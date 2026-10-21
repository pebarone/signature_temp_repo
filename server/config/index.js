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
// Origem (esquema+host+porta) de uma URL; '' se inválida/vazia
const originOf = (v) => {
  try { return v ? new URL(v).origin : ''; } catch { return ''; }
};
// Lista separada por vírgula (itens vazios descartados); ausente ou sem itens => padrão
const list = (v, def = []) => {
  const items = v === undefined || v === null
    ? []
    : String(v).split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? items : def;
};

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
    // ClientIds extras aceitos no webhook além do CLIENT_ID (ex.: o do aplicativo que criou o webhook na UI do Adobe)
    webhookClientIds: list(env.WEBHOOK_CLIENT_IDS),
    // true => POST /webhook sem X-AdobeSign-ClientId igual ao CLIENT_ID (ou a um WEBHOOK_CLIENT_IDS) responde 401 (não persiste)
    webhookRequireClientId: bool(env.WEBHOOK_REQUIRE_CLIENT_ID, false),
    adobeScopes: [
      'agreement_send:account', 'agreement_write:account', 'agreement_read:account',
      'account_read:account', 'account_write:account', 'user_login:account'
    ],
    clientSecret: env.CLIENT_SECRET,
    signatureSecret: env.SIGNATURE_SECRET,
    logUser: env.LOG_USER,
    logPass: env.LOG_PASS,

    /*
      POST /auth e POST /start (WebReport). Basic Auth do /auth: START_AUTH_USER+START_AUTH_PASS (as duas) ou,
      se ausentes, LOG_USER/LOG_PASS. O /start valida o pedido contra o workflow do OTCS (fonte da verdade).
    */
    startAuth: (str(env.START_AUTH_USER) && str(env.START_AUTH_PASS))
      ? { user: str(env.START_AUTH_USER), pass: str(env.START_AUTH_PASS), own: true }
      : { user: env.LOG_USER, pass: env.LOG_PASS, own: false },
    startVerifyWorkflow: bool(env.START_VERIFY_WORKFLOW, true),
    // Rótulos dos atributos do formulário da tarefa de início (GET /v1/forms/processes/tasks/update)
    startFields: {
      docId: str(env.START_FIELD_DOCID, 'DocID'),
      attachId: str(env.START_FIELD_ATTACHID, 'AttachID'),
      docName: str(env.START_FIELD_DOCNAME, 'Nombre del Documento'),
      emails: list(env.START_FIELD_EMAILS, ['Email Firmante 1', 'Email Firmante 2'])
    },
    // Só para a janela de migração dos WebReports: assinatura v1 (só timestamp) e GET /start sem HMAC
    startLegacySignature: bool(env.START_LEGACY_SIGNATURE, false),
    startLegacyGet: bool(env.START_LEGACY_GET_ENABLED, false),
    // Origens com CORS em /auth e /start (lista; '*' só se configurado). Padrão: a origem do OTCS_BASE.
    corsOrigins: list(env.CORS_ORIGINS, originOf(str(env.OTCS_BASE)) ? [originOf(str(env.OTCS_BASE))] : [])
      .map((o) => (o === '*' ? o : noSlash(o))),

    adobeApiBase: noSlash(str(env.ADOBE_API_BASE, 'https://api.eu1.adobesign.com')),
    adobeAuthBase: noSlash(str(env.ADOBE_AUTH_BASE, 'https://secure.eu1.adobesign.com')),
    adobeRefreshToken: str(env.ADOBE_REFRESH_TOKEN),
    adobeTimeoutMs: Math.max(1000, int(env.ADOBE_TIMEOUT_MS, 60 * 1000)),
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
      maxMs: Math.max(1, int(env.RETRY_MAX_MS, 60 * 60 * 1000)),
      // Tentativas até needs_attention; 0 = sem limite
      maxAttempts: int(env.RETRY_MAX_ATTEMPTS, 10)
    },

    // 0 desativa a purga
    logRetentionDays: int(env.LOG_RETENTION_DAYS, 15),

    // 0 desativa. needs_attention por "reintentos agotados" é reaberto sozinho após N horas
    attentionRetryHours: int(env.ATTENTION_RETRY_HOURS, 6),
    // Acordo desconhecido no webhook (banco perdido/deploy novo): adota se o externalId for nosso
    adoptUnknownAgreements: bool(env.ADOPT_UNKNOWN_AGREEMENTS, true),

    // Nomes das disposições (custom_action) do workflow. Vazio => needs_attention.
    // O mapa só tem Firmado/Rechazado: expirado, cancelado e falha de conversão encerram o fluxo como Rechazado.
    dispositions: {
      signed: str(env.DISPOSITION_SIGNED, 'Firmado'),
      rejected: str(env.DISPOSITION_REJECTED, 'Rechazado'),
      expired: str(env.DISPOSITION_EXPIRED, 'Rechazado'),
      recalled: str(env.DISPOSITION_RECALLED, 'Rechazado'),
      conversionFailed: str(env.DISPOSITION_CONVERSION_FAILED, 'Rechazado')
    },
    // Tarefas localizadas pelo nome (GET /v2/workflows/status/processes/{id}); o nome normalizado COMEÇA com um destes
    signTaskNames: list(env.SIGN_TASK_NAMES, ['Aguardar Firma']),
    startTaskNames: list(env.START_TASK_NAMES, ['Enviar solicitud de firma']),
    // OBSOLETO: a disposição é endereçada pela tarefa resolvida por nome (SIGN_TASK_NAMES); mantido só por compatibilidade
    signTaskId: int(env.SIGN_TASK_ID, 3),

    /*
      Rede de segurança do /start (services/startDiscovery.js): procura na caixa do OTCS_USER as tarefas de envio.
      Nomes EXATOS (normalizados, sem prefixo). Vazio => desligado.
    */
    startDiscovery: {
      taskNames: list(env.START_DISCOVERY_TASK_NAMES, []),
      graceMs: int(env.START_DISCOVERY_GRACE_MS, 120000),
      intervalMs: Math.max(5000, int(env.START_DISCOVERY_INTERVAL_MS, 60000)),
      retryMs: int(env.START_DISCOVERY_RETRY_MS, 1800000)
    },

    // Atributos do workflow com dados do Adobe (best effort; formUpdate ainda não validado em QA => desligado)
    wfAttributes: {
      enabled: bool(env.WF_ATTRIBUTES_ENABLED, false),
      // Rótulo do atributo no mapa; vazio desliga aquele atributo
      labels: {
        agreementId: str(env.WF_ATTR_AGREEMENT_ID, 'Adobe ID Acuerdo'),
        status: str(env.WF_ATTR_STATUS, 'Adobe Estado'),
        lastEvent: str(env.WF_ATTR_LAST_EVENT, 'Adobe Último Evento'),
        updatedAt: str(env.WF_ATTR_UPDATED_AT, 'Adobe Fecha Actualización'),
        integrationState: str(env.WF_ATTR_INTEGRATION_STATE, 'Estado Integración Firma')
      }
    }
  };
}

// Self-ping só no Render (evita hibernar); precisa de PUBLIC_URL e KEEPALIVE_INTERVAL_MS > 0
const shouldKeepalive = (config) =>
  !!(config.platform.isRender && config.publicUrl && config.keepaliveMs > 0);

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
  shouldKeepalive,
  checkStorage,
  getConfig,
  get config() { return getConfig(); },
  TMP_DATA_DIR,
  PROJECT_ROOT
};
