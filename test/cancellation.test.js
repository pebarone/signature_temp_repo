// Ticket 2026060410003715 (cancelamento de fluxos): domínio, clientes, serviço, POST /cancel (WebReport) e rotas admin.
// Nenhum teste chama API real: Adobe e OTCS são os fakes de test/support/fakes.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { computeConfig } = require('../server/config');
const { openDatabase, MIGRATIONS } = require('../server/infra/db');
const { createAgreementRepository } = require('../server/infra/agreementRepository');
const { createAdobeClient } = require('../server/infra/adobeClient');
const { createOtcsClient } = require('../server/infra/otcsClient');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const {
  CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget, parseTargets, classifyCancelOutcome, countSignatures, isProcessFinishedStatus
} = require('../server/domain/cancellation');
const { canonicalStart, signStart, deriveKey, DIRECT_SCOPE } = require('../server/http/middleware/hmac');
const { cancelRequestedPatch } = require('../server/domain/agreementState');
const { ServiceError } = require('../server/services/signatureService');
const {
  buildWorld, seedAgreement, webhookPayload, seedCancelFlow, startBodyV1, basicHeader, httpError,
  makeLogger, tmpDir, waitFor, INTEGRATION_USER_ID, HUMAN_USER_ID
} = require('./support/fakes');

