const pool = require('./db');
(async () => {
  try {
    const res = await pool.query(`
      SELECT table_name, view_definition 
      FROM information_schema.views 
      WHERE table_schema = 'public'
    `);
    console.log(res.rows.map(v => ({ name: v.table_name, hasDob: v.view_definition.includes('date_of_birth') })));
    res.rows.filter(v => v.view_definition.includes('date_of_birth')).forEach(v => {
      console.log('View:', v.table_name);
      console.log(v.view_definition);
    });
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
