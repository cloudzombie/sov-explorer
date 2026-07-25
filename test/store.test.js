// Unit tests for the index/store logic. These exercise the pure data structures
// with records shaped exactly like the node's RPC output — no network needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINER_WINDOW_BLOCKS,
  Store,
  tipGrains,
  transactionCrypto,
  txCounterparty,
  unwrapTipped,
} from '../src/store.js';

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
  // A fee-auction tipped envelope touches its inner action's counterparty.
  assert.equal(
    txCounterparty({ type: 'tipped', tip: '5', inner: { type: 'transfer', to: 'b.sovereign' } }),
    'b.sovereign',
  );
});

test('tipped envelope unwrap and tip extraction are exact and bounded', () => {
  const inner = { type: 'transfer', to: 'b.sovereign', amount: '7' };
  const tipped = { type: 'tipped', tip: '250000', inner };
  assert.equal(unwrapTipped(tipped), inner);
  assert.equal(unwrapTipped(inner), inner, 'untipped action passes through');
  assert.equal(tipGrains(tipped), 250000n);
  assert.equal(tipGrains(inner), 0n);
  assert.equal(tipGrains({ type: 'tipped', tip: 'garbage' }), 0n, 'malformed tip is 0, not NaN');
  // Consensus forbids nesting, but a hostile relay must not loop the explorer.
  let nested = inner;
  for (let i = 0; i < 10; i++) nested = { type: 'tipped', tip: '1', inner: nested };
  assert.ok(unwrapTipped(nested) !== undefined);
});

test('window stats count tipped volume and miner tips', () => {
  const s = new Store();
  const plain = tx(hx(4001), 'a.sovereign', { type: 'transfer', to: 'b.sovereign', amount: '100' });
  const tipped = tx(hx(4002), 'a.sovereign', {
    type: 'tipped',
    tip: '25',
    inner: { type: 'transfer', to: 'b.sovereign', amount: '300' },
  });
  const b = block(1, [plain, tipped]);
  b.timestampMs = Date.now();
  s.addBlock(b);
  const day = s.stats().last24h;
  assert.equal(day.volumeGrains, '400', 'tipped inner transfer counts toward volume');
  assert.equal(day.minerTipGrains, '25');
  assert.equal(day.tippedTransactions, 1);
});

test('miner accounts in window come from the registry with an explicit window', () => {
  const s = new Store();
  assert.equal(s.minerAccountsInWindow(), null, 'no registry yet — unknown, never zero');
  s.addBlock(block(1000));
  s.tipHeight = 1000;
  s.miners = [
    { account: 'in-window', lastSeenHeight: 1000 },
    { account: 'edge-in', lastSeenHeight: 1000 - MINER_WINDOW_BLOCKS + 1 },
    { account: 'edge-out', lastSeenHeight: 1000 - MINER_WINDOW_BLOCKS },
    { account: 'ancient', lastSeenHeight: 3 },
    { account: 'malformed' },
  ];
  assert.equal(s.minerAccountsInWindow(), 2, 'inclusive window boundary');
  assert.equal(s.minerAccountsInWindow(10_000), 4, 'wider window counts all well-formed entries');
  const st = s.stats();
  assert.equal(st.minerWindow.windowBlocks, MINER_WINDOW_BLOCKS);
  assert.equal(st.minerWindow.accounts, 2);
  assert.equal(st.minersActive, 2, 'backward-compatible alias');
});

test('windowed miner distribution reports coverage honestly', () => {
  const s = new Store();
  for (let h = 5; h <= 14; h++) {
    const b = block(h);
    b.proposer = h % 2 === 0 ? 'alice' : 'bob';
    s.addBlock(b);
  }
  const w = s.windowMinerStats(8); // heights 7..14, fully retained
  assert.equal(w.coveredBlocks, 8);
  assert.equal(w.complete, true);
  assert.deepEqual(w.miners.map((m) => [m.account, m.blocks]), [['alice', 4], ['bob', 4]]);
  assert.equal(w.miners[0].share, 0.5);

  const partial = s.windowMinerStats(100); // asks below minHeight (5)
  assert.equal(partial.coveredBlocks, 10);
  assert.equal(partial.complete, false, 'partial coverage is declared, not hidden');
  assert.equal(partial.fromHeight, 5);
  assert.equal(partial.toHeight, 14);

  const empty = new Store();
  assert.equal(empty.windowMinerStats(8).coveredBlocks, 0);
  assert.equal(empty.windowMinerStats(8).complete, false);
});

