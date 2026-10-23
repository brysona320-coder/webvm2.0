import test from 'node:test';
import assert from 'node:assert/strict';
import {WispNetwork, normalizeWispUrl, probeWispRelay, WISP_PRESETS} from '../wisp-network.js';

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

test('cancelling TCP and UDP readers does not close an already cancelled controller', async () => {
  const network = new WispNetwork('anura.pro', {Connection: Relay});
  for (const socket of [network.TCPSocket('example.com', 80), network.UDPSocket()]) {
    const info = await socket.opened;
    await info.readable.getReader().cancel();
    await socket.closed;
    await socket.close();
  }
  assert.equal(network.sockets.size, 0);
  network.disconnect();
});

test('a throwing WebSocket close cannot leave TCP or UDP sockets stuck', async () => {
  class BrokenCloseRelay extends Relay {
    create_stream(...args) {
      const stream = super.create_stream(...args);
      stream.close = () => { throw new Error('WebSocket is already closed'); };
      return stream;
    }
  }
  const network = new WispNetwork('anura.pro', {Connection: BrokenCloseRelay});
  const tcp = network.TCPSocket('example.com', 80), udp = network.UDPSocket();
  const tcpInfo = await tcp.opened, udpInfo = await udp.opened;
  const pendingTCP = tcpInfo.readable.getReader().read();
  const pendingUDP = udpInfo.readable.getReader().read();
  await udpInfo.writable.getWriter().write({data: new Uint8Array([1]), remoteAddress: '192.0.2.1', remotePort: 1234});
  const connection = network.connection;
  network.disconnect();
  await assert.rejects(pendingTCP, /disconnected/);
  await assert.rejects(pendingUDP, /disconnected/);
  await Promise.all([tcp.closed, udp.closed]);
  assert.equal(network.sockets.size, 0);
  assert.equal(Object.keys(connection.active_streams).length, 0);
  assert.equal(network.pending, null);
});

test('disconnecting during a handshake allows immediate retry and ignores late callbacks', async () => {
  class WaitingRelay {
    constructor() { this.connected = false; this.active_streams = {}; }
    close() { this.connected = false; }
  }
  const network = new WispNetwork('anura.pro', {Connection: WaitingRelay});
  const first = network.up(), firstConnection = network.connection, staleOpen = firstConnection.onopen;
  network.disconnect();
  await assert.rejects(first, /disconnected/);
  const second = network.up(), secondConnection = network.connection;
  firstConnection.connected = true; staleOpen();
  assert.equal(network.connection, secondConnection);
  assert.equal(network.pending, second);
  secondConnection.connected = true; secondConnection.onopen();
  assert.equal(await second, secondConnection);
  assert.equal(network.pending, null);
  network.disconnect();
});

test('relay shutdown can notify multiple UDP streams without callback reentrancy errors', async () => {
  class DroppingRelay extends Relay {
    drop() {
      this.connected = false;
      for (const id of Object.keys(this.active_streams)) {
        this.active_streams[id].onclose(3);
        delete this.active_streams[id];
      }
      this.onclose();
    }
  }
  const network = new WispNetwork('anura.pro', {Connection: DroppingRelay});
  const udp = network.UDPSocket(), {readable, writable} = await udp.opened;
  const writer = writable.getWriter();
  await writer.write({data: new Uint8Array([1]), remoteAddress: '192.0.2.1', remotePort: 1234});
  await writer.write({data: new Uint8Array([2]), remoteAddress: '192.0.2.2', remotePort: 1234});
  const response = readable.getReader().read();
  assert.doesNotThrow(() => network.connection.drop());
  await assert.rejects(response, /reset/);
  await udp.closed;
  assert.equal(network.connection, null);
  assert.equal(network.sockets.size, 0);
});

test('a failed DNS request does not poison the UDP writer or prevent a retry', async () => {
  const issues = [];
  const network = new WispNetwork('anura.pro', {Connection: Relay, onIssue: (message) => issues.push(message)});
  let requests = 0;
  network.queryDNS = async () => {
    if (++requests === 1) throw new Error('DNS destination blocked by relay');
    return new Uint8Array([42, 57]);
  };
  const udp = network.UDPSocket(), {readable, writable} = await udp.opened;
  const writer = writable.getWriter();
  const request = {data: new Uint8Array([1]), remoteAddress: '8.8.8.8', remotePort: 53};
  await writer.write(request);
  await writer.write({...request, remoteAddress: '8.8.4.4'});
  assert.deepEqual((await readable.getReader().read()).value.data, new Uint8Array([42, 57]));
  assert.equal(requests, 2);
  assert.match(issues[0], /blocked/);
  await udp.close(); network.disconnect();
});

test('closing a UDP socket aborts its pending DNS work', async () => {
  const network = new WispNetwork('anura.pro', {Connection: Relay});
  let requestSignal;
  network.queryDNS = (data, host, port, {signal}) => new Promise((resolve, reject) => {
    requestSignal = signal;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
  });
  const udp = network.UDPSocket(), {writable} = await udp.opened;
  await writable.getWriter().write({data: new Uint8Array([1]), remoteAddress: '8.8.8.8', remotePort: 53});
  assert.equal(requestSignal.aborted, false);
  await udp.close();
  assert.equal(requestSignal.aborted, true);
  network.disconnect();
});

test('the relay probe reports a blocked DNS route instead of claiming internet access', async () => {
  class DNSBlockedRelay extends Relay {
    create_stream(...args) {
      const stream = super.create_stream(...args);
      stream.send = () => queueMicrotask(() => stream.onclose(0x48));
      return stream;
    }
  }
  const result = await probeWispRelay('anura.pro', {Connection: DNSBlockedRelay});
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, 'dns');
  assert.equal(result.checks[0].stage, 'handshake');
  assert.equal(result.checks[0].status, 'passed');
  assert.match(result.error, /blocked/);
});

test('the relay probe requires both a matching DNS answer and an HTTP response', async () => {
  class WorkingRelay extends Relay {
    create_stream(...args) {
      const stream = super.create_stream(...args);
      stream.send = (data) => queueMicrotask(() => {
        if (stream.port === 53) {
          const question = data.slice(2), answer = new Uint8Array(question.length + 16);
          answer.set(question); answer[2] = 0x81; answer[3] = 0x80; answer[7] = 1;
          answer.set([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 10], question.length);
          const framed = new Uint8Array(answer.length + 2); framed[1] = answer.length; framed.set(answer, 2);
          stream.onmessage(framed);
        } else {
          assert.equal(stream.hostname, '203.0.113.10');
          stream.onmessage(new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'));
        }
      });
      return stream;
    }
  }
  const result = await probeWispRelay('anura.pro', {Connection: WorkingRelay});
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((item) => item.stage), ['handshake', 'dns', 'http']);
  assert.match(result.checks[2].detail, /200 OK/);
  for (const preset of WISP_PRESETS) assert.equal(normalizeWispUrl(preset.url), preset.url);
});
