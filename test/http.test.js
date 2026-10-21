const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../server/infra/logger');
const { sign } = require('../server/http/middleware/hmac');
const {
  buildWorld, seedAgreement, webhookPayload, waitFor, startBody, basicHeader, makeClock, tmpDir
} = require('./support/fakes');

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (world, p, body, headers = {}) =>
  fetch(`${world.baseUrl}${p}`, { ...json(body), headers: { 'content-type': 'application/json', ...headers } });
const ADMIN = { authorization: basicHeader('admin', 'pa:ss') }; // senha com ":" de propósito

/* ---------- webhook ---------- */

test('webhook HEAD/GET: eco do X-AdobeSign-ClientId', async () => {
  const world = await buildWorld({ listen: true });

  let r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD', headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');

  r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'test-client-id', 'sem header: usa o CLIENT_ID configurado');

  r = await fetch(`${world.baseUrl}/webhook`, { headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');
  assert.deepEqual(await r.json(), { status: 'pong' });

  r = await fetch(`${world.baseUrl}/webhook?challenge=xyz`, { headers: { 'X-AdobeSign-ClientId': 'abc123' } });
  assert.equal(await r.text(), 'xyz');
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');
  await world.close();
});

test('webhook POST: persiste o evento e responde 200 com X-AdobeSign-ClientId antes do processamento', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  let release;
  world.otcs.uploadGate = new Promise((resolve) => { release = resolve; }); // trava o upload no OTCS

  const t0 = Date.now();
  const r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'http-1' }), {
    'X-AdobeSign-ClientId': 'abc123'
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-adobesign-clientid'), 'abc123');
  assert.equal(await r.text(), 'OK');
  assert.ok(Date.now() - t0 < 1500, 'resposta rápida');

  // evento já está persistido, mas o upload ainda não terminou
  const events = world.repo.listEvents('AG-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].notificationId, 'http-1');
  assert.equal(events[0].kind, 'final_ok');
  assert.equal(world.repo.get('AG-1').sendonDone, false);
  assert.equal(world.otcs.uploads.length, 0);

  // libera o OTCS: o processamento assíncrono conclui
  release();
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.deepEqual(world.calls.map((c) => c[0]), ['adobe.download', 'otcs.upload', 'otcs.sendon']);
  await world.close();
});

test('webhook POST: dedupe por webhookNotificationId', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world);
  const payload = webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'same-id' });
  assert.equal((await post(world, '/webhook', payload)).status, 200);
  await waitFor(() => world.repo.get('AG-1').state === 'completed');
  assert.equal((await post(world, '/webhook', payload)).status, 200);
  assert.equal((await post(world, '/webhook', payload)).status, 200);

  assert.equal(world.repo.listEvents('AG-1').length, 1);
  assert.equal(world.otcs.uploads.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  await world.close();
});

test('webhook POST: eventos legados, informativos e vermelhos respondem 200', async () => {
  const world = await buildWorld({ listen: true });
  seedAgreement(world, 'AG-L');
  seedAgreement(world, 'AG-I');
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

test('webhook POST: acordo desconhecido responde 200 (log warn) e não grava nada', async () => {
  const world = await buildWorld({ listen: true });
  const r = await post(world, '/webhook', webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'DESCONHECIDO'));
  assert.equal(r.status, 200);
  assert.ok(world.logger.has('warn', /desconocido DESCONHECIDO/));
  assert.equal(world.repo.list().length, 0);
  assert.equal(world.calls.length, 0);
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

  const denied = await fetch(`${world.baseUrl}/auth`);
  assert.equal(denied.status, 401);

  const auth = await fetch(`${world.baseUrl}/auth`, { headers: ADMIN });
  assert.equal(auth.status, 200);
  const { timestamp, signature } = await auth.json();

  const r = await post(world, '/start', {
    userEmail1: 'one@example.com', userEmail2: 'two@example.com',
    nodeId: '1001', attachId: '2002', docName: 'contrato.pdf',
    workflowId: '3003', subworkflowId: '3004', taskId: '2', timestamp, signature
  });
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

  // SendOn automático da tarefa de envio (sem disposição) em background
  await waitFor(() => world.otcs.sendons.length === 1);
  assert.equal(world.otcs.sendons[0].taskId, '2');
  assert.equal(world.otcs.sendons[0].disposition, undefined);
  assert.equal(world.otcs.sendons[0].workflowId, '3003');
  await world.close();
});

test('/start: aceita HMAC válido (destinatários separados por ; ou ,)', async () => {
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
  r = await post(world, '/start', { ...good, signature: sign('outro-segredo', good.timestamp) });
  assert.equal(r.status, 403);

  // timestamp velho (anti-replay), mesmo com HMAC correto
  const old = String(world.clock.ms() - 3 * 60 * 1000);
  r = await post(world, '/start', { ...good, timestamp: old, signature: sign(world.config.signatureSecret, old) });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Timestamp expired.' });

  // timestamp trocado após assinar
  r = await post(world, '/start', { ...good, timestamp: String(world.clock.ms() + 1000) });
  assert.equal(r.status, 403);

  // timestamp não numérico
  r = await post(world, '/start', { ...good, timestamp: 'abc', signature: sign(world.config.signatureSecret, 'abc') });
  assert.equal(r.status, 403);

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

test('/start: duplicado (mesmo documento e destinatários em 15 min) => 409', async () => {
  const world = await buildWorld({ listen: true });
  assert.equal((await post(world, '/start', startBody(world))).status, 200);

  world.clock.advance(5 * 60 * 1000);
  const dup = await post(world, '/start', startBody(world));
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error, /ya he sido enviado recientemente/);
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
  assert.match((await r.json()).error, /adobe is down/);
  assert.equal(world.repo.list().length, 0);
  await world.close();
});

test('/start: falha do SendOn automático não derruba a resposta e fica registrada', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.sendOnFailsAlways = true;
  const r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 200);
  await waitFor(() => world.repo.get('AG-1').startSendOnError);
  assert.match(world.repo.get('AG-1').startSendOnError, /sendon failed/);
  assert.ok(world.logger.has('error', /Falha no SendOn automático/));
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

test('OAuth: /admin/login redireciona e /admin/callback troca o code', async () => {
  const world = await buildWorld({ listen: true });
  let r = await fetch(`${world.baseUrl}/admin/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/adobe\.invalid\/public\/oauth\/v2/);

  r = await fetch(`${world.baseUrl}/admin/callback?code=abc`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Token saved/);
  assert.deepEqual(world.tokenStore.exchanged, ['abc']);

  r = await fetch(`${world.baseUrl}/admin/callback?code=bad`);
  assert.equal(r.status, 500);
  r = await fetch(`${world.baseUrl}/admin/callback`);
  assert.equal(r.status, 400);
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
