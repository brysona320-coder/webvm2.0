import {client} from './vendor/wisp-client.mjs';

export const DEFAULT_WISP_URL = 'wss://anura.pro/';
export const WISP_PRESETS = Object.freeze([
  {id: 'anura', name: 'Anura', url: DEFAULT_WISP_URL, note: 'Default relay'},
  {id: 'anura-path', name: 'Anura · alternate path', url: 'wss://anura.pro/wisp/', note: 'Same operator, alternate endpoint'},
  {id: 'mercury', name: 'Mercury Workshop', url: 'wss://wisp.mercurywork.shop/', note: 'Public demo; may be throttled'},
  {id: 'rhw', name: 'RHW / SPLASH', url: 'wss://wisp.rhw.one/wisp/', note: 'Community relay'},
  {id: 'widgetry', name: 'Widgetry', url: 'wss://relay.widgetry.org/', note: 'Relay listed by Anura'}
]);
const MAX_BUFFER = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export function normalizeWispUrl(value) {
  const input = String(value || '').trim();
  const url = new URL(input.includes('://') ? input : `wss://${input}`);
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search) {
    throw new Error('Use a secure wss:// relay URL without embedded credentials, a query, or a fragment.');
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

function closeStream(stream, reason = 2) {
  if (!stream) return;
  try {
    if (stream.open && (stream.ws?.readyState === undefined || stream.ws.readyState === 1)) stream.close(reason);
  } catch { /* A closed WebSocket must not prevent local socket cleanup. */ }
  finally {
    stream.open = false;
    if (stream.connection?.active_streams) delete stream.connection.active_streams[stream.stream_id];
  }
}

function streamError(reason, protocol) {
  const message = ({3: 'The relay connection was reset', 0x41: 'The relay rejected this destination',
    0x42: 'The destination could not be resolved or reached', 0x43: 'The destination connection timed out',
    0x44: 'The destination refused the connection', 0x47: 'The data transfer timed out',
    0x48: 'This destination is blocked by the relay', 0x49: 'The relay is throttling connections'})[reason] || 'The relay closed the connection';
  return new Error(`${message} (${protocol}, Wisp ${reason}).`);
}

// CheerpX 1.4 accepts an object implementing the Direct Sockets stream shape.
// This adapter supplies those streams through Wisp rather than a tailnet.
export class WispNetwork {
  constructor(url = DEFAULT_WISP_URL, {onState = () => {}, onTraffic = () => {}, onIssue = () => {}, Connection = client.ClientConnection, timeout = 20000} = {}) {
    this.url = normalizeWispUrl(url);
    this.onState = onState;
    this.onTraffic = onTraffic;
    this.onIssue = onIssue;
    this.Connection = Connection;
    this.timeout = timeout;
    this.connection = null;
    this.pending = null;
    this.attempt = null;
    this.sockets = new Set();
    this.nextPort = 49152;
  }

  up() {
    if (this.pending) return this.pending;
    if (this.connection?.connected) return Promise.resolve(this.connection);
    const ready = deferred();
    const attempt = {ready, conn: null, timer: null};
    this.attempt = attempt;
    this.pending = ready.promise;
    this.onState('connecting');
    let conn;
    try { conn = new this.Connection(this.url); }
    catch (error) {
      this.endConnection(error, attempt);
      return ready.promise;
    }
    this.connection = conn;
    attempt.conn = conn;
    const failed = (message) => this.endConnection(new Error(message), attempt);
    conn.onopen = () => {
      clearTimeout(attempt.timer);
      if (this.connection !== conn) { conn.close(); return; }
      this.pending = null;
      attempt.opened = true;
      ready.resolve(conn);
      this.onState('connected');
    };
    conn.onerror = () => failed('The relay WebSocket failed. Check the URL, try a preset, or check whether this network blocks the relay.');
    conn.onclose = () => failed(attempt.opened ? 'The Wisp relay connection closed. Reconnect to resume networking.' : 'The relay closed its WebSocket before Wisp was ready. Test another preset or verify the endpoint path.');
    attempt.timer = setTimeout(() => failed('The relay did not complete its Wisp handshake in time. Try Test relay or another preset.'), this.timeout);
    return ready.promise;
  }

  endConnection(error, attempt = this.attempt) {
    if (attempt !== this.attempt) return;
    const conn = attempt?.conn || this.connection;
    this.attempt = null;
    this.connection = null;
    this.pending = null;
    clearTimeout(attempt?.timer);
    attempt?.ready.reject(error);
    if (conn) conn.onopen = conn.onerror = conn.onclose = () => {};
    for (const socket of [...this.sockets]) socket.fail(error);
    try { conn?.close(); } catch {}
    this.onState('disconnected', error.message);
  }

  disconnect() {
    this.endConnection(new Error('Wisp disconnected. Reconnect when ready.'));
  }

  reconnect(url = this.url) {
    const nextUrl = normalizeWispUrl(url);
    this.disconnect();
    this.url = nextUrl;
    return this.up();
  }

  async queryDNS(data, address, port = 53, {signal} = {}) {
    // DNS uses the same wire format over TCP with a two-byte length prefix.
    // This keeps DNS on the chosen Wisp relay when its UDP route is filtered.
    if (signal?.aborted) throw new Error('DNS request cancelled.');
    const socket = this.TCPSocket(address, port);
    let timer, abort;
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
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS over TCP port 53 timed out through this relay. Test another relay.')), 10000); }),
      new Promise((_, reject) => { abort = () => reject(new Error('DNS request cancelled.')); signal?.addEventListener('abort', abort, {once: true}); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await socket.close(); }
  }

  TCPSocket(host, port) {
    const opened = deferred(), closed = deferred();
    let stream, controller, owner, ended = false, cancelled = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      this.sockets.delete(socket);
      if (stream) { stream.open = false; delete stream.connection.active_streams[stream.stream_id]; }
      if (error) opened.reject(error);
      else opened.reject(new Error('Socket closed before opening.'));
      if (!cancelled) { if (error) controller.error(error); else controller.close(); }
      closed.resolve();
    };
    const close = () => { if (!ended) closeStream(stream); finish(); return closed.promise; };
    const socket = {close, fail: (error) => { if (!ended) closeStream(stream, 3); finish(error); }};
    this.sockets.add(socket);
    const readable = new ReadableStream({
      start: (value) => { controller = value; },
      cancel: () => { cancelled = true; return close(); }
    }, {highWaterMark: MAX_BUFFER, size: (chunk) => chunk.byteLength});
    const writable = new WritableStream({
      write: async (data) => {
        await opened.promise;
        if (ended) throw new Error('The TCP socket is closed.');
        const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          if (ended || this.connection !== owner || !owner?.connected || !stream.open) throw new Error('The Wisp connection closed during a write.');
          const part = bytes.slice(offset, offset + 65536);
          stream.send(part);
          this.onTraffic('sent', part.length);
          const deadline = Date.now() + 30000;
          while (stream.send_buffer.length || stream.ws.bufferedAmount > 512 * 1024) {
            if (ended || this.connection !== owner || !owner?.connected) throw new Error('The Wisp connection closed during a write.');
            if (Date.now() > deadline) throw new Error('The Wisp relay stopped accepting data.');
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
        }
      },
      close,
      abort: close
    });
    this.up().then((connection) => {
      if (ended) return;
      if (this.connection !== connection || !connection.connected) throw new Error('The relay changed before this socket opened.');
      owner = connection;
      stream = connection.create_stream(host, port, 'tcp');
      stream.onmessage = (data) => {
        if (ended) return;
        if (data.byteLength > controller.desiredSize) { socket.fail(new Error('The TCP receive buffer is full.')); return; }
        controller.enqueue(data.slice());
        this.onTraffic('received', data.byteLength);
      };
      stream.onclose = (reason) => finish(reason > 2 ? streamError(reason, 'TCP') : null);
      opened.resolve({readable, writable, localAddress: '0.0.0.0', localPort: this.nextPort++, remoteAddress: host, remotePort: port});
    }).catch(socket.fail);
    return {opened: opened.promise, closed: closed.promise, close};
  }

  UDPSocket({localPort = 0} = {}) {
    const opened = deferred(), closed = deferred();
    const streams = new Map();
    const dnsRequests = new Set();
    let controller, owner, ended = false, cancelled = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      this.sockets.delete(socket);
      for (const request of dnsRequests) request.abort();
      dnsRequests.clear();
      for (const stream of streams.values()) closeStream(stream);
      streams.clear();
      if (error) opened.reject(error);
      else opened.reject(new Error('Socket closed before opening.'));
      if (!cancelled) { if (error) controller.error(error); else controller.close(); }
      closed.resolve();
    };
    const socket = {close: () => { finish(); return closed.promise; }, fail: finish};
    this.sockets.add(socket);
    const readable = new ReadableStream({start: (value) => { controller = value; }, cancel: () => { cancelled = true; return socket.close(); }}, {
      highWaterMark: MAX_BUFFER, size: (message) => message.data.byteLength
    });
    const writable = new WritableStream({
      write: async ({data, remoteAddress, remotePort}) => {
        await opened.promise;
        if (ended || this.connection !== owner || !owner?.connected) throw new Error('The UDP socket is closed.');
        if (remotePort === 53) {
          if (dnsRequests.size >= 32) throw new Error('Too many outstanding DNS requests.');
          const request = new AbortController();
          dnsRequests.add(request);
          // Sending a datagram must not wait for its reply. A blocked DNS request
          // must not poison the UDP writer or prevent another nameserver retry.
          this.queryDNS(data.slice(), remoteAddress, remotePort, {signal: request.signal}).then((answer) => {
            if (ended) return;
            if (answer.byteLength > controller.desiredSize) throw new Error('The DNS receive buffer is full.');
            controller.enqueue({data: answer, remoteAddress, remotePort});
          }).catch((error) => { if (!ended && !request.signal.aborted) this.onIssue(error.message); })
            .finally(() => dnsRequests.delete(request));
          return;
        }
        if (!owner.udp_enabled) throw new Error('This relay does not support UDP.');
        const key = `${remoteAddress}:${remotePort}`;
        let stream = streams.get(key);
        if (!stream) {
          if (streams.size >= 64) throw new Error('Too many UDP destinations on one socket.');
          stream = owner.create_stream(remoteAddress, remotePort, 'udp');
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
            if (reason > 2) {
              // Wisp-JS invokes this while iterating its active-stream table.
              // Close siblings afterwards so its iteration never encounters a
              // stream which our callback removed underneath it.
              const siblings = [...streams.values()];
              streams.clear();
              finish(streamError(reason, 'UDP'));
              queueMicrotask(() => siblings.forEach((item) => closeStream(item)));
            }
          };
        }
        stream.send(data);
        this.onTraffic('sent', data.byteLength);
      },
      close: () => finish(), abort: () => finish()
    });
    this.up().then((connection) => {
      if (ended) return;
      if (this.connection !== connection || !connection.connected) throw new Error('The relay changed before this socket opened.');
      owner = connection;
      opened.resolve({readable, writable, localAddress: '0.0.0.0', localPort: localPort || this.nextPort++});
    }).catch(finish);
    return {opened: opened.promise, closed: closed.promise, close: socket.close};
  }

  // Wisp is an outbound proxy and cannot publish arbitrary listening ports.
  TCPServerSocket() { return null; }
}

