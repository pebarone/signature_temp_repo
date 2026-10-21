// http/routes/webhook.js
// Webhook do Adobe Sign: HEAD/GET (handshake) e POST (eventos).
// O POST persiste o evento (dedupe por webhookNotificationId) e responde 200 na hora;
// o download do PDF / SendOn rodam em segundo plano (reconciliationService).
const express = require('express');
const { parseWebhookPayload } = require('../../domain/eventPolicy');
const { describeError, oneLine } = require('../../infra/util');

function webhookRoutes({ config, logger, reconciliation }) {
  const router = express.Router();

  // Adobe exige o eco do X-AdobeSign-ClientId (valor da requisição; senão o CLIENT_ID configurado)
  const echoClientId = (req, res) => {
    const cid = req.headers['x-adobesign-clientid'] || req.headers['x-adobesign-client-id'] || config.clientId;
    if (cid) res.setHeader('X-AdobeSign-ClientId', cid);
  };

  // HEAD: validação do webhook (nunca devolve corpo)
  router.head('/webhook', (req, res) => {
    echoClientId(req, res);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end();
  });

  // GET: challenge/handshake
  router.get('/webhook', (req, res) => {
    echoClientId(req, res);
    if (req.query.challenge) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(`${req.query.challenge}`);
    }
    return res.status(200).json({ status: 'pong' });
  });

  // POST: eventos (assinatura concluída, rejeitada, etc.)
  router.post('/webhook', (req, res) => {
    echoClientId(req, res);

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      logger.error('Webhook parse error: corpo ausente ou não é JSON');
      return res.status(400).send('Invalid webhook payload');
    }

    const parsed = parseWebhookPayload(payload);
    logger.info(
      `Webhook received\n` +
      `  → Event: ${oneLine(parsed.eventName)}\n` +
      `  → Agreement ID: ${oneLine(parsed.agreementId)}\n` +
      `  → Participant: ${oneLine(parsed.participant || 'unknown')}\n` +
      `  → Date: ${oneLine(parsed.eventDate || new Date().toISOString())}\n` +
      `  → Notification: ${oneLine(parsed.notificationId || '-')}`
    );

    let result;
    try {
      result = reconciliation.handleEvent(parsed); // persiste (síncrono) e dispara o processamento
    } catch (e) {
      // Não conseguimos persistir: 5xx faz o Adobe reenviar a notificação
      logger.error(`Webhook: falha ao persistir evento ${parsed.notificationId || ''}: ${describeError(e)}`);
      return res.status(500).send('Event could not be stored');
    }

    res.status(200).send('OK');

    // O processamento já está em andamento; só garante que nenhuma rejeição fique solta
    if (result.processing) result.processing.catch(() => {});
  });

  return router;
}

module.exports = { webhookRoutes };
