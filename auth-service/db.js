const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ============================================================================
// 1. PRIMARY OPERATIONAL POOL (Core Auth, User Verification, Audits, Writes)
// ============================================================================
const pool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'hrbot',
  user: process.env.PG_USER || 'hrbot',
  password: process.env.PG_PASSWORD || 'hrchatbot',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client (primary pool):', err);
});

// ============================================================================
// 2. DEDICATED READ-ONLY POOL (BI Reporting / Analytics Engine Least Privilege)
// ============================================================================
const roUser = process.env.PG_RO_USER;
const roPassword = process.env.PG_RO_PASSWORD;
const readonlyConfigured = Boolean(roUser && roPassword && roUser !== (process.env.PG_USER || 'hrbot'));
const assertReadonlyConfigured = () => {
  if (!readonlyConfigured) {
    const err = new Error('Dedicated BI read-only credentials are required.');
    err.code = 'BI_READONLY_NOT_CONFIGURED';
    throw err;
  }
};

const roPool = new Pool({
  host: process.env.PG_RO_HOST || process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_RO_PORT || process.env.PG_PORT || '5432', 10),
  database: process.env.PG_RO_DATABASE || process.env.PG_DATABASE || 'hrbot',
  user: roUser,
  password: roPassword,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

roPool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client (read-only pool):', err);
});

module.exports = {
  // Operational pool helpers (Core Auth, User management, Logs)
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,

  // Dedicated BI / Analytics Read-Only pool helpers
  roQuery: (text, params) => { assertReadonlyConfigured(); return roPool.query(text, params); },
  getReadOnlyClient: () => { assertReadonlyConfigured(); return roPool.connect(); },
  roPool,
};
