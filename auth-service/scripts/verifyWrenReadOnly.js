'use strict';
// Deployment verification only: readonly aggregates, no login, JWT or DB writes.
// Optional --with-gemini sends schema + a synthetic aggregate question to the
// existing configured provider. It never sends database rows to the provider.
const assert = require('node:assert/strict');
const { configuration, serviceRequest } = require('../services/wrenBiService');
const db = require('../db');
const branches = { STL: 'sotrans_logistics', VTX: 'vietranstimex', SWC: 'sowatco', ALL: 'all' };

(async () => {
  const config = configuration();
  assert.equal(config.enabled, true, 'Enable protected BI configuration before verifying the release');
  const checks = [];
  const client = await db.getReadOnlyClient();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='3000ms'");
    for (const [company, branch] of Object.entries(branches)) {
      const cases = [
        ['DOC_TOTAL', 'SELECT COUNT(DISTINCT doc_version_id) AS value FROM hub_documents', "SELECT COUNT(DISTINCT doc_version_id) AS value FROM public.documents WHERE deleted_at IS NULL AND ($1='ALL' OR ARRAY_POSITION(branch_scope, 'all') IS NOT NULL OR ARRAY_POSITION(branch_scope, $2) IS NOT NULL)", [company, branch]],
        ['INTAKE_UPLOADS', 'SELECT COUNT(id) AS value FROM hub_intake_batches', "SELECT COUNT(id) AS value FROM public.hr_intake_batches WHERE ($1='ALL' OR company_id=$1)", [company]],
        ['DATA_INTEGRITY', 'SELECT COUNT(id) AS value FROM hub_staged_records', "SELECT COUNT(id) AS value FROM public.hr_employee_staging WHERE ($1='ALL' OR company_id=$1)", [company]],
      ];
      for (const [metric, sql, reference, params] of cases) {
        const expected = (await client.query(reference, params)).rows[0].value;
        const result = await serviceRequest('/query', { sql, company_id: company, limit: 10 }, config);
        assert.equal(String(result.rows[0].value), String(expected), `${metric}/${company}`);
        checks.push({ metric, company, matched: true });
      }
    }
    await client.query('ROLLBACK');
    if (process.argv.includes('--with-gemini')) {
      const catalog = await serviceRequest('/catalog', undefined, config);
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Return JSON {sql} only. Use SELECT over exposed semantic models and columns. No physical tables or made-up values.' }] }, contents: [{ role: 'user', parts: [{ text: `Catalog: ${JSON.stringify(catalog)}\nQuestion: Dung Wren phan tich so lo tiep nhan theo trang thai cua STL, toan bo thoi gian. Include COUNT(id) and status. Do not apply time filters.` }] }], generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' } }),
      });
      const model = await response.json();
      assert.equal(response.ok, true, `Provider HTTP ${response.status}`);
      const draft = JSON.parse(model.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      const result = await serviceRequest('/query', { sql: draft.sql, company_id: 'STL', limit: 500 }, config);
      const numeric = result.numeric_columns;
      assert.equal(numeric.length, 1); assert.ok(result.columns.includes('status'));
      const total = result.rows.reduce((sum, row) => sum + Number(row[numeric[0]]), 0);
      const reference = await client.query("SELECT COUNT(id) AS value FROM public.hr_intake_batches WHERE company_id='STL'");
      assert.equal(total, Number(reference.rows[0].value));
      checks.push({ flow: 'Actual Gemini -> semantic SQL -> Wren -> readonly PostgreSQL', matched: true, grouped: true });
    }
    console.log(JSON.stringify({ passed: checks.length, checks, database_mutations: 0, real_general_ai_login: false, at: new Date().toISOString() }, null, 2));
  } finally { client.release(); await Promise.all([db.pool.end(), db.roPool.end()]); }
})().catch(error => { console.error(JSON.stringify({ passed: false, code: error.code || 'VERIFICATION_FAILED', message: error.name === 'AssertionError' ? error.message : 'Readonly/provider verification failed; inspect configuration privately.' })); process.exitCode = 1; });
