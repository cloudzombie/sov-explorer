// Browser-only user tools. Watchlists never leave localStorage, and exports are
// assembled from data already shown in the current page.
const WATCH_KEY = 'sovereign-explorer-watchlist-v1';
export function watchlist() { try { const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []; } catch { return []; } }
export function isWatched(account) { return watchlist().includes(account); }
export function toggleWatch(account) { const v = watchlist(); const next = v.includes(account) ? v.filter((x) => x !== account) : [...v, account].slice(-100); localStorage.setItem(WATCH_KEY, JSON.stringify(next)); return next.includes(account); }
function cell(value) { const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function downloadRows(filename, rows, format = 'json') { const values = Array.isArray(rows) ? rows : []; const keys = Object.keys(values[0] || {}); const body = format === 'csv' ? `${keys.map(cell).join(',')}\n${values.map((r) => keys.map((k) => cell(r[k])).join(',')).join('\n')}\n` : `${JSON.stringify(values, null, 2)}\n`; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([body], { type: format === 'csv' ? 'text/csv' : 'application/json' })); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); }
export function explainAction(action) { return ({ transfer: 'Moves transparent XUS from the signer to the recipient.', token_issue: 'Creates a transparent token supply and assigns it to an account.', token_transfer: 'Moves an issued token between transparent accounts.', token_burn: 'Permanently removes units of an issued token.', shielded: 'Applies a privacy-pool bundle without revealing note ownership or individual private flows.', htlc_lock: 'Locks XUS until its secret or refund condition is satisfied.', htlc_claim: 'Claims a hash-time-locked transfer by revealing its secret.', htlc_refund: 'Returns an expired hash-time-locked transfer.', call: 'Invokes a deployed contract with the displayed gas ceiling.', deploy: 'Publishes WebAssembly contract code on-chain.', register_name: 'Registers a Sovereign Name Service name.', transfer_name: 'Changes the account targeted by an SNS name.', nft_mint: 'Creates a non-fungible token.', nft_transfer: 'Transfers ownership of a non-fungible token.', nft_set_meta: 'Updates the metadata of a non-fungible token.', tipped: 'Pays a fee-auction priority tip to the block’s miner on top of the intrinsic fee, then executes the wrapped inner action. Enabled by the miner-signaled fee-auction deployment.', set_multisig: 'Configures M-of-N multisig control for the signer’s account.', multisig_exec: 'Executes an action authorized by the required multisig approvals.', propose_multisig: 'Proposes an action for a multisig account to approve.', approve_multisig: 'Approves a pending multisig proposal.', cancel_multisig: 'Cancels a pending multisig proposal.', vault_deposit: 'Deposits XUS collateral into the signer’s xUSD vault.', vault_mint: 'Mints xUSD against vault collateral at the oracle price, subject to the minimum collateral ratio.', vault_burn: 'Burns xUSD to repay vault debt.', vault_withdraw: 'Withdraws XUS collateral while the vault stays at or above the minimum collateral ratio.', oracle_update: 'Publishes a new XUS/USD oracle price; accepted only from the authorized oracle account.', rotate_key: 'Replaces the account’s signing key.', intent_settle: 'Settles a signed intent on-chain.', intent_cancel: 'Cancels a previously signed intent.', token_set_policy: 'Updates an issued token’s policy.', claim_vesting: 'Claims a vested allocation into the liquid balance.' })[action?.type] || 'A chain-native action. The exact indexed payload is preserved below.'; }
function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
export async function verifyMerkleProof(proof, expectedRoot) { if (!proof) return { verified: false, reason: 'proof unavailable from relay' }; if (String(proof.algorithm || '').toLowerCase() !== 'sha256') return { verified: false, reason: `browser verifier does not support ${proof.algorithm || 'unspecified'} proofs` }; let current = String(proof.leaf || '').replace(/^0x/, '').toLowerCase(); for (const step of proof.path || []) { const sibling = String(step.hash || step.sibling || '').replace(/^0x/, '').toLowerCase(); const combined = step.side === 'left' ? sibling + current : current + sibling; const bytes = Uint8Array.from(combined.match(/../g) || [], (x) => parseInt(x, 16)); current = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); } const verified = current === String(expectedRoot || proof.root || '').replace(/^0x/, '').toLowerCase(); return { verified, reason: verified ? 'proof recomputed to the block header root' : 'proof does not match the block header root' }; }

// Convert relay probe state into one consistent, DOM-free presentation model.
// `configured` is the denominator so a relay that never verified because it was
// unavailable at startup remains visible instead of producing a misleading 2/2.
export function relayAvailability(relays = {}) {
  const finiteCount = (value) => {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
  };
  const healthy = finiteCount(relays.healthy);
  const configured = finiteCount(relays.configured) ?? finiteCount(relays.verified) ?? healthy;
  let state = 'pending';
  let tone = 'pending';
  if (relays.consistent === false) {
    state = 'disagreement';
    tone = 'bad';
  } else if (relays.degraded) {
    state = 'degraded';
    tone = 'warn';
  } else if (relays.reducedRedundancy) {
    state = 'reduced redundancy';
    tone = 'info';
  } else if (relays.consistent === true) {
    state = 'consistent';
    tone = 'ok';
  }
  return { healthy, configured, state, tone };
}

