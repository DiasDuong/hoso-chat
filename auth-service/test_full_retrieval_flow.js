const https = require('https');
const http = require('http');
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgresql://hrbot:hrchatbot@postgres:5432/hrbot' });

const env = fs.readFileSync('/app/.env', 'utf8');
const keyMatch = env.match(/GEMINI_API_KEY=([^\r\n]+)/);
const apiKey = keyMatch ? keyMatch[1].trim() : '';

async function geminiEmbeddingBatch(texts) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      requests: texts.map(t => ({
        model: 'models/gemini-embedding-2',
        content: { parts: [{ text: t }] },
        output_dimensionality: 768
      }))
    });
    const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.embeddings?.map(e => e.values) || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function qdrantBatchSearch(vectors) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      searches: vectors.map(v => ({
        vector: v,
        limit: 12,
        with_payload: true,
        filter: {
          must: [
            { key: 'status', match: { any: ['active'] } },
            { key: 'role_access', match: { any: ['all', 'employee'] } },
            { key: 'branch_scope', match: { any: ['all', 'sotrans_logistics'] } },
            { key: 'effective_int', range: { lte: 20261103 } },
            { key: 'expiry_int', range: { gte: 20261103 } }
          ]
        }
      }))
    });
    const req = http.request('http://hrbot-qdrant-1:6333/collections/hr_docs/points/search/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.result || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  const queries = [
    "thời gian làm việc của nhân viên SOTRANS",
    "quy định quy chế nội quy giờ làm việc thời gian làm việc",
    "khung giờ làm việc ca sáng ca chiều khối văn phòng khối vận hành SOTRANS"
  ];
  console.log('Embedding queries batch...');
  const vectors = await geminiEmbeddingBatch(queries);
  console.log('Got vectors:', vectors.length);

  const qdrantBatch = await qdrantBatchSearch(vectors);
  console.log('Qdrant batch results:', qdrantBatch.length);

  // PG Keyword
  const query_sql = `SELECT c.chunk_id, d.title, d.doc_number,
         ts_rank_cd(c.tsv, to_tsquery('simple', $1), 32) * 2.5 +
         ts_rank_cd(c.tsv, to_tsquery('simple', $2), 32) AS rank_score
  FROM chunks c JOIN documents d USING (doc_version_id)
  WHERE (c.tsv @@ to_tsquery('simple', $1) OR c.tsv @@ to_tsquery('simple', $2))
    AND d.status::text = ANY($3::text[])
    AND (d.status = 'testing' OR (d.effective_date <= CURRENT_DATE AND (d.expiry_date IS NULL OR d.expiry_date >= CURRENT_DATE)))
    AND d.role_access && $4::text[]
    AND d.branch_scope && $5::text[]
  ORDER BY rank_score DESC
  LIMIT 25;`;

  const phrase_tsq = 'thoi <-> gian | thoi <-> gio | lam <-> viec';
  const token_tsq = 'thoi | gian | gio | lam | viec | khunggio | calamviec | flexitime | trusochinh | sotrans';
  const statuses = ['active'];
  const roles = ['all', 'employee'];
  const branches = ['all', 'sotrans_logistics'];

  const pgRes = await pool.query(query_sql, [phrase_tsq, token_tsq, statuses, roles, branches]);

  // RRF
  const K = 60;
  const rrfScores = new Map();
  const chunkDetails = new Map();

  function addRanking(rankingList) {
    rankingList.forEach((item, rank) => {
      const cid = item.chunk_id;
      const current = rrfScores.get(cid) || 0;
      rrfScores.set(cid, current + (1 / (K + rank + 1)));
      if (!chunkDetails.has(cid)) {
        chunkDetails.set(cid, item);
      }
    });
  }

  for (const batch of qdrantBatch) {
    const list = (batch || []).map(hit => ({
      chunk_id: String(hit.id || hit.payload?.chunk_id),
      score: hit.score,
      title: hit.payload?.title,
      doc_number: hit.payload?.doc_number
    }));
    addRanking(list);
  }

  const kwList = pgRes.rows.map(r => ({
    chunk_id: String(r.chunk_id),
    score: Number(r.rank_score),
    title: r.title,
    doc_number: r.doc_number
  }));
  addRanking(kwList);

  const sorted = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n=== TOP RRF CANDIDATES ===');
  sorted.slice(0, 12).forEach(([cid, score], idx) => {
    const d = chunkDetails.get(cid);
    console.log(`Rank ${idx + 1}: [${cid}] (RRF: ${score.toFixed(5)}) -> ${d?.title} (${d?.doc_number})`);
  });

  await pool.end();
}

run().catch(console.error);
