// infra/agreementRepository.js
// Repositório de acordos/eventos sobre SQLite (better-sqlite3, síncrono).
// Interface usada pelos services: get, has, upsert, list, listPending, listPollable, listAttentionToReopen, recordEvent,
// listEvents, findOpenRecent, findOpenByWorkflow, findLatestByWorkflow, listByWorkflow (cancelamento), consumeNonce (nonces do /start), countByState,
// transaction.

// [chave JS, coluna SQL, tipo]
const COLUMNS = [
  ['nodeId', 'node_id', 'text'],
  ['attachId', 'attach_id', 'text'],
  ['fileName', 'file_name', 'text'],
  ['workflowId', 'workflow_id', 'text'],
  ['subworkflowId', 'subworkflow_id', 'text'],
  ['taskId', 'task_id', 'int'],
  ['emails', 'emails', 'json'],
  ['state', 'state', 'text'],
  ['finalKind', 'final_kind', 'text'],
  ['adobeStatus', 'adobe_status', 'text'],
  ['pdfDelivered', 'pdf_delivered', 'bool'],
  ['pdfDeliveredAt', 'pdf_delivered_at', 'text'],
  ['sendonDone', 'sendon_done', 'bool'],
  ['sendonAt', 'sendon_at', 'text'],
  ['disposition', 'disposition', 'text'],
  ['attempts', 'attempts', 'int'],
  ['lastError', 'last_error', 'text'],
  ['lastErrorStage', 'last_error_stage', 'text'],
  ['lastErrorAt', 'last_error_at', 'text'],
  ['nextAttemptAt', 'next_attempt_at', 'text'],
  ['attentionReason', 'attention_reason', 'text'],
  ['lastPolledAt', 'last_polled_at', 'text'],
  ['startSendOnError', 'start_sendon_error', 'text'],
  ['finalAt', 'final_at', 'text'],
  ['startSendonDone', 'start_sendon_done', 'bool'],
  ['startSendonAt', 'start_sendon_at', 'text'],
  ['signSubprocessId', 'sign_subprocess_id', 'text'],
  ['signTaskId', 'sign_task_id', 'int'],
  ['pdfNodeId', 'pdf_node_id', 'text'],
  ['attentionKind', 'attention_kind', 'text'],
  ['completedExternally', 'completed_externally', 'bool'],
  ['wfAttrsFingerprint', 'wf_attrs_fingerprint', 'text'],
  ['adopted', 'adopted', 'bool'],
  ['cancelRequestedAt', 'cancel_requested_at', 'text'],
  ['cancelSource', 'cancel_source', 'text'],
  ['workflowStopPending', 'workflow_stop_pending', 'bool'],
  ['workflowStoppedAt', 'workflow_stopped_at', 'text'],
  ['expiresAt', 'expires_at', 'text'],
  ['createdAt', 'created_at', 'text'],
  ['updatedAt', 'updated_at', 'text']
];
const KEYS = new Set(COLUMNS.map(([k]) => k));

