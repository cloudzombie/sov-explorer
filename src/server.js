#!/usr/bin/env node
// The Sovereign block explorer server: indexes one or more live networks
// (testnet + mainnet) and serves a REST API, a GraphQL endpoint, a WebSocket live
// feed, and the static web UI — all from Node's standard library, no external
// dependencies. The web UI switches between networks seamlessly; each network is
// an independent indexer over its own node's JSON-RPC.
//
//   SOVEREIGN_TESTNET_RPC=http://host:8645 \
//   SOVEREIGN_MAINNET_RPC=http://host:8645 \   # optional; omit until mainnet is live
//   PORT=8730 node src/server.js
//
// A network with no RPC configured is reported as "not live" via /networks; the UI
// shows a launching-soon state and never queries it — so mainnet can be wired in
// later by just setting SOVEREIGN_MAINNET_RPC and restarting, with zero UI changes.

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

// Network → node RPC endpoint. Testnet defaults to the public seed node so a fresh
// deploy works out of the box; mainnet is empty until its node is live.
const NETWORK_RPCS = {
  testnet: process.env.SOVEREIGN_TESTNET_RPC || process.argv[2] || 'http://159.203.109.204:8645',
  mainnet: process.env.SOVEREIGN_MAINNET_RPC || '',
};
const PORT = Number(process.env.PORT || process.argv[3] || 8730);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function blockSummary(b) {
  return {
    height: b.height,
    hash: b.hash,
    proposer: b.proposer,
    txCount: b.txCount,
    timestampMs: b.timestampMs,
    final: b.final,
  };
}

// Build an independent context per network. A network with no RPC is "not live":
// no indexer runs, and /networks reports it so the UI shows a launching-soon state.
const nets = new Map();
for (const [name, rpcUrl] of Object.entries(NETWORK_RPCS)) {
  const store = new Store();
  const wsHub = new WsHub();
  const rpc = rpcUrl ? new SovereignRpc(rpcUrl) : null;
  const indexer = rpc
    ? new Indexer(rpc, store, {
        onBlock: (b) => wsHub.broadcast({ type: 'block', block: blockSummary(b) }),
        onTx: (t) =>
          wsHub.broadcast({
            type: 'tx',
            tx: { id: t.id, signer: t.signer, action: t.action, blockHeight: t.blockHeight },
          }),
        onReset: () => wsHub.broadcast({ type: 'reset' }),
      })
    : null;
  nets.set(name, { name, rpcUrl, store, rpc, wsHub, indexer, live: !!rpcUrl });
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'access-control-allow-origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(WEB_DIR, rel));
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + (process.platform === 'win32' ? '\\' : '/'))) {
    return send(res, 403, 'forbidden', 'text/plain');
  }
  try {
    const data = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    send(res, 200, data, CONTENT_TYPES[ext] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Network discovery: which networks exist and which are live. The UI reads this
  // to render the network switch and gate a not-yet-live network's queries.
  if (pathname === '/networks') {
    return send(
      res,
      200,
      JSON.stringify([...nets.values()].map((n) => ({ name: n.name, live: n.live }))),
    );
  }

  // GraphQL, network-scoped: /graphql/<net>
  const gql = pathname.match(/^\/graphql\/([a-z0-9-]+)$/);
  if (gql) {
    const net = nets.get(gql[1]);
    if (!net) return send(res, 404, JSON.stringify({ errors: [{ message: 'unknown network' }] }));
    if (!net.live) return send(res, 503, JSON.stringify({ errors: [{ message: 'network not live yet' }] }));
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ errors: [{ message: 'POST only' }] }));
    const body = await readBody(req);
    let query = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.query === 'string') query = parsed.query;
    } catch {
      /* raw GraphQL query string */
    }
    const result = await executeGraphql(query, { store: net.store, rpc: net.rpc }, schemaRoots);
    return send(res, 200, JSON.stringify(result));
  }

  // REST, network-scoped: /api/<net>/<sub>... → dispatch to that network's store/rpc.
  const apim = pathname.match(/^\/api\/([a-z0-9-]+)(\/.*)?$/);
  if (apim) {
    const net = nets.get(apim[1]);
    if (!net) return send(res, 404, JSON.stringify({ error: 'unknown network' }));
    if (!net.live) return send(res, 503, JSON.stringify({ error: 'network not live yet', live: false }));
    const sub = apim[2] || '/';
    const rest = await handleRest(req.method, '/api' + sub, url.searchParams, {
      store: net.store,
      rpc: net.rpc,
    });
    if (rest) return send(res, rest.status, rest.body);
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  }

  return serveStatic(res, pathname);
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/ws\/([a-z0-9-]+)$/);
  const net = m && nets.get(m[1]);
  if (net && net.live) net.wsHub.handleUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`sovereign-explorer: web UI + API on http://0.0.0.0:${PORT}`);
  for (const n of nets.values()) {
    if (n.indexer) {
      console.log(`sovereign-explorer: indexing ${n.name} at ${n.rpcUrl}`);
      n.indexer.start(1000);
    } else {
      console.log(
        `sovereign-explorer: ${n.name} not configured (set SOVEREIGN_${n.name.toUpperCase()}_RPC to enable)`,
      );
    }
  }
});
