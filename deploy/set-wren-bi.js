'use strict';
const fs = require('node:fs');
const path = require('node:path');
const state = process.argv[2];
if (!['enabled', 'disabled'].includes(state)) throw new Error('Usage: node deploy/set-wren-bi.js enabled|disabled');
const file = path.resolve(__dirname, '../auth-service/storage/bi_wren_config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.enabled = state === 'enabled';
// Write in place to preserve the protected file's existing Windows ACL.
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`Wren BI is ${state}. Later toggles do not require an API restart.`);
