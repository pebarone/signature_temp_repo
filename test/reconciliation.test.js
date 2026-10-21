const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const { backoffDelay } = require('../server/domain/agreementState');
const {
  buildWorld, seedAgreement, webhookPayload, makeClock, makeAdobe, makeOtcs, tmpDir, httpError, basicHeader
} = require('./support/fakes');
const path = require('path');

// Entrega um evento de webhook ao serviço e aguarda o processamento assíncrono
// O Adobe "confirma" SIGNED por padrão (a verificação do final OK consulta o Adobe); testes podem sobrescrever
async function fire(world, event, id = 'AG-1', opts = {}) {
  world.adobe.agreements[id] ||= { id, status: 'SIGNED' };
  const result = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload(event, id, opts)));
  if (result.processing) await result.processing;
  return result;
}

const callNames = (world) => world.calls.map((c) => c[0]);
const sendonNames = (world) => world.otcs.sendons.map((s) => s.disposition || 'sendon');

test('tabela de política (fim a fim): cada evento produz a ação e o estado esperados', async (t) => {
  const EXP = { DISPOSITION_EXPIRED: 'Expirado', DISPOSITION_RECALLED: 'Cancelado', DISPOSITION_CONVERSION_FAILED: 'Erro' };
  const cases = [
    // [evento, opts, env, estado final, disposição, baixou PDF?]
    ['AGREEMENT_WORKFLOW_COMPLETED', {}, {}, 'completed', 'Firmado', true],
    ['AGREEMENT_ACTION_COMPLETED', { status: 'SIGNED' }, {}, 'completed', 'Firmado', true],
    ['AGREEMENT_ACTION_COMPLETED', { status: 'OUT_FOR_SIGNATURE' }, {}, 'pending', null, false],
    ['AGREEMENT_REJECTED', {}, {}, 'rejected', 'Rechazado', false],
    ['AGREEMENT_EXPIRED', {}, EXP, 'expired', 'Expirado', false],
    ['AGREEMENT_RECALLED', {}, EXP, 'cancelled', 'Cancelado', false],
    ['AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', {}, EXP, 'cancelled', 'Erro', false],
    // sem disposição configurada => needs_attention
    ['AGREEMENT_EXPIRED', {}, {}, 'needs_attention', null, false],
    ['AGREEMENT_RECALLED', {}, {}, 'needs_attention', null, false],
    ['AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', {}, {}, 'needs_attention', null, false],
    ['AGREEMENT_DOCUMENTS_DELETED', {}, {}, 'needs_attention', null, false],
    // legados
    ['AGREEMENT_COMPLETED', {}, {}, 'completed', 'Firmado', true],
    ['AGREEMENT_SIGNED', {}, {}, 'completed', 'Firmado', true],
    ['DOCUMENT_SIGNED', { status: 'OUT_FOR_SIGNATURE' }, {}, 'pending', null, false],
    ['DOCUMENT_SIGNED', { status: 'SIGNED' }, {}, 'completed', 'Firmado', true],
    ['PARTICIPANT_COMPLETED', { status: 'OUT_FOR_SIGNATURE' }, {}, 'pending', null, false],
    ['PARTICIPANT_SIGNED', { status: 'SIGNED' }, {}, 'completed', 'Firmado', true],
    // informativos, vermelhos e desconhecidos: nenhuma ação
    ...[
      'AGREEMENT_CREATED', 'AGREEMENT_ACTION_REQUESTED', 'AGREEMENT_MODIFIED', 'AGREEMENT_EMAIL_VIEWED',
      'AGREEMENT_REMINDER_SENT', 'AGREEMENT_SIGNER_NAME_CHANGED_BY_SIGNER',
      'AGREEMENT_VAULTED', 'AGREEMENT_KBA_AUTHENTICATED', 'AGREEMENT_WEB_IDENTITY_AUTHENTICATED',
      'AGREEMENT_BRAND_NEW_EVENT'
    ].map((e) => [e, {}, {}, 'pending', null, false])
  ];

  for (const [event, opts, env, state, disposition, downloaded] of cases) {
    await t.test(`${event} ${opts.status || ''} ${Object.keys(env).length ? '(disposições configuradas)' : ''}`, async () => {
      const world = await buildWorld({ env });
      seedAgreement(world);
      const result = await fire(world, event, 'AG-1', opts);
      assert.equal(result.known, true);

      const rec = world.repo.get('AG-1');
      assert.equal(rec.state, state);
      assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), disposition ? [disposition] : []);
      assert.equal(callNames(world).includes('adobe.download'), downloaded);
      assert.equal(world.otcs.uploads.length, downloaded ? 1 : 0);
      assert.equal(rec.sendonDone, !!disposition);
      assert.equal(world.repo.listEvents('AG-1').length, 1, 'evento sempre vai ao histórico');
      if (state === 'needs_attention') assert.ok(rec.attentionReason);
      await world.close();
    });
  }
});

