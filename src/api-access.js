// Paid API access control for the Explorer service.
//
// Key files contain SHA-256 digests only. Presented secrets are hashed and compared
// in constant time; raw secrets never enter logs, metrics, response bodies, or URLs.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ANONYMOUS_MAX_LIMIT = 50;
export const PAID_MAX_LIMIT = 200;
export const ANONYMOUS_MAX_OFFSET = 500;
export const PAID_MAX_OFFSET = 1_000_000_000;
export const PAID_PLANS = new Set(['pro', 'enterprise']);

export class ApiAccessError extends Error {
  constructor(status, code, message, { headers = {}, upgrade = false } = {}) {
    super(message);
    this.name = 'ApiAccessError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.upgrade = upgrade;
  }
}

export function keyDigest(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function normalizeRecord(record) {
  const id = String(record?.id ?? '').trim();
  const hash = String(record?.hash ?? '').toLowerCase();
  const plan = String(record?.plan ?? 'pro').toLowerCase();
  const requestsPerMinute = Number(record?.requestsPerMinute ?? 1_200);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error('API key record has an invalid id');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`API key ${id} has an invalid SHA-256 hash`);
  if (!PAID_PLANS.has(plan)) throw new Error(`API key ${id} has an invalid plan`);
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 100_000) {
    throw new Error(`API key ${id} has an invalid requestsPerMinute`);
  }
  let expiresAt = null;
  if (record?.expiresAt) {
    const parsed = Date.parse(record.expiresAt);
    if (!Number.isFinite(parsed)) throw new Error(`API key ${id} has an invalid expiresAt`);
    expiresAt = new Date(parsed).toISOString();
  }
  return {
    id,
    hash,
    digest: Buffer.from(hash, 'hex'),
    plan,
    enabled: record?.enabled !== false,
    expiresAt,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : null,
    requestsPerMinute,
  };
}

export function parseKeyDocument(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.keys)) {
    throw new Error('API key file must contain {"version":1,"keys":[]}');
  }
  const records = document.keys.map(normalizeRecord);
  const ids = new Set();
  const hashes = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`duplicate API key id ${record.id}`);
    if (hashes.has(record.hash)) throw new Error('duplicate API key hash');
    ids.add(record.id);
    hashes.add(record.hash);
  }
  return records;
}

export async function readKeyFile(filePath) {
  if (!filePath) return [];
  const source = await readFile(filePath, 'utf8');
  return parseKeyDocument(JSON.parse(source));
}

function requestCredential(req) {
  const direct = String(req?.headers?.['x-api-key'] ?? '').trim();
  const authorization = String(req?.headers?.authorization ?? '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  if (direct && bearer && direct !== bearer) {
    throw new ApiAccessError(401, 'conflicting_api_keys', 'Conflicting API credentials were supplied.');
  }
  if (direct) return direct;
  if (bearer) return bearer;
  if (authorization) throw new ApiAccessError(401, 'invalid_api_key', 'The API credential is invalid.');
  return null;
}

function integerParameter(query, name, { min, max }) {
  const raw = query.get(name);
  if (raw === null || raw === '') return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new ApiAccessError(400, 'invalid_parameter', `${name} must be an integer from ${min} to ${max}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiAccessError(400, 'invalid_parameter', `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function evaluatePaidRequirement(pathname, query, { graphql = false } = {}) {
  if (graphql) return { required: true, reason: 'graphql' };
  const limit = integerParameter(query, 'limit', { min: 1, max: PAID_MAX_LIMIT });
  const offset = integerParameter(query, 'offset', { min: 0, max: PAID_MAX_OFFSET });
  if (limit !== null && limit > ANONYMOUS_MAX_LIMIT) {
    return { required: true, reason: 'high_limit', limit };
  }
  if (offset !== null && offset > ANONYMOUS_MAX_OFFSET) {
    return { required: true, reason: 'deep_offset', offset };
  }
  const minHeight = integerParameter(query, 'minHeight', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const maxHeight = integerParameter(query, 'maxHeight', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (minHeight !== null && maxHeight !== null && maxHeight < minHeight) {
    throw new ApiAccessError(400, 'invalid_parameter', 'maxHeight must be greater than or equal to minHeight.');
  }
  if (minHeight !== null && maxHeight !== null && maxHeight - minHeight > 100_000) {
    return { required: true, reason: 'wide_block_range' };
  }
  const fromMs = integerParameter(query, 'fromMs', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const toMs = integerParameter(query, 'toMs', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (fromMs !== null && toMs !== null && toMs < fromMs) {
    throw new ApiAccessError(400, 'invalid_parameter', 'toMs must be greater than or equal to fromMs.');
  }
  if (fromMs !== null && toMs !== null && toMs - fromMs > 366 * 24 * 60 * 60_000) {
    return { required: true, reason: 'wide_time_range' };
  }
  return { required: false, reason: null, pathname };
}

export class ApiAccess {
  constructor(records = [], { filePath = null } = {}) {
    this.filePath = filePath;
    this.records = records;
    this.quotas = new Map();
  }

  static async fromFile(filePath) {
    return new ApiAccess(await readKeyFile(filePath), { filePath });
  }

  async reload() {
    const records = await readKeyFile(this.filePath);
    this.records = records;
    const ids = new Set(records.map((record) => record.id));
    for (const id of this.quotas.keys()) if (!ids.has(id)) this.quotas.delete(id);
    return records.length;
  }

  _recordFor(secret, now) {
    const presented = Buffer.from(keyDigest(secret), 'hex');
    let match = null;
    for (const record of this.records) {
      if (timingSafeEqual(presented, record.digest)) match = record;
    }
    if (!match || !match.enabled || (match.expiresAtMs !== null && match.expiresAtMs <= now)) {
      throw new ApiAccessError(401, 'invalid_api_key', 'The API credential is invalid or inactive.');
    }
    return match;
  }

  _consume(record, now) {
    const windowMs = 60_000;
    const start = Math.floor(now / windowMs) * windowMs;
    let quota = this.quotas.get(record.id);
    if (!quota || quota.start !== start) quota = { start, count: 0 };
    if (quota.count >= record.requestsPerMinute) {
      const resetSeconds = Math.max(1, Math.ceil((start + windowMs - now) / 1000));
      throw new ApiAccessError(429, 'key_rate_limit_exceeded', 'The API key request quota is exhausted.', {
        headers: {
          'retry-after': String(resetSeconds),
          'x-ratelimit-limit': String(record.requestsPerMinute),
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil((start + windowMs) / 1000)),
        },
      });
    }
    quota.count += 1;
    this.quotas.set(record.id, quota);
    return {
      limit: record.requestsPerMinute,
      remaining: Math.max(0, record.requestsPerMinute - quota.count),
      reset: Math.ceil((start + windowMs) / 1000),
    };
  }

  authorize(req, requirement, now = Date.now()) {
    const secret = requestCredential(req);
    if (!secret && requirement.required) {
      throw new ApiAccessError(402, 'paid_api_key_required', `A paid API key is required for ${requirement.reason}.`, { upgrade: true });
    }
    if (!secret) return { tier: 'anonymous', keyId: null, quota: null };
    const record = this._recordFor(secret, now);
    return { tier: record.plan, keyId: record.id, quota: this._consume(record, now) };
  }
}
