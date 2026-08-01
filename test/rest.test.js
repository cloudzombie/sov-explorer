import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRest } from '../src/rest.js';
import { Store } from '../src/store.js';

const id = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;

function context() {
  const store = new Store();
  store.nodeHeight = 1;
  store.addBlock({
    height: 1,
    hash: blockHash,
    prevHash: `0x${'00'.repeat(32)}`,
    timestampMs: 2_000,
    proposer: 'miner',
    txCount: 1,
    sizeBytes: 20_000,
    transactions: [{
      id, index: 0, signer: 'alice', publicKey: 'huge-key', signature: 'huge-signature',
      action: { type: 'transfer', to: 'bob', amount: '42', bundle: new Array(1_000).fill(1) },
      executionStatus: 'success', blockHeight: 1, blockHash, timestampMs: 2_000,
    }],
  });
  return { store, rpc: {} };
}

test('recent transaction lists use compact records', async () => {
  const response = await handleRest('GET', '/api/txs', new URLSearchParams('limit=1'), context());
  assert.equal(response.status, 200);
  const [tx] = JSON.parse(response.body);
  assert.equal(tx.id, id);
  assert.equal(tx.executionStatus, 'success');
  assert.equal(tx.publicKey, undefined);
  assert.equal(tx.signature, undefined);
  assert.equal(tx.action.bundle, undefined);
});

test('transaction pagination rejects malformed filters and returns a page envelope', async () => {
  const bad = await handleRest('GET', '/api/transactions', new URLSearchParams('cursor=bad'), context());
  assert.equal(bad.status, 400);
  const response = await handleRest('GET', '/api/transactions', new URLSearchParams('status=success'), context());
  assert.equal(response.status, 200);
  const page = JSON.parse(response.body);
  assert.equal(page.items.length, 1);
  assert.equal(page.historyComplete, false);
});

test('proof capabilities are advertised before the UI offers verification', async () => {
  const ctx = context();
  ctx.store.genesisHash = blockHash;
  ctx.rpc.transactionProof = async () => ({ algorithm: 'sha256' });
  ctx.rpc.receiptProof = async () => ({ algorithm: 'sha256' });
  const response = await handleRest('GET', '/api/capabilities', new URLSearchParams(), ctx);
  assert.deepEqual(JSON.parse(response.body).proofs, {
    transaction: true,
    receipt: true,
    algorithms: ['sha256'],
    browserVerifiable: true,
  });
});

test('the proof endpoint serves pool-v2 privacy state, and null when the node is too old', async () => {
  const ctx = context();
  // Older node: sov_getShieldedV2Info never answered, so nothing was stored.
  let response = await handleRest('GET', '/api/proof', new URLSearchParams(), ctx);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).privacy.shieldedV2Info, null, 'absent, not a fake empty pool');

  // v0.2.5 node: the dormant pool-v2 state is surfaced verbatim under privacy.
  ctx.store.shieldedV2Info = {
    active: false, poolValue: '0', noteCount: 0, nullifierCount: 0,
    anchor: 'e6efef0131865379f23c3fb340e2510abb012791cd41f5ac9bee742000a75566',
    deshieldableNowGrains: '0', deshieldLimitGrains: '2100000000000000',
    deshieldWindowBlocks: 576, windowResetsAtHeight: 576, height: 13804,
  };
  response = await handleRest('GET', '/api/proof', new URLSearchParams(), ctx);
  const privacy = JSON.parse(response.body).privacy;
  assert.equal(privacy.shieldedV2Info.active, false);
  assert.equal(privacy.shieldedV2Info.poolValue, '0');
  assert.equal(privacy.shieldedV2Info.anchor, ctx.store.shieldedV2Info.anchor);
});