const OTCS_ORIGIN = 'https://otcs.example.test';
const ADMIN = { authorization: basicHeader('admin', 'pa:ss') };
const post = (world, p, body, headers = {}) =>
  fetch(`${world.baseUrl}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {})
  });

// Erro lançado por uma Promise que deve rejeitar com ServiceError (devolve o erro para inspeção)
async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof ServiceError, `esperava ServiceError, veio: ${e?.stack || e}`);
    return e;
  }
  return assert.fail('esperava uma rejeição');
}

// Acordo aberto: registro + workflow no OTCS falso (tarefa de firma ativa) + acordo em andamento no Adobe falso
function open(world, id = 'AG-1', extra = {}) {
  const rec = seedAgreement(world, id, extra);
  world.adobe.agreements[id] = { id, status: 'OUT_FOR_SIGNATURE' };
  return rec;
}

const recalled = (world, id = 'AG-1', opts = {}) =>
  world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_RECALLED', id, opts)));

const cancelWorld = (env = {}, opts = {}) => buildWorld({ listen: true, env: { CANCEL_ENABLED: 'true', ...env }, ...opts });

// Protocolo do WebReport: POST /auth (Basic) e POST /cancel (ou /cancel/preview, via `path`) com o que voltou. `extra` entra no corpo sem passar pelo /auth.
async function authThenCancel(world, fields = { workflowId: '9001', subworkflowId: '9001' }, {
  tamper = {}, extra = {}, path = '/cancel', authPath = '/auth', authHeaders = ADMIN
} = {}) {
  const auth = await post(world, authPath, fields, authHeaders);
  assert.equal(auth.status, 200);
  const creds = await auth.json();
  return post(world, path, { ...fields, ...tamper, ...extra, ...creds });
}

/* ---------- domínio ---------- */

test('classifyCancelState: em andamento cancela; CANCELLED/ABORTED idempotente; SIGNED e demais finais não', () => {
  for (const s of ['OUT_FOR_SIGNATURE', 'IN_PROCESS', 'waiting_for_others', 'OUT_FOR_APPROVAL']) {
    assert.equal(classifyCancelState(s), CANCEL_STATES.CANCELABLE, s);
  }
  for (const s of ['CANCELLED', 'cancelled', ' ABORTED ']) assert.equal(classifyCancelState(s), CANCEL_STATES.ALREADY_CANCELLED, s);
  assert.equal(classifyCancelState('SIGNED'), CANCEL_STATES.SIGNED);
  for (const s of ['EXPIRED', 'ARCHIVED', 'NOVO_ESTADO', '', undefined, null]) {
    assert.equal(classifyCancelState(s), CANCEL_STATES.NOT_CANCELABLE, String(s));
  }
});

test('selectCancelTarget: nenhum, um aberto, vários abertos, encerrado por cancelamento e concluído por outro caminho', () => {
  const rec = (id, extra = {}) => ({ id, sendonDone: false, cancelRequestedAt: null, createdAt: '2026-06-22T12:00:00.000Z', ...extra });

  assert.deepEqual(selectCancelTarget([]), { kind: TARGET.NONE });
  assert.deepEqual(selectCancelTarget(undefined), { kind: TARGET.NONE });

  // um aberto entre vários encerrados: é o alvo
  const one = selectCancelTarget([rec('A', { sendonDone: true }), rec('B'), rec('C', { sendonDone: true, cancelRequestedAt: 'x' })]);
  assert.equal(one.kind, TARGET.OPEN);
  assert.equal(one.record.id, 'B');

  // vários abertos: nenhum é escolhido
  const many = selectCancelTarget([rec('A'), rec('B', { createdAt: '2026-06-22T13:00:00.000Z' })]);
  assert.equal(many.kind, TARGET.AMBIGUOUS);
  assert.deepEqual(many.records.map((r) => r.id), ['B', 'A'], 'mais recente primeiro');

  // sem aberto: decide o mais recente
  const cancelled = selectCancelTarget([
    rec('A', { sendonDone: true }),
    rec('B', { sendonDone: true, cancelRequestedAt: 'x', createdAt: '2026-06-22T13:00:00.000Z' })
  ]);
  assert.deepEqual([cancelled.kind, cancelled.record.id], [TARGET.CANCELLED, 'B']);
  const closed = selectCancelTarget([
    rec('A', { sendonDone: true, cancelRequestedAt: 'x' }),
    rec('B', { sendonDone: true, createdAt: '2026-06-22T13:00:00.000Z' })
  ]);
  assert.deepEqual([closed.kind, closed.record.id], [TARGET.CLOSED, 'B'], 'um reenvio já concluído não é "cancelado" por um acordo anterior');
});

test('cancelRequestedPatch: encerra o acordo aberto sem disposição; acordo já concluído só recebe a marca', () => {
  const ts = '2026-06-22T12:05:00.000Z';
  const patch = cancelRequestedPatch({ finalKind: null, state: 'needs_attention', attempts: 4 }, ts, { source: 'admin' });
  assert.deepEqual(patch, {
    cancelRequestedAt: ts, cancelSource: 'admin', adobeStatus: 'CANCELLED',
    finalKind: 'final_recalled', finalAt: ts, sendonDone: true, sendonAt: ts, disposition: null, completedExternally: false,
    startSendonDone: true, state: 'cancelled', attentionReason: null, attentionKind: null, attempts: 0,
    lastError: null, lastErrorStage: null, nextAttemptAt: null
  });
  // mantém o resultado final já conhecido (ex.: recusa do signatário ainda sem disposição)
  assert.equal(cancelRequestedPatch({ finalKind: 'final_rejected', finalAt: 'antes' }, ts).finalKind, 'final_rejected');
  assert.equal(cancelRequestedPatch({ finalKind: 'final_rejected', finalAt: 'antes' }, ts).finalAt, 'antes');

  const done = cancelRequestedPatch({ sendonDone: true, state: 'completed' }, ts, { source: 'workflow:9001/9001', adobeStatus: 'CANCELLED' });
  assert.deepEqual(done, { cancelRequestedAt: ts, cancelSource: 'workflow:9001/9001', adobeStatus: 'CANCELLED' });
});

/* ---------- configuração ---------- */

test('config: cancelamento desligado por padrão, nomes provisórios e variáveis CANCEL_*', () => {
  assert.deepEqual(computeConfig({}).cancel, {
    enabled: false,
    directEnabled: false,
    directAuthUser: '',
    directAuthPass: '',
    taskNames: ['Cancelar Flujo de Firma'],
    fields: { targetWorkflow: 'ID Flujo a Cancelar', targetSubworkflow: 'ID Subflujo a Cancelar', result: 'IDs Cancelados' },
    notifySigners: false,
    stopOriginal: false,
    settleTimeoutMs: 20000,
    maxTargets: 20,
    batchBudgetMs: 15000
  });
  const c = computeConfig({
    CANCEL_ENABLED: 'true', CANCEL_TASK_NAMES: 'Cancelar A, Cancelar B', CANCEL_FIELD_TARGET_WORKFLOW: 'Fluxo',
    CANCEL_FIELD_TARGET_SUBWORKFLOW: 'Subfluxo', CANCEL_NOTIFY_SIGNERS: '1', CANCEL_SETTLE_TIMEOUT_MS: '45000',
    CANCEL_FIELD_RESULT: 'Cancelados', CANCEL_STOP_ORIGINAL: 'true', CANCEL_MAX_TARGETS: '50', CANCEL_BATCH_BUDGET_MS: '25000',
    CANCEL_DIRECT_ENABLED: 'true', CANCEL_DIRECT_AUTH_USER: ' dir-user ', CANCEL_DIRECT_AUTH_PASS: 'dir:pass'
  }).cancel;
  assert.deepEqual(c, {
    enabled: true, directEnabled: true, directAuthUser: 'dir-user', directAuthPass: 'dir:pass', taskNames: ['Cancelar A', 'Cancelar B'],
    fields: { targetWorkflow: 'Fluxo', targetSubworkflow: 'Subfluxo', result: 'Cancelados' }, notifySigners: true, stopOriginal: true,
    settleTimeoutMs: 45000, maxTargets: 50, batchBudgetMs: 25000
  });
  assert.equal(computeConfig({ CANCEL_SETTLE_TIMEOUT_MS: '10' }).cancel.settleTimeoutMs, 1000, 'mínimo de 1 s');
  // lote: limite de alvos 1..100 (padrão 20), orçamento mínimo de 1 s e gravação do resultado desligável (vazio)
  const max = (v) => computeConfig({ CANCEL_MAX_TARGETS: v }).cancel.maxTargets;
  assert.deepEqual([max('0'), max('1'), max('100'), max('500'), max('x'), max('')], [1, 1, 100, 100, 20, 20]);
  assert.equal(computeConfig({ CANCEL_BATCH_BUDGET_MS: '10' }).cancel.batchBudgetMs, 1000, 'mínimo de 1 s');
  assert.equal(computeConfig({ CANCEL_BATCH_BUDGET_MS: 'x' }).cancel.batchBudgetMs, 15000);
  assert.equal(computeConfig({ CANCEL_FIELD_RESULT: '' }).cancel.fields.result, '', 'vazio desliga a gravação');
});

test('config: credencial do modo direto são CANCEL_DIRECT_AUTH_* (as duas) ou, senão, a do /auth (START_AUTH_* ou LOG_*)', () => {
  const creds = (env) => {
    const c = computeConfig(env).cancel;
    return [c.directAuthUser, c.directAuthPass];
  };
  assert.deepEqual(creds({}), ['', ''], 'sem nenhuma credencial: vazio (o modo direto não é montado)');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss' }), ['admin', 'pa:ss'], 'sem as próprias, vale a do /auth (LOG_*)');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss', START_AUTH_USER: 'su', START_AUTH_PASS: 'sp:x' }), ['su', 'sp:x'],
    'a do /auth é START_AUTH_* quando as duas estão definidas');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss', START_AUTH_USER: 'su' }), ['admin', 'pa:ss'],
    'START_AUTH_* incompleto cai no LOG_*, como o próprio /auth');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss', CANCEL_DIRECT_AUTH_USER: ' d ', CANCEL_DIRECT_AUTH_PASS: 'dp' }), ['d', 'dp'],
    'as próprias, quando as duas estão definidas (usuário sem espaços)');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss', CANCEL_DIRECT_AUTH_USER: 'd' }), ['admin', 'pa:ss'], 'só uma delas não basta');
  assert.deepEqual(creds({ LOG_USER: 'admin', LOG_PASS: 'pa:ss', CANCEL_DIRECT_AUTH_PASS: 'dp' }), ['admin', 'pa:ss'], 'só a senha também não');
});

test('parseTargets: lista, escalar, texto separado, duplicados, inválidos e limite', () => {
  assert.deepEqual(parseTargets(['3101', '3102']), { ids: ['3101', '3102'], invalid: [], overLimit: false });
  assert.deepEqual(parseTargets(3101), { ids: ['3101'], invalid: [], overLimit: false });
  assert.deepEqual(parseTargets('3101, 3102;3103\n3104\t3105'), { ids: ['3101', '3102', '3103', '3104', '3105'], invalid: [], overLimit: false });
  // texto separado também dentro de cada item da lista; duplicados saem e a ordem é a da primeira aparição
  assert.deepEqual(parseTargets(['3102, 3101', '3101', ' 3103 ']).ids, ['3102', '3101', '3103']);
  // inválidos: não numéricos (sem repetir); nunca viram id
  assert.deepEqual(parseTargets(['3101', 'abc', '12x', 'abc', '-5', '1.5']), {
    ids: ['3101'], invalid: ['abc', '12x', '-5', '1.5'], overLimit: false
  });
  // vazios
  for (const empty of [undefined, null, '', '  ', [], [null, '', ' '], ' ,; ']) {
    assert.deepEqual(parseTargets(empty), { ids: [], invalid: [], overLimit: false }, JSON.stringify(empty));
  }
  // limite: conta ids distintos (duplicados não contam); com ou sem inválidos
  assert.equal(parseTargets('1 2 3', { max: 3 }).overLimit, false);
  assert.equal(parseTargets('1 2 3 4', { max: 3 }).overLimit, true);
  assert.equal(parseTargets('1 2 2 1 2', { max: 2 }).overLimit, false);
  assert.deepEqual(parseTargets('1 2 3 x', { max: 2 }), { ids: ['1', '2', '3'], invalid: ['x'], overLimit: true });
});

test('classifyCancelOutcome: recusa definitiva (refused) x transitório/desconhecido (pending)', () => {
  for (const code of [
    'ALREADY_SIGNED', 'ALREADY_REJECTED', 'AGREEMENT_CLOSED', 'NOT_CANCELABLE', 'AMBIGUOUS',
    'AGREEMENT_NOT_FOUND', 'AGREEMENT_NOT_FOUND_IN_ADOBE'
  ]) assert.equal(classifyCancelOutcome(code), 'refused', code);
  for (const code of [
    'ADOBE_UNAVAILABLE', 'RECONCILE_IN_PROGRESS', 'IN_PROGRESS', 'BUDGET_EXCEEDED', 'UNEXPECTED_ERROR', 'OTCS_UNAVAILABLE',
    'ALGO_NOVO', '', undefined, null
  ]) assert.equal(classifyCancelOutcome(code), 'pending', String(code));
});

test('countSignatures: só participantes que concluíram assinatura; o remetente e o acordo inteiro (SIGNED) não contam', () => {
  assert.deepEqual(countSignatures(undefined), { signedCount: 0, lastSignedAt: null });
  assert.deepEqual(countSignatures([]), { signedCount: 0, lastSignedAt: null });
  // criação, envio, visualização, lembrete, conclusão do acordo inteiro e eventos do remetente: nada conta
  assert.equal(countSignatures([
    { type: 'CREATED', participantRole: 'SENDER' },
    { type: 'UPLOADED_BY_SENDER', participantRole: 'SENDER' },
    { type: 'EMAIL_VIEWED', participantEmail: 'a@example.com' },
    { type: 'REMINDER_SENT' },
    { type: 'ESIGNED', participantRole: 'SENDER', participantEmail: 'rh@example.com' },
    { type: 'WORKFLOW_COMPLETED' },
    { type: 'SIGNED' },
    { type: 'RECALLED' }
  ]).signedCount, 0);

  // ESIGNED + ACTION_COMPLETED da mesma pessoa = 1; pessoa diferente = +1; DIGSIGNED conta; data mais recente
  const signed = countSignatures([
    { type: 'ESIGNED', participantEmail: 'A@example.com', date: '2026-06-21T10:00:00Z' },
    { type: 'ACTION_COMPLETED', participantEmail: 'a@example.com', date: '2026-06-21T10:00:01Z' },
    { type: 'DIGSIGNED', participantEmail: 'b@example.com', date: '2026-06-22T08:30:00Z' },
    { type: 'EMAIL_VIEWED', participantEmail: 'c@example.com', date: '2026-06-23T08:30:00Z' }
  ]);
  assert.deepEqual(signed, { signedCount: 2, lastSignedAt: '2026-06-22T08:30:00Z' });

  // variantes de nome tratadas como conclusão de participante pelo eventPolicy (prefixo AGREEMENT_, PARTICIPANT_*, DOCUMENT_SIGNED)
  assert.equal(countSignatures([
    { type: 'AGREEMENT_ACTION_COMPLETED', participantEmail: 'a@example.com' },
    { type: 'PARTICIPANT_COMPLETED', participantEmail: 'b@example.com' },
    { type: 'DOCUMENT_SIGNED', participantEmail: 'c@example.com' },
    { eventType: 'ESIGNED', actingUserEmail: 'd@example.com' }
  ]).signedCount, 4);

  // sem identificação do participante: o maior número de eventos de um mesmo tipo (não soma ESIGNED com ACTION_COMPLETED)
  assert.equal(countSignatures([{ type: 'ESIGNED' }, { type: 'ACTION_COMPLETED' }]).signedCount, 1);
  assert.equal(countSignatures([{ type: 'ESIGNED' }, { type: 'ESIGNED' }, { type: 'ACTION_COMPLETED' }]).signedCount, 2);
});

/* ---------- clientes ---------- */

test('adobe: cancelAgreement faz PUT /agreements/{id}/state com state CANCELLED + agreementCancellationInfo', async () => {
  const seen = [];
  const http = { put: async (url, body, opts) => { seen.push({ url, body, opts }); return { data: {} }; } };
  const client = createAdobeClient({ apiBase: 'https://adobe.invalid', ensureToken: async () => 'tok', http, logger: makeLogger() });

  await client.cancelAgreement('AG 1', { comment: 'duplicado', notifyOthers: true });
  assert.equal(seen[0].url, 'https://adobe.invalid/api/rest/v6/agreements/AG%201/state');
  assert.deepEqual(seen[0].body, {
    state: 'CANCELLED', agreementCancellationInfo: { comment: 'duplicado', notifyOthers: true }
  });
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer tok');

  await client.cancelAgreement('AG-1'); // padrão: sem aviso e sem comentário
  assert.deepEqual(seen[1].body.agreementCancellationInfo, { comment: '', notifyOthers: false });

  // erro HTTP sobe ao chamador (o serviço decide)
  const failing = createAdobeClient({
    apiBase: 'https://adobe.invalid', ensureToken: async () => 'tok', logger: makeLogger(),
    http: { put: async () => { throw httpError(403); } }
  });
  await assert.rejects(() => failing.cancelAgreement('AG-1'), (e) => e.response.status === 403);
});

test('otcs: stopProcess faz PUT /v2/processes/{id}/status com status=stop (disponível, sem uso ligado)', async () => {
  let seen;
  const http = {
    post: async () => ({ data: { ticket: 't1', validFor: 1800 } }),
    put: async (url, body, opts) => { seen = { url, body, opts }; return { data: { ok: true } }; }
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  assert.deepEqual(await client.stopProcess(3003), { ok: true });
  assert.equal(seen.url, 'https://otcs.invalid/api/v2/processes/3003/status');
  assert.equal(seen.body, 'status=stop');
  assert.equal(seen.opts.headers.OTCSTicket, 't1');
  assert.equal(seen.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('otcs: getTaskForm entrega o valor multivalor (array) do atributo intacto, junto com escalares', async () => {
  const http = {
    post: async () => ({ data: { ticket: 't1', validFor: 1800 } }),
    get: async () => ({
      data: {
        forms: [{
          data: { WorkflowForm_1: ['3101', '3102'], WorkflowForm_2: '3103', WorkflowForm_3: [] },
          schema: { properties: {
            WorkflowForm_1: { title: 'ID Flujo a Cancelar' }, WorkflowForm_2: { title: 'Outro' }, WorkflowForm_3: { title: 'IDs Cancelados' }
          } }
        }]
      }
    })
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  const form = await client.getTaskForm(9001, 9001, 2);
  assert.deepEqual(form.fields['ID Flujo a Cancelar'], { key: 'WorkflowForm_1', value: ['3101', '3102'] });
  assert.deepEqual(form.fields.Outro, { key: 'WorkflowForm_2', value: '3103' });
  assert.deepEqual(form.fields['IDs Cancelados'], { key: 'WorkflowForm_3', value: [] });
});

/* ---------- banco e repositório ---------- */

test('db: banco no schema v3 recebe a migração v4 (cancelamento) preservando os dados', () => {
  assert.equal(MIGRATIONS.length, 6);
  const file = path.join(tmpDir(), 'v3.db');
  const raw = new Database(file);
  for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
  raw.pragma('user_version = 3');
  raw.prepare(`INSERT INTO agreements (id, node_id, workflow_id, state, created_at, updated_at) VALUES ('OLD', '1', '3003', 'pending', 'a', 'b')`).run();
  raw.close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const cols = db.prepare('PRAGMA table_info(agreements)').all().map((c) => c.name);
  assert.ok(cols.includes('cancel_requested_at') && cols.includes('cancel_source'));
  assert.ok(cols.includes('workflow_stop_pending') && cols.includes('workflow_stopped_at'), 'v5 (caducidad) aplicada em seguida');
  assert.ok(cols.includes('expires_at'), 'v6 (prazo do acordo) aplicada em seguida');
  assert.ok(db.prepare('PRAGMA index_list(agreements)').all().some((i) => i.name === 'idx_agreements_workflow'));
  const repo = createAgreementRepository(db);
  const old = repo.get('OLD');
  assert.equal(old.nodeId, '1');
  assert.equal(old.cancelRequestedAt, null);
  assert.equal(old.cancelSource, null);
  assert.deepEqual(repo.upsert('OLD', { cancelRequestedAt: '2026-06-22T12:00:00.000Z', cancelSource: 'admin' })
    .cancelRequestedAt, '2026-06-22T12:00:00.000Z');
  db.close();

  const again = openDatabase(file); // reabrir é idempotente
  assert.equal(again.pragma('user_version', { simple: true }), MIGRATIONS.length);
  again.close();
});

test('repo.listByWorkflow: por workflow (e subprocesso exato), mais recente primeiro, nunca de outro workflow', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'A', { workflowId: '3003', subworkflowId: '3004' });
  world.clock.advance(60_000);
  seedAgreement(world, 'B', { workflowId: '3003', subworkflowId: '3005' });
  world.clock.advance(60_000);
  seedAgreement(world, 'C', { workflowId: '3999', subworkflowId: '3999' });

  assert.deepEqual(world.repo.listByWorkflow('3003').map((r) => r.id), ['B', 'A']);
  assert.deepEqual(world.repo.listByWorkflow(3003, 3004).map((r) => r.id), ['A']);
  assert.deepEqual(world.repo.listByWorkflow('3003', '3999').map((r) => r.id), [], 'subprocesso de outro workflow');
  assert.deepEqual(world.repo.listByWorkflow('1234'), []);
  await world.close();
});

/* ---------- serviço: seleção do acordo ---------- */

test('cancelWorkflow: um acordo aberto => consulta o Adobe, cancela e o encerra com o evento no histórico', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');

  const out = await world.cancellation.cancelWorkflow('3003', { comment: 'documento duplicado' });
  assert.deepEqual(
    [out.agreementId, out.cancelled, out.alreadyCancelled, out.marked, out.adobeStatus],
    ['AG-1', true, false, true, 'CANCELLED']
  );

  // o estado é consultado ANTES do cancelamento
  const names = world.calls.map((c) => c[0]);
  assert.ok(names.indexOf('adobe.getAgreement') < names.indexOf('adobe.cancelAgreement'));
  assert.deepEqual(world.adobe.cancelled, [{ id: 'AG-1', comment: 'documento duplicado', notifyOthers: false }]);

  const rec = world.repo.get('AG-1');
  assert.deepEqual(
    [rec.state, rec.sendonDone, rec.finalKind, rec.disposition, rec.completedExternally, rec.adobeStatus, rec.cancelSource],
    ['cancelled', true, 'final_recalled', null, false, 'CANCELLED', 'admin']
  );
  assert.equal(rec.cancelRequestedAt, world.clock.now().toISOString());
  const [ev] = world.repo.listEvents('AG-1');
  assert.deepEqual([ev.event, ev.source, ev.kind], ['CANCEL_REQUESTED', 'cancel', 'cancel_requested']);
  assert.equal(ev.summary.comment, 'documento duplicado');
  assert.equal(ev.summary.alreadyCancelled, false);

  // o orquestrador não toca no fluxo original: nem SendOn nem PDF
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.versions.length + world.otcs.uploads.length, 0);
  await world.close();
});

test('CANCEL_NOTIFY_SIGNERS liga o aviso aos signatários; comentário vazio usa o padrão e o longo é cortado', async () => {
  const world = await buildWorld({ env: { CANCEL_NOTIFY_SIGNERS: 'true' } });
  open(world, 'AG-1');
  open(world, 'AG-2', { workflowId: '4004', subworkflowId: '4004' });

  await world.cancellation.cancelAgreement('AG-1', { comment: '   ' });
  await world.cancellation.cancelAgreement('AG-2', { comment: `${'x'.repeat(900)}\n\t` });
  assert.deepEqual(world.adobe.cancelled[0], { id: 'AG-1', comment: 'Flujo cancelado desde Content Server.', notifyOthers: true });
  assert.equal(world.adobe.cancelled[1].comment.length, 500);
  assert.ok(!/[\u0000-\u001f]/.test(world.adobe.cancelled[1].comment));
  await world.close();
});

test('cancelWorkflow: vários abertos sem subprocesso => ambíguo com a lista e nenhum é cancelado; com subprocesso cancela só o dele', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { subworkflowId: '3004' });
  world.clock.advance(1000);
  open(world, 'AG-2', { subworkflowId: '3005' });

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.equal(err.status, 409);
  assert.equal(err.body.code, 'AMBIGUOUS');
  assert.deepEqual(err.body.agreements.map((a) => [a.id, a.subworkflowId]), [['AG-2', '3005'], ['AG-1', '3004']]);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.repo.get('AG-1').sendonDone || world.repo.get('AG-2').sendonDone, false);

  const out = await world.cancellation.cancelWorkflow('3003', { subworkflowId: '3005' });
  assert.equal(out.agreementId, 'AG-2');
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-2']);
  assert.equal(world.repo.get('AG-1').state, 'pending', 'o acordo do outro subprocesso não é tocado');

  // agora só resta um aberto: sem subprocesso, é o alvo
  assert.equal((await world.cancellation.cancelWorkflow('3003')).agreementId, 'AG-1');
  await world.close();
});

test('cancelWorkflow: nunca escolhe o acordo de outro subprocesso nem de outro workflow', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { workflowId: '3003', subworkflowId: '3004' });

  const err = await failure(world.cancellation.cancelWorkflow('3003', { subworkflowId: '3999' }));
  assert.equal(err.status, 404);
  assert.equal((await failure(world.cancellation.cancelWorkflow('4444'))).status, 404);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'pending');
  await world.close();
});

test('cancelWorkflow/cancelAgreement: nenhum acordo => 404 com dica de adoção (POST /admin/adopt/:id)', async () => {
  const world = await buildWorld();
  const noWorkflow = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.equal(noWorkflow.status, 404);
  assert.equal(noWorkflow.body.code, 'AGREEMENT_NOT_FOUND');
  assert.match(noWorkflow.body.hint, /POST \/admin\/adopt\//);

  const noAgreement = await failure(world.cancellation.cancelAgreement('AG-X'));
  assert.equal(noAgreement.status, 404);
  assert.match(noAgreement.body.hint, /POST \/admin\/adopt\//);

  // ids inválidos
  assert.equal((await failure(world.cancellation.cancelWorkflow('abc'))).status, 422);
  assert.equal((await failure(world.cancellation.cancelWorkflow('3003', { subworkflowId: '30x4' }))).status, 422);
  assert.equal(world.calls.filter((c) => c[0].startsWith('adobe.')).length, 0, 'nada vai ao Adobe');
  await world.close();
});

/* ---------- serviço: estado no Adobe ---------- */

test('já CANCELLED no Adobe: idempotente, não chama o cancelamento e fecha o registro; repetir não muda nada', async () => {
  for (const status of ['CANCELLED', 'ABORTED']) {
    const world = await buildWorld();
    open(world, 'AG-1');
    world.adobe.agreements['AG-1'].status = status;

    const out = await world.cancellation.cancelWorkflow('3003');
    assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, true, true], status);
    assert.ok(!world.calls.some((c) => c[0] === 'adobe.cancelAgreement'), 'cancelamento não chamado');
    const rec = world.repo.get('AG-1');
    assert.deepEqual([rec.state, rec.sendonDone, rec.adobeStatus], ['cancelled', true, status]);
    assert.equal(world.repo.listEvents('AG-1')[0].summary.alreadyCancelled, true);

    // segunda chamada: o mais recente já foi encerrado por pedido => ok, sem gravar de novo
    const again = await world.cancellation.cancelWorkflow('3003');
    assert.deepEqual([again.cancelled, again.alreadyCancelled, again.marked], [true, true, false]);
    assert.equal(world.repo.listEvents('AG-1').length, 1);
    assert.equal(world.adobe.cancelled.length, 0);
    // o histórico só é lido na 1ª vez (CANCELLED); a repetição de um cancelamento nosso (cancelRequestedAt) não o consulta
    assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, status === 'CANCELLED' ? 1 : 0, status);
    await world.close();
  }
});

test('cancelamento repetido depois do sucesso: o Adobe é reconsultado, nada é cancelado de novo', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  await world.cancellation.cancelWorkflow('3003');
  const again = await world.cancellation.cancelWorkflow('3003');
  assert.deepEqual([again.alreadyCancelled, again.marked], [true, false]);
  assert.equal(world.adobe.cancelled.length, 1);
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 2);
  assert.ok(!world.calls.some((c) => c[0] === 'adobe.getAgreementEvents'), 'a repetição não consulta o histórico');
  await world.close();
});

test('já assinado (SIGNED) => 409 legível e nada é marcado; outros estados finais também não cancelam', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  world.adobe.agreements['AG-1'].status = 'SIGNED';

  const signed = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.equal(signed.status, 409);
  assert.equal(signed.body.code, 'ALREADY_SIGNED');
  assert.match(signed.body.error, /ya fue firmado/);

  world.adobe.agreements['AG-1'].status = 'EXPIRED';
  const expired = await failure(world.cancellation.cancelAgreement('AG-1'));
  assert.deepEqual([expired.status, expired.body.code, expired.body.adobeStatus], [409, 'NOT_CANCELABLE', 'EXPIRED']);

  assert.equal(world.adobe.cancelled.length, 0);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelRequestedAt, rec.finalKind], ['pending', false, null, null]);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  await world.close();
});

test('falha do Adobe (consulta ou cancelamento) => 503 transitório, nada é marcado e repetir funciona', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');

  world.adobe.cancelFailures = 1; // o PUT falha
  const failed = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([failed.status, failed.body.code], [503, 'ADOBE_UNAVAILABLE']);
  let rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelRequestedAt], ['pending', false, null]);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  assert.ok(world.logger.has('error', /no confirmó la cancelación/));
  // o hold foi liberado: a reconciliação do acordo volta a andar
  assert.notEqual((await world.reconciliation.reconcile('AG-1')).status, 'held');

  const realGet = world.adobe.getAgreement;
  world.adobe.getAgreement = async () => { throw httpError(500, 'adobe down'); }; // a consulta falha
  assert.equal((await failure(world.cancellation.cancelWorkflow('3003'))).status, 503);
  assert.equal(world.adobe.cancelled.length, 0);
  world.adobe.getAgreement = async () => { throw httpError(404, 'gone'); };      // acordo apagado no Adobe
  assert.equal((await failure(world.cancellation.cancelWorkflow('3003'))).status, 404);
  world.adobe.getAgreement = realGet;

  const out = await world.cancellation.cancelWorkflow('3003');
  assert.equal(out.cancelled, true);
  rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone], ['cancelled', true]);
  await world.close();
});

test('resposta do cancelamento perdida, mas aplicada no Adobe: a reconsulta confirma, o acordo é fechado e não há disposição', async () => {
  for (const finalStatus of ['CANCELLED', 'ABORTED']) {
    const world = await buildWorld();
    open(world, 'AG-1');
    world.adobe.cancelLostResponses = 1; // o Adobe aplica, mas o chamador só vê o erro (timeout / 5xx do proxy)
    if (finalStatus === 'ABORTED') world.adobe.onCancel = async (id) => { world.adobe.agreements[id].status = 'ABORTED'; };

    const out = await world.cancellation.cancelWorkflow('3003');
    assert.deepEqual(
      [out.cancelled, out.alreadyCancelled, out.marked, out.adobeStatus], [true, false, true, finalStatus], finalStatus
    );
    assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 2, 'consulta antes + reconsulta após o erro');
    assert.equal(world.adobe.cancelled.length, 1, 'o cancelamento não é pedido de novo');
    const rec = world.repo.get('AG-1');
    assert.deepEqual([rec.state, rec.sendonDone, rec.adobeStatus, rec.disposition], ['cancelled', true, finalStatus, null]);
    const [ev] = world.repo.listEvents('AG-1');
    assert.deepEqual([ev.event, ev.summary.alreadyCancelled, ev.summary.adobeStatus], ['CANCEL_REQUESTED', false, finalStatus]);
    assert.ok(world.logger.has('warn', /la respuesta de Adobe se perdió, pero Adobe confirma la cancelación/));

    // o eco do RECALLED e a fila não geram disposição
    assert.equal(recalled(world, 'AG-1').processing, undefined);
    assert.deepEqual(await world.reconciliation.runQueue(), []);
    assert.equal(world.otcs.sendons.length, 0);
    await world.close();
  }
});

test('erro no cancelamento e a reconsulta mostra o acordo em andamento => 503 ADOBE_UNAVAILABLE e nada é marcado', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  world.adobe.cancelFailures = 1; // o Adobe NÃO aplicou

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([err.status, err.body.code], [503, 'ADOBE_UNAVAILABLE']);
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 2, 'a reconsulta foi feita');
  assert.equal(world.adobe.cancelled.length, 0);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelRequestedAt], ['pending', false, null]);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  assert.ok(!world.logger.has('warn', /la respuesta de Adobe se perdió/));
  await world.close();
});

test('erro no cancelamento e a reconsulta também falha => 503 e nada é marcado; repetir depois fecha o acordo', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  world.adobe.cancelLostResponses = 1; // o Adobe aplicou, mas não há como saber
  const realGet = world.adobe.getAgreement;
  let reads = 0;
  world.adobe.getAgreement = async (id) => {
    if (++reads > 1) throw httpError(500, 'adobe down'); // só a consulta inicial funciona
    return realGet(id);
  };

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([err.status, err.body.code], [503, 'ADOBE_UNAVAILABLE']);
  assert.equal(reads, 2);
  assert.ok(world.logger.has('error', /tampoco se pudo reconsultar el estado en Adobe/));
  let rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelRequestedAt], ['pending', false, null]);
  assert.notEqual((await world.reconciliation.reconcile('AG-1')).status, 'held', 'o hold foi liberado');

  // repetir: o Adobe já está CANCELLED => idempotente, e o acordo é fechado
  world.adobe.getAgreement = realGet;
  const retry = await world.cancellation.cancelWorkflow('3003');
  assert.deepEqual([retry.cancelled, retry.alreadyCancelled, retry.marked], [true, true, true]);
  rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone], ['cancelled', true]);
  await world.close();
});

test('mais recente já concluído por outro caminho => 409; um reenvio aberto depois vira o alvo; encerrado por cancelamento é idempotente', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { state: 'completed', finalKind: 'final_ok', sendonDone: true, startSendonDone: true });

  const closed = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([closed.status, closed.body.code, closed.body.agreement.id], [409, 'AGREEMENT_CLOSED', 'AG-1']);
  assert.match(closed.body.hint, /POST \/admin\/cancel\//);
  assert.equal(world.adobe.cancelled.length, 0);

  // reenvio (acordo novo, aberto) depois do concluído: é o alvo
  world.clock.advance(60_000);
  open(world, 'AG-2');
  assert.equal((await world.cancellation.cancelWorkflow('3003')).agreementId, 'AG-2');
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-2']);

  // e repetir cancela de forma idempotente o mesmo (o AG-1 concluído não entra)
  const again = await world.cancellation.cancelWorkflow('3003');
  assert.deepEqual([again.agreementId, again.alreadyCancelled], ['AG-2', true]);
  await world.close();
});

test('cancelAgreement de acordo que o pipeline já deu por concluído (Adobe ainda aberto): cancela e só acrescenta a marca', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', {
    state: 'completed', finalKind: 'final_ok', sendonDone: true, completedExternally: true, startSendonDone: true,
    disposition: null
  });

  const out = await world.cancellation.cancelAgreement('AG-1', { source: 'admin' });
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, false, true]);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.finalKind, rec.completedExternally, rec.sendonDone], ['completed', 'final_ok', true, true]);
  assert.equal(rec.cancelSource, 'admin');
  assert.ok(rec.cancelRequestedAt);
  assert.equal(rec.adobeStatus, 'CANCELLED');
  await world.close();
});

test('dois pedidos simultâneos para o mesmo acordo: o segundo recebe 409 IN_PROGRESS e só um cancelamento é feito', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  let unblock;
  world.adobe.onCancel = () => new Promise((resolve) => { unblock = resolve; });

  const first = world.cancellation.cancelAgreement('AG-1');
  await waitFor(() => world.adobe.cancelled.length === 1);
  const err = await failure(world.cancellation.cancelAgreement('AG-1'));
  assert.deepEqual([err.status, err.body.code], [409, 'IN_PROGRESS']);

  unblock();
  assert.equal((await first).cancelled, true);
  assert.equal(world.adobe.cancelled.length, 1);
  await world.close();
});

/* ---------- recusa do signatário (CANCELLED no Adobe) ---------- */

// Registro de um acordo que NÃO pode ter sido tocado pelo cancelamento
function assertUntouched(world, id = 'AG-1') {
  const rec = world.repo.get(id);
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelRequestedAt, rec.cancelSource], ['pending', false, null, null]);
  assert.equal(world.repo.listEvents(id).length, 0, 'sem evento CANCEL_REQUESTED');
}
const rejectedInAdobe = (world, id = 'AG-1') => {
  world.adobe.agreements[id].status = 'CANCELLED';
  world.adobe.events[id] = [{ type: 'ACTION_REJECTED' }];
};

test('recusa do signatário com o Rechazado ainda pendente: 409 ALREADY_REJECTED, registro intacto e o pipeline entrega o Rechazado', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true, finalKind: 'final_rejected', sendonDone: false });
  rejectedInAdobe(world);

  for (const run of [() => world.cancellation.cancelWorkflow('3003'), () => world.cancellation.cancelAgreement('AG-1')]) {
    const err = await failure(run());
    assert.deepEqual([err.status, err.body.code, err.body.agreementId, err.body.adobeStatus], [409, 'ALREADY_REJECTED', 'AG-1', 'CANCELLED']);
    assert.match(err.body.error, /rechazado por un firmante/);
    const rec = world.repo.get('AG-1');
    assert.deepEqual([rec.finalKind, rec.sendonDone, rec.cancelRequestedAt, rec.state], ['final_rejected', false, null, 'pending']);
    assert.equal(world.repo.listEvents('AG-1').length, 0);
  }
  assert.equal(world.adobe.cancelled.length, 0);
  assert.ok(world.logger.has('warn', /rechazado por un firmante; no se cancela/));

  // o hold foi liberado e o pipeline segue: o Rechazado chega ao fluxo original
  await world.reconciliation.runQueue();
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => [s.workflowId, s.disposition]), [[3003, 'Rechazado']]);
  assert.equal(world.repo.get('AG-1').sendonDone, true);
  await world.close();
});

test('recusa ainda não registrada pelo pipeline (sem finalKind): 409 ALREADY_REJECTED e nada é marcado', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  rejectedInAdobe(world);

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([err.status, err.body.code], [409, 'ALREADY_REJECTED']);
  assertUntouched(world);
  assert.equal(world.adobe.cancelled.length, 0);
  await world.close();
});

test('CANCELLED sem poder ler o histórico: 503 ADOBE_UNAVAILABLE, nada marcado; com o histórico de volta (recall) cancela de forma idempotente', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  world.adobe.agreements['AG-1'].status = 'CANCELLED';
  world.adobe.eventsError = httpError(500, 'events down');

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([err.status, err.body.code], [503, 'ADOBE_UNAVAILABLE']);
  assert.ok(world.logger.has('error', /no se pudo consultar el historial del acuerdo/));
  assertUntouched(world);
  assert.notEqual((await world.reconciliation.reconcile('AG-1')).status, 'held', 'o hold foi liberado');

  world.adobe.eventsError = null; // sem evento de recusa: foi recall
  const out = await world.cancellation.cancelWorkflow('3003');
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, true, true]);
  await world.close();
});

test('recusa entre o GET e o PUT (o PUT falha e a reconsulta mostra CANCELLED por recusa): 409 ALREADY_REJECTED e nada é marcado', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  world.adobe.cancelFailures = 1; // o Adobe recusa o PUT porque o acordo já terminou
  const realCancel = world.adobe.cancelAgreement;
  world.adobe.cancelAgreement = async (id, o) => {
    rejectedInAdobe(world, id); // o signatário recusa depois do GET e antes da reconsulta
    return realCancel(id, o);
  };

  const err = await failure(world.cancellation.cancelWorkflow('3003'));
  assert.deepEqual([err.status, err.body.code, err.body.adobeStatus], [409, 'ALREADY_REJECTED', 'CANCELLED']);
  assert.equal(world.adobe.cancelled.length, 0);
  assertUntouched(world);

  await world.close();
});

test('PUT falha, a reconsulta mostra CANCELLED e o histórico é ilegível: vale a cancelação própria (200), sem eco; com recusa já gravada: 409', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  open(world, 'AG-2', { workflowId: '4004', subworkflowId: '4004', startSendonDone: true, finalKind: 'final_rejected' });
  const realCancel = world.adobe.cancelAgreement;
  world.adobe.cancelAgreement = async (id, o) => {
    world.adobe.agreements[id].status = 'CANCELLED'; // o PUT foi aplicado (ou o acordo já terminou) e a resposta se perdeu
    world.adobe.eventsError = httpError(500, 'events down');
    return realCancel(id, o);
  };

  // recusa já gravada por webhook: 409, nada marcado
  world.adobe.cancelFailures = 1;
  const rejected = await failure(world.cancellation.cancelAgreement('AG-2'));
  assert.deepEqual([rejected.status, rejected.body.code], [409, 'ALREADY_REJECTED']);
  const rec2 = world.repo.get('AG-2');
  assert.deepEqual([rec2.finalKind, rec2.sendonDone, rec2.cancelRequestedAt, rec2.state], ['final_rejected', false, null, 'pending']);
  assert.equal(world.repo.listEvents('AG-2').length, 0);

  // sem recusa gravada: cancelação confirmada, com aviso
  world.adobe.cancelFailures = 1;
  const out = await world.cancellation.cancelAgreement('AG-1');
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked, out.adobeStatus], [true, false, true, 'CANCELLED']);
  assert.ok(world.logger.has('warn', /historial no legible; se asume la cancelación propia/));
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.disposition], ['cancelled', true, null]);

  // o eco do RECALLED e a fila não geram disposição (histórico legível: só a marcação impede o Rechazado)
  world.adobe.eventsError = null;
  world.adobe.events['AG-1'] = [{ type: 'RECALLED' }];
  assert.equal(recalled(world, 'AG-1').processing, undefined);
  await world.reconciliation.runQueue();
  assert.ok(!world.otcs.sendons.some((s) => s.workflowId === 3003), 'nada no fluxo cancelado');
  await world.close();
});

test('POST /admin/cancel/:id de acordo recusado cujo Rechazado já foi entregue: 409 ALREADY_REJECTED (antes era 200 alreadyCancelled)', async () => {
  const world = await buildWorld({ listen: true });
  open(world, 'AG-1', { startSendonDone: true, state: 'completed', finalKind: 'final_rejected', sendonDone: true });
  rejectedInAdobe(world);

  const r = await post(world, '/admin/cancel/AG-1', {}, ADMIN);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.deepEqual([body.code, body.agreementId, body.adobeStatus], ['ALREADY_REJECTED', 'AG-1', 'CANCELLED']);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.cancelRequestedAt, rec.finalKind], ['completed', null, 'final_rejected']);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  assert.equal(world.adobe.cancelled.length, 0);
  await world.close();
});

/* ---------- espera pela reconciliação em curso ---------- */

// A primeira leitura do Adobe (a da reconciliação) fica presa até `open()`; devolve o estado do Adobe NESSE momento
function gateFirstRead(world) {
  const realGet = world.adobe.getAgreement;
  let first = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  world.adobe.getAgreement = async (id) => {
    if (!first) return realGet(id);
    first = false;
    world.calls.push(['adobe.getAgreement', id]);
    await gate;
    return world.adobe.agreements[id];
  };
  return { open: () => { world.calls.push(['test.gateOpened']); release(); } };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reads = (world) => world.calls.filter((c) => c[0] === 'adobe.getAgreement').length;

test('reconciliação já em curso: o cancelamento espera, só então consulta/cancela o Adobe e nenhum Rechazado sai', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  const gate = gateFirstRead(world);

  const running = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);
  const cancelling = world.cancellation.cancelAgreement('AG-1');
  await sleep(50);
  assert.equal(reads(world), 1, 'o cancelamento ainda não consultou o Adobe');
  assert.equal(world.adobe.cancelled.length, 0);

  gate.open();
  const out = await cancelling;
  assert.equal((await running).status, 'no_final');
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, false, true]);

  const names = world.calls.map((c) => c[0]);
  assert.ok(names.indexOf('test.gateOpened') < names.lastIndexOf('adobe.getAgreement'), 'a consulta do cancelamento veio depois');
  assert.ok(names.indexOf('test.gateOpened') < names.indexOf('adobe.cancelAgreement'));
  assert.equal(world.otcs.sendons.length, 0, 'nenhum Rechazado no fluxo original');
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.disposition], ['cancelled', true, null]);
  await world.close();
});

test('reconciliação em curso que conclui por outro caminho: recall já entregue => idempotente sem marcar; assinado => 409 ALREADY_SIGNED', async () => {
  // recall feito direto no Adobe: a reconciliação entrega o Rechazado antes de o cancelamento olhar
  let world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  let gate = gateFirstRead(world);
  let running = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);
  let cancelling = world.cancellation.cancelAgreement('AG-1');
  await sleep(20);
  world.adobe.agreements['AG-1'].status = 'CANCELLED';
  world.adobe.events['AG-1'] = [{ type: 'RECALLED' }];
  gate.open();
  const out = await cancelling;
  assert.equal((await running).status, 'completed');
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, true, false]);
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Rechazado']);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.repo.get('AG-1').cancelRequestedAt, null);
  await world.close();

  // assinado enquanto a reconciliação rodava
  world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  gate = gateFirstRead(world);
  running = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);
  cancelling = world.cancellation.cancelAgreement('AG-1');
  await sleep(20);
  world.adobe.agreements['AG-1'].status = 'SIGNED';
  gate.open();
  const err = await failure(cancelling);
  assert.equal((await running).status, 'completed');
  assert.deepEqual([err.status, err.body.code], [409, 'ALREADY_SIGNED']);
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Firmado']);
  assert.equal(world.adobe.cancelled.length, 0);
  await world.close();
});

test('settle também espera a reconciliação enfileirada (coalescida): o 2º reconcile devolve held e nenhum Rechazado sai', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  const gate = gateFirstRead(world);

  const first = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);
  const second = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true }); // fica na fila
  const cancelling = world.cancellation.cancelAgreement('AG-1');
  await sleep(50);
  assert.equal(reads(world), 1);
  assert.equal(world.adobe.cancelled.length, 0);

  gate.open();
  const out = await cancelling;
  assert.equal((await first).status, 'no_final');
  assert.equal((await second).status, 'held', 'a execução enfileirada começou depois do hold');
  assert.equal(out.cancelled, true);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'cancelled');
  await world.close();
});

test('reconciliação presa além de CANCEL_SETTLE_TIMEOUT_MS: 503 RECONCILE_IN_PROGRESS sem tocar o Adobe, hold liberado e novo cancelamento funciona', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  world.config.cancel.settleTimeoutMs = 40; // o mínimo de 1000 ms vale só para a variável de ambiente
  const gate = gateFirstRead(world);

  const running = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);

  const err = await failure(world.cancellation.cancelAgreement('AG-1'));
  assert.deepEqual([err.status, err.body.code], [503, 'RECONCILE_IN_PROGRESS']);
  assert.match(err.body.error, /reconciliación en curso/);
  assert.equal(reads(world), 1, 'nenhuma consulta do cancelamento ao Adobe');
  assert.ok(!world.calls.some((c) => c[0] === 'adobe.cancelAgreement'));
  assertUntouched(world);

  // o inflight também foi liberado: outro pedido recebe a mesma resposta (e não IN_PROGRESS)
  assert.equal((await failure(world.cancellation.cancelAgreement('AG-1'))).body.code, 'RECONCILE_IN_PROGRESS');

  gate.open();
  await running;
  assert.notEqual((await world.reconciliation.reconcile('AG-1')).status, 'held', 'o hold foi liberado');
  const out = await world.cancellation.cancelAgreement('AG-1');
  assert.deepEqual([out.cancelled, out.alreadyCancelled, out.marked], [true, false, true]);
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

test('lote: a espera pela reconciliação é limitada ao tempo restante do prazo (RECONCILE_IN_PROGRESS pending, antes do settleTimeoutMs); admin usa o settleTimeoutMs inteiro', async () => {
  const world = await buildWorld();
  open(world, 'AG-1', { startSendonDone: true });
  seedCancelFlow(world); // alvo 3003 = AG-1
  world.config.cancel.settleTimeoutMs = 5000;
  world.config.cancel.batchBudgetMs = 60; // restante do prazo << settleTimeoutMs
  const gate = gateFirstRead(world);
  const running = world.reconciliation.reconcile('AG-1', { refresh: true, force: true, manual: true });
  await waitFor(() => reads(world) === 1);

  const t0 = Date.now();
  const out = await world.cancellation.cancelFromTask({ workflowId: '9001', subworkflowId: '9001' });
  assert.ok(Date.now() - t0 < 2000, 'não esperou o settleTimeoutMs (5 s) inteiro');
  assert.deepEqual([out.complete, out.sentOn], [false, false]);
  assert.deepEqual([out.items[0].outcome, out.items[0].code], ['pending', 'RECONCILE_IN_PROGRESS']);
  assert.equal(reads(world), 1, 'nada foi consultado no Adobe pelo cancelamento');
  assert.ok(!world.calls.some((c) => c[0] === 'adobe.cancelAgreement'));
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assertUntouched(world);

  // rota admin (sem a opção interna): espera o settleTimeoutMs inteiro, então uma reconciliação que termina depois do
  // prazo do lote (60 ms) ainda é aguardada e o cancelamento acontece
  setTimeout(() => gate.open(), 200);
  const admin = await world.cancellation.cancelWorkflow('3003');
  assert.deepEqual([admin.cancelled, admin.marked], [true, true]);
  await running;
  await world.close();
});

/* ---------- AGREEMENT_RECALLED depois do cancelamento: sem disposição ---------- */

test('RECALLED por webhook depois do cancelamento: vai ao histórico, sem SendOn, PDF nem reconciliação', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  // contraste: um acordo cancelado FORA deste fluxo (direto no Adobe) continua gerando Rechazado
  open(world, 'AG-2', { workflowId: '4004', subworkflowId: '4004' });

  await world.cancellation.cancelWorkflow('3003');
  const callsBefore = world.calls.length;

  const result = recalled(world, 'AG-1');
  assert.equal(result.known, true);
  assert.equal(result.processing, undefined, 'hasPendingWork é falso: nenhuma reconciliação é disparada');
  assert.equal(world.calls.length, callsBefore, 'nenhuma chamada ao Adobe/OTCS');
  assert.deepEqual(world.otcs.dispositionCalls(), []);
  assert.deepEqual(world.repo.listEvents('AG-1').map((e) => e.event), ['AGREEMENT_RECALLED', 'CANCEL_REQUESTED']);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.disposition, rec.finalKind], ['cancelled', true, null, 'final_recalled']);

  world.adobe.agreements['AG-2'].status = 'CANCELLED'; // cancelado direto no Adobe (sem recusa nos eventos): recall
  const outside = recalled(world, 'AG-2');
  await outside.processing;
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => [s.workflowId, s.disposition]), [[4004, 'Rechazado']]);
  await world.close();
});

test('RECALLED por polling/reconcile depois do cancelamento: acordo fora do polling e reconcile devolve done', async () => {
  const world = await buildWorld({ env: { POLL_ENABLED: 'true' } });
  open(world, 'AG-1');
  await world.cancellation.cancelWorkflow('3003');
  const callsBefore = world.calls.length;

  // polling: o acordo concluído não é consultado e a fila não o reprocessa
  assert.deepEqual(world.repo.listPollable().map((r) => r.id), []);
  const summary = await world.poller.tick();
  assert.deepEqual([summary.polled, summary.finalized, summary.retried], [0, 0, 0]);
  assert.equal(world.calls.length, callsBefore);

  // mesmo se o estado CANCELLED do Adobe chegar por outro caminho (handleStatus/reconcile manual): done, sem SendOn
  assert.equal(await world.reconciliation.handleStatus('AG-1', 'CANCELLED'), 'final_recalled');
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'done');
  assert.equal((await world.reconciliation.reconcile('AG-1', { force: true, refresh: true, manual: true })).status, 'done');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'cancelled');
  await world.close();
});

test('fila de retry: acordo com início pendente ou em backoff sai da fila ao ser cancelado', async () => {
  const world = await buildWorld();
  // SendOn da tarefa de início ainda não enviado (workflow na tarefa de início)
  open(world, 'AG-1', { startSendonDone: false, attempts: 2, lastError: 'sendon failed', lastErrorStage: 'start' });
  assert.deepEqual(world.repo.listPending().map((r) => r.id), ['AG-1']);

  await world.cancellation.cancelAgreement('AG-1');
  assert.deepEqual(world.repo.listPending().map((r) => r.id), []);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.startSendonDone, rec.attempts, rec.lastError, rec.nextAttemptAt], [true, 0, null, null]);

  assert.deepEqual(await world.reconciliation.runQueue(), []);
  assert.equal(world.otcs.sendons.length, 0, 'o SendOn de início não sai depois do cancelamento');
  await world.close();
});

test('RECALLED que chega ANTES de o acordo ser marcado (durante o PUT): a reconciliação espera e não gera disposição', async () => {
  const world = await buildWorld();
  open(world, 'AG-1');
  let during;
  // o Adobe emite o webhook antes de o orquestrador receber a resposta do PUT
  world.adobe.onCancel = async (id) => {
    const r = recalled(world, id);
    assert.equal(r.known, true);
    assert.ok(r.processing, 'o evento final dispara a reconciliação');
    during = await r.processing;
  };

  const out = await world.cancellation.cancelWorkflow('3003');
  assert.equal(out.cancelled, true);
  assert.equal(during.status, 'held', 'a reconciliação do acordo fica em espera durante o cancelamento');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.versions.length + world.otcs.uploads.length, 0);

  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.disposition], ['cancelled', true, null]);
  assert.deepEqual(world.repo.listEvents('AG-1').map((e) => e.event).sort(), ['AGREEMENT_RECALLED', 'CANCEL_REQUESTED']);
  // hold liberado
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'done');
  await world.close();
});

/* ---------- POST /cancel (WebReport, lote) e POST /cancel/preview ---------- */

// Mundo com o workflow de cancelamento apontando para `target` (lista, escalar ou texto) e um acordo aberto por fluxo de `wfIds`
async function batchWorld(wfIds, { target = wfIds, env = {}, fields = {} } = {}) {
  const world = await cancelWorld(env);
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': target, ...fields } });
  for (const id of wfIds) open(world, `AG-${id}`, { workflowId: String(id), subworkflowId: String(id) });
  return world;
}

const preflight = (world, p) => fetch(`${world.baseUrl}${p}`, {
  method: 'OPTIONS', headers: { origin: OTCS_ORIGIN, 'access-control-request-method': 'POST' }
});

test('POST /cancel e /cancel/preview desligados (padrão): 404 mesmo com assinatura válida, sem CORS e sem tocar Adobe/OTCS', async () => {
  const world = await buildWorld({ listen: true, env: { OTCS_BASE: `${OTCS_ORIGIN}/cs/cs/api` } });
  assert.equal(world.config.cancel.enabled, false);
  seedCancelFlow(world);
  open(world, 'AG-1');

  for (const p of ['/cancel', '/cancel/preview']) {
    const r = await authThenCancel(world, undefined, { path: p });
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
    const pre = await preflight(world, p);
    assert.equal(pre.status, 404, `preflight ${p}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
  }

  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'pending');
  assert.equal(world.otcs.modelCalls.length, 0, 'nem o OTCS foi consultado');
  await world.close();
});

