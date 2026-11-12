const bcrypt = require('bcryptjs');
const db = require('./db');

async function seed() {
  console.log('--- Starting Auth & Company Seed ---');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Companies
    const companies = [
      { id: 'STL', code: 'STL', name: 'SOTRANS Logistics' },
      { id: 'VTX', code: 'VTX', name: 'Vietranstimex' },
      { id: 'SWC', code: 'SWC', name: 'Sowatco' },
    ];

    for (const c of companies) {
      await client.query(
        `INSERT INTO companies (id, company_code, company_name, status, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', now())
         ON CONFLICT (id) DO UPDATE 
         SET company_code = EXCLUDED.company_code,
             company_name = EXCLUDED.company_name,
             status = 'ACTIVE',
             updated_at = now()`,
        [c.id, c.code, c.name]
      );
      console.log(`✓ Company seeded: ${c.code} - ${c.name}`);
    }

    // 2. Employees
    const employees = [
      {
        code: 'STL-1029',
        name: 'Nguyễn Văn An',
        company_id: 'STL',
        dept: 'Nhân sự',
        pos: 'Chuyên viên Nhân sự',
        email: 'an.nv@sotrans.com.vn',
      },
      {
        code: 'VTX_881',
        name: 'Trần Thị Bình',
        company_id: 'VTX',
        dept: 'Kế toán',
        pos: 'Chuyên viên Kế toán',
        email: 'binh.tt@vietranstimex.com.vn',
      },
      {
        code: 'SWC-402',
        name: 'Lê Hoàng Cường',
        company_id: 'SWC',
        dept: 'Khai thác Vận tải',
        pos: 'Kỹ thuật viên Vận tải',
        email: 'cuong.lh@sowatco.com.vn',
      },
    ];

    const empIdMap = {};
    for (const emp of employees) {
      const res = await client.query(
        `INSERT INTO employees (employee_code, employee_name, company_id, department, position, email, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now())
         ON CONFLICT (company_id, employee_code) DO UPDATE
         SET employee_name = EXCLUDED.employee_name,
             company_id = EXCLUDED.company_id,
             department = EXCLUDED.department,
             position = EXCLUDED.position,
             email = EXCLUDED.email,
             status = 'ACTIVE',
             updated_at = now()
         RETURNING id`,
        [emp.code, emp.name, emp.company_id, emp.dept, emp.pos, emp.email]
      );
      empIdMap[emp.code] = res.rows[0].id;
      console.log(`✓ Employee seeded: ${emp.code} (${emp.name}) [Company: ${emp.company_id}]`);
    }

    // 3. Password hashes
    const superAdminHash = await bcrypt.hash('SuperAdmin@2026!', 10);
    const stlAdminHash = await bcrypt.hash('StlAdmin@2026!', 10);
    const vtxAdminHash = await bcrypt.hash('VtxAdmin@2026!', 10);
    const swcAdminHash = await bcrypt.hash('SwcAdmin@2026!', 10);
    const employeeHash = await bcrypt.hash('Employee@2026!', 10);

    // 4. Users
    const users = [
      // Unified ADMINs (system-wide management across STL, VTX, SWC)
      {
        username: 'superadmin',
        password_hash: superAdminHash,
        role: 'ADMIN',
        company_id: null,
        employee_id: null,
      },
      {
        username: 'admin_stl',
        password_hash: stlAdminHash,
        role: 'ADMIN',
        company_id: null,
        employee_id: null,
      },
      {
        username: 'admin_vtx',
        password_hash: vtxAdminHash,
        role: 'ADMIN',
        company_id: null,
        employee_id: null,
      },
      {
        username: 'admin_swc',
        password_hash: swcAdminHash,
        role: 'ADMIN',
        company_id: null,
        employee_id: null,
      },
      // EMPLOYEEs
      {
        username: 'emp_stl',
        password_hash: employeeHash,
        role: 'EMPLOYEE',
        company_id: 'STL',
        employee_id: empIdMap['STL-1029'],
      },
      {
        username: 'emp_vtx',
        password_hash: employeeHash,
        role: 'EMPLOYEE',
        company_id: 'VTX',
        employee_id: empIdMap['VTX_881'],
      },
      {
        username: 'emp_swc',
        password_hash: employeeHash,
        role: 'EMPLOYEE',
        company_id: 'SWC',
        employee_id: empIdMap['SWC-402'],
      },
    ];

    for (const u of users) {
      await client.query(
        `INSERT INTO users (username, password_hash, role, company_id, employee_id, status, failed_login_attempts, must_change_password, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 0, false, now())
         ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role,
             company_id = EXCLUDED.company_id,
             employee_id = EXCLUDED.employee_id,
             status = 'ACTIVE',
             failed_login_attempts = 0,
             locked_until = NULL,
             updated_at = now()`,
        [u.username, u.password_hash, u.role, u.company_id, u.employee_id]
      );
      console.log(`✓ User seeded: ${u.username} [Role: ${u.role}, Company: ${u.company_id || 'ALL'}]`);
    }

    await client.query('COMMIT');
    console.log('--- Seed Completed Successfully! ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) {
  seed();
}

module.exports = seed;
