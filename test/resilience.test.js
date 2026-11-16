// Resiliência do núcleo de reconciliação: teto de reaberturas automáticas, limite global de concorrência, Retry-After,
// confirmação no Adobe de ACTION_COMPLETED parcial, eventos fora de ordem e sinal de webhook inativo no polling.
// Dados sintéticos; nenhum teste chama API real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const { retryAfterMs, failurePatch, reopenPatch } = require('../server/domain/agreementState');
const { computeConfig } = require('../server/config');
const {
  buildWorld, seedAgreement, seedAdobeForEvent, webhookPayload, httpError, waitFor
} = require('./support/fakes');

// Entrega um evento de webhook ao serviço e aguarda o processamento assíncrono (o Adobe confirma o final por padrão)
async function fire(world, event, id = 'AG-1', opts = {}) {
  seedAdobeForEvent(world.adobe, event, id, opts);
  const result = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload(event, id, opts)));
  if (result.processing) await result.processing;
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;

// Erro HTTP como o do axios: status e headers (em minúsculas) em error.response
const rateLimited = (status, headers) => {
  const e = httpError(status, 'slow down');
  e.response.headers = headers;
  return e;
};

/* ---------- 1. teto de reaberturas automáticas (ATTENTION_MAX_REOPENS) ---------- */

// Esgota as tentativas (RETRY_MAX_ATTEMPTS=2) depois de uma tentativa já feita: espera o backoff e roda o runQueue
async function exhaust(world) {
  world.clock.advance(61 * 1000);
  await world.reconciliation.runQueue();
}
// Passa ATTENTION_RETRY_HOURS e roda a reabertura automática
async function reopenAfterHours(world) {
  world.clock.advance(HOUR + 1000);
  return world.reconciliation.reopenStale();
}

test('teto de reaberturas: 403 permanente reabre até ATTENTION_MAX_REOPENS vezes e depois fica em needs_attention; reconcile manual zera', async (t) => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2', ATTENTION_RETRY_HOURS: '1', ATTENTION_MAX_REOPENS: '2' } });
  t.after(() => world.close());
  assert.equal(world.config.attentionMaxReopens, 2);
  seedAgreement(world);
  world.otcs.dispositionFailStatus = 403;
  world.otcs.dispositionFailures = 999;

  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  await exhaust(world);
  let rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.attentionKind].join(), 'needs_attention,retries_exhausted');
  assert.equal(rec.reopenCount, 0);
  assert.doesNotMatch(rec.attentionReason, /no se reabrirá/, 'ainda há reaberturas disponíveis');

  // 1ª e 2ª reaberturas automáticas: cada uma conta e dá uma rodada nova de tentativas
  for (const n of [1, 2]) {
    assert.deepEqual(await reopenAfterHours(world), ['AG-1']);
    rec = world.repo.get('AG-1');
    assert.equal(rec.reopenCount, n);
    assert.equal(rec.state, 'pdf_delivered');
    assert.equal(rec.attempts, 0);
    assert.ok(world.logger.has('warn', new RegExp(`reabierto automáticamente.*reapertura ${n}/2`)));
    await world.reconciliation.runQueue(); // tentativa 1 falha (403)
    await exhaust(world); // tentativa 2 esgota
    rec = world.repo.get('AG-1');
    assert.equal([rec.state, rec.attentionKind].join(), 'needs_attention,retries_exhausted');
  }

  // limite atingido: motivo e log avisam que não reabre mais sozinho; o registro continua visível como needs_attention
  assert.match(rec.attentionReason, /reintentos agotados en disposition \(2\/2\).*HTTP 403.*no se reabrirá automáticamente \(2 reaperturas\); requiere intervención manual/);
  assert.ok(world.logger.has('error', /needs_attention:.*no se reabrirá automáticamente \(2 reaperturas\)/));
  assert.deepEqual(world.repo.list({ state: 'needs_attention' }).map((r) => r.id), ['AG-1']);
  assert.deepEqual(await reopenAfterHours(world), [], 'sem novas reaberturas');
  world.clock.advance(48 * HOUR);
  assert.deepEqual(await world.reconciliation.reopenStale(), []);
  assert.deepEqual(await world.reconciliation.runQueue(), [], 'needs_attention não volta à fila');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.reopenCount].join(), 'needs_attention,2');
  assert.equal(world.otcs.dispositionCalls().length, 0);

  // reconcile manual (POST /admin/reconcile): rodada nova com o contador zerado; corrigido o erro, conclui
  world.otcs.dispositionFailures = 0;
  const res = await world.reconciliation.reconcile('AG-1', { manual: true });
  assert.equal(res.status, 'completed');
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.reopenCount, rec.attempts].join(), 'completed,0,0');
});

