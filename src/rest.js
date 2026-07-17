// REST API over the indexed store: read-only JSON. Returns `null` for paths
// outside `/api/` so the server falls through to static file serving. Live,
// balance-sensitive reads (accounts, supply) hit the node directly; historical
// reads (blocks, transactions) come from the index.

import { confirmationCount, finalAtDepth, normalizeBlock } from './indexer.js';

function json(status, body) {
  return { status, body: JSON.stringify(body) };
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ACCOUNT_RE = /^[a-z0-9._-]{1,128}$/i;
const ACTION_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OBJECT_KINDS = new Set(['token', 'nft', 'contract', 'htlc']);
const TOKEN_ID_RE = /^[0-9a-f]{0,1024}$/i;
const HISTORY_CACHE_TTL_MS = 15_000;
const HISTORY_CACHE_MAX = 100;
const historyCache = new Map();
const capabilityCache = new Map();

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function compactAction(action) {
  if (!action || typeof action !== 'object') return null;
  const omitted = new Set(['bundle', 'code', 'preimage', 'proof', 'witness']);
  return Object.fromEntries(Object.entries(action).filter(([key, value]) => (
    !omitted.has(key) && !(Array.isArray(value) && value.length > 32)
  )));
}

function transactionSummary(tx) {
  return {
    id: tx.id,
    index: tx.index,
    signer: tx.signer,
    action: compactAction(tx.action),
    actionType: tx.action?.type ?? null,
    executionStatus: tx.executionStatus ?? tx.receipt?.status?.status ?? tx.receipt?.status ?? null,
    blockHeight: tx.blockHeight,
    blockHash: tx.blockHash,
    timestampMs: tx.timestampMs,
    sizeBytes: tx.sizeBytes,
  };
}

function mergeActivity(...groups) {
  const byId = new Map();
  for (const tx of groups.flat()) {
    if (tx?.id) byId.set(tx.id, tx);
  }
  return [...byId.values()]
    .sort((a, b) => (b.blockHeight - a.blockHeight) || ((b.index ?? 0) - (a.index ?? 0)))
    .map(transactionSummary);
}

function indexedObjectSummary(object) {
  if (!object) return null;
  return {
    kind: object.kind,
    id: object.id,
    owner: object.owner,
    label: object.label,
    status: object.status,
    createdHeight: object.createdHeight ?? object.blockHeight,
    updatedHeight: object.updatedHeight,
    creation: object.createdTransaction ? transactionSummary(object.createdTransaction) : null,
    latestAction: compactAction(object.action),
  };
}

function encodeCursor(tx) {
  return Buffer.from(JSON.stringify([tx.blockHeight, tx.index ?? 0, tx.id])).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const [height, index, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(height) || height < 0 || !Number.isSafeInteger(index) || index < 0 || !HASH_RE.test(id)) return null;
    return { height, index, id: id.toLowerCase() };
  } catch { return null; }
}

async function cachedHistory(key, load, metrics = null) {
  const existing = historyCache.get(key);
  if (existing && existing.expires > Date.now()) {
    metrics?.observeCache(true);
    return existing.value;
  }
  metrics?.observeCache(false);
  const value = await load();
  historyCache.set(key, { expires: Date.now() + HISTORY_CACHE_TTL_MS, value });
  while (historyCache.size > HISTORY_CACHE_MAX) {
    historyCache.delete(historyCache.keys().next().value);
  }
  return value;
}

async function mapBatches(values, width, mapper) {
  const out = [];
  for (let i = 0; i < values.length; i += width) {
    out.push(...await Promise.all(values.slice(i, i + width).map(mapper)));
  }
  return out;
}

async function blockPair(rpc, height) {
  if (typeof rpc.blockWithDigest === 'function') return rpc.blockWithDigest(height);
  const [block, digest] = await Promise.all([
    rpc.blockByHeight(height),
    rpc.blockDigest(height),
  ]);
  return block && digest ? { block, digest } : null;
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
    final: finalAtDepth(tip, height),
  };
}

