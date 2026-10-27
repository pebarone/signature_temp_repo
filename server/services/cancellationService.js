// services/cancellationService.js
// Caso de uso do cancelamento de fluxos (ticket 2026060410003715, "Cancelación y reenvío de flujos"):
//   cancelAgreement(id)        -> consulta o Adobe, pede o cancelamento e marca o acordo como encerrado
//   cancelWorkflow(workflowId) -> acha o acordo aberto do fluxo (nunca o de outro subprocesso) e cancela
//   cancelFromTask(input)      -> POST /cancel do WebReport (LOTE): lê no OTCS os fluxos alvo (atributo multivalor), cancela
//                                 um a um (cancelWorkflow), grava os cancelados no atributo de resultado e faz o SendOn da
//                                 tarefa do workflow de cancelamento
//   previewFromTask(input)     -> POST /cancel/preview: classifica cada alvo SEM cancelar nem gravar nada
//   cancelDirect(input)        -> POST /cancel/direct (MODO DIRETO: WebReport executado sozinho, sem workflow): os alvos vêm do
//                                 corpo (vinculados ao HMAC), cancela no Adobe e SEMPRE para o fluxo original no Content; sem
//                                 tarefa, formulário nem SendOn
//   previewDirect(input)       -> POST /cancel/direct/preview: prévia do modo direto (nada é cancelado nem parado)
// No modo da tarefa o orquestrador só para o fluxo original no Content com CANCEL_STOP_ORIGINAL; sem ele isso é do workflow
// de cancelamento. Em todo caso o acordo cancelado fica "concluído" (agreementState.cancelRequestedPatch) e o
// AGREEMENT_RECALLED posterior não gera Rechazado.
// Decisões e pontos em aberto: docs/DESIGN_TICKET_2026060410003715.md.
const { describeError } = require('../infra/util');
const { locate, normalizeName } = require('../domain/workflowSteps');
const {
  CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget, parseTargets, classifyCancelOutcome, countSignatures
} = require('../domain/cancellation');
const { cancelRequestedPatch } = require('../domain/agreementState');
const { KINDS, classifyAgreementStatus } = require('../domain/eventPolicy');
const { ServiceError } = require('./signatureService');
const { createWorkflowStopper } = require('./workflowStop');

const MAX_COMMENT_LENGTH = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 20000;
const DEFAULT_BATCH_BUDGET_MS = 15000;
const DEFAULT_MAX_TARGETS = 20;
const MAX_SENDON_COMMENT_LENGTH = 1000;
const DEFAULT_COMMENT = 'Flujo cancelado desde Content Server.';
const DIRECT_COMMENT = 'Flujo cancelado desde Content Server (WebReport de cancelación).';
const MAX_REQUESTED_BY_LENGTH = 64;
const CANCEL_ERROR_MESSAGE = 'Error al cancelar el flujo.';

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

// Usuário que a página do modo direto declara ter feito o pedido: texto simples de uma linha (só para auditoria e log;
// NUNCA autorização, porque é autodeclarado). Vazio se não for texto ou se nada sobrar depois da limpeza.
const cleanRequestedBy = (v) =>
  (typeof v === 'string' ? v.replace(/[^A-Za-z0-9._@-]+/g, '').slice(0, MAX_REQUESTED_BY_LENGTH) : '');

// Entrada do formulário da tarefa pelo rótulo (exato; senão ignorando acentos/caixa)
const fieldEntry = (fields, label) => {
  if (!label) return undefined;
  return fields?.[label] ?? Object.entries(fields || {}).find(([k]) => normalizeName(k) === normalizeName(label))?.[1];
};

