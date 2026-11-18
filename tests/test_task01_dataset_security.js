/**
 * SOTRANS HUB — TASK 01: BI DATASET SECURITY & GOVERNANCE TEST SUITE
 * 
 * Verifies Defect D05 fixes and security test cases:
 * - SEC-01: Active owner accesses valid dataset -> ALLOW.
 * - SEC-02: Other employee without share -> DENY.
 * - SEC-03: Cross-company user without authorization -> DENY.
 * - SEC-04: Expired dataset + owner -> DENY.
 * - SEC-05: Expired dataset + ADMIN -> DENY.
 * - SEC-06: Inactive user -> DENY.
 * - SEC-07: Missing dataset metadata -> DENY.
 * - SEC-08: Revoked query grant -> DENY.
 * - SEC-09: View-only grant cannot execute query -> DENY.
 * - SEC-10: Authorized query grant -> ALLOW.
 * 
 * Mode: Hermetic Unit & Isolated Governance Verification
 */

const assert = require('assert');
const path = require('path');
const {
  canUserAccessDataset,
  shareDataset,
  revokeDatasetShare,
  listDatasetsForUser,
} = require('../auth-service/services/biDatasetRegistry');

console.log('================================================================');
console.log('SOTRANS HUB — TASK 01: DATASET SECURITY & GOVERNANCE TEST SUITE');
console.log('================================================================');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failedTests++;
  }
}

// -------------------------------------------------------------
// FIXTURE DATA
// -------------------------------------------------------------
const validDataset = {
  file_id: 'ds-sec-valid-01',
  original_filename: 'payroll_stl_2026.xlsx',
  company_id: 'STL',
  uploaded_by: 'usr-owner-01',
  uploaded_by_username: 'owner_stl',
  processing_status: 'READY',
  retention_expiry: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), // 7 days in future
  shared_with: [],
};

const expiredDataset = {
  file_id: 'ds-sec-expired-01',
  original_filename: 'old_payroll_stl_2020.xlsx',
  company_id: 'STL',
  uploaded_by: 'usr-owner-01',
  uploaded_by_username: 'owner_stl',
  processing_status: 'READY',
  retention_expiry: '2020-01-01T00:00:00.000Z', // In the past
  shared_with: [],
};

const expiredStatusDataset = {
  file_id: 'ds-sec-expired-status-01',
  original_filename: 'archived_stl.xlsx',
  company_id: 'STL',
  uploaded_by: 'usr-owner-01',
  uploaded_by_username: 'owner_stl',
  processing_status: 'EXPIRED',
  retention_expiry: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  shared_with: [],
};

const activeOwner = {
  user_id: 'usr-owner-01',
  username: 'owner_stl',
  role: 'EMPLOYEE',
  company_id: 'STL',
  status: 'ACTIVE',
};

const otherEmployeeStl = {
  user_id: 'usr-emp-02',
  username: 'emp_stl_2',
  role: 'EMPLOYEE',
  company_id: 'STL',
  status: 'ACTIVE',
};

const crossCompanyUser = {
  user_id: 'usr-emp-vtx',
  username: 'emp_vtx_1',
  role: 'EMPLOYEE',
  company_id: 'VTX',
  status: 'ACTIVE',
};

const adminUser = {
  user_id: 'usr-admin-01',
  username: 'superadmin',
  role: 'ADMIN',
  company_id: 'STL',
  status: 'ACTIVE',
};

const inactiveUser = {
  user_id: 'usr-owner-01',
  username: 'owner_stl',
  role: 'EMPLOYEE',
  company_id: 'STL',
  status: 'INACTIVE',
};

// -------------------------------------------------------------
// CORE TEST CASES (SEC-01 to SEC-10)
// -------------------------------------------------------------

// SEC-01: Active owner accesses valid dataset -> ALLOW
runTest('SEC-01: Active owner accesses valid dataset -> ALLOW', () => {
  const res = canUserAccessDataset(validDataset, activeOwner, 'query');
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.role, 'OWNER');
  assert.strictEqual(res.permission, 'query');
});

