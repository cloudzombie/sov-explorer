#!/usr/bin/env node
// SOV block explorer: redundant relay indexer + bounded public read API.
//
// Mainnet reads from both public relays by default. Each relay is pinned to the
// canonical chain id/genesis by SovereignRpc before any indexed data is trusted.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { openArchive } from './archive.js';
import { SovereignRpc } from './rpc.js';
import { Store } from './store.js';
import { Indexer } from './indexer.js';
import { handleRest } from './rest.js';
import { executeGraphql, schemaRoots } from './graphql.js';
import { WsHub } from './ws.js';
import { RateGate } from './limits.js';
import { Metrics, routeTemplate } from './metrics.js';
import { ApiAccess, ApiAccessError, evaluatePaidRequirement } from './api-access.js';

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
const ARCHIVE_BACKFILL_BATCH = envInt('ARCHIVE_BACKFILL_BATCH', 16, 1, 64);
const ARCHIVE_DIR = String(process.env.ARCHIVE_DIR || '').trim();
const MAX_STORE_BLOCKS = envInt('MAX_STORE_BLOCKS', 10_000, 100, 100_000);
const MAX_STORE_BYTES = envInt('MAX_STORE_MIB', 256, 16, 4096) * 1024 * 1024;
const MAX_BODY_BYTES = envInt('MAX_REQUEST_BODY_KIB', 64, 4, 1024) * 1024;
const HTTP_RPM = envInt('HTTP_REQUESTS_PER_MINUTE', 600, 30, 100_000);
const GRAPHQL_RPM = envInt('GRAPHQL_REQUESTS_PER_MINUTE', 60, 5, 10_000);
const GLOBAL_HTTP_RPM = envInt('GLOBAL_HTTP_REQUESTS_PER_MINUTE', 30_000, 100, 10_000_000);
const GLOBAL_GRAPHQL_RPM = envInt('GLOBAL_GRAPHQL_REQUESTS_PER_MINUTE', 3_000, 10, 1_000_000);
const HTTP_MAX_CONNECTIONS = envInt('HTTP_MAX_CONNECTIONS', 2_000, 10, 100_000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const REQUIRE_TLS_RELAYS = process.env.REQUIRE_TLS_RELAYS === '1';
const METRICS_TOKEN = String(process.env.METRICS_TOKEN || '').trim();
const API_KEYS_FILE = String(process.env.API_KEYS_FILE || '').trim();
const REQUIRE_COMPLETE_ARCHIVE = process.env.REQUIRE_COMPLETE_ARCHIVE === '1';
const ROLE = ['all', 'ingest', 'serve'].includes(process.env.EXPLORER_ROLE)
  ? process.env.EXPLORER_ROLE
  : 'all';

const apiAccess = await ApiAccess.fromFile(API_KEYS_FILE);

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
const metrics = new Metrics();
const wsSharedCapacity = {
  count: 0,
  max: envInt('WS_MAX_CLIENTS', 1_000, 10, 100_000),
};
for (const [name, config] of Object.entries(NETWORKS)) {
  const archive = ARCHIVE_DIR && config.urls.length
    ? await openArchive(join(ARCHIVE_DIR, `${name}.sqlite`), { readOnly: ROLE === 'serve' })
    : null;
  const store = new Store({
    maxBlocks: MAX_STORE_BLOCKS,
    maxBytes: MAX_STORE_BYTES,
    archive,
  });
  const wsHub = new WsHub({
    maxClients: envInt('WS_MAX_CLIENTS_PER_NETWORK', 750, 10, 100_000),
    maxPerIp: envInt('WS_MAX_PER_IP', 20, 1, 1_000),
    sharedCapacity: wsSharedCapacity,
  });
  const rpc = config.urls.length
    ? new SovereignRpc(config.urls, {
        expectedChainId: config.chainId,
        expectedGenesisHash: config.genesisHash,
        timeoutMs: RPC_TIMEOUT_MS,
        requireTls: REQUIRE_TLS_RELAYS,
        metrics,
        networkName: name,
      })
    : null;
  const indexer = rpc
    ? new Indexer(rpc, store, {
        backfill: INDEX_BACKFILL,
        batchSize: INDEX_BATCH,
        archiveBatchSize: ARCHIVE_BACKFILL_BATCH,
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
    'access-control-expose-headers': 'x-request-id, x-api-tier, x-api-upgrade-required, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after',
    'cache-control': cacheControl,
    'content-type': contentType,
  };
}

function send(res, status, body, contentType = 'application/json; charset=utf-8', opts = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    ...baseHeaders(contentType, opts.cacheControl ?? 'no-store'),
    ...(opts.headers ?? {}),
    'content-length': payload.length,
  });
  if (opts.head) res.end();
  else res.end(payload);
}

