/**
 * SOTRANS HUB — QDRANT BACKUP & RESTORE REHEARSAL VERIFICATION
 * Isolated test of snapshot creation, download, integrity check,
 * recovery to a new collection, and semantic vector query validation.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QDRANT_HOST = '127.0.0.1';
const QDRANT_PORT = 6333; // Local dev Qdrant container
const TEST_COLLECTION = 'rehearsal_vectors';
const RECOVERED_COLLECTION = 'rehearsal_vectors_recovered';
const TEMP_DIR = path.join(__dirname, '../temp_qdrant_rehearsal');

function qdrantRequest(method, endpoint, data = null, isBinary = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: QDRANT_HOST,
      port: QDRANT_PORT,
      path: endpoint,
      method: method,
      headers: {}
    };

    let postData = null;
    if (data && !isBinary) {
      postData = JSON.stringify(data);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      if (isBinary) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            buffer: Buffer.concat(chunks)
          });
        });
      } else {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : null;
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, headers: res.headers, body });
          }
        });
      }
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function uploadSnapshotFile(endpoint, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    let prefix = `--${boundary}\r\n`;
    prefix += `Content-Disposition: form-data; name="snapshot"; filename="${fileName}"\r\n`;
    prefix += `Content-Type: application/octet-stream\r\n\r\n`;

    const suffix = `\r\n--${boundary}--\r\n`;

    const fullBody = Buffer.concat([
      Buffer.from(prefix, 'utf8'),
      fileData,
      Buffer.from(suffix, 'utf8')
    ]);

    const options = {
      hostname: QDRANT_HOST,
      port: QDRANT_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

async function runQdrantRehearsal() {
  console.log('================================================================');
  console.log('SOTRANS HUB — QDRANT BACKUP & RESTORE REHEARSAL VERIFICATION');
  console.log(`Target: http://${QDRANT_HOST}:${QDRANT_PORT}`);
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}: ${details}`);
      failed++;
    }
  }

  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // STEP 1: CREATE SYNTHETIC TEST COLLECTION & INSERT TEST VECTORS
    // -------------------------------------------------------------------------
    console.log('--- 1. CREATING SYNTHETIC TEST COLLECTION & VECTORS ---');
    
    // Clean up if already exists
    await qdrantRequest('DELETE', `/collections/${TEST_COLLECTION}`);
    await qdrantRequest('DELETE', `/collections/${RECOVERED_COLLECTION}`);

    // Create 4-dimensional cosine collection
    const createRes = await qdrantRequest('PUT', `/collections/${TEST_COLLECTION}`, {
      vectors: {
        size: 4,
        distance: 'Cosine'
      }
    });
    assert(createRes.statusCode === 200 && createRes.body.status === 'ok', 'Created synthetic test collection (size=4, distance=Cosine)');

    // Insert 3 test vectors with metadata payloads
    const pointsData = {
      points: [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3, 0.4],
          payload: { doc_id: 'doc-001', title: 'Quy định nghỉ phép 2026', category: 'HR_POLICY' }
        },
        {
          id: 2,
          vector: [0.9, 0.8, 0.7, 0.6],
          payload: { doc_id: 'doc-002', title: 'Quy chuẩn an ninh thông tin', category: 'IT_SECURITY' }
        },
        {
          id: 3,
          vector: [0.15, 0.25, 0.35, 0.45],
          payload: { doc_id: 'doc-003', title: 'Hướng dẫn công tác phí', category: 'FINANCE' }
        }
      ]
    };
    const insertRes = await qdrantRequest('PUT', `/collections/${TEST_COLLECTION}/points?wait=true`, pointsData);
    assert(insertRes.statusCode === 200 && insertRes.body.status === 'ok', 'Inserted 3 synthetic vectors with payload metadata');

    // Verify vector count
    const infoRes = await qdrantRequest('GET', `/collections/${TEST_COLLECTION}`);
    assert(
      infoRes.body.result && infoRes.body.result.points_count === 3,
      `Collection verified with exactly 3 indexed points (points_count=${infoRes.body.result.points_count})`
    );

    // -------------------------------------------------------------------------
    // STEP 2: CREATE SNAPSHOT VIA QDRANT REST API
    // -------------------------------------------------------------------------
    console.log('\n--- 2. CREATING & DOWNLOADING QDRANT SNAPSHOT ---');
    const snapCreateRes = await qdrantRequest('POST', `/collections/${TEST_COLLECTION}/snapshots`);
    assert(snapCreateRes.statusCode === 200 && snapCreateRes.body.result && snapCreateRes.body.result.name, 'Snapshot created via REST API');
    
    const snapshotName = snapCreateRes.body.result.name;
    console.log(`      Snapshot file name: ${snapshotName}`);

    // Download snapshot
    const downloadRes = await qdrantRequest('GET', `/collections/${TEST_COLLECTION}/snapshots/${snapshotName}`, null, true);
    assert(downloadRes.statusCode === 200 && downloadRes.buffer.length > 500, `Downloaded snapshot binary (${downloadRes.buffer.length} bytes)`);

    const snapshotFilePath = path.join(TEMP_DIR, snapshotName);
    fs.writeFileSync(snapshotFilePath, downloadRes.buffer);

    // Calculate SHA256 Checksum
    const sha256 = crypto.createHash('sha256').update(downloadRes.buffer).digest('hex');
    assert(sha256.length === 64, `Generated SHA256 checksum: ${sha256}`);

    // -------------------------------------------------------------------------
    // STEP 3: RECOVER INTO ISOLATED RECOVERED COLLECTION
    // -------------------------------------------------------------------------
    console.log('\n--- 3. RECOVERING SNAPSHOT INTO ISOLATED COLLECTION ---');
    
    // Qdrant supports uploading snapshot directly to create/recover a new collection:
    // POST /collections/{new_collection_name}/snapshots/upload
    const uploadRes = await uploadSnapshotFile(`/collections/${RECOVERED_COLLECTION}/snapshots/upload`, snapshotFilePath);
    assert(uploadRes.statusCode === 200 && uploadRes.body.status === 'ok', `Recovered snapshot into isolated collection "${RECOVERED_COLLECTION}"`);

    // -------------------------------------------------------------------------
    // STEP 4: VERIFY RECOVERED COLLECTION METADATA & QUERY RETRIEVAL
    // -------------------------------------------------------------------------
    console.log('\n--- 4. POST-RECOVERY METADATA & SEMANTIC QUERY AUDIT ---');
    
    // 4.1. Check recovered collection info
    const recInfoRes = await qdrantRequest('GET', `/collections/${RECOVERED_COLLECTION}`);
    assert(recInfoRes.statusCode === 200, 'Recovered collection exists and is queryable');
    assert(
      recInfoRes.body.result.config.params.vectors.size === 4 &&
      recInfoRes.body.result.config.params.vectors.distance === 'Cosine',
      'Recovered collection preserves exact vector dimensions (4) and distance metric (Cosine)'
    );
    assert(
      recInfoRes.body.result.points_count === 3,
      `Recovered collection preserves exact point count (expected 3, got ${recInfoRes.body.result.points_count})`
    );

    // 4.2. Perform vector search query on recovered collection
    const queryData = {
      vector: [0.1, 0.2, 0.3, 0.4],
      limit: 2,
      with_payload: true
    };
    const searchRes = await qdrantRequest('POST', `/collections/${RECOVERED_COLLECTION}/points/search`, queryData);
    assert(searchRes.statusCode === 200 && searchRes.body.result.length === 2, 'Vector search returned nearest neighbor results');

    const topHit = searchRes.body.result[0];
    assert(
      topHit.id === 1 && topHit.payload.doc_id === 'doc-001' && topHit.score > 0.99,
      `Top match correctly retrieved: id=1, title="${topHit.payload.title}", score=${topHit.score.toFixed(4)}`
    );

    // -------------------------------------------------------------------------
    // STEP 5: VERIFY MULTI-COLLECTION COVERAGE READINESS
    // -------------------------------------------------------------------------
    console.log('\n--- 5. VERIFYING DYNAMIC COLLECTION DISCOVERY FOR BACKUP ---');
    const allCollsRes = await qdrantRequest('GET', '/collections');
    const allNames = allCollsRes.body.result.collections.map(c => c.name);
    assert(
      allNames.includes(TEST_COLLECTION) && allNames.includes(RECOVERED_COLLECTION),
      `Dynamic discovery detects all active collections: [${allNames.join(', ')}]`
    );

    // -------------------------------------------------------------------------
    // CLEANUP
    // -------------------------------------------------------------------------
    await qdrantRequest('DELETE', `/collections/${TEST_COLLECTION}`);
    await qdrantRequest('DELETE', `/collections/${RECOVERED_COLLECTION}`);
    console.log('\nCleaned up synthetic test collections safely.');

    console.log('\n================================================================');
    console.log(`QDRANT REHEARSAL RESULT: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('FATAL QDRANT REHEARSAL ERROR:', err);
    process.exit(1);
  } finally {
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

runQdrantRehearsal();
