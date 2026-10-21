// Fakes e montagem do "mundo" de testes: Adobe/OTCS falsos, SQLite em memória (ou arquivo), relógio controlável.
// Nenhum endpoint real é chamado e nenhuma credencial real é usada (valores abaixo são fixtures).
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeConfig } = require('../../server/config');
const { openDatabase } = require('../../server/infra/db');
const { createAgreementRepository } = require('../../server/infra/agreementRepository');
const { createReconciliationService } = require('../../server/services/reconciliationService');
const { createSignatureService } = require('../../server/services/signatureService');
const { createPoller } = require('../../server/services/poller');
const { createApp } = require('../../server/app');
const { sign } = require('../../server/http/middleware/hmac');

const PDF = Buffer.from('%PDF-1.4\n% fake signed pdf\n');
const T0 = Date.parse('2026-06-22T12:00:00.000Z');

function makeClock(start = T0) {
  const clock = {
    t: start,
    now: () => new Date(clock.t),
    ms: () => clock.t,
    advance(ms) { clock.t += ms; }
  };
  return clock;
}

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  const logger = {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    auditFilePath: () => path.join(os.tmpdir(), 'nonexistent-audit.log'),
    has(level, re) { return lines[level].some((l) => re.test(l)); }
  };
  return logger;
}

const httpError = (status, message = 'boom') => {
  const e = new Error(message);
  e.response = { status, data: { message } };
  return e;
};

// Adobe falso. `calls` é compartilhado com o OTCS falso para verificar a ordem das chamadas.
function makeAdobe(calls = []) {
  const adobe = {
    calls,
    agreements: {},          // id -> { status }
    events: {},              // id -> [{ type }] (GET /agreements/{id}/events)
    eventsError: null,       // se definido, getAgreementEvents lança
    downloadFailures: 0,     // próximas N chamadas de download falham
    pdf: PDF,
    created: [],
    authOk: true,
    async checkAuth() {
      if (!adobe.authOk) throw new Error('REFRESH_TOKEN_MISSING');
      return 'token';
    },
    async createTransientDocument(buffer, fileName) {
      calls.push(['adobe.transient', fileName]);
      return 'transient-1';
    },
    async createAgreement({ name, transientDocumentId, emails }) {
      const id = `AG-${adobe.created.length + 1}`;
      adobe.created.push({ id, name, transientDocumentId, emails });
      adobe.agreements[id] = { id, status: 'OUT_FOR_SIGNATURE' };
      calls.push(['adobe.createAgreement', id]);
      return { id };
    },
    async getAgreement(id) {
      calls.push(['adobe.getAgreement', id]);
      if (!adobe.agreements[id]) throw httpError(404, 'agreement not found');
      return adobe.agreements[id];
    },
    async getAgreementEvents(id) {
      calls.push(['adobe.getAgreementEvents', id]);
      if (adobe.eventsError) throw adobe.eventsError;
      return adobe.events[id] || [];
    },
    async downloadCombinedDocument(id) {
      calls.push(['adobe.download', id]);
      if (adobe.downloadFailures > 0) {
        adobe.downloadFailures--;
        throw httpError(500, 'adobe down');
      }
      return adobe.pdf;
    }
  };
  return adobe;
}

// OTCS falso. `gate` (Promise) segura o upload até ser liberada (teste de "200 rápido").
function makeOtcs(calls = []) {
  const otcs = {
    calls,
    uploadFailures: 0,
    dispositionFailures: 0,
    uploadGate: null,
    uploadFailStatus: 500,   // status HTTP dos erros de uploadFailures
    dispositionFailStatus: 500,
    uploads: [],
    sendons: [],
    downloads: [],
    sendOnFailsAlways: false,
    async downloadNode(nodeId) {
      calls.push(['otcs.download', String(nodeId)]);
      otcs.downloads.push(String(nodeId));
      return Buffer.from('%PDF-1.4 original');
    },
    async uploadToFolder(folderId, buffer, fileName) {
      calls.push(['otcs.upload', String(folderId), fileName]);
      if (otcs.uploadGate) await otcs.uploadGate;
      if (otcs.uploadFailures > 0) {
        otcs.uploadFailures--;
        throw httpError(otcs.uploadFailStatus, 'otcs upload failed');
      }
      otcs.uploads.push({ folderId: String(folderId), fileName, size: buffer.length });
      return { ok: true };
    },
    async sendOnWorkflow(args) {
      calls.push(['otcs.sendon', args.disposition || 'sendon', args.taskId]);
      if (otcs.sendOnFailsAlways) throw httpError(500, 'sendon failed');
      if (args.disposition && otcs.dispositionFailures > 0) {
        otcs.dispositionFailures--;
        throw httpError(otcs.dispositionFailStatus, 'otcs disposition failed');
      }
      otcs.sendons.push(args);
      return { ok: true };
    },
    dispositionCalls() { return otcs.sendons.filter((s) => s.disposition); }
  };
  return otcs;
}