test('evento desconhecido gera log warn e fica no histórico', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  const r = await fire(world, 'AGREEMENT_BRAND_NEW_EVENT');
  assert.equal(r.kind, 'unknown');
  assert.ok(world.logger.has('warn', /evento desconocido: AGREEMENT_BRAND_NEW_EVENT/));
  assert.equal(world.repo.listEvents('AG-1')[0].kind, 'unknown');
  await world.close();
});

test('eventos informativos/vermelhos não alteram o estado do acordo', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  const before = world.repo.get('AG-1');
  await fire(world, 'AGREEMENT_VAULTED');
  await fire(world, 'AGREEMENT_KBA_AUTHENTICATED');
  const after = world.repo.get('AG-1');
  assert.equal(after.state, before.state);
  assert.equal(after.finalKind, null);
  assert.equal(after.sendonDone, false);
  assert.equal(world.calls.length, 0);
  await world.close();
});

test('PDF final é enviado ao OTCS ANTES da disposição', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');

  assert.deepEqual(world.calls, [
    ['adobe.getAgreement', 'AG-1'], // confirmação do SIGNED no Adobe antes de entregar
    ['adobe.download', 'AG-1'],
    ['otcs.upload', '2002', 'contrato.pdf'],
    ['otcs.sendon', 'Firmado', 3]
  ]);
  assert.equal(world.otcs.uploads[0].folderId, '2002');
  const sendon = world.otcs.sendons[0];
  assert.equal(sendon.workflowId, '3003');
  assert.equal(sendon.subworkflowId, '3004');
  assert.equal(sendon.taskId, 3);

  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.pdfDelivered, true);
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.disposition, 'Firmado');
  assert.equal(rec.attempts, 0);
  await world.close();
});

test('falha no upload do PDF: não avança a tarefa e agenda retry com backoff', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.uploadFailures = 2;

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(world.otcs.dispositionCalls().length, 0, 'tarefa NÃO avança');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.pdfDelivered, false);
  assert.equal(rec.sendonDone, false);
  assert.equal(rec.attempts, 1);
  assert.equal(rec.lastErrorStage, 'pdf');
  assert.match(rec.lastError, /otcs upload failed/);
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.timers.length, 1);
  assert.equal(world.timers[0].ms, 60 * 1000);
  assert.ok(world.logger.has('error', /pdf failed \(attempt 1\)/), 'erro é logado, não engolido');

  // retry antes do vencimento do backoff é adiado (sem nova chamada ao Adobe)
  const downloadsBefore = callNames(world).filter((c) => c === 'adobe.download').length;
  const deferred = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(deferred.status, 'deferred');
  assert.equal(callNames(world).filter((c) => c === 'adobe.download').length, downloadsBefore);

  // segundo retry (ainda falha): backoff dobra
  world.clock.advance(60 * 1000);
  await world.timers[0].fn();
  await world.reconciliation.reconcile('AG-1', { force: false }); // aguarda a fila
  rec = world.repo.get('AG-1');
  assert.equal(rec.attempts, 2);
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 120 * 1000).toISOString());
  assert.equal(world.timers.at(-1).ms, 120 * 1000);
  assert.equal(world.otcs.dispositionCalls().length, 0);

  // terceiro retry: upload ok -> disposição
  world.clock.advance(120 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.attempts, 0);
  assert.equal(rec.lastError, null);
  assert.equal(world.otcs.uploads.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('falha na disposição mantém pdf_delivered e retenta só a disposição', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.dispositionFailures = 1;

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.pdfDelivered, true);
  assert.equal(rec.sendonDone, false);
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.equal(rec.attempts, 1);
  assert.equal(world.otcs.uploads.length, 1);
  assert.equal(world.timers[0].ms, 60 * 1000);

  const downloads = () => callNames(world).filter((c) => c === 'adobe.download').length;
  const uploads = () => callNames(world).filter((c) => c === 'otcs.upload').length;
  assert.equal(downloads(), 1);
  assert.equal(uploads(), 1);

  world.clock.advance(60 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  assert.equal(downloads(), 1, 'não baixa o PDF de novo');
  assert.equal(uploads(), 1, 'não envia o PDF de novo');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

test('falha no download do Adobe também agenda retry (nada é engolido)', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.downloadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.lastErrorStage, 'pdf');
  assert.equal(rec.pdfDelivered, false);
  assert.equal(world.otcs.uploads.length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.timers.length, 1);
  await world.close();
});

