# Sovereign Block Explorer

An independent, zero-dependency block explorer for the [SOV](https://github.com/cloudzombie/sov)
chain. It indexes one or more live nodes over JSON-RPC and serves a REST API, a
GraphQL endpoint, a WebSocket live feed, and a single-page web UI — all from Node's
standard library, **no runtime dependencies**.

Everything it shows is real chain data read from a live node. Nothing is simulated.

## Testnet ⇄ Mainnet

The explorer serves every network from one process. Each network is an independent
indexer over its own node's RPC, and the UI switches between them with a toggle in the
masthead — seamlessly, with a shared history and live feed per network.

A network with no RPC configured is reported as **not live** (via `/networks`); the UI
shows a *launching-soon* panel and never queries it. So **mainnet is wired in later by
just setting one environment variable and restarting** — no code or UI change.

```
GET  /networks                 → [{ "name": "testnet", "live": true }, { "name": "mainnet", "live": false }]
GET  /api/<net>/status         → chain stats for that network
GET  /api/<net>/blocks?limit=  → recent blocks
GET  /api/<net>/block/<ref>    → block by height or hash
GET  /api/<net>/tx/<id>        → a transaction
GET  /api/<net>/account/<id>   → an account
POST /graphql/<net>            → GraphQL
WS   /ws/<net>                 → live block/tx feed
```

## Run

Requires Node ≥ 18.

```sh
# Testnet only (defaults to the public seed node)
SOVEREIGN_TESTNET_RPC=http://159.203.109.204:8645 PORT=8730 node src/server.js

# Add mainnet the moment its node exists — nothing else changes
SOVEREIGN_TESTNET_RPC=http://<testnet-node>:8645 \
SOVEREIGN_MAINNET_RPC=http://<mainnet-node>:8645 \
PORT=8730 node src/server.js
```

Then open `http://127.0.0.1:8730`.

| Env var | Default | Purpose |
|---|---|---|
| `SOVEREIGN_TESTNET_RPC` | `http://159.203.109.204:8645` | Testnet node RPC |
| `SOVEREIGN_MAINNET_RPC` | *(empty → not live)* | Mainnet node RPC |
| `PORT` | `8730` | HTTP + WS port |

```sh
npm test          # unit tests (indexer, store, graphql)
```

## Deploy

`deploy/sovereign-explorer.service` is a systemd unit for a small VPS. Point the two
RPC env vars at your nodes and it serves the explorer on `PORT`. See the unit's header
for install steps. Because it holds no state (it indexes on boot), it is restart-safe.

## License

MIT.
