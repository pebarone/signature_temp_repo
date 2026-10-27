// domain/dueDate.js
// Prazo da assinatura: o atributo (oculto) DUE_DATE do workflow traz um número inteiro de dias. Puro, sem I/O.
// O Adobe é dono do prazo: o /start só calcula a data limite e a manda na criação do acordo (expirationTime).

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/*
  Interpreta o valor do atributo. Aceita 15, "15", " 15 " e "15.0"; devolve { days } com um inteiro entre 1 e 365.
  Vazio/ausente => { days: null } (sem aviso: o atributo simplesmente não foi preenchido). Qualquer outra coisa (texto,
  0, negativo, fracionário como 15.5, acima de 365) => { days: null, invalid: true }, para quem chama avisar no log.
*/
function parseDueDays(value) {
  if (value === undefined || value === null) return { days: null };
  const text = String(value).trim();
  if (!text) return { days: null };
  if (!/^\d+(\.0+)?$/.test(text)) return { days: null, invalid: true };
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return { days: null, invalid: true };
  return { days };
}

// Data limite (ISO 8601, UTC) = agora + dias
const expirationFrom = (nowDate, days) => new Date(nowDate.getTime() + days * DAY_MS).toISOString();

module.exports = { parseDueDays, expirationFrom, MIN_DAYS, MAX_DAYS };
