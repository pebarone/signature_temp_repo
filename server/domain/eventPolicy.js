// domain/eventPolicy.js
// Funções puras: classificam eventos de webhook e estados do acordo Adobe Sign (API v6).

const KINDS = {
  FINAL_OK: 'final_ok',
  FINAL_REJECTED: 'final_rejected',
  FINAL_EXPIRED: 'final_expired',
  FINAL_RECALLED: 'final_recalled',
  FINAL_CONVERSION_FAILED: 'final_conversion_failed',
  NEEDS_ATTENTION: 'needs_attention',
  PROGRESS: 'progress',
  INFO: 'info',
  IGNORED: 'ignored',
  UNKNOWN: 'unknown'
};

const FINAL_KINDS = new Set([
  KINDS.FINAL_OK, KINDS.FINAL_REJECTED, KINDS.FINAL_EXPIRED,
  KINDS.FINAL_RECALLED, KINDS.FINAL_CONVERSION_FAILED
]);
const isFinalKind = (kind) => FINAL_KINDS.has(kind);

const BY_EVENT = {
  AGREEMENT_WORKFLOW_COMPLETED: KINDS.FINAL_OK,
  AGREEMENT_REJECTED: KINDS.FINAL_REJECTED,
  AGREEMENT_EXPIRED: KINDS.FINAL_EXPIRED,
  AGREEMENT_RECALLED: KINDS.FINAL_RECALLED,
  AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM: KINDS.FINAL_CONVERSION_FAILED,
  AGREEMENT_DOCUMENTS_DELETED: KINDS.NEEDS_ATTENTION
};

// Só histórico
const INFO_EVENTS = new Set([
  'AGREEMENT_CREATED', 'AGREEMENT_ACTION_REQUESTED', 'AGREEMENT_MODIFIED',
  'AGREEMENT_EMAIL_VIEWED', 'AGREEMENT_REMINDER_SENT', 'AGREEMENT_SIGNER_NAME_CHANGED_BY_SIGNER'
]);

// Indisponíveis no Adobe (marcados em vermelho): aceitos e ignorados
const IGNORED_EVENTS = new Set([
  'AGREEMENT_VAULTED', 'AGREEMENT_KBA_AUTHENTICATED', 'AGREEMENT_WEB_IDENTITY_AUTHENTICATED'
]);

// Nomes legados (não existem no v6): alias compatível
const LEGACY_ALIASES = {
  AGREEMENT_COMPLETED: 'AGREEMENT_WORKFLOW_COMPLETED',
  AGREEMENT_SIGNED: 'AGREEMENT_WORKFLOW_COMPLETED',
  DOCUMENT_SIGNED: 'AGREEMENT_ACTION_COMPLETED'
};

function canonicalName(eventName) {
  const n = String(eventName || '').trim().toUpperCase();
  if (!n) return 'UNKNOWN_EVENT';
  if (LEGACY_ALIASES[n]) return LEGACY_ALIASES[n];
  if (n.startsWith('PARTICIPANT_')) return 'AGREEMENT_ACTION_COMPLETED';
  return n;
}

function classifyEvent(eventName, payload) {
  const canonical = canonicalName(eventName);
  if (canonical === 'UNKNOWN_EVENT') return { kind: KINDS.UNKNOWN, canonical };

  if (canonical === 'AGREEMENT_ACTION_COMPLETED') {
    const status = String(payload?.agreement?.status || '').toUpperCase();
    return { kind: status === 'SIGNED' ? KINDS.FINAL_OK : KINDS.PROGRESS, canonical };
  }
  if (BY_EVENT[canonical]) return { kind: BY_EVENT[canonical], canonical };
  if (INFO_EVENTS.has(canonical)) return { kind: KINDS.INFO, canonical };
  if (IGNORED_EVENTS.has(canonical)) return { kind: KINDS.IGNORED, canonical };
  return { kind: KINDS.UNKNOWN, canonical };
}

const PROGRESS_STATUSES = new Set([
  'OUT_FOR_SIGNATURE', 'OUT_FOR_DELIVERY', 'OUT_FOR_ACCEPTANCE', 'OUT_FOR_FORM_FILLING',
  'OUT_FOR_APPROVAL', 'AUTHORING', 'DRAFT', 'IN_PROCESS', 'PREFILL', 'WAITING_FOR_AUTHORING',
  'WAITING_FOR_MY_SIGNATURE', 'WAITING_FOR_OTHERS', 'WAITING_FOR_FAXING', 'WAITING_FOR_PREFILL'
]);

// Estado do acordo (GET /agreements/{id}) usado pelo polling.
// Obs.: no v6 uma recusa aparece como CANCELLED (o evento AGREEMENT_REJECTED só vem pelo webhook).
function classifyAgreementStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'SIGNED') return KINDS.FINAL_OK;
  if (s === 'CANCELLED') return KINDS.FINAL_RECALLED;
  if (s === 'EXPIRED') return KINDS.FINAL_EXPIRED;
  if (s === 'ABORTED') return KINDS.NEEDS_ATTENTION;
  if (PROGRESS_STATUSES.has(s)) return KINDS.PROGRESS;
  return KINDS.UNKNOWN;
}

/*
  Extrai os campos relevantes do payload do webhook (formato v6; tolera o formato antigo
  em que `event` era um objeto).
*/
function parseWebhookPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ev = p.event;
  const evObj = ev && typeof ev === 'object' ? ev : {};
  return {
    agreementId: p.agreement?.id || evObj.agreementId || p.agreementId || null,
    eventName: (typeof ev === 'string' ? ev : evObj.eventType) || p.eventType || p.type || 'UNKNOWN_EVENT',
    notificationId: p.webhookNotificationId || null,
    webhookId: p.webhookId || null,
    eventDate: p.eventDate || evObj.eventDate || null,
    participant: p.participantUserEmail || evObj.participantUserEmail || null,
    status: p.agreement?.status || null,
    payload: p
  };
}

module.exports = {
  KINDS, isFinalKind, canonicalName, classifyEvent, classifyAgreementStatus, parseWebhookPayload
};
