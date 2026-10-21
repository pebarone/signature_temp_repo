// domain/agreementState.js
// Máquina de estados do acordo — pura, sem I/O. Cada função devolve um "patch" para o repositório.
//
// Fluxo OK:  pending -> signed -> pdf_delivered -> completed
// Demais finais: pending -> rejected | expired | cancelled (sendonDone marca a disposição entregue)
// needs_attention: exige intervenção (sem disposição configurada, sem workflowId, documentos apagados...)

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
    state: kind === KINDS.FINAL_OK && rec.pdfDelivered ? STATES.PDF_DELIVERED : plan.openState
  };
  if (adobeStatus) patch.adobeStatus = adobeStatus;
  return patch;
}

const attentionPatch = (reason) => ({
  state: STATES.NEEDS_ATTENTION,
  attentionReason: reason,
  nextAttemptAt: null
});

// Reabre um final em needs_attention (reconcile manual): volta ao estado "aberto" e zera as tentativas
function reopenPatch(rec) {
  const plan = planFor(rec.finalKind);
  return {
    state: rec.finalKind === KINDS.FINAL_OK && rec.pdfDelivered ? STATES.PDF_DELIVERED : plan.openState,
    attentionReason: null,
    attempts: 0,
    nextAttemptAt: null
  };
}

const pdfDeliveredPatch = (nowIso) => ({
  pdfDelivered: true,
  pdfDeliveredAt: nowIso,
  state: STATES.PDF_DELIVERED,
  attempts: 0,
  lastError: null,
  lastErrorStage: null,
  nextAttemptAt: null
});

const completedPatch = (plan, disposition, nowIso) => ({
  sendonDone: true,
  sendonAt: nowIso,
  disposition,
  state: plan.doneState,
  attentionReason: null,
  attempts: 0,
  lastError: null,
  lastErrorStage: null,
  nextAttemptAt: null
});

// Backoff exponencial: base * 2^(attempts-1), limitado a max
function backoffDelay(attempts, { baseMs = 60 * 1000, maxMs = 60 * 60 * 1000 } = {}) {
  const n = Math.max(1, attempts);
  return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
}

// Erro HTTP 4xx permanente (nome de disposição errado, task já avançada...); 401/408/429 são transitórios
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
  if (permanent) attention = `error permanente en ${stage}: ${message}`;
  else if (max > 0 && attempts >= max) attention = `reintentos agotados en ${stage} (${attempts}/${max}): ${message}`;
  return {
    delayMs,
    attention,
    patch: {
      attempts,
      lastError: message,
      lastErrorStage: stage,
      lastErrorAt: new Date(nowMs).toISOString(),
      nextAttemptAt: new Date(nowMs + delayMs).toISOString()
    }
  };
}

const hasPendingWork = (rec) => !!rec.finalKind && !rec.sendonDone;

const isDue = (rec, nowMs) => !rec.nextAttemptAt || Date.parse(rec.nextAttemptAt) <= nowMs;

// Candidato a runQueue: tem trabalho, não está em needs_attention e o backoff venceu
const isRetryable = (rec, nowMs) =>
  hasPendingWork(rec) && rec.state !== STATES.NEEDS_ATTENTION && isDue(rec, nowMs);

// Candidato a polling: ainda sem resultado final conhecido
function shouldPoll(rec, nowMs, maxAgeDays = 0) {
  if (rec.finalKind || rec.sendonDone || rec.state === STATES.NEEDS_ATTENTION) return false;
  if (maxAgeDays > 0 && rec.createdAt) {
    const age = nowMs - Date.parse(rec.createdAt);
    if (Number.isFinite(age) && age > maxAgeDays * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

module.exports = {
  STATES, FINAL_PLANS, planFor, dispositionFor, finalPatch, attentionPatch, reopenPatch, pdfDeliveredPatch,
  completedPatch, backoffDelay, isPermanentHttpError, failurePatch, hasPendingWork, isDue, isRetryable, shouldPoll
};
