import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { keyDigest } from '../src/api-access.js';

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startExplorer(t, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      SOVEREIGN_MAINNET_DISABLED: '1',
      SOVEREIGN_TESTNET_DISABLED: '1',
      METRICS_TOKEN: 'test-token',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 5_000;
  while (!output.includes('web UI + API')) {
    if (child.exitCode !== null) throw new Error(`explorer exited: ${output}`);
    if (Date.now() > deadline) throw new Error(`explorer did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return `http://127.0.0.1:${port}`;
}

test('HTTP surface enforces methods, security headers, network state, and metrics auth', async (t) => {
  const base = await startExplorer(t);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const homeHtml = await home.text();
  assert.match(homeHtml, /Sovereign Explorer/);
  assert.match(homeHtml, /rel="icon" href="\/favicon\.svg"/);

  const spec = await fetch(`${base}/openapi.json`);
  assert.equal(spec.status, 200);
  assert.equal((await spec.json()).info.version, '1.0.0');

  const method = await fetch(`${base}/style.css`, { method: 'POST' });
  assert.equal(method.status, 405);
  const disabled = await fetch(`${base}/api/mainnet/status`);
  assert.equal(disabled.status, 503);
  const versioned = await fetch(`${base}/api/v1/mainnet/status`);
  assert.equal(versioned.status, 503);
  const unknown = await fetch(`${base}/healthz?network=bogus`);
  assert.equal(unknown.status, 404);
  const preflight = await fetch(`${base}/api/mainnet/status`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);

  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const metrics = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /sovereign_explorer_http_requests_total/);
});

test('paid API thresholds, keys, GraphQL gate, and usage headers are enforced', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sov-http-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'keys.json');
  const apiKey = 'sov_live_http_test';
  await writeFile(file, JSON.stringify({
    version: 1,
    keys: [{ id: 'test', hash: keyDigest(apiKey), plan: 'pro', enabled: true, requestsPerMinute: 10 }],
  }));
  const base = await startExplorer(t, { API_KEYS_FILE: file });

  const payment = await fetch(`${base}/api/mainnet/transactions?limit=51`);
  assert.equal(payment.status, 402);
  assert.equal((await payment.json()).error.code, 'paid_api_key_required');
  assert.ok(payment.headers.get('x-request-id'));

  const invalid = await fetch(`${base}/api/mainnet/status`, { headers: { 'x-api-key': 'invalid' } });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, 'invalid_api_key');

  const paid = await fetch(`${base}/api/mainnet/transactions?limit=51`, { headers: { 'x-api-key': apiKey } });
  assert.equal(paid.status, 503, 'valid paid access reaches the disabled-network boundary');
  assert.equal(paid.headers.get('x-api-tier'), 'pro');
  assert.equal(paid.headers.get('x-ratelimit-limit'), '10');
  assert.equal(paid.headers.get('x-ratelimit-remaining'), '9');
  assert.doesNotMatch(await paid.text(), new RegExp(apiKey));

  const graphql = await fetch(`${base}/graphql/mainnet`, { method: 'POST', body: '{ status { chainId } }' });
  assert.equal(graphql.status, 402);

  const oversized = await fetch(`${base}/graphql/mainnet`, {
    method: 'POST', headers: { 'x-api-key': apiKey }, body: 'x'.repeat(70 * 1024),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'payload_too_large');
});