// Valores de um atributo, multivalor ou não: o forms API devolve array em `value` para atributo multivalor; escalar
// (número ou texto, inclusive separado por vírgula) vira lista de um item. Vazios saem; objetos são ignorados.
const fieldValues = (fields, label) => {
  const v = fieldEntry(fields, label)?.value;
  return (Array.isArray(v) ? v : [v])
    .filter((x) => x !== undefined && x !== null && typeof x !== 'object')
    .map((x) => String(x).trim())
    .filter(Boolean);
};

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

  // Espera a reconciliação em curso do acordo, no máximo `limitMs` (padrão cancel.settleTimeoutMs; o lote passa o
  // menor entre ele e o tempo restante do prazo). false = estourou o prazo.
  async function waitSettled(id, limitMs) {
    const limit = Number(limitMs) || Number(config.cancel?.settleTimeoutMs) || DEFAULT_SETTLE_TIMEOUT_MS;
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
    Antes de qualquer chamada ao Adobe, espera a reconciliação que já estava em curso (limite cancel.settleTimeoutMs, ou
    `settleTimeoutMs` da opção interna do lote, que o limita ao tempo restante do prazo; estourou => 503
    RECONCILE_IN_PROGRESS, nada consultado nem marcado).
    Depois do cancelamento confirmado, o acordo vira "concluído" para o pipeline (sem SendOn nem PDF).
  */
  async function cancelAgreement(agreementId, { comment, source = 'admin', settleTimeoutMs } = {}) {
    const id = clean(agreementId);
    const rec = id ? repo.get(id) : null;
    if (!rec) throw notRegistered(id);
    if (inflight.has(id)) {
      throw fail(409, 'Ya hay una cancelación en curso para este acuerdo.', { code: 'IN_PROGRESS', agreementId: id });
    }
    inflight.add(id);
    const release = hold(id);
    try {
      if (!(await waitSettled(id, settleTimeoutMs))) {
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
  async function cancelWorkflow(workflowId, { subworkflowId, comment, source = 'admin', settleTimeoutMs } = {}) {
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
        return cancelAgreement(target.record.id, { comment, source, settleTimeoutMs });
    }
  }

  /*
    Leitura comum de /cancel e /cancel/preview: `input` é o corpo já autenticado (HMAC v2 + nonce) com
    { workflowId, subworkflowId } = o workflow de cancelamento (a tarefa onde o WebReport roda). Relê a tarefa no OTCS
    (ativa e atribuída ao usuário de integração) e o formulário dela. Devolve { task, form }; os alvos NUNCA vêm do corpo.
  */
  async function readTask(input) {
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
    return { task, form };
  }

  /*
    Alvos do formulário: atributo multivalor (cfg.fields.targetWorkflow) + subprocesso opcional. O subprocesso só vale
    com UM alvo (com vários é ignorado: subworkflowIgnored). 422 MISSING_TARGET / INVALID_TARGET / TOO_MANY_TARGETS.
  */
  function readTargets(form, task, input) {
    const cfg = config.cancel || {};
    const max = Number(cfg.maxTargets) || DEFAULT_MAX_TARGETS;
    const { ids, invalid, overLimit } = parseTargets(fieldValues(form.fields, cfg.fields?.targetWorkflow), { max });
    const subs = fieldValues(form.fields, cfg.fields?.targetSubworkflow);
    const badSubs = subs.length > 1 || (subs.length === 1 && !isNumeric(subs[0])) ? subs : [];
    if (invalid.length || badSubs.length) {
      throw fail(422, 'El ID del flujo o del subflujo a cancelar no es válido.', {
        code: 'INVALID_TARGET', invalid: [...invalid, ...badSubs]
      });
    }
    if (!ids.length) {
      throw fail(422, 'El flujo de cancelación no tiene el ID del flujo a cancelar.', { code: 'MISSING_TARGET' });
    }
    if (overLimit) {
      throw fail(422, `Se pueden cancelar como máximo ${max} flujos por solicitud.`, { code: 'TOO_MANY_TARGETS', max });
    }
    const claimed = clean(input.targetWorkflowId);
    if (claimed && !ids.includes(claimed)) {
      logger.warn(`[CANCEL] Workflow ${task.processId}: el navegador envió targetWorkflowId=${claimed}; se ignora, valen los atributos del formulario (${ids.join(', ')})`);
    }
    const subworkflowIgnored = ids.length > 1 && subs.length > 0;
    if (subworkflowIgnored) {
      logger.warn(`[CANCEL] Workflow ${task.processId}: hay ${ids.length} flujos a cancelar; el subflujo ${subs[0]} se ignora (solo vale con un flujo)`);
    }
    return { ids, subworkflowId: ids.length === 1 ? (subs[0] || '') : '', subworkflowIgnored };
  }

  /*
    Prazo ÚNICO do lote (e da prévia): deadline = início + cancel.batchBudgetMs. Antes de cada item (o primeiro inclusive,
    que sempre começa porque o prazo é >= 1 s) calcula-se o tempo restante; <= 0 => BUDGET_EXCEEDED. A espera pela
    reconciliação em curso de cada item é limitada a min(settleTimeoutMs, restante), então o pior caso normal de um pedido
    é ~batchBudgetMs + as chamadas ao Adobe do último item (GET + PUT + eventual reconsulta/histórico), abaixo do timeout
    da rota do OpenShift (~30 s). Exceção: o Adobe travar numa chamada (ADOBE_TIMEOUT_MS, 60 s): a rota corta, o servidor
    termina o item e repetir é idempotente (IN_PROGRESS / alreadyCancelled).
  */
  function makeDeadline() {
    const limit = Number(config.cancel?.batchBudgetMs) || DEFAULT_BATCH_BUDGET_MS;
    const deadline = Number(now()) + limit;
    return { remaining: () => deadline - Number(now()) };
  }

  const budgetItem = (workflowId) => ({
    workflowId,
    outcome: 'pending',
    code: 'BUDGET_EXCEEDED',
    message: 'Se agotó el tiempo de la solicitud antes de procesar este flujo; repita la operación.'
  });

  /*
    Para (stop) o fluxo ORIGINAL no Content depois de o Adobe confirmar (só com cancel.stopOriginal). Devolve 'stopped',
    'already_stopped' (o stop falhou, mas o estado relido mostra o processo parado/concluído/arquivado: sucesso idempotente)
    ou { failed: true, httpStatus } (qualquer erro, inclusive 400/401/403 = sem permissão; sem saber o estado, falha).
  */
  const stopOriginalFlow = createWorkflowStopper({ otcs, logger, tag: '[CANCEL]' });

  // Item do lote para um alvo: cancelWorkflow (lógica e idempotência unitárias) traduzido em cancelled/refused/pending;
  // com stopOriginal (cancel.stopOriginal no modo da tarefa; sempre no modo direto), o Adobe confirmado é seguido do stop
  // do original (falha => pending STOP_FAILED)
  async function cancelTarget(workflowId, { subworkflowId, comment, source, settleTimeoutMs, stopOriginal = false }) {
    try {
      const out = await cancelWorkflow(workflowId, { subworkflowId, comment, source, settleTimeoutMs });
      const item = {
        workflowId,
        outcome: 'cancelled',
        agreementId: out.agreementId,
        alreadyCancelled: out.alreadyCancelled,
        adobeStatus: out.adobeStatus,
        contentStop: 'disabled',
        message: out.alreadyCancelled ? 'El acuerdo ya estaba cancelado.' : 'Acuerdo cancelado.'
      };
      if (!stopOriginal) return item;
      const stop = await stopOriginalFlow(workflowId);
      if (typeof stop === 'string') return { ...item, contentStop: stop };
      const permissions = [400, 401, 403].includes(stop.httpStatus)
        ? ' Verifique los permisos del usuario de integración para detener procesos.' : '';
      return {
        ...item,
        outcome: 'pending',
        code: 'STOP_FAILED',
        cancelledInAdobe: true,
        contentStop: 'failed',
        message: `El acuerdo fue cancelado en Adobe Sign, pero no se pudo detener el flujo en Content Server; repita la operación.${permissions}`
      };
    } catch (e) {
      if (e instanceof ServiceError) {
        const b = e.body || {};
        return {
          workflowId,
          outcome: classifyCancelOutcome(b.code),
          agreementId: b.agreementId || b.agreement?.id,
          adobeStatus: b.adobeStatus,
          code: b.code || 'UNEXPECTED_ERROR',
          message: b.error || CANCEL_ERROR_MESSAGE,
          agreements: b.agreements,
          agreement: b.agreement,
          hint: b.hint
        };
      }
      logger.error(`[CANCEL] Flujo ${workflowId}: error inesperado al cancelar: ${describeError(e)}`);
      return { workflowId, outcome: 'pending', code: 'UNEXPECTED_ERROR', message: CANCEL_ERROR_MESSAGE };
    }
  }

  // Comentário do SendOn: resumo curto do lote (cancelados / não cancelados)
  function batchComment(items) {
    const done = items.filter((i) => i.outcome === 'cancelled').map((i) => i.workflowId);
    const notDone = items.filter((i) => i.outcome !== 'cancelled').map((i) => `${i.workflowId} (${i.code})`);
    const parts = [`Cancelados (${done.length}): ${done.join(', ') || '-'}`];
    if (notDone.length) parts.push(`No cancelados (${notDone.length}): ${notDone.join(', ')}`);
    const stopped = config.cancel?.stopOriginal ? 'sí' : 'no, los detiene el paso siguiente';
    return `Cancelación en Adobe Sign (originales detenidos en Content: ${stopped}). ${parts.join('. ')}`
      .slice(0, MAX_SENDON_COMMENT_LENGTH);
  }

  // Laço do lote (comum à tarefa e ao modo direto): prazo único, um item por vez, resumo por resultado
  async function runBatch(ids, { subworkflowId, comment, source, stopOriginal }) {
    const deadline = makeDeadline();
    const settleCap = Number(config.cancel?.settleTimeoutMs) || DEFAULT_SETTLE_TIMEOUT_MS;
    const items = [];
    for (const workflowId of ids) {
      const remaining = deadline.remaining();
      items.push(remaining <= 0
        ? budgetItem(workflowId)
        : await cancelTarget(workflowId, { subworkflowId, comment, source, stopOriginal, settleTimeoutMs: Math.min(settleCap, remaining) }));
    }
    const count = (outcome) => items.filter((i) => i.outcome === outcome).length;
    return { items, summary: { total: items.length, cancelled: count('cancelled'), refused: count('refused'), pending: count('pending') } };
  }

  /*
    POST /cancel (WebReport do workflow de cancelamento), em LOTE. Os alvos vêm SEMPRE do formulário da tarefa (nunca do
    corpo), ver readTask/readTargets. Processa em sequência com cancelWorkflow dentro de cancel.batchBudgetMs; cada item
    termina em cancelled / refused (definitivo) / pending (transitório, inclusive BUDGET_EXCEEDED).
      - algum pending: { complete: false, sentOn: false, items, summary }; nada é gravado e não há SendOn (repetir é seguro);
      - todos finais: grava os WorkIDs cancelados no atributo cancel.fields.result (vazio desliga) e faz o SendOn:
        sem o atributo => 409 RESULT_FIELD_MISSING; falha ao gravar => 503 RESULT_WRITE_FAILED; falha no SendOn =>
        503 SENDON_FAILED (cancelled: true). Todos com os items. Repetir é seguro: os cancelados voltam alreadyCancelled.
  */
  async function cancelFromTask(input = {}) {
    const cfg = config.cancel || {};
    const { task, form } = await readTask(input);
    const { ids, subworkflowId, subworkflowIgnored } = readTargets(form, task, input);

    // Gravação do resultado ligada e atributo ausente: falha ANTES de cancelar qualquer coisa (nada é consultado no Adobe)
    const resultLabel = clean(cfg.fields?.result);
    const resultField = resultLabel ? fieldEntry(form.fields, resultLabel) : null;
    if (resultLabel && !resultField?.key) {
      logger.error(`[CANCEL] Workflow ${task.processId}/${task.subprocessId}/${task.taskId}: el formulario no tiene el atributo de resultado "${resultLabel}"; no se cancela nada`);
      throw fail(409, `El formulario no tiene el atributo "${resultLabel}" para registrar los flujos cancelados.`, {
        code: 'RESULT_FIELD_MISSING'
      });
    }

    const stopOriginal = !!cfg.stopOriginal;
    const source = `workflow:${task.processId}/${task.subprocessId}`;
    const comment = `Flujo cancelado desde Content Server (workflow de cancelación ${task.processId}).`;
    const { items, summary } = await runBatch(ids, { subworkflowId, comment, source, stopOriginal });
    const where = `${task.processId}/${task.subprocessId}/${task.taskId}`;

    if (summary.pending) {
      logger.warn(`[CANCEL] Workflow ${where}: lote incompleto (${summary.cancelled} cancelados, ${summary.refused} rechazados, ${summary.pending} pendientes); sin SendOn, se debe repetir`);
      return { complete: false, sentOn: false, items, summary, stopOriginal, subworkflowIgnored };
    }

    const cancelledIds = items.filter((i) => i.outcome === 'cancelled').map((i) => i.workflowId);
    if (resultField) {
      try {
        await otcs.updateTaskForm(task.processId, task.subprocessId, task.taskId, { [resultField.key]: cancelledIds });
      } catch (e) {
        logger.error(`[CANCEL] Workflow ${where}: no se pudo grabar "${resultLabel}" en el formulario: ${describeError(e)}`);
        throw fail(503, 'No se pudo registrar los flujos cancelados en el formulario; intente nuevamente.', {
          code: 'RESULT_WRITE_FAILED', items, summary, stopOriginal
        });
      }
    }

    try {
      await otcs.sendOnWorkflow({
        workflowId: task.processId,
        subworkflowId: task.subprocessId,
        taskId: task.taskId,
        comment: batchComment(items)
      });
    } catch (e) {
      logger.error(`[CANCEL] Lote procesado, pero falló el SendOn de la tarea de cancelación ${where}: ${describeError(e)}`);
      throw fail(503, 'Los flujos fueron procesados, pero no se pudo continuar el flujo de cancelación; intente nuevamente.', {
        code: 'SENDON_FAILED', cancelled: true, items, summary, stopOriginal
      });
    }
    logger.info(`[CANCEL] SendOn de la tarea de cancelación ${where} realizado (${summary.cancelled} cancelados, ${summary.refused} rechazados)`);
    return { complete: true, sentOn: true, items, summary, resultField: resultLabel || null, stopOriginal, subworkflowIgnored };
  }

  // ---------- prévia (POST /cancel/preview): consulta, não cancela nem grava nada ----------

  const previewItem = (workflowId, state, cancelable, message, extra = {}) => ({
    workflowId, state, cancelable, ...extra, message
  });

  // Histórico do acordo: lista, ou null se não foi possível ler (nunca lança)
  async function readEvents(id) {
    try {
      return await adobe.getAgreementEvents(id);
    } catch (e) {
      logger.error(`[${id}] previa de cancelación: no se pudo consultar el historial en Adobe: ${describeError(e)}`);
      return null;
    }
  }

  async function previewTarget(workflowId, subworkflowId) {
    const target = selectCancelTarget(repo.listByWorkflow(workflowId, subworkflowId));
    if (target.kind === TARGET.NONE) {
      return previewItem(workflowId, 'no_encontrado', false,
        'El orquestador no tiene un acuerdo de firma para este flujo (si es del orquestador anterior, adóptelo; si ya está firmado, regularícelo).');
    }
    if (target.kind === TARGET.AMBIGUOUS) {
      return previewItem(workflowId, 'ambiguo', false,
        'El flujo tiene más de un acuerdo de firma abierto; indique el subflujo (solo con un flujo).',
        { agreements: target.records.map(summary) });
    }
    if (target.kind === TARGET.CLOSED) {
      return previewItem(workflowId, 'concluido', false,
        `El acuerdo más reciente del flujo ya concluyó (estado ${target.record.state}); no hay nada que cancelar.`,
        { agreementId: target.record.id, agreement: summary(target.record) });
    }

    const rec = target.record; // OPEN, o CANCELLED (repetición)
    const agreementId = rec.id;
    let status;
    try {
      status = clean((await adobe.getAgreement(agreementId))?.status).toUpperCase();
    } catch (e) {
      if (httpStatus(e) === 404) {
        return previewItem(workflowId, 'no_existe_en_adobe', false, 'El acuerdo no existe en Adobe Sign.', { agreementId });
      }
      logger.error(`[${agreementId}] previa de cancelación: no se pudo consultar el estado en Adobe: ${describeError(e)}`);
      return previewItem(workflowId, 'no_disponible', null, 'Adobe Sign no disponible; intente nuevamente.', { agreementId });
    }
    const base = { agreementId, adobeStatus: status };

    switch (classifyCancelState(status)) {
      case CANCEL_STATES.SIGNED:
        return previewItem(workflowId, 'firmado', false, 'Firmado: regularizar el flujo, no cancelar.', base);
      case CANCEL_STATES.NOT_CANCELABLE:
        return previewItem(workflowId, 'no_cancelable', false,
          `El acuerdo está en estado ${status || 'desconocido'} en Adobe Sign; no se puede cancelar.`, base);
      case CANCEL_STATES.ALREADY_CANCELLED: {
        // CANCELLED sin pedido nuestro: puede ser rechazo de un firmante (solo el historial lo distingue)
        if (status === 'CANCELLED' && !rec.cancelRequestedAt) {
          const events = await readEvents(agreementId);
          if (!events) {
            return previewItem(workflowId, 'no_disponible', null, 'No se pudo leer el historial del acuerdo; intente nuevamente.', base);
          }
          if (classifyAgreementStatus(status, events) === KINDS.FINAL_REJECTED) {
            return previewItem(workflowId, 'rechazado', false, 'Un firmante rechazó el acuerdo; no se cancela.', base);
          }
        }
        return previewItem(workflowId, 'ya_cancelado', true, 'El acuerdo ya estaba cancelado; se registrará como cancelado.', base);
      }
      default: {
        const events = await readEvents(agreementId);
        if (!events) {
          return previewItem(workflowId, 'abierto', true,
            'Acuerdo abierto en Adobe Sign (no se pudo leer el historial: puede haber firmas ya realizadas).',
            { ...base, partialUnknown: true });
        }
        const { signedCount, lastSignedAt } = countSignatures(events);
        if (signedCount > 0) {
          return previewItem(workflowId, 'firma_parcial', true,
            `Atención: ${signedCount} firma(s) ya realizada(s); al cancelar se pierden.`, { ...base, signedCount, lastSignedAt });
        }
        return previewItem(workflowId, 'abierto', true, 'Acuerdo abierto, sin firmas realizadas.', base);
      }
    }
  }

  // Laço da prévia (comum à tarefa e ao modo direto): mesmo prazo do lote; alvos não iniciados ao estourar => 'pendiente'
  async function runPreview(ids, subworkflowId) {
    const deadline = makeDeadline();
    const items = [];
    for (const workflowId of ids) {
      if (deadline.remaining() <= 0) {
        items.push(previewItem(workflowId, 'pendiente', null, 'Se agotó el tiempo de la solicitud antes de consultar este flujo; repita la operación.'));
        continue;
      }
      try {
        items.push(await previewTarget(workflowId, subworkflowId));
      } catch (e) {
        logger.error(`[CANCEL] Previa del flujo ${workflowId}: error inesperado: ${describeError(e)}`);
        items.push(previewItem(workflowId, 'no_disponible', null, CANCEL_ERROR_MESSAGE));
      }
    }
    const summary = { total: items.length };
    for (const i of items) summary[i.state] = (summary[i.state] || 0) + 1;
    return { items, summary };
  }

  /*
    POST /cancel/preview: mesma leitura e validação do /cancel (tarefa ativa, atribuída, alvos do formulário), mas só
    CONSULTA: nenhum cancelAgreement, nenhuma escrita no repositório (sem hold/inflight/settle), nenhum updateTaskForm e
    nenhum SendOn. Mesmo orçamento de tempo: alvos não iniciados ao estourar => state 'pendiente'.
    => { items, summary: { total, <state>: n }, subworkflowIgnored, resultFieldMissing? (true só se a gravação está ligada e o atributo falta) }. Estados e `cancelable`: ver a spec do lote
    (cancelable null = não se sabe: no_disponible e pendiente).
  */
  async function previewFromTask(input = {}) {
    const { task, form } = await readTask(input);
    const { ids, subworkflowId, subworkflowIgnored } = readTargets(form, task, input);

    // A prévia segue normalmente; resultFieldMissing avisa a página antes de confirmar o cancelamento
    const resultLabel = clean(config.cancel?.fields?.result);
    const resultFieldMissing = !!resultLabel && !fieldEntry(form.fields, resultLabel)?.key;

    const { items, summary } = await runPreview(ids, subworkflowId);
    return { items, summary, stopOriginal: !!config.cancel?.stopOriginal, subworkflowIgnored, ...(resultFieldMissing ? { resultFieldMissing: true } : {}) };
  }

  // ---------- modo direto (WebReport executado sozinho, sem workflow) ----------

  /*
    Alvos do corpo (já autenticado: o HMAC v2 + nonce vinculam targetWorkflowIds e targetSubworkflowId, ver
    middleware/hmac.js). targetWorkflowIds precisa ser LISTA (senão 422 INVALID_TARGET). O subprocesso opcional só vale
    com UM alvo (com vários é ignorado: subworkflowIgnored). 422 MISSING_TARGET / INVALID_TARGET / TOO_MANY_TARGETS.
  */
  function readDirectTargets(input) {
    const max = Number(config.cancel?.maxTargets) || DEFAULT_MAX_TARGETS;
    const raw = input.targetWorkflowIds;
    if (!Array.isArray(raw)) {
      throw fail(422, 'targetWorkflowIds debe ser una lista de IDs numéricos.', { code: 'INVALID_TARGET', invalid: [] });
    }
    // Só texto ou número por item (objetos e afins nunca viram ID; null/undefined são vazios e saem em parseTargets)
    const { ids, invalid, overLimit } = parseTargets(
      raw.map((x) => (x == null || typeof x === 'string' || typeof x === 'number' ? x : '[inválido]')), { max }
    );
    const sub = clean(input.targetSubworkflowId);
    const badSubs = sub && !isNumeric(sub) ? [sub] : [];
    if (invalid.length || badSubs.length) {
      throw fail(422, 'El ID del flujo o del subflujo a cancelar no es válido.', {
        code: 'INVALID_TARGET', invalid: [...invalid, ...badSubs]
      });
    }
    if (!ids.length) throw fail(422, 'No se indicó ningún flujo a cancelar.', { code: 'MISSING_TARGET' });
    if (overLimit) {
      throw fail(422, `Se pueden cancelar como máximo ${max} flujos por solicitud.`, { code: 'TOO_MANY_TARGETS', max });
    }
    const subworkflowIgnored = ids.length > 1 && !!sub;
    if (subworkflowIgnored) {
      logger.warn(`[CANCEL] Directo: hay ${ids.length} flujos a cancelar; el subflujo ${sub} se ignora (solo vale con un flujo)`);
    }
    return { ids, subworkflowId: ids.length === 1 ? sub : '', subworkflowIgnored };
  }

  /*
    POST /cancel/direct: cancela o lote no Adobe e SEMPRE para o fluxo original no Content (não há passo seguinte de um
    workflow de cancelamento que o faça), qualquer que seja CANCEL_STOP_ORIGINAL. Nunca lê tarefa nem formulário, não
    grava atributos e não faz SendOn (sentOn: false). complete = nenhum item pendente; repetir é seguro (alreadyCancelled /
    already_stopped). `requestedBy` (autodeclarado pela página) só entra no source e no comentário, para auditoria.
  */
  async function cancelDirect(input = {}) {
    const { ids, subworkflowId, subworkflowIgnored } = readDirectTargets(input);
    const user = cleanRequestedBy(input.requestedBy);
    const source = user ? `webreport:direct:${user}` : 'webreport:direct';
    const comment = DIRECT_COMMENT + (user ? ` Solicitado por ${user}.` : '');
    const { items, summary } = await runBatch(ids, { subworkflowId, comment, source, stopOriginal: true });
    const resumen = `${summary.cancelled} cancelados, ${summary.refused} rechazados, ${summary.pending} pendientes`;
    if (summary.pending) logger.warn(`[CANCEL] Directo (${source}): lote incompleto (${resumen}); se debe repetir`);
    else logger.info(`[CANCEL] Directo (${source}): lote concluido (${resumen})`);
    return { mode: 'direct', complete: !summary.pending, sentOn: false, items, summary, stopOriginal: true, subworkflowIgnored };
  }

  // POST /cancel/direct/preview: só consulta (nada é cancelado nem parado)
  async function previewDirect(input = {}) {
    const { ids, subworkflowId, subworkflowIgnored } = readDirectTargets(input);
    const { items, summary } = await runPreview(ids, subworkflowId);
    return { mode: 'direct', items, summary, stopOriginal: true, subworkflowIgnored };
  }

  return { cancelAgreement, cancelWorkflow, cancelFromTask, previewFromTask, cancelDirect, previewDirect };
}

module.exports = { createCancellationService, CANCEL_ERROR_MESSAGE };