function apiHeaders(requestId, access = null, extra = {}) {
  const headers = {
    'x-request-id': requestId,
    'x-api-tier': access?.tier ?? 'anonymous',
    ...extra,
  };
  if (access?.quota) {
    headers['x-ratelimit-limit'] = String(access.quota.limit);
    headers['x-ratelimit-remaining'] = String(access.quota.remaining);
    headers['x-ratelimit-reset'] = String(access.quota.reset);
  }
  return headers;
}

function sendApiError(res, status, code, message, requestId, { access = null, headers = {}, upgrade = false, details = null } = {}) {
  const authentication = status === 401 ? { 'www-authenticate': 'Bearer realm="Sovereign Explorer API"' } : {};
  const payment = upgrade ? { 'x-api-upgrade-required': 'true' } : {};
  return send(res, status, JSON.stringify({
    error: { code, message, requestId, ...(upgrade ? { paidAccessRequired: true } : {}), ...(details ? { details } : {}) },
  }), undefined, { headers: apiHeaders(requestId, access, { ...authentication, ...payment, ...headers }) });
}

function authorizeApi(req, pathname, query, { graphql = false } = {}) {
  const requirement = evaluatePaidRequirement(pathname, query, { graphql });
  const access = apiAccess.authorize(req, requirement);
  metrics.observeApiAccess(access.tier, requirement.required ? 'paid' : 'standard');
  return access;
}

function apiErrorCode(status) {
  if (status === 400) return 'validation_error';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 502 || status === 503) return 'upstream_unavailable';
  return 'request_failed';
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
      // Unfingerprinted application assets must revalidate so a deployment cannot
      // pair new HTML/modules with a stale cached app.js or stylesheet.
      cacheControl: /\.(?:html|js|css)$/.test(rel) ? 'no-cache' : 'public, max-age=300',
    });
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

