const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const { backoffDelay, shouldPoll } = require('../server/domain/agreementState');
const {
  buildWorld, seedAgreement, seedAdobeForEvent, webhookPayload, makeClock, makeAdobe, makeOtcs, tmpDir, httpError, basicHeader,
  waitFor, INTEGRATION_USER_ID, HUMAN_USER_ID
} = require('./support/fakes');
const path = require('path');

// Entrega um evento de webhook ao serviço e aguarda o processamento assíncrono
// O Adobe confirma o evento por padrão (toda verificação de final consulta o Adobe); testes podem sobrescrever antes
async function fire(world, event, id = 'AG-1', opts = {}) {
  seedAdobeForEvent(world.adobe, event, id, opts);
  const result = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload(event, id, opts)));
  if (result.processing) await result.processing;
  return result;
}

const callNames = (world) => world.calls.map((c) => c[0]);
const sendonNames = (world) => world.otcs.sendons.map((s) => s.disposition || 'sendon');

test('tabela de política (fim a fim): cada evento produz a ação e o estado esperados', async (t) => {
  const EXP = { DISPOSITION_EXPIRED: 'Expirado', DISPOSITION_RECALLED: 'Cancelado', DISPOSITION_CONVERSION_FAILED: 'Erro' };
  const NONE = { DISPOSITION_EXPIRED: '', DISPOSITION_RECALLED: '', DISPOSITION_CONVERSION_FAILED: '' };
  const cases = [
    // [evento, opts, env, estado final, disposição, baixou PDF?]
    ['AGREEMENT_WORKFLOW_COMPLETED', {}, {}, 'completed', 'Firmado', true],
    ['AGREEMENT_ACTION_COMPLETED', { status: 'SIGNED' }, {}, 'completed', 'Firmado', true],
    ['AGREEMENT_ACTION_COMPLETED', { status: 'OUT_FOR_SIGNATURE' }, {}, 'pending', null, false],
    ['AGREEMENT_REJECTED', {}, {}, 'rejected', 'Rechazado', false],
    ['AGREEMENT_EXPIRED', {}, EXP, 'expired', 'Expirado', false],
    ['AGREEMENT_RECALLED', {}, EXP, 'cancelled', 'Cancelado', false],
    ['AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', {}, EXP, 'cancelled', 'Erro', false],
    // padrão: o mapa só tem Firmado/Rechazado, então expirado/cancelado/conversão encerram como Rechazado
    ['AGREEMENT_EXPIRED', {}, {}, 'expired', 'Rechazado', false],
    ['AGREEMENT_RECALLED', {}, {}, 'cancelled', 'Rechazado', false],
    ['AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', {}, {}, 'cancelled', 'Rechazado', false],
    // disposição vazia => needs_attention
    ['AGREEMENT_EXPIRED', {}, NONE, 'needs_attention', null, false],
    ['AGREEMENT_RECALLED', {}, NONE, 'needs_attention', null, false],
    ['AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', {}, NONE, 'needs_attention', null, false],
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
      world.otcs.customActions.push(...Object.values(env).filter(Boolean)); // nomes configurados existem no mapa
      seedAgreement(world);
      const result = await fire(world, event, 'AG-1', opts);
      assert.equal(result.known, true);

      const rec = world.repo.get('AG-1');
      assert.equal(rec.state, state);
      assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), disposition ? [disposition] : []);
      assert.equal(callNames(world).includes('adobe.download'), downloaded);
      assert.equal(world.otcs.versions.length, downloaded ? 1 : 0);
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
    ['otcs.addVersion', '1001', 'contrato.pdf'],
    ['otcs.sendon', 'Firmado', 3]
  ]);
  assert.equal(world.otcs.versions[0].nodeId, '1001', 'PDF assinado = nova versão do nó enviado à assinatura');
  assert.equal(world.otcs.uploads.length, 0, 'nenhum documento novo na pasta');
  const sendon = world.otcs.sendons[0];
  assert.equal(sendon.workflowId, 3003);
  assert.equal(sendon.subworkflowId, 3004);
  assert.equal(sendon.taskId, 3);

  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.pdfDelivered, true);
  assert.equal(rec.pdfNodeId, '1001');
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.disposition, 'Firmado');
  assert.equal(rec.signSubprocessId, '3004');
  assert.equal(rec.signTaskId, 3);
  assert.equal(rec.completedExternally, false);
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
  assert.equal(world.otcs.versions.length, 1);
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
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.timers[0].ms, 60 * 1000);

  const downloads = () => callNames(world).filter((c) => c === 'adobe.download').length;
  const uploads = () => callNames(world).filter((c) => c === 'otcs.addVersion').length;
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
  assert.equal(world.otcs.versions.length, 0);
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
  assert.equal(world.otcs.versions.length, 1);
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
  assert.deepEqual(world.calls, [
    ['adobe.getAgreement', 'AG-1'], // o CANCELLED é confirmado no Adobe (recusa, pelos eventos) antes da disposição
    ['adobe.getAgreementEvents', 'AG-1'],
    ['otcs.sendon', 'Rechazado', 3]
  ]);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.pdfDelivered, false);
  await world.close();
});

