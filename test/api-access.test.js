import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  ApiAccess,
  ApiAccessError,
  evaluatePaidRequirement,
  keyDigest,
  parseKeyDocument,
} from '../src/api-access.js';

const execFileAsync = promisify(execFile);
const secret = ['sov', 'live', 'test-secret-that-is-never-stored'].join('_');

function access(rpm = 2) {
  const records = parseKeyDocument({
    version: 1,
    keys: [{ id: 'customer-1', hash: keyDigest(secret), plan: 'pro', requestsPerMinute: rpm, enabled: true }],
  });
  return new ApiAccess(records);
}

test('paid requirements validate parameters and preserve the bounded anonymous tier', () => {
  assert.equal(evaluatePaidRequirement('/api/mainnet/blocks', new URLSearchParams('limit=50')).required, false);
  assert.equal(evaluatePaidRequirement('/api/mainnet/blocks', new URLSearchParams('limit=51')).reason, 'high_limit');
  assert.equal(evaluatePaidRequirement('/api/mainnet/catalog', new URLSearchParams('offset=501')).reason, 'deep_offset');
  assert.equal(evaluatePaidRequirement('/graphql/mainnet', new URLSearchParams(), { graphql: true }).reason, 'graphql');
  assert.throws(
    () => evaluatePaidRequirement('/api/mainnet/blocks', new URLSearchParams('limit=201')),
    (error) => error instanceof ApiAccessError && error.status === 400 && error.code === 'invalid_parameter',
  );
});

test('API keys are constant-time digest records with paid tiers and per-key quotas', () => {
  const api = access(2);
  const requirement = { required: true, reason: 'high_limit' };
  assert.throws(
    () => api.authorize({ headers: {} }, requirement, 1_000),
    (error) => error.status === 402 && error.code === 'paid_api_key_required',
  );
  assert.throws(
    () => api.authorize({ headers: { 'x-api-key': 'wrong' } }, requirement, 1_000),
    (error) => error.status === 401 && !error.message.includes('wrong'),
  );
  const first = api.authorize({ headers: { authorization: `Bearer ${secret}` } }, requirement, 1_000);
  assert.equal(first.tier, 'pro');
  assert.equal(first.quota.remaining, 1);
  assert.equal(api.authorize({ headers: { 'x-api-key': secret } }, requirement, 1_001).quota.remaining, 0);
  assert.throws(
    () => api.authorize({ headers: { 'x-api-key': secret } }, requirement, 1_002),
    (error) => error.status === 429 && error.headers['x-ratelimit-remaining'] === '0',
  );
});

test('key manager reveals a new secret once and stores only its digest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sov-api-keys-'));
  const file = join(directory, 'keys.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = new URL('../scripts/api-key.mjs', import.meta.url);
  const created = await execFileAsync(process.execPath, [script.pathname, 'create', '--file', file, '--id', 'acme', '--rpm', '900']);
  const output = JSON.parse(created.stdout);
  assert.match(output.apiKey, /^sov_live_/);
  const stored = await readFile(file, 'utf8');
  assert.doesNotMatch(stored, new RegExp(output.apiKey));
  assert.match(stored, new RegExp(keyDigest(output.apiKey)));
  const listed = await execFileAsync(process.execPath, [script.pathname, 'list', '--file', file]);
  assert.equal(JSON.parse(listed.stdout)[0].hash, undefined);
  await execFileAsync(process.execPath, [script.pathname, 'revoke', '--file', file, '--id', 'acme']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).keys[0].enabled, false);
});
