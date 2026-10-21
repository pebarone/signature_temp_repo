// http/middleware/basicAuth.js
const crypto = require('crypto');

// Compara por hash (tempo constante, independente do tamanho)
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/*
  Basic Auth para /auth, /logs e /admin/agreements|reconcile.
  Sem user/pass configurados (LOG_USER/LOG_PASS) tudo é negado.
*/
function createBasicAuth({ user, pass, realm = 'Logs' }) {
  return function basicAuth(req, res, next) {
    const challenge = (msg) => {
      res.set('WWW-Authenticate', `Basic realm="${realm}"`);
      return res.status(401).send(msg);
    };
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) return challenge('Authentication required.');
    if (!user || !pass) return challenge('Invalid credentials.');

    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString();
    const idx = decoded.indexOf(':'); // a senha pode conter ":"
    const u = idx === -1 ? decoded : decoded.slice(0, idx);
    const p = idx === -1 ? '' : decoded.slice(idx + 1);
    // Sem curto-circuito: sempre compara os dois
    const okUser = safeEqual(u, user);
    const okPass = safeEqual(p, pass);
    if (!(okUser && okPass)) return challenge('Invalid credentials.');
    next();
  };
}

module.exports = { createBasicAuth };
