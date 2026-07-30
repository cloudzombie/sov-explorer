// Transaction timing: capture, pairing, persistence, honest nulls, and graceful
// degradation against a node that does not serve the two timing RPCs (which is
// every node deployed today).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openArchive } from '../src/archive.js';
import { executeGraphql, schemaRoots } from '../src/graphql.js';
import { Indexer } from '../src/indexer.js';
import { handleRest } from '../src/rest.js';
import { Store } from '../src/store.js';
import { declaredCreationMs, isMethodNotFound, pairTiming, timingStats } from '../src/timing.js';
import { isTipped, tipGrains, unwrapTipped, unwrapTimestamped } from '../src/store.js';

const hx = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

/** The exact error a relay pool raises when every node rejects an unknown method. */
function methodNotFound(method) {
  return new Error(
    `all configured relays failed ${method}: relay-1: ${method}: Method not found (code -32601)`,
  );
}

function mempoolEntry(n, { tip = null, firstSeenMs = 1_000, state = 'ready' } = {}) {
  return {
    txId: hx(n),
    signer: 'alice.sovereign',
    nonce: n,
    tipGrains: tip,
    sizeBytes: 210,
    weight: 260,
    firstSeenMs,
    ageMs: 4_200,
    state,
  };
}

/** A minimal node mock: block bodies + digests, with optional timing RPCs. */
function nodeMock(overrides = {}) {
  return {
    async verifyRelays() {},
    async chainId() { return 'sov-mainnet'; },
    status() {
      return { configured: 2, verified: 2, healthy: 2, consistent: true, degraded: false, relays: [] };
    },
    async height() { return 2; },
    async blockDigest(height) { return { hash: hx(height + 1), txIds: [hx(500 + height)], coinbase: null }; },
    async blockByHeight(height) {
      return {
        header: {
          height,
          prev_hash: height === 0 ? hx(0) : hx(height),
          tx_root: hx(1_000 + height),
          receipts_root: hx(2_000 + height),
          state_root: hx(3_000 + height),
          timestamp_ms: 1_000 + height,
          proposer: 'miner.sovereign',
        },
        transactions: [{
          transaction: {
            signer: 'alice.sovereign',
            public_key: `0x${'11'.repeat(32)}`,
            nonce: height,
            action: { type: 'transfer', to: 'bob.sovereign', amount: '1' },
          },
          signature: `0x${'22'.repeat(64)}`,
        }],
      };
    },
    async supply() { return { total: '1', mined: '1' }; },
    async difficulty() { return { algo: 'Sha256d', sha256d: '1' }; },
    async miners() { return []; },
    async mempoolSize() { return 0; },
    ...overrides,
  };
}

test('mempool polling records a first-seen observation for every page', async () => {
  const store = new Store();
  const pages = [];
  const rpc = nodeMock({
    async mempoolTxs(offset, limit) {
      pages.push({ offset, limit });
      if (offset === 0) {
        return { txs: [mempoolEntry(1), mempoolEntry(2)], offset, limit, txCount: 3, queuedCount: 1, hasMore: true };
      }
      return { txs: [mempoolEntry(3, { state: 'queued' })], offset, limit, txCount: 3, queuedCount: 1, hasMore: false };
    },
  });
  const indexer = new Indexer(rpc, store, { mempoolPageLimit: 2 });

  const snapshot = await indexer.pollMempool(14_400);
  assert.deepEqual(pages, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }], 'paged with offset until hasMore is false');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.txs.length, 3);
  assert.equal(snapshot.queuedCount, 1);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(store.firstSeen(hx(1)), { firstSeenMs: 1_000, firstSeenHeight: 14_400 });
  assert.equal(store.firstSeen(hx(3)).firstSeenHeight, 14_400);

  // A later poll of a still-pending transaction must NOT move first-seen forward.
  await indexer.pollMempool(14_402);
  assert.deepEqual(store.firstSeen(hx(1)), { firstSeenMs: 1_000, firstSeenHeight: 14_400 });
});

