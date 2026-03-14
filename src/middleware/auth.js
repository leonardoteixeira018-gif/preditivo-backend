const jwt = require('jsonwebtoken');
const pool = require('../lib/db');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const isBlacklisted = await pool.query('SELECT 1 FROM blacklisted_tokens WHERE token = $1 LIMIT 1', [token]);
    if (isBlacklisted.rows.length > 0) {
      return res.status(401).json({ error: 'Token expired (logged out)' });
    }
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
