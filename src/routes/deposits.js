const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

// POST /deposits — usuário registra intenção de depósito
router.post('/', auth, async (req, res) => {
  try {
    const { amount, code } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Valor mínimo R$10' });
    const result = await pool.query(
      'INSERT INTO deposits (user_id, amount, code, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, amount, code, 'pending']
    );
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /deposits/my — histórico do usuário
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
