// domain/cancellation.js
// Cancelamento de fluxos (ticket 2026060410003715) — funções puras, sem I/O:
//   - classifyCancelState: o estado do acordo no Adobe permite pedir o cancelamento?
//   - selectCancelTarget: qual acordo do workflow deve ser cancelado (nunca o de outro subprocesso).
//   - parseTargets: lê os IDs dos fluxos a cancelar (lista, escalar ou texto separado) do formulário da tarefa.
//   - classifyCancelOutcome: recusa definitiva ou pendência transitória de um item do lote.
//   - countSignatures: assinaturas já concluídas por participantes no histórico do Adobe (aviso de firma parcial).

const { KINDS, classifyAgreementStatus, canonicalName } = require('./eventPolicy');

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
const isCancellable = (rec) => !rec.sendonDone;

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
  const open = list.filter(isCancellable);
  if (open.length === 1) return { kind: TARGET.OPEN, record: open[0] };
  if (open.length > 1) return { kind: TARGET.AMBIGUOUS, records: open };
  const latest = list[0];
  return { kind: latest.cancelRequestedAt ? TARGET.CANCELLED : TARGET.CLOSED, record: latest };
}

/*
  Alvos do lote (atributo multivalor do formulário). `raw` pode ser lista (multivalor do forms API), escalar ou texto
  separado por vírgula, ponto e vírgula, espaço ou quebra de linha (também dentro de cada item da lista). Duplicados saem
  (ordem preservada). Devolve { ids, invalid, overLimit }: ids numéricos, valores não numéricos (sem repetir) e se há
  mais de `max` ids (sem max, nunca estoura). Só decide a forma; quem recusa é o serviço (422).
*/
function parseTargets(raw, { max = Infinity } = {}) {
  const items = Array.isArray(raw) ? raw : [raw];
  const ids = [];
  const invalid = [];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    for (const token of String(item).split(/[\s,;]+/)) {
      if (!token) continue;
      const bucket = /^\d+$/.test(token) ? ids : invalid;
      if (!bucket.includes(token)) bucket.push(token);
    }
  }
  return { ids, invalid, overLimit: ids.length > max };
}

// Recusa definitiva: repetir não muda o resultado (o Adobe/o registro já decidiram).
const REFUSED_CODES = new Set([
  'ALREADY_SIGNED', 'ALREADY_REJECTED', 'AGREEMENT_CLOSED', 'NOT_CANCELABLE', 'AMBIGUOUS',
  'AGREEMENT_NOT_FOUND', 'AGREEMENT_NOT_FOUND_IN_ADOBE'
]);

/*
  Resultado de um item do lote que NÃO foi cancelado, pelo código de erro do serviço: 'refused' (definitivo) ou
  'pending' (transitório: ADOBE_UNAVAILABLE, RECONCILE_IN_PROGRESS, IN_PROGRESS, BUDGET_EXCEEDED, erro inesperado e
  qualquer código desconhecido; repetir pode resolver).
*/
const classifyCancelOutcome = (serviceErrorCode) =>
  (REFUSED_CODES.has(String(serviceErrorCode || '').toUpperCase()) ? 'refused' : 'pending');

/*
  Eventos do histórico (GET /agreements/{id}/events) que contam como assinatura concluída de UM participante:
  SIGNED e WORKFLOW_COMPLETED são o acordo inteiro e ficam de fora. Entram ESIGNED, DIGSIGNED
  e a conclusão de ação do participante (ACTION_COMPLETED, PARTICIPANT_*, DOCUMENT_SIGNED: os mesmos que o eventPolicy
  trata como AGREEMENT_ACTION_COMPLETED), com ou sem o prefixo AGREEMENT_. Eventos do remetente (participantRole SENDER),
  criação, envio, visualização e lembretes não contam.
*/
const PARTICIPANT_SIGNED_TYPES = new Set(['ESIGNED', 'DIGSIGNED', 'ACTION_COMPLETED']);

const bareType = (type) => String(type || '').trim().toUpperCase().replace(/^AGREEMENT_/, '');

function isParticipantSigned(event) {
  const role = String(event?.participantRole || '').trim().toUpperCase();
  if (role === 'SENDER') return false;
  const type = String(event?.type || event?.eventType || '').trim().toUpperCase();
  if (!type) return false;
  return PARTICIPANT_SIGNED_TYPES.has(bareType(type)) || canonicalName(type) === 'AGREEMENT_ACTION_COMPLETED';
}

/*
  Assinaturas já concluídas no histórico: { signedCount, lastSignedAt }. O mesmo participante costuma gerar mais de um
  evento (ESIGNED e ACTION_COMPLETED): com e-mail, conta uma vez por pessoa; sem identificação, vale o maior número de
  eventos de um mesmo tipo (nunca soma tipos diferentes). `lastSignedAt` = data mais recente (string do Adobe) ou null.
  Isto NÃO é a conclusão do acordo inteiro (SIGNED), que vem do status do acordo.
*/
function countSignatures(events) {
  const people = new Set();
  const anonymousByType = {};
  let lastSignedAt = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!isParticipantSigned(e)) continue;
    const who = String(e.participantEmail || e.actingUserEmail || '').trim().toLowerCase();
    if (who) {
      people.add(who);
    } else {
      const type = bareType(e.type || e.eventType);
      anonymousByType[type] = (anonymousByType[type] || 0) + 1;
    }
    const date = e.date || e.eventDate || e.createdDate || null;
    if (date && (!lastSignedAt || Date.parse(date) > Date.parse(lastSignedAt))) lastSignedAt = String(date);
  }
  const anonymous = Math.max(0, ...Object.values(anonymousByType));
  return { signedCount: people.size + anonymous, lastSignedAt };
}

/*
  O processo do Content já está parado/concluído/arquivado? `status` é wf_details.status de
  GET /v2/workflows/status/processes/{id} (texto livre na spec do OTCS). VALIDAR NO QA os valores reais devolvidos para um
  processo parado (a spec só lista, para os filtros, workflowlate/ontime/completed/stopped); aqui basta o texto conter
  stop/complet/archiv. Status vazio ou desconhecido => false (não se sabe: o stop é tratado como falha).
*/
const isProcessFinishedStatus = (status) => /stop|complet|archiv/i.test(String(status || ''));

module.exports = {
  isProcessFinishedStatus,
  CANCEL_STATES, TARGET, classifyCancelState, selectCancelTarget, isCancellable,
  parseTargets, classifyCancelOutcome, countSignatures, isParticipantSigned
};
