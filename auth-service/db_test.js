const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.test') });

// HARD FAIL-SAFE GUARD
if (process.env.PG_DATABASE !== 'hrbot_test' || process.env.IS_TEST_ENV !== 'true') {
  console.error('FATAL SAFETY GUARD: db_test.js cannot connect to non-test database: ' + process.env.PG_DATABASE);
  process.exit(1);
}

const pool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: 'hrbot_test',
  user: process.env.PG_USER || 'hrbot',
  password: process.env.PG_PASSWORD || 'hrchatbot',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL test client:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
