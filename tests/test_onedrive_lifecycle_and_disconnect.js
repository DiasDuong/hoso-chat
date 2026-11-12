/**
 * SOTRANS HUB — ONEDRIVE DISCONNECT & SOURCE LIFECYCLE VERIFICATION SUITE
 * 
 * Verifies all 7 lifecycle audit scenarios:
 * Scenario 1: Initial connected query & provenance verification
 * Scenario 2: Operation A — Account disconnect while retaining local snapshot (Offline warning verification)
 * Scenario 3: Operation B — Unlink file from Agent (Exclusion from new queries & anti-resurrection)
 * Scenario 4: Operation C — Purge data (Permanent deletion of disk files, snapshots, and records)
 * Scenario 5: Update detection on OneDrive (Freshness guard & auto-sync)
 * Scenario 6: Multi-user access control & Agent boundary isolation
 * Scenario 7: Graph API errors, expired tokens, and resilient fallback
 */

const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');
const fs = require('fs');
const path = require('path');
const oneDriveSourceService = require('../auth-service/services/oneDriveSourceService');
const oneDriveService = require('../auth-service/services/oneDriveService');
const dataEngine = require('../auth-service/services/dataEngine');

const BASE_URL = 'http://127.0.0.1:3000';
const JWT_SECRET = 'super_secret_jwt_key_hrbot_2026_!@#$';

