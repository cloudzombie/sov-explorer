// Drives the Store from a live node: backfills a recent window of history, then
// follows the head, keeping finality, supply, difficulty, and miners fresh. Every
// datum comes from the node over JSON-RPC; the indexer only re-derives, never
// invents. It is resilient to transient RPC errors — a failed tick is retried on
// the next interval.

import { indexBlockTiming, isMethodNotFound, normalizeMempoolTx, pairTiming } from './timing.js';

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
    // Raw header consensus fields: the BIP-9 signal word, the PoW compact target,
    // and the seal nonce — retained so signaling/difficulty are shown from real
    // headers, never re-derived. Null when a (pre-upgrade) node omits them.
    versionBits: h.version_bits ?? null,
    bits: h.bits ?? null,
    nonce: h.nonce ?? null,
    // The coinbase: this block's real height-keyed subsidy, computed by the node.
    // Current mainnet pays 100% to the proof-of-work miner. Null for genesis.
    coinbase: digest.coinbase ?? null,
    txCount: transactions.length,
    sizeBytes: Buffer.byteLength(JSON.stringify(block)),
    transactions,
    final: !!final,
  };
}

/**
 * Reduce sov_getPeerInfo to what a public explorer may republish: counts and
 * software-version distribution of the RELAY's own peers. Peer IP addresses are
 * deliberately dropped — home miners' addresses are not the explorer's to publish.
 * This is connectivity of one relay, NOT a census of network machines.
 */