function dnsQuestion(id) {
  const name = encoder.encode('example');
  const query = new Uint8Array(29);
  new DataView(query.buffer).setUint16(0, id);
  query[2] = 1; query[5] = 1; query[12] = name.length; query.set(name, 13);
  query[20] = 3; query.set(encoder.encode('com'), 21); query[26] = 1; query[28] = 1;
  return query;
}

function dnsAddress(bytes, id) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint16(0) !== id || !(bytes[2] & 0x80)) throw new Error('The DNS server returned a mismatched response.');
  if (bytes[3] & 15) throw new Error(`DNS returned an error (rcode ${bytes[3] & 15}).`);
  const skipName = (offset) => {
    for (let labels = 0; labels < 128; labels++) {
      if (offset >= bytes.length) break;
      const size = bytes[offset++];
      if ((size & 0xc0) === 0xc0 && offset < bytes.length) return offset + 1;
      if (size === 0) return offset;
      if (size > 63) break;
      offset += size;
    }
    throw new Error('The DNS server returned an invalid name.');
  };
  let offset = 12;
  for (let i = 0; i < view.getUint16(4); i++) offset = skipName(offset) + 4;
  for (let i = 0; i < view.getUint16(6); i++) {
    offset = skipName(offset);
    if (offset + 10 > bytes.length) break;
    const type = view.getUint16(offset), length = view.getUint16(offset + 8);
    offset += 10;
    if (offset + length > bytes.length) break;
    if (type === 1 && length === 4) return [...bytes.slice(offset, offset + 4)].join('.');
    offset += length;
  }
  throw new Error('DNS did not return an IPv4 address for the route test.');
}

