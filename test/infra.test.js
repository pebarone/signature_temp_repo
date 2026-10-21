const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { openDatabase, MIGRATIONS } = require('../server/infra/db');
const { createAdobeClient } = require('../server/infra/adobeClient');
const { createTokenStore } = require('../server/infra/tokenStore');
const { atomicWriteFileSync, describeError } = require('../server/infra/util');
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
  const url = store.buildLoginUrl();
  assert.match(url, /^https:\/\/secure\.eu1\.adobesign\.com\/public\/oauth\/v2\?response_type=code&client_id=cid/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fpublic\.invalid%2Fadmin%2Fcallback/);
  assert.match(url, /scope=agreement_send:account\+agreement_write:account/);

  await store.exchangeCode('the-code');
  assert.equal(sent.body.get('code'), 'the-code');
  assert.equal(sent.body.get('grant_type'), 'authorization_code');
  assert.equal(JSON.parse(fs.readFileSync(config.tokensFile, 'utf8')).refresh_token, 'r');
});
