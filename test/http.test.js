const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../server/infra/logger');
const { sign, signStart } = require('../server/http/middleware/hmac');
const { buildExternalId } = require('../server/domain/externalId');
const {
  buildWorld, seedAgreement, webhookPayload, waitFor, startBody, startBodyV1, seedStartFlow, basicHeader, makeClock, tmpDir,
  httpError
} = require('./support/fakes');

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (world, p, body, headers = {}) =>
  fetch(`${world.baseUrl}${p}`, { ...json(body), headers: { 'content-type': 'application/json', ...headers } });
const ADMIN = { authorization: basicHeader('admin', 'pa:ss') }; // senha com ":" de propósito
const signed = (world, id = 'AG-1') => { world.adobe.agreements[id] = { id, status: 'SIGNED' }; };

/* ---------- webhook ---------- */

test('webhook HEAD/GET: eco do X-AdobeSign-ClientId recebido; sem header (ou inválido) usa o CLIENT_ID configurado', async () => {
  const world = await buildWorld({ listen: true });

  // o webhook criado pela UI do Adobe envia o ClientId do aplicativo que o criou: a resposta tem de ecoar o MESMO valor
  let r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD', headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');

  r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'test-client-id', 'sem header: usa o CLIENT_ID configurado');

  r = await fetch(`${world.baseUrl}/webhook`, { headers: { 'X-AdobeSign-ClientId': 'abc.123_-X' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc.123_-X');
  assert.deepEqual(await r.json(), { status: 'pong' });

  r = await fetch(`${world.baseUrl}/webhook?challenge=xyz`, { headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(await r.text(), 'xyz');
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');

  // valor com caracteres fora de [A-Za-z0-9._-] ou longo demais nunca é ecoado
  for (const bad of ['a b<script>', 'x'.repeat(201)]) {
    r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD', headers: { 'X-AdobeSign-ClientId': bad } });
    assert.equal(r.headers.get('x-adobesign-clientid'), 'test-client-id');
  }
  await world.close();
});

test('webhook HEAD/GET: sem CLIENT_ID configurado cai no header da requisição', async () => {
  const world = await buildWorld({ listen: true, env: { CLIENT_ID: '' } });
  let r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD', headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');
  r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD' });
  assert.equal(r.headers.get('x-adobesign-clientid'), null);
  await world.close();
});

test('webhook POST: header ClientId diferente do CLIENT_ID só gera warn (padrão) e o evento é aceito', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  let r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1', { notificationId: 'ok-1' }), {
    'X-AdobeSign-ClientId': 'test-client-id'
  });
  assert.equal(r.status, 200);
  assert.equal(world.logger.has('warn', /ClientId diferente/), false);

  r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1', { notificationId: 'bad-1' }), {
    'X-AdobeSign-ClientId': 'forged'
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'forged', 'o eco é do valor recebido');
  assert.ok(world.logger.has('warn', /ClientId diferente/));
  assert.ok(!world.logger.lines.warn.some((l) => l.includes('forged')), 'não loga o valor recebido');
  assert.equal(world.repo.listEvents('AG-1').length, 2);
  await world.close();
});

test('WEBHOOK_REQUIRE_CLIENT_ID=true: POST com header ausente/diferente => 401 e nada é persistido', async () => {
  const world = await buildWorld({ listen: true, env: { WEBHOOK_REQUIRE_CLIENT_ID: 'true' } });
  seedAgreement(world);
  signed(world);
  const payload = (n) => webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: n });

  let r = await post(world, '/webhook', payload('n-1'), { 'X-AdobeSign-ClientId': 'forged' });
  assert.equal(r.status, 401);
  r = await post(world, '/webhook', payload('n-2'));
  assert.equal(r.status, 401, 'header ausente também conta como divergência');
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  assert.equal(world.repo.get('AG-1').finalKind, null);
  assert.equal(world.calls.length, 0);

  // o handshake (HEAD/GET) continua respondendo
  r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD' });
  assert.equal(r.status, 200);

  r = await post(world, '/webhook', payload('n-3'), { 'X-AdobeSign-ClientId': 'test-client-id' });
  assert.equal(r.status, 200);
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  await world.close();
});