// Runs independently of the VM, so a failed relay can be diagnosed before boot.
// Each stage checks a real response rather than treating the handshake as internet access.
export async function probeWispRelay(url, {Connection = client.ClientConnection, timeout = 12000, onProgress = () => {}} = {}) {
  const checks = [], started = Date.now();
  let network, tcp, stage = 'handshake', stageTimer;
  const deadline = (operation) => Promise.race([operation, new Promise((_, reject) => {
    stageTimer = setTimeout(() => reject(new Error(`${stage === 'dns' ? 'DNS through this relay' : 'The HTTP route test'} timed out.`)), timeout);
  })]).finally(() => clearTimeout(stageTimer));
  const progress = (status, detail) => {
    const item = {stage, status, detail};
    if (status === 'passed' || status === 'failed') checks.push(item);
    onProgress(item);
  };
  try {
    const normalized = normalizeWispUrl(url);
    network = new WispNetwork(normalized, {Connection, timeout});
    progress('running', 'Opening WebSocket and negotiating Wisp…');
    await network.up();
    const version = network.connection.wisp_version || 1;
    progress('passed', `Wisp v${version} handshake succeeded`);
    stage = 'dns';
    progress('running', 'Resolving example.com through the relay…');
    const id = Math.floor(Math.random() * 65536);
    const answer = await deadline(network.queryDNS(dnsQuestion(id), '8.8.8.8'));
    const address = dnsAddress(answer, id);
    progress('passed', `example.com → ${address}`);
    stage = 'http';
    progress('running', 'Requesting an HTTP response through the relay…');
    tcp = network.TCPSocket(address, 80);
    const status = await deadline((async () => {
      const socket = await tcp.opened;
      await socket.writable.getWriter().write(encoder.encode('HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'));
      const reader = socket.readable.getReader();
      let text = '';
      while (text.length < 16384) {
        const {value, done} = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.includes('\r\n')) break;
      }
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*/.exec(text);
      if (!match) throw new Error('The relay did not return a valid HTTP response.');
      if (+match[1] < 200 || +match[1] >= 400) throw new Error(`The route test returned ${match[0]}.`);
      return match[0];
    })());
    progress('passed', status);
    return {ok: true, url: normalized, checks, elapsedMs: Date.now() - started};
  } catch (error) {
    progress('failed', error.message);
    return {ok: false, checks, failedStage: stage, error: error.message, elapsedMs: Date.now() - started};
  } finally { await tcp?.close(); network?.disconnect(); }
}
