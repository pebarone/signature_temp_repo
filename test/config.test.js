const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { computeConfig, checkStorage, shouldKeepalive, TMP_DATA_DIR } = require('../server/config');
const { makeLogger } = require('./support/fakes');

const ROOT = '/srv/app';
const cfg = (env) => computeConfig(env, { projectRoot: ROOT });

test('storage: DATA_DIR explícito vence sempre', () => {
  for (const env of [
    { DATA_DIR: '/data' },
    { DATA_DIR: '/data', RENDER: 'true' },
    { DATA_DIR: '/data', NODE_ENV: 'production', KUBERNETES_SERVICE_HOST: '10.0.0.1', REQUIRE_PERSISTENT_STORAGE: 'true' }
  ]) {
    const c = cfg(env);
    assert.equal(c.dataDir, '/data');
    assert.equal(c.storage.source, 'DATA_DIR');
    assert.equal(c.storage.ephemeral, false);
    assert.equal(c.storage.problem, null);
    assert.equal(c.storage.fatal, false);
  }
});

test('storage: subpastas logs/ inprocess/ state/ e arquivos', () => {
  const c = cfg({ DATA_DIR: '/data' });
  assert.equal(c.logsDir, path.join('/data', 'logs'));
  assert.equal(c.inprocessDir, path.join('/data', 'inprocess'));
  assert.equal(c.stateDir, path.join('/data', 'state'));
  assert.equal(c.dbFile, path.join('/data', 'state', 'orchestrator.db'));
  assert.equal(c.tokensFile, path.join('/data', 'state', 'tokens.json'));
});

test('storage: Render usa /tmp (efêmero, aceito em QA)', () => {
  const c = cfg({ RENDER: 'true' });
  assert.equal(c.dataDir, TMP_DATA_DIR);
  assert.equal(TMP_DATA_DIR, '/tmp/signature-orchestrator');
  assert.equal(c.storage.source, 'tmp');
  assert.equal(c.storage.ephemeral, true);
  assert.equal(c.storage.problem, null);
  assert.equal(c.storage.fatal, false);
});

test('storage: NODE_ENV=production sem DATA_DIR usa /tmp', () => {
  const c = cfg({ NODE_ENV: 'production' });
  assert.equal(c.dataDir, TMP_DATA_DIR);
  assert.equal(c.storage.ephemeral, true);
});

test('storage: local usa ./data na raiz do projeto', () => {
  const c = cfg({});
  assert.equal(c.dataDir, path.join(ROOT, 'data'));
  assert.equal(c.storage.source, 'local');
  assert.equal(c.storage.ephemeral, false);
  assert.equal(c.storage.problem, null);
});

test('storage: OpenShift/Kubernetes sem DATA_DIR gera erro (não fatal por padrão)', () => {
  const c = cfg({ KUBERNETES_SERVICE_HOST: '10.0.0.1', NODE_ENV: 'production' });
  assert.match(c.storage.problem, /DATA_DIR/);
  assert.equal(c.storage.ephemeral, true);
  assert.equal(c.storage.fatal, false);

  const logger = makeLogger();
  let exited = null;
  const ok = checkStorage(c, logger, (code) => { exited = code; });
  assert.equal(ok, true);
  assert.equal(exited, null);
  assert.equal(logger.lines.error.length, 1);
});

test('storage: OpenShift sem DATA_DIR + REQUIRE_PERSISTENT_STORAGE=true falha na inicialização', () => {
  const c = cfg({ KUBERNETES_SERVICE_HOST: '10.0.0.1', REQUIRE_PERSISTENT_STORAGE: 'true' });
  assert.equal(c.storage.fatal, true);
  assert.match(c.storage.problem, /Kubernetes\/OpenShift/);

  const logger = makeLogger();
  let exited = null;
  const ok = checkStorage(c, logger, (code) => { exited = code; });
  assert.equal(ok, false);
  assert.equal(exited, 1);
  assert.ok(logger.has('error', /REQUIRE_PERSISTENT_STORAGE=true/));
});

test('storage: REQUIRE_PERSISTENT_STORAGE=true também recusa /tmp efêmero', () => {
  const c = cfg({ RENDER: 'true', REQUIRE_PERSISTENT_STORAGE: 'true' });
  assert.equal(c.storage.fatal, true);
});