test('POST /cancel ligado: cancela o fluxo do atributo, grava os cancelados no formulário e faz o SendOn', async () => {
  const world = await cancelWorld({ OTCS_BASE: `${OTCS_ORIGIN}/cs/cs/api` });
  seedCancelFlow(world); // atributo "ID Flujo a Cancelar" = 3003
  open(world, 'AG-1');

  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), {
    complete: true,
    sentOn: true,
    items: [{
      workflowId: '3003', outcome: 'cancelled', agreementId: 'AG-1', alreadyCancelled: false, adobeStatus: 'CANCELLED',
      contentStop: 'disabled', message: 'Acuerdo cancelado.'
    }],
    summary: { total: 1, cancelled: 1, refused: 0, pending: 0 },
    resultField: 'IDs Cancelados',
    stopOriginal: false,
    subworkflowIgnored: false
  });

  assert.equal(world.adobe.cancelled.length, 1);
  assert.match(world.adobe.cancelled[0].comment, /workflow de cancelación 9001/);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelSource], ['cancelled', true, 'workflow:9001/9001']);

  // Resultado no formulário da tarefa de cancelamento (lista de WorkIDs, chave do campo lida do formulário)
  assert.deepEqual(world.otcs.updateFormCalls, [{ processId: 9001, subprocessId: 9001, taskId: 2, values: { k_IDsCancelados: ['3003'] } }]);

  // SendOn (sem disposição) da tarefa do workflow de cancelamento, DEPOIS do cancelamento e da gravação
  assert.equal(world.otcs.sendons.length, 1);
  const sendon = world.otcs.sendons[0];
  assert.deepEqual([sendon.workflowId, sendon.subworkflowId, sendon.taskId, sendon.disposition], [9001, 9001, 2, undefined]);
  assert.match(sendon.comment, /Cancelados \(1\): 3003/);
  assert.doesNotMatch(sendon.comment, /No cancelados/);
  const names = world.calls.map((c) => c[0]);
  assert.ok(names.indexOf('adobe.cancelAgreement') < names.indexOf('otcs.sendon'));
  assert.equal(world.otcs.task('9001', 2).status, 'completed');
  assert.equal(world.otcs.task('9001', 3).status, 'current');
  // o fluxo original não é tocado pelo orquestrador
  assert.equal(world.otcs.task('3003', 3).status, 'current');
  assert.ok(world.otcs.sendons.every((s) => s.workflowId === 9001));

  // CORS como no /start: origem do OTCS (as duas rotas)
  for (const p of ['/cancel', '/cancel/preview']) {
    const pre = await preflight(world, p);
    assert.equal(pre.headers.get('access-control-allow-origin'), OTCS_ORIGIN, p);
  }
  await world.close();
});

