// domain/agreementState.js
// Máquina de estados do acordo — pura, sem I/O. Cada função devolve um "patch" para o repositório.
//
// Etapas (reconciliationService): start (SendOn do pedido de firma) -> verify (SIGNED no Adobe) -> pdf (nova versão
// do documento) -> disposition (Firmado/Rechazado na tarefa de firma). Cada uma é idempotente e persistida.
//
// Fluxo OK:  pending -> signed -> pdf_delivered -> completed
// Demais finais: pending -> rejected | expired | cancelled (sendonDone marca a disposição entregue)
// needs_attention: exige intervenção (sem disposição configurada, sem workflowId, documentos apagados...)
// Cancelamento de fluxos: qualquer estado aberto -> cancelled por pedido (cancelRequestedPatch), sem disposição

const { KINDS } = require('./eventPolicy');

const STATES = {
  PENDING: 'pending',
  SIGNED: 'signed',
  PDF_DELIVERED: 'pdf_delivered',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  NEEDS_ATTENTION: 'needs_attention'
};

// dispositionKey aponta para config.dispositions
const FINAL_PLANS = {
  [KINDS.FINAL_OK]: { pdf: true, dispositionKey: 'signed', openState: STATES.SIGNED, doneState: STATES.COMPLETED },
  [KINDS.FINAL_REJECTED]: { pdf: false, dispositionKey: 'rejected', openState: STATES.REJECTED, doneState: STATES.REJECTED },
  [KINDS.FINAL_EXPIRED]: { pdf: false, dispositionKey: 'expired', openState: STATES.EXPIRED, doneState: STATES.EXPIRED },
  [KINDS.FINAL_RECALLED]: { pdf: false, dispositionKey: 'recalled', openState: STATES.CANCELLED, doneState: STATES.CANCELLED },
  [KINDS.FINAL_CONVERSION_FAILED]: {
    pdf: false, dispositionKey: 'conversionFailed', openState: STATES.CANCELLED, doneState: STATES.CANCELLED
  }
};

const planFor = (kind) => FINAL_PLANS[kind] || null;
const dispositionFor = (plan, dispositions) => (plan ? dispositions?.[plan.dispositionKey] || '' : '');

/*
  Registra um resultado final. Retorna null se deve ser ignorado (já concluído ou
  conflito com um final cujo PDF já foi entregue).
*/
function finalPatch(rec, kind, { nowIso, adobeStatus } = {}) {
  const plan = planFor(kind);
  if (!plan || rec.sendonDone) return null;
  if (rec.finalKind && rec.finalKind !== kind && rec.pdfDelivered) return null;
  const patch = {
    finalKind: kind,
    finalAt: rec.finalKind === kind && rec.finalAt ? rec.finalAt : nowIso,
    attentionReason: null,
    attentionKind: null,
    ...(rec.state === STATES.NEEDS_ATTENTION ? { attempts: 0, nextAttemptAt: null } : {}),
    state: kind === KINDS.FINAL_OK && rec.pdfDelivered ? STATES.PDF_DELIVERED : plan.openState
  };
  if (adobeStatus) patch.adobeStatus = adobeStatus;
  return patch;
}

// Tipos de needs_attention: só 'retries_exhausted' é reaberto sozinho (ATTENTION_RETRY_HOURS)
const ATTENTION_KINDS = {
  PERMANENT: 'permanent',
  RETRIES_EXHAUSTED: 'retries_exhausted',
  CONFIG: 'config',
  UNCONFIRMED: 'unconfirmed',
  EVENT: 'event'
};

const attentionPatch = (reason, kind = ATTENTION_KINDS.PERMANENT) => ({
  state: STATES.NEEDS_ATTENTION,
  attentionReason: reason,
  attentionKind: kind,
  nextAttemptAt: null
});

// Reabre um needs_attention (reconcile manual / reabertura automática): volta ao estado "aberto" e zera as tentativas.
// Sem resultado final (falha na etapa start) volta a pending.
function reopenPatch(rec) {
  const plan = planFor(rec.finalKind);
  return {
    state: !plan
      ? STATES.PENDING
      : (rec.finalKind === KINDS.FINAL_OK && rec.pdfDelivered ? STATES.PDF_DELIVERED : plan.openState),
    attentionReason: null,
    attentionKind: null,
    attempts: 0,
    nextAttemptAt: null
  };
}

