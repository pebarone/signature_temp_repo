const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const { backoffDelay } = require('../server/domain/agreementState');
const {
  buildWorld, seedAgreement, webhookPayload, makeClock, makeAdobe, makeOtcs, tmpDir
} = require('./support/fakes');
const path = require('path');

// Entrega um evento de webhook ao serviço e aguarda o processamento assíncrono
async function fire(world, event, id = 'AG-1', opts = {}) {
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

test('poller: rejeição no Adobe v6 aparece como CANCELLED e usa a disposição de cancelado', async () => {
  const world = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado' } });
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').state, 'cancelled');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Cancelado']);
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
  assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-1']);
  assert.equal(w2.repo.get('AG-1').state, 'completed');
  assert.equal(w2.otcs.uploads.length, 1);
  await w2.close();
});
