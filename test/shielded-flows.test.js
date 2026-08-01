// Shielded-pool boundary-flow decoding: the byte formats here mirror the chain
// crates exactly (sov-shielded/src/codec.rs and sov-shielded-pq/src/wire.rs).
// These are the same bytes consensus decodes to move transparent balance, so a
// correct parse here is a correct statement about real on-chain flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockShieldedFlows, shieldedFlowGrains } from '../src/store.js';

/** v1 Orchard bundle prefix: flags:1 | value_balance:i64le:8 | (rest opaque). */
function v1Bundle(valueBalance) {
  const out = new Uint8Array(9 + 32); // prefix + anchor placeholder
  out[0] = 0x03; // flags: spends+outputs enabled
  const vb = BigInt.asUintN(64, BigInt(valueBalance));
  for (let i = 0; i < 8; i++) out[1 + i] = Number((vb >> BigInt(8 * i)) & 0xffn);
  return Array.from(out);
}

/** v2 wire prefix: version:1 | 4×32 anchors | 4×32 nullifiers | 4 input_dummy |
 * 4×32 commitments | 4 output_dummy | t_in:u64le | t_out:u64le | fee:u64le. */
function v2Bundle(tIn, tOut, fee = 0n, version = 1) {
  const legs = 1 + 4 * (32 + 32 + 32) + 8;
  const out = new Uint8Array(legs + 24);
  out[0] = version;
  const put = (at, v) => {
    for (let i = 0; i < 8; i++) out[at + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
  };
  put(legs, tIn);
  put(legs + 8, tOut);
  put(legs + 16, fee);
  return Array.from(out);
}

test('v1 negative value balance is a shield into pool v1', () => {
  const flow = shieldedFlowGrains({ type: 'shielded', bundle: v1Bundle(-5_000_000_000n) });
  assert.deepEqual(flow, { pool: 1, shieldGrains: 5_000_000_000n, unshieldGrains: 0n });
});

test('v1 positive value balance is an unshield out of pool v1', () => {
  const flow = shieldedFlowGrains({ type: 'shielded', bundle: v1Bundle(123n) });
  assert.deepEqual(flow, { pool: 1, shieldGrains: 0n, unshieldGrains: 123n });
});

test('v1 zero value balance (private transfer) crosses no boundary', () => {
  const flow = shieldedFlowGrains({ type: 'shielded', bundle: v1Bundle(0n) });
  assert.deepEqual(flow, { pool: 1, shieldGrains: 0n, unshieldGrains: 0n });
});

test('v2 transparent_in / transparent_out map to shield2 / unshield2', () => {
  assert.deepEqual(
    shieldedFlowGrains({ type: 'shielded_v2', bundle: v2Bundle(700n, 0n) }),
    { pool: 2, shieldGrains: 700n, unshieldGrains: 0n },
  );
  assert.deepEqual(
    shieldedFlowGrains({ type: 'shielded_v2', bundle: v2Bundle(0n, 250_000_000n, 10n) }),
    { pool: 2, shieldGrains: 0n, unshieldGrains: 250_000_000n },
  );
});

test('a tipped envelope is unwrapped to its inner shielded action', () => {
  const flow = shieldedFlowGrains({
    type: 'tipped',
    tip: '5',
    inner: { type: 'shielded', bundle: v1Bundle(-40n) },
  });
  assert.deepEqual(flow, { pool: 1, shieldGrains: 40n, unshieldGrains: 0n });
});

test('unknown v2 proof version, truncated bundles, and non-shielded actions parse to null', () => {
  assert.equal(shieldedFlowGrains({ type: 'shielded_v2', bundle: v2Bundle(1n, 0n, 0n, 9) }), null);
  assert.equal(shieldedFlowGrains({ type: 'shielded', bundle: [1, 2, 3] }), null);
  assert.equal(shieldedFlowGrains({ type: 'shielded_v2', bundle: [1, 2, 3] }), null);
  assert.equal(shieldedFlowGrains({ type: 'transfer', to: 'a', amount: '1' }), null);
  assert.equal(shieldedFlowGrains(null), null);
});

const tx = (action, executionStatus) => ({ action, executionStatus });

test('blockShieldedFlows sums only committed-successful transactions by direction', () => {
  const block = {
    transactions: [
      tx({ type: 'shielded', bundle: v1Bundle(-100n) }, 'success'),
      tx({ type: 'shielded', bundle: v1Bundle(30n) }, 'success'),
      tx({ type: 'shielded_v2', bundle: v2Bundle(7n, 0n) }, 'success'),
      tx({ type: 'shielded_v2', bundle: v2Bundle(0n, 5n) }, 'success'),
      // Failed on-chain: consensus moved nothing — excluded, not unattributed.
      tx({ type: 'shielded', bundle: v1Bundle(-999n) }, 'failed'),
      // No receipt: flow unknown — excluded from sums, counted unattributed.
      tx({ type: 'shielded', bundle: v1Bundle(-999n) }, null),
      // Successful but unparseable bundle: also unattributed, never guessed.
      tx({ type: 'shielded_v2', bundle: [1, 2] }, 'success'),
      tx({ type: 'transfer', to: 'a', amount: '5' }, 'success'),
    ],
  };
  assert.deepEqual(blockShieldedFlows(block), {
    shieldV1: '100',
    unshieldV1: '30',
    shieldV2: '7',
    unshieldV2: '5',
    shieldedTxs: 7,
    unattributed: 2,
  });
});

test('blockShieldedFlows reads status from an attached receipt when needed', () => {
  const block = {
    transactions: [
      { action: { type: 'shielded', bundle: v1Bundle(-8n) }, receipt: { status: { status: 'success' } } },
    ],
  };
  assert.equal(blockShieldedFlows(block).shieldV1, '8');
});

test('a block with no transaction bodies has unknown flows (null), not zeros', () => {
  assert.equal(blockShieldedFlows({ height: 5 }), null);
  assert.equal(blockShieldedFlows(null), null);
});

test('an empty block genuinely moved nothing: zero sums, zero shielded txs', () => {
  assert.deepEqual(blockShieldedFlows({ transactions: [] }), {
    shieldV1: '0',
    unshieldV1: '0',
    shieldV2: '0',
    unshieldV2: '0',
    shieldedTxs: 0,
    unattributed: 0,
  });
});
