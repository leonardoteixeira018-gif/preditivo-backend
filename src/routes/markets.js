const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

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

router.post('/:id/resolve', async (req, res) => {
  try {
    const { outcome } = req.body; // 'yes' ou 'no'
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    if (market.rows[0].resolved_at) return res.status(400).json({ error: 'Mercado já resolvido' });

    // Marca mercado como resolvido
    await pool.query(
      'UPDATE markets SET status = $1, resolved_outcome = $2, resolved_at = NOW() WHERE id = $3',
      ['resolved', outcome, req.params.id]
    );

    // Paga os vencedores
    const winners = await pool.query(
      'SELECT * FROM bets WHERE market_id = $1 AND side = $2 AND status = $3',
      [req.params.id, outcome, 'open']
    );

    for (const bet of winners.rows) {
      const payout = parseFloat(bet.potential_payout);
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payout, bet.user_id]);
      await pool.query('UPDATE bets SET status = $1, payout = $2 WHERE id = $3', ['won', payout, bet.id]);
    }

    // Marca perdedores
    await pool.query(
      'UPDATE bets SET status = $1 WHERE market_id = $2 AND side != $3 AND status = $4',
      ['lost', req.params.id, outcome, 'open']
    );

    res.json({ 
      success: true, 
      winners_paid: winners.rows.length,
      outcome 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
