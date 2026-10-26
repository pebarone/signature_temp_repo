// app.js
// Monta o app Express a partir de dependências injetadas (testável sem tocar Adobe/OTCS reais).
const path = require('path');
const express = require('express');
const cors = require('cors');

const { createBasicAuth } = require('./http/middleware/basicAuth');
const { createVerifySignature, deriveKey, DIRECT_SCOPE } = require('./http/middleware/hmac');
const { webhookRoutes } = require('./http/routes/webhook');
const { startRoutes } = require('./http/routes/start');
const { cancelRoutes } = require('./http/routes/cancel');
const { adminRoutes } = require('./http/routes/admin');
const { logsRoutes } = require('./http/routes/logs');

/*
  deps: { config, logger, repo, reconciliation, signatureService, tokenStore, cancellationService?, now? }
    - config: valores de config/index.js (logUser/logPass, signatureSecret, clientId...)
    - reconciliation: createReconciliationService (handleEvent, reconcile)
    - signatureService: createSignatureService (start)
    - tokenStore: createTokenStore (buildLoginUrl, exchangeCode)
    - cancellationService: createCancellationService (cancelamento de fluxos); sem ele não há rotas de cancelamento
*/
function createApp({
  config, logger, repo, reconciliation, signatureService, tokenStore, cancellationService = null, now = () => Date.now()
}) {
  const app = express();
  app.disable('x-powered-by');
  const basicAuth = createBasicAuth({ user: config.logUser, pass: config.logPass });
  // /auth tem credencial própria (START_AUTH_*) ou, sem ela, a mesma de LOG_USER/LOG_PASS
  const startBasicAuth = createBasicAuth({ user: config.startAuth.user, pass: config.startAuth.pass, realm: 'Start' });
  const verifySignature = createVerifySignature({
    secret: config.signatureSecret,
    now,
    logger,
    consumeNonce: (nonce, ttlMs) => repo.consumeNonce(nonce, ttlMs),
    allowLegacy: config.startLegacySignature
  });

  // POST /cancel e POST /cancel/preview (WebReport do workflow de cancelamento): só existem com CANCEL_ENABLED=true;
  // desligado caem no 404 padrão (e nem o preflight CORS os responde). POST /cancel/direct e /cancel/direct/preview (modo
  // direto, WebReport sem workflow) exigem, além disso, CANCEL_DIRECT_ENABLED=true E credencial própria
  // (CANCEL_DIRECT_AUTH_USER/PASS, sem fallback): sem ela as rotas diretas não são montadas (404) e o startup registra o erro.
  const cancelEnabled = !!(config.cancel?.enabled && cancellationService);
  const directCredentials = !!(config.cancel?.directAuthUser && config.cancel?.directAuthPass);
  // Reusar a credencial do /auth genérico ou dos logs anularia a separação: o modo direto também não é montado
  const samePair = (user, pass) =>
    !!user && config.cancel?.directAuthUser === String(user).trim() && config.cancel?.directAuthPass === String(pass ?? '').trim();
  const directReused = directCredentials &&
    (samePair(config.startAuth?.user, config.startAuth?.pass) || samePair(config.logUser, config.logPass));
  if (cancelEnabled && config.cancel?.directEnabled && !directCredentials) {
    logger.error('[CANCEL] CANCEL_DIRECT_ENABLED=true sin CANCEL_DIRECT_AUTH_USER/PASS: cancelación directa deshabilitada');
  } else if (cancelEnabled && config.cancel?.directEnabled && directReused) {
    logger.error('[CANCEL] CANCEL_DIRECT_AUTH_USER/PASS iguales a START_AUTH_* o LOG_*: cancelación directa deshabilitada');
  }
  const cancelDirectEnabled = cancelEnabled && !!config.cancel?.directEnabled && directCredentials && !directReused;
  // Modo direto: credencial Basic própria e chave de assinatura DERIVADA (escopo 'cancel-direct'); o /auth genérico e o
  // /cancel/direct/auth não assinam um para o outro
  const directKey = config.signatureSecret ? deriveKey(config.signatureSecret, DIRECT_SCOPE) : '';
  const directBasicAuth = createBasicAuth({
    user: config.cancel?.directAuthUser, pass: config.cancel?.directAuthPass, realm: 'CancelDirect'
  });
  const verifyDirectSignature = createVerifySignature({
    secret: directKey,
    now,
    logger,
    consumeNonce: (nonce, ttlMs) => repo.consumeNonce(nonce, ttlMs),
    allowLegacy: false
  });

  /*
    CORS só para /auth, /start e (se ligado) /cancel, /cancel/preview e (modo direto ligado) /cancel/direct* (inclui /cancel/direct/auth; chamados pelo
    navegador, a partir do WebReport no OTCS; app.use('/cancel') já cobre os subcaminhos, preflight inclusive). Com o modo
    direto desligado, /cancel/direct* fica fora do CORS (nem o preflight é respondido: 404, como o /cancel desligado). Origem
    não permitida não recebe Access-Control-Allow-Origin (o navegador bloqueia); webhook, admin, logs e health ficam sem CORS.
  */
  const corsOrigins = config.corsOrigins || [];
  const baseCors = cors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    maxAge: 600
  });
  const startCors = (req, res, next) =>
    (!cancelDirectEnabled && /^\/cancel\/direct(\/|$)/i.test(req.baseUrl + req.path) ? next() : baseCors(req, res, next));
  app.use(cancelEnabled ? ['/auth', '/start', '/cancel'] : ['/auth', '/start'], startCors);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '../static')));

  app.get('/health', (_, res) => res.status(200).json({ status: 'ok' }));

  app.use(webhookRoutes({ config, logger, reconciliation }));
  app.use(startRoutes({ config, logger, signatureService, startBasicAuth, verifySignature, now }));
  if (cancelEnabled) {
    app.use(cancelRoutes({
      logger, cancellationService, verifySignature, directEnabled: cancelDirectEnabled, directBasicAuth, verifyDirectSignature, directKey, now
    }));
  }
  app.use(adminRoutes({ config, logger, repo, reconciliation, tokenStore, basicAuth, cancellationService, now }));
  app.use(logsRoutes({ logger, basicAuth }));

  // Endpoint desconhecido
  app.use((_, res) => res.status(404).json({ error: 'Endpoint not found' }));

  // JSON malformado e demais erros (nunca vaza stack)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`);
    else logger.warn(`Bad request on ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return;
    res.status(status).json({ error: status >= 500 ? 'Internal error' : 'Bad request' });
  });

  return app;
}

module.exports = { createApp };
