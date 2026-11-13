const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { reconcileEmployees } = require('../services/reconciliationService');
const { fetchGoogleSheetAllRows } = require('../services/syncWorker');
const db = require('../db');

async function runCleanup() {
  console.log('=== SOTRANS HUB — GOOGLE SHEETS CLEANUP & RECONCILIATION ===\n');

  console.log('1. Checking current state before cleanup:');
  const beforeRecon = await reconcileEmployees({ autoFix: false, cleanStale: false });
  console.log('- Sheets raw total:', beforeRecon.counts.google_sheets_total);
  console.log('- Test records found:', beforeRecon.counts.google_sheets_test);
  console.log('- Stale records found:', beforeRecon.counts.google_sheets_stale);
  console.log('- Matched with NocoDB:', beforeRecon.counts.google_sheets_matched);
  console.log('- Is consistent before:', beforeRecon.is_consistent);

  console.log('\n2. Executing Cleanup & Reconciliation (autoFix: true, cleanStale: true)...');
  const afterRecon = await reconcileEmployees({ autoFix: true, cleanStale: true, actor: 'superadmin' });
  console.log('- Cleaned in sheets:', JSON.stringify(afterRecon.cleaned_in_sheets, null, 2));
  console.log('- Fixed in sheets:', JSON.stringify(afterRecon.fixed_in_sheets, null, 2));

  console.log('\n3. Verifying resulting state after cleanup:');
  const finalRecon = await reconcileEmployees({ autoFix: false, cleanStale: false });
  console.log('- Final counts:', JSON.stringify(finalRecon.counts, null, 2));
  console.log('- Final integrity layers:', JSON.stringify(finalRecon.integrity_layers, null, 2));
  console.log('- Final is_consistent:', finalRecon.is_consistent);

  console.log('\n4. Inspecting exact remaining rows in Google Sheets:');
  const sheetData = await fetchGoogleSheetAllRows();
  console.log(`Total rows remaining on Sheets: ${sheetData.rows.length}`);
  sheetData.rows.forEach(r => {
    console.log(`Row ${r.rowNumber}: employee_id='${r.empId}', full_name='${r.fullName}', citizen_id='${r.citizenId}', status='${r.status}', isDeleted=${r.isDeleted}, version=${r.version}`);
  });

  console.log('\n5. Inspecting exact rows in NocoDB (hr_employee_profiles):');
  const noco = await db.query('SELECT employee_id, full_name, citizen_id, company_id, status, is_deleted, version FROM hr_employee_profiles ORDER BY employee_id ASC');
  console.table(noco.rows);

  console.log('\n6. Inspecting exact rows in Website (employees):');
  const web = await db.query('SELECT employee_code, employee_name, citizen_id, company_id, status, is_deleted FROM employees ORDER BY employee_code ASC');
  console.table(web.rows);

  process.exit(finalRecon.is_consistent ? 0 : 1);
}

runCleanup().catch(err => {
  console.error('Fatal cleanup error:', err);
  process.exit(1);
});
