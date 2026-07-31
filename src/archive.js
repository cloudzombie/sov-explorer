// Durable, dependency-free SQLite archive for explorer-derived chain data.
//
// The hot Store remains a bounded in-memory cache. This archive keeps complete block,
// transaction, and account-history records across restarts so old links and queries do
// not have to amplify back into the public relays. Node's built-in SQLite module is
// available without a flag from Node 22.13 and is release-candidate quality in Node 24;
// production persistence is therefore gated to Node 24.15+ in the service/runbook.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isTipped, unwrapTimestamped } from './store.js';

function relatedAccounts(tx) {
  const action = tx?.action;
  const accounts = new Set();
  if (tx?.signer) accounts.add(tx.signer);
  if (!action || typeof action !== 'object') return [...accounts];
  for (const key of ['to', 'recipient', 'contract', 'owner']) {
    if (action[key]) accounts.add(action[key]);
  }
  return [...accounts];
}

function objectPart(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Buffer.from(value).toString('hex').toLowerCase();
  }
  return String(value).toLowerCase();
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
    // A read-only replica cannot migrate. Against an archive written before timing
    // shipped these statements simply do not prepare, and every timing read degrades
    // to null rather than failing the whole replica.
    this.txTimingStmt = this._tryPrepare('SELECT first_seen_ms, first_seen_height, waited_ms, waited_blocks, timing_source FROM transactions WHERE id = ?');
    this.observationStmt = this._tryPrepare('SELECT first_seen_ms, first_seen_height FROM mempool_observations WHERE tx_id = ?');
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
        action_type TEXT,
        execution_status TEXT,
        timestamp_ms INTEGER,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transactions_height_idx
        ON transactions(block_height DESC, tx_index DESC);
      CREATE INDEX IF NOT EXISTS transactions_signer_idx
        ON transactions(signer, block_height DESC, tx_index DESC);

      -- First-seen observations captured by polling the node's mempool. Written
      -- BEFORE a transaction is mined (and kept for transactions the node later
      -- prunes without mining), so the wait can still be paired once the block
      -- lands. Node-local, non-consensus: this is when THIS explorer first saw
      -- the transaction, never a self-reported creation time.
      CREATE TABLE IF NOT EXISTS mempool_observations (
        tx_id TEXT PRIMARY KEY,
        first_seen_ms INTEGER NOT NULL,
        first_seen_height INTEGER
      );
      CREATE INDEX IF NOT EXISTS mempool_observations_time_idx
        ON mempool_observations(first_seen_ms);

      CREATE TABLE IF NOT EXISTS account_transactions (
        account TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        tx_index INTEGER NOT NULL,
        tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        PRIMARY KEY(account, tx_id)
      );
      CREATE INDEX IF NOT EXISTS account_transactions_history_idx
        ON account_transactions(account, block_height DESC, tx_index DESC);

      CREATE TABLE IF NOT EXISTS chain_objects (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        created_tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        created_height INTEGER NOT NULL,
        updated_height INTEGER NOT NULL,
        owner TEXT,
        label TEXT,
        status TEXT,
        record_json TEXT NOT NULL,
        PRIMARY KEY(kind, id)
      );
      CREATE INDEX IF NOT EXISTS chain_objects_kind_idx
        ON chain_objects(kind, updated_height DESC, id);

      CREATE TABLE IF NOT EXISTS object_activity (
        kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        tx_index INTEGER NOT NULL,
        tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        account TEXT,
        record_json TEXT NOT NULL,
        PRIMARY KEY(kind, object_id, tx_id)
      );
      CREATE INDEX IF NOT EXISTS object_activity_idx
        ON object_activity(kind, object_id, block_height DESC, tx_index DESC);
      CREATE INDEX IF NOT EXISTS object_account_idx
        ON object_activity(account, block_height DESC, tx_index DESC);

      CREATE TABLE IF NOT EXISTS contract_events (
        tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        contract TEXT,
        topic_json TEXT,
        data_json TEXT,
        PRIMARY KEY(tx_id, event_index)
      );
      CREATE INDEX IF NOT EXISTS contract_events_contract_idx
        ON contract_events(contract, block_height DESC, event_index DESC);
    `);

    const txColumns = new Set(
      this.db.prepare('PRAGMA table_info(transactions)').all().map((column) => column.name),
    );
    if (!txColumns.has('action_type')) this.db.exec('ALTER TABLE transactions ADD COLUMN action_type TEXT');
    if (!txColumns.has('execution_status')) this.db.exec('ALTER TABLE transactions ADD COLUMN execution_status TEXT');
    // Timing columns are added in place on an existing archive. Rows written before
    // this shipped simply have NULL timing — they are reported as "not observed",
    // never backfilled with an estimate.
    for (const column of ['first_seen_ms', 'first_seen_height', 'waited_ms', 'waited_blocks']) {
      if (!txColumns.has(column)) this.db.exec(`ALTER TABLE transactions ADD COLUMN ${column} INTEGER`);
    }
    if (!txColumns.has('timing_source')) this.db.exec('ALTER TABLE transactions ADD COLUMN timing_source TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS transactions_action_idx
        ON transactions(action_type, block_height DESC, tx_index DESC);
      CREATE INDEX IF NOT EXISTS transactions_status_idx
        ON transactions(execution_status, block_height DESC, tx_index DESC);
      CREATE INDEX IF NOT EXISTS transactions_time_idx
        ON transactions(timestamp_ms DESC, block_height DESC, tx_index DESC);
    `);
    this.db.exec(`
      UPDATE transactions
      SET action_type = COALESCE(
        -- A timestamped envelope is transparent (see the insert path); rows
        -- written before v0.2.6 can never carry one, so this only matters for a
        -- re-backfill of rows written after it.
        CASE WHEN json_extract(record_json, '$.action.type') = 'timestamped'
             THEN json_extract(record_json, '$.action.inner.type') END,
        json_extract(record_json, '$.action.type')
      )
      WHERE action_type IS NULL
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
        id, block_height, tx_index, signer, counterparty, action_type,
        execution_status, timestamp_ms, record_json,
        first_seen_ms, first_seen_height, waited_ms, waited_blocks, timing_source
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // The FIRST observation wins: a later poll must never move first-seen forward.
    this.insertObservationStmt = this.db.prepare(`
      INSERT OR IGNORE INTO mempool_observations(tx_id, first_seen_ms, first_seen_height)
      VALUES(?, ?, ?)
    `);
    this.observationStmt = this.db.prepare(
      'SELECT first_seen_ms, first_seen_height FROM mempool_observations WHERE tx_id = ?',
    );
    this.pruneObservationsStmt = this.db.prepare(
      'DELETE FROM mempool_observations WHERE first_seen_ms < ?',
    );
    this.insertAccountTxStmt = this.db.prepare(`
      INSERT OR REPLACE INTO account_transactions(account, block_height, tx_index, tx_id)
      VALUES(?, ?, ?, ?)
    `);
    this.blockHeightStmt = this.db.prepare('SELECT record_json FROM blocks WHERE height = ?');
    this.blockHashStmt = this.db.prepare('SELECT record_json FROM blocks WHERE hash = ?');
    this.txStmt = this.db.prepare('SELECT record_json FROM transactions WHERE id = ?');
    this.txTimingStmt = this.db.prepare(`
      SELECT first_seen_ms, first_seen_height, waited_ms, waited_blocks, timing_source
      FROM transactions WHERE id = ?
    `);
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
    this.missingStatusStmt = this.db.prepare(`
      SELECT id FROM transactions WHERE execution_status IS NULL
      ORDER BY block_height DESC, tx_index DESC LIMIT ?
    `);
    this.updateReceiptStmt = this.db.prepare(`
      UPDATE transactions
      SET execution_status = ?, record_json = ?
      WHERE id = ?
    `);
    this.upsertObjectStmt = this.db.prepare(`
      INSERT INTO chain_objects(kind, id, created_tx_id, created_height, updated_height, owner, label, status, record_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET
        updated_height = excluded.updated_height,
        owner = COALESCE(excluded.owner, chain_objects.owner),
        label = COALESCE(excluded.label, chain_objects.label),
        status = COALESCE(excluded.status, chain_objects.status),
        record_json = excluded.record_json
    `);
    this.insertObjectActivityStmt = this.db.prepare(`
      INSERT OR REPLACE INTO object_activity(kind, object_id, block_height, tx_index, tx_id, action_type, account, record_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertEventStmt = this.db.prepare(`
      INSERT OR REPLACE INTO contract_events(tx_id, event_index, block_height, contract, topic_json, data_json)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    this._rebuildAccountIndexesIfNeeded();
    this._rebuildObjectIndexesIfNeeded();
  }

  _rebuildAccountIndexesIfNeeded() {
    if (this.meta('account_index_version') === '2') return;
    const rows = this.db.prepare(`
      SELECT id, record_json, block_height, tx_index
      FROM transactions
      ORDER BY block_height, tx_index, id
    `).all();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM account_transactions;');
      for (const row of rows) {
        const tx = parseRecord(row);
        for (const account of relatedAccounts(tx)) {
          this.insertAccountTxStmt.run(account, row.block_height, row.tx_index, row.id);
        }
      }
      this.setMetaStmt.run('account_index_version', '2');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _rebuildObjectIndexesIfNeeded() {
    if (this.meta('object_index_version') === '2') return;
    const rows = this.db.prepare(`
      SELECT record_json, block_height
      FROM transactions
      ORDER BY block_height, tx_index, id
    `).all();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM contract_events; DELETE FROM object_activity; DELETE FROM chain_objects;');
      for (const row of rows) {
        const tx = parseRecord(row);
        if (tx) this._indexChainObjects(tx, { height: row.block_height });
      }
      this.setMetaStmt.run('object_index_version', '2');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _tryPrepare(sql) {
    try {
      return this.db.prepare(sql);
    } catch {
      return null;
    }
  }

  meta(key) {
    return this.getMetaStmt.get(key)?.value ?? null;
  }

  /**
   * Record that a transaction was seen in the node's mempool. The FIRST observation
   * wins — a later poll of the same still-pending transaction must never move
   * first-seen forward. Returns the observation now on record.
   */
  recordFirstSeen(txId, firstSeenMs, firstSeenHeight = null) {
    const id = String(txId ?? '').toLowerCase();
    if (!id || !Number.isFinite(Number(firstSeenMs))) return null;
    if (!this.readOnly && this.insertObservationStmt) {
      this.insertObservationStmt.run(
        id,
        Math.trunc(Number(firstSeenMs)),
        Number.isFinite(Number(firstSeenHeight)) ? Math.trunc(Number(firstSeenHeight)) : null,
      );
    }
    return this.firstSeen(id);
  }

  /** The explorer's own first-seen observation for a transaction, or null. */
  firstSeen(txId) {
    const row = this.observationStmt?.get(String(txId ?? '').toLowerCase());
    if (!row || row.first_seen_ms === null || row.first_seen_ms === undefined) return null;
    return {
      firstSeenMs: Number(row.first_seen_ms),
      firstSeenHeight: row.first_seen_height === null || row.first_seen_height === undefined
        ? null
        : Number(row.first_seen_height),
    };
  }

  /** The timing already stored for a mined transaction, or null when it has none. */
  transactionTiming(txId) {
    const row = this.txTimingStmt?.get(String(txId ?? '').toLowerCase());
    if (!row || row.timing_source === null || row.timing_source === undefined) return null;
    const number = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      firstSeenMs: number(row.first_seen_ms),
      firstSeenHeight: number(row.first_seen_height),
      waitedMs: number(row.waited_ms),
      waitedBlocks: number(row.waited_blocks),
      source: row.timing_source,
    };
  }

  /** Drop mempool observations older than `beforeMs`. Once a transaction is mined
   * its timing lives on the transaction row, so the observation table only has to
   * cover the pending window (plus a margin for transactions the node pruned). */
  pruneObservations(beforeMs) {
    if (this.readOnly || !this.pruneObservationsStmt) return 0;
    if (!Number.isFinite(Number(beforeMs))) return 0;
    return Number(this.pruneObservationsStmt.run(Math.trunc(Number(beforeMs)))?.changes ?? 0);
  }

  /**
   * The most recent transactions with their wait and tipped-ness, for the fee-auction
   * statistics. Transactions WITHOUT timing are returned too (with `observed: false`)
   * so the caller can report how many of the window were excluded instead of
   * silently shrinking its sample.
   */
  timingSample({ limit = 2_000, minHeight = null } = {}) {
    const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(Number(limit) || 2_000)));
    const clauses = [];
    const params = [];
    if (Number.isSafeInteger(minHeight)) {
      clauses.push('block_height >= ?');
      params.push(minHeight);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this._tryPrepare(`
      SELECT block_height, action_type, waited_ms, waited_blocks, timing_source
      FROM transactions
      ${where}
      ORDER BY block_height DESC, tx_index DESC
      LIMIT ?
    `)?.all(...params, safeLimit) ?? [];
    return rows.map((row) => ({
      blockHeight: Number(row.block_height),
      // `action_type` is already the EFFECTIVE type (a creation-time envelope is
      // unwrapped at write time), so a timestamped tip is still counted as a bid.
      tipped: row.action_type === 'tipped',
      waitedMs: row.waited_ms === null || row.waited_ms === undefined ? null : Number(row.waited_ms),
      waitedBlocks: row.waited_blocks === null || row.waited_blocks === undefined
        ? null
        : Number(row.waited_blocks),
      source: row.timing_source ?? null,
      observed: !!row.timing_source,
    }));
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
      this.db.exec('DELETE FROM blocks; DELETE FROM mempool_observations; DELETE FROM meta;');
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
    // Read any timing already on record BEFORE the delete below cascades the old
    // transaction rows away: an observation cannot be recovered once the mempool
    // has moved on, so re-indexing a block must never erase it.
    const retainedTiming = new Map();
    for (const tx of record.transactions ?? []) {
      if (!tx?.id) continue;
      const txId = String(tx.id).toLowerCase();
      const timing = this.transactionTiming(txId);
      if (timing) retainedTiming.set(txId, timing);
    }
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
      const accounts = relatedAccounts(tx);
      const cp = accounts.find((account) => account !== tx.signer) ?? null;
      // Re-indexing a block (finality refresh, on-demand historical fetch) must not
      // erase timing that was paired when the block was first indexed: an observation
      // cannot be recovered once the mempool has moved on.
      const retained = retainedTiming.get(txId) ?? null;
      const timing = tx.timing?.observed
        ? tx.timing
        : retained
          ? {
              ...retained,
              includedHeight: record.height,
              includedTimestampMs: tx.timestampMs ?? record.timestampMs ?? null,
              observed: true,
            }
          : null;
      const stored = timing?.source ? { ...tx, timing } : tx;
      this.insertTxStmt.run(
        txId,
        record.height,
        tx.index ?? 0,
        tx.signer ?? null,
        cp,
        // The EFFECTIVE action type: a `timestamped` creation-time envelope
        // (v0.2.6) is metadata about when a transaction was made, not a kind of
        // action, so it is transparent here. Without this every timestamped
        // transaction would be filed under a single "timestamped" bucket and
        // vanish from every action-type filter, and the tipped/untipped wait
        // split would misclassify a timestamped tip as untipped.
        unwrapTimestamped(tx.action)?.type ?? tx.action?.type ?? null,
        tx.executionStatus ?? tx.receipt?.status?.status ?? tx.receipt?.status ?? null,
        tx.timestampMs ?? record.timestampMs ?? null,
        JSON.stringify(stored),
        timing?.firstSeenMs ?? null,
        timing?.firstSeenHeight ?? null,
        timing?.waitedMs ?? null,
        timing?.waitedBlocks ?? null,
        timing?.source ?? null,
      );
      for (const account of accounts) {
        this.insertAccountTxStmt.run(account, record.height, tx.index ?? 0, txId);
      }
      this._indexChainObjects({ ...tx, id: txId }, record);
    }
  }

  _indexChainObjects(tx, block) {
    const action = tx.action ?? {};
    const type = action.type;
    let kind = null;
    let id = null;
    let owner = action.to ?? action.recipient ?? null;
    let label = action.symbol ?? action.name ?? null;
    let status = null;
    if (type === 'token_issue') { kind = 'token'; id = `issue:${tx.signer}:${action.symbol}`; owner = null; status = 'active'; }
    else if (type === 'token_transfer' || type === 'token_burn') { kind = 'token'; id = action.asset; owner = null; status = 'active'; }
    else if (type === 'nft_mint') { kind = 'nft'; id = `mint:${tx.signer}:${action.symbol}:${objectPart(action.token_id)}`; status = 'minted'; }
    else if (type === 'nft_transfer' || type === 'nft_set_meta') { kind = 'nft'; id = `${action.collection}:${objectPart(action.token_id)}`; status = type === 'nft_transfer' ? 'transferred' : 'metadata-updated'; }
    else if (type === 'deploy') { kind = 'contract'; id = tx.signer; owner = tx.signer; status = 'deployed'; }
    else if (type === 'call') { kind = 'contract'; id = action.contract; owner = null; status = 'called'; }
    else if (type === 'htlc_lock') { kind = 'htlc'; id = tx.id; owner = tx.signer; status = 'locked'; }
    else if (type === 'htlc_claim') { kind = 'htlc'; id = action.htlc_id; status = 'claimed'; }
    else if (type === 'htlc_refund') { kind = 'htlc'; id = action.htlc_id; status = 'refunded'; }
    if (kind && id) {
      const objectId = objectPart(id);
      const object = { kind, id: objectId, action, txId: tx.id, blockHeight: block.height, owner, label, status };
      this.upsertObjectStmt.run(kind, objectId, tx.id, block.height, block.height, owner, label, status, JSON.stringify(object));
      this.insertObjectActivityStmt.run(kind, objectId, block.height, tx.index ?? 0, tx.id, type, owner ?? tx.signer ?? null, JSON.stringify(tx));
    }
    const contract = type === 'call' ? action.contract : type === 'deploy' ? tx.signer : null;
    for (const [index, event] of (tx.receipt?.events ?? []).entries()) {
      this.insertEventStmt.run(tx.id, index, block.height, contract, JSON.stringify(event.topic ?? null), JSON.stringify(event.data ?? null));
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

  transactionPage(options = {}) {
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(options.limit) || 50)));
    const clauses = [];
    const params = [];
    if (options.cursor) {
      clauses.push('(t.block_height < ? OR (t.block_height = ? AND (t.tx_index < ? OR (t.tx_index = ? AND t.id < ?))))');
      params.push(options.cursor.height, options.cursor.height, options.cursor.index, options.cursor.index, options.cursor.id);
    }
    if (options.actionType) { clauses.push('t.action_type = ?'); params.push(options.actionType); }
    if (options.status) { clauses.push('t.execution_status = ?'); params.push(options.status); }
    if (options.account) {
      clauses.push('EXISTS (SELECT 1 FROM account_transactions a WHERE a.tx_id = t.id AND a.account = ?)');
      params.push(options.account);
    }
    if (Number.isSafeInteger(options.minHeight)) { clauses.push('t.block_height >= ?'); params.push(options.minHeight); }
    if (Number.isSafeInteger(options.maxHeight)) { clauses.push('t.block_height <= ?'); params.push(options.maxHeight); }
    if (Number.isSafeInteger(options.fromMs)) { clauses.push('t.timestamp_ms >= ?'); params.push(options.fromMs); }
    if (Number.isSafeInteger(options.toMs)) { clauses.push('t.timestamp_ms <= ?'); params.push(options.toMs); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT t.record_json, t.action_type, t.execution_status
      FROM transactions t
      ${where}
      ORDER BY t.block_height DESC, t.tx_index DESC, t.id DESC
      LIMIT ?
    `).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map((row) => {
      const record = parseRecord(row);
      return record ? { ...record, executionStatus: row.execution_status ?? record.executionStatus ?? null } : null;
    }).filter(Boolean);
    return { records, hasMore };
  }

  missingExecutionStatus(limit = 16) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 16)));
    return this.missingStatusStmt?.all(safeLimit).map((row) => row.id) ?? [];
  }

  updateTransactionReceipt(id, receipt) {
    if (this.readOnly || !this.updateReceiptStmt || !receipt) return;
    const tx = this.transaction(id);
    if (!tx) return;
    const executionStatus = receipt.status?.status ?? receipt.status ?? null;
    this.updateReceiptStmt.run(executionStatus, JSON.stringify({ ...tx, receipt, executionStatus }), String(id).toLowerCase());
    for (const [index, event] of (receipt.events ?? []).entries()) {
      const contract = tx.action?.type === 'call' ? tx.action.contract : tx.action?.type === 'deploy' ? tx.signer : null;
      this.insertEventStmt?.run(tx.id, index, tx.blockHeight, contract, JSON.stringify(event.topic ?? null), JSON.stringify(event.data ?? null));
    }
  }

  objects(kind, limit = 50, offset = 0) {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const rows = this.db.prepare('SELECT * FROM chain_objects WHERE kind = ? ORDER BY updated_height DESC, id LIMIT ? OFFSET ?').all(kind, safeLimit, safeOffset);
    return rows.map((row) => ({ ...JSON.parse(row.record_json), owner: row.owner, label: row.label, status: row.status, createdHeight: row.created_height, updatedHeight: row.updated_height }));
  }

  objectCounts() {
    return Object.fromEntries(
      this.db.prepare('SELECT kind, COUNT(*) AS count FROM chain_objects GROUP BY kind')
        .all().map((row) => [row.kind, Number(row.count)]),
    );
  }

  matchingObjectActivity(kind, { id = null, signer = null, symbol = null, tokenId = null } = {}, limit = 100) {
    const clauses = ['kind = ?'];
    const params = [kind];
    if (id) {
      clauses.push('object_id = ?');
      params.push(String(id).toLowerCase());
    }
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
    const rows = this.db.prepare(`
      SELECT record_json FROM object_activity
      WHERE ${clauses.join(' AND ')}
      ORDER BY block_height DESC, tx_index DESC LIMIT ?
    `).all(...params, safeLimit).map(parseRecord).filter(Boolean);
    return rows.filter((tx) => (
      (!signer || tx.signer === signer)
      && (!symbol || tx.action?.symbol === symbol)
      && (!tokenId || objectPart(tx.action?.token_id) === objectPart(tokenId))
    ));
  }

  object(kind, id, activityLimit = 100) {
    const row = this.db.prepare('SELECT * FROM chain_objects WHERE kind = ? AND id = ?').get(kind, String(id).toLowerCase());
    if (!row) return null;
    const createdTransaction = this.transaction(row.created_tx_id);
    const activity = this.db.prepare(`SELECT record_json FROM object_activity WHERE kind = ? AND object_id = ? ORDER BY block_height DESC, tx_index DESC LIMIT ?`).all(kind, String(id).toLowerCase(), Math.max(1, Math.min(200, activityLimit))).map(parseRecord).filter(Boolean);
    const events = kind === 'contract'
      ? this.db.prepare('SELECT * FROM contract_events WHERE contract = ? ORDER BY block_height DESC, event_index DESC LIMIT ?').all(String(id).toLowerCase(), Math.max(1, Math.min(200, activityLimit))).map((event) => ({ txId: event.tx_id, index: event.event_index, blockHeight: event.block_height, topic: JSON.parse(event.topic_json), data: JSON.parse(event.data_json) }))
      : [];
    return { ...JSON.parse(row.record_json), owner: row.owner, label: row.label, status: row.status, createdHeight: row.created_height, updatedHeight: row.updated_height, createdTransaction, activity, events };
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
