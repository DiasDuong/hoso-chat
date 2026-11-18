'use strict';
const path = require('node:path');
const { createWrenPlanner } = require('../bridge/hubPlanner');
const pythonExecutable = process.argv[2] || path.resolve(__dirname, '../.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const planner = createWrenPlanner({ enabled: true, pythonExecutable });
planner.plan({
  sql: "SELECT date_trunc('month', created_at) AS period, SUM(total_files) AS files FROM hub_intake_batches GROUP BY 1 ORDER BY 1",
  userContext: { user_id: 'offline-demo', role: 'HR', company_id: 'STL', status: 'ACTIVE' },
}).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.code); process.exitCode = 1; });
