// services/startDiscovery.js
// Rede de segurança do POST /start. O WebReport pede o envio logo depois de a página avançar a própria tarefa; se a
// página fechar ou a rede falhar, a tarefa de envio continua na caixa do usuário de integração. Aqui o servidor a procura
// (GET /v2/members/assignments) e roda o mesmo caminho do /start (signatureService.start com forceVerify).
// Fica fora do poller de propósito: o poller é desligado por POLL_ENABLED=false e esta rede deve continuar ativa.
// Desligada sem START_DISCOVERY_TASK_NAMES.
const { describeError } = require('../infra/util');
const { normalizeName } = require('../domain/workflowSteps');
const { ServiceError } = require('./signatureService');

const emptySummary = () => ({ seen: 0, eligible: 0, started: 0, existing: 0, errors: 0 });
const keyOf = ({ workflowId, subworkflowId, taskId }) => `${workflowId}|${subworkflowId}|${taskId}`;

function createStartDiscovery({ otcs, signatureService, config, logger, now = () => Date.now() }) {
  const cfg = config.startDiscovery || {};
  const wanted = new Set((cfg.taskNames || []).map(normalizeName).filter(Boolean));
  const enabled = wanted.size > 0;
  const firstSeen = new Map(); // chave -> instante em que a tarefa apareceu na caixa (carência)
  const skipUntil = new Map(); // chave -> não tentar antes deste instante (após erro; Infinity após sucesso ou acordo já aberto)
  let ticking = null;
  let interval = null;
  let first = null;

  async function runTick() {
    const summary = emptySummary();
    let assignments;
    try {
      assignments = await otcs.getAssignments();
    } catch (e) {
      summary.errors++;
      logger.warn(`[discovery] não foi possível ler a caixa do usuário de integração: ${describeError(e)}`);
      return summary;
    }

    // Só os nomes configurados (nome exato, normalizado); a mesma tarefa repetida na caixa conta uma vez
    const tasks = new Map();
    for (const a of Array.isArray(assignments) ? assignments : []) {
      if (wanted.has(normalizeName(a?.name))) tasks.set(keyOf(a), a);
    }
    summary.seen = tasks.size;

    // Tarefa que saiu da caixa é esquecida: se voltar, a carência e o intervalo de retry recomeçam
    for (const k of [...firstSeen.keys(), ...skipUntil.keys()]) {
      if (!tasks.has(k)) { firstSeen.delete(k); skipUntil.delete(k); }
    }
    const t = now();
    for (const k of tasks.keys()) {
      if (!firstSeen.has(k)) firstSeen.set(k, t);
    }

    for (const [k, { workflowId, subworkflowId }] of tasks) {
      if (now() - firstSeen.get(k) < cfg.graceMs) continue;
      if (now() < (skipUntil.get(k) ?? 0)) continue;
      summary.eligible++;
      try {
        const res = await signatureService.start({ workflowId, subworkflowId }, { forceVerify: true });
        // Criado agora ou já existente: não repete enquanto a tarefa estiver na caixa (a reconciliação cuida do SendOn)
        skipUntil.set(k, Infinity);
        if (res.existing) {
          summary.existing++;
          logger.info(`[discovery] Workflow ${workflowId}/${subworkflowId}: acordo ${res.id} já existente`);
        } else {
          summary.started++;
          logger.info(`[discovery] Workflow ${workflowId}/${subworkflowId}: pedido de assinatura criado (acordo ${res.id})`);
        }
      } catch (e) {
        summary.errors++;
        skipUntil.set(k, now() + cfg.retryMs);
        if (e instanceof ServiceError) {
          logger.warn(`[discovery] Workflow ${workflowId}/${subworkflowId}: HTTP ${e.status} | ${e.body?.error ?? ''}; nova tentativa em ${cfg.retryMs} ms`);
        } else {
          logger.error(`[discovery] Workflow ${workflowId}/${subworkflowId}: ${describeError(e)}; nova tentativa em ${cfg.retryMs} ms`);
        }
      }
    }
    return summary;
  }

  // Sem sobreposição: se há um tick em curso, devolve o mesmo. Nunca rejeita.
  function tick() {
    if (!enabled) return Promise.resolve(emptySummary());
    if (!ticking) {
      ticking = runTick()
        .catch((e) => {
          logger.error(`[discovery] tick falhou: ${describeError(e)}`);
          return emptySummary();
        })
        .finally(() => { ticking = null; });
    }
    return ticking;
  }

  // Devolve true se ligada. Desligada não agenda nada e não loga (o index.js registra o estado no startup)
  function start() {
    if (!enabled) return false;
    if (interval) return true;
    interval = setInterval(() => { tick(); }, cfg.intervalMs);
    interval.unref();
    first = setTimeout(() => { tick(); }, Math.min(cfg.intervalMs, 30000));
    first.unref();
    return true;
  }

  function stop() {
    if (interval) clearInterval(interval);
    if (first) clearTimeout(first);
    interval = null;
    first = null;
  }

  return { tick, start, stop };
}

module.exports = { createStartDiscovery };
