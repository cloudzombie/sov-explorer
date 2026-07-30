// Transaction TIMING: how long a transaction waited between the moment it was
// first OBSERVED and the block that included it.
//
// Two independent sources feed this, and the explorer never blends them silently:
//
//   chain     — an `Action::Timestamped` envelope (v0.2.6, signal bit 3) carrying the
//               sender's declared creation time, which CONSENSUS bounds against the
//               including block's own timestamp. Strongest source, because it is a
//               rule every node enforced rather than one node's memory — but it is a
//               BOUNDED creation time, provably inside a window, never an exact
//               attested instant. Only present once bit 3 activates and only on
//               transactions whose sender chose to declare one.
//   node      — `sov_getTxTiming`, the node's own mempool observation. Authoritative
//               when present, because the node saw the transaction arrive on the wire.
//   explorer  — this process's own `sov_getMempoolTxs` polling. Used when the node
//               has no observation of its own (it synced the block from a peer, or
//               it restarted and lost its mempool).
//
// When NEITHER source saw the transaction, first-seen is null and stays null. A wait
// time is not estimable from chain data alone — a block timestamp says when a
// transaction was INCLUDED, never when it was created — so an unobserved transaction
// is reported as unobserved rather than guessed. That is the whole point of this
// module: the number is either a real observation or it is absent.
//
// Both RPCs are node-local, non-consensus observations. Different nodes legitimately
// disagree about first-seen, and a node that never held the transaction has no
// opinion at all.

/** JSON-RPC "method not found" from any relay in the pool (an older node). */
export function isMethodNotFound(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /code -32601/.test(message) || /method not found/i.test(message);
}

