// http/routes/cancel.js
// POST /cancel: chamado pelo WebReport do workflow de cancelamento (ticket 2026060410003715), no mesmo modelo de segurança
// do /start v2: POST /auth (Basic Auth) devolve { v, timestamp, nonce, signature } vinculado a { workflowId, subworkflowId }
// (o workflow de cancelamento) e o /cancel confere o HMAC com nonce de uso único. Só é montado com CANCEL_ENABLED=true
// (senão cai no 404 padrão do app). O fluxo a cancelar NÃO vem do corpo: o serviço o lê do formulário da tarefa no OTCS.
const express = require('express');
const { ServiceError } = require('../../services/signatureService');
const { CANCEL_ERROR_MESSAGE } = require('../../services/cancellationService');
const { oneLine, describeError } = require('../../infra/util');

function cancelRoutes({ logger, cancellationService, verifySignature }) {
  const router = express.Router();

  router.post('/cancel', (req, res, next) => {
    const { workflowId, subworkflowId } = req.body || {};
    logger.info(
      `Cancel request initiated\n` +
      `  → Cancel workflow: ${oneLine(workflowId)}\n` +
      `  → Cancel subworkflow: ${oneLine(subworkflowId)}`
    );
    next();
  }, verifySignature, async (req, res) => {
    // A assinatura v1 (só timestamp, aceita na janela de migração do /start) não vincula o corpo: nunca vale aqui
    if (req.legacyAuth) return res.status(403).json({ error: 'Unsupported signature version.' });
    try {
      const out = await cancellationService.cancelFromTask(req.body || {});
      res.json({
        message: `${out.alreadyCancelled ? 'Agreement already cancelled' : 'Agreement cancelled'}. ID: ${out.id}`,
        id: out.id,
        alreadyCancelled: out.alreadyCancelled
      });
    } catch (e) {
      // Corpos de ServiceError são fixos e genéricos; os detalhes do Adobe/OTCS ficam só no log
      if (e instanceof ServiceError) return res.status(e.status).json(e.body);
      logger.error(`[CANCEL ERROR] ${describeError(e)}`);
      res.status(500).json({ error: CANCEL_ERROR_MESSAGE });
    }
  });

  return router;
}

module.exports = { cancelRoutes };
