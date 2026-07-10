// Sovereign Explorer — single-page UI. Hash-routed, fetches the REST API, and follows
// a WebSocket live feed. All values shown are real chain data served by the node.

const $ = (id) => document.getElementById(id);
const view = $('view');

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
  const tickerItems = $('ticker-items');
  if (ticker) ticker.hidden = true;
  if (tickerItems) tickerItems.replaceChildren();
  localStorage.setItem('sov-net-v2', net);
  document.title = `Sovereign Explorer — ${net}`;
  setNetToggleUI();
  connectWs();
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
  document.title = `Sovereign Explorer — ${NET}`;
  setNetToggleUI();
  for (const b of document.querySelectorAll('#netsw button')) {
    b.addEventListener('click', () => switchNet(b.dataset.net));
  }
}

function renderNotLive(routeId) {
  const label = NET.charAt(0).toUpperCase() + NET.slice(1);
  setView(
    `<div class="empty notlive">🚀 <b>${esc(label)} is launching soon.</b><br />` +
      `<span class="dim">This network isn't live yet — switch to Testnet to explore the running chain.</span></div>`,
    routeId,
  );
}

async function api(path) {
  const res = await fetch('/api/' + NET + path);
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || `HTTP ${res.status}`);
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
      return `asset ${esc(shortHash(action.asset, 8, 6))} → ${acctLink(action.to)} · <b>${fmtCoin(action.amount)}</b>`;
    case 'token_burn':
      return `asset ${esc(shortHash(action.asset, 8, 6))} · <b>${fmtCoin(action.amount)}</b>`;
    case 'shielded':
      return `shielded bundle (${fmtBytes((action.bundle || []).length)})`;
    case 'htlc_lock':
      return `HTLC lock → ${acctLink(action.recipient)} · <b>${fmtCoin(action.amount)}</b> ${COIN_SYMBOL}`;
    case 'htlc_claim':
      return `HTLC claim ${esc(shortHash(action.htlc_id, 8, 6))}`;
    case 'htlc_refund':
      return `HTLC refund ${esc(shortHash(action.htlc_id, 8, 6))}`;
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
      return `NFT → ${acctLink(action.to)}`;
    case 'nft_set_meta':
      return `set NFT metadata`;
    default:
      return '';
  }
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
  const [status, blocks, txs, supply] = await Promise.all([
    api('/status'),
    api('/blocks?limit=12'),
    api('/txs?limit=12'),
    api('/supply').catch(() => null),
  ]);
  const s = status;
  const all = s.allTime ?? {};
  const day = s.last24h ?? {};
  const mempool = s.mempool ?? {};
  const sync = s.sync ?? {};
  const relay = s.relays ?? {};
  const relayText = relay.healthy !== undefined
    ? `${fmtNum(relay.healthy)}/${fmtNum(relay.verified)} relays${relay.consistent === false ? ' · disagreement' : relay.degraded ? ' · degraded' : ' · consistent'}`
    : 'relay status pending';
  setView(`
    <section class="hero-strip">
      <div>
        <h1>Sovereign</h1>
        <p><span id="hero-chain">${esc(s.chainId || 'Chain')}</span> · node height <span id="hero-height">${fmtNum(sync.nodeHeight ?? s.tipHeight ?? 0)}</span>${sync.ready ? '' : ` · indexing <span id="hero-indexed">${fmtNum(sync.indexedHeight ?? 0)}</span>`}</p>
      </div>
      <div class="hero-meta">
        <span>Genesis ${esc(shortHash(s.genesisHash, 10, 6))}</span>
        <span>${fmtNum(s.blocksIndexed)} indexed blocks</span>
        <span class="relay-pill ${relay.degraded ? 'degraded' : ''}">${esc(relayText)}</span>
      </div>
    </section>

    <div class="stat-columns">
      <section class="stat-card">
        <h2>All time</h2>
        ${statItem('Circulation', `${fmtCoin(all.circulationGrains)} ${COIN_SYMBOL}`, `${pct(s.mintedOfCap)} of 21,000,000 cap minted`)}
        ${statItem('Shielded supply', supply ? `${fmtDecimal(supply.shieldedPercent ?? 0, 2)}%` : '—', supply ? `${fmtCoin(supply.shielded)} ${COIN_SYMBOL} private of ${fmtCoin(supply.total)} (Zcash-style)` : 'node unreachable')}
        ${statItem('Market cap', fmtUsd(all.marketCapUsd), 'price feed not configured')}
        ${statItem('Market dominance', all.marketDominance === null || all.marketDominance === undefined ? '—' : pct(all.marketDominance), 'market feed not configured')}
        ${statItem('Blockchain size', fmtBytes(all.blockchainSizeBytes), 'indexed window')}
        ${statItem('Network nodes', all.networkNodes === null || all.networkNodes === undefined ? '—' : fmtNum(all.networkNodes), 'miner registry entries')}
        ${statItem('Difficulty', all.difficulty === null || all.difficulty === undefined ? '—' : esc(fmtNum(all.difficulty)), esc(all.difficultyAlgo === 'Sha256d' ? 'SHA-256d' : (all.difficultyAlgo || 'PoW')))}
      </section>

      <section class="stat-card">
        <h2>${day.windowComplete ? '24h statistics' : 'Indexed activity'}</h2>
        ${statItem('Transactions', fmtNum(day.transactions))}
        ${statItem('Transactions per second', fmtDecimal(day.transactionsPerSecond ?? 0, 4))}
        ${statItem('Blocks', fmtNum(day.blocks))}
        ${statItem('Volume', `${fmtCoin(day.volumeGrains)} ${COIN_SYMBOL}`, `transparent ${COIN_SYMBOL} volume`)}
        ${statItem('Median transaction fee', fmtUsd(day.medianTransactionFeeUsd), 'fee index not exposed by node')}
        ${statItem('Average transaction fee', fmtUsd(day.averageTransactionFeeUsd), 'fee index not exposed by node')}
        ${statItem('Hashrate', fmtHashrate(day.hashrate), day.hashrate == null ? 'measuring — needs a few blocks' : 'estimated from recent block work')}
        ${!day.windowComplete ? `<p class="stat-footnote">Building the recent window; values become a full 24h view after synchronization.</p>` : ''}
      </section>

      <section class="stat-card">
        <h2>Mempool</h2>
        ${statItem('Transactions', fmtNum(mempool.transactions))}
        ${statItem('Transactions per second', mempool.transactionsPerSecond === null || mempool.transactionsPerSecond === undefined ? '—' : fmtDecimal(mempool.transactionsPerSecond, 4))}
        ${statItem('Outputs', mempool.outputs === null || mempool.outputs === undefined ? '—' : fmtNum(mempool.outputs))}
        ${statItem('Fee total', fmtUsd(mempool.feeTotalUsd), 'fee index not exposed by node')}
        ${statItem('Size', fmtBytes(mempool.sizeBytes), 'mempool bytes not exposed')}
      </section>
    </div>

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
  // Live: new blocks and txs stream into their tables in place.
  live.onBlock = (b) => livePrepend('ov-blocks', blockRow(b), 12);
  live.onTx = (t) => livePrepend('ov-txs', txRow({ ...t, timestampMs: t.timestampMs ?? Date.now() }), 12);
}

function blockRow(b) {
  const coinbase = b.coinbase ? fmtCoin(b.coinbase.reward) + ' ' + COIN_SYMBOL : '<span class="dim">—</span>';
  return `<tr><td>${blockLink(b.height)}</td><td>${acctLinkShort(b.proposer)}</td><td class="right num">${fmtNum(b.txCount)}</td><td class="right num">${coinbase}</td><td class="dim" title="${esc(new Date(b.timestampMs).toLocaleString())}">${timeAgo(b.timestampMs)}</td><td>${finalBadge(b.final)}</td></tr>`;
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
  view.dataset.tipHeight = String(highest);
  // Live: on the latest page (no cursor), new blocks stream in at the top.
  if (cursor === null) {
    live.onBlock = () => route().catch((e) => errView(e.message));
  }
}

function blocksListRow(b) {
  return `<tr>
    <td>${blockLink(b.height)}</td>
    <td>${blockHashLink(b.hash)}</td>
    <td>${b.proposer ? acctLinkShort(b.proposer) : '<span class="dim">genesis</span>'}</td>
    <td class="right num">${fmtNum(b.txCount)}</td>
    <td class="right num">${b.coinbase ? fmtCoin(b.coinbase.reward) + ' ' + COIN_SYMBOL : '<span class="dim">—</span>'}</td>
    <td class="time" title="${new Date(Number(b.timestampMs)).toISOString?.() || ''} · ${esc(b.timestampMs)} ms">${fmtDateTime(b.timestampMs)}</td>
    <td class="right dim">${fmtAge(b.timestampMs)}</td>
    <td>${finalBadge(b.final)}</td></tr>`;
}

async function renderBlock(ref, routeId) {
  setView('<div class="loading">Loading block…</div>', routeId);
  let b;
  try {
    b = await api('/block/' + encodeURIComponent(ref));
  } catch (e) {
    return errView(e.message, routeId);
  }
  const txs = b.transactions || [];
  setView(`
    <div class="crumb"><a href="#/blocks">Blocks</a> / Block #${fmtNum(b.height)}</div>
    <h1>Block #${fmtNum(b.height)} ${finalBadge(b.final)}</h1>
    <div class="panel"><table class="kv">
      <tr><td class="k">Hash</td><td class="v">${esc(b.hash)} ${copyButton(b.hash, 'block hash')}</td></tr>
      <tr><td class="k">Parent</td><td class="v">${b.height > 0 ? blockHashLink(b.prevHash) : '<span class="dim">genesis</span>'}</td></tr>
      <tr><td class="k">Miner</td><td class="v">${acctLink(b.proposer)}</td></tr>
      <tr><td class="k">Timestamp</td><td class="v">${new Date(b.timestampMs).toLocaleString()} <span class="dim">(${esc(b.timestampMs)} ms)</span></td></tr>
      <tr><td class="k">Transactions</td><td class="v">${fmtNum(b.txCount)}</td></tr>
      <tr><td class="k">State root</td><td class="v">${esc(b.stateRoot)} ${copyButton(b.stateRoot, 'state root')}</td></tr>
      <tr><td class="k">Tx root</td><td class="v">${esc(b.txRoot)} ${emptyRootBadge(b.txCount === 0)} ${copyButton(b.txRoot, 'transaction root')}</td></tr>
      <tr><td class="k">Receipts root</td><td class="v">${esc(b.receiptsRoot)} ${emptyRootBadge(b.txCount === 0)} ${copyButton(b.receiptsRoot, 'receipts root')}</td></tr>
      <tr><td class="k">Finality</td><td class="v">${b.final ? 'Final — buried past the Nakamoto confirmation depth' : 'Pending — waiting for more confirmations'}</td></tr>
    </table></div>
    ${coinbasePanel(b.coinbase)}
    <h2>Transactions</h2>
    <div class="panel"><table><thead><tr><th>Tx</th><th>Type</th><th>Signer</th><th>Detail</th></tr></thead>
    <tbody>${txs.map((t) => `<tr><td>${txLink(t.id)}</td><td>${actionBadge(t.action)}</td><td>${acctLinkShort(t.signer)}</td><td>${actionSummary(t.action)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
  `, routeId);
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

/** The XUS value a transaction moves, when its action carries one. */
function actionValue(action) {
  if (!action) return null;
  switch (action.type) {
    case 'transfer':
    case 'htlc_lock':
      return action.amount;
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
  try {
    const res = await fetch('/api/' + NET + '/tx/' + encodeURIComponent(id));
    const body = await res.json();
    if (!res.ok) {
      // A just-submitted transaction has no receipt yet — show a live waiting
      // state and re-check every 5s while this page stays open, so the payout
      // link a wallet/faucet hands out "just works" once the block lands.
      if (body.pending) {
        const here = location.hash;
        setTimeout(() => { if (location.hash === here) route(); }, 5000);
        return setView(`
          <div class="crumb">Transaction</div>
          <h1>Waiting to be mined… <span class="badge pending">Pending</span></h1>
          <div class="panel"><table class="kv">
            <tr><td class="k">Id</td><td class="v">${esc(id)}</td></tr>
            <tr><td class="k">Status</td><td class="v">Not in a block yet — mainnet targets a block every 2.5 minutes. This page checks again automatically every few seconds.</td></tr>
          </table></div>
        `, routeId);
      }
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    t = body;
  } catch (e) {
    return errView(e.message, routeId);
  }
  const r = t.receipt;
  const value = actionValue(t.action);
  const events = r?.events || [];
  const returnData = r?.return_data || r?.returnData || [];
  setView(`
    <div class="crumb">Transaction</div>
    <h1>Transaction ${actionBadge(t.action)} ${finalBadge(t.final)}</h1>
    <div class="panel"><table class="kv">
      <tr><td class="k">Id</td><td class="v">${esc(t.id)} ${copyButton(t.id, 'transaction id')}</td></tr>
      <tr><td class="k">Status</td><td class="v">${receiptStatus(r)}</td></tr>
      <tr><td class="k">Block</td><td class="v">${blockLink(t.blockHeight)} · ${blockHashLink(t.blockHash)}</td></tr>
      <tr><td class="k">Confirmations</td><td class="v">${fmtNum(t.confirmations)} ${t.final ? '<span class="dim">— final (buried past the 6-confirmation Nakamoto depth)</span>' : '<span class="dim">— pending finality (6 required)</span>'}</td></tr>
      <tr><td class="k">Position</td><td class="v">#${t.index} in block</td></tr>
      <tr><td class="k">Timestamp</td><td class="v">${new Date(t.timestampMs).toLocaleString()} <span class="dim">(${timeAgo(t.timestampMs)})</span></td></tr>
      <tr><td class="k">Signer</td><td class="v">${acctLink(t.signer)}</td></tr>
      <tr><td class="k">Nonce</td><td class="v">${fmtNum(t.nonce)}</td></tr>
      <tr><td class="k">Action</td><td class="v">${esc(t.action?.type)} — ${actionSummary(t.action)}</td></tr>
      ${value !== null ? `<tr><td class="k">Value</td><td class="v"><b>${fmtCoin(value)}</b> ${COIN_SYMBOL}</td></tr>` : ''}
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
    <h2>Raw action</h2>
    <div class="panel"><details class="raw" open><summary>decoded action payload (as indexed from the block)</summary><pre class="mono">${esc(fmtActionJson(t.action))}</pre></details></div>
  `, routeId);
}

async function renderAccount(idRaw, routeId) {
  const id = decodeURIComponent(idRaw);
  setView('<div class="loading">Loading account…</div>', routeId);
  let data;
  try {
    data = await api('/account/' + encodeURIComponent(id));
  } catch (e) {
    return errView(e.message, routeId);
  }
  const a = data.account;
  const acct = data.id || id; // the resolved account (if `id` was an SNS name)
  const txs = data.transactions || [];
  const names = data.names || [];
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
    <h1 class="mono">${esc(acct)} ${copyButton(acct, 'account')}</h1>
    ${data.resolvedFrom ? `<p class="dim">↳ <span class="mono">${esc(data.resolvedFrom)}</span> resolves here</p>` : ''}
    ${names.length ? `<p class="dim">SNS: ${names.map((n) => `<span class="mono">${esc(n)}</span>`).join(', ')}</p>` : ''}
    <div class="panel"><table class="kv">${kv}</table></div>
    <h2>Indexed Transactions</h2>
    <div class="panel"><table><thead><tr><th>Tx</th><th>Type</th><th>Detail</th><th class="right">Block</th></tr></thead>
    <tbody>${txs.map((t) => `<tr><td>${txLink(t.id)}</td><td>${actionBadge(t.action)}</td><td>${t.signer === acct ? actionSummary(t.action) : `from ${acctLink(t.signer)}`}</td><td class="right">${blockLink(t.blockHeight)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
    <p class="note">Transaction history is from the explorer's indexed window; balances are read live from the node.</p>
  `, routeId);
}

async function renderMiners(routeId) {
  setView('<div class="loading">Loading miners…</div>', routeId);
  const [observed, miners] = await Promise.all([api('/observed-miners'), api('/miners')]);
  setView(`
    <h1>Miners</h1>
    <div class="cards">
      <div class="card"><div class="label">Active miners</div><div class="value num">${observed.miners.length}</div><div class="sub">observed in indexed blocks</div></div>
      <div class="card"><div class="label">Registered miners</div><div class="value num">${miners.length}</div><div class="sub">reported by the node</div></div>
      <div class="card"><div class="label">Consensus</div><div class="value mono" style="font-size:16px">Nakamoto</div><div class="sub">heaviest-work fork choice</div></div>
    </div>
    <h2>Observed Block Miners</h2>
    <div class="panel"><table><thead><tr><th>Miner</th><th class="right">Blocks mined</th><th class="right">Last height</th></tr></thead>
    <tbody>${observed.miners.map((x) => `<tr><td>${acctLink(x.account)}</td><td class="right num">${fmtNum(x.blocksMined)}</td><td class="right">${blockLink(x.lastHeight)}</td></tr>`).join('') || emptyRow(3)}</tbody></table></div>
    <h2>Miner Registry</h2>
    <div class="panel"><table><thead><tr><th>Miner</th><th class="right">Blocks mined</th><th class="right">First seen</th><th class="right">Last seen</th></tr></thead>
    <tbody>${miners.map((m) => `<tr><td>${acctLink(m.account)}</td><td class="right num">${fmtNum(m.blocksMined ?? m.mineTxs ?? 0)}</td><td class="right">${blockLink(m.firstSeenHeight)}</td><td class="right">${blockLink(m.lastSeenHeight)}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
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

async function renderSns(routeId) {
  setView('<div class="loading">Loading names…</div>', routeId);
  // The Sovereign Name Service: human-readable *.sov names that resolve to
  // accounts. Each name is a non-fungible token in the reserved SNS collection.
  const page = await api('/names?limit=200');
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
      <div class="card"><div class="label">Shielded supply</div><div class="value num">${fmtDecimal(stats.supply?.shieldedPercent ?? 0, 2)}<span class="unit">%</span></div><div class="sub">${fmtCoin(stats.supply?.shielded)} ${COIN_SYMBOL} private (Zcash-style)</div><div class="bar"><i style="width:${Math.min(100, stats.supply?.shieldedPercent ?? 0)}%"></i></div></div>
      <div class="card"><div class="label">Finality depth</div><div class="value num">6</div><div class="sub">confirmation convention</div></div>
      <div class="card"><div class="label">Mempool</div><div class="value num">${fmtNum(stats.mempoolSize)}</div></div>
      <div class="card"><div class="label">Blocks indexed</div><div class="value num">${fmtNum(stats.blocksIndexed)}</div></div>
      <div class="card"><div class="label">Transactions retained</div><div class="value num">${fmtNum(stats.transactionsRetained ?? stats.transactionsIndexed)}</div><div class="sub">memory-bounded indexed window</div></div>
    </div>
    <h2>Issuance Over Time</h2>
    <div class="panel" style="padding:18px">${issuanceChart(supplySeries)}
      <div class="legend"><span><i style="background:#3f6fff"></i>Mined (PoW)</span></div>
    </div>
    <p class="note">Issuance is sampled live as the explorer follows the chain — each point is the chain's committed supply at that height. The 21,000,000 ${COIN_SYMBOL} hard cap is enforced on-chain by exact-integer accounting.</p>
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

async function renderProof(routeId) {
  setView('<div class="loading">Loading Sovereign proof…</div>', routeId);
  const proof = await api('/proof');
  const relays = proof.relays ?? {};
  const crypto = proof.cryptography ?? {};
  const layout = crypto.hybrid65Layout ?? {};
  const supply = proof.privacy?.supply ?? {};
  const shielded = proof.privacy?.shieldedInfo ?? {};
  const empty = proof.commitments?.deterministicEmpty;
  const nonEmpty = proof.commitments?.latestNonEmpty;
  const commonHash = relays.commonHash
    ? (String(relays.commonHash).startsWith('0x') ? relays.commonHash : `0x${relays.commonHash}`)
    : null;
  const quorumLabel = relays.consistent === false
    ? 'DISAGREEMENT — INDEXING HALTED'
    : relays.consistent === true
      ? `agreed through block #${fmtNum(relays.commonHeight)}`
      : 'single-source / comparison pending';
  const pool = safeBigInt(shielded.poolValue ?? supply.shielded);
  const available = safeBigInt(shielded.deshieldableNowGrains);
  const limit = safeBigInt(shielded.deshieldLimitGrains);
  const fullyExitCapable = pool > 0n && available >= pool;
  const resetHeight = Number(shielded.windowResetsAtHeight ?? 0);
  const windowElapsed = resetHeight > 0 && Number(shielded.height ?? 0) >= resetHeight;
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
        <div class="proof-heading"><div><span class="eyebrow">CHAIN PROVENANCE</span><h2>Relay quorum</h2></div><span class="proof-state ${relays.consistent === false ? 'bad' : relays.degraded ? 'warn' : 'ok'}">${esc(quorumLabel)}</span></div>
        <div class="evidence-kv">
          <span>Chain id</span><b class="mono">${esc(proof.identity?.chainId)}</b>
          <span>Genesis</span><b class="mono break">${esc(proof.identity?.genesisHash)} ${copyButton(proof.identity?.genesisHash, 'genesis hash')}</b>
          <span>Common-head hash</span><b class="mono break">${commonHash ? `${esc(commonHash)} ${copyButton(commonHash, 'common-head hash')}` : '—'}</b>
          <span>Node / indexed</span><b class="mono">${fmtNum(proof.sync?.nodeHeight)} / ${fmtNum(proof.sync?.indexedHeight)}</b>
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
        <p class="proof-note">The limiter is visible policy, separate from shielded-pool validity. Because the configured ceiling exceeds the live pool, it does not currently throttle a full pool exit.</p>
      </section>

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
  liveReset(); // the incoming view re-registers its own live hooks
  // A not-yet-live network (e.g. mainnet pre-launch) shows a launching-soon panel
  // instead of querying a node that doesn't exist.
  if (NET_LIVE[NET] === false) {
    renderNotLive(routeId);
    return Promise.resolve();
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, head, arg] = hash.split('/');
  setActiveNav(hash);
  let task;
  if (!head) task = renderOverview(routeId);
  else if (head === 'proof') task = renderProof(routeId);
  else if (head === 'blocks') task = renderBlocks(arg, routeId);
  else if (head === 'block') task = renderBlock(arg, routeId);
  else if (head === 'tx') task = renderTx(arg, routeId);
  else if (head === 'account') task = renderAccount(arg, routeId);
  else if (head === 'miners' || head === 'validators') task = renderMiners(routeId);
  else if (head === 'analytics') task = renderAnalytics(routeId);
  else if (head === 'sns') task = renderSns(routeId);
  else if (head === 'validity') task = renderValidity(routeId);
  else task = renderOverview(routeId);
  return Promise.resolve(task).catch((e) => errView(e.message, routeId));
}

function setActiveNav(hash) {
  const top = '#/' + (hash.split('/')[1] || '');
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
  const button = event.target.closest?.('.copy-btn');
  if (!button) return;
  try {
    const value = decodeURIComponent(button.dataset.copy || '');
    await navigator.clipboard.writeText(value);
    const old = button.textContent;
    button.textContent = '✓';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = old;
      button.classList.remove('copied');
    }, 1200);
  } catch {
    button.title = 'Copy failed — select the value manually';
  }
});

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

function pushTicker(text) {
  const items = $('ticker-items');
  const t = $('ticker');
  if (!items) return;
  t.hidden = false;
  const chip = document.createElement('span');
  chip.className = 'ticker-chip';
  chip.innerHTML = text;
  items.prepend(chip);
  while (items.children.length > 14) items.lastChild.remove();
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
  const bar = $('syncbar');
  const relayText = relays.healthy !== undefined
    ? `${fmtNum(relays.healthy)}/${fmtNum(relays.verified)} verified relays`
    : 'relay verification pending';
  const detail = `${relayText}${relays.consistent === true ? ' · consistent' : relays.consistent === false ? ' · DISAGREE' : ' · degraded'} · node ${fmtNum(sync.nodeHeight ?? 0)} · indexed ${fmtNum(sync.indexedHeight ?? 0)}`;

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
      pushTicker('<b>chain reset</b> · reloading…');
      setTimeout(() => location.reload(), 400);
    } else if (msg.type === 'block') {
      const b = msg.block;
      pushTicker(`<b>Block #${fmtNum(b.height)}</b> · ${fmtNum(b.txCount)} tx`);
      live.onBlock?.(b);
      pollStatus();
    } else if (msg.type === 'tx') {
      pushTicker(`tx <b>${esc(msg.tx.action?.type || 'tx')}</b> · ${esc(shortHash(msg.tx.id))}`);
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
    if (heroHeight) heroHeight.textContent = fmtNum(sync.nodeHeight ?? s.tipHeight ?? 0);
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
  await pollStatus();
  setInterval(pollStatus, 5000);
  await route().catch((e) => errView(e.message));
})();