test('expirado/cancelado/falha de conversão: nome da disposição é configurável; vazio => needs_attention', async () => {
  // vazio explícito => needs_attention (o padrão agora é Rechazado)
  const w1 = await buildWorld({ env: { DISPOSITION_EXPIRED: '' } });
  seedAgreement(w1);
  await fire(w1, 'AGREEMENT_EXPIRED');
  let rec = w1.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.match(rec.attentionReason, /sin disposición configurada \(expired\)/);
  assert.equal(rec.attentionKind, 'config');
  assert.equal(w1.otcs.sendons.length, 0);
  assert.equal(w1.timers.filter((t) => !t.cleared).length, 0, 'sem retry automático');

  // o operador configura o nome e força a reconciliação
  w1.config.dispositions.expired = 'Expirado';
  w1.otcs.customActions.push('Expirado');
  const res = await w1.reconciliation.reconcile('AG-1', { manual: true });
  assert.equal(res.status, 'completed');
  rec = w1.repo.get('AG-1');
  assert.equal(rec.state, 'expired');
  assert.equal(rec.attentionReason, null);
  assert.deepEqual(w1.otcs.dispositionCalls().map((s) => s.disposition), ['Expirado']);
  await w1.close();

  // configurado desde o início
  const w2 = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado', DISPOSITION_CONVERSION_FAILED: 'Erro Conv' } });
  w2.otcs.customActions.push('Cancelado', 'Erro Conv');
  seedAgreement(w2, 'AG-R', { workflowId: '3103', subworkflowId: '3104' });
  seedAgreement(w2, 'AG-C', { workflowId: '3203', subworkflowId: '3204' });
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

test('acordo sem nodeId/attachId ou sem workflowId vai para needs_attention (attachId só importa no fallback)', async () => {
  // sem attachId mas com nodeId: o PDF vira versão do nó, então segue normalmente
  const w0 = await buildWorld();
  seedAgreement(w0, 'AG-1', { attachId: null });
  await fire(w0, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w0.repo.get('AG-1').state, 'completed');
  await w0.close();

  const w1 = await buildWorld();
  seedAgreement(w1, 'AG-1', { attachId: null, nodeId: null });
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
  assert.deepEqual(callNames(world).filter((c) => c !== 'adobe.getAgreement'), ['adobe.download', 'otcs.addVersion', 'otcs.sendon']);
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
  const world = await buildWorld({ env: { DISPOSITION_EXPIRED: 'Expirado', DISPOSITION_RECALLED: '' } });
  world.otcs.customActions.push('Expirado');
  seedAgreement(world, 'AG-E');
  seedAgreement(world, 'AG-C', { workflowId: '3103', subworkflowId: '3104' });
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
  world.otcs.customActions.push('Cancelado');
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
  seedAgreement(world, 'AG-A', { workflowId: '3103', subworkflowId: '3104' });
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
  assert.equal(world.otcs.versions.length, 1);
  await world.close();
});

test('POLL_ENABLED=false: a fila de retries continua sendo revisada após o restart (backoff ainda não vencido no start)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = await buildWorld({ env: { POLL_ENABLED: 'false', POLL_INTERVAL_MS: '1000', POLL_INITIAL_DELAY_MS: '0' } });
  t.after(() => world.close());
  seedAgreement(world);
  world.otcs.dispositionFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'pdf_delivered');
  world.reconciliation.stop(); // "restart": o timer de retry em memória se perde

  let passes = 0;
  const runQueue = world.reconciliation.runQueue;
  world.reconciliation.runQueue = async () => { passes++; return runQueue(); };

  assert.equal(world.poller.start(), false);
  await waitFor(() => passes >= 1); // primeira passada roda, mas o backoff ainda não venceu
  assert.equal(world.otcs.dispositionCalls().length, 0);

  world.clock.advance(61 * 1000);
  t.mock.timers.tick(1000);
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 1, 'só a verificação do final OK; sem polling de status');
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
  w2.otcs.addWorkflow('3003', { subprocessId: '3004' });
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
  assert.equal(w2.otcs.versions.length, 0, 'PDF não é reenviado após o restart');
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
  w2.otcs.addWorkflow('3003', { subprocessId: '3004' });
  assert.equal(w2.repo.get('AG-1').finalKind, 'final_ok');
  w2.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-1']);
  assert.equal(w2.repo.get('AG-1').state, 'completed');
  assert.equal(w2.otcs.versions.length, 1);
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
  // permanente: a tarefa não oferece a disposição configurada (só dado/config; 4xx do OTCS já não é permanente)
  world.otcs.customActions = ['Otra'];
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');
  assert.equal(world.repo.get('AG-1').attentionKind, 'permanent');
  assert.equal(world.repo.get('AG-1').pdfDelivered, true);
  world.otcs.customActions = ['Firmado', 'Rechazado'];

  const r = await fetch(`${world.baseUrl}/admin/reconcile/AG-1`, {
    method: 'POST', headers: { authorization: basicHeader('admin', 'pa:ss') }
  });
  assert.equal((await r.json()).result.status, 'completed');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.attempts, 0);
  assert.equal(rec.attentionReason, null);
  assert.equal(world.otcs.versions.length, 1, 'PDF não é reenviado');
  await world.close();
});

test('erro 4xx na disposição também retenta com backoff (nenhum status vai direto para needs_attention)', async () => {
  for (const status of [400, 403, 404, 409, 401, 408, 429, 500]) {
    const world = await buildWorld();
    seedAgreement(world);
    world.otcs.dispositionFailStatus = status;
    world.otcs.dispositionFailures = 1;
    await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
    const rec = world.repo.get('AG-1');
    assert.equal(rec.attempts, 1, `HTTP ${status}`);
    assert.equal(rec.lastErrorStage, 'disposition');
    assert.equal(rec.state, 'pdf_delivered', `HTTP ${status}`);
    assert.equal(rec.pdfDelivered, true, 'PDF entregue é preservado');
    assert.equal(world.timers.length, 1, 'retry agendado');
    await world.close();
  }
});

test('erro 4xx no upload do PDF: nó existente (inclusive 403 sem permissão) retenta; nó inexistente (400/404) cai para a pasta; 429 e download 404 do Adobe retentam', async () => {
  // 403 no addVersion com o nó existente (a sonda confirma): transitório, sem fallback
  let world = await buildWorld();
  seedAgreement(world);
  world.otcs.uploadFailStatus = 403;
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.match(rec.lastError, /existe pero rechazó la nueva versión.*HTTP 403/);
  assert.equal(rec.pdfDelivered, false);
  assert.equal(world.timers.length, 1);
  assert.equal(world.otcs.uploads.length, 0, 'sem fallback com o nó existente');
  assert.equal(world.otcs.dispositionCalls().length, 0);
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'completed', 'o retry entrega como nova versão');
  assert.equal(world.otcs.versions.length, 1);
  await world.close();

  // 403 e a sonda também responde 403 (o nó existe, o usuário de integração não tem permissão): o PDF assinado NÃO vai para
  // a pasta de anexos (o fluxo distribui o DocID sem assinatura); retenta até a permissão ser corrigida
  world = await buildWorld();
  seedAgreement(world);
  world.otcs.missingNodes.add('1001');
  world.otcs.missingNodeStatus = 403;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.match(rec.lastError, /el documento 1001 existe pero rechazó la nueva versión.*HTTP 403.*sin permiso/);
  assert.equal(world.otcs.uploads.length, 0, 'sem fallback para a pasta');
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(world.timers.length, 1);
  world.otcs.missingNodes.clear(); // permissão corrigida
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.deepEqual(world.otcs.versions.map((v) => v.nodeId), ['1001']);
  assert.equal(world.otcs.uploads.length, 0);
  await world.close();

  world = await buildWorld();
  seedAgreement(world);
  world.otcs.uploadFailStatus = 429;
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'signed');
  assert.equal(world.timers.length, 1);
  assert.ok(!world.otcs.modelCalls.some((c) => c[0] === 'nodeExists'), '429 é transitório: sem sonda');
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
  assert.deepEqual(callNames(world), ['adobe.getAgreement', 'adobe.download', 'otcs.addVersion', 'otcs.sendon']);
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
    assert.equal(world.otcs.versions.length, 0);
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
  assert.equal(world.otcs.versions.length, 0);
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
  assert.equal(world.otcs.versions.length, 0);
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

