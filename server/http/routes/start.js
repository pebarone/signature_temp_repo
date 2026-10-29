// http/routes/start.js
// POST /auth (Basic Auth; emite timestamp+nonce+HMAC v2 vinculado aos campos do envio) e POST /start (HMAC v2).
// Legado (só durante a migração dos WebReports, desligado por padrão): GET /auth (v1) e GET /start sem HMAC.
const express = require('express');
const { sign, signStart, newNonce } = require('../middleware/hmac');
const { ServiceError, START_ERROR_MESSAGE } = require('../../services/signatureService');
const { oneLine, describeError } = require('../../infra/util');

function startRoutes({ config, logger, signatureService, startBasicAuth, verifySignature, now = () => Date.now() }) {
  const router = express.Router();

  // Log de contexto (quem/o quê está sendo assinado)
  function logInitiated(fields) {
    const { userEmail1, userEmail2, nodeId, attachId, docName } = fields || {};
    let doc = docName || '?';
    try { doc = decodeURIComponent(doc); } catch { /* mantém o valor bruto */ }
    logger.info(
      `Signature request initiated\n` +
      `  → Document: ${oneLine(doc)}\n` +
      `  → Node ID: ${oneLine(nodeId)}\n` +
      `  → Target Folder ID: ${oneLine(attachId)}\n` +
      `  → Recipients: ${oneLine([userEmail1, userEmail2].filter(Boolean).join(', '))}`
    );
  }

  async function runStart(fields, res, options) {
    try {
      const { id, existing, handoff, final } = await signatureService.start(fields, options);
      // `message` mantém a compatibilidade com o template.html. `handoff` (quando há) diz à página o que reatribuir
      // ao usuário de integração depois do envio: { workflowId, subworkflowId, taskId, integrationUserId, assigned }.
      const extra = handoff ? { handoff } : {};
      if (existing) {
        // Acordo do próprio fluxo já final (ou concluído): `final` = { kind, state, message } e a `message` da resposta é a
        // dele (uma página antiga que só exibe `message` não anuncia um sucesso que não houve)
        if (final) return res.json({ message: final.message, id, existing: true, final, ...extra });
        return res.json({ message: `Signature already requested. ID: ${id}`, id, existing: true, ...extra });
      }
      res.json({ message: `Signature requested. ID: ${id}`, id, ...extra });
    } catch (e) {
      // Corpos de ServiceError são fixos: 409 REASSIGN_REQUIRED leva { code, handoff }; 422 NOT_PDF e 409 START_IN_PROGRESS
      // levam { code }; 401 LOGIN_REQUIRED leva só { error: 'LOGIN_REQUIRED' } (sem code); 409 DUPLICATE_OPEN leva
      // { code, id, workflowId } do acordo aberto em outro fluxo; 409 PREVIOUS_CYCLE_OPEN leva { code, id } do acordo de um
      // envio anterior ainda aberto
      if (e instanceof ServiceError) return res.status(e.status).json(e.body);
      logger.error(`[START ERROR] ${describeError(e)}`);
      res.status(500).json({ error: START_ERROR_MESSAGE });
    }
  }

  // v2: o WebReport envia os campos do envio e recebe { v, timestamp, nonce, signature } (válidos por 2 min, uso único)
  router.post('/auth', startBasicAuth, (req, res) => {
    if (!config.signatureSecret) return res.status(500).json({ error: 'Server misconfigured.' });
    const fields = req.body && typeof req.body === 'object' ? req.body : {};
    const timestamp = now().toString();
    const nonce = newNonce();
    res.json({ v: 2, timestamp, nonce, signature: signStart(config.signatureSecret, { ...fields, timestamp, nonce }) });
  });

  router.post('/start', (req, res, next) => {
    logInitiated(req.body);
    next();
  }, verifySignature, (req, res) =>
    // Assinatura legada (v1) não vincula o payload: a validação contra o OTCS passa a ser obrigatória
    runStart(req.body, res, { forceVerify: !!req.legacyAuth }));

  if (config.startLegacySignature) {
    router.get('/auth', startBasicAuth, (req, res) => {
      if (!config.signatureSecret) return res.status(500).json({ error: 'Server misconfigured.' });
      logger.warn('[AUTH] GET /auth (v1, solo timestamp) por START_LEGACY_SIGNATURE: el WebReport debe actualizarse al protocolo v2.');
      const timestamp = now().toString();
      res.json({ timestamp, signature: sign(config.signatureSecret, timestamp) });
    });
  }

  if (config.startLegacyGet) {
    router.get('/start', (req, res) => {
      logger.warn('[START] GET /start (contrato antiguo, sin HMAC) por START_LEGACY_GET_ENABLED: el WebReport debe actualizarse al protocolo v2.');
      // Repetições de um parâmetro (?a=1&a=2) viram array: fica só o primeiro valor
      const fields = Object.fromEntries(
        Object.entries(req.query || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
      );
      logInitiated(fields);
      return runStart(fields, res, { forceVerify: true });
    });
  }

  return router;
}

module.exports = { startRoutes };
