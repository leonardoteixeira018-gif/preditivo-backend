const router = require('express').Router();
const db = require('../lib/db');
const lmsr = require('../lib/lmsr');
const auth = require('../middleware/auth');

// POST /bets — fazer uma aposta
router.post('/', auth, async (req, res) => {
  const { market_id, side, amount } = req.body;

  if (!market_id || side === undefined || !amount)
    return res.status(400).json({ error: 'market_id, side e amount são obrigatórios' });

  if (amount <= 0)
    return res.status(400).json({ error: 'Valor deve ser maior que zero' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica saldo do usuário
    const userRes = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.userId]
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('Usuário não encontrado');
    if (parseFloat(user.balance) < amount)
      return res.status(400).json({ error: 'Saldo insuficiente' });

    // Busca estado atual do mercado
    const marketRes = await client.query(
      'SELECT * FROM markets WHERE id = $1 AND resolved_at IS NULL FOR UPDATE',
      [market_id]
    );
    const market = marketRes.rows[0];
    if (!market) return res.status(404).json({ error: 'Mercado não encontrado ou já resolvido' });

    const qYes = parseFloat(market.q_yes);
    const qNo  = parseFloat(market.q_no);
    const b    = parseFloat(market.b);

    // Calcula shares usando LMSR
    const shares = lmsr.sharesForAmount(qYes, qNo, b, side, amount);
    const { newQYes, newQNo, newProb } = lmsr.buyCost(qYes, qNo, b, side, shares);
    const priceAtBet = side ? lmsr.probYes(qYes, qNo, b) : lmsr.probNo(qYes, qNo, b);

    // Atualiza estado do mercado
    await client.query(
      'UPDATE markets SET q_yes = $1, q_no = $2, volume = volume + $3 WHERE id = $4',
      [newQYes, newQNo, amount, market_id]
    );

    // Debita saldo do usuário
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [amount, req.userId]
    );

    // Registra a aposta
    const betRes = await client.query(
      `INSERT INTO bets (user_id, market_id, side, amount, shares, price_at_bet)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.userId, market_id, side, amount, shares, priceAtBet]
    );

    await client.query('COMMIT');

    res.status(201).json({
      bet: betRes.rows[0],
      new_prob_yes: Math.round(lmsr.probYes(newQYes, newQNo, b) * 100 * 10) / 10,
      new_prob_no: Math.round(lmsr.probNo(newQYes, newQNo, b) * 100 * 10) / 10,
      shares_bought: shares.toFixed(4),
      potential_payout: shares.toFixed(2),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (!res.headersSent) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar aposta' });
    }
  } finally {
    client.release();
  }
});

// GET /bets/my — minhas apostas
router.get('/my', auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        b.*,
        m.title as market_title,
        m.category,
        m.outcome as market_outcome,
        m.resolved_at,
        ROUND((exp(m.q_yes::float / m.b::float) / (exp(m.q_yes::float / m.b::float) + exp(m.q_no::float / m.b::float))) * 100, 1) as current_prob_yes
      FROM bets b
      JOIN markets m ON m.id = b.market_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [req.userId]);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /bets/quote — simular aposta sem confirmar
router.get('/quote', async (req, res) => {
  const { market_id, side, amount } = req.query;
  if (!market_id || side === undefined || !amount)
    return res.status(400).json({ error: 'market_id, side e amount são obrigatórios' });

  try {
    const marketRes = await db.query(
      'SELECT q_yes, q_no, b FROM markets WHERE id = $1', [market_id]
    );
    const market = marketRes.rows[0];
    if (!market) return res.status(404).json({ error: 'Mercado não encontrado' });

    const qYes = parseFloat(market.q_yes);
    const qNo  = parseFloat(market.q_no);
    const b    = parseFloat(market.b);
    const sideB = side === 'true' || side === true;

    const shares = lmsr.sharesForAmount(qYes, qNo, b, sideB, parseFloat(amount));
    const currentProb = sideB ? lmsr.probYes(qYes, qNo, b) : lmsr.probNo(qYes, qNo, b);

    res.json({
      amount: parseFloat(amount),
      side: sideB,
      shares: shares.toFixed(4),
      potential_payout: shares.toFixed(2),
      current_prob: Math.round(currentProb * 100 * 10) / 10,
      avg_price: (parseFloat(amount) / shares).toFixed(4),
    });
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
