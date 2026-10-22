// domain/cancellation.js
// Cancelamento de fluxos (ticket 2026060410003715) — funções puras, sem I/O:
//   - classifyCancelState: o estado do acordo no Adobe permite pedir o cancelamento?
//   - selectCancelTarget: qual acordo do workflow deve ser cancelado (nunca o de outro subprocesso).

const { KINDS, classifyAgreementStatus } = require('./eventPolicy');

const CANCEL_STATES = {
  CANCELABLE: 'cancelable',                 // em andamento: pode pedir o cancelamento
  ALREADY_CANCELLED: 'already_cancelled',   // idempotente: nada a pedir ao Adobe
  SIGNED: 'signed',                         // concluído: não se cancela
  NOT_CANCELABLE: 'not_cancelable'          // expirado, abortado por erro, estado desconhecido...
};

/*
  O Adobe v6 devolve CANCELLED para o acordo cancelado (ou recusado por um signatário). A documentação de estados trata
  CANCELLED como legado do ABORTED (ambos terminais; https://developer.adobe.com/acrobat-sign/docs/overview/techblog/tldr/api-agreement-statuses),
  então os dois valem como "já cancelado": o objetivo (acordo fora do ar, sem lembretes) já está cumprido.
*/
function classifyCancelState(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'CANCELLED' || s === 'ABORTED') return CANCEL_STATES.ALREADY_CANCELLED;
  if (s === 'SIGNED') return CANCEL_STATES.SIGNED;
  if (classifyAgreementStatus(s) === KINDS.PROGRESS) return CANCEL_STATES.CANCELABLE;
  return CANCEL_STATES.NOT_CANCELABLE;
}

const TARGET = {
  NONE: 'none',               // nenhum acordo conhecido para o workflow
  OPEN: 'open',               // exatamente um acordo aberto: é o alvo
  AMBIGUOUS: 'ambiguous',     // vários abertos (sem subprocesso que desempate): não cancela nenhum
  CANCELLED: 'cancelled',     // o mais recente já foi encerrado por pedido de cancelamento (repetição idempotente)
  CLOSED: 'closed'            // o mais recente já concluiu por outro caminho (assinado, recusado...): nada a cancelar
};

// Aberto = o pipeline ainda não o encerrou (sem sendonDone). Inclui needs_attention e os que já têm resultado final
// pendente de entrega: o Adobe diz se ainda dá para cancelar.
const isOpenAgreement = (rec) => !rec.sendonDone;

const newestFirst = (a, b) =>
  String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id));

/*
  `records`: acordos do workflow (já filtrados por subprocesso, se pedido). Devolve { kind, record } ou
  { kind: AMBIGUOUS, records }. Sem acordo aberto, o mais recente decide: encerrado por cancelamento => repetição
  idempotente (CANCELLED); concluído por outro caminho => CLOSED (um reenvio posterior que já foi assinado não pode
  ser "cancelado" só porque um acordo anterior foi).
*/
function selectCancelTarget(records) {
  const list = [...(Array.isArray(records) ? records : [])].sort(newestFirst);
  if (!list.length) return { kind: TARGET.NONE };
  const open = list.filter(isOpenAgreement);
  if (open.length === 1) return { kind: TARGET.OPEN, record: open[0] };
  if (open.length > 1) return { kind: TARGET.AMBIGUOUS, records: open };
  const latest = list[0];
  return { kind: latest.cancelRequestedAt ? TARGET.CANCELLED : TARGET.CLOSED, record: latest };
}

module.exports = { CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget, isOpenAgreement };
