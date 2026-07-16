import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WsHub } from '../src/ws.js';

class FakeSocket extends EventEmitter {
  constructor(ip = '127.0.0.1') {
    super();
    this.remoteAddress = ip;
    this.writable = true;
    this.writableLength = 0;
    this.writes = [];
    this.destroyed = false;
    this.ended = false;
  }

  setNoDelay() {}

  write(value) {
    this.writes.push(Buffer.from(value));
    return true;
  }

  end(value) {
    if (value) this.write(value);
    this.writable = false;
    this.ended = true;
  }

  destroy() {
    this.writable = false;
    this.destroyed = true;
  }
}

function request(socket, origin = 'http://explorer.local') {
  return {
    socket,
    headers: {
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
      host: 'explorer.local',
      origin,
    },
  };
}

function clientFrame(opcode, payload = Buffer.alloc(0), masked = true) {
  const body = Buffer.from(payload);
  assert.ok(body.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | body.length]);
  if (!masked) return Buffer.concat([header, body]);
  const encoded = Buffer.from(body);
  for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, encoded]);
}

test('websocket accepts a fragmented masked pong and keeps the client alive', () => {
  const hub = new WsHub({ heartbeatMs: 60_000 });
  const socket = new FakeSocket();
  hub.handleUpgrade(request(socket), socket);
  assert.equal(hub.count(), 1);
  assert.match(socket.writes[0].toString(), /^HTTP\/1\.1 101 /);

  socket.sovAlive = false;
  const frame = clientFrame(0xa, Buffer.from('ok'));
  socket.emit('data', frame.subarray(0, 1));
  assert.equal(socket.sovAlive, false);
  socket.emit('data', frame.subarray(1));
  assert.equal(socket.sovAlive, true);
  assert.equal(socket.destroyed, false);
  hub.stop();
});

test('websocket rejects cross-origin handshakes', () => {
  const hub = new WsHub({ heartbeatMs: 60_000 });
  const socket = new FakeSocket();
  hub.handleUpgrade(request(socket, 'https://evil.example'), socket);
  assert.equal(hub.count(), 0);
  assert.equal(socket.ended, true);
  assert.match(Buffer.concat(socket.writes).toString(), /403 Forbidden/);
  hub.stop();
});

test('websocket drops unmasked or application-data client frames', () => {
  const hub = new WsHub({ heartbeatMs: 60_000 });
  const unmasked = new FakeSocket('127.0.0.2');
  hub.handleUpgrade(request(unmasked), unmasked);
  unmasked.emit('data', clientFrame(0xa, Buffer.alloc(0), false));
  assert.equal(unmasked.destroyed, true);
  assert.equal(hub.count(), 0);

  const text = new FakeSocket('127.0.0.3');
  hub.handleUpgrade(request(text), text);
  text.emit('data', clientFrame(0x1, Buffer.from('not allowed')));
  assert.equal(text.destroyed, true);
  assert.equal(hub.count(), 0);
  hub.stop();
});

test('websocket honors trusted forwarded identity and a process-wide capacity', () => {
  const sharedCapacity = { count: 0, max: 1 };
  const firstHub = new WsHub({ heartbeatMs: 60_000, sharedCapacity, maxPerIp: 1 });
  const secondHub = new WsHub({ heartbeatMs: 60_000, sharedCapacity, maxPerIp: 1 });
  const first = new FakeSocket('127.0.0.1');
  const firstReq = request(first);
  firstReq.sovClientIp = '203.0.113.4';
  firstHub.handleUpgrade(firstReq, first);
  assert.equal(first.sovIp, '203.0.113.4');
  assert.equal(sharedCapacity.count, 1);

  const second = new FakeSocket('127.0.0.1');
  secondHub.handleUpgrade(request(second), second);
  assert.equal(second.ended, true);
  assert.match(Buffer.concat(second.writes).toString(), /process capacity reached/);

  first.emit('close');
  assert.equal(sharedCapacity.count, 0);
  firstHub.stop();
  secondHub.stop();
});
