/**
 * SOTRANS HR SYSTEM - AUTOMATED TEST DATA CLEANUP SCRIPT
 * 
 * Safely removes all test employees, test staging records, test profiles,
 * test sync outbox/tasks, and related test logs across all storage tiers.
 * 
 * Strictly preserves all production and seed employee data.
 */

const path = require('path');
require('../auth-service/node_modules/dotenv').config({ path: path.join(__dirname, '../auth-service/.env') });
const db = require('../auth-service/db');
const { fetchGoogleSheetAllRows, deleteGoogleSheetRows } = require('../auth-service/services/syncWorker');

async function cleanupTestData() {
  console.log('========================================================');
  console.log('   SOTRANS HR - EXECUTING TEST DATA CLEANUP MECHANISM   ');
  console.log('========================================================\n');

  const client = await db.pool.connect();
  const summary = {
    stagingDeleted: 0,
    employmentHistoryDeleted: 0,
    syncTasksDeleted: 0,
    outboxDeleted: 0,
    profilesDeleted: 0,
    employeesDeleted: 0,
    nocodbDeleted: 0,
    sheetsDeleted: 0
  };

  try {
    await client.query('BEGIN');

    // 1. Identify Test Employees in Postgres
    const testEmpsRes = await client.query(`
      SELECT id, employee_code, employee_name, citizen_id 
      FROM employees 
      WHERE employee_name ILIKE '%TEST%' 
         OR employee_code ILIKE '%TEST%' 
         OR citizen_id ILIKE '%test%' 
         OR employee_code IN ('STL00016', 'STL00017', 'STL00018', 'STL00019', 'STL-GOV-999', 'SWC-TEST-01', 'STL999')
    `);
    const testEmpIds = testEmpsRes.rows.map(r => r.id);
    const testEmpCodes = testEmpsRes.rows.map(r => r.employee_code).filter(Boolean);
    console.log(`Found ${testEmpIds.length} test employee records in employees:`, testEmpCodes);

    // 2. Identify Test Profiles in hr_employee_profiles
    const testProfilesRes = await client.query(`
      SELECT id, employee_id, full_name, citizen_id 
      FROM hr_employee_profiles 
      WHERE full_name ILIKE '%TEST%' 
         OR employee_id ILIKE '%TEST%' 
         OR citizen_id ILIKE '%test%' 
         OR employee_id IN ('STL00016', 'STL00017', 'STL00018', 'STL00019', 'STL-GOV-999', 'SWC-TEST-01', 'STL999')
         OR employment_id = ANY($1)
    `, [testEmpIds]);
    const testProfileIds = testProfilesRes.rows.map(r => r.id);
    console.log(`Found ${testProfileIds.length} test profiles in hr_employee_profiles`);

    // 3. Identify Test Staging Records in hr_employee_staging
    const testStagingRes = await client.query(`
      SELECT id, full_name, employee_code, file_name 
      FROM hr_employee_staging 
      WHERE full_name ILIKE '%TEST%' 
         OR file_name ILIKE '%test%' 
         OR citizen_id ILIKE '%test%'
         OR employee_code IN ('STL00016', 'STL00017', 'STL00018', 'STL00019', 'STL-GOV-999', 'SWC-TEST-01', 'STL999')
         OR target_profile_id = ANY($1)
    `, [testProfileIds]);
    const testStagingIds = testStagingRes.rows.map(r => r.id);
    console.log(`Found ${testStagingIds.length} test staging records in hr_employee_staging`);

    // 4. Delete dependent records: hr_employment_history
    if (testEmpIds.length > 0) {
      const histDel = await client.query(`
        DELETE FROM hr_employment_history 
        WHERE employment_id = ANY($1)
      `, [testEmpIds]);
      summary.employmentHistoryDeleted = histDel.rowCount;
      console.log(`- Deleted ${histDel.rowCount} rows from hr_employment_history`);

      // Delete from hr_employment_documents if any
      await client.query(`DELETE FROM hr_employment_documents WHERE employment_id = ANY($1)`, [testEmpIds]);
      // Delete from hr_employment_compensation if any
      await client.query(`DELETE FROM hr_employment_compensation WHERE employment_id = ANY($1)`, [testEmpIds]);
    }

    // 5. Delete hr_sync_tasks related to test records
    const syncDel = await client.query(`
      DELETE FROM hr_sync_tasks 
      WHERE (employee_id = ANY($1) AND array_length($1, 1) > 0)
         OR (staging_id = ANY($2) AND array_length($2, 1) > 0)
         OR payload::text ILIKE '%TEST%'
         OR payload::text ILIKE '%cccd_test%'
         OR payload::text ILIKE '%STL00016%'
         OR payload::text ILIKE '%STL00017%'
         OR payload::text ILIKE '%STL00018%'
         OR payload::text ILIKE '%STL00019%'
         OR payload::text ILIKE '%STL-GOV-999%'
    `, [testEmpIds, testStagingIds]);
    summary.syncTasksDeleted = syncDel.rowCount;
    console.log(`- Deleted ${syncDel.rowCount} rows from hr_sync_tasks`);

    // 6. Delete test records from employee_sync_outbox
    const outboxDel = await client.query(`
      DELETE FROM employee_sync_outbox 
      WHERE employee_id = ANY($1)
         OR payload::text ILIKE '%TEST NGUYEN VAN APPROVE%'
         OR payload::text ILIKE '%cccd_test%'
         OR status = 'SKIPPED_TEST_RECORD'
         OR employee_id IN ('STL00016', 'STL00017', 'STL00018', 'STL00019', 'STL-GOV-999', 'SWC-TEST-01', 'STL999')
    `, [testEmpCodes]);
    summary.outboxDeleted = outboxDel.rowCount;
    console.log(`- Deleted ${outboxDel.rowCount} rows from employee_sync_outbox`);

    // 7. Delete staging records from hr_employee_staging
    if (testStagingIds.length > 0) {
      const stagDel = await client.query(`
        DELETE FROM hr_employee_staging 
        WHERE id = ANY($1)
      `, [testStagingIds]);
      summary.stagingDeleted = stagDel.rowCount;
      console.log(`- Deleted ${stagDel.rowCount} rows from hr_employee_staging`);
    }

    // 8. Delete profiles from hr_employee_profiles
    if (testProfileIds.length > 0) {
      const profDel = await client.query(`
        DELETE FROM hr_employee_profiles 
        WHERE id = ANY($1)
      `, [testProfileIds]);
      summary.profilesDeleted = profDel.rowCount;
      console.log(`- Deleted ${profDel.rowCount} rows from hr_employee_profiles`);
    }

    // 9. Delete employees from employees table
    if (testEmpIds.length > 0) {
      const empDel = await client.query(`
        DELETE FROM employees 
        WHERE id = ANY($1)
      `, [testEmpIds]);
      summary.employeesDeleted = empDel.rowCount;
      console.log(`- Deleted ${empDel.rowCount} rows from employees`);
    }

    await client.query('COMMIT');
    console.log('✅ PostgreSQL test data cleaned up successfully.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error cleaning PostgreSQL test data:', err);
    throw err;
  } finally {
    client.release();
  }

  // 10. Check and Clean Google Sheets (if any test row exists)
  try {
    console.log('\n--- Checking Google Sheets for test rows ---');
    const sheetData = await fetchGoogleSheetAllRows();
    const testSheetRows = sheetData.rows.filter(r => 
      r.fullName.toUpperCase().includes('TEST') ||
      r.empId.startsWith('STL_MOCK_') ||
      r.empId.startsWith('TEST_') ||
      ['STL00016', 'STL00017', 'STL00018', 'STL00019', 'STL-GOV-999', 'SWC-TEST-01', 'STL999'].includes(r.empId) ||
      r.citizenId.startsWith('cccd_test')
    );

    if (testSheetRows.length > 0) {
      const rowNumbers = testSheetRows.map(r => r.rowNumber);
      console.log(`Found ${testSheetRows.length} test rows in Google Sheets to delete:`, rowNumbers);
      const delResult = await deleteGoogleSheetRows(rowNumbers);
      summary.sheetsDeleted = rowNumbers.length;
      console.log('Google Sheets delete result:', delResult);
    } else {
      console.log('Google Sheets is completely clean (0 test rows found).');
    }
  } catch (sheetErr) {
    console.error('Warning checking Google Sheets:', sheetErr.message);
  }

  console.log('\n========================================================');
  console.log('                 CLEANUP SUMMARY REPORT                 ');
  console.log('========================================================');
  console.table(summary);

  return summary;
}

if (require.main === module) {
  cleanupTestData()
    .then(() => {
      console.log('Cleanup finished successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Cleanup failed:', err);
      process.exit(1);
    });
}

module.exports = { cleanupTestData };
