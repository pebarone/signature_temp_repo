const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLogger, purgeOldLogs } = require('../server/infra/logger');
const { tmpDir } = require('./support/fakes');

const touch = (dir, name) => fs.writeFileSync(path.join(dir, name), 'x\n');

test('purga: remove audit/error com mais de 15 dias e preserva o resto', () => {
  const dir = tmpDir('logs-');
  const now = () => new Date('2026-06-22T12:00:00Z');
  // cutoff = 2026-06-07 (hoje - 15 dias)
  for (const n of [
    'audit-2026-05-01.log', 'error-2026-05-01.log', 'audit-2026-06-06.log', 'error-2026-06-06.log',
    'audit-2026-06-07.log', 'audit-2026-06-21.log', 'audit-2026-06-22.log', 'error-2026-06-22.log',
    'other.txt', 'audit.log'
  ]) touch(dir, n);

  const deleted = purgeOldLogs({ dir, retentionDays: 15, now }).sort();
  assert.deepEqual(deleted, [
    'audit-2026-05-01.log', 'audit-2026-06-06.log', 'error-2026-05-01.log', 'error-2026-06-06.log'
  ]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'audit-2026-06-07.log', 'audit-2026-06-21.log', 'audit-2026-06-22.log', 'audit.log',
    'error-2026-06-22.log', 'other.txt'
  ]);
});

test('purga: retentionDays 0 desativa e diretório inexistente não falha', () => {
  const dir = tmpDir('logs-');
  touch(dir, 'audit-2020-01-01.log');
  assert.deepEqual(purgeOldLogs({ dir, retentionDays: 0 }), []);
  assert.ok(fs.existsSync(path.join(dir, 'audit-2020-01-01.log')));
  assert.deepEqual(purgeOldLogs({ dir: path.join(dir, 'nope'), retentionDays: 15 }), []);
});

test('logger: arquivos diários, purga no startup e troca de arquivo na virada do dia', async () => {
  const dir = tmpDir('logs-');
  touch(dir, 'audit-2026-01-01.log');
  touch(dir, 'error-2026-01-01.log');
  let day = new Date('2026-06-22T23:59:00Z');
  const logger = createLogger({ logsDir: dir, retentionDays: 15, console: false, now: () => day });

  assert.ok(!fs.existsSync(path.join(dir, 'audit-2026-01-01.log')), 'purga no startup');
  assert.ok(!fs.existsSync(path.join(dir, 'error-2026-01-01.log')));

  logger.info('primeira linha');
  logger.error('uma falha');
  day = new Date('2026-06-23T00:01:00Z');
  logger.info('segunda linha');
  await new Promise((r) => setImmediate(r));

  const a22 = fs.readFileSync(path.join(dir, 'audit-2026-06-22.log'), 'utf8');
  const a23 = fs.readFileSync(path.join(dir, 'audit-2026-06-23.log'), 'utf8');
  const e22 = fs.readFileSync(path.join(dir, 'error-2026-06-22.log'), 'utf8');
  assert.match(a22, /INFO: primeira linha/);
  assert.match(a22, /ERROR: uma falha/);
  assert.match(a23, /INFO: segunda linha/);
  assert.doesNotMatch(a23, /primeira/);
  assert.match(e22, /ERROR: uma falha/);
  assert.equal(logger.auditFilePath(), path.join(dir, 'audit-2026-06-23.log'));
  logger.stopPurge();
  logger.close();
});
