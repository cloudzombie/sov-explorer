import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RelayDivergenceError, SovereignRpc } from '../src/rpc.js';

const hx = (byte) => `0x${byte.repeat(64)}`;

test('strict relay transport requires TLS except for local development', () => {
  assert.throws(
    () => new SovereignRpc('http://203.0.113.10:8645', { requireTls: true }),
    /requires TLS/,
  );
  assert.doesNotThrow(
    () => new SovereignRpc('http://127.0.0.1:8645', { requireTls: true }),
  );
  const tls = new SovereignRpc('https://relay.example.com/rpc', { requireTls: true });
  assert.equal(tls.status().relays[0].transport, 'tls');
  assert.throws(
    () => new SovereignRpc('https://user:secret@relay.example.com'),
    /must not embed credentials/,
  );
  assert.throws(() => new SovereignRpc('file:///tmp/relay'), /must use HTTP or HTTPS/);
});

async function fakeRelay(options = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(body.method);
      if (options.failMethod === body.method) {
        res.writeHead(503).end('down');
        return;
      }
      let result;
      switch (body.method) {
        case 'sov_chainId': result = options.chainId ?? 'sov-mainnet'; break;
        case 'sov_getHeight': result = options.height ?? 10; break;
        case 'sov_getBlockDigest':
          result = {
            hash: body.params.height === 0
              ? (options.genesis ?? hx('a'))
              : (options.commonHash ?? hx('b')),
            txIds: [],
          };
          break;
        case 'sov_getSupply': result = options.supply ?? { total: '1', mined: '1' }; break;
        default: result = null;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('pins both relays and cross-checks their common head', async (t) => {
  const a = await fakeRelay();
  const b = await fakeRelay();
  t.after(() => Promise.all([a.close(), b.close()]));
  const rpc = new SovereignRpc([a.url, b.url], {
    expectedChainId: 'sov-mainnet',
    expectedGenesisHash: hx('a'),
    probeTtlMs: 0,
  });
  const status = await rpc.verifyRelays();
  assert.equal(status.healthy, 2);
  assert.equal(status.consistent, true);
  assert.equal(await rpc.height(), 10);
});

test('quarantines a relay with the wrong genesis', async (t) => {
  const good = await fakeRelay();
  const wrong = await fakeRelay({ genesis: hx('f') });
  t.after(() => Promise.all([good.close(), wrong.close()]));
  const rpc = new SovereignRpc([good.url, wrong.url], {
    expectedChainId: 'sov-mainnet',
    expectedGenesisHash: hx('a'),
  });
  await rpc.verifyRelays();
  const status = rpc.status();
  assert.equal(status.verified, 1);
  assert.equal(status.relays.find((relay) => !relay.enabled).healthy, false);
});

test('fails over an ordinary read when the first relay errors', async (t) => {
  const down = await fakeRelay({ failMethod: 'sov_getSupply' });
  const good = await fakeRelay({ supply: { total: '42', mined: '42' } });
  t.after(() => Promise.all([down.close(), good.close()]));
  const rpc = new SovereignRpc([down.url, good.url], {
    expectedChainId: 'sov-mainnet',
    expectedGenesisHash: hx('a'),
  });
  await rpc.verifyRelays();
  assert.deepEqual(await rpc.supply(), { total: '42', mined: '42' });
});

test('halts when two healthy relays disagree at a common height', async (t) => {
  const a = await fakeRelay({ commonHash: hx('b') });
  const b = await fakeRelay({ commonHash: hx('c') });
  t.after(() => Promise.all([a.close(), b.close()]));
  const rpc = new SovereignRpc([a.url, b.url], {
    expectedChainId: 'sov-mainnet',
    expectedGenesisHash: hx('a'),
    probeTtlMs: 0,
  });
  const status = await rpc.verifyRelays();
  assert.equal(status.consistent, false);
  await assert.rejects(() => rpc.height(), RelayDivergenceError);
});
