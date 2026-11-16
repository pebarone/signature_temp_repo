const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { openDatabase, MIGRATIONS } = require('../server/infra/db');
const { createAdobeClient } = require('../server/infra/adobeClient');
const { createTokenStore } = require('../server/infra/tokenStore');
const { createOtcsClient } = require('../server/infra/otcsClient');
const { atomicWriteFileSync, describeError, maskEmail } = require('../server/infra/util');
const { computeConfig } = require('../server/config');
const { PDF, makeLogger, tmpDir, httpError } = require('./support/fakes');

test('db: cria o schema (user_version) e reabrir o arquivo é idempotente', () => {
  const file = path.join(tmpDir(), 'state', 'orchestrator.db');
  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  db.prepare("INSERT INTO agreements (id, created_at, updated_at) VALUES ('x', 'a', 'b')").run();
  db.close();

  const db2 = openDatabase(file);
  assert.equal(db2.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM agreements').get().n, 1);
  assert.equal(db2.pragma('journal_mode', { simple: true }), 'wal');
  db2.close();
});

test('util: escrita atômica não deixa temporários e describeError não vaza cabeçalhos', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'a.json');
  atomicWriteFileSync(file, '{"a":1}', { mode: 0o600 });
  atomicWriteFileSync(file, '{"a":2}', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const e = httpError(403, 'forbidden');
  e.config = { headers: { Authorization: 'Bearer SECRET' } };
  const text = describeError(e);
  assert.match(text, /HTTP 403/);
  assert.doesNotMatch(text, /SECRET/);
});

// Estes casos ficam fora do teste acima de propósito: nesta máquina (Windows) ele falha na checagem do modo 600 antes daqui.
test('util: describeError diz qual requisição falhou (método + host/caminho), sem query, hash, cabeçalhos ou credenciais', () => {
  const timeout = Object.assign(new Error('timeout of 60000ms exceeded'), {
    code: 'ECONNABORTED',
    config: { method: 'post', url: 'https://api.na4.adobesign.com/api/rest/v6/transientDocuments?x=SEGREDO#frag', headers: { Authorization: 'Bearer TOKEN' }, data: 'CORPO' }
  });
  const text = describeError(timeout);
  assert.equal(text, 'timeout of 60000ms exceeded | POST api.na4.adobesign.com/api/rest/v6/transientDocuments');
  assert.doesNotMatch(text, /SEGREDO|frag|TOKEN|CORPO/);

  // url relativa junta com baseURL como o axios: o caminho do baseURL é mantido
  const rel = Object.assign(new Error('boom'), { config: { url: '/transientDocuments', baseURL: 'https://adobe.invalid/api/rest/v6/' } });
  assert.equal(describeError(rel), 'boom | GET adobe.invalid/api/rest/v6/transientDocuments');
  const relNoSlash = Object.assign(new Error('boom'), { config: { method: 'get', url: 'agreements/AG-1', baseURL: 'https://adobe.invalid/api/rest/v6' } });
  assert.equal(describeError(relNoSlash), 'boom | GET adobe.invalid/api/rest/v6/agreements/AG-1');

  const cred = Object.assign(new Error('boom'), { config: { method: 'get', url: 'https://user:pa55@api.example.com/x?y=1' } });
  assert.equal(describeError(cred), 'boom | GET api.example.com/x');
});

test('util: describeError mantém HTTP <status> | <data> no fim e limita o corpo a 500 caracteres', () => {
  const e = Object.assign(new Error('Request failed with status code 500'), {
    config: { method: 'post', url: 'https://otcs.invalid/api/v2/processes?x=1', headers: { OTCSTicket: 'SECRETO' } },
    response: { status: 500, data: { error: 'boom' } }
  });
  const text = describeError(e);
  assert.equal(text, 'Request failed with status code 500 | POST otcs.invalid/api/v2/processes | HTTP 500 | {"error":"boom"}');
  assert.doesNotMatch(text, /SECRETO/);

  const longBody = Object.assign(new Error('x'), { config: { url: 'https://h.invalid/a' }, response: { status: 502, data: 'y'.repeat(600) } });
  assert.equal(describeError(longBody), `x | GET h.invalid/a | HTTP 502 | ${'y'.repeat(500)}`);
});