test('rejeição/expiração por webhook são confirmadas no Adobe antes da disposição', async () => {
  const world = await buildWorld({ env: { DISPOSITION_EXPIRED: 'Expirado' } });
  world.otcs.customActions.push('Expirado');
  seedAgreement(world, 'AG-R');
  seedAgreement(world, 'AG-E', { workflowId: '3103', subworkflowId: '3104' });
  await fire(world, 'AGREEMENT_REJECTED', 'AG-R');
  await fire(world, 'AGREEMENT_EXPIRED', 'AG-E');
  assert.equal(getAgreementCalls(world), 2, 'uma consulta por webhook: o status do payload não basta');
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 1, 'só o CANCELLED pede o histórico');
  assert.equal(world.repo.get('AG-R').state, 'rejected');
  assert.equal(world.repo.get('AG-R').adobeStatus, 'CANCELLED');
  assert.equal(world.repo.get('AG-E').state, 'expired');
  assert.equal(world.repo.get('AG-E').adobeStatus, 'EXPIRED');
  await world.close();
});

test('expiração confirmada pelo Adobe (EXPIRED): disposição Rechazado (padrão) e adobeStatus gravado', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  await fire(world, 'AGREEMENT_EXPIRED');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Rechazado']);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'expired');
  assert.equal(rec.adobeStatus, 'EXPIRED');
  assert.equal(getAgreementCalls(world), 1);
  await world.close();
});

test('AGREEMENT_EXPIRED forjado com o Adobe em andamento: nenhuma disposição; retry com backoff; esgotado => retries_exhausted', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await fire(world, 'AGREEMENT_EXPIRED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.lastErrorStage, 'verify');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(callNames(world).includes('adobe.download'), false);

  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'retries_exhausted');
  assert.match(rec.attentionReason, /reintentos agotados en verify \(2\/2\)/);
  assert.equal(world.otcs.dispositionCalls().length, 0, 'nenhuma disposição');
  assert.equal(world.otcs.versions.length, 0);
  await world.close();
});

test('AGREEMENT_REJECTED forjado com o Adobe em SIGNED: adota o final OK (PDF como versão, Firmado) e registra a troca', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await fire(world, 'AGREEMENT_REJECTED');
  assert.deepEqual(callNames(world), ['adobe.getAgreement', 'adobe.download', 'otcs.addVersion', 'otcs.sendon'], 'uma só consulta ao Adobe');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.finalKind, 'final_ok');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.adobeStatus, 'SIGNED');
  assert.equal(world.otcs.versions.length, 1);
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Firmado']);
  const verify = world.repo.listEvents('AG-1').filter((e) => e.source === 'verify');
  assert.equal(verify.length, 1);
  assert.equal(verify[0].canonical, 'VERIFY_STATUS_SIGNED');
  assert.equal(verify[0].kind, 'final_ok');
  assert.ok(world.logger.has('warn', /se adopta el resultado de Adobe/));
  await world.close();
});

test('AGREEMENT_RECALLED com o Adobe CANCELLED + evento de recusa: adota final_rejected', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.events['AG-1'] = [{ type: 'REJECTED' }];
  await fire(world, 'AGREEMENT_RECALLED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.finalKind, 'final_rejected');
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.adobeStatus, 'CANCELLED');
  assert.equal(world.otcs.dispositionCalls()[0].comment, 'Rechazado por el firmante en Adobe Sign');
  assert.equal(world.repo.listEvents('AG-1').find((e) => e.source === 'verify').kind, 'final_rejected');
  await world.close();
});

test('falha de conversão: CANCELLED (com ou sem recusa) e ABORTED confirmam o resultado, sem adotar outro', async () => {
  for (const [status, events] of [['CANCELLED', []], ['CANCELLED', [{ type: 'REJECTED' }]], ['ABORTED', []]]) {
    const world = await buildWorld();
    seedAgreement(world);
    world.adobe.agreements['AG-1'] = { id: 'AG-1', status };
    world.adobe.events['AG-1'] = events;
    await fire(world, 'AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM');
    const rec = world.repo.get('AG-1');
    assert.equal(rec.finalKind, 'final_conversion_failed', `${status} com ${events.length} evento(s)`);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.adobeStatus, status);
    assert.equal(world.repo.listEvents('AG-1').filter((e) => e.source === 'verify').length, 0);
    assert.equal(world.otcs.dispositionCalls()[0].comment, 'Adobe Sign no pudo procesar el documento');
    await world.close();
  }
});

test('falha ao consultar os eventos do CANCELLED: retry com backoff, sem disposição; depois conclui', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.eventsError = httpError(503, 'events down');
  await fire(world, 'AGREEMENT_REJECTED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.lastErrorStage, 'verify');
  assert.equal(rec.attempts, 1);
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(world.timers.length, 1);

  world.adobe.eventsError = null;
  world.clock.advance(60 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal(rec.disposition, 'Rechazado');
  assert.equal(rec.adobeStatus, 'CANCELLED');
  await world.close();
});

test('webhook que troca o resultado gravado pelo polling zera o adobeStatus: o verify consulta o Adobe e adota o recall', async () => {
  const world = await buildWorld({ env: { DISPOSITION_RECALLED: 'Cancelado' } });
  world.otcs.customActions.push('Cancelado');
  seedAgreement(world);
  // o polling viu CANCELLED sem recusa (recall); a disposição falha uma vez, de forma transitória
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.events['AG-1'] = [];
  world.otcs.dispositionFailures = 1;
  await world.poller.tick();
  let rec = world.repo.get('AG-1');
  assert.equal(rec.finalKind, 'final_recalled');
  assert.equal(rec.adobeStatus, 'CANCELLED');
  assert.equal(rec.sendonDone, false);
  assert.equal(world.otcs.dispositionCalls().length, 0);

  // webhook forjado diz REJECTED: troca o kind e zera o adobeStatus; o verify consulta os eventos e adota o recall
  await fire(world, 'AGREEMENT_REJECTED');
  rec = world.repo.get('AG-1');
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 2, 'uma do polling e uma da verificação');
  assert.equal(rec.finalKind, 'final_recalled');
  assert.equal(rec.state, 'cancelled');
  assert.equal(rec.adobeStatus, 'CANCELLED');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Cancelado']);
  assert.equal(world.otcs.dispositionCalls()[0].comment, 'Acuerdo cancelado en Adobe Sign');
  assert.equal(world.repo.listEvents('AG-1').find((e) => e.source === 'verify').kind, 'final_recalled');
  await world.close();
});

