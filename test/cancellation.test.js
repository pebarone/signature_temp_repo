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
const { CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget } = require('../server/domain/cancellation');
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

// Protocolo do WebReport: POST /auth (Basic) e POST /cancel com o que voltou. `extra` entra no corpo sem passar pelo /auth.
async function authThenCancel(world, fields = { workflowId: '9001', subworkflowId: '9001' }, { tamper = {}, extra = {} } = {}) {
  const auth = await post(world, '/auth', fields, ADMIN);
  assert.equal(auth.status, 200);
  const creds = await auth.json();
  return post(world, '/cancel', { ...fields, ...tamper, ...extra, ...creds });
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
    taskNames: ['Cancelar Flujo de Firma'],
    fields: { targetWorkflow: 'ID Flujo a Cancelar', targetSubworkflow: 'ID Subflujo a Cancelar' },
    notifySigners: false
  });
  const c = computeConfig({
    CANCEL_ENABLED: 'true', CANCEL_TASK_NAMES: 'Cancelar A, Cancelar B', CANCEL_FIELD_TARGET_WORKFLOW: 'Fluxo',
    CANCEL_FIELD_TARGET_SUBWORKFLOW: 'Subfluxo', CANCEL_NOTIFY_SIGNERS: '1'
  }).cancel;
  assert.deepEqual(c, {
    enabled: true, taskNames: ['Cancelar A', 'Cancelar B'],
    fields: { targetWorkflow: 'Fluxo', targetSubworkflow: 'Subfluxo' }, notifySigners: true
  });
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

/* ---------- banco e repositório ---------- */

test('db: banco no schema v3 recebe a migração v4 (cancelamento) preservando os dados', () => {
  assert.equal(MIGRATIONS.length, 4);
  const file = path.join(tmpDir(), 'v3.db');
  const raw = new Database(file);
  for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
  raw.pragma('user_version = 3');
  raw.prepare(`INSERT INTO agreements (id, node_id, workflow_id, state, created_at, updated_at) VALUES ('OLD', '1', '3003', 'pending', 'a', 'b')`).run();
  raw.close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  const cols = db.prepare('PRAGMA table_info(agreements)').all().map((c) => c.name);
  assert.ok(cols.includes('cancel_requested_at') && cols.includes('cancel_source'));
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
  assert.equal(again.pragma('user_version', { simple: true }), 4);
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

/* ---------- POST /cancel (WebReport) ---------- */

test('POST /cancel desligado (padrão): 404 mesmo com assinatura válida, sem CORS e sem tocar Adobe/OTCS', async () => {
  const world = await buildWorld({ listen: true, env: { OTCS_BASE: `${OTCS_ORIGIN}/cs/cs/api` } });
  assert.equal(world.config.cancel.enabled, false);
  seedCancelFlow(world);
  open(world, 'AG-1');

  const r = await authThenCancel(world);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
  const pre = await fetch(`${world.baseUrl}/cancel`, {
    method: 'OPTIONS', headers: { origin: OTCS_ORIGIN, 'access-control-request-method': 'POST' }
  });
  assert.equal(pre.status, 404);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);

  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'pending');
  await world.close();
});