test('WEBHOOK_CLIENT_IDS: ClientId de outro aplicativo (o que criou o webhook) é aceito, ecoado e não gera warn', async () => {
  const world = await buildWorld({
    listen: true, env: { WEBHOOK_CLIENT_IDS: 'ui-app-id, other-app', WEBHOOK_REQUIRE_CLIENT_ID: 'true' }
  });
  assert.deepEqual(world.config.webhookClientIds, ['ui-app-id', 'other-app']);
  seedAgreement(world);
  signed(world);

  let r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1', { notificationId: 'ui-1' }), {
    'X-AdobeSign-ClientId': 'ui-app-id'
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'ui-app-id');
  r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1', { notificationId: 'ui-2' }), {
    'X-AdobeSign-ClientId': 'test-client-id' // o CLIENT_ID da integração continua aceito
  });
  assert.equal(r.status, 200);
  assert.equal(world.logger.has('warn', /ClientId diferente/), false);
  assert.equal(world.repo.listEvents('AG-1').length, 2);

  r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1', { notificationId: 'ui-3' }), {
    'X-AdobeSign-ClientId': 'not-listed'
  });
  assert.equal(r.status, 401, 'fora do conjunto aceito e WEBHOOK_REQUIRE_CLIENT_ID=true');
  assert.equal(world.repo.listEvents('AG-1').length, 2);
  await world.close();
});

test('WEBHOOK_REQUIRE_CLIENT_ID=true sem CLIENT_ID configurado falha fechado (401)', async () => {
  const world = await buildWorld({ listen: true, env: { WEBHOOK_REQUIRE_CLIENT_ID: 'true', CLIENT_ID: '' } });
  seedAgreement(world);
  const r = await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'AG-1'), { 'X-AdobeSign-ClientId': 'anything' });
  assert.equal(r.status, 401);
  assert.equal(world.repo.listEvents('AG-1').length, 0);
  await world.close();
});

test('webhook POST: persiste o evento e responde 200 com X-AdobeSign-ClientId antes do processamento', { timeout: 10000 }, async (t) => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  signed(world);
  let release;
  world.otcs.uploadGate = new Promise((resolve) => { release = resolve; }); // trava o upload no OTCS
  t.after(async () => { release(); await world.close(); });

  const r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'http-1' }), {
    'X-AdobeSign-ClientId': 'abc123'
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');
  assert.equal(await r.text(), 'OK');
  // O gate ainda fechado prova que o HTTP não aguardou o OTCS, sem depender da velocidade da máquina.

  // evento já está persistido, mas o upload ainda não terminou
  const events = world.repo.listEvents('AG-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].notificationId, 'http-1');
  assert.equal(events[0].kind, 'final_ok');
  assert.equal(world.repo.get('AG-1').sendonDone, false);
  assert.equal(world.otcs.versions.length, 0);

  // libera o OTCS: o processamento assíncrono conclui
  release();
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.deepEqual(world.calls.map((c) => c[0]), ['adobe.getAgreement', 'adobe.download', 'otcs.addVersion', 'otcs.sendon']);
});

test('webhook POST: dedupe por webhookNotificationId', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  signed(world);
  const payload = webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'same-id' });
  assert.equal((await post(world, '/webhook', payload)).status, 200);
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.equal((await post(world, '/webhook', payload)).status, 200);
  assert.equal((await post(world, '/webhook', payload)).status, 200);

  assert.equal(world.repo.listEvents('AG-1').length, 1);
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('webhook POST: eventos legados, informativos e vermelhos respondem 200', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world, 'AG-L');
  seedAgreement(world, 'AG-I');
  signed(world, 'AG-L');
  for (const [i, e] of ['AGREEMENT_CREATED', 'AGREEMENT_VAULTED', 'AGREEMENT_NOT_A_REAL_EVENT'].entries()) {
    const r = await post(world, '/webhook', webhookPayload(e, 'AG-I', { notificationId: `i-${i}` }));
    assert.equal(r.status, 200);
  }
  assert.equal(world.repo.listEvents('AG-I').length, 3);
  assert.equal(world.repo.get('AG-I').state, 'pending');
  assert.equal(world.calls.length, 0);

  await post(world, '/webhook', webhookPayload('AGREEMENT_COMPLETED', 'AG-L'));
  await waitFor(() => world.repo.get('AG-L').state === 'completed');
  await world.close();
});

