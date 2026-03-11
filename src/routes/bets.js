const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
  try {
    const { market_id, side, amount } = req.body;
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [market_id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (parseFloat(user.rows[0].balance) < parseFloat(amount)) return res.status(400).json({ error: 'Saldo insuficiente' });
    const prob = side === 'yes'
      ? market.rows[0].q_yes / (market.rows[0].q_yes + market.rows[0].q_no)
      : market.rows[0].q_no / (market.rows[0].q_yes + market.rows[0].q_no);
    const potential_payout = (parseFloat(amount) / prob).toFixed(2);
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, side, amount, potential_payout) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, market_id, side, amount, potential_payout]
    );
    const new_balance = parseFloat(user.rows[0].balance) - parseFloat(amount);
    res.json({ bet: bet.rows[0], new_balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, m.title as market_title
      FROM bets b
      JOIN markets m ON m.id = b.market_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/quote', async (req, res) => {
  try {
    const { market_id, side, amount } = req.query;
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [market_id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    const m = market.rows[0];
    const prob = side === 'yes' ? m.q_yes / (m.q_yes + m.q_no) : m.q_no / (m.q_yes + m.q_no);
    const payout = (parseFloat(amount) / prob).toFixed(2);
    res.json({ prob: (prob * 100).toFixed(1), payout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