test('backoff exponencial de 1 min até 1 h', () => {
  const opts = { baseMs: 60 * 1000, maxMs: 60 * 60 * 1000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => backoffDelay(n, opts) / 60000),
    [1, 2, 4, 8, 16, 32, 60, 60, 60]
  );
});

test('disposição é executada uma única vez (eventos repetidos, concorrência e reconcile manual)', async () => {
  const world = await buildWorld();
  seedAgreement(world);

  // dois eventos finais distintos em paralelo
  const [a, b] = [
    world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'n1' }))),
    world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_ACTION_COMPLETED', 'AG-1', { notificationId: 'n2', status: 'SIGNED' })))
  ];
  await Promise.all([a.processing, b.processing]);
  // e um terceiro depois de concluído
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'n3' });
  const manual = await world.reconciliation.reconcile('AG-1');

  assert.equal(manual.status, 'done');
  assert.equal(world.otcs.uploads.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(callNames(world).filter((c) => c === 'adobe.download').length, 1);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

test('dedupe de webhook por webhookNotificationId', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  const first = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'dup-1' });
  const second = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'dup-1' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.processing, undefined);
  assert.equal(world.repo.listEvents('AG-1').length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('acordo desconhecido: não lança, só log warn (não é nosso ou o mapa foi perdido)', async () => {
  const world = await buildWorld();
  const r = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'NOPE')));
  assert.equal(r.known, false);
  assert.equal(r.reason, 'unknown_agreement');
  assert.ok(world.logger.has('warn', /desconocido NOPE/));
  const none = world.reconciliation.handleEvent(parseWebhookPayload({ event: 'AGREEMENT_CREATED' }));
  assert.equal(none.known, false);
  assert.equal(world.calls.length, 0);
  assert.equal((await world.reconciliation.reconcile('NOPE')).status, 'unknown');
  await world.close();
});

test('rejeitado: só disposição Rechazado, sem baixar PDF', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  await fire(world, 'AGREEMENT_REJECTED');
  assert.deepEqual(world.calls, [['otcs.sendon', 'Rechazado', 3]]);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.pdfDelivered, false);
  await world.close();
});

test('expirado/cancelado/falha de conversão: nome da disposição é configurável; vazio => needs_attention', async () => {
  // padrão (vazio)
  const w1 = await buildWorld();
  seedAgreement(w1);
  await fire(w1, 'AGREEMENT_EXPIRED');
  let rec = w1.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.match(rec.attentionReason, /sin disposición configurada \(expired\)/);
  assert.equal(w1.otcs.sendons.length, 0);
  assert.equal(w1.timers.filter((t) => !t.cleared).length, 0, 'sem retry automático');

  // o operador configura o nome e força a reconciliação
  w1.config.dispositions.expired = 'Expirado';
  const res = await w1.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'completed');
  rec = w1.repo.get('AG-1');
  assert.equal(rec.state, 'expired');
  assert.equal(rec.attentionReason, null);
  assert.deepEqual(w1.otcs.dispositionCalls().map((s) => s.disposition), ['Expirado']);
  await w1.close();

  // configurado desde o início
  const w2 = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado', DISPOSITION_CONVERSION_FAILED: 'Erro Conv' } });
  seedAgreement(w2, 'AG-R');
  seedAgreement(w2, 'AG-C');
  await fire(w2, 'AGREEMENT_RECALLED', 'AG-R');
  await fire(w2, 'AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', 'AG-C');
  assert.deepEqual(w2.otcs.dispositionCalls().map((s) => s.disposition), ['Cancelado', 'Erro Conv']);
  await w2.close();
});

