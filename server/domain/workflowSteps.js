// domain/workflowSteps.js
// Localiza tarefas de um workflow do Content Server pelo NOME — puro, sem I/O.
// Entrada: step_list normalizado { current: [], completed: [], next: [] } com itens
// { processId, subprocessId, taskId, name, status } (ver otcsClient.getProcessSteps).

// "Aguardar Firma" == "  aguardar   FIRMA " == "Aguardár Firma"
const normalizeName = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

// O nome normalizado COMEÇA com algum dos nomes (tolera sufixos como "(Empleado y/o Firmante 2)")
function matchesTask(name, names) {
  const n = normalizeName(name);
  if (!n) return false;
  return (Array.isArray(names) ? names : [names])
    .map(normalizeName)
    .filter(Boolean)
    .some((candidate) => n.startsWith(candidate));
}

// Entre vários candidatos: o do subprocesso indicado; senão o de maior subprocessId (o mais recente)
function pick(candidates, subprocessHint) {
  if (candidates.length <= 1) return candidates[0] || null;
  const hint = subprocessHint === undefined || subprocessHint === null ? '' : String(subprocessHint);
  if (hint) {
    const hinted = candidates.filter((t) => String(t.subprocessId) === hint);
    if (hinted.length) return hinted.reduce((a, b) => (b.subprocessId > a.subprocessId ? b : a));
  }
  return candidates.reduce((a, b) => ((b.subprocessId || 0) > (a.subprocessId || 0) ? b : a));
}

/*
  Onde está a tarefa: 'current' (prioridade) > 'completed' > 'next'; 'absent' se nenhuma lista a tem.
  Devolve { where, task } (task é null quando absent).
*/
function locate(stepList, names, { subprocessHint } = {}) {
  for (const where of ['current', 'completed', 'next']) {
    const matches = (stepList?.[where] || []).filter((t) => matchesTask(t.name, names));
    const task = pick(matches, subprocessHint);
    if (task) return { where, task };
  }
  return { where: 'absent', task: null };
}

module.exports = { normalizeName, matchesTask, locate };
