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
const { classifyEvent, isFinalKind, KINDS } = require('../../server/domain/eventPolicy');
const { createApp } = require('../../server/app');
const { sign, signStart } = require('../../server/http/middleware/hmac');

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
    async createAgreement({ name, transientDocumentId, emails, externalId }) {
      const id = `AG-${adobe.created.length + 1}`;
      adobe.created.push({ id, name, transientDocumentId, emails, externalId });
      adobe.agreements[id] = { id, name, status: 'OUT_FOR_SIGNATURE', ...(externalId ? { externalId: { id: externalId } } : {}) };
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

/*
  Estado padrão do Adobe falso para um webhook (quando o teste não define o acordo): só cria o que ainda não existe, e
  só para eventos finais (progresso, informativos e desconhecidos não semeiam nada). Como no Adobe real: REJECTED = recusa
  (CANCELLED + evento REJECTED); RECALLED e falha de conversão = CANCELLED sem recusa; EXPIRED; SIGNED no final OK.
  `payload` é o do webhook: ACTION_COMPLETED só é final com status SIGNED no payload.
*/
function seedAdobeForEvent(adobe, event, id, payload = {}) {
  const { kind } = classifyEvent(event, { agreement: { status: payload.status || 'OUT_FOR_SIGNATURE' } });
  if (!isFinalKind(kind)) return;
  if (kind === KINDS.FINAL_REJECTED) {
    adobe.agreements[id] ||= { id, status: 'CANCELLED' };
    adobe.events[id] ||= [{ type: 'REJECTED' }];
  } else if (kind === KINDS.FINAL_EXPIRED) {
    adobe.agreements[id] ||= { id, status: 'EXPIRED' };
  } else if (kind === KINDS.FINAL_OK) {
    adobe.agreements[id] ||= { id, status: 'SIGNED' };
  } else {
    // RECALLED e falha de conversão
    adobe.agreements[id] ||= { id, status: 'CANCELLED' };
  }
}

// Nomes reais dos mapas de workflow (PROD/QA)
const START_TASK_NAME = 'Enviar solicitud de firma (Empleado y/o Firmante 2)';
const SIGN_TASK_NAME = 'Aguardar Firma';

/*
  OTCS falso. `gate` (Promise) segura a escrita do PDF até ser liberada (teste de "200 rápido").
  Modelo de workflow em memória (`workflows`): processo -> tarefas { subprocessId, taskId, name, status }.
  `addWorkflow(processId, { subprocessId, stage })`: subprocessId diferente do processo simula um sub-fluxo.
  O SendOn da tarefa de início ativa "Aguardar Firma"; a disposição conclui a tarefa de firma.
  Chamadas ao modelo (getProcessSteps/getTaskForm/updateTaskForm) vão para `modelCalls` (não poluem `calls`).
*/
function makeOtcs(calls = []) {
  const otcs = {
    calls,
    modelCalls: [],
    uploadFailures: 0,       // próximas N escritas do PDF (addVersion/uploadToFolder) falham
    dispositionFailures: 0,
    uploadGate: null,
    uploadFailStatus: 500,   // status HTTP dos erros de uploadFailures
    dispositionFailStatus: 500,
    uploads: [],             // uploadToFolder (PDF criado na pasta: fallback)
    versions: [],            // addVersion (PDF como nova versão do nó assinado)
    missingNodes: new Set(), // nós que respondem 404 em addVersion
    sendons: [],
    downloads: [],
    sendOnFailsAlways: false,
    sendOnFailures: 0,       // próximos N SendOn (de qualquer tipo) falham
    sendOnFailStatus: 500,
    workflows: {},
    stepsFailures: 0,        // próximas N consultas de getProcessSteps falham
    stepsFailStatus: 500,
    formFailure: null,       // se definido, getTaskForm lança
    customActions: ['Firmado', 'Rechazado'],
    formFields: {},          // rótulo -> { key, value } devolvido por getTaskForm
    updateFormFailures: 0,
    updateFormCalls: [],
    assignments: [],         // caixa do usuário de integração (getAssignments): { workflowId, subworkflowId, taskId, name }
    addWorkflow(processId, { subprocessId = processId, stage = 'sign' } = {}) {
      const sub = Number(subprocessId);
      const status = {
        start: ['current', 'next'],
        sign: ['completed', 'current'],
        done: ['completed', 'completed']
      }[stage];
      otcs.workflows[String(processId)] = {
        processId: Number(processId),
        tasks: [
          { subprocessId: sub, taskId: 1, name: 'Trae Documento a Firmar', status: 'completed' },
          { subprocessId: sub, taskId: 2, name: START_TASK_NAME, status: status[0] },
          { subprocessId: sub, taskId: 3, name: SIGN_TASK_NAME, status: status[1] },
          { subprocessId: sub, taskId: 4, name: 'Firmado?', status: 'next' }
        ]
      };
      return otcs.workflows[String(processId)];
    },
    task(processId, taskId) {
      return otcs.workflows[String(processId)]?.tasks.find((t) => t.taskId === Number(taskId));
    },
    async downloadNode(nodeId) {
      calls.push(['otcs.download', String(nodeId)]);
      otcs.downloads.push(String(nodeId));
      return Buffer.from('%PDF-1.4 original');
    },
    async uploadToFolder(folderId, buffer, fileName, { agreementId } = {}) {
      calls.push(['otcs.upload', String(folderId), fileName]);
      if (otcs.uploadGate) await otcs.uploadGate;
      if (otcs.uploadFailures > 0) {
        otcs.uploadFailures--;
        throw httpError(otcs.uploadFailStatus, 'otcs upload failed');
      }
      otcs.uploads.push({ folderId: String(folderId), fileName, size: buffer.length, agreementId });
      return { id: 9000 + otcs.uploads.length };
    },
    async addVersion(nodeId, buffer, fileName, { agreementId } = {}) {
      calls.push(['otcs.addVersion', String(nodeId), fileName]);
      if (otcs.uploadGate) await otcs.uploadGate;
      if (otcs.missingNodes.has(String(nodeId))) throw httpError(404, 'node not found');
      if (otcs.uploadFailures > 0) {
        otcs.uploadFailures--;
        throw httpError(otcs.uploadFailStatus, 'otcs upload failed');
      }
      otcs.versions.push({ nodeId: String(nodeId), fileName, size: buffer.length, agreementId });
      return { ok: true };
    },
    async getProcessSteps(processId) {
      otcs.modelCalls.push(['getProcessSteps', String(processId)]);
      if (otcs.stepsFailures > 0) {
        otcs.stepsFailures--;
        throw httpError(otcs.stepsFailStatus, 'steps failed');
      }
      const wf = otcs.workflows[String(processId)];
      if (!wf) throw httpError(404, 'process not found');
      const out = { current: [], completed: [], next: [] };
      for (const t of wf.tasks) {
        out[t.status].push({
          processId: wf.processId, subprocessId: t.subprocessId, taskId: t.taskId, name: t.name, status: t.status
        });
      }
      return out;
    },
    async getAssignments() {
      otcs.modelCalls.push(['getAssignments']);
      return otcs.assignments.map((a) => ({ ...a }));
    },
    async getTaskForm(processId, subprocessId, taskId) {
      otcs.modelCalls.push(['getTaskForm', Number(processId), Number(subprocessId), Number(taskId)]);
      if (otcs.formFailure) throw otcs.formFailure;
      return { title: 'Tarea', customActions: [...otcs.customActions], fields: otcs.formFields };
    },
    async updateTaskForm(processId, subprocessId, taskId, values) {
      otcs.modelCalls.push(['updateTaskForm', Number(processId), Number(subprocessId), Number(taskId)]);
      if (otcs.updateFormFailures > 0) {
        otcs.updateFormFailures--;
        throw httpError(500, 'formUpdate failed');
      }
      otcs.updateFormCalls.push({ processId: Number(processId), subprocessId: Number(subprocessId), taskId: Number(taskId), values });
      return { ok: true };
    },
    async sendOnWorkflow(args) {
      calls.push(['otcs.sendon', args.disposition || 'sendon', args.taskId]);
      if (otcs.sendOnFailsAlways) throw httpError(500, 'sendon failed');
      if (otcs.sendOnFailures > 0) {
        otcs.sendOnFailures--;
        throw httpError(otcs.sendOnFailStatus, 'sendon failed');
      }
      if (args.disposition && otcs.dispositionFailures > 0) {
        otcs.dispositionFailures--;
        throw httpError(otcs.dispositionFailStatus, 'otcs disposition failed');
      }
      // Modelo: só uma tarefa ativa pode receber SendOn; o início ativa a firma e a disposição conclui a firma
      const task = otcs.task(args.workflowId, args.taskId);
      if (task) {
        if (task.status !== 'current' || Number(args.subworkflowId) !== task.subprocessId) {
          throw httpError(409, 'task is not current');
        }
        task.status = 'completed';
        const next = otcs.task(args.workflowId, Number(args.taskId) + 1);
        if (next && next.status === 'next') next.status = 'current';
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
    buildLoginUrl: (state) => `https://adobe.invalid/public/oauth/v2?client_id=cid&state=${state}`,
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
  POLL_ENABLED: 'false',
  // Os testes de /start que não tratam da validação do workflow rodam sem consultar o OTCS (os de validação ligam)
  START_VERIFY_WORKFLOW: 'false'
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
  const signatureService = createSignatureService({
    repo, adobe, otcs, logger, config, now: clock.now, onCreated: (id) => reconciliation.reconcile(id)
  });
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
// (e, se o workflow ainda não existe no OTCS falso, o cria já na tarefa de firma — ou na de início se startSendonDone=false)
function seedAgreement(world, id = 'AG-1', extra = {}) {
  const rec = world.repo.upsert(id, {
    nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf',
    workflowId: '3003', subworkflowId: '3004', taskId: 2,
    emails: ['a@example.com'], state: 'pending', ...extra
  });
  if (rec.workflowId && !world.otcs.workflows[rec.workflowId]) {
    world.otcs.addWorkflow(rec.workflowId, {
      subprocessId: rec.subworkflowId || rec.workflowId,
      stage: rec.startSendonDone ? 'sign' : 'start'
    });
  }
  return rec;
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

const START_FIELDS = {
  userEmail1: 'one@example.com',
  userEmail2: 'two@example.com',
  nodeId: 1001,
  attachId: 2002,
  docName: 'contrato.pdf',
  workflowId: 3003,
  subworkflowId: 3004,
  taskId: 2
};
let nonceSeq = 0;

// Corpo do /start no protocolo v2 (timestamp+nonce+signature, como /auth devolveria). `over` sobrescreve campos e,
// se trouxer timestamp/nonce/signature, são usados como vieram (a assinatura, se omitida, é calculada sobre o resultado).
function startBody(world, over = {}) {
  const merged = { ...START_FIELDS, ...over };
  const timestamp = merged.timestamp ?? String(world.clock.ms());
  const nonce = merged.nonce ?? `n${String(++nonceSeq).padStart(8, '0')}${'a'.repeat(16)}`;
  const signature = 'signature' in over
    ? over.signature
    : signStart(world.config.signatureSecret, { ...merged, timestamp, nonce });
  return { ...merged, timestamp, nonce, signature };
}

// Corpo do /start no protocolo v1 (legado: HMAC só do timestamp, sem nonce)
function startBodyV1(world, over = {}) {
  const timestamp = String(world.clock.ms());
  return { ...START_FIELDS, timestamp, signature: sign(world.config.signatureSecret, timestamp), ...over };
}

/*
  Formulário da tarefa de início no OTCS falso (atributos do workflow) + o workflow na tarefa de início.
  Devolve o workflow. `fields` sobrescreve/remove (null) atributos pelo rótulo.
*/
function seedStartFlow(world, { processId = '3003', subprocessId = '3004', stage = 'start', fields = {} } = {}) {
  const base = {
    DocID: '1001',
    AttachID: '2002',
    'Nombre del Documento': 'contrato.pdf',
    'Email Firmante 1': 'one@example.com',
    'Email Firmante 2': 'two@example.com',
    ...fields
  };
  world.otcs.formFields = {};
  for (const [label, value] of Object.entries(base)) {
    if (value !== null) world.otcs.formFields[label] = { key: `k_${label.replace(/\W/g, '')}`, value };
  }
  return world.otcs.addWorkflow(processId, { subprocessId, stage });
}

const basicHeader = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

module.exports = {
  PDF, T0, START_TASK_NAME, SIGN_TASK_NAME, makeClock, makeLogger, makeAdobe, makeOtcs, makeTokenStore, httpError, tmpDir, buildWorld,
  seedAdobeForEvent, seedAgreement, webhookPayload, waitFor, startBody, startBodyV1, seedStartFlow, basicHeader
};
