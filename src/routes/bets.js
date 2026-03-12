const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

const TAXA_CASA = 0.02;

router.post('/', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { market_id, side, amount } = req.body;

    if (!['yes', 'no'].includes(side)) {
      return res.status(400).json({ error: 'Side deve ser yes ou no' });
    }

    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      return res.status(400).json({ error: 'Valor invalido' });
    }

    await client.query('BEGIN');

    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [market_id]
    );

    if (!market.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    if (market.rows[0].resolved_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este mercado ja foi resolvido' });
    }

    if (market.rows[0].ends_at && new Date() > new Date(market.rows[0].ends_at)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este mercado ja encerrou as apostas' });
    }

    const user = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (!user.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    if (parseFloat(user.rows[0].balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const marketRow = market.rows[0];
    const qYes = parseFloat(marketRow.q_yes);
    const qNo = parseFloat(marketRow.q_no);
    const total = qYes + qNo;
    const probBefore = side === 'yes' ? qYes / total : qNo / total;
    const taxa = amt * TAXA_CASA;
    const amountLiquido = amt - taxa;
    const potentialPayout = (amountLiquido / probBefore).toFixed(2);

    if (side === 'yes') {
      await client.query(
        'UPDATE markets SET q_yes = q_yes + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2',
        [amt, market_id]
      );
    } else {
      await client.query(
        'UPDATE markets SET q_no = q_no + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2',
        [amt, market_id]
      );
    }

    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [
      amt,
      req.user.id
    ]);

    const bet = await client.query(
      `INSERT INTO bets (user_id, market_id, side, amount, potential_payout, status, taxa)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, market_id, side, amt, potentialPayout, 'open', taxa]
    );

    const newMarket = await client.query(
      'SELECT q_yes, q_no FROM markets WHERE id = $1',
      [market_id]
    );

    const newQYes = parseFloat(newMarket.rows[0].q_yes);
    const newQNo = parseFloat(newMarket.rows[0].q_no);
    const newTotal = newQYes + newQNo;
    const newProbYes = Math.round((newQYes / newTotal) * 100);

    await client.query(
      'INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1, $2, $3, $4)',
      [
        market_id,
        ((newQYes / newTotal) * 100).toFixed(2),
        ((newQNo / newTotal) * 100).toFixed(2),
        amt
      ]
    );

    await client.query('COMMIT');

    const newBalance = parseFloat(user.rows[0].balance) - amt;

    res.json({
      bet: bet.rows[0],
      new_balance: newBalance,
      new_prob_yes: newProbYes,
      new_prob_no: 100 - newProbYes
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, m.title AS market_title
       FROM bets b
       JOIN markets m ON m.id = b.market_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
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

    const marketRow = market.rows[0];
    const total = parseFloat(marketRow.q_yes) + parseFloat(marketRow.q_no);
    const prob = side === 'yes'
      ? parseFloat(marketRow.q_yes) / total
      : parseFloat(marketRow.q_no) / total;
    const amountLiquido = parseFloat(amount) * (1 - TAXA_CASA);
    const payout = (amountLiquido / prob).toFixed(2);

    res.json({
      prob: (prob * 100).toFixed(1),
      payout,
      taxa: (parseFloat(amount) * TAXA_CASA).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
