// services/reconciliationService.js
// Orquestra, de forma idempotente e persistida, o que acontece depois do /start:
//   start        -> SendOn da tarefa de início ("Enviar solicitud de firma")
//   verify       -> confirma o resultado final no Adobe (todos os finais; adota o do Adobe se divergir)
//   pdf          -> PDF assinado como NOVA VERSÃO do documento (nodeId) que foi enviado à assinatura
//   disposition  -> Firmado/Rechazado na tarefa de firma, localizada dinamicamente pelo nome
// A lógica de decisão vive em domain/; aqui só I/O (repositório, Adobe, OTCS) e serialização.
const {
  KINDS, isFinalKind, classifyEvent, classifyAgreementStatus, isCancelledStatus, confirmsFinalKind
} = require('../domain/eventPolicy');
const state = require('../domain/agreementState');
const { locate, normalizeName } = require('../domain/workflowSteps');
const { parseExternalId, isId } = require('../domain/externalId');
const { describeError } = require('../infra/util');

const { ATTENTION_KINDS } = state;

const START_COMMENT = 'Documento enviado para assinatura – etapa automatizada';
const NOT_OURS_TTL_MS = 10 * 60 * 1000;   // acordos de outras integrações da mesma conta: não consulta o Adobe a cada evento
const NOT_OURS_MAX = 2000;

// Comentário gravado na tarefa do workflow, por resultado
const DISPOSITION_COMMENTS = {
  [KINDS.FINAL_OK]: (id) => `Firmado en Adobe Sign (acuerdo ${id})`,
  [KINDS.FINAL_REJECTED]: () => 'Rechazado por el firmante en Adobe Sign',
  [KINDS.FINAL_EXPIRED]: () => 'Acuerdo expirado en Adobe Sign',
  [KINDS.FINAL_RECALLED]: () => 'Acuerdo cancelado en Adobe Sign',
  [KINDS.FINAL_CONVERSION_FAILED]: () => 'Adobe Sign no pudo procesar el documento'
};

