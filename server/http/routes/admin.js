// http/routes/admin.js
// OAuth do Adobe (login/callback) e endpoints administrativos de reconciliação (Basic Auth).
const crypto = require('crypto');
const express = require('express');
const { describeError } = require('../../infra/util');
const { AdoptError } = require('../../services/reconciliationService');
const { ServiceError } = require('../../services/signatureService');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function adminRoutes({
  config, logger, repo, reconciliation, tokenStore, basicAuth, cancellationService = null, now = () => Date.now()
}) {
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
      logger.warn('OAuth callback rechazado: state ausente, desconocido o expirado');
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

  /*
    Força a reconciliação (consulta o Adobe se ainda não há resultado final e reprocessa pendências).
    Corpo JSON opcional { subworkflowId }: corrige o subprocesso do acordo antes de reconciliar (tarefa ambígua entre
    subprocessos, acordo registrado com o pai no lugar do subprocesso). Não vale para acordo já concluído.
  */
  router.post('/admin/reconcile/:id', basicAuth, async (req, res) => {
    const id = String(req.params.id);
    if (!repo.has(id)) return res.status(404).json({ error: 'Unknown agreement.' });
    const raw = req.body?.subworkflowId;
    const subworkflowId = raw === undefined || raw === null ? '' : String(raw).trim();
    if (subworkflowId) {
      if (!/^\d+$/.test(subworkflowId)) return res.status(422).json({ error: 'subworkflowId must be numeric.' });
      const current = repo.get(id);
      if (current.sendonDone) return res.status(409).json({ error: 'Agreement already concluded.' });
      repo.upsert(id, { subworkflowId });
      logger.warn(`[${id}] subproceso corregido manualmente: ${current.subworkflowId || '(vacío)'} -> ${subworkflowId}`);
    }
    try {
      const { record, ...result } = await reconciliation.reconcile(id, { force: true, refresh: true, manual: true });
      logger.info(`[${id}] reconcile manual: ${result.status}`);
      res.json({ result, agreement: repo.get(id) });
    } catch (e) {
      logger.error(`[${id}] reconcile manual falló: ${describeError(e)}`);
      res.status(500).json({ error: describeError(e) });
    }
  });

  /*
    Adota um acordo do Adobe que não está no store (banco efêmero perdido, acordos anteriores ao externalId).
    Usa o externalId do acordo; sem ele aceita JSON { workflowId, subworkflowId?, nodeId, attachId, fileName? }.
    Depois reconcilia (consulta o Adobe e entrega o que estiver pendente).
  */
  router.post('/admin/adopt/:id', basicAuth, async (req, res) => {
    const id = String(req.params.id);
    try {
      await reconciliation.adopt(id, req.body || {});
    } catch (e) {
      if (e instanceof AdoptError) {
        logger.warn(`[${id}] adopción manual rechazada (${e.status}): ${e.message}`);
        return res.status(e.status).json({ error: e.message, ...(e.missing ? { missing: e.missing } : {}) });
      }
      logger.error(`[${id}] adopción manual falló: ${describeError(e)}`);
      return res.status(500).json({ error: 'Internal error' });
    }
    try {
      const { record, ...result } = await reconciliation.reconcile(id, { force: true, refresh: true, manual: true });
      logger.info(`[${id}] adopción manual + reconcile: ${result.status}`);
      res.json({ adopted: true, result, agreement: repo.get(id) });
    } catch (e) {
      logger.error(`[${id}] reconcile tras la adopción falló: ${describeError(e)}`);
      res.status(500).json({ error: 'Internal error', adopted: true });
    }
  });

  /*
    Cancelamento de fluxos (ticket 2026060410003715). Não dependem de CANCEL_ENABLED (esse flag só liga o POST /cancel do
    WebReport): são ferramentas do operador, com Basic Auth. Corpo opcional { comment }. Respostas de erro: { error, code, ... }
    com 404 (sem acordo; dica de adoção), 409 (ambíguo, já assinado/concluído), 422 (ids inválidos), 503 (Adobe fora).
    Estas rotas cancelam no Adobe e fecham o acordo SEM disposição: ninguém encerra o workflow original, que continua em
    "Aguardar Firma". A resposta 200 diz isso (contentFlow: 'unchanged' + note) e o log registra um warn. Decisão: não
    mandar `Rechazado`, porque o ramo Rechazado dos mapas pode disparar ações de negócio que não são "cancelar".
    Alternativa revisável: fechar o original pelo otcsClient.stopProcess (hoje sem uso; ver o design do ticket).
  */
  if (cancellationService) {
    const CONTENT_FLOW_NOTE =
      'El flujo del Content Server no fue modificado: deténgalo en el Content o ejecute el workflow de cancelación.';
    const withContentFlow = (result, record) => {
      logger.warn(
        `[${result.agreementId}] acuerdo cancelado manualmente; el flujo del Content Server `
        + `(workflow ${result.workflowId}, subproceso ${result.subworkflowId}) no fue modificado`
      );
      return { ...result, contentFlow: 'unchanged', note: CONTENT_FLOW_NOTE, agreement: record };
    };

    const cancelError = (res, e, tag) => {
      if (e instanceof ServiceError) {
        logger.warn(`${tag} cancelación rechazada (${e.status}): ${e.message}`);
        return res.status(e.status).json(e.body);
      }
      logger.error(`${tag} cancelación falló: ${describeError(e)}`);
      return res.status(500).json({ error: 'Internal error' });
    };

    // Cancela UM acordo conhecido (inclusive um que o fluxo já deixou para trás, com o Adobe ainda aberto)
    router.post('/admin/cancel/:agreementId', basicAuth, async (req, res) => {
      const id = String(req.params.agreementId);
      try {
        const result = await cancellationService.cancelAgreement(id, { comment: req.body?.comment, source: 'admin' });
        res.json(withContentFlow(result, repo.get(id)));
      } catch (e) {
        cancelError(res, e, `[${id}]`);
      }
    });

    // Cancela o acordo aberto de um fluxo; subworkflowId opcional desempata vários acordos abertos
    router.post('/admin/cancel-workflow/:workflowId', basicAuth, async (req, res) => {
      const workflowId = String(req.params.workflowId);
      try {
        const result = await cancellationService.cancelWorkflow(workflowId, {
          subworkflowId: req.body?.subworkflowId, comment: req.body?.comment, source: 'admin'
        });
        res.json(withContentFlow(result, repo.get(result.agreementId)));
      } catch (e) {
        cancelError(res, e, `[workflow ${workflowId}]`);
      }
    });
  }

  return router;
}

module.exports = { adminRoutes };