test('POST /cancel e /cancel/preview: HMAC v2 e nonce — sem assinatura, adulterado, repetido, expirado e v1 são recusados sem cancelar', async () => {
  const world = await cancelWorld({ START_LEGACY_SIGNATURE: 'true' });
  seedCancelFlow(world);
  open(world, 'AG-1');
  const fields = { workflowId: '9001', subworkflowId: '9001' };

  // a prévia exige a mesma assinatura (nenhuma consulta ao Adobe/OTCS sem ela)
  assert.equal((await post(world, '/cancel/preview', fields)).status, 401, 'prévia sem assinatura');
  assert.equal((await post(world, '/cancel/preview', { ...fields, timestamp: '1', signature: 'zz' })).status, 400);
  assert.equal((await authThenCancel(world, fields, { path: '/cancel/preview', tamper: { workflowId: '8888' } })).status, 403);
  const v1p = await post(world, '/cancel/preview', startBodyV1(world, fields));
  assert.equal(v1p.status, 403);
  assert.deepEqual(await v1p.json(), { error: 'Unsupported signature version.' });
  const credsP = await (await post(world, '/auth', fields, ADMIN)).json();
  assert.equal((await post(world, '/cancel/preview', { ...fields, ...credsP })).status, 200);
  const replayP = await post(world, '/cancel/preview', { ...fields, ...credsP });
  assert.equal(replayP.status, 403);
  assert.deepEqual(await replayP.json(), { error: 'Solicitud ya utilizada.' });
  assert.equal(world.adobe.cancelled.length, 0);

  assert.equal((await post(world, '/cancel', fields)).status, 401, 'sem assinatura');
  assert.equal((await post(world, '/cancel', { ...fields, timestamp: '1', signature: 'zz' })).status, 400, 'malformada');
  assert.equal((await post(world, '/auth', fields)).status, 401, '/auth exige Basic Auth');

  // adulterar o workflow depois do /auth
  const tampered = await authThenCancel(world, fields, { tamper: { workflowId: '8888' } });
  assert.equal(tampered.status, 403);
  assert.deepEqual(await tampered.json(), { error: 'Invalid signature.' });

  // nonce de uso único
  const creds = await (await post(world, '/auth', fields, ADMIN)).json();
  const okBody = { ...fields, ...creds };
  assert.equal((await post(world, '/cancel', { ...okBody, signature: 'a'.repeat(64) })).status, 403);
  assert.equal((await post(world, '/cancel', okBody)).status, 200);
  const replay = await post(world, '/cancel', okBody);
  assert.equal(replay.status, 403);
  assert.deepEqual(await replay.json(), { error: 'Solicitud ya utilizada.' });

  // timestamp fora da janela de 2 min
  const old = await (await post(world, '/auth', fields, ADMIN)).json();
  world.clock.advance(3 * 60 * 1000);
  const expired = await post(world, '/cancel', { ...fields, ...old });
  assert.equal(expired.status, 403);
  assert.deepEqual(await expired.json(), { error: 'Timestamp expired.' });

  // assinatura v1 (só timestamp) é aceita no /start durante a migração, mas nunca no /cancel
  const v1 = await post(world, '/cancel', startBodyV1(world, fields));
  assert.equal(v1.status, 403);
  assert.deepEqual(await v1.json(), { error: 'Unsupported signature version.' });

  assert.equal(world.adobe.cancelled.length, 1, 'só a chamada válida cancelou');
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('POST /cancel e /cancel/preview: tarefa não atribuída ao usuário de integração => 409 REASSIGN_REQUIRED com handoff; nada é cancelado', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world, { assignee: HUMAN_USER_ID });
  open(world, 'AG-1');

  for (const path of ['/cancel/preview', '/cancel']) {
    const r = await authThenCancel(world, undefined, { path });
    assert.equal(r.status, 409, path);
    const body = await r.json();
    assert.equal(body.code, 'REASSIGN_REQUIRED');
    assert.deepEqual(body.handoff, {
      workflowId: 9001, subworkflowId: 9001, taskId: 2, integrationUserId: INTEGRATION_USER_ID, assigned: false
    });
  }
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'pending');

  // a página reatribui e repete (novo /auth: o nonce é de uso único)
  world.otcs.assign('9001', 2, INTEGRATION_USER_ID);
  assert.equal((await authThenCancel(world)).status, 200);
  assert.equal(world.adobe.cancelled.length, 1);

  // OTCS sem task_assignees: o formulário (403) decide
  const w2 = await cancelWorld();
  seedCancelFlow(w2, { assignee: HUMAN_USER_ID });
  w2.otcs.unknownAssignees('9001');
  w2.otcs.formFailure = httpError(403, 'forbidden');
  open(w2, 'AG-1');
  for (const path of ['/cancel/preview', '/cancel']) {
    const forbidden = await authThenCancel(w2, undefined, { path });
    assert.equal(forbidden.status, 409);
    assert.equal((await forbidden.json()).code, 'REASSIGN_REQUIRED');
  }
  assert.equal(w2.adobe.cancelled.length, 0);
  await world.close();
  await w2.close();
});

test('POST /cancel e /cancel/preview: tarefa fora do passo de cancelamento, workflow inexistente e OTCS fora do ar', async () => {
  const world = await cancelWorld();
  open(world, 'AG-1');

  for (const path of ['/cancel/preview', '/cancel']) {
    seedCancelFlow(world, { stage: 'done' }); // a tarefa de cancelamento já foi concluída
    let r = await authThenCancel(world, undefined, { path });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'NOT_AT_CANCEL_STEP');

    seedCancelFlow(world);
    world.otcs.workflows['9001'].tasks[1].name = 'Outra tarefa'; // sem tarefa de cancelamento no processo
    r = await authThenCancel(world, undefined, { path });
    assert.equal(r.status, 409);

    r = await authThenCancel(world, { workflowId: '7777', subworkflowId: '7777' }, { path }); // processo desconhecido (404 do OTCS)
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'Flujo no encontrado.', code: 'FLOW_NOT_FOUND' });

    seedCancelFlow(world);
    world.otcs.stepsFailures = 1;
    r = await authThenCancel(world, undefined, { path });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'OTCS_UNAVAILABLE');
    assert.equal((await authThenCancel(world, { workflowId: 'abc' }, { path })).status, 400);
  }

  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

test('POST /cancel: os fluxos alvo vêm do atributo do formulário, nunca do corpo', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': '3003' } });
  open(world, 'AG-1');                                                     // alvo real (atributo)
  open(world, 'AG-D', { workflowId: '4444', subworkflowId: '4444' });      // alvo falso, enviado pelo navegador

  const r = await authThenCancel(world, undefined, { extra: { targetWorkflowId: '4444', targetSubworkflowId: '4444' } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).items[0].agreementId, 'AG-1');
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-1']);
  assert.equal(world.repo.get('AG-D').state, 'pending');
  assert.ok(world.logger.has('warn', /targetWorkflowId=4444; se ignora/));

  // sem o atributo preenchido, o valor do corpo não substitui nada (nas duas rotas)
  const w2 = await cancelWorld();
  seedCancelFlow(w2, { fields: { 'ID Flujo a Cancelar': '' } });
  open(w2, 'AG-D', { workflowId: '4444', subworkflowId: '4444' });
  for (const path of ['/cancel', '/cancel/preview']) {
    const missing = await authThenCancel(w2, undefined, { path, extra: { targetWorkflowId: '4444' } });
    assert.equal(missing.status, 422);
    assert.equal((await missing.json()).code, 'MISSING_TARGET');
  }
  assert.equal(w2.adobe.cancelled.length, 0);
  assert.equal(w2.otcs.sendons.length, 0);
  await world.close();
  await w2.close();
});

test('lote: atributo multivalor (lista), escalar e texto separado; duplicados saem e a ordem é preservada', async () => {
  const ids = ['3101', '3102', '3103'];
  for (const target of [['3101', '3102', '3103'], '3101, 3102;3103', '3101\n3102 3103 3101', ['3101, 3102', '3103', '3102']]) {
    const world = await batchWorld(ids, { target });
    const r = await authThenCancel(world);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.deepEqual(body.items.map((i) => i.workflowId), ids, JSON.stringify(target));
    assert.deepEqual(body.summary, { total: 3, cancelled: 3, refused: 0, pending: 0 });
    assert.deepEqual(world.otcs.updateFormCalls[0].values, { k_IDsCancelados: ids });
    assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101', 'AG-3102', 'AG-3103'], 'em sequência, na ordem');
    await world.close();
  }

  // número no escalar (o forms API pode devolver number)
  const w = await batchWorld(['3101'], { target: 3101 });
  assert.equal((await authThenCancel(w)).status, 200);
  assert.deepEqual(w.adobe.cancelled.map((c) => c.id), ['AG-3101']);
  await w.close();
});

test('lote: valor inválido => 422 INVALID_TARGET com a lista; acima do limite => 422 TOO_MANY_TARGETS; nada é tocado', async () => {
  const world = await batchWorld(['3101', '3102', '3103'], { env: { CANCEL_MAX_TARGETS: '2' } });
  const check = async (target, status, code, extra = {}) => {
    seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': target } });
    for (const path of ['/cancel/preview', '/cancel']) {
      const r = await authThenCancel(world, undefined, { path });
      assert.equal(r.status, status, `${path} ${JSON.stringify(target)}`);
      const body = await r.json();
      assert.equal(body.code, code);
      for (const [k, v] of Object.entries(extra)) assert.deepEqual(body[k], v);
    }
  };
  await check(['3101', 'abc', '3102', '12x', 'abc'], 422, 'INVALID_TARGET', { invalid: ['abc', '12x'] });
  await check('3101, 3102, 3103', 422, 'TOO_MANY_TARGETS', { max: 2 });
  await check('3101 3102 3101', 200, undefined); // duplicados não contam para o limite
  assert.equal(world.config.cancel.maxTargets, 2);

  // um alvo inválido não deixa cancelar os válidos
  const w2 = await batchWorld(['3101']);
  seedCancelFlow(w2, { fields: { 'ID Flujo a Cancelar': '3101 abc' } });
  assert.equal((await authThenCancel(w2)).status, 422);
  assert.equal(w2.adobe.cancelled.length, 0);
  assert.equal(w2.otcs.sendons.length, 0);
  await world.close();
  await w2.close();
});

test('POST /cancel: subflujo inválido => 422; um alvo usa o subflujo (desempata); vários alvos o ignoram (subworkflowIgnored)', async () => {
  const world = await cancelWorld();
  open(world, 'AG-1', { subworkflowId: '3004' });
  open(world, 'AG-2', { subworkflowId: '3005' });

  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': 'abc' } });
  assert.equal((await authThenCancel(world)).status, 422);
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': null } });
  assert.equal((await authThenCancel(world)).status, 422);
  seedCancelFlow(world, { fields: { 'ID Subflujo a Cancelar': '30x5' } });
  const badSub = await authThenCancel(world);
  assert.equal(badSub.status, 422);
  const badBody = await badSub.json();
  assert.deepEqual([badBody.code, badBody.invalid], ['INVALID_TARGET', ['30x5']]);

  // sem subprocesso: dois acordos abertos => ambíguo (recusa definitiva do item), nada cancelado
  seedCancelFlow(world);
  const ambiguous = await authThenCancel(world);
  assert.equal(ambiguous.status, 200);
  const body = await ambiguous.json();
  assert.equal(body.complete, true);
  assert.deepEqual([body.items[0].outcome, body.items[0].code], ['refused', 'AMBIGUOUS']);
  assert.deepEqual(body.items[0].agreements.map((a) => a.id).sort(), ['AG-1', 'AG-2']);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.deepEqual(world.otcs.updateFormCalls[0].values, { k_IDsCancelados: [] }, 'resultado vazio também é gravado');

  // com um alvo e o atributo do subprocesso: só o AG-2
  seedCancelFlow(world, { fields: { 'ID Subflujo a Cancelar': '3005' } });
  const one = await authThenCancel(world);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).subworkflowIgnored, false);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-2']);
  assert.equal(world.repo.get('AG-1').state, 'pending');

  // com vários alvos o subflujo é ignorado (e avisado no log): 3003 ainda tem o AG-1 aberto, o subprocesso 3005 não filtra
  open(world, 'AG-9', { workflowId: '4444', subworkflowId: '4444' });
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': ['4444', '3003'], 'ID Subflujo a Cancelar': '3005' } });
  const many = await authThenCancel(world);
  assert.equal(many.status, 200);
  const manyBody = await many.json();
  assert.equal(manyBody.subworkflowIgnored, true);
  // o AG-1 (subprocesso 3004) é o único aberto do 3003; se o subflujo 3005 valesse, o alvo seria o AG-2 (já cancelado)
  assert.deepEqual(manyBody.items.map((i) => [i.workflowId, i.outcome, i.agreementId, i.alreadyCancelled]), [
    ['4444', 'cancelled', 'AG-9', false],
    ['3003', 'cancelled', 'AG-1', false]
  ]);
  assert.ok(world.logger.has('warn', /el subflujo 3005 se ignora/));
  await world.close();
});