test('teto de reaberturas: manual zera o contador mesmo se a nova tentativa falhar, e as reaberturas voltam a valer', async (t) => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '1', ATTENTION_RETRY_HOURS: '1', ATTENTION_MAX_REOPENS: '1' } });
  t.after(() => world.close());
  seedAgreement(world);
  world.otcs.dispositionFailStatus = 403;
  world.otcs.dispositionFailures = 999;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED'); // RETRY_MAX_ATTEMPTS=1: esgota na 1ª falha
  assert.deepEqual(await reopenAfterHours(world), ['AG-1']);
  await world.reconciliation.runQueue();
  assert.equal(world.repo.get('AG-1').state, 'needs_attention');
  assert.deepEqual(await reopenAfterHours(world), [], 'limite 1 atingido');

  await world.reconciliation.reconcile('AG-1', { manual: true }); // continua falhando
  let rec = world.repo.get('AG-1');
  assert.equal(rec.reopenCount, 0);
  assert.equal(rec.state, 'needs_attention', 'esgotou de novo (RETRY_MAX_ATTEMPTS=1)');
  assert.doesNotMatch(rec.attentionReason, /no se reabrirá/);
  assert.deepEqual(await reopenAfterHours(world), ['AG-1'], 'a reabertura automática voltou a valer');
  rec = world.repo.get('AG-1');
  assert.equal(rec.reopenCount, 1);
});

test('teto de reaberturas: ATTENTION_MAX_REOPENS=0 não limita', async (t) => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '1', ATTENTION_RETRY_HOURS: '1', ATTENTION_MAX_REOPENS: '0' } });
  t.after(() => world.close());
  assert.equal(world.config.attentionMaxReopens, 0);
  seedAgreement(world);
  world.otcs.dispositionFailStatus = 403;
  world.otcs.dispositionFailures = 999;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  for (let n = 1; n <= 6; n++) {
    assert.deepEqual(await reopenAfterHours(world), ['AG-1'], `reabertura ${n}`);
    await world.reconciliation.runQueue();
    const rec = world.repo.get('AG-1');
    assert.equal(rec.state, 'needs_attention');
    assert.doesNotMatch(rec.attentionReason, /no se reabrirá/);
  }
  assert.equal(world.repo.get('AG-1').reopenCount, 6);
});

test('teto de reaberturas: novo evento final em needs_attention zera o contador (e o padrão do config é 3)', async (t) => {
  const world = await buildWorld({ env: { RETRY_MAX_ATTEMPTS: '2' } });
  t.after(() => world.close());
  assert.equal(world.config.attentionMaxReopens, 3);
  seedAgreement(world, 'AG-1', {
    finalKind: 'final_ok', state: 'needs_attention', attentionKind: 'retries_exhausted',
    attentionReason: 'reintentos agotados', attempts: 2, reopenCount: 3
  });
  world.otcs.uploadFailures = 1;
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'new-final' });
  const rec = world.repo.get('AG-1');
  assert.equal(rec.reopenCount, 0);
  assert.equal(rec.attentionKind, null);
  assert.equal(rec.attempts, 1);
});

test('reopenPatch: automático conta a reabertura; manual (padrão) zera', () => {
  const rec = { finalKind: 'final_ok', pdfDelivered: true, reopenCount: 2 };
  assert.equal(reopenPatch(rec, { auto: true }).reopenCount, 3);
  assert.equal(reopenPatch({ ...rec, reopenCount: undefined }, { auto: true }).reopenCount, 1);
  assert.equal(reopenPatch(rec).reopenCount, 0);
  assert.equal(reopenPatch(rec).state, 'pdf_delivered');
});

