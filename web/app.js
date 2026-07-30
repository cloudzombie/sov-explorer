// Sovereign Explorer — single-page UI. Hash-routed, fetches the REST API, and follows
// a WebSocket live feed. All values shown are real chain data served by the node.
import { blockUnit, downloadRows, explainAction, isWatched, poolBlocks, relayAvailability, shieldedActivation, timingSummary, toggleWatch, verifyMerkleProof, watchlist } from './tools.js';
import { BlockTicker } from './ticker.js';

const $ = (id) => document.getElementById(id);

// Honour the OS reduced-motion setting: the LIVE strip falls back to a
// stepwise, non-scrolling behaviour instead of a continuous marquee.
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
// The rolling block-height ticker beside the LIVE badge (see web/ticker.js).
let blockTicker = null;
// Recent block timestamps (ms), newest last — feeds the cadence sparkline.
let cadenceTs = [];
// Rolling pool-split samples this browser has observed ({height, v1, v2} grain
// strings), persisted so the v1→v2 migration chart survives reloads. The node
// does not retain a pool-split time-series, so this is a best-effort local view.
const POOL_HISTORY_KEY = 'sov-pool-history-v1';
const view = $('view');
const DEFAULT_DESCRIPTION = 'Independent live explorer for Sovereign blocks, transactions, accounts, assets, contracts, HTLCs, and Nakamoto finality.';

function setPageMeta(title, description = DEFAULT_DESCRIPTION) {
  const fullTitle = title ? `${title} — Sovereign Explorer` : 'Sovereign Explorer';
  document.title = fullTitle;
  $('meta-description')?.setAttribute('content', description);
  $('og-title')?.setAttribute('content', fullTitle);
  $('og-description')?.setAttribute('content', description);
  $('og-url')?.setAttribute('content', location.href);
  $('twitter-title')?.setAttribute('content', fullTitle);
  $('twitter-description')?.setAttribute('content', description);
}

// ---- formatting -----------------------------------------------------------

const COIN_SYMBOL = 'XUS';
const GRAINS = 100000000n; // 1 XUS = 1e8 grains

function group(s) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtCoin(grains) {
  if (grains === null || grains === undefined) return '—';
  let g;
  try {
    g = BigInt(grains);
  } catch {
    return '—';
  }
  const neg = g < 0n;
  if (neg) g = -g;
  let s = group((g / GRAINS).toString());
  const frac = g % GRAINS;
  if (frac > 0n) s += '.' + frac.toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + s;
}
function fmtNum(n) {
  const value = String(n ?? 0);
  return /^-?\d+(?:\.\d+)?$/.test(value) ? group(value) : '—';
}
function fmtDecimal(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(digits).replace(/\.?0+$/, '');
}
function fmtUsd(n) {
  if (n === null || n === undefined) return '— USD';
  return `${fmtNum(n)} USD`;
}
function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${fmtDecimal(value, value >= 100 ? 0 : 2)} ${units[i]}`;
}

/** Format a hash rate (hashes/second) with SI-scaled units. */
function fmtHashrate(hps) {
  if (hps === null || hps === undefined) return '—';
  const n = Number(hps);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let value = n;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${fmtDecimal(value, value >= 100 ? 0 : 2)} ${units[i]}`;
}
/** Human label for a block-count window, e.g. "last 576 blocks (~24 h)". The
 * duration is derived from the node-reported block target when known; without it
 * only the block count is claimed. */
function minerWindowLabel(blocks, targetBlockMs = LAST_STATUS?.difficulty?.targetBlockMs) {
  const n = Number(blocks);
  if (!Number.isFinite(n) || n <= 0) return 'window pending';
  const target = Number(targetBlockMs);
  if (!Number.isFinite(target) || target <= 0) return `last ${fmtNum(n)} blocks`;
  const hours = (n * target) / 3_600_000;
  const approx = hours >= 48 ? `${fmtDecimal(hours / 24, 1)} d` : `${fmtDecimal(hours, hours < 10 ? 1 : 0)} h`;
  return `last ${fmtNum(n)} blocks (~${approx})`;
}
/** Format a duration given in milliseconds as seconds/minutes, or an em dash. */
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  if (s < 90) return `${fmtDecimal(s, s < 10 ? 2 : 1)} s`;
  const m = s / 60;
  return `${fmtDecimal(m, m < 10 ? 2 : 1)} min`;
}

function shortHash(h, head = 10, tail = 8) {
  if (!h) return '—';
  const value = String(h);
  return value.length > head + tail + 2
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;
}
function timeAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return (Number(x) * 100).toFixed(2) + '%';
}
function statItem(label, value, sub = '') {
  return `<div class="stat-item">
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>
    <span class="stat-arrow" aria-hidden="true">↗</span>
  </div>`;
}

// ---- network (testnet / mainnet) switch -----------------------------------
// The explorer serves every network from one server; the UI just points its API
// and live feed at /api/<net> and /ws/<net>. A network reported not-live by
// /networks (e.g. mainnet before its node exists) shows a launching-soon panel and
// is never queried — so wiring mainnet in later is a server env var, no UI change.

const savedNet = localStorage.getItem('sov-net-v2');
let NET = savedNet === 'testnet' || savedNet === 'mainnet' ? savedNet : 'mainnet';
const NET_LIVE = { testnet: true, mainnet: true };
let LAST_STATUS = null;
let WS_OPEN = false;
let ROUTE_ID = 0;

function setNetToggleUI() {
  for (const b of document.querySelectorAll('#netsw button')) {
    const n = b.dataset.net;
    b.classList.toggle('is-active', n === NET);
    b.classList.toggle('is-soon', NET_LIVE[n] === false);
    b.setAttribute('aria-pressed', String(n === NET));
    b.title = NET_LIVE[n] === false ? `${n} — launching soon` : `switch to ${n}`;
  }
}

async function switchNet(net) {
  if (net === NET) return;
  NET = net;
  LAST_STATUS = null;
  const ticker = $('ticker');
  if (blockTicker) {
    blockTicker.destroy();
    blockTicker = null;
  }
  if (ticker) ticker.hidden = true;
  localStorage.setItem('sov-net-v2', net);
  setPageMeta(net);
  setNetToggleUI();
  connectWs();
  seedTicker();
  await route().catch((e) => errView(e.message));
  pollStatus();
}

async function loadNetworks() {
  try {
    const list = await fetch('/networks').then((r) => r.json());
    for (const n of list) NET_LIVE[n.name] = !!n.live;
  } catch {
    /* leave defaults (both live) */
  }
  // Fall back to whichever network IS live if the selected one isn't.
  if (NET_LIVE[NET] === false) {
    NET = NET === 'mainnet' ? 'testnet' : 'mainnet';
    localStorage.setItem('sov-net-v2', NET);
  }
  setPageMeta(NET);
  setNetToggleUI();
  for (const b of document.querySelectorAll('#netsw button')) {
    b.addEventListener('click', () => switchNet(b.dataset.net));
  }
}

function renderNotLive(routeId) {
  const label = NET.charAt(0).toUpperCase() + NET.slice(1);
  setView(
    `<div class="empty notlive">🚀 <b>${esc(label)} is launching soon.</b><br />` +
      `<span class="dim">No relay is configured for this network. Choose an available network or check the explorer deployment.</span></div>`,
    routeId,
  );
}

async function api(path) {
  const res = await fetch('/api/' + NET + path);
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    const message = typeof e.error === 'object' ? e.error?.message : e.error;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return res.json();
}

function setView(html, routeId = null) {
  if (routeId !== null && routeId !== ROUTE_ID) return false;
  view.innerHTML = html;
  delete view.dataset.tipHeight;
  view.setAttribute('aria-busy', String(html.includes('class="loading"')));
  return true;
}
function errView(msg, routeId = null) {
  setView(`<div class="empty">⚠ ${esc(msg)}<br /><span class="dim">Is a Sovereign node running and reachable?</span></div>`, routeId);
}
function renderNotFound(message = 'That explorer page does not exist.', routeId = null) {
  setPageMeta('Not found', message);
  setView(`<div class="panel empty-state not-found"><div class="es-code">404</div><h1>Not found</h1><p>${esc(message)}</p><p><a class="pager-btn" href="#/">Return to overview</a></p></div>`, routeId);
}

// ---- live view hooks ------------------------------------------------------
// The current view registers what to do when a block/tx arrives over the WS
// feed, so the page updates in place — no refresh. Cleared on every navigation.
const live = { onBlock: null, onTx: null };
function liveReset() {
  live.onBlock = null;
  live.onTx = null;
}
// Prepend a freshly-arrived row to a table body, flash it, and cap the length.
function livePrepend(tbodyId, rowHtml, cap) {
  const tb = $(tbodyId);
  if (!tb) return;
  const empty = tb.querySelector('td.empty');
  if (empty) empty.closest('tr').remove();
  tb.insertAdjacentHTML('afterbegin', rowHtml);
  const row = tb.firstElementChild;
  if (row) row.classList.add('live-new');
  while (tb.children.length > cap) tb.lastChild.remove();
}

// ---- links + render helpers -----------------------------------------------

const blockLink = (h) => `<a href="#/block/${encodeURIComponent(h)}" class="mono">#${fmtNum(h)}</a>`;
const blockHashLink = (hash) => `<a href="#/block/${encodeURIComponent(hash)}" class="mono">${esc(shortHash(hash))}</a>`;
const txLink = (id) => `<a href="#/tx/${encodeURIComponent(id)}" class="mono">${esc(shortHash(id))}</a>`;
const acctLink = (a) => `<a href="#/account/${encodeURIComponent(a)}" class="mono">${esc(a)}</a>`;
const objectLink = (kind, id, label = shortHash(id)) => `<a href="#/object/${encodeURIComponent(kind)}/${encodeURIComponent(id)}" class="mono">${esc(label)}</a>`;
// Like acctLink but abbreviates a long implicit id (a35755d3…4c1e24); short
// human names (founder.tax.sov) are left whole.
const acctLinkShort = (a) =>
  `<a href="#/account/${encodeURIComponent(a)}" class="mono" title="${esc(a)}">${esc(shortHash(a, 8, 6))}</a>`;

function copyButton(value, label = 'value') {
  if (value === null || value === undefined) return '';
  return `<button type="button" class="copy-btn" data-copy="${encodeURIComponent(String(value))}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">⧉</button>`;
}

function actionBadge(action) {
  const t = action?.type ?? 'unknown';
  return `<span class="badge act">${esc(t)}</span>`;
}
function actionSummary(action) {
  if (!action) return '';
  switch (action.type) {
    case 'transfer':
      return `→ ${acctLink(action.to)} · <b>${fmtCoin(action.amount)}</b> ${COIN_SYMBOL}`;
    case 'token_issue':
      return `<b>${fmtCoin(action.amount)}</b> ${esc(action.symbol)} · to ${acctLink(action.to)}`;
    case 'token_transfer':
      return `asset ${objectLink('token', action.asset, shortHash(action.asset, 8, 6))} → ${acctLink(action.to)} · <b>${fmtCoin(action.amount)}</b>`;
    case 'token_burn':
      return `asset ${objectLink('token', action.asset, shortHash(action.asset, 8, 6))} · <b>${fmtCoin(action.amount)}</b>`;
    case 'shielded':
      return `shielded bundle (${fmtBytes((action.bundle || []).length)})`;
    case 'shielded_v2':
      // Pool-v2 post-quantum spend. The bundle is opaque at this layer (ML-KEM-768
      // ciphertexts + STARK proof + nullifiers/commitments are encoded inside it);
      // only its size is public. Amounts stay private, same disclosure model as v1.
      return `pool-v2 (post-quantum) shielded spend · bundle (${fmtBytes((action.bundle || []).length)})`;
    case 'htlc_lock':
      return `HTLC lock → ${acctLink(action.recipient)} · <b>${fmtCoin(action.amount)}</b> ${COIN_SYMBOL}`;
    case 'htlc_claim':
      return `HTLC claim ${objectLink('htlc', action.htlc_id, shortHash(action.htlc_id, 8, 6))}`;
    case 'htlc_refund':
      return `HTLC refund ${objectLink('htlc', action.htlc_id, shortHash(action.htlc_id, 8, 6))}`;
    case 'call':
      return `→ ${acctLink(action.contract)} · gas ${fmtNum(action.gas_limit)}`;
    case 'deploy':
      return `WASM contract (${fmtNum((action.code || []).length)} bytes)`;
    case 'claim_vesting':
      return `claim vested allocation`;
    case 'register_name':
      return `register SNS name <b>${esc(action.name)}</b>`;
    case 'transfer_name':
      return `name <b>${esc(action.name)}</b> → ${acctLink(action.to)}`;
    case 'nft_mint':
      return `mint NFT in <b>${esc(action.symbol)}</b> → ${acctLink(action.to)}`;
    case 'nft_transfer':
      return `NFT ${objectLink('nft', `${action.collection}:${bytesHex(action.token_id)}`, shortHash(bytesHex(action.token_id), 8, 6))} → ${acctLink(action.to)}`;
    case 'nft_set_meta':
      return `set NFT ${objectLink('nft', `${action.collection}:${bytesHex(action.token_id)}`, shortHash(bytesHex(action.token_id), 8, 6))} metadata`;
    case 'tipped':
      // Fee-auction envelope (v0.1.98): the tip goes to the block's miner, then
      // the inner action executes.
      return `miner tip <b>${fmtCoin(action.tip)}</b> ${COIN_SYMBOL} · ${action.inner ? `${esc(action.inner.type ?? 'action')} — ${actionSummary(action.inner)}` : ''}`;
    case 'vault_deposit':
      return `deposit <b>${fmtCoin(action.amount)}</b> ${COIN_SYMBOL} vault collateral`;
    case 'vault_mint':
      return `mint <b>${fmtCoin(action.amount)}</b> xUSD against vault collateral`;
    case 'vault_burn':
      return `repay <b>${fmtCoin(action.amount)}</b> xUSD vault debt`;
    case 'vault_withdraw':
      return `withdraw <b>${fmtCoin(action.amount)}</b> ${COIN_SYMBOL} vault collateral`;
    case 'oracle_update':
      return `oracle price update`;
    case 'rotate_key':
      return `rotate account key`;
    case 'set_multisig':
      return `configure M-of-N multisig`;
    case 'multisig_exec':
      return action.inner ? `multisig-execute ${esc(action.inner.type ?? 'action')}` : 'multisig execution';
    case 'propose_multisig':
      return 'propose multisig action';
    case 'approve_multisig':
      return 'approve multisig proposal';
    case 'cancel_multisig':
      return 'cancel multisig proposal';
    default:
      return '';
  }
}

function bytesHex(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^0x/, '').toLowerCase();
  return Array.from(value, (byte) => Number(byte).toString(16).padStart(2, '0')).join('');
}
function finalBadge(final) {
  return final
    ? `<span class="badge final">Final</span>`
    : `<span class="badge pending">Pending</span>`;
}

function emptyRootBadge(empty) {
  return empty ? '<span class="root-kind" title="Deterministic Merkle root of an empty ordered list">empty set</span>' : '';
}

function safeBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

// ---- views ----------------------------------------------------------------

