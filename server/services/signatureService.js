// services/signatureService.js
// Caso de uso do POST /start: valida o pedido contra o workflow do OTCS, baixa o PDF, cria o acordo no Adobe
// e registra o mapeamento.
const { describeError } = require('../infra/util');
const { buildExternalId } = require('../domain/externalId');
const { locate, normalizeName } = require('../domain/workflowSteps');

class ServiceError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const START_ERROR_MESSAGE = 'Error al solicitar la firma.';

const duplicateError = () =>
  new ServiceError(409, { error: 'El documento ya he sido enviado recientemente a este destinatario.' });
const flowNotFound = () => new ServiceError(409, { error: 'Flujo no encontrado.' });
const otcsUnavailable = () =>
  new ServiceError(503, { error: 'Content Server no disponible; intente nuevamente.' });

// E-mails separados por ; ou , (itens sem "@" descartados)
const parseEmails = (...values) =>
  values.filter(Boolean).flatMap((e) => String(e).split(/[;,]+/)).map((e) => e.trim()).filter((e) => e.includes('@'));
const dedupeEmails = (emails) => {
  const seen = new Set();
  return emails.filter((e) => {
    const k = e.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const emailKey = (emails) => [...new Set(emails.map((e) => e.toLowerCase()))].sort().join(',');
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const httpStatus = (e) => e?.response?.status;

// Valor de um atributo do formulário pelo rótulo (exato; senão ignorando acentos/caixa)
function fieldValue(fields, label) {
  const entry = fields?.[label]
    ?? Object.entries(fields || {}).find(([k]) => normalizeName(k) === normalizeName(label))?.[1];
  const v = entry && typeof entry === 'object' ? entry.value : undefined;
  return v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim();
}

/*
  onCreated(id, ctx): chamado depois de gravar o acordo (em background); executa a etapa start da reconciliação
  (SendOn da tarefa de início localizada pelo nome). Sem ele o registro fica com startSendonDone=false e o
  runQueue/poller assume o envio. ctx.existing=true: acordo já existente cujo start ainda estava pendente (o /start
  foi repetido, p.ex. depois de a página reatribuir a tarefa); a reconciliação é serializada por acordo.
*/
function createSignatureService({ repo, adobe, otcs, logger, config, now = () => new Date(), onCreated = null }) {
  const inflight = new Set(); // chaves nodeId + e-mails em processamento (anti-corrida do /start)

  // Dispara a etapa start da reconciliação em background. A promise devolvida nunca rejeita.
  function kickStart(id, ctx) {
    if (!onCreated) return Promise.resolve();
    return Promise.resolve().then(() => onCreated(id, ctx)).then(() => undefined).catch((e) => {
      logger.error(`Falha na etapa start del acuerdo ${id}: ${describeError(e)}`);
    });
  }

  /*
    START_VERIFY_WORKFLOW: o OTCS é a fonte da verdade. Localiza a tarefa de início (precisa estar "current") e lê
    DocID/AttachID/nome/e-mails do OTCS; devolve { workflowId, subworkflowId, taskId, nodeId, attachId, docName, emails, handoff }.
    Origem dos atributos:
      - tarefa atribuída ao usuário de integração: formulário da tarefa (como sempre);
      - tarefa ainda no usuário humano + fluxo puro (subprocesso == processo): GET status/info do workflow;
      - tarefa ainda no usuário humano + sub-workflow: 409 REASSIGN_REQUIRED (status/info só traz os atributos do pai).
    handoff = { workflowId, subworkflowId, taskId, integrationUserId, assigned } (números): o que a página deve
    reatribuir ao usuário de integração depois do envio (só quando assigned=false).
    O payload do navegador só é conferido (divergência => 409, detalhe só no log).
    Se a tarefa de início já avançou mas o acordo deste documento ainda está aberto (recarga da página), devolve
    { existing: <registro> } (sem handoff: não há mais nada a reatribuir) em vez de 409.
  */
  async function resolveFromWorkflow(input) {
    const workflowId = clean(input.workflowId);
    if (!/^\d+$/.test(workflowId)) throw new ServiceError(400, { error: 'workflowId is mandatory.' });

    let steps;
    try {
      steps = await otcs.getProcessSteps(workflowId);
    } catch (e) {
      if (httpStatus(e) === 404) throw flowNotFound();
      logger.error(`[START] OTCS getProcessSteps(${workflowId}) falhou: ${describeError(e)}`);
      throw otcsUnavailable();
    }
    // Usa a mesma normalização do HMAC: espaços não podem mudar o subprocesso escolhido.
    // latest: com a tarefa em mais de um subprocesso sem dica clara, o /start cria o acordo a partir do mais recente
    const { where, task } = locate(steps, config.startTaskNames, {
      subprocessHint: clean(input.subworkflowId), processId: workflowId, latest: true
    });
    if (where !== 'current') {
      // Recarga da página depois de um envio já processado: a tarefa de início pode já ter avançado (SendOn em background)
      const nodeHint = clean(input.nodeId);
      const open = where !== 'absent' && nodeHint ? repo.findOpenByWorkflow(workflowId, task.subprocessId, nodeHint) : null;
      if (open) return { existing: open };
      logger.warn(`[START] Workflow ${workflowId}: tarefa de início ${where === 'absent' ? 'não encontrada' : `em "${where}"`}`);
      throw new ServiceError(409, { error: 'El flujo no está en el paso de envío a firma.' });
    }

    // Quem está com a tarefa: o usuário de integração lê o formulário; com a tarefa ainda no usuário humano (o WebReport
    // reatribui só DEPOIS do /start) os atributos vêm de status/info, válido apenas para fluxo puro.
    // assigneeIds null = o OTCS não informou os responsáveis: caminho antigo (formulário), sem consultar o usuário
    // de integração (integrationUserId null no handoff)
    let integrationUserId = null;
    let assigned = true;
    if (Array.isArray(task.assigneeIds)) {
      try {
        integrationUserId = Number((await otcs.getCurrentUser())?.id);
        if (!Number.isFinite(integrationUserId)) throw new Error('usuario de integración desconocido');
      } catch (e) {
        logger.error(`[START] OTCS getCurrentUser falhou: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      assigned = task.assigneeIds.includes(integrationUserId);
    }
    const standalone = Number(task.subprocessId) === Number(task.processId);
    const handoff = {
      workflowId: Number(task.processId),
      subworkflowId: Number(task.subprocessId),
      taskId: Number(task.taskId),
      integrationUserId,
      assigned
    };

    let fields;
    if (assigned) {
      let form;
      try {
        form = await otcs.getTaskForm(task.processId, task.subprocessId, task.taskId);
      } catch (e) {
        const status = httpStatus(e);
        if (status === 401 || status === 403) {
          logger.warn(`[START] Workflow ${workflowId}: formulário da tarefa ${task.taskId} sem acesso (HTTP ${status})`);
          throw new ServiceError(409, { error: 'La tarea no está asignada al usuario de integración.' });
        }
        if (status === 404) throw flowNotFound();
        logger.error(`[START] OTCS getTaskForm(${task.processId}/${task.subprocessId}/${task.taskId}) falhou: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      fields = form.fields;
    } else if (standalone) {
      let attrs;
      try {
        attrs = await otcs.getWorkflowAttributes(task.processId);
      } catch (e) {
        if (httpStatus(e) === 404) throw flowNotFound();
        logger.error(`[START] OTCS getWorkflowAttributes(${task.processId}) falhou: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      fields = Object.fromEntries(Object.entries(attrs || {}).map(([label, value]) => [label, { value }]));
    } else {
      // Sub-workflow: status/info só devolve os atributos do pai e o formulário exige a tarefa no usuário de integração
      logger.info(`[START] Workflow ${workflowId}/${task.subprocessId}: tarefa ${task.taskId} ainda no usuário; a página deve reatribuí-la antes do envio`);
      throw new ServiceError(409, {
        error: 'La tarea debe asignarse al usuario de integración antes del envío.',
        code: 'REASSIGN_REQUIRED',
        handoff
      });
    }

    const f = config.startFields;
    const nodeId = fieldValue(fields, f.docId);
    const attachId = fieldValue(fields, f.attachId);
    const docName = fieldValue(fields, f.docName);
    const emails = dedupeEmails(parseEmails(...f.emails.map((label) => fieldValue(fields, label))));
    if (!/^\d+$/.test(nodeId)) {
      throw new ServiceError(422, { error: 'El flujo no tiene el documento a firmar (DocID).' });
    }
    if (!emails.length) throw new ServiceError(422, { error: 'El flujo no tiene correos de firmantes.' });
    if (!/^\d+$/.test(attachId)) {
      throw new ServiceError(422, { error: 'El flujo no tiene la carpeta de destino (AttachID).' });
    }

    // Conferência do payload (só o que veio preenchido): divergência => 409 genérico
    const diffs = [];
    if (clean(input.nodeId) && clean(input.nodeId) !== nodeId) {
      diffs.push(`nodeId payload=${clean(input.nodeId)} otcs=${nodeId}`);
    }
    if (clean(input.attachId) && clean(input.attachId) !== attachId) {
      diffs.push(`attachId payload=${clean(input.attachId)} otcs=${attachId}`);
    }
    const payloadEmails = parseEmails(input.userEmail1, input.userEmail2);
    if (payloadEmails.length && emailKey(payloadEmails) !== emailKey(emails)) {
      diffs.push(`emails payload=[${emailKey(payloadEmails)}] otcs=[${emailKey(emails)}]`);
    }
    if (diffs.length) {
      logger.warn(`[START] Workflow ${workflowId}: dados enviados não coincidem com o fluxo (${diffs.join('; ')})`);
      throw new ServiceError(409, { error: 'Los datos enviados no coinciden con el flujo.' });
    }

    return {
      workflowId,
      subworkflowId: String(task.subprocessId),
      taskId: task.taskId,
      nodeId,
      attachId,
      docName: docName || clean(input.docName),
      emails,
      handoff
    };
  }

  /*
    options.forceVerify: valida contra o OTCS mesmo com START_VERIFY_WORKFLOW=false (autenticação legada que não
    vincula o payload: assinatura v1 e GET /start).
    Devolve { id, sendOn, handoff? } ou, se já existe acordo não final do mesmo workflow + subprocesso + documento
    (só com validação do OTCS), { id, existing: true, sendOn, handoff? } sem criar outro. `handoff` só vem com a
    validação do OTCS e com a tarefa de início ainda ativa. No caso existing e com o SendOn ainda pendente, a etapa start
    é retomada (onCreated(id, { existing: true })): depois do REASSIGN da página, o segundo /start dispara o SendOn já.
  */
  async function start(input, { forceVerify = false } = {}) {
    input = input || {};
    let { nodeId, attachId, workflowId, subworkflowId, taskId } = input;
    let { docName } = input;
    let emails;
    let handoff;
    if (config.startVerifyWorkflow || forceVerify) {
      const resolved = await resolveFromWorkflow(input);
      handoff = resolved.handoff;
      const open = resolved.existing || repo.findOpenByWorkflow(resolved.workflowId, resolved.subworkflowId, resolved.nodeId);
      if (open) {
        logger.info(`[START] Workflow ${open.workflowId}/${open.subworkflowId}: ya existe la solicitud de firma ${open.id}`);
        // Etapa start ainda pendente (ex.: aguardando a reatribuição da página): retoma agora, sem esperar o backoff
        const pending = !!open.workflowId && !open.startSendonDone && !open.sendonDone;
        return { id: open.id, existing: true, sendOn: pending ? kickStart(open.id, { existing: true }) : Promise.resolve(), handoff };
      }
      ({ workflowId, subworkflowId, taskId, nodeId, attachId, docName, emails } = resolved);
    } else {
      emails = parseEmails(input.userEmail1, input.userEmail2);
      if (!emails.length || !nodeId) throw new ServiceError(400, { error: 'Node ID and Email are mandatory.' });
      if (!attachId || isNaN(+attachId)) throw new ServiceError(400, { error: 'attachId is mandatory.' });
    }

    // Evita reenvio duplicado (mesmo documento + mesmos destinatários) dentro da janela
    if (repo.findRecent(nodeId, emails, DUPLICATE_WINDOW_MS)) throw duplicateError();

    // Requisições concorrentes iguais (ainda sem registro no repo) caem aqui; findRecent não as enxerga
    const keys = [`${nodeId}|${[...emails].sort().join('|')}`];
    // O formulário pode mudar entre duas consultas concorrentes: a identidade do workflow também precisa de trava.
    if (config.startVerifyWorkflow || forceVerify) keys.push(`workflow|${workflowId}|${subworkflowId}|${nodeId}`);
    if (keys.some((key) => inflight.has(key))) throw duplicateError();
    for (const key of keys) inflight.add(key);
    try {
      try {
        await adobe.checkAuth();
      } catch {
        throw new ServiceError(401, { error: 'LOGIN_REQUIRED' });
      }

      try {
        const original = await otcs.downloadNode(nodeId);
        const fileName = String(docName || '').trim() || `node_${nodeId}.pdf`;

        const transientDocumentId = await adobe.createTransientDocument(Buffer.from(original), fileName);
        const subId = String(subworkflowId || workflowId || '');
        const ag = await adobe.createAgreement({
          name: `Documento ${fileName}`,
          transientDocumentId,
          emails,
          externalId: buildExternalId({ workflowId, subworkflowId: subId, nodeId, attachId })
        });

        // Mapeamento persistido ANTES do SendOn: um webhook imediato já encontra o acordo
        repo.upsert(ag.id, {
          nodeId: String(nodeId),
          attachId: String(attachId),
          fileName,
          workflowId: String(workflowId || ''),
          subworkflowId: subId,
          taskId: taskId ? Number(taskId) : null,
          emails,
          state: 'pending',
          // O SendOn da tarefa de início é uma etapa persistida da reconciliação (com retry), não mais um fire-and-forget
          startSendonDone: !workflowId,
          createdAt: now().toISOString()
        });
        logger.info(`Signature requested: ${ag.id}`);

        // Etapa start em background (não bloqueia o cliente). `sendOn` nunca rejeita.
        const sendOn = workflowId ? kickStart(ag.id) : Promise.resolve();

        return { id: ag.id, sendOn, handoff };
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        // Detalhes (corpo do Adobe/OTCS) só no log; o navegador recebe uma mensagem genérica
        logger.error(`[START ERROR] ${describeError(e)}`);
        throw new ServiceError(500, { error: START_ERROR_MESSAGE });
      }
    } finally {
      for (const key of keys) inflight.delete(key);
    }
  }

  return { start };
}

module.exports = { createSignatureService, ServiceError, START_ERROR_MESSAGE, fieldValue };
