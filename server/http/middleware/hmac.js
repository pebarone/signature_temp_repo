// http/middleware/hmac.js
const crypto = require('crypto');

const MAX_AGE_MS = 2 * 60 * 1000;

const sign = (secret, timestamp) =>
  crypto.createHmac('sha256', secret).update(String(timestamp)).digest('hex');

/*
  Verifica timestamp+HMAC (SHA-256) no corpo da requisição (POST /start):
  rejeita assinatura ausente/mal formada, timestamp fora da janela de 2 min (anti-replay) e HMAC inválido.
*/
function createVerifySignature({ secret, now = () => Date.now(), maxAgeMs = MAX_AGE_MS, logger }) {
  return function verifySignature(req, res, next) {
    if (!secret) {
      logger?.error('SIGNATURE_SECRET não configurado: /start indisponível');
      return res.status(500).json({ error: 'Server misconfigured.' });
    }
    const { signature, timestamp } = req.body || {};
    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature or timestamp.' });
    }
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
      return res.status(400).json({ error: 'Malformed signature.' });
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > maxAgeMs) {
      return res.status(403).json({ error: 'Timestamp expired.' });
    }
    const expected = Buffer.from(sign(secret, timestamp), 'hex');
    const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return res.status(403).json({ error: 'Invalid signature.' });
    }
    next();
  };
}

module.exports = { createVerifySignature, sign, MAX_AGE_MS };