// pdfNodeId: nó que recebeu o PDF final (nova versão do documento ou, no fallback, o documento criado na pasta)
const pdfDeliveredPatch = (nowIso, pdfNodeId = null) => ({
  pdfDelivered: true,
  pdfDeliveredAt: nowIso,
  pdfNodeId: pdfNodeId ? String(pdfNodeId) : null,
  state: STATES.PDF_DELIVERED,
  attempts: 0,
  lastError: null,
  lastErrorStage: null,
  nextAttemptAt: null
});

// externally: a tarefa de firma já estava concluída fora da integração (ex.: recuperação manual); nada foi enviado
const completedPatch = (plan, disposition, nowIso, { externally = false } = {}) => ({
  sendonDone: true,
  sendonAt: nowIso,
  disposition: externally ? null : disposition,
  completedExternally: !!externally,
  startSendonDone: true,
  state: plan.doneState,
  attentionReason: null,
  attentionKind: null,
  attempts: 0,
  lastError: null,
  lastErrorStage: null,
  nextAttemptAt: null
});

/*
  Acordo encerrado por PEDIDO DE CANCELAMENTO (ticket 2026060410003715; services/cancellationService.js), depois de o Adobe
  confirmar o cancelamento. Quem encerra o fluxo original no Content é o workflow de cancelamento: o AGREEMENT_RECALLED que
  o Adobe emite em seguida NÃO pode virar disposição (Rechazado) na tarefa de firma. sendonDone=true é o que garante isso:
  tira o acordo de listPending/listPollable, finalPatch devolve null, hasPendingWork é falso e reconcile devolve 'done'
  (mesmo precedente de completedExternally: o pipeline considera o acordo concluído sem enviar nada ao OTCS).
  Acordo cujo pipeline já havia concluído (sendonDone, p.ex. tarefa concluída fora da integração com o acordo ainda aberto
  no Adobe) só ganha a marca do pedido: estado e disposição já gravados são preservados.
*/
const cancelRequestedPatch = (rec, nowIso, { source = '', adobeStatus = 'CANCELLED' } = {}) => {
  const marks = { cancelRequestedAt: nowIso, cancelSource: source || null, adobeStatus };
  if (rec.sendonDone) return marks;
  return {
    ...marks,
    finalKind: rec.finalKind || KINDS.FINAL_RECALLED,
    finalAt: rec.finalAt || nowIso,
    sendonDone: true,
    sendonAt: nowIso,
    disposition: null,
    completedExternally: false,
    startSendonDone: true,
    state: STATES.CANCELLED,
    attentionReason: null,
    attentionKind: null,
    attempts: 0,
    lastError: null,
    lastErrorStage: null,
    nextAttemptAt: null
  };
};

// Backoff exponencial: base * 2^(attempts-1), limitado a max
function backoffDelay(attempts, { baseMs = 60 * 1000, maxMs = 60 * 60 * 1000 } = {}) {
  const n = Math.max(1, attempts);
  return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
}

// Só CLASSIFICA o erro HTTP 4xx (nome de disposição errado, tarefa já avançada, nó inexistente/reservado...); 401/408/429
// são transitórios. Não manda para needs_attention: decide se vale sondar o nó (PDF) ou conferir se a tarefa já foi
// concluída (disposição); em qualquer caso a falha retenta com backoff.
const isPermanentHttpError = (err) => {
  const status = err?.response?.status;
  return status >= 400 && status <= 499 && ![401, 408, 429].includes(status);
};

/*
  `attention` vem preenchido (motivo) quando não vale mais retentar: erro permanente ou
  `backoff.maxAttempts` atingido (0/ausente = sem limite).
*/
function failurePatch(rec, stage, message, nowMs, backoff, { permanent = false } = {}) {
  const attempts = (rec.attempts || 0) + 1;
  const delayMs = backoffDelay(attempts, backoff);
  const max = backoff?.maxAttempts || 0;
  let attention = null;
  let attentionKind = null;
  if (permanent) {
    attention = `error permanente en ${stage}: ${message}`;
    attentionKind = ATTENTION_KINDS.PERMANENT;
  } else if (max > 0 && attempts >= max) {
    attention = `reintentos agotados en ${stage} (${attempts}/${max}): ${message}`;
    attentionKind = ATTENTION_KINDS.RETRIES_EXHAUSTED;
  }
  return {
    delayMs,
    attention,
    attentionKind,
    patch: {
      attempts,
      lastError: message,
      lastErrorStage: stage,
      lastErrorAt: new Date(nowMs).toISOString(),
      nextAttemptAt: new Date(nowMs + delayMs).toISOString()
    }
  };
}

