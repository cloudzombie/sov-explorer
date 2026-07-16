// Durable, dependency-free SQLite archive for explorer-derived chain data.
//
// The hot Store remains a bounded in-memory cache. This archive keeps complete block,
// transaction, and account-history records across restarts so old links and queries do
// not have to amplify back into the public relays. Node's built-in SQLite module is
// available without a flag from Node 22.13 and is release-candidate quality in Node 24;
// production persistence is therefore gated to Node 24.15+ in the service/runbook.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function counterparty(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'transfer') return action.to ?? null;
  if (action.type === 'call') return action.contract ?? null;
  return null;
}

function parseRecord(row) {
  if (!row?.record_json) return null;
  return JSON.parse(row.record_json);
}

function normalizedIdentity(value) {
  return String(value ?? '').toLowerCase();
}

export class SqliteArchive {
  constructor(db, filePath, { readOnly = false } = {}) {
    this.db = db;
    this.filePath = filePath;
    this.readOnly = readOnly;
    if (readOnly) this._prepareReadOnly();
    else this._prepare();
  }

  _prepareReadOnly() {
    this.getMetaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.blockHeightStmt = this.db.prepare('SELECT record_json FROM blocks WHERE height = ?');
    this.blockHashStmt = this.db.prepare('SELECT record_json FROM blocks WHERE hash = ?');
    this.txStmt = this.db.prepare('SELECT record_json FROM transactions WHERE id = ?');
    this.accountTxsStmt = this.db.prepare(`SELECT t.record_json FROM account_transactions a JOIN transactions t ON t.id = a.tx_id WHERE a.account = ? ORDER BY a.block_height DESC, a.tx_index DESC LIMIT ?`);
    this.recentStmt = this.db.prepare('SELECT record_json FROM blocks ORDER BY height DESC LIMIT ?');
    this.beforeStmt = this.db.prepare('SELECT record_json FROM blocks WHERE height <= ? ORDER BY height DESC LIMIT ?');
    this.boundsStmt = this.db.prepare('SELECT COUNT(*) AS blocks, MIN(height) AS min_height, MAX(height) AS max_height, COALESCE(SUM(size_bytes), 0) AS indexed_bytes FROM blocks');
    this.contiguousTailStmt = this.db.prepare(`WITH ordered AS (SELECT height, ROW_NUMBER() OVER (ORDER BY height DESC) AS row_number, MAX(height) OVER () AS max_height FROM blocks) SELECT MIN(height) AS contiguous_from FROM ordered WHERE height = max_height - row_number + 1`);
    this.lookupBlockHashStmt = this.db.prepare('SELECT height FROM blocks WHERE hash = ?');
    this.lookupTxStmt = this.db.prepare('SELECT id FROM transactions WHERE id = ?');
  }

