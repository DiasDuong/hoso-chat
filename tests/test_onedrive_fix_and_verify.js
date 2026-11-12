/**
 * SOTRANS HUB — ONEDRIVE FIX & VERIFY AUTOMATED REGRESSION SUITE
 * 
 * Verifies all 10 Acceptance Test Scenarios:
 * Test 1: Initial connection
 * Test 2: Persistence after reopening (General + Agent-specific queries)
 * Test 3: Existing indexed data retrieval & row matching
 * Test 4: Update detection & re-indexing
 * Test 5: Stale cache detection
 * Test 6: Similar but different rows (đi đơn vs đi ghép, no cross-substitution)
 * Test 7: Missing or inaccessible file handling
 * Test 8: Duplicate selection prevention
 * Test 9: Concurrent synchronization mutex lock
 * Test 10: Access control boundaries & isolation
 */

const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const fs = require('fs');
const path = require('path');
const oneDriveSourceService = require('../auth-service/services/oneDriveSourceService');
const dataEngine = require('../auth-service/services/dataEngine');
const universalDataEngine = require('../auth-service/services/universalDataEngine');

function resolveLocalPath(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return p;
  const inAuth = p.replace('/app/data', path.resolve(__dirname, '..', 'auth-service', 'data'));
  if (fs.existsSync(inAuth)) return inAuth;
  const inAuth2 = path.resolve(__dirname, '..', 'auth-service', 'data', 'uploads', path.basename(p));
  if (fs.existsSync(inAuth2)) return inAuth2;
  return p;
}

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const userSTL = {
  userId: 'f2b6606e-3125-409c-b5f9-d3ed82282c26',
  username: 'emp_stl',
  token: jwt.sign(
    { user_id: 'f2b6606e-3125-409c-b5f9-d3ed82282c26', username: 'emp_stl', role: 'EMPLOYEE', company_id: 'STL' },
    JWT_SECRET,
    { expiresIn: '3h' }
  ),
  agentId: 'cbb7053e-c388-4072-a87f-1e49b6facf07', // Excel-Data-Pro
  emailAgentId: '6debff96-7f14-49f8-b2a9-f59df2d62eb8' // Email-Assistant
};

