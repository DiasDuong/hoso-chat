const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedHR() {
  const hash = await bcrypt.hash('Employee@2026!', 10);
  
  // 1. Update hr_stl to role 'HR'
  await db.query(`UPDATE users SET role = 'HR', updated_at = now() WHERE username = 'hr_stl'`);
  console.log('✓ Updated hr_stl to role HR');

  // 2. VTX HR
  const vtxEmp = await db.query(
    `INSERT INTO employees (employee_code, employee_name, company_id, department, position, email, status, updated_at)
     VALUES ('VTX_102', 'Lê Thu Hà', 'VTX', 'Phòng Nhân sự', 'Chuyên viên Nhân sự VTX', 'ha.lt@vietranstimex.com.vn', 'ACTIVE', now())
     ON CONFLICT (company_id, employee_code) DO UPDATE
     SET employee_name = EXCLUDED.employee_name, department = EXCLUDED.department, position = EXCLUDED.position, email = EXCLUDED.email
     RETURNING id`
  );
  const vtxEmpId = vtxEmp.rows[0].id;
  await db.query(
    `INSERT INTO users (username, password_hash, role, company_id, employee_id, status, failed_login_attempts, must_change_password, updated_at)
     VALUES ('hr_vtx', $1, 'HR', 'VTX', $2, 'ACTIVE', 0, false, now())
     ON CONFLICT (username) DO UPDATE
     SET role = 'HR', company_id = 'VTX', employee_id = $2, password_hash = $1, status = 'ACTIVE', updated_at = now()`,
    [hash, vtxEmpId]
  );
  console.log('✓ Seeded hr_vtx (Company: VTX)');

  // 3. SWC HR
  const swcEmp = await db.query(
    `INSERT INTO employees (employee_code, employee_name, company_id, department, position, email, status, updated_at)
     VALUES ('SWC-102', 'Trần Quốc Huy', 'SWC', 'Phòng Tổ chức - Nhân sự', 'Chuyên viên Nhân sự SWC', 'huy.tq@sowatco.com.vn', 'ACTIVE', now())
     ON CONFLICT (company_id, employee_code) DO UPDATE
     SET employee_name = EXCLUDED.employee_name, department = EXCLUDED.department, position = EXCLUDED.position, email = EXCLUDED.email
     RETURNING id`
  );
  const swcEmpId = swcEmp.rows[0].id;
  await db.query(
    `INSERT INTO users (username, password_hash, role, company_id, employee_id, status, failed_login_attempts, must_change_password, updated_at)
     VALUES ('hr_swc', $1, 'HR', 'SWC', $2, 'ACTIVE', 0, false, now())
     ON CONFLICT (username) DO UPDATE
     SET role = 'HR', company_id = 'SWC', employee_id = $2, password_hash = $1, status = 'ACTIVE', updated_at = now()`,
    [hash, swcEmpId]
  );
  console.log('✓ Seeded hr_swc (Company: SWC)');

  const result = await db.query(
    `SELECT u.username, u.role, u.company_id, e.employee_code, e.employee_name 
     FROM users u 
     LEFT JOIN employees e ON u.employee_id = e.id 
     WHERE u.role = 'HR' ORDER BY u.username`
  );
  console.log('\n--- Danh sách tài khoản HR hiện tại trong hệ thống ---');
  console.table(result.rows);

  await db.pool.end();
}

seedHR().catch(e => { console.error('Error:', e); process.exit(1); });
