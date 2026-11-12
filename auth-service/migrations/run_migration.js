const fs = require('fs');
const path = require('path');
module.paths.push(path.join(__dirname, '../node_modules'));

const { Pool } = require('pg');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'hrbot',
  user: 'hrbot',
  password: 'hrchatbot'
});

async function run() {
  console.log('=== SOTRANS HUB PRODUCTION MIGRATION RUNNER ===');
  console.log('Target Database: hrbot');
  
  const client = await pool.connect();
  try {
    const dbCheck = await client.query('SELECT current_database(), current_user;');
    console.log('Verified Database & User:', dbCheck.rows[0]);
    if (dbCheck.rows[0].current_database !== 'hrbot') {
      throw new Error(`CRITICAL: Connected to ${dbCheck.rows[0].current_database}, expected 'hrbot'. Aborting!`);
    }

    const sqlFile = path.join(__dirname, '20261030_01_production_employee_hard_delete_workflow.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('Starting migration transaction...');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Migration committed successfully!');

    // Verify all created tables
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN (
          'employee_retention_policies',
          'employee_hard_delete_requests',
          'employee_hard_delete_approvals',
          'employee_hard_delete_manifests',
          'employee_hard_delete_executions',
          'employee_hard_delete_outbox',
          'employee_hard_delete_audit',
          'employee_hard_delete_tombstones'
        )
      ORDER BY table_name;
    `);
    console.log('\nVerified tables created in hrbot:');
    tableCheck.rows.forEach(r => console.log(' - ' + r.table_name));

    if (tableCheck.rows.length !== 8) {
      throw new Error(`Expected 8 workflow tables, found ${tableCheck.rows.length}`);
    }

    // Verify employees table is untouched
    const empCheck = await client.query('SELECT COUNT(*) as total FROM employees;');
    console.log('\nVerified employees table record count:', empCheck.rows[0].total);
    if (parseInt(empCheck.rows[0].total, 10) !== 5) {
      throw new Error(`CRITICAL: Employees count changed! Found ${empCheck.rows[0].total}, expected 5`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed and rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