test('lote misto: cancelado, assinado, não encontrado e ambíguo => grava só os cancelados no formulário e faz o SendOn', async () => {
  const world = await batchWorld(['3101', '3102', '3104'], { target: ['3101', '3102', '3103', '3104'] });
  world.adobe.agreements['AG-3102'].status = 'SIGNED';
  // 3104 passa a ter dois acordos abertos (ambíguo); 3103 não tem acordo nenhum
  open(world, 'AG-3104B', { workflowId: '3104', subworkflowId: '3105' });

  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.code]), [
    ['3101', 'cancelled', undefined],
    ['3102', 'refused', 'ALREADY_SIGNED'],
    ['3103', 'refused', 'AGREEMENT_NOT_FOUND'],
    ['3104', 'refused', 'AMBIGUOUS']
  ]);
  assert.deepEqual(body.summary, { total: 4, cancelled: 1, refused: 3, pending: 0 });
  assert.deepEqual([body.complete, body.sentOn], [true, true]);
  assert.equal(body.items[1].agreementId, 'AG-3102');
  assert.equal(body.items[3].agreements.length, 2);
  assert.match(body.items[2].hint, /adopt/);

  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101']);
  assert.deepEqual(world.otcs.updateFormCalls.map((c) => c.values), [{ k_IDsCancelados: ['3101'] }]);
  assert.equal(world.otcs.sendons.length, 1);
  assert.match(world.otcs.sendons[0].comment, /Cancelados \(1\): 3101\. No cancelados \(3\): 3102 \(ALREADY_SIGNED\), 3103 \(AGREEMENT_NOT_FOUND\), 3104 \(AMBIGUOUS\)/);
  assert.ok(world.otcs.sendons[0].comment.length <= 1000);
  assert.equal(world.repo.get('AG-3102').state, 'pending', 'o assinado fica intacto');
  await world.close();
});

test('lote com item transitório (503 do Adobe): complete:false, nada gravado e sem SendOn; repetir termina e é idempotente', async () => {
  const world = await batchWorld(['3101', '3102']);
  world.adobe.cancelFailures = 1; // o 1º cancelamento falha (e a reconsulta mostra o acordo ainda em andamento)

  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual([body.complete, body.sentOn], [false, false]);
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.code]), [
    ['3101', 'pending', 'ADOBE_UNAVAILABLE'],
    ['3102', 'cancelled', undefined]
  ]);
  assert.deepEqual(body.summary, { total: 2, cancelled: 1, refused: 0, pending: 1 });
  assert.equal(world.otcs.updateFormCalls.length, 0, 'nada gravado');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current');
  assert.equal(world.repo.get('AG-3101').state, 'pending');

  // repetir: o que já foi cancelado volta como alreadyCancelled e o lote fecha
  const again = await authThenCancel(world);
  const done = await again.json();
  assert.equal(again.status, 200);
  assert.deepEqual([done.complete, done.sentOn], [true, true]);
  assert.deepEqual(done.items.map((i) => [i.workflowId, i.outcome, i.alreadyCancelled]), [
    ['3101', 'cancelled', false], ['3102', 'cancelled', true]
  ]);
  assert.deepEqual(world.otcs.updateFormCalls.map((c) => c.values), [{ k_IDsCancelados: ['3101', '3102'] }]);
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.adobe.cancelled.length, 2, 'cada acordo foi cancelado uma única vez no Adobe');

  // erro inesperado de um item vira pendente com mensagem genérica (o detalhe só no log)
  const w2 = await batchWorld(['3101']);
  w2.repo.listByWorkflow = () => { throw new Error('segredo interno'); };
  const unexpected = await (await authThenCancel(w2)).json();
  assert.deepEqual([unexpected.complete, unexpected.items[0].outcome, unexpected.items[0].code], [false, 'pending', 'UNEXPECTED_ERROR']);
  assert.equal(unexpected.items[0].message, 'Error al cancelar el flujo.');
  assert.doesNotMatch(JSON.stringify(unexpected), /segredo interno/);
  assert.ok(w2.logger.has('error', /segredo interno/));
  assert.equal(w2.otcs.sendons.length, 0);
  await world.close();
  await w2.close();
});

test('orçamento de tempo estourado: alvos não iniciados ficam pendentes (BUDGET_EXCEEDED), sem gravar nem SendOn; repetir fecha', async () => {
  const world = await batchWorld(['3101', '3102', '3103'], { env: { CANCEL_BATCH_BUDGET_MS: '5000' } });
  assert.equal(world.config.cancel.batchBudgetMs, 5000);
  world.adobe.onCancel = async () => world.clock.advance(6000); // o 1º cancelamento consome o orçamento

  const body = await (await authThenCancel(world)).json();
  assert.deepEqual([body.complete, body.sentOn], [false, false]);
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.code]), [
    ['3101', 'cancelled', undefined],
    ['3102', 'pending', 'BUDGET_EXCEEDED'],
    ['3103', 'pending', 'BUDGET_EXCEEDED']
  ]);
  assert.deepEqual(body.summary, { total: 3, cancelled: 1, refused: 0, pending: 2 });
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101'], 'os não iniciados nem foram consultados');
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement' && c[1] !== 'AG-3101').length, 0);

  world.adobe.onCancel = null;
  const again = await (await authThenCancel(world)).json();
  assert.deepEqual([again.complete, again.sentOn], [true, true]);
  assert.deepEqual(world.otcs.updateFormCalls[0].values, { k_IDsCancelados: ['3101', '3102', '3103'] });
  assert.equal(world.otcs.sendons.length, 1);

  // o primeiro alvo sempre começa, mesmo com o orçamento no mínimo
  assert.equal(computeConfig({ CANCEL_BATCH_BUDGET_MS: '1' }).cancel.batchBudgetMs, 1000);
  await world.close();
});

test('POST /cancel: atributo de resultado ausente no formulário => 409 RESULT_FIELD_MISSING ANTES de cancelar nada', async () => {
  const world = await batchWorld(['3101'], { fields: { 'IDs Cancelados': null } });

  const r = await authThenCancel(world);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'RESULT_FIELD_MISSING');
  assert.equal(body.items, undefined);
  // nada foi consultado nem cancelado no Adobe, nada gravado, sem SendOn, registro intacto
  assert.equal(world.calls.filter((c) => c[0].startsWith('adobe.')).length, 0);
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.cancelAgreement').length, 0);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.repo.get('AG-3101').state, 'pending');
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current');
  await world.close();
});

test('prévia: resultFieldMissing só quando a gravação está ligada e o atributo falta; a prévia responde normalmente', async () => {
  const world = await batchWorld(['3101'], { fields: { 'IDs Cancelados': null } });
  let body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.equal(body.resultFieldMissing, true);
  assert.deepEqual(body.items.map((i) => [i.state, i.cancelable]), [['abierto', true]]);
  assert.equal(world.adobe.cancelled.length, 0);

  // atributo presente: sem a flag
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': '3101' } });
  body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.equal(body.resultFieldMissing, undefined);

  // gravação desligada: o atributo pode faltar sem aviso
  const off = await batchWorld(['3101'], { env: { CANCEL_FIELD_RESULT: '' }, fields: { 'IDs Cancelados': null } });
  body = await (await authThenCancel(off, undefined, { path: '/cancel/preview' })).json();
  assert.equal(body.resultFieldMissing, undefined);
  await world.close();
  await off.close();
});

test('POST /cancel: falha ao gravar o resultado => 503 RESULT_WRITE_FAILED (com items), sem SendOn; repetir fecha', async () => {
  const world = await batchWorld(['3101']);
  world.otcs.updateFormFailures = 1;

  const r = await authThenCancel(world);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.code, 'RESULT_WRITE_FAILED');
  assert.equal(body.items[0].outcome, 'cancelled');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current');

  const retry = await authThenCancel(world);
  assert.equal(retry.status, 200);
  const done = await retry.json();
  assert.equal(done.items[0].alreadyCancelled, true);
  assert.deepEqual(world.otcs.updateFormCalls.map((c) => c.values), [{ k_IDsCancelados: ['3101'] }]);
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.adobe.cancelled.length, 1);
  await world.close();
});

test('POST /cancel: falha no SendOn depois do lote => 503 SENDON_FAILED (cancelled, items) e repetir é idempotente', async () => {
  const world = await batchWorld(['3101', '3102']);
  world.otcs.sendOnFailures = 1;

  const failed = await authThenCancel(world);
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.deepEqual([body.code, body.cancelled], ['SENDON_FAILED', true]);
  assert.deepEqual(body.items.map((i) => i.outcome), ['cancelled', 'cancelled']);
  assert.deepEqual(body.summary, { total: 2, cancelled: 2, refused: 0, pending: 0 });
  assert.equal(world.adobe.cancelled.length, 2);
  assert.equal(world.repo.get('AG-3101').state, 'cancelled');
  assert.equal(world.otcs.task('9001', 2).status, 'current', 'a tarefa de cancelamento continua ativa');

  const retry = await authThenCancel(world);
  assert.equal(retry.status, 200, await retry.clone().text());
  const done = await retry.json();
  assert.deepEqual([done.complete, done.sentOn], [true, true]);
  assert.deepEqual(done.items.map((i) => i.alreadyCancelled), [true, true]);
  assert.equal(world.adobe.cancelled.length, 2, 'o cancelamento não é repetido no Adobe');
  assert.equal(world.otcs.task('9001', 2).status, 'completed');
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.otcs.updateFormCalls.length, 2, 'o resultado é regravado na repetição, com a mesma lista');
  assert.deepEqual(world.otcs.updateFormCalls[0].values, world.otcs.updateFormCalls[1].values);

  // depois de concluída, uma terceira chamada já não está no passo de cancelamento
  assert.equal((await authThenCancel(world)).status, 409);
  await world.close();
});

test('POST /cancel com CANCEL_FIELD_RESULT vazio: não grava o formulário (updateTaskForm) e segue para o SendOn', async () => {
  const world = await batchWorld(['3101'], { env: { CANCEL_FIELD_RESULT: '' }, fields: { 'IDs Cancelados': null } });
  assert.equal(world.config.cancel.fields.result, '');

  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual([body.complete, body.sentOn, body.resultField], [true, true, null]);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'updateTaskForm').length, 0);
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('POST /cancel: fluxo sem acordo, já assinado, Adobe indisponível — recusa definitiva fecha o lote; transitório não', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world);

  const none = await authThenCancel(world);
  assert.equal(none.status, 200);
  const noneBody = await none.json();
  assert.deepEqual([noneBody.complete, noneBody.items[0].outcome, noneBody.items[0].code], [true, 'refused', 'AGREEMENT_NOT_FOUND']);
  assert.match(noneBody.items[0].hint, /adopt/);
  assert.deepEqual(world.otcs.updateFormCalls.map((c) => c.values), [{ k_IDsCancelados: [] }]);
  assert.equal(world.otcs.sendons.length, 1, 'tudo recusado de forma definitiva: o lote termina e o workflow segue');

  const w2 = await cancelWorld();
  seedCancelFlow(w2);
  open(w2, 'AG-1');
  w2.adobe.cancelFailures = 1;
  const down = await (await authThenCancel(w2)).json();
  assert.deepEqual([down.complete, down.items[0].outcome, down.items[0].code], [false, 'pending', 'ADOBE_UNAVAILABLE']);
  assert.equal(w2.repo.get('AG-1').state, 'pending', 'nada marcado');

  w2.adobe.agreements['AG-1'].status = 'SIGNED';
  const signed = await (await authThenCancel(w2)).json();
  assert.deepEqual([signed.complete, signed.items[0].outcome, signed.items[0].code], [true, 'refused', 'ALREADY_SIGNED']);
  assert.equal(w2.otcs.sendons.length, 1);
  assert.equal(w2.adobe.cancelled.length, 0);

  // demais recusas definitivas do serviço unitário
  for (const [setup, code] of [
    [(w) => { w.adobe.agreements['AG-1'].status = 'EXPIRED'; }, 'NOT_CANCELABLE'],
    [(w) => { w.adobe.agreements['AG-1'].status = 'CANCELLED'; w.adobe.events['AG-1'] = [{ type: 'REJECTED' }]; }, 'ALREADY_REJECTED'],
    [(w) => { delete w.adobe.agreements['AG-1']; }, 'AGREEMENT_NOT_FOUND_IN_ADOBE'],
    [(w) => { w.repo.upsert('AG-1', { sendonDone: true, state: 'completed' }); }, 'AGREEMENT_CLOSED']
  ]) {
    const w = await cancelWorld();
    seedCancelFlow(w);
    open(w, 'AG-1');
    setup(w);
    const item = (await (await authThenCancel(w)).json()).items[0];
    assert.deepEqual([item.outcome, item.code], ['refused', code]);
    await w.close();
  }

  // 503 de reconciliação em curso, IN_PROGRESS: transitórios
  assert.deepEqual(
    ['RECONCILE_IN_PROGRESS', 'IN_PROGRESS', 'ADOBE_UNAVAILABLE', 'OTCS_UNAVAILABLE', 'BUDGET_EXCEEDED', 'UNEXPECTED_ERROR', 'QUALQUER'].map(classifyCancelOutcome),
    Array(7).fill('pending')
  );
  await world.close();
  await w2.close();
});

test('POST /cancel: erro inesperado devolve 500 genérico sem vazar detalhes', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world);
  open(world, 'AG-1');
  world.cancellation.cancelFromTask = async () => { throw new Error('segredo interno'); }; // o app usa o mesmo objeto

  const r = await authThenCancel(world);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Error al cancelar el flujo.' });
  assert.ok(world.logger.has('error', /segredo interno/));

  world.cancellation.previewFromTask = async () => { throw new Error('segredo da previa'); };
  const p = await authThenCancel(world, undefined, { path: '/cancel/preview' });
  assert.equal(p.status, 500);
  assert.deepEqual(await p.json(), { error: 'Error al cancelar el flujo.' });
  assert.ok(world.logger.has('error', /segredo da previa/));
  await world.close();
});

/* ---------- CANCEL_STOP_ORIGINAL: parar o fluxo original no Content depois do Adobe ---------- */

// Mundo com a parada do original ligada; `otcs.stopProcess` também registra a ordem em world.calls
async function stopWorld(wfIds, opts = {}) {
  const world = await batchWorld(wfIds, { ...opts, env: { CANCEL_STOP_ORIGINAL: 'true', ...(opts.env || {}) } });
  const realStop = world.otcs.stopProcess;
  world.otcs.stopProcess = async (id) => {
    world.calls.push(['otcs.stop', String(id)]);
    return realStop(id);
  };
  return world;
}

test('stop do original desligado (padrão): nenhuma chamada a stopProcess, contentStop disabled e stopOriginal false', async () => {
  const world = await batchWorld(['3101', '3102']);
  assert.equal(world.config.cancel.stopOriginal, false);

  const body = await (await authThenCancel(world)).json();
  assert.deepEqual([body.complete, body.sentOn, body.stopOriginal], [true, true, false]);
  assert.deepEqual(body.items.map((i) => [i.outcome, i.contentStop]), [['cancelled', 'disabled'], ['cancelled', 'disabled']]);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'stopProcess' || c[0] === 'getProcessStatus').length, 0);
  assert.deepEqual(world.otcs.stopped, []);
  assert.match(world.otcs.sendons[0].comment, /originales detenidos en Content: no/);
  await world.close();
});

test('stop do original ligado: depois do Adobe confirmar, item a item; o resultado inclui os parados e o SendOn avisa', async () => {
  const world = await stopWorld(['3101', '3102']);
  assert.equal(world.config.cancel.stopOriginal, true);

  const body = await (await authThenCancel(world)).json();
  assert.deepEqual([body.complete, body.sentOn, body.stopOriginal], [true, true, true]);
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.contentStop]), [
    ['3101', 'cancelled', 'stopped'], ['3102', 'cancelled', 'stopped']
  ]);
  assert.deepEqual(world.otcs.stopped, [3101, 3102]);
  // ordem por item: Adobe confirmado -> stop -> próximo item
  const seq = world.calls.map((c) => c.join(':')).filter((c) => /cancelAgreement|otcs\.stop|otcs\.sendon/.test(c));
  assert.deepEqual(seq, [
    'adobe.cancelAgreement:AG-3101', 'otcs.stop:3101', 'adobe.cancelAgreement:AG-3102', 'otcs.stop:3102', 'otcs.sendon:sendon:2'
  ]);
  assert.deepEqual(world.otcs.updateFormCalls[0].values, { k_IDsCancelados: ['3101', '3102'] });
  assert.match(world.otcs.sendons[0].comment, /originales detenidos en Content: sí/);
  // o eco RECALLED continua sem disposição: o original só foi parado, não recebeu Rechazado
  assert.equal(world.otcs.dispositionCalls().length, 0);
  await world.close();
});

test('stop do original ligado: recusados (assinado, não encontrado...) nunca são parados', async () => {
  const world = await stopWorld(['3101', '3102'], { target: ['3101', '3102', '3103'] });
  world.adobe.agreements['AG-3102'].status = 'SIGNED';

  const body = await (await authThenCancel(world)).json();
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.contentStop]), [
    ['3101', 'cancelled', 'stopped'], ['3102', 'refused', undefined], ['3103', 'refused', undefined]
  ]);
  assert.deepEqual(world.otcs.stopped, [3101]);
  assert.equal(world.otcs.workflows['3102'].status, undefined, 'o assinado segue ativo');
  await world.close();
});

test('stop do original falha (sem permissão): pending STOP_FAILED, sem gravação nem SendOn; repetir não cancela de novo no Adobe e refaz o stop', async () => {
  const world = await stopWorld(['3101', '3102']);
  world.otcs.stopFailures = 1; // o 1º stop (3101) falha com 403

  const r = await authThenCancel(world);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual([body.complete, body.sentOn], [false, false]);
  const [first, second] = body.items;
  assert.deepEqual([first.outcome, first.code, first.cancelledInAdobe, first.contentStop, first.agreementId],
    ['pending', 'STOP_FAILED', true, 'failed', 'AG-3101']);
  assert.match(first.message, /cancelado en Adobe Sign, pero no se pudo detener el flujo en Content Server/);
  assert.match(first.message, /permisos del usuario de integración/);
  assert.deepEqual([second.outcome, second.contentStop], ['cancelled', 'stopped']);
  assert.deepEqual(body.summary, { total: 2, cancelled: 1, refused: 0, pending: 1 });
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-3101').state, 'cancelled', 'o Adobe/registro já estão cancelados');
  assert.ok(world.logger.has('error', /no se pudo detener el flujo original/));
  assert.equal(world.adobe.cancelled.length, 2);

  // repetir: o Adobe não é cancelado de novo (alreadyCancelled) e só o stop é refeito
  const again = await (await authThenCancel(world)).json();
  assert.deepEqual([again.complete, again.sentOn], [true, true]);
  assert.deepEqual(again.items.map((i) => [i.workflowId, i.alreadyCancelled, i.contentStop]), [
    ['3101', true, 'stopped'], ['3102', true, 'stopped']
  ]);
  assert.equal(world.adobe.cancelled.length, 2, 'nenhum novo cancelamento no Adobe');
  assert.ok(world.otcs.stopped.includes(3101));
  assert.deepEqual(world.otcs.updateFormCalls.map((c) => c.values), [{ k_IDsCancelados: ['3101', '3102'] }]);
  assert.equal(world.otcs.sendons.length, 1);

  // erro que não é de permissão: STOP_FAILED sem a dica de permissões
  const w2 = await stopWorld(['3101']);
  w2.otcs.stopFailures = 1;
  w2.otcs.stopFailStatus = 500;
  const item = (await (await authThenCancel(w2)).json()).items[0];
  assert.equal(item.code, 'STOP_FAILED');
  assert.doesNotMatch(item.message, /permisos/);
  await world.close();
  await w2.close();
});

