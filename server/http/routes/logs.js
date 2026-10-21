// http/routes/logs.js
// Download e streaming (SSE) do log de auditoria do dia, protegidos por Basic Auth.
const fs = require('fs');
const path = require('path');
const express = require('express');

const HEARTBEAT_MS = 15 * 1000;

function logsRoutes({ logger, basicAuth }) {
  const router = express.Router();

  router.get('/logs', basicAuth, (req, res) => {
    const file = logger.auditFilePath();
    if (!fs.existsSync(file)) return res.status(404).send('Log file not found.');
    res.download(file, path.basename(file));
  });

  router.get('/logs/stream', basicAuth, (req, res) => {
    let file = logger.auditFilePath();
    if (!fs.existsSync(file)) return res.status(404).send('Log file not found.');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    let offset = 0;                 // bytes já enviados
    let pending = Buffer.alloc(0);  // linha incompleta no fim do arquivo
    let watcher = null;

    // Envia as linhas completas escritas desde o último offset (o conteúdo atual sai na conexão)
    function pump() {
      let size;
      try { size = fs.statSync(file).size; } catch { return; }
      if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      offset = size;
      const all = Buffer.concat([pending, buf]);
      const cut = all.lastIndexOf(0x0a);
      if (cut === -1) { pending = all; return; }
      pending = all.subarray(cut + 1);
      for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    }

    function watch() {
      if (watcher) watcher.close();
      try { watcher = fs.watch(file, { encoding: 'utf8' }, (evt) => { if (evt === 'change') pump(); }); } catch { watcher = null; }
    }

    // Heartbeat: mantém a conexão viva e acompanha a virada do dia (novo arquivo de auditoria)
    const heartbeat = setInterval(() => {
      const current = logger.auditFilePath();
      if (current !== file && fs.existsSync(current)) {
        file = current;
        offset = 0;
        pending = Buffer.alloc(0);
        watch();
      }
      pump();
      res.write(': keepalive\n\n');
    }, HEARTBEAT_MS);

    pump();
    watch();
    req.on('close', () => {
      clearInterval(heartbeat);
      if (watcher) watcher.close();
    });
  });

  return router;
}

module.exports = { logsRoutes };