test('mempool paging is bounded and reports that it was capped', async () => {
  const store = new Store();
  let calls = 0;
  const rpc = nodeMock({
    async mempoolTxs(offset, limit) {
      calls += 1;
      return { txs: [mempoolEntry(offset + 1)], offset, limit, txCount: 999_999, hasMore: true };
    },
  });
  const indexer = new Indexer(rpc, store, { mempoolMaxPages: 3, mempoolPageLimit: 1 });
  const snapshot = await indexer.pollMempool(10);
  assert.equal(calls, 3, 'an always-hasMore node cannot spin the poll loop');
  assert.equal(snapshot.truncated, true, 'the cap is reported, not hidden');
});

test('pairing math: waited_ms and waited_blocks come from real observations', () => {
  const paired = pairTiming({
    nodeTiming: null,
    observation: { firstSeenMs: 1_753_900_000_000, firstSeenHeight: 14_400 },
    includedHeight: 14_402,
    includedTimestampMs: 1_753_900_300_000,
  });
  assert.equal(paired.observed, true);
  assert.equal(paired.source, 'explorer');
  assert.equal(paired.waitedMs, 300_000);
  assert.equal(paired.waitedBlocks, 2);
});

test('node timing is preferred, and observed:false falls back to the explorer', () => {
  const observation = { firstSeenMs: 500, firstSeenHeight: 9 };
  const fromNode = pairTiming({
    nodeTiming: {
      txId: hx(1), firstSeenMs: 100, firstSeenHeight: 8, includedHeight: 10,
      includedTimestampMs: 1_100, waitedMs: 1_000, waitedBlocks: 2, observed: true,
    },
    observation,
    includedHeight: 10,
    includedTimestampMs: 1_100,
  });
  assert.equal(fromNode.source, 'node');
  assert.equal(fromNode.firstSeenMs, 100);
  assert.equal(fromNode.waitedMs, 1_000);
  assert.equal(fromNode.waitedBlocks, 2);

  // The node HONESTLY reports it never saw the transaction (it synced the block
  // from a peer): the explorer's own observation is used instead.
  const fallback = pairTiming({
    nodeTiming: {
      txId: hx(1), firstSeenMs: null, firstSeenHeight: null, includedHeight: 10,
      includedTimestampMs: 1_100, waitedMs: null, waitedBlocks: null, observed: false,
    },
    observation,
    includedHeight: 10,
    includedTimestampMs: 1_100,
  });
  assert.equal(fallback.source, 'explorer');
  assert.equal(fallback.firstSeenMs, 500);
  assert.equal(fallback.waitedMs, 600);
  assert.equal(fallback.waitedBlocks, 1);
});

test('a transaction nobody observed keeps null timing — never an estimate', () => {
  const unobserved = pairTiming({
    nodeTiming: { txId: hx(1), observed: false, firstSeenMs: null, waitedMs: null, waitedBlocks: null },
    observation: null,
    includedHeight: 10,
    includedTimestampMs: 1_100,
  });
  assert.deepEqual(unobserved, {
    firstSeenMs: null,
    firstSeenHeight: null,
    includedHeight: 10,
    includedTimestampMs: 1_100,
    waitedMs: null,
    waitedBlocks: null,
    source: null,
    observed: false,
    declared: false,
  });
});

test('the indexer attaches node timing to a block in ONE request', async () => {
  const store = new Store();
  let calls = 0;
  const rpc = nodeMock({
    async blockTxTiming(height) {
      calls += 1;
      assert.equal(height, 10);
      return {
        height,
        txs: [
          { txId: hx(1), firstSeenMs: 100, firstSeenHeight: 8, includedHeight: 10, includedTimestampMs: 1_100, waitedMs: 1_000, waitedBlocks: 2, observed: true },
          { txId: hx(2), firstSeenMs: null, firstSeenHeight: null, includedHeight: 10, includedTimestampMs: 1_100, waitedMs: null, waitedBlocks: null, observed: false },
        ],
      };
    },
  });
  const indexer = new Indexer(rpc, store);
  store.recordFirstSeen(hx(2), 900, 9);
  const record = {
    height: 10,
    timestampMs: 1_100,
    transactions: [{ id: hx(1), timestampMs: 1_100 }, { id: hx(2), timestampMs: 1_100 }, { id: hx(3), timestampMs: 1_100 }],
  };
  await indexer.attachTiming(record, 10);

  assert.equal(calls, 1, 'one sov_getTxTiming request for the whole block');
  assert.equal(record.transactions[0].timing.source, 'node');
  assert.equal(record.transactions[1].timing.source, 'explorer', 'observed:false falls back to our own record');
  assert.equal(record.transactions[1].timing.waitedMs, 200);
  assert.equal(record.transactions[2].timing.observed, false, 'unknown stays unobserved');
  assert.equal(record.transactions[2].timing.waitedMs, null);
});

