const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3');
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite');

const workflowsToActivate = [
  'HR_Document_Intake_01',
  'HR_Approval_Callback_01',
  'HR_Sequential_Sync_01',
  'HR_Retry_Recovery_01'
];

db.serialize(() => {
  db.all("SELECT id, name, active FROM workflow_entity WHERE id IN ('HR_Document_Intake_01', 'HR_Approval_Callback_01', 'HR_Sequential_Sync_01', 'HR_Retry_Recovery_01')", (err, rows) => {
    if (err) {
      console.error('Error selecting:', err);
      return;
    }
    console.log('Current state of workflows before update:', rows);

    db.run("UPDATE workflow_entity SET active = 1 WHERE id IN ('HR_Document_Intake_01', 'HR_Approval_Callback_01', 'HR_Sequential_Sync_01', 'HR_Retry_Recovery_01')", function(err2) {
      if (err2) {
        console.error('Error updating:', err2);
        return;
      }
      console.log(`Updated ${this.changes} workflows to active = 1`);

      db.all("SELECT id, name, active FROM workflow_entity WHERE id IN ('HR_Document_Intake_01', 'HR_Approval_Callback_01', 'HR_Sequential_Sync_01', 'HR_Retry_Recovery_01')", (err3, rowsAfter) => {
        if (err3) console.error('Error re-selecting:', err3);
        else console.log('Workflows after update:', rowsAfter);
        db.close();
      });
    });
  });
});