// Small in-process fixed-window limiter. Production deployments should keep the
// reverse-proxy limit too; this layer prevents a proxy mistake from becoming an
// unbounded GraphQL/RPC amplifier.
const rateGate = new RateGate({
  clientHttp: HTTP_RPM,
  clientGraphql: GRAPHQL_RPM,
  globalHttp: GLOBAL_HTTP_RPM,
  globalGraphql: GLOBAL_GRAPHQL_RPM,
});
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function rateAllowed(req, pathname) {
  const kind = pathname.startsWith('/graphql/') ? 'graphql' : 'http';
  return rateGate.allow(clientIp(req), kind);
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, JSON.stringify({ error: 'malformed URL' }));
  }
  const pathname = url.pathname;

  if (pathname === '/metrics') {
    if (METRICS_TOKEN && req.headers.authorization !== `Bearer ${METRICS_TOKEN}`) {
      return send(res, 401, 'unauthorized', 'text/plain; charset=utf-8');
    }
    return send(res, 200, metrics.render([...nets.values()]), 'text/plain; version=0.0.4; charset=utf-8');
  }

  const rate = rateAllowed(req, pathname);
  if (!rate.allowed) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/graphql/')) {
      return sendApiError(res, 429, 'rate_limit_exceeded', 'The client request rate is exhausted.', randomUUID(), {
        headers: { 'retry-after': String(rate.retryAfterSeconds) },
        details: { scope: rate.scope },
      });
    }
    return send(res, 429, JSON.stringify({ error: 'rate limit exceeded', scope: rate.scope }), undefined, {
      headers: { 'retry-after': String(rate.retryAfterSeconds) },
    });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...baseHeaders('text/plain; charset=utf-8', 'no-store'),
      'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-api-key',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  if (pathname === '/healthz') {
    const requested = url.searchParams.get('network');
    const requireArchive = REQUIRE_COMPLETE_ARCHIVE || url.searchParams.get('archive') === '1';
    const selected = requested ? [nets.get(requested)].filter(Boolean) : [...nets.values()].filter((net) => net.live);
    if (requested && selected.length === 0) {
      return send(res, 404, JSON.stringify({ ok: false, error: 'unknown network' }));
    }
    const states = Object.fromEntries(selected.map((net) => {
      const archive = net.store.archive?.status(net.store.nodeHeight) ?? { enabled: false };
      return [net.name, {
        live: net.live,
        ready: net.store.ready,
        phase: net.store.syncPhase,
        archive,
      }];
    }));
    const readyCount = selected.filter((net) => {
      const archiveReady = !requireArchive || !!net.store.archive?.status(net.store.nodeHeight).complete;
      return net.live && net.store.ready && archiveReady;
    }).length;
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
        archive: net.store.archive?.status(net.store.nodeHeight) ?? { enabled: false },
      }))),
    );
  }

  const gql = pathname.match(/^\/graphql\/([a-z0-9-]+)$/);
  if (gql) {
    const requestId = randomUUID();
    req.sovRequestId = requestId;
    let access;
    try {
      access = authorizeApi(req, pathname, url.searchParams, { graphql: true });
      req.sovApiAccess = access;
    } catch (error) {
      if (!(error instanceof ApiAccessError)) throw error;
      metrics.observeApiAccess('anonymous', 'rejected');
      return sendApiError(res, error.status, error.code, error.message, requestId, error);
    }
    const net = nets.get(gql[1]);
    if (!net) return sendApiError(res, 404, 'unknown_network', 'Unknown network.', requestId, { access });
    if (req.method !== 'POST') return sendApiError(res, 405, 'method_not_allowed', 'POST only.', requestId, { access });
    const body = await readBody(req);
    if (!net.live) return sendApiError(res, 503, 'network_unavailable', 'Network not live.', requestId, { access });
    let query = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.query === 'string') query = parsed.query;
    } catch {
      // Raw GraphQL query strings are supported.
    }
    const result = await executeGraphql(query, { store: net.store, rpc: net.rpc }, schemaRoots);
    result.extensions = { ...(result.extensions ?? {}), requestId };
    return send(res, 200, JSON.stringify(result), undefined, { headers: apiHeaders(requestId, access) });
  }

  const apim = pathname.match(/^\/api\/(?:v1\/)?([a-z0-9-]+)(\/.*)?$/);
  if (apim) {
    const requestId = randomUUID();
    req.sovRequestId = requestId;
    let access;
    try {
      access = authorizeApi(req, pathname, url.searchParams);
      req.sovApiAccess = access;
    } catch (error) {
      if (!(error instanceof ApiAccessError)) throw error;
      metrics.observeApiAccess('anonymous', 'rejected');
      return sendApiError(res, error.status, error.code, error.message, requestId, error);
    }
    const net = nets.get(apim[1]);
    if (!net) return sendApiError(res, 404, 'unknown_network', 'Unknown network.', requestId, { access });
    if (!net.live) return sendApiError(res, 503, 'network_unavailable', 'Network not live.', requestId, { access });
    const sub = apim[2] || '/';
    const rest = await handleRest(req.method, '/api' + sub, url.searchParams, {
      store: net.store,
      rpc: net.rpc,
      metrics,
      apiTier: access.tier,
    });
    if (rest?.status >= 400) {
      let parsed = {};
      try { parsed = JSON.parse(rest.body); } catch {}
      const message = typeof parsed.error === 'string' ? parsed.error : 'Request failed.';
      const { error: _, ...details } = parsed;
      return sendApiError(res, rest.status, apiErrorCode(rest.status), message, requestId, {
        access,
        details: Object.keys(details).length ? details : null,
      });
    }
    if (rest) return send(res, rest.status, rest.body, undefined, { headers: apiHeaders(requestId, access) });
    return sendApiError(res, 404, 'not_found', 'Not found.', requestId, { access });
  }

  return serveStatic(req, res, pathname);
}

