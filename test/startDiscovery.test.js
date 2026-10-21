// Descoberta de tarefas de envio na caixa do usuário de integração (rede de segurança do /start).
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeConfig } = require('../server/config');
const { createOtcsClient } = require('../server/infra/otcsClient');
const { createStartDiscovery } = require('../server/services/startDiscovery');
const { ServiceError } = require('../server/services/signatureService');
const {
  makeClock, makeLogger, makeOtcs, httpError, tmpDir, buildWorld, seedStartFlow, START_TASK_NAME, waitFor
} = require('./support/fakes');

const NAME = 'Enviar solicitud de firma';
const task = (over = {}) => ({ workflowId: 3003, subworkflowId: 3004, taskId: 2, name: NAME, ...over });

// signatureService falso: grava as chamadas; `respond` decide o resultado (ou lança)
function stubSignature(respond = async () => ({ id: 'AG-1', sendOn: Promise.resolve() })) {
  const calls = [];
  return {
    calls,
    async start(input, opts) {
      calls.push({ input, opts });
      return respond(calls.length, input, opts);
    }
  };
}

function setup({ taskNames = [NAME], graceMs = 1000, retryMs = 300000, respond, assignments = [task()] } = {}) {
  const clock = makeClock();
  const logger = makeLogger();
  const otcs = makeOtcs();
  otcs.assignments = assignments;
  const signature = stubSignature(respond);
  const config = { startDiscovery: { taskNames, graceMs, intervalMs: 60000, retryMs } };
  const discovery = createStartDiscovery({ otcs, signatureService: signature, config, logger, now: clock.ms });
  return { clock, logger, otcs, signature, discovery };
}

// Cliente OTCS com http falso: a resposta de GET /v2/members/assignments é `body`
function otcsReturning(body) {
  const seen = [];
  const http = {
    post: async () => ({ data: { ticket: 'tk', validFor: 1800 } }),
    get: async (url, opts) => { seen.push({ url, opts }); return { data: body }; }
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  return { client, seen };
}

test('config: START_DISCOVERY_* tem padrões desligados e lê a lista, a carência e o mínimo de 5 s do intervalo', () => {
  const off = computeConfig({ DATA_DIR: tmpDir() }).startDiscovery;
  assert.deepEqual(off, { taskNames: [], graceMs: 120000, intervalMs: 60000, retryMs: 1800000 });

  const on = computeConfig({
    DATA_DIR: tmpDir(),
    START_DISCOVERY_TASK_NAMES: 'Enviar solicitud de firma, Otra tarea',
    START_DISCOVERY_GRACE_MS: '0',
    START_DISCOVERY_INTERVAL_MS: '100',
    START_DISCOVERY_RETRY_MS: '5000'
  }).startDiscovery;
  assert.deepEqual(on, { taskNames: ['Enviar solicitud de firma', 'Otra tarea'], graceMs: 0, intervalMs: 5000, retryMs: 5000 });
});

test('otcs.getAssignments: data.assignments como objeto ou array; só type 153 com workflow_id numérico', async () => {
  const { client, seen } = otcsReturning({
    results: [
      { data: { assignments: { name: 'Enviar solicitud de firma', type: 153, workflow_id: 3003, workflow_subworkflow_id: 3004, workflow_subworkflow_task_id: 2 } } },
      { data: { assignments: [
        { name: 'Aguardar Firma', type: 153, workflow_id: '5005', workflow_subworkflow_id: '5006', workflow_subworkflow_task_id: '3' },
        { name: 'Documento', type: 144, workflow_id: 7007 },
        { name: 'Sin workflow', type: 153, workflow_id: '' }
      ] } },
      { data: { assignments: { name: 'Fluxo puro', type: 153, workflow_id: 8008 } } }
    ],
    links: []
  });
  assert.deepEqual(await client.getAssignments(), [
    { workflowId: 3003, subworkflowId: 3004, taskId: 2, name: 'Enviar solicitud de firma' },
    { workflowId: 5005, subworkflowId: 5006, taskId: 3, name: 'Aguardar Firma' },
    { workflowId: 8008, subworkflowId: 8008, taskId: null, name: 'Fluxo puro' }
  ]);
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v2/members/assignments');
});

test('otcs.getAssignments: sem results devolve lista vazia', async () => {
  const { client } = otcsReturning({});
  assert.deepEqual(await client.getAssignments(), []);
});

test('discovery: sem START_DISCOVERY_TASK_NAMES fica desligada: start() devolve false e tick não consulta o OTCS', async () => {
  const { discovery, otcs } = setup({ taskNames: [] });
  assert.equal(discovery.start(), false);
  assert.deepEqual(await discovery.tick(), { seen: 0, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.deepEqual(otcs.modelCalls, []);
  discovery.stop();
});

test('discovery: start() ligada devolve true (idempotente) e stop() limpa os timers', () => {
  const { discovery } = setup();
  assert.equal(discovery.start(), true);
  assert.equal(discovery.start(), true);
  discovery.stop();
});

test('discovery: nome exato, sem prefixo: "... (Empleado y/o Firmante 2)" não casa com "Enviar solicitud de firma"', async () => {
  const { discovery, signature } = setup({
    graceMs: 0, assignments: [task({ name: 'Enviar solicitud de firma (Empleado y/o Firmante 2)' })]
  });
  assert.deepEqual(await discovery.tick(), { seen: 0, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 0);
});

test('discovery: acentos e caixa não importam ("ENVIÁR  solicitud de  FIRMA" casa com "Enviar solicitud de firma")', async () => {
  const { discovery, signature } = setup({ graceMs: 0, assignments: [task({ name: 'ENVIÁR  solicitud de  FIRMA' })] });
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 1, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 1);
});

test('discovery: a primeira vez só registra; após a carência chama start({ workflowId, subworkflowId }, { forceVerify: true }) uma vez', async () => {
  const { clock, discovery, signature } = setup({ graceMs: 1000 });
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 0);

  clock.advance(999);
  await discovery.tick();
  assert.equal(signature.calls.length, 0);

  clock.advance(1);
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 1, existing: 0, errors: 0 });
  assert.deepEqual(signature.calls, [{ input: { workflowId: 3003, subworkflowId: 3004 }, opts: { forceVerify: true } }]);

  // criado: não repete enquanto a tarefa estiver na caixa
  clock.advance(600000);
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 1);
});

