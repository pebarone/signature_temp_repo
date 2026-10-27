// Prazo da assinatura (atributo DUE_DATE): interpretação do valor e data limite — domínio puro.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDueDays, expirationFrom } = require('../server/domain/dueDate');

test('parseDueDays: inteiro de 1 a 365, como número ou texto ("15", " 15 ", "15.0")', () => {
  for (const v of [15, '15', ' 15 ', '15.0', 15.0, '1', 365, '365', '015']) {
    const days = Number(String(v).trim());
    assert.deepEqual(parseDueDays(v), { days }, String(v));
  }
});

test('parseDueDays: vazio/ausente => sem prazo e sem aviso; o resto é inválido', () => {
  for (const v of [undefined, null, '', '   ']) assert.deepEqual(parseDueDays(v), { days: null }, String(v));
  for (const v of ['abc', '15 dias', '0', 0, '-5', -5, '15.5', 15.5, '366', 400, '1e2', NaN, Infinity, '1,5', {}]) {
    assert.deepEqual(parseDueDays(v), { days: null, invalid: true }, String(v));
  }
});

test('expirationFrom: agora + N dias em ISO 8601 (UTC)', () => {
  const t0 = new Date('2026-10-01T12:00:00.000Z');
  assert.equal(expirationFrom(t0, 15), '2026-10-16T12:00:00.000Z');
  assert.equal(expirationFrom(t0, 1), '2026-10-02T12:00:00.000Z');
  assert.equal(t0.toISOString(), '2026-10-01T12:00:00.000Z', 'não altera a data recebida');
});
