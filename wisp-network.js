import {client} from './vendor/wisp-client.mjs';

export const DEFAULT_WISP_URL = 'wss://anura.pro/';
const MAX_BUFFER = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export function normalizeWispUrl(value) {
  const input = String(value || '').trim();
  const url = new URL(input.includes('://') ? input : `wss://${input}`);
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) {
    throw new Error('Use a secure wss:// relay URL without embedded credentials or a fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The VM may close a socket before it starts observing its opened promise.
  promise.catch(() => {});
  return {promise, resolve, reject};
}

// CheerpX 1.4 accepts an object implementing the Direct Sockets stream shape.
// This adapter supplies those streams through Wisp rather than a tailnet.
export class WispNetwork {
  constructor(url = DEFAULT_WISP_URL, {onState = () => {}, onTraffic = () => {}, Connection = client.ClientConnection, timeout = 20000} = {}) {
    this.url = normalizeWispUrl(url);
    this.onState = onState;
    this.onTraffic = onTraffic;
    this.Connection = Connection;
    this.timeout = timeout;
    this.connection = null;
    this.pending = null;
    this.sockets = new Set();
    this.nextPort = 49152;
  }

  up() {
    if (this.connection?.connected) return Promise.resolve();
    if (this.pending) return this.pending;
    const ready = deferred();
    this.pending = ready.promise;
    this.onState('connecting');
    let conn;
    try { conn = new this.Connection(this.url); }
    catch (error) {
      this.pending = null;
      ready.reject(error);
      this.onState('disconnected', error.message);
      return ready.promise;
    }
    this.connection = conn;
    let timer;
    const failed = (message) => {
      clearTimeout(timer);
      if (this.connection !== conn) return;
      this.connection = null;
      this.pending = null;
      const error = new Error(message);
      ready.reject(error);
      for (const socket of [...this.sockets]) socket.fail(error);
      this.onState('disconnected', message);
    };
    conn.onopen = () => {
      clearTimeout(timer);
      if (this.connection !== conn) { conn.close(); return; }
      this.pending = null;
      ready.resolve();
      this.onState('connected');
    };
    conn.onerror = () => failed('The Wisp relay could not be reached. Check the URL or retry.');
    conn.onclose = () => failed('The Wisp relay connection closed. Reconnect to resume networking.');
    timer = setTimeout(() => {
      failed('The Wisp relay did not complete its handshake in time.');
      conn.close();
    }, this.timeout);
    return ready.promise;
  }

  disconnect() {
    const conn = this.connection;
    for (const socket of [...this.sockets]) socket.close();
    conn?.close();
  }

  async queryDNS(data, address, port = 53) {
    // DNS uses the same wire format over TCP with a two-byte length prefix.
    // This keeps DNS on the chosen Wisp relay when its UDP route is filtered.
    const socket = this.TCPSocket(address, port);
    let timer;
    try {
      return await Promise.race([(async () => {
        const info = await socket.opened;
        const packet = new Uint8Array(data.byteLength + 2);
        new DataView(packet.buffer).setUint16(0, data.byteLength);
        packet.set(data, 2);
        await info.writable.getWriter().write(packet);
        const reader = info.readable.getReader();
        let received = new Uint8Array(0);
        while (true) {
          const {value, done} = await reader.read();
          if (done) throw new Error('The DNS server closed before sending an answer.');
          const combined = new Uint8Array(received.length + value.length);
          combined.set(received); combined.set(value, received.length); received = combined;
          if (received.length >= 2) {
            const length = new DataView(received.buffer).getUint16(0);
            if (length < 12) throw new Error('The DNS server returned an invalid answer.');
            if (received.length >= length + 2) return received.slice(2, length + 2);
          }
        }
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The DNS request timed out.')), 10000); })]);
    } finally { clearTimeout(timer); socket.close(); }
  }

  TCPSocket(host, port) {
    const opened = deferred(), closed = deferred();
    let stream, controller, ended = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      this.sockets.delete(socket);
      if (stream) { stream.open = false; delete stream.connection.active_streams[stream.stream_id]; }
      if (error) { opened.reject(error); controller.error(error); }
      else { controller.close(); opened.reject(new Error('Socket closed before opening.')); }
      closed.resolve();
    };
    const close = () => { if (!ended) stream?.close(2); finish(); return closed.promise; };
    const socket = {close, fail: (error) => { stream?.close(3); finish(error); }};
    this.sockets.add(socket);
    const readable = new ReadableStream({
      start: (value) => { controller = value; },
      cancel: close
    }, {highWaterMark: MAX_BUFFER, size: (chunk) => chunk.byteLength});
    const writable = new WritableStream({
      write: async (data) => {
        await opened.promise;
        if (ended) throw new Error('The TCP socket is closed.');
        const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          if (ended || !this.connection?.connected) throw new Error('The Wisp connection closed during a write.');
          const part = bytes.slice(offset, offset + 65536);
          stream.send(part);
          this.onTraffic('sent', part.length);
          const deadline = Date.now() + 30000;
          while (stream.send_buffer.length || stream.ws.bufferedAmount > 512 * 1024) {
            if (ended || !this.connection?.connected) throw new Error('The Wisp connection closed during a write.');
            if (Date.now() > deadline) throw new Error('The Wisp relay stopped accepting data.');
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
        }
      },
      close,
      abort: close
    });
    this.up().then(() => {
      if (ended) return;
      stream = this.connection.create_stream(host, port, 'tcp');
      stream.onmessage = (data) => {
        if (ended) return;
        if (data.byteLength > controller.desiredSize) { socket.fail(new Error('The TCP receive buffer is full.')); return; }
        controller.enqueue(data.slice());
        this.onTraffic('received', data.byteLength);
      };
      stream.onclose = (reason) => finish(reason > 2 ? new Error(`Wisp TCP connection failed (reason ${reason}).`) : null);
      opened.resolve({readable, writable, localAddress: '0.0.0.0', localPort: this.nextPort++, remoteAddress: host, remotePort: port});
    }).catch(socket.fail);
    return {opened: opened.promise, closed: closed.promise, close};
  }

  UDPSocket({localPort = 0} = {}) {
    const opened = deferred(), closed = deferred();
    const streams = new Map();
    let controller, ended = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      this.sockets.delete(socket);
      for (const stream of streams.values()) stream.close(2);
      streams.clear();
      if (error) { controller.error(error); opened.reject(error); }
      else { controller.close(); opened.reject(new Error('Socket closed before opening.')); }
      closed.resolve();
    };
    const socket = {close: () => { finish(); return closed.promise; }, fail: finish};
    this.sockets.add(socket);
    const readable = new ReadableStream({start: (value) => { controller = value; }, cancel: () => finish()}, {
      highWaterMark: MAX_BUFFER, size: (message) => message.data.byteLength
    });
    const writable = new WritableStream({
      write: async ({data, remoteAddress, remotePort}) => {
        await opened.promise;
        if (ended || !this.connection?.connected) throw new Error('The UDP socket is closed.');
        if (remotePort === 53) {
          const answer = await this.queryDNS(data, remoteAddress, remotePort);
          if (ended) return;
          if (answer.byteLength > controller.desiredSize) throw new Error('The DNS receive buffer is full.');
          controller.enqueue({data: answer, remoteAddress, remotePort});
          return;
        }
        if (!this.connection.udp_enabled) throw new Error('This relay does not support UDP.');
        const key = `${remoteAddress}:${remotePort}`;
        let stream = streams.get(key);
        if (!stream) {
          if (streams.size >= 64) throw new Error('Too many UDP destinations on one socket.');
          stream = this.connection.create_stream(remoteAddress, remotePort, 'udp');
          streams.set(key, stream);
          stream.onmessage = (bytes) => {
            if (ended) return;
            if (bytes.byteLength > controller.desiredSize) { finish(new Error('The UDP receive buffer is full.')); return; }
            controller.enqueue({data: bytes.slice(), remoteAddress, remotePort});
            this.onTraffic('received', bytes.byteLength);
          };
          stream.onclose = (reason) => {
            stream.open = false;
            streams.delete(key);
            if (reason > 2) finish(new Error(`Wisp UDP connection failed (reason ${reason}).`));
          };
        }
        stream.send(data);
        this.onTraffic('sent', data.byteLength);
      },
      close: () => finish(), abort: () => finish()
    });
    this.up().then(() => {
      if (ended) return;
      opened.resolve({readable, writable, localAddress: '0.0.0.0', localPort: localPort || this.nextPort++});
    }).catch(finish);
    return {opened: opened.promise, closed: closed.promise, close: socket.close};
  }

  // Wisp is an outbound proxy and cannot publish arbitrary listening ports.
  TCPServerSocket() { return null; }
}
