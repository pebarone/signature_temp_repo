// domain/externalId.js
// externalId do acordo no Adobe: liga o acordo ao workflow/documento do Content Server.
// Formato: otcs|wf=<workflowId>|sub=<subworkflowId>|node=<nodeId>|attach=<attachId>[|sig=<hex>]
// Permite adotar um acordo desconhecido (banco perdido) e rastrear o acordo na UI do Adobe.
// O `sig` é um HMAC dos quatro IDs: o externalId é texto livre no Adobe e qualquer usuário da conta poderia forjá-lo;
// a adoção automática (webhook) só aceita o que o /start assinou com SIGNATURE_SECRET.

const crypto = require('node:crypto');

const PREFIX = 'otcs';
// Prefixo de domínio próprio: o canônico nunca colide com o `v2\n...` do /start (mesmo segredo, outro propósito).
const SIG_DOMAIN = 'otcs-ext-v1';
const SIG_HEX_LEN = 32; // 128 bits
const clean = (v) => String(v ?? '').replace(/[|=\s]/g, '');
const isId = (v) => /^\d+$/.test(String(v ?? ''));

// sub não numérico/ausente vale wf (igual ao parse), para build -> parse -> verify fechar para qualquer entrada.
const effectiveSub = (wf, sub) => (isId(sub) ? sub : wf);

function signIds(secret, { workflowId, subworkflowId, nodeId, attachId }) {
  const canonical = [SIG_DOMAIN, workflowId, subworkflowId, nodeId, attachId].join('\n');
  return crypto.createHmac('sha256', String(secret)).update(canonical).digest('hex').slice(0, SIG_HEX_LEN);
}

function buildExternalId({ workflowId, subworkflowId, nodeId, attachId }, secret) {
  const wf = clean(workflowId);
  const sub = clean(subworkflowId);
  const node = clean(nodeId);
  const attach = clean(attachId);
  const parts = [PREFIX, `wf=${wf}`, `sub=${sub}`, `node=${node}`, `attach=${attach}`];
  if (secret) {
    parts.push(`sig=${signIds(secret, { workflowId: wf, subworkflowId: effectiveSub(wf, sub), nodeId: node, attachId: attach })}`);
  }
  return parts.join('|');
}

/*
  Devolve { workflowId, subworkflowId, nodeId, attachId, sig } ou null se não for um externalId nosso
  ou se faltar algum dado essencial (wf, node e attach numéricos; sub, se ausente, vale wf).
  `sig` é a assinatura informada (string) ou null; use verifyExternalId para validá-la.
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
    subworkflowId: effectiveSub(kv.wf, kv.sub),
    nodeId: kv.node,
    attachId: kv.attach,
    sig: typeof kv.sig === 'string' && kv.sig ? kv.sig : null
  };
}

// true só se `parsed` (saída de parseExternalId) traz uma assinatura válida para `secret`. Nunca lança.
function verifyExternalId(parsed, secret) {
  try {
    if (!parsed || !secret || typeof parsed.sig !== 'string') return false;
    if (parsed.sig.length !== SIG_HEX_LEN || !/^[0-9a-fA-F]+$/.test(parsed.sig)) return false;
    const expected = Buffer.from(signIds(secret, parsed), 'utf8');
    const got = Buffer.from(parsed.sig.toLowerCase(), 'utf8');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

module.exports = { buildExternalId, parseExternalId, verifyExternalId, isId };