async function renderOverview(routeId) {
  setView('<div class="loading">Loading overview…</div>', routeId);
  const [status, blocks100, txs, supply] = await Promise.all([
    api('/status'),
    api('/blocks?limit=24').catch(() => []),
    api('/txs?limit=12'),
    api('/supply').catch(() => null),
  ]);
  const blocks = (Array.isArray(blocks100) ? blocks100 : []).slice(0, 12);
  const s = status;
  // Feed the live-strip cadence sparkline and record a pool-split sample.
  seedCadence(blocks100);
  recordPoolSample(
    Number(s.sync?.nodeHeight ?? s.tipHeight),
    supply?.shielded ?? s.shieldedInfo?.poolValue ?? null,
    s.shieldedV2Info?.poolValue ?? null,
  );
  const all = s.allTime ?? {};
  const day = s.last24h ?? {};
  const mempool = s.mempool ?? {};
  const sync = s.sync ?? {};
  const relay = s.relays ?? {};
  const relayState = relayAvailability(relay);
  const relayText = relayState.healthy !== null
    ? `${fmtNum(relayState.healthy)}/${fmtNum(relayState.configured)} relays · ${relayState.state}`
    : 'relay status pending';
  // Mining accounts seen in the server-stated recent window (24h at the 150s
  // target). The window is always shown WITH the count: a short sample hides
  // low-hashrate miners, and coinbase accounts are not machines — several
  // machines can pay the same account.
  const mw = s.minerWindow ?? {};
  const windowLabel = minerWindowLabel(mw.windowBlocks);
  const minersText = mw.accounts === null || mw.accounts === undefined
    ? 'miners pending'
    : `${fmtNum(mw.accounts)} mining account${mw.accounts === 1 ? '' : 's'} · ${windowLabel}`;
  setView(`
    <section class="hero-strip">
      <div>
        <h1>Sovereign</h1>
        <p><span id="hero-chain">${esc(s.chainId || 'Chain')}</span> · node height <span id="hero-height">${fmtNum(sync.nodeHeight ?? s.tipHeight ?? 0)}</span>${sync.ready ? '' : ` · indexing <span id="hero-indexed">${fmtNum(sync.indexedHeight ?? 0)}</span>`}</p>
      </div>
      <div class="hero-meta">
        <a class="genesis-chip mono" href="#/block/0" title="Open the genesis block (#0) — ${esc(s.genesisHash || '')}">Genesis ${esc(shortHash(s.genesisHash, 10, 6))}</a>
        <span>${fmtNum(s.blocksIndexed)} indexed blocks</span>
        ${s.archive?.enabled ? `<span>${s.archive.complete ? `${fmtNum(s.archive.blocks)}-block complete archive` : `archive from #${fmtNum(s.archive.contiguousFromHeight)}`}</span>` : ''}
        <span class="relay-pill ${relayState.tone === 'warn' || relayState.tone === 'bad' ? 'degraded' : relayState.tone === 'info' ? 'reduced' : ''}">${esc(relayText)}</span>
        <span class="miners-pill ${mw.accounts ? '' : 'idle'}" title="Coinbase accounts that won at least one of the last ${esc(String(mw.windowBlocks ?? '—'))} blocks. Accounts, not machines — several machines can pay one account.">${esc(minersText)}</span>
        ${pqActivationChips(s)}
      </div>
    </section>
    ${signalProgress(s)}
    ${trustWidget(s, supply, s.genesisHash)}

    <div class="stat-columns">
      <section class="stat-card">
        <h2>All time</h2>
        ${statItem('Circulation', `<span id="ov-circulation">${fmtCoin(all.circulationGrains)} ${COIN_SYMBOL}</span>`, `${pct(s.mintedOfCap)} of 21,000,000 cap minted`)}
        ${statItem('Shielded supply', supply?.shieldedPercent === undefined ? '—' : `${fmtDecimal(supply.shieldedPercent, 2)}%`, supply ? `${fmtCoin(supply.shielded)} ${COIN_SYMBOL} private of ${fmtCoin(supply.total)} (Orchard pool — not post-quantum)` : 'node unreachable')}
        ${statItem('Market cap', fmtUsd(all.marketCapUsd), 'price feed not configured')}
        ${statItem('Market dominance', all.marketDominance === null || all.marketDominance === undefined ? '—' : pct(all.marketDominance), 'market feed not configured')}
        ${statItem('Blockchain size', fmtBytes(all.blockchainSizeBytes), 'indexed window')}
        ${statItem('Mining accounts', mw.accounts === null || mw.accounts === undefined ? '—' : fmtNum(mw.accounts), `won a block in the ${windowLabel} — accounts, not machines`)}
        ${statItem('Mining accounts (all time)', (all.minersSeen ?? all.networkNodes) == null ? '—' : fmtNum(all.minersSeen ?? all.networkNodes), 'every coinbase account in the node registry')}
        ${statItem('Relays', relayState.healthy === null ? '—' : `${fmtNum(relayState.healthy)} / ${fmtNum(relayState.configured)}`, 'healthy / configured identity-pinned endpoints')}
        ${statItem('Difficulty', all.difficulty === null || all.difficulty === undefined ? '—' : esc(fmtNum(all.difficulty)), esc(all.difficultyAlgo === 'Sha256d' ? 'SHA-256d' : (all.difficultyAlgo || 'PoW')))}
      </section>

      <section class="stat-card">
        <h2>${day.windowComplete ? '24h statistics' : 'Indexed activity'}</h2>
        ${statItem('Transactions', fmtNum(day.transactions))}
        ${statItem('Transactions per second', fmtDecimal(day.transactionsPerSecond ?? 0, 4))}
        ${statItem('Blocks', fmtNum(day.blocks))}
        ${statItem('Volume', `${fmtCoin(day.volumeGrains)} ${COIN_SYMBOL}`, `transparent ${COIN_SYMBOL} volume`)}
        ${statItem('Miner tips', day.minerTipGrains === undefined ? '—' : `${fmtCoin(day.minerTipGrains)} ${COIN_SYMBOL}`, day.tippedTransactions ? `${fmtNum(day.tippedTransactions)} fee-auction tipped tx` : 'fee-auction tips in indexed window')}
        ${statItem('Hashrate', fmtHashrate(day.hashrate), day.hashrate == null ? 'measuring — needs a few blocks' : 'node estimate from recent block work (sov_getDifficulty)')}
        ${blockTimeStat(s.blockTime)}
        ${!day.windowComplete ? `<p class="stat-footnote">Building the recent window; values become a full 24h view after synchronization.</p>` : ''}
      </section>

      <section class="stat-card">
        <h2>Mempool &amp; fees</h2>
        ${statItem('Pending transactions', fmtNum(mempool.transactions), 'sov_getMempoolSize')}
        ${feeRouteStats(s)}
        ${statItem('Auction floor', '—', auctionFloorNote(s))}
        ${statItem('Block subsidy', s.mintRewardGrains == null ? '—' : `${fmtCoin(s.mintRewardGrains)} ${COIN_SYMBOL}`, s.mintRewardGrains == null ? 'not exposed by node' : 'next coinbase at this height (sov_getMintReward)')}
        ${statItem('Size', fmtBytes(mempool.sizeBytes), 'mempool bytes not exposed')}
      </section>
    </div>
    ${deploymentsPanel(s)}
    ${minerReadinessBoard(blocks100)}
    ${poolMigrationChart()}

    <div class="grid2">
      <div>
        <h2>Latest Blocks</h2>
        <div class="panel"><table><thead><tr><th>Height</th><th>Miner</th><th class="right">Txs</th><th class="right">Coinbase</th><th>Age</th><th></th></tr></thead>
        <tbody id="ov-blocks">${blocks.map(blockRow).join('') || emptyRow(6)}</tbody></table></div>
      </div>
      <div>
        <h2>Latest Transactions</h2>
        <div class="panel"><table><thead><tr><th>Tx</th><th>Type</th><th>Age</th><th>Signer</th><th class="right">Block</th></tr></thead>
        <tbody id="ov-txs">${txs.map(txRow).join('') || emptyRow(5)}</tbody></table></div>
      </div>
    </div>
  `, routeId);
  // Count the circulation figure up to its value (rolls on later re-renders).
  odometer($('ov-circulation'), all.circulationGrains, (g) => `${fmtCoin(String(Math.round(g)))} ${COIN_SYMBOL}`, 'ov-circulation');
  // Live: new blocks and txs stream into their tables in place.
  live.onBlock = (b) => livePrepend('ov-blocks', blockRow(b), 12);
  live.onTx = (t) => livePrepend('ov-txs', txRow({ ...t, timestampMs: t.timestampMs ?? Date.now() }), 12);
}

/** Why the mempool auction floor is a dash. The floor genuinely has no RPC, but the
 * reason must not assert the fee-auction's state when the node has not reported it —
 * during an outage `deployments` is null and nothing about activation is known. */
function auctionFloorNote(s) {
  const feeAuction = (s.deployments?.deployments ?? []).find((d) => d?.name === 'fee-auction');
  if (!feeAuction) return 'mempool tip floor is not exposed by the node RPC';
  return feeAuction.state === 'Active'
    ? 'fee-auction is active, but the mempool tip floor has no RPC — not estimated here'
    : `fee-auction is ${String(feeAuction.state).toLowerCase()}; the mempool tip floor has no RPC either way`;
}

/** Observed block spacing, measured from real header timestamps. The window and the
 * method are shown with the number; a window too small to yield an interval renders
 * as a dash, never as a zero or as the protocol target dressed up as a measurement. */
function blockTimeStat(bt) {
  if (!bt || bt.intervals === 0) {
    return statItem('Block time', '—', 'not enough retained headers to measure yet');
  }
  const target = bt.targetMs == null ? '' : ` · target ${fmtDuration(bt.targetMs)}`;
  const coverage = bt.complete
    ? `${fmtNum(bt.intervals)} intervals`
    : `${fmtNum(bt.intervals)} intervals (partial window)`;
  const skipped = bt.nonMonotonicIntervals
    ? ` · ${fmtNum(bt.nonMonotonicIntervals)} backwards header${bt.nonMonotonicIntervals === 1 ? '' : 's'} excluded`
    : '';
  return statItem(
    'Block time (median)',
    fmtDuration(bt.medianMs),
    `mean ${fmtDuration(bt.meanMs)}${target} · ${coverage} over #${fmtNum(bt.fromHeight)}–#${fmtNum(bt.toHeight)}${skipped}`,
  );
}

/** Every send route the node prices, each an exact runtime fee. Routes the node did
 * not price are simply not shown rather than rendered as a zero fee. */
function feeRouteStats(s) {
  const LABELS = {
    transfer: 'Transfer fee',
    tokenTransfer: 'Token transfer fee',
    shielded: 'Shielded fee',
  };
  const routes = s.feeRoutes ?? (s.fees ? { [s.fees.kind]: s.fees } : null);
  if (!routes || !Object.keys(routes).length) {
    return statItem('Transfer fee', '—', 'fee estimate not exposed by node');
  }
  return Object.entries(LABELS)
    .filter(([kind]) => routes[kind])
    .map(([kind, label]) => {
      const fee = routes[kind];
      return statItem(
        label,
        `${fmtCoin(fee.feeGrains)} ${COIN_SYMBOL}`,
        `exact runtime fee · gas ${fmtNum(fee.gasUsed)} × ${fmtNum(fee.gasPriceGrains)} grains`,
      );
    })
    .join('');
}