test('stop do original: já cancelado (repetição) também para; stop falha mas o processo já está parado => already_stopped; sem saber o estado => falha', async () => {
  // fluxo já cancelado antes (flag desligado), agora o lote com o flag ligado também para o original
  const world = await stopWorld(['3101']);
  world.config.cancel.stopOriginal = false;
  assert.equal((await authThenCancel(world)).status, 200);
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': '3101' } });
  world.config.cancel.stopOriginal = true;
  const rep = (await (await authThenCancel(world)).json()).items[0];
  assert.deepEqual([rep.alreadyCancelled, rep.contentStop], [true, 'stopped']);
  assert.deepEqual(world.otcs.stopped, [3101]);

  // o stop devolve erro (resposta perdida), mas o OTCS já parou o processo: sucesso idempotente
  const w2 = await stopWorld(['3101']);
  w2.otcs.stopFailsButStops = 1;
  const body = await (await authThenCancel(w2)).json();
  assert.deepEqual([body.complete, body.items[0].outcome, body.items[0].contentStop], [true, 'cancelled', 'already_stopped']);
  assert.ok(w2.otcs.modelCalls.some((c) => c[0] === 'getProcessStatus'));
  assert.equal(w2.otcs.sendons.length, 1);

  // processo concluído/arquivado também vale (status relido); sem conseguir reler o estado => falha
  const w3 = await stopWorld(['3101']);
  w3.otcs.stopFailures = 1;
  w3.otcs.workflows['3101'].status = 'Completed';
  assert.equal((await (await authThenCancel(w3)).json()).items[0].contentStop, 'already_stopped');
  const w4 = await stopWorld(['3101']);
  w4.otcs.stopFailures = 1;
  w4.otcs.processStatusFailure = httpError(500, 'status down');
  const failed = (await (await authThenCancel(w4)).json()).items[0];
  assert.deepEqual([failed.outcome, failed.code, failed.contentStop], ['pending', 'STOP_FAILED', 'failed']);
  assert.equal(w4.otcs.sendons.length, 0);
  for (const w of [world, w2, w3, w4]) await w.close();
});

test('stop do original conta no prazo do lote: com o tempo esgotado depois do stop, o próximo item é BUDGET_EXCEEDED', async () => {
  const world = await stopWorld(['3101', '3102'], { env: { CANCEL_BATCH_BUDGET_MS: '5000' } });
  const stop = world.otcs.stopProcess;
  world.otcs.stopProcess = async (id) => { const out = await stop(id); world.clock.advance(6000); return out; };

  const body = await (await authThenCancel(world)).json();
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.code, i.contentStop]), [
    ['3101', 'cancelled', undefined, 'stopped'], ['3102', 'pending', 'BUDGET_EXCEEDED', undefined]
  ]);
  assert.equal(body.complete, false);
  assert.deepEqual(world.otcs.stopped, [3101]);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101']);
  await world.close();
});

test('prévia e rotas admin nunca param o original, com o flag ligado; a prévia informa stopOriginal', async () => {
  const world = await stopWorld(['3101', '3102']);
  world.adobe.agreements['AG-3102'].status = 'SIGNED';
  const body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.equal(body.stopOriginal, true);
  assert.deepEqual(body.items.map((i) => i.state), ['abierto', 'firmado']);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'stopProcess' || c[0] === 'getProcessStatus').length, 0);
  assert.deepEqual(world.otcs.stopped, []);

  // rotas admin / serviço unitário: só o Adobe (contentFlow 'unchanged'), mesmo com o flag
  const out = await world.cancellation.cancelWorkflow('3101');
  assert.equal(out.cancelled, true);
  assert.deepEqual(world.otcs.stopped, []);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'stopProcess').length, 0);

  const off = await batchWorld(['3101']);
  assert.equal((await (await authThenCancel(off, undefined, { path: '/cancel/preview' })).json()).stopOriginal, false);
  await world.close();
  await off.close();
});

test('otcs: getProcessStatus lê wf_details.status e os passos ativos de /v2/workflows/status/processes/{id}', async () => {
  const bodies = [
    { results: { wf_details: { status: 'stopped' }, step_list: { current: [], completed: [{}], next: [] } } },
    { results: { step_list: { current: [{}, {}] } } },
    {}
  ];
  const seen = [];
  const http = {
    post: async () => ({ data: { ticket: 't1', validFor: 1800 } }),
    get: async (url) => { seen.push(url); return { data: bodies.shift() }; }
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  assert.deepEqual(await client.getProcessStatus(3003), { status: 'stopped', currentTasks: 0 });
  assert.deepEqual(await client.getProcessStatus(3003), { status: '', currentTasks: 2 });
  assert.deepEqual(await client.getProcessStatus(3003), { status: '', currentTasks: null });
  assert.equal(seen[0], 'https://otcs.invalid/api/v2/workflows/status/processes/3003');
});

test('isProcessFinishedStatus: parado/concluído/arquivado sim; ativo, vazio e desconhecido não', () => {
  for (const s of ['stopped', 'Stopped', 'completed', 'Complete', 'archived', 'Archived']) assert.equal(isProcessFinishedStatus(s), true, s);
  for (const s of ['ontime', 'workflowlate', 'Active', '', undefined, null, 'suspended']) assert.equal(isProcessFinishedStatus(s), false, String(s));
});

/* ---------- POST /cancel/preview ---------- */

// Foto do que a prévia nunca pode mudar: registros, histórico de eventos e as chamadas de escrita
function snapshot(world, ids) {
  return JSON.stringify(ids.map((id) => [world.repo.get(id), world.repo.listEvents(id)]));
}

test('prévia: cada estado da tabela, sem cancelar no Adobe nem escrever no repositório, no formulário ou no workflow', async () => {
  const wf = ['3101', '3102', '3103', '3104', '3105', '3106', '3107', '3108', '3109', '3110', '3111'];
  const world = await batchWorld(['3101', '3102', '3103', '3104', '3105', '3106', '3108', '3111'], { target: wf });
  const set = (n, status, events) => {
    world.adobe.agreements[`AG-${n}`].status = status;
    if (events) world.adobe.events[`AG-${n}`] = events;
  };
  // 3102: em andamento com 1 assinatura concluída (ESIGNED + ACTION_COMPLETED da mesma pessoa contam uma vez)
  world.adobe.events['AG-3102'] = [
    { type: 'CREATED', participantRole: 'SENDER', participantEmail: 'rh@example.com', date: '2026-06-20T09:00:00Z' },
    { type: 'EMAIL_VIEWED', participantEmail: 'a@example.com', date: '2026-06-21T09:00:00Z' },
    { type: 'ESIGNED', participantRole: 'SIGNER', participantEmail: 'a@example.com', date: '2026-06-21T10:00:00Z' },
    { type: 'ACTION_COMPLETED', participantEmail: 'a@example.com', date: '2026-06-21T10:00:01Z' }
  ];
  set('3103', 'SIGNED');
  set('3104', 'CANCELLED', [{ type: 'REJECTED' }]);
  set('3105', 'CANCELLED', [{ type: 'RECALLED' }]);
  set('3106', 'EXPIRED');
  // 3107: acordo já concluído por outro caminho (sem cancelamento)
  open(world, 'AG-3107', { workflowId: '3107', subworkflowId: '3107', sendonDone: true, state: 'completed' });
  // 3108: dois acordos abertos; 3109: nenhum; 3110: registro sem acordo no Adobe (404); 3111: Adobe falha
  open(world, 'AG-3108B', { workflowId: '3108', subworkflowId: '3199' });
  seedAgreement(world, 'AG-3110', { workflowId: '3110', subworkflowId: '3110' });
  const getAgreement = world.adobe.getAgreement;
  world.adobe.getAgreement = async (id) => {
    if (id === 'AG-3111') throw httpError(500, 'adobe down');
    return getAgreement(id);
  };
  const ids = ['AG-3101', 'AG-3102', 'AG-3103', 'AG-3104', 'AG-3105', 'AG-3106', 'AG-3107', 'AG-3108', 'AG-3108B', 'AG-3110', 'AG-3111'];
  const before = snapshot(world, ids);

  const r = await authThenCancel(world, undefined, { path: '/cancel/preview' });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  const byWf = Object.fromEntries(body.items.map((i) => [i.workflowId, i]));
  const expected = {
    3101: ['abierto', true], 3102: ['firma_parcial', true], 3103: ['firmado', false], 3104: ['rechazado', false],
    3105: ['ya_cancelado', true], 3106: ['no_cancelable', false], 3107: ['concluido', false], 3108: ['ambiguo', false],
    3109: ['no_encontrado', false], 3110: ['no_existe_en_adobe', false], 3111: ['no_disponible', null]
  };
  assert.deepEqual(body.items.map((i) => i.workflowId), wf, 'mesma ordem do atributo');
  for (const [id, [state, cancelable]] of Object.entries(expected)) {
    assert.deepEqual([byWf[id].state, byWf[id].cancelable], [state, cancelable], id);
    assert.ok(byWf[id].message, `${id} tem mensagem`);
  }
  assert.deepEqual(body.summary, {
    total: 11, abierto: 1, firma_parcial: 1, firmado: 1, rechazado: 1, ya_cancelado: 1, no_cancelable: 1, concluido: 1,
    ambiguo: 1, no_encontrado: 1, no_existe_en_adobe: 1, no_disponible: 1
  });
  assert.equal(body.subworkflowIgnored, false);

  // detalhes por estado
  assert.deepEqual([byWf[3101].agreementId, byWf[3101].adobeStatus], ['AG-3101', 'OUT_FOR_SIGNATURE']);
  assert.equal(byWf[3101].signedCount, undefined);
  assert.deepEqual([byWf[3102].signedCount, byWf[3102].lastSignedAt], [1, '2026-06-21T10:00:01Z']);
  assert.equal(byWf[3103].adobeStatus, 'SIGNED');
  assert.match(byWf[3103].message, /regularizar/);
  assert.deepEqual(byWf[3108].agreements.map((a) => a.id).sort(), ['AG-3108', 'AG-3108B']);
  assert.equal(byWf[3107].agreement.id, 'AG-3107');

  // nada foi cancelado nem gravado
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.cancelAgreement').length, 0);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(snapshot(world, ids), before, 'registros e histórico intactos');
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'updateTaskForm').length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current');
  await world.close();
});

test('prévia: histórico ilegível (abierto com partialUnknown; CANCELLED => no_disponible), já cancelado por nós e orçamento (pendiente)', async () => {
  const world = await batchWorld(['3101', '3102']);
  world.adobe.eventsError = httpError(500, 'events down');
  world.adobe.agreements['AG-3102'].status = 'CANCELLED';
  let body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.deepEqual(body.items.map((i) => [i.state, i.cancelable, i.partialUnknown]), [
    ['abierto', true, true], ['no_disponible', null, undefined]
  ]);

  // cancelado por nós (registro marcado): ya_cancelado sem ler o histórico, mesmo com ele indisponível
  world.adobe.eventsError = null;
  world.adobe.agreements['AG-3102'].status = 'OUT_FOR_SIGNATURE';
  assert.equal((await authThenCancel(world)).status, 200);
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': ['3101', '3102'] } }); // o SendOn concluiu a tarefa: reabre para a prévia
  world.adobe.eventsError = httpError(500, 'events down');
  body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.deepEqual(body.items.map((i) => [i.state, i.cancelable]), [['ya_cancelado', true], ['ya_cancelado', true]]);

  // orçamento: o 1º item gasta o tempo, o 2º não é consultado
  const w2 = await batchWorld(['3101', '3102'], { env: { CANCEL_BATCH_BUDGET_MS: '5000' } });
  const getAgreement = w2.adobe.getAgreement;
  w2.adobe.getAgreement = async (id) => { const out = await getAgreement(id); w2.clock.advance(6000); return out; };
  body = await (await authThenCancel(w2, undefined, { path: '/cancel/preview' })).json();
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.state, i.cancelable]), [['3101', 'abierto', true], ['3102', 'pendiente', null]]);
  assert.deepEqual(body.summary, { total: 2, abierto: 1, pendiente: 1 });
  assert.equal(w2.calls.filter((c) => c[0] === 'adobe.getAgreement' && c[1] === 'AG-3102').length, 0);
  await world.close();
  await w2.close();
});

test('prévia: com vários alvos o subflujo é ignorado; com um alvo desempata', async () => {
  const world = await cancelWorld();
  open(world, 'AG-1', { subworkflowId: '3004' });
  open(world, 'AG-2', { subworkflowId: '3005' });

  seedCancelFlow(world, { fields: { 'ID Subflujo a Cancelar': '3005' } });
  let body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.deepEqual([body.items[0].state, body.items[0].agreementId, body.subworkflowIgnored], ['abierto', 'AG-2', false]);

  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': '3003 4444', 'ID Subflujo a Cancelar': '3005' } });
  body = await (await authThenCancel(world, undefined, { path: '/cancel/preview' })).json();
  assert.deepEqual(body.items.map((i) => i.state), ['ambiguo', 'no_encontrado']);
  assert.equal(body.subworkflowIgnored, true);
  assert.equal(world.adobe.cancelled.length, 0);
  await world.close();
});

/* ---------- rotas administrativas ---------- */

test('POST /admin/cancel/:agreementId: Basic Auth, 404 com dica, cancela com comentário e é idempotente', async () => {
  const world = await buildWorld({ listen: true }); // CANCEL_ENABLED não é necessário nas rotas admin
  assert.equal(world.config.cancel.enabled, false);
  open(world, 'AG-1');

  assert.equal((await post(world, '/admin/cancel/AG-1', {})).status, 401);
  assert.equal((await post(world, '/admin/cancel/AG-1', {}, { authorization: basicHeader('admin', 'errada') })).status, 401);
  assert.equal(world.adobe.cancelled.length, 0);

  const unknown = await post(world, '/admin/cancel/NOPE', {}, ADMIN);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).hint, /POST \/admin\/adopt\//);

  const r = await post(world, '/admin/cancel/AG-1', { comment: 'reenvio solicitado' }, ADMIN);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual([body.cancelled, body.alreadyCancelled, body.agreementId], [true, false, 'AG-1']);
  // as rotas admin não encerram o fluxo no Content: a resposta e o log dizem isso
  assert.equal(body.contentFlow, 'unchanged');
  assert.match(body.note, /^El flujo del Content Server no fue modificado: deténgalo en el Content o ejecute el workflow de cancelación/);
  assert.ok(world.logger.has('warn', /\[AG-1\] acuerdo cancelado manualmente; el flujo del Content Server \(workflow 3003, subproceso 3004\) no fue modificado/));
  assert.equal(world.otcs.sendons.length, 0, 'nenhuma disposição nem SendOn no fluxo original');
  assert.equal(body.agreement.state, 'cancelled');
  assert.equal(body.agreement.sendonDone, true);
  assert.equal(world.adobe.cancelled[0].comment, 'reenvio solicitado');

  const again = await post(world, '/admin/cancel/AG-1', {}, ADMIN);
  assert.equal(again.status, 200);
  const againBody = await again.json();
  assert.equal(againBody.alreadyCancelled, true);
  assert.equal(againBody.contentFlow, 'unchanged');
  assert.equal(world.adobe.cancelled.length, 1);

  // /admin/agreements mostra a marca do pedido
  const list = await (await fetch(`${world.baseUrl}/admin/agreements`, { headers: ADMIN })).json();
  assert.equal(list.agreements[0].cancelSource, 'admin');
  assert.ok(list.agreements[0].cancelRequestedAt);
  await world.close();
});

test('POST /admin/cancel-workflow/:workflowId: Basic Auth, subworkflowId opcional, ambíguo/404/409/422/503', async () => {
  const world = await buildWorld({ listen: true });
  open(world, 'AG-1', { subworkflowId: '3004' });
  open(world, 'AG-2', { subworkflowId: '3005' });

  assert.equal((await post(world, '/admin/cancel-workflow/3003', {})).status, 401);

  const ambiguous = await post(world, '/admin/cancel-workflow/3003', {}, ADMIN);
  assert.equal(ambiguous.status, 409);
  const ambiguousBody = await ambiguous.json();
  assert.equal(ambiguousBody.code, 'AMBIGUOUS');
  assert.equal(ambiguousBody.contentFlow, undefined, 'só a resposta 200 leva contentFlow');
  assert.equal(ambiguousBody.agreements.length, 2);
  assert.equal(world.adobe.cancelled.length, 0);

  assert.equal((await post(world, '/admin/cancel-workflow/3003', { subworkflowId: '3999' }, ADMIN)).status, 404);
  assert.equal((await post(world, '/admin/cancel-workflow/abc', {}, ADMIN)).status, 422);
  assert.equal((await post(world, '/admin/cancel-workflow/3003', { subworkflowId: 'x' }, ADMIN)).status, 422);

  world.adobe.cancelFailures = 1;
  assert.equal((await post(world, '/admin/cancel-workflow/3003', { subworkflowId: '3005' }, ADMIN)).status, 503);
  assert.equal(world.repo.get('AG-2').state, 'pending');

  const ok = await post(world, '/admin/cancel-workflow/3003', { subworkflowId: '3005', comment: 'duplicado' }, ADMIN);
  assert.equal(ok.status, 200, await ok.clone().text());
  const okBody = await ok.json();
  assert.deepEqual([okBody.agreementId, okBody.agreement.state], ['AG-2', 'cancelled']);
  assert.equal(okBody.contentFlow, 'unchanged');
  assert.match(okBody.note, /no fue modificado/);
  assert.ok(world.logger.has('warn', /\[AG-2\] acuerdo cancelado manualmente.*workflow 3003, subproceso 3005/));
  assert.equal(world.otcs.sendons.length, 0);
  assert.deepEqual(world.adobe.cancelled.map((c) => [c.id, c.comment]), [['AG-2', 'duplicado']]);
  assert.equal(world.repo.get('AG-1').state, 'pending');

  world.adobe.agreements['AG-1'].status = 'SIGNED';
  const signed = await post(world, '/admin/cancel-workflow/3003', {}, ADMIN);
  assert.equal(signed.status, 409);
  assert.equal((await signed.json()).code, 'ALREADY_SIGNED');
  await world.close();
});

