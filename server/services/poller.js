// services/poller.js
// Rede de segurança do webhook: consulta periodicamente o Adobe para acordos sem resultado final
// e reprocessa pendências (PDF entregue sem disposição, retries vencidos).
const { isFinalKind } = require('../domain/eventPolicy');
const { shouldPoll } = require('../domain/agreementState');
const { describeError } = require('../infra/util');

function createPoller({ repo, adobe, processor, config, logger, now = () => new Date() }) {
  const poll = config.poll || {};
  let ticking = null;
  let interval = null;
  let first = null;

  async function runTick() {
    const summary = { polled: 0, finalized: 0, errors: 0, retried: 0 };
    const t = now().getTime();

    // Mais antigos sem consulta primeiro, limitado por tick
    const candidates = repo
      .list((r) => shouldPoll(r, t, poll.maxAgeDays))
      .sort((a, b) => String(a.lastPolledAt || '').localeCompare(String(b.lastPolledAt || '')))
      .slice(0, poll.maxPerTick || 50);

    for (const rec of candidates) {
      try {
        const ag = await adobe.getAgreement(rec.id);
        summary.polled++;
        const kind = await processor.handleStatus(rec.id, ag.status);
        if (isFinalKind(kind)) {
          summary.finalized++;
          logger.info(`[poll] ${rec.id}: estado Adobe ${ag.status} -> ${kind}`);
        }
      } catch (e) {
        summary.errors++;
        logger.warn(`[poll] ${rec.id}: ${describeError(e)}`);
      }
    }

    try {
      summary.retried = (await processor.runQueue()).length;
    } catch (e) {
      summary.errors++;
      logger.error(`[poll] runQueue falló: ${describeError(e)}`);
    }
    return summary;
  }

  // Sem sobreposição: se há um tick em curso, devolve o mesmo
  function tick() {
    if (!ticking) ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  function start() {
    if (!poll.enabled) {
      logger.info('Polling de reconciliación desactivado (POLL_ENABLED=false)');
      return false;
    }
    if (interval) return true;
    const safe = () => tick().catch((e) => logger.error(`[poll] tick falló: ${describeError(e)}`));
    interval = setInterval(safe, poll.intervalMs);
    interval.unref();
    first = setTimeout(safe, poll.initialDelayMs ?? 30000);
    first.unref();
    logger.info(`Polling de reconciliación activo: cada ${poll.intervalMs} ms`);
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

module.exports = { createPoller };
