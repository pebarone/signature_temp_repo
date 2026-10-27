// infra/adobeClient.js
const FormData = require('form-data');
const { sleep: defaultSleep } = require('./util');

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
const REQUEST_TIMEOUT_MS = 60 * 1000;

/*
  Cliente fino da REST API v6 do Adobe Sign.
  - ensureToken: async () => access token válido
  - http: axios (injetável nos testes)
  - download: { attempts, delayMs, maxDelayMs } para o retry de 403 (race do Adobe pós-assinatura)
*/
function createAdobeClient({
  apiBase,
  ensureToken,
  http = require('axios'),
  sleep = defaultSleep,
  download = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  logger
}) {
  const attempts = Math.max(1, download.attempts ?? 8);
  const delayMs = download.delayMs ?? 3000;
  const maxDelayMs = download.maxDelayMs ?? 30000;
  const rest = `${apiBase}/api/rest/v6`;

  const authHeaders = async (extra = {}) => ({ Authorization: `Bearer ${await ensureToken()}`, ...extra });

  async function createTransientDocument(buffer, fileName) {
    const fd = new FormData();
    fd.append('File', buffer, { filename: fileName, contentType: 'application/pdf' });
    const rsp = await http.post(`${rest}/transientDocuments`, fd, {
      headers: await authHeaders(fd.getHeaders()),
      maxBodyLength: Infinity,
      timeout: timeoutMs
    });
    return rsp.data.transientDocumentId;
  }

  // externalId (opcional): referência ao workflow/documento do OTCS (ver domain/externalId.js)
  // expirationTime (opcional, ISO 8601): data limite para assinar; depois dela o Adobe expira o acordo (AGREEMENT_EXPIRED)
  async function createAgreement({ name, transientDocumentId, emails, externalId, expirationTime }) {
    const rsp = await http.post(`${rest}/agreements`, {
      name,
      fileInfos: [{ transientDocumentId }],
      participantSetsInfo: emails.map((email) => ({ role: 'SIGNER', order: 1, memberInfos: [{ email }] })),
      signatureType: 'ESIGN',
      state: 'IN_PROCESS',
      ...(externalId ? { externalId: { id: externalId } } : {}),
      ...(expirationTime ? { expirationTime } : {})
    }, { headers: await authHeaders(), timeout: timeoutMs });
    return rsp.data; // { id }
  }

  async function getAgreement(id) {
    const rsp = await http.get(`${rest}/agreements/${encodeURIComponent(id)}`, {
      headers: await authHeaders(),
      timeout: timeoutMs
    });
    return rsp.data;
  }

  // Histórico do acordo (distingue recusa de cancelamento quando o status é CANCELLED)
  async function getAgreementEvents(id) {
    const rsp = await http.get(`${rest}/agreements/${encodeURIComponent(id)}/events`, {
      headers: await authHeaders(),
      timeout: timeoutMs
    });
    return rsp.data?.events || [];
  }

  /*
    Cancela (recall) um acordo em andamento: PUT /agreements/{agreementId}/state (escopo agreement_write, já pedido).
    Corpo da API v6 do Acrobat Sign: { state: 'CANCELLED', agreementCancellationInfo: { comment, notifyOthers } }.
    Referência: API Reference v6 > Agreements > "PUT /agreements/{agreementId}/state"
    (https://secure.na1.adobesign.com/public/docs/restapi/v6); estados em
    https://developer.adobe.com/acrobat-sign/docs/overview/techblog/tldr/api-agreement-statuses.
    notifyOthers: avisa os demais participantes do cancelamento (o `comment` aparece no aviso). O cancelamento é definitivo
    e o Adobe depois emite AGREEMENT_RECALLED (webhook). Qualquer 2xx vale como confirmado; erros HTTP sobem ao chamador.
  */
  async function cancelAgreement(id, { comment = '', notifyOthers = false } = {}) {
    const rsp = await http.put(`${rest}/agreements/${encodeURIComponent(id)}/state`, {
      state: 'CANCELLED',
      agreementCancellationInfo: { comment: String(comment ?? ''), notifyOthers: !!notifyOthers }
    }, { headers: await authHeaders(), timeout: timeoutMs });
    return rsp.data;
  }

  /*
    Baixa o PDF final (com relatório de auditoria). Retry limitado e *aguardado* em 403;
    qualquer outro erro (ou esgotadas as tentativas) é propagado.
  */
  async function downloadCombinedDocument(id, { attachAuditReport = true } = {}) {
    const url = `${rest}/agreements/${encodeURIComponent(id)}/combinedDocument?attachAuditReport=${attachAuditReport}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const rsp = await http.get(url, {
          responseType: 'arraybuffer',
          headers: await authHeaders(),
          maxContentLength: MAX_PDF_BYTES,
          timeout: timeoutMs
        });
        const buf = Buffer.from(rsp.data);
        if (!buf.length || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new Error('Adobe devolvió un contenido que no es un PDF');
        }
        return buf;
      } catch (e) {
        if (e.response?.status === 403 && attempt < attempts) {
          const wait = Math.min(maxDelayMs, delayMs * 2 ** (attempt - 1));
          logger?.warn(`Adobe 403 al descargar ${id} (intento ${attempt}/${attempts}); reintento en ${wait} ms`);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  }

  // Lança se não houver token válido (usado pelo /start para responder LOGIN_REQUIRED)
  const checkAuth = () => ensureToken();

  return {
    createTransientDocument, createAgreement, getAgreement, getAgreementEvents, cancelAgreement, downloadCombinedDocument,
    checkAuth
  };
}

module.exports = { createAdobeClient };