test('POST /cancel ligado: cancela o fluxo do atributo e depois faz o SendOn da tarefa do workflow de cancelamento', async () => {
  const world = await cancelWorld({ OTCS_BASE: `${OTCS_ORIGIN}/cs/cs/api` });
  seedCancelFlow(world); // atributo "ID Flujo a Cancelar" = 3003
  open(world, 'AG-1');

  const r = await authThenCancel(world);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { message: 'Agreement cancelled. ID: AG-1', id: 'AG-1', alreadyCancelled: false });

  assert.equal(world.adobe.cancelled.length, 1);
  assert.match(world.adobe.cancelled[0].comment, /workflow de cancelación 9001/);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.state, rec.sendonDone, rec.cancelSource], ['cancelled', true, 'workflow:9001/9001']);

  // SendOn (sem disposição) da tarefa do workflow de cancelamento, DEPOIS do cancelamento confirmado
  assert.equal(world.otcs.sendons.length, 1);
  const sendon = world.otcs.sendons[0];
  assert.deepEqual([sendon.workflowId, sendon.subworkflowId, sendon.taskId, sendon.disposition], [9001, 9001, 2, undefined]);
  assert.equal(sendon.comment, 'Cancelación confirmada en Adobe Sign (acuerdo AG-1)');
  const names = world.calls.map((c) => c[0]);
  assert.ok(names.indexOf('adobe.cancelAgreement') < names.indexOf('otcs.sendon'));
  assert.equal(world.otcs.task('9001', 2).status, 'completed');
  assert.equal(world.otcs.task('9001', 3).status, 'current');
  // o fluxo original não é tocado pelo orquestrador
  assert.equal(world.otcs.task('3003', 3).status, 'current');
  assert.ok(world.otcs.sendons.every((s) => s.workflowId === 9001));

  // CORS como no /start: origem do OTCS
  const pre = await fetch(`${world.baseUrl}/cancel`, {
    method: 'OPTIONS', headers: { origin: OTCS_ORIGIN, 'access-control-request-method': 'POST' }
  });
  assert.equal(pre.headers.get('access-control-allow-origin'), OTCS_ORIGIN);
  await world.close();
});

test('POST /cancel: HMAC v2 e nonce — sem assinatura, adulterado, repetido, expirado e v1 são recusados sem cancelar', async () => {
  const world = await cancelWorld({ START_LEGACY_SIGNATURE: 'true' });
  seedCancelFlow(world);
  open(world, 'AG-1');
  const fields = { workflowId: '9001', subworkflowId: '9001' };

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

test('POST /cancel: tarefa não atribuída ao usuário de integração => 409 REASSIGN_REQUIRED com handoff; nada é cancelado', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world, { assignee: HUMAN_USER_ID });
  open(world, 'AG-1');

  const r = await authThenCancel(world);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'REASSIGN_REQUIRED');
  assert.deepEqual(body.handoff, {
    workflowId: 9001, subworkflowId: 9001, taskId: 2, integrationUserId: INTEGRATION_USER_ID, assigned: false
  });
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
  const forbidden = await authThenCancel(w2);
  assert.equal(forbidden.status, 409);
  assert.equal((await forbidden.json()).code, 'REASSIGN_REQUIRED');
  assert.equal(w2.adobe.cancelled.length, 0);
  await world.close();
  await w2.close();
});

test('POST /cancel: tarefa fora do passo de cancelamento, workflow inexistente e OTCS fora do ar', async () => {
  const world = await cancelWorld();
  open(world, 'AG-1');

  seedCancelFlow(world, { stage: 'done' }); // a tarefa de cancelamento já foi concluída
  let r = await authThenCancel(world);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'NOT_AT_CANCEL_STEP');

  seedCancelFlow(world);
  world.otcs.workflows['9001'].tasks[1].name = 'Outra tarefa'; // sem tarefa de cancelamento no processo
  r = await authThenCancel(world);
  assert.equal(r.status, 409);

  r = await authThenCancel(world, { workflowId: '7777', subworkflowId: '7777' }); // processo desconhecido (404 do OTCS)
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Flujo no encontrado.', code: 'FLOW_NOT_FOUND' });

  seedCancelFlow(world);
  world.otcs.stepsFailures = 1;
  r = await authThenCancel(world);
  assert.equal(r.status, 503);
  assert.equal((await authThenCancel(world, { workflowId: 'abc' })).status, 400);

  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

test('POST /cancel: o fluxo alvo vem do atributo do formulário, nunca do corpo', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world, { fields: { 'ID Flujo a Cancelar': '3003' } });
  open(world, 'AG-1');                                                     // alvo real (atributo)
  open(world, 'AG-D', { workflowId: '4444', subworkflowId: '4444' });      // alvo falso, enviado pelo navegador

  const r = await authThenCancel(world, undefined, { extra: { targetWorkflowId: '4444', targetSubworkflowId: '4444' } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).id, 'AG-1');
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-1']);
  assert.equal(world.repo.get('AG-D').state, 'pending');
  assert.ok(world.logger.has('warn', /targetWorkflowId=4444; se ignora/));

  // sem o atributo preenchido, o valor do corpo não substitui nada
  const w2 = await cancelWorld();
  seedCancelFlow(w2, { fields: { 'ID Flujo a Cancelar': '' } });
  open(w2, 'AG-D', { workflowId: '4444', subworkflowId: '4444' });
  const missing = await authThenCancel(w2, undefined, { extra: { targetWorkflowId: '4444' } });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).code, 'MISSING_TARGET');
  assert.equal(w2.adobe.cancelled.length, 0);
  assert.equal(w2.otcs.sendons.length, 0);
  await world.close();
  await w2.close();
});

