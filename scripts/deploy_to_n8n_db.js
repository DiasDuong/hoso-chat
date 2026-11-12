const fs = require('fs');
const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const db = new sqlite3.Database('/home/node/.n8n/database.sqlite');

const masterWfPath = '/tmp/SOTRANS_HR_EMPLOYEE_LIFECYCLE.json';
if (!fs.existsSync(masterWfPath)) {
  console.error('Master workflow JSON not found at:', masterWfPath);
  process.exit(1);
}

const wfData = JSON.parse(fs.readFileSync(masterWfPath, 'utf8'));
const workflowId = 'SOTRANS_HR_EMPLOYEE_LIFECYCLE';
const versionId = uuidv4();
const nodesJson = JSON.stringify(wfData.nodes);
const connectionsJson = JSON.stringify(wfData.connections);
const projectId = 'ATzva6fPFnDCLlXz'; // n8n project id

console.log(`Deploying ${workflowId} with version ${versionId}...`);

db.serialize(() => {
  // 1. Delete existing records for master workflow in all related tables
  db.run("DELETE FROM webhook_entity WHERE workflowId = ?", [workflowId]);
  db.run("DELETE FROM shared_workflow WHERE workflowId = ?", [workflowId]);
  db.run("DELETE FROM workflow_published_version WHERE workflowId = ?", [workflowId]);
  db.run("DELETE FROM workflow_history WHERE workflowId = ?", [workflowId]);
  db.run("DELETE FROM workflow_entity WHERE id = ?", [workflowId]);

  // 2. Insert into workflow_entity
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO workflow_entity (
      id, name, active, nodes, connections, createdAt, updatedAt, versionId, activeVersionId
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `, [
    workflowId,
    wfData.name || workflowId,
    nodesJson,
    connectionsJson,
    now,
    now,
    versionId,
    versionId
  ], function(err) {
    if (err) {
      console.error('Error inserting into workflow_entity:', err);
      process.exit(1);
    }
    console.log('Inserted into workflow_entity successfully.');
  });

  // 3. Insert into workflow_history
  db.run(`
    INSERT INTO workflow_history (
      versionId, workflowId, authors, nodes, connections, createdAt, updatedAt, autosaved, nodeGroups
    ) VALUES (?, ?, '[]', ?, ?, ?, ?, 0, '[]')
  `, [
    versionId,
    workflowId,
    nodesJson,
    connectionsJson,
    now,
    now
  ], function(err) {
    if (err) console.error('Error inserting into workflow_history:', err);
    else console.log('Inserted into workflow_history successfully.');
  });

  // 4. Insert into workflow_published_version
  db.run(`
    INSERT INTO workflow_published_version (
      workflowId, publishedVersionId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?)
  `, [
    workflowId,
    versionId,
    now,
    now
  ], function(err) {
    if (err) console.error('Error inserting into workflow_published_version:', err);
    else console.log('Inserted into workflow_published_version successfully.');
  });

  // 5. Insert into shared_workflow
  db.run(`
    INSERT INTO shared_workflow (
      workflowId, projectId, role, createdAt, updatedAt
    ) VALUES (?, ?, 'workflow:owner', ?, ?)
  `, [
    workflowId,
    projectId,
    now,
    now
  ], function(err) {
    if (err) console.error('Error inserting into shared_workflow:', err);
    else console.log('Inserted into shared_workflow successfully.');
  });

  // 6. Find all webhook nodes and insert into webhook_entity
  const webhookNodes = wfData.nodes.filter(n => n.type === 'n8n-nodes-base.webhook');
  for (const node of webhookNodes) {
    const webhookPath = node.parameters.path;
    const method = (node.parameters.httpMethod || 'GET').toUpperCase();
    const pathLength = webhookPath.split('/').filter(Boolean).length;

    db.run(`
      INSERT INTO webhook_entity (
        workflowId, webhookPath, method, node, pathLength
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      workflowId,
      webhookPath,
      method,
      node.name,
      pathLength
    ], function(err) {
      if (err) console.error(`Error inserting webhook ${webhookPath}:`, err);
      else console.log(`Registered webhook [${method}] /webhook/${webhookPath} -> node "${node.name}"`);
    });
  }

  db.close((err) => {
    if (err) console.error('Error closing db:', err);
    else console.log('All deployment steps completed successfully!');
  });
});