test('deep-history blocks are not asked for timing the node cannot have', async () => {
  const store = new Store();
  let calls = 0;
  const rpc = nodeMock({ async blockTxTiming() { calls += 1; return { txs: [] }; } });
  const indexer = new Indexer(rpc, store, { timingLookbackBlocks: 16 });
  await indexer.attachTiming({ height: 10, timestampMs: 1, transactions: [{ id: hx(1) }] }, 5_000);
  assert.equal(calls, 0, 'a cold backfill does not spend one request per historical block');
});

// ---- graceful degradation --------------------------------------------------

test('a node without the timing RPCs keeps working, and is not asked forever', async () => {
  const store = new Store();
  let mempoolCalls = 0;
  let timingCalls = 0;
  const rpc = nodeMock({
    async mempoolTxs() { mempoolCalls += 1; throw methodNotFound('sov_getMempoolTxs'); },
    async blockTxTiming() { timingCalls += 1; throw methodNotFound('sov_getTxTiming'); },
  });
  const indexer = new Indexer(rpc, store, { backfill: 3, timingProbeIntervalMs: 60_000 });

  await indexer.syncOnce();
  const afterFirst = { mempoolCalls, timingCalls };
  await indexer.syncOnce();
  await indexer.syncOnce();

  assert.equal(mempoolCalls, 1, 'method-not-found is remembered, not re-requested every tick');
  // The first tick fetches a batch of blocks in parallel, so the timing probe can
  // be in flight more than once before the first rejection lands — but never again
  // after it does.
  assert.ok(afterFirst.timingCalls <= indexer.batchSize, 'at most one batch of probes');
  assert.equal(timingCalls, afterFirst.timingCalls, 'no further probes once the node has said no');
  assert.equal(store.timingSupport.mempool, false);
  assert.equal(store.timingSupport.timing, false);
  // Everything else still indexed normally.
  assert.equal(store.tipHeight, 2);
  assert.equal(store.ready, true);
  assert.equal(store.mempoolSnapshot.available, false);
  assert.match(store.mempoolSnapshot.reason, /sov_getMempoolTxs/);

  // …but the write-off expires, so an upgraded relay is picked up again.
  indexer.timingProbeIntervalMs = 0;
  indexer._unsupportedUntil.set('mempool', Date.now() - 1);
  await indexer.pollMempool(3);
  assert.equal(mempoolCalls, 2, 'the method is re-probed after the write-off window');
});

test('isMethodNotFound only matches the JSON-RPC unknown-method answer', () => {
  assert.equal(isMethodNotFound(methodNotFound('sov_getTxTiming')), true);
  assert.equal(isMethodNotFound(new Error('request timed out')), false);
  assert.equal(isMethodNotFound(new Error('HTTP 502')), false);
});

test('a transient mempool error is not written off as unsupported', async () => {
  const store = new Store();
  let calls = 0;
  const rpc = nodeMock({
    async mempoolTxs() {
      calls += 1;
      if (calls === 1) throw new Error('all configured relays failed sov_getMempoolTxs: relay-1: request timed out');
      return { txs: [mempoolEntry(1)], offset: 0, limit: 256, txCount: 1, hasMore: false };
    },
  });
  const indexer = new Indexer(rpc, store);
  assert.equal(await indexer.pollMempool(1), null);
  assert.equal(store.timingSupport.mempool, null, 'a timeout says nothing about node support');
  const snapshot = await indexer.pollMempool(2);
  assert.equal(snapshot.available, true);
  assert.equal(calls, 2);
});