test('POST /cancel: atributo ausente ou inválido => 422; o subprocesso do atributo desempata acordos abertos', async () => {
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
  assert.equal((await badSub.json()).code, 'INVALID_TARGET');

  // sem subprocesso: dois acordos abertos => ambíguo, nada cancelado e sem SendOn
  seedCancelFlow(world);
  const ambiguous = await authThenCancel(world);
  assert.equal(ambiguous.status, 409);
  const body = await ambiguous.json();
  assert.equal(body.code, 'AMBIGUOUS');
  assert.deepEqual(body.agreements.map((a) => a.id).sort(), ['AG-1', 'AG-2']);
  assert.equal(world.adobe.cancelled.length, 0);
  assert.equal(world.otcs.sendons.length, 0);

  // com o atributo do subprocesso: só o AG-2
  seedCancelFlow(world, { fields: { 'ID Subflujo a Cancelar': '3005' } });
  assert.equal((await authThenCancel(world)).status, 200);
  assert.deepEqual(world.adobe.cancelled.map((c) => c.id), ['AG-2']);
  assert.equal(world.repo.get('AG-1').state, 'pending');
  await world.close();
});

test('POST /cancel: fluxo sem acordo => 404 com dica; Adobe indisponível => 503; já assinado => 409; sem SendOn em todos', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world);

  const none = await authThenCancel(world);
  assert.equal(none.status, 404);
  const noneBody = await none.json();
  assert.equal(noneBody.code, 'AGREEMENT_NOT_FOUND');
  assert.match(noneBody.hint, /adopt/);

  open(world, 'AG-1');
  world.adobe.cancelFailures = 1;
  const down = await authThenCancel(world);
  assert.equal(down.status, 503);
  assert.equal((await down.json()).code, 'ADOBE_UNAVAILABLE');
  assert.equal(world.repo.get('AG-1').state, 'pending', 'nada marcado');

  world.adobe.agreements['AG-1'].status = 'SIGNED';
  const signed = await authThenCancel(world);
  assert.equal(signed.status, 409);
  assert.equal((await signed.json()).code, 'ALREADY_SIGNED');

  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.otcs.task('9001', 2).status, 'current');
  await world.close();
});

test('POST /cancel: falha no SendOn depois do cancelamento => 503 e repetir é idempotente (Adobe não é cancelado de novo)', async () => {
  const world = await cancelWorld();
  seedCancelFlow(world);
  open(world, 'AG-1');
  world.otcs.sendOnFailures = 1;

  const failed = await authThenCancel(world);
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.deepEqual([body.code, body.cancelled, body.id], ['SENDON_FAILED', true, 'AG-1']);
  assert.equal(world.adobe.cancelled.length, 1);
  assert.equal(world.repo.get('AG-1').state, 'cancelled');
  assert.equal(world.otcs.task('9001', 2).status, 'current', 'a tarefa de cancelamento continua ativa');

  const retry = await authThenCancel(world);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual(await retry.json(), { message: 'Agreement already cancelled. ID: AG-1', id: 'AG-1', alreadyCancelled: true });
  assert.equal(world.adobe.cancelled.length, 1, 'o cancelamento não é repetido no Adobe');
  assert.equal(world.otcs.task('9001', 2).status, 'completed');
  assert.equal(world.otcs.sendons.length, 1);

  // depois de concluída, uma terceira chamada já não está no passo de cancelamento
  assert.equal((await authThenCancel(world)).status, 409);
  await world.close();
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
