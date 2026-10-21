// util.js
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
  Descreve um erro (axios ou comum) sem expor cabeçalhos/tokens:
  mensagem + status HTTP + início do corpo da resposta.
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
  return [e.message || String(e), status ? `HTTP ${status}` : '', data].filter(Boolean).join(' | ');
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

module.exports = { sleep, describeError, atomicWriteFileSync };
