// domain/externalId.js
// externalId do acordo no Adobe: liga o acordo ao workflow/documento do Content Server.
// Formato: otcs|wf=<workflowId>|sub=<subworkflowId>|node=<nodeId>|attach=<attachId>
// Permite adotar um acordo desconhecido (banco perdido) e rastrear o acordo na UI do Adobe.

const PREFIX = 'otcs';
const clean = (v) => String(v ?? '').replace(/[|=\s]/g, '');
const isId = (v) => /^\d+$/.test(String(v ?? ''));

function buildExternalId({ workflowId, subworkflowId, nodeId, attachId }) {
  return [
    PREFIX,
    `wf=${clean(workflowId)}`,
    `sub=${clean(subworkflowId)}`,
    `node=${clean(nodeId)}`,
    `attach=${clean(attachId)}`
  ].join('|');
}

/*
  Devolve { workflowId, subworkflowId, nodeId, attachId } ou null se não for um externalId nosso
  ou se faltar algum dado essencial (wf, node e attach numéricos; sub, se ausente, vale wf).
*/
function parseExternalId(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('|');
  if (parts[0] !== PREFIX) return null;
  const kv = {};
  for (const part of parts.slice(1)) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  if (!isId(kv.wf) || !isId(kv.node) || !isId(kv.attach)) return null;
  return {
    workflowId: kv.wf,
    subworkflowId: isId(kv.sub) ? kv.sub : kv.wf,
    nodeId: kv.node,
    attachId: kv.attach
  };
}

module.exports = { buildExternalId, parseExternalId, isId };
