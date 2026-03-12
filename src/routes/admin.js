const router = require('express').Router();
const pool = require('../lib/db');
const adminAuth = require('../middleware/adminAuth');
const { processReferralBonus } = require('./deposits');

router.use(adminAuth);

async function processRollover(userId, db = pool) {
  try {
    const user = await db.query(
      'SELECT bonus_locked, bonus_bets_count FROM users WHERE id = $1',
      [userId]
    );

    if (!user.rows.length) return;

    const locked = parseFloat(user.rows[0].bonus_locked || 0);
    const count = parseInt(user.rows[0].bonus_bets_count || 0, 10);

    if (locked <= 0) return;

    const newCount = count + 1;
    if (newCount >= 3) {
      await db.query(
        'UPDATE users SET bonus_bets_count = 0, bonus_locked = 0 WHERE id = $1',
        [userId]
      );
      return;
    }

    await db.query(
      'UPDATE users SET bonus_bets_count = $1 WHERE id = $2',
      [newCount, userId]
    );
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
      ORDER BY d.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/deposits/:id/confirm', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const dep = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!dep.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deposito nao encontrado' });
    }

    if (dep.rows[0].status === 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Deposito ja confirmado' });
    }

    await client.query('UPDATE deposits SET status = $1 WHERE id = $2', [
      'confirmed',
      req.params.id
    ]);

    await client.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2',
      [dep.rows[0].amount, dep.rows[0].user_id]
    );

    await processReferralBonus(dep.rows[0].user_id, dep.rows[0].amount, client);
    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/deposits/:id/reject', async (req, res) => {
  try {
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', [
      'rejected',
      req.params.id
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, balance, bonus_balance, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/balance', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [
      amount,
      user_id
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/receita', async (req, res) => {
  try {
    const totalApostado = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM bets'
    );
    const totalPago = await pool.query(
      "SELECT COALESCE(SUM(potential_payout), 0) AS total FROM bets WHERE status = 'won'"
    );
    const taxaColetada = await pool.query(
      'SELECT COALESCE(SUM(taxa), 0) AS total FROM bets'
    );
    const porStatus = await pool.query(
      'SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS volume FROM bets GROUP BY status'
    );
    const porMercado = await pool.query(`
      SELECT
        m.title,
        m.category,
        m.resolved_outcome,
        COUNT(b.id) AS total_apostas,
        COALESCE(SUM(b.amount), 0) AS total_apostado,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) AS total_pago,
        COALESCE(SUM(b.taxa), 0) AS taxa_coletada,
        COALESCE(SUM(b.amount), 0) - COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) AS spread
      FROM markets m
      LEFT JOIN bets b ON b.market_id = m.id
      GROUP BY m.id, m.title, m.category, m.resolved_outcome
      ORDER BY total_apostado DESC
    `);
    const depositos = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE status = 'confirmed'"
    );

    const entrada = parseFloat(totalApostado.rows[0].total);
    const saida = parseFloat(totalPago.rows[0].total);

    res.json({
      total_apostado: entrada,
      total_pago: saida,
      spread_retido: entrada - saida,
      taxa_coletada: parseFloat(taxaColetada.rows[0].total),
      total_depositado: parseFloat(depositos.rows[0].total),
      por_status: porStatus.rows,
      por_mercado: porMercado.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/markets', async (req, res) => {
  try {
    const { title, category, ends_at, description } = req.body;

    if (!title || !ends_at) {
      return res.status(400).json({ error: 'titulo e ends_at obrigatorios' });
    }

    const result = await pool.query(
      `INSERT INTO markets (title, category, ends_at, description, q_yes, q_no, b, status)
       VALUES ($1, $2, $3, $4, 100, 100, 100, 'open')
       RETURNING *`,
      [title, category || 'politica', ends_at, description || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/markets/:id/reset', async (req, res) => {
  try {
    const { q_yes, q_no, volume } = req.body;

    if (!q_yes || !q_no) {
      return res.status(400).json({ error: 'q_yes e q_no obrigatorios' });
    }

    await pool.query(
      'UPDATE markets SET q_yes = $1, q_no = $2, volume = COALESCE($3, volume) WHERE id = $4',
      [q_yes, q_no, volume || null, req.params.id]
    );

    const total = parseFloat(q_yes) + parseFloat(q_no);
    const probYes = ((parseFloat(q_yes) / total) * 100).toFixed(2);
    const probNo = ((parseFloat(q_no) / total) * 100).toFixed(2);

    await pool.query(
      'INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1, $2, $3, $4)',
      [req.params.id, probYes, probNo, volume || 0]
    );

    res.json({ ok: true, prob_yes: probYes, prob_no: probNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/markets/sync-volume', async (req, res) => {
  try {
    await pool.query(`
      UPDATE markets m
      SET volume = (
        SELECT COALESCE(SUM(b.amount), 0)
        FROM bets b
        WHERE b.market_id = m.id
      )
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/markets/:id/history-seed', async (req, res) => {
  try {
    const { points } = req.body;
    if (!Array.isArray(points)) {
      return res.status(400).json({ error: 'points array required' });
    }

    let inserted = 0;
    for (const point of points) {
      const interval = `${point.days_ago || 0} days ${point.hours_ago || 0} hours`;
      await pool.query(
        `INSERT INTO market_history (market_id, prob_yes, prob_no, volume, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${interval}')`,
        [req.params.id, point.prob_yes, point.prob_no, point.volume]
      );
      inserted += 1;
    }

    res.json({ ok: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, u.username
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/withdrawals/:id/pay', async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [
      'paid',
      req.params.id
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/withdrawals/:id/cancel', async (req, res) => {
  try {
    const withdrawal = await pool.query(
      'SELECT * FROM withdrawals WHERE id = $1',
      [req.params.id]
    );

    if (!withdrawal.rows.length) {
      return res.status(404).json({ error: 'Saque nao encontrado' });
    }

    if (withdrawal.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Saque ja processado' });
    }

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [
      'cancelled',
      req.params.id
    ]);
    await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [withdrawal.rows[0].amount, withdrawal.rows[0].user_id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/markets/:id/resolve', async (req, res) => {
  const client = await pool.connect();

  try {
    const { outcome } = req.body;
    if (!['yes', 'no'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome deve ser yes ou no' });
    }

    await client.query('BEGIN');

    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!market.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    if (market.rows[0].resolved_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Mercado ja resolvido' });
    }

    await client.query(
      'UPDATE markets SET resolved_at = NOW(), resolved_outcome = $1, status = $2 WHERE id = $3',
      [outcome, 'resolved', req.params.id]
    );

    const bets = await client.query(
      "SELECT * FROM bets WHERE market_id = $1 AND status = 'open'",
      [req.params.id]
    );

    for (const bet of bets.rows) {
      if (bet.side === outcome) {
        await client.query("UPDATE bets SET status = 'won' WHERE id = $1", [bet.id]);
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [bet.potential_payout, bet.user_id]
        );
      } else {
        await client.query("UPDATE bets SET status = 'lost' WHERE id = $1", [bet.id]);
      }

      await processRollover(bet.user_id, client);
    }

    await client.query('COMMIT');
    res.json({ ok: true, resolved: `${bets.rows.length} apostas processadas` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