test('webhook do mesmo resultado não zera o adobeStatus gravado pelo polling (sem consulta extra)', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'EXPIRED' };
  world.otcs.dispositionFailures = 1;
  await world.poller.tick(); // EXPIRED gravado; a disposição falha uma vez
  assert.equal(world.repo.get('AG-1').adobeStatus, 'EXPIRED');

  await fire(world, 'AGREEMENT_EXPIRED');
  assert.equal(getAgreementCalls(world), 1, 'só a consulta do polling');
  assert.equal(world.repo.get('AG-1').adobeStatus, 'EXPIRED');
  assert.equal(world.repo.get('AG-1').state, 'expired');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Rechazado']);
  await world.close();
});

test('webhook final com o Adobe sem resultado (ABORTED, status desconhecido ou vazio): needs_attention unconfirmed, sem disposição nem PDF', async () => {
  for (const event of ['AGREEMENT_REJECTED', 'AGREEMENT_EXPIRED']) {
    for (const status of ['ABORTED', 'FOO', '']) {
      const world = await buildWorld();
      seedAgreement(world);
      world.adobe.agreements['AG-1'] = { id: 'AG-1', status };
      await fire(world, event);
      const rec = world.repo.get('AG-1');
      assert.equal(rec.state, 'needs_attention', `${event} com ${status || 'vazio'}`);
      assert.equal(rec.attentionKind, 'unconfirmed');
      assert.equal(rec.attentionReason, `evento final no confirmado por Adobe: ${status || 'sin estado'}`);
      assert.equal(world.otcs.dispositionCalls().length, 0);
      assert.equal(world.otcs.versions.length, 0);
      assert.equal(callNames(world).includes('adobe.download'), false);
      await world.close();
    }
  }
});

test('poll gravou andamento (adobeStatus OUT_FOR_SIGNATURE) e depois chega o final: o verify consulta o Adobe de novo', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').adobeStatus, 'OUT_FOR_SIGNATURE');
  assert.equal(getAgreementCalls(world), 1);

  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(getAgreementCalls(world), 2, 'andamento gravado não confirma o final: nova consulta');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.repo.get('AG-1').adobeStatus, 'SIGNED');
  await world.close();
});

test('final vindo do polling (adobeStatus gravado e compatível): o verify não consulta o Adobe de novo', async () => {
  const cases = [
    ['EXPIRED', [], 'expired', 0],
    ['CANCELLED', [{ type: 'REJECTED' }], 'rejected', 1],
    ['CANCELLED', [], 'cancelled', 1]
  ];
  for (const [status, events, state, eventsCalls] of cases) {
    const world = await buildWorld();
    seedAgreement(world);
    world.adobe.agreements['AG-1'] = { id: 'AG-1', status };
    world.adobe.events['AG-1'] = events;
    await world.poller.tick();
    assert.equal(world.repo.get('AG-1').state, state, status);
    assert.equal(getAgreementCalls(world), 1, `${status}: só a consulta do próprio polling`);
    assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, eventsCalls, `${status}: eventos`);
    await world.close();
  }
});

test('verify que adotaria outro resultado com PDF já entregue: needs_attention unconfirmed, sem PDF nem disposição', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { finalKind: 'final_rejected', state: 'rejected', pdfDelivered: true });
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await world.reconciliation.reconcile('AG-1', { force: true });
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'unconfirmed');
  assert.match(rec.attentionReason, /ya tiene final_rejected con el PDF entregado/);
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(world.otcs.versions.length, 0);
  assert.equal(callNames(world).includes('adobe.download'), false);
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

/* ---------- tarefa só no subprocesso do acordo (A2) ---------- */

const ADMIN_HEADERS = { authorization: basicHeader('admin', 'pa:ss'), 'content-type': 'application/json' };
const adminReconcile = (world, id, body) => fetch(`${world.baseUrl}/admin/reconcile/${id}`, {
  method: 'POST', headers: ADMIN_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

test('A2 disposição: o Firmado do S1 (Aguardar Firma já concluída à mão) não conclui a tarefa current do S2 do mesmo pai', async () => {
  const world = await buildWorld();
  seedAgreement(world); // pai 3003, subprocesso do acordo (S1) = 3004
  world.otcs.addSubprocess('3003', 3005, { stage: 'sign' }); // S2 com "Aguardar Firma" current
  world.otcs.task('3003', 3, 3004).status = 'completed'; // S1 concluído manualmente

  const res = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(res.known, true);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.completedExternally, true);
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.state, 'completed');
  assert.equal(rec.signSubprocessId, '3004');
  assert.equal(world.otcs.sendons.length, 0, 'nenhum SendOn nem disposição');
  assert.equal(world.otcs.task('3003', 3, 3005).status, 'current', 'a tarefa do S2 continua current');
  await world.close();
});

test('A2 início: o início concluído do S1 não deixa o SendOn ir para a tarefa de início current do S2', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  world.otcs.addSubprocess('3003', 3005, { stage: 'start' });
  world.otcs.task('3003', 2, 3004).status = 'completed'; // início do S1 já enviado fora da integração

  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'start_sent');
  assert.equal(world.otcs.sendons.length, 0, 'nenhum SendOn no S2');
  assert.equal(world.otcs.task('3003', 2, 3005).status, 'current');
  assert.equal(world.repo.get('AG-1').startSendonDone, true);
  await world.close();
});

test('A2: a dica aponta um subprocesso sem a tarefa => retry transitório citando em que outro subprocesso ela existe', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: 3005, stage: 'sign' }); // a tarefa só existe no 3005
  seedAgreement(world, 'AG-1', { subworkflowId: '3004' });
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.match(rec.lastError, /existe en otro subproceso: 3005; no corresponde al acuerdo, subproceso 3004/);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.timers.length, 1);
  await world.close();
});

test('dica = pai com um único subprocesso: a disposição vai para esse subprocesso', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: 3004, stage: 'sign' });
  seedAgreement(world, 'AG-1', { subworkflowId: '3003' }); // WebReport antigo: WFID nos dois campos
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.otcs.dispositionCalls()[0].subworkflowId, 3004);
  assert.equal(world.repo.get('AG-1').signSubprocessId, '3004');
  await world.close();
});

