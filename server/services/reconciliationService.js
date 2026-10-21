// services/reconciliationService.js
// Orquestra a entrega de resultado ao Content Server (PDF -> disposição) de forma idempotente.
// A lógica de decisão vive em domain/; aqui só I/O (repositório, Adobe, OTCS) e serialização.
const {
  KINDS, isFinalKind, classifyEvent, classifyAgreementStatus, isCancelledStatus
} = require('../domain/eventPolicy');
const state = require('../domain/agreementState');
const { describeError } = require('../infra/util');

function createReconciliationService({
  repo,
  adobe,
  otcs,
  config,
  logger,
  now = () => new Date(),
  scheduleRetries = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const backoff = config.backoff || {};
  const queued = new Map();     // id -> Promise da próxima execução (coalescida)
  const queuedOpts = new Map(); // id -> opções mescladas
  const running = new Map();    // id -> Promise da execução em curso
  const timers = new Map();     // id -> timer de retry

  const nowIso = () => now().toISOString();

  /* ---------- helpers de estado ---------- */

  function markAttention(id, reason) {
    const rec = repo.get(id);
    clearTimeout_(id); // needs_attention não reprocessa sozinho (só reconcile manual ou novo evento final)
    const changed = !(rec.state === state.STATES.NEEDS_ATTENTION && rec.attentionReason === reason);
    repo.upsert(id, state.attentionPatch(reason));
    if (changed) logger.error(`[${id}] needs_attention: ${reason}`);
    return { status: 'needs_attention', reason };
  }

  // permanent: erro que não adianta retentar (4xx do OTCS) => needs_attention direto
  function registerFailure(id, stage, err, { permanent = false } = {}) {
    const rec = repo.get(id);
    const message = describeError(err);
    const { patch, delayMs, attention } = state.failurePatch(
      rec, stage, message, now().getTime(), backoff, { permanent }
    );
    repo.upsert(id, patch);
    if (attention) {
      logger.error(`[${id}] ${stage} failed (attempt ${patch.attempts}): ${message}`);
      return markAttention(id, attention);
    }
    logger.error(
      `[${id}] ${stage} failed (attempt ${patch.attempts}); next retry at ${patch.nextAttemptAt}: ${message}`
    );
    scheduleRetry(id, delayMs);
    return { status: 'failed', stage, error: message };
  }

  function scheduleRetry(id, delayMs) {
    if (!scheduleRetries) return;
    clearTimeout_(id);
    const t = setTimer(() => {
      timers.delete(id);
      // force: o timer pode disparar ~1 ms antes de nextAttemptAt (Date.now vs timers do Node)
      reconcile(id, { force: true });
    }, delayMs);
    if (t && t.unref) t.unref();
    timers.set(id, t);
  }

  function clearTimeout_(id) {
    if (timers.has(id)) {
      clearTimer(timers.get(id));
      timers.delete(id);
    }
  }

  /* ---------- reconciliação de um acordo ---------- */

  async function doReconcile(id, opts) {
    let rec = repo.get(id);
    if (!rec) return { status: 'unknown' };

    if (opts.refresh && !rec.finalKind && !rec.sendonDone) {
      try {
        const ag = await adobe.getAgreement(id);
        // null: não deu para ler os eventos do Adobe; não finaliza agora
        if (await applyAdobeStatus(id, ag.status) === null) return { status: 'refresh_failed' };
        rec = repo.get(id);
      } catch (e) {
        logger.warn(`[${id}] no se pudo consultar el estado en Adobe: ${describeError(e)}`);
        return { status: 'refresh_failed', error: describeError(e) };
      }
    }

    const plan = state.planFor(rec.finalKind);
    if (!plan) return { status: 'no_final', record: rec };
    if (rec.sendonDone) return { status: 'done', record: rec };
    // reconcile manual (POST /admin/reconcile): tira de needs_attention e zera as tentativas (rodada nova)
    if (opts.manual && (rec.state === state.STATES.NEEDS_ATTENTION || rec.attempts)) {
      rec = repo.upsert(id, state.reopenPatch(rec));
    }
    if (!opts.force && !state.isDue(rec, now().getTime())) return { status: 'deferred', record: rec };

    // 0) Adobe é a fonte da verdade: final OK vindo de webhook só segue após confirmar SIGNED no Adobe.
    // adobeStatus=SIGNED só é gravado por consulta ao Adobe (polling/aqui), então já vale como verificado.
    // (Rejeição/expiração forjadas têm impacto menor e não são verificadas.)
    if (rec.finalKind === KINDS.FINAL_OK && rec.adobeStatus !== 'SIGNED') {
      let status;
      try {
        status = String((await adobe.getAgreement(id))?.status || '').trim().toUpperCase();
      } catch (e) {
        return registerFailure(id, 'verify', e);
      }
      if (status !== 'SIGNED') {
        // Estado em andamento logo após o webhook é transitório: retenta com backoff em vez de travar em needs_attention.
        if (classifyAgreementStatus(status) === KINDS.PROGRESS) {
          return registerFailure(id, 'verify', new Error(`Adobe aún no confirma la firma (estado ${status})`));
        }
        logger.error(`[${id}] evento final no confirmado por Adobe: ${status || 'sin estado'}`);
        return markAttention(id, `evento final no confirmado por Adobe: ${status || 'sin estado'}`);
      }
      rec = repo.upsert(id, { adobeStatus: 'SIGNED' });
    }

    // 1) PDF final -> nova versão no attachId
    if (plan.pdf && !rec.pdfDelivered) {
      if (!rec.attachId) return markAttention(id, 'acuerdo sin attachId: no hay carpeta destino para el PDF');
      const name = (rec.fileName || '').trim() || `node_${rec.nodeId}.pdf`;
      let buf;
      try {
        buf = await adobe.downloadCombinedDocument(id);
      } catch (e) {
        return registerFailure(id, 'pdf', e);
      }
      try {
        await otcs.uploadToFolder(rec.attachId, buf, name);
      } catch (e) {
        return registerFailure(id, 'pdf', e, { permanent: state.isPermanentHttpError(e) });
      }
      rec = repo.upsert(id, state.pdfDeliveredPatch(nowIso()));
      logger.info(`[${id}] PDF final enviado a la carpeta ${rec.attachId} del Content Server`);
    }

    // 2) disposição na tarefa de assinatura (uma única vez)
    const disposition = state.dispositionFor(plan, config.dispositions);
    if (!disposition) {
      return markAttention(id, `resultado ${rec.finalKind} sin disposición configurada (${plan.dispositionKey})`);
    }
    if (!rec.workflowId) {
      return markAttention(id, 'acuerdo sin workflowId: no se puede ejecutar la disposición');
    }
    try {
      await otcs.sendOnWorkflow({
        workflowId: rec.workflowId,
        subworkflowId: rec.subworkflowId || rec.workflowId,
        taskId: config.signTaskId,
        disposition,
        comment: `Documento ${disposition.toLowerCase()} via webhook`
      });
    } catch (e) {
      return registerFailure(id, 'disposition', e, { permanent: state.isPermanentHttpError(e) });
    }
    clearTimeout_(id);
    rec = repo.upsert(id, state.completedPatch(plan, disposition, nowIso()));
    logger.info(`[${id}] SendOn task ${config.signTaskId} (${disposition}) done for workflow ${rec.workflowId}`);
    return { status: 'completed', record: rec };
  }

  /* ---------- serialização por acordo ---------- */

  function enqueue(id, opts) {
    const merged = { ...(queuedOpts.get(id) || {}), ...opts };
    if (queuedOpts.has(id)) {
      // coalesce: um force/refresh pendente não pode ser perdido
      merged.force = !!(queuedOpts.get(id).force || opts.force);
      merged.refresh = !!(queuedOpts.get(id).refresh || opts.refresh);
    }
    queuedOpts.set(id, merged);
    if (queued.has(id)) return queued.get(id);

    const prev = running.get(id) || Promise.resolve();
    const p = prev.then(() => {
      queued.delete(id);
      const runOpts = queuedOpts.get(id);
      queuedOpts.delete(id);
      const run = doReconcile(id, runOpts).catch((e) => {
        logger.error(`[${id}] error inesperado en la reconciliación: ${describeError(e)}`);
        return { status: 'error', error: describeError(e) };
      });
      const tracked = run.then(() => {
        if (running.get(id) === tracked) running.delete(id);
      });
      running.set(id, tracked);
      return run;
    });
    queued.set(id, p);
    return p;
  }

  function reconcile(id, opts = {}) {
    return enqueue(String(id), { force: true, refresh: false, ...opts });
  }

  /* ---------- entradas: webhook e polling ---------- */

  /*
    Registra o evento (persistido e deduplicado) e aplica a transição de estado de forma síncrona.
    O processamento (PDF -> disposição) segue assíncrono em `result.processing` (Promise que nunca
    rejeita); o chamador do webhook não precisa aguardá-lo.
  */
  function handleEvent(parsed) {
    const id = parsed.agreementId && String(parsed.agreementId);
    if (!id) {
      logger.warn(`Webhook sin agreement id (evento ${parsed.eventName})`);
      return { known: false, reason: 'no_agreement_id' };
    }
    const rec = repo.get(id);
    if (!rec) {
      logger.warn(`Webhook de un acuerdo desconocido ${id} (evento ${parsed.eventName}): no está en el store`);
      return { known: false, reason: 'unknown_agreement' };
    }

    const { kind, canonical } = classifyEvent(parsed.eventName, parsed.payload);
    const ts = nowIso();
    let patch = null;
    if (isFinalKind(kind)) {
      // O status do payload NÃO vai para adobeStatus (webhook não é confiável; fica só no resumo do evento)
      patch = state.finalPatch(rec, kind, { nowIso: ts });
    } else if (kind === KINDS.NEEDS_ATTENTION) {
      patch = rec.sendonDone ? null : state.attentionPatch(`evento ${canonical}`);
    }

    const recorded = repo.recordEvent(id, {
      notificationId: parsed.notificationId,
      event: parsed.eventName,
      canonical,
      kind,
      source: 'webhook',
      receivedAt: ts,
      summary: {
        status: parsed.status,
        participant: parsed.participant,
        eventDate: parsed.eventDate,
        webhookId: parsed.webhookId
      }
    }, patch);

    if (!recorded) {
      logger.warn(`[${id}] acuerdo eliminado durante el procesamiento del evento ${parsed.eventName}`);
      return { known: false, reason: 'unknown_agreement' };
    }
    if (recorded.duplicate) {
      logger.info(`[${id}] evento duplicado ignorado (${parsed.notificationId})`);
      return { known: true, duplicate: true, kind, canonical };
    }

    if (kind === KINDS.UNKNOWN) logger.warn(`[${id}] evento desconocido: ${parsed.eventName}`);
    if (kind === KINDS.NEEDS_ATTENTION && patch) logger.error(`[${id}] needs_attention: evento ${canonical}`);

    const result = { known: true, duplicate: false, kind, canonical };
    if (isFinalKind(kind) && state.hasPendingWork(recorded.record)) {
      result.processing = reconcile(id);
    }
    return result;
  }

  /*
    Aplica o estado do acordo consultado no Adobe (polling / reconcile manual).
    Retorna o `kind` classificado, ou null se não deu para decidir (nada é gravado).
  */
  async function applyAdobeStatus(id, status) {
    if (!repo.has(id)) return KINDS.UNKNOWN;
    // CANCELLED: recusa ou recall? Só os eventos dizem. Se falhar, não finaliza (o próximo ciclo retenta)
    let events;
    if (isCancelledStatus(status)) {
      try {
        events = await adobe.getAgreementEvents(id);
      } catch (e) {
        logger.warn(`[${id}] no se pudo consultar los eventos del acuerdo en Adobe: ${describeError(e)}`);
        return null;
      }
    }
    const rec = repo.get(id);
    if (!rec) return KINDS.UNKNOWN;
    const kind = classifyAgreementStatus(status, events);
    const ts = nowIso();
    const patch = { adobeStatus: status, lastPolledAt: ts };
    if (isFinalKind(kind)) {
      Object.assign(patch, state.finalPatch(rec, kind, { nowIso: ts, adobeStatus: status }) || {});
    } else if (kind === KINDS.NEEDS_ATTENTION && !rec.sendonDone) {
      Object.assign(patch, state.attentionPatch(`estado Adobe ${status}`));
    } else if (kind === KINDS.UNKNOWN) {
      logger.warn(`[${id}] estado Adobe desconocido: ${status}`);
    }

    if (rec.adobeStatus !== status) {
      repo.recordEvent(id, {
        event: `POLL_STATUS_${status}`,
        canonical: `POLL_STATUS_${status}`,
        kind,
        source: 'poll',
        receivedAt: ts,
        summary: { status }
      }, patch);
    } else {
      repo.upsert(id, patch);
    }
    return kind;
  }

  async function handleStatus(id, status) {
    id = String(id);
    const kind = await applyAdobeStatus(id, status);
    if (isFinalKind(kind)) await reconcile(id, { force: false });
    return kind;
  }

  /*
    Reprocessa tudo que tem trabalho pendente e backoff vencido
    (ex.: PDF entregue mas disposição falhou).
  */
  async function runQueue() {
    const t = now().getTime();
    const due = repo.listPending().filter((r) => state.isRetryable(r, t));
    const ids = [];
    for (const rec of due) {
      await reconcile(rec.id, { force: false });
      ids.push(rec.id);
    }
    return ids;
  }

  function stop() {
    for (const id of [...timers.keys()]) clearTimeout_(id);
  }

  return { handleEvent, handleStatus, applyAdobeStatus, reconcile, runQueue, stop };
}

module.exports = { createReconciliationService };