// ---- persistence -----------------------------------------------------------

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sov-explorer-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function timedBlock(height, timing) {
  return {
    height,
    hash: hx(height + 1),
    prevHash: hx(height),
    txRoot: hx(1_000 + height),
    receiptsRoot: hx(2_000 + height),
    stateRoot: hx(3_000 + height),
    timestampMs: 1_000 + height,
    proposer: 'miner.sovereign',
    coinbase: null,
    txCount: 1,
    sizeBytes: 2_048,
    transactions: [{
      id: hx(10_000 + height),
      index: 0,
      signer: 'alice.sovereign',
      action: { type: 'transfer', to: 'bob.sovereign', amount: '42' },
      blockHeight: height,
      blockHash: hx(height + 1),
      timestampMs: 1_000 + height,
      executionStatus: 'success',
      timing,
    }],
  };
}

test('timing survives a restart and re-indexing never erases it', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'mainnet.sqlite');

  let archive = await openArchive(file);
  archive.ensureIdentity('sov-mainnet', hx(1));
  archive.recordFirstSeen(hx(77), 500, 4);
  archive.putBlock(timedBlock(5, {
    firstSeenMs: 400, firstSeenHeight: 3, includedHeight: 5, includedTimestampMs: 1_005,
    waitedMs: 605, waitedBlocks: 2, source: 'explorer', observed: true,
  }));
  archive.close();

  archive = await openArchive(file);
  t.after(() => archive.close());
  const tx = archive.transaction(hx(10_005));
  assert.equal(tx.timing.waitedMs, 605, 'timing is embedded in the durable record');
  assert.deepEqual(archive.transactionTiming(hx(10_005)), {
    firstSeenMs: 400, firstSeenHeight: 3, waitedMs: 605, waitedBlocks: 2, source: 'explorer',
  });
  assert.deepEqual(archive.firstSeen(hx(77)), { firstSeenMs: 500, firstSeenHeight: 4 });

  // Re-indexing the same block WITHOUT timing (finality refresh, on-demand fetch)
  // must not throw away the observation — it cannot be recovered afterwards.
  archive.putBlock(timedBlock(5, undefined));
  assert.equal(archive.transaction(hx(10_005)).timing.waitedMs, 605);
  assert.equal(archive.transactionTiming(hx(10_005)).source, 'explorer');

  // The first observation wins: a later poll cannot move first-seen forward.
  archive.recordFirstSeen(hx(77), 9_999, 40);
  assert.equal(archive.firstSeen(hx(77)).firstSeenMs, 500);
});