test('storage: efêmero sem erro só gera warn', () => {
  const logger = makeLogger();
  checkStorage(cfg({ RENDER: 'true' }), logger, () => assert.fail('não deve sair'));
  assert.equal(logger.lines.warn.length, 1);
  assert.equal(logger.lines.error.length, 0);
});

test('disposições: Firmado/Rechazado por padrão; expirado/cancelado/conversão vazios', () => {
  const c = cfg({});
  assert.deepEqual(c.dispositions, {
    signed: 'Firmado', rejected: 'Rechazado', expired: '', recalled: '', conversionFailed: ''
  });
  const c2 = cfg({
    DISPOSITION_SIGNED: 'Signed', DISPOSITION_REJECTED: 'Rejected', DISPOSITION_EXPIRED: 'Expirado',
    DISPOSITION_RECALLED: 'Cancelado', DISPOSITION_CONVERSION_FAILED: 'Erro'
  });
  assert.deepEqual(c2.dispositions, {
    signed: 'Signed', rejected: 'Rejected', expired: 'Expirado', recalled: 'Cancelado', conversionFailed: 'Erro'
  });
});

test('config: padrões de polling, retenção e região Adobe', () => {
  const c = cfg({});
  assert.equal(c.poll.intervalMs, 10 * 60 * 1000);
  assert.equal(c.poll.enabled, true);
  assert.equal(c.logRetentionDays, 15);
  assert.equal(c.signTaskId, 3);
  assert.equal(c.adobeApiBase, 'https://api.eu1.adobesign.com');
  const c2 = cfg({
    POLL_ENABLED: 'false', POLL_INTERVAL_MS: '5000', LOG_RETENTION_DAYS: '7',
    ADOBE_API_BASE: 'https://api.na4.adobesign.com/', PUBLIC_URL: 'https://x.example/'
  });
  assert.equal(c2.poll.enabled, false);
  assert.equal(c2.poll.intervalMs, 5000);
  assert.equal(c2.logRetentionDays, 7);
  assert.equal(c2.adobeApiBase, 'https://api.na4.adobesign.com');
});

test('keepalive: só no Render (RENDER=true) com PUBLIC_URL e KEEPALIVE_INTERVAL_MS > 0', () => {
  const on = { RENDER: 'true', PUBLIC_URL: 'https://app.example' };
  assert.equal(shouldKeepalive(cfg(on)), true);
  assert.equal(shouldKeepalive(cfg({ ...on, NODE_ENV: 'production' })), true);
  assert.equal(shouldKeepalive(cfg({ NODE_ENV: 'production', PUBLIC_URL: 'https://app.example' })), false, 'production fora do Render');
  assert.equal(shouldKeepalive(cfg({ KUBERNETES_SERVICE_HOST: '10.0.0.1', NODE_ENV: 'production', PUBLIC_URL: 'https://app.example' })), false);
  assert.equal(shouldKeepalive(cfg({ RENDER: 'true' })), false, 'sem PUBLIC_URL');
  assert.equal(shouldKeepalive(cfg({ ...on, KEEPALIVE_INTERVAL_MS: '0' })), false);
  assert.equal(cfg({}).keepaliveMs, 10 * 60 * 1000);
});

test('config: ADOBE_TIMEOUT_MS e RETRY_MAX_ATTEMPTS (padrões e limites)', () => {
  assert.equal(cfg({}).adobeTimeoutMs, 60000);
  assert.equal(cfg({ ADOBE_TIMEOUT_MS: '20000' }).adobeTimeoutMs, 20000);
  assert.equal(cfg({ ADOBE_TIMEOUT_MS: '5' }).adobeTimeoutMs, 1000, 'mínimo de 1 s (mesma regra do OTCS_TIMEOUT_MS)');
  assert.equal(cfg({}).backoff.maxAttempts, 10);
  assert.equal(cfg({ RETRY_MAX_ATTEMPTS: '0' }).backoff.maxAttempts, 0);
  assert.equal(cfg({ RETRY_MAX_ATTEMPTS: '3' }).backoff.maxAttempts, 3);
  assert.equal(cfg({ RETRY_MAX_ATTEMPTS: 'x' }).backoff.maxAttempts, 10);
});
