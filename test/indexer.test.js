// Unit test for block normalization: the RPC's snake_case block + digest are
// mapped to the store's record shape. The input mirrors a real block-by-height
// + block-digest response captured from a live node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationCount, finalAtDepth, Indexer, normalizeBlock } from '../src/indexer.js';
import { Store } from '../src/store.js';

test('normalizeBlock maps real RPC shapes', () => {
  const block = {
    header: {
      height: 1,
      prev_hash: '0x' + 'd5'.repeat(32),
      tx_root: '0x' + 'ef'.repeat(32),
      receipts_root: '0x' + '30'.repeat(32),
      state_root: '0x' + '18'.repeat(32),
      timestamp_ms: 1_780_000_000_000,
      proposer: 'val01.node.sovereign',
    },
    transactions: [
      {
        transaction: {
          signer: 'usa.reserve.sovereign',
          public_key: '0x' + '81'.repeat(32),
          nonce: 0,
          action: { type: 'transfer', to: 'ecb.reserve.sovereign', amount: '10000000000' },
        },
        signature: '0x' + '7f'.repeat(64),
      },
    ],
  };
  const digest = { hash: '0x' + 'ac'.repeat(32), txIds: ['0x' + '21'.repeat(32)] };

  const rec = normalizeBlock(block, digest, true);
  assert.equal(rec.height, 1);
  assert.equal(rec.hash, '0x' + 'ac'.repeat(32));
  assert.equal(rec.prevHash, '0x' + 'd5'.repeat(32));
  assert.equal(rec.stateRoot, '0x' + '18'.repeat(32));
  assert.equal(rec.proposer, 'val01.node.sovereign');
  assert.equal(rec.final, true);
  assert.equal(rec.txCount, 1);

  const t = rec.transactions[0];
  assert.equal(t.id, '0x' + '21'.repeat(32), 'canonical tx id from digest');
  assert.equal(t.index, 0);
  assert.equal(t.signer, 'usa.reserve.sovereign');
  assert.equal(t.action.type, 'transfer');
  assert.equal(t.action.to, 'ecb.reserve.sovereign');
  assert.equal(t.blockHeight, 1);
  assert.equal(t.blockHash, rec.hash);
});

test('finality follows the chain confirmation convention', () => {
  assert.equal(confirmationCount(10, 10), 1, 'the active head has one confirmation');
  assert.equal(confirmationCount(10, 5), 6);
  assert.equal(finalAtDepth(10, 5), true, 'six confirmations is final');
  assert.equal(finalAtDepth(10, 6), false, 'five confirmations is still pending');
  assert.equal(finalAtDepth(0, 0), true, 'genesis is final by definition');
});

test('cold backfill is silent, then genuinely new blocks emit live events', async () => {
  let head = 5;
  const hash = (height) => `0x${BigInt(height + 1).toString(16).padStart(64, '0')}`;
  const rpc = {
    async verifyRelays() {},
    async chainId() { return 'sov-mainnet'; },
    status() {
      return { configured: 2, verified: 2, healthy: 2, consistent: true, degraded: false, relays: [] };
    },
    async height() { return head; },
    async blockDigest(height) {
      return { hash: hash(height), txIds: [], coinbase: null };
    },
    async blockByHeight(height) {
      return {
        header: {
          height,
          prev_hash: height === 0 ? `0x${'0'.repeat(64)}` : hash(height - 1),
          tx_root: hash(100 + height),
          receipts_root: hash(200 + height),
          state_root: hash(300 + height),
          timestamp_ms: Date.now(),
          proposer: 'miner.sov',
        },
        transactions: [],
      };
    },
    async supply() { return { total: '1', mined: '1' }; },
    async difficulty() { return { algo: 'Sha256d', sha256d: '1' }; },
    async miners() { return []; },
    async mempoolSize() { return 0; },
  };
  const store = new Store();
  const emitted = [];
  const indexer = new Indexer(rpc, store, { backfill: 3, batchSize: 2, onBlock: (b) => emitted.push(b.height) });

  await indexer.syncOnce();
  assert.deepEqual(emitted, [], 'historical bootstrap blocks are not called live');
  assert.equal(store.minHeight, 3);
  assert.equal(store.tipHeight, 5);
  assert.equal(store.ready, true);

  head = 6;
  await indexer.syncOnce();
  assert.deepEqual(emitted, [6], 'a new tip after readiness is announced');
});

test('a relay range must form one canonical parent-linked chain', async () => {
  const hash = (height) => `0x${BigInt(height + 1).toString(16).padStart(64, '0')}`;
  const store = new Store();
  const indexer = new Indexer({}, store, { batchSize: 4 });
  indexer.fetchBlock = async (height) => ({
    height,
    hash: hash(height),
    prevHash: height === 2 ? hash(99) : hash(height - 1),
    txRoot: hash(100 + height),
    receiptsRoot: hash(200 + height),
    stateRoot: hash(300 + height),
    timestampMs: Date.now(),
    proposer: 'miner.sov',
    coinbase: null,
    txCount: 0,
    sizeBytes: 100,
    transactions: [],
    final: false,
  });

  await assert.rejects(indexer.indexRange(1, 3), /does not extend/);
  assert.equal(store.blocksByHeight.size, 0, 'the malformed batch is rejected atomically');
});
