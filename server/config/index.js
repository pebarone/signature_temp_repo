// config.js
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TMP_DATA_DIR = '/tmp/signature-orchestrator';

const bool = (v, def) =>
  (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const str = (v, def = '') => (v === undefined || v === null ? def : String(v).trim());
const noSlash = (v) => String(v).replace(/\/+$/, '');

/*
  === Config a partir de um objeto env (testável) ===
  Storage: DATA_DIR > Render/NODE_ENV=production (/tmp, efêmero) > ./data local.
  Kubernetes/OpenShift sem DATA_DIR => storage efêmero (problem); fatal se REQUIRE_PERSISTENT_STORAGE=true
  (que também recusa o /tmp efêmero do Render/production).
*/
function computeConfig(env = process.env, { projectRoot = PROJECT_ROOT } = {}) {
  const isRender = bool(env.RENDER, false);
  const isProduction = env.NODE_ENV === 'production';
  const isKubernetes = !!env.KUBERNETES_SERVICE_HOST;
  const requirePersistent = bool(env.REQUIRE_PERSISTENT_STORAGE, false);

  let dataDir;
  let source;
  if (str(env.DATA_DIR)) {
    dataDir = path.resolve(str(env.DATA_DIR));
    source = 'DATA_DIR';
  } else if (isRender || isProduction) {
    dataDir = TMP_DATA_DIR;
    source = 'tmp';
  } else {
    dataDir = path.join(projectRoot, 'data');
    source = 'local';
  }

  const noDataDir = source !== 'DATA_DIR';
  const ephemeral = source === 'tmp' || (isKubernetes && noDataDir);
  let problem = null;
  if (isKubernetes && noDataDir) {
    problem = 'Kubernetes/OpenShift detectado sin DATA_DIR: el estado (base SQLite, tokens, logs) se perderá al reiniciar el pod. ' +
      'Monte un PVC y defina DATA_DIR (ej. /data).';
  } else if (ephemeral && requirePersistent) {
    problem = `REQUIRE_PERSISTENT_STORAGE=true pero el storage es efímero (${dataDir}). Defina DATA_DIR con un volumen persistente.`;
  }

  const stateDir = path.join(dataDir, 'state');
  const publicUrl = str(env.PUBLIC_URL);

  return {
    platform: { isRender, isProduction, isKubernetes },
    storage: {
      source,
      ephemeral,
      problem,
      fatal: !!problem && requirePersistent
    },
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    inprocessDir: path.join(dataDir, 'inprocess'),
    stateDir,
    dbFile: path.join(stateDir, 'orchestrator.db'),
    tokensFile: path.join(stateDir, 'tokens.json'),
    // Locais antigos: agreements.json é importado para o SQLite no primeiro start; tokens só se o novo não existir
    legacy: {
      agreementsFiles: [
        path.join(stateDir, 'agreements.json'),
        '/tmp/agreements.json',
        path.join(projectRoot, 'server/serverModules/agreements.json')
      ],
      tokensFiles: ['/tmp/tokens.json', path.join(projectRoot, 'tokens.json')]
    },

    port: int(env.PORT, 3000),
    publicUrl,
    redirectUri: `${publicUrl}/admin/callback`,
    clientId: env.CLIENT_ID,
    adobeScopes: [
      'agreement_send:account', 'agreement_write:account', 'agreement_read:account',
      'account_read:account', 'account_write:account', 'user_login:account'
    ],
    clientSecret: env.CLIENT_SECRET,
    signatureSecret: env.SIGNATURE_SECRET,
    logUser: env.LOG_USER,
    logPass: env.LOG_PASS,

    adobeApiBase: noSlash(str(env.ADOBE_API_BASE, 'https://api.eu1.adobesign.com')),
    adobeAuthBase: noSlash(str(env.ADOBE_AUTH_BASE, 'https://secure.eu1.adobesign.com')),
    adobeRefreshToken: str(env.ADOBE_REFRESH_TOKEN),
    adobeDownload: {
      attempts: Math.max(1, int(env.ADOBE_DOWNLOAD_ATTEMPTS, 8)),
      delayMs: int(env.ADOBE_DOWNLOAD_RETRY_DELAY_MS, 3000),
      maxDelayMs: int(env.ADOBE_DOWNLOAD_RETRY_MAX_DELAY_MS, 30000)
    },

    otcs: {
      base: noSlash(str(env.OTCS_BASE)),
      user: env.OTCS_USER,
      pass: env.OTCS_PASS,
      timeoutMs: Math.max(1000, int(env.OTCS_TIMEOUT_MS, 60 * 1000))
    },

    // Self-ping (Render): intervalo em ms; 0 desativa
    keepaliveMs: int(env.KEEPALIVE_INTERVAL_MS, 10 * 60 * 1000),

    poll: {
      enabled: bool(env.POLL_ENABLED, true),
      intervalMs: Math.max(1000, int(env.POLL_INTERVAL_MS, 10 * 60 * 1000)),
      initialDelayMs: int(env.POLL_INITIAL_DELAY_MS, 30 * 1000),
      maxPerTick: Math.max(1, int(env.POLL_MAX_PER_TICK, 50)),
      maxAgeDays: int(env.POLL_MAX_AGE_DAYS, 90)
    },
    backoff: {
      baseMs: Math.max(1, int(env.RETRY_BASE_MS, 60 * 1000)),
      maxMs: Math.max(1, int(env.RETRY_MAX_MS, 60 * 60 * 1000))
    },

    // 0 desativa a purga
    logRetentionDays: int(env.LOG_RETENTION_DAYS, 15),

    // Nomes das disposições (custom_action) do workflow. Vazio => needs_attention
    dispositions: {
      signed: str(env.DISPOSITION_SIGNED, 'Firmado'),
      rejected: str(env.DISPOSITION_REJECTED, 'Rechazado'),
      expired: str(env.DISPOSITION_EXPIRED),
      recalled: str(env.DISPOSITION_RECALLED),
      conversionFailed: str(env.DISPOSITION_CONVERSION_FAILED)
    },
    signTaskId: int(env.SIGN_TASK_ID, 3)
  };
}

/*
  Valida o storage no startup: loga o erro e, se REQUIRE_PERSISTENT_STORAGE=true, encerra o processo.
*/
function checkStorage(config, logger, exit = (code) => process.exit(code)) {
  if (config.storage.problem) {
    logger.error(`[STORAGE] ${config.storage.problem}`);
    if (config.storage.fatal) {
      logger.error('[STORAGE] REQUIRE_PERSISTENT_STORAGE=true: abortando la inicialización.');
      exit(1);
      return false;
    }
  } else if (config.storage.ephemeral) {
    logger.warn(`[STORAGE] Storage efímero (${config.dataDir}): el estado se pierde al reiniciar.`);
  }
  return true;
}

// Instância padrão (lazy: dotenv só é carregado quando alguém realmente usa)
let defaultConfig = null;
function getConfig() {
  if (!defaultConfig) {
    require('dotenv').config();
    defaultConfig = computeConfig(process.env);
  }
  return defaultConfig;
}

module.exports = {
  computeConfig,
  checkStorage,
  getConfig,
  get config() { return getConfig(); },
  TMP_DATA_DIR,
  PROJECT_ROOT
};
