// util.js
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
  Método + host/caminho de uma requisição axios, sem query, hash nem credenciais.
  Junta baseURL + url como o axios (new URL(url, base) sozinho descartaria o caminho do baseURL).
*/
function describeRequest(config) {
  // Roda dentro de catch: nunca lança (valor que nem vira string = sem requisição no texto)
  try {
    const method = String(config.method || 'GET').toUpperCase();
    const url = String(config.url);
    try {
      const base = config.baseURL ? String(config.baseURL).replace(/\/*$/, '/') : undefined;
      const u = new URL(url.replace(/^\/+/, ''), base);
      return `${method} ${u.host}${u.pathname}`;
    } catch {
      // URL que não parseia: tira tudo até o último @ antes de cortar ?/# (a senha pode conter /, ? ou #), uma linha só
      const semCredencial = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)?.*@/i, '$1').split(/[?#]/)[0];
      return `${method} ${semCredencial.replace(/[\r\n]+/g, ' ').slice(0, 200)}`;
    }
  } catch {
    return '';
  }
}

/*
  Descreve um erro (axios ou comum) sem expor cabeçalhos/tokens:
  mensagem + requisição (só se for erro axios) + status HTTP + início do corpo da resposta.
*/
function describeError(e) {
  if (!e) return 'unknown error';
  const status = e.response?.status;
  let data = e.response?.data;
  if (Buffer.isBuffer(data)) data = data.toString('utf8');
  else if (data instanceof ArrayBuffer) data = Buffer.from(data).toString('utf8');
  else if (data && typeof data === 'object') {
    try { data = JSON.stringify(data); } catch { data = ''; }
  }
  data = data ? String(data).slice(0, 500) : '';
  const request = e.config?.url ? describeRequest(e.config) : '';
  return [e.message || String(e), request, status ? `HTTP ${status}` : '', data].filter(Boolean).join(' | ');
}

// Valor vindo de fora numa única linha de log (evita forjar linhas com \r\n)
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);

/*
  E-mail mascarado para log: 2 primeiras letras do nome + '***@' + domínio (ab***@example.com). Vazio ou que não é e-mail
  vira '?', para que nada além disso chegue ao log.
*/
function maskEmail(email) {
  const s = typeof email === 'string' ? email.trim() : '';
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '?';
  return `${s.slice(0, Math.min(2, at))}***@${s.slice(at + 1)}`;
}

/*
  Escrita atômica: arquivo temporário no mesmo diretório + rename.
*/
function atomicWriteFileSync(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { sleep, describeError, oneLine, maskEmail, atomicWriteFileSync };
