const { execSync } = require('child_process');

// Script to patch Insert chunks in n8n container
const scriptInContainer = `
const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite');

db.all("SELECT nodes FROM workflow_entity WHERE id = 'iFzvznia61WjuhJE'", (err, rows) => {
  if (err) {
    console.error('Select error:', err);
    process.exit(1);
  }
  const nodes = JSON.parse(rows[0].nodes);
  const ic = nodes.find(n => n.name === 'Insert chunks');
  if (!ic) {
    console.error('Insert chunks node not found!');
    process.exit(1);
  }
  console.log('Old queryReplacement:', ic.parameters?.options?.queryReplacement || ic.options?.queryReplacement);
  
  if (ic.parameters && ic.parameters.options) {
    ic.parameters.options.queryReplacement = "={{ [ JSON.stringify($('Chunk').first().json.rows.map((r, i) => ({ ...r, seq: i }))) ] }}";
  } else if (ic.options) {
    ic.options.queryReplacement = "={{ [ JSON.stringify($('Chunk').first().json.rows.map((r, i) => ({ ...r, seq: i }))) ] }}";
  }

  // Also clean up Make batches if it had replace(/\\u0000/g, ' ')
  const mb = nodes.find(n => n.name === 'Make batches');
  if (mb && mb.parameters && mb.parameters.jsCode) {
    mb.parameters.jsCode = mb.parameters.jsCode.replace(/\\.replace\\(\\/\\\\u0000\\/g, ' '\\)/g, '');
  }

  db.run("UPDATE workflow_entity SET nodes = ?, updatedAt = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW') WHERE id = 'iFzvznia61WjuhJE'", [JSON.stringify(nodes)], function(uErr) {
    if (uErr) {
      console.error('Update error:', uErr);
      process.exit(1);
    }
    console.log('Update successful! Rows changed:', this.changes);
    db.close();
  });
});
`;

console.log('Executing patch inside hrbot-n8n-1...');
const output = execSync('docker exec -i hrbot-n8n-1 node', {
  input: scriptInContainer,
  encoding: 'utf8'
});
console.log(output);

console.log('Restarting hrbot-n8n-1 to reload workflow...');
execSync('docker restart hrbot-n8n-1', { stdio: 'inherit' });
console.log('hrbot-n8n-1 restarted successfully.');
