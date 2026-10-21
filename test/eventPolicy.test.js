const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KINDS, isFinalKind, canonicalName, classifyEvent, classifyAgreementStatus, classifyCancelled,
  confirmsFinalKind, parseWebhookPayload
} = require('../server/domain/eventPolicy');

const kindOf = (event, status) => classifyEvent(event, { agreement: { status } }).kind;

test('tabela de política: eventos finais', () => {
  assert.equal(kindOf('AGREEMENT_WORKFLOW_COMPLETED'), KINDS.FINAL_OK);
  assert.equal(kindOf('AGREEMENT_REJECTED'), KINDS.FINAL_REJECTED);
  assert.equal(kindOf('AGREEMENT_EXPIRED'), KINDS.FINAL_EXPIRED);
  assert.equal(kindOf('AGREEMENT_RECALLED'), KINDS.FINAL_RECALLED);
  assert.equal(kindOf('AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM'), KINDS.FINAL_CONVERSION_FAILED);
  for (const k of [KINDS.FINAL_OK, KINDS.FINAL_REJECTED, KINDS.FINAL_EXPIRED, KINDS.FINAL_RECALLED, KINDS.FINAL_CONVERSION_FAILED]) {
    assert.equal(isFinalKind(k), true);
  }
});

test('AGREEMENT_ACTION_COMPLETED: final OK só se agreement.status === SIGNED', () => {
  assert.equal(kindOf('AGREEMENT_ACTION_COMPLETED', 'SIGNED'), KINDS.FINAL_OK);
  assert.equal(kindOf('AGREEMENT_ACTION_COMPLETED', 'signed'), KINDS.FINAL_OK);
  assert.equal(kindOf('AGREEMENT_ACTION_COMPLETED', 'OUT_FOR_SIGNATURE'), KINDS.PROGRESS);
  assert.equal(classifyEvent('AGREEMENT_ACTION_COMPLETED', {}).kind, KINDS.PROGRESS);
  assert.equal(classifyEvent('AGREEMENT_ACTION_COMPLETED', undefined).kind, KINDS.PROGRESS);
});

test('AGREEMENT_DOCUMENTS_DELETED marca needs_attention', () => {
  assert.equal(kindOf('AGREEMENT_DOCUMENTS_DELETED'), KINDS.NEEDS_ATTENTION);
  assert.equal(isFinalKind(KINDS.NEEDS_ATTENTION), false);
});

test('eventos informativos: só histórico', () => {
  for (const e of [
    'AGREEMENT_CREATED', 'AGREEMENT_ACTION_REQUESTED', 'AGREEMENT_MODIFIED',
    'AGREEMENT_EMAIL_VIEWED', 'AGREEMENT_REMINDER_SENT', 'AGREEMENT_SIGNER_NAME_CHANGED_BY_SIGNER'
  ]) {
    assert.equal(kindOf(e), KINDS.INFO, e);
  }
});

test('eventos em vermelho (indisponíveis): aceitos e ignorados', () => {
  for (const e of ['AGREEMENT_VAULTED', 'AGREEMENT_KBA_AUTHENTICATED', 'AGREEMENT_WEB_IDENTITY_AUTHENTICATED']) {
    assert.equal(kindOf(e), KINDS.IGNORED, e);
  }
});

