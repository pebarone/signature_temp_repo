// services/signatureService.js
// Caso de uso do POST /start: valida o pedido contra o workflow do OTCS, baixa o PDF (e confere que é um PDF), cria o acordo
// no Adobe e registra o mapeamento.
const { describeError } = require('../infra/util');
const { buildExternalId } = require('../domain/externalId');
const { locate, normalizeName } = require('../domain/workflowSteps');
const { isPdf, sniffType, TYPE_LABELS } = require('../domain/documentType');
const { finalNotice } = require('../domain/agreementState');

class ServiceError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const START_ERROR_MESSAGE = 'Error al solicitar la firma.';

// Trava de 15 min: só um acordo ABERTO do mesmo documento + destinatários em OUTRO fluxo (id e workflowId dele no corpo)
const duplicateOpenError = (dup) => new ServiceError(409, {
  error: 'Este documento ya tiene una solicitud de firma abierta para este destinatario en otro flujo.',
  code: 'DUPLICATE_OPEN',
  id: dup.id,
  workflowId: dup.workflowId || null
});
// Requisição igual ainda em processamento neste servidor (o acordo dela ainda não está no repositório)
const startInProgressError = () => new ServiceError(409, {
  error: 'Ya hay un envío en curso para este documento y destinatario; espere unos segundos e intente nuevamente.',
  code: 'START_IN_PROGRESS'
});
const notPdfError = () =>
  new ServiceError(422, { error: 'El documento a firmar no es un PDF válido.', code: 'NOT_PDF' });
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
      logger.error(`Falló la etapa start del acuerdo ${id}: ${describeError(e)}`);
    });
  }

  // Baixa o documento do OTCS e confere que é um PDF (cabeçalho nos primeiros 1024 bytes). Não toca no Adobe: um HTML ou
  // DOCX enviado como application/pdf só falharia depois, com o acordo cancelado por problema de conversão.
  async function fetchPdf(nodeId) {
    const content = Buffer.from(await otcs.downloadNode(nodeId));
    if (!isPdf(content)) {
      logger.warn(
        `[START] El nodo ${nodeId} no es un PDF válido (${content.length} bytes; tipo detectado: ${TYPE_LABELS[sniffType(content)]}); `
        + 'no se envía a Adobe Sign'
      );
      throw notPdfError();
    }
    return content;
  }

  // Acordo DESTE ciclo do fluxo, com a tarefa de início current: o mais recente de (workflow, subprocesso, nó) que ainda não foi
  // concluído (sendonDone=false): aberto, ou final com o resultado ainda não aplicado ao fluxo (o caso do incidente de QA).
  // Um acordo CONCLUÍDO (sendonDone=true, inclusive completedExternally) já teve o resultado aplicado: se a tarefa de início
  // voltou a ser current, o mapa voltou ao envio e é um ciclo NOVO; o acordo antigo é ignorado.
  function currentCycleAgreement(workflowId, subworkflowId, nodeId) {
    const latest = repo.findLatestByWorkflow(workflowId, subworkflowId, nodeId);
    return latest && !latest.sendonDone ? latest : null;
  }

  // Trava anti-duplicidade: acordo ABERTO do mesmo documento + destinatários criado na janela de 15 min. Com `flow`, só vale o
  // de OUTRO fluxo; sem `flow` (caminho legado, sem validação do workflow), qualquer acordo aberto.
  function assertNoOpenElsewhere(nodeId, emails, flow) {
    const dup = repo.findOpenRecent(nodeId, emails, DUPLICATE_WINDOW_MS, flow);
    if (!dup) return;
    logger.warn(
      `[START] El documento ${nodeId} ya tiene la solicitud de firma abierta ${dup.id} (workflow ${dup.workflowId || '-'}/${dup.subworkflowId || '-'}) `
      + `para los mismos destinatarios${flow ? ` en otro flujo (este: ${flow.workflowId}/${flow.subworkflowId})` : ''}`
    );
    throw duplicateOpenError(dup);
  }

  /*
    Sub-workflow com a tarefa ainda no usuário humano: o servidor não consegue ler o formulário (só quem tem a tarefa o lê) e
    pede a reatribuição ANTES de existir acordo. Antes de pedir, valida o que dá com as DICAS do corpo (nodeId numérico e ao menos
    um e-mail; nunca usadas para criar acordo): o documento é um PDF e não há acordo aberto dele em outro fluxo. Se falhar, o
    erro sai aqui e a tarefa NÃO é reatribuída. Depois da reatribuição, o caminho normal relê o formulário e valida tudo de novo.
    Sem dicas (ou com o acordo deste ciclo do fluxo já existente, não concluído) não há o que validar: segue para o
    REASSIGN_REQUIRED. Um acordo concluído é de um ciclo anterior: a pré-checagem roda normalmente.
  */
  async function precheckBeforeReassign(input, handoff) {
    const nodeHint = clean(input.nodeId);
    const emailHints = dedupeEmails(parseEmails(input.userEmail1, input.userEmail2));
    if (!/^\d+$/.test(nodeHint) || !emailHints.length) {
      logger.info(`[START] Workflow ${handoff.workflowId}/${handoff.subworkflowId}: el pedido no trae nodeId/correos; se omite la prevalidación antes de reasignar`);
      return;
    }
    if (currentCycleAgreement(handoff.workflowId, handoff.subworkflowId, nodeHint)) return;
    assertNoOpenElsewhere(nodeHint, emailHints, { workflowId: handoff.workflowId, subworkflowId: handoff.subworkflowId });
    try {
      await fetchPdf(nodeHint);
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      logger.error(`[START ERROR] ${describeError(e)}`);
      throw new ServiceError(500, { error: START_ERROR_MESSAGE });
    }
  }

  /*
    START_VERIFY_WORKFLOW: o OTCS é a fonte da verdade. Localiza a tarefa de início (precisa estar "current") e lê
    DocID/AttachID/nome/e-mails do OTCS; devolve { workflowId, subworkflowId, taskId, nodeId, attachId, docName, emails, handoff }.
    Origem dos atributos:
      - tarefa atribuída ao usuário de integração: formulário da tarefa (como sempre);
      - tarefa ainda no usuário humano + fluxo puro (subprocesso == processo): GET status/info do workflow;
      - tarefa ainda no usuário humano + sub-workflow: 409 REASSIGN_REQUIRED (status/info só traz os atributos do pai), depois
        da pré-checagem com as dicas do corpo (PDF e trava; ver precheckBeforeReassign).
    handoff = { workflowId, subworkflowId, taskId, integrationUserId, assigned } (números): o que a página deve
    reatribuir ao usuário de integração depois do envio (só quando assigned=false).
    O payload do navegador só é conferido (divergência => 409, detalhe só no log).
    Se a tarefa de início já avançou mas este fluxo já tem acordo do documento (recarga da página; aberto ou já final), devolve
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
      logger.error(`[START] OTCS getProcessSteps(${workflowId}) falló: ${describeError(e)}`);
      throw otcsUnavailable();
    }
    // Usa a mesma normalização do HMAC: espaços não podem mudar o subprocesso escolhido.
    // latest: com a tarefa em mais de um subprocesso sem dica clara, o /start cria o acordo a partir do mais recente
    const { where, task } = locate(steps, config.startTaskNames, {
      subprocessHint: clean(input.subworkflowId), processId: workflowId, latest: true
    });
    if (where !== 'current') {
      // Recarga da página depois de um envio já processado: a tarefa de início pode já ter avançado (SendOn em background).
      // Aqui a tarefa de início NÃO está current: o acordo mais recente do fluxo vale em qualquer estado, inclusive concluído
      // (já ficou final, ex.: conversão falhou, e a página o mostra)
      const nodeHint = clean(input.nodeId);
      const known = where !== 'absent' && nodeHint ? repo.findLatestByWorkflow(workflowId, task.subprocessId, nodeHint) : null;
      if (known) return { existing: known };
      logger.warn(`[START] Workflow ${workflowId}: tarea de inicio ${where === 'absent' ? 'no encontrada' : `en "${where}"`}`);
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
        logger.error(`[START] OTCS getCurrentUser falló: ${describeError(e)}`);
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
          logger.warn(`[START] Workflow ${workflowId}: formulario de la tarea ${task.taskId} sin acceso (HTTP ${status})`);
          throw new ServiceError(409, { error: 'La tarea no está asignada al usuario de integración.' });
        }
        if (status === 404) throw flowNotFound();
        logger.error(`[START] OTCS getTaskForm(${task.processId}/${task.subprocessId}/${task.taskId}) falló: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      fields = form.fields;
    } else if (standalone) {
      let attrs;
      try {
        attrs = await otcs.getWorkflowAttributes(task.processId);
      } catch (e) {
        if (httpStatus(e) === 404) throw flowNotFound();
        logger.error(`[START] OTCS getWorkflowAttributes(${task.processId}) falló: ${describeError(e)}`);
        throw otcsUnavailable();
      }
      fields = Object.fromEntries(Object.entries(attrs || {}).map(([label, value]) => [label, { value }]));
    } else {
      // Sub-workflow: status/info só devolve os atributos do pai e o formulário exige a tarefa no usuário de integração.
      // A regra é reatribuir só com acordo gerado: aqui ainda não há, então valida antes o que as dicas do corpo permitem
      await precheckBeforeReassign(input, handoff);
      logger.info(`[START] Workflow ${workflowId}/${task.subprocessId}: tarea ${task.taskId} aún en el usuario; la página debe reasignarla antes del envío`);
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
      logger.warn(`[START] Workflow ${workflowId}: los datos enviados no coinciden con el flujo (${diffs.join('; ')})`);
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

  // Resposta para o acordo que este fluxo já tem. Aberto: como sempre. Já final (ou concluído): leva também `final`
  // ({ kind, state, message }), para a página explicar o resultado em vez do sucesso do envio. Em ambos, o acordo existe,
  // então a página pode reatribuir (handoff) e o pipeline faz o SendOn pendente da tarefa de início e a disposição.
  function existingResult(rec, handoff) {
    const final = finalNotice(rec);
    logger.info(final
      ? `[START] Workflow ${rec.workflowId}/${rec.subworkflowId}: la solicitud de firma ${rec.id} ya terminó (${final.kind}, estado ${final.state}); no se crea otra`
      : `[START] Workflow ${rec.workflowId}/${rec.subworkflowId}: ya existe la solicitud de firma ${rec.id}`);
    // Etapa start ainda pendente (ex.: aguardando a reatribuição da página): retoma agora, sem esperar o backoff.
    // Com resultado final, essa retomada reconcilia: SendOn da tarefa de início e depois a disposição.
    const pending = !!rec.workflowId && !rec.startSendonDone && !rec.sendonDone;
    return {
      id: rec.id,
      existing: true,
      sendOn: pending ? kickStart(rec.id, { existing: true }) : Promise.resolve(),
      handoff,
      ...(final ? { final } : {})
    };
  }

  /*
    options.forceVerify: valida contra o OTCS mesmo com START_VERIFY_WORKFLOW=false (autenticação legada que não
    vincula o payload: assinatura v1 e GET /start).
    Devolve { id, sendOn, handoff? } ou, se este fluxo já tem acordo do documento (mesmo workflow + subprocesso + documento,
    só com validação do OTCS), { id, existing: true, sendOn, handoff?, final? } sem criar outro: com a tarefa de início ainda
    current, o acordo mais recente deste ciclo (aberto, ou final com sendonDone=false); com ela já avançada, o mais recente em
    qualquer estado. Já final ou concluído leva `final` ({ kind, state, message }). Com a tarefa current e o acordo mais recente
    CONCLUÍDO (sendonDone=true), o fluxo voltou ao envio: ciclo novo, o antigo é ignorado e o envio segue normal (trava e PDF
    valem). `handoff` só vem com a validação do OTCS
    e com a tarefa de início ainda ativa. No caso existing e com o SendOn ainda pendente, a etapa start é retomada
    (onCreated(id, { existing: true })): depois do REASSIGN da página, o segundo /start dispara o SendOn já.
    Ordem: o acordo existe antes da reatribuição e do SendOn (a página só reatribui com acordo gerado).
    NOT_PDF (422): o documento baixado não é um PDF; nada é criado no Adobe. DUPLICATE_OPEN (409): o mesmo documento e
    destinatários já têm um acordo ABERTO, criado há menos de 15 min, em OUTRO fluxo (final ou concluído nunca bloqueia).
  */
  async function start(input, { forceVerify = false } = {}) {
    input = input || {};
    let { nodeId, attachId, workflowId, subworkflowId, taskId } = input;
    let { docName } = input;
    let emails;
    let handoff;
    const verified = config.startVerifyWorkflow || forceVerify;
    if (verified) {
      const resolved = await resolveFromWorkflow(input);
      handoff = resolved.handoff;
      // O mesmo fluxo vê o acordo do ciclo dele, mesmo se já for final mas ainda não concluído (a trava de 15 min abaixo só olha
      // OUTROS fluxos). resolved.existing: a tarefa de início já avançou, o mais recente em qualquer estado
      const known = resolved.existing || currentCycleAgreement(resolved.workflowId, resolved.subworkflowId, resolved.nodeId);
      if (known) return existingResult(known, handoff);
      ({ workflowId, subworkflowId, taskId, nodeId, attachId, docName, emails } = resolved);
    } else {
      emails = parseEmails(input.userEmail1, input.userEmail2);
      if (!emails.length || !nodeId) throw new ServiceError(400, { error: 'Node ID and Email are mandatory.' });
      if (!attachId || isNaN(+attachId)) throw new ServiceError(400, { error: 'attachId is mandatory.' });
    }

    // Evita reenvio duplicado: acordo ABERTO do mesmo documento + destinatários dentro da janela. Com a validação do
    // workflow só vale o de OUTRO fluxo (o deste já voltou como existing); sem ela (sem identidade de fluxo), qualquer aberto.
    assertNoOpenElsewhere(nodeId, emails, verified ? { workflowId, subworkflowId } : null);

    // Requisições concorrentes iguais (ainda sem registro no repo) caem aqui; findOpenRecent não as enxerga
    const keys = [`${nodeId}|${[...emails].sort().join('|')}`];
    // O formulário pode mudar entre duas consultas concorrentes: a identidade do workflow também precisa de trava.
    if (verified) keys.push(`workflow|${workflowId}|${subworkflowId}|${nodeId}`);
    if (keys.some((key) => inflight.has(key))) throw startInProgressError();
    for (const key of keys) inflight.add(key);
    try {
      try {
        await adobe.checkAuth();
      } catch {
        throw new ServiceError(401, { error: 'LOGIN_REQUIRED' });
      }

      try {
        // Antes de qualquer coisa no Adobe: o conteúdo precisa ser um PDF (senão 422 NOT_PDF)
        const content = await fetchPdf(nodeId);
        const fileName = String(docName || '').trim() || `node_${nodeId}.pdf`;

        const transientDocumentId = await adobe.createTransientDocument(content, fileName);
        const subId = String(subworkflowId || workflowId || '');
        const ag = await adobe.createAgreement({
          name: `Documento ${fileName}`,
          transientDocumentId,
          emails,
          externalId: buildExternalId({ workflowId, subworkflowId: subId, nodeId, attachId }, config.signatureSecret)
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
