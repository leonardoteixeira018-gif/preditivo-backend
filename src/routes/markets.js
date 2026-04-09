const router = require('express').Router();
const pool = require('../lib/db');
const adminAuth = require('../middleware/adminAuth');
const { sendEmail } = require('../lib/email');
const { marketWonEmail, marketLostEmail } = require('../lib/emailTemplates');
const { APP_URL, APP_BRAND, ADMIN_EMAIL } = require('../lib/appConfig');
const cache = require('../lib/cache');

const CACHE_KEY_LIST = 'markets:list';
const CACHE_KEY_STATS = 'markets:stats';

/**
 * Gera slug URL-amigável a partir do título.
 * Ex.: "Lula vai ganhar em 2026?" → "lula-vai-ganhar-em-2026"
 */
function generateSlug(title) {
  return String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // remove chars especiais
    .trim()
    .replace(/\s+/g, '-')          // espaços → hífens
    .replace(/-+/g, '-')           // múltiplos hífens → um
    .substring(0, 80);             // máximo 80 chars
}

/**
 * Garante slug único — adiciona sufixo numérico se necessário.
 */
async function uniqueSlug(base, excludeId = null) {
  let candidate = base;
  let attempt = 0;
  while (true) {
    const q = excludeId
      ? await pool.query('SELECT id FROM markets WHERE slug = $1 AND id != $2', [candidate, excludeId])
      : await pool.query('SELECT id FROM markets WHERE slug = $1', [candidate]);
    if (!q.rows.length) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }
}

router.get('/stats', async (req, res) => {
  const cached = cache.get(CACHE_KEY_STATS);
  if (cached) return res.json(cached);

  const client = await pool.connect();
  try {
    // Timeout curto para não bloquear quando banco está sob pressão
    await client.query('SET LOCAL statement_timeout = 5000');

    const [volResult, mktResult, tradersResult] = await Promise.all([
      client.query('SELECT COALESCE(SUM(amount), 0) AS total_volume FROM bets'),
      client.query("SELECT COUNT(*) AS active_markets FROM markets WHERE resolved_at IS NULL AND status = 'open'"),
      client.query('SELECT COUNT(DISTINCT user_id) AS active_traders FROM bets WHERE created_at > NOW() - INTERVAL \'30 days\''),
    ]);

    const stats = {
      total_volume: parseFloat(volResult.rows[0].total_volume),
      active_markets: parseInt(mktResult.rows[0].active_markets, 10),
      active_traders: parseInt(tradersResult.rows[0].active_traders, 10)
    };

    cache.set(CACHE_KEY_STATS, stats, 60_000); // 60s TTL
    res.json(stats);
  } catch (err) {
    // Se banco estiver sobrecarregado, retorna último cache ou zeros (nunca 500)
    const fallback = cache.get(CACHE_KEY_STATS) || { total_volume: 0, active_markets: 0, active_traders: 0 };
    res.json(fallback);
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const category = req.query.category || null;

    const cacheKey = `${CACHE_KEY_LIST}:${category || 'all'}:${limit}:${offset}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const query = `
      SELECT *, COUNT(*) OVER() AS total_count
      FROM markets
      WHERE ($1::text IS NULL OR category = $1)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [category, limit, offset]);

    const response = {
      markets: result.rows.map(r => { const { total_count, ...m } = r; return m; }),
      total: parseInt(result.rows[0]?.total_count || 0, 10),
      limit,
      offset
    };

    cache.set(cacheKey, response, 30_000); // TTL 30s
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview slug without creating a market (used by admin form)
router.get('/preview-slug', async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'title obrigatorio' });
    const slug = generateSlug(title);
    res.json({ slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lookup by slug (must come before /:id to avoid conflicts)
router.get('/by-slug/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const cacheKey = `market:slug:${slug}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const marketRow = await pool.query(
      `SELECT m.*,
        (SELECT COUNT(DISTINCT user_id) FROM bets WHERE market_id = m.id) AS bettors_count
       FROM markets m WHERE m.slug = $1`,
      [slug]
    );
    if (!marketRow.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });

    const history = await pool.query(
      'SELECT prob_yes, prob_no, volume, created_at FROM market_history WHERE market_id = $1 ORDER BY created_at ASC',
      [marketRow.rows[0].id]
    );

    const response = { ...marketRow.rows[0], history: history.rows };
    cache.set(cacheKey, response, 30_000);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const cacheKey = `market:${req.params.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [market, history] = await Promise.all([
      pool.query(
        `SELECT m.*,
          (SELECT COUNT(DISTINCT user_id) FROM bets WHERE market_id = m.id) AS bettors_count
         FROM markets m WHERE m.id = $1`,
        [req.params.id]
      ),
      pool.query(
        'SELECT prob_yes, prob_no, volume, created_at FROM market_history WHERE market_id = $1 ORDER BY created_at ASC',
        [req.params.id]
      )
    ]);

    if (!market.rows.length) {
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    const response = { ...market.rows[0], history: history.rows };
    cache.set(cacheKey, response, 30_000); // 30s TTL
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', adminAuth, async (req, res) => {
  try {
    const { title, description, category, ends_at, closes_at, image_url, initial_prob } = req.body;
    const marketEndsAt = ends_at || closes_at;
    if (!title || !marketEndsAt) {
      return res.status(400).json({ error: 'title e ends_at sao obrigatorios' });
    }

    // Distribute q_yes/q_no proportionally to initial_prob (total liquidity = 200)
    const prob = Math.min(95, Math.max(5, parseFloat(initial_prob) || 50)) / 100;
    const q_yes = Math.round(200 * prob);
    const q_no  = 200 - q_yes;

    // Gerar slug único para URL amigável
    const slugBase = generateSlug(title);
    const slug = await uniqueSlug(slugBase);

    const result = await pool.query(
      `INSERT INTO markets (title, description, category, ends_at, q_yes, q_no, b, volume, status, image_url, slug)
       VALUES ($1, $2, $3, $4, $5, $6, 100, 0, 'open', $7, $8)
       RETURNING *`,
      [title, description || null, category || 'politica', marketEndsAt, q_yes, q_no, image_url || null, slug]
    );

    cache.del(CACHE_KEY_LIST);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/description', adminAuth, async (req, res) => {
  try {
    const { description } = req.body;
    await pool.query('UPDATE markets SET description = $1 WHERE id = $2', [description, req.params.id]);
    cache.del(`market:${req.params.id}`);
    cache.del(CACHE_KEY_LIST);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/image', adminAuth, async (req, res) => {
  try {
    const { image_url } = req.body;
    await pool.query('UPDATE markets SET image_url = $1 WHERE id = $2', [image_url, req.params.id]);
    cache.del(`market:${req.params.id}`);
    cache.del(CACHE_KEY_LIST);
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
    cache.del(CACHE_KEY_STATS);
    cache.del(`market:${m.id}`);
    cache.del('ranking:list');

    // Envia emails fora da transação (não bloqueia o commit em caso de falha)
    for (const bet of winners.rows) {
      sendEmail(
        bet.email,
        `🏆 Você acertou! — Futoro`,
        marketWonEmail(bet.username, m.title, bet.amount, bet.potential_payout)
      ).catch(() => {});
    }

    for (const bet of losers.rows) {
      sendEmail(
        bet.email,
        `Resultado: ${m.title.slice(0, 50)} — Futoro`,
        marketLostEmail(bet.username, m.title, bet.amount, bet.side, outcome)
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
module.exports.generateSlug = generateSlug;
module.exports.uniqueSlug = uniqueSlug;