/** Badge for a BIP-9 deployment state, textual — never colour-only. */
function deploymentStateBadge(state) {
  const s = String(state ?? 'Unknown');
  const cls = s === 'Active' ? 'ok' : s === 'Failed' ? 'fail' : s === 'LockedIn' ? 'final' : 'pending';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

/** Earliest possible BIP-9 activation schedule for a deployment, derived purely
 * from the RPC-carried startHeight + period — never hardcoded per deployment. A
 * deployment can lock in no earlier than the first full period after its start,
 * and activates one period after lock-in, so:
 *   earliest lock-in  = startHeight + period
 *   earliest active   = startHeight + 2 × period
 * (e.g. shielded-v2: start 14,976, period 288 → lock-in 15,264 → active 15,552).
 * Returns null when the object lacks the fields. The word "earliest" is load-
 * bearing: real activation slips later if signaling misses the 90% threshold. */
function projectedActivation(d) {
  const start = Number(d?.startHeight);
  const period = Number(d?.period);
  if (!Number.isFinite(start) || !Number.isFinite(period) || period <= 0) return null;
  return { lockin: start + period, active: start + 2 * period };
}

/** Coarse "time remaining" for an activation countdown — seconds → days/hours/
 * minutes. fmtDuration tops out at minutes, which reads badly for the hundreds
 * of blocks (many hours) between BIP-9 milestones. */
function fmtEta(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return h > 0 ? `~${d}d ${h}h` : `~${d}d`;
  if (h > 0) return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  return `~${Math.max(1, m)}m`;
}

/** Top-row PQ-TX activation marker chips. The post-quantum shielded pool
 * ("shielded-v2", signal bit 2) arms via BIP-9; this surfaces its go-live as a
 * signal → lock-in → active chip strip whose heights are DERIVED from the
 * node-reported startHeight + period (see shieldedActivation). Past milestones
 * read as reached, the next carries a block countdown + ~ETA, and once Active it
 * collapses to a single "PQ TX LIVE" chip. Renders nothing when the node does
 * not report the deployment, so an older node degrades to no chips at all. */
function pqActivationChips(s) {
  const dep = (s.deployments?.deployments ?? []).find((d) => d?.name === 'shielded-v2');
  const head = s.deployments?.height ?? s.sync?.nodeHeight ?? s.tipHeight;
  const model = shieldedActivation(dep, head);
  if (!model) return '';

  if (model.active) {
    return `<span class="pq-pill live" title="The post-quantum shielded pool (shielded-v2, signal bit 2) is active — Action::ShieldedV2 spends are accepted.">PQ TX LIVE <b>since #${fmtNum(model.activeHeight)}</b></span>`;
  }

  const chips = model.milestones.map((m) => {
    const live = m.key === 'active' ? ' — PQ TX live' : '';
    if (m.reached) {
      return `<span class="pq-pill done" title="${esc(m.label + ' milestone reached')}">${esc(m.label)}${live} ✓ <b>#${fmtNum(m.height)}</b></span>`;
    }
    if (m.next) {
      let count;
      if (m.eligibleNow) {
        count = 'eligible — awaiting signaling';
      } else if (m.blocksRemaining !== undefined) {
        const eta = fmtEta(m.etaSeconds);
        count = `in ${fmtNum(m.blocksRemaining)} block${m.blocksRemaining === 1 ? '' : 's'}${eta ? ` · ${eta}` : ''}`;
      } else {
        count = 'next';
      }
      return `<span class="pq-pill next" title="Earliest ${esc(m.label)} at #${fmtNum(m.height)} (projected from startHeight + period; slips if signaling misses 90%).">${esc(m.label)}${live} <b>#${fmtNum(m.height)}</b> · ${esc(count)}</span>`;
    }
    return `<span class="pq-pill pending" title="Earliest ${esc(m.label)} at #${fmtNum(m.height)} (projected).">${esc(m.label)}${live} <b>#${fmtNum(m.height)}</b></span>`;
  }).join('');

  const label = model.failed
    ? `<span class="pq-pill lead failed" title="shielded-v2 signaling failed to reach threshold before timeout.">PQ TX · ${esc(model.state)}</span>`
    : `<span class="pq-pill lead" title="Post-quantum shielded pool (shielded-v2, signal bit 2) activation via BIP-9 miner signaling.">PQ TX</span>`;
  return label + chips;
}

/** Consensus deployments (BIP-9 miner signaling): states from sov_getDeployments
 * plus signaling observed in retained headers, with the observation window stated.
 * When the node does not expose deployment states, that is said outright. */
function deploymentsPanel(s) {
  const dep = s.deployments;
  if (!dep) {
    return `<h2>Consensus upgrades</h2><div class="panel"><p class="note" style="margin:12px">Deployment states are not exposed by the connected node (sov_getDeployments unavailable).</p></div>`;
  }
  const signaling = s.signaling;
  const rows = (dep.deployments ?? []).map((d) => {
    const observed = signaling && signaling.coveredBlocks > 0 && signaling.byBit?.[d.bit] !== undefined
      ? `${fmtNum(signaling.byBit[d.bit])}/${fmtNum(signaling.coveredBlocks)} recent headers (${fmtDecimal((signaling.byBit[d.bit] / signaling.coveredBlocks) * 100, 1)}%)`
      : 'no retained headers yet';
    const proj = projectedActivation(d);
    // Only meaningful before the outcome is settled; once Active/Failed the
    // projection is moot and would mislead.
    const projLine = proj && d.state !== 'Active' && d.state !== 'Failed'
      ? `<div class="dim" style="font-size:12px">earliest lock-in #${fmtNum(proj.lockin)} → active #${fmtNum(proj.active)}</div>`
      : '';
    return `<tr>
      <td><b>${esc(d.name)}</b>${projLine}</td>
      <td class="right num">${fmtNum(d.bit)}</td>
      <td>${deploymentStateBadge(d.state)}</td>
      <td class="right num">${fmtNum(d.startHeight)}</td>
      <td class="right num">${fmtNum(d.timeoutHeight)}</td>
      <td class="right num">${fmtNum(d.period)}</td>
      <td>${esc(observed)}</td>
    </tr>`;
  }).join('');
  return `
    <h2>Consensus upgrades <span class="dim">— BIP-9 miner signaling, evaluated by the node at height ${fmtNum(dep.height)}</span></h2>
    <div class="panel"><table><thead><tr><th>Deployment</th><th class="right">Bit</th><th>State</th><th class="right">Start</th><th class="right">Timeout</th><th class="right">Period</th><th>Header signaling observed</th></tr></thead>
    <tbody>${rows || emptyRow(7)}</tbody></table></div>
    ${signingDomainNote(s)}`;
}

/** The observable RUNTIME EFFECT of an activated tx-domain deployment: the exact
 * chain/genesis-bound tags every signature is now checked against. This is what
 * makes a transaction from another SOV network unreplayable here, and the node
 * reports it directly (sov_getSigningDomain) rather than it being inferred. */
function signingDomainNote(s) {
  const d = s.signingDomain;
  if (!d) return '';
  const state = d.active
    ? '<span class="badge ok">ENFORCED</span>'
    : '<span class="badge pending">NOT YET ENFORCED</span>';
  return `<p class="note">Transaction signing domain ${state} — signatures are bound to
    <code>${esc(d.chainId ?? '—')}</code> and genesis <code>${esc(shortHash(d.genesis, 10, 6))}</code>
    with tags <code>${esc(d.txTag ?? '—')}</code> / <code>${esc(d.intentTag ?? '—')}</code>.
    A transaction signed for a different Sovereign network cannot be replayed onto this one.</p>`;
}

function blockRow(b) {
  const coinbase = b.coinbase ? fmtCoin(b.coinbase.reward) + ' ' + COIN_SYMBOL : '<span class="dim">—</span>';
  // Finality shading: pending blocks (<6 confirmations) read dimmer with an amber
  // edge; they brighten with a green edge once the node reports them final.
  return `<tr class="blk-row ${b.final ? 'is-final' : 'is-pending'}"><td>${blockLink(b.height)}</td><td>${acctLinkShort(b.proposer)}</td><td class="right num">${fmtNum(b.txCount)}</td><td class="right num">${coinbase}</td><td class="dim" title="${esc(new Date(b.timestampMs).toLocaleString())}">${timeAgo(b.timestampMs)}</td><td>${finalBadge(b.final)}</td></tr>`;
}
function txRow(t) {
  return `<tr><td>${txLink(t.id)}</td><td>${actionBadge(t.action)}</td><td class="dim" title="${esc(new Date(t.timestampMs).toLocaleString())}">${timeAgo(t.timestampMs)}</td><td>${acctLinkShort(t.signer)}</td><td class="right">${blockLink(t.blockHeight)}</td></tr>`;
}
function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="empty">No data yet — waiting for blocks.</td></tr>`;
}

// A human date + time (local), e.g. "Jul 3, 2026, 04:24:19".
function fmtDateTime(ms) {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
// Relative age, e.g. "3m ago".
function fmtAge(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.max(0, Math.floor((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- transaction timing ---------------------------------------------------
// First-seen is an OBSERVATION, and the UI says so everywhere it is shown: it is
// the moment the node (or this explorer, polling the node's mempool) first saw the
// transaction, never a self-reported creation time. Two honest nodes can differ.
// A transaction nobody observed pending — which is every transaction mined before
// this shipped — shows "— / not observed" and is never given an estimated wait.
const FIRST_SEEN_TOOLTIP = 'When this node (or the explorer polling its mempool) FIRST OBSERVED this transaction. It is not a self-reported creation time, and different nodes can legitimately report different first-seen times.';
// A transaction that carries an `Action::Timestamped` envelope (v0.2.6, signal bit 3)
// declares its OWN creation time, and consensus refuses to include it unless that
// time falls inside a window anchored on the including block's timestamp. That is a
// stronger claim than any observation — every node enforced it — but it is still a
// BOUNDED time, not an exact attested instant, and the tooltip says exactly that.
const MADE_TOOLTIP = 'The creation time this transaction DECLARED, which consensus refused to include unless it fell inside a bounded window around the including block\'s timestamp (at most 2 minutes ahead, at most 30 minutes behind). Every node enforced the same bound, so unlike a first-seen observation this does not vary between nodes — but it is a bounded time, not a proof of the exact instant.';
const NOT_OBSERVED = `<span class="dim" title="Neither the node nor this explorer observed this transaction while it was pending, so its wait is unknown. It is never estimated.">— / not observed</span>`;

const timingSourceNote = (source) => (source === 'chain'
  ? 'declared by the transaction itself, bounded by consensus against the block\'s timestamp'
  : source === 'node'
    ? 'observed by the node itself (sov_getTxTiming)'
    : source === 'explorer'
      ? 'observed by this explorer polling the node\'s mempool'
      : 'not observed');

/** Wait, in seconds and in blocks, for a table cell. */
function waitCell(timing) {
  const t = timingSummary(timing);
  if (!t.observed || t.waitedMs === null) return NOT_OBSERVED;
  const blocks = t.waitedBlocks === null ? '' : ` <span class="dim">· ${fmtNum(t.waitedBlocks)} blk</span>`;
  return `<span title="${esc(timingSourceNote(t.source))}">${fmtDuration(t.waitedMs)}</span>${blocks}`;
}

/** The first-seen / confirmed / waited rows of the transaction detail table. */
function timingRows(timing, blockHeight, blockTimestampMs) {
  const t = timingSummary(timing);
  const confirmed = `${fmtDateTime(blockTimestampMs)} <span class="dim">— block #${fmtNum(blockHeight)}</span>`;
  if (!t.observed) {
    return `
      <tr><td class="k">First seen</td><td class="v" title="${esc(FIRST_SEEN_TOOLTIP)}">${NOT_OBSERVED}
        <span class="dim">— neither the node nor this explorer held this transaction in a mempool it was watching (it may have been mined before timing was recorded, or arrived inside a block synced from a peer).</span></td></tr>
      <tr><td class="k">Confirmed</td><td class="v">${confirmed}</td></tr>
      <tr><td class="k">Waited</td><td class="v">${NOT_OBSERVED}</td></tr>`;
  }
  const blocks = t.waitedBlocks === null
    ? '<span class="dim">— block count unavailable</span>'
    : `· <b>${fmtNum(t.waitedBlocks)}</b> block${t.waitedBlocks === 1 ? '' : 's'}`;
  // "Made" only when the transaction itself declared the time and consensus bounded
  // it; otherwise it stays the honest "First seen".
  const declared = t.source === 'chain';
  const label = declared ? 'Made' : 'First seen';
  const tooltip = declared ? MADE_TOOLTIP : FIRST_SEEN_TOOLTIP;
  const from = declared
    ? 'from the declared (consensus-bounded) creation time to the including block\'s header timestamp'
    : 'from first observation to the including block\'s header timestamp';
  return `
    <tr><td class="k">${label}</td><td class="v" title="${esc(tooltip)}">${fmtDateTime(t.firstSeenMs)}
      <span class="dim">(${fmtAge(t.firstSeenMs)})${t.firstSeenHeight === null ? '' : ` · chain height #${fmtNum(t.firstSeenHeight)}`} — ${esc(timingSourceNote(t.source))}</span></td></tr>
    <tr><td class="k">Confirmed</td><td class="v">${confirmed}</td></tr>
    <tr><td class="k">Waited</td><td class="v"><b>${fmtDecimal((t.waitedMs ?? 0) / 1000, 1)}</b> s ${blocks}
      <span class="dim">— ${esc(from)}</span></td></tr>`;
}

const PAGE_SIZE = 50;

async function renderBlocks(before, routeId) {
  setView('<div class="loading">Loading blocks…</div>', routeId);
  const cursor = before !== undefined && before !== '' ? Number(before) : null;
  const qs = `?limit=${PAGE_SIZE}` + (cursor !== null ? `&before=${cursor}` : '');
  let blocks, tip;
  try {
    const [status, list] = await Promise.all([api('/status'), api('/blocks' + qs)]);
    tip = Math.max(0, status.tipHeight);
    blocks = list;
  } catch (e) {
    return errView(e.message, routeId);
  }
  const highest = blocks.length ? blocks[0].height : 0;
  const lowest = blocks.length ? blocks[blocks.length - 1].height : 0;
  const hasNewer = cursor !== null && highest < tip; // blocks exist above this page
  const hasOlder = lowest > 0; // genesis (0) not yet on the page

  const btn = (href, label, on) =>
    on
      ? `<a class="pager-btn" href="${href}">${label}</a>`
      : `<span class="pager-btn is-disabled">${label}</span>`;
  const newerHref = highest + PAGE_SIZE >= tip ? '#/blocks' : `#/blocks/${highest + PAGE_SIZE}`;
  const pager = `<div class="pager">
    ${btn('#/blocks', '⏮ Latest', hasNewer)}
    ${btn(newerHref, '◀ Newer', hasNewer)}
    <span class="pager-info">${blocks.length ? `#${fmtNum(lowest)} – #${fmtNum(highest)}` : '—'} of ${fmtNum(tip)}</span>
    ${btn(`#/blocks/${lowest - 1}`, 'Older ▶', hasOlder)}
    ${btn(`#/blocks/${PAGE_SIZE - 1}`, 'Genesis ⏭', hasOlder)}
  </div>`;

  const committed = setView(`
    <h1>Blocks</h1>
    ${pager}
    <div class="panel"><table><thead><tr><th>Height</th><th>Hash</th><th>Miner</th><th class="right">Txs</th><th class="right">Coinbase</th><th>Date &amp; time</th><th class="right">Age</th><th></th></tr></thead>
    <tbody id="blocks-tbody">${blocks.map(blocksListRow).join('') || emptyRow(8)}</tbody></table></div>
    ${pager}
  `, routeId);
  if (!committed) return;
  window.__sovExport = { name: `${NET}-blocks-${cursor ?? 'latest'}`, rows: blocks };
  $('export-tools').hidden = false;
  view.dataset.tipHeight = String(highest);
  // Live: on the latest page (no cursor), new blocks stream in at the top.
  if (cursor === null) {
    live.onBlock = () => route().catch((e) => errView(e.message));
  }
}

function blocksListRow(b) {
  return `<tr class="blk-row ${b.final ? 'is-final' : 'is-pending'}">
    <td>${blockLink(b.height)}</td>
    <td>${blockHashLink(b.hash)}</td>
    <td>${b.proposer ? acctLinkShort(b.proposer) : '<span class="dim">genesis</span>'}</td>
    <td class="right num">${fmtNum(b.txCount)}</td>
    <td class="right num">${b.coinbase ? fmtCoin(b.coinbase.reward) + ' ' + COIN_SYMBOL : '<span class="dim">—</span>'}</td>
    <td class="time" title="${new Date(Number(b.timestampMs)).toISOString?.() || ''} · ${esc(b.timestampMs)} ms">${fmtDateTime(b.timestampMs)}</td>
    <td class="right dim">${fmtAge(b.timestampMs)}</td>
    <td>${finalBadge(b.final)}</td></tr>`;
}

const TX_ACTION_TYPES = [
  'transfer', 'tipped', 'token_issue', 'token_transfer', 'token_burn', 'shielded',
  'htlc_lock', 'htlc_claim', 'htlc_refund', 'call', 'deploy',
  'claim_vesting', 'register_name', 'transfer_name', 'nft_mint',
  'nft_transfer', 'nft_set_meta', 'set_multisig', 'multisig_exec',
  'propose_multisig', 'approve_multisig', 'cancel_multisig',
  'vault_deposit', 'vault_mint', 'vault_burn', 'vault_withdraw', 'oracle_update',
  'rotate_key', 'intent_settle', 'intent_cancel', 'token_set_policy',
];

function transactionListRow(tx) {
  const status = tx.executionStatus
    ? `<span class="badge ${tx.executionStatus === 'success' ? 'ok' : 'fail'}">${esc(tx.executionStatus)}</span>`
    : '<span class="dim">—</span>';
  return `<tr><td>${txLink(tx.id)}</td><td>${actionBadge(tx.action)}</td><td>${status}</td><td>${acctLinkShort(tx.signer)}</td><td>${actionSummary(tx.action)}</td><td>${blockLink(tx.blockHeight)}</td><td>${waitCell(tx.timing)}</td><td class="time">${fmtDateTime(tx.timestampMs)}</td></tr>`;
}

async function renderTransactions(params, routeId) {
  setView('<div class="loading">Loading transactions…</div>', routeId);
  const query = new URLSearchParams(params);
  query.set('limit', '50');
  const page = await api(`/transactions?${query}`);
  const items = page.items ?? [];
  const selected = (name, value) => query.get(name) === value ? ' selected' : '';
  const filterValue = (name) => esc(query.get(name) ?? '');
  const next = page.nextCursor
    ? `<a class="pager-btn" href="#/transactions?${new URLSearchParams({ ...Object.fromEntries(query), cursor: page.nextCursor, limit: '50' })}">Older ▶</a>`
    : '<span class="pager-btn is-disabled">Older ▶</span>';
  const committed = setView(`
    <h1>Transactions</h1>
    <form class="tx-filters panel" id="tx-filters">
      <label>Action<select name="action"><option value="">All actions</option>${TX_ACTION_TYPES.map((type) => `<option value="${type}"${selected('action', type)}>${esc(type)}</option>`).join('')}</select></label>
      <label>Status<select name="status"><option value="">Any status</option><option value="success"${selected('status', 'success')}>Success</option><option value="failed"${selected('status', 'failed')}>Failed</option></select></label>
      <label>Account<input name="account" value="${filterValue('account')}" placeholder="account or name" /></label>
      <label>From block<input name="minHeight" type="number" min="0" value="${filterValue('minHeight')}" /></label>
      <label>To block<input name="maxHeight" type="number" min="0" value="${filterValue('maxHeight')}" /></label>
      <label>From date<input name="fromDate" type="date" /></label>
      <label>To date<input name="toDate" type="date" /></label>
      <button type="submit">Apply filters</button><a class="pager-btn" href="#/transactions">Clear</a>
    </form>
    <div class="panel"><table><thead><tr><th>Tx</th><th>Action</th><th>Status</th><th>Signer</th><th>Detail</th><th>Block</th><th title="${esc(FIRST_SEEN_TOOLTIP)}">Waited</th><th>Date</th></tr></thead><tbody>${items.map(transactionListRow).join('') || emptyRow(8)}</tbody></table></div>
    <div class="pager"><span class="pager-info">${page.historyComplete ? 'Complete archived history' : 'Indexed history only'}</span>${next}</div>
  `, routeId);
  if (!committed) return;
  window.__sovExport = { name: `${NET}-transactions`, rows: items };
  $('export-tools').hidden = false;
  const form = $('tx-filters');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const out = new URLSearchParams();
    for (const name of ['action', 'status', 'account', 'minHeight', 'maxHeight']) {
      const value = String(values.get(name) ?? '').trim();
      if (value) out.set(name, value);
    }
    const fromDate = String(values.get('fromDate') ?? '');
    const toDate = String(values.get('toDate') ?? '');
    if (fromDate) out.set('fromMs', String(new Date(`${fromDate}T00:00:00Z`).getTime()));
    if (toDate) out.set('toMs', String(new Date(`${toDate}T23:59:59.999Z`).getTime()));
    location.hash = `#/transactions${out.size ? `?${out}` : ''}`;
  });
}

const OBJECT_KINDS = ['token', 'nft', 'contract', 'htlc'];
const OBJECT_LABELS = { token: 'Tokens', nft: 'NFTs', contract: 'Contracts', htlc: 'HTLCs' };

function catalogRow(kind, item) {
  if (kind === 'token') return `<tr><td>${objectLink(kind, item.id, item.symbol || shortHash(item.id))}</td><td>${acctLinkShort(item.issuer)}</td><td class="right num">${fmtCoin(item.supply)}</td><td class="right num">${fmtCoin(item.burned)}</td></tr>`;
  if (kind === 'nft') return `<tr><td>${objectLink(kind, item.id, item.tokenText || shortHash(item.tokenId, 10, 6))}</td><td>${objectLink('nft', item.id, shortHash(item.collection, 8, 6))}</td><td>${acctLinkShort(item.owner)}</td><td class="right">#${fmtNum(item.mintedHeight)}</td></tr>`;
  return `<tr><td>${objectLink(kind, item.id)}</td><td>${item.status ? `<span class="badge act">${esc(item.status)}</span>` : '<span class="dim">—</span>'}</td><td>${item.owner ? acctLinkShort(item.owner) : '<span class="dim">—</span>'}</td><td class="right">${blockLink(item.updatedHeight ?? item.blockHeight)}</td></tr>`;
}

function catalogTable(kind, items) {
  const headings = kind === 'token'
    ? '<th>Symbol / asset</th><th>Issuer</th><th class="right">Supply</th><th class="right">Burned</th>'
    : kind === 'nft'
      ? '<th>Token</th><th>Collection</th><th>Owner</th><th class="right">Minted</th>'
      : '<th>Object</th><th>Status</th><th>Owner</th><th class="right">Latest block</th>';
  return `<div class="panel"><table><thead><tr>${headings}</tr></thead><tbody>${items.map((item) => catalogRow(kind, item)).join('') || emptyRow(4)}</tbody></table></div>`;
}

async function renderAssets(params, routeId) {
  setView('<div class="loading">Loading chain objects…</div>', routeId);
  const selected = params.get('kind');
  const kind = OBJECT_KINDS.includes(selected) ? selected : null;
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  if (kind) {
    const page = await api(`/catalog?kind=${kind}&offset=${offset}&limit=50`);
    const newer = offset > 0 ? `<a class="pager-btn" href="#/assets?kind=${kind}&offset=${Math.max(0, offset - 50)}">◀ Newer</a>` : '<span class="pager-btn is-disabled">◀ Newer</span>';
    const older = page.hasMore ? `<a class="pager-btn" href="#/assets?kind=${kind}&offset=${offset + 50}">Older ▶</a>` : '<span class="pager-btn is-disabled">Older ▶</span>';
    const committed = setView(`
      <div class="crumb"><a href="#/assets">Assets</a> / ${OBJECT_LABELS[kind]}</div>
      <h1>${OBJECT_LABELS[kind]}</h1>
      ${catalogTable(kind, page.items ?? [])}
      <div class="pager">${newer}<span class="pager-info">${fmtNum(offset + 1)}–${fmtNum(offset + (page.items?.length ?? 0))}</span>${older}</div>
    `, routeId);
    if (committed) {
      window.__sovExport = { name: `${NET}-${kind}-${offset}`, rows: page.items ?? [] };
      $('export-tools').hidden = false;
    }
    return;
  }
  const pages = await Promise.all(OBJECT_KINDS.map((itemKind) => api(`/catalog?kind=${itemKind}&limit=5`)));
  setView(`
    <h1>Assets &amp; chain objects</h1>
    <p class="note">Authoritative token and NFT state comes from the live node; archived activity, contracts, events, and completed HTLC status come from the complete explorer index.</p>
    <div class="object-summary">${OBJECT_KINDS.map((itemKind, index) => `<section><div class="section-heading"><h2>${OBJECT_LABELS[itemKind]}</h2><a href="#/assets?kind=${itemKind}">Browse all</a></div>${catalogTable(itemKind, pages[index].items ?? [])}</section>`).join('')}</div>
  `, routeId);
}

function objectActivityTable(activity) {
  return `<div class="panel"><table><thead><tr><th>Tx</th><th>Action</th><th>Signer</th><th>Detail</th><th class="right">Block</th></tr></thead><tbody>${activity.map((tx) => `<tr><td>${txLink(tx.id)}</td><td>${actionBadge(tx.action)}</td><td>${acctLinkShort(tx.signer)}</td><td>${actionSummary(tx.action)}</td><td class="right">${blockLink(tx.blockHeight)}</td></tr>`).join('') || emptyRow(5)}</tbody></table></div>`;
}

function objectFields(data) {
  const state = data.state ?? {};
  if (data.kind === 'token') return [
    ['Asset', data.id], ['Symbol', state.symbol], ['Issuer', state.issuer],
    ['Current supply', state.supply === undefined ? null : `${fmtCoin(state.supply)} units`],
    ['Total issued', state.issued === undefined ? null : `${fmtCoin(state.issued)} units`],
    ['Total burned', state.burned === undefined ? null : `${fmtCoin(state.burned)} units`],
  ];
  if (data.kind === 'nft') return [
    ['Collection', data.collection], ['Token ID', data.tokenId], ['Readable token', state.tokenText],
    ['Owner', state.owner], ['Collection symbol', data.collectionState?.symbol],
    ['Collection issuer', data.collectionState?.issuer], ['Minted height', state.mintedHeight],
    ['Metadata', state.metadata === undefined ? null : JSON.stringify(state.metadata)],
  ];
  if (data.kind === 'contract') return [
    ['Contract account', data.id], ['Status', data.indexed?.status ?? (state.code ? 'deployed' : null)],
    ['Balance', state.balance === undefined ? null : `${fmtCoin(state.balance)} ${COIN_SYMBOL}`],
    ['Nonce', state.nonce], ['WASM size', state.code ? fmtBytes(state.code.length) : null],
  ];
  const lock = state && Object.keys(state).length ? state : data.indexed?.creation?.action ?? {};
  return [
    ['HTLC ID', data.id], ['Status', data.status], ['Locker', lock.locker ?? data.indexed?.owner],
    ['Recipient', lock.recipient], ['Amount', lock.amount === undefined ? null : `${fmtCoin(lock.amount)} ${COIN_SYMBOL}`],
    ['Hashlock', Array.isArray(lock.hashlock) ? bytesHex(lock.hashlock) : lock.hashlock], ['Timeout height', lock.timeoutHeight ?? lock.timeout_height],
  ];
}

