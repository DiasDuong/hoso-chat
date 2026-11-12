/**
 * test_unified_admin_rbac.js
 * End-to-End Verification Suite for Unified ADMIN Role & Multi-Tenant RBAC in SOTRANS Hub.
 */

const http = require('http');

const BASE_URL = 'http://127.0.0.1:3000';

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', (err) => reject(err));
    if (postData) {
      if (typeof postData === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(postData));
      } else {
        req.write(postData);
      }
    }
    req.end();
  });
}

async function login(username, password, portal = null) {
  const payload = { username, password };
  if (portal) payload.portal = portal;
  const res = await request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST'
  }, payload);
  return res;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🧪 SOTRANS HUB - UNIFIED ADMIN RBAC VERIFICATION SUITE');
  console.log('============================================================\n');

  let superadminToken = '';
  let adminStlToken = '';
  let hrStlToken = '';
  let empStlToken = '';
  let superadminUser = null;
  let adminStlUser = null;

  // ------------------------------------------------------------
  // SECTION 1: AUTHENTICATION & UNIFIED ROLE ASSIGNMENT
  // ------------------------------------------------------------
  console.log('▶ [TEST GROUP 1] Unified ADMIN Role Login & Token Verification');

  // 1.1 superadmin login
  const saRes = await login('superadmin', 'SuperAdmin@2026!');
  assert(saRes.status === 200 && saRes.body.success, 'superadmin can log in successfully');
  assert(saRes.body.user.role === 'ADMIN', `superadmin has unified role ADMIN (actual: ${saRes.body.user?.role})`);
  assert(saRes.body.user.company_id === null, 'superadmin company_id is NULL (multi-tenant scope)');
  superadminToken = saRes.body.token;
  superadminUser = saRes.body.user;

  // 1.2 admin_stl login (previously COMPANY_ADMIN)
  const stlRes = await login('admin_stl', 'StlAdmin@2026!');
  assert(stlRes.status === 200 && stlRes.body.success, 'admin_stl can log in successfully');
  assert(stlRes.body.user.role === 'ADMIN', `admin_stl now has unified role ADMIN (actual: ${stlRes.body.user?.role})`);
  assert(stlRes.body.user.company_id === null, 'admin_stl company_id is NULL (multi-tenant scope)');
  adminStlToken = stlRes.body.token;
  adminStlUser = stlRes.body.user;

  // 1.3 admin portal check for ADMIN
  const portalRes = await login('admin_stl', 'StlAdmin@2026!', 'admin');
  assert(portalRes.status === 200 && portalRes.body.success, 'admin_stl can access portal: "admin"');

  // 1.4 hr_stl login
  const hrRes = await login('hr_stl', 'Employee@2026!');
  assert(hrRes.status === 200 && hrRes.body.success, 'hr_stl can log in successfully');
  assert(hrRes.body.user.role === 'HR', `hr_stl has role HR (actual: ${hrRes.body.user?.role})`);
  assert(hrRes.body.user.company_id === 'STL', 'hr_stl is locked to company_id STL');
  hrStlToken = hrRes.body.token;

  // 1.5 emp_stl login & portal denial
  const empRes = await login('emp_stl', 'Employee@2026!');
  assert(empRes.status === 200 && empRes.body.success, 'emp_stl can log in successfully');
  assert(empRes.body.user.role === 'EMPLOYEE', 'emp_stl has role EMPLOYEE');
  empStlToken = empRes.body.token;

  const empPortalRes = await login('emp_stl', 'Employee@2026!', 'admin');
  assert(empPortalRes.status === 403, 'EMPLOYEE is rejected with 403 when trying to access admin portal');

  // ------------------------------------------------------------
  // SECTION 2: MULTI-COMPANY CAPABILITIES FOR UNIFIED ADMIN
  // ------------------------------------------------------------
  console.log('\n▶ [TEST GROUP 2] Unified ADMIN Multi-Company Operations');

  // 2.1 GET /api/users across companies as admin_stl
  const usersRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(usersRes.status === 200 && usersRes.body.success, 'admin_stl can list all users');
  const usersList = usersRes.body.data || usersRes.body.users || [];
  const userCompanies = new Set(usersList.map(u => u.company_id).filter(Boolean));
  assert(userCompanies.has('STL') && userCompanies.has('VTX') && userCompanies.has('SWC'),
    'admin_stl sees users from STL, VTX, and SWC');

  // 2.2 GET /api/employees cross-company as admin_stl
  const empListRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(empListRes.status === 200 && empListRes.body.success, 'admin_stl can list all employees');
  const empList = empListRes.body.data || empListRes.body.employees || [];
  const empCompanies = new Set(empList.map(e => e.company_id).filter(Boolean));
  assert(empCompanies.has('STL') && empCompanies.has('VTX') && empCompanies.has('SWC'),
    'admin_stl sees employees across all 3 companies');

  // 2.3 Filter employees by company as ADMIN
  const swcEmpRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees?company_id=SWC', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(swcEmpRes.status === 200, 'admin_stl can filter employees by company_id=SWC');
  const swcList = swcEmpRes.body.data || swcEmpRes.body.employees || [];
  const allSWC = swcList.every(e => e.company_id === 'SWC');
  assert(allSWC && swcList.length > 0, 'All returned employees belong to SWC');

  // 2.4 GET /api/companies as ADMIN
  const compRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/companies', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(compRes.status === 200 && compRes.body.success, 'admin_stl can retrieve companies list');
  const compList = compRes.body.data || compRes.body.companies || [];
  assert(compList.length >= 3, 'admin_stl retrieves all member companies');

  // 2.5 GET /api/documents as ADMIN
  const docRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/documents', method: 'GET',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(docRes.status === 200 && docRes.body.success, 'admin_stl can retrieve policy documents across all scopes');

  // ------------------------------------------------------------
  // SECTION 3: ADMIN MANAGEMENT PRIVILEGES & ANTI-TAMPERING
  // ------------------------------------------------------------
  console.log('\n▶ [TEST GROUP 3] Account Lifecycle, Self-Protection & Tampering Defense');

  // 3.1 Create new ADMIN account by existing ADMIN
  const testAdminUsername = `test_admin_${Date.now()}`;
  const createAdminRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'POST',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  }, {
    username: testAdminUsername,
    role: 'ADMIN',
    password: 'AdminPassword@2026!'
  });
  assert(createAdminRes.status === 201 && createAdminRes.body.success, `ADMIN can create new ADMIN account (@${testAdminUsername})`);
  const createdAdminId = createAdminRes.body.user?.user_id;

  // 3.2 Anti-self-demotion: Admin cannot demote themselves
  const demoteSelfRes = await request({
    hostname: '127.0.0.1', port: 3000, path: `/api/users/${adminStlUser.user_id}`, method: 'PUT',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  }, {
    role: 'EMPLOYEE'
  });
  assert(demoteSelfRes.status === 400 || demoteSelfRes.status === 403, 'ADMIN self-demotion is blocked (400/403)');

  // 3.3 Anti-self-deletion: Admin cannot delete their own account
  const deleteSelfRes = await request({
    hostname: '127.0.0.1', port: 3000, path: `/api/users/${adminStlUser.user_id}`, method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  });
  assert(deleteSelfRes.status === 400 || deleteSelfRes.status === 403, 'ADMIN self-deletion is blocked (400/403)');

  // 3.4 Delete the temporary created admin
  if (createdAdminId) {
    const deleteTestAdminRes = await request({
      hostname: '127.0.0.1', port: 3000, path: `/api/users/${createdAdminId}`, method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminStlToken}` }
    });
    assert(deleteTestAdminRes.status === 200 && deleteTestAdminRes.body.success, 'ADMIN can delete another admin account');
  }

  // 3.5 Attempt to assign invalid legacy role 'SUPER_ADMIN' or 'COMPANY_ADMIN'
  const legacyRoleRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'POST',
    headers: { 'Authorization': `Bearer ${adminStlToken}` }
  }, {
    username: `legacy_test_${Date.now()}`,
    role: 'SUPER_ADMIN',
    password: 'Password@2026!'
  });
  assert(legacyRoleRes.status === 400, 'Assigning legacy role SUPER_ADMIN is rejected with 400');

  // ------------------------------------------------------------
  // SECTION 4: TENANT ISOLATION & PRIVILEGE RESTRICTION FOR HR
  // ------------------------------------------------------------
  console.log('\n▶ [TEST GROUP 4] HR Strict Company Isolation & Permission Boundaries');

  // 4.1 HR cannot access /api/users
  const hrUsersRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'GET',
    headers: { 'Authorization': `Bearer ${hrStlToken}` }
  });
  assert(hrUsersRes.status === 403, 'HR access to /api/users is denied with 403');

  // 4.2 HR cannot create users via /api/users
  const hrCreateUserRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'POST',
    headers: { 'Authorization': `Bearer ${hrStlToken}` }
  }, {
    username: `hr_unauth_${Date.now()}`,
    role: 'ADMIN',
    password: 'Password@2026!'
  });
  assert(hrCreateUserRes.status === 403, 'HR cannot create ADMIN or other accounts via /api/users (403)');

  // 4.3 HR only receives employees of their own company
  const hrEmpRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees', method: 'GET',
    headers: { 'Authorization': `Bearer ${hrStlToken}` }
  });
  assert(hrEmpRes.status === 200 && hrEmpRes.body.success, 'HR can list employees');
  const hrReturnedCompanies = new Set((hrEmpRes.body.data || hrEmpRes.body.employees || []).map(e => e.company_id).filter(Boolean));
  assert(hrReturnedCompanies.has('STL') && !hrReturnedCompanies.has('VTX') && !hrReturnedCompanies.has('SWC'),
    'HR (STL) only sees employees of STL; VTX and SWC are strictly isolated');

  // 4.4 HR cannot query other company employees by overriding company_id parameter
  const hrTamperRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees?company_id=VTX', method: 'GET',
    headers: { 'Authorization': `Bearer ${hrStlToken}` }
  });
  const hrTamperCompanies = new Set((hrTamperRes.body.data || []).map(e => e.company_id).filter(Boolean));
  assert(!hrTamperCompanies.has('VTX'), 'HR cannot bypass tenant isolation via query param company_id=VTX');

  // 4.5 HR cannot delete an employee profile
  const anyStlEmp = hrEmpRes.body.data[0];
  if (anyStlEmp) {
    const hrDelEmpRes = await request({
      hostname: '127.0.0.1', port: 3000, path: `/api/employees/${anyStlEmp.id}`, method: 'DELETE',
      headers: { 'Authorization': `Bearer ${hrStlToken}` }
    });
    assert(hrDelEmpRes.status === 403, 'HR cannot delete employee profiles (403 Forbidden)');
  }

  // 4.6 HR cannot create cross-company employees
  const hrCrossCompRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees', method: 'POST',
    headers: { 'Authorization': `Bearer ${hrStlToken}` }
  }, {
    employee_code: `VTX_TEST_${Date.now()}`,
    employee_name: 'Cross Company Test',
    company_id: 'VTX'
  });
  assert(hrCrossCompRes.status === 403, 'HR cannot create employee for another company (403 Forbidden)');

  // ------------------------------------------------------------
  // SECTION 5: UNAUTHENTICATED GUEST PROTECTION
  // ------------------------------------------------------------
  console.log('\n▶ [TEST GROUP 5] Unauthenticated / Guest Access Control');

  // 5.1 Access protected endpoint without token
  const noTokenRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/users', method: 'GET'
  });
  assert(noTokenRes.status === 401, 'Unauthenticated request to /api/users returns 401');

  const noTokenEmpRes = await request({
    hostname: '127.0.0.1', port: 3000, path: '/api/employees', method: 'GET'
  });
  assert(noTokenEmpRes.status === 401, 'Unauthenticated request to /api/employees returns 401');

  // ------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------
  console.log('\n============================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
