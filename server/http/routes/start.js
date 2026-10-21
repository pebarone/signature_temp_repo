// http/routes/start.js
// /auth (timestamp+HMAC para o front, protegido por Basic Auth) e POST /start (protegido por HMAC).
const express = require('express');
const { sign } = require('../middleware/hmac');
const { ServiceError } = require('../../services/signatureService');
const { oneLine } = require('../../infra/util');

function startRoutes({ config, logger, signatureService, basicAuth, verifySignature, now = () => Date.now() }) {
  const router = express.Router();

  // Emite timestamp+HMAC para o WebReport
  router.get('/auth', basicAuth, (req, res) => {
    if (!config.signatureSecret) return res.status(500).json({ error: 'Server misconfigured.' });
    const timestamp = now().toString();
    res.json({ timestamp, signature: sign(config.signatureSecret, timestamp) });
  });

  router.post('/start', (req, res, next) => {
    // Log de contexto (quem/o quê está sendo assinado)
    const { userEmail1, userEmail2, nodeId, attachId, docName } = req.body || {};
    let doc = docName || '?';
    try { doc = decodeURIComponent(doc); } catch { /* mantém o valor bruto */ }
    logger.info(
      `Signature request initiated\n` +
      `  → Document: ${oneLine(doc)}\n` +
      `  → Node ID: ${oneLine(nodeId)}\n` +
      `  → Target Folder ID: ${oneLine(attachId)}\n` +
      `  → Recipients: ${oneLine([userEmail1, userEmail2].filter(Boolean).join(', '))}`
    );
    next();
  }, verifySignature, async (req, res) => {
    try {
      const { id } = await signatureService.start(req.body);
      // `message` mantém a compatibilidade com o template.html
      res.json({ message: `Signature requested. ID: ${id}`, id });
    } catch (e) {
      if (e instanceof ServiceError) return res.status(e.status).json(e.body);
      logger.error(`[START ERROR] ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { startRoutes };
