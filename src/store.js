// In-memory, queryable index of Sovereign chain data, built by the Indexer from a live
// node over JSON-RPC. The node is the source of truth; this store is a derived,
// fully re-buildable view — nothing in it is fabricated. It keeps the most recent
// `maxBlocks` blocks (a ring), bounding memory on a long-lived chain.

const GRAINS_PER_XUS = 100_000_000n; // 8 decimals
const SUPPLY_CAP_GRAINS = 21_000_000n * GRAINS_PER_XUS;

// The recent-miner window: a miner ACCOUNT in the node registry (sov_getMiners)
// counts as "seen recently" if it won a block within this many blocks of the tip.
//
// 576 blocks ≈ 24 hours at the 150 s target — long enough that low-hashrate
// participants still register: an account holding just 2% of network hashrate
// misses a 576-block window with probability 0.98^576 ≈ 9×10⁻⁶, and one holding
// 4% with ≈ 8×10⁻¹¹. A short window (e.g. 20–30 blocks) systematically
// undercounts small miners — with five accounts of unequal hashrate, the last
// 20 blocks routinely contain only three or four of them. The count is only
// meaningful WITH its window, so the API reports both together.
//
// NOTE: this counts coinbase ACCOUNTS, not machines. Several physical machines
// can (and on this network do) pay the same coinbase account, so a machine
// count is not derivable from chain data and is never claimed.
export const MINER_WINDOW_BLOCKS = 576;

/** Unwrap a fee-auction `tipped` envelope (v0.1.98) to the action it executes.
 * Consensus forbids nested tips, but decoding stays bounded regardless. */
export function unwrapTipped(action) {
  let inner = action;
  for (let i = 0; i < 4 && inner && typeof inner === 'object' && inner.type === 'tipped'; i++) {
    inner = inner.inner ?? null;
  }
  return inner;
}

/** The XUS grains a `tipped` envelope bids to the block's miner (0n when untipped). */
export function tipGrains(action) {
  if (!action || typeof action !== 'object' || action.type !== 'tipped') return 0n;
  try {
    return BigInt(action.tip ?? 0);
  } catch {
    return 0n;
  }
}

// ---- shielded-pool boundary flows ------------------------------------------
// The transparent↔shielded value movement of a shielded action is public
// consensus data carried INSIDE the serialized bundle:
//
// - Pool v1 (`Action::Shielded`, Orchard/Halo2): the canonical codec is
//   `flags:1 | value_balance:i64le:8 | anchor:32 | …` (chain crate
//   `sov-shielded/src/codec.rs`). Consensus applies `value_balance` to the
//   transparent side: vb < 0 shields |vb| grains INTO the pool, vb > 0
//   de-shields vb grains OUT, vb == 0 is a fully private transfer (no
//   boundary flow).
// - Pool v2 (`Action::ShieldedV2`, ML-KEM-768/STARK): the v1 wire format is
//   `version:1 | 4×anchor:32 | 4×nullifier:32 | 4×input_dummy:1 |
//   4×output_commitment:32 | 4×output_dummy:1 | transparent_in:u64le |
//   transparent_out:u64le | fee:u64le | …` (chain crate
//   `sov-shielded-pq/src/wire.rs`). `transparent_in` is the shield leg,
//   `transparent_out` the de-shield leg; both are public STARK inputs.
//
// Nothing here is inferred or estimated: these are the exact bytes consensus
// itself decodes to move transparent balance. An unparseable bundle yields
// null (unknown), never a guessed amount.

const V2_PROOF_VERSION = 1;
const V2_SLOTS = 4;
// version + slots·(anchor + nullifier + commitment) + 2·slots dummy flags.
const V2_LEGS_OFFSET = 1 + V2_SLOTS * (32 + 32 + 32) + V2_SLOTS * 2;
const V2_MIN_LEN = V2_LEGS_OFFSET + 24; // through transparent_in/out + fee

/** The leading bytes of a bundle field as a byte array, or null. The node's
 * JSON-RPC serializes `Vec<u8>` as an array of numbers; a hex string is also
 * accepted defensively. Only `need` bytes are materialized. */
