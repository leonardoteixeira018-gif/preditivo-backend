const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? true
    : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'ERROR',
    msg: 'Unexpected pool error',
    error: err.message
  }));
});

module.exports = pool;