test('chain-object catalog and token detail merge live state with archived activity', async () => {
  const ctx = context();
  const issue = {
    id, index: 0, signer: 'alice', action: { type: 'token_issue', symbol: 'USD1', to: 'alice', amount: '100' },
    blockHeight: 1, blockHash, timestampMs: 2_000,
  };
  ctx.rpc.listTokens = async () => ({
    tokens: [{ asset: id, issuer: 'alice', symbol: 'USD1', supply: '90', issued: '100', burned: '10' }],
    hasMore: false,
  });
  ctx.rpc.tokenInfo = async () => ({ asset: id, issuer: 'alice', symbol: 'USD1', supply: '90' });
  ctx.store.archive = {
    object: (_kind, objectId) => objectId.startsWith('issue:') ? { activity: [issue] } : null,
  };
  const catalog = await handleRest('GET', '/api/catalog', new URLSearchParams('kind=token'), ctx);
  assert.equal(JSON.parse(catalog.body).items[0].id, id);
  const detail = await handleRest('GET', `/api/object/token/${encodeURIComponent(id)}`, new URLSearchParams(), ctx);
  const object = JSON.parse(detail.body);
  assert.equal(object.state.symbol, 'USD1');
  assert.equal(object.activity[0].actionType, 'token_issue');
  assert.equal(object.activity[0].signature, undefined);
});

test('account history is cursor-paginated and includes live holdings', async () => {
  const ctx = context();
  const archived = ctx.store.recentTxs(1)[0];
  ctx.rpc.account = async () => ({ balance: '42', nonce: 1 });
  ctx.rpc.namesOf = async () => ['alice.sov'];
  ctx.rpc.tokenBalances = async () => [{ asset: id, symbol: 'USD1', balance: '7' }];
  ctx.rpc.nftsOf = async () => [{ collection: blockHash, tokenId: '01', owner: 'alice' }];
  ctx.store.archive = {
    status: () => ({ complete: true, contiguousFromHeight: 0 }),
    transactionPage: ({ account, limit, cursor }) => {
      assert.equal(account, 'alice');
      assert.equal(limit, 1);
      assert.equal(cursor, null);
      return { records: [archived], hasMore: true };
    },
  };
  const response = await handleRest('GET', '/api/account/alice', new URLSearchParams('limit=1'), ctx);
  const account = JSON.parse(response.body);
  assert.equal(account.transactions.length, 1);
  assert.ok(account.nextCursor);
  assert.equal(account.tokenBalances[0].symbol, 'USD1');
  assert.equal(account.nfts[0].tokenId, '01');
  assert.equal(account.historyComplete, true);
});

test('block lists carry real per-block shielded flows, and never fabricate them', async () => {
  const ctx = context();
  // A block whose only shielded action is a successful v1 shield of 100 grains
  // (bundle prefix: flags byte + value_balance -100 as i64le, per the chain codec).
  const vb = new Array(9).fill(0);
  vb[0] = 0x03;
  const neg100 = BigInt.asUintN(64, -100n);
  for (let i = 0; i < 8; i++) vb[1 + i] = Number((neg100 >> BigInt(8 * i)) & 0xffn);
  const hash2 = `0x${'ef'.repeat(32)}`;
  ctx.store.addBlock({
    height: 2,
    hash: hash2,
    prevHash: blockHash,
    timestampMs: 3_000,
    proposer: 'miner',
    txCount: 1,
    sizeBytes: 1_000,
    transactions: [{
      id: `0x${'12'.repeat(32)}`, index: 0, signer: 'alice', publicKey: 'k', signature: 's',
      action: { type: 'shielded', bundle: vb },
      executionStatus: 'success', blockHeight: 2, blockHash: hash2, timestampMs: 3_000,
    }],
  });
  const response = await handleRest('GET', '/api/blocks', new URLSearchParams('limit=2'), ctx);
  const [top, prev] = JSON.parse(response.body);
  // Derived from the retained transactions (no precomputed field on this record).
  assert.deepEqual(top.shieldedFlows, {
    shieldV1: '100', unshieldV1: '0', shieldV2: '0', unshieldV2: '0', shieldedTxs: 1, unattributed: 0,
  });
  // The transfer-only block genuinely moved nothing across the pool boundary.
  assert.equal(prev.shieldedFlows.shieldV1, '0');
  assert.equal(prev.shieldedFlows.shieldedTxs, 0);
});
