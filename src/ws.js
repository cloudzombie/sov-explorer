// Bounded RFC 6455 WebSocket broadcast hub.
//
// The feed is server -> client only. Connections are same-origin checked, capped,
// heartbeat-reaped, and disconnected when they stop accepting data so one slow or
// malicious browser cannot grow the Node process's socket buffers without bound.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function reject(socket, status, reason) {
  if (socket.writable) {
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
    );
  } else {
    socket.destroy();
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser health checks / websocket clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export class WsHub {
  constructor(opts = {}) {
    this.clients = new Set();
    this.perIp = new Map();
    this.maxClients = opts.maxClients ?? 1_000;
    this.maxPerIp = opts.maxPerIp ?? 20;
    this.sharedCapacity = opts.sharedCapacity ?? null;
    this.maxInboundBytes = opts.maxInboundBytes ?? 64 * 1024;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 1024 * 1024;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this._heartbeat = setInterval(() => this._pulse(), this.heartbeatMs);
    this._heartbeat.unref?.();
  }

  handleUpgrade(req, socket) {
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    const connection = String(req.headers.connection ?? '').toLowerCase();
    const version = String(req.headers['sec-websocket-version'] ?? '');
    const key = String(req.headers['sec-websocket-key'] ?? '');
    let keyBytes = null;
    try {
      keyBytes = Buffer.from(key, 'base64');
    } catch {
      // handled by the length check below
    }
    if (upgrade !== 'websocket' || !connection.split(',').some((v) => v.trim() === 'upgrade')) {
      return reject(socket, '400 Bad Request', 'invalid websocket upgrade');
    }
    if (version !== '13' || !keyBytes || keyBytes.length !== 16) {
      return reject(socket, '400 Bad Request', 'invalid websocket handshake');
    }
    if (!sameOrigin(req)) return reject(socket, '403 Forbidden', 'websocket origin rejected');
    if (this.clients.size >= this.maxClients) {
      return reject(socket, '503 Service Unavailable', 'websocket capacity reached');
    }
    if (this.sharedCapacity && this.sharedCapacity.count >= this.sharedCapacity.max) {
      return reject(socket, '503 Service Unavailable', 'websocket process capacity reached');
    }

    const ip = req.sovClientIp ?? req.socket.remoteAddress ?? 'unknown';
    const ipCount = this.perIp.get(ip) ?? 0;
    if (ipCount >= this.maxPerIp) {
      return reject(socket, '429 Too Many Requests', 'too many websocket connections');
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.sovAlive = true;
    socket.sovIp = ip;
    socket.sovBuffer = Buffer.alloc(0);
    socket.sovSharedCapacity = this.sharedCapacity;
    this.clients.add(socket);
    if (this.sharedCapacity) this.sharedCapacity.count += 1;
    this.perIp.set(ip, ipCount + 1);

    socket.on('data', (buf) => this._onData(socket, buf));
    const drop = () => this._drop(socket);
    socket.on('close', drop);
    socket.on('end', drop);
    socket.on('error', drop);
  }

  _drop(socket) {
    if (!this.clients.delete(socket)) return;
    if (socket.sovSharedCapacity) {
      socket.sovSharedCapacity.count = Math.max(0, socket.sovSharedCapacity.count - 1);
      socket.sovSharedCapacity = null;
    }
    const ip = socket.sovIp ?? 'unknown';
    const next = (this.perIp.get(ip) ?? 1) - 1;
    if (next <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, next);
  }

  _onData(socket, chunk) {
    const prior = socket.sovBuffer ?? Buffer.alloc(0);
    if (prior.length + chunk.length > this.maxInboundBytes) return this._destroy(socket);
    socket.sovBuffer = prior.length ? Buffer.concat([prior, chunk]) : chunk;

    while (socket.sovBuffer.length >= 2) {
      const buf = socket.sovBuffer;
      const first = buf[0];
      const second = buf[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;

      // This is a server-only application protocol. The only valid client frames
      // are masked, unfragmented close/ping/pong controls with no RSV extensions.
      if ((first & 0x70) !== 0 || !fin || !masked || ![0x8, 0x9, 0xa].includes(opcode)) {
        return this._destroy(socket);
      }

      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const large = buf.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return this._destroy(socket);
        length = Number(large);
        headerLength = 10;
      }
      if (length > 125 || length > this.maxInboundBytes) return this._destroy(socket);

      const frameLength = headerLength + 4 + length;
      if (buf.length < frameLength) return;
      const mask = buf.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(buf.subarray(headerLength + 4, frameLength));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      socket.sovBuffer = buf.subarray(frameLength);

      if (opcode === 0x8) {
        this._drop(socket);
        if (socket.writable) socket.end(encodeFrame(payload, 0x8));
        else socket.destroy();
        return;
      }
      if (opcode === 0x9) {
        if (socket.writable) socket.write(encodeFrame(payload, 0xa));
      } else {
        socket.sovAlive = true;
      }
    }
  }

  _destroy(socket) {
    this._drop(socket);
    socket.destroy();
  }

  _pulse() {
    const ping = encodeFrame(Buffer.alloc(0), 0x9);
    for (const socket of this.clients) {
      if (!socket.writable || socket.sovAlive === false || socket.writableLength > this.maxBufferedBytes) {
        this._drop(socket);
        socket.destroy();
        continue;
      }
      socket.sovAlive = false;
      try {
        socket.write(ping);
      } catch {
        this._drop(socket);
        socket.destroy();
      }
    }
  }

  broadcast(obj) {
    if (this.clients.size === 0) return;
    const frame = encodeFrame(Buffer.from(JSON.stringify(obj)), 0x1);
    for (const socket of this.clients) {
      if (!socket.writable || socket.writableLength + frame.length > this.maxBufferedBytes) {
        this._drop(socket);
        socket.destroy();
        continue;
      }
      try {
        socket.write(frame);
      } catch {
        this._drop(socket);
        socket.destroy();
      }
    }
  }

  count() {
    return this.clients.size;
  }

  stop() {
    clearInterval(this._heartbeat);
    for (const socket of [...this.clients]) {
      this._drop(socket);
      socket.destroy();
    }
    this.perIp.clear();
  }
}

/** Encode an unmasked server frame (FIN set) with the given opcode. */
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
