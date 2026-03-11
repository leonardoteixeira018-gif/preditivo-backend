const router = require('express').Router();
const pool = require('../lib/db');

router.get('/deposits', async (req, res) => {
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

router.post('/deposits/:id/confirm', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['confirmed', req.params.id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/deposits/:id/reject', async (req, res) => {
  try {
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, balance, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/balance', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/receita', async (req, res) => {
  try {
    // Total apostado
    const totalApostado = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM bets
    `);

    // Total pago em premios (apostas won)
    const totalPago = await pool.query(`
      SELECT COALESCE(SUM(potential_payout), 0) as total FROM bets WHERE status = 'won'
    `);

    // Apostas por status
    const porStatus = await pool.query(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as volume
      FROM bets GROUP BY status
    `);

    // Receita por mercado
    const porMercado = await pool.query(`
      SELECT 
        m.title,
        m.category,
        m.resolved_outcome,
        COUNT(b.id) as total_apostas,
        COALESCE(SUM(b.amount), 0) as total_apostado,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) as total_pago,
        COALESCE(SUM(b.amount), 0) - COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) as spread
      FROM markets m
      LEFT JOIN bets b ON b.market_id = m.id
      GROUP BY m.id, m.title, m.category, m.resolved_outcome
      ORDER BY total_apostado DESC
    `);

    // Depositos confirmados
    const depositos = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'confirmed'
    `);

    const entrada = parseFloat(totalApostado.rows[0].total);
    const saida = parseFloat(totalPago.rows[0].total);

    res.json({
      total_apostado: entrada,
      total_pago: saida,
      spread_retido: entrada - saida,
      total_depositado: parseFloat(depositos.rows[0].total),
      por_status: porStatus.rows,
      por_mercado: porMercado.rows
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
