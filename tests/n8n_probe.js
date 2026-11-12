
const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/sqlite3@5.1.7_bluebird@3.7.2_supports-color@8.1.1/node_modules/sqlite3');
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite', sqlite3.OPEN_READONLY);

db.all("SELECT id, name, active FROM workflow_entity WHERE id = 'odSyncReconcile01'", (err, wf) => {
  if (err) { console.error(err); process.exit(1); }

  db.all("SELECT status, count(*) as cnt FROM execution_entity WHERE workflowId = 'odSyncReconcile01' GROUP BY status", (err2, statCounts) => {
    db.all("SELECT id, workflowId, status, mode, startedAt, stoppedAt FROM execution_entity WHERE workflowId = 'odSyncReconcile01' ORDER BY startedAt DESC LIMIT 10", (err3, recentExecs) => {
      console.log(JSON.stringify({ workflow: wf[0], statCounts, recentExecs }));
      db.close();
    });
  });
});
  