test('util: describeError com URL que não parseia corta ?/# e tira credenciais', () => {
  const e = Object.assign(new Error('falhou'), { config: { method: 'get', url: 'https://user:pa?ss@api.example.com:99999/p?token=abc#h' } });
  assert.equal(describeError(e), 'falhou | GET https://api.example.com:99999/p');
  // senha com "/" e quebra de linha (forjaria uma linha de log) também não passam
  const barra = Object.assign(new Error('falhou'), { config: { url: 'https://user:pa/ss@host:99999/x?t=1' } });
  assert.equal(describeError(barra), 'falhou | GET https://host:99999/x');
  const quebra = Object.assign(new Error('falhou'), { config: { url: 'https://h:99999/a\nFAKE LINE?q=1' } });
  assert.doesNotMatch(describeError(quebra), /[\r\n]/);
  // valor que não vira string: describeError não lança
  const ruim = Object.assign(new Error('m'), { config: { url: { toString() { throw new Error('x'); } } } });
  assert.equal(describeError(ruim), 'm');
});

test('util: describeError de erro comum, string ou erro sem config.url sai como antes', () => {
  assert.equal(describeError(new Error('falha simples')), 'falha simples');
  assert.equal(describeError('texto solto'), 'texto solto');
  assert.equal(describeError(null), 'unknown error');
  const semUrl = Object.assign(new Error('sem url'), { config: { method: 'post', headers: { A: 'b' } } });
  assert.equal(describeError(semUrl), 'sem url');
});

test('util: maskEmail mantém as 2 primeiras letras do nome e o domínio; o que não é e-mail vira "?"', () => {
  assert.equal(maskEmail('ab.cdef@example.com'), 'ab***@example.com');
  assert.equal(maskEmail('a@x.com'), 'a***@x.com');
  assert.equal(maskEmail('  Maria@Example.com '), 'Ma***@Example.com');
  for (const v of ['', '   ', null, undefined, 42, 'sem-arroba', '@example.com', 'maria@']) {
    assert.equal(maskEmail(v), '?', String(v));
  }
  assert.doesNotMatch(maskEmail('segredo.longo@example.com'), /segredo|longo/);
});

/* ---------- Adobe: retry de 403 aguardado ---------- */

function adobeWith(responses, opts = {}) {
  const sleeps = [];
  const calls = [];
  const http = {
    get: async (url) => {
      calls.push(url);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { data: next };
    }
  };
  const client = createAdobeClient({
    apiBase: 'https://adobe.invalid',
    ensureToken: async () => 'tok',
    http,
    sleep: async (ms) => { sleeps.push(ms); },
    download: { attempts: 4, delayMs: 1000, maxDelayMs: 3000, ...opts },
    logger: makeLogger()
  });
  return { client, sleeps, calls };
}

test('adobe: 403 no download é reaguardado com backoff e depois entrega o PDF', async () => {
  const { client, sleeps, calls } = adobeWith([httpError(403), httpError(403), PDF]);
  const buf = await client.downloadCombinedDocument('AG-1');
  assert.deepEqual(buf, PDF);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\/api\/rest\/v6\/agreements\/AG-1\/combinedDocument\?attachAuditReport=true$/);
});

test('adobe: esgotadas as tentativas de 403 o erro é propagado (não engolido)', async () => {
  const { client, sleeps } = adobeWith([httpError(403), httpError(403), httpError(403), httpError(403), PDF]);
  await assert.rejects(() => client.downloadCombinedDocument('AG-1'), (e) => e.response.status === 403);
  assert.deepEqual(sleeps, [1000, 2000, 3000]); // limitado por maxDelayMs
});

test('adobe: outros erros e conteúdo que não é PDF falham imediatamente', async () => {
  const a = adobeWith([httpError(500)]);
  await assert.rejects(() => a.client.downloadCombinedDocument('AG-1'), (e) => e.response.status === 500);
  assert.equal(a.sleeps.length, 0);

  const b = adobeWith([Buffer.from('<html>erro</html>')]);
  await assert.rejects(() => b.client.downloadCombinedDocument('AG-1'), /no es un PDF/);
});

test('adobe: getAgreementEvents lê /agreements/{id}/events e devolve a lista (vazia se não houver)', async () => {
  const { client, calls } = adobeWith([{ events: [{ type: 'ACTION_REJECTED' }] }, {}]);
  assert.deepEqual(await client.getAgreementEvents('AG 1'), [{ type: 'ACTION_REJECTED' }]);
  assert.match(calls[0], /\/api\/rest\/v6\/agreements\/AG%201\/events$/);
  assert.deepEqual(await client.getAgreementEvents('AG-1'), []);
});

