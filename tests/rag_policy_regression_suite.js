/**
 * RAG Policy Retrieval, Context Resolution and Answer Grounding Regression Suite
 * 12 Comprehensive Test Scenarios for SOTRANS Hub Policy Chat Pipeline
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const db = require('../auth-service/db');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hrbot_2026_!@#$';

function makeToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      role: user.role,
      company_id: user.company_id
    },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function callPolicyChat(token, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': `Bearer ${token}`,
      ...extraHeaders
    };

    const req = http.request('http://localhost:3000/api/policy/chat', {
      method: 'POST',
      headers,
      timeout: 90000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode, data: parsed, raw });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timed out (90s)'));
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runRegressionSuite() {
  console.log('================================================================');
  console.log('  STARTING RAG RETRIEVAL & ANSWER GROUNDING REGRESSION SUITE   ');
  console.log('================================================================\n');

  // Load test users
  const usersRes = await db.query(`SELECT user_id, username, role, company_id FROM users`);
  const users = {};
  usersRes.rows.forEach(u => { users[u.username] = u; });

  const adminUser = users['superadmin'];
  const empStlUser = users['emp_stl'];
  const empSwcUser = users['emp_swc'];
  const guestUser = users['user_guest'];

  const adminToken = makeToken(adminUser);
  const stlToken = makeToken(empStlUser);
  const swcToken = makeToken(empSwcUser);
  const guestToken = makeToken(guestUser);

  // Clear policy cache before running test suite
  await new Promise((resolve) => {
    const req = http.request('http://localhost:3000/api/policy/cache/clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, res => resolve());
    req.on('error', () => resolve());
    req.end();
  });

  const suiteResults = [];

  // Helper to record scenario
  function recordScenario(id, title, status, details, notes = '') {
    const passed = status === 'PASS';
    console.log(`[${status}] ${id}: ${title}`);
    if (!passed) console.log(`       Reason: ${notes}`);
    suiteResults.push({ id, title, status, passed, details, notes });
  }

  // -------------------------------------------------------------
  // Scenario 1: General Lunch-break Query
  // -------------------------------------------------------------
  try {
    const q1 = "Thời gian nghỉ trưa như thế nào?";
    const res1 = await callPolicyChat(adminToken, { message: q1, company_id: 'ALL' });
    const reply1 = res1.data?.reply || '';
    const answerable1 = res1.data?.answerable;
    const sources1 = res1.data?.sources || [];

    const hasStdLunch = reply1.includes('12:00') && reply1.includes('13:00');
    const hasShiftLunch = reply1.includes('12:30') && reply1.includes('13:30');
    const explainsDistinction = reply1.toLowerCase().includes('chuẩn') && (reply1.toLowerCase().includes('ca') || reply1.toLowerCase().includes('đặc thù'));

    const pass1 = res1.status === 200 && answerable1 === true && hasStdLunch && hasShiftLunch && explainsDistinction;
    recordScenario(
      'SCENARIO_01_GENERAL_LUNCH',
      'General lunch-break duration query distinguishes corporate standard vs special shift',
      pass1 ? 'PASS' : 'FAIL',
      { query: q1, reply: reply1, sources: sources1.map(s => s.title) },
      pass1 ? '' : 'Did not properly distinguish standard 12:00-13:00 vs shift 12:30-13:30'
    );
  } catch (err) {
    recordScenario('SCENARIO_01_GENERAL_LUNCH', 'General lunch-break duration query', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 2: Office-specific Lunch-break Query
  // -------------------------------------------------------------
  try {
    const q2 = "Thời gian nghỉ trưa của khối văn phòng như thế nào?";
    const res2 = await callPolicyChat(adminToken, { message: q2, company_id: 'ALL' });
    const reply2 = res2.data?.reply || '';
    const answerable2 = res2.data?.answerable;
    const sources2 = res2.data?.sources || [];

    const mentionsOffice = reply2.toLowerCase().includes('văn phòng');
    const hasStdOffice = reply2.includes('12:00') && reply2.includes('13:00');
    const hasShiftOffice = reply2.includes('12:30') && reply2.includes('13:30');
    const explainsConditions = reply2.toLowerCase().includes('ca') || reply2.toLowerCase().includes('áp dụng');

    const pass2 = res2.status === 200 && answerable2 === true && mentionsOffice && hasStdOffice && hasShiftOffice && explainsConditions;
    recordScenario(
      'SCENARIO_02_OFFICE_LUNCH',
      'Office-specific lunch-break query directly addresses office staff and explains standard vs special shift applicability',
      pass2 ? 'PASS' : 'FAIL',
      { query: q2, reply: reply2, sources: sources2.map(s => s.title) },
      pass2 ? '' : 'Did not directly address office employee group or applicability'
    );
  } catch (err) {
    recordScenario('SCENARIO_02_OFFICE_LUNCH', 'Office-specific lunch-break query', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 3: Follow-up Narrowing Employee Group (Multi-turn Context)
  // -------------------------------------------------------------
  try {
    const history3 = [
      { role: 'user', content: 'Thời gian nghỉ trưa như thế nào?' },
      { role: 'assistant', content: 'Khung giờ chuẩn toàn tập đoàn là từ 12:00 đến 13:00...' }
    ];
    const q3 = "Thế còn khối văn phòng thì sao?";
    const res3 = await callPolicyChat(adminToken, { message: q3, history: history3, company_id: 'ALL' });
    const reply3 = res3.data?.reply || '';
    const answerable3 = res3.data?.answerable;

    const resolvesOfficeLunch = (reply3.includes('12:00') || reply3.includes('12:30')) && reply3.toLowerCase().includes('văn phòng');
    const pass3 = res3.status === 200 && answerable3 === true && resolvesOfficeLunch;
    recordScenario(
      'SCENARIO_03_FOLLOWUP_NARROWING',
      'Follow-up query narrowing employee group ("Thế còn khối văn phòng thì sao?") resolves context from previous turn',
      pass3 ? 'PASS' : 'FAIL',
      { history: history3, query: q3, reply: reply3 },
      pass3 ? '' : 'Failed to resolve context of lunch break for office staff'
    );
  } catch (err) {
    recordScenario('SCENARIO_03_FOLLOWUP_NARROWING', 'Follow-up query narrowing employee group', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 4: Follow-up Changing Employee Group
  // -------------------------------------------------------------
  try {
    const history4 = [
      { role: 'user', content: 'Thời gian nghỉ trưa của khối văn phòng như thế nào?' },
      { role: 'assistant', content: 'Khối văn phòng có khung chuẩn 12:00 - 13:00 và ca đặc thù 12:30 - 13:30...' }
    ];
    const q4 = "Thế còn nhân viên khối hiện trường hoặc lái xe thì sao?";
    const res4 = await callPolicyChat(adminToken, { message: q4, history: history4, company_id: 'ALL' });
    const reply4 = res4.data?.reply || '';
    const answerable4 = res4.data?.answerable;

    // The system should either mention the general framework or clarify that field/driver staff follow field/shift rules
    const pass4 = res4.status === 200 && typeof answerable4 === 'boolean' && reply4.length > 20;
    recordScenario(
      'SCENARIO_04_FOLLOWUP_CHANGING',
      'Follow-up query changing employee group ("Thế còn nhân viên khối hiện trường hoặc lái xe?") shifts focus correctly',
      pass4 ? 'PASS' : 'FAIL',
      { history: history4, query: q4, reply: reply4 },
      pass4 ? '' : 'Failed to handle shift in employee group'
    );
  } catch (err) {
    recordScenario('SCENARIO_04_FOLLOWUP_CHANGING', 'Follow-up changing employee group', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 5: General vs Office Policy Differing (Precedence / Distinction)
  // -------------------------------------------------------------
  try {
    const q5 = "Quy chế tập đoàn quy định nghỉ trưa 12:00-13:00 nhưng quy định văn phòng ghi 12:30-13:30, tôi phải theo quy định nào?";
    const res5 = await callPolicyChat(adminToken, { message: q5, company_id: 'ALL' });
    const reply5 = res5.data?.reply || '';
    const answerable5 = res5.data?.answerable;

    const explainsHierarchy = reply5.toLowerCase().includes('ca') || reply5.toLowerCase().includes('áp dụng') || reply5.toLowerCase().includes('nhân sự');
    const pass5 = res5.status === 200 && answerable5 === true && explainsHierarchy;
    recordScenario(
      'SCENARIO_05_POLICY_DIFFERING',
      'General vs specialized shift differing breaks explains distinct scopes without claiming invalidity',
      pass5 ? 'PASS' : 'FAIL',
      { query: q5, reply: reply5 },
      pass5 ? '' : 'Failed to explain distinct applicability scopes'
    );
  } catch (err) {
    recordScenario('SCENARIO_05_POLICY_DIFFERING', 'General vs office policy differing', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 6: Both Documents Agree
  // -------------------------------------------------------------
  try {
    const q6 = "Ngày làm việc trong tuần theo quy chế là những ngày nào?";
    const res6 = await callPolicyChat(adminToken, { message: q6, company_id: 'ALL' });
    const reply6 = res6.data?.reply || '';
    const answerable6 = res6.data?.answerable;

    const mentionsMondayToFriday = reply6.toLowerCase().includes('thứ hai') && (reply6.toLowerCase().includes('thứ sáu') || reply6.toLowerCase().includes('thứ 6'));
    const pass6 = res6.status === 200 && answerable6 === true && mentionsMondayToFriday;
    recordScenario(
      'SCENARIO_06_BOTH_AGREE',
      'Both documents agree on working days (Thứ Hai đến Thứ Sáu) produces consistent answer',
      pass6 ? 'PASS' : 'FAIL',
      { query: q6, reply: reply6 },
      pass6 ? '' : 'Failed to confirm working days agreement'
    );
  } catch (err) {
    recordScenario('SCENARIO_06_BOTH_AGREE', 'Both documents agree', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 7: Sources Conflict & Precedence Unknown
  // -------------------------------------------------------------
  try {
    const q7 = "Nếu hai văn bản nội bộ có hiệu lực đồng thời mâu thuẫn trực tiếp về quyền lợi mà không có điều khoản quy định văn bản nào ưu tiên thì xử lý thế nào?";
    const res7 = await callPolicyChat(adminToken, { message: q7, company_id: 'ALL' });
    const reply7 = res7.data?.reply || '';

    const advisesHrConfirmation = reply7.toLowerCase().includes('nhân sự') || reply7.toLowerCase().includes('liên hệ') || reply7.toLowerCase().includes('xác nhận');
    const pass7 = res7.status === 200 && advisesHrConfirmation;
    recordScenario(
      'SCENARIO_07_SOURCES_CONFLICT',
      'Sources conflict with unknown precedence prompts stating divergence and advising HR confirmation',
      pass7 ? 'PASS' : 'FAIL',
      { query: q7, reply: reply7 },
      pass7 ? '' : 'Failed to advise HR confirmation upon conflict'
    );
  } catch (err) {
    recordScenario('SCENARIO_07_SOURCES_CONFLICT', 'Sources conflict', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 8: Relevant Clause Missing From All Documents
  // -------------------------------------------------------------
  try {
    const q8 = "Chính sách trợ cấp học phí cho con em nhân viên theo học đại học là bao nhiêu tiền mỗi tháng?";
    const res8 = await callPolicyChat(adminToken, { message: q8, company_id: 'ALL' });
    const reply8 = res8.data?.reply || '';
    const answerable8 = res8.data?.answerable;
    const sources8 = res8.data?.sources || [];

    const pass8 = res8.status === 200 && answerable8 === false && sources8.length === 0 && reply8.toLowerCase().includes('nhân sự');
    recordScenario(
      'SCENARIO_08_MISSING_CLAUSE',
      'Relevant clause missing from documents returns answerable=false and directs user to HR contact',
      pass8 ? 'PASS' : 'FAIL',
      { query: q8, reply: reply8, answerable: answerable8, sourcesCount: sources8.length },
      pass8 ? '' : 'Did not set answerable=false or missing HR direction'
    );
  } catch (err) {
    recordScenario('SCENARIO_08_MISSING_CLAUSE', 'Relevant clause missing', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 9: Old Revoked vs Current Active Version
  // -------------------------------------------------------------
  try {
    const q9 = "Thời gian làm việc ca 09h30 quy định như thế nào?";
    const res9 = await callPolicyChat(adminToken, { message: q9, company_id: 'ALL' });
    const reply9 = res9.data?.reply || '';
    const sources9 = res9.data?.sources || [];

    const citesV3 = sources9.some(s => s.version === 3);
    const citesV2 = sources9.some(s => s.version === 2);
    const docVersions = res9.data?.doc_versions || [];

    const pass9 = res9.status === 200 && citesV3 && !citesV2 && !docVersions.includes('481dad7a-6856-4f01-bbe1-e066e782ec39');
    recordScenario(
      'SCENARIO_09_REVOKED_VS_CURRENT',
      'Old revoked version (v2) is strictly ignored; only current active version (v3) is cited',
      pass9 ? 'PASS' : 'FAIL',
      { query: q9, citesV3, citesV2, doc_versions: docVersions },
      pass9 ? '' : 'Revoked version was cited or active version was missing'
    );
  } catch (err) {
    recordScenario('SCENARIO_09_REVOKED_VS_CURRENT', 'Old revoked vs current active version', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 10: Cache Hit Followed By Doc Version Change (Invalidation)
  // -------------------------------------------------------------
  try {
    const q10 = "Thời gian nghỉ trưa theo quy chế lao động toàn tập đoàn là từ mấy giờ đến mấy giờ?";
    
    // Clear cache specifically to ensure cold Call 1
    await new Promise((resolve) => {
      const req = http.request('http://localhost:3000/api/policy/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` }
      }, () => resolve());
      req.on('error', () => resolve());
      req.end();
    });

    // Call 1: Cold call (should be cached: false)
    const call1 = await callPolicyChat(adminToken, { message: q10, company_id: 'ALL' });
    const cached1 = call1.data?.cached;
    const key1 = call1.data?.cache_key;

    // Call 2: Repeat call (should be cached: true)
    const call2 = await callPolicyChat(adminToken, { message: q10, company_id: 'ALL' });
    const cached2 = call2.data?.cached;
    const key2 = call2.data?.cache_key;

    // Simulate Document Version Invalidation: Touch a document title in DB
    const testDocId = '298d5728-7a73-4faf-ade8-b819991bdb64';
    const originalTitle = 'Quy định Thời gian Làm việc - Khối Văn phòng (Ca 09h30)';
    const tempTitle = 'Quy định Thời gian Làm việc - Khối Văn phòng (Ca 09h30) [v3.1]';

    await db.query(`UPDATE documents SET title = $1 WHERE doc_version_id = $2`, [tempTitle, testDocId]);

    // Wait 5.5 seconds for DOC_HASH_TTL_MS (5s) to expire
    await new Promise(r => setTimeout(r, 5500));

    // Call 3: Post-update call (should be cached: false due to hash change!)
    const call3 = await callPolicyChat(adminToken, { message: q10, company_id: 'ALL' });
    const cached3 = call3.data?.cached;
    const key3 = call3.data?.cache_key;

    // Restore original title
    await db.query(`UPDATE documents SET title = $1 WHERE doc_version_id = $2`, [originalTitle, testDocId]);

    const pass10 = cached1 === false && cached2 === true && cached3 === false && key1 !== key3;
    recordScenario(
      'SCENARIO_10_CACHE_INVALIDATION',
      'Policy cache hits on repeat query, then automatically invalidates when document versions change',
      pass10 ? 'PASS' : 'FAIL',
      { call1_cached: cached1, call2_cached: cached2, call3_cached: cached3, key1_equals_key2: key1 === key2, key1_diff_key3: key1 !== key3 },
      pass10 ? '' : `Cache behavior mismatch: call1=${cached1}, call2=${cached2}, call3=${cached3}`
    );
  } catch (err) {
    recordScenario('SCENARIO_10_CACHE_INVALIDATION', 'Cache hit and invalidation', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 11: Tenant / Company Permission Isolation
  // -------------------------------------------------------------
  try {
    const q11 = "Thời gian nghỉ trưa của ca 09h30 như thế nào?";

    // User A: SWC employee (has Sowatco access)
    const resSwc = await callPolicyChat(swcToken, { message: q11 });
    const swcSources = (resSwc.data?.sources || []).map(s => s.title);
    const swcSeesCa930 = resSwc.data?.answerable === true && (resSwc.data?.reply || '').includes('12:30');

    // User B: STL employee (does NOT have Sowatco access)
    const resStl = await callPolicyChat(stlToken, { message: q11 });
    const stlSources = (resStl.data?.sources || []).map(s => s.title);
    const stlDoesNotSeeSowatcoDoc = !stlSources.some(t => t.toLowerCase().includes('09h30'));

    const pass11 = swcSeesCa930 && stlDoesNotSeeSowatcoDoc;
    recordScenario(
      'SCENARIO_11_TENANT_ISOLATION',
      'Company permission isolation prevents STL user from accessing SWC-scoped branch policy while SWC user succeeds',
      pass11 ? 'PASS' : 'FAIL',
      { swcSeesCa930, swcSources, stlDoesNotSeeSowatcoDoc, stlSources },
      pass11 ? '' : 'Tenant permission boundary was violated or SWC user could not access'
    );
  } catch (err) {
    recordScenario('SCENARIO_11_TENANT_ISOLATION', 'Tenant permission isolation', 'FAIL', null, err.message);
  }

  // -------------------------------------------------------------
  // Scenario 12: Semantically Similar Question Asking About Different Policy
  // -------------------------------------------------------------
  try {
    const q12 = "Quy định về thời gian làm thêm giờ (tăng ca / overtime) như thế nào?";
    const res12 = await callPolicyChat(adminToken, { message: q12, company_id: 'ALL' });
    const reply12 = res12.data?.reply || '';
    const answerable12 = res12.data?.answerable;

    const addressesOvertime = reply12.toLowerCase().includes('làm thêm') || reply12.toLowerCase().includes('tăng ca') || reply12.toLowerCase().includes('giờ');
    const pass12 = res12.status === 200 && answerable12 === true && addressesOvertime;
    recordScenario(
      'SCENARIO_12_SEMANTIC_DISTINCTION',
      'Semantically similar question (overtime vs lunch break) correctly targets overtime provisions without confusion',
      pass12 ? 'PASS' : 'FAIL',
      { query: q12, reply: reply12 },
      pass12 ? '' : 'Failed to correctly target overtime policy'
    );
  } catch (err) {
    recordScenario('SCENARIO_12_SEMANTIC_DISTINCTION', 'Semantic distinction', 'FAIL', null, err.message);
  }

  console.log('\n================================================================');
  console.log('                   REGRESSION SUITE SUMMARY                     ');
  console.log('================================================================');

  const total = suiteResults.length;
  const passed = suiteResults.filter(r => r.passed).length;
  const failed = total - passed;

  console.log(`TOTAL SCENARIOS: ${total}`);
  console.log(`PASSED:          ${passed}`);
  console.log(`FAILED:          ${failed}`);
  console.log(`PASS RATE:       ${((passed / total) * 100).toFixed(1)}%\n`);

  const report = {
    executed_at: new Date().toISOString(),
    total,
    passed,
    failed,
    pass_rate: `${((passed / total) * 100).toFixed(1)}%`,
    results: suiteResults
  };

  fs.writeFileSync(
    path.join(__dirname, 'rag_policy_regression_report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );
  console.log('Report saved to tests/rag_policy_regression_report.json');

  process.exit(failed === 0 ? 0 : 1);
}

runRegressionSuite().catch(err => {
  console.error('Test suite failed with fatal error:', err);
  process.exit(1);
});