export function summarizePeerInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const agents = {};
  for (const peer of Array.isArray(info.peerVersions) ? info.peerVersions : []) {
    const agent = typeof peer?.agent === 'string' && peer.agent ? peer.agent : 'unknown';
    agents[agent] = (agents[agent] ?? 0) + 1;
  }
  return {
    peers: Number.isFinite(Number(info.peers)) ? Number(info.peers) : null,
    relayVersion: typeof info.version === 'string' ? info.version : null,
    protocolVersion: Number.isFinite(Number(info.protocolVersion)) ? Number(info.protocolVersion) : null,
    agents,
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
    // Mempool polling: pages of at most 256 (the node's hard cap), bounded so a
    // large mempool can never turn one tick into an unbounded request loop.
    this.mempoolPageLimit = Math.max(1, Math.min(256, opts.mempoolPageLimit ?? 256));
    this.mempoolMaxPages = Math.max(1, Math.min(64, opts.mempoolMaxPages ?? 8));
    // Node timing is only requested for blocks near the head: a node's mempool
    // observations do not reach back into deep history, so asking during a cold
    // backfill would spend one request per block to be told "not observed".
    this.timingLookbackBlocks = Math.max(0, opts.timingLookbackBlocks ?? 128);
    // How long an RPC the node answered with method-not-found stays written off
    // before it is probed again (a relay can be upgraded under a running explorer).
    this.timingProbeIntervalMs = opts.timingProbeIntervalMs ?? 10 * 60_000;
    this.observationRetentionMs = opts.observationRetentionMs ?? 7 * 24 * 60 * 60_000;
    this._unsupportedUntil = new Map(); // rpc key -> timestamp to re-probe at
    this._lastObservationPruneAt = 0;
    this._running = false;
    this._timer = null;
    this._lastStatsAt = 0;
    this._archiveRestored = false;
  }

  /** False while an RPC the node rejected as unknown is still written off. */
  _supports(key) {
    const retryAt = this._unsupportedUntil.get(key);
    return retryAt === undefined || Date.now() >= retryAt;
  }

  _markUnsupported(key) {
    this._unsupportedUntil.set(key, Date.now() + this.timingProbeIntervalMs);
    this.store.timingSupport[key] = false;
  }

  _markSupported(key) {
    this._unsupportedUntil.delete(key);
    this.store.timingSupport[key] = true;
  }

  /**
   * Poll the node's mempool and record a first-seen observation for every
   * transaction id seen for the FIRST time. This also captures transactions the node
   * later prunes without mining, and it is what makes a wait measurable at all —
   * a block says when a transaction was included, never when it appeared.
   *
   * Paged with `offset`/`hasMore` up to `mempoolMaxPages`. A node without
   * `sov_getMempoolTxs` answers method-not-found exactly once: the method is then
   * written off until the next probe window and the snapshot says so plainly.
   */
  async pollMempool(head) {
    if (typeof this.rpc.mempoolTxs !== 'function') return null;
    if (!this._supports('mempool')) return null;
    const txs = [];
    let offset = 0;
    let truncated = false;
    let txCount = null;
    let queuedCount = null;
    for (let page = 0; page < this.mempoolMaxPages; page++) {
      let response;
      try {
        response = await this.rpc.mempoolTxs(offset, this.mempoolPageLimit);
      } catch (error) {
        if (isMethodNotFound(error)) {
          this._markUnsupported('mempool');
          this.store.setMempoolSnapshot({
            available: false,
            reason: 'this node does not serve sov_getMempoolTxs',
            txs: [],
            txCount: null,
            queuedCount: null,
            truncated: false,
            updatedAt: Date.now(),
          });
          return null;
        }
        return null; // transient relay error: the next tick retries
      }
      this._markSupported('mempool');
      const entries = Array.isArray(response?.txs) ? response.txs : [];
      const observedAt = Date.now();
      for (const entry of entries) {
        const tx = normalizeMempoolTx(entry, observedAt, head);
        if (!tx) continue;
        // The chain height recorded alongside first-seen is the head at the moment
        // THIS explorer first saw the transaction, so `waitedBlocks` is a difference
        // of two real heights rather than an estimate from the block interval.
        const observation = this.store.recordFirstSeen(tx.txId, tx.firstSeenMs, head);
        txs.push({
          ...tx,
          firstSeenMs: observation?.firstSeenMs ?? tx.firstSeenMs,
          firstSeenHeight: observation?.firstSeenHeight ?? null,
        });
      }
      txCount = Number.isFinite(Number(response?.txCount)) ? Number(response.txCount) : txCount;
      queuedCount = Number.isFinite(Number(response?.queuedCount))
        ? Number(response.queuedCount)
        : queuedCount;
      if (!response?.hasMore || entries.length === 0) break;
      offset += entries.length;
      if (page === this.mempoolMaxPages - 1) truncated = true;
    }
    const snapshot = {
      available: true,
      reason: null,
      txs,
      txCount,
      queuedCount,
      truncated,
      updatedAt: Date.now(),
    };
    this.store.setMempoolSnapshot(snapshot);
    if (Date.now() - this._lastObservationPruneAt >= this.timingProbeIntervalMs) {
      this._lastObservationPruneAt = Date.now();
      this.store.archive?.pruneObservations?.(Date.now() - this.observationRetentionMs);
    }
    return snapshot;
  }

  /** The node's own timing for one block, indexed by transaction id, or null when
   * the node cannot answer (older node, out of lookback, or a transient error). */
  async blockTiming(height, head) {
    if (typeof this.rpc.blockTxTiming !== 'function') return null;
    if (!this._supports('timing')) return null;
    if (Number.isFinite(head) && head - height > this.timingLookbackBlocks) return null;
    try {
      const response = await this.rpc.blockTxTiming(height);
      this._markSupported('timing');
      return indexBlockTiming(response);
    } catch (error) {
      if (isMethodNotFound(error)) this._markUnsupported('timing');
      return null;
    }
  }

  /**
   * Attach first-seen / wait timing to every transaction in a block.
   *
   * The node's own observation wins when it has one; otherwise the explorer's own
   * recorded observation is used; when NEITHER saw the transaction the timing is
   * present but every field is null with `observed: false`. Nothing is estimated,
   * and transactions mined before this explorer started observing stay unobserved
   * forever — that is the honest answer, not a defect.
   */
  async attachTiming(record, head = record.height) {
    if (!record.transactions?.length) return;
    const nodeTiming = await this.blockTiming(record.height, head);
    for (const tx of record.transactions) {
      const id = String(tx.id ?? '').toLowerCase();
      tx.timing = pairTiming({
        nodeTiming: nodeTiming?.get(id) ?? null,
        observation: this.store.firstSeen(id),
        includedHeight: record.height,
        includedTimestampMs: tx.timestampMs ?? record.timestampMs,
      });
    }
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
    const record = normalizeBlock(block, digest, final);
    await this.attachReceipts(record);
    await this.attachTiming(record, head);
    return record;
  }

  /**
   * Attach execution receipts to a block's transactions.
   *
   * Prefers `sov_getBlockReceipts` — ONE request for the whole block — and only falls
   * back to per-transaction `sov_getReceipt` when the node does not serve the batch
   * form. On a 640-block cold backfill of this chain that is the difference between
   * roughly one request per transaction (thousands) and one per block, against a
   * production node the explorer does not own.
   *
   * Receipts are matched by transaction id, never by array position: a node that
   * returns them in another order (or omits one) must not mislabel a transaction's
   * execution status. Anything unmatched simply stays without a status.
   */
  async attachReceipts(record) {
    if (!record.transactions.length) return;
    if (typeof this.rpc.blockReceipts === 'function') {
      const receipts = await this.rpc.blockReceipts(record.height).catch(() => null);
      if (Array.isArray(receipts)) {
        const byId = new Map();
        for (const receipt of receipts) {
          const id = receipt?.tx_id ?? receipt?.txId ?? null;
          if (id) byId.set(comparableHash(id), receipt);
        }
        let matched = 0;
        for (const tx of record.transactions) {
          const receipt = byId.get(comparableHash(tx.id));
          if (!receipt) continue;
          matched += 1;
          tx.receipt = receipt;
          tx.executionStatus = receipt.status?.status ?? receipt.status ?? null;
        }
        // A complete batch is authoritative; a partial one falls through so the
        // remaining transactions still get their real status.
        if (matched === record.transactions.length) return;
      }
    }
    if (typeof this.rpc.receipt !== 'function') return;
    await Promise.all(record.transactions.map(async (tx) => {
      if (tx.receipt) return;
      const receipt = await this.rpc.receipt(tx.id).catch(() => null);
      if (!receipt) return;
      tx.receipt = receipt;
      tx.executionStatus = receipt.status?.status ?? receipt.status ?? null;
    }));
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
    // Observe the mempool BEFORE indexing this tick's blocks, so a transaction that
    // is about to be mined still gets a first-seen record. Reuses this same polling
    // loop — there is no second scheduler — and is a no-op on a node without the RPC.
    await this.pollMempool(head);
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
    await this.backfillExecutionStatuses();
  }

  async backfillExecutionStatuses() {
    const archive = this.store.archive;
    if (!archive?.missingExecutionStatus || typeof this.rpc.receipt !== 'function') return;
    const ids = archive.missingExecutionStatus(16);
    await Promise.all(ids.map(async (id) => {
      const receipt = await this.rpc.receipt(id).catch(() => null);
      if (receipt) archive.updateTransactionReceipt(id, receipt);
    }));
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
    // Optional RPCs (absent on older nodes) fail soft to null and keep the last
    // good value on a transient error — an unavailable datum renders as
    // unavailable, never as a fabricated zero.
    const optional = (name, ...args) => (typeof this.rpc[name] === 'function'
      ? this.rpc[name](...args).catch(() => null)
      : Promise.resolve(null));
    try {
      // Request budget: this whole batch runs at most once per `statsIntervalMs`
      // (10 s by default), i.e. ≈1.2 requests/second amortized against ONE relay —
      // the chain-stat cost of the explorer is fixed and does not grow with traffic,
      // because every browser is served from this one cached snapshot.
      const [
        supply, difficulty, miners, mempool, shieldedInfo, shieldedV2Info, deployments,
        feeTransfer, feeToken, feeShielded, peerInfo, mintReward, signingDomain,
      ] = await Promise.all([
        this.rpc.supply(),
        this.rpc.difficulty(),
        this.rpc.miners(),
        this.rpc.mempoolSize(),
        optional('shieldedInfo'),
        optional('shieldedV2Info'),
        optional('deployments'),
        optional('estimateFee', 'transfer'),
        optional('estimateFee', 'tokenTransfer'),
        optional('estimateFee', 'shielded'),
        optional('peerInfo'),
        optional('mintReward'),
        optional('signingDomain'),
      ]);
      this.store.recordSupply(supply, height);
      this.store.difficulty = difficulty;
      this.store.miners = miners;
      this.store.mempoolSize = mempool;
      if (shieldedInfo) this.store.shieldedInfo = shieldedInfo;
      if (shieldedV2Info) this.store.shieldedV2Info = shieldedV2Info;
      if (deployments) this.store.deployments = deployments;
      if (feeTransfer) this.store.feeEstimate = feeTransfer;
      // Only routes the node actually priced appear; a route it refused is absent
      // rather than present-and-zero.
      const routes = {};
      for (const estimate of [feeTransfer, feeToken, feeShielded]) {
        if (estimate && typeof estimate.kind === 'string') routes[estimate.kind] = estimate;
      }
      if (Object.keys(routes).length) this.store.feeRoutes = routes;
      if (peerInfo) this.store.peerSummary = summarizePeerInfo(peerInfo);
      if (mintReward !== null && mintReward !== undefined) this.store.mintReward = String(mintReward);
      if (signingDomain) this.store.signingDomain = signingDomain;
      // These fields are assigned directly rather than through addBlock/recordSupply,
      // so the memoized stats snapshot must be invalidated explicitly — otherwise a
      // refresh that changes only chain stats (difficulty, fees, deployments, peers)
      // could be served from a stale cached snapshot.
      this.store._touchStats();
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
