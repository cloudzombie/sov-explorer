// In-memory, queryable index of Sovereign chain data, built by the Indexer from a live
// node over JSON-RPC. The node is the source of truth; this store is a derived,
// fully re-buildable view — nothing in it is fabricated. It keeps the most recent
// `maxBlocks` blocks (a ring), bounding memory on a long-lived chain.

const GRAINS_PER_XUS = 100_000_000n; // 8 decimals
const SUPPLY_CAP_GRAINS = 21_000_000n * GRAINS_PER_XUS;

/** The account a transaction touches besides its signer, if any. */
export function txCounterparty(action) {
  if (!action || typeof action !== 'object') return null;
  switch (action.type) {
    case 'transfer':
      return action.to ?? null;
    case 'call':
      return action.contract ?? null;
    default:
      return null;
  }
}

function encodedHexBytes(value, prefix = '') {
  let text = String(value ?? '');
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  if (text.startsWith('0x')) text = text.slice(2);
  return /^[0-9a-f]*$/i.test(text) && text.length % 2 === 0 ? text.length / 2 : 0;
}

export function transactionCrypto(tx) {
  const key = String(tx?.publicKey ?? '');
  const signature = String(tx?.signature ?? '');
  const keyBytes = encodedHexBytes(key, key.startsWith('hybrid65:') ? 'hybrid65:' : '');
  const signatureBytes = encodedHexBytes(
    signature,
    signature.startsWith('hybrid65:') ? 'hybrid65:' : '',
  );
  const scheme = key.startsWith('hybrid65:') && signature.startsWith('hybrid65:')
    ? 'hybrid65'
    : keyBytes === 32 && signatureBytes === 64
      ? 'ed25519'
      : 'other';
  return { scheme, keyBytes, signatureBytes };
}

export class Store {
  constructor({ maxBlocks = 10_000, maxBytes = 256 * 1024 * 1024 } = {}) {
    this.maxBlocks = Math.max(1, maxBlocks);
    this.maxBytes = Math.max(1, maxBytes);
    this._statsVersion = 0;
    this._statsCache = null;
    this.chainId = null;
    this.genesisHash = null;
    this.nodeHeight = -1;
    this.syncing = true;
    this.ready = false;
    this.syncPhase = 'connecting';
    this.syncStartHeight = null;
    this.syncTargetHeight = null;
    this.lastIndexedAt = null;
    this.lastError = null;
    this.relayStatus = null;
    this.tipHeight = -1;
    this.minHeight = Infinity;
    this.blocksByHeight = new Map(); // height -> block record
    this.heightByHash = new Map(); // block hash -> height
    this.txById = new Map(); // tx id -> tx record
    // account -> { ids: tx id[] in insertion order, start: first live position }.
    // The moving start offset lets eviction stay O(1)-amortized instead of leaving
    // every historical transaction id in memory forever.
    this.txIdsByAccount = new Map();
    this.proposers = new Map(); // header proposer/miner account -> { blocks, lastHeight }
    this.miners = [];
    this.supply = null; // { total, mined } (decimal-grain strings)
    this.difficulty = null; // { sha256d, algo, hashrate, targetBlockMs } from sov_getDifficulty
    this.mempoolSize = 0;
    this.shieldedInfo = null;
    this.supplySeries = []; // [{ height, total, mined, timestampMs }]
    this.totalTxIndexed = 0;
    this.totalBlockBytesIndexed = 0;
    this.latestTxId = null;
    this.crypto = { hybrid65: 0, ed25519: 0, other: 0, keyBytes: 0, signatureBytes: 0 };
  }

  _touchStats() {
    this._statsVersion += 1;
    this._statsCache = null;
  }

  /** Drop all indexed chain data so the index can be rebuilt from genesis. Used
   * when the node's chain is replaced (a regenesis) or rolls back below our tip —
   * the old blocks describe a dead chain and must not be served. `chainId` and
   * `genesisHash` are refreshed by the indexer's `init()` right after. */
  reset() {
    this.tipHeight = -1;
    this.minHeight = Infinity;
    this.blocksByHeight.clear();
    this.heightByHash.clear();
    this.txById.clear();
    this.txIdsByAccount.clear();
    this.proposers.clear();
    this.miners = [];
    this.supply = null;
    this.difficulty = null;
    this.mempoolSize = 0;
    this.shieldedInfo = null;
    this.supplySeries = [];
    this.totalTxIndexed = 0;
    this.totalBlockBytesIndexed = 0;
    this.latestTxId = null;
    this.crypto = { hybrid65: 0, ed25519: 0, other: 0, keyBytes: 0, signatureBytes: 0 };
    this.ready = false;
    this.syncing = true;
    this.syncPhase = 'rebuilding';
    this.syncStartHeight = null;
    this.syncTargetHeight = null;
    this.lastIndexedAt = null;
    this._touchStats();
  }