test('tarefa ambígua (dica = pai, dois subprocessos): needs_attention permanente sem SendOn; POST /admin/reconcile com subworkflowId conclui no escolhido', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.addWorkflow('3003', { subprocessId: 3004, stage: 'sign' });
  world.otcs.addSubprocess('3003', 3005, { stage: 'sign' });
  seedAgreement(world, 'AG-1', { subworkflowId: '3003' });

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'permanent');
  assert.match(rec.attentionReason, /más de un subproceso \(3004, 3005\) del workflow 3003.*subworkflowId 3003/);
  assert.match(rec.attentionReason, /POST \/admin\/reconcile\/AG-1/);
  assert.equal(rec.pdfDelivered, true);
  assert.equal(world.otcs.sendons.length, 0, 'nenhum SendOn');
  assert.equal(world.timers.length, 0, 'sem retry agendado');

  // corpo inválido: 422 e nada muda
  let r = await adminReconcile(world, 'AG-1', { subworkflowId: '30x5' });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: 'subworkflowId must be numeric.' });
  assert.equal(world.repo.get('AG-1').subworkflowId, '3003');
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');

  // subprocesso escolhido: corrige o registro, loga e conclui no S2
  r = await adminReconcile(world, 'AG-1', { subworkflowId: 3005 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal(rec.subworkflowId, '3005');
  assert.equal(rec.state, 'completed');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.otcs.dispositionCalls()[0].subworkflowId, 3005);
  assert.equal(world.otcs.task('3003', 3, 3004).status, 'current', 'a tarefa do S1 não foi tocada');
  assert.ok(world.logger.has('warn', /\[AG-1\] subproceso corregido manualmente: 3003 -> 3005/));

  // acordo já concluído: 409 e o subprocesso gravado não muda
  r = await adminReconcile(world, 'AG-1', { subworkflowId: '3004' });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Agreement already concluded.' });
  assert.equal(world.repo.get('AG-1').subworkflowId, '3005');

  // sem corpo / corpo sem subworkflowId: comportamento de sempre
  r = await adminReconcile(world, 'AG-1');
  assert.equal(r.status, 200);
  r = await adminReconcile(world, 'AG-1', {});
  assert.equal(r.status, 200);
  assert.equal(world.repo.get('AG-1').subworkflowId, '3005');
  await world.close();
});

test('tarefa de início ambígua (dica = pai, dois subprocessos): needs_attention permanente sem SendOn', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: 3004, stage: 'start' });
  world.otcs.addSubprocess('3003', 3005, { stage: 'start' });
  seedAgreement(world, 'AG-1', { subworkflowId: '3003', startSendonDone: false });
  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'needs_attention');
  assert.match(res.reason, /Enviar solicitud de firma.*más de un subproceso \(3004, 3005\)/);
  assert.equal(world.repo.get('AG-1').attentionKind, 'permanent');
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

/* ---------- 4xx do OTCS: sonda do nó e retry (M1) ---------- */

test('M1: addVersion 400 em nó inexistente/inacessível => sonda, fallback para a pasta e conclusão; 404 não sonda', async () => {
  for (const status of [400, 404]) {
    const world = await buildWorld();
    seedAgreement(world);
    world.otcs.missingNodes.add('1001');
    world.otcs.missingNodeStatus = status;
    await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
    const rec = world.repo.get('AG-1');
    assert.equal(rec.state, 'completed', `HTTP ${status}`);
    assert.equal(world.otcs.versions.length, 0);
    assert.equal(world.otcs.uploads.length, 1);
    assert.equal(world.otcs.uploads[0].folderId, '2002');
    assert.equal(rec.pdfNodeId, '9001');
    assert.ok(world.logger.has('warn', /el nodo 1001 ya no existe/), `HTTP ${status}`);
    const probes = world.otcs.modelCalls.filter((c) => c[0] === 'nodeExists').length;
    assert.equal(probes, status === 404 ? 0 : 1, `sondas com HTTP ${status}`);
    await world.close();
  }
});

test('M1: nó existente que rejeita a versão (reservado, 409) é transitório; liberado o nó, o retry entrega como versão', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.lockedNodes.add('1001');
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.lastErrorStage, 'pdf');
  assert.match(rec.lastError, /el documento 1001 existe pero rechazó la nueva versión.*HTTP 409.*reservado o sin permiso/);
  assert.equal(world.timers.length, 1);
  assert.equal(world.otcs.uploads.length, 0, 'sem fallback');
  assert.equal(world.otcs.sendons.length, 0);

  world.otcs.lockedNodes.clear();
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.versions[0].nodeId, '1001');
  assert.equal(rec.pdfNodeId, '1001');
  assert.equal(world.otcs.uploads.length, 0);
  await world.close();
});

test('M1: a sonda do nó falha (500) => transitório, sem fallback; na tentativa seguinte a sonda decide', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.missingNodes.add('1001');
  world.otcs.missingNodeStatus = 400;
  world.otcs.nodeExistsFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.lastErrorStage, 'pdf');
  assert.match(rec.lastError, /HTTP 400/, 'o erro registrado é o do addVersion');
  assert.equal(world.otcs.uploads.length, 0, 'sem saber se o nó existe não há fallback');
  assert.equal(world.timers.length, 1);

  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(world.otcs.uploads.length, 1, 'sonda ok: o nó não existe => pasta de anexos');
  await world.close();
});

test('M1: falha 4xx no uploadToFolder (fallback) também é transitória', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.missingNodes.add('1001');
  world.otcs.uploadFailStatus = 403;
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.attentionReason, null);
  assert.equal(world.timers.length, 1);
  assert.equal(world.otcs.uploads.length, 0);

  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.uploads.length, 1);
  await world.close();
});

test('M1: disposição com 403 até esgotar => retries_exhausted (não permanent) e reopenStale reabre depois de ATTENTION_RETRY_HOURS', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3', ATTENTION_RETRY_HOURS: '6' } });
  seedAgreement(world);
  world.otcs.dispositionFailStatus = 403;
  world.otcs.dispositionFailures = 99;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  for (const wait of [60, 120]) {
    assert.equal(world.repo.get('AG-1').state, 'pdf_delivered');
    world.clock.advance(wait * 1000);
    await world.reconciliation.reconcile('AG-1', { force: false });
  }
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'retries_exhausted');
  assert.match(rec.attentionReason, /reintentos agotados en disposition \(3\/3\).*HTTP 403/);
  assert.equal(rec.pdfDelivered, true);

  // antes do prazo não reabre; depois reabre sozinho e o runQueue conclui
  world.clock.advance(5 * 60 * 60 * 1000);
  assert.deepEqual(await world.reconciliation.reopenStale(), []);
  world.clock.advance(2 * 60 * 60 * 1000);
  assert.deepEqual(await world.reconciliation.reopenStale(), ['AG-1']);
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.attempts, 0);
  world.otcs.dispositionFailures = 0;
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

test('M1: getProcessSteps com 403 é transitório; 404 (workflow inexistente) segue permanente', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.stepsFailStatus = 403;
  world.otcs.stepsFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.match(rec.lastError, /HTTP 403|403/);
  assert.equal(world.timers.length, 1);

  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();

  // a etapa start também trata o 403 do processo como transitório
  const w2 = await buildWorld();
  seedAgreement(w2, 'AG-2', { startSendonDone: false });
  w2.otcs.stepsFailStatus = 403;
  w2.otcs.stepsFailures = 1;
  const res = await w2.reconciliation.reconcile('AG-2');
  assert.equal(res.status, 'failed');
  assert.equal(w2.repo.get('AG-2').state, 'pending');
  assert.equal(w2.repo.get('AG-2').attempts, 1);
  await w2.close();

  const w3 = await buildWorld();
  seedAgreement(w3, 'AG-3', { startSendonDone: false });
  delete w3.otcs.workflows['3003'];
  const gone = await w3.reconciliation.reconcile('AG-3');
  assert.equal(gone.status, 'needs_attention');
  assert.equal(w3.repo.get('AG-3').attentionKind, 'permanent');
  assert.match(gone.reason, /workflow inexistente \(3003\)/);
  await w3.close();
});

