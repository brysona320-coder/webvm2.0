import test from 'node:test';
import assert from 'node:assert/strict';
import {WispNetwork, normalizeWispUrl} from '../wisp-network.js';

class Relay {
  constructor() {
    this.connected = false;
    this.udp_enabled = true;
    this.active_streams = {};
    this.nextId = 1;
    queueMicrotask(() => { this.connected = true; this.onopen(); });
  }
  create_stream(host, port, type) {
    const stream = {
      hostname: host, port, type, open: true, stream_id: this.nextId++, connection: this,
      send_buffer: [], ws: {bufferedAmount: 0},
      send: (data) => this.onSend?.(stream, data),
      close: () => { stream.open = false; delete this.active_streams[stream.stream_id]; }
    };
    this.active_streams[stream.stream_id] = stream;
    return stream;
  }
  close() { this.connected = false; this.onclose(); }
}

test('relay URLs normalize user input and require secure WebSockets', () => {
  assert.equal(normalizeWispUrl('anura.pro'), 'wss://anura.pro/');
  assert.equal(normalizeWispUrl('wss://example.com/wisp'), 'wss://example.com/wisp/');
  for (const url of ['http://example.com', 'ws://example.com', 'wss://user:secret@example.com/', 'wss://example.com/#token']) {
    assert.throws(() => normalizeWispUrl(url));
  }
});

test('TCP exposes real byte streams and closes without leaking a socket', async () => {
  const network = new WispNetwork('anura.pro', {Connection: Relay});
  await network.up();
  network.connection.onSend = (stream, data) => queueMicrotask(() => stream.onmessage(data));
  const tcp = network.TCPSocket('example.com', 443);
  const {readable, writable, remoteAddress, remotePort} = await tcp.opened;
  assert.equal(remoteAddress, 'example.com');
  assert.equal(remotePort, 443);
  const reader = readable.getReader();
  await writable.getWriter().write(new Uint8Array([0, 255, 42]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([0, 255, 42]));
  assert.equal(tcp.close(), tcp.closed, 'CheerpX requires close() to return a promise');
  assert.equal((await reader.read()).done, true);
  await tcp.closed;
  assert.equal(network.sockets.size, 0);
  assert.equal(Object.keys(network.connection.active_streams).length, 0);
  network.disconnect();
});

test('DNS datagrams use framed Wisp TCP and reassemble split responses', async () => {
  const network = new WispNetwork('anura.pro', {Connection: Relay});
  await network.up();
  const query = new Uint8Array([0x42, 0x57, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const answer = query.slice(); answer[2] = 0x81;
  network.connection.onSend = (stream, data) => {
    assert.equal(stream.type, 'tcp');
    assert.equal(stream.hostname, '8.8.8.8');
    assert.equal(stream.port, 53);
    assert.equal(new DataView(data.buffer).getUint16(0), query.length);
    assert.deepEqual(data.slice(2), query);
    const packet = new Uint8Array(answer.length + 2); packet[1] = answer.length; packet.set(answer, 2);
    queueMicrotask(() => { stream.onmessage(packet.slice(0, 1)); stream.onmessage(packet.slice(1, 6)); stream.onmessage(packet.slice(6)); });
  };
  const udp = network.UDPSocket({localPort: 53000});
  const {readable, writable, localPort} = await udp.opened;
  assert.equal(localPort, 53000);
  await writable.getWriter().write({data: query, remoteAddress: '8.8.8.8', remotePort: 53});
  assert.deepEqual((await readable.getReader().read()).value, {data: answer, remoteAddress: '8.8.8.8', remotePort: 53});
  assert.equal(udp.close(), udp.closed, 'CheerpX requires close() to return a promise');
  assert.equal(network.sockets.size, 0);
  network.disconnect();
});

test('relay failure rejects pending sockets and leaves no false connected state', async () => {
  class UnavailableRelay extends Relay {
    constructor() { super(); }
    set onopen(callback) { queueMicrotask(() => { this.connected = false; this.onclose(); }); }
    get onopen() { return () => {}; }
  }
  const states = [];
  const network = new WispNetwork('anura.pro', {Connection: UnavailableRelay, onState: (state) => states.push(state)});
  const tcp = network.TCPSocket('example.com', 80);
  await assert.rejects(tcp.opened, /closed/);
  await tcp.closed;
  assert.equal(network.connection, null);
  assert.equal(network.sockets.size, 0);
  assert.equal(states.at(-1), 'disconnected');
});

test('ordinary UDP datagrams preserve the remote address and port', async () => {
  const network = new WispNetwork('anura.pro', {Connection: Relay});
  await network.up();
  network.connection.onSend = (stream, data) => {
    assert.equal(stream.type, 'udp');
    queueMicrotask(() => stream.onmessage(data));
  };
  const udp = network.UDPSocket();
  const {readable, writable} = await udp.opened;
  const message = {data: new Uint8Array([1, 2, 3]), remoteAddress: '192.0.2.1', remotePort: 1234};
  await writable.getWriter().write(message);
  assert.deepEqual((await readable.getReader().read()).value, message);
  udp.close(); network.disconnect();
});