  /** Publish indexer/relay status as part of the same API snapshot as chain data. */
  setSyncStatus(update = {}) {
    if (update.nodeHeight !== undefined) this.nodeHeight = update.nodeHeight;
    if (update.syncing !== undefined) this.syncing = !!update.syncing;
    if (update.ready !== undefined) this.ready = !!update.ready;
    if (update.phase !== undefined) this.syncPhase = update.phase;
    if (update.startHeight !== undefined) this.syncStartHeight = update.startHeight;
    if (update.targetHeight !== undefined) this.syncTargetHeight = update.targetHeight;
    if (update.lastIndexedAt !== undefined) this.lastIndexedAt = update.lastIndexedAt;
    if (update.lastError !== undefined) this.lastError = update.lastError;
    if (update.relays !== undefined) this.relayStatus = update.relays;
    this._touchStats();
  }

  /** Insert (or replace, e.g. on a finality refresh) a normalized block record. */
  addBlock(rec) {
    const existing = this.blocksByHeight.has(rec.height);
    this.blocksByHeight.set(rec.height, rec);
    this.heightByHash.set(rec.hash, rec.height);
    if (rec.height > this.tipHeight) this.tipHeight = rec.height;
    if (rec.height < this.minHeight) this.minHeight = rec.height;
    this._touchStats();
    if (existing) return; // re-index: per-tx / miner indices already populated
    this.totalBlockBytesIndexed += rec.sizeBytes ?? 0;

    const p = this.proposers.get(rec.proposer) ?? { blocks: 0, lastHeight: -1 };
    p.blocks += 1;
    p.lastHeight = Math.max(p.lastHeight, rec.height);
    this.proposers.set(rec.proposer, p);

    for (const tx of rec.transactions) {
      this.txById.set(tx.id, tx);
      this.latestTxId = tx.id;
      this.totalTxIndexed += 1;
      const crypto = transactionCrypto(tx);
      this.crypto[crypto.scheme] += 1;
      this.crypto.keyBytes += crypto.keyBytes;
      this.crypto.signatureBytes += crypto.signatureBytes;
      this._tagAccount(tx.signer, tx.id);
      const cp = txCounterparty(tx.action);
      if (cp && cp !== tx.signer) this._tagAccount(cp, tx.id);
    }
    this._evict();
  }

  _tagAccount(account, txId) {
    if (!account || !txId) return;
    let entry = this.txIdsByAccount.get(account);
    if (!entry) {
      entry = { ids: [], start: 0 };
      this.txIdsByAccount.set(account, entry);
    }
    entry.ids.push(txId);
  }

  _cleanAccountIndex(account) {
    const entry = this.txIdsByAccount.get(account);
    if (!entry) return;
    while (entry.start < entry.ids.length && !this.txById.has(entry.ids[entry.start])) {
      entry.start += 1;
    }
    if (entry.start >= entry.ids.length) {
      this.txIdsByAccount.delete(account);
      return;
    }
    // Periodically compact the dead prefix so long-running/high-traffic accounts stay
    // bounded without paying an Array.shift() cost for every evicted transaction.
    if (entry.start >= 1024 && entry.start * 2 >= entry.ids.length) {
      entry.ids = entry.ids.slice(entry.start);
      entry.start = 0;
    }
  }

  _evict() {
    while (
      this.blocksByHeight.size > this.maxBlocks ||
      (this.totalBlockBytesIndexed > this.maxBytes && this.blocksByHeight.size > 1)
    ) {
      const rec = this.blocksByHeight.get(this.minHeight);
      this.blocksByHeight.delete(this.minHeight);
      if (rec) {
        this.heightByHash.delete(rec.hash);
        const touched = new Set();
        for (const tx of rec.transactions) {
          this.txById.delete(tx.id);
          if (this.latestTxId === tx.id) this.latestTxId = null;
          const crypto = transactionCrypto(tx);
          this.crypto[crypto.scheme] = Math.max(0, this.crypto[crypto.scheme] - 1);
          this.crypto.keyBytes = Math.max(0, this.crypto.keyBytes - crypto.keyBytes);
          this.crypto.signatureBytes = Math.max(0, this.crypto.signatureBytes - crypto.signatureBytes);
          touched.add(tx.signer);
          const cp = txCounterparty(tx.action);
          if (cp) touched.add(cp);
        }
        for (const account of touched) this._cleanAccountIndex(account);
        const proposer = this.proposers.get(rec.proposer);
        if (proposer) {
          proposer.blocks -= 1;
          if (proposer.blocks <= 0) this.proposers.delete(rec.proposer);
        }
        this.totalBlockBytesIndexed = Math.max(
          0,
          this.totalBlockBytesIndexed - (rec.sizeBytes ?? 0),
        );
      }
      this.minHeight += 1;
    }
  }