test('config: ATTENTION_MAX_REOPENS e RECONCILE_CONCURRENCY (padrões e valores inválidos)', () => {
  const cfg = (env) => computeConfig({ DATA_DIR: '/tmp/x', ...env });
  assert.equal(cfg({}).attentionMaxReopens, 3);
  assert.equal(cfg({ ATTENTION_MAX_REOPENS: '0' }).attentionMaxReopens, 0);
  assert.equal(cfg({ ATTENTION_MAX_REOPENS: '5' }).attentionMaxReopens, 5);
  assert.equal(cfg({ ATTENTION_MAX_REOPENS: 'abc' }).attentionMaxReopens, 3);
  assert.equal(cfg({ ATTENTION_MAX_REOPENS: '-1' }).attentionMaxReopens, 3);
  assert.equal(cfg({}).reconcileConcurrency, 4);
  assert.equal(cfg({ RECONCILE_CONCURRENCY: '1' }).reconcileConcurrency, 1);
  assert.equal(cfg({ RECONCILE_CONCURRENCY: '8' }).reconcileConcurrency, 8);
  for (const bad of ['0', '-1', '-3', 'abc', '', ' ']) {
    assert.equal(cfg({ RECONCILE_CONCURRENCY: bad }).reconcileConcurrency, 4, `inválido: "${bad}"`);
  }
});

/* ---------- 2. limite global de concorrência (RECONCILE_CONCURRENCY) ---------- */

test('concorrência: 10 acordos distintos com RECONCILE_CONCURRENCY=3 => no máximo 3 pipelines ao mesmo tempo e todos concluem uma vez', async (t) => {
  const world = await buildWorld({ env: { RECONCILE_CONCURRENCY: '3' } });
  t.after(() => world.close());
  assert.equal(world.config.reconcileConcurrency, 3);
  const N = 10;
  const idByWorkflow = new Map();
  for (let i = 0; i < N; i++) {
    const wf = String(4000 + i);
    seedAgreement(world, `AG-${i}`, { nodeId: String(1000 + i), workflowId: wf, subworkflowId: wf });
    idByWorkflow.set(wf, `AG-${i}`);
  }

  // Pipeline em curso = do 1º getAgreement (verify) até a disposição; o PDF é lento para as execuções se sobreporem
  const active = new Set();
  let max = 0;
  const getAgreement = world.adobe.getAgreement.bind(world.adobe);
  world.adobe.getAgreement = async (id) => {
    active.add(id);
    max = Math.max(max, active.size);
    return getAgreement(id);
  };
  const addVersion = world.otcs.addVersion.bind(world.otcs);
  world.otcs.addVersion = async (...args) => {
    await sleep(15);
    return addVersion(...args);
  };
  const sendOn = world.otcs.sendOnWorkflow.bind(world.otcs);
  world.otcs.sendOnWorkflow = async (args) => {
    const out = await sendOn(args);
    if (args.disposition) active.delete(idByWorkflow.get(String(args.workflowId)));
    return out;
  };

  // Rajada: todos os webhooks de uma vez, sem aguardar o processamento (como o handler HTTP)
  const processing = [];
  for (let i = 0; i < N; i++) {
    const id = `AG-${i}`;
    seedAdobeForEvent(world.adobe, 'AGREEMENT_WORKFLOW_COMPLETED', id);
    const r = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', id)));
    assert.ok(r.processing);
    processing.push(r.processing);
  }
  await Promise.all(processing);

  assert.equal(max, 3, 'a rajada ocupa todo o limite, e nunca passa dele');
  assert.equal(active.size, 0);
  assert.equal(world.otcs.versions.length, N);
  assert.deepEqual(world.otcs.versions.map((v) => v.nodeId).sort(), Array.from({ length: N }, (_, i) => String(1000 + i)));
  assert.equal(world.otcs.dispositionCalls().length, N);
  assert.deepEqual([...new Set(world.otcs.dispositionCalls().map((s) => s.workflowId))].length, N);
  for (let i = 0; i < N; i++) assert.equal(world.repo.get(`AG-${i}`).state, 'completed');
});