/* ---------- B1: tarefa de firma com outro responsável ---------- */

test('B1 disposição: "Aguardar Firma" atribuída a outro usuário => espera a reatribuição (sem SendOn nem log de erro), esgota com motivo explícito e conclui depois de reatribuir', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3' } });
  seedAgreement(world); // 3003/3004 na tarefa de firma
  world.otcs.assign(3003, 3, HUMAN_USER_ID);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.pdfDelivered, true, 'o PDF segue entregue; só a disposição espera');
  assert.equal([rec.attempts, rec.lastErrorStage].join(), '1,disposition');
  assert.match(rec.lastError, /la tarea de firma \(3 "Aguardar Firma"\) está asignada a otro usuario \(279463\); reasígnela al usuario de integración/);
  assert.equal(world.otcs.sendons.length, 0, 'nenhum SendOn fadado ao erro');
  assert.ok(!world.otcs.modelCalls.some((c) => c[0] === 'getTaskForm'), 'nem leitura do formulário');
  assert.equal(world.timers.length, 1, 'retry agendado com backoff');
  assert.deepEqual(world.logger.lines.error, [], 'espera transitória: info, não erro');
  assert.ok(world.logger.has('info', /asignada a otro usuario/));
  assert.deepEqual(await world.reconciliation.runQueue(), [], 'o backoff ainda não venceu');

  world.clock.advance(60 * 1000);
  assert.equal((await world.reconciliation.reconcile('AG-1', { force: false })).status, 'waiting_assignee');
  world.clock.advance(120 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'needs_attention');
  rec = world.repo.get('AG-1');
  assert.equal(rec.attentionKind, 'retries_exhausted', 'reabre sozinho depois de ATTENTION_RETRY_HOURS');
  assert.match(rec.attentionReason, /reintentos agotados en disposition \(3\/3\).*asignada a otro usuario \(279463\)/);
  assert.equal(world.otcs.sendons.length, 0);

  world.otcs.assign(3003, 3, INTEGRATION_USER_ID);
  assert.equal((await world.reconciliation.reconcile('AG-1', { manual: true })).status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.attempts].join(), 'completed,0');
  assert.deepEqual(world.otcs.dispositionCalls().map((s) => s.disposition), ['Firmado']);
  await world.close();
});

test('B1 disposição (L5): responsáveis informados e VAZIOS ([]: atribuição a grupo) => tenta o SendOn como com null, sem consultar o usuário nem esperar a reatribuição', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.otcs.task(3003, 3).assignees = [];
  world.otcs.currentUserFailure = httpError(500, 'não deve ser chamado');
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.otcs.modelCalls.filter(([m]) => m === 'getCurrentUser').length, 0);
  assert.equal(world.calls.filter((c) => c[0] === 'otcs.sendon').length, 1, 'tentou o SendOn');
  const rec = world.repo.get('AG-1');
  // o fake só aceita o SendOn do responsável (o OTCS real também): a tentativa falha como erro de disposição, não como espera
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.doesNotMatch(String(rec.lastError), /asignada a otro usuario/);
  await world.close();
});

test('B1 disposição: responsáveis desconhecidos (null) => SendOn como antes; usuário de integração entre vários => SendOn; falha do getCurrentUser é transitória', async () => {
  // assigneeIds null: nem consulta o usuário
  let world = await buildWorld();
  seedAgreement(world);
  world.otcs.unknownAssignees('3003');
  world.otcs.currentUserFailure = httpError(500, 'não deve ser chamado');
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.modelCalls.filter(([m]) => m === 'getCurrentUser').length, 0);
  await world.close();

  // vários responsáveis, entre eles o usuário de integração
  world = await buildWorld();
  seedAgreement(world);
  world.otcs.task(3003, 3).assignees = [HUMAN_USER_ID, INTEGRATION_USER_ID];
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();

  // não deu para saber quem é o usuário de integração: retry (stage disposition), sem SendOn
  world = await buildWorld();
  seedAgreement(world);
  world.otcs.currentUserFailure = httpError(500, 'auth down');
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.attempts, rec.lastErrorStage].join(), 'pdf_delivered,1,disposition');
  assert.equal(world.otcs.sendons.length, 0);
  world.otcs.currentUserFailure = null;
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();

  // tarefa já concluída (por outra pessoa): conclui como externa sem checar o responsável
  world = await buildWorld();
  seedAgreement(world);
  world.otcs.assign(3003, 3, HUMAN_USER_ID);
  world.otcs.task(3003, 3).status = 'completed';
  world.otcs.currentUserFailure = httpError(500, 'não deve ser chamado');
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,true');
  await world.close();
});

/* ---------- B2: "Aguardar Firma" concluída de uma passagem anterior ---------- */

// O SendOn do início reativa a "Aguardar Firma" (a que já estava em completed volta a current), como no laço do mapa
function loopBackOnStartSendOn(world, processId = '3003', subprocessId = 3004) {
  const original = world.otcs.sendOnWorkflow;
  world.otcs.sendOnWorkflow = async (args) => {
    const r = await original(args);
    if (!args.disposition) world.otcs.task(processId, 3, subprocessId).status = 'current';
    return r;
  };
}

test('B2 disposição: "Aguardar Firma" concluída de uma passagem anterior com o início deste acordo ainda current => envia o início e dá a disposição na nova passagem', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  world.otcs.task(3003, 3, 3004).status = 'completed'; // a firma da passagem anterior continua em completed
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  loopBackOnStartSendOn(world);

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.completedExternally, false, 'não é conclusão externa');
  assert.equal(rec.startSendonDone, true);
  assert.deepEqual(world.otcs.sendons.map((s) => s.disposition || 'sendon'), ['sendon', 'Firmado']);
  assert.equal(world.otcs.sendons[0].taskId, 2, 'o primeiro SendOn é o do início');
  assert.equal(world.otcs.task(3003, 3, 3004).status, 'completed');
  await world.close();
});