test('version-bits signaling counts only headers that carry the signal word', () => {
  const s = new Store();
  for (let h = 0; h < 6; h++) {
    const b = block(h);
    // heights 0-1 pre-date versionBits retention; 2-3 signal bits 0+1; 4-5 signal none
    b.versionBits = h < 2 ? null : h < 4 ? 0b11 : 0;
    s.addBlock(b);
  }
  const sig = s.versionBitsSignaling([0, 1], 10);
  assert.equal(sig.coveredBlocks, 4, 'null signal words are excluded, not counted as zero');
  assert.deepEqual(sig.byBit, { 0: 2, 1: 2 });
  assert.deepEqual(s.versionBitsSignaling([0], 2).byBit, { 0: 0 }, 'window restricts to newest blocks');
  assert.deepEqual(s.versionBitsSignaling([99], 10).byBit, {}, 'invalid bits are rejected');
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
  // A miner ACCOUNT is not a node: with no peer information available, the node
  // count must be unavailable rather than borrowing the miner-account count.
  assert.equal(st.allTime.networkNodes, null);
  assert.equal(st.allTime.networkNodesBasis, null);
  assert.equal(st.allTime.minersSeen, 1, 'miner accounts are still reported, as accounts');
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

test('block-time statistics are measured from header timestamps with a stated window', () => {
  const s = new Store();
  s.difficulty = { targetBlockMs: 150_000 };
  // Intervals: 100s, 200s, 300s → median 200s, mean 200s.
  const stamps = [0, 100_000, 300_000, 600_000];
  stamps.forEach((ts, i) => {
    const b = block(i, []);
    b.timestampMs = ts;
    s.addBlock(b);
  });

  const bt = s.blockTimeStats(3);
  assert.equal(bt.intervals, 3);
  assert.equal(bt.medianMs, 200_000);
  assert.equal(bt.meanMs, 200_000);
  assert.equal(bt.minMs, 100_000);
  assert.equal(bt.maxMs, 300_000);
  assert.equal(bt.targetMs, 150_000, 'the protocol target is reported alongside, not substituted');
  assert.equal(bt.fromHeight, 0);
  assert.equal(bt.toHeight, 3);
  assert.equal(bt.complete, true);
  assert.equal(bt.nonMonotonicIntervals, 0);
});

test('block-time statistics exclude backwards headers instead of clamping them', () => {
  const s = new Store();
  // Height 2 has a timestamp EARLIER than height 1 — legal for a miner-supplied
  // header. It must not be counted as a zero-length block.
  for (const [h, ts] of [[0, 0], [1, 200_000], [2, 150_000], [3, 350_000]]) {
    const b = block(h, []);
    b.timestampMs = ts;
    s.addBlock(b);
  }
  const bt = s.blockTimeStats(3);
  assert.equal(bt.nonMonotonicIntervals, 1);
  assert.equal(bt.intervals, 2, 'only the two forward intervals are measured');
  // 200_000 (0→1) and 200_000 (2→3); the backwards step contributes nothing.
  assert.equal(bt.meanMs, 200_000);
  assert.equal(bt.complete, true, 'every height still produced a decision');
});

test('block-time statistics report nulls, never zeros, without a usable interval', () => {
  const s = new Store();
  assert.deepEqual(
    { medianMs: s.blockTimeStats().medianMs, meanMs: s.blockTimeStats().meanMs, intervals: s.blockTimeStats().intervals },
    { medianMs: null, meanMs: null, intervals: 0 },
  );
  const b = block(5, []);
  b.timestampMs = 1_000;
  s.addBlock(b);
  const one = s.blockTimeStats(576);
  assert.equal(one.intervals, 0, 'a single block yields no interval');
  assert.equal(one.medianMs, null);
  assert.equal(one.complete, false, 'a partial window says so');
});

test('the node count comes from peers, never from miner accounts', () => {
  const s = new Store();
  const b = block(1, []);
  b.timestampMs = Date.now();
  s.addBlock(b);
  s.miners = [{ account: 'a' }, { account: 'b' }, { account: 'c' }];
  s.recordSupply({ total: '1', mined: '1' }, 1);

  assert.equal(s.stats().allTime.networkNodes, null, 'three miner accounts are not three nodes');

  s.peerSummary = { peers: 3, relayVersion: 'v0.2.0', protocolVersion: 2, agents: {} };
  s._touchStats(); // chain-stat fields are assigned directly; the snapshot is memoized
  const st = s.stats();
  assert.equal(st.allTime.networkNodes, 3);
  assert.match(st.allTime.networkNodesBasis, /not a network census/);
  assert.equal(st.allTime.minersSeen, 3, 'miner accounts remain reported separately');
});

test('fee routes only contain the routes the node actually priced', () => {
  const s = new Store();
  s.feeRoutes = { transfer: { kind: 'transfer', feeGrains: '1651760' } };
  s._touchStats();
  const st = s.stats();
  assert.deepEqual(Object.keys(st.feeRoutes), ['transfer']);
  assert.equal(st.feeRoutes.shielded, undefined, 'an unpriced route is absent, not zero');
});

test('an outage yields unavailable values, never fabricated zeros', () => {
  const s = new Store(); // nothing indexed, node never answered
  const st = s.stats();
  assert.equal(st.mintedOfCap, null, 'a 0.00%-of-cap reading would look like a real answer');
  assert.equal(st.supply, null);
  assert.equal(st.difficulty, null);
  assert.equal(st.deployments, null);
  assert.equal(st.feeRoutes, null);
  assert.equal(st.mintRewardGrains, null);
  assert.equal(st.signingDomain, null);
  assert.equal(st.minerWindow.accounts, null);
  assert.equal(st.blockTime.medianMs, null);
  assert.equal(st.allTime.networkNodes, null);

  // Once supply is known the ratio becomes a real number again.
  s.recordSupply({ total: '2100000000000000', mined: '2100000000000000' }, 1);
  assert.equal(s.stats().mintedOfCap, 1);
});