test('AGREEMENT_DOCUMENTS_DELETED depois de concluído não reabre o acordo', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  await fire(world, 'AGREEMENT_DOCUMENTS_DELETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

test('acordo sem attachId ou sem workflowId vai para needs_attention', async () => {
  const w1 = await buildWorld();
  seedAgreement(w1, 'AG-1', { attachId: null });
  await fire(w1, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w1.repo.get('AG-1').state, 'needs_attention');
  assert.equal(w1.otcs.sendons.length, 0);
  await w1.close();

  const w2 = await buildWorld();
  seedAgreement(w2, 'AG-2', { workflowId: '', subworkflowId: '' });
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-2');
  const rec = w2.repo.get('AG-2');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.pdfDelivered, true, 'o PDF já foi entregue');
  await w2.close();
});

test('reconcile manual com refresh consulta o Adobe e recupera acordo assinado', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  const res = await world.reconciliation.reconcile('AG-1', { refresh: true });
  assert.equal(res.status, 'completed');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

/* ---------- polling ---------- */

test('poller recupera acordo SIGNED sem webhook', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };

  const summary = await world.poller.tick();
  assert.equal(summary.polled, 1);
  assert.equal(summary.finalized, 1);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.adobeStatus, 'SIGNED');
  assert.deepEqual(callNames(world).filter((c) => c !== 'adobe.getAgreement'), ['adobe.download', 'otcs.upload', 'otcs.sendon']);
  assert.equal(world.repo.listEvents('AG-1')[0].source, 'poll');

  // acordo concluído não é mais consultado
  const again = await world.poller.tick();
  assert.equal(again.polled, 0);
  await world.close();
});

test('poller: acordo ainda em andamento só atualiza o status', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  const s = await world.poller.tick();
  assert.equal(s.polled, 1);
  assert.equal(s.finalized, 0);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pending');
  assert.equal(rec.adobeStatus, 'OUT_FOR_SIGNATURE');
  assert.ok(rec.lastPolledAt);
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

test('poller: expirado e cancelado/recolhido (com e sem disposição configurada)', async () => {
  const world = await buildWorld({ env: { DISPOSITION_EXPIRED: 'Expirado' } });
  seedAgreement(world, 'AG-E');
  seedAgreement(world, 'AG-C');
  world.adobe.agreements['AG-E'] = { id: 'AG-E', status: 'EXPIRED' };
  world.adobe.agreements['AG-C'] = { id: 'AG-C', status: 'CANCELLED' };
  await world.poller.tick();
  assert.equal(world.repo.get('AG-E').state, 'expired');
  assert.equal(world.repo.get('AG-C').state, 'needs_attention'); // DISPOSITION_RECALLED vazio
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Expirado']);
  await world.close();
});

test('poller: CANCELLED sem evento de recusa é recall e usa a disposição de cancelado', async () => {
  const world = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado' } });
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.events['AG-1'] = [{ type: 'CREATED' }, { type: 'CANCELLED' }];
  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').state, 'cancelled');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Cancelado']);
  await world.close();
});

test('poller: rejeição no Adobe v6 (CANCELLED + evento REJECTED/ACTION_REJECTED) usa a disposição de rejeitado', async () => {
  const world = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado' } });
  seedAgreement(world, 'AG-R');
  seedAgreement(world, 'AG-A');
  for (const [id, type] of [['AG-R', 'REJECTED'], ['AG-A', 'ACTION_REJECTED']]) {
    world.adobe.agreements[id] = { id, status: 'CANCELLED' };
    world.adobe.events[id] = [{ type: 'CREATED' }, { type }];
  }
  await world.poller.tick();
  for (const id of ['AG-R', 'AG-A']) {
    const rec = world.repo.get(id);
    assert.equal(rec.state, 'rejected');
    assert.equal(rec.finalKind, 'final_rejected');
    assert.equal(rec.disposition, 'Rechazado');
  }
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Rechazado', 'Rechazado']);
  assert.equal(callNames(world).includes('adobe.download'), false);
  await world.close();
});