// Erro de negócio da adoção manual (status HTTP sugerido para o /admin/adopt)
class AdoptError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

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
  const signNames = () => config.signTaskNames || ['Aguardar Firma'];
  const startNames = () => config.startTaskNames || ['Enviar solicitud de firma'];
  const wfAttrs = config.wfAttributes || { enabled: false, labels: {} };

  const queued = new Map();     // id -> Promise da próxima execução (coalescida)
  const queuedOpts = new Map(); // id -> opções mescladas
  const running = new Map();    // id -> Promise da execução em curso
  const timers = new Map();     // id -> timer de retry
  const attrChains = new Map(); // id -> Promise da última gravação de atributos (serializa por acordo)
  const attrMissingLogged = new Set(); // `${id}|${rótulo}` já logados (rótulo inexistente no mapa)
  const adopting = new Map();   // id -> Promise da adoção em curso
  const notOurs = new Map();    // id -> expiração (ms): acordo sem externalId nosso

  const nowIso = () => now().toISOString();

  /* ---------- helpers de estado ---------- */

  function markAttention(id, reason, kind = ATTENTION_KINDS.PERMANENT) {
    const rec = repo.get(id);
    clearTimeout_(id); // needs_attention não reprocessa sozinho (só reconcile manual, reabertura automática ou novo evento final)
    const changed = !(rec.state === state.STATES.NEEDS_ATTENTION && rec.attentionReason === reason);
    repo.upsert(id, state.attentionPatch(reason, kind));
    if (changed) {
      logger.error(`[${id}] needs_attention: ${reason}`);
      syncInBackground(id);
    }
    return { status: 'needs_attention', reason };
  }

  // permanent: só problema de dado/configuração que retentar não resolve (workflow inexistente...) => needs_attention
  // direto. Erros 4xx do OTCS NÃO são permanentes: retentam com backoff e, esgotadas as tentativas, viram
  // needs_attention retries_exhausted (reabre sozinho após ATTENTION_RETRY_HOURS).
  function registerFailure(id, stage, err, { permanent = false } = {}) {
    const rec = repo.get(id);
    const message = describeError(err);
    const { patch, delayMs, attention, attentionKind } = state.failurePatch(
      rec, stage, message, now().getTime(), backoff, { permanent }
    );
    repo.upsert(id, patch);
    if (attention) {
      logger.error(`[${id}] ${stage} failed (attempt ${patch.attempts}): ${message}`);
      return markAttention(id, attention, attentionKind);
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

  /* ---------- atributos do workflow com dados do Adobe (best effort) ---------- */

  const LABEL_KEYS = ['agreementId', 'status', 'lastEvent', 'updatedAt', 'integrationState'];

  function wfAttrValues(rec) {
    const last = repo.listEvents(rec.id, 1)[0];
    return {
      agreementId: rec.id,
      status: rec.adobeStatus || '',
      lastEvent: last?.canonical || last?.event || '',
      updatedAt: nowIso(),
      integrationState: rec.state || ''
    };
  }

  // updatedAt fica fora: senão o conjunto "mudaria" a cada chamada
  const wfAttrFingerprint = (v) => JSON.stringify([v.agreementId, v.status, v.lastEvent, v.integrationState]);

  async function doSyncAttributes(id, { located = null, form = null } = {}) {
    try {
      const rec = repo.get(id);
      if (!rec || !rec.workflowId) return;
      const labels = LABEL_KEYS.filter((k) => wfAttrs.labels?.[k]);
      if (!labels.length) return;

      const values = wfAttrValues(rec);
      const fingerprint = wfAttrFingerprint(values);
      if (rec.wfAttrsFingerprint === fingerprint) return;

      if (!located) {
        const steps = await otcs.getProcessSteps(rec.workflowId);
        located = locate(steps, signNames(), { subprocessHint: rec.subworkflowId, processId: rec.workflowId });
      }
      if (located.where !== 'current') return; // só com a tarefa ativa (formUpdate); ambígua/ausente: nada a gravar
      const t = located.task;
      form = form || await otcs.getTaskForm(t.processId, t.subprocessId, t.taskId);

      const toWrite = {};
      for (const k of labels) {
        const label = wfAttrs.labels[k];
        const field = form.fields?.[label];
        if (!field) {
          const key = `${id}|${label}`;
          if (!attrMissingLogged.has(key)) {
            attrMissingLogged.add(key);
            logger.info(`[${id}] atributo "${label}" no existe en el mapa del workflow: ignorado`);
          }
          continue;
        }
        toWrite[field.key] = String(values[k] ?? '');
      }
      if (Object.keys(toWrite).length) {
        await otcs.updateTaskForm(t.processId, t.subprocessId, t.taskId, toWrite);
      }
      repo.upsert(id, { wfAttrsFingerprint: fingerprint });
    } catch (e) {
      logger.warn(`[${id}] no se pudieron actualizar los atributos del workflow: ${describeError(e)}`);
    }
  }

  // Nunca rejeita; serializado por acordo
  function syncWorkflowAttributes(id, opts = {}) {
    if (!wfAttrs.enabled) return Promise.resolve();
    const prev = attrChains.get(id) || Promise.resolve();
    const p = prev.then(() => doSyncAttributes(id, opts));
    attrChains.set(id, p);
    p.then(() => { if (attrChains.get(id) === p) attrChains.delete(id); });
    return p;
  }

  // Sem aguardar (mudança de estado Adobe / da integração fora do pipeline)
  function syncInBackground(id) {
    if (wfAttrs.enabled) syncWorkflowAttributes(id).catch(() => {});
  }

  /* ---------- etapas do pipeline ---------- */
  // Cada etapa devolve { rec } (segue) ou { result } (encerra a reconciliação com esse resultado).

  // Falha ao ler o processo: 404 = workflow inexistente (permanente); qualquer outro erro é transitório (retry com backoff)
  function stepsFailure(id, stage, rec, e) {
    if (e?.response?.status === 404) {
      return registerFailure(
        id, stage, new Error(`workflow inexistente (${rec.workflowId}): ${describeError(e)}`), { permanent: true }
      );
    }
    return registerFailure(id, stage, e);
  }

  // A tarefa existe em mais de um subprocesso do pai e o acordo não diz qual: dado ambíguo, retentar não resolve.
  // Nada é enviado ao OTCS; o admin indica o subprocesso em POST /admin/reconcile/:id.
  function attentionAmbiguous(id, rec, names, located) {
    const hint = String(rec.subworkflowId ?? '').trim() || 'vacío';
    return markAttention(
      id,
      `la tarea "${names.join(' / ')}" existe en más de un subproceso (${located.subprocesses.join(', ')}) del workflow `
      + `${rec.workflowId} y el acuerdo no indica cuál (subworkflowId ${hint}); indique el subproceso en `
      + `POST /admin/reconcile/${id} con {"subworkflowId": ...}`,
      ATTENTION_KINDS.PERMANENT
    );
  }

  // Sufixo da mensagem quando a tarefa só existe em OUTRO subprocesso (nunca se usa a de outro subprocesso)
  const elsewhereNote = (rec, located) => (located.elsewhere?.length
    ? ` (existe en otro subproceso: ${located.elsewhere.join(', ')}; no corresponde al acuerdo, subproceso ${rec.subworkflowId})`
    : '');

  // Tarefa de início ainda atribuída ao usuário (não ao de integração): estado transitório "aguardando reatribuição".
  // Conta como tentativa da etapa start (backoff e limite normais), mas sem log de erro; esgotadas as tentativas,
  // needs_attention com o motivo explícito (reabre sozinho após ATTENTION_RETRY_HOURS ou ao repetir o /start).
  function waitForHandoff(id, rec, t) {
    const message = `la tarea de envío (${t.taskId}) sigue asignada al usuario; reabra la página para completar el envío`;
    const { patch, delayMs, attention, attentionKind } = state.failurePatch(rec, 'start', message, now().getTime(), backoff);
    repo.upsert(id, patch);
    if (attention) return markAttention(id, attention, attentionKind);
    logger.info(`[${id}] ${message} (intento ${patch.attempts}); próximo intento: ${patch.nextAttemptAt}`);
    scheduleRetry(id, delayMs);
    return { status: 'waiting_handoff', stage: 'start', attempts: patch.attempts };
  }

  /*
    start: localiza a tarefa de início pelo nome e faz o SendOn. Já concluída (ou a tarefa de firma já ativa/concluída)
    => só marca como feito. `steps` evita uma segunda consulta quando o chamador já a fez.
  */
  async function ensureStartSent(id, rec, { steps = null } = {}) {
    if (!rec.workflowId) return { rec };
    try {
      steps = steps || await otcs.getProcessSteps(rec.workflowId);
    } catch (e) {
      return { result: stepsFailure(id, 'start', rec, e) };
    }
    const hint = { subprocessHint: rec.subworkflowId, processId: rec.workflowId };
    const start = locate(steps, startNames(), hint);
    if (start.where === 'ambiguous') return { result: attentionAmbiguous(id, rec, startNames(), start) };

    if (start.where === 'current') {
      const t = start.task;
      // O WebReport só reatribui a tarefa ao usuário de integração DEPOIS do /start: enquanto ela está com o usuário
      // humano não há SendOn possível (nem erro): espera a reatribuição com o backoff normal
      // assigneeIds null = o OTCS não informou os responsáveis: segue como antes (tenta o SendOn), sem consultar o usuário
      if (Array.isArray(t.assigneeIds)) {
        let integrationUserId;
        try {
          integrationUserId = Number((await otcs.getCurrentUser())?.id);
          if (!Number.isFinite(integrationUserId)) throw new Error('usuario de integración desconocido');
        } catch (e) {
          return { result: registerFailure(id, 'start', e) };
        }
        if (!t.assigneeIds.includes(integrationUserId)) return { result: waitForHandoff(id, rec, t) };
      }
      await syncWorkflowAttributes(id, { located: start }); // antes do SendOn; nunca falha
      try {
        await otcs.sendOnWorkflow({
          workflowId: t.processId, subworkflowId: t.subprocessId, taskId: t.taskId, comment: START_COMMENT
        });
      } catch (e) {
        try { repo.upsert(id, { startSendOnError: describeError(e) }); } catch { /* ignore */ }
        // transitório até o limite de tentativas: o WebReport pode ainda estar ocupando a tarefa
        return { result: registerFailure(id, 'start', e) };
      }
      clearTimeout_(id);
      rec = repo.upsert(id, state.startDonePatch(rec, nowIso()));
      logger.info(`[${id}] SendOn automático realizado (tarea ${t.taskId} "${t.name}") para el workflow ${t.processId}`);
      return { rec };
    }

    const sign = locate(steps, signNames(), hint);
    if (start.where !== 'completed' && sign.where === 'ambiguous') {
      return { result: attentionAmbiguous(id, rec, signNames(), sign) };
    }
    if (start.where === 'completed' || sign.where === 'current' || sign.where === 'completed') {
      rec = repo.upsert(id, state.startDonePatch(rec, nowIso()));
      logger.info(
        `[${id}] solicitud de firma ya enviada (tarea de inicio: ${start.where}; tarea de firma: ${sign.where}): sin SendOn`
      );
      return { rec };
    }
    return {
      result: registerFailure(id, 'start', new Error(
        `no se encontró la tarea de inicio (${startNames().join(' / ')}) activa en el workflow ${rec.workflowId} (${start.where})${elsewhereNote(rec, start)}`
      ))
    };
  }

  /*
    verify: Adobe é a fonte da verdade para TODO resultado final (webhook ou polling; o status do payload não é confiável).
    Um adobeStatus gravado por consulta ao Adobe que já confirma o resultado dispensa nova consulta (o polling já a fez).
    Senão: em andamento => transitório (retry com backoff); o Adobe confirma => segue; outro resultado final => adota o
    do Adobe (o pipeline roda de novo, uma vez); sem resultado final => needs_attention. O final OK não adota outro resultado.
  */
  async function verifyFinal(id, rec) {
    if (confirmsFinalKind(rec.finalKind, rec.adobeStatus)) return { rec };
    let status;
    let events;
    try {
      status = String((await adobe.getAgreement(id))?.status || '').trim().toUpperCase();
      // recusa x recall (CANCELLED) depende do histórico; o final OK não precisa dele
      if (rec.finalKind !== KINDS.FINAL_OK && isCancelledStatus(status)) events = await adobe.getAgreementEvents(id);
    } catch (e) {
      return { result: registerFailure(id, 'verify', e) };
    }
    if (confirmsFinalKind(rec.finalKind, status, events)) return { rec: repo.upsert(id, { adobeStatus: status }) };

    // Estado em andamento logo após o webhook é transitório: retenta com backoff em vez de travar em needs_attention.
    const kind = classifyAgreementStatus(status, events);
    if (kind === KINDS.PROGRESS) {
      const what = rec.finalKind === KINDS.FINAL_OK ? 'la firma' : `el resultado ${rec.finalKind}`;
      return { result: registerFailure(id, 'verify', new Error(`Adobe aún no confirma ${what} (estado ${status})`)) };
    }
    // Sem outro resultado final (NEEDS_ATTENTION/UNKNOWN/vazio, ABORTED fora da conversão) ou final OK divergente
    if (rec.finalKind === KINDS.FINAL_OK || !isFinalKind(kind)) {
      logger.error(`[${id}] evento final no confirmado por Adobe: ${status || 'sin estado'}`);
      return {
        result: markAttention(
          id, `evento final no confirmado por Adobe: ${status || 'sin estado'}`, ATTENTION_KINDS.UNCONFIRMED
        )
      };
    }

    // Outro resultado final: prevalece o do Adobe (o webhook pode ter sido forjado ou estar desatualizado)
    const ts = nowIso();
    const patch = state.finalPatch(rec, kind, { nowIso: ts, adobeStatus: status });
    if (!patch) {
      return {
        result: markAttention(
          id,
          `Adobe indica ${kind} (estado ${status}), pero el acuerdo ya tiene ${rec.finalKind} con el PDF entregado`,
          ATTENTION_KINDS.UNCONFIRMED
        )
      };
    }
    logger.warn(`[${id}] Adobe indica ${kind} (estado ${status}) y no ${rec.finalKind}: se adopta el resultado de Adobe`);
    const recorded = repo.recordEvent(id, {
      event: `VERIFY_STATUS_${status}`,
      canonical: `VERIFY_STATUS_${status}`,
      kind,
      source: 'verify',
      receivedAt: ts,
      summary: { status, previousKind: rec.finalKind }
    }, patch);
    return { rec: recorded.record, adopted: true };
  }

  /*
    pdf: o PDF assinado vira NOVA VERSÃO do nó que foi enviado à assinatura (DocID): o workflow devolve e a
    distribuição ao workspace copia esse nó. Se o nó não existe mais ou não é acessível, cai para um documento na pasta
    de anexos. Falha no addVersion: 404 => fallback direto; outro 4xx (o OTCS documenta 400 para nó inexistente/sem
    acesso; 409/423 para nó reservado) => sonda o nó: inexistente => fallback; existente => transitório (retry, o nó
    pode estar reservado); sonda com erro => transitório, sem fallback. Erros não-4xx (5xx, rede, 401/408/429) e
    qualquer falha no upload para a pasta também são transitórios.
  */
  async function deliverSignedPdf(id, plan, rec) {
    if (!plan.pdf || rec.pdfDelivered) return { rec };
    if (!rec.nodeId && !rec.attachId) {
      return {
        result: markAttention(id, 'acuerdo sin nodeId ni attachId: no hay dónde entregar el PDF', ATTENTION_KINDS.PERMANENT)
      };
    }
    const name = (rec.fileName || '').trim() || `node_${rec.nodeId}.pdf`;
    let buf;
    try {
      buf = await adobe.downloadCombinedDocument(id);
    } catch (e) {
      return { result: registerFailure(id, 'pdf', e) };
    }

    let pdfNodeId = null;
    let versioned = false;
    if (rec.nodeId) {
      try {
        await otcs.addVersion(rec.nodeId, buf, name, { agreementId: id });
        pdfNodeId = rec.nodeId;
        versioned = true;
      } catch (e) {
        const status = e?.response?.status;
        if (status !== 404) {
          if (!state.isPermanentHttpError(e)) return { result: registerFailure(id, 'pdf', e) };
          let exists;
          try {
            exists = await otcs.nodeExists(rec.nodeId);
          } catch {
            return { result: registerFailure(id, 'pdf', e) }; // sem saber se o nó existe não há fallback
          }
          if (exists) {
            return {
              result: registerFailure(id, 'pdf', new Error(
                `el documento ${rec.nodeId} existe pero rechazó la nueva versión (${describeError(e)}); puede estar reservado o sin permiso`
              ))
            };
          }
        }
        logger.warn(
          `[${id}] el nodo ${rec.nodeId} ya no existe o no es accesible (HTTP ${status}): el PDF irá a la carpeta ${rec.attachId || '(sin attachId)'}`
        );
      }
    }
    if (!versioned) {
      if (!rec.attachId) {
        return {
          result: markAttention(id, 'acuerdo sin attachId: no hay carpeta destino para el PDF', ATTENTION_KINDS.PERMANENT)
        };
      }
      try {
        const created = await otcs.uploadToFolder(rec.attachId, buf, name, { agreementId: id });
        pdfNodeId = created?.id ?? null;
      } catch (e) {
        return { result: registerFailure(id, 'pdf', e) };
      }
    }
    rec = repo.upsert(id, state.pdfDeliveredPatch(nowIso(), pdfNodeId));
    logger.info(versioned
      ? `[${id}] PDF final enviado como nueva versión del nodo ${rec.nodeId} del Content Server`
      : `[${id}] PDF final enviado a la carpeta ${rec.attachId} del Content Server`);
    return { rec };
  }

  /*
    disposition: localiza a tarefa de firma pelo nome, SÓ no subprocesso do acordo (pode ser diferente do processo), e a
    conclui. Tarefa já concluída fora da integração => conclui sem enviar nada (não é needs_attention).
    Tarefa em mais de um subprocesso sem dica clara => needs_attention permanente, sem SendOn.
  */
  async function executeDisposition(id, plan, rec) {
    const disposition = state.dispositionFor(plan, config.dispositions);
    if (!rec.workflowId) {
      return {
        result: markAttention(id, 'acuerdo sin workflowId: no se puede ejecutar la disposición', ATTENTION_KINDS.PERMANENT)
      };
    }

    let located;
    for (let pass = 0; ; pass++) {
      let steps;
      try {
        steps = await otcs.getProcessSteps(rec.workflowId);
      } catch (e) {
        return { result: stepsFailure(id, 'disposition', rec, e) };
      }
      const hint = { subprocessHint: rec.subworkflowId, processId: rec.workflowId };
      located = locate(steps, signNames(), hint);
      if (located.where === 'ambiguous') return { result: attentionAmbiguous(id, rec, signNames(), located) };
      if (located.where === 'current' || located.where === 'completed') break;

      // Tarefa de firma ainda não existe: se o pedido de firma não foi enviado, envia agora e olha de novo (uma vez)
      const start = locate(steps, startNames(), hint);
      if (start.where === 'ambiguous') return { result: attentionAmbiguous(id, rec, startNames(), start) };
      if (start.where === 'current' && pass === 0) {
        const r = await ensureStartSent(id, rec, { steps });
        if (r.result) return r;
        rec = r.rec;
        continue;
      }
      return {
        result: registerFailure(id, 'disposition', new Error(
          `la tarea de firma (${signNames().join(' / ')}) no está activa en el workflow ${rec.workflowId} (${located.where})${elsewhereNote(rec, located)}`
        ))
      };
    }

    const t = located.task;
    rec = repo.upsert(id, { signSubprocessId: String(t.subprocessId), signTaskId: t.taskId });

    if (located.where === 'completed') {
      clearTimeout_(id);
      rec = repo.upsert(id, state.completedPatch(plan, disposition, nowIso(), { externally: true }));
      logger.info(`[${id}] tarea ${t.taskId} "${t.name}" ya concluida fuera de la integración: sin disposición`);
      return { result: { status: 'completed', completedExternally: true, record: rec } };
    }

    if (!disposition) {
      return {
        result: markAttention(
          id, `resultado ${rec.finalKind} sin disposición configurada (${plan.dispositionKey})`, ATTENTION_KINDS.CONFIG
        )
      };
    }

    // Valida a disposição contra as ações reais da tarefa. Se o formulário não puder ser lido não bloqueia
    let form = null;
    try {
      form = await otcs.getTaskForm(t.processId, t.subprocessId, t.taskId);
    } catch (e) {
      logger.warn(`[${id}] no se pudo leer el formulario de la tarea ${t.taskId}: ${describeError(e)}`);
    }
    let action = disposition;
    if (form && Array.isArray(form.customActions)) {
      const wanted = normalizeName(disposition);
      const match = form.customActions.find((a) => a === disposition)
        || form.customActions.find((a) => normalizeName(a) === wanted);
      if (!match) {
        return {
          result: markAttention(
            id,
            `disposición "${disposition}" no disponible en la tarea ${t.taskId} "${t.name}" (disponibles: ${form.customActions.join(', ')})`,
            ATTENTION_KINDS.PERMANENT
          )
        };
      }
      action = match;
    }

    await syncWorkflowAttributes(id, { located, form }); // antes da disposição; nunca falha

    try {
      await otcs.sendOnWorkflow({
        workflowId: t.processId,
        subworkflowId: t.subprocessId,
        taskId: t.taskId,
        disposition: action,
        comment: (DISPOSITION_COMMENTS[rec.finalKind] || (() => action))(id)
      });
    } catch (e) {
      // A tarefa pode ter sido concluída entre a consulta e o PUT, inclusive com a resposta do PUT perdida.
      // Antes de retentar um 4xx, confirma a conclusão da MESMA tarefa no processo.
      if (state.isPermanentHttpError(e)) {
        try {
          const steps = await otcs.getProcessSteps(rec.workflowId);
          const completed = (steps.completed || []).some((s) =>
            String(s.processId) === String(t.processId)
            && String(s.subprocessId) === String(t.subprocessId)
            && String(s.taskId) === String(t.taskId));
          if (completed) {
            clearTimeout_(id);
            rec = repo.upsert(id, state.completedPatch(plan, action, nowIso(), { externally: true }));
            logger.info(`[${id}] tarea ${t.taskId} ya concluida al confirmar el error del envío: sin nueva disposición`);
            return { result: { status: 'completed', completedExternally: true, record: rec } };
          }
        } catch (checkError) {
          // Sem conseguir confirmar a conclusão: a próxima tentativa consulta de novo.
          return { result: stepsFailure(id, 'disposition', rec, checkError) };
        }
      }
      return { result: registerFailure(id, 'disposition', e) };
    }
    clearTimeout_(id);
    rec = repo.upsert(id, state.completedPatch(plan, action, nowIso()));
    logger.info(`[${id}] SendOn task ${t.taskId} (${action}) done for workflow ${t.processId}/${t.subprocessId}`);
    return { result: { status: 'completed', record: rec } };
  }

  /* ---------- reconciliação de um acordo ---------- */

  async function doReconcile(id, opts) {
    let rec = repo.get(id);
    if (!rec) return { status: 'unknown' };
    if (rec.state === state.STATES.NEEDS_ATTENTION && !opts.manual) {
      return { status: 'needs_attention', reason: rec.attentionReason, record: rec };
    }

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
    if (rec.sendonDone) return { status: 'done', record: rec };
    // reconcile manual (POST /admin/reconcile): tira de needs_attention e zera as tentativas (rodada nova)
    if (opts.manual && (rec.state === state.STATES.NEEDS_ATTENTION || rec.attempts)) {
      rec = repo.upsert(id, state.reopenPatch(rec));
    }
    if (!plan && !state.isStartPending(rec)) return { status: 'no_final', record: rec };
    if (!opts.force && !state.isDue(rec, now().getTime())) return { status: 'deferred', record: rec };

    // Sem resultado final: só o pedido de firma pode estar pendente
    if (!plan) {
      const r = await ensureStartSent(id, rec);
      return r.result || { status: 'start_sent', record: r.rec };
    }

    let step = await verifyFinal(id, rec);
    if (step.result) return step.result;
    if (step.adopted) {
      // Com o resultado do Adobe mudou o plano (e a disposição): o pipeline roda de novo, uma única vez (a flag evita laço)
      if (opts.rerun) {
        return markAttention(id, 'Adobe cambió el resultado final durante la verificación', ATTENTION_KINDS.UNCONFIRMED);
      }
      return doReconcile(id, { ...opts, rerun: true });
    }
    step = await deliverSignedPdf(id, plan, step.rec);
    if (step.result) return step.result;
    step = await executeDisposition(id, plan, step.rec);
    return step.result;
  }

  /* ---------- serialização por acordo ---------- */

  function enqueue(id, opts) {
    const merged = { ...(queuedOpts.get(id) || {}), ...opts };
    if (queuedOpts.has(id)) {
      // coalesce: um force/refresh pendente não pode ser perdido
      merged.force = !!(queuedOpts.get(id).force || opts.force);
      merged.refresh = !!(queuedOpts.get(id).refresh || opts.refresh);
      merged.manual = !!(queuedOpts.get(id).manual || opts.manual);
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

  /*
    Retoma a etapa start de um acordo existente (o /start foi repetido, p.ex. depois de a página reatribuir a tarefa):
    ignora o backoff e, se as tentativas já tinham esgotado (needs_attention retries_exhausted), reabre uma rodada nova.
    Serializado por acordo como qualquer reconcile; seguro de repetir.
  */
  function resumeStart(id) {
    id = String(id);
    const rec = repo.get(id);
    const reopen = !!rec && state.isStartPending(rec)
      && rec.state === state.STATES.NEEDS_ATTENTION && rec.attentionKind === ATTENTION_KINDS.RETRIES_EXHAUSTED;
    return reconcile(id, reopen ? { manual: true } : {});
  }

  /* ---------- adoção de acordos desconhecidos ---------- */

  const isNotOurs = (id) => {
    const exp = notOurs.get(id);
    if (exp === undefined) return false;
    if (exp > now().getTime()) return true;
    notOurs.delete(id);
    return false;
  };

  function rememberNotOurs(id) {
    const t = now().getTime();
    if (notOurs.size >= NOT_OURS_MAX) {
      for (const [k, exp] of notOurs) if (exp <= t) notOurs.delete(k);
      if (notOurs.size >= NOT_OURS_MAX) notOurs.clear();
    }
    notOurs.set(id, t + NOT_OURS_TTL_MS);
  }

  const emailsOf = (ag) => [...new Set(
    (Array.isArray(ag?.participantSetsInfo) ? ag.participantSetsInfo : [])
      .flatMap((s) => (Array.isArray(s?.memberInfos) ? s.memberInfos : []))
      .map((m) => m?.email)
      .filter(Boolean)
  )];

  // Cria o registro de um acordo existente no Adobe a partir de { workflowId, subworkflowId, nodeId, attachId }
  function createAdoptedRecord(id, ag, src, fileName) {
    const createdMs = Date.parse(ag?.createdDate || '');
    return repo.upsert(id, {
      nodeId: String(src.nodeId),
      attachId: String(src.attachId),
      workflowId: String(src.workflowId),
      subworkflowId: String(src.subworkflowId || src.workflowId),
      fileName: (fileName || String(ag?.name || '').replace(/^Documento\s+/i, '') || `node_${src.nodeId}.pdf`).trim(),
      emails: emailsOf(ag),
      state: 'pending',
      adopted: true,
      // Sem o estado local não sabemos se o SendOn ocorreu; a etapa start confirma no OTCS antes de enviar.
      startSendonDone: false,
      ...(Number.isFinite(createdMs) ? { createdAt: new Date(createdMs).toISOString() } : {})
    });
  }

  // Resolve true se o acordo já está (ou passou a estar) no store. Nunca rejeita.
  function ensureAdopted(id) {
    if (repo.has(id)) return Promise.resolve(true);
    if (adopting.has(id)) return adopting.get(id);
    const p = Promise.resolve().then(async () => {
      try {
        const ag = await adobe.getAgreement(id);
        const ext = parseExternalId(ag?.externalId?.id);
        if (!ext) {
          rememberNotOurs(id);
          logger.warn(`[${id}] acuerdo desconocido sin externalId propio: no se adopta`);
          return false;
        }
        if (!repo.has(id)) {
          createAdoptedRecord(id, ag, ext);
          logger.warn(`[${id}] acuerdo desconocido adoptado por su externalId (workflow ${ext.workflowId}, nodo ${ext.nodeId})`);
        }
        return true;
      } catch (e) {
        logger.warn(`[${id}] no se pudo adoptar el acuerdo desconocido: ${describeError(e)}`);
        return false;
      }
    }).finally(() => adopting.delete(id));
    adopting.set(id, p);
    return p;
  }

  /*
    Adoção manual (POST /admin/adopt/:id). Usa o externalId do acordo; `data` ({ workflowId, subworkflowId?, nodeId,
    attachId, fileName? }) completa/substitui — necessário para acordos criados antes do externalId.
  */
  async function adopt(id, data = {}) {
    id = String(id);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new AdoptError(422, 'Invalid agreement id.');
    if (repo.has(id)) throw new AdoptError(409, 'Agreement already registered.');
    let ag;
    try {
      ag = await adobe.getAgreement(id);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404 || status === 400) throw new AdoptError(404, 'Agreement not found in Adobe Sign.');
      throw new AdoptError(502, `Could not query Adobe Sign: ${describeError(e)}`);
    }
    const body = data && typeof data === 'object' ? data : {};
    const src = { ...(parseExternalId(ag?.externalId?.id) || {}) };
    for (const k of ['workflowId', 'subworkflowId', 'nodeId', 'attachId']) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') src[k] = String(body[k]).trim();
    }
    const missing = ['workflowId', 'nodeId', 'attachId'].filter((k) => !isId(src[k]));
    if (missing.length || (src.subworkflowId && !isId(src.subworkflowId))) {
      throw new AdoptError(
        422,
        'Agreement has no usable externalId; send numeric workflowId, nodeId and attachId (subworkflowId optional).',
        { missing }
      );
    }
    if (repo.has(id)) throw new AdoptError(409, 'Agreement already registered.');
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim().slice(0, 300) : '';
    const rec = createAdoptedRecord(id, ag, src, fileName);
    logger.warn(`[${id}] acuerdo adoptado manualmente (workflow ${rec.workflowId}, nodo ${rec.nodeId})`);
    return rec;
  }

  /* ---------- entradas: webhook e polling ---------- */

  /*
    Registra o evento (persistido e deduplicado) e aplica a transição de estado de forma síncrona.
    O processamento (PDF -> disposição) segue assíncrono em `result.processing` (Promise que nunca
    rejeita); o chamador do webhook não precisa aguardá-lo. Acordo desconhecido: tenta adotá-lo em background
    (`result.adoption`, também nunca rejeita) e reaplica o evento.
  */
  function handleEvent(parsed, { noAdopt = false } = {}) {
    const id = parsed.agreementId && String(parsed.agreementId);
    if (!id) {
      logger.warn(`Webhook sin agreement id (evento ${parsed.eventName})`);
      return { known: false, reason: 'no_agreement_id' };
    }
    const rec = repo.get(id);
    if (!rec) {
      if (config.adoptUnknownAgreements && !noAdopt && !isNotOurs(id)) {
        logger.warn(`Webhook de un acuerdo desconocido ${id} (evento ${parsed.eventName}): intentando adoptarlo por su externalId`);
        const adoption = ensureAdopted(id)
          .then((ok) => {
            if (!ok) return undefined;
            const again = handleEvent(parsed, { noAdopt: true });
            return again.processing;
          })
          .catch((e) => logger.error(`[${id}] error al reaplicar el evento tras la adopción: ${describeError(e)}`));
        return { known: false, reason: 'unknown_agreement', adoption };
      }
      logger.warn(`Webhook de un acuerdo desconocido ${id} (evento ${parsed.eventName}): no está en el store`);
      return { known: false, reason: 'unknown_agreement' };
    }

    const { kind, canonical } = classifyEvent(parsed.eventName, parsed.payload);
    const ts = nowIso();
    let patch = null;
    if (isFinalKind(kind)) {
      // O status do payload NÃO vai para adobeStatus (webhook não é confiável; fica só no resumo do evento)
      patch = state.finalPatch(rec, kind, { nowIso: ts });
      // Troca de resultado (ex.: RECALLED gravado pelo polling e REJECTED pelo webhook): o adobeStatus gravado é do
      // resultado anterior e não confirma o novo; zera para o verify consultar o Adobe (com os eventos) de novo
      if (patch && rec.finalKind && rec.finalKind !== kind) patch.adobeStatus = null;
    } else if (kind === KINDS.NEEDS_ATTENTION) {
      patch = rec.sendonDone ? null : state.attentionPatch(`evento ${canonical}`, ATTENTION_KINDS.EVENT);
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
      Object.assign(patch, state.attentionPatch(`estado Adobe ${status}`, ATTENTION_KINDS.EVENT));
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
      // Mudança de estado no Adobe com a tarefa de firma ativa: reflete no workflow (final: o pipeline cuida)
      if (!isFinalKind(kind) && !rec.sendonDone) syncInBackground(id);
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
    (ex.: PDF entregue mas disposição falhou; pedido de firma ainda não enviado).
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

  /*
    Reabre needs_attention por "reintentos agotados" cuja última falha é mais antiga que ATTENTION_RETRY_HOURS
    (zera as tentativas, como o reconcile manual). Outros tipos de atenção não reabrem sozinhos.
    O reprocessamento fica por conta do runQueue.
  */
  async function reopenStale() {
    const hours = config.attentionRetryHours;
    if (!hours || hours <= 0) return [];
    const cutoff = new Date(now().getTime() - hours * 60 * 60 * 1000).toISOString();
    const ids = [];
    for (const rec of repo.listAttentionToReopen(cutoff)) {
      repo.upsert(rec.id, state.reopenPatch(rec));
      logger.warn(`[${rec.id}] needs_attention reabierto automáticamente (reintentos agotados hace más de ${hours} h): ${rec.attentionReason}`);
      ids.push(rec.id);
    }
    return ids;
  }

  function stop() {
    for (const id of [...timers.keys()]) clearTimeout_(id);
  }

  return {
    handleEvent, handleStatus, applyAdobeStatus, reconcile, resumeStart, runQueue, reopenStale, adopt, stop
  };
}

module.exports = { createReconciliationService, AdoptError, START_COMMENT };