// SEC-02: Other employee without share -> DENY
runTest('SEC-02: Other employee without share -> DENY', () => {
  const res = canUserAccessDataset(validDataset, otherEmployeeStl, 'query');
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /INSUFFICIENT_PERMISSIONS/);
});

// SEC-03: Cross-company user without authorization -> DENY
runTest('SEC-03: Cross-company user without authorization -> DENY', () => {
  const res = canUserAccessDataset(validDataset, crossCompanyUser, 'query');
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /TENANT_MISMATCH/);
});

// SEC-04: Expired dataset + owner -> DENY
runTest('SEC-04: Expired dataset + owner -> DENY', () => {
  // Test with retention_expiry in past
  const res1 = canUserAccessDataset(expiredDataset, activeOwner, 'query');
  assert.strictEqual(res1.allowed, false);
  assert.strictEqual(res1.reason, 'DATASET_EXPIRED');

  // Test with processing_status = EXPIRED
  const res2 = canUserAccessDataset(expiredStatusDataset, activeOwner, 'query');
  assert.strictEqual(res2.allowed, false);
  assert.strictEqual(res2.reason, 'DATASET_EXPIRED_OR_DELETED');
});

// SEC-05: Expired dataset + ADMIN -> DENY
runTest('SEC-05: Expired dataset + ADMIN -> DENY', () => {
  // Test with retention_expiry in past
  const res1 = canUserAccessDataset(expiredDataset, adminUser, 'query');
  assert.strictEqual(res1.allowed, false);
  assert.strictEqual(res1.reason, 'DATASET_EXPIRED');

  // Test with processing_status = EXPIRED
  const res2 = canUserAccessDataset(expiredStatusDataset, adminUser, 'query');
  assert.strictEqual(res2.allowed, false);
  assert.strictEqual(res2.reason, 'DATASET_EXPIRED_OR_DELETED');
});

// SEC-06: Inactive user -> DENY
runTest('SEC-06: Inactive user -> DENY', () => {
  const res = canUserAccessDataset(validDataset, inactiveUser, 'query');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'ACCOUNT_INACTIVE');

  // Test with isActive: false
  const resInactiveBool = canUserAccessDataset(validDataset, { ...activeOwner, is_active: false }, 'query');
  assert.strictEqual(resInactiveBool.allowed, false);
  assert.strictEqual(resInactiveBool.reason, 'ACCOUNT_INACTIVE');
});

// SEC-07: Missing dataset metadata -> DENY
runTest('SEC-07: Missing dataset metadata -> DENY', () => {
  const res1 = canUserAccessDataset(null, activeOwner, 'view');
  assert.strictEqual(res1.allowed, false);
  assert.strictEqual(res1.reason, 'DATASET_MISSING');

  const res2 = canUserAccessDataset({}, activeOwner, 'view');
  assert.strictEqual(res2.allowed, false);
  assert.strictEqual(res2.reason, 'DATASET_MISSING');

  const res3 = canUserAccessDataset({ invalid: true }, activeOwner, 'query');
  assert.strictEqual(res3.allowed, false);
  assert.strictEqual(res3.reason, 'DATASET_MISSING');
});

// SEC-08: Revoked query grant -> DENY
runTest('SEC-08: Revoked query grant -> DENY', () => {
  // Dataset with a revoked share entry
  const datasetWithRevokedShare = {
    ...validDataset,
    file_id: 'ds-sec-revoked-01',
    shared_with: [
      {
        share_id: 'sh-01',
        target_type: 'user',
        target_id: 'usr-emp-02',
        permission: 'query',
        revoked: true, // explicit revoked flag
      },
      {
        share_id: 'sh-02',
        target_type: 'user',
        target_id: 'usr-emp-vtx',
        permission: 'query',
        status: 'REVOKED', // status revoked flag
      },
    ],
  };

  const resStl = canUserAccessDataset(datasetWithRevokedShare, otherEmployeeStl, 'query');
  assert.strictEqual(resStl.allowed, false);
  assert.match(resStl.reason, /INSUFFICIENT_PERMISSIONS/);

  const resVtx = canUserAccessDataset(datasetWithRevokedShare, crossCompanyUser, 'query');
  assert.strictEqual(resVtx.allowed, false);
  assert.match(resVtx.reason, /TENANT_MISMATCH/);
});

