// Carga sintética via HTTP: rajada de /start (v2) para 22 fluxos distintos (mais repetições concorrentes do mesmo fluxo) e,
// depois, 44 webhooks finais embaralhados com reenvios (mesmo notificationId). Nenhum dado real; tudo em fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorld, startBody, webhookPayload, waitFor } = require('./support/fakes');

const FLOWS = 22;
const CONCURRENCY = 3;
const WEBHOOK_BUDGET_MS = 1000;

const flow = (i) => ({
  workflowId: String(5000 + i),
  nodeId: String(7000 + i),
  attachId: String(8000 + i),
  email: `signer${i}@example.com`,
  docName: `doc${i}.pdf`
});

// PRNG determinístico (mulberry32): o embaralhamento é o mesmo em toda rodada
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const postJson = (world, path, body) => fetch(`${world.baseUrl}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('carga: 22 /start concorrentes + 44 webhooks finais embaralhados com reenvios => sem duplicidade e dentro do limite de concorrência', { timeout: 30000 }, async (t) => {
  const world = await buildWorld({
    listen: true,
    env: { START_VERIFY_WORKFLOW: 'true', START_FIELD_DUE_DATE: '', RECONCILE_CONCURRENCY: String(CONCURRENCY) }
  });
  t.after(() => world.close());
  assert.equal(world.config.reconcileConcurrency, CONCURRENCY);

  // Um workflow (fluxo puro, na tarefa de início) e um formulário por fluxo; o OTCS falso tem um formulário só, então o
  // getTaskForm devolve os atributos do fluxo pedido
  const flows = Array.from({ length: FLOWS }, (_, i) => flow(i));
  const byProcess = new Map(flows.map((f) => [f.workflowId, f]));
  for (const f of flows) world.otcs.addWorkflow(f.workflowId, { stage: 'start' });
  const getTaskForm = world.otcs.getTaskForm.bind(world.otcs);
  world.otcs.getTaskForm = async (processId, subprocessId, taskId) => {
    const base = await getTaskForm(processId, subprocessId, taskId);
    const f = byProcess.get(String(processId));
    const field = (label, value) => [label, { key: `k_${label.replace(/\W/g, '')}`, value }];
    return {
      ...base,
      fields: Object.fromEntries([
        field('DocID', f.nodeId), field('AttachID', f.attachId), field('Nombre del Documento', f.docName),
        field('Email Firmante 1', f.email)
      ])
    };
  };

  // Pipelines em curso (do 1º getAgreement do verify até a disposição) e o pico; o PDF é lento para as execuções se sobreporem
  const active = new Set();
  let peak = 0;
  const idByWorkflow = new Map();
  const getAgreement = world.adobe.getAgreement.bind(world.adobe);
  world.adobe.getAgreement = async (id) => {
    active.add(id);
    peak = Math.max(peak, active.size);
    return getAgreement(id);
  };
  const addVersion = world.otcs.addVersion.bind(world.otcs);
  world.otcs.addVersion = async (...args) => {
    await new Promise((r) => setTimeout(r, 5));
    return addVersion(...args);
  };
  const sendOn = world.otcs.sendOnWorkflow.bind(world.otcs);
  world.otcs.sendOnWorkflow = async (args) => {
    const out = await sendOn(args);
    if (args.disposition) active.delete(idByWorkflow.get(String(args.workflowId)));
    return out;
  };

  /* ---------- fase 1: /start concorrentes ---------- */

  const startFor = (f) => startBody(world, {
    workflowId: f.workflowId, subworkflowId: f.workflowId, nodeId: f.nodeId, attachId: f.attachId,
    userEmail1: f.email, userEmail2: '', docName: f.docName, taskId: 2
  });
  const DUPLICATED = [0, 5, 10, 15]; // fluxos que recebem 2 /start extras ao mesmo tempo
  const requests = flows.map((f) => ({ f, body: startFor(f) }));
  for (const i of DUPLICATED) for (let k = 0; k < 2; k++) requests.push({ f: flows[i], body: startFor(flows[i]) });

  const responses = await Promise.all(shuffle(requests, rng(1)).map(async ({ f, body }) => {
    const res = await postJson(world, '/start', body);
    return { f, status: res.status, json: await res.json() };
  }));

  const idsByWorkflow = new Map();
  for (const r of responses) {
    // repetição concorrente: ou devolve o acordo que já existe (200 existing) ou "envio em curso" (409); nunca 5xx nem outro acordo
    assert.ok([200, 409].includes(r.status), `/start ${r.f.workflowId}: ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status === 409) assert.equal(r.json.code, 'START_IN_PROGRESS');
    else {
      if (!idsByWorkflow.has(r.f.workflowId)) idsByWorkflow.set(r.f.workflowId, new Set());
      idsByWorkflow.get(r.f.workflowId).add(r.json.id);
    }
  }
  assert.equal(idsByWorkflow.size, FLOWS, 'cada fluxo teve ao menos um /start aceito');
  for (const [wf, ids] of idsByWorkflow) assert.equal(ids.size, 1, `fluxo ${wf}: um só acordo`);

  // Zero acordos duplicados no Adobe e um registro por fluxo
  assert.equal(world.adobe.created.length, FLOWS);
  assert.equal(new Set(world.adobe.created.map((a) => a.externalId)).size, FLOWS);
  const records = world.repo.list();
  assert.equal(records.length, FLOWS);
  assert.equal(new Set(records.map((r) => r.workflowId)).size, FLOWS);
  for (const [wf, ids] of idsByWorkflow) idByWorkflow.set(wf, [...ids][0]);

  // A etapa start (SendOn da tarefa de início) conclui para todos antes de o Adobe "assinar"
  await waitFor(() => world.repo.list().every((r) => r.startSendonDone), { timeout: 10000 });
  assert.equal(world.otcs.sendons.length, FLOWS, 'um SendOn de início por fluxo');

  /* ---------- fase 2: webhooks finais ---------- */

  const agreements = [...idByWorkflow.entries()].map(([workflowId, id]) => ({ workflowId, id }));
  for (const { id } of agreements) world.adobe.agreements[id] = { ...world.adobe.agreements[id], status: 'SIGNED' };

  const events = [];
  for (const { id } of agreements) {
    events.push(webhookPayload('AGREEMENT_ACTION_COMPLETED', id, { status: 'SIGNED', notificationId: `ac-${id}` }));
    events.push(webhookPayload('AGREEMENT_WORKFLOW_COMPLETED', id, { notificationId: `wc-${id}` }));
  }
  assert.equal(events.length, FLOWS * 2);
  const random = rng(2);
  const redeliveries = shuffle(events, random).slice(0, 10); // 10 reenvios do mesmo notificationId
  const burst = shuffle([...events, ...redeliveries], random);

  const timings = await Promise.all(burst.map(async (payload) => {
    const t0 = performance.now();
    const res = await postJson(world, '/webhook', payload);
    await res.text();
    return { status: res.status, ms: performance.now() - t0 };
  }));
  assert.equal(timings.length, FLOWS * 2 + 10);
  for (const { status, ms } of timings) {
    assert.equal(status, 200);
    assert.ok(ms < WEBHOOK_BUDGET_MS, `webhook respondeu em ${Math.round(ms)} ms (limite ${WEBHOOK_BUDGET_MS} ms)`);
  }

  // Todos concluem, cada um com um único PDF (versão do próprio DocID) e uma única disposição Firmado
  await waitFor(() => world.repo.list().every((r) => r.state === 'completed'), { timeout: 15000 });
  assert.ok(peak >= 2, `a rajada deveria sobrepor pipelines (pico ${peak})`);
  assert.ok(peak <= CONCURRENCY, `pico de pipelines simultâneos ${peak} > RECONCILE_CONCURRENCY=${CONCURRENCY}`);
  assert.equal(active.size, 0);

  assert.equal(world.otcs.versions.length, FLOWS);
  assert.equal(world.otcs.uploads.length, 0, 'sem PDF na pasta (fallback)');
  for (const f of flows) {
    assert.equal(world.otcs.versions.filter((v) => v.nodeId === f.nodeId).length, 1, `versões do nó ${f.nodeId}`);
    const dispositions = world.otcs.dispositionCalls().filter((s) => String(s.workflowId) === f.workflowId);
    assert.equal(dispositions.length, 1, `disposições do workflow ${f.workflowId}`);
    assert.equal(dispositions[0].disposition, 'Firmado');
  }
  assert.equal(world.otcs.dispositionCalls().length, FLOWS);
  assert.equal(world.adobe.created.length, FLOWS, 'nenhum acordo novo durante a carga de webhooks');

  // Cada acordo guarda os dois eventos uma só vez (os reenvios foram deduplicados)
  for (const { id } of agreements) {
    const hooks = world.repo.listEvents(id).filter((e) => e.source === 'webhook');
    assert.deepEqual(hooks.map((e) => e.notificationId).sort(), [`ac-${id}`, `wc-${id}`].sort());
    const rec = world.repo.get(id);
    assert.equal([rec.finalKind, rec.disposition, rec.sendonDone].join(), 'final_ok,Firmado,true');
  }
  assert.equal(world.logger.lines.error.length, 0, world.logger.lines.error.join('\n'));
});
