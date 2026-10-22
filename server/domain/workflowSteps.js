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

const WHERES = ['current', 'completed', 'next'];

// Ids distintos (ordem numérica) dos subprocessos de uma lista de candidatos { where, task }
function distinctSubprocesses(candidates) {
  const byKey = new Map();
  for (const c of candidates) byKey.set(String(c.task.subprocessId), c.task.subprocessId);
  return [...byKey.values()].sort((a, b) => Number(a) - Number(b));
}

/*
  Onde está a tarefa: 'current' (prioridade) > 'completed' > 'next'; 'absent' se nenhuma lista a tem.
  Devolve { where, task } (task é null quando não há tarefa utilizável).

  A tarefa NUNCA é de outro subprocesso que o do acordo: o step_list do pai traz as tarefas de todos os subprocessos
  (inclusive os já encerrados, em 'completed'). Por isso os candidatos de todas as listas são juntados antes de escolher:
    - subprocessHint presente entre os candidatos => só os dele (prioridade current > completed > next);
    - dica de um subprocesso real (diferente do pai) sem candidato próprio => { where: 'absent', elsewhere: [subprocessos] };
    - sem dica, ou dica = o próprio pai (WebReport antigo manda WFID nos dois campos; adoção sem subworkflowId grava o
      pai): vale o único subprocesso que tem a tarefa; com vários => { where: 'ambiguous', subprocesses: [...] },
      salvo `latest` (o mais recente, na lista de maior prioridade: aceitável quando a tarefa vira o acordo, como no /start).
  processId: o pai (padrão: o processId da primeira tarefa do step_list).
*/
function locate(stepList, names, { subprocessHint, processId, latest = false } = {}) {
  const candidates = [];
  for (const where of WHERES) {
    for (const task of stepList?.[where] || []) {
      if (matchesTask(task.name, names)) candidates.push({ where, task });
    }
  }
  const hint = String(subprocessHint ?? '').trim();

  const hinted = candidates.filter((c) => String(c.task.subprocessId) === hint);
  if (hint && hinted.length) return { where: hinted[0].where, task: hinted[0].task };

  const firstTask = WHERES.flatMap((w) => stepList?.[w] || [])[0];
  const parent = String(processId ?? '').trim() || String(firstTask?.processId ?? '').trim();
  if (hint && hint !== parent) {
    return { where: 'absent', task: null, elsewhere: distinctSubprocesses(candidates) };
  }

  const subprocesses = distinctSubprocesses(candidates);
  if (!subprocesses.length) return { where: 'absent', task: null };
  if (subprocesses.length === 1) return { where: candidates[0].where, task: candidates[0].task };
  if (!latest) return { where: 'ambiguous', task: null, subprocesses };
  const top = candidates.filter((c) => c.where === candidates[0].where);
  const chosen = top.reduce((a, b) => ((b.task.subprocessId || 0) > (a.task.subprocessId || 0) ? b : a));
  return { where: chosen.where, task: chosen.task };
}

module.exports = { normalizeName, matchesTask, locate };