  _prepare() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT,
        timestamp_ms INTEGER,
        proposer TEXT,
        tx_count INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_timestamp_idx ON blocks(timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        block_height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
        tx_index INTEGER NOT NULL,
        signer TEXT,
        counterparty TEXT,
        timestamp_ms INTEGER,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transactions_height_idx
        ON transactions(block_height DESC, tx_index DESC);
      CREATE INDEX IF NOT EXISTS transactions_signer_idx
        ON transactions(signer, block_height DESC, tx_index DESC);

      CREATE TABLE IF NOT EXISTS account_transactions (
        account TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        tx_index INTEGER NOT NULL,
        tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        PRIMARY KEY(account, tx_id)
      );
      CREATE INDEX IF NOT EXISTS account_transactions_history_idx
        ON account_transactions(account, block_height DESC, tx_index DESC);
    `);

    this.getMetaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.deleteHeightStmt = this.db.prepare('DELETE FROM blocks WHERE height = ?');
    this.deleteHashStmt = this.db.prepare('DELETE FROM blocks WHERE hash = ?');
    this.insertBlockStmt = this.db.prepare(`
      INSERT INTO blocks(
        height, hash, prev_hash, timestamp_ms, proposer, tx_count, size_bytes, record_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertTxStmt = this.db.prepare(`
      INSERT OR REPLACE INTO transactions(
        id, block_height, tx_index, signer, counterparty, timestamp_ms, record_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertAccountTxStmt = this.db.prepare(`
      INSERT OR REPLACE INTO account_transactions(account, block_height, tx_index, tx_id)
      VALUES(?, ?, ?, ?)
    `);
    this.blockHeightStmt = this.db.prepare('SELECT record_json FROM blocks WHERE height = ?');
    this.blockHashStmt = this.db.prepare('SELECT record_json FROM blocks WHERE hash = ?');
    this.txStmt = this.db.prepare('SELECT record_json FROM transactions WHERE id = ?');
    this.accountTxsStmt = this.db.prepare(`
      SELECT t.record_json
      FROM account_transactions a
      JOIN transactions t ON t.id = a.tx_id
      WHERE a.account = ?
      ORDER BY a.block_height DESC, a.tx_index DESC
      LIMIT ?
    `);
    this.recentStmt = this.db.prepare(`
      SELECT record_json FROM blocks ORDER BY height DESC LIMIT ?
    `);
    this.beforeStmt = this.db.prepare(`
      SELECT record_json FROM blocks WHERE height <= ? ORDER BY height DESC LIMIT ?
    `);
    this.boundsStmt = this.db.prepare(`
      SELECT COUNT(*) AS blocks, MIN(height) AS min_height, MAX(height) AS max_height,
             COALESCE(SUM(size_bytes), 0) AS indexed_bytes
      FROM blocks
    `);
    this.contiguousTailStmt = this.db.prepare(`
      WITH ordered AS (
        SELECT height,
               ROW_NUMBER() OVER (ORDER BY height DESC) AS row_number,
               MAX(height) OVER () AS max_height
        FROM blocks
      )
      SELECT MIN(height) AS contiguous_from
      FROM ordered
      WHERE height = max_height - row_number + 1
    `);
    this.lookupBlockHashStmt = this.db.prepare('SELECT height FROM blocks WHERE hash = ?');
    this.lookupTxStmt = this.db.prepare('SELECT id FROM transactions WHERE id = ?');
  }

  meta(key) {
    return this.getMetaStmt.get(key)?.value ?? null;
  }

  ensureIdentity(chainId, genesisHash) {
    const expectedChain = String(chainId ?? '');
    const expectedGenesis = normalizedIdentity(genesisHash);
    const currentChain = this.meta('chain_id');
    const currentGenesis = normalizedIdentity(this.meta('genesis_hash'));
    const mismatch = (currentChain && currentChain !== expectedChain)
      || (currentGenesis && currentGenesis !== expectedGenesis);
    if (this.readOnly) {
      if (mismatch) throw new Error('read-only archive chain identity mismatch');
      return { cleared: false };
    }
    if (mismatch) this.clearChainData();
    this.setMetaStmt.run('chain_id', expectedChain);
    this.setMetaStmt.run('genesis_hash', expectedGenesis);
    return { cleared: !!mismatch };
  }

  clearChainData() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM blocks; DELETE FROM meta;');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _insertBlock(record) {
    if (!Number.isSafeInteger(record?.height) || record.height < 0 || !record?.hash) {
      throw new Error('archive block requires a non-negative safe height and hash');
    }
    const blockHash = String(record.hash).toLowerCase();
    this.deleteHeightStmt.run(record.height);
    this.deleteHashStmt.run(blockHash);
    this.insertBlockStmt.run(
      record.height,
      blockHash,
      record.prevHash ? String(record.prevHash).toLowerCase() : null,
      record.timestampMs ?? null,
      record.proposer ?? null,
      record.transactions?.length ?? record.txCount ?? 0,
      record.sizeBytes ?? 0,
      JSON.stringify(record),
    );
    for (const tx of record.transactions ?? []) {
      if (!tx?.id) continue;
      const txId = String(tx.id).toLowerCase();
      const cp = counterparty(tx.action);
      this.insertTxStmt.run(
        txId,
        record.height,
        tx.index ?? 0,
        tx.signer ?? null,
        cp,
        tx.timestampMs ?? record.timestampMs ?? null,
        JSON.stringify(tx),
      );
      if (tx.signer) {
        this.insertAccountTxStmt.run(tx.signer, record.height, tx.index ?? 0, txId);
      }
      if (cp && cp !== tx.signer) {
        this.insertAccountTxStmt.run(cp, record.height, tx.index ?? 0, txId);
      }
    }
  }

  putBlock(record) {
    this.putBlocks([record]);
  }

  putBlocks(records) {
    if (!records?.length) return;
    if (this.readOnly) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) this._insertBlock(record);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  block(idOrHeight) {
    const row = typeof idOrHeight === 'number'
      ? this.blockHeightStmt.get(idOrHeight)
      : this.blockHashStmt.get(String(idOrHeight).toLowerCase());
    return parseRecord(row);
  }

  transaction(id) {
    return parseRecord(this.txStmt.get(String(id).toLowerCase()));
  }

  accountTransactions(account, limit = 50) {
    const safeLimit = Math.max(0, Math.min(200, Math.trunc(Number(limit) || 0)));
    return this.accountTxsStmt.all(String(account), safeLimit).map(parseRecord).filter(Boolean);
  }

  recentBlocks(limit = 100) {
    const safeLimit = Math.max(1, Math.min(100_000, Math.trunc(Number(limit) || 1)));
    return this.recentStmt.all(safeLimit).map(parseRecord).filter(Boolean);
  }

  blocksBefore(before, limit = 100) {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(Number(limit) || 1)));
    return this.beforeStmt.all(before, safeLimit).map(parseRecord).filter(Boolean);
  }

  lookupHash(hash) {
    const normalized = String(hash).toLowerCase();
    const block = this.lookupBlockHashStmt.get(normalized);
    if (block) return { kind: 'block', ref: block.height, known: true };
    const tx = this.lookupTxStmt.get(normalized);
    if (tx) return { kind: 'tx', ref: normalized, known: true };
    return null;
  }

  status(nodeHeight = null) {
    const row = this.boundsStmt.get();
    const blocks = Number(row?.blocks ?? 0);
    const minHeight = row?.min_height === null || row?.min_height === undefined
      ? null
      : Number(row.min_height);
    const maxHeight = row?.max_height === null || row?.max_height === undefined
      ? null
      : Number(row.max_height);
    const pageCount = Number(this.db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
    const tailRow = blocks > 0 ? this.contiguousTailStmt.get() : null;
    const contiguousFromHeight = tailRow?.contiguous_from === null
      || tailRow?.contiguous_from === undefined
      ? null
      : Number(tailRow.contiguous_from);
    const contiguous = minHeight === null || maxHeight === null
      ? false
      : blocks === maxHeight - minHeight + 1;
    return {
      enabled: true,
      blocks,
      minHeight,
      maxHeight,
      contiguousFromHeight,
      complete: contiguous && minHeight === 0 && (nodeHeight == null || maxHeight >= nodeHeight),
      contiguous,
      indexedBytes: Number(row?.indexed_bytes ?? 0),
      databaseBytes: pageCount * pageSize,
    };
  }

  checkpoint() {
    if (this.readOnly) return;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  close() {
    this.checkpoint();
    this.db.close();
  }
}

export async function openArchive(filePath, opts = {}) {
  if (!filePath) return null;
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error('persistent archive requires Node 24.15 or newer');
  }
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new Error(
      `persistent archive requires Node 24.15+ with node:sqlite (${error.message})`,
    );
  }
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new sqlite.DatabaseSync(filePath, { allowExtension: false, readOnly: opts.readOnly === true });
  return new SqliteArchive(db, filePath, opts);
}
