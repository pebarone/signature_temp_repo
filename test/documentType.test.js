// Funções puras de domain/documentType: reconhecimento do PDF (%PDF- nos primeiros 1024 bytes) e tipo do conteúdo para o log.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDF_HEADER_WINDOW, DOCUMENT_TYPES, TYPE_LABELS, isPdf, sniffType } = require('../server/domain/documentType');

const T = DOCUMENT_TYPES;

test('isPdf: cabeçalho %PDF- nos primeiros 1024 bytes, com ou sem lixo antes', () => {
  assert.equal(PDF_HEADER_WINDOW, 1024);
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n%âãÏÓ')), true);
  assert.equal(isPdf(Buffer.concat([Buffer.alloc(500, 0x20), Buffer.from('%PDF-1.4')])), true);
  // limite: o cabeçalho inteiro termina exatamente no byte 1024 / começa no byte 1019 (índice 1019..1023)
  assert.equal(isPdf(Buffer.concat([Buffer.alloc(PDF_HEADER_WINDOW - 5, 0x20), Buffer.from('%PDF-')])), true);
  assert.equal(isPdf(Buffer.concat([Buffer.alloc(PDF_HEADER_WINDOW - 4, 0x20), Buffer.from('%PDF-')])), false);
  assert.equal(isPdf(Buffer.concat([Buffer.alloc(PDF_HEADER_WINDOW + 10, 0x20), Buffer.from('%PDF-1.7')])), false);
});

test('isPdf: HTML, ZIP, texto, vazio e entradas estranhas não são PDF', () => {
  assert.equal(isPdf(Buffer.from('<!DOCTYPE html><html></html>')), false);
  assert.equal(isPdf(Buffer.from([0x50, 0x4b, 0x03, 0x04])), false);
  assert.equal(isPdf(Buffer.from('PDF-1.4 sem o percentual')), false);
  assert.equal(isPdf(Buffer.alloc(0)), false);
  assert.equal(isPdf(null), false);
  assert.equal(isPdf(undefined), false);
  // ArrayBuffer / Uint8Array / string também são aceitos
  assert.equal(isPdf(new Uint8Array(Buffer.from('%PDF-1.4')).buffer), true);
  assert.equal(isPdf(new Uint8Array(Buffer.from('%PDF-1.4'))), true);
  assert.equal(isPdf('%PDF-1.4'), true);
});

test('sniffType: pdf, html (inclusive com BOM/espaços/maiúsculas), zip/docx, texto, vazio e desconhecido', () => {
  assert.equal(sniffType(Buffer.from('%PDF-1.4 x')), T.PDF);

  assert.equal(sniffType(Buffer.from('<!DOCTYPE html>\n<html><body>x</body></html>')), T.HTML);
  assert.equal(sniffType(Buffer.from('  \r\n<HTML lang="es"><HEAD></HEAD></HTML>')), T.HTML);
  assert.equal(sniffType(Buffer.from('<head><title>x</title></head>')), T.HTML);
  assert.equal(sniffType(Buffer.from('<body>oi</body>')), T.HTML);
  assert.equal(sniffType(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html><p>x')])), T.HTML);
  assert.equal(sniffType(Buffer.from('<!-- comentário -->\n<html><body></body></html>')), T.HTML);

  // docx/xlsx/pptx/zip: "PK" + 03 04 (entrada), 05 06 (vazio) ou 07 08 (dividido)
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])), T.ZIP);
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])), T.ZIP);
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0])), T.ZIP);

  assert.equal(sniffType(Buffer.from('apenas um texto, ação e coração\nlinha 2\ttab')), T.TEXT);
  assert.equal(sniffType(Buffer.from('<nao-e-html>x</nao-e-html>')), T.TEXT);

  assert.equal(sniffType(Buffer.alloc(0)), T.EMPTY);
  assert.equal(sniffType(null), T.EMPTY);

  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), T.UNKNOWN); // PNG
  assert.equal(sniffType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), T.UNKNOWN); // doc/xls antigo (OLE)
  assert.equal(sniffType(Buffer.from([0x00, 0x01, 0x02, 0x03])), T.UNKNOWN);
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), T.UNKNOWN); // JPEG
});

test('sniffType: um PDF com "<html" depois do cabeçalho continua PDF; o rótulo cobre todos os tipos', () => {
  assert.equal(sniffType(Buffer.from('%PDF-1.4\n<html>')), T.PDF);
  for (const type of Object.values(T)) assert.equal(typeof TYPE_LABELS[type], 'string', type);
  assert.equal(TYPE_LABELS[T.HTML], 'HTML');
});