  block(idOrHeight) {
    if (typeof idOrHeight === 'number') return this.blocksByHeight.get(idOrHeight) ?? null;
    const h = this.heightByHash.get(idOrHeight);
    return h === undefined ? null : this.blocksByHeight.get(h);
  }

  tx(id) {
    return this.txById.get(id) ?? null;
  }

  latestTransaction() {
    return this.latestTxId ? this.txById.get(this.latestTxId) ?? null : null;
  }

  cryptographyStats() {
    const retained = this.txById.size;
    return {
      retainedTransactions: retained,
      hybrid65: this.crypto.hybrid65,
      ed25519: this.crypto.ed25519,
      other: this.crypto.other,
      hybridCoverage: retained > 0 ? this.crypto.hybrid65 / retained : null,
      publicKeyBytesRetained: this.crypto.keyBytes,
      signatureBytesRetained: this.crypto.signatureBytes,
      hybrid65Layout: {
        publicKeyBytes: 1984,
        ed25519PublicKeyBytes: 32,
        mlDsa65PublicKeyBytes: 1952,
        signatureBytes: 3373,
        ed25519SignatureBytes: 64,
        mlDsa65SignatureBytes: 3309,
        verification: 'both-required',
      },
    };
  }

  recentBlocks(limit = 20) {
    return this.blocksBefore(null, limit);
  }

  /**
   * A page of blocks at height ≤ `before` (or the tip when `before` is null),
   * newest-first, up to `limit`. The paged Blocks page uses this to walk backward
   * toward genesis: each page's lowest height − 1 is the next page's `before`.
   */
  blocksBefore(before, limit = 50) {
    const out = [];
    const start =
      before === null || before === undefined || !Number.isFinite(before)
        ? this.tipHeight
        : Math.min(before, this.tipHeight);
    for (let h = start; h >= this.minHeight && out.length < limit; h--) {
      const b = this.blocksByHeight.get(h);
      if (b) out.push(b);
    }
    return out;
  }

  /** The oldest block height currently retained in the index (0 once genesis is in). */
  oldestHeight() {
    return this.minHeight;
  }

  recentTxs(limit = 20) {
    const out = [];
    for (let h = this.tipHeight; h >= this.minHeight && out.length < limit; h--) {
      const b = this.blocksByHeight.get(h);
      if (!b) continue;
      for (let i = b.transactions.length - 1; i >= 0 && out.length < limit; i--) {
        out.push(b.transactions[i]);
      }
    }
    return out;
  }

  accountTxs(account, limit = 50) {
    const entry = this.txIdsByAccount.get(account);
    if (!entry) return [];
    const out = [];
    const safeLimit = Number.isFinite(Number(limit))
      ? Math.max(0, Math.min(200, Math.trunc(Number(limit))))
      : 50;
    for (let i = entry.ids.length - 1; i >= entry.start && out.length < safeLimit; i--) {
      const tx = this.txById.get(entry.ids[i]);
      if (tx) out.push(tx);
    }
    return out;
  }

  /** Observed miner activity: who actually produced the blocks we indexed. */
  observedMiners() {
    return [...this.proposers.entries()]
      .map(([account, s]) => ({ account, blocksMined: s.blocks, blocksProposed: s.blocks, lastHeight: s.lastHeight }))
      .sort((a, b) => b.blocksMined - a.blocksMined);
  }

  /** Backward-compatible name for older clients. */
  validators() {
    return this.observedMiners();
  }

  recordSupply(supply, height) {
    this.supply = supply;
    this._touchStats();
    const last = this.supplySeries[this.supplySeries.length - 1];
    if (!last || last.height !== height) {
      this.supplySeries.push({
        height,
        total: supply.total,
        mined: supply.mined,
        timestampMs: Date.now(),
      });
      if (this.supplySeries.length > 5000) this.supplySeries.shift();
    }
  }

  transparentVolumeGrains(action) {
    if (!action || typeof action !== 'object') return 0n;
    try {
      switch (action.type) {
        case 'transfer':
        case 'htlc_lock':
          return BigInt(action.amount ?? 0);
        default:
          return 0n;
      }
    } catch {
      return 0n;
    }
  }

