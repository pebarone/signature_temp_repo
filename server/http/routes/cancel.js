// http/routes/cancel.js
// POST /cancel e POST /cancel/preview: chamados pelo WebReport do workflow de cancelamento (ticket 2026060410003715), no
// mesmo modelo de segurança do /start v2: POST /auth (Basic Auth) devolve { v, timestamp, nonce, signature } vinculado a
// { workflowId, subworkflowId } (o workflow de cancelamento) e a rota confere o HMAC com nonce de uso único (cada chamada
// consome um nonce: a página pede um /auth novo para cada uma). Só são montados com CANCEL_ENABLED=true (senão caem no 404
// padrão do app, preflight CORS inclusive). Os fluxos a cancelar NÃO vêm do corpo: o serviço os lê do formulário da tarefa
// no OTCS.
//   /cancel/preview: só consulta (nada é cancelado nem gravado) e devolve o estado de cada alvo.
//   /cancel: cancela o lote, grava o resultado no formulário e faz o SendOn; o corpo é o do serviço (complete/sentOn/items).
// MODO DIRETO (WebReport executado sozinho, sem workflow): /cancel/direct/auth (Basic de CANCEL_DIRECT_AUTH_* ou, sem elas,
// o do /auth) emite a assinatura; /cancel/direct/preview e /cancel/direct a verificam com a chave DERIVADA e recebem
// { targetWorkflowIds, targetSubworkflowId?, requestedBy? } no corpo. Só são montados com CANCEL_DIRECT_ENABLED=true (além de
// CANCEL_ENABLED e de uma credencial Basic); senão caem no 404 padrão. Os alvos ficam vinculados ao HMAC (o /cancel/direct/auth os assina, ver middleware/hmac.js);
// cancelam no Adobe e SEMPRE param o fluxo original; sem tarefa, formulário nem SendOn.
const express = require('express');
const { signStart, newNonce } = require('../middleware/hmac');
const { ServiceError } = require('../../services/signatureService');
const { CANCEL_ERROR_MESSAGE } = require('../../services/cancellationService');
const { oneLine, describeError } = require('../../infra/util');

function cancelRoutes({
  logger, cancellationService, verifySignature, directEnabled = false, directBasicAuth, verifyDirectSignature, directKey, now = () => Date.now()
}) {
  const router = express.Router();

  // Mesmo pipeline para as duas rotas: log, HMAC v2 + nonce, recusa de v1 e tradução dos erros do serviço
  const route = (path, label, run, { direct = false, verify = verifySignature } = {}) => {
    router.post(path, (req, res, next) => {
      const { workflowId, subworkflowId, targetWorkflowIds, targetSubworkflowId } = req.body || {};
      logger.info(direct
        ? `${label} request initiated\n` +
          `  → Cancel targets: ${oneLine(Array.isArray(targetWorkflowIds) ? targetWorkflowIds.join(',') : targetWorkflowIds)}\n` +
          `  → Cancel subworkflow: ${oneLine(targetSubworkflowId)}`
        : `${label} request initiated\n` +
          `  → Cancel workflow: ${oneLine(workflowId)}\n` +
          `  → Cancel subworkflow: ${oneLine(subworkflowId)}`);
      next();
    }, verify, async (req, res) => {
      // A assinatura v1 (só timestamp, aceita na janela de migração do /start) não vincula o corpo: nunca vale aqui
      if (req.legacyAuth) return res.status(403).json({ error: 'Unsupported signature version.' });
      try {
        res.json(await run(req.body || {}));
      } catch (e) {
        // Corpos de ServiceError são fixos e genéricos; os detalhes do Adobe/OTCS ficam só no log
        if (e instanceof ServiceError) return res.status(e.status).json(e.body);
        logger.error(`[${label.toUpperCase()} ERROR] ${describeError(e)}`);
        res.status(500).json({ error: CANCEL_ERROR_MESSAGE });
      }
    });
  };

  route('/cancel', 'Cancel', (body) => cancellationService.cancelFromTask(body));
  route('/cancel/preview', 'Cancel preview', (body) => cancellationService.previewFromTask(body));
  if (directEnabled) {
    // /auth do modo direto: Basic do modo direto (CANCEL_DIRECT_AUTH_* ou, sem elas, o do /auth) e assinatura com a chave derivada (escopo 'cancel-direct'):
    // mesmo formato { v, timestamp, nonce, signature } do /auth genérico, mas só vale em /cancel/direct*
    router.post('/cancel/direct/auth', directBasicAuth, (req, res) => {
      if (!directKey) return res.status(500).json({ error: 'Server misconfigured.' });
      const fields = req.body && typeof req.body === 'object' ? req.body : {};
      const timestamp = now().toString();
      const nonce = newNonce();
      res.json({ v: 2, timestamp, nonce, signature: signStart(directKey, { ...fields, timestamp, nonce }) });
    });
    route('/cancel/direct', 'Cancel direct', (body) => cancellationService.cancelDirect(body), { direct: true, verify: verifyDirectSignature });
    route('/cancel/direct/preview', 'Cancel direct preview', (body) => cancellationService.previewDirect(body), { direct: true, verify: verifyDirectSignature });
  }

  return router;
}

module.exports = { cancelRoutes };