function bundlePrefix(bundle, need) {
  if (Array.isArray(bundle)) {
    if (bundle.length < need) return null;
    const out = new Uint8Array(need);
    for (let i = 0; i < need; i++) {
      const b = Number(bundle[i]);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      out[i] = b;
    }
    return out;
  }
  if (typeof bundle === 'string') {
    const hex = bundle.startsWith('0x') ? bundle.slice(2) : bundle;
    if (hex.length < need * 2 || !/^[0-9a-fA-F]*$/.test(hex.slice(0, need * 2))) return null;
    const out = new Uint8Array(need);
    for (let i = 0; i < need; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return null;
}

function u64le(bytes, at) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

/**
 * The transparent-boundary flow a shielded action's bundle declares, or null
 * when the action is not a shielded action / its bundle cannot be parsed.
 * Returns `{ pool: 1|2, shieldGrains, unshieldGrains }` with BigInt grain
 * amounts (either may be 0n; a v1 private transfer is `{1, 0n, 0n}`).
 */
export function shieldedFlowGrains(action) {
  const a = unwrapTipped(action);
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'shielded') {
    const bytes = bundlePrefix(a.bundle, 9);
    if (!bytes) return null;
    const vb = BigInt.asIntN(64, u64le(bytes, 1)); // signed value balance
    return {
      pool: 1,
      shieldGrains: vb < 0n ? -vb : 0n,
      unshieldGrains: vb > 0n ? vb : 0n,
    };
  }
  if (a.type === 'shielded_v2') {
    const bytes = bundlePrefix(a.bundle, V2_MIN_LEN);
    if (!bytes || bytes[0] !== V2_PROOF_VERSION) return null;
    return {
      pool: 2,
      shieldGrains: u64le(bytes, V2_LEGS_OFFSET),
      unshieldGrains: u64le(bytes, V2_LEGS_OFFSET + 8),
    };
  }
  return null;
}

/** A transaction's committed execution status, from wherever the record has it. */
function txExecutionStatus(tx) {
  return tx?.executionStatus ?? tx?.receipt?.status?.status ?? tx?.receipt?.status ?? null;
}

/**
 * Sum a block's REAL transparent↔shielded flows by direction, from its
 * transactions' bundle bytes. Only transactions whose committed receipt says
 * `success` are counted — a failed shielded action moves nothing. A shielded
 * transaction whose status is unknown (no receipt) or whose bundle bytes are
 * not parseable is EXCLUDED from the sums and counted in `unattributed`
 * instead: an unknown flow is reported as unknown, never as a number.
 * Grain sums are decimal strings (they exceed 2^53).
 */
export function blockShieldedFlows(block) {
  if (!Array.isArray(block?.transactions)) return null;
  const sums = { shieldV1: 0n, unshieldV1: 0n, shieldV2: 0n, unshieldV2: 0n };
  let shieldedTxs = 0;
  let unattributed = 0;
  for (const tx of block.transactions) {
    const inner = unwrapTipped(tx?.action);
    const type = inner?.type;
    if (type !== 'shielded' && type !== 'shielded_v2') continue;
    shieldedTxs += 1;
    const status = txExecutionStatus(tx);
    if (status !== 'success') {
      if (status === null || status === undefined) unattributed += 1;
      continue; // failed: consensus moved nothing
    }
    const flow = shieldedFlowGrains(tx.action);
    if (!flow) {
      unattributed += 1;
      continue;
    }
    if (flow.pool === 1) {
      sums.shieldV1 += flow.shieldGrains;
      sums.unshieldV1 += flow.unshieldGrains;
    } else {
      sums.shieldV2 += flow.shieldGrains;
      sums.unshieldV2 += flow.unshieldGrains;
    }
  }
  return {
    shieldV1: sums.shieldV1.toString(),
    unshieldV1: sums.unshieldV1.toString(),
    shieldV2: sums.shieldV2.toString(),
    unshieldV2: sums.unshieldV2.toString(),
    shieldedTxs,
    unattributed,
  };
}

/** The account a transaction touches besides its signer, if any. */
export function txCounterparty(action) {
  const a = unwrapTipped(action);
  if (!a || typeof a !== 'object') return null;
  switch (a.type) {
    case 'transfer':
      return a.to ?? null;
    case 'call':
      return a.contract ?? null;
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
  constructor({ maxBlocks = 10_000, maxBytes = 256 * 1024 * 1024, archive = null } = {}) {
    this.maxBlocks = Math.max(1, maxBlocks);
    this.maxBytes = Math.max(1, maxBytes);
    this.archive = archive;
    this.archiveError = null;
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
    this.archiveError = null;
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
    this.shieldedV2Info = null; // pool v2 (post-quantum) state from sov_getShieldedV2Info (null = node too old)
    this.deployments = null; // { height, deployments: [...] } from sov_getDeployments
    this.feeEstimate = null; // { kind, gasUsed, gasPriceGrains, feeGrains } from sov_estimateFee
    this.feeRoutes = null; // { <kind>: estimate } for every route the node prices
    this.mintReward = null; // decimal-grain string from sov_getMintReward
    this.signingDomain = null; // { active, chainId, genesis, txTag, intentTag } from sov_getSigningDomain
    this.peerSummary = null; // { peers, agents } aggregated from sov_getPeerInfo (no addresses)
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
  reset({ clearArchive = true } = {}) {
    if (clearArchive) this.archive?.clearChainData();
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
    this.shieldedV2Info = null;
    this.deployments = null;
    this.feeEstimate = null;
    this.feeRoutes = null;
    this.mintReward = null;
    this.signingDomain = null;
    this.peerSummary = null;
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
  addBlock(rec, { persist = true } = {}) {
    if (persist) this.archive?.putBlock(rec);
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

  /**
   * How many miner ACCOUNTS in the node registry won a block within the last
   * `windowBlocks` of the tip. Registry `lastSeenHeight` covers the whole chain,
   * so this is exact even beyond the in-memory block window. Distinct from
   * `miners.length` (every account ever seen) and from the relay count
   * (infrastructure nodes). Returns null when the tip or registry isn't known —
   * an unknown count is never rendered as zero.
   */
  minerAccountsInWindow(windowBlocks = MINER_WINDOW_BLOCKS) {
    if (!Array.isArray(this.miners) || this.miners.length === 0) return null;
    if (!Number.isFinite(this.tipHeight) || this.tipHeight < 0) return null;
    const cutoff = this.tipHeight - windowBlocks + 1;
    return this.miners.reduce((n, m) => {
      const seen = Number(m?.lastSeenHeight);
      return n + (Number.isFinite(seen) && seen >= cutoff ? 1 : 0);
    }, 0);
  }

  /**
   * Per-account block wins over the last `windowBlocks` heights, computed from the
   * blocks actually retained in memory. Reports its own coverage honestly: when the
   * store retains fewer than `windowBlocks` blocks, `coveredBlocks`/`complete` say
   * exactly which sub-range the shares describe instead of pretending a full window.
   */
  windowMinerStats(windowBlocks = MINER_WINDOW_BLOCKS) {
    const to = this.tipHeight;
    if (!Number.isFinite(to) || to < 0) {
      return { windowBlocks, fromHeight: null, toHeight: null, coveredBlocks: 0, complete: false, miners: [] };
    }
    const requestedFrom = Math.max(0, to - windowBlocks + 1);
    const from = Math.max(requestedFrom, Number.isFinite(this.minHeight) ? this.minHeight : requestedFrom);
    const byAccount = new Map();
    let covered = 0;
    for (let h = from; h <= to; h++) {
      const b = this.blocksByHeight.get(h);
      if (!b || !b.proposer) continue; // genesis mints nothing and has no miner
      covered += 1;
      const entry = byAccount.get(b.proposer) ?? { blocks: 0, lastHeight: -1 };
      entry.blocks += 1;
      entry.lastHeight = Math.max(entry.lastHeight, h);
      byAccount.set(b.proposer, entry);
    }
    const miners = [...byAccount.entries()]
      .map(([account, s]) => ({
        account,
        blocks: s.blocks,
        share: covered > 0 ? s.blocks / covered : null,
        lastHeight: s.lastHeight,
      }))
      .sort((a, b) => b.blocks - a.blocks || a.account.localeCompare(b.account));
    return {
      windowBlocks,
      fromHeight: covered > 0 ? from : null,
      toHeight: covered > 0 ? to : null,
      coveredBlocks: covered,
      complete: from === requestedFrom && covered >= to - from + 1,
      miners,
    };
  }

  /**
   * Observed block spacing over the last `windowBlocks` heights, measured from the
   * `timestamp_ms` of retained headers — never from wall-clock time and never
   * assumed from the difficulty target.
   *
   * Method (stated so the number can be checked): take consecutive retained heights
   * in the window, difference their header timestamps, and report the MEDIAN and the
   * MEAN of those intervals. Proof-of-work intervals are approximately exponential,
   * so the median is the robust headline and the mean is the one that should track
   * the protocol target; both are reported rather than silently picking one.
   *
   * Header timestamps are miner-supplied and only loosely ordered by consensus, so a
   * negative interval is possible. Those are EXCLUDED from the statistics and counted
   * in `nonMonotonicIntervals` rather than being clamped to zero, which would drag
   * the average down and misrepresent spacing. A gap in retained heights breaks the
   * chain of differences instead of producing one huge fabricated interval.
   *
   * Returns nulls (never zeros) when there is not yet a single usable interval.
   */
  blockTimeStats(windowBlocks = MINER_WINDOW_BLOCKS) {
    const to = this.tipHeight;
    const empty = {
      windowBlocks,
      fromHeight: null,
      toHeight: null,
      intervals: 0,
      nonMonotonicIntervals: 0,
      medianMs: null,
      meanMs: null,
      minMs: null,
      maxMs: null,
      targetMs: this.difficulty?.targetBlockMs ?? null,
      complete: false,
    };
    if (!Number.isFinite(to) || to < 0) return empty;
    // `windowBlocks` intervals need `windowBlocks + 1` heights.
    const requestedFrom = Math.max(0, to - windowBlocks);
    const from = Math.max(requestedFrom, Number.isFinite(this.minHeight) ? this.minHeight : requestedFrom);
    const deltas = [];
    let nonMonotonic = 0;
    let previous = null;
    for (let h = from; h <= to; h++) {
      const block = this.blocksByHeight.get(h);
      const ts = Number(block?.timestampMs);
      if (!block || !Number.isFinite(ts)) {
        previous = null; // a hole in retained history must not become one giant interval
        continue;
      }
      if (previous !== null) {
        const delta = ts - previous;
        if (delta >= 0) deltas.push(delta);
        else nonMonotonic += 1;
      }
      previous = ts;
    }
    if (deltas.length === 0) {
      return { ...empty, fromHeight: from, toHeight: to, nonMonotonicIntervals: nonMonotonic };
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const meanMs = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
    return {
      windowBlocks,
      fromHeight: from,
      toHeight: to,
      intervals: deltas.length,
      nonMonotonicIntervals: nonMonotonic,
      medianMs,
      meanMs,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      targetMs: this.difficulty?.targetBlockMs ?? null,
      // True only when the full requested window was retained AND every height in it
      // produced an interval (no holes, no non-monotonic headers dropped).
      complete: from === requestedFrom && deltas.length + nonMonotonic === to - from,
    };
  }

  /**
   * BIP-9 signaling actually observed in retained headers: for each deployment bit,
   * how many of the last `windowBlocks` retained blocks set it in `version_bits`.
   * Blocks indexed before the explorer recorded `versionBits` are excluded from
   * `coveredBlocks` rather than counted as non-signaling.
   */
  versionBitsSignaling(bits, windowBlocks = 288) {
    const to = this.tipHeight;
    const wanted = (Array.isArray(bits) ? bits : [])
      .map(Number)
      .filter((bit) => Number.isInteger(bit) && bit >= 0 && bit <= 28);
    if (!Number.isFinite(to) || to < 0) {
      return { windowBlocks, coveredBlocks: 0, byBit: Object.fromEntries(wanted.map((b) => [b, 0])) };
    }
    const from = Math.max(0, Math.max(to - windowBlocks + 1, Number.isFinite(this.minHeight) ? this.minHeight : 0));
    const byBit = Object.fromEntries(wanted.map((b) => [b, 0]));
    let covered = 0;
    for (let h = from; h <= to; h++) {
      const b = this.blocksByHeight.get(h);
      const raw = b?.versionBits;
      if (raw === null || raw === undefined) continue; // pre-retention block: excluded, not zero
      const vb = Number(raw);
      if (!Number.isFinite(vb)) continue;
      covered += 1;
      for (const bit of wanted) {
        if ((vb >>> bit) & 1) byBit[bit] += 1;
      }
    }
    return { windowBlocks, coveredBlocks: covered, byBit };
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
    const a = unwrapTipped(action); // a tipped envelope moves its inner action's value
    if (!a || typeof a !== 'object') return 0n;
    try {
      switch (a.type) {
        case 'transfer':
        case 'htlc_lock':
          return BigInt(a.amount ?? 0);
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
    let tips = 0n;
    let tippedTransactions = 0;

    for (const block of this.blocksByHeight.values()) {
      if ((block.timestampMs ?? 0) < cutoff) continue;
      blocks += 1;
      for (const tx of block.transactions ?? []) {
        transactions += 1;
        txBytes += tx.sizeBytes ?? 0;
        volume += this.transparentVolumeGrains(tx.action);
        const tip = tipGrains(tx.action);
        if (tip > 0n || tx.action?.type === 'tipped') {
          tippedTransactions += 1;
          tips += tip;
        }
      }
    }

    const oldest = Number.isFinite(this.minHeight) ? this.blocksByHeight.get(this.minHeight) : null;
    const windowComplete = !!oldest && (this.minHeight === 0 || (oldest.timestampMs ?? now) <= cutoff);
    return {
      transactions,
      transactionsPerSecond: transactions / Math.max(1, windowMs / 1000),
      blocks,
      volumeGrains: volume.toString(),
      minerTipGrains: tips.toString(),
      tippedTransactions,
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
    const recentMinerAccounts = this.minerAccountsInWindow();
    const deploymentBits = (this.deployments?.deployments ?? [])
      .map((d) => Number(d?.bit))
      .filter((bit) => Number.isInteger(bit) && bit >= 0 && bit <= 28);
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
      minersActive: recentMinerAccounts, // backward-compatible alias for minerWindow.accounts
      // The miner-account count is only meaningful with its window, so the two are
      // reported as one object. Accounts, not machines: several machines can pay
      // the same coinbase account.
      minerWindow: {
        windowBlocks: MINER_WINDOW_BLOCKS,
        accounts: recentMinerAccounts,
        allTimeAccounts: this.miners.length || null,
      },
      mempoolSize: this.mempoolSize,
      supply: this.supply,
      difficulty: this.difficulty,
      shieldedInfo: this.shieldedInfo,
      // Pool v2 (post-quantum) state from sov_getShieldedV2Info (null = the node is
      // older than v0.2.5 and does not expose it — never fabricated).
      shieldedV2Info: this.shieldedV2Info,
      // BIP-9 deployment states straight from sov_getDeployments (null = the node
      // does not expose them), plus signaling actually observed in retained headers.
      deployments: this.deployments,
      signaling: deploymentBits.length ? this.versionBitsSignaling(deploymentBits) : null,
      // sov_estimateFee for a plain transfer (null = not exposed by the node). The
      // mempool auction's dynamic floor has no RPC today and is reported as absent.
      fees: this.feeEstimate,
      // Every send route the node prices (transfer | tokenTransfer | shielded), each
      // an exact runtime fee, not an interpolation. Routes the node did not answer
      // are simply absent from the map rather than defaulted.
      feeRoutes: this.feeRoutes,
      // The height-keyed coinbase subsidy the node would pay next (sov_getMintReward).
      mintRewardGrains: this.mintReward,
      // Runtime effect of the ACTIVE tx-domain deployment: the exact domain tags every
      // signature is now bound to (sov_getSigningDomain). Null when not exposed.
      signingDomain: this.signingDomain,
      // Observed block spacing from real header timestamps, method + window stated.
      blockTime: this.blockTimeStats(),
      peers: this.peerSummary,
      allTime: {
        circulationGrains: this.supply?.total ?? null,
        marketCapUsd: null,
        marketDominance: null,
        blockchainSizeBytes: this.totalBlockBytesIndexed,
        // Reachable NODES, not miner accounts. This used to report the miner-account
        // count, which conflated two different things: a coinbase account is not a
        // machine (several machines can pay one account) and a node is not a miner
        // (most peers do not mine). The only honest node-side signal is the peer
        // count of the relay we are connected to — itself a lower bound on one
        // relay's neighbourhood, not a network census. Null when unavailable.
        networkNodes: this.peerSummary?.peers ?? null,
        networkNodesBasis: this.peerSummary
          ? 'peers of one relay (sov_getPeerInfo) — a lower bound, not a network census'
          : null,
        minersSeen: this.miners.length || null,
        minersActive: recentMinerAccounts,
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
      // Null — not 0 — when the node has not supplied a supply figure. A "0.00% of
      // cap minted" reading is indistinguishable from a real answer and would be a
      // fabricated statistic during an outage.
      mintedOfCap: this.supply ? ratio(mined, SUPPLY_CAP_GRAINS) : null,
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
      archive: this.archive
        ? { ...this.archive.status(this.nodeHeight), error: this.archiveError }
        : { enabled: false, error: null },
    };
    this._statsCache = { at: now, version: this._statsVersion, value };
    return value;
  }
}
