const db = require('../auth-service/db');

async function main() {
  const triggers = await db.query(`
    SELECT trigger_name, event_manipulation, action_statement 
    FROM information_schema.triggers 
    WHERE event_object_table = 'hr_employee_profiles'
  `);
  console.log('Triggers on hr_employee_profiles:', triggers.rows);

  // Check if STL00088 exists in employees
  await db.query(`DELETE FROM employees WHERE employee_code = 'STL00088'`);
  console.log('Deleted STL00088 from employees.');

  const empCount = await db.query('SELECT count(*) FROM employees WHERE is_deleted = false');
  console.log('Employees active count:', empCount.rows[0].count);

  const nocoCount = await db.query('SELECT count(*) FROM hr_employee_profiles WHERE is_deleted = false');
  console.log('hr_employee_profiles active count:', nocoCount.rows[0].count);

  process.exit(0);
}

main().catch(console.error);
