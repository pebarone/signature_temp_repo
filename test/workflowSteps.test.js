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
  assert.deepEqual(locate(stepList, ['Aguardar Firma']), { where: 'current', task: stepList.current[0] });
  assert.equal(locate(stepList, ['Enviar solicitud de firma']).where, 'completed');
  assert.equal(locate(stepList, ['Firmado']).where, 'next');
  assert.deepEqual(locate(stepList, ['Activación']), { where: 'absent', task: null });
  assert.deepEqual(locate({}, ['Aguardar Firma']), { where: 'absent', task: null });
  assert.deepEqual(locate(null, ['Aguardar Firma']), { where: 'absent', task: null });
});

test('locate: vários candidatos => o do subprocessHint; senão o de maior subprocessId', () => {
  const stepList = {
    current: [step(10, 3, 'Aguardar Firma'), step(30, 3, 'Aguardar Firma'), step(20, 3, 'Aguardar Firma')]
  };
  assert.equal(locate(stepList, ['Aguardar Firma']).task.subprocessId, 30);
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '10' }).task.subprocessId, 10);
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: 20 }).task.subprocessId, 20);
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '999' }).task.subprocessId, 30, 'dica sem correspondência');
  assert.equal(locate(stepList, ['Aguardar Firma'], { subprocessHint: '' }).task.subprocessId, 30);
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
