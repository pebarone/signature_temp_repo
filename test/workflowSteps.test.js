const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, matchesTask, locate } = require('../server/domain/workflowSteps');
const { buildExternalId, parseExternalId } = require('../server/domain/externalId');

const step = (subprocessId, taskId, name, status = '') => ({ processId: 100, subprocessId, taskId, name, status });

test('normalizeName: sem acentos, minúsculas, espaços colapsados e trim', () => {
  assert.equal(normalizeName('  Aguardár   FIRMA '), 'aguardar firma');
  assert.equal(normalizeName('Enviar solicitud de firma (Empleado y/o Firmante 2)'),
    'enviar solicitud de firma (empleado y/o firmante 2)');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});

test('matchesTask: o nome normalizado COMEÇA com algum dos nomes', () => {
  assert.equal(matchesTask('Aguardar Firma', ['Aguardar Firma']), true);
  assert.equal(matchesTask('AGUARDAR  firma (Empleado)', ['aguardar firma']), true);
  assert.equal(matchesTask('Enviar solicitud de firma (Empleado y/o Firmante 2)', ['Enviar solicitud de firma']), true);
  assert.equal(matchesTask('Firmado?', ['Aguardar Firma']), false);
  assert.equal(matchesTask('Re-aguardar firma', ['Aguardar Firma']), false, 'começa com, não contém');
  assert.equal(matchesTask('Firmado?', ['Aguardar Firma', 'Firmado']), true);
  assert.equal(matchesTask('', ['Aguardar Firma']), false);
  assert.equal(matchesTask('Qualquer', ['', '  ']), false, 'nomes vazios nunca casam');
  assert.equal(matchesTask('Aguardar Firma', 'aguardar'), true, 'aceita string simples');
});

test('locate: prioriza current > completed > next e devolve absent quando não há', () => {
  const stepList = {
    current: [step(7, 3, 'Aguardar Firma')],
    completed: [step(7, 2, 'Enviar solicitud de firma (Empleado y/o Firmante 2)'), step(5, 3, 'Aguardar Firma')],
    next: [step(7, 4, 'Firmado?')]
  };
  // dica = subprocesso 7: a tarefa do 5 (completed) é de outro subprocesso e não entra
  const hint = { subprocessHint: 7 };
  assert.deepEqual(locate(stepList, ['Aguardar Firma'], hint), { where: 'current', task: stepList.current[0] });
  assert.equal(locate(stepList, ['Enviar solicitud de firma'], hint).where, 'completed');
  assert.equal(locate(stepList, ['Firmado'], hint).where, 'next');
  assert.deepEqual(locate(stepList, ['Activación']), { where: 'absent', task: null });
  assert.deepEqual(locate({}, ['Aguardar Firma']), { where: 'absent', task: null });
  assert.deepEqual(locate(null, ['Aguardar Firma']), { where: 'absent', task: null });
});

test('locate: o subprocesso da dica vale mesmo com a tarefa em completed e outra current em outro subprocesso', () => {
  const stepList = {
    current: [step(30, 3, 'Aguardar Firma')],
    completed: [step(10, 3, 'Aguardar Firma')]
  };
  const r = locate(stepList, ['Aguardar Firma'], { subprocessHint: '10', processId: 100 });
  assert.equal(r.where, 'completed');
  assert.equal(r.task.subprocessId, 10);
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: 30, processId: 100 }).where, 'current');
});

test('locate: dica de um subprocesso real sem tarefa própria => absent + elsewhere (nunca a de outro subprocesso)', () => {
  const stepList = {
    current: [step(30, 3, 'Aguardar Firma'), step(20, 3, 'Aguardar Firma')],
    completed: [step(20, 2, 'Enviar solicitud de firma')]
  };
  assert.deepEqual(locate(stepList, ['Aguardar Firma'], { subprocessHint: '999', processId: 100 }),
    { where: 'absent', task: null, elsewhere: [20, 30] });
  // sem o processId explícito, o pai vem da primeira tarefa do step_list
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '999' }).where, 'absent');
  // a tarefa de início só existe no subprocesso 20
  assert.deepEqual(locate(stepList, ['Enviar solicitud de firma'], { subprocessHint: '30', processId: 100 }),
    { where: 'absent', task: null, elsewhere: [20] });
});

