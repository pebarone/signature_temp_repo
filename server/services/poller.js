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

  // Tentativa sem resultado (a consulta ou o histórico falhou) também conta para a ordem: senão um acordo que falha sempre
  // (404/403 permanente) fica no topo e, com maxPerTick deles, os demais nunca são consultados
  function markAttempt(id) {
    try {
      repo.upsert(id, { lastPolledAt: now().toISOString() });
    } catch (e) {
      logger.warn(`[poll] ${id}: no se pudo registrar el intento de consulta: ${describeError(e)}`);
    }
  }

  // O polling achou o resultado final e o acordo nunca recebeu um webhook (de nenhum tipo): sinal de webhook inativo ou mal
  // configurado no Adobe. Um aviso só por acordo (depois do final ele deixa de ser consultado); consulta barata, só um EXISTS.
  function warnIfNoWebhook(id) {
    try {
      if (typeof repo.hasEventFrom !== 'function' || repo.hasEventFrom(id, 'webhook')) return;
      logger.warn(
        `[${id}] resultado final detectado sólo por polling: ningún webhook recibido para este acuerdo (¿webhook inactivo en Adobe?)`
      );
    } catch (e) {
      logger.warn(`[poll] ${id}: no se pudo comprobar si hubo webhook: ${describeError(e)}`);
    }
  }

  async function runTick() {
    const summary = { polled: 0, finalized: 0, errors: 0, retried: 0, reopened: 0 };
    const t = now().getTime();

    // needs_attention por tentativas esgotadas volta à fila depois de ATTENTION_RETRY_HOURS
    summary.reopened = await reopen();

    // Mais antigos sem consulta primeiro, limitado por tick
    const candidates = repo
      .listPollable()
      .filter((r) => shouldPoll(r, t, poll.maxAgeDays))
      .sort((a, b) => String(a.lastPolledAt || '').localeCompare(String(b.lastPolledAt || '')))
      .slice(0, poll.maxPerTick || 50);

    for (const rec of candidates) {
      try {
        const ag = await adobe.getAgreement(rec.id);
        summary.polled++;
        const kind = await processor.handleStatus(rec.id, ag.status);
        if (kind === null) markAttempt(rec.id); // histórico ilegível: nada foi gravado
        if (isFinalKind(kind)) {
          summary.finalized++;
          logger.info(`[poll] ${rec.id}: estado Adobe ${ag.status} -> ${kind}`);
          warnIfNoWebhook(rec.id);
        }
      } catch (e) {
        summary.errors++;
        logger.warn(`[poll] ${rec.id}: ${describeError(e)}`);
        markAttempt(rec.id);
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

  // Reabre needs_attention antigos por tentativas esgotadas (o runQueue os reprocessa); nunca rejeita
  async function reopen() {
    if (typeof processor.reopenStale !== 'function') return 0;
    try {
      return (await processor.reopenStale()).length;
    } catch (e) {
      logger.error(`[poll] reopenStale falló: ${describeError(e)}`);
      return 0;
    }
  }

  // Sem sobreposição: se há um tick em curso, devolve o mesmo
  function tick() {
    if (!ticking) ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  // Só a fila persistida (retries com backoff), sem consultar o Adobe; sem sobreposição
  let draining = null;
  function drainQueue() {
    if (!draining) draining = reopen().then(() => processor.runQueue()).finally(() => { draining = null; });
    return draining;
  }

  function start() {
    const enabled = Boolean(poll.enabled);
    if (interval) return enabled;
    /*
      Desligado, o polling de status não roda, mas a fila de retries continua sendo revisada a cada
      POLL_INTERVAL_MS: os timers de retry vivem em memória e se perdem num restart durante o backoff.
    */
    const safe = enabled
      ? () => tick().catch((e) => logger.error(`[poll] tick falló: ${describeError(e)}`))
      : () => drainQueue().catch((e) => logger.error(`[poll] runQueue falló: ${describeError(e)}`));
    interval = setInterval(safe, poll.intervalMs);
    interval.unref();
    first = setTimeout(safe, poll.initialDelayMs ?? 30000);
    first.unref();
    logger.info(enabled
      ? `Polling de reconciliación activo: cada ${poll.intervalMs} ms`
      : `Polling de reconciliación desactivado (POLL_ENABLED=false); cola de reintentos revisada cada ${poll.intervalMs} ms`);
    return enabled;
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
