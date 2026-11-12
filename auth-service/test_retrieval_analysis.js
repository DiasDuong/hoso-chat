const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://hrbot:hrchatbot@postgres:5432/hrbot' });

async function main() {
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
  const token_tsq = 'thoi | gian | gio | lam | viec | khunggio | calamviec | flexitime | trusochinh';
  const statuses = ['active'];
  const roles = ['all', 'employee'];
  const branches = ['all', 'sotrans_logistics'];

  const res = await pool.query(query_sql, [phrase_tsq, token_tsq, statuses, roles, branches]);
  console.log(`PG Keyword Hits: ${res.rows.length}`);
  for (const r of res.rows.slice(0, 10)) {
    console.log(`  [${r.chunk_id}] ${r.title} (${r.doc_number}) -> score: ${Number(r.rank_score).toFixed(4)}`);
  }
  await pool.end();
}
main().catch(console.error);
