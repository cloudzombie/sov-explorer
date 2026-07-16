// Drives the Store from a live node: backfills a recent window of history, then
// follows the head, keeping finality, supply, difficulty, and miners fresh. Every
// datum comes from the node over JSON-RPC; the indexer only re-derives, never
// invents. It is resilient to transient RPC errors — a failed tick is retried on
// the next interval.

export function confirmationCount(head, height) {
  return Math.max(0, head - height + 1);
}

export function finalAtDepth(head, height, depth = 6) {
  return height === 0 || confirmationCount(head, height) >= depth;
}

function comparableHash(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/^0x/, '') : null;
}

/** Turn a raw RPC block + digest into the store's normalized record. */
export function normalizeBlock(block, digest, final) {
  const h = block.header;
  const height = h.height;
  const hash = digest.hash;
  const txIds = digest.txIds ?? [];
  const transactions = block.transactions.map((stx, index) => ({
    id: txIds[index] ?? null,
    index,
    signer: stx.transaction.signer,
    publicKey: stx.transaction.public_key,
    nonce: stx.transaction.nonce,
    action: stx.transaction.action,
    signature: stx.signature,
    sizeBytes: Buffer.byteLength(JSON.stringify(stx)),
    blockHeight: height,
    blockHash: hash,
    timestampMs: h.timestamp_ms,
  }));
  return {
    height,
    hash,
    prevHash: h.prev_hash,
    txRoot: h.tx_root,
    receiptsRoot: h.receipts_root,
    stateRoot: h.state_root,
    timestampMs: h.timestamp_ms,
    proposer: h.proposer,
    // The coinbase: this block's real height-keyed subsidy, computed by the node.
    // Current mainnet pays 100% to the proof-of-work miner. Null for genesis.
    coinbase: digest.coinbase ?? null,
    txCount: transactions.length,
    sizeBytes: Buffer.byteLength(JSON.stringify(block)),
    transactions,
    final: !!final,
  };
}

export class Indexer {
  constructor(rpc, store, opts = {}) {
    this.rpc = rpc;
    this.store = store;
    // 640 blocks covers a little over one day at the 2.5-minute target. Full older
    // history remains available on demand through the relays without making every
    // process restart replay thousands of blocks before it can become useful.
    this.backfill = opts.backfill ?? 640;
    this.batchSize = Math.max(1, Math.min(32, opts.batchSize ?? 8));
    this.archiveBatchSize = Math.max(1, Math.min(64, opts.archiveBatchSize ?? 16));
    this.finalityWindow = opts.finalityWindow ?? 64;
    this.finalityDepth = opts.finalityDepth ?? 6;
    this.liveCatchupThreshold = opts.liveCatchupThreshold ?? 3;
    this.statsIntervalMs = opts.statsIntervalMs ?? 10_000;
    this.onBlock = opts.onBlock ?? null;
    this.onTx = opts.onTx ?? null;
    this.onReset = opts.onReset ?? null;
    this._running = false;
    this._timer = null;
    this._lastStatsAt = 0;
    this._archiveRestored = false;
  }

  /** Learn the chain id and genesis hash before the first sync. */
  async init() {
    if (typeof this.rpc.verifyRelays === 'function') await this.rpc.verifyRelays();
    this.store.chainId = await this.rpc.chainId();
    const g = await this.rpc.blockDigest(0);
    if (g) this.store.genesisHash = g.hash;
    if (this.store.archive) {
      const identity = this.store.archive.ensureIdentity(this.store.chainId, this.store.genesisHash);
      if (identity.cleared && this.store.tipHeight >= 0) {
        this.store.reset({ clearArchive: false });
        this.store.chainId = await this.rpc.chainId();
        this.store.genesisHash = g?.hash ?? null;
      }
      if (!this._archiveRestored && this.store.tipHeight < 0) {
        const records = this.store.archive.recentBlocks(this.store.maxBlocks).reverse();
        for (const record of records) this.store.addBlock(record, { persist: false });
      }
      this._archiveRestored = true;
    }
    this.store.setSyncStatus({
      phase: 'bootstrap',
      relays: typeof this.rpc.status === 'function' ? this.rpc.status() : null,
      lastError: null,
    });
  }