function makeTokenStore() {
  return {
    exchanged: [],
    buildLoginUrl: () => 'https://adobe.invalid/public/oauth/v2?client_id=cid',
    async exchangeCode(code) {
      if (code === 'bad') throw new Error('invalid_grant');
      this.exchanged.push(code);
    },
    async ensureToken() { return 'token'; }
  };
}

const createdDirs = [];
process.on('exit', () => {
  for (const d of createdDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmpDir(prefix = 'sigtest-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

const baseEnv = (dataDir) => ({
  DATA_DIR: dataDir,
  CLIENT_ID: 'test-client-id',
  CLIENT_SECRET: 'test-client-secret',
  SIGNATURE_SECRET: 'test-signature-secret',
  LOG_USER: 'admin',
  LOG_PASS: 'pa:ss',
  PUBLIC_URL: 'http://localhost:0',
  POLL_ENABLED: 'false'
});

/*
  Monta repo + serviços (+ app HTTP opcional). `dbFile` ':memory:' por padrão; passe um arquivo para testar restart.
  Retries agendados vão para `timers` (não rodam sozinhos).
*/
async function buildWorld({
  dbFile = ':memory:', env = {}, clock = makeClock(), adobe, otcs, listen = false, logger = makeLogger(), tokenStore
} = {}) {
  const calls = [];
  adobe = adobe || makeAdobe(calls);
  otcs = otcs || makeOtcs(adobe.calls);
  const dataDir = tmpDir();
  const config = computeConfig({ ...baseEnv(dataDir), ...env });
  const db = openDatabase(dbFile);
  const repo = createAgreementRepository(db, { now: clock.now });
  const timers = [];
  const reconciliation = createReconciliationService({
    repo, adobe, otcs, config, logger, now: clock.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; }
  });
  const signatureService = createSignatureService({ repo, adobe, otcs, logger, config, now: clock.now });
  const poller = createPoller({ repo, adobe, processor: reconciliation, config, logger, now: clock.now });
  tokenStore = tokenStore || makeTokenStore();

  const world = {
    config, db, repo, adobe, otcs, clock, logger, timers, reconciliation, signatureService, poller, tokenStore, dataDir,
    calls: adobe.calls,
    async close() {
      reconciliation.stop();
      poller.stop();
      if (world.server) await new Promise((r) => world.server.close(r));
      try { db.close(); } catch { /* já fechado */ }
    }
  };

  if (listen) {
    world.app = createApp({
      config, logger, repo, reconciliation, signatureService, tokenStore, now: clock.ms
    });
    world.server = await new Promise((resolve) => {
      const s = world.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    world.baseUrl = `http://127.0.0.1:${world.server.address().port}`;
  }
  return world;
}

// Cria um acordo "pendente" já mapeado (como o /start faria)
function seedAgreement(world, id = 'AG-1', extra = {}) {
  return world.repo.upsert(id, {
    nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf',
    workflowId: '3003', subworkflowId: '3004', taskId: 2,
    emails: ['a@example.com'], state: 'pending', ...extra
  });
}

// Payload de webhook no formato v6 do Adobe
function webhookPayload(event, agreementId, { notificationId, status, extra = {} } = {}) {
  return {
    webhookId: 'wh-1',
    webhookNotificationId: notificationId === undefined ? `n-${event}-${agreementId}` : notificationId,
    event,
    eventDate: '2026-06-22T12:00:00Z',
    participantUserEmail: 'a@example.com',
    agreement: { id: agreementId, status: status || 'OUT_FOR_SIGNATURE' },
    ...extra
  };
}

async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Corpo do /start como o template.html monta (timestamp+signature via /auth)
function startBody(world, over = {}) {
  const timestamp = String(world.clock.ms());
  return {
    userEmail1: 'one@example.com',
    userEmail2: 'two@example.com',
    nodeId: 1001,
    attachId: 2002,
    docName: 'contrato.pdf',
    workflowId: 3003,
    subworkflowId: 3004,
    taskId: 2,
    timestamp,
    signature: sign(world.config.signatureSecret, timestamp),
    ...over
  };
}

const basicHeader = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

module.exports = {
  PDF, T0, makeClock, makeLogger, makeAdobe, makeOtcs, makeTokenStore, httpError, tmpDir, buildWorld,
  seedAgreement, webhookPayload, waitFor, startBody, basicHeader
};