// null / undefined / '' are ABSENT, not zero: `Number(null)` is 0, and treating a
// null first-seen as the epoch would manufacture an enormous fake wait.
function finiteInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeId(value) {
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

/**
 * The CONSENSUS-BOUNDED creation time an `Action::Timestamped` envelope declares
 * (v0.2.6, signal bit 3), or null when the transaction carries none — which is every
 * transaction before bit 3 activates, and every one whose sender did not opt in.
 *
 * Consensus requires the envelope to be the OUTERMOST action and forbids nesting, so
 * one level is the whole rule; the loop stays bounded regardless of what a node
 * serves. Never throws and never guesses: an absent or malformed envelope is null.
 */
export function declaredCreationMs(action) {
  let node = action;
  for (let i = 0; i < 4 && node && typeof node === 'object'; i++) {
    if (node.type !== 'timestamped') return null;
    const declared = finiteInt(node.created_at_ms ?? node.createdAtMs);
    if (declared !== null) return declared;
    node = node.inner ?? null;
  }
  return null;
}

/** An empty, honest timing record: observed by nobody, therefore all nulls. */
export function unobservedTiming(includedHeight = null, includedTimestampMs = null) {
  return {
    firstSeenMs: null,
    firstSeenHeight: null,
    includedHeight: finiteInt(includedHeight),
    includedTimestampMs: finiteInt(includedTimestampMs),
    waitedMs: null,
    waitedBlocks: null,
    source: null,
    observed: false,
    declared: false,
  };
}

/**
 * Normalize one `sov_getMempoolTxs` entry into the explorer's observation shape.
 * `tipGrains` is a decimal STRING on the wire (grain amounts exceed 2^53) and is
 * kept as a string. Returns null when the entry carries no usable id.
 */
export function normalizeMempoolTx(entry, observedAtMs = Date.now(), chainHeight = null) {
  const txId = normalizeId(entry?.txId ?? entry?.tx_id);
  if (!txId) return null;
  const firstSeenMs = finiteInt(entry?.firstSeenMs ?? entry?.first_seen_ms);
  return {
    txId,
    signer: entry?.signer ?? null,
    nonce: finiteInt(entry?.nonce),
    tipGrains: entry?.tipGrains === undefined || entry?.tipGrains === null
      ? null
      : String(entry.tipGrains),
    sizeBytes: finiteInt(entry?.sizeBytes),
    weight: finiteInt(entry?.weight),
    // The node's own first-seen is preferred; `ageMs` is a fallback for a node that
    // reports age but not an absolute timestamp. Our poll time is the last resort —
    // it is still a REAL observation, just this explorer's rather than the node's.
    firstSeenMs: firstSeenMs
      ?? (finiteInt(entry?.ageMs) !== null ? observedAtMs - finiteInt(entry.ageMs) : observedAtMs),
    firstSeenHeight: finiteInt(chainHeight),
    state: entry?.state === 'queued' ? 'queued' : 'ready',
  };
}

/**
 * Pick the timing for ONE transaction and derive the wait, from the strongest source
 * that actually has an answer.
 *
 * Precedence, strongest first:
 *
 *   1. `chain`    — the transaction's OWN declared creation time, bounded by
 *                   consensus against the including block's timestamp. Every node
 *                   agrees on it, and it survives restarts and cold sync, because it
 *                   is in the block. `source: 'chain'`.
 *   2. `node`     — the node's own mempool observation (`observed: true` with a real
 *                   first-seen). One node's memory; another node may differ.
 *   3. `explorer` — this process's own polling record, when the node has no
 *                   observation of its own.
 *
 * When none has one, every timing field stays null with `observed: false`: nothing is
 * estimated or backfilled. A block timestamp says when a transaction was INCLUDED,
 * never when it was made, so an unobserved transaction is reported as unobserved.
 *
 * `waitedMs` is (block timestamp − first seen/created) and `waitedBlocks` is (block
 * height − the height at which the transaction was first observed). A chain-declared
 * creation time has no associated height — it is a wall-clock instant, not a chain
 * position — so `waitedBlocks` stays null unless an observation also supplied one.
 */
export function pairTiming({
  declaredCreatedAtMs = null,
  nodeTiming = null,
  observation = null,
  includedHeight,
  includedTimestampMs,
} = {}) {
  const height = finiteInt(includedHeight);
  const timestampMs = finiteInt(includedTimestampMs);
  const declared = finiteInt(declaredCreatedAtMs);
  const nodeObserved = nodeTiming?.observed === true
    && finiteInt(nodeTiming?.firstSeenMs) !== null;

  const firstSeenMs = declared !== null
    ? declared
    : nodeObserved
      ? finiteInt(nodeTiming.firstSeenMs)
      : finiteInt(observation?.firstSeenMs);
  if (firstSeenMs === null) return unobservedTiming(height, timestampMs);

  // A chain-declared creation time carries no height of its own. An observation's
  // height is still used when one exists, so `waitedBlocks` stays available for a
  // transaction this explorer also happened to watch arrive.
  const firstSeenHeight = declared !== null
    ? finiteInt(observation?.firstSeenHeight)
    : nodeObserved
      ? finiteInt(nodeTiming.firstSeenHeight)
      : finiteInt(observation?.firstSeenHeight);

  // Prefer the source's own arithmetic when it supplied it (the node knows its own
  // inclusion timestamp exactly); otherwise derive it from the two observations.
  const waitedMs = declared === null && nodeObserved && finiteInt(nodeTiming.waitedMs) !== null
    ? finiteInt(nodeTiming.waitedMs)
    : timestampMs !== null ? timestampMs - firstSeenMs : null;
  const waitedBlocks = declared === null && nodeObserved
    && finiteInt(nodeTiming.waitedBlocks) !== null
    ? finiteInt(nodeTiming.waitedBlocks)
    : height !== null && firstSeenHeight !== null ? height - firstSeenHeight : null;

  return {
    firstSeenMs,
    firstSeenHeight,
    includedHeight: height,
    includedTimestampMs: timestampMs,
    waitedMs,
    waitedBlocks,
    source: declared !== null ? 'chain' : nodeObserved ? 'node' : 'explorer',
    observed: true,
    // True only for `chain`: the value is a consensus-bounded property of the
    // transaction, not one node's recollection. The UI uses this to say "made"
    // rather than "first seen".
    declared: declared !== null,
  };
}

/** Index a `sov_getTxTiming` per-block response by transaction id. */
export function indexBlockTiming(response) {
  const rows = Array.isArray(response?.txs) ? response.txs : [];
  const byId = new Map();
  for (const row of rows) {
    const id = normalizeId(row?.txId ?? row?.tx_id);
    if (id) byId.set(id, row);
  }
  return byId;
}

/** Linear-interpolated quantile of an ASCENDING-sorted numeric array. */
export function quantile(sorted, q) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(rows) {
  const waits = rows.map((row) => row.waitedMs).filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  const blocks = rows.map((row) => row.waitedBlocks).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    count: rows.length,
    medianWaitMs: quantile(waits, 0.5),
    p90WaitMs: quantile(waits, 0.9),
    medianWaitBlocks: quantile(blocks, 0.5),
    p90WaitBlocks: quantile(blocks, 0.9),
  };
}

/**
 * Median and p90 wait, split by tipped vs untipped — the fee auction, measured.
 *
 * ONLY transactions with an observed wait enter the statistics. Everything else is
 * counted and reported: `excludedUnobserved` (nobody recorded a first-seen — every
 * transaction mined before this feature shipped is in here) and `excludedNegative`
 * (block timestamp earlier than first-seen; miner timestamps are only loosely
 * ordered by consensus, so these are dropped rather than clamped to zero, which
 * would drag the medians down). The caller is expected to SHOW those counts: a
 * sample that silently omits most of its population is a misleading statistic.
 */
export function timingStats(rows) {
  const usable = [];
  let excludedUnobserved = 0;
  let excludedNegative = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const waitedMs = Number(row?.waitedMs);
    if (!row || row.observed === false || !Number.isFinite(waitedMs)) {
      excludedUnobserved += 1;
      continue;
    }
    if (waitedMs < 0) {
      excludedNegative += 1;
      continue;
    }
    usable.push({
      waitedMs,
      waitedBlocks: Number.isFinite(Number(row.waitedBlocks)) ? Number(row.waitedBlocks) : null,
      tipped: !!row.tipped,
    });
  }
  return {
    considered: (Array.isArray(rows) ? rows.length : 0),
    sampleSize: usable.length,
    excludedUnobserved,
    excludedNegative,
    overall: summarize(usable),
    tipped: summarize(usable.filter((row) => row.tipped)),
    untipped: summarize(usable.filter((row) => !row.tipped)),
  };
}
