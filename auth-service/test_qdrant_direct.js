const https = require('https');
const http = require('http');
const fs = require('fs');

const env = fs.readFileSync('/app/.env', 'utf8');
const keyMatch = env.match(/GEMINI_API_KEY=([^\r\n]+)/);
const apiKey = keyMatch ? keyMatch[1].trim() : '';

async function geminiEmbedding(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text }] },
      output_dimensionality: 768
    });
    const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.embedding?.values);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function qdrantSearch(vector) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      vector,
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
    });
    const req = http.request('http://hrbot-qdrant-1:6333/collections/hr_docs/points/search', {
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
  const q = 'Thời giờ làm việc của công ty như thế nào?';
  console.log('Embedding query:', q);
  const vec = await geminiEmbedding(q);
  console.log('Got vector:', vec ? vec.length : 'null');
  const hits = await qdrantSearch(vec);
  console.log('Qdrant Search hits:', hits.length);
  for (const h of hits) {
    console.log(`  [${h.id}] score: ${h.score.toFixed(4)} | title: ${h.payload?.title} | doc: ${h.payload?.doc_number}`);
  }
}

run().catch(console.error);
