// infra/legacyImport.js
const fs = require('fs');

/*
  Importa o agreements.json antigo (mapa plano id -> {nodeId, attachId, sendonDone...}) para o SQLite
  e renomeia o arquivo para .migrated. Ids já existentes no banco não são sobrescritos.
*/
function importLegacyAgreements(repo, files, { logger, now = () => new Date() } = {}) {
  let imported = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger?.error(`Legacy import: ${file} ilegible (${e.message}); renombrado a .corrupt`);
      try { fs.renameSync(file, `${file}.corrupt`); } catch { /* ignore */ }
      continue;
    }

    let count = 0;
    repo.transaction(() => {
      for (const [id, e] of Object.entries(data || {})) {
        if (!e || typeof e !== 'object' || repo.has(id)) continue;
        const done = !!e.sendonDone;
        repo.upsert(id, {
          nodeId: e.nodeId,
          attachId: e.attachId,
          fileName: e.fileName,
          workflowId: e.workflowId,
          subworkflowId: e.subworkflowId,
          emails: Array.isArray(e.emails) ? e.emails : [],
          state: done ? 'completed' : 'pending',
          finalKind: done ? 'final_ok' : null,
          pdfDelivered: done,
          sendonDone: done,
          createdAt: e.createdAt || now().toISOString()
        });
        count++;
      }
    });

    let target = `${file}.migrated`;
    if (fs.existsSync(target)) target = `${file}.${Date.now()}.migrated`;
    try {
      fs.renameSync(file, target);
    } catch (err) {
      logger?.error(`Legacy import: no se pudo renombrar ${file}: ${err.message}`);
    }
    logger?.info(`Legacy import: ${count} acuerdo(s) importados de ${file}`);
    imported += count;
  }
  return imported;
}

module.exports = { importLegacyAgreements };
