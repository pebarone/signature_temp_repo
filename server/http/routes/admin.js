// http/routes/admin.js
// OAuth do Adobe (login/callback) e endpoints administrativos de reconciliação (Basic Auth).
const express = require('express');
const { describeError } = require('../../infra/util');

function adminRoutes({ config, logger, repo, reconciliation, tokenStore, basicAuth }) {
  const router = express.Router();

  // Login com Adobe Sign: redireciona para a página de consentimento
  router.get('/admin/login', (_, res) => {
    const url = tokenStore.buildLoginUrl();
    logger.info('Adobe OAuth login iniciado');
    res.redirect(url);
  });

  // Callback OAuth2: troca o code por tokens e salva
  router.get('/admin/callback', async (req, res) => {
    const { code } = req.query;
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
