// Redundant JSON-RPC client for SOV relays.
//
// The explorer is informational infrastructure, but users still rely on it to show
// the correct chain. A single unpinned HTTP endpoint is therefore not enough: this
// client verifies every configured relay's chain id + genesis, fails over between
// healthy relays, and compares their block hash at a common height before the indexer
// advances. Relay URLs are never returned to browsers or included in errors.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_PROBE_TTL_MS = 5_000;

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  return value.toLowerCase().replace(/^0x/, '');
}

function publicRelayLabel(raw, index) {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return `relay-${index + 1}`;
  }
}

function loopbackHostname(hostname) {
  const host = String(hostname).toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateRelayUrl(raw, index, requireTls) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`relay ${index + 1} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`relay ${index + 1} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`relay ${index + 1} must not embed credentials in its URL`);
  }
  if (requireTls && parsed.protocol !== 'https:' && !loopbackHostname(parsed.hostname)) {
    throw new Error(`relay ${index + 1} requires TLS because it is not loopback`);
  }
  return parsed.toString();
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s)]+/g, '[relay]');
}

class RpcResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpcResponseError';
    this.relayResponded = true;
  }
}

export class RelayDivergenceError extends Error {
  constructor(height) {
    super(`configured relays disagree at common height ${height}; indexing halted`);
    this.name = 'RelayDivergenceError';
    this.height = height;
  }
}

