const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { importLegacyAgreements } = require('../server/infra/legacyImport');
const { openDatabase } = require('../server/infra/db');
const { createAgreementRepository } = require('../server/infra/agreementRepository');
const { makeLogger, tmpDir } = require('./support/fakes');

const legacy = {
  'AG-OLD-1': {
    nodeId: '10', attachId: '20', fileName: 'a.pdf', workflowId: '30', subworkflowId: '31',
    sendonDone: false, emails: ['x@example.com'], createdAt: '2026-05-01T10:00:00.000Z'
  },
  'AG-OLD-2': {
    nodeId: '11', attachId: '21', fileName: 'b.pdf', workflowId: '32', subworkflowId: '32',
    sendonDone: true, emails: ['y@example.com'], createdAt: '2026-05-02T10:00:00.000Z'
  }
};

test('importa agreements.json legado para o SQLite e renomeia o arquivo', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agreements.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const repo = createAgreementRepository(openDatabase(':memory:'));
  const logger = makeLogger();

  const n = importLegacyAgreements(repo, [file, path.join(dir, 'missing.json')], { logger });
  assert.equal(n, 2);

  const pending = repo.get('AG-OLD-1');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.nodeId, '10');
  assert.equal(pending.attachId, '20');
  assert.equal(pending.workflowId, '30');
  assert.equal(pending.subworkflowId, '31');
  assert.deepEqual(pending.emails, ['x@example.com']);
  assert.equal(pending.createdAt, '2026-05-01T10:00:00.000Z');
  assert.equal(pending.sendonDone, false);
  assert.equal(pending.finalKind, null);

  const done = repo.get('AG-OLD-2');
  assert.equal(done.state, 'completed');
  assert.equal(done.sendonDone, true);
  assert.equal(done.pdfDelivered, true);
  assert.equal(done.finalKind, 'final_ok');

  assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.migrated`));
  // acordos pendentes importados entram no polling
  assert.deepEqual(repo.list({ state: 'pending' }).map((r) => r.id), ['AG-OLD-1']);
});

test('não sobrescreve ids existentes e é idempotente', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agreements.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const repo = createAgreementRepository(openDatabase(':memory:'));
  repo.upsert('AG-OLD-1', { nodeId: 'novo', attachId: '1', emails: [], state: 'signed' });

  assert.equal(importLegacyAgreements(repo, [file]), 1);
  assert.equal(repo.get('AG-OLD-1').nodeId, 'novo');
  assert.equal(repo.get('AG-OLD-1').state, 'signed');
  // arquivo já renomeado: segunda chamada não importa nada
  assert.equal(importLegacyAgreements(repo, [file]), 0);
});

test('arquivo corrompido é renomeado para .corrupt e não derruba o start', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agreements.json');
  fs.writeFileSync(file, '{not json');
  const repo = createAgreementRepository(openDatabase(':memory:'));
  const logger = makeLogger();
  assert.equal(importLegacyAgreements(repo, [file], { logger }), 0);
  assert.ok(fs.existsSync(`${file}.corrupt`));
  assert.equal(logger.lines.error.length, 1);
});