test('concorrência: com limite 1 a exceção inesperada de um acordo não prende o espaço dos demais', async (t) => {
  const world = await buildWorld({ env: { RECONCILE_CONCURRENCY: '1', RETRY_MAX_ATTEMPTS: '5' } });
  t.after(() => world.close());
  seedAgreement(world, 'AG-A', { nodeId: '1001', workflowId: '4001', subworkflowId: '4001' });
  seedAgreement(world, 'AG-B', { nodeId: '1002', workflowId: '4002', subworkflowId: '4002' });
  const upsert = world.repo.upsert;
  world.repo.upsert = (id, patch) => {
    if (id === 'AG-A' && patch && 'signSubprocessId' in patch) throw new TypeError('bug simulado');
    return upsert(id, patch);
  };
  await Promise.all([
    fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-A'),
    fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-B')
  ]);
  assert.equal(world.repo.get('AG-B').state, 'completed');
  assert.equal(world.repo.get('AG-A').lastErrorStage, 'reconcile');
  assert.ok(world.logger.has('error', /error inesperado en la reconciliación: .*bug simulado/));
});

test('concorrência: acordo em hold não ocupa espaço nem trava o settle (sem deadlock) com o limite ocupado', async (t) => {
  const world = await buildWorld({ env: { RECONCILE_CONCURRENCY: '1' } });
  t.after(() => world.close());
  seedAgreement(world, 'AG-B', { nodeId: '1002', workflowId: '4002', subworkflowId: '4002' });
  seedAgreement(world, 'AG-A', { nodeId: '1001', workflowId: '4001', subworkflowId: '4001' });
  seedAgreement(world, 'AG-C', { nodeId: '1003', workflowId: '4003', subworkflowId: '4003' });

  // B segura o único espaço (o upload do PDF fica preso)
  let openGate;
  world.otcs.uploadGate = new Promise((r) => { openGate = r; });
  const pB = fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-B');
  await waitFor(() => world.calls.some((c) => c[0] === 'otcs.addVersion' && c[1] === '1002'));

  // C em hold sem execução em curso: o reconcile devolve 'held' na hora, sem esperar o espaço
  const releaseC = world.reconciliation.hold('AG-C');
  const heldC = await Promise.race([world.reconciliation.reconcile('AG-C'), sleep(500).then(() => 'blocked')]);
  assert.equal(heldC.status, 'held');
  releaseC();

  // A já está na fila do limite quando o cancelamento a põe em hold: o settle NÃO espera a vez dela (ela ainda não executa
  // nada; ao ganhar a vaga devolve 'held'), então resolve na hora mesmo com o único espaço ocupado por B
  seedAdobeForEvent(world.adobe, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-A');
  const rA = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-A')));
  await sleep(10); // A entrou na fila do semáforo (o único espaço é de B)
  const releaseA = world.reconciliation.hold('AG-A');
  const settled = world.reconciliation.settle('AG-A').then(() => 'settled');
  assert.equal(await Promise.race([settled, sleep(500).then(() => 'blocked')]), 'settled', 'não espera o espaço do limite');

  openGate();
  await pB;
  assert.equal((await rA.processing).status, 'held');
  assert.equal(world.repo.get('AG-B').state, 'completed');
  assert.equal(world.otcs.versions.some((v) => v.nodeId === '1001'), false, 'A em hold: nada foi enviado');
  assert.notEqual(world.repo.get('AG-A').state, 'completed');

  // solto o hold, a fila reprocessa A
  releaseA();
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-A']);
  assert.equal(world.repo.get('AG-A').state, 'completed');
});

test('concorrência: settle de um acordo parado na fila do limite resolve na hora (todas as vagas ocupadas); ele devolve held sem tocar OTCS/Adobe e, solto o hold, roda normal', async (t) => {
  const world = await buildWorld({ env: { RECONCILE_CONCURRENCY: '2' } });
  t.after(() => world.close());
  assert.equal(world.config.reconcileConcurrency, 2);
  seedAgreement(world, 'AG-B', { nodeId: '1002', workflowId: '4002', subworkflowId: '4002' });
  seedAgreement(world, 'AG-C', { nodeId: '1003', workflowId: '4003', subworkflowId: '4003' });
  seedAgreement(world, 'AG-A', { nodeId: '1001', workflowId: '4001', subworkflowId: '4001' });

  // B e C ocupam as duas vagas (o upload do PDF fica preso)
  let openGate;
  world.otcs.uploadGate = new Promise((r) => { openGate = r; });
  const pB = fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-B');
  const pC = fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-C');
  await waitFor(() => ['1002', '1003'].every((n) => world.calls.some((c) => c[0] === 'otcs.addVersion' && c[1] === n)));

  // A fica parada na fila do limite; o cancelamento põe o hold
  seedAdobeForEvent(world.adobe, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-A');
  const rA = world.reconciliation.handleEvent(parseWebhookPayload(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', 'AG-A')));
  await sleep(10);
  const touchesA = (c) => c.slice(1).some((x) => x === 'AG-A' || x === '1001');
  assert.equal(world.calls.some(touchesA), false, 'A ainda não executou nada');
  const releaseA = world.reconciliation.hold('AG-A');

  // settle (o mesmo que o waitSettled do cancelamento usa) resolve sem liberar nenhuma vaga
  assert.equal(await Promise.race([world.reconciliation.settle('AG-A').then(() => 'settled'), sleep(500).then(() => 'blocked')]), 'settled');
  assert.equal(world.calls.some(touchesA), false);

  // libera as vagas: a execução parada de A ganha a vaga, vê o hold e devolve 'held' sem chamar OTCS/Adobe
  openGate();
  await Promise.all([pB, pC]);
  assert.equal((await rA.processing).status, 'held');
  assert.equal(world.calls.some(touchesA), false, 'em hold: nenhuma chamada ao OTCS/Adobe para A');
  assert.equal(world.otcs.dispositionCalls().some((s) => String(s.workflowId) === '4001'), false);
  assert.equal(world.repo.get('AG-B').state, 'completed');
  assert.equal(world.repo.get('AG-C').state, 'completed');
  assert.notEqual(world.repo.get('AG-A').state, 'completed');

  // solto o hold, A roda normalmente
  releaseA();
  const res = await world.reconciliation.reconcile('AG-A');
  assert.equal(res.status, 'completed');
  assert.equal(world.repo.get('AG-A').state, 'completed');
  assert.equal(world.otcs.versions.some((v) => v.nodeId === '1001'), true);
});

test('concorrência: settle espera a execução que já passou da checagem do hold (dentro do limite)', async (t) => {
  const world = await buildWorld({ env: { RECONCILE_CONCURRENCY: '2' } });
  t.after(() => world.close());
  seedAgreement(world, 'AG-A', { nodeId: '1001', workflowId: '4001', subworkflowId: '4001' });
  let openGate;
  world.otcs.uploadGate = new Promise((r) => { openGate = r; });
  const pA = fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-A');
  await waitFor(() => world.calls.some((c) => c[0] === 'otcs.addVersion' && c[1] === '1001'));

  const release = world.reconciliation.hold('AG-A');
  const settled = world.reconciliation.settle('AG-A').then(() => 'settled');
  assert.equal(await Promise.race([settled, sleep(50).then(() => 'pending')]), 'pending', 'A já executa: o settle espera');
  openGate();
  assert.equal(await Promise.race([settled, sleep(2000).then(() => 'deadlock')]), 'settled');
  await pA;
  release();
});

/* ---------- 3. Retry-After (429 / 503) ---------- */

test('retryAfterMs: segundos, HTTP-date, ausente e lixo', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  const err = (status, headers) => ({ response: { status, headers } });

  assert.equal(retryAfterMs(err(429, { 'retry-after': '120' }), now), 120000);
  assert.equal(retryAfterMs(err(503, { 'retry-after': ' 7 ' }), now), 7000);
  assert.equal(retryAfterMs(err(429, { 'Retry-After': '30' }), now), 30000, 'caixa do header');
  assert.equal(retryAfterMs(err(429, { 'retry-after': ['45'] }), now), 45000);
  assert.equal(retryAfterMs(err(429, { get: (n) => (n === 'retry-after' ? '15' : undefined) }), now), 15000, 'AxiosHeaders');

  const at = (ms) => new Date(now + ms).toUTCString(); // "Mon, 22 Jun 2026 12:05:00 GMT"
  assert.equal(retryAfterMs(err(503, { 'retry-after': at(300000) }), now), 300000);
  assert.equal(retryAfterMs(err(429, { 'retry-after': at(-60000) }), now), null, 'data no passado');
  assert.equal(retryAfterMs(err(429, { 'retry-after': '0' }), now), null);

  assert.equal(retryAfterMs(err(429, {}), now), null, 'ausente');
  assert.equal(retryAfterMs(err(429, undefined), now), null);
  assert.equal(retryAfterMs(err(429, { 'retry-after': '' }), now), null);
  for (const garbage of ['soon', 'foo 1', '-5', '1.5', '12abc', 'Mon, 99 Foo 2026', '2026-06-22T12:05:00Z']) {
    assert.equal(retryAfterMs(err(429, { 'retry-after': garbage }), now), null, `lixo: ${garbage}`);
  }
  // só 429 e 503
  assert.equal(retryAfterMs(err(500, { 'retry-after': '120' }), now), null);
  assert.equal(retryAfterMs(err(403, { 'retry-after': '120' }), now), null);
  assert.equal(retryAfterMs(new Error('rede'), now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test('failurePatch: atraso = max(backoff normal, Retry-After), limitado ao máximo do backoff', () => {
  const backoff = { baseMs: 60000, maxMs: 3600000, maxAttempts: 10 };
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  const delay = (rec, retryAfter) => failurePatch(rec, 'pdf', 'x', now, backoff, { retryAfterMs: retryAfter }).delayMs;

  assert.equal(delay({ attempts: 0 }, null), 60000);
  assert.equal(delay({ attempts: 0 }, 120000), 120000, 'Retry-After maior que o backoff');
  assert.equal(delay({ attempts: 0 }, 5000), 60000, 'Retry-After menor: vale o backoff');
  assert.equal(delay({ attempts: 2 }, 100000), 240000, 'backoff maior que o Retry-After');
  assert.equal(delay({ attempts: 0 }, 99999999), 3600000, 'limitado ao teto de 60 min');
  const p = failurePatch({ attempts: 0 }, 'pdf', 'x', now, backoff, { retryAfterMs: 120000 });
  assert.equal(p.patch.nextAttemptAt, new Date(now + 120000).toISOString());
  // sem o campo maxMs na config usa 60 min
  assert.equal(failurePatch({ attempts: 0 }, 'pdf', 'x', now, {}, { retryAfterMs: 99999999 }).delayMs, 3600000);
});

test('Retry-After 429 no download do Adobe: o retry não vem antes do pedido (e respeita o teto de 60 min)', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  const download = world.adobe.downloadCombinedDocument.bind(world.adobe);
  let header = '120';
  let failures = 1;
  world.adobe.downloadCombinedDocument = async (id) => {
    if (failures-- > 0) throw rateLimited(429, { 'retry-after': header });
    return download(id);
  };

  const t0 = world.clock.ms();
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED');
  let rec = world.repo.get('AG-1');
  assert.equal(rec.lastErrorStage, 'pdf');
  assert.ok(Date.parse(rec.nextAttemptAt) >= t0 + 120 * 1000, 'nextAttemptAt >= agora + Retry-After');
  assert.equal(world.timers.at(-1).ms, 120 * 1000, 'o timer de retry também usa o Retry-After');
  assert.equal(world.otcs.versions.length, 0);

  // antes do prazo o runQueue não reprocessa; no prazo conclui
  world.clock.advance(119 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), []);
  world.clock.advance(1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.otcs.versions.length, 1);
});

test('Retry-After: HTTP-date, teto de 60 min, valor menor que o backoff e 5xx comum ignoram/limitam como esperado', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  const delayFor = async (id, error) => {
    seedAgreement(world, id, { nodeId: id.replace(/\D/g, '') + '1', workflowId: id.replace(/\D/g, '') + '2', subworkflowId: id.replace(/\D/g, '') + '2' });
    world.adobe.downloadCombinedDocument = async () => { throw error; };
    const before = world.clock.ms();
    await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', id);
    return Date.parse(world.repo.get(id).nextAttemptAt) - before;
  };
  const inMs = (ms) => new Date(world.clock.ms() + ms).toUTCString();

  assert.equal(await delayFor('AG-1', rateLimited(503, { 'retry-after': inMs(300000) })), 300000, 'HTTP-date em 503');
  assert.equal(await delayFor('AG-2', rateLimited(429, { 'retry-after': '86400' })), HOUR, 'limitado ao RETRY_MAX_MS');
  assert.equal(await delayFor('AG-3', rateLimited(429, { 'retry-after': '5' })), 60000, 'menor que o backoff');
  assert.equal(await delayFor('AG-4', rateLimited(500, { 'retry-after': '600' })), 60000, '500 ignora o header');
  assert.equal(await delayFor('AG-5', rateLimited(429, { 'retry-after': 'depois' })), 60000, 'header inválido');
});

/* ---------- 4. ACTION_COMPLETED parcial (um de vários signatários) ---------- */

test('ACTION_COMPLETED com status SIGNED no payload, mas o Adobe ainda OUT_FOR_SIGNATURE: sem PDF nem disposição; retry, não needs_attention', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' }; // falta um signatário
  await fire(world, 'AGREEMENT_ACTION_COMPLETED', 'AG-1', { status: 'SIGNED', notificationId: 'ac-1' });

  let rec = world.repo.get('AG-1');
  assert.notEqual(rec.state, 'needs_attention', 'não é needs_attention na primeira tentativa');
  assert.equal([rec.attempts, rec.lastErrorStage].join(), '1,verify');
  assert.equal(rec.nextAttemptAt, new Date(world.clock.ms() + 60 * 1000).toISOString());
  assert.equal(world.timers.length, 1);
  assert.equal(world.otcs.versions.length, 0);
  assert.equal(world.calls.some((c) => c[0] === 'adobe.download'), false);
  assert.equal(world.otcs.dispositionCalls().length, 0);
  assert.equal(rec.adobeStatus, null, 'o status do payload não é gravado');

  // o último signatário assina: o retry confirma no Adobe e conclui uma vez só
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  world.clock.advance(60 * 1000);
  assert.deepEqual(await world.reconciliation.runQueue(), ['AG-1']);
  rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.adobeStatus, rec.disposition].join(), 'completed,SIGNED,Firmado');
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
});

/* ---------- 5. eventos fora de ordem e repetidos ---------- */

test('fora de ordem: WORKFLOW_COMPLETED concluído e depois ACTION_COMPLETED(SIGNED) com outro notificationId: 1 versão, 1 disposição', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'wc-1' });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  const calls = world.calls.length;
  const modelCalls = world.otcs.modelCalls.length;

  const late = await fire(world, 'AGREEMENT_ACTION_COMPLETED', 'AG-1', { status: 'SIGNED', notificationId: 'ac-late' });
  assert.equal(late.duplicate, false);
  assert.equal(late.processing, undefined, 'nada a processar');
  const rec = world.repo.get('AG-1');
  assert.equal(rec.state, 'completed');
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
  assert.equal(world.calls.length, calls, 'nenhuma chamada nova ao Adobe/OTCS');
  assert.equal(world.otcs.modelCalls.length, modelCalls);
  assert.equal(world.repo.listEvents('AG-1').length, 2, 'o evento tardio fica no histórico');
});

