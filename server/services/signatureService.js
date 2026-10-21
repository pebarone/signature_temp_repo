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
  onCreated(id): chamado depois de gravar o acordo (em background); executa a etapa start da reconciliação
  (SendOn da tarefa de início localizada pelo nome). Sem ele o registro fica com startSendonDone=false e o
  runQueue/poller assume o envio.
*/
function createSignatureService({ repo, adobe, otcs, logger, config, now = () => new Date(), onCreated = null }) {
  const inflight = new Set(); // chaves nodeId + e-mails em processamento (anti-corrida do /start)

  /*
    START_VERIFY_WORKFLOW: o OTCS é a fonte da verdade. Localiza a tarefa de início (precisa estar "current"), lê o
    formulário e devolve { workflowId, subworkflowId, taskId, nodeId, attachId, docName, emails } do OTCS.
    O payload do navegador só é conferido (divergência => 409, detalhe só no log).
    Se a tarefa de início já avançou mas o acordo deste documento ainda está aberto (recarga da página), devolve
    { existing: <registro> } em vez de 409.
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
    const { where, task } = locate(steps, config.startTaskNames, { subprocessHint: clean(input.subworkflowId) });
    if (where !== 'current') {
      // Recarga da página depois de um envio já processado: a tarefa de início pode já ter avançado (SendOn em background)
      const nodeHint = clean(input.nodeId);
      const open = where !== 'absent' && nodeHint ? repo.findOpenByWorkflow(workflowId, task.subprocessId, nodeHint) : null;
      if (open) return { existing: open };
      logger.warn(`[START] Workflow ${workflowId}: tarefa de início ${where === 'absent' ? 'não encontrada' : `em "${where}"`}`);
      throw new ServiceError(409, { error: 'El flujo no está en el paso de envío a firma.' });
    }

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

    const f = config.startFields;
    const nodeId = fieldValue(form.fields, f.docId);
    const attachId = fieldValue(form.fields, f.attachId);
    const docName = fieldValue(form.fields, f.docName);
    const emails = dedupeEmails(parseEmails(...f.emails.map((label) => fieldValue(form.fields, label))));
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
      emails
    };
  }

  /*
    options.forceVerify: valida contra o OTCS mesmo com START_VERIFY_WORKFLOW=false (autenticação legada que não
    vincula o payload: assinatura v1 e GET /start).
    Devolve { id, sendOn } ou, se já existe acordo não final do mesmo workflow + subprocesso + documento
    (só com validação do OTCS), { id, existing: true, sendOn } sem criar outro.
  */
  async function start(input, { forceVerify = false } = {}) {
    input = input || {};
    let { nodeId, attachId, workflowId, subworkflowId, taskId } = input;
    let { docName } = input;
    let emails;
    if (config.startVerifyWorkflow || forceVerify) {
      const resolved = await resolveFromWorkflow(input);
      const open = resolved.existing || repo.findOpenByWorkflow(resolved.workflowId, resolved.subworkflowId, resolved.nodeId);
      if (open) {
        logger.info(`[START] Workflow ${open.workflowId}/${open.subworkflowId}: ya existe la solicitud de firma ${open.id}`);
        return { id: open.id, existing: true, sendOn: Promise.resolve() };
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
        let sendOn = Promise.resolve();
        if (workflowId && onCreated) {
          sendOn = Promise.resolve().then(() => onCreated(ag.id)).then(() => undefined).catch((e) => {
            logger.error(`Falha na etapa start del acuerdo ${ag.id}: ${describeError(e)}`);
          });
        }

        return { id: ag.id, sendOn };
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

module.exports = { createSignatureService, ServiceError, START_ERROR_MESSAGE };
