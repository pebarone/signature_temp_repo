// Pipeline de reconciliação (start / verify / pdf / disposition), resolução dinâmica da tarefa, reabertura,
// atributos do workflow e adoção de acordos — tudo com OTCS/Adobe falsos.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const {
  buildWorld, seedAgreement, seedAdobeForEvent, webhookPayload, httpError, basicHeader, waitFor, tmpDir,
  INTEGRATION_USER_ID, HUMAN_USER_ID
} = require('./support/fakes');

// Como em reconciliation.test.js: o Adobe confirma o evento por padrão (ver seedAdobeForEvent)
async function fire(world, event, id = 'AG-1', opts = {}) {
  seedAdobeForEvent(world.adobe, event, id, opts);
  const result = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload(event, id, opts)));
  if (result.processing) await result.processing;
  return result;
}

const ADMIN = { authorization: basicHeader('admin', 'pa:ss') };
const postJson = (world, p, body, headers = ADMIN) => fetch(`${world.baseUrl}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
});

/* ---------- resolução dinâmica da tarefa de firma ---------- */

test('sub-fluxo: workflowId = subworkflowId = WorkID do pai => a disposição vai ao SUBPROCESSO resolvido', async () => {
  const world = await buildWorld();
  // processo pai 5000; a tarefa de firma vive no subprocesso 5111 (o WebReport de contratação manda WFID nos dois campos)
  world.otcs.addWorkflow('5000', { subprocessId: 5111 });
  seedAgreement(world, 'AG-1', { workflowId: '5000', subworkflowId: '5000', nodeId: '777' });
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');

  const [sendon] = world.otcs.dispositionCalls();
  assert.equal(sendon.workflowId, 5000);
  assert.equal(sendon.subworkflowId, 5111, 'não o 5000 gravado pelo /start');
  assert.equal(sendon.taskId, 3);
  assert.equal(sendon.disposition, 'Firmado');
  assert.equal(sendon.comment, 'Firmado en Adobe Sign (acuerdo AG-1)');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.signSubprocessId, '5111');
  assert.equal(rec.signTaskId, 3);
  assert.equal(world.otcs.task(5000, 3).status, 'completed');
  await world.close();
});

test('comentário da tarefa por resultado (rejeitado, expirado, cancelado, conversão)', async () => {
  const expected = {
    AGREEMENT_REJECTED: 'Rechazado por el firmante en Adobe Sign',
    AGREEMENT_EXPIRED: 'Acuerdo expirado en Adobe Sign',
    AGREEMENT_RECALLED: 'Acuerdo cancelado en Adobe Sign',
    AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM: 'Adobe Sign no pudo procesar el documento'
  };
  for (const [event, comment] of Object.entries(expected)) {
    const world = await buildWorld();
    seedAgreement(world);
    await fire(world, event);
    const [sendon] = world.otcs.dispositionCalls();
    assert.equal(sendon.disposition, 'Rechazado', `${event}: expirado/cancelado/conversão encerram como Rechazado`);
    assert.equal(sendon.comment, comment);
    await world.close();
  }
});

test('nomes de tarefa configuráveis (SIGN_TASK_NAMES) e SIGN_TASK_ID obsoleto não endereça mais a disposição', async () => {
  const world = await buildWorld({ env: { SIGN_TASK_NAMES: 'Espera Firma, Aguardar Firma', SIGN_TASK_ID: '99' } });
  assert.deepEqual(world.config.signTaskNames, ['Espera Firma', 'Aguardar Firma']);
  assert.equal(world.config.signTaskId, 99);
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.otcs.dispositionCalls()[0].taskId, 3);
  await world.close();
});

test('tarefa de firma já concluída fora da integração: conclui com completedExternally, sem disposição nem needs_attention', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'done' }); // recuperação manual já avançou o fluxo
  seedAgreement(world);
  const result = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(result.known, true);

  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.completedExternally, true);
  assert.equal(rec.disposition, null);
  assert.equal(rec.attentionReason, null);
  assert.equal(rec.signTaskId, 3);
  assert.equal(world.otcs.sendons.length, 0, 'nada é enviado');
  assert.equal(world.otcs.versions.length, 1, 'o PDF ainda é entregue');
  assert.ok(world.logger.has('info', /ya concluida fuera de la integración/));
  assert.equal(world.logger.lines.error.length, 0);
  assert.equal(world.timers.filter((t) => !t.cleared).length, 0);

  // idem para um final não-OK (estado final do plano)
  const w2 = await buildWorld();
  w2.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'done' });
  seedAgreement(w2);
  await fire(w2, 'AGREEMENT_REJECTED');
  assert.equal(w2.repo.get('AG-1').state, 'rejected');
  assert.equal(w2.repo.get('AG-1').completedExternally, true);
  await world.close();
  await w2.close();
});

test('disposição inexistente nas ações da tarefa => needs_attention permanente listando as disponíveis', async () => {
  const world = await buildWorld();
  world.otcs.customActions = ['Aprobar', 'Devolver'];
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'permanent');
  assert.match(rec.attentionReason, /"Firmado" no disponible.*tarea 3 "Aguardar Firma".*disponibles: Aprobar, Devolver/);
  assert.equal(rec.pdfDelivered, true, 'PDF entregue é preservado');
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.timers.filter((t) => !t.cleared).length, 0, 'sem retry automático');

  // a comparação ignora caixa/acentos e usa a chave real da ação
  const w2 = await buildWorld();
  w2.otcs.customActions = ['FIRMADO', 'Rechazado'];
  seedAgreement(w2);
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w2.otcs.dispositionCalls()[0].disposition, 'FIRMADO');

  // formulário ilegível (ex.: permissão) não bloqueia: segue com a disposição configurada
  const w3 = await buildWorld();
  w3.otcs.formFailure = httpError(403, 'forbidden form');
  seedAgreement(w3);
  await fire(w3, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w3.repo.get('AG-1').state, 'completed');
  assert.ok(w3.logger.has('warn', /no se pudo leer el formulario/));
  await world.close();
  await w2.close();
  await w3.close();
});

test('processo inexistente (404) => needs_attention permanente; tarefa de firma ainda não ativa => retry transitório', async () => {
  const w1 = await buildWorld();
  seedAgreement(w1, 'AG-1', { workflowId: '8888', subworkflowId: '8888' });
  delete w1.otcs.workflows['8888'];
  await fire(w1, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = w1.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'permanent');
  assert.match(rec.attentionReason, /workflow inexistente \(8888\)/);
  assert.equal(w1.timers.length, 0);
  await w1.close();

  // a firma ainda é "next" (e a tarefa de início não está ativa): transitório, vira needs_attention só pelo limite
  const w2 = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  seedAgreement(w2);
  w2.otcs.workflows['3003'].tasks.find((t) => t.taskId === 3).status = 'next';
  w2.otcs.workflows['3003'].tasks.find((t) => t.taskId === 2).status = 'completed';
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED');
  rec = w2.repo.get('AG-1');
  assert.equal(rec.state, 'pdf_delivered');
  assert.equal(rec.lastErrorStage, 'disposition');
  assert.match(rec.lastError, /tarea de firma.*no está activa.*next/);
  assert.equal(w2.timers.length, 1);

  w2.clock.advance(60 * 1000);
  await w2.reconciliation.reconcile('AG-1', { force: false });
  rec = w2.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'retries_exhausted');
  await w2.close();
});

test('disposição: formulário legível sem ações não permite enviar a disposição configurada', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  world.otcs.customActions = [];
  await fire(world, 'AGREEMENT_REJECTED');
  assert.equal(world.repo.get('AG-1').attentionKind, 'permanent');
  assert.match(world.repo.get('AG-1').attentionReason, /no disponible/);
  assert.equal(world.otcs.sendons.length, 0);
});

test('disposição: tarefa concluída durante o PUT (409) termina sem atenção nem reenvio', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  world.otcs.sendOnWorkflow = async () => {
    world.otcs.task('3003', 3).status = 'completed';
    throw httpError(409, 'task already completed');
  };
  await fire(world, 'AGREEMENT_REJECTED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.completedExternally, true);
  assert.equal(rec.attentionKind, null);
  assert.equal(rec.disposition, null);
  assert.equal(world.timers.length, 0);
});

test('tarefa concluída externamente não exige disposição configurada', async (t) => {
  const world = await buildWorld({ env: { DISPOSITION_REJECTED: '' } });
  t.after(() => world.close());
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'done' });
  seedAgreement(world);
  await fire(world, 'AGREEMENT_REJECTED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.completedExternally, true);
  assert.equal(rec.sendonDone, true);
  assert.equal(rec.attentionKind, null);
  assert.equal(world.otcs.sendons.length, 0);
});

test('needs_attention permanente bloqueia execução automática já enfileirada; manual coalescido reabre', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  world.otcs.customActions = ['Otra'];
  await fire(world, 'AGREEMENT_REJECTED');
  const calls = world.otcs.modelCalls.length;
  await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(world.otcs.modelCalls.length, calls, 'a execução automática respeita a atenção');
  world.otcs.customActions = ['Firmado', 'Rechazado'];
  await Promise.all([
    world.reconciliation.reconcile('AG-1', { manual: true }),
    world.reconciliation.reconcile('AG-1', { manual: false, force: false })
  ]);
  assert.equal(world.repo.get('AG-1').sendonDone, true);
});

/* ---------- PDF como versão do nó ---------- */

test('PDF assinado vira nova versão do nodeId; a pasta de anexos só é usada no fallback (nó 404)', async () => {
  const world = await buildWorld();
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.deepEqual(world.otcs.versions.map((v) => [v.nodeId, v.fileName]), [['1001', 'contrato.pdf']]);
  assert.equal(world.otcs.versions[0].agreementId, 'AG-1', 'a entrega leva o marcador de idempotência');
  assert.equal(world.otcs.uploads.length, 0);
  assert.equal(world.repo.get('AG-1').pdfNodeId, '1001');
  await world.close();

  const w2 = await buildWorld();
  w2.otcs.missingNodes.add('1001'); // o documento foi apagado
  seedAgreement(w2);
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w2.otcs.versions.length, 0);
  assert.deepEqual(w2.otcs.uploads.map((u) => [u.folderId, u.fileName]), [['2002', 'contrato.pdf']]);
  assert.equal(w2.otcs.uploads[0].agreementId, 'AG-1', 'o fallback também leva o marcador');
  const rec = w2.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.pdfNodeId, '9001', 'nó criado na pasta');
  assert.ok(w2.logger.has('warn', /el nodo 1001 ya no existe/));
  await w2.close();

  // nó apagado e sem pasta de anexos: não há onde entregar
  const w3 = await buildWorld();
  w3.otcs.missingNodes.add('1001');
  seedAgreement(w3, 'AG-1', { attachId: null });
  await fire(w3, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w3.repo.get('AG-1').state, 'needs_attention');
  assert.match(w3.repo.get('AG-1').attentionReason, /sin attachId/);
  assert.equal(w3.otcs.sendons.length, 0);
  await w3.close();
});

/* ---------- etapa start ---------- */

test('start: localiza a tarefa de início pelo nome, faz o SendOn e marca startSendonDone', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('5000', { subprocessId: 5111, stage: 'start' });
  seedAgreement(world, 'AG-1', { workflowId: '5000', subworkflowId: '5000', startSendonDone: false });

  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'start_sent');
  const [sendon] = world.otcs.sendons;
  assert.deepEqual(
    [sendon.workflowId, sendon.subworkflowId, sendon.taskId, sendon.disposition], [5000, 5111, 2, undefined]
  );
  const rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.ok(rec.startSendonAt);
  assert.equal(world.otcs.task(5000, 3).status, 'current');

  // idempotente: o registro não volta à fila nem repete o SendOn
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'no_final');
  assert.deepEqual(world.repo.listPending(), []);
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('start: falha do OTCS => retry com backoff pelo runQueue e recuperação; não bloqueia o /start', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  world.otcs.sendOnFailures = 2;

  let res = await world.reconciliation.reconcile('AG-1');
  assert.deepEqual([res.status, res.stage], ['failed', 'start']);
  let rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, false);
  assert.equal(rec.attempts, 1);
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.timers[0].ms, 60 * 1000);
  assert.deepEqual(world.repo.listPending().map((r) => r.id), ['AG-1'], 'a fila inclui o pedido de firma pendente');

  assert.deepEqual(await world.reconciliation.runQueue(), [], 'backoff ainda não venceu');
  world.clock.advance(61 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  assert.equal(world.repo.get('AG-1').attempts, 2);

  world.clock.advance(121 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.equal(rec.attempts, 0);
  assert.equal(rec.lastError, null);
  assert.equal(rec.startSendOnError, null);
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('start: tarefa ainda atribuída ao usuário => espera a reatribuição (sem SendOn, sem erro, sem needs_attention) e envia depois', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('5000', { subprocessId: 5111, stage: 'start', assignee: HUMAN_USER_ID });
  seedAgreement(world, 'AG-1', { workflowId: '5000', subworkflowId: '5000', startSendonDone: false });

  const res = await world.reconciliation.reconcile('AG-1');
  assert.deepEqual([res.status, res.stage, res.attempts], ['waiting_handoff', 'start', 1]);
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pending');
  assert.equal(rec.startSendonDone, false);
  assert.equal(rec.lastErrorStage, 'start');
  assert.match(rec.lastError, /sigue asignada al usuario/);
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString(), 'backoff normal da etapa start');
  assert.equal(world.timers[0].ms, 60 * 1000);
  assert.equal(world.otcs.sendons.length, 0, 'nenhum SendOn enquanto a tarefa está com o usuário');
  assert.deepEqual(world.logger.lines.error, [], 'espera de reatribuição não gera log de erro');
  assert.ok(world.logger.has('info', /sigue asignada al usuario/));

  // o backoff ainda não venceu: o poller/runQueue não tenta; depois da reatribuição, o retry envia
  assert.deepEqual(await world.reconciliation.runQueue(), []);
  world.otcs.assign(5000, 2, INTEGRATION_USER_ID);
  world.clock.advance(61 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.equal(rec.attempts, 0);
  assert.equal(rec.lastError, null);
  assert.equal(world.otcs.sendons.length, 1);
  assert.deepEqual(world.logger.lines.error, []);
  await world.close();
});

test('start: reatribuição que não acontece esgota as tentativas com motivo explícito; resumeStart reabre e envia', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '3' } });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start', assignee: HUMAN_USER_ID });
  seedAgreement(world, 'AG-1', { startSendonDone: false });

  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'waiting_handoff');
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'waiting_handoff');
  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'needs_attention');
  assert.match(res.reason, /sigue asignada al usuario; reabra la página/);
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'retries_exhausted', 'reabre sozinho depois de ATTENTION_RETRY_HOURS');
  assert.equal(world.otcs.sendons.length, 0);

  // needs_attention não reprocessa sozinho; o /start repetido (resumeStart) reabre uma rodada nova, ignorando o backoff
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'needs_attention');
  world.otcs.assign(3003, 2, INTEGRATION_USER_ID);
  assert.equal((await world.reconciliation.resumeStart('AG-1')).status, 'start_sent');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.startSendonDone, rec.attempts].join(), 'pending,true,0');
  assert.equal(world.otcs.sendons.length, 1);

  // idempotente: repetir não envia de novo
  assert.equal((await world.reconciliation.resumeStart('AG-1')).status, 'no_final');
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('start: responsáveis desconhecidos (assigneeIds null) => SendOn imediato, sem consultar o usuário de integração', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('5000', { subprocessId: 5111, stage: 'start' });
  world.otcs.unknownAssignees('5000');
  world.otcs.currentUserFailure = httpError(500, 'não deve ser chamado');
  seedAgreement(world, 'AG-1', { workflowId: '5000', subworkflowId: '5000', startSendonDone: false });

  const res = await world.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'start_sent');
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.repo.get('AG-1').startSendonDone, true);
  assert.equal(world.otcs.modelCalls.filter(([m]) => m === 'getCurrentUser').length, 0);
  assert.deepEqual(world.logger.lines.error, []);
  await world.close();
});

test('start: falha ao consultar o usuário de integração é transitória (retry), sem SendOn', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  world.otcs.currentUserFailure = httpError(500, 'auth down');
  const res = await world.reconciliation.reconcile('AG-1');
  assert.deepEqual([res.status, res.stage], ['failed', 'start']);
  assert.equal(world.otcs.sendons.length, 0);
  world.otcs.currentUserFailure = null;
  assert.equal((await world.reconciliation.reconcile('AG-1')).status, 'start_sent');
  await world.close();
});

test('start: tarefa de início já concluída (ou firma já ativa) só marca como feito, sem SendOn', async () => {
  for (const stage of ['sign', 'done']) {
    const world = await buildWorld();
    world.otcs.addWorkflow('3003', { subprocessId: '3004', stage });
    seedAgreement(world, 'AG-1', { startSendonDone: false });
    const res = await world.reconciliation.reconcile('AG-1');
    assert.equal(res.status, 'start_sent');
    assert.equal(world.repo.get('AG-1').startSendonDone, true);
    assert.equal(world.otcs.sendons.length, 0, stage);
    await world.close();
  }
});

test('start: processo inexistente (404) => needs_attention permanente; tarefa de início não encontrada => retry', async () => {
  const w1 = await buildWorld();
  seedAgreement(w1, 'AG-1', { startSendonDone: false });
  delete w1.otcs.workflows['3003'];
  const res = await w1.reconciliation.reconcile('AG-1');
  assert.equal(res.status, 'needs_attention');
  assert.equal(w1.repo.get('AG-1').attentionKind, 'permanent');
  await w1.close();

  const w2 = await buildWorld();
  seedAgreement(w2, 'AG-1', { startSendonDone: false });
  w2.otcs.workflows['3003'].tasks = []; // mapa sem as tarefas esperadas
  const r2 = await w2.reconciliation.reconcile('AG-1');
  assert.deepEqual([r2.status, r2.stage], ['failed', 'start']);
  assert.match(r2.error, /no se encontró la tarea de inicio/);
  await w2.close();
});

test('final chega com a tarefa de firma ainda inexistente: envia o início agora, retenta e conclui quando a firma existir', async () => {
  const world = await buildWorld();
  seedAgreement(world, 'AG-1', { startSendonDone: false }); // início "current", firma "next"
  world.otcs.sendOnFailures = 1; // o SendOn do início falha na primeira vez

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.pdfDelivered, true, 'o PDF já foi entregue');
  assert.equal(rec.lastErrorStage, 'start');
  assert.equal(rec.sendonDone, false);
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(world.timers.length, 1);

  world.clock.advance(61 * 1000);
  const res = await world.reconciliation.reconcile('AG-1', { force: false });
  assert.equal(res.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.startSendonDone, true);
  assert.deepEqual(world.otcs.sendons.map((s) => [s.taskId, s.disposition || 'sendon']), [[2, 'sendon'], [3, 'Firmado']]);
  assert.equal(world.otcs.versions.length, 1, 'PDF não é reenviado');
  await world.close();
});

test('POST /start grava startSendonDone=false, dispara a etapa start e devolve o mesmo contrato', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  const { startBody } = require('./support/fakes');
  const r = await postJson(world, '/start', startBody(world), {});
  assert.equal(r.status, 200);
  // sem START_VERIFY_WORKFLOW não há consulta ao workflow, então também não há handoff
  assert.deepEqual(await r.json(), { message: 'Signature requested. ID: AG-1', id: 'AG-1' });
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.repo.get('AG-1').adopted, false);
  await world.close();
});

/* ---------- reabertura automática ---------- */

test('ATTENTION_RETRY_HOURS: needs_attention por tentativas esgotadas reabre sozinho (poller com polling ligado)', async () => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  assert.equal(world.config.attentionRetryHours, 6);
  seedAgreement(world);
  world.otcs.uploadFailures = 2;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  world.clock.advance(60 * 1000);
  await world.reconciliation.reconcile('AG-1', { force: false });
  let rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'needs_attention');
  assert.equal(rec.attentionKind, 'retries_exhausted');

  // antes de 6 h: continua parado
  world.clock.advance(5 * 60 * 60 * 1000);
  let s = await world.poller.tick();
  assert.equal(s.reopened, 0);
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');

  // depois de 6 h da última falha: reabre (tentativas zeradas) e reprocessa
  world.clock.advance(61 * 60 * 1000);
  s = await world.poller.tick();
  assert.equal(s.reopened, 1);
  assert.equal(s.retried, 1);
  rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(rec.attentionKind, null);
  assert.equal(rec.attempts, 0);
  assert.ok(world.logger.has('warn', /reabierto automáticamente/));
  await world.close();
});

test('ATTENTION_RETRY_HOURS: também reabre com POLL_ENABLED=false; outros tipos e valor 0 não reabrem', async () => {
  const world = await buildWorld({
    env: { RETRY_MAX_ATTEMPTS: '1', POLL_ENABLED: 'false', POLL_INTERVAL_MS: '1000', POLL_INITIAL_DELAY_MS: '0' }
  });
  seedAgreement(world);
  seedAgreement(world, 'AG-P', { workflowId: '3103', subworkflowId: '3104' });
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').attentionKind, 'retries_exhausted');

  world.otcs.customActions = ['Outra']; // AG-P: erro permanente (não reabre sozinho)
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-P');
  assert.equal(world.repo.get('AG-P').attentionKind, 'permanent');
  world.otcs.customActions = ['Firmado', 'Rechazado'];

  world.clock.advance(7 * 60 * 60 * 1000);
  assert.equal(world.poller.start(), false);
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.equal(world.repo.get('AG-P').state, 'needs_attention', 'permanente não reabre');
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 2, 'sem polling de status');
  world.poller.stop();
  await world.close();

  const off = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '1', ATTENTION_RETRY_HOURS: '0' } });
  seedAgreement(off);
  off.otcs.uploadFailures = 1;
  await fire(off, 'AGREEMENT_WORKFLOW_COMPLETED');
  off.clock.advance(100 * 60 * 60 * 1000);
  assert.deepEqual(await off.reconciliation.reopenStale(), []);
  assert.equal(off.repo.get('AG-1').state, 'needs_attention');
  await off.close();
});

test('tipos de atenção: não confirmado, config e evento', async () => {
  const w1 = await buildWorld();
  seedAgreement(w1);
  w1.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  await fire(w1, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(w1.repo.get('AG-1').attentionKind, 'unconfirmed');
  await w1.close();

  const w2 = await buildWorld();
  seedAgreement(w2);
  await fire(w2, 'AGREEMENT_DOCUMENTS_DELETED');
  assert.equal(w2.repo.get('AG-1').attentionKind, 'event');
  await w2.close();

  // reconcile manual limpa o tipo
  const w3 = await buildWorld({ env: { DISPOSITION_EXPIRED: '' } });
  seedAgreement(w3);
  await fire(w3, 'AGREEMENT_EXPIRED');
  assert.equal(w3.repo.get('AG-1').attentionKind, 'config');
  w3.config.dispositions.expired = 'Rechazado';
  await w3.reconciliation.reconcile('AG-1', { manual: true });
  assert.equal(w3.repo.get('AG-1').state, 'expired');
  assert.equal(w3.repo.get('AG-1').attentionKind, null);
  await w3.close();
});

test('reconcile manual sem resultado final reabre atenção e devolve o acordo ao polling', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world, 'AG-1', {
    state: 'needs_attention', attentionKind: 'event', attentionReason: 'evento AGREEMENT_DOCUMENTS_DELETED',
    attempts: 2, nextAttemptAt: new Date(world.clock.ms() + 60000).toISOString()
  });
  world.adobe.agreements['AG-1'] = { status: 'OUT_FOR_SIGNATURE' };

  const result = await world.reconciliation.reconcile('AG-1', { manual: true, refresh: true });
  assert.equal(result.status, 'no_final');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pending');
  assert.equal(rec.attentionKind, null);
  assert.equal(rec.attentionReason, null);
  assert.equal(rec.attempts, 0);
  assert.equal(rec.nextAttemptAt, null);
  assert.deepEqual(world.repo.listPollable().map((r) => r.id), ['AG-1']);
  assert.equal(world.otcs.sendons.length, 0);

  world.adobe.agreements['AG-1'].status = 'SIGNED';
  await world.poller.tick();
  assert.equal(world.repo.get('AG-1').state, 'completed');
});

test('resposta de SendOn perdida: restart retoma início e disposição sem repetir o PUT aplicado', async (t) => {
  for (const stage of ['start', 'disposition']) {
    await t.test(stage, async () => {
      const dbFile = path.join(tmpDir(), 'lost-sendon.db');
      const w1 = await buildWorld({ dbFile });
      seedAgreement(w1, 'AG-1', { startSendonDone: stage !== 'start' });
      const sendOn = w1.otcs.sendOnWorkflow;
      let writes = 0;
      w1.otcs.sendOnWorkflow = async (args) => {
        writes++;
        await sendOn(args); // OTCS aplica o PUT antes de a conexão cair
        throw new Error('connection lost after commit');
      };
      if (stage === 'start') await w1.reconciliation.reconcile('AG-1');
      else await fire(w1, 'AGREEMENT_REJECTED');
      assert.equal(w1.repo.get('AG-1').lastErrorStage, stage);
      await w1.close();

      w1.clock.advance(61 * 1000);
      const w2 = await buildWorld({ dbFile, otcs: w1.otcs, adobe: w1.adobe, clock: w1.clock });
      try {
        assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-1']);
        assert.equal(writes, 1, 'nenhum PUT repetido após o restart');
        assert.equal(w2.repo.get('AG-1').startSendonDone, true);
        if (stage === 'disposition') assert.equal(w2.repo.get('AG-1').completedExternally, true);
      } finally {
        await w2.close();
      }
    });
  }
});

test('novo evento final reabre atenção com contador e tipo limpos', async (t) => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  t.after(() => world.close());
  seedAgreement(world, 'AG-1', {
    finalKind: 'final_ok', state: 'needs_attention', attentionKind: 'retries_exhausted',
    attentionReason: 'reintentos agotados', attempts: 2
  });
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'new-final' });
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'signed');
  assert.equal(rec.attempts, 1);
  assert.equal(rec.attentionKind, null);
  assert.equal(rec.attentionReason, null);
  assert.ok(rec.nextAttemptAt);
});

/* ---------- atributos do workflow ---------- */

const ATTR_FIELDS = {
  'Adobe ID Acuerdo': { key: 'WorkflowForm_1', value: '' },
  'Adobe Estado': { key: 'WorkflowForm_2', value: '' },
  'Estado Integración Firma': { key: 'WorkflowForm_5', value: '' }
  // "Adobe Último Evento" e "Adobe Fecha Actualización" não existem no mapa: ignorados
};

test('atributos desligados (padrão): nunca chama updateTaskForm', async () => {
  const world = await buildWorld();
  assert.equal(world.config.wfAttributes.enabled, false);
  world.otcs.formFields = ATTR_FIELDS;
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await world.poller.tick();
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.modelCalls.some((c) => c[0] === 'updateTaskForm'), false);
  assert.equal(world.otcs.updateFormCalls.length, 0);
  await world.close();
});

test('atributos ligados: grava pelos rótulos antes da disposição, ignora rótulos ausentes e não regrava o igual', async () => {
  const world = await buildWorld({ env: { WF_ATTRIBUTES_ENABLED: 'true' } });
  world.otcs.formFields = ATTR_FIELDS;
  const seenAtUpdate = [];
  const update = world.otcs.updateTaskForm;
  world.otcs.updateTaskForm = async (...a) => {
    seenAtUpdate.push(world.otcs.task(3003, 3).status);
    return update(...a);
  };
  seedAgreement(world);

  // mudança de estado no Adobe com a tarefa de firma ativa => gravação em background
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await world.poller.tick();
  await waitFor(() => world.otcs.updateFormCalls.length === 1);
  assert.deepEqual(world.otcs.updateFormCalls[0], {
    processId: 3003, subprocessId: 3004, taskId: 3,
    values: { WorkflowForm_1: 'AG-1', WorkflowForm_2: 'OUT_FOR_SIGNATURE', WorkflowForm_5: 'pending' }
  });
  assert.ok(world.logger.has('info', /atributo "Adobe Último Evento" no existe/));
  assert.equal(world.logger.lines.info.filter((l) => /atributo "Adobe Último Evento"/.test(l)).length, 1);
  assert.ok(world.repo.get('AG-1').wfAttrsFingerprint);

  // mesmo estado de novo: nada novo
  await world.poller.tick();
  assert.equal(world.otcs.updateFormCalls.length, 1);

  // final: grava o novo conjunto ANTES de concluir a tarefa
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.updateFormCalls.length, 2);
  assert.deepEqual(world.otcs.updateFormCalls[1].values, {
    WorkflowForm_1: 'AG-1', WorkflowForm_2: 'SIGNED', WorkflowForm_5: 'pdf_delivered'
  });
  assert.deepEqual(seenAtUpdate, ['current', 'current'], 'tarefa ainda ativa quando gravou');
  await world.close();
});

test('atributos: rótulo vazio desliga aquele atributo; erro do formUpdate só gera warn e não bloqueia a disposição', async () => {
  const world = await buildWorld({
    env: { WF_ATTRIBUTES_ENABLED: 'true', WF_ATTR_STATUS: '', WF_ATTR_INTEGRATION_STATE: '' }
  });
  assert.equal(world.config.wfAttributes.labels.status, '');
  world.otcs.formFields = ATTR_FIELDS;
  world.otcs.updateFormFailures = 1;
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed', 'a falha do formUpdate não bloqueia');
  assert.equal(rec.attempts, 0);
  assert.equal(rec.wfAttrsFingerprint, null, 'falha: nada de fingerprint (tenta de novo na próxima mudança)');
  assert.ok(world.logger.has('warn', /no se pudieron actualizar los atributos del workflow.*formUpdate failed/));
  assert.equal(world.otcs.dispositionCalls().length, 1);

  // com o formUpdate funcionando só o atributo ligado é gravado
  const w2 = await buildWorld({
    env: { WF_ATTRIBUTES_ENABLED: 'true', WF_ATTR_STATUS: '', WF_ATTR_INTEGRATION_STATE: '' }
  });
  w2.otcs.formFields = ATTR_FIELDS;
  seedAgreement(w2);
  await fire(w2, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.deepEqual(w2.otcs.updateFormCalls[0].values, { WorkflowForm_1: 'AG-1' });
  await world.close();
  await w2.close();
});

test('atributos: na criação (tarefa de início) grava o ID do acordo antes do SendOn', async () => {
  const world = await buildWorld({ env: { WF_ATTRIBUTES_ENABLED: 'true' } });
  world.otcs.formFields = ATTR_FIELDS;
  seedAgreement(world, 'AG-1', { startSendonDone: false });
  const order = [];
  const update = world.otcs.updateTaskForm;
  world.otcs.updateTaskForm = async (...a) => { order.push('update'); return update(...a); };
  const sendOn = world.otcs.sendOnWorkflow;
  world.otcs.sendOnWorkflow = async (a) => { order.push('sendon'); return sendOn(a); };

  await world.reconciliation.reconcile('AG-1');
  assert.deepEqual(order, ['update', 'sendon']);
  assert.equal(world.otcs.updateFormCalls[0].taskId, 2, 'na tarefa de início');
  assert.equal(world.otcs.updateFormCalls[0].values.WorkflowForm_1, 'AG-1');
  assert.equal(world.repo.get('AG-1').startSendonDone, true);

  // falha do formUpdate na criação não impede o SendOn
  const w2 = await buildWorld({ env: { WF_ATTRIBUTES_ENABLED: 'true' } });
  w2.otcs.formFields = ATTR_FIELDS;
  w2.otcs.updateFormFailures = 1;
  seedAgreement(w2, 'AG-1', { startSendonDone: false });
  assert.equal((await w2.reconciliation.reconcile('AG-1')).status, 'start_sent');
  await world.close();
  await w2.close();
});

/* ---------- adoção ---------- */

const EXT = 'otcs|wf=3003|sub=3004|node=1001|attach=2002';

test('adoção de acordo em andamento recupera o início pendente e não repete o SendOn já aplicado', async (t) => {
  for (const stage of ['start', 'sign']) {
    await t.test(stage, async () => {
      const dbFile = path.join(tmpDir(), 'adopt-start.db');
      const w1 = await buildWorld({ dbFile });
      w1.otcs.addWorkflow('3003', { subprocessId: '3004', stage });
      w1.adobe.agreements['AG-X'] = { status: 'OUT_FOR_SIGNATURE', externalId: { id: EXT } };
      await w1.reconciliation.handleEvent(
        parseWebhookPayload(webhookPayload('AGREEMENT_ACTION_REQUESTED', 'AG-X'))
      ).adoption;
      assert.equal(w1.repo.get('AG-X').startSendonDone, false);
      await w1.close();

      // POLL_ENABLED=false: basta a fila persistida, sem depender de outro evento ou do resultado final.
      const w2 = await buildWorld({ dbFile, adobe: w1.adobe, otcs: w1.otcs, clock: w1.clock });
      try {
        assert.deepEqual(await w2.reconciliation.runQueue(), ['AG-X']);
        assert.equal(w2.repo.get('AG-X').startSendonDone, true);
        assert.equal(w2.otcs.sendons.length, stage === 'start' ? 1 : 0);
        assert.equal(w2.otcs.task('3003', 3).status, 'current');
        assert.deepEqual(await w2.reconciliation.runQueue(), []);
      } finally {
        await w2.close();
      }
    });
  }
});

test('webhook de acordo desconhecido com externalId nosso: adota (adopted=true) e reaplica o evento', async () => {
  const world = await buildWorld();
  world.otcs.addWorkflow('3003', { subprocessId: '3004' });
  world.adobe.agreements['AG-X'] = {
    id: 'AG-X', name: 'Documento contrato final.pdf', status: 'SIGNED', externalId: { id: EXT },
    createdDate: '2026-06-20T10:00:00Z',
    participantSetsInfo: [{ memberInfos: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }]
  };
  const result = world.reconciliation.handleEvent(
    parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-X'))
  );
  assert.equal(result.known, false, 'o webhook responde sem esperar');
  assert.equal(result.reason, 'unknown_agreement');
  await result.adoption;

  const rec = world.repo.get('AG-X');
  assert.equal(rec.adopted, true);
  assert.equal(rec.fileName, 'contrato final.pdf', 'sem o prefixo "Documento "');
  assert.deepEqual([rec.workflowId, rec.subworkflowId, rec.nodeId, rec.attachId], ['3003', '3004', '1001', '2002']);
  assert.equal(rec.startSendonDone, true);
  assert.deepEqual(rec.emails, ['a@example.com', 'b@example.com']);
  assert.equal(rec.createdAt, '2026-06-20T10:00:00.000Z');
  assert.equal(rec.state, 'completed', 'o evento foi reaplicado e processado');
  assert.equal(world.repo.listEvents('AG-X').length, 1);
  assert.deepEqual(world.otcs.versions.map((v) => v.nodeId), ['1001']);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.ok(world.logger.has('warn', /adoptado por su externalId/));

  // eventos concorrentes do mesmo acordo desconhecido adotam uma vez só
  const w2 = await buildWorld();
  w2.adobe.agreements['AG-Y'] = { id: 'AG-Y', name: 'Documento a.pdf', status: 'OUT_FOR_SIGNATURE', externalId: { id: EXT } };
  const [a, b] = ['n1', 'n2'].map((n) => w2.reconciliation.handleEvent(
    parseWebhookPayload(webhookPayload('AGREEMENT_ACTION_REQUESTED', 'AG-Y', { notificationId: n }))
  ));
  await Promise.all([a.adoption, b.adoption]);
  assert.equal(w2.calls.filter((c) => c[0] === 'adobe.getAgreement').length, 1);
  assert.equal(w2.repo.listEvents('AG-Y').length, 2);
  await world.close();
  await w2.close();
});

test('POST /admin/adopt/:id: Basic Auth, externalId, corpo para acordos antigos, 404/409/422', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.addWorkflow('3003', { subprocessId: '3004' });
  world.adobe.agreements['AG-X'] = { id: 'AG-X', name: 'Documento contrato.pdf', status: 'SIGNED', externalId: { id: EXT } };
  world.adobe.agreements['AG-OLD'] = { id: 'AG-OLD', name: 'Documento antigo.pdf', status: 'OUT_FOR_SIGNATURE' };

  let r = await postJson(world, '/admin/adopt/AG-X', undefined, {});
  assert.equal(r.status, 401);

  r = await postJson(world, '/admin/adopt/NOPE', undefined);
  assert.equal(r.status, 404);

  // com externalId: não precisa de corpo; reconcilia (SIGNED => conclui)
  r = await postJson(world, '/admin/adopt/AG-X', undefined);
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.adopted, true);
  assert.equal(body.result.status, 'completed');
  assert.equal(body.agreement.adopted, true);
  assert.equal(body.agreement.state, 'completed');

  r = await postJson(world, '/admin/adopt/AG-X', undefined);
  assert.equal(r.status, 409);

  // sem externalId e sem dados: 422 dizendo o que falta
  r = await postJson(world, '/admin/adopt/AG-OLD', undefined);
  assert.equal(r.status, 422);
  assert.deepEqual((await r.json()).missing, ['workflowId', 'nodeId', 'attachId']);
  r = await postJson(world, '/admin/adopt/AG-OLD', { workflowId: '3003', nodeId: 'abc', attachId: '2002' });
  assert.equal(r.status, 422);
  assert.deepEqual((await r.json()).missing, ['nodeId']);
  assert.equal(world.repo.has('AG-OLD'), false);

  // acordo antigo: o operador informa os IDs
  r = await postJson(world, '/admin/adopt/AG-OLD', {
    workflowId: '3003', subworkflowId: '3004', nodeId: '1001', attachId: '2002', fileName: 'antigo.pdf'
  });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.result.status, 'start_sent', 'ainda em andamento no Adobe; confirma o início no OTCS');
  const rec = world.repo.get('AG-OLD');
  assert.deepEqual([rec.adopted, rec.nodeId, rec.fileName, rec.state], [true, '1001', 'antigo.pdf', 'pending']);
  assert.equal(rec.adobeStatus, 'OUT_FOR_SIGNATURE');
  await world.close();
});