test('poller: falha ao ler os eventos de um CANCELLED não finaliza (warn) e o próximo ciclo retenta', async () => {
  const world = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado' } });
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.events['AG-1'] = [{ type: 'REJECTED' }];
  world.adobe.eventsError = httpError(500, 'events down');

  await world.poller.tick();
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pending');
  assert.equal(rec.finalKind, null);
  assert.equal(rec.adobeStatus, null, 'nada gravado');
  assert.equal(rec.lastPolledAt, null);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  assert.equal(world.otcs.sendons.length, 0);
  assert.ok(world.logger.has('warn', /events down/));

  world.adobe.eventsError = null;
  await world.poller.tick();
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.disposition, 'Rechazado');
  await world.close();
});

test('reconcile manual com refresh: falha nos eventos do CANCELLED devolve refresh_failed sem finalizar', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.eventsError = httpError(503, 'events down');
  const res = await world.reconciliation.reconcile('AG-1', { refresh: true });
  assert.equal(res.status, 'refresh_failed');
  assert.equal(world.repo.get('AG-1').finalKind, null);
  await world.close();
});

test('poller: erro ao consultar um acordo não interrompe os demais', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-MISSING');
  seedAgreement(world, 'AG-OK');
  world.adobe.agreements['AG-OK'] = { id: 'AG-OK', status: 'SIGNED' };
  const s = await world.poller.tick();
  assert.equal(s.errors, 1);
  assert.equal(world.repo.get('AG-OK').state, 'completed');
  assert.equal(world.repo.get('AG-MISSING').state, 'pending');
  await world.close();
});

test('poller reprocessa pendências vencidas (PDF entregue sem disposição) e respeita o backoff', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.dispositionFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'pdf_delivered');

  let s = await world.poller.tick(); // backoff ainda não venceu
  assert.equal(s.retried, 0);
  assert.equal(world.otcs.dispositionCalls().length, 0);

  world.clock.advance(61 * 1000);
  s = await world.poller.tick();
  assert.equal(s.retried, 1);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.otcs.uploads.length, 1);
  await world.close();
});

test('poller: acordos além de POLL_MAX_AGE_DAYS deixam de ser consultados', async () => {
  const world = await buildWorld({ env: { POLL_MAX_AGE_DAYS: '90' } });
  seedAgreement(world);
  world.clock.advance(91 * 24 * 60 * 60 * 1000);
  const s = await world.poller.tick();
  assert.equal(s.polled, 0);
  await world.close();
});

/* ---------- estado sobrevive a restart ---------- */

test('estado persistido sobrevive a restart (reabre o arquivo SQLite) e retoma só a disposição', async () => {
  const dbFile = path.join(tmpDir('restart-'), 'state', 'orchestrator.db');
  const clock = makeClock();

  const w1 = await buildWorld({ dbFile, clock });
  seedAgreement(w1);
  w1.otcs.dispositionFailures = 1;
  await fire(w1, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'persist-1' });
  assert.equal(w1.repo.get('AG-1').state, 'pdf_delivered');
  await w1.close(); // "pod" cai

  // novo processo: fakes novos, mesmo arquivo
  const w2 = await buildWorld({ dbFile, clock });
  const rec = w2.repo.get('AG-1');
  assert.ok(rec, 'mapa agreement -> workflow sobreviveu');
  assert.equal(rec.workflowId, '3003');
  assert.equal(rec.attachId, '2002');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.pdfDelivered, true);
  assert.equal(rec.attempts, 1);
  assert.equal(w2.repo.listEvents('AG-1').length, 1);

  // dedupe também sobrevive
  const dup = w2.reconciliation.handleEvent(
    parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'persist-1' }))
  );
  assert.equal(dup.duplicate, true);

  // antes do backoff nada acontece; depois, só a disposição roda
  assert.deepEqual(await w2.reconciliation.runQueue(), []);
  clock.advance(61 * 1000);
  assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-1']);
  assert.deepEqual(w2.calls, [['otcs.sendon', 'Firmado', 3]]);
  assert.equal(w2.otcs.uploads.length, 0, 'PDF não é reenviado após o restart');
  assert.equal(w2.repo.get('AG-1').state, 'completed');
  await w2.close();

  // e um terceiro start não repete nada
  const w3 = await buildWorld({ dbFile, clock });
  assert.deepEqual(await w3.reconciliation.runQueue(), []);
  assert.equal(w3.repo.get('AG-1').sendonDone, true);
  await w3.close();
});