/* ---------- MODO DIRETO: WebReport executado sozinho (sem workflow): POST /cancel/direct e /cancel/direct/preview ---------- */

// Credencial PRÓPRIA do modo direto (CANCEL_DIRECT_AUTH_*; sem elas, vale a do /auth: ver NO_DIRECT_OWN)
const DIRECT_ENV = { CANCEL_DIRECT_ENABLED: 'true', CANCEL_DIRECT_AUTH_USER: 'cancel-direct', CANCEL_DIRECT_AUTH_PASS: 'dir:pa:ss' };
const DIRECT_ADMIN = { authorization: basicHeader('cancel-direct', 'dir:pa:ss') };

// Mundo com o modo direto ligado e um acordo aberto por fluxo de `wfIds`; NÃO existe workflow de cancelamento
async function directWorld(wfIds, env = {}) {
  const world = await cancelWorld({ ...DIRECT_ENV, OTCS_BASE: `${OTCS_ORIGIN}/cs/cs/api`, ...env });
  for (const id of wfIds) open(world, `AG-${id}`, { workflowId: String(id), subworkflowId: String(id) });
  return world;
}

// Protocolo do WebReport no modo direto: POST /cancel/direct/auth (Basic do modo direto) e a rota recebem os MESMOS campos (os alvos entram no HMAC)
const direct = (world, targets, { path = '/cancel/direct', fields = {}, tamper = {}, extra = {}, authHeaders = DIRECT_ADMIN } = {}) =>
  authThenCancel(world, { targetWorkflowIds: targets, ...fields }, {
    path, tamper, extra, authPath: '/cancel/direct/auth', authHeaders
  });

const TASK_APIS = ['getProcessSteps', 'getCurrentUser', 'getTaskForm', 'updateTaskForm'];
const usedTaskApis = (world) => world.otcs.modelCalls.filter((c) => TASK_APIS.includes(c[0]));

test('hmac: canonicalStart sem targetWorkflowIds fica idêntico; com alvos vincula lista, ordem e subflujo', () => {
  const base = { timestamp: '1700', nonce: 'n1', workflowId: '9001', subworkflowId: '9002' };
  const legacy = 'v2\n1700\nn1\n9001\n9002\n\n\n\n';
  assert.equal(canonicalStart(base), legacy);
  assert.equal(canonicalStart({ ...base, targetWorkflowIds: undefined, targetSubworkflowId: '7' }), legacy);
  assert.equal(canonicalStart({ ...base, targetWorkflowIds: null, targetSubworkflowId: '7' }), legacy);
  assert.equal(canonicalStart({}), ['v2', '', '', '', '', '', '', '', ''].join('\n'));

  const withTargets = (targetWorkflowIds, targetSubworkflowId) => canonicalStart({ ...base, targetWorkflowIds, targetSubworkflowId });
  assert.equal(withTargets(['3101', 3102], '7'), `${legacy}\n3101,3102\n7`);
  assert.equal(withTargets([' 3101 '], undefined), `${legacy}\n3101\n`);
  assert.equal(withTargets([], undefined), `${legacy}\n\n`, 'lista vazia também é vinculada (presente)');

  const secret = 'segredo-de-teste';
  const sig = (ids, sub) => signStart(secret, { ...base, targetWorkflowIds: ids, targetSubworkflowId: sub });
  const ref = sig(['3101', '3102'], '7');
  assert.equal(sig(['3101', '3102'], '7'), ref);
  assert.notEqual(sig(['3102', '3101'], '7'), ref, 'ordem');
  assert.notEqual(sig(['3101', '3102', '3103'], '7'), ref, 'alvo a mais');
  assert.notEqual(sig(['3101'], '7'), ref, 'alvo a menos');
  assert.notEqual(sig(['3101', '3102'], '8'), ref, 'subflujo');
  assert.notEqual(sig(['3101', '3102'], undefined), ref, 'subflujo removido');
  // sem alvos a assinatura é a de sempre; com alvos ela muda
  assert.notEqual(signStart(secret, base), ref);

  // tipo adulterado: um valor que não é lista vira text(valor); só o texto idêntico à lista coincide (e o serviço
  // recusa não-lista com 422, ver o teste das rotas)
  assert.notEqual(sig({ a: 1 }, '7'), ref);
  assert.notEqual(sig(3101, '7'), ref);
  assert.notEqual(sig('3101;3102', '7'), ref);
});

// Sem as CANCEL_DIRECT_AUTH_* próprias (strings vazias anulam o DIRECT_ENV): o modo direto usa a credencial do /auth
const NO_DIRECT_OWN = { CANCEL_DIRECT_AUTH_USER: '', CANCEL_DIRECT_AUTH_PASS: '' };

test('modo direto sem CANCEL_DIRECT_AUTH_*: a credencial do /auth serve de ponta a ponta (LOG_*; com START_AUTH_* definidas, a delas)', async (t) => {
  // só LOG_* (padrão dos testes): o admin aceito pelo /auth também é aceito pelo modo direto, e cancela
  const logs = await directWorld(['3101'], NO_DIRECT_OWN);
  t.after(() => logs.close());
  assert.equal(logs.logger.has('error', /sin credencial/), false);
  assert.deepEqual([logs.config.cancel.directAuthUser, logs.config.cancel.directAuthPass], ['admin', 'pa:ss']);
  const ok = await direct(logs, ['3101'], { authHeaders: ADMIN });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual([(await ok.json()).complete, logs.otcs.stopped, logs.adobe.cancelled.map((c) => c.id)], [true, [3101], ['AG-3101']]);

  // com START_AUTH_* definidas, o modo direto usa a MESMA do /auth (START_AUTH_*), não a de LOG_*
  const start = await directWorld(['3101'], { ...NO_DIRECT_OWN, START_AUTH_USER: 'start-user', START_AUTH_PASS: 'start:pass' });
  t.after(() => start.close());
  const START = { authorization: basicHeader('start-user', 'start:pass') };
  assert.equal((await post(start, '/cancel/direct/auth', { targetWorkflowIds: ['3101'] }, ADMIN)).status, 401, 'LOG_* não entra quando há START_AUTH_*');
  const ok2 = await direct(start, ['3101'], { authHeaders: START });
  assert.equal(ok2.status, 200, await ok2.clone().text());
  assert.deepEqual([(await ok2.json()).complete, start.otcs.stopped], [true, [3101]]);
});

test('modo direto com CANCEL_DIRECT_AUTH_USER/PASS (as duas): são as únicas aceitas em /cancel/direct/auth; só uma delas não basta e cai na do /auth', async (t) => {
  const world = await directWorld(['3101'], { START_AUTH_USER: 'start-user', START_AUTH_PASS: 'start:pass' });
  t.after(() => world.close());
  const START = { authorization: basicHeader('start-user', 'start:pass') };
  // LOG_*, START_AUTH_* e a própria com senha errada não entram
  for (const headers of [ADMIN, START, { authorization: basicHeader('cancel-direct', 'errada') }]) {
    assert.equal((await post(world, '/cancel/direct/auth', { targetWorkflowIds: ['3101'] }, headers)).status, 401, JSON.stringify(headers));
  }
  const ok = await direct(world, ['3101']);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual([(await ok.json()).complete, world.otcs.stopped], [true, [3101]]);

  // só o usuário definido (senha vazia): a própria não fica completa, então vale a do /auth (LOG_*)
  const partial = await directWorld(['3101'], { CANCEL_DIRECT_AUTH_PASS: '' });
  t.after(() => partial.close());
  assert.deepEqual([partial.config.cancel.directAuthUser, partial.config.cancel.directAuthPass], ['admin', 'pa:ss']);
  assert.equal((await post(partial, '/cancel/direct/auth', { targetWorkflowIds: ['3101'] }, DIRECT_ADMIN)).status, 401, 'a própria incompleta não vale');
  assert.equal((await post(partial, '/cancel/direct/auth', { targetWorkflowIds: ['3101'] }, ADMIN)).status, 200, 'a do /auth vale');
});

test('sem credencial própria, /auth e modo direto compartilham o Basic mas as assinaturas não se cruzam (genérica nas rotas diretas; direta no /cancel, no /start)', async (t) => {
  const world = await directWorld(['3101'], NO_DIRECT_OWN);
  t.after(() => world.close());
  // 1) a assinatura do /auth (mesmo Basic) não vale nas rotas diretas
  for (const p of ['/cancel/direct', '/cancel/direct/preview']) {
    const r = await authThenCancel(world, { targetWorkflowIds: ['3101'] }, { path: p, authPath: '/auth', authHeaders: ADMIN });
    assert.equal(r.status, 403, p);
    assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
  }
  // 2) a assinatura direta (mesmo Basic) não vale no /cancel da tarefa, no /cancel/preview nem no /start
  const taskFields = { workflowId: '9001', subworkflowId: '9001' };
  for (const p of ['/cancel', '/cancel/preview']) {
    const r = await authThenCancel(world, taskFields, { path: p, authPath: '/cancel/direct/auth', authHeaders: ADMIN });
    assert.equal(r.status, 403, p);
    assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
  }
  const startFields = { userEmail1: 'a@example.com', nodeId: 1001, attachId: 2002, docName: 'c.pdf', workflowId: 3003, subworkflowId: 3004, taskId: 2 };
  const startCreds = await (await post(world, '/cancel/direct/auth', startFields, ADMIN)).json();
  const startRes = await post(world, '/start', { ...startFields, ...startCreds });
  assert.equal(startRes.status, 403);
  assert.deepEqual(await startRes.json(), { error: 'Invalid signature.' });
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.adobe.cancelled.length, 0, 'nenhuma assinatura cruzada cancelou nada');
  // 3) o mesmo Basic segue valendo no modo direto, com a assinatura emitida por ele
  const ok = await direct(world, ['3101'], { authHeaders: ADMIN });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101']);
});

