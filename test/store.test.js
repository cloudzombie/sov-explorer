// Unit tests for the index/store logic. These exercise the pure data structures
// with records shaped exactly like the node's RPC output — no network needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, transactionCrypto, txCounterparty } from '../src/store.js';

const hx = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

function tx(id, signer, action) {
  return {
    id,
    index: 0,
    signer,
    publicKey: '0x' + '11'.repeat(32),
    nonce: 0,
    action,
    signature: '0x' + '22'.repeat(64),
    sizeBytes: 256,
    blockHeight: 0,
    blockHash: hx(0),
    timestampMs: 1000,
  };
}

function block(height, txs = []) {
  return {
    height,
    hash: hx(height),
    prevHash: hx(height === 0 ? 0 : height - 1),
    txRoot: hx(900 + height),
    receiptsRoot: hx(800 + height),
    stateRoot: hx(700 + height),
    timestampMs: 1_000 + height,
    proposer: 'val01.node.sovereign',
    txCount: txs.length,
    sizeBytes: 2048,
    transactions: txs,
    final: false,
  };
}

test('counterparty extraction', () => {
  assert.equal(txCounterparty({ type: 'transfer', to: 'b.sovereign' }), 'b.sovereign');
  assert.equal(txCounterparty({ type: 'call', contract: 'c.sovereign' }), 'c.sovereign');
  assert.equal(txCounterparty({ type: 'mine' }), null);
});

test('hybrid65 key and signature evidence is measured from retained transactions', () => {
  const hybrid = tx(hx(9001), 'pq.sovereign', { type: 'mine' });
  hybrid.publicKey = `hybrid65:0x${'11'.repeat(1984)}`;
  hybrid.signature = `hybrid65:0x${'22'.repeat(3373)}`;
  assert.deepEqual(transactionCrypto(hybrid), {
    scheme: 'hybrid65',
    keyBytes: 1984,
    signatureBytes: 3373,
  });

  const s = new Store({ maxBlocks: 1 });
  s.addBlock(block(0, [hybrid]));
  assert.equal(s.latestTransaction().id, hybrid.id);
  assert.equal(s.cryptographyStats().hybridCoverage, 1);
  assert.equal(s.cryptographyStats().signatureBytesRetained, 3373);
  s.addBlock(block(1));
  assert.equal(s.latestTransaction(), null);
  assert.equal(s.cryptographyStats().retainedTransactions, 0);
});

test('indexes blocks, transactions, and both account sides', () => {
  const s = new Store();
  const t = tx(hx(1001), 'usa.reserve.sovereign', { type: 'transfer', to: 'ecb.reserve.sovereign', amount: '10000000000' });
  s.addBlock(block(1, [t]));

  assert.equal(s.block(1).height, 1);
  assert.equal(s.block(hx(1)).height, 1, 'lookup by hash');
  assert.equal(s.tx(hx(1001)).signer, 'usa.reserve.sovereign');
  assert.equal(s.accountTxs('usa.reserve.sovereign').length, 1, 'signer indexed');
  assert.equal(s.accountTxs('ecb.reserve.sovereign').length, 1, 'recipient indexed');
  assert.equal(s.observedMiners()[0].account, 'val01.node.sovereign');
  assert.equal(s.observedMiners()[0].blocksMined, 1);
  assert.equal(s.totalTxIndexed, 1);
});

test('search classifies height, hash, tx id, and account', () => {
  const s = new Store();
  s.addBlock(block(1, [tx(hx(1001), 'a.sovereign', { type: 'mine' })]));

  assert.deepEqual(s.search('1'), { kind: 'block', ref: 1, known: true });
  assert.equal(s.search(hx(1)).kind, 'block'); // by block hash
  assert.equal(s.search(hx(1001)).kind, 'tx'); // by tx id
  assert.equal(s.search('a.sovereign').kind, 'account');
  assert.equal(s.search(hx(424242)).kind, 'hash'); // unknown 0x-hash
  assert.equal(s.search('9'.repeat(80)).kind, 'invalid');
  assert.equal(s.search('').kind, 'empty');
});