test('aliases legados', () => {
  assert.equal(canonicalName('AGREEMENT_COMPLETED'), 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(canonicalName('AGREEMENT_SIGNED'), 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(canonicalName('DOCUMENT_SIGNED'), 'AGREEMENT_ACTION_COMPLETED');
  assert.equal(canonicalName('PARTICIPANT_COMPLETED'), 'AGREEMENT_ACTION_COMPLETED');
  assert.equal(canonicalName('PARTICIPANT_SIGNED'), 'AGREEMENT_ACTION_COMPLETED');
  assert.equal(canonicalName('participant_whatever'), 'AGREEMENT_ACTION_COMPLETED');

  assert.equal(kindOf('AGREEMENT_COMPLETED'), KINDS.FINAL_OK);
  assert.equal(kindOf('AGREEMENT_SIGNED'), KINDS.FINAL_OK);
  assert.equal(kindOf('DOCUMENT_SIGNED', 'OUT_FOR_SIGNATURE'), KINDS.PROGRESS);
  assert.equal(kindOf('DOCUMENT_SIGNED', 'SIGNED'), KINDS.FINAL_OK);
  assert.equal(kindOf('PARTICIPANT_COMPLETED', 'OUT_FOR_SIGNATURE'), KINDS.PROGRESS);
  assert.equal(kindOf('PARTICIPANT_COMPLETED', 'SIGNED'), KINDS.FINAL_OK);
});

test('evento desconhecido ou vazio', () => {
  assert.equal(kindOf('AGREEMENT_SOMETHING_NEW'), KINDS.UNKNOWN);
  assert.equal(classifyEvent('', {}).kind, KINDS.UNKNOWN);
  assert.equal(classifyEvent(undefined, {}).kind, KINDS.UNKNOWN);
  assert.equal(classifyEvent(' agreement_expired ', {}).kind, KINDS.FINAL_EXPIRED);
});

test('classifyAgreementStatus (polling)', () => {
  assert.equal(classifyAgreementStatus('SIGNED'), KINDS.FINAL_OK);
  assert.equal(classifyAgreementStatus('CANCELLED'), KINDS.FINAL_RECALLED);
  assert.equal(classifyAgreementStatus('EXPIRED'), KINDS.FINAL_EXPIRED);
  assert.equal(classifyAgreementStatus('ABORTED'), KINDS.NEEDS_ATTENTION);
  assert.equal(classifyAgreementStatus('OUT_FOR_SIGNATURE'), KINDS.PROGRESS);
  assert.equal(classifyAgreementStatus('WHATEVER'), KINDS.UNKNOWN);
  assert.equal(classifyAgreementStatus(undefined), KINDS.UNKNOWN);
});

test('classifyCancelled: evento REJECTED/ACTION_REJECTED => recusa; senão recall', () => {
  assert.equal(classifyCancelled([{ type: 'CREATED' }, { type: 'REJECTED' }]), KINDS.FINAL_REJECTED);
  assert.equal(classifyCancelled([{ type: 'ACTION_REJECTED' }]), KINDS.FINAL_REJECTED);
  assert.equal(classifyCancelled([{ eventType: 'action_rejected' }]), KINDS.FINAL_REJECTED);
  assert.equal(classifyCancelled([{ type: 'CREATED' }, { type: 'CANCELLED' }]), KINDS.FINAL_RECALLED);
  assert.equal(classifyCancelled([]), KINDS.FINAL_RECALLED);
  assert.equal(classifyCancelled(undefined), KINDS.FINAL_RECALLED);
  assert.equal(classifyAgreementStatus('CANCELLED', [{ type: 'REJECTED' }]), KINDS.FINAL_REJECTED);
});

test('parseWebhookPayload: formato v6 (event string, id em agreement.id)', () => {
  const p = parseWebhookPayload({
    webhookId: 'w', webhookNotificationId: 'n1', event: 'AGREEMENT_WORKFLOW_COMPLETED',
    eventDate: '2026-06-22T12:00:00Z', participantUserEmail: 'x@y.z',
    agreement: { id: 'AG', status: 'SIGNED' }
  });
  assert.equal(p.agreementId, 'AG');
  assert.equal(p.eventName, 'AGREEMENT_WORKFLOW_COMPLETED');
  assert.equal(p.notificationId, 'n1');
  assert.equal(p.status, 'SIGNED');
  assert.equal(p.participant, 'x@y.z');
});

test('confirmsFinalKind: o Adobe confirma o resultado pedido; CANCELLED depende dos eventos (ou só do status gravado)', () => {
  assert.equal(confirmsFinalKind(KINDS.FINAL_OK, 'SIGNED'), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_OK, 'CANCELLED', []), false);
  assert.equal(confirmsFinalKind(KINDS.FINAL_OK, 'OUT_FOR_SIGNATURE'), false);
  assert.equal(confirmsFinalKind(KINDS.FINAL_OK, undefined), false);
  assert.equal(confirmsFinalKind(KINDS.FINAL_EXPIRED, 'EXPIRED'), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_REJECTED, 'CANCELLED', [{ type: 'REJECTED' }]), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_RECALLED, 'CANCELLED', [{ type: 'REJECTED' }]), false, 'recusa não é recall');
  assert.equal(confirmsFinalKind(KINDS.FINAL_RECALLED, 'CANCELLED', []), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_REJECTED, 'SIGNED'), false);
  // status gravado sem histórico: CANCELLED vale para recusa e recall
  assert.equal(confirmsFinalKind(KINDS.FINAL_REJECTED, 'CANCELLED'), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_RECALLED, 'CANCELLED'), true);
  // falha de conversão: CANCELLED (com ou sem recusa) e ABORTED
  assert.equal(confirmsFinalKind(KINDS.FINAL_CONVERSION_FAILED, 'CANCELLED', [{ type: 'REJECTED' }]), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_CONVERSION_FAILED, 'ABORTED'), true);
  assert.equal(confirmsFinalKind(KINDS.FINAL_CONVERSION_FAILED, 'EXPIRED'), false);
});

test('parseWebhookPayload: tolera o formato antigo e payload inválido', () => {
  const old = parseWebhookPayload({ event: { eventType: 'AGREEMENT_REJECTED', agreementId: 'OLD' } });
  assert.equal(old.agreementId, 'OLD');
  assert.equal(old.eventName, 'AGREEMENT_REJECTED');
  const empty = parseWebhookPayload(null);
  assert.equal(empty.agreementId, null);
  assert.equal(empty.eventName, 'UNKNOWN_EVENT');
});
