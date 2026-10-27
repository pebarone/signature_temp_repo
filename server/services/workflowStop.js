// services/workflowStop.js
// Para (stop) um fluxo no Content Server de forma idempotente. Usado pelo cancelamento (CANCEL_STOP_ORIGINAL / modo direto)
// e pelo acordo expirado (EXPIRED_STOP_WORKFLOW).
const { describeError } = require('../infra/util');
const { isProcessFinishedStatus } = require('../domain/cancellation');

const httpStatus = (e) => e?.response?.status;

/*
  createWorkflowStopper({ otcs, logger, tag }) -> stopWorkflow(workflowId). `tag` é o prefixo dos logs (ex.: '[CANCEL]').
  Devolve 'stopped', 'already_stopped' (o stop falhou, mas o estado relido mostra o processo parado/concluído/arquivado:
  sucesso idempotente) ou { failed: true, httpStatus } (qualquer erro, inclusive 400/401/403 = sem permissão; sem saber o
  estado, falha).
*/
function createWorkflowStopper({ otcs, logger, tag }) {
  return async function stopWorkflow(workflowId) {
    try {
      await otcs.stopProcess(workflowId);
      return 'stopped';
    } catch (e) {
      logger.error(`${tag} Flujo ${workflowId}: no se pudo detener el flujo original en Content Server: ${describeError(e)}`);
      try {
        const { status } = await otcs.getProcessStatus(workflowId);
        if (isProcessFinishedStatus(status)) {
          logger.warn(`${tag} Flujo ${workflowId}: el flujo original ya estaba detenido/concluido en Content Server (estado "${status}")`);
          return 'already_stopped';
        }
        logger.error(`${tag} Flujo ${workflowId}: el flujo original sigue activo en Content Server (estado "${status}")`);
      } catch (re) {
        logger.error(`${tag} Flujo ${workflowId}: tampoco se pudo leer el estado del flujo original: ${describeError(re)}`);
      }
      return { failed: true, httpStatus: httpStatus(e) };
    }
  };
}

module.exports = { createWorkflowStopper };