  /** Fetch and normalize one block without mutating the store. */
  async fetchBlock(height, head = height) {
    const pair = typeof this.rpc.blockWithDigest === 'function'
      ? await this.rpc.blockWithDigest(height)
      : null;
    const [block, digest] = pair
      ? [pair.block, pair.digest]
      : await Promise.all([this.rpc.blockByHeight(height), this.rpc.blockDigest(height)]);
    if (!block || !digest) return null;
    if (Number(block.header?.height) !== height) {
      throw new Error(`relay returned block height ${block.header?.height} for requested height ${height}`);
    }
    if (!comparableHash(digest.hash) || !Array.isArray(block.transactions)) {
      throw new Error(`relay returned malformed block data at height ${height}`);
    }
    if (!Array.isArray(digest.txIds) || digest.txIds.length !== block.transactions.length) {
      throw new Error(`block/digest transaction count mismatch at height ${height}`);
    }
    // Finality is the documented six-confirmation Nakamoto convention. Deriving it
    // from the already cross-checked head avoids an extra RPC call for every backfill
    // block (thousands of requests on a cold start).
    const final = finalAtDepth(head, height, this.finalityDepth);
    return normalizeBlock(block, digest, final);
  }

  /** Commit one normalized record and optionally announce it as genuinely live. */
  commitRecord(rec, { emit = true } = {}) {
    const height = rec.height;
    const isNew = !this.store.blocksByHeight.has(height);
    this.store.addBlock(rec);
    this.store.setSyncStatus({ lastIndexedAt: Date.now() });
    if (isNew && emit) {
      if (this.onBlock) this.onBlock(rec);
      if (this.onTx) for (const tx of rec.transactions) this.onTx(tx);
    }
    return rec;
  }

  /** Fetch, normalize, and index the block at `height`. Returns the record. */
  async indexBlock(height, opts = {}) {
    const rec = await this.fetchBlock(height, opts.head ?? height);
    return rec ? this.commitRecord(rec, opts) : null;
  }

