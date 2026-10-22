// index.js — ponto de entrada: monta as dependências reais, inicia o polling e o servidor HTTP.
const fs = require('fs');
const axios = require('axios');

const { config, checkStorage, shouldKeepalive } = require('./config');
const { createLogger } = require('./infra/logger');
const { openDatabase } = require('./infra/db');
const { createAgreementRepository } = require('./infra/agreementRepository');
const { importLegacyAgreements } = require('./infra/legacyImport');
const { createTokenStore } = require('./infra/tokenStore');
const { createAdobeClient } = require('./infra/adobeClient');
const { createOtcsClient } = require('./infra/otcsClient');
const { createReconciliationService } = require('./services/reconciliationService');
const { createSignatureService } = require('./services/signatureService');
const { createCancellationService } = require('./services/cancellationService');
const { createPoller } = require('./services/poller');
const { createApp } = require('./app');

function start() {
  const logger = createLogger({ logsDir: config.logsDir, retentionDays: config.logRetentionDays });

  // Falha cedo se o storage é efêmero e REQUIRE_PERSISTENT_STORAGE=true
  if (!checkStorage(config, logger)) return null;
  for (const dir of [config.logsDir, config.inprocessDir, config.stateDir]) fs.mkdirSync(dir, { recursive: true });

  const db = openDatabase(config.dbFile, { logger });
  const repo = createAgreementRepository(db);
  importLegacyAgreements(repo, config.legacy.agreementsFiles, { logger });

  const tokenStore = createTokenStore({ config, logger });
  const adobe = createAdobeClient({
    apiBase: config.adobeApiBase,
    timeoutMs: config.adobeTimeoutMs,
    ensureToken: tokenStore.ensureToken,
    download: config.adobeDownload,
    logger
  });
  const otcs = createOtcsClient({ ...config.otcs });

  const reconciliation = createReconciliationService({ repo, adobe, otcs, config, logger });
  const signatureService = createSignatureService({
    repo, adobe, otcs, logger, config, onCreated: (id, ctx) => (ctx?.existing ? reconciliation.resumeStart(id) : reconciliation.reconcile(id))
  });
  const cancellationService = createCancellationService({
    repo, adobe, otcs, logger, config, hold: reconciliation.hold, settle: reconciliation.settle
  });
  const poller = createPoller({ repo, adobe, processor: reconciliation, config, logger });

  const app = createApp({ config, logger, repo, reconciliation, signatureService, tokenStore, cancellationService });
  if (config.cancel.enabled) logger.info(`Cancelación de flujos habilitada (POST /cancel; tareas: ${config.cancel.taskNames.join(' / ')})`);
  const server = app.listen(config.port, () => {
    logger.info(
      `Server started successfully\n` +
      `  → Local:  http://localhost:${config.port}\n` +
      `  → Public: ${config.publicUrl}\n` +
      `  → Data:   ${config.dataDir}\n\n`
    );
  });
  poller.start();

  /*
    Keepalive / self-ping (Render): evita que o serviço hiberne.
    Só no Render (RENDER=true); KEEPALIVE_INTERVAL_MS=0 desativa.
  */
  let keepalive = null;
  if (shouldKeepalive(config)) {
    keepalive = setInterval(() => {
      axios.get(`${config.publicUrl}/health`, { timeout: 15000 })
        .then(() => console.log('[KEEPALIVE] Internal ping OK'))
        .catch((err) => console.log(`[KEEPALIVE] Internal ping failed: ${err.message}`));
    }, config.keepaliveMs);
    keepalive.unref();
  }

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    logger.info(`${signal} recibido: cerrando`);
    poller.stop();
    reconciliation.stop();
    if (keepalive) clearInterval(keepalive);
    logger.stopPurge();
    server.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error(`unhandledRejection: ${err?.stack || err}`));

  return { app, server, db, repo, logger };
}

if (require.main === module) start();

module.exports = { start };
