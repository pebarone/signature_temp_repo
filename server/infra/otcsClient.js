// infra/otcsClient.js
const FormData = require('form-data');
const qs = require('qs');

/*
  Cliente do OpenText Content Server. Credenciais/base vêm da config; http é injetável.
*/
function createOtcsClient({
  base, user, pass, http = require('axios'), now = () => Date.now(), timeoutMs = 60 * 1000
}) {
  let ticket = '';
  let expiresAt = 0;
  let inflight = null;

  async function login() {
    const rsp = await http.post(
      `${base}/v1/auth`,
      { username: user, password: pass },
      { headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }
    );
    ticket = rsp.data.ticket || rsp.data.otdsToken;
    expiresAt = now() + (rsp.data.validFor || 1800) * 1000;
    return ticket;
  }

  async function ensureTicket() {
    if (ticket && now() < expiresAt - 30_000) return ticket;
    if (!inflight) inflight = login().finally(() => { inflight = null; });
    return inflight;
  }

  // 401 (ticket expirado/revogado antes do validFor): descarta o ticket e repete a chamada uma vez com login novo
  async function withTicket(fn) {
    const tck = await ensureTicket();
    try {
      return await fn(tck);
    } catch (e) {
      if (e.response?.status !== 401) throw e;
      if (ticket === tck) { ticket = ''; expiresAt = 0; } // outro request pode já ter renovado
      return fn(await ensureTicket());
    }
  }

  const downloadNode = (nodeId, version = 1) => withTicket(async (tck) => {
    const rsp = await http.get(`${base}/v1/nodes/${nodeId}/versions/${version}/content`, {
      responseType: 'arraybuffer',
      headers: { OTCSTicket: tck },
      timeout: timeoutMs
    });
    return rsp.data; // Buffer com o PDF
  });

  const uploadToFolder = (folderId, buffer, fileName) => withTicket(async (tck) => {
    // 1. Verifica se já existe um documento com mesmo nome na pasta
    const existing = await http.get(
      `${base}/v1/nodes/${folderId}/nodes?where_name=${encodeURIComponent(fileName)}`,
      { headers: { OTCSTicket: tck }, timeout: timeoutMs }
    );
    const existingDoc = existing.data?.data?.find((n) => n.name === fileName && n.type === 144);

    const fd = new FormData();
    fd.append('file', buffer, { filename: fileName, contentType: 'application/pdf' });

    if (existingDoc) {
      // 2. Adiciona como nova versão
      const rsp = await http.post(`${base}/v1/nodes/${existingDoc.id}/versions`, fd, {
        headers: { ...fd.getHeaders(), OTCSTicket: tck },
        timeout: timeoutMs,
        maxBodyLength: Infinity
      });
      return rsp.data;
    }

    // 3. Cria novo documento
    fd.append('parent_id', folderId);
    fd.append('type', '144');
    fd.append('name', fileName);
    fd.append('resource', JSON.stringify({ name: fileName }));
    const rsp = await http.post(`${base}/v1/nodes`, fd, {
      headers: { ...fd.getHeaders(), OTCSTicket: tck },
      timeout: timeoutMs,
      maxBodyLength: Infinity
    });
    return rsp.data;
  });

  const sendOnWorkflow = ({ workflowId, subworkflowId, taskId = 2, disposition = '', comment = '' }) => withTicket(async (tck) => {
    const url = `${base}/v2/processes/${workflowId}/subprocesses/${subworkflowId}/tasks/${taskId}`;

    // Só um parâmetro: action OU custom_action (disposition)
    const dataObj = disposition
      ? { custom_action: disposition, ...(comment && { comment }) }
      : { action: 'sendon', ...(comment && { comment }) };

    const rsp = await http.put(url, qs.stringify(dataObj), {
      headers: { OTCSTicket: tck, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: timeoutMs
    });
    return rsp.data;
  });

  return { ensureTicket, downloadNode, uploadToFolder, sendOnWorkflow };
}

module.exports = { createOtcsClient };