test('fora de ordem: final antes do AGREEMENT_CREATED: o CREATED não regride o estado nem faz chamadas', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'wc-1' });
  assert.equal(world.repo.get('AG-1').state, 'completed');
  const before = world.repo.get('AG-1');
  const calls = world.calls.length;

  const created = await fire(world, 'AGREEMENT_CREATED', 'AG-1', { notificationId: 'created-late' });
  assert.equal(created.duplicate, false);
  assert.equal(created.processing, undefined);
  const after = world.repo.get('AG-1');
  assert.equal(after.state, 'completed');
  assert.equal(after.finalKind, before.finalKind);
  assert.equal(after.sendonDone, true);
  assert.equal(after.disposition, 'Firmado');
  assert.equal(world.calls.length, calls, 'nenhuma chamada nova');
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
});

test('fora de ordem: CREATED/ACTION_COMPLETED parcial depois do final de um acordo em needs_attention não o tiram de lá', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world, 'AG-1', { state: 'needs_attention', attentionKind: 'permanent', attentionReason: 'erro permanente em x' });
  const calls = world.calls.length;
  await fire(world, 'AGREEMENT_CREATED', 'AG-1', { notificationId: 'c-1' });
  await fire(world, 'AGREEMENT_ACTION_COMPLETED', 'AG-1', { notificationId: 'ac-partial' }); // status do payload: em andamento
  const rec = world.repo.get('AG-1');
  assert.equal([rec.state, rec.attentionKind].join(), 'needs_attention,permanent');
  assert.equal(world.calls.length, calls);
});

