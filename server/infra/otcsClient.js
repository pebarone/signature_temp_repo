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

  // Sem `version`: conteúdo da versão MAIS RECENTE do nó (/content); com `version`: aquela versão
  const downloadNode = (nodeId, version) => withTicket(async (tck) => {
    const url = version === undefined || version === null
      ? `${base}/v1/nodes/${nodeId}/content`
      : `${base}/v1/nodes/${nodeId}/versions/${version}/content`;
    const rsp = await http.get(url, {
      responseType: 'arraybuffer',
      headers: { OTCSTicket: tck },
      timeout: timeoutMs
    });
    return rsp.data; // Buffer com o PDF
  });

  const deliveryMarker = (agreementId) => agreementId ? `Adobe Sign: ${agreementId}` : '';

  // O marcador remoto fecha a janela entre o OTCS aplicar a escrita e o SQLite confirmar pdfDelivered.
  // Lista todas as versões (v1, sem paginação), pois outra versão pode ter sido adicionada durante o retry.
  async function addVersionWithTicket(tck, nodeId, buffer, fileName, marker) {
    if (marker) {
      const versions = await http.get(`${base}/v1/nodes/${nodeId}/versions`, {
        headers: { OTCSTicket: tck }, timeout: timeoutMs
      });
      if (!Array.isArray(versions.data?.data)) throw new Error('Respuesta inválida al consultar las versiones del documento');
      const delivered = versions.data.data.find((v) => v.description === marker);
      if (delivered) return delivered;
    }
    const fd = new FormData();
    fd.append('file', buffer, { filename: fileName, contentType: 'application/pdf' });
    if (marker) fd.append('description', marker);
    const rsp = await http.post(`${base}/v1/nodes/${nodeId}/versions`, fd, {
      headers: { ...fd.getHeaders(), OTCSTicket: tck },
      timeout: timeoutMs,
      maxBodyLength: Infinity
    });
    return rsp.data;
  }

  const uploadToFolder = (folderId, buffer, fileName, { agreementId } = {}) => withTicket(async (tck) => {
    const marker = deliveryMarker(agreementId);
    // 1. Verifica se já existe um documento com mesmo nome na pasta
    const existing = await http.get(
      `${base}/v1/nodes/${folderId}/nodes?where_name=${encodeURIComponent(fileName)}`,
      { headers: { OTCSTicket: tck }, timeout: timeoutMs }
    );
    const existingDoc = existing.data?.data?.find((n) => n.name === fileName && n.type === 144);

    if (existingDoc) {
      // Criação anterior confirmada no servidor, mas com resposta perdida.
      if (marker && existingDoc.description === marker) return { id: existingDoc.id };
      const version = await addVersionWithTicket(tck, existingDoc.id, buffer, fileName, marker);
      return { ...version, id: existingDoc.id };
    }

    // 3. Cria novo documento
    const fd = new FormData();
    fd.append('file', buffer, { filename: fileName, contentType: 'application/pdf' });
    fd.append('parent_id', folderId);
    fd.append('type', '144');
    fd.append('name', fileName);
    fd.append('resource', JSON.stringify({ name: fileName }));
    if (marker) fd.append('description', marker);
    const rsp = await http.post(`${base}/v1/nodes`, fd, {
      headers: { ...fd.getHeaders(), OTCSTicket: tck },
      timeout: timeoutMs,
      maxBodyLength: Infinity
    });
    return rsp.data;
  });

  // Nova versão de um documento existente (o nó é o mesmo: o workflow/distribuição passa a ver o PDF assinado)
  const addVersion = (nodeId, buffer, fileName, { agreementId } = {}) => withTicket((tck) =>
    addVersionWithTicket(tck, nodeId, buffer, fileName, deliveryMarker(agreementId)));

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

  /*
    Tarefas do processo: GET /v2/workflows/status/processes/{id} => results.step_list.{current,completed,next}[].
    Normaliza para { current, completed, next } com itens { processId, subprocessId, taskId, name, status }.
  */
  const toStep = (s) => ({
    processId: Number(s.process_id),
    subprocessId: Number(s.subprocess_id),
    taskId: Number(s.task_id),
    name: String(s.task_name ?? ''),
    status: s.task_status === undefined || s.task_status === null ? '' : String(s.task_status)
  });
  const getProcessSteps = (processId) => withTicket(async (tck) => {
    const rsp = await http.get(`${base}/v2/workflows/status/processes/${encodeURIComponent(processId)}`, {
      headers: { OTCSTicket: tck },
      timeout: timeoutMs
    });
    const list = rsp.data?.results?.step_list || rsp.data?.step_list || {};
    const out = {};
    for (const where of ['current', 'completed', 'next']) {
      out[where] = (Array.isArray(list[where]) ? list[where] : []).map(toStep);
    }
    return out;
  });

  /*
    Caixa do usuário de integração: GET /v2/members/assignments (sem paginação na spec). Cada item de results[] traz
    data.assignments (objeto por item; aceita também array). Só tarefas de workflow (type 153) com workflow_id numérico.
    Subprocesso ausente => o próprio workflow (no fluxo puro WORKID == SUBWORKID). => [{ workflowId, subworkflowId, taskId, name }]
  */
  const toId = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) : null);
  const getAssignments = () => withTicket(async (tck) => {
    const rsp = await http.get(`${base}/v2/members/assignments`, {
      headers: { OTCSTicket: tck },
      timeout: timeoutMs
    });
    const out = [];
    for (const result of Array.isArray(rsp.data?.results) ? rsp.data.results : []) {
      const raw = result?.data?.assignments;
      for (const a of Array.isArray(raw) ? raw : [raw]) {
        const workflowId = toId(a?.workflow_id);
        if (Number(a?.type) !== 153 || workflowId === null) continue;
        out.push({
          workflowId,
          subworkflowId: toId(a.workflow_subworkflow_id) ?? workflowId,
          taskId: toId(a.workflow_subworkflow_task_id),
          name: String(a.name ?? '')
        });
      }
    }
    return out;
  });

  /*
    Formulário de uma tarefa: GET /v1/forms/processes/tasks/update?process_id=&subprocess_id=&task_id=.
    => { title, customActions: [chaves das disposições], fields: { [rótulo do atributo]: { key, value } } }.
  */
  const getTaskForm = (processId, subprocessId, taskId) => withTicket(async (tck) => {
    const rsp = await http.get(`${base}/v1/forms/processes/tasks/update`, {
      params: { process_id: processId, subprocess_id: subprocessId, task_id: taskId },
      headers: { OTCSTicket: tck },
      timeout: timeoutMs
    });
    const body = rsp.data || {};
    const data = body.data || body.results?.data || {};
    const fields = {};
    for (const form of Array.isArray(body.forms) ? body.forms : []) {
      for (const [key, value] of Object.entries(form?.data || {})) {
        const label = form.schema?.properties?.[key]?.title || form.options?.fields?.[key]?.label;
        if (label) fields[label] = { key, value };
      }
    }
    return {
      title: data.title || '',
      customActions: (Array.isArray(data.custom_actions) ? data.custom_actions : [])
        .map((a) => (typeof a === 'string' ? a : a?.key))
        .filter(Boolean),
      fields
    };
  });

  /*
    Atualiza atributos de uma tarefa em andamento: PUT .../tasks/{t} com body={"action":"formUpdate","values":{...}}.
    Fora da spec oficial (fóruns da OpenText); ainda não validado em QA => usado só com WF_ATTRIBUTES_ENABLED.
  */
  const updateTaskForm = (processId, subprocessId, taskId, values) => withTicket(async (tck) => {
    const url = `${base}/v2/processes/${processId}/subprocesses/${subprocessId}/tasks/${taskId}`;
    const body = qs.stringify({ body: JSON.stringify({ action: 'formUpdate', values }) });
    const rsp = await http.put(url, body, {
      headers: { OTCSTicket: tck, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: timeoutMs
    });
    return rsp.data;
  });

  return {
    ensureTicket, downloadNode, uploadToFolder, addVersion, sendOnWorkflow, getProcessSteps, getAssignments, getTaskForm, updateTaskForm
  };
}

module.exports = { createOtcsClient };
