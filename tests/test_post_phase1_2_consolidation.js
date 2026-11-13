/**
 * SOTRANS HUB — POST PHASE 1.2 CONSOLIDATION & CLEANUP VERIFICATION
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const INTERNAL_SECRET = '8973d464f5f1475b83d6ab88d222d824';

function sendPost(pathStr, body) {
  return new Promise(resolve => {
    const postData = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: pathStr,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('================================================================');
  console.log(' POST PHASE 1.2 CONSOLIDATION & DEAD CODE CLEANUP VERIFICATION');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function record(name, ok, detail) {
    if (ok) {
      passed++;
      console.log(`[PASS] ${name}`);
    } else {
      failed++;
      console.error(`[FAIL] ${name} -> ${detail}`);
    }
  }

  // 1. Check n8n workflow nodes consolidation
  const wfPath = path.resolve(__dirname, '..', 'n8n-workflows', 'SOTRANS_HR_EMPLOYEE_LIFECYCLE.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

  const removedNodeNames = [
    'Normalize - Canonical Employee Fields',
    'IF Normalize Valid?',
    'Respond Normalize Error',
    'Validate - Required Fields',
    'Validate - Citizen ID & Duplicate',
    'IF Duplicate Check Valid?',
    'Respond Duplicate Error',
    'Persist - Employee Staging',
    'IF Persist Valid?',
    'Respond Persist Error'
  ];

  const hasNoRemovedNodes = removedNodeNames.every(name => !wf.nodes.some(n => n.name === name));
  record('1. Obsolete 10 nodes completely removed from workflow JSON', hasNoRemovedNodes, `Remaining nodes: ${wf.nodes.length}`);

  const hasUnifiedIngestion = wf.nodes.some(n => n.name === 'Ingestion - Process Staged Candidate');
  const hasIngestionGate = wf.nodes.some(n => n.name === 'IF Ingestion Valid?');
  const hasIngestionErrResp = wf.nodes.some(n => n.name === 'Respond Ingestion Error');
  record('2. Unified Ingestion pipeline & error handlers active in workflow', hasUnifiedIngestion && hasIngestionGate && hasIngestionErrResp, 'Ingestion nodes missing');

  // Check 2-layer classification preservation
  const hasLayer1 = wf.nodes.some(n => n.name === 'Classify - Document Type');
  const hasLayer2 = wf.nodes.some(n => n.name === 'OCR - Parse JSON & Error Handling');
  record('3. Two-layer classification preserved in workflow (Filename + Content)', hasLayer1 && hasLayer2, 'Classification layers missing');

  // 2. Check Dead Code Endpoints
  const resFallback = await sendPost('/api/hoso/intake/internal/extract-text-fallback', { text: 'test' });
  record('4. Endpoint /internal/extract-text-fallback returns 410 Gone', resFallback.status === 410, `Status: ${resFallback.status}`);

  const resClassify = await sendPost('/api/hoso/intake/internal/classify-document', { fileName: 'test.pdf' });
  record('5. Endpoint /internal/classify-document returns 410 Gone', resClassify.status === 410, `Status: ${resClassify.status}`);

  const resOcr = await sendPost('/api/hoso/intake/internal/ocr-document', { fileStoragePath: 'dummy' });
  record('6. Endpoint /internal/ocr-document returns 403 (fallback disabled)', resOcr.status === 403 && resOcr.body?.fallback_disabled === true, `Status: ${resOcr.status}`);

  // 3. Check Policy Documents RAG module preservation
  const hasOcrPipeline = fs.existsSync(path.resolve(__dirname, '..', 'auth-service', 'services', 'ocrDocumentPipeline.js'));
  const docsRoute = fs.readFileSync(path.resolve(__dirname, '..', 'auth-service', 'routes', 'documents.js'), 'utf8');
  const policyRoute = fs.readFileSync(path.resolve(__dirname, '..', 'auth-service', 'routes', 'policy.js'), 'utf8');
  const policyPreserved = hasOcrPipeline && docsRoute.includes('ocrDocumentPipeline') && policyRoute.includes('ocrDocumentPipeline');
  record('7. Policy Documents & RAG dependencies preserved (ocrDocumentPipeline.js)', policyPreserved, 'Policy route missing dependency');

  // 4. Check Backward Compatibility of Legacy Endpoints
  const resLegacyAudit = await sendPost('/api/hoso/intake/internal/audit-log', { action: 'TEST_AUDIT', status: 'INFO' });
  record('8. Legacy endpoint /internal/audit-log preserved for backward compatibility', resLegacyAudit.status === 200, `Status: ${resLegacyAudit.status}`);

  console.log('\n================================================================');
  console.log(` CONSOLIDATION AUDIT: ${passed} / 8 PASSED (${failed} FAILED)`);
  console.log('================================================================');

  if (failed > 0) process.exit(1);
}

run();