/* ---------- tokenStore ---------- */

// legacy.tokensFiles vazio: o teste não depende de /tmp/tokens.json da máquina
const tokenConfig = (dir, extra = {}) => {
  const c = computeConfig({ DATA_DIR: dir, CLIENT_ID: 'cid', CLIENT_SECRET: 'csecret', PUBLIC_URL: 'https://public.invalid' });
  return { ...c, legacy: { ...c.legacy, tokensFiles: [] }, ...extra };
};

test('tokenStore: refresh grava tokens.json (modo 600), reaproveita o token e persiste entre restarts', async () => {
  const dir = tmpDir();
  const config = tokenConfig(dir);
  let posts = 0;
  const http = {
    post: async (url, body) => {
      posts++;
      assert.match(url, /\/oauth\/v2\/refresh$/);
      assert.equal(new URLSearchParams(body).get('refresh_token'), 'refresh-1');
      return { data: { access_token: `access-${posts}`, expires_in: 3600 } };
    }
  };
  let t = 1_000_000;
  const store = createTokenStore({ config, logger: makeLogger(), http, now: () => t });
  store.setToken('old-access', -10, 'refresh-1'); // expirado, mas com refresh token
  assert.equal(await store.ensureToken(), 'access-1');
  assert.equal(await store.ensureToken(), 'access-1');
  assert.equal(posts, 1);

  assert.equal(fs.statSync(config.tokensFile).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(config.tokensFile, 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-1');

  // restart: novo store lê do arquivo
  const store2 = createTokenStore({ config, logger: makeLogger(), http, now: () => t });
  assert.equal(await store2.ensureToken(), 'access-1');
  assert.equal(posts, 1);
});

test('tokenStore: sem token => REFRESH_TOKEN_MISSING; semente ADOBE_REFRESH_TOKEN; importa tokens.json antigo', async () => {
  const logger = makeLogger();
  const noToken = createTokenStore({ config: tokenConfig(tmpDir(), { legacy: { tokensFiles: [] } }), logger, http: {} });
  await assert.rejects(() => noToken.ensureToken(), /REFRESH_TOKEN_MISSING/);

  const seeded = createTokenStore({
    config: tokenConfig(tmpDir(), { adobeRefreshToken: 'from-env', legacy: { tokensFiles: [] } }),
    logger,
    http: { post: async () => ({ data: { access_token: 'a', expires_in: 60 } }) }
  });
  assert.equal(await seeded.ensureToken(), 'a');

  const legacyFile = path.join(tmpDir(), 'tokens.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ access_token: 'legacy-access', refresh_token: 'r', expires_at: Date.now() + 3600_000 }));
  const imported = createTokenStore({ config: tokenConfig(tmpDir(), { legacy: { tokensFiles: [legacyFile] } }), logger, http: {} });
  assert.equal(await imported.ensureToken(), 'legacy-access');
});

test('tokenStore: login URL e troca de code', async () => {
  const config = tokenConfig(tmpDir());
  let sent;
  const store = createTokenStore({
    config, logger: makeLogger(),
    http: { post: async (url, body) => { sent = { url, body: new URLSearchParams(body) }; return { data: { access_token: 'a', refresh_token: 'r', expires_in: 60 } }; } }
  });
  const url = store.buildLoginUrl('st ate/1');
  assert.match(url, /^https:\/\/secure\.eu1\.adobesign\.com\/public\/oauth\/v2\?response_type=code&client_id=cid/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fpublic\.invalid%2Fadmin%2Fcallback/);
  assert.match(url, /scope=agreement_send:account\+agreement_write:account/);
  assert.match(url, /&state=st%20ate%2F1$/);

  await store.exchangeCode('the-code');
  assert.equal(sent.body.get('code'), 'the-code');
  assert.equal(sent.body.get('grant_type'), 'authorization_code');
  assert.equal(JSON.parse(fs.readFileSync(config.tokensFile, 'utf8')).refresh_token, 'r');
});

test('tokenStore: falha ao gravar tokens.json propaga no exchangeCode, mas o refresh segue em memória', async () => {
  // o "diretório" de state é um arquivo: qualquer gravação falha (simula volume sem permissão)
  const blocker = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const config = tokenConfig(tmpDir(), { tokensFile: path.join(blocker, 'tokens.json') });
  const http = { post: async () => ({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }) };
  const logger = makeLogger();

  const store = createTokenStore({ config, logger, http });
  await assert.rejects(() => store.exchangeCode('the-code'), /no persistidos/);

  const refreshing = createTokenStore({ config: { ...config, adobeRefreshToken: 'seed' }, logger, http });
  assert.equal(await refreshing.ensureToken(), 'a');
});

test('tokenStore: refresh e exchangeCode usam timeout (ADOBE_TIMEOUT_MS, padrão 60000)', async () => {
  assert.equal(tokenConfig(tmpDir()).adobeTimeoutMs, 60000);
  assert.equal(computeConfig({ DATA_DIR: tmpDir(), ADOBE_TIMEOUT_MS: '15000' }).adobeTimeoutMs, 15000);

  const timeouts = [];
  const http = {
    post: async (url, body, opts) => {
      timeouts.push(opts.timeout);
      return { data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } };
    }
  };
  const store = createTokenStore({ config: tokenConfig(tmpDir(), { adobeTimeoutMs: 12345 }), logger: makeLogger(), http });
  await store.exchangeCode('c');
  store.setToken('old', -10, 'r');
  await store.ensureToken(); // refresh
  assert.deepEqual(timeouts, [12345, 12345]);
});

test('tokenStore: refresh rejeitado/travado (timeout) limpa o inflight e o próximo ensureToken tenta de novo', async () => {
  const pending = [];
  const http = {
    post: () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  };
  const store = createTokenStore({ config: tokenConfig(tmpDir()), logger: makeLogger(), http });
  store.setToken('old', -10, 'r1');

  // chamadas concorrentes compartilham o mesmo refresh em curso
  const a = store.ensureToken();
  const b = store.ensureToken();
  assert.equal(pending.length, 1);
  const timeoutErr = Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' });
  pending[0].reject(timeoutErr); // o axios rejeita quando o timeout estoura
  await assert.rejects(a, /timeout/);
  await assert.rejects(b, /timeout/);

  // inflight limpo: nova chamada dispara outro refresh (não reaproveita a promise rejeitada)
  const c = store.ensureToken();
  assert.equal(pending.length, 2);
  pending[1].resolve({ data: { access_token: 'fresh', expires_in: 3600 } });
  assert.equal(await c, 'fresh');
});

test('tokenStore: 10 ensureToken() concorrentes com token expirado => um único refresh e o mesmo token para todos', async () => {
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const http = {
    post: async () => {
      posts++;
      await gate; // as 10 chamadas entram antes de o refresh terminar
      return { data: { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 } };
    }
  };
  const store = createTokenStore({ config: tokenConfig(tmpDir()), logger: makeLogger(), http });
  store.setToken('old', -10, 'r1');

  const calls = Array.from({ length: 10 }, () => store.ensureToken());
  release();
  const tokens = await Promise.all(calls);
  assert.equal(posts, 1);
  assert.deepEqual(tokens, Array(10).fill('fresh'));
  assert.equal(await store.ensureToken(), 'fresh', 'token válido: não refaz o refresh');
  assert.equal(posts, 1);
});

test('tokenStore: refresh cujo tokens.json não pode ser gravado loga erro (sem valores de token) e o token segue válido', async () => {
  // o "diretório" de state é um arquivo: a gravação falha (simula volume sem permissão)
  const blocker = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const config = tokenConfig(tmpDir(), { tokensFile: path.join(blocker, 'tokens.json'), adobeRefreshToken: 'seed-refresh' });
  const http = {
    post: async () => ({ data: { access_token: 'access-valor-secreto', refresh_token: 'refresh-valor-secreto', expires_in: 3600 } })
  };
  const logger = makeLogger();
  const store = createTokenStore({ config, logger, http });

  assert.equal(await store.ensureToken(), 'access-valor-secreto');
  assert.ok(logger.has('error', /Token renovado pero no se pudo guardar en tokens\.json/));
  assert.ok(logger.lines.error.every((l) => !/valor-secreto/.test(l)), 'nenhum valor de token no log');
  assert.equal(await store.ensureToken(), 'access-valor-secreto', 'segue em memória');
});

/* ---------- OTCS: 401 => novo login e uma repetição ---------- */

function otcsWith(handler) {
  const seen = []; // [método, ticket usado]
  let logins = 0;
  const call = (method) => async (url, ...rest) => {
    const opts = rest[rest.length - 1];
    seen.push([method, opts.headers.OTCSTicket]);
    return handler(method, url, opts.headers.OTCSTicket);
  };
  const http = {
    post: async (url, body, opts) => {
      if (url.endsWith('/v1/auth')) { logins++; return { data: { ticket: `t${logins}`, validFor: 1800 } }; }
      seen.push(['post', opts.headers.OTCSTicket]);
      return handler('post', url, opts.headers.OTCSTicket);
    },
    get: call('get'),
    put: call('put')
  };
  const client = createOtcsClient({ base: 'https://otcs.invalid/api', user: 'u', pass: 'p', http, now: () => 1000 });
  return { client, seen, logins: () => logins };
}

const unauthorizedFor = (stale) => (method, url, ticket) => {
  if (ticket === stale) throw httpError(401, 'ticket expired');
  if (method === 'get' && url.includes('/nodes?where_name=')) return { data: { data: [] } };
  return { data: method === 'get' ? PDF : { ok: true } };
};

test('otcs: 401 no downloadNode descarta o ticket, refaz o login e repete uma vez', async () => {
  const { client, seen, logins } = otcsWith(unauthorizedFor('t1'));
  assert.equal(await client.ensureTicket(), 't1');
  assert.deepEqual(await client.downloadNode(1001), PDF);
  assert.deepEqual(seen, [['get', 't1'], ['get', 't2']]);
  assert.equal(logins(), 2);
  // o ticket novo fica em cache
  await client.downloadNode(1001);
  assert.equal(logins(), 2);
});

test('otcs: 401 no uploadToFolder e no sendOnWorkflow também repetem uma vez com login novo', async () => {
  const up = otcsWith(unauthorizedFor('t1'));
  await up.client.ensureTicket();
  assert.deepEqual(await up.client.uploadToFolder(2002, PDF, 'a.pdf'), { ok: true });
  assert.deepEqual(up.seen, [['get', 't1'], ['get', 't2'], ['post', 't2']]);

  const so = otcsWith(unauthorizedFor('t1'));
  await so.client.ensureTicket();
  assert.deepEqual(await so.client.sendOnWorkflow({ workflowId: 1, subworkflowId: 1, disposition: 'Firmado' }), { ok: true });
  assert.deepEqual(so.seen, [['put', 't1'], ['put', 't2']]);
  assert.equal(so.logins(), 2);
});

test('otcs: só repete uma vez (401 persistente propaga) e outros erros não repetem nem refazem o login', async () => {
  const always401 = otcsWith(() => { throw httpError(401, 'nope'); });
  await assert.rejects(() => always401.client.downloadNode(1), (e) => e.response.status === 401);
  assert.equal(always401.seen.length, 2);
  assert.equal(always401.logins(), 2);

  const e500 = otcsWith(() => { throw httpError(500, 'boom'); });
  await assert.rejects(() => e500.client.sendOnWorkflow({ workflowId: 1, subworkflowId: 1 }), (e) => e.response.status === 500);
  assert.equal(e500.seen.length, 1);
  assert.equal(e500.logins(), 1);
});

test('adobe: createAgreement só leva expirationTime quando informado (sem ele o payload é o de sempre)', async () => {
  const posts = [];
  const http = { post: async (url, body) => { posts.push({ url, body }); return { data: { id: 'AG-X' } }; } };
  const client = createAdobeClient({ apiBase: 'https://adobe.invalid', ensureToken: async () => 'tok', http, logger: makeLogger() });
  const base = { name: 'Documento a.pdf', transientDocumentId: 'T1', emails: ['a@example.com'], externalId: 'otcs|wf=1' };

  await client.createAgreement(base);
  await client.createAgreement({ ...base, expirationTime: '2026-11-11T12:00:00.000Z' });
  assert.equal(posts[0].url, 'https://adobe.invalid/api/rest/v6/agreements');
  assert.equal('expirationTime' in posts[0].body, false);
  assert.deepEqual(Object.keys(posts[0].body), ['name', 'fileInfos', 'participantSetsInfo', 'signatureType', 'state', 'externalId']);
  assert.equal(posts[1].body.expirationTime, '2026-11-11T12:00:00.000Z');
  assert.deepEqual({ ...posts[1].body, expirationTime: undefined }, { ...posts[0].body, expirationTime: undefined });
});