// SEC-09: View-only grant cannot execute query -> DENY
runTest('SEC-09: View-only grant cannot execute query -> DENY', () => {
  const datasetWithViewOnlyShare = {
    ...validDataset,
    file_id: 'ds-sec-viewonly-01',
    shared_with: [
      {
        share_id: 'sh-view-01',
        target_type: 'user',
        target_id: 'usr-emp-02',
        permission: 'view', // view only!
      },
    ],
  };

  // View permission is ALLOWED
  const resView = canUserAccessDataset(datasetWithViewOnlyShare, otherEmployeeStl, 'view');
  assert.strictEqual(resView.allowed, true);
  assert.strictEqual(resView.permission, 'view');

  // Query permission is DENIED
  const resQuery = canUserAccessDataset(datasetWithViewOnlyShare, otherEmployeeStl, 'query');
  assert.strictEqual(resQuery.allowed, false);
  assert.match(resQuery.reason, /INSUFFICIENT_PERMISSION/);
});

// SEC-10: Authorized query grant -> ALLOW
runTest('SEC-10: Authorized query grant -> ALLOW', () => {
  const datasetWithQueryShare = {
    ...validDataset,
    file_id: 'ds-sec-queryshare-01',
    shared_with: [
      {
        share_id: 'sh-query-01',
        target_type: 'user',
        target_id: 'usr-emp-02',
        permission: 'query',
      },
      {
        share_id: 'sh-query-cross-02',
        target_type: 'user',
        target_id: 'usr-emp-vtx',
        permission: 'query',
      },
    ],
  };

  // Same company query grant
  const resStl = canUserAccessDataset(datasetWithQueryShare, otherEmployeeStl, 'query');
  assert.strictEqual(resStl.allowed, true);
  assert.strictEqual(resStl.permission, 'query');
  assert.strictEqual(resStl.role, 'SHARED');

  // Authorized cross-company query grant
  const resVtx = canUserAccessDataset(datasetWithQueryShare, crossCompanyUser, 'query');
  assert.strictEqual(resVtx.allowed, true);
  assert.strictEqual(resVtx.permission, 'query');
  assert.strictEqual(resVtx.role, 'SHARED');
});

// -------------------------------------------------------------
// ADDITIONAL HARDENING CHECKS
// -------------------------------------------------------------

// SEC-11: ADMIN cross-company access on valid active dataset -> ALLOW
runTest('SEC-11: ADMIN cross-company access on valid active dataset -> ALLOW', () => {
  const vtxDataset = {
    ...validDataset,
    file_id: 'ds-vtx-01',
    company_id: 'VTX',
    uploaded_by: 'usr-emp-vtx',
  };
  const res = canUserAccessDataset(vtxDataset, adminUser, 'query');
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.role, 'ADMIN');
  assert.strictEqual(res.permission, 'query');
});

// SEC-12: Inactive ADMIN is blocked -> DENY
runTest('SEC-12: Inactive ADMIN is blocked -> DENY', () => {
  const inactiveAdmin = { ...adminUser, status: 'LOCKED' };
  const res = canUserAccessDataset(validDataset, inactiveAdmin, 'query');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'ACCOUNT_INACTIVE');
});

// SEC-13: Missing data / Failed dataset -> DENY
runTest('SEC-13: Missing data / Failed dataset -> DENY', () => {
  const failedDataset = { ...validDataset, processing_status: 'FAILED' };
  const res = canUserAccessDataset(failedDataset, adminUser, 'query');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'DATASET_UNAVAILABLE');
});

console.log('================================================================');
console.log(`TASK 01 TEST SUMMARY: ${passedTests} / ${passedTests + failedTests} PASS | ${failedTests} FAIL`);
console.log('================================================================');

if (failedTests > 0) {
  process.exit(1);
}
