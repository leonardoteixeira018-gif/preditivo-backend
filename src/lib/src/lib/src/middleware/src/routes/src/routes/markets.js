const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const { lmsrPrice, lmsrCostForShares } = require('../lib/lmsr');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { title, description, category, closes_at } = req.body;
    const result = await pool.query(
      'INSERT INTO markets (title, description, category, closes_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description, category, closes_at, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resolve', auth, async (req, res) => {
  try {
    const { outcome } = req.body; // 'yes' or 'no'
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    await pool.query('UPDATE markets SET status = $1, resolved_outcome = $2 WHERE id = $3', ['resolved', outcome, req.params.id]);
    const bets = await pool.query('SELECT * FROM bets WHERE market_id = $1 AND outcome = $2', [req.params.id, outcome]);
    for (const bet of bets.rows) {
      const payout = parseFloat(bet.potential_payout);
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payout, bet.user_id]);
      await pool.query('UPDATE bets SET status = $1 WHERE id = $2', ['won', bet.id]);
    }
    await pool.query('UPDATE bets SET status = $1 WHERE market_id = $2 AND outcome != $3 AND status = $4', ['lost', req.params.id, outcome, 'pending']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
