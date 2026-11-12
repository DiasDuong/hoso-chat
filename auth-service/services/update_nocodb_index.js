const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/usr/app/data/noco.db');

db.exec('DROP INDEX IF EXISTS uq_nc_hoso_citizen_id;');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_nc_hoso_employee_id ON nc_08u4___Hoso_Nhansu (employee_id) WHERE employee_id IS NOT NULL AND employee_id <> '';");

const list = db.prepare('PRAGMA index_list(nc_08u4___Hoso_Nhansu)').all();
console.log('Updated indexes:', list);
