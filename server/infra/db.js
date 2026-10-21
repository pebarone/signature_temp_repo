// infra/db.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/*
  Migrações de schema: índice+1 = versão (PRAGMA user_version). Só acrescentar ao final.
*/
const MIGRATIONS = [
  `
  CREATE TABLE agreements (
    id               TEXT PRIMARY KEY,
    node_id          TEXT,
    attach_id        TEXT,
    file_name        TEXT,
    workflow_id      TEXT,
    subworkflow_id   TEXT,
    task_id          INTEGER,
    emails           TEXT NOT NULL DEFAULT '[]',
    state            TEXT NOT NULL DEFAULT 'pending',
    final_kind       TEXT,
    adobe_status     TEXT,
    pdf_delivered    INTEGER NOT NULL DEFAULT 0,
    pdf_delivered_at TEXT,
    sendon_done      INTEGER NOT NULL DEFAULT 0,
    sendon_at        TEXT,
    disposition      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    last_error_stage TEXT,
    last_error_at    TEXT,
    next_attempt_at  TEXT,
    attention_reason TEXT,
    last_polled_at   TEXT,
    start_sendon_error TEXT,
    final_at         TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX idx_agreements_state ON agreements(state);
  CREATE INDEX idx_agreements_node ON agreements(node_id);
  CREATE TABLE agreement_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agreement_id    TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
    notification_id TEXT UNIQUE,
    event           TEXT,
    canonical       TEXT,
    kind            TEXT,
    source          TEXT,
    payload_summary TEXT,
    received_at     TEXT NOT NULL
  );
  CREATE INDEX idx_events_agreement ON agreement_events(agreement_id, id);
  `
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}

/*
  Abre (ou cria) o banco SQLite. ':memory:' é aceito (testes).
*/
function openDatabase(file, { logger } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = migrate(db);
  if (logger) logger.info(`SQLite ready: ${file} (schema v${version})`);
  return db;
}

module.exports = { openDatabase, migrate, MIGRATIONS };
