// app.js
// Monta o app Express a partir de dependências injetadas (testável sem tocar Adobe/OTCS reais).
const path = require('path');
const express = require('express');
const cors = require('cors');

const { createBasicAuth } = require('./http/middleware/basicAuth');
const { createVerifySignature } = require('./http/middleware/hmac');
const { webhookRoutes } = require('./http/routes/webhook');
const { startRoutes } = require('./http/routes/start');
const { adminRoutes } = require('./http/routes/admin');
const { logsRoutes } = require('./http/routes/logs');

/*
  deps: { config, logger, repo, reconciliation, signatureService, tokenStore, now? }
    - config: valores de config/index.js (logUser/logPass, signatureSecret, clientId...)
    - reconciliation: createReconciliationService (handleEvent, reconcile)
    - signatureService: createSignatureService (start)
    - tokenStore: createTokenStore (buildLoginUrl, exchangeCode)
*/
function createApp({ config, logger, repo, reconciliation, signatureService, tokenStore, now = () => Date.now() }) {
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

  /*
    CORS só para /auth e /start (chamados pelo navegador, a partir do WebReport no OTCS). Origem não permitida não
    recebe Access-Control-Allow-Origin (o navegador bloqueia); webhook, admin, logs e health ficam sem CORS.
  */
  const corsOrigins = config.corsOrigins || [];
  const startCors = cors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    maxAge: 600
  });
  app.use(['/auth', '/start'], startCors);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '../static')));

  app.get('/health', (_, res) => res.status(200).json({ status: 'ok' }));

  app.use(webhookRoutes({ config, logger, reconciliation }));
  app.use(startRoutes({ config, logger, signatureService, startBasicAuth, verifySignature, now }));
  app.use(adminRoutes({ config, logger, repo, reconciliation, tokenStore, basicAuth, now }));
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
