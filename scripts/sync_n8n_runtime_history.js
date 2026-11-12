const { execSync } = require('child_process');

const scriptInContainer = `
const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite');

db.all("SELECT nodes, connections FROM workflow_entity WHERE id = 'iFzvznia61WjuhJE'", (err, rows) => {
  if (err || !rows[0]) {
    console.error('Select workflow_entity error:', err);
    process.exit(1);
  }
  const entityNodes = rows[0].nodes;
  const entityConnections = rows[0].connections;

  db.run(
    "UPDATE workflow_history SET nodes = ?, connections = ?, updatedAt = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW') WHERE workflowId = 'iFzvznia61WjuhJE'",
    [entityNodes, entityConnections],
    function(uErr) {
      if (uErr) {
        console.error('Update workflow_history error:', uErr);
        process.exit(1);
      }
      console.log('Successfully synced workflow_entity to workflow_history! Rows changed:', this.changes);
      db.close();
    }
  );
});
`;

console.log('Syncing workflow_history in hrbot-n8n-1...');
const output = execSync('docker exec -i hrbot-n8n-1 node', {
  input: scriptInContainer,
  encoding: 'utf8'
});
console.log(output);

console.log('Restarting hrbot-n8n-1...');
execSync('docker restart hrbot-n8n-1', { stdio: 'inherit' });
console.log('hrbot-n8n-1 restarted.');
