const router = require('express').Router();
const pool = require('../lib/db');
const adminAuth = require('../middleware/adminAuth');
const { sendEmail } = require('../lib/email');
const { APP_URL, APP_BRAND, ADMIN_EMAIL } = require('../lib/appConfig');
const cache = require('../lib/cache');

const CACHE_KEY_LIST = 'markets:list';

router.get('/stats', async (req, res) => {
  try {
    const volQ = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total_volume FROM bets');
    const marketsQ = await pool.query('SELECT COUNT(*) AS total FROM markets WHERE resolved_at IS NULL');
    const tradersQ = await pool.query('SELECT COUNT(DISTINCT user_id) AS total FROM bets WHERE status = $1', ['open']);

    res.json({
      total_volume: parseFloat(volQ.rows[0].total_volume),
      active_markets: parseInt(marketsQ.rows[0].total, 10),
      active_traders: parseInt(tradersQ.rows[0].total, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEY_LIST);
    if (cached) return res.json(cached);

    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    cache.set(CACHE_KEY_LIST, result.rows, 30_000); // TTL 30s
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const market = await pool.query(
      `SELECT m.*,
        (SELECT COUNT(DISTINCT user_id) FROM bets WHERE market_id = m.id) AS bettors_count
       FROM markets m WHERE m.id = $1`,
      [req.params.id]
    );
    if (!market.rows.length) {
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    const history = await pool.query(
      'SELECT prob_yes, prob_no, volume, created_at FROM market_history WHERE market_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ ...market.rows[0], history: history.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', adminAuth, async (req, res) => {
  try {
    const { title, description, category, ends_at, closes_at, image_url } = req.body;
    const marketEndsAt = ends_at || closes_at;
    if (!title || !marketEndsAt) {
      return res.status(400).json({ error: 'title e ends_at sao obrigatorios' });
    }

    const result = await pool.query(
      `INSERT INTO markets (title, description, category, ends_at, q_yes, q_no, b, volume, status, image_url)
       VALUES ($1, $2, $3, $4, 100, 100, 100, 0, 'open', $5)
       RETURNING *`,
      [title, description || null, category || 'politica', marketEndsAt, image_url || null]
    );

    cache.del(CACHE_KEY_LIST); // Invalida cache ao criar novo mercado
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/description', adminAuth, async (req, res) => {
  try {
    const { description } = req.body;
    await pool.query('UPDATE markets SET description = $1 WHERE id = $2', [description, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/image', adminAuth, async (req, res) => {
  try {
    const { image_url } = req.body;
    await pool.query('UPDATE markets SET image_url = $1 WHERE id = $2', [image_url, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resolve', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { outcome } = req.body;
    if (!['yes', 'no'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome deve ser yes ou no' });
    }

    await client.query('BEGIN');

    // Lock exclusivo — previne resolução dupla concorrente
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

    const m = market.rows[0];

    await client.query(
      'UPDATE markets SET status = $1, resolved_outcome = $2, resolved_at = NOW() WHERE id = $3',
      ['resolved', outcome, m.id]
    );

    const winners = await client.query(
      `SELECT b.*, u.email, u.username
       FROM bets b
       JOIN users u ON u.id = b.user_id
       WHERE b.market_id = $1 AND b.side = $2 AND b.status = $3`,
      [m.id, outcome, 'open']
    );

    for (const bet of winners.rows) {
      const payout = parseFloat(bet.potential_payout);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payout, bet.user_id]);
      await client.query('UPDATE bets SET status = $1, payout = $2 WHERE id = $3', ['won', payout, bet.id]);
    }

    const losers = await client.query(
      `SELECT b.*, u.email, u.username
       FROM bets b
       JOIN users u ON u.id = b.user_id
       WHERE b.market_id = $1 AND b.side != $2 AND b.status = $3`,
      [m.id, outcome, 'open']
    );

    for (const bet of losers.rows) {
      await client.query('UPDATE bets SET status = $1, payout = 0 WHERE id = $2', ['lost', bet.id]);
    }

    await client.query('COMMIT');

    // Invalida caches após commit
    cache.del(CACHE_KEY_LIST);
    cache.del('ranking:list');

    // Envia emails fora da transação (não bloqueia o commit em caso de falha)
    for (const bet of winners.rows) {
      const payout = parseFloat(bet.potential_payout);
      sendEmail(
        bet.email,
        `Voce ganhou! Mercado resolvido - ${APP_BRAND}`,
        `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
          <h2 style="color:#00e676">Parabens, ${bet.username}!</h2>
          <p style="color:#5a6878;margin-bottom:20px">Voce apostou certo no mercado:</p>
          <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin-bottom:20px">
            <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
            <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#00e676">${outcome.toUpperCase()}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Sua aposta: <strong style="color:#e8edf2">R$${parseFloat(bet.amount).toFixed(2)}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Retorno creditado: <strong style="color:#00e676">R$${payout.toFixed(2)}</strong></div>
          </div>
          <a href="${APP_URL}" style="display:inline-block;background:#00e676;color:#080c10;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none">Ver meu saldo</a>
        </div>`
      ).catch(() => {});
    }

    for (const bet of losers.rows) {
      sendEmail(
        bet.email,
        `Resultado do mercado - ${APP_BRAND}`,
        `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
          <h2 style="color:#e8edf2">Resultado do mercado</h2>
          <p style="color:#5a6878;margin-bottom:20px">Ola ${bet.username}, o mercado foi resolvido:</p>
          <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin-bottom:20px">
            <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
            <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#ff4757">${outcome.toUpperCase()}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Sua aposta: <strong style="color:#e8edf2">R$${parseFloat(bet.amount).toFixed(2)} em ${bet.side.toUpperCase()}</strong></div>
          </div>
          <p style="color:#5a6878;font-size:0.85rem;margin-bottom:20px">Nao desanime, explore outros mercados e tente novamente.</p>
          <a href="${APP_URL}" style="display:inline-block;background:#0e1419;color:#00e676;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;border:1px solid rgba(0,230,118,0.3)">Ver mercados</a>
        </div>`
      ).catch(() => {});
    }

    sendEmail(
      ADMIN_EMAIL,
      `[Admin] Mercado resolvido: ${m.title}`,
      `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
        <h2 style="color:#00b4ff">Mercado resolvido</h2>
        <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin:16px 0">
          <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
          <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#e8edf2">${outcome.toUpperCase()}</strong></div>
          <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Vencedores pagos: <strong style="color:#00e676">${winners.rows.length}</strong></div>
          <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Perdedores: <strong style="color:#ff4757">${losers.rows.length}</strong></div>
        </div>
        <a href="${APP_URL}/admin.html" style="display:inline-block;background:#00b4ff;color:#080c10;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none">Ver painel admin</a>
      </div>`
    ).catch(() => {});

    res.json({
      success: true,
      ok: true,
      winners_paid: winners.rows.length,
      winners: winners.rows.length,
      losers: losers.rows.length,
      outcome
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

async function closeExpiredMarkets() {
  const result = await pool.query(`
    UPDATE markets
    SET status = 'closed'
    WHERE status = 'open'
      AND ends_at < NOW()
      AND resolved_at IS NULL
    RETURNING id, title
  `);
  if (result.rows.length > 0) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'INFO',
      msg: `${result.rows.length} mercado(s) fechado(s) por expiração`,
      markets: result.rows.map(m => m.title)
    }));
  }
  return result.rows.length;
}

// ---- COMMENTS ----
const auth = require('../middleware/auth');

// GET /markets/:id/comments — público
router.get('/:id/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.username, u.name, u.avatar_url
       FROM market_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.market_id = $1
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /markets/:id/comments — requer auth
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || content.trim().length < 1 || content.trim().length > 500) {
      return res.status(400).json({ error: 'Comentário deve ter entre 1 e 500 caracteres.' });
    }
    // Verifica se o mercado existe
    const mkt = await pool.query('SELECT id FROM markets WHERE id = $1', [req.params.id]);
    if (!mkt.rows.length) return res.status(404).json({ error: 'Mercado não encontrado.' });

    const result = await pool.query(
      `INSERT INTO market_comments (market_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [req.params.id, req.user.id, content.trim()]
    );
    const comment = result.rows[0];
    // Busca dados do usuário para retornar no mesmo formato do GET
    const userQ = await pool.query('SELECT username, name, avatar_url FROM users WHERE id = $1', [req.user.id]);
    res.json({ ...comment, ...userQ.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/close-expired', adminAuth, async (req, res) => {
  try {
    const count = await closeExpiredMarkets();
    if (count > 0) cache.del(CACHE_KEY_LIST);
    res.json({ ok: true, closed_count: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.closeExpiredMarkets = closeExpiredMarkets;