test('webhook POST: acordo desconhecido responde 200 (log warn) e não grava nada (adoção desligada)', async () => {
  const world = await buildWorld({ listen: true, env: { ADOPT_UNKNOWN_AGREEMENTS: 'false' } });
  const r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'DESCONHECIDO'));
  assert.equal(r.status, 200);
  assert.ok(world.logger.has('warn', /desconocido DESCONHECIDO/));
  assert.equal(world.repo.list().length, 0);
  assert.equal(world.calls.length, 0);
  await world.close();
});

test('webhook POST: acordo desconhecido e que não existe/ não é nosso responde 200 e não grava nada (adoção ligada)', async () => {
  const world = await buildWorld({ listen: true });
  // sem externalId nosso: é de outra integração da mesma conta
  world.adobe.agreements.OUTRO = { id: 'OUTRO', status: 'SIGNED', externalId: { id: 'crm|123' } };
  for (const id of ['DESCONHECIDO', 'OUTRO']) {
    const r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', id, { notificationId: `n-${id}` }));
    assert.equal(r.status, 200);
  }
  await waitFor(() => world.logger.has('warn', /sin externalId propio/) && world.logger.has('warn', /no se pudo adoptar/));
  assert.equal(world.repo.list().length, 0);
  assert.equal(world.otcs.sendons.length, 0);

  // acordo de outra integração: lembrado por alguns minutos, sem nova consulta ao Adobe a cada evento
  const before = world.calls.filter((c) => c[0] === 'adobe.getAgreement').length;
  await post(world, '/webhook', webhookPayload('AGREEMENT_CREATED', 'OUTRO', { notificationId: 'n-OUTRO-2' }));
  assert.equal(world.calls.filter((c) => c[0] === 'adobe.getAgreement').length, before);
  await world.close();
});

