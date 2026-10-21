// http/routes/webhook.js
// Webhook do Adobe Sign: HEAD/GET (handshake) e POST (eventos).
// O POST persiste o evento (dedupe por webhookNotificationId) e responde 200 na hora;
// o download do PDF / SendOn rodam em segundo plano (reconciliationService).
const express = require('express');
const { parseWebhookPayload } = require('../../domain/eventPolicy');
const { describeError, oneLine } = require('../../infra/util');

// Só caracteres seguros num header (evita injeção de cabeçalho/log); o ClientId do Adobe é alfanumérico
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function webhookRoutes({ config, logger, reconciliation }) {
  const router = express.Router();

  const rawClientId = (req) => req.headers['x-adobesign-clientid'] || req.headers['x-adobesign-client-id'];
  // Valor recebido, se tiver formato válido
  const sentClientId = (req) => {
    const v = rawClientId(req);
    return typeof v === 'string' && CLIENT_ID_RE.test(v) ? v : null;
  };
  // Conjunto aceito: CLIENT_ID da integração + WEBHOOK_CLIENT_IDS (o webhook criado pela UI do Adobe envia o ClientId
  // do aplicativo que o criou, que não é o CLIENT_ID OAuth daqui)
  const acceptedIds = () => new Set([config.clientId, ...(config.webhookClientIds || [])].filter(Boolean));

  // Adobe exige que a resposta ecoe o MESMO valor recebido no X-AdobeSign-ClientId. Sem header (ou inválido),
  // devolvemos o CLIENT_ID configurado
  const echoClientId = (req, res) => {
    const cid = sentClientId(req) || config.clientId;
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

    // Autenticidade (best effort: o ClientId não é segredo). Com WEBHOOK_REQUIRE_CLIENT_ID=true header
    // ausente ou fora do conjunto aceito é recusado antes de persistir; sem nenhum ID configurado não há com o que comparar
    const accepted = acceptedIds();
    const sent = sentClientId(req);
    const mismatch = !accepted.size || !sent || !accepted.has(sent);
    if (rawClientId(req) && accepted.size && mismatch) {
      logger.warn('Webhook com X-AdobeSign-ClientId diferente do CLIENT_ID configurado');
    }
    if (config.webhookRequireClientId && mismatch) {
      logger.warn('Webhook recusado (WEBHOOK_REQUIRE_CLIENT_ID=true): X-AdobeSign-ClientId ausente ou inválido');
      return res.status(401).send('Invalid client id');
    }

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

    // O processamento (e a adoção de acordo desconhecido) já está em andamento; só garante que nenhuma rejeição fique solta
    if (result.processing) result.processing.catch(() => {});
    if (result.adoption) result.adoption.catch(() => {});
  });

  return router;
}

module.exports = { webhookRoutes };
