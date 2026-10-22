// Cliente OTCS (modelo de workflow), createAgreement com externalId, migração v1 -> v2 e consultas novas do repositório.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const qs = require('qs');
const { openDatabase, MIGRATIONS } = require('../server/infra/db');
const { createAgreementRepository } = require('../server/infra/agreementRepository');
const { createAdobeClient } = require('../server/infra/adobeClient');
const { createOtcsClient } = require('../server/infra/otcsClient');
const { PDF, tmpDir } = require('./support/fakes');

/* ---------- cliente OTCS ---------- */

function otcsStub(responder) {
  const seen = [];
  const rec = (method) => async (url, ...rest) => {
    const opts = rest[rest.length - 1] || {};
    const body = method === 'get' ? undefined : rest[0];
    seen.push({ method, url, body, opts });
    return responder(method, url, opts, body);
  };
  const http = {
    post: async (url, body, opts) => {
      if (url.endsWith('/v1/auth')) return { data: { ticket: 'tk', validFor: 1800 } };
      seen.push({ method: 'post', url, body, opts });
      return responder('post', url, opts, body);
    },
    get: rec('get'),
    put: rec('put')
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  return { client, seen };
}

test('otcs.downloadNode: sem versão => /content (mais recente); com versão mantém /versions/{v}/content', async () => {
  const { client, seen } = otcsStub(() => ({ data: PDF }));
  await client.downloadNode(1001);
  await client.downloadNode(1001, 3);
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v1/nodes/1001/content');
  assert.equal(seen[1].url, 'https://otcs.invalid/api/v1/nodes/1001/versions/3/content');
  assert.equal(seen[0].opts.headers.OTCSTicket, 'tk');
  assert.ok(seen[0].opts.timeout > 0);
});

test('otcs.addVersion: POST /v1/nodes/{id}/versions multipart com o arquivo', async () => {
  const { client, seen } = otcsStub(() => ({ data: { ok: true } }));
  assert.deepEqual(await client.addVersion(1001, PDF, 'contrato.pdf'), { ok: true });
  const call = seen[0];
  assert.equal(call.method, 'post');
  assert.equal(call.url, 'https://otcs.invalid/api/v1/nodes/1001/versions');
  assert.match(call.opts.headers['content-type'], /^multipart\/form-data/);
  assert.equal(call.opts.headers.OTCSTicket, 'tk');
  assert.ok(call.opts.timeout > 0);
});

test('otcs.addVersion: resposta perdida após a escrita não duplica versão, inclusive com cliente novo', async () => {
  const versions = [];
  let writes = 0;
  const responder = (method, url, opts, body) => {
    if (method === 'get') return { data: { data: versions } };
    writes++;
    assert.match(body.getBuffer().toString(), /name="description"\r\n\r\nAdobe Sign: AG-1/);
    versions.push({ version_number: 2, description: 'Adobe Sign: AG-1' });
    throw new Error('connection lost after commit');
  };
  await assert.rejects(() => otcsStub(responder).client.addVersion(1001, PDF, 'contrato.pdf', { agreementId: 'AG-1' }));
  const recovered = await otcsStub(responder).client.addVersion(1001, PDF, 'contrato.pdf', { agreementId: 'AG-1' });
  assert.equal(recovered.version_number, 2);
  assert.equal(writes, 1);
});

test('otcs.uploadToFolder: resposta perdida ao criar não adiciona versão e retorna o ID do nó no retry', async () => {
  const nodes = [];
  let writes = 0;
  const responder = (method, url, opts, body) => {
    if (method === 'get') return { data: { data: nodes } };
    writes++;
    assert.match(body.getBuffer().toString(), /name="description"\r\n\r\nAdobe Sign: AG-1/);
    nodes.push({ id: 9001, type: 144, name: 'contrato.pdf', description: 'Adobe Sign: AG-1' });
    throw new Error('connection lost after commit');
  };
  await assert.rejects(() => otcsStub(responder).client.uploadToFolder(2002, PDF, 'contrato.pdf', { agreementId: 'AG-1' }));
  const recovered = await otcsStub(responder).client.uploadToFolder(2002, PDF, 'contrato.pdf', { agreementId: 'AG-1' });
  assert.equal(recovered.id, 9001);
  assert.equal(writes, 1);
});

test('otcs.uploadToFolder: nó existente recebe versão marcada e pdfNodeId é o ID do documento', async () => {
  const { client, seen } = otcsStub((method, url) => {
    if (url.includes('/nodes?')) return { data: { data: [{ id: 9001, type: 144, name: 'contrato.pdf' }] } };
    if (method === 'get') return { data: { data: [{ description: 'outro acordo' }] } };
    return { data: { id: 2, version_number: 2 } };
  });
  const result = await client.uploadToFolder(2002, PDF, 'contrato.pdf', { agreementId: 'AG-1' });
  assert.equal(result.id, 9001);
  assert.equal(result.version_number, 2);
  assert.equal(seen.filter((c) => c.method === 'post').length, 1);
});

test('otcs.getProcessSteps: normaliza step_list (números como Number) e tolera listas ausentes', async () => {
  const { client, seen } = otcsStub(() => ({
    data: {
      results: {
        step_list: {
          current: [{
            process_id: '43693053', subprocess_id: '43701548', task_id: '3', task_name: 'Aguardar Firma', task_status: 'ontime',
            task_assignees: { assignee: [{ userId: 11742766, loginName: 'AdminKeralty' }, { userId: '279463' }], assigneeCount: 2 }
          }],
          completed: [{ process_id: 43693053, subprocess_id: 43701548, task_id: 2, task_name: 'Enviar solicitud de firma (Empleado y/o Firmante 2)' }]
        }
      }
    }
  }));
  const steps = await client.getProcessSteps(43693053);
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v2/workflows/status/processes/43693053');
  assert.deepEqual(steps.current, [
    {
      processId: 43693053, subprocessId: 43701548, taskId: 3, name: 'Aguardar Firma', status: 'ontime',
      assigneeIds: [11742766, 279463]
    }
  ]);
  assert.equal(steps.completed[0].taskId, 2);
  assert.equal(steps.completed[0].status, '');
  // sem task_assignees: responsáveis desconhecidos (null); informado e vazio: []
  assert.equal(steps.completed[0].assigneeIds, null);
  assert.deepEqual(steps.next, []);
});

test('otcs.getProcessSteps: assigneeIds vazio quando task_assignees informa nenhum responsável', async () => {
  const { client } = otcsStub(() => ({
    data: { results: { step_list: { current: [
      { process_id: 1, subprocess_id: 1, task_id: 2, task_name: 'x', task_assignees: { assignee: [], assigneeCount: 0 } },
      { process_id: 1, subprocess_id: 1, task_id: 3, task_name: 'y', task_assignees: { assignee: { userId: 7 }, assigneeCount: 1 } }
    ] } } }
  }));
  const steps = await client.getProcessSteps(1);
  assert.deepEqual(steps.current.map((s) => s.assigneeIds), [[], [7]]);
});

test('otcs.getWorkflowAttributes: status/info => { DisplayName: valor } (StepData; espelho ValueTemplate; null => "")', async () => {
  const { client, seen } = otcsStub(() => ({
    data: {
      results: {
        Attributes: {
          Content: {
            RootSet: {
              Children: [
                { ID: 11, DisplayName: 'DocID' },
                { ID: 12, DisplayName: 'AttachID' },
                { ID: 13, DisplayName: 'Email Firmante 2' },
                { ID: 14, DisplayName: 'Nombre del Documento' },
                { DisplayName: 'sem id' }
              ],
              ValueTemplate: { Values: [{ 14: { Values: ['espelho.pdf'] }, 11: { Values: ['0'] } }] }
            }
          },
          StepData: { AttrData: { Values: [{ 11: { Values: [1001] }, 12: { Values: ['2002'] }, 13: { Values: [null] } }] } }
        }
      }
    }
  }));
  const attrs = await client.getWorkflowAttributes(3003);
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v2/workflows/status/info');
  assert.deepEqual(seen[0].opts.params, { workid: 3003 });
  assert.equal(seen[0].opts.headers.OTCSTicket, 'tk');
  assert.deepEqual(attrs, { DocID: '1001', AttachID: '2002', 'Email Firmante 2': '', 'Nombre del Documento': 'espelho.pdf' });

  const empty = otcsStub(() => ({ data: {} }));
  assert.deepEqual(await empty.client.getWorkflowAttributes(1), {});
});

test('otcs.getCurrentUser: GET /v1/auth => { id, name }, em cache; resposta inválida não fica em cache', async () => {
  let n = 0;
  let body = { data: { id: 11742766, name: 'AdminKeralty' } };
  const { client, seen } = otcsStub(() => { n++; return { data: body }; });
  assert.deepEqual(await client.getCurrentUser(), { id: 11742766, name: 'AdminKeralty' });
  assert.deepEqual(await client.getCurrentUser(), { id: 11742766, name: 'AdminKeralty' });
  assert.equal(n, 1, 'uma só consulta');
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v1/auth');
  assert.equal(seen[0].opts.headers.OTCSTicket, 'tk');

  // formato alternativo (id no topo) e falha sem cache
  body = { id: 5, name: 'x' };
  assert.deepEqual(await otcsStub(() => ({ data: body })).client.getCurrentUser(), { id: 5, name: 'x' });
  const bad = otcsStub(() => ({ data: { data: {} } }));
  await assert.rejects(() => bad.client.getCurrentUser());
  await assert.rejects(() => bad.client.getCurrentUser());
  assert.equal(bad.seen.length, 2, 'a falha não é guardada em cache');
});

test('otcs.getTaskForm: disposições (chaves) e atributos por rótulo (schema.title, fallback options.label)', async () => {
  const { client, seen } = otcsStub(() => ({
    data: {
      data: {
        title: 'Aguardar Firma',
        custom_actions: [{ key: 'Firmado', label: 'Firmado' }, { key: 'Rechazado', label: 'Rechazar' }]
      },
      forms: [
        {
          data: { WorkflowForm_1: '123', WorkflowForm_2: 'x' },
          schema: { properties: { WorkflowForm_1: { title: 'DocID', type: 'string' } } },
          options: { fields: { WorkflowForm_2: { label: 'Nombre del Documento' } } }
        },
        {
          data: { WorkflowForm_9: 'a@b', semRotulo: 1 },
          schema: { properties: { WorkflowForm_9: { title: 'Email Firmante 1' } } }
        }
      ]
    }
  }));
  const form = await client.getTaskForm(43693053, 43701548, 3);
  assert.equal(seen[0].url, 'https://otcs.invalid/api/v1/forms/processes/tasks/update');
  assert.deepEqual(seen[0].opts.params, { process_id: 43693053, subprocess_id: 43701548, task_id: 3 });
  assert.equal(form.title, 'Aguardar Firma');
  assert.deepEqual(form.customActions, ['Firmado', 'Rechazado']);
  assert.deepEqual(form.fields, {
    DocID: { key: 'WorkflowForm_1', value: '123' },
    'Nombre del Documento': { key: 'WorkflowForm_2', value: 'x' },
    'Email Firmante 1': { key: 'WorkflowForm_9', value: 'a@b' }
  });

  const empty = otcsStub(() => ({ data: {} }));
  assert.deepEqual(await empty.client.getTaskForm(1, 2, 3), { title: '', customActions: [], fields: {} });
});

test('otcs.updateTaskForm: PUT .../tasks/{t} com body={"action":"formUpdate","values":{...}} form-urlencoded', async () => {
  const { client, seen } = otcsStub(() => ({ data: { ok: true } }));
  await client.updateTaskForm(10, 20, 3, { WorkflowForm_1: 'AG-1', WorkflowForm_2: 'SIGNED' });
  const call = seen[0];
  assert.equal(call.method, 'put');
  assert.equal(call.url, 'https://otcs.invalid/api/v2/processes/10/subprocesses/20/tasks/3');
  assert.equal(call.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const parsed = qs.parse(call.body);
  assert.deepEqual(JSON.parse(parsed.body), {
    action: 'formUpdate', values: { WorkflowForm_1: 'AG-1', WorkflowForm_2: 'SIGNED' }
  });
});

test('otcs: 401 nos métodos novos também refaz o login uma vez', async () => {
  let logins = 0;
  const http = {
    post: async (url) => { logins++; return { data: { ticket: `t${logins}`, validFor: 1800 } }; },
    get: async (url, opts) => {
      if (opts.headers.OTCSTicket === 't1') { const e = new Error('401'); e.response = { status: 401 }; throw e; }
      return { data: { results: { step_list: { current: [] } } } };
    }
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  await client.ensureTicket();
  assert.deepEqual(await client.getProcessSteps(1), { current: [], completed: [], next: [] });
  assert.equal(logins, 2);
});

/* ---------- Adobe: externalId ---------- */

test('adobe.createAgreement: envia externalId { id } só quando informado', async () => {
  const bodies = [];
  const http = { post: async (url, body) => { bodies.push(body); return { data: { id: 'AG-1' } }; } };
  const adobe = createAdobeClient({
    apiBase: 'https://adobe.invalid', ensureToken: async () => 'tk', http, logger: { warn() {} }
  });
  await adobe.createAgreement({ name: 'Documento a.pdf', transientDocumentId: 't', emails: ['a@x.com'], externalId: 'otcs|wf=1|sub=1|node=2|attach=3' });
  await adobe.createAgreement({ name: 'Documento a.pdf', transientDocumentId: 't', emails: ['a@x.com'] });
  assert.deepEqual(bodies[0].externalId, { id: 'otcs|wf=1|sub=1|node=2|attach=3' });
  assert.equal('externalId' in bodies[1], false);
});

/* ---------- banco: migração v1 -> v2 ---------- */

test('db: arquivo criado no schema v1 recebe as migrações seguintes (v2, v3) preservando os dados', () => {
  assert.equal(MIGRATIONS.length, 3);
  const file = path.join(tmpDir(), 'v1.db');

  // banco "antigo": só a migração 1
  const raw = new Database(file);
  raw.exec(MIGRATIONS[0]);
  raw.pragma('user_version = 1');
  raw.prepare(
    `INSERT INTO agreements (id, node_id, attach_id, workflow_id, subworkflow_id, state, final_kind, adobe_status, sendon_done, created_at, updated_at)
     VALUES ('OLD', '1001', '2002', '3003', '3004', 'signed', 'final_ok', 'SIGNED', 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  ).run();
  raw.prepare(
    `INSERT INTO agreements (id, workflow_id, start_sendon_error, sendon_done, created_at, updated_at)
     VALUES (?, '3003', 'sendon failed', ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  ).run('START-FAILED', 0);
  raw.prepare(
    `INSERT INTO agreements (id, workflow_id, start_sendon_error, sendon_done, created_at, updated_at)
     VALUES (?, '3003', 'old error', ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  ).run('ALREADY-DONE', 1);
  raw.prepare(
    `INSERT INTO agreements (id, state, attention_reason, last_error_at, created_at, updated_at)
     VALUES (?, 'needs_attention', ?, '2026-06-01T00:00:00.000Z', 'a', 'b')`
  ).run('EXHAUSTED', 'reintentos agotados en pdf (10/10): timeout');
  raw.prepare(
    `INSERT INTO agreements (id, state, attention_reason, last_error_at, created_at, updated_at)
     VALUES (?, 'needs_attention', ?, '2026-06-01T00:00:00.000Z', 'a', 'b')`
  ).run('PERMANENT', 'error permanente en disposition: forbidden');
  raw.close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  const cols = db.prepare('PRAGMA table_info(agreements)').all().map((c) => c.name);
  for (const c of ['start_sendon_done', 'start_sendon_at', 'sign_subprocess_id', 'sign_task_id', 'pdf_node_id',
    'attention_kind', 'completed_externally', 'wf_attrs_fingerprint', 'adopted']) {
    assert.ok(cols.includes(c), `coluna ${c}`);
  }

  const repo = createAgreementRepository(db);
  const old = repo.get('OLD');
  assert.equal(old.nodeId, '1001');
  assert.equal(old.state, 'signed');
  assert.equal(old.adobeStatus, 'SIGNED');
  assert.equal(old.startSendonDone, true, 'o código antigo já tinha feito o SendOn');
  assert.equal(old.completedExternally, false);
  assert.equal(old.adopted, false);
  assert.equal(old.signSubprocessId, null);
  assert.equal(repo.get('START-FAILED').startSendonDone, false, 'falha conhecida de SendOn continua pendente');
  assert.equal(repo.get('START-FAILED').startSendOnError, 'sendon failed');
  assert.equal(repo.get('ALREADY-DONE').startSendonDone, true, 'fluxo concluído não reabre');
  assert.equal(repo.get('EXHAUSTED').attentionKind, 'retries_exhausted');
  assert.equal(repo.get('PERMANENT').attentionKind, 'permanent');
  assert.deepEqual(repo.listAttentionToReopen('2026-06-02T00:00:00.000Z').map((r) => r.id), ['EXHAUSTED']);
  assert.deepEqual(repo.listPending().map((r) => r.id), ['OLD', 'START-FAILED'], 'final e início pendentes continuam na fila');

  // e reabrir o arquivo já migrado é idempotente
  db.close();
  const again = openDatabase(file);
  assert.equal(again.pragma('user_version', { simple: true }), 3);
  assert.equal(createAgreementRepository(again).get('OLD').startSendonDone, true);
  again.close();
});

test('repo.listPending inclui etapa start pendente (com workflowId) e listAttentionToReopen filtra tipo e data', () => {
  const db = openDatabase(':memory:');
  const repo = createAgreementRepository(db);
  repo.upsert('START', { workflowId: '10', startSendonDone: false, state: 'pending' });
  repo.upsert('START-NOWF', { workflowId: '', startSendonDone: false, state: 'pending' });
  repo.upsert('START-ATT', { workflowId: '10', startSendonDone: false, state: 'needs_attention' });
  repo.upsert('START-DONE', { workflowId: '10', startSendonDone: false, sendonDone: true });
  repo.upsert('OLDSTYLE', { workflowId: '10', state: 'pending' });
  assert.deepEqual(repo.listPending().map((r) => r.id), ['START']);

  const att = (id, extra) => repo.upsert(id, {
    state: 'needs_attention', attentionKind: 'retries_exhausted', lastErrorAt: '2026-06-22T00:00:00.000Z', ...extra
  });
  att('OLD-RETRIES', {});
  att('NEW-RETRIES', { lastErrorAt: '2026-06-22T11:00:00.000Z' });
  att('PERMANENT', { attentionKind: 'permanent' });
  att('NO-KIND', { attentionKind: null });
  att('DONE', { sendonDone: true });
  assert.deepEqual(repo.listAttentionToReopen('2026-06-22T06:00:00.000Z').map((r) => r.id), ['OLD-RETRIES']);
  db.close();
});