test('webhook POST: JSON inválido => 400; falha ao persistir => 500 (Adobe reenvia)', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  let r = await fetch(`${world.baseUrl}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  r = await fetch(`${world.baseUrl}/webhook`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  assert.equal(r.status, 400);

  const original = world.repo.recordEvent;
  world.repo.recordEvent = () => { throw new Error('disk full'); };
  r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1'));
  assert.equal(r.status, 500);
  world.repo.recordEvent = original;
  assert.equal(world.calls.length, 0);
  await world.close();
});

/* ---------- /start ---------- */

test('/auth + /start: fluxo compatível com o template.html', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });

  const fields = {
    userEmail1: 'one@example.com', userEmail2: 'two@example.com',
    nodeId: '1001', attachId: '2002', docName: 'contrato.pdf',
    workflowId: '3003', subworkflowId: '3004'
  };
  const denied = await post(world, '/auth', fields);
  assert.equal(denied.status, 401);

  const auth = await post(world, '/auth', fields, ADMIN);
  assert.equal(auth.status, 200);
  const { v, timestamp, nonce, signature } = await auth.json();
  assert.equal(v, 2);
  assert.match(nonce, /^[a-f0-9]{32}$/);

  const r = await post(world, '/start', { ...fields, taskId: '2', timestamp, nonce, signature });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.message, 'Signature requested. ID: AG-1');

  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'pending');
  assert.equal(rec.nodeId, '1001');
  assert.equal(rec.attachId, '2002');
  assert.equal(rec.fileName, 'contrato.pdf');
  assert.equal(rec.workflowId, '3003');
  assert.equal(rec.subworkflowId, '3004');
  assert.deepEqual(rec.emails, ['one@example.com', 'two@example.com']);
  assert.deepEqual(world.adobe.created[0].emails, ['one@example.com', 'two@example.com']);
  assert.deepEqual(world.otcs.downloads, ['1001']);
  assert.equal(
    world.adobe.created[0].externalId,
    buildExternalId({ workflowId: '3003', subworkflowId: '3004', nodeId: '1001', attachId: '2002' }, world.config.signatureSecret),
    'rastreável pelo externalId, assinado'
  );

  // SendOn automático da tarefa de início (localizada pelo nome; sem disposição) em background
  await waitFor(() => world.otcs.sendons.length === 1);
  assert.equal(world.otcs.sendons[0].taskId, 2);
  assert.equal(world.otcs.sendons[0].disposition, undefined);
  assert.equal(world.otcs.sendons[0].workflowId, 3003);
  assert.equal(world.otcs.sendons[0].subworkflowId, 3004);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  assert.ok(world.repo.get('AG-1').startSendonAt);
  assert.equal(world.otcs.task(3003, 3).status, 'current', 'a tarefa de firma ficou ativa');
  await world.close();
});

test('/start: aceita HMAC v2 válido (destinatários separados por ; ou ,)', async () => {
  const world = await buildWorld({ listen: true });
  const r = await post(world, '/start', startBody(world, { userEmail1: 'a@x.com; b@x.com', userEmail2: 'c@x.com,d@x.com' }));
  assert.equal(r.status, 200);
  assert.deepEqual(world.adobe.created[0].emails, ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  await world.close();
});

test('/start: rejeita assinatura ausente, malformada, inválida, expirada e timestamp inválido', async () => {
  const world = await buildWorld({ listen: true });
  const good = startBody(world);

  let r = await post(world, '/start', { ...good, signature: undefined });
  assert.equal(r.status, 401);
  r = await post(world, '/start', { ...good, timestamp: undefined });
  assert.equal(r.status, 401);
  r = await post(world, '/start', { ...good, signature: 'zz-not-hex' });
  assert.equal(r.status, 400);
  r = await post(world, '/start', { ...good, signature: 'a'.repeat(64) });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Invalid signature.' });

  // assinatura de outro segredo
  r = await post(world, '/start', startBody(world, { signature: signStart('outro-segredo', good) }));
  assert.equal(r.status, 403);

  // timestamp velho (anti-replay), mesmo com HMAC correto
  r = await post(world, '/start', startBody(world, { timestamp: String(world.clock.ms() - 3 * 60 * 1000) }));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Timestamp expired.' });

  // timestamp trocado após assinar
  r = await post(world, '/start', { ...startBody(world), timestamp: String(world.clock.ms() + 1000) });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Invalid signature.' });

  // timestamp não numérico
  r = await post(world, '/start', startBody(world, { timestamp: 'abc' }));
  assert.equal(r.status, 403);

  // nonce mal formado
  r = await post(world, '/start', startBody(world, { nonce: 'curto' }));
  assert.equal(r.status, 400);

  assert.equal(world.adobe.created.length, 0, 'nada foi criado no Adobe');
  assert.equal(world.otcs.downloads.length, 0);
  await world.close();
});

test('/start: sem SIGNATURE_SECRET configurado falha fechado', async () => {
  const world = await buildWorld({ listen: true, env: { SIGNATURE_SECRET: '' } });
  const r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 500);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('/start: duplicado (acordo ABERTO do mesmo documento e destinatários em 15 min) => 409 DUPLICATE_OPEN', async () => {
  const world = await buildWorld({ listen: true });
  assert.equal((await post(world, '/start', startBody(world))).status, 200);

  world.clock.advance(5 * 60 * 1000);
  const dup = await post(world, '/start', startBody(world));
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), {
    error: 'Este documento ya tiene una solicitud de firma abierta para este destinatario en otro flujo.',
    code: 'DUPLICATE_OPEN',
    id: 'AG-1',
    workflowId: '3003'
  });
  assert.equal(world.adobe.created.length, 1);

  // destinatários em outra ordem continuam duplicados; outros destinatários não
  assert.equal((await post(world, '/start', startBody(world, { userEmail1: 'two@example.com', userEmail2: 'one@example.com' }))).status, 409);
  assert.equal((await post(world, '/start', startBody(world, { userEmail2: 'other@example.com' }))).status, 200);

  // passada a janela, o reenvio é permitido
  world.clock.advance(16 * 60 * 1000);
  assert.equal((await post(world, '/start', startBody(world))).status, 200);
  await world.close();
});

test('/start: validações de entrada, login requerido e erro do Adobe', async () => {
  const world = await buildWorld({ listen: true });
  let r = await post(world, '/start', startBody(world, { userEmail1: '', userEmail2: '' }));
  assert.equal(r.status, 400);
  r = await post(world, '/start', startBody(world, { attachId: undefined }));
  assert.equal(r.status, 400);
  r = await post(world, '/start', startBody(world, { attachId: 'abc' }));
  assert.equal(r.status, 400);

  world.adobe.authOk = false;
  r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'LOGIN_REQUIRED' });
  world.adobe.authOk = true;

  world.adobe.createAgreement = async () => { throw new Error('adobe is down'); };
  r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Error al solicitar la firma.' });
  assert.ok(world.logger.has('error', /\[START ERROR\].*adobe is down/), 'detalhe fica só no log');
  assert.equal(world.repo.list().length, 0);
  await world.close();
});

test('/start: corpo de erro do Adobe/OTCS não vaza para o navegador (500 genérico, detalhes no log)', async () => {
  const world = await buildWorld({ listen: true });
  const leaky = (msg) => {
    const e = new Error('Request failed with status code 502');
    e.response = { status: 502, data: Buffer.from(msg) };
    return e;
  };
  world.otcs.downloadNode = async () => { throw leaky('OTCS internal: host=10.1.2.3 secret=abc'); };
  let r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 500);
  let text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'Error al solicitar la firma.' });
  assert.doesNotMatch(text, /10\.1\.2\.3|secret/);
  assert.ok(world.logger.has('error', /\[START ERROR\].*HTTP 502.*host=10\.1\.2\.3/));

  world.adobe.createTransientDocument = async () => {
    const e = new Error('boom');
    e.response = { status: 400, data: { code: 'INVALID_X', message: 'Adobe says: private detail' } };
    throw e;
  };
  world.otcs.downloadNode = async () => Buffer.from('%PDF-1.4');
  r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 500);
  text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'Error al solicitar la firma.' });
  assert.doesNotMatch(text, /private detail|INVALID_X/);
  assert.ok(world.logger.has('error', /private detail/));
  await world.close();
});

test('/start: duas requisições concorrentes iguais => só uma cria o acordo, a outra recebe o mesmo 409', async () => {
  const world = await buildWorld();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const download = world.otcs.downloadNode;
  world.otcs.downloadNode = async (id) => { await gate; return download(id); };

  const first = world.signatureService.start(startBody(world));
  try {
    // mesma chave com e-mails em outra ordem: ainda é a mesma requisição
    const second = world.signatureService.start(startBody(world, { userEmail1: 'two@example.com', userEmail2: 'one@example.com' }));
    await assert.rejects(second, (e) => e.status === 409 && e.body.code === 'START_IN_PROGRESS' && /envío en curso/.test(e.body.error));
    assert.equal(world.otcs.downloads.length, 0, 'a segunda nem chegou ao OTCS');

    // outro documento ou outros destinatários não são bloqueados
    const other = world.signatureService.start(startBody(world, { nodeId: 2002, userEmail2: 'other@example.com' }));
    release();
    const [a, b] = await Promise.all([first, other]);
    assert.notEqual(a.id, b.id);
    assert.equal(world.adobe.created.length, 2);
    await Promise.all([a.sendOn, b.sendOn]);

    // depois de concluída, a chave foi liberada e quem barra é a trava de acordo aberto (DUPLICATE_OPEN)
    await assert.rejects(world.signatureService.start(startBody(world)), (e) => e.status === 409 && e.body.code === 'DUPLICATE_OPEN');
  } finally {
    release(); // um assert que falhe não pode deixar o primeiro envio preso no gate
    await world.close();
  }
});

test('/start: a chave em andamento é liberada em caso de erro (nova tentativa é permitida)', async () => {
  const world = await buildWorld();
  const download = world.otcs.downloadNode;
  world.otcs.downloadNode = async () => { throw new Error('otcs down'); };
  await assert.rejects(world.signatureService.start(startBody(world)), (e) => e.status === 500);

  world.otcs.downloadNode = download;
  const ok = await world.signatureService.start(startBody(world));
  assert.ok(ok.id);
  await ok.sendOn;
  await world.close();
});

test('/start: falha do SendOn automático não derruba a resposta, fica registrada e é retentada (etapa start)', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.addWorkflow('3003', { subprocessId: '3004', stage: 'start' });
  world.otcs.sendOnFailsAlways = true;
  const r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 200);
  await waitFor(() => world.repo.get('AG-1').startSendOnError);
  assert.match(world.repo.get('AG-1').startSendOnError, /sendon failed/);
  assert.ok(world.logger.has('error', /start failed \(attempt 1\)/));
  let rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, false);
  assert.equal(rec.lastErrorStage, 'start');
  assert.equal(world.timers.length, 1, 'retry agendado');

  // o OTCS volta: o runQueue (poller) reenvia o pedido
  world.otcs.sendOnFailsAlways = false;
  world.clock.advance(61 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  rec = world.repo.get('AG-1');
  assert.equal(rec.startSendonDone, true);
  assert.equal(rec.attempts, 0);
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

/* ---------- admin ---------- */

test('admin: GET /admin/agreements exige Basic Auth e lista o estado', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world, 'AG-1');
  seedAgreement(world, 'AG-2', { state: 'needs_attention', attentionReason: 'teste' });

  for (const headers of [{}, { authorization: basicHeader('admin', 'errada') }, { authorization: basicHeader('outro', 'pa:ss') }, { authorization: 'Bearer x' }]) {
    const r = await fetch(`${world.baseUrl}/admin/agreements`, { headers });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /Basic/);
  }

  let r = await fetch(`${world.baseUrl}/admin/agreements`, { headers: ADMIN });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.total, 2);
  assert.deepEqual(body.counts, { pending: 1, needs_attention: 1 });
  assert.deepEqual(body.agreements.map((a) => a.id), ['AG-1', 'AG-2']);

  r = await fetch(`${world.baseUrl}/admin/agreements?state=needs_attention`, { headers: ADMIN });
  body = await r.json();
  assert.deepEqual(body.agreements.map((a) => a.id), ['AG-2']);
  assert.equal(body.agreements[0].attentionReason, 'teste');
  await world.close();
});

test('admin: sem LOG_USER/LOG_PASS configurados tudo é negado', async () => {
  const world = await buildWorld({ listen: true, env: { LOG_USER: '', LOG_PASS: '' } });
  const r = await fetch(`${world.baseUrl}/admin/agreements`, { headers: { authorization: basicHeader('', '') } });
  assert.equal(r.status, 401);
  await world.close();
});

test('admin: POST /admin/reconcile/:id exige Basic Auth, 404 para desconhecido e força a reconciliação', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  signed(world);
  world.otcs.uploadFailures = 1;
  await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1'));
  await waitFor(() => world.repo.get('AG-1').attempts === 1);
  assert.equal(world.repo.get('AG-1').state, 'signed');

  let r = await fetch(`${world.baseUrl}/admin/reconcile/AG-1`, { method: 'POST' });
  assert.equal(r.status, 401);
  r = await fetch(`${world.baseUrl}/admin/reconcile/NOPE`, { method: 'POST', headers: ADMIN });
  assert.equal(r.status, 404);

  // força imediatamente, sem esperar o backoff
  r = await fetch(`${world.baseUrl}/admin/reconcile/AG-1`, { method: 'POST', headers: ADMIN });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.result.status, 'completed');
  assert.equal(body.agreement.state, 'completed');
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('admin: reconcile manual consulta o Adobe quando ainda não há resultado final', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  const r = await fetch(`${world.baseUrl}/admin/reconcile/AG-1`, { method: 'POST', headers: ADMIN });
  assert.equal((await r.json()).result.status, 'completed');
  await world.close();
});

// Faz o login (Basic Auth) e devolve o state que foi para a URL do Adobe
async function oauthLogin(world) {
  const r = await fetch(`${world.baseUrl}/admin/login`, { redirect: 'manual', headers: ADMIN });
  assert.equal(r.status, 302);
  const url = new URL(r.headers.get('location'));
  assert.match(url.origin + url.pathname, /^https:\/\/adobe\.invalid\/public\/oauth\/v2$/);
  return url.searchParams.get('state');
}

test('OAuth: /admin/login exige Basic Auth, redireciona com state aleatório e /admin/callback troca o code', async () => {
  const world = await buildWorld({ listen: true });
  let r = await fetch(`${world.baseUrl}/admin/login`, { redirect: 'manual' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('location'), null);

  const state = await oauthLogin(world);
  assert.match(state, /^[0-9a-f]{48}$/);
  assert.notEqual(await oauthLogin(world), state, 'um state novo a cada login');

  // o callback segue sem Basic Auth (é o redirect do Adobe)
  r = await fetch(`${world.baseUrl}/admin/callback?code=abc&state=${state}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Token saved/);
  assert.deepEqual(world.tokenStore.exchanged, ['abc']);

  r = await fetch(`${world.baseUrl}/admin/callback?code=bad&state=${await oauthLogin(world)}`);
  assert.equal(r.status, 500);
  r = await fetch(`${world.baseUrl}/admin/callback?state=${await oauthLogin(world)}`);
  assert.equal(r.status, 400);
  await world.close();
});