test('locate: dica igual ao pai (ou ausente) usa o único subprocesso que tem a tarefa; com vários é ambiguous', () => {
  const one = { current: [step(30, 3, 'Aguardar Firma')], completed: [step(30, 2, 'Enviar solicitud de firma')] };
  for (const opts of [{ subprocessHint: '100', processId: 100 }, { subprocessHint: 100 }, { subprocessHint: '' }, {}]) {
    const r = locate(one, ['Aguardar Firma'], opts);
    assert.equal(r.where, 'current', JSON.stringify(opts));
    assert.equal(r.task.subprocessId, 30);
  }

  const two = {
    current: [step(30, 3, 'Aguardar Firma'), step(10, 3, 'Aguardar Firma')],
    completed: [step(20, 3, 'Aguardar Firma')]
  };
  for (const opts of [{ subprocessHint: '100', processId: 100 }, { subprocessHint: 100 }, { subprocessHint: '' }, {}]) {
    assert.deepEqual(locate(two, ['Aguardar Firma'], opts), { where: 'ambiguous', task: null, subprocesses: [10, 20, 30] },
      JSON.stringify(opts));
  }

  // o mesmo subprocesso em listas diferentes não é ambiguidade: vale a lista de maior prioridade
  const same = { current: [step(30, 3, 'Aguardar Firma')], completed: [step(30, 3, 'Aguardar Firma')] };
  assert.equal(locate(same, ['Aguardar Firma'], {}).where, 'current');
});

test('locate: latest => na ambiguidade, o maior subprocessId da lista de maior prioridade', () => {
  const stepList = {
    current: [step(10, 3, 'Aguardar Firma'), step(30, 3, 'Aguardar Firma'), step(20, 3, 'Aguardar Firma')],
    completed: [step(40, 3, 'Aguardar Firma')]
  };
  const r = locate(stepList, ['Aguardar Firma'], { latest: true });
  assert.equal(r.where, 'current');
  assert.equal(r.task.subprocessId, 30, 'o 40 está em completed: a lista current tem prioridade');
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '100', processId: 100, latest: true }).task.subprocessId, 30);
  // com dica que casa, latest não interfere
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '10', latest: true }).task.subprocessId, 10);
  // dica de subprocesso real sem tarefa própria continua absent, mesmo com latest
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '999', processId: 100, latest: true }).where, 'absent');
});

test('externalId: monta e interpreta; rejeita o que não é nosso ou está incompleto', () => {
  const id = buildExternalId({ workflowId: 3003, subworkflowId: '3004', nodeId: 1001, attachId: '2002' });
  assert.equal(id, 'otcs|wf=3003|sub=3004|node=1001|attach=2002');
  assert.deepEqual(parseExternalId(id), { workflowId: '3003', subworkflowId: '3004', nodeId: '1001', attachId: '2002' });

  // sub ausente/inválido vale o wf
  assert.equal(parseExternalId('otcs|wf=1|node=2|attach=3').subworkflowId, '1');
  assert.equal(parseExternalId('otcs|wf=1|sub=x|node=2|attach=3').subworkflowId, '1');

  for (const bad of [null, undefined, 42, '', 'crm|wf=1|node=2|attach=3', 'otcs|wf=1|node=2', 'otcs|wf=a|node=2|attach=3',
    'otcs|wf=1|node=|attach=3', 'otcs']) {
    assert.equal(parseExternalId(bad), null, String(bad));
  }
  // separadores dentro dos valores não forjam outros campos
  assert.equal(
    buildExternalId({ workflowId: '1|node=9', subworkflowId: '2', nodeId: '3', attachId: '4' }),
    'otcs|wf=1node9|sub=2|node=3|attach=4'
  );
});
