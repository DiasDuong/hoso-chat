const db = require('../db');

async function scan() {
  const tablesRes = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  
  const ids = ['180c7240-5d74-47cc-87c2-200bf312802a', 'fdd31f9a-00eb-4dd3-8837-9318dc44f2a1', 'SWC00032', '060098011607'];

  for (const t of tablesRes.rows) {
    const colsRes = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
    `, [t.table_name]);

    for (const col of colsRes.rows) {
      if (['character varying', 'text', 'uuid'].includes(col.data_type)) {
        try {
          const check = await db.query(`
            SELECT count(*)::int as c 
            FROM "${t.table_name}" 
            WHERE "${col.column_name}"::text = ANY($1::text[])
          `, [ids]);
          if (check.rows[0].c > 0) {
            console.log(`Table: ${t.table_name}, Col: ${col.column_name}, Count: ${check.rows[0].c}`);
          }
        } catch (e) {
          // ignore error
        }
      }
    }
  }
  process.exit(0);
}

scan().catch(console.error);
