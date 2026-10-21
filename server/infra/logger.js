// infra/logger.js
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const { createLogger: createWinston, format, transports } = winston;
const MESSAGE = Symbol.for('message');
const FILE_RE = /^(audit|error)-(\d{4}-\d{2}-\d{2})\.log$/;

const logFormat = format.printf(({ timestamp, level, message }) =>
  `[${timestamp}] ${level.toUpperCase()}: ${message}`);

const dayOf = (date) => date.toISOString().slice(0, 10);
const fileFor = (prefix, date) => `${prefix}-${dayOf(date)}.log`;

/*
  Transport de arquivo diário (audit-YYYY-MM-DD.log / error-YYYY-MM-DD.log, data em UTC).
  O nome é calculado a cada linha, então a virada do dia troca de arquivo sozinha.
*/
class DailyFileTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
    this.dir = opts.dir;
    this.prefix = opts.prefix;
    this.now = opts.now || (() => new Date());
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, fileFor(this.prefix, this.now())), `${info[MESSAGE]}\n`);
    } catch (e) {
      process.stderr.write(`[LOGGER] cannot write log file: ${e.message}\n`);
    }
    callback();
  }
}

/*
  Remove arquivos de log com data anterior a (hoje - retentionDays). retentionDays <= 0 desativa.
*/
function purgeOldLogs({ dir, retentionDays, now = () => new Date() }) {
  const deleted = [];
  if (!(retentionDays > 0) || !fs.existsSync(dir)) return deleted;
  const cutoff = dayOf(new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000));
  for (const name of fs.readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (m && m[2] < cutoff) {
      try {
        fs.unlinkSync(path.join(dir, name));
        deleted.push(name);
      } catch { /* ignore */ }
    }
  }
  return deleted;
}

function createLogger({
  logsDir,
  retentionDays = 15,
  level = 'info',
  console: withConsole = true,
  now = () => new Date(),
  schedulePurge = true
}) {
  const fileFormat = format.combine(format.timestamp(), logFormat);
  const list = [
    new DailyFileTransport({ dir: logsDir, prefix: 'error', level: 'error', format: fileFormat, now }),
    new DailyFileTransport({ dir: logsDir, prefix: 'audit', level: 'info', format: fileFormat, now })
  ];
  if (withConsole) {
    list.push(new transports.Console({ format: format.combine(format.timestamp(), format.colorize(), logFormat) }));
  }

  const logger = createWinston({
    level,
    format: format.combine(format.errors({ stack: true }), format.splat()),
    transports: list
  });

  logger.auditFilePath = (date = now()) => path.join(logsDir, fileFor('audit', date));
  logger.purgeOldLogs = () => purgeOldLogs({ dir: logsDir, retentionDays, now });

  let timer = null;
  logger.stopPurge = () => { if (timer) clearInterval(timer); timer = null; };
  if (schedulePurge) {
    try {
      const removed = logger.purgeOldLogs();
      if (removed.length) logger.info(`Log retention: removed ${removed.length} old file(s)`);
    } catch { /* ignore */ }
    timer = setInterval(() => { try { logger.purgeOldLogs(); } catch { /* ignore */ } }, 24 * 60 * 60 * 1000);
    timer.unref();
  }
  return logger;
}

module.exports = { createLogger, purgeOldLogs, DailyFileTransport, FILE_RE };
