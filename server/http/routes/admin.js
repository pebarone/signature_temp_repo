// http/routes/admin.js
// OAuth do Adobe (login/callback) e endpoints administrativos de reconciliação (Basic Auth).
const crypto = require('crypto');
const express = require('express');
const { describeError } = require('../../infra/util');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function adminRoutes({ config, logger, repo, reconciliation, tokenStore, basicAuth, now = () => Date.now() }) {
  const router = express.Router();

  // `state` do OAuth (anti-CSRF): em memória, uso único, expira em 10 min
  const oauthStates = new Map(); // state -> expiração (ms)
  function issueState() {
    const t = now();
    for (const [s, exp] of oauthStates) if (exp <= t) oauthStates.delete(s);
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, t + OAUTH_STATE_TTL_MS);
    return state;
  }
  function consumeState(state) {
    const exp = typeof state === 'string' ? oauthStates.get(state) : undefined;
    oauthStates.delete(state);
    return exp !== undefined && exp > now();
  }

  // Login com Adobe Sign: redireciona para a página de consentimento (protegido: só quem administra inicia)
  router.get('/admin/login', basicAuth, (_, res) => {
    const url = tokenStore.buildLoginUrl(issueState());
    logger.info('Adobe OAuth login iniciado');
    res.redirect(url);
  });

  // Callback OAuth2 (redirect do Adobe, sem Basic Auth): valida o state, troca o code por tokens e salva
  router.get('/admin/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!consumeState(state)) {
      logger.warn('OAuth callback rejeitado: state ausente, desconhecido ou expirado');
      return res.status(400).send('<pre>Invalid state</pre>');
    }
    if (!code) return res.status(400).send('<pre>Missing code</pre>');
    try {
      await tokenStore.exchangeCode(String(code));
      logger.info('Token saved successfully');
      res.send('<h1>Token saved</h1>');
    } catch (e) {
      const msg = e.response?.data?.error_description || e.message;
      logger.error(`OAUTH CALLBACK ERROR: ${msg}`);
      res.status(500).send(`<pre>${String(msg).replace(/[<>&]/g, '')}</pre>`);
    }
  });

  // Estado de todos os acordos (?state=needs_attention filtra; ?events=N inclui os últimos N eventos)
  router.get('/admin/agreements', basicAuth, (req, res) => {
    const state = req.query.state ? String(req.query.state) : null;
    const nEvents = Math.min(parseInt(req.query.events, 10) || 0, 50);
    const agreements = repo.list(state ? { state } : undefined).map((rec) =>
      (nEvents ? { ...rec, events: repo.listEvents(rec.id, nEvents) } : rec));
    res.json({ counts: repo.countByState(), total: agreements.length, agreements });
  });

  // Força a reconciliação (consulta o Adobe se ainda não há resultado final e reprocessa pendências)
  router.post('/admin/reconcile/:id', basicAuth, async (req, res) => {
    const id = String(req.params.id);
    if (!repo.has(id)) return res.status(404).json({ error: 'Unknown agreement.' });
    try {
      const { record, ...result } = await reconciliation.reconcile(id, { force: true, refresh: true, manual: true });
      logger.info(`[${id}] reconcile manual: ${result.status}`);
      res.json({ result, agreement: repo.get(id) });
    } catch (e) {
      logger.error(`[${id}] reconcile manual falló: ${describeError(e)}`);
      res.status(500).json({ error: describeError(e) });
    }
  });

  return router;
}

module.exports = { adminRoutes };