const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  const started = performance.now();
  res.once('finish', () => {
    let pathname = 'malformed';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
    metrics.observeRequest(req.method, routeTemplate(pathname), res.statusCode, performance.now() - started);
  });
  handleRequest(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? 'internal server error' : error.message;
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
    if (pathname.startsWith('/api/') || pathname.startsWith('/graphql/')) {
      return sendApiError(
        res,
        status,
        status === 413 ? 'payload_too_large' : status >= 500 ? 'internal_error' : 'request_failed',
        message,
        req.sovRequestId ?? randomUUID(),
        { access: req.sovApiAccess ?? null },
      );
    }
    send(res, status, JSON.stringify({ error: message }));
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.maxConnections = HTTP_MAX_CONNECTIONS;

server.on('upgrade', (req, socket) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return socket.destroy();
  }
  const match = url.pathname.match(/^\/ws\/([a-z0-9-]+)$/);
  const net = match && nets.get(match[1]);
  if (net?.live) {
    req.sovClientIp = clientIp(req);
    net.wsHub.handleUpgrade(req, socket);
  }
  else socket.destroy();
});

async function startRuntime() {
  for (const net of nets.values()) {
    if (net.indexer) {
      const relayCount = net.rpc.status().relays.length;
      console.log(`sovereign-explorer: ${net.name} configured with ${relayCount} pinned relay(s)`);
      if (ROLE !== 'serve') net.indexer.start(1_000);
      else {
        // A serve-only replica tails the durable archive written by the ingest
        // process. It retains direct read RPC access but never advances ingestion.
        await net.indexer.init();
        const refresh = async () => {
          const records = net.store.archive?.recentBlocks(net.store.maxBlocks).reverse() ?? [];
          for (const record of records) {
            if (!net.store.block(record.height)) net.store.addBlock(record, { persist: false });
          }
          const head = await net.rpc.height().catch(() => net.store.tipHeight);
          net.store.setSyncStatus({ nodeHeight: head, ready: net.store.tipHeight >= 0, syncing: false, phase: 'serving-archive' });
        };
        await refresh();
        net.serveTimer = setInterval(refresh, 1_000);
        net.serveTimer.unref();
      }
    } else {
      console.log(`sovereign-explorer: ${net.name} disabled (no relay configured)`);
    }
  }
}

if (ROLE === 'ingest') {
  if (!ARCHIVE_DIR) throw new Error('EXPLORER_ROLE=ingest requires ARCHIVE_DIR');
  console.log('sovereign-explorer: ingest-only role (public HTTP disabled)');
  await startRuntime();
} else {
  if (ROLE === 'serve' && !ARCHIVE_DIR) throw new Error('EXPLORER_ROLE=serve requires ARCHIVE_DIR');
  server.listen(PORT, HOST, () => {
    console.log(`sovereign-explorer: web UI + API on http://${HOST}:${PORT} (${ROLE})`);
    startRuntime().catch((error) => {
      console.error(`sovereign-explorer: startup failed: ${error.message}`);
      shutdown();
    });
  });
}

function shutdown() {
  for (const net of nets.values()) {
    net.indexer?.stop();
    if (net.serveTimer) clearInterval(net.serveTimer);
    net.wsHub.stop();
    net.store.archive?.close();
  }
  if (server.listening) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('SIGHUP', () => {
  apiAccess.reload()
    .then((count) => console.log(`sovereign-explorer: reloaded ${count} paid API key record(s)`))
    .catch((error) => console.error(`sovereign-explorer: API key reload failed: ${error.message}`));
});