async function renderObject(kindRaw, idRaw, routeId) {
  const kind = decodeURIComponent(kindRaw ?? '');
  const id = decodeURIComponent(idRaw ?? '');
  setView('<div class="loading">Loading chain object…</div>', routeId);
  let data;
  try {
    data = await api(`/object/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  } catch (error) {
    return renderNotFound(`The ${kind || 'chain'} object “${shortHash(id)}” was not found.`, routeId);
  }
  setPageMeta(`${data.state?.symbol || data.state?.tokenText || kind} ${shortHash(id)}`, `${kind} detail and complete archived activity on Sovereign.`);
  const fields = objectFields(data).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const events = data.events ?? data.indexed?.events ?? [];
  const activity = data.activity ?? [];
  const committed = setView(`
    <div class="crumb"><a href="#/assets">Assets</a> / <a href="#/assets?kind=${encodeURIComponent(kind)}">${esc(OBJECT_LABELS[kind] ?? kind)}</a></div>
    <h1>${esc((data.state?.symbol || data.state?.tokenText || OBJECT_LABELS[kind]?.slice(0, -1) || kind))} <span class="badge act">${esc(kind)}</span></h1>
    <div class="panel"><table class="kv">${fields.map(([label, value]) => `<tr><td class="k">${esc(label)}</td><td class="v mono break">${esc(value)} ${copyButton(value, label)}</td></tr>`).join('')}</table></div>
    <h2>Archived activity</h2>
    ${objectActivityTable(activity)}
    ${events.length ? `<h2>Contract events</h2><div class="panel"><table><thead><tr><th>Tx</th><th>Block</th><th>Topic</th><th>Data</th></tr></thead><tbody>${events.map((event) => `<tr><td>${txLink(event.txId)}</td><td>${blockLink(event.blockHeight)}</td><td class="mono break">${esc(JSON.stringify(event.topic))}</td><td class="mono break">${esc(JSON.stringify(event.data))}</td></tr>`).join('')}</tbody></table></div>` : ''}
  `, routeId);
  if (committed) {
    window.__sovExport = { name: `${NET}-${kind}-${id}`, rows: activity };
    $('export-tools').hidden = false;
  }
}

async function renderBlock(ref, routeId) {
  setView('<div class="loading">Loading block…</div>', routeId);
  let b;
  try {
    b = await api('/block/' + encodeURIComponent(ref));
  } catch (e) {
    return errView(e.message, routeId);
  }
  setPageMeta(`Block #${b.height}`, `Sovereign block #${b.height}, ${b.txCount} transactions, roots, miner, and finality.`);
  const txs = b.transactions || [];
  setView(`
    <div class="crumb"><a href="#/blocks">Blocks</a> / Block #${fmtNum(b.height)}</div>
    <h1>Block #${fmtNum(b.height)} ${finalBadge(b.final)}</h1>
    <div class="panel"><table class="kv">
      <tr><td class="k">Hash</td><td class="v">${copyable(b.hash, 'block hash')} ${copyButton(b.hash, 'block hash')}</td></tr>
      <tr><td class="k">Parent</td><td class="v">${b.height > 0 ? blockHashLink(b.prevHash) : '<span class="dim">genesis</span>'}</td></tr>
      <tr><td class="k">Miner</td><td class="v">${acctLink(b.proposer)}</td></tr>
      <tr><td class="k">Timestamp</td><td class="v">${new Date(b.timestampMs).toLocaleString()} <span class="dim">(${esc(b.timestampMs)} ms)</span></td></tr>
      <tr><td class="k">Transactions</td><td class="v">${fmtNum(b.txCount)}</td></tr>
      <tr><td class="k">State root</td><td class="v">${esc(b.stateRoot)} ${copyButton(b.stateRoot, 'state root')}</td></tr>
      <tr><td class="k">Tx root</td><td class="v">${esc(b.txRoot)} ${emptyRootBadge(b.txCount === 0)} ${copyButton(b.txRoot, 'transaction root')}</td></tr>
      <tr><td class="k">Receipts root</td><td class="v">${esc(b.receiptsRoot)} ${emptyRootBadge(b.txCount === 0)} ${copyButton(b.receiptsRoot, 'receipts root')}</td></tr>
      ${versionBitsRow(b.versionBits)}
      ${b.bits !== null && b.bits !== undefined ? `<tr><td class="k">Difficulty bits</td><td class="v mono">${fmtNum(b.bits)} <span class="dim">(compact PoW target, 0x${Number(b.bits).toString(16)})</span></td></tr>` : ''}
      ${b.nonce !== null && b.nonce !== undefined ? `<tr><td class="k">Nonce</td><td class="v mono">${fmtNum(b.nonce)}</td></tr>` : ''}
      <tr><td class="k">Finality</td><td class="v">${b.final ? 'Final — buried past the Nakamoto confirmation depth' : 'Pending — waiting for more confirmations'}</td></tr>
    </table></div>
    ${coinbasePanel(b.coinbase)}
    <h2>Transactions</h2>
    <div class="panel"><table><thead><tr><th>Tx</th><th>Type</th><th>Signer</th><th>Detail</th></tr></thead>
    <tbody>${txs.map((t) => `<tr><td>${txLink(t.id)}</td><td>${actionBadge(t.action)}</td><td>${acctLinkShort(t.signer)}</td><td>${actionSummary(t.action)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
  `, routeId);
}

/** The header's BIP-9 signal word with per-deployment bit decode (from the last
 * polled /status deployments; raw value is always shown). Blocks indexed before
 * the explorer retained this field render as "not retained", not as zero. */
function versionBitsRow(versionBits) {
  if (versionBits === null || versionBits === undefined) {
    return `<tr><td class="k">Version bits</td><td class="v dim">not retained for this block (re-indexed data will include the header's signal word)</td></tr>`;
  }
  const vb = Number(versionBits);
  const deployments = LAST_STATUS?.deployments?.deployments ?? [];
  const set = deployments
    .filter((d) => Number.isInteger(Number(d.bit)) && ((vb >>> Number(d.bit)) & 1))
    .map((d) => `bit ${fmtNum(d.bit)} · ${esc(d.name)}`);
  const detail = deployments.length
    ? (set.length ? `signaling ${set.join(', ')}` : 'no known deployment bits set')
    : 'deployment names unavailable';
  return `<tr><td class="k">Version bits</td><td class="v mono">${fmtNum(vb)} <span class="dim">(0b${vb.toString(2)}) — ${detail}</span></td></tr>`;
}

/** Human label for a coinbase recipient's role. */
function coinbaseRole(role) {
  return (
    { miner: 'Miner (proof-of-work)', 'founder-tax': 'Founder tax', 'dev-tax': 'Dev tax' }[role] ||
    esc(role)
  );
}

/** The Coinbase panel: a block's real issuance — the minted subsidy and its
 * miner / founder-tax / dev-tax split. Shown for every mined block (genesis
 * mints nothing, so it has no coinbase). */
function coinbasePanel(cb) {
  if (!cb) return '';
  const reward = Number(cb.reward) || 0;
  const rows = (cb.recipients || [])
    .map((r) => {
      const share = reward > 0 ? ((Number(r.amount) / reward) * 100).toFixed(0) : '0';
      return `<tr><td>${acctLink(r.account)}</td><td>${coinbaseRole(r.role)} <span class="dim">${share}%</span></td><td>${fmtCoin(r.amount)} ${COIN_SYMBOL}</td></tr>`;
    })
    .join('');
  return `
    <h2>Coinbase <span class="dim">— newly minted this block</span></h2>
    <div class="panel"><table class="kv">
      <tr><td class="k">Subsidy minted</td><td class="v">${fmtCoin(cb.reward)} ${COIN_SYMBOL}</td></tr>
    </table></div>
    <div class="panel"><table><thead><tr><th>Recipient</th><th>Share</th><th>Amount</th></tr></thead>
    <tbody>${rows || emptyRow(3)}</tbody></table></div>`;
}

/** The XUS value a transaction moves, when its action carries one. A fee-auction
 * `tipped` envelope moves its inner action's value (the tip is shown separately). */
function actionValue(action) {
  if (!action) return null;
  switch (action.type) {
    case 'transfer':
    case 'htlc_lock':
      return action.amount;
    case 'tipped':
      return action.inner ? actionValue(action.inner) : null;
    default:
      return null;
  }
}

/** Execution outcome badge + detail, from the node's receipt (null = unavailable).
 * The node serializes the status as a tagged object: {status:"success"} or
 * {status:"failed", reason:"…"}. */
function receiptStatus(r) {
  if (!r) return `<span class="badge pending">Unknown</span> <span class="dim">receipt unavailable (node did not return one)</span>`;
  const s = r.status?.status ?? r.status;
  if (s === 'success') return `<span class="badge ok">✓ Success</span>`;
  return `<span class="badge fail">✗ Failed</span> — ${esc(r.status?.reason || 'execution rejected')}`;
}

/** Render event bytes (serde Vec<u8> → number array) as UTF-8 when printable, else hex. */
function fmtEventBytes(bytes) {
  if (!Array.isArray(bytes) || !bytes.length) return '<span class="dim">—</span>';
  const shown = bytes.slice(0, 4096);
  const suffix = bytes.length > shown.length ? `… (${fmtBytes(bytes.length)} total)` : '';
  const printable = shown.every((b) => b >= 32 && b < 127);
  if (printable) return esc(new TextDecoder().decode(Uint8Array.from(shown))) + esc(suffix);
  return '0x' + shown.map((b) => b.toString(16).padStart(2, '0')).join('') + esc(suffix);
}

/** Pretty-print an action for the Raw panel: byte arrays (serde Vec<u8> — e.g. a
 * shielded bundle or WASM code) become compact hex strings instead of thousands
 * of JSON numbers, one per line. */
function fmtActionJson(action) {
  const compact = (v) => {
    if (Array.isArray(v) && v.length > 8 && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      const shown = v.slice(0, 8192);
      const suffix = v.length > shown.length ? `… truncated; ${fmtBytes(v.length)} total` : ` (${fmtBytes(v.length)})`;
      return `0x${shown.map((b) => b.toString(16).padStart(2, '0')).join('')}${suffix}`;
    }
    if (Array.isArray(v)) return v.map(compact);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)]));
    return v;
  };
  return JSON.stringify(compact(action), null, 2);
}

/** A long raw hex blob (hybrid PQ keys/signatures run to kilobytes) shown
 * abbreviated with a click-to-expand full value. */
function rawBlob(value) {
  const v = String(value ?? '');
  if (v.length <= 80) return esc(v);
  return `<details class="raw"><summary class="mono">${esc(shortHash(v, 26, 12))} · ${fmtBytes(Math.floor(v.replace(/^.*?0x/, '').length / 2))} — expand</summary><pre class="mono">${esc(v)}</pre></details>`;
}

