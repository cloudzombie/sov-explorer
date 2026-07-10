#!/usr/bin/env node
// SOV block explorer: redundant relay indexer + bounded public read API.
//
// Mainnet reads from both public relays by default. Each relay is pinned to the
// canonical chain id/genesis by SovereignRpc before any indexed data is trusted.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { SovereignRpc } from './rpc.js';
import { Store } from './store.js';
import { Indexer } from './indexer.js';
import { handleRest } from './rest.js';
import { executeGraphql, schemaRoots } from './graphql.js';
import { WsHub } from './ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = normalize(join(HERE, '..', 'web'));

const MAINNET_GENESIS = 'cb0272ff88e64c18cde0257f7fae1c8236b02651f10cc7a02456fd682ee2e72d';
const TESTNET_GENESIS = '4d7d9123a489f4fd29486da3d66a6c20b04953cb886dee847662e11af293da15';
const DEFAULT_MAINNET_RELAYS = 'http://64.225.10.34:8645,http://137.184.83.91:8645';
const DEFAULT_TESTNET_RELAYS = 'http://159.203.109.204:8645';

function envInt(name, fallback, lo, hi) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(lo, Math.min(hi, Math.trunc(value))) : fallback;
}

function relayList(pluralName, singularName, fallback) {
  const value = process.env[pluralName] || process.env[singularName] || fallback;
  return String(value).split(',').map((url) => url.trim()).filter(Boolean);
}

const NETWORKS = {
  testnet: {
    urls: process.env.SOVEREIGN_TESTNET_DISABLED === '1'
      ? []
      : relayList('SOVEREIGN_TESTNET_RPCS', 'SOVEREIGN_TESTNET_RPC', DEFAULT_TESTNET_RELAYS),
    chainId: 'sov-testnet-1',
    genesisHash: TESTNET_GENESIS,
  },
  mainnet: {
    urls: process.env.SOVEREIGN_MAINNET_DISABLED === '1'
      ? []
      : relayList('SOVEREIGN_MAINNET_RPCS', 'SOVEREIGN_MAINNET_RPC', DEFAULT_MAINNET_RELAYS),
    chainId: 'sov-mainnet',
    genesisHash: MAINNET_GENESIS,
  },
};