test('discovery: ServiceError 409 => sem nova tentativa antes de retryMs; depois tenta de novo', async () => {
  let fail = true;
  const { clock, discovery, signature, logger } = setup({
    graceMs: 0,
    retryMs: 300000,
    respond: async () => {
      if (fail) throw new ServiceError(409, { error: 'El flujo no está en el paso de envío a firma.' });
      return { id: 'AG-2', sendOn: Promise.resolve() };
    }
  });
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 0, existing: 0, errors: 1 });
  assert.equal(signature.calls.length, 1);
  assert.ok(logger.has('warn', /HTTP 409 \| El flujo no está/));

  clock.advance(299999);
  await discovery.tick();
  assert.equal(signature.calls.length, 1, 'ainda em backoff');

  clock.advance(1);
  fail = false;
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 1, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 2);
});

test('discovery: erro inesperado do start vai para o log de erro e também entra em backoff', async () => {
  const { clock, discovery, signature, logger } = setup({
    graceMs: 0, retryMs: 300000, respond: async () => { throw httpError(500, 'otcs down'); }
  });
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 0, existing: 0, errors: 1 });
  assert.ok(logger.has('error', /HTTP 500/));
  clock.advance(1000);
  await discovery.tick();
  assert.equal(signature.calls.length, 1);
});

test('discovery: acordo já existente conta como existing, não é erro e não repete enquanto a tarefa estiver na caixa', async () => {
  const { clock, discovery, signature, logger } = setup({
    graceMs: 0, respond: async () => ({ id: 'AG-9', existing: true, sendOn: Promise.resolve() })
  });
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 0, existing: 1, errors: 0 });
  assert.ok(logger.has('info', /acordo AG-9 já existente/));
  clock.advance(600000);
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 1);
});

test('discovery: falha ao ler a caixa => tick resolve, loga warn e não chama o signatureService', async () => {
  const { discovery, signature, logger, otcs } = setup();
  otcs.getAssignments = async () => { throw httpError(503, 'otcs down'); };
  assert.deepEqual(await discovery.tick(), { seen: 0, eligible: 0, started: 0, existing: 0, errors: 1 });
  assert.equal(signature.calls.length, 0);
  assert.ok(logger.has('warn', /caixa do usuário de integração: .*HTTP 503/));
});

test('discovery: tarefa que sai da caixa esquece a carência; se voltar, a carência recomeça', async () => {
  const { clock, discovery, signature, otcs } = setup({ graceMs: 1000 });
  await discovery.tick();          // registra em T0
  otcs.assignments = [];
  clock.advance(5000);
  await discovery.tick();          // saiu da caixa: esquecida
  otcs.assignments = [task()];
  clock.advance(5000);
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 0, started: 0, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 0);
  clock.advance(1000);
  assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 1, existing: 0, errors: 0 });
  assert.equal(signature.calls.length, 1);
});

test('discovery: ticks concorrentes são coalescidos (uma só leitura da caixa)', async () => {
  const { discovery, otcs } = setup({ graceMs: 0 });
  let reads = 0;
  const original = otcs.getAssignments;
  otcs.getAssignments = async () => { reads++; return original(); };
  const [a, b] = await Promise.all([discovery.tick(), discovery.tick()]);
  assert.equal(reads, 1);
  assert.strictEqual(a, b);
});

test('discovery + signatureService real: tarefa na caixa cria o acordo e faz o SendOn, como o /start', async () => {
  const world = await buildWorld({
    env: { START_DISCOVERY_TASK_NAMES: START_TASK_NAME, START_DISCOVERY_GRACE_MS: '0' }
  });
  try {
    seedStartFlow(world, { processId: '3003', subprocessId: '3004', stage: 'start' });
    world.otcs.assignments = [{ workflowId: 3003, subworkflowId: 3004, taskId: 2, name: START_TASK_NAME }];
    const discovery = createStartDiscovery({
      otcs: world.otcs, signatureService: world.signatureService, config: world.config, logger: world.logger, now: world.clock.ms
    });

    assert.deepEqual(await discovery.tick(), { seen: 1, eligible: 1, started: 1, existing: 0, errors: 0 });
    assert.equal(world.adobe.created.length, 1);
    assert.deepEqual(world.adobe.created[0].emails, ['one@example.com', 'two@example.com']);
    await waitFor(() => world.otcs.sendons.length === 1);
    assert.equal(world.otcs.task(3003, 2).status, 'completed');

    // A tarefa sai da caixa depois do SendOn; uma nova rodada não cria outro acordo
    world.otcs.assignments = [];
    await discovery.tick();
    assert.equal(world.adobe.created.length, 1);
  } finally {
    await world.close();
  }
});
