#!/usr/bin/env node
// Offline key-file manager. The generated secret is printed exactly once; the key
// document receives only its SHA-256 digest and is replaced atomically.

import { randomBytes } from 'node:crypto';
import { chmod, chown, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { keyDigest, parseKeyDocument, PAID_PLANS } from '../src/api-access.js';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function options(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid option ${name ?? ''}`);
    out[name.slice(2)] = value;
  }
  return out;
}

async function documentAt(file) {
  try {
    const document = JSON.parse(await readFile(file, 'utf8'));
    parseKeyDocument(document);
    return document;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, keys: [] };
    throw error;
  }
}

async function save(file, document) {
  parseKeyDocument(document);
  const temporary = resolve(dirname(file), `.${file.split('/').at(-1)}.${process.pid}.tmp`);
  let ownership = null;
  try {
    ownership = await stat(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
  await chmod(temporary, 0o640);
  if (ownership) await chown(temporary, ownership.uid, ownership.gid);
  await rename(temporary, file);
}

function recordOptions(opts, current = {}) {
  const plan = String(opts.plan ?? current.plan ?? 'pro').toLowerCase();
  if (!PAID_PLANS.has(plan)) throw new Error('plan must be pro or enterprise');
  const requestsPerMinute = Number(opts.rpm ?? current.requestsPerMinute ?? 1_200);
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 100_000) {
    throw new Error('rpm must be an integer from 1 to 100000');
  }
  const expiresAt = opts.expires === 'never' || (!opts.expires && !current.expiresAt)
    ? null
    : new Date(opts.expires ?? current.expiresAt).toISOString();
  return { plan, requestsPerMinute, expiresAt };
}

function newSecret() {
  return `sov_live_${randomBytes(32).toString('base64url')}`;
}

async function main() {
  const [command, ...raw] = process.argv.slice(2);
  const opts = options(raw);
  const file = resolve(opts.file ?? process.env.API_KEYS_FILE ?? 'api-keys.json');
  const document = await documentAt(file);
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(document.keys.map(({ hash, ...record }) => record), null, 2)}\n`);
    return;
  }
  const id = String(opts.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error('--id is required and must be a safe key identifier');
  const index = document.keys.findIndex((record) => record.id === id);
  if (command === 'create') {
    if (index !== -1) throw new Error(`key id ${id} already exists`);
    const secret = newSecret();
    const settings = recordOptions(opts);
    document.keys.push({ id, hash: keyDigest(secret), ...settings, enabled: true });
    await save(file, document);
    process.stdout.write(`${JSON.stringify({ id, apiKey: secret, ...settings })}\n`);
    return;
  }
  if (index === -1) throw new Error(`key id ${id} does not exist`);
  if (command === 'revoke') {
    document.keys[index].enabled = false;
    await save(file, document);
    process.stdout.write(`${JSON.stringify({ id, revoked: true })}\n`);
    return;
  }
  if (command === 'rotate') {
    const secret = newSecret();
    const settings = recordOptions(opts, document.keys[index]);
    document.keys[index] = { id, hash: keyDigest(secret), ...settings, enabled: true };
    await save(file, document);
    process.stdout.write(`${JSON.stringify({ id, apiKey: secret, ...settings })}\n`);
    return;
  }
  throw new Error('usage: api-key.mjs create|list|revoke|rotate --file PATH [--id ID --plan pro|enterprise --rpm N --expires ISO|never]');
}

main().catch((error) => fail(error.message));
