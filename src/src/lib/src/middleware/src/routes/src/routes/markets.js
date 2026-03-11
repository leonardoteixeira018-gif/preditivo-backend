const router = require('express').Router();
const db = require('../lib/db');
const lmsr = require('../lib/lmsr');
const auth = require('../middleware/auth');

// GET /markets — listar todos
router.get('/', async (req, res) => {
  const { category } = req.query;
  let query = `
    SELECT
      m.*,
      ROUND(${lmsr.probYes.toString().includes('function') ? '' : ''}
        (exp(q_yes::float / b::float) / (exp(q_yes::float / b::float) + exp(q_no::float / b::float))) * 100, 1
      ) as prob_yes,
      ROUND(
        (exp(q_no::float / b::float) / (exp(q_yes::float / b::float) + exp(q_no::float / b::float))) * 100, 1
      ) as prob_no,
      COUNT(DISTINCT bets.user_id) as traders
    FROM markets m
    LEFT JOIN bets ON bets.market_id = m.id
    WHERE m.resolved_at IS NULL
    ${category ? 'AND m.category = $1' : ''}
    GROUP BY m.id
    ORDER BY m.volume DESC
  `;
  try {
    const result = await db.query(query, category ? [category] : []);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /markets/:id — detalhe de um mercado
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        m.*,
        ROUND((exp(q_yes::float / b::float) / (exp(q_yes::float / b::float) + exp(q_no::float / b::float))) * 100, 1) as prob_yes,
        ROUND((exp(q_no::float / b::float) / (exp(q_yes::float / b::float) + exp(q_no::float / b::float))) * 100, 1) as prob_no,
        COUNT(DISTINCT bets.user_id) as traders
      FROM markets m
      LEFT JOIN bets ON bets.market_id = m.id
      WHERE m.id = $1
      GROUP BY m.id
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Mercado não encontrado' });
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /markets — criar mercado (admin)
router.post('/', auth, async (req, res) => {
  const { title, category, description, ends_at } = req.body;
  if (!title || !category || !ends_at)
    return res.status(400).json({ error: 'Campos obrigatórios: title, category, ends_at' });

  try {
    const result = await db.query(`
      INSERT INTO markets (title, category, description, ends_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [title, category, description, ends_at]);
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /markets/:id/resolve — resolver mercado (admin)
router.post('/:id/resolve', auth, async (req, res) => {
  const { outcome } = req.body; // true = SIM, false = NÃO
  if (outcome === undefined) return res.status(400).json({ error: 'outcome obrigatório' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Atualiza o mercado
    await client.query(
      'UPDATE markets SET outcome = $1, resolved_at = NOW() WHERE id = $2',
      [outcome, req.params.id]
    );

    // Busca todas as apostas vencedoras
    const bets = await client.query(
      'SELECT * FROM bets WHERE market_id = $1 AND side = $2 AND payout IS NULL',
      [req.params.id, outcome]
    );

    // Paga os vencedores (1 share = 1 USDC)
    for (const bet of bets.rows) {
      const payout = parseFloat(bet.shares);
      await client.query(
        'UPDATE bets SET payout = $1 WHERE id = $2',
        [payout, bet.id]
      );
      await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [payout, bet.user_id]
      );
    }

    // Marca perdedoras com payout = 0
    await client.query(
      'UPDATE bets SET payout = 0 WHERE market_id = $1 AND side = $2 AND payout IS NULL',
      [req.params.id, !outcome]
    );

    await client.query('COMMIT');
    res.json({ message: 'Mercado resolvido', outcome, winners: bets.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao resolver mercado' });
  } finally {
    client.release();
  }
});

module.exports = router;
