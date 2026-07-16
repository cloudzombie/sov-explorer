import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startExplorer(t) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      SOVEREIGN_MAINNET_DISABLED: '1',
      SOVEREIGN_TESTNET_DISABLED: '1',
      METRICS_TOKEN: 'test-token',
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
  assert.match(await home.text(), /Sovereign Explorer/);

  const method = await fetch(`${base}/style.css`, { method: 'POST' });
  assert.equal(method.status, 405);
  const disabled = await fetch(`${base}/api/mainnet/status`);
  assert.equal(disabled.status, 503);
  const unknown = await fetch(`${base}/healthz?network=bogus`);
  assert.equal(unknown.status, 404);
  const preflight = await fetch(`${base}/api/mainnet/status`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);

  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const metrics = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /sovereign_explorer_http_requests_total/);
});
