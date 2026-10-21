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
const { createPoller } = require('./services/poller');
const { createStartDiscovery } = require('./services/startDiscovery');
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
    repo, adobe, otcs, logger, config, onCreated: (id) => reconciliation.reconcile(id)
  });
  const poller = createPoller({ repo, adobe, processor: reconciliation, config, logger });
  // Mesma instância do signatureService: o anti-corrida (inflight) do /start vale também para a descoberta
  const startDiscovery = createStartDiscovery({ otcs, signatureService, config, logger });

  const app = createApp({ config, logger, repo, reconciliation, signatureService, tokenStore });
  const server = app.listen(config.port, () => {
    logger.info(
      `Server started successfully\n` +
      `  → Local:  http://localhost:${config.port}\n` +
      `  → Public: ${config.publicUrl}\n` +
      `  → Data:   ${config.dataDir}\n\n`
    );
  });
  poller.start();
  if (startDiscovery.start()) {
    logger.info(`[discovery] Descoberta de tarefas de envio ativa: ${config.startDiscovery.taskNames.join(', ')} ` +
      `(carência ${config.startDiscovery.graceMs} ms, a cada ${config.startDiscovery.intervalMs} ms)`);
  } else {
    logger.info('[discovery] Descoberta de tarefas de envio desativada (START_DISCOVERY_TASK_NAMES vazio)');
  }

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
    startDiscovery.stop();
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