async function renderTx(id, routeId) {
  setView('<div class="loading">Loading transaction…</div>', routeId);
  let t;
  let capabilities = null;
  try {
    const res = await fetch('/api/' + NET + '/tx/' + encodeURIComponent(id));
    const body = await res.json();
    if (!res.ok) {
      const apiError = typeof body.error === 'object' ? body.error : null;
      // A just-submitted transaction has no receipt yet — show a live waiting
      // state and re-check every 5s while this page stays open, so the payout
      // link a wallet/faucet hands out "just works" once the block lands.
      if (body.pending || apiError?.details?.pending) {
        const here = location.hash;
        setTimeout(() => { if (location.hash === here) route(); }, 5000);
        // The pending wait counts up from a REAL first-seen observation (the node's
        // mempool, polled by this explorer). Without one, no waiting time is shown —
        // an unobserved pending transaction is not given an invented start.
        const details = apiError?.details ?? body;
        const firstSeenMs = Number(details.firstSeenMs);
        const waiting = Number.isFinite(firstSeenMs)
          ? `<b>pending — waiting ${fmtDecimal(Math.max(0, Date.now() - firstSeenMs) / 1000, 0)}s</b>
             <span class="dim">— since first seen ${fmtDateTime(firstSeenMs)}${details.state ? ` · mempool state: ${esc(details.state)}` : ''}</span>`
          : `<b>pending</b> ${NOT_OBSERVED} <span class="dim">— this explorer has no first-seen observation for it${details.inMempool ? '' : ', and the node is not holding it in a mempool the explorer can read'}.</span>`;
        return setView(`
          <div class="crumb">Transaction</div>
          <h1>Waiting to be mined… <span class="badge pending">Pending</span></h1>
          <div class="panel"><table class="kv">
            <tr><td class="k">Id</td><td class="v">${esc(id)}</td></tr>
            <tr><td class="k">Status</td><td class="v">Not in a block yet — mainnet targets a block every 2.5 minutes. This page checks again automatically every few seconds.</td></tr>
            <tr><td class="k" title="${esc(FIRST_SEEN_TOOLTIP)}">Waiting</td><td class="v">${waiting}</td></tr>
          </table></div>
        `, routeId);
      }
      throw new Error(apiError?.message || body.error || `HTTP ${res.status}`);
    }
    t = body;
    capabilities = await api('/capabilities').catch(() => null);
  } catch (e) {
    return errView(e.message, routeId);
  }
  setPageMeta(`Transaction ${shortHash(t.id)}`, `${t.action?.type || 'Transaction'} in Sovereign block #${t.blockHeight}.`);
  const r = t.receipt;
  const value = actionValue(t.action);
  const events = r?.events || [];
  const returnData = r?.return_data || r?.returnData || [];
  setView(`
    <div class="crumb">Transaction</div>
    <h1>Transaction ${actionBadge(t.action)} ${finalBadge(t.final)}</h1>
    <div class="panel"><table class="kv">
      <tr><td class="k">Id</td><td class="v">${copyable(t.id, 'transaction id')} ${copyButton(t.id, 'transaction id')}</td></tr>
      <tr><td class="k">Status</td><td class="v">${receiptStatus(r)}</td></tr>
      <tr><td class="k">Block</td><td class="v">${blockLink(t.blockHeight)} · ${blockHashLink(t.blockHash)}</td></tr>
      <tr><td class="k">Confirmations</td><td class="v">${fmtNum(t.confirmations)} ${t.final ? '<span class="dim">— final (buried past the 6-confirmation Nakamoto depth)</span>' : '<span class="dim">— pending finality (6 required)</span>'}</td></tr>
      <tr><td class="k">Position</td><td class="v">#${t.index} in block</td></tr>
      <tr><td class="k">Timestamp</td><td class="v">${new Date(t.timestampMs).toLocaleString()} <span class="dim">(${timeAgo(t.timestampMs)})</span></td></tr>
      ${timingRows(t.timing, t.blockHeight, t.timestampMs)}
      <tr><td class="k">Signer</td><td class="v">${acctLink(t.signer)}</td></tr>
      <tr><td class="k">Nonce</td><td class="v">${fmtNum(t.nonce)}</td></tr>
      <tr><td class="k">Action</td><td class="v">${esc(t.action?.type)} — ${actionSummary(t.action)}</td></tr>
      ${value !== null ? `<tr><td class="k">Value</td><td class="v"><b>${fmtCoin(value)}</b> ${COIN_SYMBOL}</td></tr>` : ''}
      ${t.action?.type === 'tipped' ? `<tr><td class="k">Miner tip</td><td class="v"><b>${fmtCoin(t.action.tip)}</b> ${COIN_SYMBOL} <span class="dim">— fee-auction priority bid paid to this block's miner on top of the intrinsic fee</span></td></tr>` : ''}
      ${t.action?.type === 'shielded_v2' ? `<tr><td class="k">Privacy</td><td class="v">pool-v2 (post-quantum) shielded spend <span class="dim">— ML-KEM-768 + STARK. The ${fmtBytes((t.action.bundle || []).length)} bundle carries the nullifiers, commitments and proof; amounts and parties stay private, only the bundle size is public.</span></td></tr>` : ''}
      ${r ? `<tr><td class="k">Gas used</td><td class="v">${fmtNum(r.gas_used ?? r.gasUsed ?? 0)}</td></tr>` : ''}
      <tr><td class="k">Public key</td><td class="v">${rawBlob(t.publicKey)}</td></tr>
      <tr><td class="k">Signature</td><td class="v">${rawBlob(t.signature)}</td></tr>
    </table></div>
    ${events.length ? `
    <h2>Events <span class="dim">— emitted during execution, committed under the receipts root</span></h2>
    <div class="panel"><table><thead><tr><th>#</th><th>Topic</th><th>Data</th></tr></thead>
    <tbody>${events.map((ev, i) => `<tr><td class="num">${i}</td><td class="mono">${fmtEventBytes(ev.topic)}</td><td class="mono">${fmtEventBytes(ev.data)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${Array.isArray(returnData) && returnData.length ? `
    <h2>Return data</h2>
    <div class="panel"><pre class="mono" style="margin:0;overflow-wrap:anywhere;white-space:pre-wrap">${fmtEventBytes(returnData)}</pre></div>` : ''}
    <div class="panel action-explainer"><b>What this action does</b><p>${esc(explainAction(t.action))}</p></div>
    <h2>Portable inclusion evidence</h2>
    ${capabilities?.proofs?.browserVerifiable
      ? `<div class="panel proof-check" data-proof-id="${encodeURIComponent(t.id)}"><button type="button" class="proof-verify">Request and verify proofs</button><span class="proof-result dim"> Relay proof methods and browser algorithm are supported.</span></div>`
      : `<div class="panel proof-check unavailable"><span class="badge pending">Unavailable</span><span class="dim">${capabilities?.proofs?.transaction || capabilities?.proofs?.receipt ? `Relay proofs use ${esc(capabilities.proofs.algorithms.join(', ') || 'an unsupported algorithm')}; browser verification is disabled.` : 'The configured relays do not expose transaction and receipt proof methods.'}</span></div>`}
    <h2>Raw action</h2>
    <div class="panel"><details class="raw" open><summary>decoded action payload (as indexed from the block)</summary><pre class="mono">${esc(fmtActionJson(t.action))}</pre></details></div>
  `, routeId);
}

async function renderAccount(idRaw, params, routeId) {
  const id = decodeURIComponent(idRaw);
  setView('<div class="loading">Loading account…</div>', routeId);
  let data;
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (params.get('cursor')) query.set('cursor', params.get('cursor'));
    data = await api(`/account/${encodeURIComponent(id)}?${query}`);
  } catch (e) {
    return errView(e.message, routeId);
  }
  const a = data.account;
  const acct = data.id || id; // the resolved account (if `id` was an SNS name)
  setPageMeta(`Account ${shortHash(acct, 10, 8)}`, `Sovereign account balance, holdings, names, and complete paginated transaction history.`);
  const txs = data.transactions || [];
  const names = data.names || [];
  const tokenBalances = data.tokenBalances || [];
  const nfts = data.nfts || [];
  const accountBase = `#/account/${encodeURIComponent(id)}`;
  const accountPager = `<div class="pager"><a class="pager-btn${params.get('cursor') ? '' : ' is-disabled'}" href="${accountBase}">⏮ Latest</a><span class="pager-info">${data.historyComplete ? 'Complete archived history' : 'Indexed history only'}</span>${data.nextCursor ? `<a class="pager-btn" href="${accountBase}?cursor=${encodeURIComponent(data.nextCursor)}">Older ▶</a>` : '<span class="pager-btn is-disabled">Older ▶</span>'}</div>`;
  const locked = a?.locked ?? '0';
  const kv = a
    ? `
      <tr><td class="k">Liquid balance</td><td class="v">${fmtCoin(a.balance)} ${COIN_SYMBOL}</td></tr>
      <tr><td class="k">Locked (vesting)</td><td class="v">${fmtCoin(locked)} ${COIN_SYMBOL} ${locked !== '0' && a.unlock_height !== undefined ? `<span class="dim">(unlocks at height ${fmtNum(a.unlock_height)})</span>` : ''}</td></tr>
      <tr><td class="k">Nonce</td><td class="v">${fmtNum(a.nonce)}</td></tr>
      <tr><td class="k">Key</td><td class="v">${a.key ? esc(a.key) : '<span class="dim">none (receive-only)</span>'}</td></tr>
      <tr><td class="k">Type</td><td class="v">${a.code ? 'WASM contract' : 'account'}</td></tr>`
    : `<tr><td class="v empty" colspan="2">This account is not funded on-chain (it holds no state).</td></tr>`;
  setView(`
    <div class="crumb">Account${data.resolvedFrom ? ` · resolved from SNS name` : ''}</div>
    <h1 class="mono">${copyable(acct, 'account')} ${copyButton(acct, 'account')}</h1>
    <p><button type="button" class="watch-toggle" data-account="${encodeURIComponent(acct)}">${isWatched(acct) ? '★ Remove from local watchlist' : '☆ Add to local watchlist'}</button></p>
    ${data.resolvedFrom ? `<p class="dim">↳ <span class="mono">${esc(data.resolvedFrom)}</span> resolves here</p>` : ''}
    ${names.length ? `<p class="dim">SNS: ${names.map((n) => `<span class="mono">${esc(n)}</span>`).join(', ')}</p>` : ''}
    <div class="panel"><table class="kv">${kv}</table></div>
    ${tokenBalances.length ? `<h2>Token holdings</h2><div class="panel"><table><thead><tr><th>Asset</th><th>Symbol</th><th class="right">Balance</th></tr></thead><tbody>${tokenBalances.map((token) => `<tr><td>${objectLink('token', token.asset)}</td><td>${esc(token.symbol)}</td><td class="right num">${fmtCoin(token.balance)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${nfts.length ? `<h2>NFT holdings</h2><div class="panel"><table><thead><tr><th>Token</th><th>Collection</th><th>Type</th></tr></thead><tbody>${nfts.map((nft) => `<tr><td>${objectLink('nft', `${nft.collection}:${nft.tokenId}`, nft.tokenText || shortHash(nft.tokenId))}</td><td class="mono">${esc(shortHash(nft.collection))}</td><td>${nft.isSns ? 'SNS name' : 'NFT'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h2>Indexed Transactions</h2>
    ${accountPager}
    <div class="panel"><table><thead><tr><th>Tx</th><th>Type</th><th>Detail</th><th class="right">Block</th></tr></thead>
    <tbody>${txs.map((t) => `<tr><td>${txLink(t.id)}</td><td>${actionBadge(t.action)}</td><td>${t.signer === acct ? actionSummary(t.action) : `from ${acctLink(t.signer)}`}</td><td class="right">${blockLink(t.blockHeight)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
    ${accountPager}
    <p class="note">${data.historyComplete ? 'Complete archived transaction history' : `Transaction history currently indexed from block #${fmtNum(data.historyFromHeight)}`} · balances are read live from the node.</p>
  `, routeId);
  window.__sovExport = { name: `${NET}-account-${acct}-transactions`, rows: txs };
  $('export-tools').hidden = false;
}

async function renderWatchlist(routeId) {
  const accounts = watchlist();
  setView('<div class="loading">Loading local watchlist…</div>', routeId);
  if (!accounts.length) {
    return setView('<h1>Watchlist</h1><div class="panel empty-state"><div class="es-title">No watched accounts</div><div class="dim">Open an account and choose “Add to local watchlist.” Saved accounts remain in this browser.</div></div>', routeId);
  }
  const rows = [];
  for (const account of accounts) {
    const data = await api('/account/' + encodeURIComponent(account)).catch(() => null);
    rows.push({ account, data });
  }
  setView(`
    <h1>Watchlist</h1>
    <p class="note">Stored only in this browser. The explorer requests each displayed account independently; it never uploads or stores the watchlist.</p>
    <div class="watch-grid">${rows.map(({ account, data }) => {
      const state = data?.account;
      const latest = data?.transactions?.[0];
      return `<article class="panel watch-card"><div><h2>${acctLinkShort(account)}</h2><p class="mono break">${esc(account)}</p></div><div class="watch-balance">${state ? `${fmtCoin(state.balance)} ${COIN_SYMBOL}` : 'No funded state'}</div><div class="dim">${latest ? `Latest activity ${txLink(latest.id)} · block ${blockLink(latest.blockHeight)}` : 'No archived activity'}</div><button type="button" class="watch-toggle" data-account="${encodeURIComponent(account)}">Remove</button></article>`;
    }).join('')}</div>
  `, routeId);
}

async function renderMiners(routeId) {
  setView('<div class="loading">Loading miners…</div>', routeId);
  const [observed, miners, status] = await Promise.all([
    api('/observed-miners'),
    api('/miners'),
    api('/status').catch(() => null),
  ]);
  const w = observed.window ?? {};
  const registry = observed.registry ?? {};
  const target = status?.difficulty?.targetBlockMs;
  const windowLabel = minerWindowLabel(registry.windowBlocks ?? w.windowBlocks, target);
  const coverage = w.coveredBlocks
    ? (w.complete
      ? `all ${fmtNum(w.coveredBlocks)} blocks #${fmtNum(w.fromHeight)}–#${fmtNum(w.toHeight)}`
      : `partial coverage: ${fmtNum(w.coveredBlocks)} retained blocks #${fmtNum(w.fromHeight)}–#${fmtNum(w.toHeight)} — the explorer has not yet indexed the full window`)
    : 'no retained blocks yet';
  const peers = status?.peers;
  const agentList = peers?.agents
    ? Object.entries(peers.agents).map(([agent, count]) => `${esc(agent)} × ${fmtNum(count)}`).join(' · ')
    : null;
  setView(`
    <h1>Miners</h1>
    <p class="note"><b>A coinbase account is not a machine.</b> Several physical machines can — and on this network do — pay the same account, so a machine count cannot be derived from chain data and is never claimed here. Every count below states the exact window it was measured over; a short sample systematically misses low-hashrate miners, which is why the recent window spans ${esc(windowLabel.replace(/^last /, ''))}.</p>
    <div class="cards">
      <div class="card"><div class="label">Mining accounts · ${esc(windowLabel)}</div><div class="value num">${registry.recentAccounts === null || registry.recentAccounts === undefined ? '—' : fmtNum(registry.recentAccounts)}</div><div class="sub">won ≥ 1 block in the window (node registry)</div></div>
      <div class="card"><div class="label">Mining accounts · all time</div><div class="value num">${registry.allTimeAccounts === null || registry.allTimeAccounts === undefined ? '—' : fmtNum(registry.allTimeAccounts)}</div><div class="sub">every coinbase account since genesis</div></div>
      <div class="card"><div class="label">Consensus</div><div class="value mono" style="font-size:16px">Nakamoto</div><div class="sub">pure proof-of-work, heaviest-work fork choice</div></div>
    </div>
    <h2>Block wins — ${esc(windowLabel)}</h2>
    <p class="note">Share of blocks each account won, measured over ${esc(coverage)}.</p>
    <div class="panel"><table><thead><tr><th>Account</th><th class="right">Blocks won</th><th class="right">Share</th><th class="right">Latest win</th></tr></thead>
    <tbody>${(w.miners ?? []).map((x) => `<tr><td>${acctLink(x.account)}</td><td class="right num">${fmtNum(x.blocks)}</td><td class="right num">${x.share === null ? '—' : pct(x.share)}</td><td class="right">${blockLink(x.lastHeight)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
    <h2>All-time registry <span class="dim">— sov_getMiners, whole chain</span></h2>
    <div class="panel"><table><thead><tr><th>Account</th><th class="right">Blocks mined</th><th class="right">First seen</th><th class="right">Last seen</th></tr></thead>
    <tbody>${miners.map((m) => `<tr><td>${acctLink(m.account)}</td><td class="right num">${fmtNum(m.blocksMined ?? m.mineTxs ?? 0)}</td><td class="right">${blockLink(m.firstSeenHeight)}</td><td class="right">${blockLink(m.lastSeenHeight)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
    <h2>Relay connectivity <span class="dim">— a different, weaker signal than mining accounts</span></h2>
    ${peers
      ? `<div class="panel"><table class="kv">
          <tr><td class="k">Authenticated peers of the relay</td><td class="v num">${peers.peers === null ? '—' : fmtNum(peers.peers)}</td></tr>
          <tr><td class="k">Peer software</td><td class="v">${agentList || '<span class="dim">not reported</span>'}</td></tr>
          <tr><td class="k">Relay version</td><td class="v mono">${esc(peers.relayVersion ?? '—')}${peers.protocolVersion === null ? '' : ` · protocol ${fmtNum(peers.protocolVersion)}`}</td></tr>
        </table></div>
        <p class="note">These are the nodes one relay is directly connected to (sov_getPeerInfo) — evidence of live machines, but neither a full network census nor a miner count: non-mining nodes appear here and distant miners may not. Peer addresses are deliberately not republished.</p>`
      : '<div class="panel"><p class="note" style="margin:12px">Peer information is not exposed by the connected node.</p></div>'}
  `, routeId);
}

function snsCard(n) {
  return `<div class="sns-card">
    <div class="sns-head">
      <a class="sns-name" href="#/account/${encodeURIComponent(n.name)}">${esc(n.name)}</a>
      <span class="chip sns">SNS · NFT</span>
    </div>
    <div class="sns-row"><span class="k">resolves to</span> ${acctLinkShort(n.owner)}</div>
    <div class="sns-row"><span class="k">registered</span> ${blockLink(n.registeredHeight)}</div>
  </div>`;
}

async function renderSns(params, routeId) {
  setView('<div class="loading">Loading names…</div>', routeId);
  // The Sovereign Name Service: human-readable *.sov names that resolve to
  // accounts. Each name is a non-fungible token in the reserved SNS collection.
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const page = await api(`/names?limit=50&offset=${offset}`);
  const names = page.names ?? [];
  const total = page.total ?? names.length;
  const committed = setView(`
    <section class="hero-strip">
      <div>
        <h1>SNS</h1>
        <p>Sovereign Name Service · ${fmtNum(total)} name${total === 1 ? '' : 's'} registered</p>
      </div>
      <div class="hero-meta">
        <span>names are NFTs</span>
        <span>name → account resolver</span>
      </div>
    </section>

    <form class="sns-lookup" id="sns-lookup" aria-label="Resolve a Sovereign name">
      <input id="sns-q" type="text" aria-label="Resolve a Sovereign name" placeholder="resolve a name — e.g. alice.sov" autocomplete="off" spellcheck="false" />
      <button id="sns-go" class="sns-btn" type="submit">Resolve</button>
    </form>

    ${
      names.length
        ? `<div class="sns-grid">${names.map(snsCard).join('')}</div>`
        : `<div class="panel empty-state"><div class="es-title">No names registered yet</div><div class="dim">Register one in SOV Station → Wallet → Sovereign Name Service.</div></div>`
    }

    <div class="pager">${offset ? `<a class="pager-btn" href="#/sns?offset=${Math.max(0, offset - 50)}">◀ Newer</a>` : '<span class="pager-btn is-disabled">◀ Newer</span>'}<span class="pager-info">${names.length ? `${fmtNum(offset + 1)}–${fmtNum(offset + names.length)} of ${fmtNum(total)}` : 'No names'}</span>${page.hasMore ? `<a class="pager-btn" href="#/sns?offset=${offset + 50}">Older ▶</a>` : '<span class="pager-btn is-disabled">Older ▶</span>'}</div>

    <p class="note">Each name is a non-fungible token (token id = the name) in the reserved SNS collection — owned, transferable, and resolvable. The registry and resolution are consensus state every node agrees on.</p>
  `, routeId);
  if (!committed) return;
  const go = () => {
    const v = (document.getElementById('sns-q')?.value || '').trim();
    if (v) location.hash = '#/account/' + encodeURIComponent(v);
  };
  document.getElementById('sns-lookup')?.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
}

async function renderAnalytics(routeId) {
  setView('<div class="loading">Loading analytics…</div>', routeId);
  const { stats, supplySeries } = await api('/analytics');
  setView(`
    <h1>Analytics</h1>
    <div class="cards">
      <div class="card"><div class="label">Total supply</div><div class="value num">${fmtCoin(stats.supply?.total)}<span class="unit">${COIN_SYMBOL}</span></div></div>
      <div class="card"><div class="label">Mined (PoW)</div><div class="value num">${fmtCoin(stats.supply?.mined)}<span class="unit">${COIN_SYMBOL}</span></div><div class="sub">${pct(stats.mintedOfCap)} of 21M cap</div><div class="bar"><i style="width:${Math.min(100, (stats.mintedOfCap ?? 0) * 100)}%"></i></div></div>
      <div class="card"><div class="label">Shielded supply</div><div class="value num">${stats.supply?.shieldedPercent === undefined ? '—' : fmtDecimal(stats.supply.shieldedPercent, 2)}<span class="unit">%</span></div><div class="sub">${fmtCoin(stats.supply?.shielded)} ${COIN_SYMBOL} private (Orchard pool — not post-quantum)</div><div class="bar"><i style="width:${Math.min(100, stats.supply?.shieldedPercent ?? 0)}%"></i></div></div>
      <div class="card"><div class="label">Finality depth</div><div class="value num">6</div><div class="sub">confirmation convention</div></div>
      <div class="card"><div class="label">Mempool</div><div class="value num">${fmtNum(stats.mempoolSize)}</div></div>
      <div class="card"><div class="label">Blocks indexed</div><div class="value num">${fmtNum(stats.blocksIndexed)}</div></div>
      ${stats.archive?.enabled ? `<div class="card"><div class="label">Blocks archived</div><div class="value num">${fmtNum(stats.archive.blocks)}</div><div class="sub">${stats.archive.complete ? 'complete from genesis' : `contiguous from #${fmtNum(stats.archive.contiguousFromHeight)}`}</div></div>` : ''}
      <div class="card"><div class="label">Transactions retained</div><div class="value num">${fmtNum(stats.transactionsRetained ?? stats.transactionsIndexed)}</div><div class="sub">memory-bounded indexed window</div></div>
    </div>
    <h2>Issuance Over Time</h2>
    <div class="panel" style="padding:18px">${issuanceChart(supplySeries)}
      <div class="legend"><span><i style="background:#3f6fff"></i>Mined (PoW)</span></div>
    </div>
    <p class="note">Issuance is sampled live as the explorer follows the chain — each point is the chain's committed supply at that height. The 21,000,000 ${COIN_SYMBOL} hard cap is enforced on-chain by exact-integer accounting.</p>
  `, routeId);
}

/** One tipped/untipped statistics column. `null` renders as an em dash — a group
 * with no observed sample is never shown as a zero wait. */
function waitStatCard(label, group, sub) {
  const value = group?.medianWaitMs === null || group?.medianWaitMs === undefined
    ? '<span class="dim">—</span>'
    : fmtDuration(group.medianWaitMs);
  const p90 = group?.p90WaitMs === null || group?.p90WaitMs === undefined
    ? '—'
    : fmtDuration(group.p90WaitMs);
  const blocks = group?.medianWaitBlocks === null || group?.medianWaitBlocks === undefined
    ? '—'
    : `${fmtDecimal(group.medianWaitBlocks, 1)} blk`;
  return `<div class="card">
    <div class="label">${esc(label)}</div>
    <div class="value num">${value}</div>
    <div class="sub">p90 ${p90} · median ${blocks} · n=${fmtNum(group?.count ?? 0)}</div>
    <div class="sub dim">${esc(sub)}</div>
  </div>`;
}

/**
 * Wait times: the fee auction, measured. Median and p90 wait split by tipped vs
 * untipped, computed ONLY over transactions with an observed first-seen. The
 * excluded counts are shown next to the sample size, because a median drawn from
 * a fraction of the window is only meaningful with that fraction stated.
 */
async function renderTiming(routeId) {
  setView('<div class="loading">Loading wait times…</div>', routeId);
  let stats;
  let mempool;
  try {
    [stats, mempool] = await Promise.all([
      api('/tx-timing?limit=2000'),
      api('/mempool?limit=25').catch(() => null),
    ]);
  } catch (e) {
    return errView(e.message, routeId);
  }
  const support = stats.support ?? {};
  const unsupported = support.mempoolRpc === false && support.timingRpc === false;
  const pending = (mempool?.txs ?? []).map((tx) => `<tr>
    <td>${txLink(tx.txId)}</td>
    <td>${acctLinkShort(tx.signer)}</td>
    <td class="right num">${tx.tipGrains ? `${fmtCoin(tx.tipGrains)} ${COIN_SYMBOL}` : '<span class="dim">no tip</span>'}</td>
    <td>${esc(tx.state ?? '—')}</td>
    <td class="right">${Number.isFinite(Number(tx.firstSeenMs))
      ? `waiting ${fmtDecimal(Math.max(0, Date.now() - Number(tx.firstSeenMs)) / 1000, 0)}s`
      : NOT_OBSERVED}</td>
  </tr>`).join('');

  setView(`
    <h1>Transaction wait times</h1>
    <p class="note">How long transactions waited between the moment they were first <b>observed</b> in a mempool
      and the block that included them. Tipped transactions bid for priority under the fee-auction deployment;
      untipped ones take the ordinary queue. Only transactions with a real observation are counted — nothing here is estimated.</p>
    ${unsupported ? `<div class="panel"><p class="note"><b>This node does not report transaction timing.</b>
      It answered <code>sov_getMempoolTxs</code> and <code>sov_getTxTiming</code> with "method not found", so no wait can be measured from it.
      The explorer stopped asking and everything else on this page keeps working; timing is simply absent, never invented.</p></div>` : ''}
    <div class="cards">
      ${waitStatCard('Tipped — median wait', stats.tipped, 'fee-auction priority bids')}
      ${waitStatCard('Untipped — median wait', stats.untipped, 'no priority bid')}
      ${waitStatCard('All observed', stats.overall, 'every transaction with a recorded first-seen')}
      <div class="card">
        <div class="label">Sample</div>
        <div class="value num">${fmtNum(stats.sampleSize)}</div>
        <div class="sub">of ${fmtNum(stats.considered)} transactions in the window${stats.window?.fromHeight === null ? '' : ` (#${fmtNum(stats.window.fromHeight)}–#${fmtNum(stats.window.toHeight)})`}</div>
        <div class="sub dim">${fmtNum(stats.excludedUnobserved)} excluded as not observed${stats.excludedNegative ? ` · ${fmtNum(stats.excludedNegative)} excluded for a block timestamp earlier than first-seen` : ''}</div>
      </div>
    </div>
    <h2>Where the timing came from</h2>
    <div class="panel"><table class="kv">
      <tr><td class="k">Node observations</td><td class="v">${fmtNum(stats.sources?.node ?? 0)} <span class="dim">— the node's own mempool record (<code>sov_getTxTiming</code>)</span></td></tr>
      <tr><td class="k">Explorer observations</td><td class="v">${fmtNum(stats.sources?.explorer ?? 0)} <span class="dim">— seen by this explorer polling <code>sov_getMempoolTxs</code></span></td></tr>
      <tr><td class="k">Not observed</td><td class="v">${fmtNum(stats.excludedUnobserved)} <span class="dim">— excluded from every statistic above. Transactions mined before this explorer recorded first-seen have no wait, and one is never estimated for them.</span></td></tr>
    </table></div>
    <h2>Pending now</h2>
    ${mempool?.available
      ? `<div class="panel"><table><thead><tr><th>Tx</th><th>Signer</th><th class="right">Tip</th><th>State</th><th class="right">Waiting</th></tr></thead>
        <tbody>${pending || emptyRow(5)}</tbody></table></div>
        <p class="note">Read from this node's mempool ${mempool.updatedAt ? `at ${fmtDateTime(mempool.updatedAt)}` : ''}${mempool.truncated ? ' (page-capped — the mempool is larger than the polled window)' : ''}. A mempool is node-local: another node may hold a different set.</p>`
      : `<div class="panel"><p class="note">${esc(mempool?.reason ?? 'The mempool listing is unavailable from this node.')} Pending transactions cannot be listed, so none are shown — rather than an empty table implying an empty mempool.</p></div>`}
    <p class="note">First seen is an <b>observation</b>, not a creation time: it is when a node (or this explorer, polling that node) first
      saw the transaction. Different nodes can legitimately differ. Transactions mined before this explorer began recording first-seen show
      “— / not observed” everywhere and are excluded from these statistics; none of them are backfilled with an estimate.</p>
  `, routeId);
}

function issuanceChart(series) {
  if (!series || series.length < 2) {
    return '<div class="empty">Collecting issuance samples as new blocks arrive…</div>';
  }
  const W = 1000;
  const H = 200;
  const pad = 8;
  const xs = series.map((p) => p.height);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const coin = (g) => Number(BigInt(g) / 1000000n) / 100; // coin units with 2dp, safe
  const mined = series.map((p) => coin(p.mined));
  const dataMin = Math.min(...mined);
  const dataMax = Math.max(...mined);
  const change = dataMax - dataMin;
  const range = Math.max(1, change);
  const minY = Math.max(0, dataMin - range * 0.08);
  const maxY = dataMax + range * 0.08;
  const X = (x) => pad + ((x - minX) / Math.max(1, maxX - minX)) * (W - 2 * pad);
  const Y = (y) => H - pad - ((y - minY) / Math.max(1, maxY - minY)) * (H - 2 * pad);
  const path = (vals) => vals.map((y, i) => `${i === 0 ? 'M' : 'L'}${X(xs[i]).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  const line = path(mined);
  const area = `${line} L${X(xs.at(-1)).toFixed(1)},${H - pad} L${X(xs[0]).toFixed(1)},${H - pad} Z`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Mined supply increased by ${fmtDecimal(change, 2)} ${COIN_SYMBOL} from block ${fmtNum(minX)} to ${fmtNum(maxX)}">
    <defs><linearGradient id="issuance-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f6fff" stop-opacity=".32"/><stop offset="1" stop-color="#3f6fff" stop-opacity=".02"/></linearGradient></defs>
    <line class="gridline" x1="${pad}" y1="${H * 0.33}" x2="${W - pad}" y2="${H * 0.33}" />
    <line class="gridline" x1="${pad}" y1="${H * 0.66}" x2="${W - pad}" y2="${H * 0.66}" />
    <line class="axis" x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" />
    <path class="series-area" d="${area}" />
    <path class="series-mined" d="${line}" />
  </svg>
  <div class="chart-meta"><span>Block #${fmtNum(minX)}</span><strong>+${fmtDecimal(change, 2)} ${COIN_SYMBOL} in indexed window</strong><span>Block #${fmtNum(maxX)}</span></div>`;
}

/** Pool v2 (post-quantum) shielded-state card for the proof view. Mirrors the v1
 * shielded card but is driven by sov_getShieldedV2Info. A node older than v0.2.5
 * does not expose the method, so `v2` is null — say so outright rather than
 * fabricate an empty pool. The pool is DORMANT until the `shielded-v2` deployment
 * (signal bit 2) activates at mainnet height 15,552; `v2.active` is the node's
 * authoritative answer for whether it can be transacted with right now. */
function poolV2ProofCard(v2) {
  if (!v2) {
    return `
      <section class="proof-card">
        <div class="proof-heading"><div><span class="eyebrow">POST-QUANTUM PRIVACY</span><h2>Shielded pool v2</h2></div><span class="proof-state warn">not reported by this node</span></div>
        <p class="proof-note">This node does not expose <code>sov_getShieldedV2Info</code> — it predates the v0.2.5 pool-v2 release. Point the explorer at a v0.2.5+ node to surface the post-quantum pool's state. Nothing is assumed about the pool in its absence.</p>
      </section>`;
  }
  const pool = safeBigInt(v2.poolValue);
  const available = safeBigInt(v2.deshieldableNowGrains);
  const limit = safeBigInt(v2.deshieldLimitGrains);
  const active = v2.active === true;
  const resetHeight = Number(v2.windowResetsAtHeight ?? 0);
  const windowElapsed = resetHeight > 0 && Number(v2.height ?? 0) >= resetHeight;
  const stateLabel = active ? 'ACTIVE — spendable' : 'DORMANT — not yet active';
  return `
      <section class="proof-card">
        <div class="proof-heading"><div><span class="eyebrow">POST-QUANTUM PRIVACY</span><h2>Shielded pool v2</h2></div><span class="proof-state ${active ? 'ok' : 'warn'}">${esc(stateLabel)}</span></div>
        <div class="proof-metric"><b>${fmtCoin(pool.toString())} ${COIN_SYMBOL}</b><span>inside the post-quantum pool</span><small>${fmtNum(v2.noteCount)} notes · ${fmtNum(v2.nullifierCount)} nullifiers spent</small></div>
        <div class="evidence-kv compact">
          <span>Anchor (Merkle root)</span><b class="mono break">${v2.anchor ? `${esc(shortHash(v2.anchor, 12, 10))} ${copyButton(v2.anchor, 'pool-v2 anchor')}` : '—'}</b>
          <span>De-shieldable now</span><b>${fmtCoin(available.toString())} ${COIN_SYMBOL}</b>
          <span>Policy ceiling</span><b>${fmtCoin(limit.toString())} ${COIN_SYMBOL} / ${fmtNum(v2.deshieldWindowBlocks)} blocks</b>
          <span>Window state</span><b>${windowElapsed ? 'elapsed · resets on next de-shield' : `resets at #${fmtNum(resetHeight)}`}</b>
        </div>
        <p class="proof-note"><b>Cryptography:</b> pool v2 is post-quantum — ML-KEM-768 note encryption and a STARK spend proof (hash-based, no elliptic curves, no trusted setup), unlike the v1 Orchard/Halo2 pool above.</p>
        <p class="proof-note">${active
          ? 'The <code>shielded-v2</code> deployment (signal bit 2) is active at this height, so the pool accepts spends. Every field above is the node\'s live answer.'
          : 'The pool is <b>dormant</b>: the <code>shielded-v2</code> deployment (signal bit 2) activates at mainnet height 15,552, until which an <code>Action::ShieldedV2</code> is rejected on every node. The state above is real and simply empty until then.'}</p>
      </section>`;
}

async function renderProof(routeId) {
  setView('<div class="loading">Loading Sovereign proof…</div>', routeId);
  const proof = await api('/proof');
  const relays = proof.relays ?? {};
  const relayState = relayAvailability(relays);
  const crypto = proof.cryptography ?? {};
  const layout = crypto.hybrid65Layout ?? {};
  const supply = proof.privacy?.supply ?? {};
  const shielded = proof.privacy?.shieldedInfo ?? {};
  const shieldedV2 = proof.privacy?.shieldedV2Info ?? null;
  const empty = proof.commitments?.deterministicEmpty;
  const nonEmpty = proof.commitments?.latestNonEmpty;
  const commonHash = relays.commonHash
    ? (String(relays.commonHash).startsWith('0x') ? relays.commonHash : `0x${relays.commonHash}`)
    : null;
  const quorumLabel = relays.consistent === false
    ? 'DISAGREEMENT — INDEXING HALTED'
    : relays.consistent === true
      ? `agreed through block #${fmtNum(relays.commonHeight)}${relays.reducedRedundancy ? ` · ${fmtNum(relayState.healthy)}/${fmtNum(relayState.configured)} relays available` : ''}`
      : 'single-source / comparison pending';
  const pool = safeBigInt(shielded.poolValue ?? supply.shielded);
  const available = safeBigInt(shielded.deshieldableNowGrains);
  const limit = safeBigInt(shielded.deshieldLimitGrains);
  const fullyExitCapable = pool > 0n && available >= pool;
  const resetHeight = Number(shielded.windowResetsAtHeight ?? 0);
  const windowElapsed = resetHeight > 0 && Number(shielded.height ?? 0) >= resetHeight;
  const poolV2Card = poolV2ProofCard(shieldedV2);
  const coverage = crypto.hybridCoverage === null || crypto.hybridCoverage === undefined
    ? 'awaiting transactions'
    : `${fmtDecimal(Number(crypto.hybridCoverage) * 100, 2)}% of retained transactions`;
  const relayCards = (relays.relays ?? []).map((relay, index) => `
    <div class="relay-evidence">
      <div><span class="evidence-dot ${relay.healthy && relay.verified ? 'ok' : 'bad'}"></span><b>Relay ${index + 1}</b></div>
      <span class="mono">${esc(relay.name)}</span>
      <small>${relay.verified ? 'identity pinned' : 'not verified'} · height ${fmtNum(relay.height)} · ${relay.latencyMs == null ? '—' : `${fmtNum(relay.latencyMs)} ms`}</small>
    </div>`).join('');

  setView(`
    <section class="hero-strip proof-hero">
      <div>
        <h1>Sovereign Proof</h1>
        <p>Live, chain-native evidence — not a generic explorer skin.</p>
      </div>
      <div class="hero-meta">
        <span>dual-relay provenance</span>
        <span>hybrid post-quantum</span>
        <span>shielded policy telemetry</span>
      </div>
    </section>

    <div class="proof-grid">
      <section class="proof-card proof-wide">
        <div class="proof-heading"><div><span class="eyebrow">CHAIN PROVENANCE</span><h2>Relay quorum</h2></div><span class="proof-state ${relayState.tone}">${esc(quorumLabel)}</span></div>
        <div class="evidence-kv">
          <span>Chain id</span><b class="mono">${esc(proof.identity?.chainId)}</b>
          <span>Genesis</span><b class="mono break">${copyable(proof.identity?.genesisHash, 'genesis hash')} ${copyButton(proof.identity?.genesisHash, 'genesis hash')}</b>
          <span>Common-head hash</span><b class="mono break">${commonHash ? `${esc(commonHash)} ${copyButton(commonHash, 'common-head hash')}` : '—'}</b>
          <span>Node / indexed</span><b class="mono">${fmtNum(proof.sync?.nodeHeight)} / ${fmtNum(proof.sync?.indexedHeight)}</b>
          <span>Durable archive</span><b class="mono">${proof.archive?.enabled ? `${fmtNum(proof.archive.blocks)} blocks · ${proof.archive.complete ? 'complete from genesis' : `contiguous from #${fmtNum(proof.archive.contiguousFromHeight)}`}` : 'disabled'}</b>
        </div>
        <div class="relay-evidence-grid">${relayCards || '<span class="dim">No relay evidence available.</span>'}</div>
        <p class="proof-note">This proves source identity and cross-relay agreement at the compared height. It is not a substitute for independently executing consensus in a full node.</p>
      </section>

      <section class="proof-card">
        <div class="proof-heading"><div><span class="eyebrow">TRANSACTION CRYPTOGRAPHY</span><h2>Hybrid65 in the blocks</h2></div><span class="proof-state ok">both signatures required</span></div>
        <div class="proof-metric"><b>${fmtNum(crypto.hybrid65 ?? 0)}</b><span>hybrid65 transactions retained</span><small>${esc(coverage)}</small></div>
        <div class="crypto-label"><span>Public key · ${fmtNum(layout.publicKeyBytes)} bytes</span></div>
        <div class="crypto-stack" aria-label="Hybrid65 public key: 32-byte Ed25519 plus 1,952-byte ML-DSA-65"><span class="classic">Ed25519<br />${fmtNum(layout.ed25519PublicKeyBytes)} B</span><span class="pq">ML-DSA-65 · ${fmtNum(layout.mlDsa65PublicKeyBytes)} B</span></div>
        <div class="crypto-label"><span>Signature · ${fmtNum(layout.signatureBytes)} bytes</span></div>
        <div class="crypto-stack signature" aria-label="Hybrid65 signature: 64-byte Ed25519 plus 3,309-byte ML-DSA-65"><span class="classic">Ed25519<br />${fmtNum(layout.ed25519SignatureBytes)} B</span><span class="pq">ML-DSA-65 · ${fmtNum(layout.mlDsa65SignatureBytes)} B</span></div>
        <p class="proof-note">The scheme prefix, public key, and signature are carried by each indexed transaction. Consensus accepts hybrid65 only when both classical and FIPS 204 components verify.</p>
      </section>

      <section class="proof-card">
        <div class="proof-heading"><div><span class="eyebrow">PRIVATE VALUE</span><h2>Shielded pool, with policy exposed</h2></div><span class="proof-state ${fullyExitCapable ? 'warn' : 'ok'}">${fullyExitCapable ? 'full pool currently exit-capable' : 'circuit breaker active'}</span></div>
        <div class="proof-metric"><b>${fmtCoin(pool.toString())} ${COIN_SYMBOL}</b><span>inside the shielded pool</span><small>${fmtDecimal(supply.shieldedPercent ?? 0, 2)}% of circulating supply</small></div>
        <div class="evidence-kv compact">
          <span>De-shieldable now</span><b>${fmtCoin(available.toString())} ${COIN_SYMBOL}</b>
          <span>Policy ceiling</span><b>${fmtCoin(limit.toString())} ${COIN_SYMBOL} / ${fmtNum(shielded.deshieldWindowBlocks)} blocks</b>
          <span>Spent this window</span><b>${fmtCoin(shielded.windowSpentGrains)} ${COIN_SYMBOL}</b>
          <span>Window state</span><b>${windowElapsed ? 'elapsed · resets on next de-shield' : `resets at #${fmtNum(resetHeight)}`}</b>
        </div>
        <p class="proof-note">The limiter is visible policy, separate from shielded-pool validity. ${fullyExitCapable ? 'Because the configured ceiling exceeds the live pool, it does not currently throttle a full pool exit.' : 'The window ceiling currently caps how fast the pool can be exited.'}</p>
        <p class="proof-note"><b>Cryptography disclosure:</b> this shielded pool is Orchard (Halo2, no trusted setup) — classical elliptic-curve cryptography, <b>not post-quantum</b>, unlike the chain's hybrid transaction signatures. This is disclosed in the project's quantum posture; the post-quantum pool v2 below is the successor design.</p>
      </section>

      ${poolV2Card}

      <section class="proof-card proof-wide">
        <div class="proof-heading"><div><span class="eyebrow">COMMITMENT SEMANTICS</span><h2>Why the roots repeat — and when they change</h2></div><span class="proof-state ok">content committed</span></div>
        <div class="commitment-compare">
          <div>
            <span class="root-kind">empty set</span>
            <h3>${empty ? `Block #${fmtNum(empty.height)} · 0 transactions` : 'Empty block'}</h3>
            <code>${esc(empty?.txRoot ?? 'not indexed')}</code>
            <p>Transaction and receipt lists are both empty, so both use the same deterministic domain-separated Merkle root. The state root still changes when coinbase is applied.</p>
          </div>
          <div>
            <span class="root-kind changed">non-empty</span>
            <h3>${nonEmpty ? `${blockLink(nonEmpty.height)} · ${fmtNum(nonEmpty.txCount)} transaction` : 'Awaiting a retained transaction'}</h3>
            <dl><dt>Tx root</dt><dd><code>${esc(shortHash(nonEmpty?.txRoot, 18, 12))}</code></dd><dt>Receipt root</dt><dd><code>${esc(shortHash(nonEmpty?.receiptsRoot, 18, 12))}</code></dd></dl>
            ${nonEmpty?.transactionId ? `<p>Evidence: ${txLink(nonEmpty.transactionId)}</p>` : ''}
          </div>
        </div>
      </section>
    </div>
  `, routeId);
}

async function renderValidity(routeId) {
  setView('<div class="loading">Loading validity view…</div>', routeId);
  const blocks = await api('/blocks?limit=40');
  const finalCount = blocks.filter((b) => b.final).length;
  setView(`
    <h1>Commitments &amp; Finality</h1>
    <div class="assurance-note">
      <b>What this explorer verifies:</b> both configured relays are pinned to the
      expected chain id and genesis hash, and their common-head block hashes must
      agree. Indexing halts on disagreement. The explorer displays node-validated
      state, transaction, and receipt roots; it does not independently re-execute
      consensus. Run a full node for independent validation. Repeated transaction
      and receipt roots marked <b>empty set</b> are the intentional Merkle commitment
      for blocks carrying no transactions; their state roots still change with coinbase.
    </div>
    <div class="cards">
      <div class="card"><div class="label">Recent window</div><div class="value num">${blocks.length}</div><div class="sub">blocks</div></div>
      <div class="card"><div class="label">Final</div><div class="value num">${finalCount}</div><div class="sub">past confirmation depth</div></div>
      <div class="card"><div class="label">Pending</div><div class="value num">${blocks.length - finalCount}</div><div class="sub">waiting for confirmations</div></div>
    </div>
    <div class="panel"><table><thead><tr><th>Height</th><th>State root</th><th>Tx root</th><th>Receipts root</th><th>Finality</th></tr></thead>
    <tbody>${blocks
      .map(
        (b) =>
          `<tr><td>${blockLink(b.height)}</td><td class="mono dim">${esc(shortHash(b.stateRoot, 10, 6))}</td><td class="mono dim">${esc(shortHash(b.txRoot, 10, 6))} ${emptyRootBadge(b.txCount === 0)}</td><td class="mono dim">${esc(shortHash(b.receiptsRoot, 10, 6))} ${emptyRootBadge(b.txCount === 0)}</td><td>${finalBadge(b.final)}</td></tr>`,
      )
      .join('') || emptyRow(5)}</tbody></table></div>
  `, routeId);
}

async function resolveSearch(q) {
  try {
    const r = await api('/search?q=' + encodeURIComponent(q));
    if (r.kind === 'block') location.hash = '#/block/' + r.ref;
    else if (r.kind === 'tx') location.hash = '#/tx/' + r.ref;
    else if (r.kind === 'account') location.hash = '#/account/' + encodeURIComponent(r.ref);
    else errView(`Nothing found for “${q}”.`);
  } catch (e) {
    errView(e.message);
  }
}

// ---- router ---------------------------------------------------------------

function route() {
  const routeId = ++ROUTE_ID;
  window.__sovExport = null;
  $('export-tools').hidden = true;
  liveReset(); // the incoming view re-registers its own live hooks
  // A not-yet-live network (e.g. mainnet pre-launch) shows a launching-soon panel
  // instead of querying a node that doesn't exist.
  if (NET_LIVE[NET] === false) {
    renderNotLive(routeId);
    return Promise.resolve();
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const [routePath, routeSearch = ''] = hash.split('?');
  const [, head, arg, extra] = routePath.split('/');
  const routeQuery = new URLSearchParams(routeSearch);
  const routeTitles = {
    proof: 'Proof', blocks: 'Blocks', transactions: 'Transactions', assets: 'Assets',
    watchlist: 'Watchlist', miners: 'Miners', validators: 'Miners', sns: 'Names',
    analytics: 'Analytics', validity: 'Finality', timing: 'Wait times',
  };
  setPageMeta(routeTitles[head] ?? (head ? '' : 'Overview'));
  setActiveNav(hash);
  let task;
  if (!head) task = renderOverview(routeId);
  else if (head === 'proof') task = renderProof(routeId);
  else if (head === 'blocks') task = renderBlocks(arg, routeId);
  else if (head === 'transactions') task = renderTransactions(routeQuery, routeId);
  else if (head === 'assets') task = renderAssets(routeQuery, routeId);
  else if (head === 'watchlist') task = renderWatchlist(routeId);
  else if (head === 'block' && arg) task = renderBlock(arg, routeId);
  else if (head === 'tx' && arg) task = renderTx(arg, routeId);
  else if (head === 'object' && arg && extra) task = renderObject(arg, extra, routeId);
  else if (head === 'account' && arg) task = renderAccount(arg, routeQuery, routeId);
  else if (head === 'miners' || head === 'validators') task = renderMiners(routeId);
  else if (head === 'analytics') task = renderAnalytics(routeId);
  else if (head === 'timing') task = renderTiming(routeId);
  else if (head === 'sns') task = renderSns(routeQuery, routeId);
  else if (head === 'validity') task = renderValidity(routeId);
  else task = renderNotFound(`Unknown or incomplete explorer route “${head}”.`, routeId);
  return Promise.resolve(task).catch((e) => errView(e.message, routeId));
}

function setActiveNav(hash) {
  let section = hash.split('/')[1] || '';
  if (section === 'object') section = 'assets';
  const top = '#/' + section;
  for (const a of document.querySelectorAll('.nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === top);
  }
}

window.addEventListener('hashchange', () => {
  route()
    .then(() => {
      const heading = view.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    })
    .catch((e) => errView(e.message));
});

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) resolveSearch(q);
});

document.addEventListener('click', async (event) => {
  const exportButton = event.target.closest?.('.data-export');
  if (exportButton && window.__sovExport) {
    const format = exportButton.dataset.format || 'json';
    downloadRows(`${window.__sovExport.name}.${format}`, window.__sovExport.rows, format);
    return;
  }
  const watchButton = event.target.closest?.('.watch-toggle');
  if (watchButton) {
    const account = decodeURIComponent(watchButton.dataset.account || '');
    watchButton.textContent = toggleWatch(account) ? '★ Remove from local watchlist' : '☆ Add to local watchlist';
    if (location.hash.startsWith('#/watchlist')) route();
    return;
  }
  const proofButton = event.target.closest?.('.proof-verify');
  if (proofButton) {
    const panel = proofButton.closest('.proof-check');
    const result = panel.querySelector('.proof-result');
    proofButton.disabled = true;
    result.textContent = ' Requesting relay evidence…';
    try {
      const evidence = await api(`/inclusion-proof/${panel.dataset.proofId}`);
      const tx = await verifyMerkleProof(evidence.transactionProof, evidence.txRoot);
      const receipt = await verifyMerkleProof(evidence.receiptProof, evidence.receiptsRoot);
      result.textContent = ` Transaction: ${tx.reason}. Receipt: ${receipt.reason}.`;
      result.className = `proof-result ${tx.verified && receipt.verified ? 'ok-text' : 'warn-text'}`;
    } catch (error) { result.textContent = ` ${error.message}`; }
    finally { proofButton.disabled = false; }
    return;
  }
  // Copy-on-click: the ⧉ buttons AND any element carrying data-copy (hash/address
  // text made copyable inline). One handler, one toast, shared everywhere.
  const button = event.target.closest?.('.copy-btn');
  const target = button || event.target.closest?.('.copyable[data-copy]');
  if (target) doCopy(target, button);
});

// Keyboard support for the inline copyable spans (role="button").
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target.closest?.('.copyable[data-copy]');
  if (!el) return;
  event.preventDefault();
  doCopy(el, null);
});

// ---- item 7: copy value + transient toast ---------------------------------
async function doCopy(el, button) {
  const value = decodeURIComponent(el.dataset.copy || '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    if (button) {
      const old = button.textContent;
      button.textContent = '✓';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = old;
        button.classList.remove('copied');
      }, 1200);
    }
    showToast('Copied to clipboard');
  } catch {
    el.title = 'Copy failed — select the value manually';
    showToast('Copy failed', true);
  }
}
let toastTimer = 0;
function showToast(message, warn = false) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show${warn ? ' warn' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 1600);
}

// Wrap a hash/address as clickable copy-to-clipboard text (reuses the shared
// handler + toast above). Returns escaped, safe markup.
function copyable(value, label = 'value') {
  if (value === null || value === undefined) return '';
  const v = String(value);
  return `<span class="copyable" data-copy="${encodeURIComponent(v)}" tabindex="0" role="button" title="Click to copy ${esc(label)}">${esc(v)}</span>`;
}

// ---- live feed + header status --------------------------------------------

function drawSealStars() {
  const g = $('seal-stars');
  if (!g) return;
  let s = '';
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2 - Math.PI / 2;
    const x = 32 + Math.cos(a) * 28;
    const y = 32 + Math.sin(a) * 28;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.1" />`;
  }
  g.innerHTML = s;
}

// Populate one rolling ticker chip for a block. Each chip is an <a> pointing at
// the block-detail route, so every item is individually clickable and navigates
// to its own height (pause-on-hover, in web/ticker.js, makes moving chips
// catchable). Reused when a chip recycles into a freshly-mined block.
function renderBlockChip(el, b) {
  el.href = `#/block/${encodeURIComponent(b.height)}`;
  el.title = `Open block #${fmtNum(b.height)} — ${fmtNum(b.txCount)} tx`;
  el.innerHTML = `<b>#${fmtNum(b.height)}</b> · ${fmtNum(b.txCount)} tx`;
}

// Build (or rebuild) the marquee against the current DOM + reduced-motion mode.
function ensureTicker() {
  const track = $('ticker-track');
  const viewport = $('ticker-viewport');
  const ticker = $('ticker');
  if (!track || !viewport) return null;
  if (ticker) ticker.classList.toggle('reduced', REDUCED_MOTION);
  if (!blockTicker) {
    blockTicker = new BlockTicker({
      track,
      viewport,
      render: renderBlockChip,
      cap: 48,
      speed: 44,
      reducedMotion: REDUCED_MOTION,
    });
  }
  return blockTicker;
}

// Seed the ticker from recent block history so it always has content rolling,
// even before the next block is mined. Degrades quietly: if the REST call fails
// the live WS feed will still seed it on the first incoming block.
async function seedTicker() {
  if (NET_LIVE[NET] === false) return;
  let blocks;
  try {
    blocks = await api('/blocks?limit=24');
  } catch {
    return; // no history yet — the WS feed will bootstrap the ticker
  }
  if (!Array.isArray(blocks) || !blocks.length) return;
  const ticker = ensureTicker();
  if (!ticker) return;
  const t = $('ticker');
  if (t) t.hidden = false;
  // The REST list is newest-first; the ticker wants oldest..newest so the newest
  // block sits at the leading (right) edge that fresh blocks feed in from.
  ticker.seed(blocks.map((b) => ({ height: b.height, txCount: b.txCount })).reverse());
  seedCadence(blocks);
}

// A freshly-mined block from the live feed rolls into the ticker.
function tickerPushBlock(b) {
  const ticker = ensureTicker();
  if (!ticker) return;
  const t = $('ticker');
  if (t) t.hidden = false;
  ticker.push({ height: b.height, txCount: b.txCount });
  pulseLive();
  cadenceTs.push(b.timestampMs ?? Date.now());
  if (cadenceTs.length > 40) cadenceTs = cadenceTs.slice(-40);
  renderCadence();
}

// ---- item 6: LIVE heartbeat -----------------------------------------------
// Pulse the green LIVE badge on each new block. Re-trigger the CSS animation by
// removing the class, forcing reflow, then re-adding it.
function pulseLive() {
  const label = $('ticker-label');
  if (!label || REDUCED_MOTION) return;
  label.classList.remove('beat');
  void label.offsetWidth;
  label.classList.add('beat');
}

// ---- item 4: block-cadence sparkline --------------------------------------
// A tiny SVG of recent inter-block times, pinned at the right of the LIVE strip,
// so the ~2.5-min pulse is visible. Hidden until at least two blocks are known.
function seedCadence(blocks) {
  if (!Array.isArray(blocks)) return;
  cadenceTs = blocks
    .map((b) => b.timestampMs)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
    .slice(-40);
  renderCadence();
}
function renderCadence() {
  const el = $('ticker-cadence');
  if (!el) return;
  const gaps = [];
  for (let i = 1; i < cadenceTs.length; i++) {
    const d = (cadenceTs[i] - cadenceTs[i - 1]) / 1000; // seconds
    if (d > 0 && d < 3600) gaps.push(d);
  }
  const recent = gaps.slice(-24);
  if (recent.length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const max = Math.max(...recent);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const w = 3;
  const gap = 1;
  const H = 20;
  const bars = recent
    .map((d, i) => {
      const h = Math.max(2, (d / max) * (H - 2));
      return `<rect x="${i * (w + gap)}" y="${(H - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="1" />`;
    })
    .join('');
  const width = recent.length * (w + gap);
  el.title = `Recent block cadence — avg ${fmtCadence(avg)} over last ${recent.length} intervals (target ~2m30s)`;
  el.innerHTML =
    `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="${esc(el.title)}">${bars}</svg>` +
    `<span class="cadence-avg">${esc(fmtCadence(avg))}</span>`;
}
function fmtCadence(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m${String(r).padStart(2, '0')}s` : `${m}m`;
}

// ---- item 5: odometer count-ups -------------------------------------------
// Last value shown per odometer key, kept in a module map so a re-rendered
// element still rolls from its previous value rather than resetting.
const odoState = new Map();
// Tween an element's number to `to` over ~600ms (rAF, eased). Formats each frame
// with `fmt`. Skips the animation under reduced-motion or when unchanged.
function odometer(el, to, fmt = fmtNum, key = el?.id) {
  if (!el) return;
  const target = Number(to);
  if (!Number.isFinite(target)) return;
  const prev = odoState.get(key);
  const from = Number.isFinite(prev) ? prev : target;
  odoState.set(key, target);
  if (REDUCED_MOTION || from === target) {
    el.textContent = fmt(target);
    return;
  }
  const dur = 600;
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (target - from) * eased));
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  };
  requestAnimationFrame(step);
}

// ---- item 1: bit-2 (shielded-v2) signaling progress -----------------------
// Progress toward the 90% BIP-9 activation threshold, computed from the header
// signaling the node already reports (s.signaling). Hidden when the node does
// not expose bit-2 signaling.
function signalProgress(s) {
  const sig = s?.signaling;
  const covered = Number(sig?.coveredBlocks ?? 0);
  const count = Number(sig?.byBit?.[2] ?? NaN);
  if (!covered || !Number.isFinite(count)) return '';
  const window = Number(sig?.windowBlocks ?? covered);
  const pctVal = (count / covered) * 100;
  const threshold = 90;
  const met = pctVal >= threshold;
  return `
    <section class="signal-panel" title="BIP-9: shielded-v2 (post-quantum, signal bit 2) activates once ≥90% of a ${fmtNum(window)}-block period signals.">
      <div class="signal-head">
        <span class="signal-title">PQ activation signaling <span class="dim">— bit 2 · last ${fmtNum(covered)} of ${fmtNum(window)} blocks</span></span>
        <span class="signal-figure ${met ? 'ok-text' : ''}">${fmtDecimal(pctVal, 1)}% <span class="dim">· need ≥90%</span></span>
      </div>
      <div class="signal-bar" role="progressbar" aria-valuenow="${fmtDecimal(pctVal, 1)}" aria-valuemin="0" aria-valuemax="100">
        <i class="signal-fill ${met ? 'met' : ''}" style="width:${Math.min(100, pctVal).toFixed(1)}%"></i>
        <span class="signal-threshold" style="left:${threshold}%" title="90% activation threshold"></span>
      </div>
    </section>`;
}

// ---- item 2: miner readiness board ----------------------------------------
// Which recently-active miners are signaling bit 2. Built purely from retained
// block headers (proposer + version_bits) over the sample — honest about who is
// actually producing blocks, not a registry roster. Hidden if no header carries
// version_bits (older node).
function minerReadinessBoard(blocks) {
  const list = Array.isArray(blocks) ? blocks.filter((b) => b && b.proposer) : [];
  if (!list.length) return '';
  const withBits = list.filter((b) => b.versionBits !== null && b.versionBits !== undefined);
  if (!withBits.length) return '';
  const byMiner = new Map();
  for (const b of withBits) {
    const m = byMiner.get(b.proposer) ?? { total: 0, signaling: 0, lastHeight: -1, lastSignaling: false };
    m.total += 1;
    const on = ((Number(b.versionBits) >>> 2) & 1) === 1;
    if (on) m.signaling += 1;
    if (b.height > m.lastHeight) {
      m.lastHeight = b.height;
      m.lastSignaling = on;
    }
    byMiner.set(b.proposer, m);
  }
  const rows = [...byMiner.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([acct, m]) => {
      const ready = m.lastSignaling;
      return `<div class="miner-cell ${ready ? 'ready' : 'not-ready'}" title="${esc(acct)} — ${fmtNum(m.signaling)}/${fmtNum(m.total)} sampled blocks signalled bit 2; latest #${fmtNum(m.lastHeight)} ${ready ? 'signals' : 'does not signal'}">
        <span class="miner-dot">${ready ? '●' : '○'}</span>
        <a class="mono" href="#/account/${encodeURIComponent(acct)}">${esc(shortHash(acct, 6, 4))}</a>
        <span class="miner-count">${fmtNum(m.signaling)}/${fmtNum(m.total)}</span>
      </div>`;
    })
    .join('');
  const readyCount = [...byMiner.values()].filter((m) => m.lastSignaling).length;
  return `
    <section class="miner-board">
      <h2>Miner readiness <span class="dim">— bit 2 (post-quantum) signaling · ${fmtNum(readyCount)}/${fmtNum(byMiner.size)} recent miners · sample of ${fmtNum(withBits.length)} blocks</span></h2>
      <div class="miner-grid">${rows}</div>
      <p class="note">Latest-header signal per miner that produced a block in the sampled window. A miner producing an unsignalled block flips to hollow; this reflects real headers, not intentions.</p>
    </section>`;
}

// ---- item 8: supply-invariant trust widget --------------------------------
// Compact, prove-don't-claim assertions verifiable from served data only.
function trustWidget(s, supply, genesisHash) {
  const total = safeBigInt(supply?.total ?? s?.supply?.total);
  const shielded = safeBigInt(supply?.shielded ?? s?.shieldedInfo?.poolValue);
  const conserved = total > 0n && shielded >= 0n && shielded <= total;
  const transparent = conserved ? total - shielded : 0n;
  const chips = [];
  if (total > 0n) {
    chips.push(`<span class="trust-chip ${conserved ? 'ok' : 'warn'}" title="Transparent ${fmtCoin(transparent.toString())} + shielded ${fmtCoin(shielded.toString())} = circulating ${fmtCoin(total.toString())} ${COIN_SYMBOL}. The shielded pool is a subset of circulation, checked against the node's own totals.">${conserved ? '✓' : '!'} supply conserved</span>`);
  }
  if (genesisHash) {
    chips.push(`<a class="trust-chip ok" href="#/block/0" title="Genesis is a hardcoded constant: ${esc(genesisHash)}. Click to open block #0.">✓ genesis frozen <span class="mono dim">${esc(shortHash(genesisHash, 6, 4))}</span></a>`);
  }
  chips.push(`<a class="trust-chip ok" href="#/proof" title="Consensus bytes are pinned by cross-implementation known-answer test vectors (KAT). Open the proof view.">✓ KAT-pinned</a>`);
  if (!chips.length) return '';
  return `<section class="trust-widget" aria-label="Reserve-grade guarantees">${chips.join('')}</section>`;
}

// ---- item 3: v1→v2 pool migration (best-effort local history) -------------
function loadPoolHistory() {
  try {
    const raw = localStorage.getItem(POOL_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function recordPoolSample(height, v1, v2) {
  if (!Number.isFinite(height) || v1 === null || v1 === undefined) return;
  const hist = loadPoolHistory();
  if (hist.length && hist[hist.length - 1].height === height) return; // dedupe by height
  hist.push({ height, v1: String(v1), v2: v2 === null || v2 === undefined ? '0' : String(v2) });
  while (hist.length > 500) hist.shift();
  try {
    localStorage.setItem(POOL_HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* storage full / disabled — the chart just shows what it has */
  }
}
// A voxel-vault view of the shielded-pool migration: Orchard v1 (NON-PQ) and
// the post-quantum v2 pool rendered as isometric block stacks — each cube a
// fixed XUS quantum — so the amounts read as two physical vaults. The v2 vault
// ghosts out while it is dormant (0 XUS) rather than showing an empty column.
// Honest: values are the node's live served pool state, quantised for display;
// the node retains no pool-split time-series so nothing here is a fabricated
// history.
function poolMigrationChart() {
  const hist = loadPoolHistory();
  if (hist.length < 1) {
    return `<section class="pool-migration"><h2>Shielded pool migration <span class="dim">— Orchard v1 (NON-PQ) vs post-quantum v2 (PQ)</span></h2>
      <div class="empty">Reading the live pool state — the node exposes current pool value only, so this fills in on the first sampled block.</div></section>`;
  }
  const coin = (g) => Number(BigInt(g) / 1000000n) / 100;
  const cur = hist.at(-1);
  const v1c = coin(cur.v1);
  const v2c = coin(cur.v2);
  // One cube denotes this many XUS — sized so the taller vault is ~14 cubes.
  const unit = blockUnit(Math.max(1, v1c, v2c), 14);
  const b1 = poolBlocks(v1c, unit);
  const b2 = poolBlocks(v2c, unit);
  const priv = v1c + v2c;
  const pctPq = priv > 0 ? (v2c / priv) * 100 : 0;
  const pctV1 = priv > 0 ? (v1c / priv) * 100 : 0;

  // --- isometric geometry ---------------------------------------------------
  const CW = 74; // cube front-face width
  const CH = 22; // cube front-face height
  const DP = 13; // isometric depth (top/right face offset)
  const GAP = 6; // seam between stacked cubes
  const STEP = CH + GAP;
  const rows = Math.min(20, Math.max(4, Math.ceil(Math.max(b1.total, b2.total, 4))));
  const topPad = 60; // room for the total + tag above each vault
  const botPad = 58; // room for the vault label below
  const sideL = 78; // left scale gutter
  const towerGap = 132; // breathing room between the two vaults
  const foot = CW + DP;
  const W = sideL + foot * 2 + towerGap + 46;
  const groundY = topPad + rows * STEP;
  const H = groundY + botPad;
  const x1 = sideL;
  const x2 = sideL + foot + towerGap;
  const fc1 = x1 + CW / 2; // front-face centre (for centred labels)
  const fc2 = x2 + CW / 2;

  // One isometric cube: front rect + lighter top face + darker right face.
  const cube = (x, yTop, h, cls) => `
    <g class="vx-cube">
      <polygon class="vx-top ${cls}" points="${x},${yTop} ${x + DP},${yTop - DP} ${x + CW + DP},${yTop - DP} ${x + CW},${yTop}" />
      <polygon class="vx-side ${cls}" points="${x + CW},${yTop} ${x + CW + DP},${yTop - DP} ${x + CW + DP},${(yTop - DP + h).toFixed(1)} ${x + CW},${(yTop + h).toFixed(1)}" />
      <rect class="vx-face ${cls}" x="${x}" y="${yTop}" width="${CW}" height="${h.toFixed(1)}" />
    </g>`;

  // Build a vault: solid cubes if it holds value, else a ghost outline that
  // reserves the space and reads as "dormant / awaiting migration".
  const vault = (x, info, cls, dormant) => {
    const out = [];
    if (dormant) {
      for (let i = 0; i < 3; i++) {
        out.push(cube(x, groundY - i * STEP - CH, CH, `${cls} vx-ghost`));
      }
      return out.join('');
    }
    const full = Math.min(info.full, rows);
    for (let i = 0; i < full; i++) {
      out.push(cube(x, groundY - i * STEP - CH, CH, cls));
    }
    if (info.partial > 0 && full < rows) {
      const ph = Math.max(6, CH * info.partial);
      out.push(cube(x, groundY - full * STEP - ph, ph, `${cls} vx-partial`));
    }
    return out.join('');
  };

  // Slim value scale on the left: a few clean ticks, no busy gridlines.
  const ticks = [];
  const tickEvery = rows <= 6 ? 2 : rows <= 12 ? 3 : 5;
  for (let k = 0; k <= rows; k += tickEvery) {
    const y = groundY - k * STEP;
    ticks.push(`<line class="vx-tick" x1="${sideL - 16}" y1="${y}" x2="${sideL - 8}" y2="${y}" />`);
    const label = unit < 1 ? fmtDecimal(k * unit, 2) : fmtNum(Math.round(k * unit));
    ticks.push(`<text class="vx-tick-lbl" x="${sideL - 22}" y="${y + 3.5}" text-anchor="end">${label}</text>`);
  }

  const dormantV2 = v2c <= 0;
  const fmtXus = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const towers = `
    <svg class="pm-vaults" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Shielded pool vaults: v1 Orchard ${fmtDecimal(v1c, 2)} ${COIN_SYMBOL}, post-quantum v2 ${fmtDecimal(v2c, 2)} ${COIN_SYMBOL}">
      <line class="vx-axis" x1="${sideL - 16}" y1="${topPad - 8}" x2="${sideL - 16}" y2="${groundY}" />
      <line class="vx-ground" x1="${sideL - 16}" y1="${groundY + DP + 2}" x2="${W - 24}" y2="${groundY + DP + 2}" />
      ${ticks.join('')}
      <text class="vx-total vx-t1" x="${fc1}" y="${topPad - 28}" text-anchor="middle">${fmtXus(v1c)}</text>
      <text class="vx-unit-lbl" x="${fc1}" y="${topPad - 14}" text-anchor="middle">${COIN_SYMBOL} · ${fmtDecimal(pctV1, 1)}% of private</text>
      <text class="vx-total vx-t2 ${dormantV2 ? 'vx-muted' : ''}" x="${fc2}" y="${topPad - 28}" text-anchor="middle">${dormantV2 ? '0' : fmtXus(v2c)}</text>
      <text class="vx-unit-lbl" x="${fc2}" y="${topPad - 14}" text-anchor="middle">${COIN_SYMBOL} · ${dormantV2 ? 'dormant' : `${fmtDecimal(pctPq, 1)}% of private`}</text>
      ${vault(x1, b1, 'v1', false)}
      ${vault(x2, b2, 'v2', dormantV2)}
      <text class="vx-name" x="${fc1}" y="${groundY + DP + 26}" text-anchor="middle">v1 · Orchard</text>
      <text class="vx-sub" x="${fc1}" y="${groundY + DP + 40}" text-anchor="middle">Halo2 · classical</text>
      <text class="vx-name" x="${fc2}" y="${groundY + DP + 26}" text-anchor="middle">v2 · post-quantum</text>
      <text class="vx-sub" x="${fc2}" y="${groundY + DP + 40}" text-anchor="middle">ML-KEM-768 · STARK</text>
    </svg>`;

  // Clean segmented migration meter: N cells filled green for the PQ share.
  const SEG = 28;
  const pqCells = Math.round((pctPq / 100) * SEG);
  const meter = Array.from({ length: SEG }, (_, i) => `<i class="${i < pqCells ? 'on' : ''}"></i>`).join('');

  return `<section class="pool-migration">
    <h2>Shielded pool migration <span class="dim">— Orchard v1 (NON-PQ) → post-quantum v2 (PQ)</span></h2>
    <div class="panel pm-panel">
      <div class="pm-legend">
        <span><i class="pm-sw v1"></i> v1 Orchard <b>NON-PQ</b></span>
        <span><i class="pm-sw v2"></i> v2 post-quantum <b>PQ</b></span>
        <span class="pm-unit">1 cube = ${fmtNum(unit)} ${COIN_SYMBOL}</span>
      </div>
      ${towers}
      <div class="pm-meter" role="img" aria-label="${fmtDecimal(pctPq, 1)} percent of the private supply is post-quantum">
        <div class="pm-meter-cells">${meter}</div>
        <div class="pm-meter-cap"><b>${fmtDecimal(pctPq, 1)}%</b> post-quantum${dormantV2 ? ' · v2 vault dormant, awaiting migration' : ''}</div>
      </div>
    </div>
    <p class="note">Live pool state, quantised at ${fmtNum(unit)} ${COIN_SYMBOL} per cube (the top cube is the sub-unit remainder). The node exposes only the current pool value — this is a snapshot, not a node-authoritative time-series.</p>
  </section>`;
}

function setConn(state, detail = '') {
  const c = $('conn');
  const txt = $('conn-text');
  c.className = 'conn ' + state;
  const labels = {
    live: 'live',
    syncing: 'syncing',
    degraded: 'degraded',
    down: 'offline',
    halted: 'halted',
    connecting: 'connecting…',
  };
  txt.textContent = labels[state] || labels.connecting;
  c.title = detail || 'Chain and relay status';
}

function renderOperationalStatus(status) {
  if (!status) {
    setConn(WS_OPEN ? 'connecting' : 'down');
    return;
  }
  const sync = status.sync ?? {};
  const relays = status.relays ?? {};
  const relayState = relayAvailability(relays);
  const bar = $('syncbar');
  const relayText = relayState.healthy !== null
    ? `${fmtNum(relayState.healthy)}/${fmtNum(relayState.configured)} relays healthy`
    : 'relay verification pending';
  const detail = `${relayText} · ${relayState.state} · node ${fmtNum(sync.nodeHeight ?? 0)} · indexed ${fmtNum(sync.indexedHeight ?? 0)}`;

  if (sync.phase === 'halted' || relays.consistent === false) {
    setConn('halted', detail);
    bar.hidden = false;
    bar.className = 'syncbar danger';
    bar.innerHTML = `<b>Indexing halted:</b> ${esc(sync.error || 'the configured relays disagree')}`;
    return;
  }
  if (sync.phase === 'offline') {
    setConn('down', detail);
    bar.hidden = false;
    bar.className = 'syncbar danger';
    bar.innerHTML = `<b>Relay connection lost.</b> ${esc(sync.error || 'Retrying automatically.')}`;
    return;
  }
  if (!sync.ready || sync.syncing) {
    setConn(WS_OPEN ? 'syncing' : 'connecting', detail);
    const progress = Math.max(0, Math.min(100, Number(sync.progress ?? 0) * 100));
    bar.hidden = false;
    bar.className = 'syncbar';
    bar.innerHTML = `<div><b>Verifying recent chain history</b><span>indexed ${fmtNum(sync.indexedHeight ?? 0)} of ${fmtNum(sync.nodeHeight ?? 0)} · ${progress.toFixed(1)}%</span></div><div class="sync-track" aria-hidden="true"><i style="width:${progress.toFixed(1)}%"></i></div>`;
    return;
  }
  if (relays.degraded) {
    setConn('degraded', detail);
    bar.hidden = false;
    bar.className = 'syncbar warn';
    bar.innerHTML = `<b>Degraded relay redundancy:</b> serving the pinned chain through ${esc(relayText)} while failover recovers.`;
    return;
  }
  setConn(WS_OPEN ? 'live' : 'connecting', detail);
  bar.hidden = true;
}

let ws = null;
function connectWs() {
  // Close any prior socket (e.g. after a network switch) without letting it trigger
  // a reconnect to the old network.
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  WS_OPEN = false;
  if (NET_LIVE[NET] === false) {
    setConn('down');
    return; // not-live network has no feed
  }
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${NET}`);
  } catch {
    setConn('down');
    return;
  }
  const mine = ws;
  ws.onopen = () => {
    WS_OPEN = true;
    renderOperationalStatus(LAST_STATUS);
  };
  ws.onclose = () => {
    WS_OPEN = false;
    renderOperationalStatus(LAST_STATUS);
    if (ws === mine) setTimeout(() => ws === mine && connectWs(), 2500);
  };
  ws.onerror = () => mine.close();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'reset') {
      // The node was re-genesised / rolled back; the old view is dead. Reload to
      // re-render against the fresh chain.
      setTimeout(() => location.reload(), 400);
    } else if (msg.type === 'block') {
      const b = msg.block;
      tickerPushBlock(b);
      live.onBlock?.(b);
      pollStatus();
    } else if (msg.type === 'tx') {
      live.onTx?.(msg.tx);
    }
  };
}

async function pollStatus() {
  try {
    const s = await api('/status');
    const wasReady = LAST_STATUS?.sync?.ready;
    LAST_STATUS = s;
    renderOperationalStatus(s);
    const sync = s.sync ?? {};
    $('foot-chain').textContent = s.chainId
      ? `${s.chainId} · node ${fmtNum(sync.nodeHeight ?? 0)} · indexed ${fmtNum(sync.indexedHeight ?? 0)}`
      : '';
    const heroHeight = $('hero-height');
    if (heroHeight) odometer(heroHeight, sync.nodeHeight ?? s.tipHeight ?? 0, fmtNum, 'hero-height');
    const heroIndexed = $('hero-indexed');
    if (heroIndexed) heroIndexed.textContent = fmtNum(sync.indexedHeight ?? s.tipHeight ?? 0);
    const onLatestBlocks = (location.hash || '#/') === '#/blocks';
    const renderedTip = Number(view.dataset.tipHeight ?? -1);
    if (
      (wasReady === false && sync.ready === true)
      || (sync.ready && onLatestBlocks && renderedTip < Number(sync.indexedHeight ?? 0))
    ) {
      await route().catch((e) => errView(e.message));
    }
  } catch {
    setConn('down', 'Explorer API is unreachable');
  }
}

(async () => {
  drawSealStars();
  await loadNetworks(); // resolve live networks + wire the switch before first render
  connectWs();
  seedTicker(); // seed the rolling ticker from recent block history (non-blocking)
  await pollStatus();
  setInterval(pollStatus, 5000);
  await route().catch((e) => errView(e.message));
})();
