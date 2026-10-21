// services/signatureService.js
// Caso de uso do POST /start: baixa o PDF do OTCS, cria o acordo no Adobe e registra o mapeamento.
const { describeError } = require('../infra/util');

class ServiceError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

function createSignatureService({ repo, adobe, otcs, logger, config, now = () => new Date() }) {
  async function start(input) {
    const { userEmail1, userEmail2, nodeId, attachId, workflowId, subworkflowId, taskId } = input;
    const emails = [userEmail1, userEmail2]
      .filter(Boolean).flatMap((e) => String(e).split(/[;,]+/)).map((e) => e.trim()).filter((e) => e.includes('@'));
    if (!emails.length || !nodeId) throw new ServiceError(400, { error: 'Node ID and Email are mandatory.' });
    if (!attachId || isNaN(+attachId)) throw new ServiceError(400, { error: 'attachId is mandatory.' });

    // Evita reenvio duplicado (mesmo documento + mesmos destinatários) dentro da janela
    if (repo.findRecent(nodeId, emails, DUPLICATE_WINDOW_MS)) {
      throw new ServiceError(409, { error: 'El documento ya he sido enviado recientemente a este destinatario.' });
    }

    try {
      await adobe.checkAuth();
    } catch {
      throw new ServiceError(401, { error: 'LOGIN_REQUIRED' });
    }

    try {
      const original = await otcs.downloadNode(nodeId);
      const fileName = String(input.docName || '').trim() || `node_${nodeId}.pdf`;

      const transientDocumentId = await adobe.createTransientDocument(Buffer.from(original), fileName);
      const ag = await adobe.createAgreement({ name: `Documento ${fileName}`, transientDocumentId, emails });

      // Mapeamento persistido ANTES do SendOn: um webhook imediato já encontra o acordo
      repo.upsert(ag.id, {
        nodeId: String(nodeId),
        attachId: String(attachId),
        fileName,
        workflowId: String(workflowId || ''),
        subworkflowId: String(subworkflowId || workflowId || ''),
        taskId: taskId ? Number(taskId) : null,
        emails,
        state: 'pending',
        createdAt: now().toISOString()
      });
      logger.info(`Signature requested: ${ag.id}`);

      // SendOn da tarefa de envio em background (não bloqueia o cliente). `sendOn` nunca rejeita.
      let sendOn = Promise.resolve();
      if (workflowId) {
        sendOn = otcs.sendOnWorkflow({
          workflowId,
          subworkflowId: subworkflowId || workflowId,
          taskId: taskId || 2,
          comment: 'Documento enviado para assinatura – etapa automatizada'
        }).then(() => {
          logger.info(`SendOn automático realizado para workflow ${workflowId}`);
        }).catch((e) => {
          const msg = describeError(e);
          logger.error(`Falha no SendOn automático: ${msg}`);
          try { repo.upsert(ag.id, { startSendOnError: msg }); } catch { /* ignore */ }
        });
      }

      return { id: ag.id, sendOn };
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      const raw = e.response?.data;
      const text = Buffer.isBuffer(raw) ? raw.toString() : JSON.stringify(raw || e.message);
      logger.error(`[START ERROR] ${text}`);
      throw new ServiceError(500, { error: Buffer.isBuffer(raw) ? raw.toString() : (raw || e.message) });
    }
  }

  return { start };
}

module.exports = { createSignatureService, ServiceError };