test('modo direto ligado sem credencial nenhuma (CANCEL_DIRECT_AUTH_* e LOG_* vazios): não monta as rotas diretas e registra o erro no startup', async (t) => {
  const world = await directWorld(['3101'], { ...NO_DIRECT_OWN, LOG_USER: '', LOG_PASS: '' });
  t.after(() => world.close());
  assert.deepEqual([world.config.cancel.enabled, world.config.cancel.directEnabled, world.config.cancel.directAuthUser, world.config.cancel.directAuthPass], [true, true, '', '']);
  assert.ok(world.logger.has('error', /CANCEL_DIRECT_ENABLED=true sin credencial Basic .*: cancelación directa deshabilitada/));
  for (const p of ['/cancel/direct/auth', '/cancel/direct', '/cancel/direct/preview']) {
    const r = await post(world, p, { targetWorkflowIds: ['3101'] }, ADMIN);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
    const pre = await preflight(world, p);
    assert.equal(pre.status, 404, `preflight ${p}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.modelCalls.length, 0, 'nem o OTCS foi consultado');
});

test('modo direto desligado (CANCEL_DIRECT_ENABLED=false) ou sem CANCEL_ENABLED: 404 em /cancel/direct* (auth, preview, cancel), sem CORS e sem tocar Adobe/OTCS', async (t) => {
  const worlds = [
    // CANCEL_ENABLED ligado, CANCEL_DIRECT_ENABLED desligado (padrão)
    await directWorld(['3101'], { CANCEL_DIRECT_ENABLED: 'false' }),
    // CANCEL_DIRECT_ENABLED ligado, mas CANCEL_ENABLED desligado
    await directWorld(['3101'], { CANCEL_ENABLED: 'false' })
  ];
  for (const w of worlds) t.after(() => w.close());
  assert.deepEqual(worlds.map((w) => [w.config.cancel.enabled, w.config.cancel.directEnabled]), [[true, false], [false, true]]);
  assert.equal(worlds[0].logger.has('error', /CANCEL_DIRECT_ENABLED=true sin/), false);
  assert.equal(worlds[1].logger.has('error', /CANCEL_DIRECT_ENABLED=true sin/), false, 'sem CANCEL_ENABLED o modo direto nem é avaliado');

  for (const world of worlds) {
    for (const p of ['/cancel/direct/auth', '/cancel/direct', '/cancel/direct/preview']) {
      // credenciais diretas corretas e uma assinatura qualquer: nada existe
      const r = await post(world, p, { targetWorkflowIds: ['3101'], timestamp: '1', nonce: 'n'.repeat(16), signature: 'a'.repeat(64) }, DIRECT_ADMIN);
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
      const pre = await preflight(world, p);
      assert.equal(pre.status, 404, `preflight ${p}`);
      assert.equal(pre.headers.get('access-control-allow-origin'), null);
      // caixa diferente: o Express roteia sem distinguir, o portão do CORS também
      const preUpper = await preflight(world, p.toUpperCase());
      assert.equal(preUpper.headers.get('access-control-allow-origin'), null, `preflight ${p.toUpperCase()}`);
    }
    assert.equal(world.adobe.cancelled.length, 0);
    assert.deepEqual(world.otcs.stopped, []);
    assert.equal(world.otcs.modelCalls.length, 0, 'nem o OTCS foi consultado');
    assert.equal(world.repo.get('AG-3101').state, 'pending');
  }

  // com o modo direto desligado, o /cancel da tarefa e o seu CORS seguem iguais
  const [off] = worlds;
  assert.equal((await preflight(off, '/cancel')).headers.get('access-control-allow-origin'), OTCS_ORIGIN);
  assert.equal((await preflight(off, '/cancel/preview')).headers.get('access-control-allow-origin'), OTCS_ORIGIN);
});

test('POST /cancel/direct: vários alvos, cancela no Adobe e PARA cada original (mesmo com CANCEL_STOP_ORIGINAL=false), sem tarefa, formulário nem SendOn', async () => {
  const world = await directWorld(['3101', '3102', '3103'], { CANCEL_STOP_ORIGINAL: 'false' });
  seedCancelFlow(world); // um workflow de cancelamento qualquer: o modo direto nunca o consulta
  assert.equal(world.config.cancel.stopOriginal, false);

  const r = await direct(world, ['3101', '3102', '3103']);
  assert.equal(r.status, 200, await r.clone().text());
  const item = (id) => ({
    workflowId: id, outcome: 'cancelled', agreementId: `AG-${id}`, alreadyCancelled: false, adobeStatus: 'CANCELLED',
    contentStop: 'stopped', message: 'Acuerdo cancelado.'
  });
  assert.deepEqual(await r.json(), {
    mode: 'direct',
    complete: true,
    sentOn: false,
    items: [item('3101'), item('3102'), item('3103')],
    summary: { total: 3, cancelled: 3, refused: 0, pending: 0 },
    stopOriginal: true,
    subworkflowIgnored: false
  });

  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101', 'AG-3102', 'AG-3103']);
  assert.match(world.adobe.cancelled[0].comment, /^Flujo cancelado desde Content Server \(WebReport de cancelación\)\.$/);
  assert.deepEqual(world.otcs.stopped, [3101, 3102, 3103]);
  // ordem por item: Adobe confirmado -> stop original
  assert.deepEqual(world.otcs.modelCalls.filter((c) => c[0] === 'stopProcess'), [['stopProcess', 3101], ['stopProcess', 3102], ['stopProcess', 3103]]);
  assert.deepEqual(usedTaskApis(world), [], 'nunca lê passos, usuário, formulário nem grava atributos');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.calls.filter((c) => c[0] === 'otcs.sendon').length, 0);
  assert.equal(world.otcs.updateFormCalls.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current', 'o workflow de cancelamento não é tocado');
  for (const id of ['3101', '3102', '3103']) {
    const rec = world.repo.get(`AG-${id}`);
    assert.deepEqual([rec.state, rec.sendonDone, rec.cancelSource], ['cancelled', true, 'webreport:direct']);
  }
  // o eco RECALLED do Adobe não gera Rechazado
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.ok(world.logger.has('info', /\[CANCEL\] Directo \(webreport:direct\): lote concluido \(3 cancelados, 0 rechazados, 0 pendientes\)/));

  // CORS como o /cancel: origem do OTCS
  for (const p of ['/cancel/direct', '/cancel/direct/preview']) {
    assert.equal((await preflight(world, p)).headers.get('access-control-allow-origin'), OTCS_ORIGIN, p);
  }
  await world.close();
});

test('com o modo direto ligado, o /cancel da tarefa segue igual (sem mode, com SendOn)', async () => {
  const world = await directWorld(['3003']);
  seedCancelFlow(world);
  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual([body.complete, body.sentOn, body.stopOriginal, 'mode' in body], [true, true, false, false]);
  assert.equal(world.otcs.sendons.length, 1);
  assert.deepEqual(world.otcs.stopped, [], 'no modo da tarefa o stop continua dependendo de CANCEL_STOP_ORIGINAL');
  assert.equal(world.repo.get('AG-3003').cancelSource, 'workflow:9001/9001');
  await world.close();
});

test('POST /cancel/direct e /direct/preview: HMAC v2 vincula os alvos — adulterar, repetir, v1 e assinatura da tarefa são recusados sem cancelar', async () => {
  const world = await directWorld(['3101', '3102', '3103'], { START_LEGACY_SIGNATURE: 'true' });
  const sub = '3101';
  const fields = { targetWorkflowIds: ['3101'] };

  for (const p of ['/cancel/direct', '/cancel/direct/preview']) {
    assert.equal((await post(world, p, fields)).status, 401, `${p} sem assinatura`);
    assert.equal((await post(world, p, { ...fields, timestamp: '1', signature: 'zz' })).status, 400, `${p} malformada`);
    const v1 = await post(world, p, { ...fields, ...startBodyV1(world) });
    assert.equal(v1.status, 403, p);
    assert.deepEqual(await v1.json(), { error: 'Unsupported signature version.' });

    // alvo a mais, outro alvo, ordem trocada, alvo removido, subflujo acrescentado, tipo adulterado: todos 'Invalid signature'
    const two = { targetWorkflowIds: ['3101', '3102'] };
    const tampers = [
      [fields, { targetWorkflowIds: ['3101', '3102'] }],
      [fields, { targetWorkflowIds: ['3102'] }],
      [two, { targetWorkflowIds: ['3102', '3101'] }],
      [two, { targetWorkflowIds: ['3101'] }],
      [fields, { targetSubworkflowId: sub }],
      [{ ...fields, targetSubworkflowId: sub }, { targetSubworkflowId: '9' }],
      [{ ...fields, targetSubworkflowId: sub }, { targetSubworkflowId: undefined }],
      [fields, { targetWorkflowIds: { 0: '3101' } }],
      [fields, { targetWorkflowIds: 3103 }]
    ];
    for (const [signed, tamper] of tampers) {
      const r = await authThenCancel(world, signed, { path: p, tamper });
      assert.equal(r.status, 403, `${p} ${JSON.stringify(tamper)}`);
      assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
    }
    // a assinatura do /cancel da tarefa (sem alvos) não serve para escolher alvos
    const fromTask = await authThenCancel(world, { workflowId: '9001', subworkflowId: '9001' }, { path: p, extra: { targetWorkflowIds: ['3101'] } });
    assert.equal(fromTask.status, 403, `${p} assinatura da tarefa`);
  }

  // nonce de uso único; timestamp fora da janela
  const creds = await (await post(world, '/cancel/direct/auth', fields, DIRECT_ADMIN)).json();
  const okBody = { ...fields, ...creds };
  assert.equal((await post(world, '/cancel/direct', okBody)).status, 200);
  const replay = await post(world, '/cancel/direct', okBody);
  assert.equal(replay.status, 403);
  assert.deepEqual(await replay.json(), { error: 'Solicitud ya utilizada.' });
  const old = await (await post(world, '/cancel/direct/auth', fields, DIRECT_ADMIN)).json();
  world.clock.advance(3 * 60 * 1000);
  assert.equal((await post(world, '/cancel/direct', { ...fields, ...old })).status, 403);

  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101'], 'só a chamada válida cancelou');
  assert.deepEqual(world.otcs.stopped, [3101]);
  await world.close();
});

test('POST /cancel/direct: alvos inválidos => 422 (MISSING_TARGET / INVALID_TARGET / TOO_MANY_TARGETS), nada é consultado', async () => {
  const world = await directWorld(['3101', '3102', '3103'], { CANCEL_MAX_TARGETS: '2' });
  const call = async (targets, opts) => {
    const r = await direct(world, targets, opts);
    return [r.status, await r.json()];
  };

  const [sEmpty, bEmpty] = await call([]);
  assert.deepEqual([sEmpty, bEmpty.code], [422, 'MISSING_TARGET']);
  assert.equal(bEmpty.error, 'No se indicó ningún flujo a cancelar.');
  assert.deepEqual((await call(['', ' ', null]))[1].code, 'MISSING_TARGET');

  const [sBad, bBad] = await call(['3101', 'abc', '12x']);
  assert.deepEqual([sBad, bBad.code, bBad.invalid], [422, 'INVALID_TARGET', ['abc', '12x']]);
  assert.deepEqual((await call([{ id: 3101 }]))[1].code, 'INVALID_TARGET');
  assert.deepEqual((await call(['-5']))[1].code, 'INVALID_TARGET');

  // não-lista: texto, número, objeto, ausente (null/undefined) => INVALID_TARGET, mesmo com assinatura válida
  assert.deepEqual((await call('3101'))[1].code, 'INVALID_TARGET');
  assert.deepEqual((await call(3101))[1].code, 'INVALID_TARGET');
  assert.deepEqual((await call({ 0: '3101' }))[1].code, 'INVALID_TARGET');
  assert.deepEqual((await call(null))[1].code, 'INVALID_TARGET');
  assert.deepEqual((await call(undefined))[1].code, 'INVALID_TARGET');
  // a string '3101,3102' tem o mesmo texto canônico da lista ['3101','3102'] (a assinatura confere), mas o serviço a recusa
  const asString = await authThenCancel(world, { targetWorkflowIds: ['3101', '3102'] }, {
    path: '/cancel/direct', tamper: { targetWorkflowIds: '3101,3102' }, authPath: '/cancel/direct/auth', authHeaders: DIRECT_ADMIN
  });
  assert.equal(asString.status, 422);
  assert.equal((await asString.json()).code, 'INVALID_TARGET');

  // subflujo não numérico
  const [sSub, bSub] = await call(['3101'], { fields: { targetSubworkflowId: '30x5' } });
  assert.deepEqual([sSub, bSub.code, bSub.invalid], [422, 'INVALID_TARGET', ['30x5']]);

  // limite (CANCEL_MAX_TARGETS=2): duplicados não contam
  const [sMany, bMany] = await call(['3101', '3102', '3103']);
  assert.deepEqual([sMany, bMany.code, bMany.max], [422, 'TOO_MANY_TARGETS', 2]);
  assert.equal((await call(['3101', '3101', '3102', '3102']))[0], 200);

  // as mesmas validações valem na prévia
  for (const targets of [[], ['abc'], 'x', ['3101', '3102', '3103']]) {
    assert.equal((await direct(world, targets, { path: '/cancel/direct/preview' })).status, 422, JSON.stringify(targets));
  }

  assert.deepEqual(usedTaskApis(world), []);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101', 'AG-3102'], 'só o pedido com duplicados válidos cancelou');
  await world.close();
});

test('POST /cancel/direct: o subflujo vale com UM alvo (desempata) e é ignorado com vários (subworkflowIgnored)', async () => {
  const world = await cancelWorld({ ...DIRECT_ENV });
  open(world, 'AG-1', { subworkflowId: '3004' }); // fluxo 3003 com dois acordos abertos, em subprocessos diferentes
  open(world, 'AG-2', { subworkflowId: '3005' });
  open(world, 'AG-9', { workflowId: '4444', subworkflowId: '4444' });

  // sem subflujo: ambíguo (recusa definitiva do item), nada cancelado nem parado
  const ambiguous = await (await direct(world, ['3003'])).json();
  assert.deepEqual([ambiguous.complete, ambiguous.items[0].outcome, ambiguous.items[0].code], [true, 'refused', 'AMBIGUOUS']);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.deepEqual(world.otcs.stopped, []);

  // um alvo com subflujo: só o AG-2
  const one = await (await direct(world, ['3003'], { fields: { targetSubworkflowId: '3005' } })).json();
  assert.deepEqual([one.complete, one.subworkflowIgnored, one.items[0].agreementId, one.items[0].contentStop], [true, false, 'AG-2', 'stopped']);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-2']);
  assert.equal(world.repo.get('AG-1').state, 'pending');

  // vários alvos: o subflujo é ignorado (e avisado); o AG-2 já está cancelado, então o AG-1 é o único aberto do 3003
  const many = await (await direct(world, ['4444', '3003'], { fields: { targetSubworkflowId: '3005' } })).json();
  assert.equal(many.subworkflowIgnored, true);
  assert.deepEqual(many.items.map((i) => [i.workflowId, i.outcome, i.agreementId]), [['4444', 'cancelled', 'AG-9'], ['3003', 'cancelled', 'AG-1']]);
  assert.ok(world.logger.has('warn', /Directo: hay 2 flujos a cancelar; el subflujo 3005 se ignora/));

  // a prévia aplica a mesma regra
  const prev = await (await direct(world, ['3003'], { path: '/cancel/direct/preview', fields: { targetSubworkflowId: '3005' } })).json();
  assert.deepEqual([prev.mode, prev.subworkflowIgnored], ['direct', false]);
  await world.close();
});

test('POST /cancel/direct: lote misto (assinado => refused, Adobe fora do ar => pending) deixa complete:false; repetir fecha e é idempotente', async () => {
  const world = await directWorld(['3101', '3102', '3103']);
  world.adobe.agreements['AG-3102'].status = 'SIGNED';
  world.adobe.cancelFailures = 1; // o 1º cancelamento (3101) falha e a reconsulta mostra o acordo ainda aberto

  const body = await (await direct(world, ['3101', '3102', '3103'])).json();
  assert.deepEqual([body.mode, body.complete, body.sentOn], ['direct', false, false]);
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.outcome, i.code, i.contentStop]), [
    ['3101', 'pending', 'ADOBE_UNAVAILABLE', undefined],
    ['3102', 'refused', 'ALREADY_SIGNED', undefined],
    ['3103', 'cancelled', undefined, 'stopped']
  ]);
  assert.deepEqual(body.summary, { total: 3, cancelled: 1, refused: 1, pending: 1 });
  assert.deepEqual(world.otcs.stopped, [3103], 'o recusado e o pendente não são parados');
  assert.ok(world.logger.has('warn', /Directo \(webreport:direct\): lote incompleto/));

  // repetir: o que já foi cancelado volta como alreadyCancelled (e o stop é refeito, idempotente)
  const again = await (await direct(world, ['3101', '3102', '3103'])).json();
  assert.deepEqual(again.items.map((i) => [i.workflowId, i.outcome, i.alreadyCancelled]), [
    ['3101', 'cancelled', false], ['3102', 'refused', undefined], ['3103', 'cancelled', true]
  ]);
  assert.equal(again.complete, true);
  assert.deepEqual(world.otcs.stopped.sort(), [3101, 3103, 3103]);
  assert.equal(world.adobe.cancelled.length, 2, 'cada acordo foi cancelado uma única vez no Adobe');
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

test('POST /cancel/direct: falha ao parar o original => pending STOP_FAILED (complete:false); repetir só refaz o stop', async () => {
  const world = await directWorld(['3101', '3102']);
  world.otcs.stopFailures = 1; // o stop do 3101 falha com 403

  const body = await (await direct(world, ['3101', '3102'])).json();
  assert.deepEqual([body.complete, body.sentOn, body.stopOriginal], [false, false, true]);
  const [first, second] = body.items;
  assert.deepEqual([first.outcome, first.code, first.cancelledInAdobe, first.contentStop], ['pending', 'STOP_FAILED', true, 'failed']);
  assert.match(first.message, /cancelado en Adobe Sign, pero no se pudo detener el flujo en Content Server/);
  assert.match(first.message, /permisos del usuario de integración/);
  assert.deepEqual([second.outcome, second.contentStop], ['cancelled', 'stopped']);
  assert.equal(world.repo.get('AG-3101').state, 'cancelled', 'o Adobe/registro já estão cancelados');

  const again = await (await direct(world, ['3101', '3102'])).json();
  assert.equal(again.complete, true);
  assert.deepEqual(again.items.map((i) => [i.workflowId, i.alreadyCancelled, i.contentStop]), [
    ['3101', true, 'stopped'], ['3102', true, 'stopped']
  ]);
  assert.equal(world.adobe.cancelled.length, 2, 'nenhum novo cancelamento no Adobe');
  assert.ok(world.otcs.stopped.includes(3101));

  // o stop falha mas o processo já está parado => already_stopped (sucesso idempotente)
  const w2 = await directWorld(['3101']);
  w2.otcs.stopFailsButStops = 1;
  const ok = await (await direct(w2, ['3101'])).json();
  assert.deepEqual([ok.complete, ok.items[0].contentStop], [true, 'already_stopped']);
  await world.close();
  await w2.close();
});

test('POST /cancel/direct/preview: estados de cada alvo; não cancela, não para, não grava e não lê tarefa', async () => {
  const world = await directWorld(['3101', '3102']);
  world.adobe.agreements['AG-3102'].status = 'SIGNED';

  const r = await direct(world, ['3101', '3102', '3103'], { path: '/cancel/direct/preview' });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual([body.mode, body.stopOriginal, body.subworkflowIgnored], ['direct', true, false]);
  assert.deepEqual(body.items.map((i) => [i.workflowId, i.state, i.cancelable]), [
    ['3101', 'abierto', true], ['3102', 'firmado', false], ['3103', 'no_encontrado', false]
  ]);
  assert.deepEqual(body.summary, { total: 3, abierto: 1, firmado: 1, no_encontrado: 1 });
  assert.equal('complete' in body, false);

  assert.equal(world.adobe.cancelled.length, 0);
  assert.deepEqual(world.otcs.stopped, []);
  assert.equal(world.otcs.modelCalls.filter((c) => c[0] === 'stopProcess' || c[0] === 'getProcessStatus').length, 0);
  assert.deepEqual(usedTaskApis(world), []);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-3101').state, 'pending');
  assert.equal(world.repo.get('AG-3101').cancelRequestedAt, null);
  await world.close();
});

test('modo direto: requestedBy autodeclarado é sanitizado (uma linha, [A-Za-z0-9._@-], 64) e só vai ao source e ao comentário', async () => {
  const world = await directWorld(['3101', '3102', '3103', '3104', '3105']);
  const run = async (id, requestedBy) => {
    await world.cancellation.cancelDirect({ targetWorkflowIds: [id], requestedBy });
    return world.repo.get(`AG-${id}`).cancelSource;
  };
  const commentOf = (id) => world.adobe.cancelled.find((c) => c.id === `AG-${id}`).comment;

  assert.equal(await run('3101', ' pedro.barone@keralty.com '), 'webreport:direct:pedro.barone@keralty.com');
  assert.equal(commentOf('3101'), 'Flujo cancelado desde Content Server (WebReport de cancelación). Solicitado por pedro.barone@keralty.com.');

  const dirty = await run('3102', 'Ped ro\r\nX-Evil: <b>1</b>');
  assert.match(dirty, /^webreport:direct:[A-Za-z0-9._@-]+$/);
  assert.equal(dirty, 'webreport:direct:PedroX-Evilb1b');
  assert.doesNotMatch(commentOf('3102'), /[\r\n]/);

  assert.equal(await run('3103', 'a'.repeat(200)), `webreport:direct:${'a'.repeat(64)}`);
  // não-texto ou nada que sobre: sem usuário
  assert.equal(await run('3104', { toString: () => 'x' }), 'webreport:direct');
  assert.equal(await run('3105', '¡¿ !'), 'webreport:direct');
  assert.equal(commentOf('3105'), 'Flujo cancelado desde Content Server (WebReport de cancelación).');

  // por HTTP: requestedBy não entra no HMAC (a página o manda no /auth e na rota, mas adulterá-lo não invalida a assinatura)
  const w2 = await directWorld(['3101']);
  const r = await direct(w2, ['3101'], { fields: { requestedBy: 'maria' }, tamper: { requestedBy: 'outra' } });
  assert.equal(r.status, 200);
  assert.equal(w2.repo.get('AG-3101').cancelSource, 'webreport:direct:outra');
  await world.close();
  await w2.close();
});

test('modo direto: deriveKey separa por escopo e é estável (HMAC-SHA256 do segredo sobre o escopo)', () => {
  const k = deriveKey('segredo', DIRECT_SCOPE);
  assert.equal(DIRECT_SCOPE, 'cancel-direct');
  assert.match(k, /^[a-f0-9]{64}$/);
  assert.equal(k, deriveKey('segredo', 'cancel-direct'));
  assert.notEqual(k, deriveKey('segredo', 'outro'));
  assert.notEqual(k, deriveKey('outro-segredo', DIRECT_SCOPE));
  assert.notEqual(k, 'segredo');
});

test('modo direto: credencial e assinatura próprias — o /auth genérico não assina para o direto, nem o direto para /start e /cancel', async (t) => {
  const world = await directWorld(['3101', '3102'], { START_AUTH_USER: 'start-user', START_AUTH_PASS: 'start:pass' });
  t.after(() => world.close());
  seedCancelFlow(world);
  const START = { authorization: basicHeader('start-user', 'start:pass') };
  const fields = { targetWorkflowIds: ['3101'] };

  // 1) /auth genérico (START_AUTH_*; sem elas, LOG_*) assina, mas a assinatura NÃO vale nas rotas diretas
  const logOnly = await directWorld(['3101']); // sem START_AUTH_*: o /auth genérico usa LOG_USER/LOG_PASS
  t.after(() => logOnly.close());
  for (const [w, headers] of [[world, START], [logOnly, ADMIN]]) {
    for (const p of ['/cancel/direct', '/cancel/direct/preview']) {
      const r = await authThenCancel(w, fields, { path: p, authPath: '/auth', authHeaders: headers });
      assert.equal(r.status, 403, p);
      assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
    }
    assert.equal(w.adobe.cancelled.length, 0);
  }

  // 2) com credencial própria (DIRECT_ENV), START_AUTH_* / LOG_* não entram no /cancel/direct/auth; nem sem credencial
  for (const headers of [START, ADMIN, {}, { authorization: basicHeader('cancel-direct', 'errada') }, { authorization: basicHeader('outro', 'dir:pa:ss') }]) {
    assert.equal((await post(world, '/cancel/direct/auth', fields, headers)).status, 401, JSON.stringify(headers));
  }
  // e a credencial direta não vale no /auth genérico
  assert.equal((await post(world, '/auth', fields, DIRECT_ADMIN)).status, 401);

  // 3) a assinatura emitida com a credencial direta funciona de ponta a ponta (prévia e cancelamento)
  const prev = await direct(world, ['3101'], { path: '/cancel/direct/preview' });
  assert.equal(prev.status, 200, await prev.clone().text());
  const ok = await direct(world, ['3101']);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual([(await ok.json()).complete, world.otcs.stopped], [true, [3101]]);
  const creds = await (await post(world, '/cancel/direct/auth', fields, DIRECT_ADMIN)).json();
  assert.deepEqual(Object.keys(creds).sort(), ['nonce', 'signature', 'timestamp', 'v']);
  assert.equal(creds.v, 2);

  // 4) a assinatura direta NÃO vale no /cancel da tarefa, no /cancel/preview nem no /start (nem com os mesmos campos)
  const taskFields = { workflowId: '9001', subworkflowId: '9001' };
  for (const p of ['/cancel', '/cancel/preview']) {
    const r = await authThenCancel(world, taskFields, { path: p, authPath: '/cancel/direct/auth', authHeaders: DIRECT_ADMIN });
    assert.equal(r.status, 403, p);
    assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
  }
  const startFields = { userEmail1: 'a@example.com', nodeId: 1001, attachId: 2002, docName: 'c.pdf', workflowId: 3003, subworkflowId: 3004, taskId: 2 };
  const startCreds = await (await post(world, '/cancel/direct/auth', startFields, DIRECT_ADMIN)).json();
  const startRes = await post(world, '/start', { ...startFields, ...startCreds });
  assert.equal(startRes.status, 403);
  assert.deepEqual(await startRes.json(), { error: 'Invalid signature.' });
  assert.equal(world.otcs.sendons.length, 0);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-3101'], 'só o pedido direto válido cancelou');

  // 5) o inverso: a assinatura do /auth genérico segue valendo no /cancel da tarefa (sem mudança)
  const generic = await authThenCancel(world, taskFields, { path: '/cancel/preview', authHeaders: START });
  assert.equal(generic.status, 200, await generic.clone().text());
});
