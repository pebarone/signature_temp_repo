// services/cancellationService.js
// Caso de uso do cancelamento de fluxos (ticket 2026060410003715, "Cancelación y reenvío de flujos"):
//   cancelAgreement(id)        -> consulta o Adobe, pede o cancelamento e marca o acordo como encerrado
//   cancelWorkflow(workflowId) -> acha o acordo aberto do fluxo (nunca o de outro subprocesso) e cancela
//   cancelFromTask(input)      -> POST /cancel do WebReport: lê no OTCS o fluxo alvo, cancela e faz o SendOn da tarefa
//                                 do workflow de cancelamento
// O orquestrador NÃO encerra o fluxo original no Content: isso é do workflow de cancelamento. Por isso o acordo
// cancelado fica "concluído" (agreementState.cancelRequestedPatch) e o AGREEMENT_RECALLED posterior não gera Rechazado.
// Decisões e pontos em aberto: docs/DESIGN_TICKET_2026060410003715.md.
const { describeError } = require('../infra/util');
const { locate } = require('../domain/workflowSteps');
const { CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget } = require('../domain/cancellation');
const { cancelRequestedPatch } = require('../domain/agreementState');
const { KINDS, classifyAgreementStatus } = require('../domain/eventPolicy');
const { ServiceError, fieldValue } = require('./signatureService');

const MAX_COMMENT_LENGTH = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 20000;
const DEFAULT_COMMENT = 'Flujo cancelado desde Content Server.';
const CANCEL_ERROR_MESSAGE = 'Error al cancelar el flujo.';
const sendOnComment = (agreementId) => `Cancelación confirmada en Adobe Sign (acuerdo ${agreementId})`;

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const httpStatus = (e) => e?.response?.status;
const isNumeric = (v) => /^\d+$/.test(v);
const fail = (status, error, extra = {}) => new ServiceError(status, { error, ...extra });

const adobeUnavailable = () =>
  fail(503, 'Adobe Sign no disponible; intente nuevamente.', { code: 'ADOBE_UNAVAILABLE' });
const otcsUnavailable = () =>
  fail(503, 'Content Server no disponible; intente nuevamente.', { code: 'OTCS_UNAVAILABLE' });
const reconcileInProgress = () =>
  fail(503, 'Hay una reconciliación en curso para este acuerdo; intente nuevamente.', { code: 'RECONCILE_IN_PROGRESS' });
const flowNotFound = () => fail(409, 'Flujo no encontrado.', { code: 'FLOW_NOT_FOUND' });
const notRegistered = (id) => fail(404, `Acuerdo ${id} no registrado en el orquestador.`, {
  code: 'AGREEMENT_NOT_FOUND',
  hint: 'Si fue enviado por el orquestador anterior, adóptelo con POST /admin/adopt/{agreementId} y vuelva a cancelar.'
});