function toSql(value, type) {
  if (value === undefined || value === null) {
    if (type === 'json') return '[]';
    return type === 'bool' ? 0 : null;
  }
  if (type === 'bool') return value ? 1 : 0;
  if (type === 'int') return Number.isFinite(Number(value)) ? Number(value) : null;
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

function fromSql(value, type) {
  if (type === 'bool') return !!value;
  if (type === 'json') {
    try { return JSON.parse(value || '[]'); } catch { return []; }
  }
  return value === undefined ? null : value;
}

// Conjunto de e-mails sem caixa nem ordem (e sem repetição): a identidade dos destinatários na trava anti-duplicidade
const emailSetKey = (emails) => [...new Set(emails.map((e) => String(e).trim().toLowerCase()))].sort().join('|');

function createAgreementRepository(db, { now = () => new Date(), maxEvents = 50 } = {}) {
  const nowIso = () => now().toISOString();

  const rowToRecord = (row) => {
    const rec = { id: row.id };
    for (const [key, col, type] of COLUMNS) rec[key] = fromSql(row[col], type);
    return rec;
  };

  const colNames = COLUMNS.map(([, c]) => c);
  const stmts = {
    get: db.prepare('SELECT * FROM agreements WHERE id = ?'),
    exists: db.prepare('SELECT 1 FROM agreements WHERE id = ?'),
    upsert: db.prepare(
      `INSERT INTO agreements (id, ${colNames.join(', ')})
       VALUES (@id, ${colNames.map((c) => '@' + c).join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${colNames.map((c) => `${c} = excluded.${c}`).join(', ')}`
    ),
    list: db.prepare('SELECT * FROM agreements ORDER BY created_at, id'),
    listByState: db.prepare('SELECT * FROM agreements WHERE state = ? ORDER BY created_at, id'),
    // Pendente: resultado final ainda não entregue OU pedido de firma (SendOn de início) ainda não enviado
    listPending: db.prepare(
      `SELECT * FROM agreements WHERE state != 'needs_attention' AND (
         (final_kind IS NOT NULL AND sendon_done = 0)
         OR (start_sendon_done = 0 AND sendon_done = 0 AND COALESCE(workflow_id, '') != '')
       ) ORDER BY created_at, id`
    ),
    // needs_attention por tentativas esgotadas, com a última falha anterior ao corte (reabertura automática)
    listAttentionToReopen: db.prepare(
      `SELECT * FROM agreements WHERE state = 'needs_attention' AND attention_kind = 'retries_exhausted'
         AND sendon_done = 0 AND last_error_at IS NOT NULL AND last_error_at < ? ORDER BY created_at, id`
    ),
    listPollable: db.prepare(
      `SELECT * FROM agreements WHERE final_kind IS NULL AND sendon_done = 0 AND state != 'needs_attention'
       ORDER BY created_at, id`
    ),
    // Acordos ABERTOS (sem resultado final e sem SendOn do resultado) do documento criados depois do corte
    recentOpen: db.prepare(
      `SELECT * FROM agreements WHERE node_id = ? AND created_at > ? AND final_kind IS NULL AND sendon_done = 0`
    ),
    // Acordo ainda não final (sem resultado final e sem SendOn do resultado) do mesmo workflow/subprocesso/documento
    openByWorkflow: db.prepare(
      `SELECT * FROM agreements WHERE workflow_id = ? AND subworkflow_id = ? AND node_id = ?
         AND final_kind IS NULL AND sendon_done = 0 ORDER BY created_at DESC, id DESC LIMIT 1`
    ),
    // O acordo mais recente do mesmo workflow/subprocesso/documento, em qualquer estado
    latestByWorkflow: db.prepare(
      `SELECT * FROM agreements WHERE workflow_id = ? AND subworkflow_id = ? AND node_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`
    ),
    // Todos os acordos de um workflow (mais recente primeiro), com ou sem filtro de subprocesso (cancelamento de fluxos)
    byWorkflow: db.prepare('SELECT * FROM agreements WHERE workflow_id = ? ORDER BY created_at DESC, id DESC'),
    byWorkflowSub: db.prepare(
      'SELECT * FROM agreements WHERE workflow_id = ? AND subworkflow_id = ? ORDER BY created_at DESC, id DESC'
    ),
    purgeNonces: db.prepare('DELETE FROM start_nonces WHERE expires_at < ?'),
    insertNonce: db.prepare('INSERT OR IGNORE INTO start_nonces (nonce, expires_at) VALUES (?, ?)'),
    countByState: db.prepare('SELECT state, COUNT(*) AS n FROM agreements GROUP BY state'),
    insertEvent: db.prepare(
      `INSERT OR IGNORE INTO agreement_events
         (agreement_id, notification_id, event, canonical, kind, source, payload_summary, received_at)
       VALUES (@agreement_id, @notification_id, @event, @canonical, @kind, @source, @payload_summary, @received_at)`
    ),
    pruneEvents: db.prepare(
      `DELETE FROM agreement_events WHERE agreement_id = ? AND id NOT IN
         (SELECT id FROM agreement_events WHERE agreement_id = ? ORDER BY id DESC LIMIT ?)`
    ),
    events: db.prepare('SELECT * FROM agreement_events WHERE agreement_id = ? ORDER BY id DESC LIMIT ?')
  };

  const get = (id) => {
    const row = stmts.get.get(String(id));
    return row ? rowToRecord(row) : null;
  };

  const upsertTx = db.transaction((id, patch) => {
    id = String(id);
    const existing = get(id);
    const merged = existing || {
      id, emails: [], state: 'pending', pdfDelivered: false, sendonDone: false, attempts: 0, startSendonDone: true
    };
    for (const [k, v] of Object.entries(patch || {})) {
      if (KEYS.has(k) && v !== undefined) merged[k] = v;
    }
    const ts = nowIso();
    merged.updatedAt = ts;
    merged.createdAt = existing ? existing.createdAt : (patch?.createdAt || ts);
    const params = { id };
    for (const [key, col, type] of COLUMNS) params[col] = toSql(merged[key], type);
    stmts.upsert.run(params);
    return get(id);
  });

  const recordEventTx = db.transaction((id, ev, patch) => {
    id = String(id);
    if (!stmts.exists.get(id)) return null;
    const res = stmts.insertEvent.run({
      agreement_id: id,
      notification_id: ev.notificationId || null,
      event: ev.event || null,
      canonical: ev.canonical || null,
      kind: ev.kind || null,
      source: ev.source || 'webhook',
      payload_summary: ev.summary ? JSON.stringify(ev.summary) : null,
      received_at: ev.receivedAt || nowIso()
    });
    if (res.changes === 0) return { duplicate: true, record: get(id) };
    stmts.pruneEvents.run(id, id, maxEvents);
    const record = patch && Object.keys(patch).length ? upsertTx(id, patch) : get(id);
    return { duplicate: false, record };
  });

  return {
    get,
    has: (id) => !!stmts.exists.get(String(id)),
    upsert: (id, patch) => upsertTx(id, patch),

    // filter: função(record) ou { state }
    list(filter) {
      const rows = filter && typeof filter === 'object' && filter.state
        ? stmts.listByState.all(filter.state)
        : stmts.list.all();
      const records = rows.map(rowToRecord);
      return typeof filter === 'function' ? records.filter(filter) : records;
    },

    // Com resultado final e trabalho pendente (runQueue) / ainda sem resultado final (polling); sem needs_attention
    listPending: () => stmts.listPending.all().map(rowToRecord),
    listPollable: () => stmts.listPollable.all().map(rowToRecord),
    listAttentionToReopen: (cutoffIso) => stmts.listAttentionToReopen.all(String(cutoffIso)).map(rowToRecord),

    /*
      Registra o evento (dedupe por notification_id) e, se não for duplicado, aplica o patch
      de estado na mesma transação. Retorna null se o acordo não existe.
    */
    recordEvent: (id, ev, patch) => recordEventTx(id, ev, patch),

    listEvents(id, limit = maxEvents) {
      return stmts.events.all(String(id), limit).map((r) => ({
        id: r.id,
        notificationId: r.notification_id,
        event: r.event,
        canonical: r.canonical,
        kind: r.kind,
        source: r.source,
        summary: r.payload_summary ? JSON.parse(r.payload_summary) : null,
        receivedAt: r.received_at
      }));
    },

    /*
      Trava anti-duplicidade do /start: acordo ABERTO (sem resultado final e sem SendOn do resultado) do mesmo documento + mesmos
      destinatários (conjunto, sem caixa nem ordem) criado dentro da janela. exceptFlow ({ workflowId, subworkflowId }) exclui
      o próprio fluxo: só vale o acordo aberto de OUTRO fluxo. Acordo final ou concluído nunca é devolvido.
    */
    findOpenRecent(nodeId, emails, thresholdMs, exceptFlow = null) {
      const cutoff = new Date(now().getTime() - thresholdMs).toISOString();
      const key = emailSetKey(emails);
      return stmts.recentOpen.all(String(nodeId), cutoff).map(rowToRecord).find((r) =>
        Array.isArray(r.emails) && emailSetKey(r.emails) === key
        && !(exceptFlow
          && String(r.workflowId ?? '') === String(exceptFlow.workflowId ?? '')
          && String(r.subworkflowId ?? '') === String(exceptFlow.subworkflowId ?? ''))) || null;
    },

    // Idempotência do /start: acordo não final do mesmo workflow + subprocesso + documento (ou null)
    findOpenByWorkflow(workflowId, subworkflowId, nodeId) {
      const row = stmts.openByWorkflow.get(String(workflowId), String(subworkflowId), String(nodeId));
      return row ? rowToRecord(row) : null;
    },

    // O acordo mais recente do mesmo workflow + subprocesso + documento, final ou não (ou null)
    findLatestByWorkflow(workflowId, subworkflowId, nodeId) {
      const row = stmts.latestByWorkflow.get(String(workflowId), String(subworkflowId), String(nodeId));
      return row ? rowToRecord(row) : null;
    },

    /*
      Acordos de um workflow, mais recente primeiro (abertos e já encerrados). `subworkflowId` opcional filtra pelo
      subprocesso exato: o cancelamento nunca escolhe o acordo de outro subprocesso. "Aberto" é decidido em
      domain/cancellation.js (selectCancelTarget): sem sendonDone.
    */
    listByWorkflow(workflowId, subworkflowId) {
      const sub = subworkflowId === undefined || subworkflowId === null ? '' : String(subworkflowId).trim();
      const rows = sub
        ? stmts.byWorkflowSub.all(String(workflowId), sub)
        : stmts.byWorkflow.all(String(workflowId));
      return rows.map(rowToRecord);
    },

    /*
      Nonce de uso único do /start (HMAC v2): true se foi consumido agora, false se já tinha sido usado.
      Purga os expirados a cada inserção. Persistido no SQLite (sobrevive a restart e vale entre réplicas do mesmo volume).
    */
    consumeNonce(nonce, ttlMs) {
      return db.transaction(() => {
        stmts.purgeNonces.run(nowIso());
        return stmts.insertNonce.run(String(nonce), new Date(now().getTime() + ttlMs).toISOString()).changes === 1;
      })();
    },

    countByState() {
      const out = {};
      for (const { state, n } of stmts.countByState.all()) out[state] = n;
      return out;
    },

    transaction: (fn) => db.transaction(fn)()
  };
}

module.exports = { createAgreementRepository };
