import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openArchive } from '../src/archive.js';
import { Indexer } from '../src/indexer.js';
import { Store } from '../src/store.js';

const hx = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

function transaction(height, index = 0) {
  return {
    id: hx(10_000 + height * 10 + index),
    index,
    signer: 'alice.sovereign',
    publicKey: `0x${'11'.repeat(32)}`,
    nonce: height,
    action: { type: 'transfer', to: 'bob.sovereign', amount: '42' },
    signature: `0x${'22'.repeat(64)}`,
    sizeBytes: 256,
    blockHeight: height,
    blockHash: hx(height + 1),
    timestampMs: 1_000 + height,
  };
}

function block(height, withTx = true) {
  const transactions = withTx ? [transaction(height)] : [];
  return {
    height,
    hash: hx(height + 1),
    prevHash: height === 0 ? hx(0) : hx(height),
    txRoot: hx(1_000 + height),
    receiptsRoot: hx(2_000 + height),
    stateRoot: hx(3_000 + height),
    timestampMs: 1_000 + height,
    proposer: 'miner.sovereign',
    coinbase: null,
    txCount: transactions.length,
    sizeBytes: 2_048,
    transactions,
    final: height === 0,
  };
}

async function tempArchive(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sov-explorer-archive-'));
  const file = join(dir, 'mainnet.sqlite');
  const archive = await openArchive(file);
  t.after(async () => {
    archive.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { archive, file };
}

test('SQLite archive persists blocks, transactions, account history, and search indexes', async (t) => {
  const { archive } = await tempArchive(t);
  assert.deepEqual(archive.ensureIdentity('sov-mainnet', hx(1)), { cleared: false });
  archive.putBlocks([block(0), block(1), block(2, false)]);

  assert.equal(archive.block(1).height, 1);
  assert.equal(archive.block(hx(2)).height, 1, 'block lookup by normalized hash');
  assert.equal(archive.transaction(transaction(1).id).blockHeight, 1);
  assert.deepEqual(
    archive.accountTransactions('alice.sovereign', 10).map((tx) => tx.blockHeight),
    [1, 0],
  );
  assert.equal(archive.accountTransactions('bob.sovereign', 10).length, 2);
  assert.deepEqual(archive.recentBlocks(2).map((row) => row.height), [2, 1]);
  assert.deepEqual(archive.blocksBefore(1, 2).map((row) => row.height), [1, 0]);
  assert.deepEqual(archive.lookupHash(hx(2)), { kind: 'block', ref: 1, known: true });
  assert.deepEqual(archive.lookupHash(transaction(1).id), {
    kind: 'tx', ref: transaction(1).id, known: true,
  });

  const status = archive.status(2);
  assert.equal(status.blocks, 3);
  assert.equal(status.minHeight, 0);
  assert.equal(status.maxHeight, 2);
  assert.equal(status.contiguousFromHeight, 0);
  assert.equal(status.contiguous, true);
  assert.equal(status.complete, true);
  assert.ok(status.databaseBytes > 0);
});

test('an on-demand historical island cannot redirect contiguous genesis backfill', async (t) => {
  const { archive } = await tempArchive(t);
  archive.putBlocks([block(3), block(4), block(5)]);
  archive.putBlock(block(0));
  const status = archive.status(5);
  assert.equal(status.minHeight, 0, 'the isolated historical row is retained');
  assert.equal(status.contiguousFromHeight, 3, 'coverage truth follows the head-connected tail');
  assert.equal(status.contiguous, false);
  assert.equal(status.complete, false);
});

test('SQLite archive survives restart and clears records on chain identity mismatch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sov-explorer-restart-'));
  const file = join(dir, 'mainnet.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));

  let archive = await openArchive(file);
  archive.ensureIdentity('sov-mainnet', hx(1));
  archive.putBlock(block(0));
  archive.close();

  archive = await openArchive(file);
  assert.equal(archive.block(0).hash, hx(1));
  assert.deepEqual(archive.ensureIdentity('sov-mainnet', hx(999)), { cleared: true });
  assert.equal(archive.status(0).blocks, 0);
  assert.equal(archive.meta('chain_id'), 'sov-mainnet');
  assert.equal(archive.meta('genesis_hash'), hx(999));
  archive.close();
});

test('indexer restores a hot window and backfills archive to genesis without growing memory', async (t) => {
  const { archive } = await tempArchive(t);
  let head = 5;
  const rpc = {
    async verifyRelays() {},
    async chainId() { return 'sov-mainnet'; },
    status() {
      return { configured: 2, verified: 2, healthy: 2, consistent: true, degraded: false, relays: [] };
    },
    async height() { return head; },
    async blockDigest(height) {
      return { hash: hx(height + 1), txIds: [], coinbase: null };
    },
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
        transactions: [],
      };
    },
    async supply() { return { total: '1', mined: '1' }; },
    async difficulty() { return { algo: 'Sha256d', sha256d: '1' }; },
    async miners() { return []; },
    async mempoolSize() { return 0; },
  };

  const firstStore = new Store({ maxBlocks: 3, archive });
  const first = new Indexer(rpc, firstStore, {
    backfill: 3,
    batchSize: 2,
    archiveBatchSize: 2,
  });
  await first.syncOnce();
  assert.deepEqual([firstStore.minHeight, firstStore.tipHeight], [3, 5]);
  assert.deepEqual([archive.status(head).minHeight, archive.status(head).maxHeight], [1, 5]);
  assert.equal(firstStore.blocksByHeight.size, 3, 'archive backfill stays outside the hot store');

  await first.syncOnce();
  assert.equal(archive.status(head).complete, true);
  assert.equal(firstStore.blocksByHeight.size, 3);

  const restoredStore = new Store({ maxBlocks: 2, archive });
  const restored = new Indexer(rpc, restoredStore, { backfill: 2, archiveBatchSize: 2 });
  await restored.init();
  assert.deepEqual([restoredStore.minHeight, restoredStore.tipHeight], [4, 5]);
  assert.equal(restoredStore.blocksByHeight.size, 2);
});