test('an archive written before timing shipped still opens, with null timing', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'legacy.sqlite');
  const { DatabaseSync } = await import('node:sqlite');

  // The pre-timing schema, byte for byte the columns that existed then.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE blocks (
      height INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, prev_hash TEXT,
      timestamp_ms INTEGER, proposer TEXT, tx_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL, record_json TEXT NOT NULL
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      block_height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      tx_index INTEGER NOT NULL, signer TEXT, counterparty TEXT, action_type TEXT,
      execution_status TEXT, timestamp_ms INTEGER, record_json TEXT NOT NULL
    );
    CREATE TABLE account_transactions (
      account TEXT NOT NULL, block_height INTEGER NOT NULL, tx_index INTEGER NOT NULL,
      tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      PRIMARY KEY(account, tx_id)
    );
  `);
  const old = timedBlock(1, undefined);
  legacy.prepare('INSERT INTO blocks VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
    1, hx(2), hx(1), 1_001, 'miner.sovereign', 1, 2_048, JSON.stringify(old),
  );
  legacy.prepare('INSERT INTO transactions VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    hx(10_001), 1, 0, 'alice.sovereign', 'bob.sovereign', 'transfer', 'success', 1_001,
    JSON.stringify(old.transactions[0]),
  );
  legacy.close();

  const archive = await openArchive(file);
  t.after(() => archive.close());
  assert.equal(archive.block(1).height, 1, 'the existing archive still loads');
  assert.equal(archive.transaction(hx(10_001)).signer, 'alice.sovereign');
  assert.equal(archive.transactionTiming(hx(10_001)), null, 'pre-existing rows have no timing');
  assert.equal(archive.firstSeen(hx(10_001)), null);
  const sample = archive.timingSample({ limit: 10 });
  assert.deepEqual(sample.map((row) => row.observed), [false]);

  // New blocks written into the migrated archive carry timing normally.
  archive.putBlock(timedBlock(2, {
    firstSeenMs: 1, firstSeenHeight: 1, includedHeight: 2, includedTimestampMs: 1_002,
    waitedMs: 1_001, waitedBlocks: 1, source: 'node', observed: true,
  }));
  assert.equal(archive.transactionTiming(hx(10_002)).source, 'node');
});

// ---- serving layers --------------------------------------------------------

function servedStore() {
  const store = new Store();
  store.nodeHeight = 12;
  store.addBlock({
    height: 12,
    hash: hx(13),
    prevHash: hx(12),
    timestampMs: 5_000,
    proposer: 'miner.sovereign',
    txCount: 2,
    sizeBytes: 1_000,
    transactions: [
      {
        id: hx(1), index: 0, signer: 'alice', action: { type: 'transfer', to: 'bob', amount: '1' },
        blockHeight: 12, blockHash: hx(13), timestampMs: 5_000, executionStatus: 'success',
        timing: {
          firstSeenMs: 2_000, firstSeenHeight: 10, includedHeight: 12, includedTimestampMs: 5_000,
          waitedMs: 3_000, waitedBlocks: 2, source: 'node', observed: true,
        },
      },
      {
        id: hx(2), index: 1, signer: 'carol', action: { type: 'transfer', to: 'dave', amount: '2' },
        blockHeight: 12, blockHash: hx(13), timestampMs: 5_000, executionStatus: 'success',
        timing: {
          firstSeenMs: null, firstSeenHeight: null, includedHeight: 12, includedTimestampMs: 5_000,
          waitedMs: null, waitedBlocks: null, source: null, observed: false,
        },
      },
    ],
  });
  return store;
}

test('REST serves timing on transactions and keeps unobserved ones null', async () => {
  const store = servedStore();
  const ctx = { store, rpc: { receipt: async () => null } };

  const list = JSON.parse((await handleRest('GET', '/api/txs', new URLSearchParams('limit=2'), ctx)).body);
  const [second, first] = list; // newest-first within the block
  assert.equal(first.timing.waitedMs, 3_000);
  assert.equal(first.timing.source, 'node');
  assert.equal(second.timing.observed, false);
  assert.equal(second.timing.waitedMs, null);
  assert.equal(second.timing.firstSeenMs, null);

  const detail = JSON.parse((await handleRest('GET', `/api/tx/${hx(2)}`, new URLSearchParams(), ctx)).body);
  assert.equal(detail.timing.observed, false);
  assert.equal(detail.timing.waitedMs, null);
  assert.equal(detail.timing.waitedBlocks, null);
});

test('a transaction indexed before timing existed serves an explicit unobserved record', async () => {
  const store = new Store();
  store.nodeHeight = 3;
  store.addBlock({
    height: 3, hash: hx(4), prevHash: hx(3), timestampMs: 300, proposer: 'miner', txCount: 1, sizeBytes: 10,
    transactions: [{
      id: hx(9), index: 0, signer: 'alice', action: { type: 'transfer', to: 'bob', amount: '1' },
      blockHeight: 3, blockHash: hx(4), timestampMs: 300,
    }],
  });
  const response = await handleRest('GET', `/api/tx/${hx(9)}`, new URLSearchParams(), {
    store, rpc: { receipt: async () => null },
  });
  const tx = JSON.parse(response.body);
  assert.deepEqual(tx.timing, {
    firstSeenMs: null, firstSeenHeight: null, includedHeight: 3, includedTimestampMs: 300,
    waitedMs: null, waitedBlocks: null, source: null, observed: false, declared: false,
  });
});

test('REST reports a pending transaction with its real first-seen, or none at all', async () => {
  const store = new Store();
  store.setMempoolSnapshot({
    available: true, reason: null, truncated: false, txCount: 1, queuedCount: 0, updatedAt: 10,
    txs: [{ txId: hx(5), signer: 'alice', firstSeenMs: 1_234, state: 'ready' }],
  });
  store.recordFirstSeen(hx(5), 1_234, 7);
  const ctx = { store, rpc: { receipt: async () => null } };

  const pending = JSON.parse((await handleRest('GET', `/api/tx/${hx(5)}`, new URLSearchParams(), ctx)).body);
  assert.equal(pending.pending, true);
  assert.equal(pending.inMempool, true);
  assert.equal(pending.firstSeenMs, 1_234);

  const unknown = JSON.parse((await handleRest('GET', `/api/tx/${hx(6)}`, new URLSearchParams(), ctx)).body);
  assert.equal(unknown.pending, true);
  assert.equal(unknown.inMempool, false);
  assert.equal(unknown.firstSeenMs, null, 'an unobserved pending transaction gets no invented start');
});

test('the mempool endpoint says plainly when the node cannot list pending transactions', async () => {
  const store = new Store();
  const ctx = { store, rpc: {} };
  let body = JSON.parse((await handleRest('GET', '/api/mempool', new URLSearchParams(), ctx)).body);
  assert.equal(body.available, false);
  assert.deepEqual(body.txs, []);

  store.setMempoolSnapshot({
    available: false, reason: 'this node does not serve sov_getMempoolTxs', txs: [],
    txCount: null, queuedCount: null, truncated: false, updatedAt: 1,
  });
  body = JSON.parse((await handleRest('GET', '/api/mempool', new URLSearchParams(), ctx)).body);
  assert.equal(body.available, false);
  assert.match(body.reason, /sov_getMempoolTxs/);
});

test('GraphQL carries the same timing, nulls included', async () => {
  const store = servedStore();
  const result = await executeGraphql(
    `{ observed: transaction(id: "${hx(1)}") { id timing { waitedMs waitedBlocks source observed } }
       unobserved: transaction(id: "${hx(2)}") { id timing { waitedMs firstSeenMs source observed } } }`,
    { store, rpc: {} },
    schemaRoots,
  );
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.observed.timing, {
    waitedMs: 3_000, waitedBlocks: 2, source: 'node', observed: true,
  });
  assert.deepEqual(result.data.unobserved.timing, {
    waitedMs: null, firstSeenMs: null, source: null, observed: false,
  });
});

// ---- aggregate statistics --------------------------------------------------

test('median and p90 wait are split by tipped vs untipped, with exclusions stated', () => {
  const rows = [
    ...[1_000, 2_000, 3_000, 4_000, 5_000].map((waitedMs, i) => ({
      waitedMs, waitedBlocks: i + 1, tipped: true, observed: true,
    })),
    ...[10_000, 20_000, 30_000, 40_000, 50_000].map((waitedMs, i) => ({
      waitedMs, waitedBlocks: 10 + i, tipped: false, observed: true,
    })),
    { waitedMs: null, waitedBlocks: null, tipped: false, observed: false },
    { waitedMs: null, waitedBlocks: null, tipped: true, observed: false },
    { waitedMs: -5_000, waitedBlocks: 1, tipped: false, observed: true },
  ];
  const stats = timingStats(rows);
  assert.equal(stats.considered, 13);
  assert.equal(stats.sampleSize, 10);
  assert.equal(stats.excludedUnobserved, 2, 'unobserved transactions are counted, not hidden');
  assert.equal(stats.excludedNegative, 1, 'a block timestamp before first-seen is dropped, not clamped');
  assert.equal(stats.tipped.count, 5);
  assert.equal(stats.tipped.medianWaitMs, 3_000);
  assert.equal(stats.tipped.p90WaitMs, 4_600);
  assert.equal(stats.untipped.count, 5);
  assert.equal(stats.untipped.medianWaitMs, 30_000);
  assert.equal(stats.untipped.p90WaitMs, 46_000);
  assert.equal(stats.overall.count, 10);
  assert.equal(stats.tipped.medianWaitBlocks, 3);
});

test('a group with no observed sample reports null, never a zero wait', () => {
  const stats = timingStats([{ waitedMs: 1_000, waitedBlocks: 1, tipped: false, observed: true }]);
  assert.equal(stats.untipped.medianWaitMs, 1_000);
  assert.equal(stats.tipped.count, 0);
  assert.equal(stats.tipped.medianWaitMs, null);
  assert.equal(stats.tipped.p90WaitMs, null);
  assert.deepEqual(timingStats([]).overall, {
    count: 0, medianWaitMs: null, p90WaitMs: null, medianWaitBlocks: null, p90WaitBlocks: null,
  });
});

test('the timing statistics endpoint reports its sample, sources, and exclusions', async () => {
  const store = servedStore();
  store.timingSupport = { mempool: true, timing: true };
  const response = await handleRest('GET', '/api/tx-timing', new URLSearchParams('limit=100'), { store, rpc: {} });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.considered, 2);
  assert.equal(body.sampleSize, 1);
  assert.equal(body.excludedUnobserved, 1);
  assert.equal(body.overall.medianWaitMs, 3_000);
  assert.deepEqual(body.sources, { node: 1, explorer: 0 });
  assert.equal(body.support.mempoolRpc, true);
  assert.equal(body.window.toHeight, 12);
});

test('timing statistics come from the durable archive when there is one', async (t) => {
  const dir = await tempDir(t);
  const archive = await openArchive(join(dir, 'stats.sqlite'));
  t.after(() => archive.close());
  archive.ensureIdentity('sov-mainnet', hx(1));
  for (let height = 1; height <= 4; height++) {
    const block = timedBlock(height, height % 2 === 0 ? {
      firstSeenMs: 1, firstSeenHeight: height - 1, includedHeight: height,
      includedTimestampMs: 1_000 + height, waitedMs: height * 1_000, waitedBlocks: 1,
      source: 'explorer', observed: true,
    } : undefined);
    if (height === 2) block.transactions[0].action = { type: 'tipped', tip: '1000', inner: { type: 'transfer' } };
    archive.putBlock(block);
  }
  const store = new Store({ archive });
  const sample = store.timingSample({ limit: 100 });
  assert.equal(sample.length, 4);
  assert.equal(sample.filter((row) => row.observed).length, 2);
  assert.equal(sample.filter((row) => row.tipped).length, 1);
  const stats = timingStats(sample);
  assert.equal(stats.sampleSize, 2);
  assert.equal(stats.excludedUnobserved, 2);
  assert.equal(stats.tipped.medianWaitMs, 2_000);
  assert.equal(stats.untipped.medianWaitMs, 4_000);
});

// ── On-chain creation time (`Action::Timestamped`, signal bit 3) ────────────
//
// A transaction may declare its OWN creation time, which consensus refuses to
// include unless it falls inside a bounded window around the including block's
// timestamp. That is strictly stronger than any mempool observation — every node
// enforced the same bound, and it lives in the block, so it survives a restart and
// a cold sync. When present it wins; when absent (every transaction before bit 3
// activates) nothing changes at all.

const stamped = (createdAtMs, inner) => ({ type: 'timestamped', created_at_ms: createdAtMs, inner });

test('declaredCreationMs reads a declared creation time and never invents one', () => {
  assert.equal(
    declaredCreationMs(stamped(1_000, { type: 'transfer', to: 'bob', amount: '1' })),
    1_000,
  );
  // The overwhelmingly common case today: no envelope, so no declared time.
  assert.equal(declaredCreationMs({ type: 'transfer', to: 'bob', amount: '1' }), null);
  assert.equal(declaredCreationMs({ type: 'tipped', tip: '5', inner: { type: 'transfer' } }), null);
  // Malformed or absent input is null, never a throw and never a guess.
  assert.equal(declaredCreationMs(null), null);
  assert.equal(declaredCreationMs(undefined), null);
  assert.equal(declaredCreationMs({ type: 'timestamped' }), null);
  assert.equal(declaredCreationMs({ type: 'timestamped', created_at_ms: 'soon' }), null);
});

test('a declared creation time outranks both observations and is labeled `chain`', () => {
  const timing = pairTiming({
    declaredCreatedAtMs: 1_000,
    // Both observations exist AND disagree with the declaration — the chain still
    // wins, because it is the one value every node agreed on.
    nodeTiming: { observed: true, firstSeenMs: 4_000, firstSeenHeight: 8, waitedMs: 1, waitedBlocks: 1 },
    observation: { firstSeenMs: 5_000, firstSeenHeight: 9 },
    includedHeight: 10,
    includedTimestampMs: 9_000,
  });
  assert.equal(timing.source, 'chain');
  assert.equal(timing.declared, true);
  assert.equal(timing.firstSeenMs, 1_000);
  assert.equal(timing.waitedMs, 8_000, 'block timestamp minus the DECLARED time');
  // The declaration is a wall-clock instant with no chain position of its own, so
  // the block count comes from an observation when one exists — and only then.
  assert.equal(timing.waitedBlocks, 1, '10 - 9, the explorer observation height');

  const noObservation = pairTiming({
    declaredCreatedAtMs: 1_000,
    includedHeight: 10,
    includedTimestampMs: 9_000,
  });
  assert.equal(noObservation.waitedBlocks, null, 'no height to measure against, so null');
  assert.equal(noObservation.waitedMs, 8_000, 'the wait in TIME is still exact');
});

test('with no declared time every existing precedence and null is unchanged', () => {
  // Graceful degradation, restated as a property: passing declaredCreatedAtMs: null
  // (what every pre-activation transaction yields) must reproduce the old answers.
  const nodeWins = pairTiming({
    declaredCreatedAtMs: null,
    nodeTiming: { observed: true, firstSeenMs: 4_000, firstSeenHeight: 8 },
    observation: { firstSeenMs: 5_000, firstSeenHeight: 9 },
    includedHeight: 10,
    includedTimestampMs: 9_000,
  });
  assert.equal(nodeWins.source, 'node');
  assert.equal(nodeWins.declared, false);
  assert.equal(nodeWins.firstSeenMs, 4_000);

  const explorerFallback = pairTiming({
    nodeTiming: { observed: false, firstSeenMs: null },
    observation: { firstSeenMs: 5_000, firstSeenHeight: 9 },
    includedHeight: 10,
    includedTimestampMs: 9_000,
  });
  assert.equal(explorerFallback.source, 'explorer');
  assert.equal(explorerFallback.firstSeenMs, 5_000);

  const nobody = pairTiming({ includedHeight: 10, includedTimestampMs: 9_000 });
  assert.equal(nobody.observed, false);
  assert.equal(nobody.declared, false);
  assert.equal(nobody.waitedMs, null);
});

test('the indexer prefers a declared creation time over its own observation', async () => {
  const store = new Store();
  const indexer = new Indexer({}, store);
  // The explorer watched this transaction arrive at 5_000...
  store.recordFirstSeen(hx(1), 5_000, 9);
  const record = {
    height: 10,
    timestampMs: 9_000,
    transactions: [
      { id: hx(1), index: 0, signer: 'alice', timestampMs: 9_000,
        action: stamped(1_000, { type: 'transfer', to: 'bob', amount: '1' }) },
      { id: hx(2), index: 1, signer: 'carol', timestampMs: 9_000,
        action: { type: 'transfer', to: 'dave', amount: '2' } },
    ],
  };
  await indexer.attachTiming(record, 10);
  // ...but the transaction said when it was made, and consensus bounded it.
  assert.equal(record.transactions[0].timing.source, 'chain');
  assert.equal(record.transactions[0].timing.firstSeenMs, 1_000);
  assert.equal(record.transactions[0].timing.waitedMs, 8_000);
  // A transaction that declared nothing is untouched by any of this.
  assert.equal(record.transactions[1].timing.source, null);
  assert.equal(record.transactions[1].timing.observed, false);
});

test('a fee-auction tip stays visible through a creation-time envelope', () => {
  // `timestamped { tipped { transfer } }` is a legal shape: a transaction may be
  // both timestamped and tipped. If the envelope hid the tip, the whole
  // tipped-vs-untipped wait split — the point of the fee-auction view — would
  // silently misclassify every timestamped bid as untipped.
  const inner = { type: 'transfer', to: 'bob', amount: '1' };
  const bare = { type: 'tipped', tip: '5000', inner };
  const wrapped = stamped(1_000, bare);

  assert.deepEqual(unwrapTimestamped(wrapped), bare);
  assert.deepEqual(unwrapTipped(wrapped), inner, 'value accounting reaches the real action');
  assert.equal(tipGrains(wrapped), 5000n, 'the bid is still counted');
  assert.equal(isTipped(wrapped), true);

  // And nothing about an ordinary transaction changes.
  assert.equal(tipGrains(bare), 5000n);
  assert.equal(isTipped(bare), true);
  assert.equal(isTipped(inner), false);
  assert.equal(tipGrains(inner), 0n);
  assert.deepEqual(unwrapTimestamped(inner), inner, 'no envelope, no change');
  assert.equal(unwrapTimestamped(null), null);
});