async function responseBytes(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`RPC response exceeds ${maxBytes} byte limit`);
  }

  if (!res.body?.getReader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`RPC response exceeds ${maxBytes} byte limit`);
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`RPC response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class SovereignRpc {
  constructor(urls, opts = {}) {
    const list = (Array.isArray(urls) ? urls : [urls])
      .flatMap((value) => String(value ?? '').split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    if (list.length === 0) throw new Error('at least one relay RPC URL is required');

    const requireTls = opts.requireTls === true;
    const validated = list.map((url, index) => validateRelayUrl(url, index, requireTls));

    this.relays = [...new Set(validated)].map((url, index) => ({
      url,
      label: publicRelayLabel(url, index),
      tls: url.startsWith('https:'),
      enabled: true,
      verified: false,
      healthy: null,
      height: null,
      latencyMs: null,
      lastOkAt: null,
      lastError: null,
      chainId: null,
      genesisHash: null,
    }));
    this.expectedChainId = opts.expectedChainId ?? null;
    this.expectedGenesisHash = normalizeHash(opts.expectedGenesisHash);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.probeTtlMs = opts.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.metrics = opts.metrics ?? null;
    this.networkName = opts.networkName ?? 'unknown';
    this._id = 0;
    this._verified = false;
    this._probeAt = 0;
    this._probeResult = null;
    this._cursor = 0;
  }

  async _callRelay(relay, method, params = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params });
      const res = await fetch(relay.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await responseBytes(res, this.maxResponseBytes);
      let json;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error('invalid JSON response');
      }
      relay.healthy = true;
      relay.latencyMs = Date.now() - started;
      relay.lastOkAt = Date.now();
      relay.lastError = null;
      if (json.error) {
        throw new RpcResponseError(`${method}: ${json.error.message} (code ${json.error.code})`);
      }
      return json.result;
    } catch (error) {
      this.metrics?.observeUpstream(this.networkName, method);
      if (!error?.relayResponded) relay.healthy = false;
      relay.lastError = safeError(error?.name === 'AbortError' ? new Error('request timed out') : error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  _candidates() {
    return this.relays
      .filter((relay) => relay.enabled && relay.verified)
      .sort((a, b) => {
        if (a.healthy !== b.healthy) return a.healthy === true ? -1 : b.healthy === true ? 1 : 0;
        return (b.height ?? -1) - (a.height ?? -1);
      });
  }

  _orderedCandidates() {
    const candidates = this._candidates();
    const offset = candidates.length > 1 ? this._cursor++ % candidates.length : 0;
    return candidates.slice(offset).concat(candidates.slice(0, offset));
  }

  /** Call one relay, failing over on transport/HTTP/RPC errors. */
  async call(method, params = {}, { nonNull = false } = {}) {
    const errors = [];
    let sawNull = false;
    // Share ordinary read load across equally healthy relays while preserving the
    // candidate ordering for failover. This keeps a cold backfill from hammering only
    // the first public relay.
    for (const relay of this._orderedCandidates()) {
      try {
        const result = await this._callRelay(relay, method, params);
        if (nonNull && result == null) {
          sawNull = true;
          continue;
        }
        return result;
      } catch (error) {
        errors.push(`${relay.label}: ${safeError(error)}`);
      }
    }
    if (sawNull) return null;
    throw new Error(`all configured relays failed ${method}: ${errors.join('; ')}`);
  }

  /**
   * Verify each relay independently. A relay with the wrong chain id or genesis is
   * quarantined permanently for this process. At least one valid relay is required.
   */
  async _verifyRelay(relay) {
    try {
      const [chainId, genesis, height] = await Promise.all([
        this._callRelay(relay, 'sov_chainId'),
        this._callRelay(relay, 'sov_getBlockDigest', { height: 0 }),
        this._callRelay(relay, 'sov_getHeight'),
      ]);
      const genesisHash = normalizeHash(genesis?.hash);
      relay.chainId = chainId;
      relay.genesisHash = genesisHash;
      relay.height = Number(height);
      const wrongChain = this.expectedChainId && chainId !== this.expectedChainId;
      const wrongGenesis = this.expectedGenesisHash && genesisHash !== this.expectedGenesisHash;
      if (wrongChain || wrongGenesis) {
        relay.enabled = false;
        relay.verified = false;
        relay.healthy = false;
        relay.lastError = wrongChain
          ? `chain id ${chainId} does not match pinned ${this.expectedChainId}`
          : 'genesis hash does not match the frozen network identity';
        return false;
      }
      relay.verified = true;
      return true;
    } catch (error) {
      relay.verified = false;
      relay.healthy = false;
      relay.lastError = safeError(error);
      return false;
    }
  }

  async verifyRelays() {
    await Promise.all(this.relays.map((relay) => this._verifyRelay(relay)));

    const valid = this.relays.filter((relay) => relay.enabled && relay.verified);
    if (valid.length === 0) throw new Error('no configured relay passed chain identity verification');

    // When no explicit identity was supplied (custom/dev network), pin this process to
    // the first valid relay and quarantine any different chain before continuing.
    const chainId = this.expectedChainId ?? valid[0].chainId;
    const genesisHash = this.expectedGenesisHash ?? valid[0].genesisHash;
    for (const relay of valid) {
      if (relay.chainId !== chainId || relay.genesisHash !== genesisHash) {
        relay.enabled = false;
        relay.verified = false;
        relay.healthy = false;
        relay.lastError = 'relay does not match the selected chain identity';
      }
    }
    if (!this.relays.some((relay) => relay.enabled && relay.verified)) {
      throw new Error('configured relays do not agree on one chain identity');
    }
    this.expectedChainId = chainId;
    this.expectedGenesisHash = genesisHash;
    this._verified = true;
    this._probeAt = 0;
    return this.probe({ force: true });
  }

  /**
   * Compare healthy relays at their common height. Two healthy relays that disagree
   * are a fail-closed condition; one temporarily unavailable relay is degraded but
   * still usable because the remaining source has already passed the genesis pin.
   */
  async probe({ force = false } = {}) {
    if (!this._verified) throw new Error('relay identity has not been verified');
    if (!force && this._probeResult && Date.now() - this._probeAt < this.probeTtlMs) {
      return this._probeResult;
    }

    // A relay that was offline during boot may join later, but it must pass the full
    // chain-id/genesis check before it is allowed into the candidate pool.
    const pending = this.relays.filter((relay) => relay.enabled && !relay.verified);
    if (pending.length) await Promise.all(pending.map((relay) => this._verifyRelay(relay)));
    const enabled = this.relays.filter((relay) => relay.enabled && relay.verified);
    const heights = await Promise.all(enabled.map(async (relay) => {
      try {
        const height = Number(await this._callRelay(relay, 'sov_getHeight'));
        if (!Number.isSafeInteger(height) || height < 0) throw new Error('invalid relay height');
        relay.height = height;
        return { relay, height };
      } catch {
        return null;
      }
    }));
    const healthy = heights.filter(Boolean);
    if (healthy.length === 0) throw new Error('no verified relay is currently reachable');

    let bestHeight = Math.max(...healthy.map((entry) => entry.height));
    let commonHeight = Math.min(...healthy.map((entry) => entry.height));
    let consistent = null;
    let commonHash = null;
    if (healthy.length >= 2) {
      const digests = await Promise.all(healthy.map(async ({ relay }) => {
        try {
          const digest = await this._callRelay(relay, 'sov_getBlockDigest', { height: commonHeight });
          const hash = normalizeHash(digest?.hash);
          if (!hash) throw new Error('invalid block digest during consistency check');
          return { relay, hash };
        } catch (error) {
          relay.healthy = false;
          relay.lastError = safeError(error);
          return null;
        }
      }));
      const comparable = digests.filter((entry) => entry?.hash);
      if (comparable.length >= 2) {
        commonHash = comparable[0].hash;
        consistent = comparable.every((entry) => entry.hash === commonHash);
      }
    }

    const active = healthy.filter(({ relay }) => relay.healthy === true);
    if (active.length === 0) throw new Error('no verified relay passed the consistency probe');
    bestHeight = Math.max(...active.map((entry) => entry.height));
    if (active.length < 2) commonHeight = active[0].height;

    this._probeResult = {
      configured: this.relays.length,
      verified: enabled.length,
      healthy: active.length,
      bestHeight,
      commonHeight,
      commonHash,
      consistent,
      degraded: active.length < enabled.length || consistent !== true,
    };
    this._probeAt = Date.now();
    return this._probeResult;
  }

  status() {
    return {
      ...(this._probeResult ?? {
        configured: this.relays.length,
        verified: this.relays.filter((relay) => relay.enabled && relay.verified).length,
        healthy: this.relays.filter((relay) => relay.healthy).length,
        bestHeight: null,
        commonHeight: null,
        commonHash: null,
        consistent: null,
        degraded: true,
      }),
      relays: this.relays.map((relay) => ({
        name: relay.label,
        transport: relay.tls ? 'tls' : 'plain-http',
        enabled: relay.enabled,
        verified: relay.verified,
        healthy: relay.healthy,
        height: relay.height,
        latencyMs: relay.latencyMs,
        lastOkAt: relay.lastOkAt,
        error: relay.lastError,
      })),
    };
  }

  async chainId() {
    if (!this._verified) await this.verifyRelays();
    return this.expectedChainId;
  }

  async height() {
    const status = await this.probe();
    if (status.consistent === false) throw new RelayDivergenceError(status.commonHeight);
    return status.bestHeight;
  }

  head() { return this.call('sov_getHead'); }
  /** Fetch a block and its digest from the SAME relay, then fail over as one unit. */
  async blockWithDigest(height) {
    const errors = [];
    for (const relay of this._orderedCandidates()) {
      try {
        const [block, digest] = await Promise.all([
          this._callRelay(relay, 'sov_getBlockByHeight', { height }),
          this._callRelay(relay, 'sov_getBlockDigest', { height }),
        ]);
        if (block && digest) return { block, digest };
      } catch (error) {
        errors.push(`${relay.label}: ${safeError(error)}`);
      }
    }
    if (errors.length) throw new Error(`all configured relays failed block ${height}: ${errors.join('; ')}`);
    return null;
  }
  blockByHeight(height) { return this.call('sov_getBlockByHeight', { height }, { nonNull: true }); }
  blockByHash(hash) { return this.call('sov_getBlockByHash', { hash }, { nonNull: true }); }
  blockDigest(height) { return this.call('sov_getBlockDigest', { height }, { nonNull: true }); }
  supply() { return this.call('sov_getSupply'); }
  shieldedInfo() { return this.call('sov_getShieldedInfo'); }
  account(account) { return this.call('sov_getAccount', { account }); }
  difficulty() { return this.call('sov_getDifficulty'); }
  stateRoot() { return this.call('sov_getStateRoot'); }
  isFinal(hash) { return this.call('sov_isFinal', { hash }); }
  receipt(txId) { return this.call('sov_getReceipt', { txId }, { nonNull: true }); }
  transactionProof(txId) { return this.call('sov_getTransactionProof', { txId }, { nonNull: true }); }
  receiptProof(txId) { return this.call('sov_getReceiptProof', { txId }, { nonNull: true }); }
  miners() { return this.call('sov_getMiners'); }
  mempoolSize() { return this.call('sov_getMempoolSize'); }

  listTokens(offset = 0, limit = 100) { return this.call('sov_listTokens', { offset, limit }); }
  tokenInfo(asset) { return this.call('sov_getTokenInfo', { hash: asset }); }
  tokenBalances(account, offset = 0, limit = 100) {
    return this.call('sov_getTokenBalances', { account, offset, limit });
  }
  htlc(id) { return this.call('sov_getHtlc', { hash: id }); }
  listNfts(offset = 0, limit = 100) { return this.call('sov_listNfts', { offset, limit }); }
  nftClass(collection) { return this.call('sov_getNftClass', { collection }); }
  nft(collection, tokenId) { return this.call('sov_getNft', { collection, tokenId }); }
  nftsOf(account, offset = 0, limit = 100) { return this.call('sov_nftsOf', { account, offset, limit }); }

  listNames(offset = 0, limit = 100) { return this.call('sov_listNames', { offset, limit }); }
  resolveName(name) { return this.call('sov_resolveName', { name }); }
  getName(name) { return this.call('sov_getName', { name }); }
  namesOf(account) { return this.call('sov_namesOf', { account }); }
}