test('restart no meio: evento final persistido mas processamento não concluído é retomado pelo runQueue', async () => {
  const dbFile = path.join(tmpDir('restart-'), 'orchestrator.db');
  const clock = makeClock();
  const w1 = await buildWorld({ dbFile, clock });
  seedAgreement(w1);
  // processo cai logo após registrar o evento final (sem aguardar o processamento)
  w1.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1')));
  w1.db.close();

  const w2 = await buildWorld({ dbFile, clock });
  assert.equal(w2.repo.get('AG-1').finalKind, 'final_ok');
  w2.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-1']);
  assert.equal(w2.repo.get('AG-1').state, 'completed');
  assert.equal(w2.otcs.uploads.length, 1);
  await w2.close();
});

/* ---------- limite de tentativas e erros permanentes ---------- */

test('RETRY_MAX_ATTEMPTS: ao atingir o limite vai para needs_attention com o motivo e o último erro', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3' } });
  seedAgreement(world);
  world.otcs.uploadFailures = 99;

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  for (const wait of [60, 120]) {
    assert.equal(world.repo.get('AG-1').state, 'signed');
    world.clock.advance(wait * 1000);
    await world.reconciliation.reconcile('AG-1', { force: false });
  }
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attempts, 3);
  assert.equal(rec.nextAttemptAt, null);
  assert.match(rec.attentionReason, /reintentos agotados en pdf \(3\/3\).*otcs upload failed/);
  assert.match(rec.lastError, /otcs upload failed/);
  assert.equal(world.timers.at(-1).cleared, true, 'sem timer de retry pendente');
  assert.ok(world.logger.has('error', /needs_attention: reintentos agotados/));

  // needs_attention não é reprocessado pelo runQueue
  world.clock.advance(24 * 60 * 60 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), []);
  await world.close();
});

test('RETRY_MAX_ATTEMPTS=0 não limita as tentativas; o padrão é 10', async () => {
  assert.equal((await buildWorld()).config.backoff.maxAttempts, 10);
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '0' } });
  assert.equal(world.config.backoff.maxAttempts, 0);
  seedAgreement(world);
  world.otcs.uploadFailures = 99;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  for (let i = 0; i < 14; i++) {
    world.clock.advance(60 * 60 * 1000);
    await world.reconciliation.reconcile('AG-1', { force: false });
  }
  const rec = world.repo.get('AG-1');
  assert.equal(rec.attempts, 15);
  assert.equal(rec.state, 'signed');
  await world.close();
});

test('needs_attention por limite de tentativas: reconcile manual zera as tentativas (rodada nova)', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  seedAgreement(world);
  world.otcs.uploadFailures = 2;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');
  assert.equal(world.repo.get('AG-1').attempts, 2);

  // rodada nova: uma falha não estoura o limite de novo (attempts volta a 1, não 3)
  world.otcs.uploadFailures = 1;
  let res = await world.reconciliation.reconcile('AG-1', { force: true, refresh: true, manual: true });
  assert.equal(res.status, 'failed');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attentionReason, null);

  // e agora o manual conclui
  res = await world.reconciliation.reconcile('AG-1', { force: true, refresh: true, manual: true });
  assert.equal(res.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.attempts, 0);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('POST /admin/reconcile/:id reprocessa um needs_attention (erro permanente) e conclui', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  world.otcs.dispositionFailStatus = 404;
  world.otcs.dispositionFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');
  assert.equal(world.repo.get('AG-1').pdfDelivered, true);

  const r = await fetch(`${world.baseUrl}/admin/reconcile/AG-1`, {
    method: 'POST', headers: { authorization: basicHeader('admin', 'pa:ss') }
  });
  assert.equal((await r.json()).result.status, 'completed');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.attempts, 0);
  assert.equal(rec.attentionReason, null);
  assert.equal(world.otcs.uploads.length, 1, 'PDF não é reenviado');
  await world.close();
});

