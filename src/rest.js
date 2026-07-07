// REST API over the indexed store: read-only JSON. Returns `null` for paths
// outside `/api/` so the server falls through to static file serving. Live,
// balance-sensitive reads (accounts, supply) hit the node directly; historical
// reads (blocks, transactions) come from the index.

import { normalizeBlock } from './indexer.js';

function json(status, body) {
  return { status, body: JSON.stringify(body) };
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

// A block-list summary built from a node `sov_getBlockDigest`, for historical blocks
// outside the in-memory index window. Matches the fields the Blocks page renders.
// `proposer` is the coinbase miner (absent on the zero-reward genesis block); `final`
// is derived from depth (6-confirmation rule) rather than an extra RPC round-trip.
function digestSummary(height, d, tip) {
  return {
    height,
    hash: d.hash,
    proposer: d.coinbase?.recipients?.[0]?.account ?? null,
    txCount: Array.isArray(d.txIds) ? d.txIds.length : 0,
    coinbase: d.coinbase ?? null,
    timestampMs: d.timestampMs,
    final: tip - height >= 6,
  };
}

export async function handleRest(method, pathname, query, ctx) {
  if (!pathname.startsWith('/api/')) return null;
  if (method !== 'GET') return json(405, { error: 'GET only' });

  const { store, rpc } = ctx;
  const parts = pathname.split('/').filter(Boolean); // ['api', <sub>, <arg>]
  const sub = parts[1];
  const arg = parts[2] !== undefined ? decodeURIComponent(parts[2]) : undefined;

  try {
    switch (sub) {
      case 'status':
        return json(200, store.stats());

      case 'blocks': {
        // Paged, newest-first. Recent blocks come from the in-memory index; older
        // ones (outside the retained window) are fetched from the node on demand, so
        // the page walks all the way back to genesis on a long chain. `?before=<height>`
        // sets the cursor (omit for the latest page); `?limit` bounds the page.
        const limit = clamp(query.get('limit'), 1, 200, 25);
        const tip = store.tipHeight;
        const beforeRaw = query.get('before');
        const startRaw = beforeRaw !== null && beforeRaw !== '' ? Number(beforeRaw) : tip;
        const start = Number.isFinite(startRaw) ? Math.min(startRaw, tip) : tip;
        const out = [];
        for (let h = start; h >= 0 && out.length < limit; h--) {
          let b = store.block(h);
          if (!b) {
            const d = await rpc.blockDigest(h).catch(() => null);
            if (d) b = digestSummary(h, d, tip);
          }
          if (b) out.push(b);
        }
        return json(200, out);
      }

      case 'txs':
        return json(200, store.recentTxs(clamp(query.get('limit'), 1, 200, 25)));

      case 'block': {
        if (arg === undefined) return json(400, { error: 'missing block reference' });
        const ref = /^\d+$/.test(arg) ? Number(arg) : arg.toLowerCase();
        const block = store.block(ref);
        if (block) return json(200, block);
        // Outside the in-memory window (e.g. genesis on a long chain): fetch the
        // block from the node so permalinks — height or hash — never go dark.
        const node =
          typeof ref === 'number'
            ? await rpc.blockDigest(ref).catch(() => null)
            : await rpc.blockByHash(ref).catch(() => null);
        if (node) {
          const height = typeof ref === 'number' ? ref : node.header?.height ?? node.height;
          const d = typeof ref === 'number' ? node : await rpc.blockDigest(height).catch(() => null);
          if (d) {
            const s = digestSummary(height, d, store.tipHeight);
            return json(200, { ...s, prevHash: d.prevHash, stateRoot: d.stateRoot, txRoot: d.txRoot ?? null, receiptsRoot: d.receiptsRoot ?? null, transactions: [] });
          }
        }
        return json(404, { error: 'block not found on the chain' });
      }

      case 'tx': {
        if (!arg) return json(400, { error: 'missing transaction id' });
        const id = arg.toLowerCase();
        let tx = store.tx(id);
        if (!tx) {
          // Not in the indexed window. If the node holds a RECEIPT for this id,
          // the transaction IS on-chain — pull its block and lift the record out,
          // so fresh links (clicked before the indexer caught up) and old ones
          // (evicted from the window) both resolve.
          const r = await rpc.receipt(id).catch(() => null);
          if (r && Number.isFinite(r.height)) {
            const [block, digest] = await Promise.all([
              rpc.blockByHeight(r.height).catch(() => null),
              rpc.blockDigest(r.height).catch(() => null),
            ]);
            if (block && digest) {
              const rec = normalizeBlock(block, digest, store.tipHeight - r.height >= 6);
              tx = rec.transactions.find((t) => t.id === id) ?? null;
            }
          }
          if (!tx) {
            // No receipt anywhere: either it was just submitted and hasn't been
            // mined yet, or the id is unknown. Tell the client it may be pending
            // so it can wait-and-retry instead of declaring failure.
            return json(404, { error: 'transaction not yet mined', pending: true });
          }
        }
        // Enrich with the live execution receipt (success / exact failure reason,
        // gas, contract events) and depth-derived confirmations — both are real
        // chain data read from the node, not stored copies.
        const receipt = await rpc.receipt(tx.id).catch(() => null);
        const confirmations = Math.max(0, store.tipHeight - tx.blockHeight + 1);
        return json(200, { ...tx, receipt, confirmations, final: confirmations >= 6 });
      }

      case 'account': {
        if (!arg) return json(400, { error: 'missing account' });
        let id = arg;
        let resolvedFrom = null;
        let account = await rpc.account(id).catch(() => null);
        // If it isn't a funded account but IS a registered SNS name, resolve the
        // name to the account it points to (so a name is trackable/resolvable).
        if (!account) {
          const target = await rpc.resolveName(id).catch(() => null);
          if (target) {
            resolvedFrom = id;
            id = target;
            account = await rpc.account(id).catch(() => null);
          }
        }
        // SNS names that resolve to this account (reverse lookup).
        const names = await rpc.namesOf(id).catch(() => []);
        return json(200, { id, resolvedFrom, account, names, transactions: store.accountTxs(id, 50) });
      }

      // Sovereign Name Service: a page of registered names. Live from the node so
      // it reflects the current registry. Params: ?offset & ?limit.
      case 'names': {
        const offset = clamp(query.get('offset'), 0, 1e9, 0);
        const limit = clamp(query.get('limit'), 1, 200, 100);
        return json(200, await rpc.listNames(offset, limit));
      }

      // A single SNS name → its record (owner + registration height), or null.
      case 'name': {
        if (!arg) return json(400, { error: 'missing name' });
        return json(200, (await rpc.getName(arg)) ?? null);
      }

      case 'supply':
        return json(200, store.supply ?? (await rpc.supply()));

      case 'observed-miners':
        return json(200, { miners: store.observedMiners() });

      case 'validators': {
        return json(200, { validators: store.validators() });
      }

      case 'miners':
        return json(200, store.miners);

      case 'analytics':
        return json(200, { stats: store.stats(), supplySeries: store.supplySeries });

      case 'search': {
        const result = store.search(query.get('q') ?? '');
        // An unknown 0x-hash may be an older block outside our window — ask the node.
        if (result.kind === 'hash') {
          const blk = await rpc.blockByHash(result.ref).catch(() => null);
          if (blk) return json(200, { kind: 'block', ref: blk.header.height, known: true });
        }
        return json(200, result);
      }

      default:
        return json(404, { error: `unknown endpoint /api/${sub ?? ''}` });
    }
  } catch (e) {
    return json(502, { error: `upstream node error: ${e.message}` });
  }
}
