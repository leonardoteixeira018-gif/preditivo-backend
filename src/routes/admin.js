const router = require('express').Router();
const pool = require('../lib/db');
const { processReferralBonus } = require('./deposits');

async function processRollover(userId) {
  try {
    const user = await pool.query(
      'SELECT bonus_locked, bonus_bets_count FROM users WHERE id = $1', [userId]
    );
    if (!user.rows.length) return;
    const locked = parseFloat(user.rows[0].bonus_locked || 0);
    const count = parseInt(user.rows[0].bonus_bets_count || 0);
    if (locked <= 0) return;
    const newCount = count + 1;
    if (newCount >= 3) {
      await pool.query(
        'UPDATE users SET bonus_bets_count = 0, bonus_locked = 0 WHERE id = $1', [userId]
      );
      console.log('Rollover completo — bônus liberado para:', userId);
    } else {
      await pool.query(
        'UPDATE users SET bonus_bets_count = $1 WHERE id = $2', [newCount, userId]
      );
    }
  } catch (err) {
    console.error('Rollover error:', err.message);
  }
}

router.get('/deposits', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, u.username
      FROM deposits d
      LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/deposits/:id/confirm', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['confirmed', req.params.id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
    await processReferralBonus(user_id, amount);
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
    const result = await pool.query('SELECT id, username, email, balance, bonus_balance, created_at FROM users ORDER BY created_at DESC');
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
    const totalApostado = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM bets`);
    const totalPago = await pool.query(`SELECT COALESCE(SUM(potential_payout), 0) as total FROM bets WHERE status = 'won'`);
    const taxaColetada = await pool.query(`SELECT COALESCE(SUM(taxa), 0) as total FROM bets`);
    const porStatus = await pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as volume FROM bets GROUP BY status`);
    const porMercado = await pool.query(`
      SELECT m.title, m.category, m.resolved_outcome,
        COUNT(b.id) as total_apostas,
        COALESCE(SUM(b.amount), 0) as total_apostado,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) as total_pago,
        COALESCE(SUM(b.taxa), 0) as taxa_coletada,
        COALESCE(SUM(b.amount), 0) - COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) as spread
      FROM markets m
      LEFT JOIN bets b ON b.market_id = m.id
      GROUP BY m.id, m.title, m.category, m.resolved_outcome
      ORDER BY total_apostado DESC
    `);
    const depositos = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'confirmed'`);
    const entrada = parseFloat(totalApostado.rows[0].total);
    const saida = parseFloat(totalPago.rows[0].total);
    res.json({
      total_apostado: entrada, total_pago: saida,
      spread_retido: entrada - saida,
      taxa_coletada: parseFloat(taxaColetada.rows[0].total),
      total_depositado: parseFloat(depositos.rows[0].total),
      por_status: porStatus.rows, por_mercado: porMercado.rows
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/markets', async (req, res) => {
  try {
    const { title, category, ends_at, description } = req.body;
    if (!title || !ends_at) return res.status(400).json({ error: 'titulo e ends_at obrigatorios' });
    const result = await pool.query(
      `INSERT INTO markets (title, category, ends_at, description, q_yes, q_no, b, status)
       VALUES ($1, $2, $3, $4, 100, 100, 100, 'open') RETURNING *`,
      [title, category || 'politica', ends_at, description || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, u.username FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/withdrawals/:id/pay', async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['paid', req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/withdrawals/:id/cancel', async (req, res) => {
  try {
    const w = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);
    if (!w.rows.length) return res.status(404).json({ error: 'Saque não encontrado' });
    if (w.rows[0].status !== 'pending') return res.status(400).json({ error: 'Saque já processado' });
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['cancelled', req.params.id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [w.rows[0].amount, w.rows[0].user_id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/markets/:id/resolve', async (req, res) => {
  try {
    const { outcome } = req.body;
    if (!['yes', 'no'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome deve ser yes ou no' });
    }
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    if (market.rows[0].resolved_at) return res.status(400).json({ error: 'Mercado já resolvido' });

    await pool.query(
      'UPDATE markets SET resolved_at = NOW(), resolved_outcome = $1, status = $2 WHERE id = $3',
      [outcome, 'resolved', req.params.id]
    );

    const bets = await pool.query(
      "SELECT * FROM bets WHERE market_id = $1 AND status = 'open'", [req.params.id]
    );

    for (const bet of bets.rows) {
      if (bet.side === outcome) {
        await pool.query("UPDATE bets SET status = 'won' WHERE id = $1", [bet.id]);
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [bet.potential_payout, bet.user_id]
        );
      } else {
        await pool.query("UPDATE bets SET status = 'lost' WHERE id = $1", [bet.id]);
      }
      await processRollover(bet.user_id);
    }

    res.json({ ok: true, resolved: bets.rows.length + ' apostas processadas' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