test('OAuth: callback sem state, com state desconhecido, reutilizado ou expirado => 400 sem trocar o code', async () => {
  const world = await buildWorld({ listen: true });
  const cb = async (qs) => (await fetch(`${world.baseUrl}/admin/callback?${qs}`)).status;

  assert.equal(await cb('code=abc'), 400, 'sem state');
  assert.equal(await cb('code=abc&state='), 400, 'state vazio');
  assert.equal(await cb('code=abc&state=nao-emitido'), 400, 'state desconhecido');
  assert.equal(await cb('code=abc&state=a&state=b'), 400, 'state repetido (array)');

  const used = await oauthLogin(world);
  assert.equal(await cb(`code=abc&state=${used}`), 200);
  assert.equal(await cb(`code=abc&state=${used}`), 400, 'uso único');

  const old = await oauthLogin(world);
  world.clock.advance(10 * 60 * 1000 + 1); // TTL de 10 min (relógio injetado, sem sleep)
  assert.equal(await cb(`code=abc&state=${old}`), 400, 'expirado');

  const fresh = await oauthLogin(world);
  world.clock.advance(9 * 60 * 1000);
  assert.equal(await cb(`code=abc&state=${fresh}`), 200, 'dentro do TTL');

  assert.deepEqual(world.tokenStore.exchanged, ['abc', 'abc'], 'o code só foi trocado com state válido');
  assert.ok(world.logger.has('warn', /OAuth callback rechazado/));
  await world.close();
});

