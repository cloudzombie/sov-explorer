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
