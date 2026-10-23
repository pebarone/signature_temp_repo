// http/routes/cancel.js
// POST /cancel e POST /cancel/preview: chamados pelo WebReport do workflow de cancelamento (ticket 2026060410003715), no
// mesmo modelo de segurança do /start v2: POST /auth (Basic Auth) devolve { v, timestamp, nonce, signature } vinculado a
// { workflowId, subworkflowId } (o workflow de cancelamento) e a rota confere o HMAC com nonce de uso único (cada chamada
// consome um nonce: a página pede um /auth novo para cada uma). Só são montados com CANCEL_ENABLED=true (senão caem no 404
// padrão do app, preflight CORS inclusive). Os fluxos a cancelar NÃO vêm do corpo: o serviço os lê do formulário da tarefa
// no OTCS.
//   /cancel/preview: só consulta (nada é cancelado nem gravado) e devolve o estado de cada alvo.
//   /cancel: cancela o lote, grava o resultado no formulário e faz o SendOn; o corpo é o do serviço (complete/sentOn/items).
const express = require('express');
const { ServiceError } = require('../../services/signatureService');
const { CANCEL_ERROR_MESSAGE } = require('../../services/cancellationService');
const { oneLine, describeError } = require('../../infra/util');

function cancelRoutes({ logger, cancellationService, verifySignature }) {
  const router = express.Router();

  // Mesmo pipeline para as duas rotas: log, HMAC v2 + nonce, recusa de v1 e tradução dos erros do serviço
  const route = (path, label, run) => {
    router.post(path, (req, res, next) => {
      const { workflowId, subworkflowId } = req.body || {};
      logger.info(
        `${label} request initiated\n` +
        `  → Cancel workflow: ${oneLine(workflowId)}\n` +
        `  → Cancel subworkflow: ${oneLine(subworkflowId)}`
      );
      next();
    }, verifySignature, async (req, res) => {
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

  return router;
}

module.exports = { cancelRoutes };