function blockListSummary(block, tip) {
  return {
    height: block.height,
    hash: block.hash,
    proposer: block.proposer,
    txCount: block.txCount ?? block.transactions?.length ?? 0,
    coinbase: block.coinbase ?? null,
    timestampMs: block.timestampMs,
    stateRoot: block.stateRoot ?? null,
    txRoot: block.txRoot ?? null,
    receiptsRoot: block.receiptsRoot ?? null,
    final: finalAtDepth(tip, block.height),
  };
}

export async function handleRest(method, pathname, query, ctx) {
  if (!pathname.startsWith('/api/')) return null;
  if (method !== 'GET') return json(405, { error: 'GET only' });

  const { store, rpc, metrics } = ctx;
  const maxPageLimit = ['pro', 'enterprise'].includes(ctx.apiTier) ? 200 : 50;
  const parts = pathname.split('/').filter(Boolean); // ['api', <sub>, <arg>]
  const sub = parts[1];
  const arg = parts[2] !== undefined ? safeDecode(parts[2]) : undefined;
  if (parts[2] !== undefined && arg === null) return json(400, { error: 'malformed URL encoding' });
  const extra = parts[3] !== undefined ? safeDecode(parts.slice(3).join('/')) : undefined;
  if (parts[3] !== undefined && extra === null) return json(400, { error: 'malformed URL encoding' });

  try {
    switch (sub) {
      case 'status':
        return json(200, store.stats());

      case 'blocks': {
        // Paged, newest-first. Recent blocks come from the in-memory index; older
        // ones (outside the retained window) are fetched from the node on demand, so
        // the page walks all the way back to genesis on a long chain. `?before=<height>`
        // sets the cursor (omit for the latest page); `?limit` bounds the page.
        const limit = clamp(query.get('limit'), 1, maxPageLimit, 25);
        const tip = store.tipHeight;
        const beforeRaw = query.get('before');
        const startRaw = beforeRaw !== null && beforeRaw !== '' ? Number(beforeRaw) : tip;
        const start = Number.isFinite(startRaw)
          ? Math.max(0, Math.min(Math.trunc(startRaw), tip))
          : tip;
        const heights = Array.from({ length: Math.min(limit, start + 1) }, (_, i) => start - i);
        // The head participates in the key because list summaries contain derived
        // finality. Finalized historical pages are then immutable for this head.
        const key = `${store.genesisHash}:${tip}:${start}:${limit}`;
        const out = await cachedHistory(key, async () => {
          const rows = await mapBatches(heights, 8, async (h) => {
            const local = store.block(h);
            if (local) return blockListSummary(local, tip);
            const archived = store.archive?.block(h);
            if (archived) return blockListSummary(archived, tip);
            const d = await rpc.blockDigest(h).catch(() => null);
            return d ? digestSummary(h, d, tip) : null;
          });
          return rows.filter(Boolean);
        }, metrics);
        return json(200, out);
      }

      case 'txs':
        return json(200, store.recentTxs(clamp(query.get('limit'), 1, maxPageLimit, 25)).map(transactionSummary));

      case 'transactions': {
        const limit = clamp(query.get('limit'), 1, maxPageLimit, 50);
        const cursorRaw = query.get('cursor');
        const cursor = decodeCursor(cursorRaw);
        if (cursorRaw && !cursor) return json(400, { error: 'invalid transaction cursor' });
        const actionType = String(query.get('action') ?? '').trim().toLowerCase();
        if (actionType && !ACTION_TYPE_RE.test(actionType)) return json(400, { error: 'invalid action filter' });
        const status = String(query.get('status') ?? '').trim().toLowerCase();
        if (status && !['success', 'failed'].includes(status)) return json(400, { error: 'invalid status filter' });
        const account = String(query.get('account') ?? '').trim();
        if (account && !ACCOUNT_RE.test(account)) return json(400, { error: 'invalid account filter' });
        const intFilter = (name) => {
          const raw = query.get(name);
          if (raw === null || raw === '') return null;
          const value = Number(raw);
          return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
        };
        const minHeight = intFilter('minHeight');
        const maxHeight = intFilter('maxHeight');
        const fromMs = intFilter('fromMs');
        const toMs = intFilter('toMs');
        if ([minHeight, maxHeight, fromMs, toMs].some(Number.isNaN)) return json(400, { error: 'invalid numeric transaction filter' });
        let records;
        let hasMore = false;
        if (store.archive) {
          ({ records, hasMore } = store.archive.transactionPage({
            limit, cursor, actionType: actionType || null, status: status || null,
            account: account || null, minHeight, maxHeight, fromMs, toMs,
          }));
        } else {
          records = store.recentTxs(200).filter((tx) => (
            (!actionType || tx.action?.type === actionType)
            && (!status || (tx.executionStatus ?? tx.receipt?.status?.status ?? tx.receipt?.status) === status)
            && (!account || tx.signer === account)
            && (minHeight === null || tx.blockHeight >= minHeight)
            && (maxHeight === null || tx.blockHeight <= maxHeight)
            && (fromMs === null || tx.timestampMs >= fromMs)
            && (toMs === null || tx.timestampMs <= toMs)
          )).slice(0, limit);
        }
        return json(200, {
          items: records.map(transactionSummary),
          nextCursor: hasMore && records.length ? encodeCursor(records.at(-1)) : null,
          historyComplete: store.archive?.status(store.nodeHeight).complete ?? false,
        });
      }

      case 'catalog': {
        const kind = String(query.get('kind') ?? '').toLowerCase();
        if (!OBJECT_KINDS.has(kind)) return json(400, { error: 'kind must be token, nft, contract, or htlc' });
        const offset = clamp(query.get('offset'), 0, 1_000_000_000, 0);
        const limit = clamp(query.get('limit'), 1, maxPageLimit, 50);
        if (kind === 'token' && typeof rpc.listTokens === 'function') {
          const page = await rpc.listTokens(offset, limit);
          return json(200, {
            kind,
            items: (page?.tokens ?? []).map((item) => ({ kind, id: item.asset, ...item, status: 'active' })),
            offset,
            limit,
            hasMore: !!page?.hasMore,
          });
        }
        if (kind === 'nft' && typeof rpc.listNfts === 'function') {
          const page = await rpc.listNfts(offset, limit);
          return json(200, {
            kind,
            items: (page?.nfts ?? []).map((item) => ({
              kind, id: `${item.collection}:${item.tokenId}`, collection: item.collection,
              tokenId: item.tokenId, tokenText: item.tokenText, owner: item.owner,
              mintedHeight: item.mintedHeight, status: 'minted',
            })),
            offset,
            limit,
            hasMore: !!page?.hasMore,
          });
        }
        const items = store.archive?.objects(kind, limit + 1, offset) ?? [];
        return json(200, {
          kind,
          items: items.slice(0, limit).map(indexedObjectSummary),
          offset,
          limit,
          hasMore: items.length > limit,
        });
      }

      case 'object': {
        const kind = String(arg ?? '').toLowerCase();
        const id = extra;
        if (!OBJECT_KINDS.has(kind)) return json(400, { error: 'invalid object kind' });
        if (!id) return json(400, { error: 'missing object id' });
        const archive = store.archive;
        if (kind === 'token') {
          if (!HASH_RE.test(id)) return json(400, { error: 'invalid token asset id' });
          const state = typeof rpc.tokenInfo === 'function' ? await rpc.tokenInfo(id).catch(() => null) : null;
          const indexed = archive?.object(kind, id);
          if (!state && !indexed) return json(404, { error: 'token not found on the chain' });
          const issuance = state
            ? archive?.object(kind, `issue:${state.issuer}:${state.symbol}`)?.activity ?? []
            : [];
          return json(200, {
            kind, id: id.toLowerCase(), state, indexed: indexedObjectSummary(indexed),
            activity: mergeActivity(indexed?.activity ?? [], issuance),
          });
        }
        if (kind === 'nft') {
          const separator = id.indexOf(':');
          const collection = separator > 0 ? id.slice(0, separator) : '';
          const tokenId = separator > 0 ? id.slice(separator + 1) : '';
          if (!HASH_RE.test(collection) || !TOKEN_ID_RE.test(tokenId)) return json(400, { error: 'invalid NFT id' });
          const [state, collectionState] = await Promise.all([
            typeof rpc.nft === 'function' ? rpc.nft(collection, tokenId).catch(() => null) : null,
            typeof rpc.nftClass === 'function' ? rpc.nftClass(collection).catch(() => null) : null,
          ]);
          const indexed = archive?.object(kind, id);
          if (!state && !indexed) return json(404, { error: 'NFT not found on the chain' });
          const mint = collectionState
            ? archive?.object(kind, `mint:${collectionState.issuer}:${collectionState.symbol}:${tokenId}`)?.activity ?? []
            : [];
          return json(200, {
            kind, id: id.toLowerCase(), collection, tokenId, state, collectionState,
            indexed: indexedObjectSummary(indexed),
            activity: mergeActivity(indexed?.activity ?? [], mint),
          });
        }
        if (kind === 'contract') {
          if (!ACCOUNT_RE.test(id)) return json(400, { error: 'invalid contract account' });
          const [state, indexed] = await Promise.all([
            typeof rpc.account === 'function' ? rpc.account(id).catch(() => null) : null,
            Promise.resolve(archive?.object(kind, id)),
          ]);
          if (!indexed && !state?.code) return json(404, { error: 'contract not found on the chain' });
          return json(200, {
            kind, id, state, indexed: indexedObjectSummary(indexed),
            activity: mergeActivity(indexed?.activity ?? []),
            events: indexed?.events ?? [],
          });
        }
        if (!HASH_RE.test(id)) return json(400, { error: 'invalid HTLC id' });
        const [state, indexed] = await Promise.all([
          typeof rpc.htlc === 'function' ? rpc.htlc(id).catch(() => null) : null,
          Promise.resolve(archive?.object(kind, id)),
        ]);
        if (!state && !indexed) return json(404, { error: 'HTLC not found on the chain' });
        return json(200, {
          kind, id: id.toLowerCase(), state, indexed: indexedObjectSummary(indexed),
          status: indexed?.status ?? (state ? 'locked' : 'unknown'),
          activity: mergeActivity(indexed?.activity ?? []),
        });
      }

      case 'block': {
        if (arg === undefined) return json(400, { error: 'missing block reference' });
        const ref = /^\d+$/.test(arg) ? Number(arg) : arg.toLowerCase();
        if (typeof ref === 'number' && (!Number.isSafeInteger(ref) || ref < 0)) {
          return json(400, { error: 'invalid block height' });
        }
        if (typeof ref === 'string' && !HASH_RE.test(ref)) {
          return json(400, { error: 'invalid block hash' });
        }
        const block = store.block(ref) ?? store.archive?.block(ref);
        if (block) {
          return json(200, { ...block, final: finalAtDepth(store.tipHeight, block.height) });
        }
        // Outside the retained window, load the full body and digest as one
        // same-relay pair. This keeps old permalinks complete without retaining the
        // entire chain in memory or mixing a body from one relay with another's id.
        const cacheKey = `${store.genesisHash}:block:${String(ref)}`;
        const historical = await cachedHistory(cacheKey, async () => {
          let height = ref;
          if (typeof ref === 'string') {
            const byHash = await rpc.blockByHash(ref).catch(() => null);
            if (!byHash) return null;
            height = byHash.header?.height ?? byHash.height;
          }
          if (!Number.isSafeInteger(height) || height < 0) return null;
          const pair = await blockPair(rpc, height).catch(() => null);
          if (!pair) return null;
          if (typeof ref === 'string' && String(pair.digest.hash).toLowerCase() !== ref) return null;
          return normalizeBlock(pair.block, pair.digest, finalAtDepth(store.tipHeight, height));
        }, metrics);
        if (historical) {
          store.archive?.putBlock(historical);
          return json(200, historical);
        }
        return json(404, { error: 'block not found on the chain' });
      }

      case 'tx': {
        if (!arg) return json(400, { error: 'missing transaction id' });
        const id = arg.toLowerCase();
        if (!HASH_RE.test(id)) return json(400, { error: 'invalid transaction id' });
        let tx = store.tx(id) ?? store.archive?.transaction(id);
        if (!tx) {
          // Not in the indexed window. If the node holds a RECEIPT for this id,
          // the transaction IS on-chain — pull its block and lift the record out,
          // so fresh links (clicked before the indexer caught up) and old ones
          // (evicted from the window) both resolve.
          const r = await rpc.receipt(id).catch(() => null);
          if (r && Number.isFinite(r.height)) {
            const pair = await blockPair(rpc, r.height).catch(() => null);
            if (pair) {
              const rec = normalizeBlock(
                pair.block,
                pair.digest,
                finalAtDepth(store.tipHeight, r.height),
              );
              store.archive?.putBlock(rec);
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
        const receipt = await rpc.receipt(tx.id).catch(() => null) ?? tx.receipt ?? null;
        const confirmations = confirmationCount(store.tipHeight, tx.blockHeight);
        return json(200, { ...tx, receipt, confirmations, final: finalAtDepth(store.tipHeight, tx.blockHeight) });
      }

      case 'inclusion-proof': {
        if (!arg || !HASH_RE.test(arg)) return json(400, { error: 'invalid transaction id' });
        const id = arg.toLowerCase();
        const tx = store.tx(id) ?? store.archive?.transaction(id);
        const receipt = await rpc.receipt(id).catch(() => null);
        const height = tx?.blockHeight ?? receipt?.height;
        if (!Number.isSafeInteger(height) || height < 0) return json(404, { error: 'transaction not found on the chain' });
        const block = store.block(height) ?? store.archive?.block(height);
        const pair = block ? null : await blockPair(rpc, height).catch(() => null);
        const header = block ?? (pair ? normalizeBlock(pair.block, pair.digest, finalAtDepth(store.tipHeight, height)) : null);
        if (!header) return json(502, { error: 'block header unavailable' });
        const [transactionProof, receiptProof] = await Promise.all([
          rpc.transactionProof(id).catch(() => null),
          rpc.receiptProof(id).catch(() => null),
        ]);
        return json(200, {
          transactionId: id,
          blockHeight: height,
          blockHash: header.hash,
          txRoot: header.txRoot,
          receiptsRoot: header.receiptsRoot,
          transactionProof,
          receiptProof,
          supported: { transaction: !!transactionProof, receipt: !!receiptProof },
        });
      }

      case 'capabilities': {
        const key = store.genesisHash ?? 'unknown';
        const cached = capabilityCache.get(key);
        if (cached && cached.expires > Date.now()) return json(200, cached.value);
        const latest = store.latestTransaction();
        let transactionProof = null;
        let receiptProof = null;
        if (latest?.id) {
          [transactionProof, receiptProof] = await Promise.all([
            typeof rpc.transactionProof === 'function' ? rpc.transactionProof(latest.id).catch(() => null) : null,
            typeof rpc.receiptProof === 'function' ? rpc.receiptProof(latest.id).catch(() => null) : null,
          ]);
        }
        const algorithms = [...new Set(
          [transactionProof?.algorithm, receiptProof?.algorithm].filter(Boolean).map((x) => String(x).toLowerCase()),
        )];
        const value = {
          proofs: {
            transaction: !!transactionProof,
            receipt: !!receiptProof,
            algorithms,
            browserVerifiable: !!transactionProof && !!receiptProof
              && algorithms.length > 0 && algorithms.every((algorithm) => algorithm === 'sha256'),
          },
        };
        capabilityCache.set(key, { expires: Date.now() + 5 * 60_000, value });
        return json(200, value);
      }

      case 'account': {
        if (!arg) return json(400, { error: 'missing account' });
        if (!ACCOUNT_RE.test(arg)) return json(400, { error: 'invalid account or name' });
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
        // Reverse indexes are live state: names, native-token holdings, and NFTs.
        const [names, tokenBalances, nfts] = await Promise.all([
          rpc.namesOf(id).catch(() => []),
          typeof rpc.tokenBalances === 'function' ? rpc.tokenBalances(id, 0, 100).catch(() => []) : [],
          typeof rpc.nftsOf === 'function' ? rpc.nftsOf(id, 0, 100).catch(() => []) : [],
        ]);
        const archiveStatus = store.archive?.status(store.nodeHeight) ?? null;
        const limit = clamp(query.get('limit'), 1, maxPageLimit, 50);
        const cursorRaw = query.get('cursor');
        const cursor = decodeCursor(cursorRaw);
        if (cursorRaw && !cursor) return json(400, { error: 'invalid account-history cursor' });
        let transactions;
        let hasMore = false;
        if (store.archive) {
          const page = store.archive.transactionPage({ account: id, limit, cursor });
          transactions = page.records;
          hasMore = page.hasMore;
        } else {
          transactions = store.accountTxs(id, limit).map((tx) => tx);
        }
        return json(200, {
          id,
          resolvedFrom,
          account,
          names,
          tokenBalances,
          nfts,
          transactions: transactions.map(transactionSummary),
          nextCursor: hasMore && transactions.length ? encodeCursor(transactions.at(-1)) : null,
          historyFromHeight: archiveStatus?.contiguousFromHeight
            ?? (Number.isFinite(store.minHeight) ? store.minHeight : null),
          historyComplete: archiveStatus?.complete ?? false,
        });
      }

      // Sovereign Name Service: a page of registered names. Live from the node so
      // it reflects the current registry. Params: ?offset & ?limit.
      case 'names': {
        const offset = clamp(query.get('offset'), 0, 1e9, 0);
        const limit = clamp(query.get('limit'), 1, maxPageLimit, 50);
        return json(200, await rpc.listNames(offset, limit));
      }

      // A single SNS name → its record (owner + registration height), or null.
      case 'name': {
        if (!arg) return json(400, { error: 'missing name' });
        if (!ACCOUNT_RE.test(arg)) return json(400, { error: 'invalid name' });
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

      case 'proof': {
        const stats = store.stats();
        const latestTx = store.latestTransaction();
        const nonEmpty = latestTx ? store.block(latestTx.blockHeight) : null;
        const empty = store.recentBlocks(32).find((block) => block.txCount === 0) ?? null;
        const roots = (block) => block ? {
          height: block.height,
          hash: block.hash,
          txCount: block.txCount,
          txRoot: block.txRoot,
          receiptsRoot: block.receiptsRoot,
          stateRoot: block.stateRoot,
          transactionId: block.transactions?.[0]?.id ?? null,
        } : null;
        return json(200, {
          identity: { chainId: store.chainId, genesisHash: store.genesisHash },
          sync: stats.sync,
          relays: stats.relays,
          consensus: {
            proofOfWork: store.difficulty?.algo ?? null,
            finalityConfirmations: 6,
            difficulty: store.difficulty,
          },
          cryptography: store.cryptographyStats(),
          privacy: { supply: store.supply, shieldedInfo: store.shieldedInfo },
          commitments: { deterministicEmpty: roots(empty), latestNonEmpty: roots(nonEmpty) },
          archive: stats.archive,
        });
      }

      case 'search': {
        const raw = query.get('q') ?? '';
        if (raw.length > 256) return json(400, { error: 'search query is too long' });
        const result = store.search(raw);
        if (result.kind === 'block' && !result.known && store.archive?.block(result.ref)) {
          return json(200, { ...result, known: true });
        }
        // An unknown 0x-hash may be an older block outside our window — ask the node.
        if (result.kind === 'hash') {
          const archived = store.archive?.lookupHash(result.ref);
          if (archived) return json(200, archived);
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