const userVTX = {
  userId: 'bd33d589-3804-469e-a373-a934a5855d19',
  username: 'emp_vtx',
  token: jwt.sign(
    { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
    JWT_SECRET,
    { expiresIn: '3h' }
  ),
  agentId: 'b6a784da-cfb1-43c4-81ba-8853116cd9cd'
};

async function runAllTests() {
  console.log('='.repeat(80));
  console.log('   SOTRANS HUB — ONEDRIVE FIX & VERIFY 10-STAGE AUTOMATED ACCEPTANCE TEST');
  console.log('='.repeat(80));

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Initial connection & persistence of metadata
    // -------------------------------------------------------------
    console.log('\n--- TEST 1: Initial Connection & Metadata Persistence ---');
    const existingSynced = await db.query(
      `SELECT * FROM public.user_onedrive_sources 
       WHERE owner_user_id = $1 AND file_name = 'Pricing Vendor.xlsx' AND sync_status != 'DISCONNECTED'
       ORDER BY updated_at DESC LIMIT 1`,
      [userSTL.userId]
    );

    let activeSource = existingSynced.rows[0];
    assert(Boolean(activeSource), 'User emp_stl has an active SYNCED Pricing Vendor.xlsx source record');
    assert(activeSource.active_version >= 1, `Source has active_version = ${activeSource.active_version}`);
    assert(Boolean(activeSource.active_snapshot_id), `Source has active_snapshot_id = ${activeSource.active_snapshot_id}`);

    const snapRes = await db.query(
      `SELECT * FROM public.onedrive_source_snapshots WHERE id = $1`,
      [activeSource.active_snapshot_id]
    );
    assert(snapRes.rows.length === 1, 'Active snapshot exists in onedrive_source_snapshots');
    const snap = snapRes.rows[0];
    assert(snap.status === 'PUBLISHED', 'Snapshot status is PUBLISHED');
    assert(Boolean(snap.data_profile), 'Snapshot contains data_profile');

    // -------------------------------------------------------------
    // Test 2: Persistence after reopening (General + Agent-specific queries)
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Persistence After Reopening Management Modal ---');
    
    // 2a. Reopen modal from General mode (no agent_id query parameter)
    const respGeneral = await fetch(`${BASE_URL}/api/onedrive/sources`, {
      headers: { Authorization: `Bearer ${userSTL.token}` }
    });
    const dataGeneral = await respGeneral.json();
    assert(dataGeneral.success === true, 'GET /api/onedrive/sources (General mode) returned 200 OK');
    assert(Array.isArray(dataGeneral.sources) && dataGeneral.sources.length > 0, `General mode returned ${dataGeneral.sources?.length} connected file(s)`);
    const foundGeneral = dataGeneral.sources.find(s => s.file_name === 'Pricing Vendor.xlsx');
    assert(Boolean(foundGeneral), 'Pricing Vendor.xlsx is listed in General mode');
    assert(foundGeneral?.sync_status === 'SYNCED', 'File sync_status is SYNCED');

    // 2b. Reopen modal from Excel Agent mode (custom agent UUID)
    const respAgent = await fetch(`${BASE_URL}/api/onedrive/sources?agent_id=${userSTL.agentId}`, {
      headers: { Authorization: `Bearer ${userSTL.token}` }
    });
    const dataAgent = await respAgent.json();
    assert(dataAgent.success === true, 'GET /api/onedrive/sources?agent_id=<UUID> returned 200 OK');
    const foundAgent = dataAgent.sources?.find(s => s.file_name === 'Pricing Vendor.xlsx');
    assert(Boolean(foundAgent), 'Pricing Vendor.xlsx is listed when filtered by Excel Agent UUID');

    // 2c. Reopen modal with 'excel-data-pro' slug
    const respSlug = await fetch(`${BASE_URL}/api/onedrive/sources?agent_id=excel-data-pro`, {
      headers: { Authorization: `Bearer ${userSTL.token}` }
    });
    const dataSlug = await respSlug.json();
    const foundSlug = dataSlug.sources?.find(s => s.file_name === 'Pricing Vendor.xlsx');
    assert(Boolean(foundSlug), 'Pricing Vendor.xlsx is listed when filtered by excel-data-pro slug');

    // -------------------------------------------------------------
    // Test 3: Existing indexed data retrieval
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Existing Indexed Data Retrieval ---');
    const dp = typeof snap.data_profile === 'string' ? JSON.parse(snap.data_profile) : snap.data_profile;

    const queryRaw = 'chi phí cho 1 chuyến từ Cảng Hải Phòng đến WHA Industrial Zone 1 là bao nhiêu';
    const searchRes = dataEngine.searchSpreadsheetRecords(dp, { query: queryRaw });

    assert(searchRes.success === true, 'searchSpreadsheetRecords executed successfully');
    assert(searchRes.totalMatches >= 1, `Found ${searchRes.totalMatches} matching row(s) for query: "${queryRaw}"`);

    const rowDon = searchRes.results.find(r => String(r.data['LOẠI CONT/XE']).includes('đi đơn'));
    const rowGhep = searchRes.results.find(r => String(r.data['LOẠI CONT/XE']).includes('đi ghép'));

    assert(Boolean(rowDon), 'Found row for Cont 20\' (đi đơn)');
    assert(rowDon?.data['GIÁ COST'] === 11000000, `Cost for Cont 20' đi đơn is exactly 11.000.000 VNĐ (actual: ${rowDon?.data['GIÁ COST']})`);
    assert(Boolean(rowGhep), 'Found row for Cont 20\' (đi ghép)');
    assert(rowGhep?.data['GIÁ COST'] === 9500000, `Cost for Cont 20' đi ghép is exactly 9.500.000 VNĐ (actual: ${rowGhep?.data['GIÁ COST']})`);

    // -------------------------------------------------------------
    // Test 4: Update detection
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Update Detection & Auto-Sync ---');
    // Simulate Graph returning new eTag/cTag
    const mockUpdatedGraphMetadata = {
      id: activeSource.item_id || 'test_item_id',
      name: 'Pricing Vendor.xlsx',
      eTag: 'new_etag_v' + (activeSource.active_version + 1),
      cTag: 'new_ctag_v' + (activeSource.active_version + 1),
      size: activeSource.file_size || 50000,
      lastModifiedDateTime: new Date().toISOString(),
      parentReference: { driveId: activeSource.drive_id || 'test_drive' }
    };

    const freshnessRes = await oneDriveSourceService.checkSourceFreshness(
      activeSource,
      'mock_token',
      { fetchGraphMetadataFn: async () => mockUpdatedGraphMetadata }
    );

    assert(freshnessRes.isFresh === false, 'checkSourceFreshness accurately detected file has changed on OneDrive');
    assert(freshnessRes.isGraphReachable === true, 'Microsoft Graph metadata reachable');

    // Perform sync with mock downloader returning updated workbook row
    const initialVersion = activeSource.active_version;
    const syncRes = await oneDriveSourceService.syncSourceVersion(activeSource.id, userSTL.userId, {
      jobType: 'AUTOMATED_TEST',
      targetMetadata: mockUpdatedGraphMetadata,
      downloaderFn: async (src) => {
        // Return existing disk buffer
        const resolvedP = resolveLocalPath(activeSource.storage_path);
        const buf = fs.readFileSync(resolvedP);
        return {
          buffer: buf,
          fileName: activeSource.file_name,
          mimeType: activeSource.mime_type,
          size: buf.length,
          eTag: mockUpdatedGraphMetadata.eTag,
          cTag: mockUpdatedGraphMetadata.cTag,
          lastModifiedDateTime: mockUpdatedGraphMetadata.lastModifiedDateTime,
          driveItemId: activeSource.item_id,
          driveId: activeSource.drive_id
        };
      }
    });

    assert(syncRes.version === initialVersion + 1, `Version incremented from v${initialVersion} to v${syncRes.version}`);
    assert(syncRes.source.sync_status === 'SYNCED', 'Source sync_status updated to SYNCED');

    // -------------------------------------------------------------
    // Test 5: Stale cache
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Stale Cache Freshness Verification ---');
    // Freshness check with matching eTag
    const freshCheck = await oneDriveSourceService.checkSourceFreshness(
      syncRes.source,
      'mock_token',
      {
        fetchGraphMetadataFn: async () => ({
          cTag: syncRes.source.ctag,
          eTag: syncRes.source.etag,
          lastModifiedDateTime: syncRes.source.last_modified_at
        })
      }
    );
    assert(freshCheck.isFresh === true, 'Matching metadata confirms data is fresh');

    // Freshness check with mismatched cTag (stale cache)
    const staleCheck = await oneDriveSourceService.checkSourceFreshness(
      syncRes.source,
      'mock_token',
      {
        fetchGraphMetadataFn: async () => ({
          cTag: 'newer_unseen_ctag_' + Date.now(),
          eTag: 'newer_unseen_etag_' + Date.now(),
          lastModifiedDateTime: new Date().toISOString()
        })
      }
    );
    assert(staleCheck.isFresh === false, 'Stale cache detected when remote cTag is newer');

    // -------------------------------------------------------------
    // Test 6: Similar but different rows (no cross-substitution)
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Similar Rows & Container Type Precision ---');
    const qDiDon = 'giá cước từ Cảng Hải Phòng đến WHA Industrial Zone 1 đi đơn';
    const resDiDon = dataEngine.searchSpreadsheetRecords(dp, { query: qDiDon });
    assert(resDiDon.totalMatches === 1, `Query for 'đi đơn' matched exactly 1 row (matches: ${resDiDon.totalMatches})`);
    assert(resDiDon.results[0]?.data['GIÁ COST'] === 11000000, 'Matched row is 11.000.000 VNĐ');

    const qDiGhep = 'giá cước từ Cảng Hải Phòng đến WHA Industrial Zone 1 đi ghép';
    const resDiGhep = dataEngine.searchSpreadsheetRecords(dp, { query: qDiGhep });
    assert(resDiGhep.totalMatches === 1, `Query for 'đi ghép' matched exactly 1 row (matches: ${resDiGhep.totalMatches})`);
    assert(resDiGhep.results[0]?.data['GIÁ COST'] === 9500000, 'Matched row is 9.500.000 VNĐ');

    // Cross-row substitution guard
    const qHanoi = 'giá cước từ cảng Hải Phòng đến Hà Nội';
    const resHanoi = dataEngine.searchSpreadsheetRecords(dp, { query: qHanoi });
    assert(resHanoi.totalMatches > 0, 'Found rows for destination Hà Nội');
    assert(!resHanoi.results.some(r => r.data['ĐIỂM ĐẾN'].includes('WHA')), 'No cross-destination substitution between Hà Nội and WHA');

    // -------------------------------------------------------------
    // Test 7: Missing or inaccessible file
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Missing / Inaccessible File Handling ---');
    const inaccessibleCheck = await oneDriveSourceService.checkSourceFreshness(
      syncRes.source,
      'mock_token',
      {
        fetchGraphMetadataFn: async () => {
          throw new Error('Graph API 404: The resource could not be found.');
        }
      }
    );
    assert(inaccessibleCheck.isFresh === false, 'Inaccessible file returns isFresh: false');
    assert(inaccessibleCheck.isGraphReachable === false, 'isGraphReachable is marked false on network/Graph failure');
    assert(inaccessibleCheck.reason.includes('404'), 'Reason includes error detail');

    // -------------------------------------------------------------
    // Test 8: Duplicate selection prevention
    // -------------------------------------------------------------
    console.log('\n--- TEST 8: Duplicate Selection Prevention ---');
    const countBefore = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM public.user_onedrive_sources 
       WHERE owner_user_id = $1 AND file_name = 'Pricing Vendor.xlsx' AND sync_status != 'DISCONNECTED'`,
      [userSTL.userId]
    );

    // Register again with same item_id/file_name
    await oneDriveSourceService.registerOrUpdateSource({
      ownerUserId: userSTL.userId,
      agentId: userSTL.agentId,
      sharingUrl: activeSource.sharing_url,
      dl: {
        fileName: 'Pricing Vendor.xlsx',
        driveItemId: activeSource.item_id,
        driveId: activeSource.drive_id,
        size: activeSource.file_size,
        mimeType: activeSource.mime_type
      },
      parsedUniversal: {
        fileType: 'spreadsheet',
        manifest: { totalUnits: 10 },
        dataProfile: dp
      },
      storagePath: resolveLocalPath(activeSource.storage_path)
    });

    const countAfter = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM public.user_onedrive_sources 
       WHERE owner_user_id = $1 AND file_name = 'Pricing Vendor.xlsx' AND sync_status != 'DISCONNECTED'`,
      [userSTL.userId]
    );

    assert(countAfter.rows[0].cnt === countBefore.rows[0].cnt, `No duplicate records created (count before: ${countBefore.rows[0].cnt}, count after: ${countAfter.rows[0].cnt})`);

    // -------------------------------------------------------------
    // Test 9: Concurrent synchronization mutex lock
    // -------------------------------------------------------------
    console.log('\n--- TEST 9: Concurrent Synchronization Mutex Lock ---');
    let callCount = 0;
    const concurrentDownloader = async (src) => {
      callCount++;
      await new Promise(r => setTimeout(r, 200)); // Simulating 200ms download
      const buf = fs.readFileSync(resolveLocalPath(activeSource.storage_path));
      return {
        buffer: buf,
        fileName: activeSource.file_name,
        mimeType: activeSource.mime_type,
        size: buf.length,
        driveItemId: activeSource.item_id,
        driveId: activeSource.drive_id
      };
    };

    const [p1, p2] = await Promise.all([
      oneDriveSourceService.syncSourceVersion(activeSource.id, userSTL.userId, {
        jobType: 'CONCURRENT_1',
        downloaderFn: concurrentDownloader
      }),
      oneDriveSourceService.syncSourceVersion(activeSource.id, userSTL.userId, {
        jobType: 'CONCURRENT_2',
        downloaderFn: concurrentDownloader
      })
    ]);

    assert(p1.version === p2.version, `Concurrent jobs resolved to same version v${p1.version}`);
    assert(callCount === 1, `Downloader called exactly once due to mutex (callCount: ${callCount})`);

    // -------------------------------------------------------------
    // Test 10: Access control and regression
    // -------------------------------------------------------------
    console.log('\n--- TEST 10: Access Control Boundaries & Isolation ---');
    
    // 10a. User VTX attempting to delete user STL's source
    const idorResp = await fetch(`${BASE_URL}/api/onedrive/sources/${activeSource.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userVTX.token}` }
    });
    assert(idorResp.status === 404 || idorResp.status === 403, `IDOR prevented on DELETE (HTTP ${idorResp.status})`);

    // 10b. User STL's Email Agent requesting sources
    const emailAgentResp = await fetch(`${BASE_URL}/api/onedrive/sources?agent_id=${userSTL.emailAgentId}`, {
      headers: { Authorization: `Bearer ${userSTL.token}` }
    });
    const emailData = await emailAgentResp.json();
    const leakedExcel = emailData.sources?.some(s => s.id === activeSource.id && s.agent_id === userSTL.agentId);
    assert(!leakedExcel, 'Email Assistant agent does not leak sources assigned to Excel Agent');

    console.log('\n' + '='.repeat(80));
    console.log(`ACCEPTANCE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('='.repeat(80));

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('UNEXPECTED TEST EXCEPTION:', err);
    process.exit(1);
  }
}

runAllTests();