// ---- transaction timing presentation --------------------------------------
// Pure, DOM-free reduction of the API's `timing` record to what the UI renders.
// A transaction with no recorded first-seen is NOT given a guessed wait: it comes
// back `observed: false` so the view can print "— / not observed". First-seen is
// the moment a node/this explorer first OBSERVED the transaction — not a
// self-reported creation time — and two nodes can legitimately differ.
export function timingSummary(timing) {
  // null / undefined are ABSENT, not zero — `Number(null)` is 0, which would turn a
  // missing first-seen into an epoch timestamp and an absurd wait.
  const num = (value) => (value === null || value === undefined ? Number.NaN : Number(value));
  const firstSeenMs = num(timing?.firstSeenMs);
  if (!timing || timing.observed !== true || !Number.isFinite(firstSeenMs)) {
    return {
      observed: false,
      source: null,
      firstSeenMs: null,
      firstSeenHeight: null,
      waitedMs: null,
      waitedSeconds: null,
      waitedBlocks: null,
    };
  }
  const waitedMs = num(timing.waitedMs);
  const waitedBlocks = num(timing.waitedBlocks);
  return {
    observed: true,
    source: timing.source ?? null,
    firstSeenMs,
    firstSeenHeight: Number.isFinite(num(timing.firstSeenHeight))
      ? Number(timing.firstSeenHeight)
      : null,
    waitedMs: Number.isFinite(waitedMs) ? waitedMs : null,
    waitedSeconds: Number.isFinite(waitedMs) ? waitedMs / 1000 : null,
    waitedBlocks: Number.isFinite(waitedBlocks) ? waitedBlocks : null,
  };
}

// ---- shielded-v2 (post-quantum TX) activation model -----------------------
// Pure, framework-free derivation of the BIP-9 activation milestones for the
// post-quantum shielded pool ("PQ TX"). Heights are DERIVED from the node-
// reported startHeight + period, never hardcoded: a deployment can lock in no
// earlier than one full period after its start and activate one period after
// lock-in, so signal = start, lock-in = start+period, active = start+2·period.
// (shielded-v2 on mainnet: start 14,976, period 288 → 15,264 → 15,552.)
// Done-ness is taken from the authoritative BIP-9 state — height alone would
// mislabel a milestone as reached when signaling missed the 90% threshold and
// activation slipped to a later period. Countdowns use the projected height.
// Returns null when the deployment or its fields are absent so the caller can
// render nothing at all on an older node. `blockSeconds` defaults to the 150s
// (2.5 min) target for the ~time-remaining estimate.
const BIP9_RANK = { Defined: 0, Started: 1, LockedIn: 2, Active: 3, Failed: 0 };

export function shieldedActivation(deployment, head, opts = {}) {
  if (!deployment) return null;
  const start = Number(deployment.startHeight);
  const period = Number(deployment.period);
  if (!Number.isFinite(start) || !Number.isFinite(period) || period <= 0) return null;
  const state = String(deployment.state ?? 'Defined');
  const rank = BIP9_RANK[state] ?? 0;
  const failed = state === 'Failed';
  const blockSeconds = Number.isFinite(Number(opts.blockSeconds)) ? Number(opts.blockSeconds) : 150;
  const h = Number.isFinite(Number(head)) ? Number(head) : null;

  // signal → lock-in → active, each keyed to the BIP-9 rank that proves it.
  const defs = [
    { key: 'signal', label: 'Signal', height: start, minRank: 1 },
    { key: 'lockin', label: 'Lock-in', height: start + period, minRank: 2 },
    { key: 'active', label: 'Active', height: start + 2 * period, minRank: 3 },
  ];
  const milestones = defs.map((m) => ({
    key: m.key,
    label: m.label,
    height: m.height,
    reached: rank >= m.minRank,
  }));

  // The next milestone is the first not yet reached; only it carries a
  // countdown. When the projected height has already passed but the state has
  // not advanced (signaling below threshold), there is no positive countdown —
  // it is eligible and awaiting the next signaling period.
  const nextIdx = failed ? -1 : milestones.findIndex((m) => !m.reached);
  if (nextIdx >= 0) {
    const m = milestones[nextIdx];
    m.next = true;
    if (h !== null) {
      const remaining = m.height - h;
      m.blocksRemaining = remaining > 0 ? remaining : 0;
      m.eligibleNow = remaining <= 0;
      m.etaSeconds = remaining > 0 ? remaining * blockSeconds : 0;
    }
  }

  const active = rank >= 3;
  return {
    name: deployment.name,
    bit: deployment.bit,
    state,
    failed,
    active,
    head: h,
    activeHeight: start + 2 * period,
    milestones,
  };
}

// ---- shielded-pool "blocky" migration chart helpers ----------------------
// Pure, DOM-free quantisers shared by the Minecraft/Tetris-style pool chart in
// app.js. Kept here (like RingBuffer in ticker.js) so they are unit-testable.

// Choose a "nice" XUS-per-block unit on a 1/2/5×10ⁿ ladder so the tallest pool
// stack is roughly `target` unit-blocks tall (never taller). Returns the XUS
// value a single block denotes. `maxValueXus` ≤ 0 collapses to a unit of 1 so a
// freshly-launched, empty pool still renders one honest empty column.
export function blockUnit(maxValueXus, target = 20) {
  const max = Math.max(0, Number(maxValueXus) || 0);
  const t = Math.max(1, Number(target) || 20);
  if (max <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(max / t)));
  for (const step of [1, 2, 5]) {
    const unit = step * mag;
    if (max / unit <= t) return unit;
  }
  return 10 * mag;
}

// Quantise a pool's XUS value into discrete unit-blocks. `unit` is the XUS a
// single block denotes. Returns whole `full` blocks plus a `partial` fraction
// (0..1) for the remainder that sits below one unit — drawn as a short top
// block. Pure — no DOM, no rounding surprises for the caller.
export function poolBlocks(valueXus, unit) {
  const v = Math.max(0, Number(valueXus) || 0);
  const u = Number(unit) > 0 ? Number(unit) : 1;
  const total = v / u;
  const full = Math.floor(total + 1e-9);
  const partial = Math.min(1, Math.max(0, total - full));
  return { full, partial, total };
}