  windowStats(windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    let blocks = 0;
    let transactions = 0;
    let volume = 0n;
    let txBytes = 0;

    for (const block of this.blocksByHeight.values()) {
      if ((block.timestampMs ?? 0) < cutoff) continue;
      blocks += 1;
      for (const tx of block.transactions ?? []) {
        transactions += 1;
        txBytes += tx.sizeBytes ?? 0;
        volume += this.transparentVolumeGrains(tx.action);
      }
    }

    const oldest = Number.isFinite(this.minHeight) ? this.blocksByHeight.get(this.minHeight) : null;
    const windowComplete = !!oldest && (this.minHeight === 0 || (oldest.timestampMs ?? now) <= cutoff);
    return {
      transactions,
      transactionsPerSecond: transactions / Math.max(1, windowMs / 1000),
      blocks,
      volumeGrains: volume.toString(),
      medianTransactionFeeUsd: null,
      averageTransactionFeeUsd: null,
      hashrate: this.difficulty?.hashrate ?? null,
      indexedTransactionBytes: txBytes,
      windowComplete,
    };
  }

  /** Classify a free-text query into a block / tx / account / raw-hash lookup. */
  search(query) {
    const s = String(query ?? '').trim();
    if (!s) return { kind: 'empty' };
    if (/^\d+$/.test(s)) {
      const h = Number(s);
      if (!Number.isSafeInteger(h)) return { kind: 'invalid', ref: s, known: false };
      return { kind: 'block', ref: h, known: this.blocksByHeight.has(h) };
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
      const lower = s.toLowerCase();
      if (this.heightByHash.has(lower)) return { kind: 'block', ref: this.heightByHash.get(lower), known: true };
      if (this.txById.has(lower)) return { kind: 'tx', ref: lower, known: true };
      return { kind: 'hash', ref: lower, known: false };
    }
    return { kind: 'account', ref: s, known: this.txIdsByAccount.has(s) };
  }

  /** Aggregate chain statistics, all derived from real indexed/observed data. */
  stats() {
    const now = Date.now();
    if (
      this._statsCache
      && this._statsCache.version === this._statsVersion
      && now - this._statsCache.at < 1_000
    ) {
      return this._statsCache.value;
    }
    const grains = (v) => {
      try {
        return BigInt(v ?? 0);
      } catch {
        return 0n;
      }
    };
    const mined = grains(this.supply?.mined);
    const ratio = (a, b) => (b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : 0);
    const last24h = this.windowStats(24 * 60 * 60 * 1000);
    const behindBlocks = this.nodeHeight >= 0
      ? Math.max(0, this.nodeHeight - Math.max(-1, this.tipHeight))
      : null;
    const span = this.syncStartHeight !== null && this.syncTargetHeight !== null
      ? Math.max(1, this.syncTargetHeight - this.syncStartHeight + 1)
      : null;
    const completed = span === null || this.tipHeight < 0 || this.syncStartHeight === null
      ? 0
      : Math.max(0, Math.min(span, this.tipHeight - this.syncStartHeight + 1));
    const progress = this.ready ? 1 : span ? completed / span : 0;
    const value = {
      chainId: this.chainId,
      genesisHash: this.genesisHash,
      tipHeight: this.tipHeight,
      blocksIndexed: this.blocksByHeight.size,
      transactionsIndexed: this.totalTxIndexed,
      transactionsRetained: this.txById.size,
      indexedFromHeight: Number.isFinite(this.minHeight) ? this.minHeight : null,
      minersObserved: this.proposers.size,
      miners: this.miners.length,
      mempoolSize: this.mempoolSize,
      supply: this.supply,
      difficulty: this.difficulty,
      allTime: {
        circulationGrains: this.supply?.total ?? null,
        marketCapUsd: null,
        marketDominance: null,
        blockchainSizeBytes: this.totalBlockBytesIndexed,
        networkNodes: this.miners.length || null,
        difficulty: this.difficulty?.sha256d ?? null,
        // The PoW seal actually in force (RandomX on mainnet, SHA-256d on dev/test) —
        // reported by the node's sov_getDifficulty `algo`, not assumed.
        difficultyAlgo: this.difficulty?.algo ?? null,
      },
      last24h,
      mempool: {
        transactions: this.mempoolSize,
        transactionsPerSecond: null,
        outputs: null,
        feeTotalUsd: null,
        sizeBytes: null,
      },
      mintedOfCap: ratio(mined, SUPPLY_CAP_GRAINS),
      supplyCapGrains: SUPPLY_CAP_GRAINS.toString(),
      sync: {
        phase: this.syncPhase,
        ready: this.ready,
        syncing: this.syncing,
        indexedHeight: this.tipHeight,
        nodeHeight: this.nodeHeight,
        behindBlocks,
        progress,
        lastIndexedAt: this.lastIndexedAt,
        error: this.lastError,
      },
      relays: this.relayStatus,
    };
    this._statsCache = { at: now, version: this._statsVersion, value };
    return value;
  }
}
