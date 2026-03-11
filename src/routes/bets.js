const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const { lmsrCostForShares, lmsrPrice } = require('../lib/lmsr');

const B = 100;

router.get('/quote', async (req, res) => {
  try {
    const { market_id, outcome, amount } = req.query;
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [market_id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    const m = market.rows[0];
    const q = [parseFloat(m.shares_yes), parseFloat(m.shares_no)];
    const i = outcome === 'yes' ? 0 : 1;
    const cost = lmsrCostForShares(q, i, parseFloat(amount), B);
    const price = lmsrPrice(q, i, B);
    res.json({ cost, price, potential_payout: parseFloat(amount) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { market_id, outcome, shares } = req.body;
    const market = await pool.query('SELECT * FROM markets WHERE id = $1 AND status = $2', [market_id, 'open']);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado ou fechado' });
    const m = market.rows[0];
    const q = [parseFloat(m.shares_yes), parseFloat(m.shares_no)];
    const i = outcome === 'yes' ? 0 : 1;
    const cost = lmsrCostForShares(q, i, parseFloat(shares), B);
    const user = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    if (parseFloat(user.rows[0].balance) < cost) return res.status(400).json({ error: 'Saldo insuficiente' });
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [cost, req.user.id]);
    const field = outcome === 'yes' ? 'shares_yes' : 'shares_no';
    await pool.query(`UPDATE markets SET ${field} = ${field} + $1 WHERE id = $2`, [shares, market_id]);
    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, outcome, shares, cost, potential_payout) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, market_id, outcome, shares, cost, shares]
    );
    res.json(bet.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT b.*, m.title as market_title FROM bets b JOIN markets m ON b.market_id = m.id WHERE b.user_id = $1 ORDER BY b.created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
