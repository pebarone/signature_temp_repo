// infra/tokenStore.js
const fs = require('fs');
const { atomicWriteFileSync, describeError } = require('./util');

/*
  Tokens OAuth do Adobe Sign em arquivo JSON (stateDir/tokens.json, modo 600, escrita atômica).
  Semente opcional: config.adobeRefreshToken (ADOBE_REFRESH_TOKEN) quando não há refresh token salvo.
  Nunca loga valores de token.
*/
function createTokenStore({ config, logger, http = require('axios'), now = () => Date.now() }) {
  const file = config.tokensFile;
  const timeout = config.adobeTimeoutMs ?? 60 * 1000;
  let tok = { access_token: '', refresh_token: '', expires_at: 0 };
  let inflight = null;

  function readFile(p) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      logger?.error(`Failed to read ${p}: ${err.message}`);
      return null;
    }
  }

  function save() {
    try {
      atomicWriteFileSync(file, JSON.stringify(tok, null, 2), { mode: 0o600 });
    } catch (err) {
      logger?.error(`Failed to save tokens file: ${err.message}`);
    }
  }

  function load() {
    let loaded = null;
    if (fs.existsSync(file)) {
      loaded = readFile(file);
    } else {
      const legacy = (config.legacy?.tokensFiles || []).find((p) => fs.existsSync(p));
      if (legacy) {
        loaded = readFile(legacy);
        if (loaded) logger?.info('tokens.json importado de ubicación antigua');
      } else {
        logger?.warn('tokens.json NOT FOUND');
      }
    }
    if (loaded) tok = { ...tok, ...loaded };
    if (!tok.refresh_token && config.adobeRefreshToken) {
      tok.refresh_token = config.adobeRefreshToken;
      logger?.info('Adobe refresh token inicializado desde ADOBE_REFRESH_TOKEN');
    }
  }

  function setToken(accessToken, expiresInSec, refreshToken) {
    tok.access_token = accessToken;
    tok.expires_at = now() + expiresInSec * 1000;
    if (refreshToken) tok.refresh_token = refreshToken;
    save();
  }

  async function refresh() {
    try {
      const rsp = await http.post(
        `${config.adobeApiBase}/oauth/v2/refresh`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: tok.refresh_token
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout }
      );
      setToken(rsp.data.access_token, rsp.data.expires_in, rsp.data.refresh_token);
      return tok.access_token;
    } catch (err) {
      logger?.error(`Refresh failed: ${describeError(err)}`);
      throw err;
    }
  }

  // URL de consentimento OAuth (scopes separados por "+", formato aceito pelo Adobe); `state` anti-CSRF
  function buildLoginUrl(state) {
    return `${config.adobeAuthBase}/public/oauth/v2?` +
      'response_type=code' +
      `&client_id=${encodeURIComponent(config.clientId)}` +
      `&redirect_uri=${encodeURIComponent(config.redirectUri)}` +
      `&scope=${(config.adobeScopes || []).join('+')}` +
      (state ? `&state=${encodeURIComponent(state)}` : '');
  }

  // Troca o code do callback por access/refresh token e persiste
  async function exchangeCode(code) {
    const r = await http.post(
      `${config.adobeApiBase}/oauth/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout }
    );
    setToken(r.data.access_token, r.data.expires_in, r.data.refresh_token);
  }

  async function ensureToken() {
    if (tok.access_token && now() < tok.expires_at - 30000) return tok.access_token;
    if (!tok.refresh_token) {
      logger?.error('Missing refresh token');
      throw new Error('REFRESH_TOKEN_MISSING');
    }
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  load();
  return { setToken, ensureToken, buildLoginUrl, exchangeCode };
}

module.exports = { createTokenStore };