test('erro 4xx na disposição (exceto 401/408/429) => needs_attention na hora; 401/408/429 e 5xx retentam', async () => {
  for (const [status, permanent] of [[400, true], [403, true], [404, true], [409, true], [401, false], [408, false], [429, false], [500, false]]) {
    const world = await buildWorld();
    seedAgreement(world);
    world.otcs.dispositionFailStatus = status;
    world.otcs.dispositionFailures = 1;
    await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
    const rec = world.repo.get('AG-1');
    assert.equal(rec.attempts, 1, `HTTP ${status}`);
    assert.equal(rec.lastErrorStage, 'disposition');
    if (permanent) {
      assert.equal(rec.state, 'needs_attention', `HTTP ${status}`);
      assert.match(rec.attentionReason, new RegExp(`error permanente en disposition.*HTTP ${status}`));
      assert.equal(rec.pdfDelivered, true, 'PDF entregue é preservado');
      assert.equal(world.timers.length, 0, 'sem retry agendado');
    } else {
      assert.equal(rec.state, 'pdf_delivered', `HTTP ${status}`);
      assert.equal(world.timers.length, 1);
    }
    await world.close();
  }
});

test('erro 4xx no upload do PDF segue a mesma regra; falha de download no Adobe nunca é permanente', async () => {
  let world = await buildWorld();
  seedAgreement(world);
  world.otcs.uploadFailStatus = 403;
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.match(rec.attentionReason, /error permanente en pdf.*HTTP 403/);
  assert.equal(rec.pdfDelivered, false);
  assert.equal(world.otcs.dispositionCalls().length, 0);
  await world.close();

  world = await buildWorld();
  seedAgreement(world);
  world.otcs.uploadFailStatus = 429;
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'signed');
  assert.equal(world.timers.length, 1);
  await world.close();

  world = await buildWorld();
  seedAgreement(world);
  world.adobe.downloadFailures = 1; // httpError(500)
  const origDownload = world.adobe.downloadCombinedDocument;
  world.adobe.downloadCombinedDocument = async (id) => {
    try { return await origDownload(id); } catch (e) { e.response.status = 404; throw e; }
  };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed', 'download do Adobe com 404 ainda retenta (regra é do OTCS)');
  assert.equal(world.timers.length, 1);
  await world.close();
});

/* ---------- consultas filtradas no SQL ---------- */

test('repo.listPending/listPollable: filtram no SQL (final x sem final, sem concluídos nem needs_attention)', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'A-POLL');
  seedAgreement(world, 'A-ATT-NOFINAL', { state: 'needs_attention' });
  seedAgreement(world, 'A-PEND', { finalKind: 'final_ok', state: 'signed' });
  seedAgreement(world, 'A-PEND-ATT', { finalKind: 'final_ok', state: 'needs_attention' });
  seedAgreement(world, 'A-DONE', { finalKind: 'final_ok', state: 'completed', sendonDone: true });
  seedAgreement(world, 'A-DONE-NOFINAL', { sendonDone: true });

  assert.deepEqual(world.repo.listPollable().map((r) => r.id), ['A-POLL']);
  assert.deepEqual(world.repo.listPending().map((r) => r.id), ['A-PEND']);
  await world.close();
});

/* ---------- Adobe como fonte da verdade (final OK vindo de webhook) ---------- */

const getAgreementCalls = (world) => callNames(world).filter((c) => c === 'adobe.getAgreement').length;

test('final OK por webhook confirma SIGNED no Adobe antes do PDF e grava adobeStatus', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.deepEqual(callNames(world), ['adobe.getAgreement', 'adobe.download', 'otcs.upload', 'otcs.sendon']);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.adobeStatus, 'SIGNED');
  await world.close();
});

