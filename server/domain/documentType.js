// domain/documentType.js
// Funções puras que reconhecem o conteúdo baixado do OTCS (sem I/O). O Adobe recebe os bytes como application/pdf: um HTML ou
// um DOCX só falha depois do envio (acordo cancelado por problema de conversão), então o /start confere o cabeçalho antes.

// A especificação do PDF tolera lixo antes do "%PDF-", desde que o cabeçalho esteja nos primeiros 1024 bytes
const PDF_HEADER_WINDOW = 1024;
const PDF_MAGIC = '%PDF-';
const SNIFF_WINDOW = 512;

const DOCUMENT_TYPES = {
  PDF: 'pdf',
  HTML: 'html',
  ZIP: 'zip',
  TEXT: 'text',
  EMPTY: 'empty',
  UNKNOWN: 'unknown'
};

// Rótulos para o log (espanhol)
const TYPE_LABELS = {
  [DOCUMENT_TYPES.PDF]: 'PDF',
  [DOCUMENT_TYPES.HTML]: 'HTML',
  [DOCUMENT_TYPES.ZIP]: 'ZIP/Office (docx, xlsx...)',
  [DOCUMENT_TYPES.TEXT]: 'texto',
  [DOCUMENT_TYPES.EMPTY]: 'vacío',
  [DOCUMENT_TYPES.UNKNOWN]: 'desconocido'
};

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content ?? []));

// Cabeçalho "%PDF-" nos primeiros 1024 bytes
const isPdf = (content) => toBuffer(content).subarray(0, PDF_HEADER_WINDOW).includes(PDF_MAGIC);

// Sem NUL nem caracteres de controle (exceto tab, LF, FF, CR): bytes altos passam (UTF-8 / Latin-1)
function looksLikeText(sample) {
  for (const byte of sample) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)) return false;
  }
  return true;
}

/*
  Tipo do conteúdo por inspeção simples dos primeiros bytes (só para o log; o veredito do /start é isPdf).
  Devolve um valor de DOCUMENT_TYPES. Nunca devolve nem registra o conteúdo.
*/
function sniffType(content) {
  const buf = toBuffer(content);
  if (!buf.length) return DOCUMENT_TYPES.EMPTY;
  if (isPdf(buf)) return DOCUMENT_TYPES.PDF;
  // ZIP (docx, xlsx, pptx...): "PK" + 0x03 0x04 (entrada), 0x05 0x06 (vazio) ou 0x07 0x08 (dividido)
  if (buf[0] === 0x50 && buf[1] === 0x4b && [3, 5, 7].includes(buf[2])) return DOCUMENT_TYPES.ZIP;

  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const sample = buf.subarray(hasBom ? 3 : 0, SNIFF_WINDOW);
  const head = sample.toString('latin1').trimStart().toLowerCase();
  if (/^(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/.test(head) || /<html[\s>]/.test(head)) {
    return DOCUMENT_TYPES.HTML;
  }
  return looksLikeText(sample) ? DOCUMENT_TYPES.TEXT : DOCUMENT_TYPES.UNKNOWN;
}

module.exports = { PDF_HEADER_WINDOW, DOCUMENT_TYPES, TYPE_LABELS, isPdf, sniffType };
