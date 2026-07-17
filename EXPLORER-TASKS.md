# Explorer Improvement Tasks

This list is intentionally scoped to the explorer application and its deployment.
Items are ordered by production risk, data dependencies, and user impact.

## 1. Durable production history

- [x] Enable `ARCHIVE_DIR` for the production explorer service.
- [x] Confirm the SQLite archive survives a service restart.
- [x] Let the archive backfill contiguously to genesis.
- [x] Require archive completeness in the production readiness check once backfill finishes.
- [x] Confirm account and transaction history no longer depends on the hot-memory window.

## 2. Metrics protection and bounded labels

- [x] Require a production metrics bearer token or ingress allowlist.
- [x] Replace dynamic single-segment metric labels with a fixed route allowlist.
- [x] Bound all in-process metric maps.
- [x] Add regression tests for label cardinality and metrics authorization.

## 3. First-class Transactions index

- [x] Add durable transaction cursor pagination.
- [x] Add a compact transaction-list DTO that omits keys, signatures, and raw payload blobs.
- [x] Add filters for action type, account, execution status, block range, and time range.
- [x] Add a Transactions navigation item and paginated/exportable page.
- [x] Add API and browser integration coverage.

## 4. Finish watchlists and proof capability UX

- [x] Add a local Watchlist page for saved accounts.
- [x] Show balances and recent activity without transmitting the watchlist to the server.
- [x] Advertise proof RPC capability before rendering proof controls.
- [x] Hide or clearly disable unavailable proof verification.
- [x] Add browser tests for local-only persistence and capability states.

## 5. Chain-object explorer indexes

- [x] Index token issuance, transfers, burns, and holder activity.
- [x] Add NFT collection and token detail indexes.
- [x] Index contracts, calls, and emitted events.
- [x] Add HTLC detail and status indexes.
- [x] Add action-type browsing across archived transactions.

## 6. Product and API completion

- [x] Render a real not-found page for unknown routes and objects.
- [x] Paginate account history instead of fixing it at 50 entries.
- [x] Add favicon and complete application metadata.
- [x] Add object-aware titles and share metadata where hash routing permits it.
- [x] Publish a versioned API description and examples.

## 7. Paid API enforcement

- [x] Define a bounded anonymous tier and paid parameter thresholds without breaking ordinary explorer reads.
- [x] Store only hashed, revocable, expiring key records in a root-owned deployment file.
- [x] Add a safe create/list/revoke/rotate key-management CLI that reveals a new secret once.
- [x] Require a valid paid key for GraphQL, high limits, and deep offsets; reject invalid keys closed.
- [x] Enforce per-key quotas and return tier, request-id, limit, remaining, and reset headers.
- [x] Return stable machine-readable payment, authentication, quota, and validation errors.
- [x] Keep key material out of responses, logs, WebSocket URLs, and metrics labels.
- [x] Add enforcement tests for anonymous, missing-key, invalid-key, and paid-key requests.
- [x] Document key provisioning, rotation, and the enforced tier boundaries.

## 8. Release verification and deployment

- [x] Run syntax, unit, integration, and browser smoke checks.
- [x] Verify archive migration and rollback procedures.
- [x] Deploy the explorer as a separate release unit.
- [x] Verify production health, archive completeness, metrics isolation, and historical links.
