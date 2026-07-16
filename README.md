# Sovereign Block Explorer

An independent, zero-runtime-dependency block explorer for the [SOV](https://github.com/cloudzombie/sov)
chain. It indexes redundant, identity-pinned relays over JSON-RPC and serves a REST API, a
GraphQL endpoint, a WebSocket live feed, and a single-page web UI — all from Node's
standard library, **no third-party runtime dependencies**. A built-in SQLite/WAL archive
keeps complete block, transaction, and account history while the bounded in-memory store
remains the low-latency hot cache.

Everything it shows is real chain data read from live nodes. Nothing is simulated.
Mainnet defaults to both public relays; each must identify as `sov-mainnet` and
reproduce the frozen `cb0272ff…e72d` genesis. The explorer fails over when one relay
is unavailable and halts indexing if two healthy relays disagree at a common height.

## What makes it Sovereign

The **Sovereign Proof** view is an evidence surface built from chain-native data:

- relay-by-relay chain-id/genesis pinning, common-head hash agreement, latency, and
  node-vs-index height;
- retained-block measurement of `hybrid65` keys and signatures, including the real
  Ed25519 + ML-DSA-65 byte layout and both-required verification rule;
- live shielded-pool value and the on-chain de-shield window, spent amount, policy
  ceiling, and presently available amount;
- side-by-side empty and non-empty transaction/receipt commitments, explaining why
  transaction-free blocks intentionally share one deterministic empty Merkle root.

It deliberately distinguishes source agreement from independent consensus validation:
the explorer cross-checks relays, while a full node is still required to re-execute the
chain independently.

## Testnet ⇄ Mainnet

The explorer serves every network from one process. Each network is an independent
indexer over its own pinned relay set, and the UI switches between them with a toggle in the
masthead — seamlessly, with a shared history and live feed per network.

A network explicitly disabled with `SOVEREIGN_<NETWORK>_DISABLED=1` is reported as
**not live** via `/networks`; the UI shows a disabled-network panel and never queries it.

```
GET  /networks                 → network availability + readiness/sync phase
GET  /api/<net>/status         → chain stats for that network
GET  /api/<net>/blocks?limit=  → recent blocks
GET  /api/<net>/block/<ref>    → block by height or hash
GET  /api/<net>/tx/<id>        → a transaction
GET  /api/<net>/inclusion-proof/<id> → optional tx + receipt Merkle evidence
GET  /api/<net>/account/<id>   → an account
GET  /api/<net>/proof          → relay/PQ/privacy/commitment evidence
POST /graphql/<net>            → GraphQL
WS   /ws/<net>                 → live block/tx feed
GET  /healthz[?network=<net>&archive=1] → service, network, or full-archive readiness
GET  /metrics                  → Prometheus process/index/relay/cache/WS metrics
```

## Run

Requires Node ≥ 24.15. The durable archive uses Node's built-in `node:sqlite` module.

```sh
# Defaults: testnet seed + both mainnet relays, bound safely to loopback.
# ARCHIVE_DIR enables restart-safe archival indexing.
ARCHIVE_DIR="$PWD/.archive" PORT=8730 node src/server.js

# Override with comma-separated relay lists
SOVEREIGN_TESTNET_RPCS=http://<testnet-a>:8645,http://<testnet-b>:8645 \
SOVEREIGN_MAINNET_RPCS=http://<mainnet-a>:8645,http://<mainnet-b>:8645 \
HOST=127.0.0.1 PORT=8730 node src/server.js
```

Then open `http://127.0.0.1:8730`.

| Env var | Default | Purpose |
|---|---|---|
| `SOVEREIGN_TESTNET_RPCS` | `http://159.203.109.204:8645` | Comma-separated testnet relays |
| `SOVEREIGN_MAINNET_RPCS` | NY + SF public relays | Comma-separated mainnet relays |
| `SOVEREIGN_<NETWORK>_DISABLED` | unset | Set to `1` to disable that network |
| `HOST` | `127.0.0.1` | HTTP bind address; publish through a TLS reverse proxy |
| `PORT` | `8730` | HTTP + WS port |
| `EXPLORER_ROLE` | `all` | `all`, single-writer `ingest`, or read-only-archive `serve` |
| `INDEX_BACKFILL_BLOCKS` | `640` | Recent blocks retained after a cold start |
| `INDEX_BATCH_SIZE` | `8` | Bounded concurrent block fetch width |
| `ARCHIVE_DIR` | unset | Directory for one SQLite/WAL archive per enabled network |
| `ARCHIVE_BACKFILL_BATCH` | `16` | Older blocks archived per sync tick, fetched with bounded concurrency |
| `MAX_STORE_BLOCKS` | `10000` | Hard in-memory block ceiling |
| `MAX_STORE_MIB` | `256` | Hard in-memory indexed-byte ceiling |
| `RPC_TIMEOUT_MS` | `5000` | Per-relay request timeout |
| `HTTP_REQUESTS_PER_MINUTE` | `600` | In-process HTTP safety limit per client |
| `GRAPHQL_REQUESTS_PER_MINUTE` | `60` | GraphQL safety limit per client |
| `GLOBAL_HTTP_REQUESTS_PER_MINUTE` | `30000` | Process-wide HTTP ceiling across all clients |
| `GLOBAL_GRAPHQL_REQUESTS_PER_MINUTE` | `3000` | Process-wide GraphQL ceiling across all clients |
| `HTTP_MAX_CONNECTIONS` | `2000` | Process-wide TCP connection ceiling |
| `METRICS_TOKEN` | unset | Optional bearer token required by `/metrics` |
| `REQUIRE_TLS_RELAYS` | unset | Set to `1` in production; rejects non-loopback plain-HTTP relays |
| `WS_MAX_CLIENTS` | `1000` | Process-wide WebSocket connection ceiling across networks |
| `WS_MAX_CLIENTS_PER_NETWORK` | `750` | WebSocket ceiling for one network |
| `WS_MAX_PER_IP` | `20` | WebSocket connection ceiling per client IP |

```sh
npm test          # unit tests (indexer, store, graphql)
npm run check     # syntax + complete unit/integration suite
```

## Deploy

`deploy/sovereign-explorer.service` is a sandboxed systemd unit with a private,
systemd-managed archive directory. `deploy/nginx-sovereign-explorer.conf` terminates
public TLS and enforces per-client plus edge-global request/connection limits.
`deploy/nginx-sovereign-relay.conf` is the relay-side TLS proxy template; each relay
needs its own DNS name/certificate and only permits the explorer ingress IP. The
process itself also caps request bodies,
GraphQL depth/fields, historical RPC fan-out, WebSocket clients/backpressure, store
bytes, and store blocks. Its sync phase and relay agreement are visible in `/healthz`,
`/api/<net>/status`, and the UI, so a cold backfill is never presented as live tip data.
The aggregate health check remains available when at least one configured network is
ready and reports `degraded: true` for a partial outage; use
`/healthz?network=mainnet` when a deployment requires mainnet-specific readiness, or
append `&archive=1` when traffic must wait for a contiguous genesis-to-head archive.

The SQLite archive is the durable single-ingester source for this deployment and can
be rebuilt entirely from identity-pinned relays. Never run two writers against the
same database files. At multi-ingress scale, keep one canonical ingester and replicate
the durable index into a read-oriented database; do not raise in-memory ceilings or
point multiple processes at one SQLite file.

For a split deployment, run exactly one `npm run start:ingest` process against the
archive and one or more `npm run start:serve` processes with read-only archive handles.
Place a durable database/commit-log replication layer between hosts before scaling
beyond one local WAL archive. The UI keeps watchlists in browser local storage only,
can export the currently displayed blocks/account history as CSV or JSON, and explains
actions while retaining their exact payloads.

The inclusion-evidence endpoint calls optional `sov_getTransactionProof` and
`sov_getReceiptProof` relay methods. Absence is reported as unsupported, never as a
valid proof. The browser currently recomputes SHA-256 proof paths; other algorithms
are labeled unsupported until a reviewed verifier is shipped.

## License

MIT.
