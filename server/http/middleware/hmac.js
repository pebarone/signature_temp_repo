// http/middleware/hmac.js
const crypto = require('crypto');

const MAX_AGE_MS = 2 * 60 * 1000;
// O nonce nunca é aceito depois de timestamp+janela; guarda-se pelo dobro da janela (margem para relógio)
const NONCE_TTL_MS = 2 * MAX_AGE_MS;
const NONCE_RE = /^[A-Za-z0-9]{16,64}$/;

// v1 (legado): HMAC só do timestamp — NÃO vincula o payload
const sign = (secret, timestamp) =>
  crypto.createHmac('sha256', secret).update(String(timestamp)).digest('hex');

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

// E-mails de userEmail1/userEmail2 (separados por ; ou ,): trim, minúsculas, ordenados, unidos por ','
const canonicalEmails = (fields) =>
  [fields.userEmail1, fields.userEmail2]
    .flatMap((e) => text(e).split(/[;,]+/))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');

/*
  Forma canônica v2 do /start (pura): vincula a assinatura aos campos do envio.
  v2\n<timestamp>\n<nonce>\n<workflowId>\n<subworkflowId>\n<nodeId>\n<attachId>\n<emails>\n<docName>
  Campos ausentes viram string vazia; todos passam por String() + trim.
*/
function canonicalStart(fields = {}) {
  return [
    'v2',
    text(fields.timestamp),
    text(fields.nonce),
    text(fields.workflowId),
    text(fields.subworkflowId),
    text(fields.nodeId),
    text(fields.attachId),
    canonicalEmails(fields),
    text(fields.docName)
  ].join('\n');
}

const signStart = (secret, fields) =>
  crypto.createHmac('sha256', secret).update(canonicalStart(fields)).digest('hex');

const newNonce = () => crypto.randomBytes(16).toString('hex');

function equalHex(expectedHex, receivedHex) {
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/*
  Verifica o POST /start (corpo JSON):
    - v2 (com nonce): recalcula o canônico a partir do corpo (tempo constante), exige timestamp na janela de 2 min e
      consome o nonce (uso único, persistido). O nonce só é consumido DEPOIS de a assinatura ser válida.
    - v1 (sem nonce, só timestamp): rejeitado, salvo allowLegacy (START_LEGACY_SIGNATURE); marca req.legacyAuth = true.
  consumeNonce(nonce, ttlMs) => boolean (true = consumido agora, false = replay).
*/
function createVerifySignature({
  secret, now = () => Date.now(), maxAgeMs = MAX_AGE_MS, logger, consumeNonce, allowLegacy = false
}) {
  return function verifySignature(req, res, next) {
    if (!secret) {
      logger?.error('SIGNATURE_SECRET no configurado: /start no disponible');
      return res.status(500).json({ error: 'Server misconfigured.' });
    }
    const body = req.body || {};
    const { signature, timestamp, nonce } = body;
    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature or timestamp.' });
    }
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
      return res.status(400).json({ error: 'Malformed signature.' });
    }
    const legacy = nonce === undefined || nonce === null || nonce === '';
    if (legacy && !allowLegacy) {
      return res.status(403).json({ error: 'Unsupported signature version.' });
    }
    if (!legacy && (typeof nonce !== 'string' || !NONCE_RE.test(nonce))) {
      return res.status(400).json({ error: 'Malformed nonce.' });
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > maxAgeMs) {
      return res.status(403).json({ error: 'Timestamp expired.' });
    }
    const expectedHex = legacy ? sign(secret, timestamp) : signStart(secret, body);
    if (!equalHex(expectedHex, signature)) {
      return res.status(403).json({ error: 'Invalid signature.' });
    }
    if (legacy) {
      logger?.warn('[START] Firma v1 (solo timestamp) aceptada por START_LEGACY_SIGNATURE: el WebReport debe actualizarse al protocolo v2.');
      req.legacyAuth = true;
    } else if (!consumeNonce || !consumeNonce(nonce, NONCE_TTL_MS)) {
      // Sem armazenamento de nonces não há como garantir uso único: falha fechado
      return res.status(403).json({ error: 'Solicitud ya utilizada.' });
    }
    next();
  };
}

module.exports = {
  createVerifySignature, sign, signStart, canonicalStart, newNonce, MAX_AGE_MS, NONCE_TTL_MS
};
