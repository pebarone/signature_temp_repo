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
  `,
  // v2: etapa start, tarefa de firma resolvida, nó do PDF, tipo de atenção, conclusão externa, atributos e adoção.
  // start_sendon_done DEFAULT 1: preserva o envio antigo, salvo quando há uma falha de SendOn registrada.
  `
  ALTER TABLE agreements ADD COLUMN start_sendon_done INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agreements ADD COLUMN start_sendon_at TEXT;
  ALTER TABLE agreements ADD COLUMN sign_subprocess_id TEXT;
  ALTER TABLE agreements ADD COLUMN sign_task_id INTEGER;
  ALTER TABLE agreements ADD COLUMN pdf_node_id TEXT;
  ALTER TABLE agreements ADD COLUMN attention_kind TEXT;
  ALTER TABLE agreements ADD COLUMN completed_externally INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agreements ADD COLUMN wf_attrs_fingerprint TEXT;
  ALTER TABLE agreements ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
  UPDATE agreements SET start_sendon_done = 0
    WHERE sendon_done = 0 AND COALESCE(workflow_id, '') != '' AND COALESCE(start_sendon_error, '') != '';
  UPDATE agreements SET attention_kind = CASE
    WHEN attention_reason LIKE 'reintentos agotados en %' THEN 'retries_exhausted'
    WHEN attention_reason LIKE 'error permanente en %' THEN 'permanent'
    ELSE NULL END WHERE state = 'needs_attention';
  `,
  // v3: nonces de uso único do POST /start (HMAC v2); expirados são purgados a cada inserção
  `
  CREATE TABLE start_nonces (
    nonce      TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_start_nonces_expires ON start_nonces(expires_at);
  `,
  // v4: cancelamento de fluxos (ticket 2026060410003715). cancel_requested_at/cancel_source marcam o acordo encerrado por
  // pedido de cancelamento (o AGREEMENT_RECALLED que o Adobe emite depois não gera disposição); o índice atende a busca
  // por workflow_id (POST /admin/cancel-workflow e o endpoint /cancel do WebReport).
  `
  ALTER TABLE agreements ADD COLUMN cancel_requested_at TEXT;
  ALTER TABLE agreements ADD COLUMN cancel_source TEXT;
  CREATE INDEX idx_agreements_workflow ON agreements(workflow_id);
  `,
  // v5: acordo expirado no Adobe (EXPIRED_STOP_WORKFLOW). workflow_stop_pending marca que o SendOn da tarefa de firma (com o
  // comentário de caducidad) já foi feito e falta parar o fluxo no Content; assim a retentativa não confunde a tarefa já
  // concluída por nós com uma concluída por uma pessoa. workflow_stopped_at registra quando o fluxo foi parado.
  `
  ALTER TABLE agreements ADD COLUMN workflow_stop_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agreements ADD COLUMN workflow_stopped_at TEXT;
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