test('dedupe: o mesmo notificationId reenviado grava um só evento e não reprocessa', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  const first = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'dup-1' });
  assert.equal(first.duplicate, false);
  const calls = world.calls.length;
  for (let i = 0; i < 3; i++) {
    const again = await fire(world, 'AGREEMENT_WORKFLOW_COMPLETED', 'AG-1', { notificationId: 'dup-1' });
    assert.equal(again.duplicate, true);
    assert.equal(again.processing, undefined);
  }
  assert.equal(world.repo.listEvents('AG-1').filter((e) => e.notificationId === 'dup-1').length, 1);
  assert.equal(world.repo.listEvents('AG-1').length, 1);
  assert.equal(world.calls.length, calls);
  assert.equal(world.otcs.versions.length, 1);
  assert.equal(world.otcs.dispositionCalls().length, 1);
});

/* ---------- 6. polling: sinal de webhook inativo ---------- */

const NO_WEBHOOK = /\[AG-(\d)\] resultado final detectado sólo por polling: ningún webhook recibido para este acuerdo \(¿webhook inactivo en Adobe\?\)/;

test('poller: final achado só por polling, sem nenhum webhook do acordo => um aviso; com webhook registrado não avisa', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world, 'AG-1');
  seedAgreement(world, 'AG-2', { nodeId: '1101', workflowId: '3103', subworkflowId: '3103' });
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'SIGNED' };
  world.adobe.agreements['AG-2'] = { id: 'AG-2', status: 'SIGNED' };
  // AG-2 recebeu um webhook (informativo): o webhook está vivo para ele
  await fire(world, 'AGREEMENT_CREATED', 'AG-2', { notificationId: 'created-2' });
  assert.equal(world.repo.hasEventFrom('AG-2', 'webhook'), true);
  assert.equal(world.repo.hasEventFrom('AG-1', 'webhook'), false);

  const summary = await world.poller.tick();
  assert.equal(summary.finalized, 2);
  assert.equal(world.repo.get('AG-1').state, 'completed');
  assert.equal(world.repo.get('AG-2').state, 'completed');

  const warns = world.logger.lines.warn.filter((l) => NO_WEBHOOK.test(l));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[AG-1\]/);

  // o acordo já é final: outro tick não repete o aviso
  await world.poller.tick();
  assert.equal(world.logger.lines.warn.filter((l) => NO_WEBHOOK.test(l)).length, 1);
});

test('poller: acordo em andamento não gera o aviso de webhook inativo', async (t) => {
  const world = await buildWorld();
  t.after(() => world.close());
  seedAgreement(world);
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'OUT_FOR_SIGNATURE' };
  await world.poller.tick();
  assert.equal(world.logger.lines.warn.some((l) => NO_WEBHOOK.test(l)), false);
});
