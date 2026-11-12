const fs = require('fs');
const http = require('http');
const https = require('https');

const env = fs.readFileSync('/app/.env', 'utf8');
const keyMatch = env.match(/GEMINI_API_KEY=([^\r\n]+)/);
const apiKey = keyMatch ? keyMatch[1].trim() : '';

async function checkDocScores() {
  const queries = [
    "thời gian làm việc của nhân viên SOTRANS",
    "quy định quy chế nội quy giờ làm việc thời gian làm việc",
    "khung giờ làm việc ca sáng ca chiều khối văn phòng khối vận hành SOTRANS"
  ];
  for (const q of queries) {
    const data = JSON.stringify({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: q }] },
      output_dimensionality: 768
    });
    const vec = await new Promise((resolve, reject) => {
      const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body).embedding?.values));
      });
      req.write(data);
      req.end();
    });

    const hits = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        vector: vec,
        limit: 25,
        with_payload: true,
        filter: {
          must: [
            { key: 'status', match: { any: ['active'] } },
            { key: 'role_access', match: { any: ['all', 'employee'] } },
            { key: 'branch_scope', match: { any: ['all', 'sotrans_logistics'] } }
          ]
        }
      });
      const req = http.request('http://hrbot-qdrant-1:6333/collections/hr_docs/points/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body).result || []));
      });
      req.write(payload);
      req.end();
    });

    console.log(`\nQuery: "${q}"`);
    const hitCDS = hits.find(h => h.id === '385ff68c-d1ea-42d9-9050-55ee3bf80c9c');
    const hitVPC = hits.find(h => h.id === '310a2f4e-e4a4-4d3a-91f9-3a8cc363bfe3');
    const hit01 = hits.find(h => h.id === '2a71e5db-6491-46fe-9a5d-2691d71862b8');
    console.log(`  01/QC: rank ${hits.indexOf(hit01) + 1}, score: ${hit01?.score?.toFixed(4)}`);
    console.log(`  VPC:   rank ${hits.indexOf(hitVPC) + 1}, score: ${hitVPC?.score?.toFixed(4)}`);
    console.log(`  CDS:   rank ${hits.indexOf(hitCDS) + 1}, score: ${hitCDS?.score?.toFixed(4)}`);
  }
}

checkDocScores().catch(console.error);