  /** Fetch a range with bounded parallelism, then commit it in canonical order. */
  async indexRange(from, to, { emit = false } = {}) {
    for (let start = from; start <= to; start += this.batchSize) {
      const end = Math.min(to, start + this.batchSize - 1);
      const records = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) => this.fetchBlock(start + i, to)),
      );
      if (records.some((rec) => !rec)) {
        throw new Error(`relay did not return a complete block range ${start}..${end}`);
      }
      let previous = this.store.blocksByHeight.get(start - 1) ?? null;
      for (const rec of records) {
        if (previous && comparableHash(rec.prevHash) !== comparableHash(previous.hash)) {
          throw new Error(`non-canonical relay range: block ${rec.height} does not extend ${previous.height}`);
        }
        previous = rec;
      }
      for (const rec of records) this.commitRecord(rec, { emit });
    }
  }

  /** Detect that the node is now serving a DIFFERENT chain than what we indexed —
   * i.e. a regenesis (new genesis hash) or a rollback below our tip — so the
   * stored blocks describe a dead chain and must be discarded. */
  async chainWasReset(head) {
    if (this.store.tipHeight < 0) return false; // nothing indexed yet
    // (a) The genesis block hash changed → a brand-new chain.
    if (this.store.genesisHash) {
      const g = await this.rpc.blockDigest(0).catch(() => null);
      if (g?.hash && g.hash !== this.store.genesisHash) return true;
    }
    // (b) The node's head is BELOW our tip → a reset/deep rollback (our tip can't
    // exist on the live chain).
    if (head < this.store.tipHeight) return true;
    // (c) Same height, different hash at our tip → a reorg replaced our history.
    const stored = this.store.blocksByHeight.get(this.store.tipHeight);
    if (stored) {
      const live = await this.rpc.blockDigest(this.store.tipHeight).catch(() => null);
      if (live?.hash && live.hash !== stored.hash) return true;
    }
    return false;
  }

  /** One full pass: index new blocks, refresh finality and chain stats. */
  async syncOnce() {
    if (!this.store.chainId) await this.init(); // recover if the node was down at boot
    const head = await this.rpc.height();
    const relayStatus = typeof this.rpc.status === 'function' ? this.rpc.status() : null;
    this.store.setSyncStatus({ nodeHeight: head, relays: relayStatus, lastError: null });
    // Self-heal across a regenesis/rollback: wipe the dead index and rebuild from
    // the live chain's genesis so we never serve stale blocks.
    if (await this.chainWasReset(head)) {
      this.store.reset();
      this._archiveRestored = false;
      await this.init();
      if (this.onReset) this.onReset();
    }
    const initial = this.store.tipHeight < 0;
    const from = initial ? Math.max(0, head - this.backfill + 1) : this.store.tipHeight + 1;
    const lag = Math.max(0, head - Math.max(-1, this.store.tipHeight));
    const suppressHistoricalEvents = initial || lag > this.liveCatchupThreshold;

    this.store.setSyncStatus({
      syncing: from <= head,
      ready: false,
      phase: from <= head ? (initial ? 'bootstrap' : 'catching-up') : 'verifying',
      startHeight: from,
      targetHeight: head,
    });

    // Populate supply/difficulty immediately so the overview does not show dashes for
    // the entire cold backfill. Thereafter refresh at a bounded cadence.
    if (initial || Date.now() - this._lastStatsAt >= this.statsIntervalMs) {
      await this.refreshChainStats(head);
      this._lastStatsAt = Date.now();
    }
    if (from <= head) await this.indexRange(from, head, { emit: !suppressHistoricalEvents });
    await this.refreshFinality();

    const relays = typeof this.rpc.status === 'function' ? this.rpc.status() : null;
    const degraded = !!relays?.degraded;
    this.store.setSyncStatus({
      nodeHeight: head,
      syncing: false,
      ready: true,
      phase: degraded ? 'degraded' : 'live',
      startHeight: from,
      targetHeight: head,
      relays,
      lastError: null,
    });

    if (this.store.archive) {
      try {
        await this.backfillArchive(head);
        this.store.archiveError = null;
      } catch (error) {
        this.store.archiveError = error?.message ?? String(error);
        if (process?.env?.DEBUG) console.error('[archive]', this.store.archiveError);
      }
    }
  }

  /** Fill one older archive batch without expanding the bounded hot Store. */
  async backfillArchive(head) {
    const archive = this.store.archive;
    if (!archive) return;
    const status = archive.status(head);
    const floor = status.contiguousFromHeight;
    if (status.blocks === 0 || floor === null || floor <= 0) return;
    const to = floor - 1;
    const from = Math.max(0, to - this.archiveBatchSize + 1);
    const records = [];
    for (let start = from; start <= to; start += this.batchSize) {
      const end = Math.min(to, start + this.batchSize - 1);
      records.push(...await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) => this.fetchBlock(start + i, head)),
      ));
    }
    if (records.some((record) => !record)) {
      throw new Error(`relay did not return archive range ${from}..${to}`);
    }
    for (let i = 1; i < records.length; i++) {
      if (comparableHash(records[i].prevHash) !== comparableHash(records[i - 1].hash)) {
        throw new Error(`non-canonical archive range at block ${records[i].height}`);
      }
    }
    const next = archive.block(floor);
    const last = records.at(-1);
    if (next && comparableHash(next.prevHash) !== comparableHash(last.hash)) {
      throw new Error(`archive range ${from}..${to} does not join block ${next.height}`);
    }
    archive.putBlocks(records);
  }

  /** Re-check finality for the most recent not-yet-final blocks. */
  async refreshFinality() {
    const top = this.store.tipHeight;
    const floor = Math.max(this.store.minHeight, top - this.finalityWindow + 1);
    for (let h = top; h >= floor; h--) {
      const b = this.store.blocksByHeight.get(h);
      if (!b || b.final) continue;
      if (finalAtDepth(top, h, this.finalityDepth)) b.final = true;
    }
  }

  async refreshChainStats(height) {
    try {
      const [supply, difficulty, miners, mempool, shieldedInfo] = await Promise.all([
        this.rpc.supply(),
        this.rpc.difficulty(),
        this.rpc.miners(),
        this.rpc.mempoolSize(),
        typeof this.rpc.shieldedInfo === 'function'
          ? this.rpc.shieldedInfo().catch(() => null)
          : Promise.resolve(null),
      ]);
      this.store.recordSupply(supply, height);
      this.store.difficulty = difficulty;
      this.store.miners = miners;
      this.store.mempoolSize = mempool;
      if (shieldedInfo) this.store.shieldedInfo = shieldedInfo;
    } catch {
      // Transient RPC hiccup; the next tick retries.
    }
  }

  start(intervalMs = 1000) {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try {
        await this.syncOnce();
      } catch (e) {
        const divergence = e?.name === 'RelayDivergenceError';
        this.store.setSyncStatus({
          syncing: false,
          ready: false,
          phase: divergence ? 'halted' : 'offline',
          lastError: e?.message ?? String(e),
          relays: typeof this.rpc.status === 'function' ? this.rpc.status() : null,
        });
        if (process?.env?.DEBUG) console.error('[indexer]', e.message);
      }
      if (this._running) this._timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
  }
}
