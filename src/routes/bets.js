const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

const TAXA_CASA = 0.02; // 2%

router.post('/', auth, async (req, res) => {
  try {
    const { market_id, side, amount } = req.body;

    // Validação básica
    if (!['yes', 'no'].includes(side)) {
      return res.status(400).json({ error: 'Side deve ser yes ou no' });
    }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [market_id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });

    if (market.rows[0].resolved_at) {
      return res.status(400).json({ error: 'Este mercado ja foi resolvido' });
    }

    // Bloqueia apostas após o closes_at
    if (market.rows[0].ends_at && new Date() > new Date(market.rows[0].ends_at)) {
      return res.status(400).json({ error: 'Este mercado já encerrou as apostas' });
    }

    // Transação atômica para evitar race condition de saldo
    await pool.query('BEGIN');

    const user = await pool.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!user.rows.length) { await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Usuário não encontrado' }); }

    if (parseFloat(user.rows[0].balance) < amt) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const m = market.rows[0];
    const q_yes = parseFloat(m.q_yes);
    const q_no = parseFloat(m.q_no);
    const total = q_yes + q_no;

    const taxa = amt * TAXA_CASA;
    const amount_liquido = amt - taxa;
    const prob_before = side === 'yes' ? q_yes / total : q_no / total;
    const potential_payout = (amount_liquido / prob_before).toFixed(2);

    if (side === 'yes') {
      await pool.query('UPDATE markets SET q_yes = q_yes + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2', [amt, market_id]);
    } else {
      await pool.query('UPDATE markets SET q_no = q_no + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2', [amt, market_id]);
    }

    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amt, req.user.id]);

    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, side, amount, potential_payout, status, taxa) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, market_id, side, amt, potential_payout, 'open', taxa]
    );

    const new_market = await pool.query('SELECT q_yes, q_no FROM markets WHERE id = $1', [market_id]);
    const nq_yes = parseFloat(new_market.rows[0].q_yes);
    const nq_no = parseFloat(new_market.rows[0].q_no);
    const new_total = nq_yes + nq_no;
    const new_prob_yes = Math.round((nq_yes / new_total) * 100);

    await pool.query(
      'INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1,$2,$3,$4)',
      [market_id, (nq_yes / new_total * 100).toFixed(2), (nq_no / new_total * 100).toFixed(2), amt]
    );

    await pool.query('COMMIT');

    const new_balance = parseFloat(user.rows[0].balance) - amt;

    res.json({
      bet: bet.rows[0],
      new_balance,
      new_prob_yes,
      new_prob_no: 100 - new_prob_yes
    });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
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
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });
    const m = market.rows[0];
    const total = parseFloat(m.q_yes) + parseFloat(m.q_no);
    const prob = side === 'yes' ? parseFloat(m.q_yes) / total : parseFloat(m.q_no) / total;
    const amount_liquido = parseFloat(amount) * (1 - TAXA_CASA);
    const payout = (amount_liquido / prob).toFixed(2);
    res.json({ prob: (prob * 100).toFixed(1), payout, taxa: (parseFloat(amount) * TAXA_CASA).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
