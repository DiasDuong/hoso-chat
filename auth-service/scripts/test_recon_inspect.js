const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { reconcileEmployees } = require('../services/reconciliationService');

async function main() {
  console.log('Running dry reconciliation inspection...');
  const res = await reconcileEmployees({ autoFix: false });
  console.log('Result:');
  console.log('- is_consistent:', res.is_consistent);
  console.log('- Counts:', JSON.stringify(res.counts, null, 2));
  console.log('- Integrity layers:', JSON.stringify(res.integrity_layers, null, 2));
  console.log('- Test records in sheets:', res.test_records_in_sheets.map(r => ({ emp: r.employee_id, name: r.full_name, rows: r.rowNumbers })));
  console.log('- Stale records in sheets:', res.stale_in_sheets.map(r => ({ emp: r.employee_id, name: r.full_name, rows: r.rowNumbers })));
  console.log('- Needs verification in sheets:', res.needs_verification_in_sheets);
  console.log('- Matched in sheets:', res.reconciled_count);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