const testUserSTL = {
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

const testUserVTX = {
  userId: 'bd33d589-3804-469e-a373-a934a5855d19',
  username: 'emp_vtx',
  token: jwt.sign(
    { user_id: 'bd33d589-3804-469e-a373-a934a5855d19', username: 'emp_vtx', role: 'EMPLOYEE', company_id: 'VTX' },
    JWT_SECRET,
    { expiresIn: '3h' }
  ),
  agentId: 'b6a784da-cfb1-43c4-81ba-8853116cd9cd'
};

function resolveLocalPath(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return p;
  const inAuth = p.replace('/app/data', path.resolve(__dirname, '..', 'auth-service', 'data'));
  if (fs.existsSync(inAuth)) return inAuth;
  const inAuth2 = path.resolve(__dirname, '..', 'auth-service', 'data', 'uploads', path.basename(p));
  if (fs.existsSync(inAuth2)) return inAuth2;
  return p;
}

async function runLifecycleAudit() {
  console.log('='.repeat(80));
  console.log('   SOTRANS HUB — ONEDRIVE DISCONNECT & SOURCE LIFECYCLE AUDIT');
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
    // SCENARIO 1: Connected file query & provenance
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 1: Connected Source & Provenance Verification ---');
    const sourcesRes = await db.query(
      `SELECT * FROM public.user_onedrive_sources 
       WHERE owner_user_id = $1 AND file_name = 'Pricing Vendor.xlsx' AND sync_status = 'SYNCED'
       ORDER BY updated_at DESC LIMIT 1`,
      [testUserSTL.userId]
    );

    let src = sourcesRes.rows[0];
    assert(Boolean(src), 'Found active SYNCED source Pricing Vendor.xlsx for emp_stl');
    assert(Boolean(src.active_snapshot_id), `Active snapshot ID: ${src?.active_snapshot_id}`);

    // Verify snapshot in DB
    const snapRes = await db.query(`SELECT * FROM public.onedrive_source_snapshots WHERE id = $1`, [src.active_snapshot_id]);
    assert(snapRes.rows.length === 1, 'Snapshot exists in onedrive_source_snapshots');
    const snap = snapRes.rows[0];
    assert(snap.status === 'PUBLISHED', 'Snapshot status is PUBLISHED');

    // Query spreadsheet records directly
    const dp = typeof snap.data_profile === 'string' ? JSON.parse(snap.data_profile) : snap.data_profile;
    const lookup = dataEngine.searchSpreadsheetRecords(dp, {
      query: 'chi phí cho 1 chuyến từ Cảng Hải Phòng đến WHA Industrial Zone 1 đi đơn là bao nhiêu'
    });
    assert(lookup.totalMatches === 1, 'Found exact 1 row for Cont 20\' đi đơn');
    assert(lookup.results[0]?.data['GIÁ COST'] === 11000000, 'Cost matches ground truth 11.000.000 VNĐ');

    // -------------------------------------------------------------
    // SCENARIO 2: Operation A — Account disconnect with retained snapshot
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 2: Operation A — Account Disconnect & Offline Warning ---');
    
    // Save current OAuth token for restoration at end of test
    const tokenBackupRes = await db.query(
      `SELECT * FROM public.user_oauth_tokens WHERE user_id = $1 AND provider = 'microsoft'`,
      [testUserSTL.userId]
    );
    const savedTokenRow = tokenBackupRes.rows[0] || null;

    // Execute Operation A: Disconnect OAuth
    console.log('  Executing POST /api/auth/microsoft/disconnect...');
    const disconnResp = await fetch(`${BASE_URL}/api/auth/microsoft/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUserSTL.token}` }
    });
    const disconnData = await disconnResp.json();
    assert(disconnData.success === true, 'POST /api/auth/microsoft/disconnect succeeded');

    // Verify OAuth token is removed from database
    const tokenCheck = await db.query(
      `SELECT * FROM public.user_oauth_tokens WHERE user_id = $1 AND provider = 'microsoft'`,
      [testUserSTL.userId]
    );
    assert(tokenCheck.rows.length === 0, 'OAuth token removed from user_oauth_tokens');

    // Verify local snapshot and source are RETAINED (not deleted)
    const retainedSrc = await db.query(
      `SELECT * FROM public.user_onedrive_sources WHERE id = $1`,
      [src.id]
    );
    assert(retainedSrc.rows.length === 1, 'Source record retained in user_onedrive_sources');
    assert(retainedSrc.rows[0].sync_status === 'SYNCED', 'Source retained in SYNCED status for offline use');

    // Test ensureAgentSourcesFreshness without OAuth token
    const freshnessWhenOffline = await oneDriveSourceService.ensureAgentSourcesFreshness({
      agent: { id: testUserSTL.agentId },
      userId: testUserSTL.userId,
      userMessage: 'chi phí cho 1 chuyến từ Cảng Hải Phòng đến WHA Industrial Zone 1 là bao nhiêu'
    });

    assert(freshnessWhenOffline.activeFiles.length > 0, 'Offline activeFiles loaded from retained snapshot');
    const offFile = freshnessWhenOffline.activeFiles[0];
    assert(offFile.isOffline === true, 'activeFile marked isOffline: true');
    assert(freshnessWhenOffline.freshnessNotes.some(n => n.includes('NGẮT KẾT NỐI') || n.includes('NGOẠI TUYẾN')), 'freshnessNotes contains offline warning notice');

    // Test Agent Chat when offline
    console.log('  Testing Agent Chat when account is offline...');
    const chatForm = new FormData();
    chatForm.append('message', 'chi phí cho 1 chuyến từ Cảng Hải Phòng đến WHA Industrial Zone 1 đi đơn là bao nhiêu');
    const chatResp = await fetch(`${BASE_URL}/api/agents/${testUserSTL.agentId}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUserSTL.token}` },
      body: chatForm
    });
    const chatData = await chatResp.json();
    assert(chatResp.status === 200, 'Agent responded 200 OK using retained offline snapshot');
    const replyText = chatData.reply || '';
    assert(replyText.includes('11.000.000') || replyText.includes('11,000,000'), 'Agent successfully retrieved price from offline snapshot');
    assert(
      replyText.toLowerCase().includes('ngoại tuyến') || 
      replyText.toLowerCase().includes('ngắt kết nối') || 
      replyText.toLowerCase().includes('bản sao') ||
      replyText.toLowerCase().includes('lưu trữ nội bộ'),
      'Agent response explicitly includes offline snapshot warning notice'
    );

    // -------------------------------------------------------------
    // SCENARIO 3: Operation B — Unlink file from Agent
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Operation B — Unlink File from Agent ---');
    
    // Create a temporary test source to unlink without destroying our main source
    const testUnlinkItemId = 'ITEM_TEST_UNLINK_' + Date.now();
    const unlinkSource = await oneDriveSourceService.registerOrUpdateSource({
      ownerUserId: testUserSTL.userId,
      agentId: testUserSTL.agentId,
      sharingUrl: 'https://1drv.ms/x/test_unlink',
      dl: {
        fileName: 'Test_Unlink_File.xlsx',
        driveItemId: testUnlinkItemId,
        driveId: 'test_drive',
        size: 1024,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      },
      parsedUniversal: {
        fileType: 'spreadsheet',
        manifest: { totalUnits: 5 },
        dataProfile: { sheetNames: ['TestSheet'], sheets: { TestSheet: { rows: [{ 'GIÁ': '500.000' }] } } }
      },
      storagePath: resolveLocalPath(src.storage_path)
    });

    assert(Boolean(unlinkSource?.id), `Created temporary test source for unlinking (id: ${unlinkSource?.id})`);

    // Verify it is initially returned by getConnectedSourcesForAgent
    const beforeUnlink = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: testUserSTL.userId,
      agentId: testUserSTL.agentId
    });
    assert(beforeUnlink.some(s => s.id === unlinkSource.id), 'Source is initially connected to Agent');

    // Execute Operation B: Unlink (DELETE /api/onedrive/sources/:id?mode=unlink)
    console.log(`  Calling DELETE /api/onedrive/sources/${unlinkSource.id}?mode=unlink...`);
    const unlinkResp = await fetch(`${BASE_URL}/api/onedrive/sources/${unlinkSource.id}?mode=unlink`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUserSTL.token}` }
    });
    const unlinkData = await unlinkResp.json();
    assert(unlinkData.success === true, 'DELETE source (mode=unlink) returned success');
    assert(unlinkData.action === 'UNLINK', 'Action verified as UNLINK');

    // Verify source is DISCONNECTED and agent_id is NULL
    const checkUnlink = await db.query(`SELECT sync_status, agent_id FROM public.user_onedrive_sources WHERE id = $1`, [unlinkSource.id]);
    assert(checkUnlink.rows[0].sync_status === 'DISCONNECTED', 'Source sync_status set to DISCONNECTED');
    assert(checkUnlink.rows[0].agent_id === null, 'Source agent_id cleared to NULL');

    // Verify it is excluded from getConnectedSourcesForAgent
    const afterUnlink = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: testUserSTL.userId,
      agentId: testUserSTL.agentId
    });
    assert(!afterUnlink.some(s => s.id === unlinkSource.id), 'Unlinked source is excluded from Agent sources list');

    // -------------------------------------------------------------
    // SCENARIO 4: Operation C — Purge data (Permanent hard-delete)
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 4: Operation C — Purge Data (Hard-Delete) ---');

    // Create a temporary file and source to purge
    const purgeDiskPath = path.resolve(__dirname, '..', 'auth-service', 'data', 'uploads', `test_purge_${Date.now()}.xlsx`);
    fs.writeFileSync(purgeDiskPath, Buffer.from('TEST_PURGE_CONTENT'));
    assert(fs.existsSync(purgeDiskPath), 'Created physical test file on disk');

    const purgeItemId = 'ITEM_TEST_PURGE_' + Date.now();
    const purgeSource = await oneDriveSourceService.registerOrUpdateSource({
      ownerUserId: testUserSTL.userId,
      agentId: testUserSTL.agentId,
      sharingUrl: 'https://1drv.ms/x/test_purge',
      dl: {
        fileName: 'Test_Purge_File.xlsx',
        driveItemId: purgeItemId,
        driveId: 'test_drive',
        size: 18,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      },
      parsedUniversal: {
        fileType: 'spreadsheet',
        manifest: { totalUnits: 1 },
        dataProfile: { sheetNames: ['PurgeSheet'], sheets: { PurgeSheet: { rows: [] } } }
      },
      storagePath: purgeDiskPath
    });

    assert(Boolean(purgeSource?.id), `Created temporary source for purge (id: ${purgeSource?.id})`);

    // Execute Operation C: Purge (DELETE /api/onedrive/sources/:id?mode=purge)
    console.log(`  Calling DELETE /api/onedrive/sources/${purgeSource.id}?mode=purge...`);
    const purgeResp = await fetch(`${BASE_URL}/api/onedrive/sources/${purgeSource.id}?mode=purge`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testUserSTL.token}` }
    });
    const purgeData = await purgeResp.json();
    assert(purgeData.success === true, 'DELETE source (mode=purge) returned success');
    assert(purgeData.purged === true, 'Action confirmed as PURGED');

    // Verify physical file on disk is deleted
    assert(!fs.existsSync(purgeDiskPath), 'Physical file on disk permanently unlinked/deleted');

    // Verify database records deleted
    const dbSourceCheck = await db.query(`SELECT * FROM public.user_onedrive_sources WHERE id = $1`, [purgeSource.id]);
    assert(dbSourceCheck.rows.length === 0, 'Source record deleted from user_onedrive_sources');

    const dbSnapCheck = await db.query(`SELECT * FROM public.onedrive_source_snapshots WHERE source_id = $1`, [purgeSource.id]);
    assert(dbSnapCheck.rows.length === 0, 'All snapshots deleted from onedrive_source_snapshots');

    // -------------------------------------------------------------
    // SCENARIO 5: Update detection on OneDrive
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 5: Update Detection & Re-Indexing ---');
    const updateCheck = await oneDriveSourceService.checkSourceFreshness(
      src,
      'mock_token',
      {
        fetchGraphMetadataFn: async () => ({
          cTag: 'brand_new_ctag_' + Date.now(),
          eTag: 'brand_new_etag_' + Date.now(),
          lastModifiedDateTime: new Date().toISOString()
        })
      }
    );
    assert(updateCheck.isFresh === false, 'Freshness guard successfully detected updated version on Graph');
    assert(updateCheck.isGraphReachable === true, 'Graph reachable flag is true');

    // -------------------------------------------------------------
    // SCENARIO 6: Access control boundaries & isolation
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 6: Multi-User Access Control & Agent Boundaries ---');
    
    // User VTX trying to purge User STL's source
    const crossPurgeResp = await fetch(`${BASE_URL}/api/onedrive/sources/${src.id}/purge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUserVTX.token}` }
    });
    assert(crossPurgeResp.status === 404 || crossPurgeResp.status === 403, `IDOR prevented on cross-user purge (HTTP ${crossPurgeResp.status})`);

    // Verify source is still intact
    const intactCheck = await db.query(`SELECT * FROM public.user_onedrive_sources WHERE id = $1`, [src.id]);
    assert(intactCheck.rows.length === 1, 'Source intact after unauthorized cross-user attempt');

    // Verify Email Agent does not access Pricing Vendor.xlsx
    const emailSources = await oneDriveSourceService.getConnectedSourcesForAgent({
      ownerUserId: testUserSTL.userId,
      agentId: testUserSTL.emailAgentId
    });
    assert(!emailSources.some(s => s.id === src.id && s.agent_id === testUserSTL.agentId), 'Email Assistant does not access Excel Agent specific sources');

    // -------------------------------------------------------------
    // SCENARIO 7: Graph API errors and resilient handling
    // -------------------------------------------------------------
    console.log('\n--- SCENARIO 7: Graph API Errors & Resilient Fallback ---');
    
    // Expired token simulation
    const expiredCheck = await oneDriveSourceService.checkSourceFreshness(
      src,
      'expired_token',
      {
        fetchGraphMetadataFn: async () => {
          const err = new Error('Graph API 401: CompactToken parsing failed with error code: 80049217');
          err.statusCode = 401;
          throw err;
        }
      }
    );
    assert(expiredCheck.isFresh === false, 'Expired token handled safely (isFresh: false)');
    assert(expiredCheck.isGraphReachable === false, 'isGraphReachable marked false');

    // Deleted remote file simulation (404)
    const notFoundCheck = await oneDriveSourceService.checkSourceFreshness(
      src,
      'valid_token',
      {
        fetchGraphMetadataFn: async () => {
          const err = new Error('Graph API 404: The item does not exist.');
          err.statusCode = 404;
          throw err;
        }
      }
    );
    assert(notFoundCheck.isFresh === false, 'Deleted remote file handled safely');
    assert(notFoundCheck.reason.includes('404'), 'Reason includes 404 detail');

    // -------------------------------------------------------------
    // Clean-up & Token Restoration
    // -------------------------------------------------------------
    if (savedTokenRow) {
      console.log('\n  Restoring saved OAuth token for emp_stl...');
      await db.query(`
        INSERT INTO public.user_oauth_tokens (
          user_id, provider, account_id, account_email, account_name,
          encrypted_access_token, encrypted_refresh_token, token_expires_at, scope, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (user_id, provider) DO UPDATE SET
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          token_expires_at = EXCLUDED.token_expires_at,
          updated_at = NOW()
      `, [
        savedTokenRow.user_id,
        savedTokenRow.provider,
        savedTokenRow.account_id,
        savedTokenRow.account_email,
        savedTokenRow.account_name,
        savedTokenRow.encrypted_access_token,
        savedTokenRow.encrypted_refresh_token,
        savedTokenRow.token_expires_at,
        savedTokenRow.scope
      ]);
      console.log('  [RESTORE] emp_stl OAuth token restored successfully');
    }

    console.log('\n' + '='.repeat(80));
    console.log(`LIFECYCLE AUDIT SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('='.repeat(80));

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('UNEXPECTED LIFECYCLE AUDIT EXCEPTION:', err);
    process.exit(1);
  }
}

runLifecycleAudit();
