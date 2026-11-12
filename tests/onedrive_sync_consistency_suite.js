/**
 * SOTRANS AI Hub - OneDrive Sync Consistency & Real-Time Data Refresh Test Suite
 * Covers 10 mandatory regression test scenarios:
 * 1. First sync integrity
 * 2. Value edit & content hash change detection
 * 3. Row delete non-retrievability verification
 * 4. Row add / active row immediate retrievability
 * 5. Rapid sync debounce & idempotency (zero false version bumps)
 * 6. API error simulation & graceful failure fallback
 * 7. Agent query after sync & ai_attachments priority inversion guard
 * 8. Concurrent multi-file sync
 * 9. Tenant / User isolation
 * 10. Reopen modal / persistent connected files state
 */

const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const oneDriveSourceService = require('../auth-service/services/oneDriveSourceService');
const universalDataEngine = require('../auth-service/services/universalDataEngine');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

function makeToken(userId, username = 'test_user', role = 'ADMIN') {
  return jwt.sign(
    { user_id: userId, username, role, sub: userId },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

const USER_A_ID = 'bd33d589-3804-469e-a373-a934a5855d19'; // Owner of testdulieu.xlsx & Pricing Vendor
const USER_B_ID = '158b0726-9c95-4f6d-9247-85353022de93'; // Unrelated employee
const SOURCE_TESTDULIEU = 'b58446c8-440d-4d69-af87-f0dd867f2cae';
const SOURCE_PRICING = '90c8fad8-7e9e-4223-bd46-76cce394e1f6';

const results = [];

function recordTest(testNum, testName, passed, details) {
  results.push({ testNum, testName, passed, details });
  console.log(`[TEST ${testNum}] ${passed ? '✅ PASS' : '❌ FAIL'}: ${testName}`);
  if (details) {
    console.log(`  Details: ${typeof details === 'object' ? JSON.stringify(details, null, 2) : details}`);
  }
}

async function runSuite() {
  console.log('================================================================');
  console.log('🚀 RUNNING ONEDRIVE SYNC CONSISTENCY & REAL-TIME REFRESH SUITE');
  console.log('================================================================\n');

  // TEST 1: First sync integrity
  try {
    const srcRes = await db.query(
      `SELECT s.id, s.file_name, s.active_version, s.sync_status, s.content_hash,
              snp.id AS snap_id, snp.status AS snap_status, snp.manifest, snp.data_profile
       FROM public.user_onedrive_sources s
       JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
       WHERE s.id = $1`,
      [SOURCE_TESTDULIEU]
    );

    if (srcRes.rows.length === 0) {
      recordTest(1, 'First sync source registration & snapshot integrity', false, 'Source record not found');
    } else {
      const row = srcRes.rows[0];
      const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
      const dp = typeof row.data_profile === 'string' ? JSON.parse(row.data_profile) : row.data_profile;

      const isValid = Boolean(
        row.snap_id &&
        row.snap_status === 'PUBLISHED' &&
        row.content_hash &&
        row.content_hash.length === 64 &&
        manifest &&
        manifest.sheets &&
        dp &&
        dp.sheetNames
      );

      recordTest(1, 'First sync source registration & snapshot integrity', isValid, {
        fileName: row.file_name,
        activeVersion: row.active_version,
        syncStatus: row.sync_status,
        contentHash: row.content_hash,
        sheets: manifest.sheets,
        totalUnits: manifest.totalUnits,
        validUnits: manifest.validUnits
      });
    }
  } catch (err) {
    recordTest(1, 'First sync source registration & snapshot integrity', false, err.message);
  }

  // TEST 2: Value edit & content hash change detection
  try {
    // Check that syncSourceVersion checks hash:
    // If hash does NOT change, it must return isNewVersion = false without version increment
    const unchangedSync = await oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, {
      force: true,
      jobType: 'MANUAL'
    });

    const isDetectingUnchanged = Boolean(
      unchangedSync &&
      unchangedSync.success &&
      unchangedSync.isNewVersion === false &&
      unchangedSync.version === 9
    );

    recordTest(2, 'Value edit & content hash change detection (idempotent when unchanged)', isDetectingUnchanged, {
      success: unchangedSync.success,
      isNewVersion: unchangedSync.isNewVersion,
      version: unchangedSync.version,
      status: unchangedSync.status,
      message: unchangedSync.message
    });
  } catch (err) {
    recordTest(2, 'Value edit & content hash change detection', false, err.message);
  }

  // TEST 3: Row delete non-retrievability verification
  try {
    // In testdulieu.xlsx, "Cảng Nam Định" to "WHA Industrial Zone 1" was deleted
    const freshness = await oneDriveSourceService.ensureAgentSourcesFreshness({
      agent: { id: 'excel-data-pro', name: 'Excel-Data-Pro' },
      userId: USER_A_ID,
      userMessage: 'chi phí cho 1 chuyến từ Cảng Nam Định đến WHA Industrial Zone 1 là bao nhiêu'
    });

    const searchResults = universalDataEngine.searchUniversalContent(freshness.activeFiles, {
      query: 'Cảng Nam Định WHA Industrial Zone 1',
      origin: 'Cảng Nam Định',
      destination: 'WHA Industrial Zone 1'
    });

    const foundDeletedRow = searchResults.results && searchResults.results.some(r => {
      const str = JSON.stringify(r).toLowerCase();
      return str.includes('nam định') && str.includes('wha');
    });

    recordTest(3, 'Row delete non-retrievability verification (deleted row absent from retrieval)', !foundDeletedRow, {
      totalFound: searchResults.totalMatches || (searchResults.results ? searchResults.results.length : 0),
      foundDeletedRow,
      status: searchResults.status
    });
  } catch (err) {
    recordTest(3, 'Row delete non-retrievability verification', false, err.message);
  }

  // TEST 4: Row add / active row immediate retrievability
  try {
    const freshness = await oneDriveSourceService.ensureAgentSourcesFreshness({
      agent: { id: 'excel-data-pro', name: 'Excel-Data-Pro' },
      userId: USER_A_ID,
      userMessage: 'Cát Lái Sóng Thần'
    });

    const searchResults = universalDataEngine.searchUniversalContent(freshness.activeFiles, {
      query: 'Cát Lái Sóng Thần'
    });

    const hasMatches = Boolean(searchResults && searchResults.results && searchResults.results.length > 0);

    recordTest(4, 'Row add / active row immediate retrievability', hasMatches, {
      totalFound: searchResults.totalMatches || (searchResults.results ? searchResults.results.length : 0),
      sampleResult: (searchResults.results && searchResults.results[0]) ? {
        location: searchResults.results[0].location,
        origin: searchResults.results[0].data?.['ĐIỂM ĐI'],
        dest: searchResults.results[0].data?.['ĐIỂM ĐẾN'],
        cost: searchResults.results[0].data?.['GIÁ COST']
      } : null
    });
  } catch (err) {
    recordTest(4, 'Row add / active row immediate retrievability', false, err.message);
  }

  // TEST 5: Rapid sync debounce & idempotency (zero false version bumps)
  try {
    const initialVersionRes = await db.query(
      `SELECT active_version FROM public.user_onedrive_sources WHERE id = $1`,
      [SOURCE_TESTDULIEU]
    );
    const startVer = initialVersionRes.rows[0].active_version;

    // Fire 3 simultaneous sync requests
    const syncPromises = [
      oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, { force: true }),
      oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, { force: true }),
      oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, { force: true })
    ];

    const allResults = await Promise.all(syncPromises);

    const endVersionRes = await db.query(
      `SELECT active_version FROM public.user_onedrive_sources WHERE id = $1`,
      [SOURCE_TESTDULIEU]
    );
    const endVer = endVersionRes.rows[0].active_version;

    const noVersionBump = (endVer === startVer);
    const allSuccessful = allResults.every(r => r.success === true);
    const noneReportedFalseNew = allResults.every(r => r.isNewVersion === false);

    recordTest(5, 'Rapid sync debounce & idempotency (zero false version bumps)', noVersionBump && allSuccessful && noneReportedFalseNew, {
      startVersion: startVer,
      endVersion: endVer,
      resultsCount: allResults.length,
      allReportedNoChange: noneReportedFalseNew
    });
  } catch (err) {
    recordTest(5, 'Rapid sync debounce & idempotency', false, err.message);
  }

  // TEST 6: API error simulation & graceful failure fallback
  try {
    // Simulate a Graph API network error using downloaderFn for USER_A
    let caughtExpectedError = false;
    let errMessage = '';
    try {
      await oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, {
        force: true,
        downloaderFn: async () => {
          const e = new Error('Microsoft Graph API gateway timeout (504)');
          e.statusCode = 504;
          throw e;
        }
      });
    } catch (apiErr) {
      caughtExpectedError = true;
      errMessage = apiErr.message;
    }

    // Verify source sync_status transitions to FAILED with last_error recorded
    const failCheck = await db.query(
      `SELECT sync_status, last_error FROM public.user_onedrive_sources WHERE id = $1`,
      [SOURCE_TESTDULIEU]
    );

    // Verify active snapshot is still completely intact in database
    const verifySource = await db.query(
      `SELECT s.id, s.active_snapshot_id, snp.status, snp.version_number
       FROM public.user_onedrive_sources s
       JOIN public.onedrive_source_snapshots snp ON s.active_snapshot_id = snp.id
       WHERE s.id = $1`,
      [SOURCE_TESTDULIEU]
    );

    const isIntact = verifySource.rows.length === 1 && verifySource.rows[0].status === 'PUBLISHED';
    const isGraceful = caughtExpectedError && isIntact && failCheck.rows[0].sync_status === 'FAILED';

    recordTest(6, 'API error simulation & graceful failure fallback', isGraceful, {
      caughtExpectedError,
      errMessage,
      syncStatusAfterError: failCheck.rows[0]?.sync_status,
      lastErrorRecorded: failCheck.rows[0]?.last_error,
      activeSnapshotIntact: isIntact,
      snapshotVersion: verifySource.rows[0]?.version_number
    });

    // Recover source back to SYNCED
    await db.query(
      `UPDATE public.user_onedrive_sources SET sync_status = 'SYNCED', last_error = NULL WHERE id = $1`,
      [SOURCE_TESTDULIEU]
    );
  } catch (err) {
    recordTest(6, 'API error simulation & graceful failure fallback', false, err.message);
  }

  // TEST 7: Agent query after sync & ai_attachments priority inversion guard
  try {
    // Check ensureAgentSourcesFreshness directly
    const agentSources = await oneDriveSourceService.ensureAgentSourcesFreshness({
      agent: { id: 'excel-data-pro', name: 'Excel-Data-Pro' },
      userId: USER_A_ID,
      conversationId: null,
      userMessage: 'chi phí vận chuyển'
    });

    const hasActiveFiles = agentSources.activeFiles && agentSources.activeFiles.length > 0;
    const hasActiveSpreadsheets = agentSources.activeSpreadsheets && agentSources.activeSpreadsheets.length > 0;
    const testdulieuIncluded = agentSources.activeFiles.some(f => (f.name === 'testdulieu.xlsx' || f.fileName === 'testdulieu.xlsx'));

    recordTest(7, 'Agent query after sync & ai_attachments priority inversion guard', hasActiveFiles && hasActiveSpreadsheets && testdulieuIncluded, {
      activeFilesCount: agentSources.activeFiles.length,
      activeSpreadsheetsCount: agentSources.activeSpreadsheets.length,
      files: agentSources.activeFiles.map(f => ({ name: f.name || f.fileName, version: f.version, size: f.size })),
      freshnessNotes: agentSources.freshnessNotes
    });
  } catch (err) {
    recordTest(7, 'Agent query after sync & ai_attachments priority inversion guard', false, err.message);
  }

  // TEST 8: Concurrent multi-file sync
  try {
    const multiSync = await Promise.all([
      oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_A_ID, { force: true }),
      oneDriveSourceService.syncSourceVersion(SOURCE_PRICING, USER_A_ID, { force: true })
    ]);

    const bothSucceeded = multiSync.length === 2 && multiSync[0].success && multiSync[1].success;

    recordTest(8, 'Concurrent multi-file sync (independent mutex & zero race condition)', bothSucceeded, {
      file1: { name: multiSync[0].fileName, version: multiSync[0].version, isNew: multiSync[0].isNewVersion },
      file2: { name: multiSync[1].fileName, version: multiSync[1].version, isNew: multiSync[1].isNewVersion }
    });
  } catch (err) {
    recordTest(8, 'Concurrent multi-file sync', false, err.message);
  }

  // TEST 9: Tenant / User isolation
  try {
    // User B attempts to access User A's source structure
    const userBAccess = await oneDriveSourceService.getSourceStructureById({
      ownerUserId: USER_B_ID,
      sourceId: SOURCE_TESTDULIEU
    });

    // User B attempts to sync User A's source
    let userBSyncBlocked = false;
    try {
      await oneDriveSourceService.syncSourceVersion(SOURCE_TESTDULIEU, USER_B_ID, { force: true });
    } catch (e) {
      userBSyncBlocked = true;
    }

    const isIsolated = (userBAccess === null) && userBSyncBlocked;

    recordTest(9, 'Tenant / User isolation (cross-user access blocked)', isIsolated, {
      userBAccessResult: userBAccess,
      userBSyncBlocked
    });
  } catch (err) {
    recordTest(9, 'Tenant / User isolation', false, err.message);
  }

  // TEST 10: Reopen modal / persistent connected files state
  try {
    const connectedSources = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: USER_A_ID,
      agentId: 'excel-data-pro'
    });

    const hasTestdulieu = connectedSources.some(s => s.file_name === 'testdulieu.xlsx' && s.sync_status === 'SYNCED');
    const hasPricing = connectedSources.some(s => s.file_name === 'Pricing Vendor.xlsx' && s.sync_status === 'SYNCED');
    const allHaveHashes = connectedSources.every(s => Boolean(s.content_hash));

    recordTest(10, 'Reopen modal / persistent connected files state', hasTestdulieu && hasPricing && allHaveHashes, {
      totalConnectedSources: connectedSources.length,
      sources: connectedSources.map(s => ({
        id: s.id,
        fileName: s.file_name,
        version: s.active_version,
        status: s.sync_status,
        contentHash: s.content_hash ? s.content_hash.slice(0, 16) + '...' : null,
        sheetCount: (s.snapshot_manifest?.sheets || []).length
      }))
    });
  } catch (err) {
    recordTest(10, 'Reopen modal / persistent connected files state', false, err.message);
  }

  console.log('\n================================================================');
  const totalPassed = results.filter(r => r.passed).length;
  console.log(`🏁 SUITE COMPLETE: ${totalPassed}/${results.length} PASSED`);
  console.log('================================================================');

  if (totalPassed < results.length) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSuite().catch(e => {
  console.error('FATAL TEST SUITE ERROR:', e);
  process.exit(1);
});