const HOST = process.env.HOST || '127.0.0.1';
const PORT = envInt('PORT', Number(process.argv[3]) || 8730, 1, 65_535);
const RPC_TIMEOUT_MS = envInt('RPC_TIMEOUT_MS', 5_000, 500, 60_000);
const INDEX_BACKFILL = envInt('INDEX_BACKFILL_BLOCKS', 640, 32, 10_000);
const INDEX_BATCH = envInt('INDEX_BATCH_SIZE', 8, 1, 32);
const MAX_STORE_BLOCKS = envInt('MAX_STORE_BLOCKS', 10_000, 100, 100_000);
const MAX_STORE_BYTES = envInt('MAX_STORE_MIB', 256, 16, 4096) * 1024 * 1024;
const MAX_BODY_BYTES = envInt('MAX_REQUEST_BODY_KIB', 64, 4, 1024) * 1024;
const HTTP_RPM = envInt('HTTP_REQUESTS_PER_MINUTE', 600, 30, 100_000);
const GRAPHQL_RPM = envInt('GRAPHQL_REQUESTS_PER_MINUTE', 60, 5, 10_000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function blockSummary(b) {
  return {
    height: b.height,
    hash: b.hash,
    proposer: b.proposer,
    txCount: b.txCount,
    coinbase: b.coinbase,
    timestampMs: b.timestampMs,
    final: b.final,
  };
}

// Build an isolated store/indexer/hub per network. Mainnet's one logical RPC client
// owns both relay URLs and handles identity checks, failover, and cross-checking.
const nets = new Map();
for (const [name, config] of Object.entries(NETWORKS)) {
  const store = new Store({ maxBlocks: MAX_STORE_BLOCKS, maxBytes: MAX_STORE_BYTES });
  const wsHub = new WsHub({
    maxClients: envInt('WS_MAX_CLIENTS', 1_000, 10, 100_000),
    maxPerIp: envInt('WS_MAX_PER_IP', 20, 1, 1_000),
  });
  const rpc = config.urls.length
    ? new SovereignRpc(config.urls, {
        expectedChainId: config.chainId,
        expectedGenesisHash: config.genesisHash,
        timeoutMs: RPC_TIMEOUT_MS,
      })
    : null;
  const indexer = rpc
    ? new Indexer(rpc, store, {
        backfill: INDEX_BACKFILL,
        batchSize: INDEX_BATCH,
        onBlock: (b) => wsHub.broadcast({ type: 'block', block: blockSummary(b) }),
        onTx: (t) =>
          wsHub.broadcast({
            type: 'tx',
            tx: {
              id: t.id,
              signer: t.signer,
              action: t.action,
              blockHeight: t.blockHeight,
              timestampMs: t.timestampMs,
            },
          }),
        onReset: () => wsHub.broadcast({ type: 'reset' }),
      })
    : null;
  nets.set(name, { name, store, rpc, wsHub, indexer, live: !!rpc });
}

function baseHeaders(contentType, cacheControl) {
  return {
    ...SECURITY_HEADERS,
    'access-control-allow-origin': CORS_ORIGIN,
    'cache-control': cacheControl,
    'content-type': contentType,
  };
}

function send(res, status, body, contentType = 'application/json; charset=utf-8', opts = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    ...baseHeaders(contentType, opts.cacheControl ?? 'no-store'),
    'content-length': payload.length,
  });
  if (opts.head) res.end();
  else res.end(payload);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const error = new Error(`request body exceeds ${maxBytes} byte limit`);
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!settled) reject(Object.assign(new Error('request read failed'), { status: 400 }));
    });
  });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'GET or HEAD only', 'text/plain; charset=utf-8');
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(WEB_DIR, rel));
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + (process.platform === 'win32' ? '\\' : '/'))) {
    return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  }
  try {
    const data = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    send(res, 200, data, CONTENT_TYPES[ext] || 'application/octet-stream', {
      head: req.method === 'HEAD',
      cacheControl: rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
    });
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

// Small in-process fixed-window limiter. Production deployments should keep the
// reverse-proxy limit too; this layer prevents a proxy mistake from becoming an
// unbounded GraphQL/RPC amplifier.
const rateWindows = new Map();
let rateRequests = 0;
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function rateAllowed(req, pathname) {
  const nowWindow = Math.floor(Date.now() / 60_000);
  const limit = pathname.startsWith('/graphql/') ? GRAPHQL_RPM : HTTP_RPM;
  const key = `${clientIp(req)}:${pathname.startsWith('/graphql/') ? 'graphql' : 'http'}`;
  const current = rateWindows.get(key);
  const next = !current || current.window !== nowWindow
    ? { window: nowWindow, count: 1 }
    : { window: nowWindow, count: current.count + 1 };
  rateWindows.set(key, next);
  rateRequests += 1;
  if (rateRequests % 1_000 === 0) {
    for (const [entryKey, value] of rateWindows) {
      if (value.window < nowWindow - 1) rateWindows.delete(entryKey);
    }
  }
  return next.count <= limit;
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, JSON.stringify({ error: 'malformed URL' }));
  }
  const pathname = url.pathname;

  if (!rateAllowed(req, pathname)) {
    return send(res, 429, JSON.stringify({ error: 'rate limit exceeded' }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...baseHeaders('text/plain; charset=utf-8', 'no-store'),
      'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  if (pathname === '/healthz') {
    const requested = url.searchParams.get('network');
    const selected = requested ? [nets.get(requested)].filter(Boolean) : [...nets.values()].filter((net) => net.live);
    if (requested && selected.length === 0) {
      return send(res, 404, JSON.stringify({ ok: false, error: 'unknown network' }));
    }
    const states = Object.fromEntries(selected.map((net) => [net.name, {
      live: net.live,
      ready: net.store.ready,
      phase: net.store.syncPhase,
    }]));
    const readyCount = selected.filter((net) => net.live && net.store.ready).length;
    const ok = requested ? readyCount === selected.length : readyCount > 0;
    const degraded = readyCount < selected.filter((net) => net.live).length;
    return send(res, ok ? 200 : 503, JSON.stringify({ ok, degraded, networks: states }));
  }

  if (pathname === '/networks') {
    return send(
      res,
      200,
      JSON.stringify([...nets.values()].map((net) => ({
        name: net.name,
        live: net.live,
        ready: net.store.ready,
        phase: net.store.syncPhase,
      }))),
    );
  }

  const gql = pathname.match(/^\/graphql\/([a-z0-9-]+)$/);
  if (gql) {
    const net = nets.get(gql[1]);
    if (!net) return send(res, 404, JSON.stringify({ errors: [{ message: 'unknown network' }] }));
    if (!net.live) return send(res, 503, JSON.stringify({ errors: [{ message: 'network not live' }] }));
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ errors: [{ message: 'POST only' }] }));
    const body = await readBody(req);
    let query = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.query === 'string') query = parsed.query;
    } catch {
      // Raw GraphQL query strings are supported.
    }
    const result = await executeGraphql(query, { store: net.store, rpc: net.rpc }, schemaRoots);
    return send(res, 200, JSON.stringify(result));
  }

  const apim = pathname.match(/^\/api\/([a-z0-9-]+)(\/.*)?$/);
  if (apim) {
    const net = nets.get(apim[1]);
    if (!net) return send(res, 404, JSON.stringify({ error: 'unknown network' }));
    if (!net.live) return send(res, 503, JSON.stringify({ error: 'network not live', live: false }));
    const sub = apim[2] || '/';
    const rest = await handleRest(req.method, '/api' + sub, url.searchParams, {
      store: net.store,
      rpc: net.rpc,
    });
    if (rest) return send(res, rest.status, rest.body);
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  }

  return serveStatic(req, res, pathname);
}

const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  handleRequest(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? 'internal server error' : error.message;
    send(res, status, JSON.stringify({ error: message }));
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

server.on('upgrade', (req, socket) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return socket.destroy();
  }
  const match = url.pathname.match(/^\/ws\/([a-z0-9-]+)$/);
  const net = match && nets.get(match[1]);
  if (net?.live) net.wsHub.handleUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`sovereign-explorer: web UI + API on http://${HOST}:${PORT}`);
  for (const net of nets.values()) {
    if (net.indexer) {
      const relayCount = net.rpc.status().relays.length;
      console.log(`sovereign-explorer: ${net.name} configured with ${relayCount} pinned relay(s)`);
      net.indexer.start(1_000);
    } else {
      console.log(`sovereign-explorer: ${net.name} disabled (no relay configured)`);
    }
  }
});

function shutdown() {
  for (const net of nets.values()) {
    net.indexer?.stop();
    net.wsHub.stop();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