// Comentário do cancelamento (o Adobe o mostra a quem for avisado): sem controles, limitado, com texto padrão
const cleanComment = (c) =>
  clean(String(c ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')).slice(0, MAX_COMMENT_LENGTH) || DEFAULT_COMMENT;

// Resumo de um acordo para as respostas de erro (ambíguo / encerrado)
const summary = (r) => ({
  id: r.id, workflowId: r.workflowId, subworkflowId: r.subworkflowId, nodeId: r.nodeId, fileName: r.fileName,
  state: r.state, createdAt: r.createdAt
});

/*
  hold(id) -> release: reconciliation.hold. Enquanto o cancelamento de um acordo está em curso, a reconciliação desse
  acordo fica em espera (o AGREEMENT_RECALLED pode chegar antes de o acordo ser marcado como encerrado).
  settle(id) -> Promise: reconciliation.settle. Resolve quando termina a reconciliação do acordo que já estava em curso
  (ela passou da checagem do hold e poderia adotar o RECALLED do nosso próprio cancelamento); nunca rejeita.
*/
function createCancellationService({
  repo, adobe, otcs, logger, config, now = () => new Date(), hold = () => () => {}, settle = async () => {}
}) {
  const inflight = new Set(); // acordos com cancelamento em curso (anti-corrida de dois pedidos iguais)

  // Marca o acordo como encerrado por pedido de cancelamento, junto com o evento no histórico (mesma transação).
  // Repetição (já marcado) ou pipeline que já havia concluído um acordo já cancelado no Adobe: nada a gravar.
  function markClosed(id, { source, comment, adobeStatus, alreadyCancelled }) {
    const current = repo.get(id);
    if (current.cancelRequestedAt || (alreadyCancelled && current.sendonDone)) return { record: current, marked: false };
    const ts = now().toISOString();
    const recorded = repo.recordEvent(id, {
      event: 'CANCEL_REQUESTED',
      canonical: 'CANCEL_REQUESTED',
      kind: 'cancel_requested',
      source: 'cancel',
      receivedAt: ts,
      summary: { source, comment, adobeStatus, alreadyCancelled }
    }, cancelRequestedPatch(current, ts, { source, adobeStatus }));
    return { record: recorded?.record || repo.get(id), marked: true };
  }

  // Depois de um erro no PUT: o Adobe já aplicou o cancelamento? Devolve o estado lido (CANCELLED/ABORTED) ou null
  // (outro estado, ou a própria reconsulta falhou). Nunca lança.
  async function cancelledAfterError(id) {
    try {
      const status = clean((await adobe.getAgreement(id))?.status).toUpperCase();
      return classifyCancelState(status) === CANCEL_STATES.ALREADY_CANCELLED ? status : null;
    } catch (e) {
      logger.error(`[${id}] cancelación: tampoco se pudo reconsultar el estado en Adobe: ${describeError(e)}`);
      return null;
    }
  }

  // Espera a reconciliação em curso do acordo, no máximo cancel.settleTimeoutMs. false = estourou o prazo.
  async function waitSettled(id) {
    const limit = Number(config.cancel?.settleTimeoutMs) || DEFAULT_SETTLE_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), limit); });
    try {
      return await Promise.race([Promise.resolve(settle(id)).then(() => true, () => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /*
    No Adobe v6 a recusa de um signatário também deixa o acordo CANCELLED; só o histórico distingue. Uma recusa não é
    "já cancelado": o pipeline ainda precisa entregar o Rechazado ao fluxo original, então o pedido é recusado e o
    registro fica intacto. Repetição de um cancelamento nosso (cancelRequestedAt gravado) não consulta o histórico.
    Sem ler o histórico não dá para decidir: 503 transitório, nada marcado (caminho inicial, antes de qualquer PUT nosso).
    afterPutError: o CANCELLED veio da reconsulta depois de um PUT nosso que falhou; o mais provável é que o NOSSO PUT
    tenha sido aplicado (resposta perdida). Devolver 503 reabriria o eco (o RECALLED depois do release do hold geraria
    Rechazado), então, com o histórico ilegível, vale a cancelação própria, salvo recusa já gravada no registro (webhook).
  */
  async function assertNotRejected(id, status, { afterPutError = false } = {}) {
    if (status !== 'CANCELLED' || repo.get(id)?.cancelRequestedAt) return;
    const rejected = () => {
      logger.warn(`[${id}] cancelación: el acuerdo fue rechazado por un firmante; no se cancela y el pipeline entrega el Rechazado`);
      return fail(409, 'El acuerdo fue rechazado por un firmante en Adobe Sign; no se puede cancelar.', {
        code: 'ALREADY_REJECTED', agreementId: id, adobeStatus: status
      });
    };
    let events;
    try {
      events = await adobe.getAgreementEvents(id);
    } catch (e) {
      logger.error(`[${id}] cancelación: no se pudo consultar el historial del acuerdo en Adobe: ${describeError(e)}`);
      if (!afterPutError) throw adobeUnavailable();
      if (repo.get(id)?.finalKind === KINDS.FINAL_REJECTED) throw rejected();
      logger.warn(`[${id}] cancelación: historial no legible; se asume la cancelación propia (el PUT pudo aplicarse con la respuesta perdida)`);
      return;
    }
    if (classifyAgreementStatus(status, events) === KINDS.FINAL_REJECTED) throw rejected();
  }

  async function runCancel(id, { comment, source }) {
    let status;
    try {
      status = clean((await adobe.getAgreement(id))?.status).toUpperCase();
    } catch (e) {
      if (httpStatus(e) === 404) {
        throw fail(404, 'El acuerdo no existe en Adobe Sign.', { code: 'AGREEMENT_NOT_FOUND_IN_ADOBE', agreementId: id });
      }
      logger.error(`[${id}] cancelación: no se pudo consultar el estado en Adobe: ${describeError(e)}`);
      throw adobeUnavailable();
    }

    const verdict = classifyCancelState(status);
    if (verdict === CANCEL_STATES.SIGNED) {
      throw fail(409, 'El acuerdo ya fue firmado en Adobe Sign; no se puede cancelar.', {
        code: 'ALREADY_SIGNED', agreementId: id, adobeStatus: status
      });
    }
    if (verdict === CANCEL_STATES.NOT_CANCELABLE) {
      throw fail(409, `El acuerdo está en estado ${status || 'desconocido'} en Adobe Sign; no se puede cancelar.`, {
        code: 'NOT_CANCELABLE', agreementId: id, adobeStatus: status
      });
    }

    // Idempotente: já cancelado no Adobe (inclusive por uma chamada anterior cuja resposta se perdeu)
    const alreadyCancelled = verdict === CANCEL_STATES.ALREADY_CANCELLED;
    if (alreadyCancelled) await assertNotRejected(id, status);
    let adobeStatus = alreadyCancelled ? status : 'CANCELLED';
    if (!alreadyCancelled) {
      try {
        await adobe.cancelAgreement(id, { comment, notifyOthers: !!config.cancel?.notifySigners });
      } catch (e) {
        logger.error(`[${id}] cancelación: Adobe no confirmó la cancelación: ${describeError(e)}`);
        // A resposta pode ter se perdido (timeout, 5xx do proxy) com o Adobe já tendo cancelado: reconsulta antes de desistir.
        // Sem a confirmação (reconsulta falha ou estado diferente) é transitório: nada é marcado; repetir reconsulta o estado.
        const confirmed = await cancelledAfterError(id);
        if (!confirmed) throw adobeUnavailable();
        await assertNotRejected(id, confirmed, { afterPutError: true }); // o signatário pode ter recusado entre a consulta e o PUT
        adobeStatus = confirmed;
        logger.warn(
          `[${id}] cancelación: la respuesta de Adobe se perdió, pero Adobe confirma la cancelación (estado ${confirmed}); `
          + 'se trata como cancelación confirmada'
        );
      }
    }

    const { record, marked } = markClosed(id, { source, comment, adobeStatus, alreadyCancelled });
    logger.info(
      `[${id}] cancelación ${alreadyCancelled ? 'ya estaba confirmada' : 'confirmada'} en Adobe (${source}); `
      + (marked ? 'acuerdo cerrado por solicitud de cancelación' : 'sin cambios en el registro')
    );
    return {
      agreementId: id,
      workflowId: record.workflowId,
      subworkflowId: record.subworkflowId,
      cancelled: true,
      alreadyCancelled,
      marked,
      adobeStatus
    };
  }

  /*
    Cancela UM acordo conhecido pelo orquestrador. Antes de pedir ao Adobe, consulta o estado:
      - em andamento: pede o cancelamento (falha do Adobe => 503 e nada é marcado);
      - já CANCELLED (recall)/ABORTED: idempotente, não chama o cancelamento (e fecha o registro, se ainda aberto);
      - CANCELLED por recusa do signatário (histórico): 409 ALREADY_REJECTED, registro intacto;
      - SIGNED ou outro estado final: 409.
    Antes de qualquer chamada ao Adobe, espera a reconciliação que já estava em curso (limite cancel.settleTimeoutMs;
    estourou => 503 RECONCILE_IN_PROGRESS, nada consultado nem marcado).
    Depois do cancelamento confirmado, o acordo vira "concluído" para o pipeline (sem SendOn nem PDF).
  */
  async function cancelAgreement(agreementId, { comment, source = 'admin' } = {}) {
    const id = clean(agreementId);
    const rec = id ? repo.get(id) : null;
    if (!rec) throw notRegistered(id);
    if (inflight.has(id)) {
      throw fail(409, 'Ya hay una cancelación en curso para este acuerdo.', { code: 'IN_PROGRESS', agreementId: id });
    }
    inflight.add(id);
    const release = hold(id);
    try {
      if (!(await waitSettled(id))) {
        logger.warn(`[${id}] cancelación: la reconciliación en curso no terminó a tiempo; no se consulta ni se cancela en Adobe`);
        throw reconcileInProgress();
      }
      return await runCancel(id, { comment: cleanComment(comment), source });
    } finally {
      release();
      inflight.delete(id);
    }
  }

  /*
    Cancela o acordo aberto de um fluxo (workflowId), opcionalmente de um subprocesso exato. Nunca escolhe o acordo de
    outro subprocesso nem adivinha entre vários: ver domain/cancellation.js (selectCancelTarget).
  */
  async function cancelWorkflow(workflowId, { subworkflowId, comment, source = 'admin' } = {}) {
    const wf = clean(workflowId);
    const sub = clean(subworkflowId);
    if (!isNumeric(wf)) throw fail(422, 'workflowId debe ser numérico.', { code: 'INVALID_WORKFLOW_ID' });
    if (sub && !isNumeric(sub)) throw fail(422, 'subworkflowId debe ser numérico.', { code: 'INVALID_SUBWORKFLOW_ID' });

    const scope = `${wf}${sub ? ` (subproceso ${sub})` : ''}`;
    const target = selectCancelTarget(repo.listByWorkflow(wf, sub));
    switch (target.kind) {
      case TARGET.NONE:
        throw fail(404, `No se encontró un acuerdo de firma para el flujo ${scope}.`, {
          code: 'AGREEMENT_NOT_FOUND',
          hint: 'Si fue enviado por el orquestador anterior, adóptelo con POST /admin/adopt/{agreementId} y vuelva a cancelar.'
        });
      case TARGET.AMBIGUOUS:
        throw fail(409, `El flujo ${scope} tiene más de un acuerdo de firma abierto; indique el subproceso.`, {
          code: 'AMBIGUOUS', agreements: target.records.map(summary)
        });
      case TARGET.CLOSED:
        throw fail(409, `El acuerdo más reciente del flujo ${scope} ya concluyó (estado ${target.record.state}); no hay nada que cancelar.`, {
          code: 'AGREEMENT_CLOSED',
          agreement: summary(target.record),
          hint: 'Si el acuerdo sigue abierto en Adobe Sign, use POST /admin/cancel/{agreementId}.'
        });
      default:
        // OPEN, o CANCELLED (repetição: o Adobe é reconsultado e o resultado é idempotente)
        return cancelAgreement(target.record.id, { comment, source });
    }
  }

  /*
    POST /cancel (WebReport do workflow de cancelamento). `input` é o corpo já autenticado (HMAC v2 + nonce):
      { workflowId, subworkflowId } = o workflow de cancelamento (a tarefa onde o WebReport roda).
    O fluxo a cancelar vem SEMPRE do formulário dessa tarefa (atributos CANCEL_FIELD_*), nunca do corpo. Exige a tarefa
    ativa e atribuída ao usuário de integração. Cancelamento confirmado => SendOn da tarefa do workflow de cancelamento.
    Repetir depois de uma falha no SendOn é seguro: o acordo já cancelado responde de forma idempotente.
  */
  async function cancelFromTask(input = {}) {
    const cfg = config.cancel || {};
    const processId = clean(input.workflowId);
    if (!isNumeric(processId)) throw fail(400, 'workflowId is mandatory.');

    let steps;
    try {
      steps = await otcs.getProcessSteps(processId);
    } catch (e) {
      if (httpStatus(e) === 404) throw flowNotFound();
      logger.error(`[CANCEL] OTCS getProcessSteps(${processId}) falló: ${describeError(e)}`);
      throw otcsUnavailable();
    }
    const { where, task } = locate(steps, cfg.taskNames, {
      subprocessHint: clean(input.subworkflowId), processId, latest: true
    });
    if (where !== 'current') {
      logger.warn(`[CANCEL] Workflow ${processId}: tarea de cancelación ${where === 'absent' ? 'no encontrada' : `en "${where}"`}`);
      throw fail(409, 'El flujo no está en el paso de cancelación.', { code: 'NOT_AT_CANCEL_STEP' });
    }

    // A tarefa precisa estar com o usuário de integração (o formulário só é legível para ele e o SendOn é dele).
    // assigneeIds null = o OTCS não informou os responsáveis: segue e deixa o formulário (401/403) decidir.
    let integrationUserId = null;
    let assigned = true;
    if (Array.isArray(task.assigneeIds)) {
      try {
        integrationUserId = Number((await otcs.getCurrentUser())?.id);
        if (!Number.isFinite(integrationUserId)) throw new Error('usuario de integración desconocido');
      } catch (e) {
        logger.error(`[CANCEL] OTCS getCurrentUser falló: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      assigned = task.assigneeIds.includes(integrationUserId);
    }
    const handoff = {
      workflowId: Number(task.processId),
      subworkflowId: Number(task.subprocessId),
      taskId: Number(task.taskId),
      integrationUserId,
      assigned
    };
    if (!assigned) {
      logger.info(`[CANCEL] Workflow ${processId}/${task.subprocessId}: tarea ${task.taskId} aún en otro usuario; la página debe reasignarla`);
      throw fail(409, 'La tarea debe asignarse al usuario de integración antes de cancelar.', {
        code: 'REASSIGN_REQUIRED', handoff
      });
    }

    let form;
    try {
      form = await otcs.getTaskForm(task.processId, task.subprocessId, task.taskId);
    } catch (e) {
      const status = httpStatus(e);
      if (status === 401 || status === 403) {
        logger.warn(`[CANCEL] Workflow ${processId}: formulario de la tarea ${task.taskId} sin acceso (HTTP ${status})`);
        throw fail(409, 'La tarea no está asignada al usuario de integración.', { code: 'REASSIGN_REQUIRED', handoff });
      }
      if (status === 404) throw flowNotFound();
      logger.error(`[CANCEL] OTCS getTaskForm(${task.processId}/${task.subprocessId}/${task.taskId}) falló: ${describeError(e)}`);
      throw otcsUnavailable();
    }

    // O destino sale del atributo del formulario (OTCS = fuente de la verdad); un valor del navegador no cuenta
    const targetWorkflowId = fieldValue(form.fields, cfg.fields?.targetWorkflow);
    const targetSubworkflowId = fieldValue(form.fields, cfg.fields?.targetSubworkflow);
    if (!isNumeric(targetWorkflowId)) {
      throw fail(422, 'El flujo de cancelación no tiene el ID del flujo a cancelar.', { code: 'MISSING_TARGET' });
    }
    if (targetSubworkflowId && !isNumeric(targetSubworkflowId)) {
      throw fail(422, 'El ID del subflujo a cancelar no es válido.', { code: 'INVALID_TARGET' });
    }
    const claimed = clean(input.targetWorkflowId);
    if (claimed && claimed !== targetWorkflowId) {
      logger.warn(`[CANCEL] Workflow ${processId}: el navegador envió targetWorkflowId=${claimed}; se ignora, vale el atributo del formulario (${targetWorkflowId})`);
    }

    const result = await cancelWorkflow(targetWorkflowId, {
      subworkflowId: targetSubworkflowId,
      comment: `Flujo cancelado desde Content Server (workflow de cancelación ${task.processId}).`,
      source: `workflow:${task.processId}/${task.subprocessId}`
    });

    try {
      await otcs.sendOnWorkflow({
        workflowId: task.processId,
        subworkflowId: task.subprocessId,
        taskId: task.taskId,
        comment: sendOnComment(result.agreementId)
      });
    } catch (e) {
      logger.error(`[${result.agreementId}] acuerdo cancelado, pero falló el SendOn de la tarea de cancelación ${task.processId}/${task.subprocessId}/${task.taskId}: ${describeError(e)}`);
      throw fail(503, 'El acuerdo fue cancelado, pero no se pudo continuar el flujo de cancelación; intente nuevamente.', {
        code: 'SENDON_FAILED', cancelled: true, id: result.agreementId
      });
    }
    logger.info(`[${result.agreementId}] SendOn de la tarea de cancelación ${task.taskId} realizado (workflow ${task.processId}/${task.subprocessId})`);
    return {
      id: result.agreementId,
      alreadyCancelled: result.alreadyCancelled,
      targetWorkflowId,
      targetSubworkflowId: result.subworkflowId
    };
  }

  return { cancelAgreement, cancelWorkflow, cancelFromTask };
}

module.exports = { createCancellationService, CANCEL_ERROR_MESSAGE };
