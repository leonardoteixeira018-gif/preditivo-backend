const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

// Middleware admin simples
const adminAuth = (req, res, next) => {
  // Aceita qualquer token válido por enquanto — melhore isso depois
  next();
};

// GET /admin/deposits
router.get('/deposits', auth, adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, u.username
      FROM deposits d
      LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/deposits/:id/confirm
router.post('/deposits/:id/confirm', auth, adminAuth, async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['confirmed', req.params.id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/deposits/:id/reject
router.post('/deposits/:id/reject', auth, adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/users
router.get('/users', auth, adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, balance, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/balance
router.post('/balance', auth, adminAuth, async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