test('B2 disposição: logo após o SendOn do início a firma ainda figura concluída (nova ainda não ativa) => retry transitório, não conclusão externa', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  world.otcs.task(3003, 3, 3004).status = 'completed';
  seedAgreement(world, 'AG-1', { startSendonDone: false });

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true, 'o início foi enviado');
  assert.equal(rec.sendonDone, false);
  assert.equal(rec.completedExternally, false);
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.match(rec.lastError, /aún figura concluida tras enviar el pedido de firma/);
  assert.equal(world.otcs.sendons.length, 1, 'só o SendOn do início');
  assert.equal(world.timers.length, 1);

  world.otcs.task(3003, 3, 3004).status = 'current'; // a nova passagem ativou
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,false');
  assert.deepEqual(world.otcs.sendons.map((s) => s.disposition || 'sendon'), ['sendon', 'Firmado']);
  await world.close();
});

test('B2 disposição (M3): a firma nova continua sem ativar no retry seguinte => segue transitório (não conclusão externa) até esgotar as tentativas', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3' } });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  world.otcs.task(3003, 3, 3004).status = 'completed'; // a firma da passagem anterior
  seedAgreement(world, 'AG-1', { startSendonDone: false });

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.ok(rec.startSendonAt, 'o SendOn de início é nosso e fica registrado');
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.equal(world.otcs.sendons.length, 1);

  // retry seguinte: startSentNow é false, mas o início foi enviado depois do final => ainda é a firma da passagem anterior
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal(rec.sendonDone, false);
  assert.equal(rec.completedExternally, false);
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.match(rec.lastError, /aún figura concluida tras enviar el pedido de firma/);
  assert.equal(rec.attempts, 2);

  world.clock.advance(120 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'needs_attention');
  rec = world.repo.get('AG-1');
  assert.equal(rec.attentionKind, 'retries_exhausted');
  assert.equal(rec.completedExternally, false);
  assert.equal(world.otcs.sendons.length, 1, 'só o SendOn do início');
  await world.close();
});

test('B2 disposição (M3): final antes do início; a firma NOVA ativa com outro usuário e concluída à mão => conclusão externa, não trava', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3' } });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  world.otcs.task(3003, 3, 3004).assignees = [HUMAN_USER_ID]; // "Aguardar Firma" com outro usuário
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.ok(Date.parse(rec.startSendonAt) >= Date.parse(rec.finalAt), 'início enviado depois do final');
  assert.ok(rec.signTaskId, 'o acordo viu a sua tarefa de firma (current)');
  assert.equal(rec.sendonDone, false, 'esperando a reatribuição');

  // um humano conclui a "Aguardar Firma" (a nova) à mão
  world.otcs.task(3003, 3, 3004).status = 'completed';
  world.clock.advance(10 * 60 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal(res.status, 'completed');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,true');
  assert.equal(world.otcs.sendons.length, 1, 'só o SendOn do início');
  await world.close();
});

test('B2 disposição (M3): início "já enviado" sem SendOn nosso não grava startSendonAt e a firma concluída segue como conclusão externa', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'done' });
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.equal(rec.startSendonAt, null, 'nenhum SendOn nosso');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,true');
  await world.close();
});

test('B2 disposição: firma concluída e início também concluído (ou início já enviado) segue como conclusão externa', async () => {
  // início não é current: nada a enviar, a firma concluída é de fato externa
  let world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'done' });
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,true');
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();

  // início deste acordo já enviado (startSendonDone): a firma concluída não dispara outro SendOn do início
  world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  world.otcs.task(3003, 3, 3004).status = 'completed';
  seedAgreement(world, 'AG-1', { startSendonDone: true });
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.completedExternally].join(), 'completed,true');
  assert.equal(world.otcs.sendons.length, 0);
  await world.close();
});

/* ---------- B4: ABORTED no polling x webhook de falha de conversão ---------- */

const CONVERSION_EVENTS = [{ type: 'CREATED' }, { type: 'AUTO_CANCELLED_CONVERSION_PROBLEM' }];

test('B4 polling: ABORTED com o evento de falha de conversão => final_conversion_failed (Rechazado), como o webhook', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  world.adobe.events['AG-1'] = CONVERSION_EVENTS;
  const s = await world.poller.tick();
  assert.equal(s.finalized, 1);
  const rec = world.repo.get('AG-1');
  assert.equal([rec.finalKind, rec.state, rec.adobeStatus, rec.sendonDone].join(), 'final_conversion_failed,cancelled,ABORTED,true');
  assert.equal(rec.disposition, 'Rechazado');
  assert.equal(world.otcs.dispositionCalls()[0].comment, 'Adobe Sign no pudo procesar el documento');
  assert.equal(callNames(world).includes('adobe.download'), false);
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 1, 'o status gravado dispensa o verify');
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 1);
  await world.close();
});

test('B4 polling: ABORTED sem o evento de conversão continua em needs_attention (event); falha ao ler os eventos não finaliza e o próximo ciclo retenta', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  seedAgreement(world, 'AG-2', { workflowId: '3103', subworkflowId: '3104' });
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  world.adobe.events['AG-1'] = [{ type: 'CREATED' }, { type: 'DOCUMENTS_DELETED' }];
  world.adobe.agreements['AG-2'] = { id: 'AG-2', status: 'ABORTED' };
  world.adobe.events['AG-2'] = CONVERSION_EVENTS;
  world.adobe.eventsError = httpError(503, 'events down');

  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').state, 'pending', 'sem o histórico não decide (nem needs_attention precipitado)');
  assert.equal(world.repo.get('AG-2').state, 'pending');
  assert.equal(world.repo.get('AG-1').adobeStatus, null);
  assert.ok(world.logger.has('warn', /no se pudo consultar los eventos del acuerdo en Adobe/));

  world.adobe.eventsError = null;
  await world.poller.tick();
  const r1 = world.repo.get('AG-1');
  assert.equal([r1.state, r1.attentionKind, r1.finalKind].join(), 'needs_attention,event,');
  assert.equal(r1.attentionReason, 'estado Adobe ABORTED');
  assert.equal(world.repo.get('AG-2').finalKind, 'final_conversion_failed');
  assert.equal(world.otcs.dispositionCalls().length, 1, 'só o AG-2 foi encerrado');
  await world.close();
});

test('B4 verify: webhook de recusa com o Adobe em ABORTED + evento de conversão adota a falha de conversão; final OK nunca adota nem pede o histórico', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  world.adobe.events['AG-1'] = CONVERSION_EVENTS;
  await fire(world, 'AGREEMENT_REJECTED');
  const rec = world.repo.get('AG-1');
  assert.equal([rec.finalKind, rec.state, rec.sendonDone].join(), 'final_conversion_failed,cancelled,true');
  assert.equal(world.otcs.dispositionCalls()[0].comment, 'Adobe Sign no pudo procesar el documento');
  assert.ok(world.repo.listEvents('AG-1').some((e) => e.source === 'verify' && e.canonical === 'VERIFY_STATUS_ABORTED'));
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 1);
  await world.close();

  const w2 = await buildWorld();
  seedAgreement(w2);
  w2.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  w2.adobe.events['AG-1'] = CONVERSION_EVENTS;
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w2.repo.get('AG-1').attentionKind, 'unconfirmed');
  assert.equal(w2.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 0);
  await w2.close();
});