test('/health e endpoint desconhecido', async () => {
  const world = await buildWorld({ listen: true });
  let r = await fetch(`${world.baseUrl}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
  r = await fetch(`${world.baseUrl}/nada`);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
  await world.close();
});

/* ---------- /logs ---------- */

async function worldWithRealLogger() {
  const clock = makeClock();
  const logsDir = tmpDir('logs-');
  const logger = createLogger({ logsDir, retentionDays: 15, console: false, schedulePurge: false, now: clock.now });
  const world = await buildWorld({ listen: true, clock, logger });
  world.logsDir = logsDir;
  return world;
}

test('/logs serve o arquivo de auditoria do dia (Basic Auth)', async () => {
  const world = await worldWithRealLogger();
  world.logger.info('linha de teste para download');
  const file = world.logger.auditFilePath();
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('linha de teste'));

  let r = await fetch(`${world.baseUrl}/logs`);
  assert.equal(r.status, 401);
  r = await fetch(`${world.baseUrl}/logs`, { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /audit-2026-06-22\.log/);
  assert.match(await r.text(), /INFO: linha de teste para download/);
  await world.close();
});

test('/logs e /logs/stream: 404 quando não há arquivo do dia', async () => {
  const world = await buildWorld({ listen: true });
  assert.equal((await fetch(`${world.baseUrl}/logs`, { headers: ADMIN })).status, 404);
  assert.equal((await fetch(`${world.baseUrl}/logs/stream`, { headers: ADMIN })).status, 404);
  await world.close();
});

test('/logs/stream envia o conteúdo atual e as novas linhas (SSE)', async () => {
  const world = await worldWithRealLogger();
  world.logger.info('linha antiga');
  const file = world.logger.auditFilePath();
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('linha antiga'));

  assert.equal((await fetch(`${world.baseUrl}/logs/stream`)).status, 401);

  const ac = new AbortController();
  const r = await fetch(`${world.baseUrl}/logs/stream`, { headers: ADMIN, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const readUntil = async (re) => {
    const deadline = Date.now() + 4000;
    while (!re.test(seen)) {
      if (Date.now() > deadline) throw new Error(`SSE: não recebeu ${re}; recebido: ${seen}`);
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
  };
  await readUntil(/data: .*INFO: linha antiga/);
  world.logger.info('linha nova');
  await readUntil(/data: .*INFO: linha nova/);

  ac.abort();
  await world.close();
});