// Acordo aberto: sem resultado final e sem a disposição enviada (o mesmo critério de agreementRepository.openByWorkflow)
const isOpenAgreement = (rec) => !rec.finalKind && !rec.sendonDone;

// O que a página mostra quando o /start encontra o acordo do próprio fluxo já final (por kind)
const FINAL_NOTICES = {
  [KINDS.FINAL_OK]: 'Este documento ya fue firmado en Adobe Sign.',
  [KINDS.FINAL_REJECTED]: 'El firmante rechazó la solicitud de firma en Adobe Sign.',
  [KINDS.FINAL_EXPIRED]: 'La solicitud de firma expiró en Adobe Sign.',
  [KINDS.FINAL_RECALLED]: 'La solicitud de firma fue cancelada en Adobe Sign.',
  [KINDS.FINAL_CONVERSION_FAILED]: 'Adobe Sign no pudo procesar el documento (verifique que sea un PDF válido).'
};
const FINAL_NOTICE_FALLBACK = 'La solicitud de firma de este documento ya terminó en Adobe Sign.';

/*
  { kind, state, message } de um acordo que já tem resultado final (ou a disposição enviada); null se ainda está aberto.
  A frase final diz o que acontece com o fluxo: continua sozinho (pipeline pendente), já continuou (disposição enviada)
  ou precisa de revisão (needs_attention não se resolve sozinho).
*/
function finalNotice(rec) {
  if (!rec || isOpenAgreement(rec)) return null;
  const outcome = rec.state === STATES.NEEDS_ATTENTION
    ? 'El flujo requiere revisión del administrador.'
    : (rec.sendonDone ? 'El flujo ya continuó según el resultado.' : 'El flujo continuará automáticamente según el resultado.');
  return {
    kind: rec.finalKind || null,
    state: rec.state || null,
    message: `${FINAL_NOTICES[rec.finalKind] || FINAL_NOTICE_FALLBACK} ${outcome}`
  };
}

// Etapa start pendente: o pedido de firma ainda não foi enviado (SendOn da tarefa de início)
const isStartPending = (rec) => !rec.startSendonDone && !rec.sendonDone && !!rec.workflowId;

const hasPendingWork = (rec) => (!!rec.finalKind && !rec.sendonDone) || isStartPending(rec);

// Marca a etapa start como concluída (zera o contador só se a última falha era do próprio start ou uma exceção inesperada
// genérica 'reconcile', que também pode ter ocorrido antes do SendOn)
const startDonePatch = (rec, nowIso) => ({
  startSendonDone: true,
  startSendonAt: nowIso,
  startSendOnError: null,
  ...(['start', 'reconcile'].includes(rec.lastErrorStage)
    ? { attempts: 0, lastError: null, lastErrorStage: null, nextAttemptAt: null }
    : {})
});

const isDue = (rec, nowMs) => !rec.nextAttemptAt || Date.parse(rec.nextAttemptAt) <= nowMs;

// Candidato a runQueue: tem trabalho, não está em needs_attention e o backoff venceu
const isRetryable = (rec, nowMs) =>
  hasPendingWork(rec) && rec.state !== STATES.NEEDS_ATTENTION && isDue(rec, nowMs);

const DAY_MS = 24 * 60 * 60 * 1000;

// Candidato a polling: ainda sem resultado final conhecido. Além de maxAgeDays desde a criação deixa de ser consultado,
// salvo se o prazo do acordo no Adobe (expiresAt, DUE_DATE até 365 dias) ainda não passou há mais de 1 dia: com o webhook
// perdido, é o polling que vê o EXPIRED/SIGNED desse acordo.
function shouldPoll(rec, nowMs, maxAgeDays = 0) {
  if (rec.finalKind || rec.sendonDone || rec.state === STATES.NEEDS_ATTENTION) return false;
  if (maxAgeDays > 0 && rec.createdAt) {
    const age = nowMs - Date.parse(rec.createdAt);
    if (Number.isFinite(age) && age > maxAgeDays * DAY_MS) {
      const expiresMs = Date.parse(rec.expiresAt || '');
      return Number.isFinite(expiresMs) && nowMs <= expiresMs + DAY_MS;
    }
  }
  return true;
}

module.exports = {
  STATES, ATTENTION_KINDS, FINAL_PLANS, planFor, dispositionFor, finalPatch, attentionPatch, reopenPatch,
  pdfDeliveredPatch, completedPatch, cancelRequestedPatch, startDonePatch, backoffDelay, isPermanentHttpError, failurePatch,
  isStartPending, hasPendingWork, isDue, isRetryable, shouldPoll, isOpenAgreement, finalNotice
};
