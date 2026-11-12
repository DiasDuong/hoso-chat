const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/sqlite3@5.1.7_bluebird@3.7.2_supports-color@8.1.1/node_modules/sqlite3');
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite', sqlite3.OPEN_READONLY);

db.all("SELECT id, name, active FROM workflow_entity WHERE name LIKE '%OneDrive%'", (err, workflows) => {
  if (err) {
    console.error('Workflow error:', err);
    process.exit(1);
  }
  console.log('Workflows:', JSON.stringify(workflows, null, 2));

  db.all("SELECT id, workflowId, status, mode, startedAt, stoppedAt FROM execution_entity WHERE workflowId IN (SELECT id FROM workflow_entity WHERE name LIKE '%OneDrive%') ORDER BY startedAt DESC LIMIT 10", (err2, executions) => {
    if (err2) {
      console.error('Execution error:', err2);
    } else {
      console.log('Executions:', JSON.stringify(executions, null, 2));
    }
    db.close();
  });
});