test('B4 reconcile manual com refresh: ABORTED com evento de conversão finaliza; falha nos eventos devolve refresh_failed', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  world.adobe.events['AG-1'] = CONVERSION_EVENTS;
  world.adobe.eventsError = httpError(500, 'events down');
  assert.equal((await world.reconciliation.reconcile('AG-1', { refresh: true })).status, 'refresh_failed');
  assert.equal(world.repo.get('AG-1').finalKind, null);

  world.adobe.eventsError = null;
  const res = await world.reconciliation.reconcile('AG-1', { refresh: true });
  assert.equal(res.status, 'completed');
  assert.equal(world.repo.get('AG-1').finalKind, 'final_conversion_failed');
  await world.close();
});

/* ---------- B5: polling até o prazo do acordo ---------- */

test('B5 shouldPoll: além de POLL_MAX_AGE_DAYS só continua até expiresAt + 1 dia', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const created = '2026-01-01T00:00:00.000Z';
  const base = Date.parse(created);
  const rec = (extra = {}) => ({ createdAt: created, state: 'pending', ...extra });
  const at = (days) => base + days * DAY;
  const expiresAt = new Date(at(200)).toISOString();

  assert.equal(shouldPoll(rec(), at(89), 90), true);
  assert.equal(shouldPoll(rec(), at(91), 90), false, 'sem prazo conhecido: como antes');
  assert.equal(shouldPoll(rec({ expiresAt: null }), at(91), 90), false);
  assert.equal(shouldPoll(rec({ expiresAt: 'lixo' }), at(91), 90), false);
  assert.equal(shouldPoll(rec({ expiresAt }), at(91), 90), true, 'mais velho que o máximo, mas dentro do prazo');
  assert.equal(shouldPoll(rec({ expiresAt }), at(201), 90), true, 'folga de 1 dia depois do prazo');
  assert.equal(shouldPoll(rec({ expiresAt }), at(201) + 1, 90), false);
  assert.equal(shouldPoll(rec({ expiresAt: new Date(at(30)).toISOString() }), at(60), 90), true, 'dentro da idade máxima nada muda');
  assert.equal(shouldPoll(rec({ expiresAt }), at(500), 0), true, 'maxAgeDays 0 = sem limite');
  // o resto das regras não muda
  assert.equal(shouldPoll(rec({ expiresAt, finalKind: 'final_ok' }), at(91), 90), false);
  assert.equal(shouldPoll(rec({ expiresAt, sendonDone: true }), at(91), 90), false);
  assert.equal(shouldPoll(rec({ expiresAt, state: 'needs_attention' }), at(91), 90), false);
});

test('B5 poller: acordo com prazo (expiresAt) além de POLL_MAX_AGE_DAYS continua sendo consultado e finaliza; sem prazo ou vencido há mais de 1 dia não', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const world = await buildWorld({ env: { POLL_MAX_AGE_DAYS: '90' } });
  seedAgreement(world, 'AG-DUE', { expiresAt: new Date(world.clock.ms() + 200 * DAY).toISOString() });
  seedAgreement(world, 'AG-NODUE', { workflowId: '3103', subworkflowId: '3104' });
  seedAgreement(world, 'AG-LATE', { workflowId: '3203', subworkflowId: '3204', expiresAt: new Date(world.clock.ms() + 50 * DAY).toISOString() });
  for (const id of ['AG-DUE', 'AG-NODUE', 'AG-LATE']) world.adobe.agreements[id] = { id, status: 'EXPIRED' };
  world.clock.advance(100 * DAY);

  const s = await world.poller.tick();
  assert.equal(s.polled, 1);
  assert.equal(s.finalized, 1);
  assert.equal(world.repo.get('AG-DUE').state, 'expired');
  assert.equal(world.repo.get('AG-NODUE').finalKind, null);
  assert.equal(world.repo.get('AG-LATE').finalKind, null);
  await world.close();
});

/* ---------- B7: exceção inesperada no pipeline ---------- */

test('B7: exceção inesperada na reconciliação conta como falha (backoff) e esgota em retries_exhausted, em vez de repetir para sempre', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3', ATTENTION_RETRY_HOURS: '6' } });
  seedAgreement(world);
  const upsert = world.repo.upsert;
  world.repo.upsert = (id, patch) => {
    if (patch && 'signSubprocessId' in patch) throw new TypeError('bug simulado');
    return upsert(id, patch);
  };

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal([rec.attempts, rec.lastErrorStage].join(), '1,reconcile');
  assert.match(rec.lastError, /bug simulado/);
  assert.ok(rec.nextAttemptAt, 'backoff gravado');
  assert.equal(world.timers.length, 1);
  assert.ok(world.logger.has('error', /error inesperado en la reconciliación: .*bug simulado/));
  assert.deepEqual(await world.reconciliation.runQueue(), [], 'o runQueue respeita o backoff (antes: repetia a cada tick)');

  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.repo.get('AG-1').attempts, 2);
  world.clock.advance(120 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.attentionKind].join(), 'needs_attention,retries_exhausted');
  assert.match(rec.attentionReason, /reintentos agotados en reconcile \(3\/3\).*bug simulado/);
  assert.deepEqual(await world.reconciliation.runQueue(), [], 'needs_attention não volta à fila');

  // corrigido o bug, a reabertura automática (ATTENTION_RETRY_HOURS) devolve o acordo à fila e ele conclui
  world.repo.upsert = upsert;
  world.clock.advance(7 * 60 * 60 * 1000);
  assert.deepEqual(await world.reconciliation.reopenStale(), ['AG-1']);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  await world.close();
});

test('B7: exceção inesperada com falha também no registro (banco indisponível) só vai para o log e não lança', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  world.repo.get = () => { throw new Error('db fechado'); };
  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'error');
  assert.ok(world.logger.has('error', /no se pudo registrar el error inesperado de la reconciliación/));
  await world.close();
});

test('B4 verify: falha de conversão já registrada e o Adobe em ABORTED => confirma sem buscar os eventos (falha do /events não trava)', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { finalKind: 'final_conversion_failed', state: 'cancelled', finalAt: '2026-06-22T12:00:00.000Z', adobeStatus: null });
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'ABORTED' };
  world.adobe.eventsError = httpError(503, 'events down');
  await world.reconciliation.reconcile('AG-1', { force: true });
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreementEvents').length, 0);
  const rec = world.repo.get('AG-1');
  assert.equal(rec.adobeStatus, 'ABORTED');
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.disposition, 'Rechazado');
  await world.close();
});
