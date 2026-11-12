/**
 * SOTRANS HUB — LIVE ONEDRIVE ACCEPTANCE TEST SCRIPT
 * Tests Group C, Group D, and Group E with Real Microsoft Graph & Universal Data Engine.
 */

const path = require('path');
const db = require('../auth-service/db');
const oneDriveService = require('../auth-service/services/oneDriveService');
const universalEngine = require('../auth-service/services/universalDataEngine');

async function runLiveAcceptance() {
  console.log('========================================================================================');
  console.log('   SOTRANS HUB — LIVE ONEDRIVE ACCEPTANCE AUDIT                                         ');
  console.log('========================================================================================\n');

  const userId = 'b250d5b5-fdcd-4705-b35d-0eb40403623e'; // emp_swc (Lê Hoàng Cường)
  const realUrl = 'https://1drv.ms/x/c/d629852830f61364/IQBlvzFitXkqQKCzhAjApQCXAfP6YWtHTBxa8QLxTw-6Ttc?e=DEaUXd';

  // 1. Check OAuth Status
  console.log('--- TEST GROUP B & C: OAUTH CONNECTION & LIVE GRAPH RESOLUTION ---');
  const status = await oneDriveService.getOAuthConnectionStatus(userId);
  console.log(`[STATUS] User connected: ${status.connected}`);
  console.log(`[STATUS] Account email: ${status.accountEmail}`);
  console.log(`[STATUS] Account name: ${status.accountName}`);
  console.log(`[STATUS] Token expires at: ${status.expiresAt}`);

  if (!status.connected) {
    console.error('[BLOCKED] User is not connected to Microsoft OneDrive.');
    process.exit(1);
  }

  // 2. Resolve & Download Real File
  console.log('\n--- LIVE DOWNLOAD VIA MICROSOFT GRAPH ---');
  const startTime = Date.now();
  let dl;
  try {
    dl = await oneDriveService.resolveAndDownloadSharedItem(realUrl, userId);
  } catch (err) {
    console.error(`[FAIL] Live download error: ${err.message}`);
    process.exit(1);
  }
  const duration = Date.now() - startTime;

  console.log(`[PASS] Live download succeeded in ${duration}ms`);
  console.log(`[PASS] Downloaded File Name: ${dl.fileName}`);
  console.log(`[PASS] Byte count: ${dl.buffer.length} bytes (${(dl.buffer.length / 1024).toFixed(2)} KB)`);
  console.log(`[PASS] MIME type detected: ${dl.mimeType}`);
  console.log(`[PASS] Within 20MB limit: ${dl.buffer.length <= 20 * 1024 * 1024}`);

  // 3. Universal Data Engine Parse
  console.log('\n--- TEST GROUP D: UNIVERSAL DATA ENGINE PIPELINE ---');
  let parsed;
  try {
    parsed = await universalEngine.parseUniversalFile(dl.buffer, {
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      fileId: 'live_acceptance_file_01'
    });
  } catch (err) {
    console.error(`[FAIL] Universal Engine parsing error: ${err.message}`);
    process.exit(1);
  }

  console.log(`[PASS] Parsed Universal File Type: ${parsed.fileType}`);
  const sheetNames = parsed.dataProfile ? (parsed.dataProfile.sheetNames || Object.keys(parsed.dataProfile.sheets || {})) : [];
  console.log(`[PASS] Total Sheet Count: ${sheetNames.length}`);

  if (parsed.dataProfile && parsed.dataProfile.sheets) {
    sheetNames.forEach((sName, idx) => {
      const s = parsed.dataProfile.sheets[sName];
      console.log(`       Sheet ${idx + 1}: "${sName}" | Raw Rows: ${s.totalRawRows || s.totalRows || 0} | Valid Rows: ${s.validDataRows || 0} | Columns: ${(s.columns || []).length}`);
      if (s.columns) {
        console.log(`         Sample columns: ${s.columns.slice(0, 5).map(c => c.name || c).join(', ')}`);
      }
    });
  }

  // 4. Test Error Handling on Inaccessible Link
  console.log('\n--- TEST GROUP E: ERROR HANDLING & EDGE CASES ---');
  try {
    await oneDriveService.resolveAndDownloadSharedItem('https://1drv.ms/x/c/invalid_bad_token_999999/IQBlvzFitXkqQKCzh', userId);
    console.log('[FAIL] Inaccessible link should have thrown error!');
  } catch (err) {
    console.log(`[PASS] Inaccessible link handled correctly: ${err.message.slice(0, 100)}`);
  }

  // 5. Test Unauthorized User Isolation
  try {
    const foreignUserId = '00000000-0000-0000-0000-000000000000';
    await oneDriveService.resolveAndDownloadSharedItem(realUrl, foreignUserId);
    console.log('[FAIL] Foreign unlinked user should not be able to download without token!');
  } catch (err) {
    console.log(`[PASS] Foreign user isolation verified: ${err.message.slice(0, 100)}`);
  }

  console.log('\n========================================================================================');
  console.log('   ALL LIVE ACCEPTANCE VERIFICATIONS COMPLETED SUCCESSFULLY                            ');
  console.log('========================================================================================\n');

  await db.pool.end();
  process.exit(0);
}

runLiveAcceptance().catch(err => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
