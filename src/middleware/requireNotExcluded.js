const pool = require('../lib/db');

module.exports = async function requireNotExcluded(req, res, next) {
  try {
    const result = await pool.query(
      'SELECT self_excluded_until FROM users WHERE id = $1', [req.user.id]
    );
    const until = result.rows[0]?.self_excluded_until;
    if (until && new Date(until) > new Date()) {
      return res.status(403).json({
        error: 'ACCOUNT_SELF_EXCLUDED',
        message: 'Conta temporariamente suspensa por sua solicitação.',
        excluded_until: until,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};