test('recent blocks are newest-first', () => {
  const s = new Store();
  for (let h = 0; h <= 5; h++) s.addBlock(block(h));
  const recent = s.recentBlocks(3).map((b) => b.height);
  assert.deepEqual(recent, [5, 4, 3]);
});

test('ring eviction drops oldest blocks and their txs', () => {
  const s = new Store({ maxBlocks: 2 });
  s.addBlock(block(0, [tx(hx(2000), 'a.sovereign', { type: 'mine' })]));
  s.addBlock(block(1));
  s.addBlock(block(2));
  assert.equal(s.block(0), null, 'oldest block evicted');
  assert.equal(s.tx(hx(2000)), null, 'evicted block tx removed');
  assert.ok(s.block(2), 'newest retained');
  assert.equal(s.totalBlockBytesIndexed, 4096, 'evicted block bytes removed');
  // The evicted tx id is removed from the account index, not retained forever.
  assert.equal(s.accountTxs('a.sovereign').length, 0);
  assert.equal(s.txIdsByAccount.has('a.sovereign'), false);
});

test('byte ceiling evicts records even below the block-count ceiling', () => {
  const s = new Store({ maxBlocks: 100, maxBytes: 4096 });
  s.addBlock(block(0));
  s.addBlock(block(1));
  s.addBlock(block(2));
  assert.equal(s.blocksByHeight.size, 2);
  assert.equal(s.block(0), null);
  assert.ok(s.totalBlockBytesIndexed <= 4096);
});

test('an oversized newest block remains a coherent one-block index', () => {
  const s = new Store({ maxBlocks: 100, maxBytes: 4096 });
  const large = block(7);
  large.sizeBytes = 8192;
  s.addBlock(large);
  assert.equal(s.blocksByHeight.size, 1);
  assert.equal(s.tipHeight, 7);
  assert.equal(s.minHeight, 7);
  assert.ok(s.block(7));
});

test('status distinguishes node height from indexed height while syncing', () => {
  const s = new Store();
  s.addBlock(block(5));
  s.setSyncStatus({ nodeHeight: 10, syncing: true, ready: false, phase: 'bootstrap' });
  const status = s.stats().sync;
  assert.equal(status.nodeHeight, 10);
  assert.equal(status.indexedHeight, 5);
  assert.equal(status.behindBlocks, 5);
  assert.equal(status.ready, false);
});

test('status aggregation is cached until chain state changes', () => {
  const s = new Store();
  s.addBlock(block(1));
  const first = s.stats();
  assert.equal(s.stats(), first);
  s.setSyncStatus({ nodeHeight: 2 });
  const updated = s.stats();
  assert.notEqual(updated, first);
  assert.equal(updated.sync.nodeHeight, 2);
});

test('stats expose blockchair-style explorer parameters', () => {
  const s = new Store();
  const t = tx(hx(3000), 'usa.reserve.sovereign', {
    type: 'transfer',
    to: 'ecb.reserve.sovereign',
    amount: '10000000000',
  });
  const b = block(10, [t]);
  b.timestampMs = Date.now();
  b.sizeBytes = 4096;
  b.transactions[0].sizeBytes = 512;
  s.addBlock(b);
  s.recordSupply({ total: '100000000000000', mined: '21000000000000' }, 10);
  s.difficulty = { sha256d: '181019021' };
  s.miners = [{ account: 'val01.node.sovereign' }];
  s.mempoolSize = 10;

  const st = s.stats();
  assert.equal(st.supplyCapGrains, '2100000000000000');
  assert.equal(st.allTime.circulationGrains, '100000000000000');
  assert.equal(st.allTime.blockchainSizeBytes, 4096);
  assert.equal(st.allTime.networkNodes, 1);
  assert.equal(st.allTime.difficulty, '181019021');
  assert.equal(st.last24h.transactions, 1);
  assert.equal(st.last24h.blocks, 1);
  assert.equal(st.last24h.volumeGrains, '10000000000');
  assert.equal(st.last24h.indexedTransactionBytes, 512);
  assert.equal(st.mempool.transactions, 10);
  assert.equal(st.mempool.sizeBytes, null);
  assert.equal('stakingRatio' in st, false);
  assert.ok(st.mintedOfCap > 0 && st.mintedOfCap < 0.02, 'mined/cap small but nonzero');
});
