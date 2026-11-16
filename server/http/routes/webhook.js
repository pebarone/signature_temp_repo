// http/routes/webhook.js
// Webhook do Adobe Sign: HEAD/GET (handshake) e POST (eventos).
// O POST persiste o evento (dedupe por webhookNotificationId) e responde 200 na hora;
// o download do PDF / SendOn rodam em segundo plano (reconciliationService).
// Acordo desconhecido (adoção ligada): aguarda a adoção por um tempo limitado e responde 503 se não deu para ler o acordo no
// Adobe (ou demorou demais), para o Adobe reenviar o evento: com o 200 ele não reenviaria e o evento se perderia.
const express = require('express');
const { parseWebhookPayload } = require('../../domain/eventPolicy');
const { describeError, oneLine, maskEmail } = require('../../infra/util');

// Só caracteres seguros num header (evita injeção de cabeçalho/log); o ClientId do Adobe é alfanumérico
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
// Espera máxima pela adoção de um acordo desconhecido antes de responder. O Adobe dá 5 s para a resposta e entrega as
// notificações do webhook uma de cada vez: uma resposta lenta segura a fila inteira. 3 s deixam folga para a rede.
// Sobrescrevível por config.webhookAdoptionWaitMs (testes).
const ADOPTION_WAIT_MS = 3000;
const ADOPTION_TRANSIENT = 'transient';

const rawClientId = (req) => req.headers['x-adobesign-clientid'] || req.headers['x-adobesign-client-id'];
// Valor recebido, se tiver formato válido
const sentClientId = (req) => {
  const v = rawClientId(req);
  return typeof v === 'string' && CLIENT_ID_RE.test(v) ? v : null;
};

// Adobe exige que a resposta ecoe o MESMO valor recebido no X-AdobeSign-ClientId. Sem header (ou inválido),
// devolvemos o CLIENT_ID configurado
function echoClientId(config, req, res) {
  const cid = sentClientId(req) || config.clientId;
  if (cid) res.setHeader('X-AdobeSign-ClientId', cid);
}

/*
  Middleware do eco, montado em app.js ANTES do express.json: um POST com JSON inválido ou acima do limite cai no handler de
  erros (400/413) sem passar pela rota, e sem este middleware essa resposta sairia sem o header que o Adobe exige.
*/
function webhookEchoClientId(config) {
  return (req, res, next) => {
    echoClientId(config, req, res);
    next();
  };
}

function webhookRoutes({ config, logger, reconciliation }) {
  const router = express.Router();

  // Conjunto aceito: CLIENT_ID da integração + WEBHOOK_CLIENT_IDS (o webhook criado pela UI do Adobe envia o ClientId
  // do aplicativo que o criou, que não é o CLIENT_ID OAuth daqui)
  const acceptedIds = () => new Set([config.clientId, ...(config.webhookClientIds || [])].filter(Boolean));

  // HEAD: validação do webhook (nunca devolve corpo)
  router.head('/webhook', (req, res) => {
    echoClientId(config, req, res);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end();
  });

  // GET: challenge/handshake
  router.get('/webhook', (req, res) => {
    echoClientId(config, req, res);
    if (req.query.challenge) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(`${req.query.challenge}`);
    }
    return res.status(200).json({ status: 'pong' });
  });

  // POST: eventos (assinatura concluída, rejeitada, etc.)
  router.post('/webhook', async (req, res) => {
    echoClientId(config, req, res);

    // Autenticidade (best effort: o ClientId não é segredo). Com WEBHOOK_REQUIRE_CLIENT_ID=true header
    // ausente ou fora do conjunto aceito é recusado antes de persistir; sem nenhum ID configurado não há com o que comparar
    const accepted = acceptedIds();
    const sent = sentClientId(req);
    const mismatch = !accepted.size || !sent || !accepted.has(sent);
    if (rawClientId(req) && accepted.size && mismatch) {
      logger.warn('Webhook con X-AdobeSign-ClientId diferente del CLIENT_ID configurado');
    }
    if (config.webhookRequireClientId && mismatch) {
      logger.warn('Webhook rechazado (WEBHOOK_REQUIRE_CLIENT_ID=true): X-AdobeSign-ClientId ausente o inválido');
      return res.status(401).send('Invalid client id');
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      logger.error('Webhook parse error: cuerpo ausente o no es JSON');
      return res.status(400).send('Invalid webhook payload');
    }

    const parsed = parseWebhookPayload(payload);
    logger.info(
      `Webhook received\n` +
      `  → Event: ${oneLine(parsed.eventName)}\n` +
      `  → Agreement ID: ${oneLine(parsed.agreementId)}\n` +
      `  → Participant: ${oneLine(parsed.participant ? maskEmail(parsed.participant) : 'unknown')}\n` +
      `  → Date: ${oneLine(parsed.eventDate || new Date().toISOString())}\n` +
      `  → Notification: ${oneLine(parsed.notificationId || '-')}`
    );

    let result;
    try {
      result = reconciliation.handleEvent(parsed); // persiste (síncrono) e dispara o processamento
    } catch (e) {
      // Não conseguimos persistir: 5xx faz o Adobe reenviar a notificação
      logger.error(`Webhook: falló al persistir el evento ${parsed.notificationId || ''}: ${describeError(e)}`);
      return res.status(500).send('Event could not be stored');
    }

    // O processamento (e a adoção de acordo desconhecido) já está em andamento; só garante que nenhuma rejeição fique solta
    if (result.processing) result.processing.catch(() => {});
    if (result.adoption) result.adoption.catch(() => {});

    if (result.adopted) {
      // Acordo desconhecido: o evento só é persistido depois da adoção. Falha transitória ao ler o acordo no Adobe (ou
      // demora acima do limite) => 503 para o Adobe reenviar; se a adoção terminar em segundo plano, o reenvio é duplicado
      // por notificationId e nada é processado duas vezes. Recusado ("não é nosso") => 200 como antes.
      // Só um número finito positivo sobrescreve (null/0/texto inválido voltam ao padrão, em vez de virar 0 ms)
      const override = Number(config.webhookAdoptionWaitMs);
      const waitMs = Number.isFinite(override) && override > 0 ? override : ADOPTION_WAIT_MS;
      let timer;
      try {
        const outcome = await Promise.race([
          result.adopted,
          new Promise((resolve) => { timer = setTimeout(() => resolve(ADOPTION_TRANSIENT), waitMs); })
        ]);
        if (outcome === ADOPTION_TRANSIENT) {
          logger.warn(`Webhook: no se pudo adoptar el acuerdo ${oneLine(parsed.agreementId)} ahora (evento ${oneLine(parsed.eventName)}): se responde 503 para que Adobe reenvíe`);
          return res.status(503).send('Agreement could not be verified, retry later');
        }
      } catch (e) {
        logger.error(`Webhook: falló al persistir el evento ${parsed.notificationId || ''} tras la adopción: ${describeError(e)}`);
        return res.status(500).send('Event could not be stored');
      } finally {
        clearTimeout(timer);
      }
    }

    res.status(200).send('OK');
  });

  return router;
}

module.exports = { webhookRoutes, webhookEchoClientId, ADOPTION_WAIT_MS };
