// Pacote 2: HMAC v2 vinculado ao payload + nonce, validação do /start contra o workflow do OTCS (fonte da verdade),
// idempotência, legado (flags), CORS restrito, credencial própria do /auth e migração v3.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { computeConfig } = require('../server/config');
const { openDatabase, MIGRATIONS } = require('../server/infra/db');
const { createAgreementRepository } = require('../server/infra/agreementRepository');
const { canonicalStart, signStart } = require('../server/http/middleware/hmac');
const { parseWebhookPayload } = require('../server/domain/eventPolicy');
const { finalNotice } = require('../server/domain/agreementState');
const {
  buildWorld, startBody, startBodyV1, seedStartFlow, basicHeader, makeClock, waitFor, httpError, tmpDir, webhookPayload,
  INTEGRATION_USER_ID, HUMAN_USER_ID
} = require('./support/fakes');

const OTCS_BASE = 'https://otcs.example.test/cs/cs/api';
const OTCS_ORIGIN = 'https://otcs.example.test';
const ADMIN = { authorization: basicHeader('admin', 'pa:ss') };

const post = (world, p, body, headers = {}) =>
  fetch(`${world.baseUrl}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });

// Campos do envio como o WebReport os tem (sem timestamp/nonce/signature)
const FIELDS = {
  userEmail1: 'one@example.com', userEmail2: 'two@example.com',
  nodeId: '1001', attachId: '2002', docName: 'contrato.pdf', workflowId: '3003', subworkflowId: '3004'
};

// Protocolo completo: POST /auth (Basic) e POST /start com o que voltou
async function authThenStart(world, fields = FIELDS, { authHeaders = ADMIN, tamper = {} } = {}) {
  const auth = await post(world, '/auth', fields, authHeaders);
  assert.equal(auth.status, 200);
  const creds = await auth.json();
  return post(world, '/start', { ...fields, ...tamper, taskId: '2', ...creds });
}

const verifyWorld = (env = {}, opts = {}) =>
  buildWorld({ listen: true, env: { START_VERIFY_WORKFLOW: 'true', OTCS_BASE, ...env }, ...opts });

/* ---------- canonicalStart ---------- */

test('canonicalStart: string v2 estável, e-mails normalizados e campos ausentes vazios', () => {
  const c = canonicalStart({
    timestamp: 1750000000000, nonce: 'abc', workflowId: 3003, subworkflowId: ' 3004 ', nodeId: 1001, attachId: 2002,
    userEmail1: ' B@x.com; a@X.com', userEmail2: 'a@x.com,,', docName: ' Contrato.pdf '
  });
  assert.equal(c, ['v2', '1750000000000', 'abc', '3003', '3004', '1001', '2002', 'a@x.com,a@x.com,b@x.com', 'Contrato.pdf'].join('\n'));
  assert.equal(canonicalStart({}), ['v2', '', '', '', '', '', '', '', ''].join('\n'));
  // a ordem dos e-mails e a caixa não mudam a assinatura; o resto muda
  const base = { timestamp: '1', nonce: 'n', userEmail1: 'a@x.com', userEmail2: 'b@x.com', nodeId: '1' };
  assert.equal(signStart('s', base), signStart('s', { ...base, userEmail1: 'B@X.com', userEmail2: 'a@x.com' }));
  assert.notEqual(signStart('s', base), signStart('s', { ...base, nodeId: '2' }));
  assert.notEqual(signStart('s', base), signStart('s', { ...base, userEmail2: 'c@x.com' }));
});

/* ---------- HMAC v2 + nonce ---------- */

test('/start v2: payload adulterado depois do /auth => 403 e nada é criado', async () => {
  const world = await buildWorld({ listen: true });
  for (const tamper of [{ nodeId: '9999' }, { attachId: '1' }, { userEmail1: 'evil@x.com' }, { workflowId: '1' },
    { subworkflowId: '1' }, { docName: 'outro.pdf' }]) {
    const r = await authThenStart(world, FIELDS, { tamper });
    assert.equal(r.status, 403, JSON.stringify(tamper));
    assert.deepEqual(await r.json(), { error: 'Invalid signature.' });
  }
  assert.equal(world.adobe.created.length, 0);
  assert.equal(world.otcs.downloads.length, 0);
  await world.close();
});

test('/start v2: nonce de uso único (replay => 403), só consumido depois de validar a assinatura', async () => {
  const world = await buildWorld({ listen: true });
  const good = startBody(world);

  // assinatura inválida com o nonce: não o consome
  let r = await post(world, '/start', { ...good, signature: 'a'.repeat(64) });
  assert.equal(r.status, 403);
  assert.equal((await post(world, '/start', good)).status, 200);

  // o mesmo corpo outra vez: replay
  r = await post(world, '/start', good);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Solicitud ya utilizada.' });
  assert.equal(world.adobe.created.length, 1);
  await world.close();
});

test('/start v2: nonce expirado na janela de 2 min e vindo do /auth real', async () => {
  const world = await buildWorld({ listen: true });
  const auth = await post(world, '/auth', FIELDS, ADMIN);
  const creds = await auth.json();
  world.clock.advance(3 * 60 * 1000);
  const r = await post(world, '/start', { ...FIELDS, taskId: '2', ...creds });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Timestamp expired.' });
  await world.close();
});

test('/auth: POST exige Basic Auth, devolve v2 e GET não existe por padrão', async () => {
  const world = await buildWorld({ listen: true });
  assert.equal((await post(world, '/auth', FIELDS)).status, 401);
  assert.equal((await post(world, '/auth', FIELDS, { authorization: basicHeader('admin', 'errada') })).status, 401);
  const ok = await post(world, '/auth', FIELDS, ADMIN);
  assert.equal(ok.status, 200);
  const creds = await ok.json();
  assert.deepEqual(Object.keys(creds).sort(), ['nonce', 'signature', 'timestamp', 'v']);
  assert.equal(creds.signature, signStart(world.config.signatureSecret, { ...FIELDS, ...creds }));
  assert.notEqual((await (await post(world, '/auth', FIELDS, ADMIN)).json()).nonce, creds.nonce);

  const get = await fetch(`${world.baseUrl}/auth`, { headers: ADMIN });
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: 'Endpoint not found' });
  await world.close();
});

test('/auth: sem SIGNATURE_SECRET falha fechado', async () => {
  const world = await buildWorld({ listen: true, env: { SIGNATURE_SECRET: '' } });
  assert.equal((await post(world, '/auth', FIELDS, ADMIN)).status, 500);
  await world.close();
});

test('START_AUTH_USER/START_AUTH_PASS: credencial própria do /auth, separada do LOG_USER', async () => {
  const world = await buildWorld({ listen: true, env: { START_AUTH_USER: 'wr-user', START_AUTH_PASS: 'wr:pass' } });
  const own = { authorization: basicHeader('wr-user', 'wr:pass') };
  assert.equal((await post(world, '/auth', FIELDS, ADMIN)).status, 401, 'a credencial do admin não serve');
  assert.equal((await post(world, '/auth', FIELDS, own)).status, 200);
  // a credencial do WebReport não abre o admin
  assert.equal((await fetch(`${world.baseUrl}/admin/agreements`, { headers: own })).status, 401);
  assert.equal((await fetch(`${world.baseUrl}/admin/agreements`, { headers: ADMIN })).status, 200);
  await world.close();

  // sem START_AUTH_* (ou só uma das duas) vale LOG_USER/LOG_PASS
  assert.deepEqual(computeConfig({ LOG_USER: 'a', LOG_PASS: 'b' }).startAuth, { user: 'a', pass: 'b', own: false });
  assert.equal(computeConfig({ LOG_USER: 'a', LOG_PASS: 'b', START_AUTH_USER: 'x' }).startAuth.user, 'a');
});

/* ---------- legado (flags) ---------- */

test('assinatura v1 (só timestamp) é rejeitada por padrão e aceita com START_LEGACY_SIGNATURE (com validação do OTCS)', async () => {
  let world = await buildWorld({ listen: true });
  let r = await post(world, '/start', startBodyV1(world));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Unsupported signature version.' });
  assert.equal(world.adobe.created.length, 0);
  await world.close();

  world = await buildWorld({ listen: true, env: { START_LEGACY_SIGNATURE: 'true', START_VERIFY_WORKFLOW: 'false' } });
  // v1 não vincula o payload: a validação contra o OTCS é obrigatória, mesmo com START_VERIFY_WORKFLOW=false
  seedStartFlow(world);
  r = await post(world, '/start', startBodyV1(world, { nodeId: '777' }));
  assert.equal(r.status, 409, 'payload divergente do OTCS');
  r = await post(world, '/start', startBodyV1(world));
  assert.equal(r.status, 200);
  assert.ok(world.logger.has('warn', /Firma v1/));
  assert.ok(world.otcs.modelCalls.some(([m]) => m === 'getTaskForm'));

  // GET /auth v1 só com a flag
  const get = await fetch(`${world.baseUrl}/auth`, { headers: ADMIN });
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(await get.json()).sort(), ['signature', 'timestamp']);
  await world.close();
});

test('GET /start (contrato antigo) responde 404 por padrão e funciona com START_LEGACY_GET_ENABLED, sempre validando no OTCS', async () => {
  let world = await buildWorld({ listen: true });
  const query = new URLSearchParams({ ...FIELDS, taskId: '2' }).toString();
  let r = await fetch(`${world.baseUrl}/start?${query}`);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'Endpoint not found' });
  await world.close();

  world = await buildWorld({ listen: true, env: { START_LEGACY_GET_ENABLED: 'true', START_VERIFY_WORKFLOW: 'false' } });
  // sem workflow no OTCS: a validação é obrigatória e falha
  r = await fetch(`${world.baseUrl}/start?${query}`);
  assert.equal(r.status, 409);
  assert.equal(world.adobe.created.length, 0);

  seedStartFlow(world);
  // contrato antigo do 702040: workflowId = subworkflowId = WFID (do pai); o OTCS resolve o subprocesso real
  const legacy = new URLSearchParams({ ...FIELDS, subworkflowId: '3003', taskId: '2' }).toString();
  r = await fetch(`${world.baseUrl}/start?${legacy}`);
  assert.equal(r.status, 200);
  assert.match((await r.json()).message, /^Signature requested\. ID: AG-1$/);
  assert.equal(world.repo.get('AG-1').subworkflowId, '3004', 'subprocesso resolvido pelo OTCS');
  assert.ok(world.logger.has('warn', /GET \/start \(contrato antiguo/));
  await world.close();
});

/* ---------- CORS ---------- */

test('CORS: só /auth e /start, só a origem do OTCS_BASE (padrão); origem estranha, webhook, admin e health sem cabeçalho', async () => {
  const world = await buildWorld({ listen: true, env: { OTCS_BASE } });
  assert.deepEqual(world.config.corsOrigins, [OTCS_ORIGIN]);
  const acao = (r) => r.headers.get('access-control-allow-origin');
  const preflight = (p, origin) => fetch(`${world.baseUrl}${p}`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }
  });

  for (const p of ['/auth', '/start']) {
    let r = await preflight(p, OTCS_ORIGIN);
    assert.equal(r.status, 204);
    assert.equal(acao(r), OTCS_ORIGIN);
    assert.match(r.headers.get('access-control-allow-headers'), /authorization/i);
    r = await preflight(p, 'https://evil.example.test');
    assert.equal(acao(r), null);
  }

  // resposta real
  let r = await post(world, '/auth', FIELDS, { ...ADMIN, origin: OTCS_ORIGIN });
  assert.equal(r.status, 200);
  assert.equal(acao(r), OTCS_ORIGIN);
  r = await post(world, '/auth', FIELDS, { ...ADMIN, origin: 'https://evil.example.test' });
  assert.equal(acao(r), null);

  // fora de /auth e /start: nenhum cabeçalho CORS
  r = await fetch(`${world.baseUrl}/webhook`, { method: 'HEAD', headers: { origin: OTCS_ORIGIN } });
  assert.equal(r.status, 200);
  assert.equal(acao(r), null);
  r = await fetch(`${world.baseUrl}/health`, { headers: { origin: OTCS_ORIGIN } });
  assert.equal(acao(r), null);
  r = await fetch(`${world.baseUrl}/admin/agreements`, { headers: { ...ADMIN, origin: OTCS_ORIGIN } });
  assert.equal(acao(r), null);
  r = await preflight('/admin/agreements', OTCS_ORIGIN);
  assert.equal(acao(r), null);
  await world.close();
});

test('CORS_ORIGINS: lista explícita, barra final ignorada, "*" só se configurado e sem OTCS_BASE nada é permitido', async () => {
  assert.deepEqual(computeConfig({ OTCS_BASE }).corsOrigins, [OTCS_ORIGIN]);
  assert.deepEqual(computeConfig({}).corsOrigins, []);
  assert.deepEqual(computeConfig({ OTCS_BASE, CORS_ORIGINS: 'https://a.test/, https://b.test' }).corsOrigins,
    ['https://a.test', 'https://b.test']);
  assert.deepEqual(computeConfig({ CORS_ORIGINS: '*' }).corsOrigins, ['*']);

  const check = async (env, origin) => {
    const world = await buildWorld({ listen: true, env });
    const r = await fetch(`${world.baseUrl}/start`, {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' }
    });
    const header = r.headers.get('access-control-allow-origin');
    await world.close();
    return header;
  };
  assert.equal(await check({ CORS_ORIGINS: 'https://a.test, https://b.test' }, 'https://b.test'), 'https://b.test');
  assert.equal(await check({ CORS_ORIGINS: 'https://a.test' }, OTCS_ORIGIN), null);
  assert.equal(await check({ CORS_ORIGINS: '*' }, 'https://qualquer.test'), '*');
  assert.equal(await check({}, OTCS_ORIGIN), null, 'sem OTCS_BASE e sem CORS_ORIGINS: ninguém');
});

/* ---------- validação contra o workflow do OTCS ---------- */

test('config: START_VERIFY_WORKFLOW liga por padrão e os rótulos dos atributos são configuráveis', () => {
  const c = computeConfig({});
  assert.equal(c.startVerifyWorkflow, true);
  assert.deepEqual(c.startFields, {
    docId: 'DocID', attachId: 'AttachID', docName: 'Nombre del Documento',
    emails: ['Email Firmante 1', 'Email Firmante 2']
  });
  assert.equal(c.startLegacySignature, false);
  assert.equal(c.startLegacyGet, false);
  const o = computeConfig({
    START_VERIFY_WORKFLOW: 'false', START_FIELD_DOCID: 'Doc', START_FIELD_ATTACHID: 'Adj',
    START_FIELD_DOCNAME: 'Nome', START_FIELD_EMAILS: 'Mail A, Mail B, Mail C',
    START_LEGACY_SIGNATURE: 'true', START_LEGACY_GET_ENABLED: '1'
  });
  assert.equal(o.startVerifyWorkflow, false);
  assert.deepEqual(o.startFields, { docId: 'Doc', attachId: 'Adj', docName: 'Nome', emails: ['Mail A', 'Mail B', 'Mail C'] });
  assert.equal(o.startLegacySignature, true);
  assert.equal(o.startLegacyGet, true);
});

test('/start verificado: os valores do OTCS prevalecem e o subprocesso/tarefa resolvidos são gravados', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { fields: { 'Email Firmante 1': 'Uno@Example.com; dos@example.com', 'Email Firmante 2': ' tres@example.com ,' } });

  // payload com subworkflowId = pai (o WebReport antigo manda WFID nos dois campos), sem nodeId/attachId/emails/docName
  // e taskId absurdo. Uma dica de subprocesso real sem a tarefa já não é tolerada (ver o teste seguinte).
  const fields = { workflowId: '3003', subworkflowId: '3003' };
  const auth = await (await post(world, '/auth', fields, ADMIN)).json();
  const r = await post(world, '/start', { ...fields, taskId: '77', ...auth });
  assert.equal(r.status, 200, await r.clone().text());

  const rec = world.repo.get('AG-1');
  assert.equal(rec.nodeId, '1001');
  assert.equal(rec.attachId, '2002');
  assert.equal(rec.fileName, 'contrato.pdf');
  assert.equal(rec.workflowId, '3003');
  assert.equal(rec.subworkflowId, '3004', 'subprocesso do OTCS, não o do payload');
  assert.equal(rec.taskId, 2, 'tarefa do OTCS, não a do payload');
  assert.deepEqual(rec.emails, ['Uno@Example.com', 'dos@example.com', 'tres@example.com']);
  assert.deepEqual(world.adobe.created[0].emails, rec.emails);
  assert.equal(world.adobe.created[0].externalId, 'otcs|wf=3003|sub=3004|node=1001|attach=2002');
  assert.deepEqual(world.otcs.downloads, ['1001']);
  assert.ok(world.otcs.modelCalls.some((c) => c[0] === 'getTaskForm' && c[1] === 3003 && c[2] === 3004 && c[3] === 2));

  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start verificado: subworkflowId de um subprocesso real que não tem a tarefa de início => 409; tarefa em vários subprocessos sem dica usa o mais recente', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  const wrong = { workflowId: '3003', subworkflowId: '999' };
  const r = await authThenStart(world, wrong);
  assert.equal(r.status, 409, 'a tarefa existe só no subprocesso 3004, que não é o do payload');
  assert.equal(world.adobe.created.length, 0);

  // o mesmo pai com outro subprocesso na tarefa de início e a dica = pai: latest => o de maior subprocessId
  world.otcs.addSubprocess('3003', 3005, { stage: 'start' });
  const both = await authThenStart(world, { workflowId: '3003', subworkflowId: '3003' });
  assert.equal(both.status, 200, await both.clone().text());
  assert.equal(world.repo.get('AG-1').subworkflowId, '3005');
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start verificado: payload coerente (e-mails em outra ordem/caixa) é aceito e o nome do arquivo vem do OTCS', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { fields: { 'Nombre del Documento': 'Contrato OTCS.pdf' } });
  const r = await authThenStart(world, {
    ...FIELDS, userEmail1: 'TWO@example.com', userEmail2: 'one@example.com', docName: 'o-navegador-diz-outro.pdf'
  });
  assert.equal(r.status, 200);
  assert.equal(world.repo.get('AG-1').fileName, 'Contrato OTCS.pdf');
  assert.deepEqual(world.repo.get('AG-1').emails, ['one@example.com', 'two@example.com'], 'e-mails do OTCS');
  await world.close();
});

test('/start v2: espaços no subprocesso preservam o HMAC e a tarefa originalmente indicada', async (t) => {
  const world = await verifyWorld();
  t.after(() => world.close());
  seedStartFlow(world);
  world.otcs.workflows['3003'].tasks.push({
    subprocessId: 4004, taskId: 2, name: 'Enviar solicitud de firma', status: 'current'
  });
  const getForm = world.otcs.getTaskForm;
  world.otcs.getTaskForm = async (processId, subprocessId, taskId) => {
    const form = await getForm(processId, subprocessId, taskId);
    return Number(subprocessId) === 4004
      ? { ...form, fields: { ...form.fields, DocID: { key: 'other_doc', value: '9999' } } }
      : form;
  };

  // Sem os campos opcionais: o servidor resolve o documento pelo workflow; mudar só os espaços não muda o HMAC.
  const fields = { workflowId: '3003', subworkflowId: '3004' };
  const r = await authThenStart(world, fields, { tamper: { subworkflowId: ' 3004 ' } });
  assert.equal(r.status, 200);
  const rec = world.repo.get((await r.json()).id);
  assert.equal(rec.subworkflowId, '3004');
  assert.equal(rec.nodeId, '1001');
  assert.deepEqual(world.otcs.downloads, ['1001']);
  await waitFor(() => world.repo.get(rec.id).startSendonDone);
});

test('/start verificado: dados divergentes do OTCS => 409 genérico (detalhe só no log)', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  const msg = { error: 'Los datos enviados no coinciden con el flujo.' };
  for (const over of [
    { nodeId: '9999' }, { attachId: '1' }, { userEmail1: 'evil@x.com' }, { userEmail2: '' , userEmail1: 'one@example.com' }
  ]) {
    const r = await authThenStart(world, { ...FIELDS, ...over });
    assert.equal(r.status, 409, JSON.stringify(over));
    assert.deepEqual(await r.json(), msg);
  }
  assert.ok(world.logger.has('warn', /nodeId payload=9999 otcs=1001/));
  assert.ok(world.logger.has('warn', /emails payload=\[evil@x\.com,two@example\.com\]/));
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('/start verificado: tarefa que não está "current" => 409; workflow inexistente => 409; sem workflowId => 400', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { stage: 'sign' }); // a tarefa de início já foi concluída
  let r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'El flujo no está en el paso de envío a firma.' });

  r = await authThenStart(world, { ...FIELDS, workflowId: '8888', subworkflowId: '8888' });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Flujo no encontrado.' });

  r = await authThenStart(world, { ...FIELDS, workflowId: '' });
  assert.equal(r.status, 400);
  r = await authThenStart(world, { ...FIELDS, workflowId: 'abc' });
  assert.equal(r.status, 400);
  assert.equal(world.adobe.created.length, 0);
  assert.equal(world.otcs.downloads.length, 0);
  await world.close();
});

test('/start verificado: erros do OTCS — 5xx/rede/timeout => 503; 401/403 no formulário => 409; 404 => 409', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  const unavailable = { error: 'Content Server no disponible; intente nuevamente.' };

  world.otcs.stepsFailures = 1; // 500 em getProcessSteps
  let r = await authThenStart(world);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), unavailable);

  world.otcs.stepsFailStatus = 502;
  world.otcs.stepsFailures = 1;
  r = await authThenStart(world);
  assert.equal(r.status, 503);
  world.otcs.stepsFailStatus = 500;

  // erro de rede/timeout (sem resposta HTTP)
  const steps = world.otcs.getProcessSteps;
  world.otcs.getProcessSteps = async () => { throw Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }); };
  r = await authThenStart(world);
  assert.equal(r.status, 503);
  world.otcs.getProcessSteps = steps;

  // formulário
  world.otcs.formFailure = httpError(500, 'boom');
  r = await authThenStart(world);
  assert.equal(r.status, 503);
  for (const status of [401, 403]) {
    world.otcs.formFailure = httpError(status, 'forbidden');
    r = await authThenStart(world);
    assert.equal(r.status, 409, String(status));
    assert.deepEqual(await r.json(), { error: 'La tarea no está asignada al usuario de integración.' });
  }
  world.otcs.formFailure = httpError(404, 'gone');
  r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Flujo no encontrado.' });

  assert.equal(world.adobe.created.length, 0);
  // o detalhe do OTCS só aparece no log
  assert.ok(world.logger.has('error', /getProcessSteps\(3003\) falló/));
  await world.close();
});

test('/start verificado: formulário sem DocID, sem e-mails ou sem AttachID => 422', async () => {
  const world = await verifyWorld();
  for (const [fields, re] of [
    [{ DocID: null }, /DocID/],
    [{ DocID: 'abc' }, /DocID/],
    [{ 'Email Firmante 1': '', 'Email Firmante 2': '?' }, /correos/],
    [{ 'Email Firmante 1': null, 'Email Firmante 2': null }, /correos/],
    [{ AttachID: null }, /AttachID/]
  ]) {
    world.otcs.workflows = {};
    seedStartFlow(world, { fields });
    const r = await authThenStart(world);
    assert.equal(r.status, 422, JSON.stringify(fields));
    assert.match((await r.json()).error, re);
  }
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('/start verificado: rótulos dos atributos configuráveis (START_FIELD_*)', async () => {
  const world = await verifyWorld({
    START_FIELD_DOCID: 'Documento', START_FIELD_ATTACHID: 'Carpeta', START_FIELD_DOCNAME: 'Nombre', START_FIELD_EMAILS: 'Correo'
  });
  seedStartFlow(world, {
    fields: { DocID: null, AttachID: null, 'Nombre del Documento': null, 'Email Firmante 1': null, 'Email Firmante 2': null,
      Documento: '1001', Carpeta: '2002', Nombre: 'x.pdf', Correo: 'solo@example.com' }
  });
  const r = await authThenStart(world, { ...FIELDS, userEmail1: 'solo@example.com', userEmail2: '' });
  assert.equal(r.status, 200);
  assert.deepEqual(world.repo.get('AG-1').emails, ['solo@example.com']);
  assert.equal(world.repo.get('AG-1').fileName, 'x.pdf');
  await world.close();
});

/* ---------- idempotência ---------- */

test('/start verificado: segundo envio igual devolve o mesmo acordo (200, existing) sem tocar o Adobe', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  let r = await authThenStart(world);
  assert.equal(r.status, 200);
  // handoff: o que a página reatribui (tarefa já no usuário de integração => assigned: true)
  const handoff = { workflowId: 3003, subworkflowId: 3004, taskId: 2, integrationUserId: INTEGRATION_USER_ID, assigned: true };
  assert.deepEqual(await r.json(), { message: 'Signature requested. ID: AG-1', id: 'AG-1', handoff });
  assert.equal(world.adobe.created.length, 1);

  // enquanto a tarefa de início ainda está "current" (SendOn em background) ou já avançou: o mesmo resultado
  for (const advance of [false, true]) {
    if (advance) await waitFor(() => world.repo.get('AG-1').startSendonDone);
    const downloads = world.otcs.downloads.length;
    r = await authThenStart(world);
    assert.equal(r.status, 200, `advance=${advance}`);
    // com a tarefa de início já avançada o handoff some (nada a reatribuir); antes, volta com os mesmos ids
    // (o SendOn em background pode ter terminado antes da segunda chamada: as duas respostas são válidas)
    const body = await r.json();
    if (advance) assert.equal('handoff' in body, false);
    else if ('handoff' in body) assert.deepEqual(body.handoff, handoff);
    delete body.handoff;
    assert.deepEqual(body, { message: 'Signature already requested. ID: AG-1', id: 'AG-1', existing: true });
    assert.equal(world.adobe.created.length, 1);
    assert.equal(world.otcs.downloads.length, downloads, 'não baixou o PDF de novo');
  }
  assert.equal(world.repo.list().length, 1);
  await world.close();
});

test('/start: restart preserva o nonce consumido e a idempotência por workflow', async () => {
  const dbFile = path.join(tmpDir(), 'restart-start.db');
  const w1 = await verifyWorld({}, { dbFile });
  seedStartFlow(w1);
  const creds = await (await post(w1, '/auth', FIELDS, ADMIN)).json();
  assert.equal((await post(w1, '/start', { ...FIELDS, ...creds })).status, 200);
  await waitFor(() => w1.repo.get('AG-1').startSendonDone);
  await w1.close();

  const w2 = await verifyWorld({}, { dbFile, adobe: w1.adobe, otcs: w1.otcs, clock: w1.clock });
  try {
    const replay = await post(w2, '/start', { ...FIELDS, ...creds });
    assert.equal(replay.status, 403);
    assert.deepEqual(await replay.json(), { error: 'Solicitud ya utilizada.' });
    const fresh = await authThenStart(w2);
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).existing, true);
    assert.equal(w2.adobe.created.length, 1);
  } finally {
    await w2.close();
  }
});

test('/start verificado: alteração de e-mails no formulário durante envio não cria dois acordos do mesmo workflow', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let authCalls = 0;
  world.adobe.checkAuth = async () => {
    if (++authCalls === 1) { started(); await gate; }
  };
  const first = world.signatureService.start({ workflowId: '3003', subworkflowId: '3004' });
  try {
    await entered;
    world.otcs.formFields['Email Firmante 1'].value = 'changed@example.com';
    await assert.rejects(
      () => world.signatureService.start({ workflowId: '3003', subworkflowId: '3004' }),
      (e) => e.status === 409
    );
  } finally {
    release();
    const created = await first;
    await created.sendOn;
    await world.close();
  }
  assert.equal(world.adobe.created.length, 1);
});

test('/start verificado: idempotência é por workflow + subprocesso + documento; outro documento do mesmo workflow cria outro acordo', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  assert.equal((await authThenStart(world)).status, 200);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);

  // acordo final (resultado definitivo): deixa de ser "aberto", mas o fluxo continua vendo o dele (findLatestByWorkflow)
  world.repo.upsert('AG-1', { finalKind: 'final_ok', state: 'signed' });
  assert.equal(world.repo.findOpenByWorkflow('3003', '3004', '1001'), null);
  assert.equal(world.repo.findLatestByWorkflow('3003', '3004', '1001').id, 'AG-1');
  assert.equal(world.repo.findOpenByWorkflow('3003', '3004', '5555'), null);
  assert.equal(world.repo.findLatestByWorkflow('3003', '3004', '5555'), null);

  // outro documento no mesmo workflow cria outro acordo (a tarefa de início volta a "current" no modelo)
  world.otcs.workflows = {};
  seedStartFlow(world, { fields: { DocID: '5555' } });
  world.clock.advance(16 * 60 * 1000);
  const r = await authThenStart(world, { ...FIELDS, nodeId: '5555' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    message: 'Signature requested. ID: AG-2',
    id: 'AG-2',
    handoff: { workflowId: 3003, subworkflowId: 3004, taskId: 2, integrationUserId: INTEGRATION_USER_ID, assigned: true }
  });
  assert.equal(world.adobe.created.length, 2);
  await world.close();
});

/* ---------- handoff: REASSIGN da página só depois do /start ---------- */

// Fluxo puro (processo == subprocesso): o /start não exige a tarefa no usuário de integração
const STANDALONE = { ...FIELDS, subworkflowId: '3003' };
const handoffOf = (over = {}) => ({
  workflowId: 3003, subworkflowId: 3003, taskId: 2, integrationUserId: INTEGRATION_USER_ID, assigned: false, ...over
});
const modelCalled = (world, name) => world.otcs.modelCalls.filter(([m]) => m === name).length;

test('/start com a tarefa no usuário humano (fluxo puro): cria o acordo, devolve handoff e só envia depois do REASSIGN', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { subprocessId: '3003', assignee: HUMAN_USER_ID });

  let r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { message: 'Signature requested. ID: AG-1', id: 'AG-1', handoff: handoffOf() });
  // atributos lidos de status/info (a tarefa não está com o usuário de integração: sem formulário)
  assert.equal(modelCalled(world, 'getWorkflowAttributes'), 1);
  assert.equal(modelCalled(world, 'getTaskForm'), 0);
  const rec = world.repo.get('AG-1');
  assert.deepEqual([rec.nodeId, rec.attachId, rec.fileName, rec.workflowId, rec.subworkflowId, rec.taskId],
    ['1001', '2002', 'contrato.pdf', '3003', '3003', 2]);
  assert.deepEqual(rec.emails, ['one@example.com', 'two@example.com']);

  // a reconciliação em background espera a reatribuição: nenhum SendOn, sem erro, sem needs_attention
  await waitFor(() => world.repo.get('AG-1').attempts === 1);
  assert.equal(world.otcs.sendons.length, 0);
  assert.equal(world.repo.get('AG-1').state, 'pending');
  assert.deepEqual(world.logger.lines.error, []);

  // repetir o /start ainda sem REASSIGN: existing + handoff.assigned=false, continua sem SendOn
  r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    message: 'Signature already requested. ID: AG-1', id: 'AG-1', existing: true, handoff: handoffOf()
  });
  assert.equal(world.adobe.created.length, 1);
  assert.equal(world.otcs.sendons.length, 0);

  // a página reatribui; o segundo /start (existing) dispara o SendOn já, sem esperar o backoff
  world.otcs.assign(3003, 2, INTEGRATION_USER_ID);
  r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.existing, true);
  assert.deepEqual(body.handoff, handoffOf({ assigned: true }));
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  assert.equal(world.otcs.sendons.length, 1);
  assert.equal(world.otcs.task(3003, 3).status, 'current', 'tarefa de firma ativa');
  assert.equal(world.adobe.created.length, 1, 'um único acordo');

  // depois do avanço da tarefa: existing sem handoff
  r = await authThenStart(world, STANDALONE);
  const after = await r.json();
  assert.equal(after.existing, true);
  assert.equal('handoff' in after, false);
  assert.equal(world.otcs.sendons.length, 1);
  await world.close();
});

test('/start com a tarefa no usuário de integração (fluxo puro): formulário como antes e handoff.assigned=true', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { subprocessId: '3003' });
  const r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    message: 'Signature requested. ID: AG-1', id: 'AG-1', handoff: handoffOf({ assigned: true })
  });
  assert.equal(modelCalled(world, 'getTaskForm'), 1);
  assert.equal(modelCalled(world, 'getWorkflowAttributes'), 0);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  assert.equal(world.otcs.sendons.length, 1, 'SendOn imediato');
  await world.close();
});

test('/start com responsáveis desconhecidos (assigneeIds null): caminho do formulário, sem consultar o usuário de integração', async () => {
  for (const subprocessId of ['3003', '3004']) { // fluxo puro e sub-workflow
    const world = await verifyWorld();
    seedStartFlow(world, { subprocessId });
    world.otcs.unknownAssignees('3003');
    world.otcs.currentUserFailure = httpError(500, 'não deve ser chamado');
    const r = await authThenStart(world, { ...FIELDS, subworkflowId: subprocessId });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual((await r.json()).handoff, handoffOf({ subworkflowId: Number(subprocessId), integrationUserId: null, assigned: true }));
    assert.equal(modelCalled(world, 'getCurrentUser'), 0);
    assert.equal(modelCalled(world, 'getTaskForm'), 1);
    assert.equal(modelCalled(world, 'getWorkflowAttributes'), 0);
    await waitFor(() => world.repo.get('AG-1').startSendonDone);
    assert.equal(world.otcs.sendons.length, 1, 'SendOn imediato');
    assert.deepEqual(world.logger.lines.error, []);
    await world.close();
  }
});

test('/start em sub-workflow: tarefa no usuário humano => 409 REASSIGN_REQUIRED com handoff, sem Adobe nem leitura de atributos', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID }); // processo 3003, subprocesso 3004
  const r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), {
    error: 'La tarea debe asignarse al usuario de integración antes del envío.',
    code: 'REASSIGN_REQUIRED',
    handoff: handoffOf({ subworkflowId: 3004 })
  });
  assert.equal(world.adobe.created.length, 0);
  // a pré-checagem (dicas do corpo) baixa o nó, mas não toca o Adobe
  assert.deepEqual(world.adobe.calls, [['otcs.download', '1001']], 'só o download da pré-checagem, nada no Adobe');
  assert.equal(modelCalled(world, 'getWorkflowAttributes'), 0, 'status/info só traz os atributos do pai');
  assert.equal(modelCalled(world, 'getTaskForm'), 0);

  // depois do REASSIGN feito pela página, o /start segue o caminho do formulário
  world.otcs.assign(3003, 2, INTEGRATION_USER_ID);
  const ok = await authThenStart(world);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).handoff, handoffOf({ subworkflowId: 3004, assigned: true }));
  assert.equal(modelCalled(world, 'getTaskForm'), 1);
  assert.equal(modelCalled(world, 'getWorkflowAttributes'), 0);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start pelo caminho dos atributos: DocID/e-mails/AttachID ausentes => os mesmos 422', async () => {
  const world = await verifyWorld();
  for (const [fields, re] of [
    [{ DocID: null }, /DocID/],
    [{ DocID: 'abc' }, /DocID/],
    [{ 'Email Firmante 1': '', 'Email Firmante 2': '?' }, /correos/],
    [{ 'Email Firmante 1': null, 'Email Firmante 2': null }, /correos/],
    [{ AttachID: null }, /AttachID/]
  ]) {
    world.otcs.workflows = {};
    seedStartFlow(world, { subprocessId: '3003', assignee: HUMAN_USER_ID, fields });
    const r = await authThenStart(world, STANDALONE);
    assert.equal(r.status, 422, JSON.stringify(fields));
    assert.match((await r.json()).error, re);
  }
  assert.equal(modelCalled(world, 'getTaskForm'), 0);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('/start pelo caminho dos atributos: dados divergentes => 409 genérico; atributos do OTCS prevalecem', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, {
    subprocessId: '3003',
    assignee: HUMAN_USER_ID,
    fields: { 'Email Firmante 1': 'Uno@Example.com; dos@example.com', 'Email Firmante 2': null }
  });
  const msg = { error: 'Los datos enviados no coinciden con el flujo.' };
  for (const over of [{ nodeId: '9999' }, { attachId: '1' }, { userEmail1: 'evil@x.com', userEmail2: '' }]) {
    const r = await authThenStart(world, { ...STANDALONE, ...over });
    assert.equal(r.status, 409, JSON.stringify(over));
    assert.deepEqual(await r.json(), msg);
  }
  assert.ok(world.logger.has('warn', /nodeId payload=9999 otcs=1001/));
  assert.equal(world.adobe.created.length, 0);

  // payload só com o essencial: valem os e-mails do OTCS
  const r = await authThenStart(world, { workflowId: '3003', subworkflowId: '3003' });
  assert.equal(r.status, 200);
  assert.deepEqual(world.repo.get('AG-1').emails, ['Uno@Example.com', 'dos@example.com']);
  await world.close();
});

test('/start pelo caminho dos atributos: erros do OTCS (404 => 409, 5xx => 503); usuário de integração indisponível => 503', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { subprocessId: '3003', assignee: HUMAN_USER_ID });

  world.otcs.attributesFailure = httpError(404, 'gone');
  let r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Flujo no encontrado.' });

  world.otcs.attributesFailure = httpError(500, 'boom');
  r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Content Server no disponible; intente nuevamente.' });
  assert.ok(world.logger.has('error', /getWorkflowAttributes\(3003\) falló/));
  world.otcs.attributesFailure = null;

  world.otcs.currentUserFailure = httpError(500, 'auth down');
  r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 503);
  assert.ok(world.logger.has('error', /getCurrentUser falló/));
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

/* ---------- validação do PDF antes do Adobe (NOT_PDF) ---------- */

const HTML_DOC = Buffer.from('<!DOCTYPE html>\n<html><body>CONTEUDO-SECRETO</body></html>');
const DOCX_DOC = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), Buffer.from('word/document.xml CONTEUDO-SECRETO')]);
const NOT_PDF_BODY = { error: 'El documento a firmar no es un PDF válido.', code: 'NOT_PDF' };
const adobeCalls = (world) => world.adobe.calls.filter(([name]) => name.startsWith('adobe.'));
const allLogs = (world) => [...world.logger.lines.info, ...world.logger.lines.warn, ...world.logger.lines.error];

test('/start verificado: nó HTML no lugar do PDF => 422 NOT_PDF, nada no Adobe, sem vazar o conteúdo; com o PDF o reenvio funciona', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  world.otcs.nodeContents['1001'] = HTML_DOC;

  let r = await authThenStart(world);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), NOT_PDF_BODY);
  assert.deepEqual(adobeCalls(world), [], 'nem documento transitório nem acordo');
  assert.equal(world.adobe.created.length, 0);
  assert.equal(world.repo.list().length, 0);
  assert.deepEqual(world.otcs.downloads, ['1001']);
  assert.equal(world.otcs.sendons.length, 0, 'a tarefa de início fica como estava');
  assert.ok(world.logger.has('warn', new RegExp(`nodo 1001 no es un PDF válido \\(${HTML_DOC.length} bytes; tipo detectado: HTML\\)`)));
  assert.ok(allLogs(world).every((line) => !/CONTEUDO-SECRETO/.test(line)), 'o conteúdo não vai para o log');

  // o usuário sobe uma versão PDF no mesmo nó e tenta de novo: a chave em andamento foi liberada
  delete world.otcs.nodeContents['1001'];
  r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(world.adobe.created.length, 1);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start verificado: DOCX/zip, texto, vazio ou binário desconhecido => 422 NOT_PDF com o tipo no log', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  for (const [content, label] of [
    [DOCX_DOC, 'ZIP\\/Office'],
    [Buffer.from('apenas um texto qualquer'), 'texto'],
    [Buffer.alloc(0), 'vacío'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), 'desconocido']
  ]) {
    world.otcs.nodeContents['1001'] = content;
    const r = await authThenStart(world);
    assert.equal(r.status, 422, label);
    assert.deepEqual(await r.json(), NOT_PDF_BODY);
    assert.ok(world.logger.has('warn', new RegExp(`\\(${content.length} bytes; tipo detectado: ${label}`)), label);
  }
  assert.equal(world.adobe.created.length, 0);
  assert.deepEqual(adobeCalls(world), []);
  await world.close();
});

test('/start verificado: PDF com bytes antes do %PDF- é aceito se o cabeçalho está nos primeiros 1024 bytes', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  // cabeçalho depois do byte 1024: não é PDF
  world.otcs.nodeContents['1001'] = Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1.7\n')]);
  let r = await authThenStart(world);
  assert.equal(r.status, 422);
  assert.equal(world.adobe.created.length, 0);

  // lixo (BOM, espaços) antes do cabeçalho, dentro da janela
  world.otcs.nodeContents['1001'] = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.alloc(900, 0x20), Buffer.from('%PDF-1.7\n%resto')]);
  r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(world.adobe.created.length, 1);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start sem validação do workflow (legado): o nó HTML também é barrado antes do Adobe', async () => {
  const world = await buildWorld({ listen: true });
  world.otcs.nodeContents['1001'] = HTML_DOC;
  const r = await post(world, '/start', startBody(world));
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), NOT_PDF_BODY);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

/* ---------- o mesmo fluxo sempre vê o acordo dele, mesmo final ---------- */

test('incidente: o acordo do próprio fluxo virou final (conversão) antes da confirmação => 200 existing + final, não o 409 de duplicidade', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { subprocessId: '3003', assignee: HUMAN_USER_ID }); // mapa Firma puro: WORKID == SUBWORKID

  // 1) o /start cria o acordo A; a tarefa ainda está no usuário: nenhum SendOn
  let r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).id, 'AG-1');
  await waitFor(() => world.repo.get('AG-1').attempts === 1);

  // 2) o Adobe cancela A por problema de conversão; o pipeline espera a reatribuição
  world.adobe.agreements['AG-1'].status = 'CANCELLED';
  const ev = world.reconciliation.handleEvent(
    parseWebhookPayload(webhookPayload('AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM', 'AG-1'))
  );
  await ev.processing;
  assert.equal(world.repo.get('AG-1').finalKind, 'final_conversion_failed');
  assert.equal(world.otcs.sendons.length, 0);

  // 3) a página reatribui a tarefa de envio e chama o /start de confirmação (a de firma é do usuário de integração no mapa real)
  world.otcs.assign(3003, 2, INTEGRATION_USER_ID);
  world.otcs.assign(3003, 3, INTEGRATION_USER_ID);
  r = await authThenStart(world, STANDALONE);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  const message = 'Adobe Sign no pudo procesar el documento (verifique que sea un PDF válido). '
    + 'El flujo continuará automáticamente según el resultado.';
  assert.deepEqual(body, {
    message,
    id: 'AG-1',
    existing: true,
    final: { kind: 'final_conversion_failed', state: 'cancelled', message },
    handoff: handoffOf({ assigned: true })
  });

  // 4) o kick do /start retoma a reconciliação: SendOn pendente da tarefa de início e depois a disposição
  await waitFor(() => world.repo.get('AG-1').sendonDone);
  assert.deepEqual(world.otcs.sendons.map((s) => s.disposition || 'sendon'), ['sendon', 'Rechazado']);
  assert.equal(world.repo.get('AG-1').startSendonDone, true);
  assert.equal(world.adobe.created.length, 1, 'nenhum acordo novo');
  assert.deepEqual(world.otcs.downloads, ['1001'], 'não baixou o PDF de novo');
  assert.deepEqual(world.logger.lines.error, []);
  await world.close();
});

test('/start verificado: acordo final do próprio fluxo com a tarefa de início ainda ativa => existing + final e retoma a reconciliação (kick)', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  world.repo.upsert('AG-1', {
    nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf', workflowId: '3003', subworkflowId: '3004', taskId: 2,
    emails: ['one@example.com', 'two@example.com'], state: 'rejected', finalKind: 'final_rejected', startSendonDone: false
  });
  world.adobe.agreements['AG-1'] = { id: 'AG-1', status: 'CANCELLED' };
  world.adobe.events['AG-1'] = [{ type: 'REJECTED' }];

  const r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.existing, true);
  assert.deepEqual(body.final, {
    kind: 'final_rejected',
    state: 'rejected',
    message: 'El firmante rechazó la solicitud de firma en Adobe Sign. El flujo continuará automáticamente según el resultado.'
  });
  assert.equal(body.handoff.assigned, true);

  // o kick seguiu para o reconcile: início (SendOn) e depois a disposição Rechazado
  await waitFor(() => world.repo.get('AG-1').sendonDone);
  assert.deepEqual(world.otcs.sendons.map((s) => s.disposition || 'sendon'), ['sendon', 'Rechazado']);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('/start verificado: tarefa de início já não é current e o fluxo tem acordo final => existing + final (não o 409 "paso de envío")', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { stage: 'sign' }); // a tarefa de início já foi concluída
  const base = {
    nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf', workflowId: '3003', subworkflowId: '3004', taskId: 2,
    emails: ['one@example.com', 'two@example.com'], startSendonDone: true
  };

  // sem acordo: continua o 409 de sempre
  let r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'El flujo no está en el paso de envío a firma.' });

  // acordo final com a disposição ainda pendente
  world.repo.upsert('AG-1', { ...base, state: 'expired', finalKind: 'final_expired' });
  r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  let body = await r.json();
  assert.equal(body.existing, true);
  assert.equal(body.id, 'AG-1');
  assert.equal('handoff' in body, false, 'a tarefa de início já avançou: nada a reatribuir');
  assert.deepEqual(body.final, {
    kind: 'final_expired',
    state: 'expired',
    message: 'La solicitud de firma expiró en Adobe Sign. El flujo continuará automáticamente según el resultado.'
  });
  assert.equal(body.message, body.final.message);

  // acordo concluído (disposição enviada)
  world.repo.upsert('AG-1', { sendonDone: true, state: 'expired' });
  body = await (await authThenStart(world)).json();
  assert.equal(body.final.message, 'La solicitud de firma expiró en Adobe Sign. El flujo ya continuó según el resultado.');

  // acordo ainda aberto: existing sem final, como antes
  world.repo.upsert('AG-1', { sendonDone: false, finalKind: null, state: 'pending' });
  body = await (await authThenStart(world)).json();
  assert.deepEqual(body, { message: 'Signature already requested. ID: AG-1', id: 'AG-1', existing: true });

  // sem a dica do documento não há como achar o acordo
  r = await authThenStart(world, { workflowId: '3003', subworkflowId: '3004' });
  assert.equal(r.status, 409);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

/* ---------- trava de 15 min: só acordo ABERTO de OUTRO fluxo ---------- */

const OTHER_FLOW = {
  nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf', workflowId: '9999', subworkflowId: '9998', taskId: 2,
  emails: ['one@example.com', 'two@example.com'], startSendonDone: true
};

test('/start verificado: acordo FINAL ou concluído do mesmo documento e destinatários em OUTRO fluxo não bloqueia', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  world.repo.upsert('AG-FINAL', { ...OTHER_FLOW, state: 'rejected', finalKind: 'final_rejected' });
  world.repo.upsert('AG-DONE', { ...OTHER_FLOW, state: 'completed', finalKind: 'final_ok', sendonDone: true });

  const r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).id, 'AG-1');
  assert.equal(world.adobe.created.length, 1);
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('/start verificado: acordo ABERTO do mesmo documento e destinatários em outro fluxo dentro de 15 min => 409 DUPLICATE_OPEN', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  world.repo.upsert('AG-OTHER', { ...OTHER_FLOW, state: 'pending' });

  let r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), {
    error: 'Este documento ya tiene una solicitud de firma abierta para este destinatario en otro flujo.',
    code: 'DUPLICATE_OPEN',
    id: 'AG-OTHER',
    workflowId: '9999'
  });
  assert.equal(world.adobe.created.length, 0);
  assert.deepEqual(world.otcs.downloads, [], 'barrado antes de baixar o documento');
  assert.ok(world.logger.has('warn', /AG-OTHER.*otro flujo/));

  // passada a janela, deixa de bloquear
  world.clock.advance(16 * 60 * 1000);
  r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  await waitFor(() => world.repo.get('AG-1').startSendonDone);
  await world.close();
});

test('repo.findOpenRecent: só aberto, conjunto de e-mails sem caixa/ordem, janela e exceção do próprio fluxo', () => {
  const clock = makeClock();
  const db = openDatabase(':memory:');
  const repo = createAgreementRepository(db, { now: clock.now });
  const base = { nodeId: '1001', workflowId: '10', subworkflowId: '11', emails: ['A@x.com', 'b@x.com'], state: 'pending' };
  repo.upsert('OPEN', base);
  repo.upsert('FINAL', { ...base, nodeId: '2002', finalKind: 'final_ok' });
  repo.upsert('DONE', { ...base, nodeId: '3003', sendonDone: true });
  const win = 15 * 60 * 1000;

  assert.equal(repo.findOpenRecent('1001', ['b@X.com', 'a@x.com'], win).id, 'OPEN');
  assert.equal(repo.findOpenRecent('1001', ['a@x.com', 'a@x.com', 'b@x.com'], win).id, 'OPEN', 'repetição não muda o conjunto');
  assert.equal(repo.findOpenRecent('1001', ['a@x.com'], win), null, 'outro conjunto de destinatários');
  assert.equal(repo.findOpenRecent('2002', ['a@x.com', 'b@x.com'], win), null, 'final não bloqueia');
  assert.equal(repo.findOpenRecent('3003', ['a@x.com', 'b@x.com'], win), null, 'concluído não bloqueia');
  assert.equal(repo.findOpenRecent('1001', ['a@x.com', 'b@x.com'], win, { workflowId: 10, subworkflowId: '11' }), null, 'o próprio fluxo é excluído');
  assert.equal(repo.findOpenRecent('1001', ['a@x.com', 'b@x.com'], win, { workflowId: '10', subworkflowId: '12' }).id, 'OPEN');

  clock.advance(win + 1000);
  assert.equal(repo.findOpenRecent('1001', ['a@x.com', 'b@x.com'], win), null, 'fora da janela');
  db.close();
});

test('repo.findLatestByWorkflow: o mais recente do workflow + subprocesso + documento, em qualquer estado', () => {
  const clock = makeClock();
  const db = openDatabase(':memory:');
  const repo = createAgreementRepository(db, { now: clock.now });
  const base = { nodeId: '1001', workflowId: '10', subworkflowId: '11', emails: ['a@x.com'], state: 'pending' };
  repo.upsert('OLD', { ...base, state: 'rejected', finalKind: 'final_rejected', createdAt: '2026-06-22T10:00:00.000Z' });
  repo.upsert('NEW', { ...base, state: 'cancelled', finalKind: 'final_conversion_failed', createdAt: '2026-06-22T11:00:00.000Z' });
  repo.upsert('OTHERDOC', { ...base, nodeId: '2002', createdAt: '2026-06-22T12:00:00.000Z' });
  repo.upsert('OTHERSUB', { ...base, subworkflowId: '12', createdAt: '2026-06-22T12:00:00.000Z' });

  assert.equal(repo.findLatestByWorkflow('10', '11', '1001').id, 'NEW');
  assert.equal(repo.findLatestByWorkflow(10, 11, 1001).id, 'NEW');
  assert.equal(repo.findLatestByWorkflow('10', '11', '2002').id, 'OTHERDOC');
  assert.equal(repo.findLatestByWorkflow('10', '11', '9999'), null);
  assert.equal(repo.findOpenByWorkflow('10', '11', '1001'), null, 'findOpenByWorkflow continua só com o não final');
  db.close();
});

test('finalNotice: mensagem por kind, variação por estado e null para o acordo aberto', () => {
  const rec = (over) => ({ id: 'X', state: 'cancelled', sendonDone: false, finalKind: null, ...over });
  const tail = ' El flujo continuará automáticamente según el resultado.';
  assert.equal(finalNotice(rec()), null);
  assert.equal(finalNotice(null), null);
  const expected = {
    final_ok: 'Este documento ya fue firmado en Adobe Sign.',
    final_rejected: 'El firmante rechazó la solicitud de firma en Adobe Sign.',
    final_expired: 'La solicitud de firma expiró en Adobe Sign.',
    final_recalled: 'La solicitud de firma fue cancelada en Adobe Sign.',
    final_conversion_failed: 'Adobe Sign no pudo procesar el documento (verifique que sea un PDF válido).'
  };
  for (const [kind, text] of Object.entries(expected)) {
    assert.deepEqual(finalNotice(rec({ finalKind: kind })), { kind, state: 'cancelled', message: text + tail });
  }
  assert.equal(finalNotice(rec({ finalKind: 'final_ok', sendonDone: true, state: 'completed' })).message,
    expected.final_ok + ' El flujo ya continuó según el resultado.');
  assert.equal(finalNotice(rec({ finalKind: 'final_ok', state: 'needs_attention' })).message,
    expected.final_ok + ' El flujo requiere revisión del administrador.');
  // concluído sem kind (dado antigo): mensagem genérica
  assert.match(finalNotice(rec({ sendonDone: true })).message, /^La solicitud de firma de este documento ya terminó en Adobe Sign\./);
});

/* ---------- ciclo novo: acordo concluído + tarefa de início current de novo ---------- */

const hoursAgo = (world, h) => new Date(world.clock.ms() - h * 60 * 60 * 1000).toISOString();
const SAME_FLOW = {
  nodeId: '1001', attachId: '2002', fileName: 'contrato.pdf', workflowId: '3003', subworkflowId: '3004', taskId: 2,
  emails: ['one@example.com', 'two@example.com'], startSendonDone: true
};

test('/start verificado: acordo CONCLUÍDO do mesmo workflow/sub/nó e a tarefa de início current de novo => ciclo novo, cria acordo novo (não existing)', async () => {
  for (const old of [
    { state: 'rejected', finalKind: 'final_rejected', disposition: 'Rechazado', sendonDone: true },
    { state: 'completed', finalKind: 'final_ok', disposition: null, sendonDone: true, completedExternally: true }
  ]) {
    const world = await verifyWorld();
    seedStartFlow(world); // o mapa voltou ao passo de envio: a tarefa de início está current
    world.repo.upsert('AG-OLD', { ...SAME_FLOW, ...old, createdAt: hoursAgo(world, 2) });

    // o PDF vale normalmente no ciclo novo: nó HTML => 422, nada criado
    world.otcs.nodeContents['1001'] = HTML_DOC;
    let r = await authThenStart(world);
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), NOT_PDF_BODY);
    assert.equal(world.adobe.created.length, 0);

    // a trava vale normalmente: acordo aberto do mesmo documento em outro fluxo => 409
    delete world.otcs.nodeContents['1001'];
    world.repo.upsert('AG-OTHER', { ...OTHER_FLOW, state: 'pending' });
    r = await authThenStart(world);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'DUPLICATE_OPEN');
    assert.equal(world.adobe.created.length, 0);
    world.repo.upsert('AG-OTHER', { finalKind: 'final_ok', state: 'completed' });

    // o acordo antigo é ignorado: nasce um acordo novo, aberto, sem `existing` nem `final`
    r = await authThenStart(world);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.equal(body.id, 'AG-1');
    assert.equal('existing' in body, false);
    assert.equal('final' in body, false);
    assert.equal(body.message, 'Signature requested. ID: AG-1');
    assert.equal(world.adobe.created.length, 1);
    assert.equal(world.repo.get('AG-1').sendonDone, false);
    assert.equal(world.repo.get('AG-OLD').sendonDone, true, 'o acordo antigo não é tocado');
    await waitFor(() => world.repo.get('AG-1').startSendonDone);

    // recarregar: agora o acordo do ciclo é o novo (a tarefa de início já avançou)
    assert.deepEqual(await (await authThenStart(world)).json(), {
      message: 'Signature already requested. ID: AG-1', id: 'AG-1', existing: true
    });
    assert.equal(world.adobe.created.length, 1);
    await world.close();
  }
});

test('/start verificado: final com sendonDone=false e a tarefa de início current => continua existing + final, mesmo com um acordo concluído mais antigo', async () => {
  const world = await verifyWorld();
  seedStartFlow(world);
  world.repo.upsert('AG-OLD', { ...SAME_FLOW, state: 'rejected', finalKind: 'final_rejected', sendonDone: true, createdAt: hoursAgo(world, 2) });
  world.repo.upsert('AG-NEW', {
    ...SAME_FLOW, state: 'cancelled', finalKind: 'final_conversion_failed', startSendonDone: false, createdAt: hoursAgo(world, 1)
  });
  world.adobe.agreements['AG-NEW'] = { id: 'AG-NEW', status: 'CANCELLED' };

  const r = await authThenStart(world);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.id, 'AG-NEW');
  assert.equal(body.existing, true);
  assert.equal(body.final.kind, 'final_conversion_failed');
  assert.equal(world.adobe.created.length, 0, 'nenhum acordo novo');
  await waitFor(() => world.repo.get('AG-NEW').sendonDone);
  await world.close();
});

test('/start em sub-workflow: com acordo CONCLUÍDO do mesmo nó a pré-checagem roda (nó HTML => 422; PDF => REASSIGN_REQUIRED)', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID }); // processo 3003, subprocesso 3004
  world.repo.upsert('AG-OLD', { ...SAME_FLOW, state: 'rejected', finalKind: 'final_rejected', disposition: 'Rechazado', sendonDone: true });

  world.otcs.nodeContents['1001'] = HTML_DOC;
  let r = await authThenStart(world);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), NOT_PDF_BODY);
  assert.deepEqual(world.otcs.downloads, ['1001'], 'a pré-checagem baixou o nó');
  assert.deepEqual(world.otcs.task(3003, 2, 3004).assignees, [HUMAN_USER_ID], 'a tarefa não foi reatribuída');

  delete world.otcs.nodeContents['1001'];
  r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'REASSIGN_REQUIRED');
  assert.deepEqual(world.otcs.downloads, ['1001', '1001']);
  await world.close();
});

/* ---------- sub-workflow: pré-checagem antes do REASSIGN_REQUIRED ---------- */

test('/start em sub-workflow: nó HTML nas dicas => 422 NOT_PDF e a tarefa NÃO é reatribuída (sem REASSIGN_REQUIRED)', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID }); // processo 3003, subprocesso 3004
  world.otcs.nodeContents['1001'] = HTML_DOC;

  const r = await authThenStart(world);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), NOT_PDF_BODY);
  assert.deepEqual(adobeCalls(world), []);
  assert.equal(world.adobe.created.length, 0);
  assert.equal(modelCalled(world, 'getTaskForm'), 0);
  assert.deepEqual(world.otcs.task(3003, 2, 3004).assignees, [HUMAN_USER_ID], 'a tarefa continua com o usuário');
  assert.ok(world.logger.has('warn', /no es un PDF válido/));

  // com o PDF de volta, a pré-checagem passa e o servidor pede a reatribuição
  delete world.otcs.nodeContents['1001'];
  const again = await authThenStart(world);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'REASSIGN_REQUIRED');
  await world.close();
});

test('/start em sub-workflow: acordo aberto do mesmo documento em outro fluxo => 409 DUPLICATE_OPEN antes de pedir a reatribuição', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID });
  world.repo.upsert('AG-OTHER', { ...OTHER_FLOW, state: 'pending' });

  let r = await authThenStart(world);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'DUPLICATE_OPEN');
  assert.deepEqual([body.id, body.workflowId], ['AG-OTHER', '9999']);
  assert.deepEqual(world.otcs.downloads, [], 'a trava vem antes do download');

  // acordo final de outro fluxo não bloqueia: segue para o REASSIGN_REQUIRED
  world.repo.upsert('AG-OTHER', { finalKind: 'final_ok', state: 'completed' });
  r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'REASSIGN_REQUIRED');
  await world.close();
});

test('/start em sub-workflow: sem dicas, ou com acordo do próprio fluxo, ou com falha do OTCS no download', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID });
  world.otcs.nodeContents['1001'] = HTML_DOC;

  // sem nodeId/e-mails no pedido não há o que validar: segue para o REASSIGN_REQUIRED, sem baixar nada
  let r = await authThenStart(world, { workflowId: '3003', subworkflowId: '3004' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'REASSIGN_REQUIRED');
  assert.deepEqual(world.otcs.downloads, []);
  assert.ok(world.logger.has('info', /se omite la prevalidación/));

  // o fluxo já tem acordo deste documento: a página pode reatribuir (o /start seguinte devolve existing); nada a validar
  world.repo.upsert('AG-1', { ...OTHER_FLOW, workflowId: '3003', subworkflowId: '3004', state: 'cancelled', finalKind: 'final_conversion_failed' });
  r = await authThenStart(world);
  assert.equal((await r.json()).code, 'REASSIGN_REQUIRED');
  assert.deepEqual(world.otcs.downloads, []);

  // falha do OTCS ao baixar: erro genérico, sem reatribuição
  world.repo.upsert('AG-1', { nodeId: '5555' });
  world.otcs.downloadNode = async () => { throw httpError(502, 'bad gateway'); };
  r = await authThenStart(world);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Error al solicitar la firma.' });
  assert.ok(world.logger.has('error', /\[START ERROR\].*HTTP 502/));
  assert.deepEqual(world.otcs.task(3003, 2, 3004).assignees, [HUMAN_USER_ID]);
  await world.close();
});

test('/start em sub-workflow com a pré-checagem ok: REASSIGN_REQUIRED como antes e, depois da reatribuição, valida de novo com o formulário', async () => {
  const world = await verifyWorld();
  seedStartFlow(world, { assignee: HUMAN_USER_ID });
  let r = await authThenStart(world);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'REASSIGN_REQUIRED');
  assert.deepEqual(world.otcs.downloads, ['1001'], 'a pré-checagem baixou o nó das dicas');
  assert.equal(world.adobe.created.length, 0);

  // a reatribuição aconteceu, mas agora o formulário (fonte da verdade) aponta para um nó HTML: valida de novo
  world.otcs.assign(3003, 2, INTEGRATION_USER_ID);
  world.otcs.formFields.DocID.value = '7777';
  world.otcs.nodeContents['7777'] = HTML_DOC;
  r = await authThenStart(world, { ...FIELDS, nodeId: '7777' });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), NOT_PDF_BODY);
  assert.equal(world.adobe.created.length, 0);
  await world.close();
});

test('START_VERIFY_WORKFLOW=false preserva o comportamento anterior (sem consultar o OTCS nem idempotência)', async () => {
  const world = await buildWorld({ listen: true });
  assert.equal(world.config.startVerifyWorkflow, false);
  assert.equal((await post(world, '/start', startBody(world))).status, 200);
  assert.deepEqual(world.otcs.modelCalls.filter(([m]) => m !== 'getProcessSteps'), []);
  world.clock.advance(16 * 60 * 1000);
  assert.equal((await post(world, '/start', startBody(world))).status, 200);
  assert.equal(world.adobe.created.length, 2);
  await world.close();
});

/* ---------- banco: nonces e migração v3 ---------- */

test('repo.consumeNonce: uso único, purga dos expirados a cada inserção', () => {
  const clock = makeClock();
  const db = openDatabase(':memory:');
  const repo = createAgreementRepository(db, { now: clock.now });
  assert.equal(repo.consumeNonce('n1', 1000), true);
  assert.equal(repo.consumeNonce('n1', 1000), false);
  assert.equal(repo.consumeNonce('n2', 5000), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM start_nonces').get().n, 2);

  clock.advance(2000); // n1 expirou; n2 não
  assert.equal(repo.consumeNonce('n3', 1000), true);
  assert.deepEqual(db.prepare('SELECT nonce FROM start_nonces ORDER BY nonce').all().map((r) => r.nonce), ['n2', 'n3']);
  assert.equal(repo.consumeNonce('n2', 1000), false);
  db.close();
});

test('db: banco no schema v2 recebe a migração v3 (start_nonces) preservando os dados', () => {
  assert.equal(MIGRATIONS.length, 4); // v4: cancelamento de fluxos (test/cancellation.test.js)
  const file = path.join(tmpDir(), 'v2.db');
  const raw = new Database(file);
  raw.exec(MIGRATIONS[0]);
  raw.exec(MIGRATIONS[1]);
  raw.pragma('user_version = 2');
  raw.prepare(`INSERT INTO agreements (id, node_id, created_at, updated_at) VALUES ('OLD', '1', 'a', 'b')`).run();
  raw.close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const cols = db.prepare('PRAGMA table_info(start_nonces)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['expires_at', 'nonce']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreements').get().n, 1);
  const repo = createAgreementRepository(db);
  assert.equal(repo.consumeNonce('x', 1000), true);
  db.close();

  // reabrir é idempotente
  const again = openDatabase(file);
  assert.equal(again.pragma('user_version', { simple: true }), MIGRATIONS.length);
  again.close();
});
