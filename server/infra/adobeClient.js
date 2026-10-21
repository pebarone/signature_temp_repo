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
  async function createAgreement({ name, transientDocumentId, emails, externalId }) {
    const rsp = await http.post(`${rest}/agreements`, {
      name,
      fileInfos: [{ transientDocumentId }],
      participantSetsInfo: emails.map((email) => ({ role: 'SIGNER', order: 1, memberInfos: [{ email }] })),
      signatureType: 'ESIGN',
      state: 'IN_PROCESS',
      ...(externalId ? { externalId: { id: externalId } } : {})
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
    createTransientDocument, createAgreement, getAgreement, getAgreementEvents, downloadCombinedDocument, checkAuth
  };
}

module.exports = { createAdobeClient };