test('final OK forjado (Adobe diz que não está SIGNED): needs_attention, sem PDF nem disposição', async () => {
  for (const [event, opts] of [
    ['AGREEMENT_WORKFLOW_COMPLETED', {}],
    ['AGREEMENT_ACTION_COMPLETED', { status: 'SIGNED' }] // o status do payload não é confiável
  ]) {
    const world = await buildWorld();
    seedAgreement(world);
    world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
    const result = await fire(world, event, 'AG-1', opts);
    assert.equal(result.known, true);

    const rec = world.repo.get('AG-1');
    assert.equal(rec.state, 'needs_attention');
    assert.equal(rec.attentionReason, 'evento final no confirmado por Adobe: CANCELLED');
    assert.equal(rec.adobeStatus, null, 'status do payload/Adobe não confirmado não vira "verificado"');
    assert.equal(rec.sendonDone, false);
    assert.equal(world.otcs.uploads.length, 0);
    assert.equal(world.otcs.sendons.length, 0);
    assert.equal(callNames(world).includes('adobe.download'), false);
    assert.ok(world.logger.has('error', /evento final no confirmado por Adobe: CANCELLED/));
    await world.close();
  }
});

test('falha ao consultar o Adobe na verificação: registerFailure stage "verify" (retry com backoff) e depois conclui', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  const getAgreement = world.adobe.getAgreement;
  world.adobe.getAgreement = async () => { throw httpError(503, 'adobe down'); };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  world.adobe.getAgreement = getAgreement;
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.lastErrorStage, 'verify');
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.timers.length, 1);
  assert.equal(world.timers[0].ms, 60 * 1000);
  assert.match(rec.lastError, /adobe down/);
  assert.equal(world.otcs.uploads.length, 0);
  assert.equal(callNames(world).includes('adobe.download'), false);

  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  world.clock.advance(60 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  assert.equal(world.repo.get('AG-1').adobeStatus, 'SIGNED');
  await world.close();
});

test('final OK com Adobe ainda em andamento (OUT_FOR_SIGNATURE) é transitório: retry com backoff, não needs_attention', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.notEqual(rec.state, 'needs_attention');
  assert.equal(rec.lastErrorStage, 'verify');
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.timers.length, 1);
  assert.equal(world.otcs.uploads.length, 0);
  assert.equal(callNames(world).includes('adobe.download'), false);
  assert.equal(world.otcs.dispositionCalls().length, 0);

  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  world.clock.advance(60 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  const done = world.repo.get('AG-1');
  assert.equal(done.state, 'completed');
  assert.equal(done.disposition, 'Firmado');
  assert.equal(done.adobeStatus, 'SIGNED');
  await world.close();
});

test('adobeStatus já SIGNED (veio do polling) dispensa a consulta extra', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(getAgreementCalls(world), 1, 'só a consulta do próprio polling');
  await world.close();
});

test('status do payload do webhook não é gravado em adobeStatus (fica só no resumo do evento)', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };

  // evento informativo forjado dizendo SIGNED não pode "pré-verificar" o acordo
  await fire(world, 'AGREEMENT_CREATED', 'AG-1', { status: 'SIGNED' });
  let rec = world.repo.get('AG-1');
  assert.equal(rec.adobeStatus, null);
  assert.equal(world.repo.listEvents('AG-1')[0].summary.status, 'SIGNED');

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { status: 'SIGNED', notificationId: 'forged-final' });
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention', 'Adobe é consultado e não confirma');
  assert.equal(getAgreementCalls(world), 1);
  assert.equal(rec.adobeStatus, null);
  await world.close();
});

test('só o final OK é verificado: rejeição/expiração por webhook seguem sem consultar o Adobe', async () => {
  const world = await buildWorld({ env: { DISPOSITION_EXPIRED: 'Expirado' } });
  seedAgreement(world, 'AG-R');
  seedAgreement(world, 'AG-E');
  await fire(world, 'AGREEMENT_REJECTED', 'AG-R');
  await fire(world, 'AGREEMENT_EXPIRED', 'AG-E');
  assert.equal(getAgreementCalls(world), 0);
  assert.equal(world.repo.get('AG-R').state, 'rejected');
  assert.equal(world.repo.get('AG-E').state, 'expired');
  await world.close();
});

test('reconcile manual de um final OK não confirmado volta a consultar o Adobe e conclui quando SIGNED', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');

  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  const res = await world.reconciliation.reconcile('AG-1', { force: true, refresh: true, manual: true });
  assert.equal(res.status, 'completed');
  assert.equal(world.repo.get('AG-1').adobeStatus, 'SIGNED');
  await world.close();
});
