const router = require('express').Router();
const pool = require('../lib/db');
const adminAuth = require('../middleware/adminAuth');
const { processReferralBonus } = require('./deposits');
const { logAudit } = require('../lib/audit');
const logger = require('../lib/logger');
const cache = require('../lib/cache');
const { validateCPF } = require('../lib/kyc');
const { verifyCPF } = require('../lib/kyc-bureau');
const { runFullScreening } = require('../lib/pep-screening');
const { validateAnswers, calculateProfile, calcExpiresAt } = require('../lib/suitability');

router.use(adminAuth);

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const cached = cache.get('admin:dashboard');
    if (cached) return res.json(cached);

    const result = await pool.query(`
      WITH
        withdrawals_pending AS (
          SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
          FROM withdrawals WHERE status = 'pending'
        ),
        deposits_pending AS (
          SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
          FROM deposits WHERE status = 'pending'
        ),
        users_new AS (
          SELECT
            COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)               AS today,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS week,
            COUNT(*)                                                          AS total
          FROM users WHERE COALESCE(is_bot, FALSE) = FALSE
        ),
        bets_volume AS (
          SELECT
            COALESCE(SUM(b.amount) FILTER (WHERE b.created_at >= CURRENT_DATE),              0) AS today,
            COALESCE(SUM(b.amount) FILTER (WHERE b.created_at >= NOW() - INTERVAL '7 days'), 0) AS week
          FROM bets b
          JOIN users u ON u.id = b.user_id
          WHERE COALESCE(u.is_bot, FALSE) = FALSE
        ),
        revenue AS (
          SELECT
            COALESCE(SUM(b.taxa) FILTER (WHERE b.created_at >= CURRENT_DATE),              0) AS today,
            COALESCE(SUM(b.taxa) FILTER (WHERE b.created_at >= NOW() - INTERVAL '7 days'), 0) AS week
          FROM bets b
          JOIN users u ON u.id = b.user_id
          WHERE COALESCE(u.is_bot, FALSE) = FALSE
        ),
        markets_summary AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'open')         AS open,
            COUNT(*) FILTER (WHERE status = 'closed')       AS closed,
            COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved
          FROM markets
        ),
        kyc_summary AS (
          SELECT
            COUNT(*) FILTER (WHERE kyc_status = 'submitted') AS pending_review,
            COUNT(*) FILTER (WHERE kyc_status = 'approved')  AS approved,
            COUNT(*) FILTER (WHERE kyc_status = 'rejected')  AS rejected
          FROM users WHERE COALESCE(is_bot, FALSE) = FALSE
        ),
        coaf_summary AS (
          SELECT COUNT(*) AS pending_flags
          FROM coaf_flags WHERE status = 'pending'
        ),
        pep_summary AS (
          SELECT COUNT(*) AS pep_flagged
          FROM users
          WHERE pep_status = 'flagged'
            AND COALESCE(is_bot, FALSE) = FALSE
        ),
        suitability_summary AS (
          SELECT
            COUNT(*) FILTER (WHERE suitability_profile IS NULL)                                        AS sem_perfil,
            COUNT(*) FILTER (WHERE suitability_profile IS NOT NULL AND suitability_expires_at < NOW()) AS expirados,
            COUNT(*) FILTER (WHERE suitability_profile IS NOT NULL AND suitability_expires_at > NOW()) AS ativos
          FROM users
          WHERE COALESCE(is_bot, FALSE) = FALSE
        )
      SELECT
        row_to_json(withdrawals_pending)   AS withdrawals_pending,
        row_to_json(deposits_pending)      AS deposits_pending,
        row_to_json(users_new)             AS users_new,
        row_to_json(bets_volume)           AS bets_volume,
        row_to_json(revenue)               AS revenue,
        row_to_json(markets_summary)       AS markets,
        row_to_json(kyc_summary)           AS kyc,
        row_to_json(coaf_summary)          AS coaf,
        row_to_json(pep_summary)           AS pep,
        row_to_json(suitability_summary)   AS suitability
      FROM withdrawals_pending, deposits_pending, users_new, bets_volume, revenue, markets_summary, kyc_summary, coaf_summary, pep_summary, suitability_summary
    `);

    const dashboard = result.rows[0];
    cache.set('admin:dashboard', dashboard, 30_000); // 30s TTL
    res.json(dashboard);
  } catch (err) {
    logger.error('Dashboard query failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

const MARKET_CURATION_RULES = [
  {
    match: /lula.*elei/i,
    ends_at: '2026-10-25 23:59:59',
    description: 'Resolvido como SIM se Luiz Inacio Lula da Silva vencer a eleicao presidencial de 2026, em primeiro ou segundo turno. Fonte primaria: TSE. Como o segundo turno de 2026 ocorre em 25/10/2026, este mercado encerra nessa data.'
  },
  {
    match: /lula.*aprov|aprov.*lula/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se a aprovacao do governo Lula terminar 2026 acima de 40% em pesquisa nacional de instituto de primeira linha divulgada no fim de dezembro de 2026. Em caso de divergencia, prevalece a media de Datafolha, Quaest e Ipec/Atlas quando disponivel.'
  },
  {
    match: /selic/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se a taxa Selic meta definida pelo Copom estiver abaixo do patamar descrito no mercado em qualquer decisao ate 31/12/2026. Fonte primaria: Banco Central/Copom.'
  },
  {
    match: /dolar|dólar/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se a cotacao comercial USD/BRL atingir ou superar o nivel descrito no mercado em qualquer dia util de 2026. Fonte primaria: Banco Central ou provedores amplamente aceitos como PTAX/AwesomeAPI.'
  },
  {
    match: /recess/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se o Brasil registrar recessao tecnica em 2026, definida como dois trimestres consecutivos de variacao negativa do PIB na serie dessazonalizada do IBGE.'
  },
  {
    match: /pt.*maioria.*cam|camara|câmara/i,
    ends_at: '2026-10-04 23:59:59',
    description: 'Resolvido como SIM se partidos formalmente alinhados ao PT nao conquistarem maioria absoluta das cadeiras da Camara dos Deputados nas eleicoes gerais de 2026. Fonte primaria: TSE.'
  },
  {
    match: /flavio|flávio/i,
    ends_at: '2026-08-15 23:59:59',
    description: 'Resolvido como SIM se Flavio Bolsonaro tiver pedido de registro de candidatura a presidente protocolado no TSE ate 15/08/2026, prazo oficial de registro das candidaturas. Fonte primaria: TSE.'
  },
  {
    match: /stf|impeachment/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se houver aprovacao final de impeachment ou perda definitiva do cargo de ministro do STF por decisao do Senado em 2026. Fonte primaria: Senado Federal e Diario Oficial.'
  },
  {
    match: /bitcoin.*120|bitcoin.*150|bitcoin/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se o preco spot do Bitcoin atingir ou superar o nivel descrito no mercado em qualquer momento ate a data-limite. Fonte primaria: CoinGecko ou exchanges liquidas como Coinbase/Binance.'
  },
  {
    match: /flamengo.*brasileir/i,
    ends_at: '2026-12-31 23:59:59',
    description: 'Resolvido como SIM se o Flamengo terminar a Serie A do Campeonato Brasileiro de 2026 na primeira colocacao. Fonte primaria: CBF.'
  },
  {
    match: /vence.*copa|copa do mundo/i,
    ends_at: '2026-07-19 23:59:59',
    description: 'Resolvido como SIM se o Brasil conquistar a Copa do Mundo FIFA 2026. Fonte primaria: FIFA. A final do torneio esta marcada para 19/07/2026.'
  },
  {
    match: /semifin/i,
    ends_at: '2026-07-15 23:59:59',
    description: 'Resolvido como SIM se a selecao brasileira se classificar para uma das semifinais da Copa do Mundo FIFA 2026. Fonte primaria: FIFA. As semifinais estao marcadas para 14/07/2026 e 15/07/2026.'
  },
  {
    match: /ethereum|eth/i,
    ends_at: '2026-10-31 23:59:59',
    description: 'Resolvido como SIM se o preco spot do Ethereum atingir ou superar o nivel descrito no mercado em qualquer momento ate 31/10/2026. Fonte primaria: CoinGecko ou exchanges liquidas como Coinbase/Binance.'
  },
  {
    match: /ipca/i,
    ends_at: '2027-01-15 23:59:59',
    description: 'Resolvido como SIM se o IPCA acumulado de 2026, divulgado oficialmente pelo IBGE em janeiro de 2027, ficar abaixo do patamar descrito no mercado. Fonte primaria: IBGE.'
  },
  {
    match: /libertadores/i,
    ends_at: '2026-11-30 23:59:59',
    description: 'Resolvido como SIM se o Flamengo conquistar a CONMEBOL Libertadores de 2026. Fonte primaria: CONMEBOL.'
  },
  {
    match: /fase de grupos|grupos da copa/i,
    ends_at: '2026-07-01 23:59:59',
    description: 'Resolvido como SIM se a selecao brasileira for eliminada ainda na fase de grupos da Copa do Mundo FIFA 2026. Fonte primaria: FIFA.'
  },
  {
    match: /campe[aã]o da copa do mundo|é campeão da copa do mundo|e campeao da copa do mundo/i,
    ends_at: '2026-07-19 23:59:59',
    description: 'Resolvido como SIM se o Brasil conquistar a Copa do Mundo FIFA 2026. Fonte primaria: FIFA. A final do torneio esta marcada para 19/07/2026.'
  },
  {
    match: /vorcaro/i,
    ends_at: '2026-03-31 23:59:59',
    description: 'Resolvido como SIM se Daniel Vorcaro estiver oficialmente solto ao final de 31/03/2026, considerando decisao judicial ou ato formal de liberacao amplamente noticiado por fontes confiaveis.'
  }
];

const DEFAULT_BOT_CONFIG = {
  enabled: false,
  rounds_per_cycle: 5,
  min_amount: 5,
  max_amount: 800,
  category: null
};

let adminMetaReadyPromise = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function syntheticDisplayProfile(userId, username) {
  const seed = `${userId}:${username || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }

  const normalized = Math.abs(hash);
  return {
    total_bets: 18 + (normalized % 83),
    total_profit: 450 + (normalized % 14000),
    win_rate: 58 + (normalized % 29)
  };
}

async function ensureAdminMeta() {
  if (!adminMetaReadyPromise) {
    adminMetaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_total_bets INTEGER');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_profit DECIMAL(18,2)');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_win_rate DECIMAL(5,2)');
    })().catch((err) => {
      adminMetaReadyPromise = null;
      throw err;
    });
  }

  return adminMetaReadyPromise;
}

async function readConfig(key, fallback) {
  await ensureAdminMeta();
  const result = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  if (!result.rows.length) return fallback;
  return { ...fallback, ...(result.rows[0].value || {}) };
}

async function writeConfig(key, value) {
  await ensureAdminMeta();
  await pool.query(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
  return value;
}

async function getBotConfig() {
  const config = await readConfig('bot_config', DEFAULT_BOT_CONFIG);
  return {
    enabled: !!config.enabled,
    rounds_per_cycle: clamp(parseInt(config.rounds_per_cycle || DEFAULT_BOT_CONFIG.rounds_per_cycle, 10), 1, 500),
    min_amount: clamp(parseFloat(config.min_amount || DEFAULT_BOT_CONFIG.min_amount), 1, 100000),
    max_amount: clamp(parseFloat(config.max_amount || DEFAULT_BOT_CONFIG.max_amount), 1, 100000),
    category: config.category || null
  };
}

async function setBotConfig(partialConfig) {
  const current = await getBotConfig();
  const next = {
    ...current,
    ...partialConfig
  };

  next.rounds_per_cycle = clamp(parseInt(next.rounds_per_cycle || DEFAULT_BOT_CONFIG.rounds_per_cycle, 10), 1, 500);
  next.min_amount = clamp(parseFloat(next.min_amount || DEFAULT_BOT_CONFIG.min_amount), 1, 100000);
  next.max_amount = clamp(parseFloat(next.max_amount || DEFAULT_BOT_CONFIG.max_amount), next.min_amount, 100000);
  next.enabled = !!next.enabled;
  next.category = next.category || null;

  await writeConfig('bot_config', next);
  return next;
}

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
    logger.error('Failed to fetch deposits', {
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao buscar depositos' });
  }
});

router.post('/deposits/:id/confirm', async (req, res) => {
  const client = await pool.connect();

  try {
    logger.info('Admin deposit confirmation attempt', {
      depositId: req.params.id,
      ip: req.ip
    });

    await client.query('BEGIN');

    const dep = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!dep.rows.length) {
      logger.warn('Admin deposit confirmation failed - deposit not found', {
        depositId: req.params.id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deposito nao encontrado' });
    }

    if (dep.rows[0].status === 'confirmed') {
      logger.warn('Admin deposit confirmation failed - already confirmed', {
        depositId: req.params.id,
        ip: req.ip
      });
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

    const userInfo = await client.query('SELECT email, username FROM users WHERE id = $1', [dep.rows[0].user_id]);
    if (userInfo.rows.length) {
      const { sendEmail } = require('../lib/email');
      const { APP_BRAND } = require('../lib/appConfig');
      await sendEmail(
        userInfo.rows[0].email,
        `Deposito confirmado — ${APP_BRAND}`,
        `<h1>Ola, ${userInfo.rows[0].username}!</h1>
         <p>Seu deposito de <strong>R$${parseFloat(dep.rows[0].amount).toFixed(2)}</strong> foi confirmado manualmente pela nossa equipe.</p>
         <p>Seu saldo ja foi atualizado. Boa sorte!</p>`
      );
    }

    // Log de auditoria
    await logAudit({
      action: 'deposit_confirmed',
      resourceType: 'deposit',
      resourceId: req.params.id,
      adminId: null, // TODO: extrair de JWT quando implementado
      ipAddress: req.ip,
      details: {
        amount: dep.rows[0].amount,
        userId: dep.rows[0].user_id,
        method: dep.rows[0].method
      }
    });

    logger.info('Admin deposit confirmed successfully', {
      depositId: req.params.id,
      amount: dep.rows[0].amount,
      userId: dep.rows[0].user_id,
      ip: req.ip
    });

    cache.del('admin:dashboard');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Admin deposit confirmation failed', {
      depositId: req.params.id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao confirmar deposito' });
  } finally {
    client.release();
  }
});

router.post('/deposits/:id/reject', async (req, res) => {
  try {
    logger.info('Admin deposit rejection', {
      depositId: req.params.id,
      ip: req.ip
    });

    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', [
      'rejected',
      req.params.id
    ]);

    logger.info('Admin deposit rejected successfully', {
      depositId: req.params.id,
      ip: req.ip
    });

    cache.del('admin:dashboard');
    res.json({ ok: true });
  } catch (err) {
    logger.error('Admin deposit rejection failed', {
      depositId: req.params.id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao rejeitar deposito' });
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
    logger.error('Failed to fetch withdrawals', {
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao buscar saques' });
  }
});

router.post('/withdrawals/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('Admin withdrawal payment processing', {
      withdrawalId: id,
      ip: req.ip
    });

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['paid', id]);

    const withdrawal = await pool.query(
      'SELECT w.*, u.email, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = $1',
      [id]
    );

    if (withdrawal.rows.length) {
      logger.info('Admin withdrawal paid successfully', {
        withdrawalId: id,
        amount: withdrawal.rows[0].amount,
        userId: withdrawal.rows[0].user_id,
        ip: req.ip
      });

      const { sendEmail } = require('../lib/email');
      const { APP_BRAND } = require('../lib/appConfig');
      const w = withdrawal.rows[0];
      await sendEmail(
        w.email,
        `Saque Realizado — ${APP_BRAND}`,
        `<h1>Parabens, ${w.username}!</h1>
         <p>Seu saque de <strong>R${parseFloat(w.amount).toFixed(2)}</strong> foi processado e pago para a chave PIX informada.</p>
         <p>Obrigado por utilizar a ${APP_BRAND}.</p>`
      );
    }
    cache.del('admin:dashboard');
    res.json({ ok: true });
  } catch (err) {
    logger.error('Admin withdrawal payment failed', {
      withdrawalId: req.params.id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao processar saque' });
  }
});

router.post('/withdrawals/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('Admin withdrawal cancellation', {
      withdrawalId: id,
      ip: req.ip
    });

    const withdrawal = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);

    if (!withdrawal.rows.length) {
      logger.warn('Admin withdrawal cancellation failed - not found', {
        withdrawalId: id,
        ip: req.ip
      });
      return res.status(404).json({ error: 'Saque nao encontrado' });
    }
    if (withdrawal.rows[0].status !== 'pending') {
      logger.warn('Admin withdrawal cancellation failed - already processed', {
        withdrawalId: id,
        status: withdrawal.rows[0].status,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Saque ja processado' });
    }

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['cancelled', id]);
    await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [withdrawal.rows[0].amount, withdrawal.rows[0].user_id]
    );

    logger.info('Admin withdrawal cancelled successfully', {
      withdrawalId: id,
      amount: withdrawal.rows[0].amount,
      userId: withdrawal.rows[0].user_id,
      ip: req.ip
    });

    cache.del('admin:dashboard');

    const user = await pool.query('SELECT email, username FROM users WHERE id = $1', [withdrawal.rows[0].user_id]);
    if (user.rows.length) {
      const { sendEmail } = require('../lib/email');
      const { APP_BRAND } = require('../lib/appConfig');
      const w = withdrawal.rows[0];
      await sendEmail(
        user.rows[0].email,
        `Saque Cancelado — ${APP_BRAND}`,
        `<h1>Ola, ${user.rows[0].username}!</h1>
         <p>Seu pedido de saque de <strong>R${parseFloat(w.amount).toFixed(2)}</strong> foi cancelado pela nossa equipe.</p>
         <p>O valor ja foi estornado integralmente para o seu saldo na plataforma.</p>`
      );
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('Admin withdrawal cancellation failed', {
      withdrawalId: req.params.id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao cancelar saque' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, balance, created_at, is_bot FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    logger.error('Failed to fetch users', {
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao buscar usuarios' });
  }
});

// GET /admin/receita — receita e lucratividade da plataforma
router.get('/receita', async (req, res) => {
  try {
    const casaQ = await pool.query(`
      SELECT
        COALESCE(SUM(b.amount), 0) AS receita_bruta,
        COALESCE(SUM(b.taxa), 0)   AS taxa_coletada
      FROM bets b
    `);
    const depositosQ = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_depositado
      FROM deposits WHERE status = 'confirmed'
    `);
    const realQ = await pool.query(`
      SELECT
        COALESCE(SUM(b.amount), 0) AS total_apostado,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) AS total_pago,
        COALESCE(SUM(b.taxa), 0)   AS taxa_coletada
      FROM bets b JOIN users u ON u.id = b.user_id
      WHERE COALESCE(u.is_bot, false) = false
    `);
    const botQ = await pool.query(`
      SELECT
        COALESCE(SUM(b.amount), 0) AS total_apostado,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout ELSE 0 END), 0) AS total_pago,
        COALESCE(SUM(b.taxa), 0)   AS taxa_coletada
      FROM bets b JOIN users u ON u.id = b.user_id
      WHERE COALESCE(u.is_bot, false) = true
    `);
    const mercadosQ = await pool.query(`
      SELECT m.title, m.resolved_outcome,
        COALESCE(SUM(b.amount), 0) AS total_apostado,
        COALESCE(SUM(b.taxa), 0)   AS taxa_coletada
      FROM markets m
      LEFT JOIN bets b ON b.market_id = m.id
      GROUP BY m.id, m.title, m.resolved_outcome
      ORDER BY total_apostado DESC LIMIT 20
    `);
    const c = casaQ.rows[0];
    const r = realQ.rows[0];
    const a = botQ.rows[0];
    const totalPago = parseFloat(r.total_pago) + parseFloat(a.total_pago);
    res.json({
      casa: {
        receita_bruta:    parseFloat(c.receita_bruta),
        taxa_coletada:    parseFloat(c.taxa_coletada),
        spread_retido:    parseFloat(c.receita_bruta) - totalPago - parseFloat(c.taxa_coletada),
        total_depositado: parseFloat(depositosQ.rows[0].total_depositado)
      },
      usuarios_reais: {
        total_apostado: parseFloat(r.total_apostado),
        total_pago:     parseFloat(r.total_pago),
        taxa_coletada:  parseFloat(r.taxa_coletada),
        lucro_liquido:  parseFloat(r.total_apostado) - parseFloat(r.total_pago) - parseFloat(r.taxa_coletada)
      },
      usuarios_artificiais: {
        total_apostado: parseFloat(a.total_apostado),
        total_pago:     parseFloat(a.total_pago),
        taxa_coletada:  parseFloat(a.taxa_coletada),
        lucro_liquido:  parseFloat(a.total_apostado) - parseFloat(a.total_pago) - parseFloat(a.taxa_coletada)
      },
      por_mercado: mercadosQ.rows.map(function(m) {
        return {
          title:            m.title,
          total_apostado:   parseFloat(m.total_apostado),
          taxa_coletada:    parseFloat(m.taxa_coletada),
          resolved_outcome: m.resolved_outcome
        };
      })
    });
  } catch (err) {
    logger.error('Failed to fetch revenue data', {
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao buscar dados de receita' });
  }
});

// POST /admin/balance — ajusta ou define o saldo de qualquer usuário
// mode "set"   → define o saldo exatamente para `amount` (usado para bots)
// mode "delta" (padrão) → adiciona/subtrai `amount` ao saldo atual
router.post('/balance', async (req, res) => {
  const { user_id, amount, mode } = req.body;

  if (!user_id || amount === undefined || amount === null) {
    logger.warn('Admin balance adjustment failed - missing parameters', {
      hasUserId: !!user_id,
      hasAmount: amount !== undefined && amount !== null,
      ip: req.ip
    });
    return res.status(400).json({ error: 'user_id e amount são obrigatórios' });
  }
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt)) {
    logger.warn('Admin balance adjustment failed - invalid amount', {
      userId: user_id,
      amount,
      ip: req.ip
    });
    return res.status(400).json({ error: 'amount inválido' });
  }

  try {
    logger.info('Admin balance adjustment attempt', {
      userId: user_id,
      amount: amt,
      mode: mode || 'delta',
      ip: req.ip
    });

    let result;
    if (mode === 'set') {
      if (amt < 0) {
        logger.warn('Admin balance adjustment failed - negative amount', {
          userId: user_id,
          amount: amt,
          ip: req.ip
        });
        return res.status(400).json({ error: 'Saldo não pode ser negativo' });
      }
      result = await pool.query(
        'UPDATE users SET balance = $1 WHERE id = $2 RETURNING id, username, balance',
        [amt, user_id]
      );
    } else {
      // delta: adiciona (ou subtrai se negativo), nunca abaixo de 0
      result = await pool.query(
        'UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) + $1) WHERE id = $2 RETURNING id, username, balance',
        [amt, user_id]
      );
    }
    if (!result.rows.length) {
      logger.warn('Admin balance adjustment failed - user not found', {
        userId: user_id,
        ip: req.ip
      });
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    const row = result.rows[0];

    logger.info('Admin balance adjusted successfully', {
      userId: row.id,
      username: row.username,
      newBalance: parseFloat(row.balance),
      adjustmentAmount: amt,
      ip: req.ip
    });

    res.json({ ok: true, user_id: row.id, username: row.username, new_balance: parseFloat(row.balance) });
  } catch (err) {
    logger.error('Admin balance adjustment failed', {
      userId: user_id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao ajustar saldo' });
  }
});

// POST /admin/markets — criar novo mercado (alias do POST /markets em markets.js)
router.post('/markets', async (req, res) => {
  try {
    const { title, description, category, ends_at, closes_at, image_url } = req.body;

    logger.info('Admin market creation attempt', {
      title,
      category: category || 'politica',
      ip: req.ip
    });

    const marketEndsAt = ends_at || closes_at;
    if (!title || !marketEndsAt) {
      logger.warn('Admin market creation failed - missing fields', {
        hasTitle: !!title,
        hasEndsAt: !!marketEndsAt,
        ip: req.ip
      });
      return res.status(400).json({ error: 'title e ends_at sao obrigatorios' });
    }
    const result = await pool.query(
      `INSERT INTO markets (title, description, category, ends_at, q_yes, q_no, b, volume, status, image_url)
       VALUES ($1, $2, $3, $4, 100, 100, 100, 0, 'open', $5)
       RETURNING *`,
      [title, description || null, category || 'politica', marketEndsAt, image_url || null]
    );

    logger.info('Admin market created successfully', {
      marketId: result.rows[0].id,
      title,
      category: result.rows[0].category,
      endsAt: result.rows[0].ends_at,
      ip: req.ip
    });

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('Admin market creation failed', {
      title: req.body.title,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao criar mercado' });
  }
});

router.post('/markets/:id/resolve', async (req, res) => {
  const client = await pool.connect();

  try {
    const { outcome } = req.body;

    logger.info('Admin market resolution attempt', {
      marketId: req.params.id,
      outcome,
      ip: req.ip
    });

    if (!['yes', 'no'].includes(outcome)) {
      logger.warn('Admin market resolution failed - invalid outcome', {
        marketId: req.params.id,
        outcome,
        ip: req.ip
      });
      return res.status(400).json({ error: 'outcome deve ser yes ou no' });
    }

    await client.query('BEGIN');

    // Lock exclusivo — previne resolução dupla concorrente
    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!market.rows.length) {
      logger.warn('Admin market resolution failed - market not found', {
        marketId: req.params.id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    const m = market.rows[0];

    // Se já resolvido com outcome diferente → erro (não permite mudar)
    if (m.resolved_at && m.resolved_outcome && m.resolved_outcome !== outcome) {
      logger.warn('Admin market resolution failed - already resolved with different outcome', {
        marketId: req.params.id,
        currentOutcome: m.resolved_outcome,
        attemptedOutcome: outcome,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Mercado ja resolvido como "${m.resolved_outcome}". Nao e possivel alterar o resultado.` });
    }

    // Se ainda não resolvido → marcar como resolvido agora
    if (!m.resolved_at) {
      await client.query(
        'UPDATE markets SET resolved_at = NOW(), resolved_outcome = $1, status = $2 WHERE id = $3',
        [outcome, 'resolved', req.params.id]
      );
    }

    const loserSide = outcome === 'yes' ? 'no' : 'yes';

    // Batch 1 — marcar vencedores (1 query para todas as apostas ganhadoras)
    const wonResult = await client.query(
      `UPDATE bets SET status = 'won', payout = potential_payout
       WHERE market_id = $1 AND side = $2 AND status = 'open'
       RETURNING user_id, potential_payout`,
      [req.params.id, outcome]
    );

    // Batch 2 — marcar perdedores (1 query para todas as apostas perdedoras)
    const lostResult = await client.query(
      `UPDATE bets SET status = 'lost', payout = 0
       WHERE market_id = $1 AND side = $2 AND status = 'open'
       RETURNING user_id`,
      [req.params.id, loserSide]
    );

    const newlyProcessed = wonResult.rows.length + lostResult.rows.length;

    // Batch 3 — creditar saldo de todos os vencedores em 1 única query (unnest)
    if (wonResult.rows.length > 0) {
      const payoutByUser = {};
      for (const row of wonResult.rows) {
        payoutByUser[row.user_id] = (payoutByUser[row.user_id] || 0) + (parseFloat(row.potential_payout) || 0);
      }
      const uids    = Object.keys(payoutByUser);
      const amounts = uids.map(uid => payoutByUser[uid]);
      await client.query(
        `UPDATE users SET balance = balance + sub.total
         FROM unnest($1::uuid[], $2::numeric[]) AS sub(uid, total)
         WHERE users.id = sub.uid`,
        [uids, amounts]
      );
    }

    await client.query('COMMIT');

    logger.info('Admin market resolved successfully', {
      marketId: req.params.id,
      marketTitle: m.title,
      outcome,
      winnersCount: wonResult.rows.length,
      losersCount: lostResult.rows.length,
      totalProcessed: newlyProcessed,
      ip: req.ip
    });

    // Invalida cache após commit
    cache.del('markets:list');
    cache.del('ranking:list');
    cache.del('admin:dashboard');

    // Rollover em paralelo (fire-and-forget) — sem esperar
    const allProcessedUids = [...new Set([
      ...wonResult.rows.map(b => b.user_id),
      ...lostResult.rows.map(b => b.user_id)
    ])];
    allProcessedUids.forEach(uid => processRollover(uid, pool).catch(() => {}));

    // Notificações em batch — 1 INSERT com múltiplos rows (fire-and-forget)
    if (newlyProcessed > 0) {
      const allNotifs = [
        ...wonResult.rows.map(b => ({
          user_id: b.user_id,
          type: 'market_won',
          title: '🎉 Você ganhou!',
          body: `${m.title} — você recebeu R$${(parseFloat(b.potential_payout) || 0).toFixed(2)}`,
          meta: JSON.stringify({ market_id: req.params.id, market_title: m.title, payout: parseFloat(b.potential_payout) || 0 })
        })),
        ...lostResult.rows.map(b => ({
          user_id: b.user_id,
          type: 'market_lost',
          title: '📊 Mercado encerrado',
          body: `${m.title} — resultado: ${outcome === 'yes' ? 'SIM' : 'NÃO'}`,
          meta: JSON.stringify({ market_id: req.params.id, market_title: m.title, payout: 0 })
        }))
      ];
      const placeholders = allNotifs.map((_, i) => `($${i*5+1},$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5})`).join(',');
      const notifParams  = allNotifs.flatMap(n => [n.user_id, n.type, n.title, n.body, n.meta]);
      pool.query(
        `INSERT INTO notifications (user_id, type, title, body, meta) VALUES ${placeholders}`,
        notifParams
      ).catch(() => {});
    }

    // Push notifications de resultado (fire-and-forget)
    if (newlyProcessed > 0) {
      try {
        const { sendPushToUser } = require('./notifications');
        const wonByUserPush = {};
        wonResult.rows.forEach(b => {
          wonByUserPush[b.user_id] = (wonByUserPush[b.user_id] || 0) + (parseFloat(b.potential_payout) || 0);
        });
        allProcessedUids.forEach(uid => {
          const won = !!wonByUserPush[uid];
          const payout = wonByUserPush[uid] || 0;
          sendPushToUser(
            uid,
            won ? '🎉 Você ganhou!' : '📊 Mercado encerrado',
            won ? `+R$${payout.toFixed(2)} creditado — ${m.title}` : `${m.title} — resultado: ${outcome === 'yes' ? 'SIM' : 'NÃO'}`,
            `/market.html?id=${req.params.id}`
          ).catch(() => {});
        });
      } catch(e) { /* web-push opcional */ }
    }

    // Emails de resultado (fire-and-forget, em paralelo)
    if (newlyProcessed > 0) {
      const { sendEmail } = require('../lib/email');
      const { APP_BRAND, APP_URL } = require('../lib/appConfig');

      const wonByUser = {};
      wonResult.rows.forEach(b => {
        wonByUser[b.user_id] = (wonByUser[b.user_id] || 0) + (parseFloat(b.potential_payout) || 0);
      });

      pool.query(
        'SELECT id, email, username FROM users WHERE id = ANY($1::uuid[])',
        [allProcessedUids]
      ).then(usersRes => {
        const userMap = {};
        usersRes.rows.forEach(u => { userMap[u.id] = u; });

        allProcessedUids.forEach(uid => {
          const u = userMap[uid];
          if (!u?.email) return;
          const won = !!wonByUser[uid];
          const payout = wonByUser[uid] || 0;
          const subject = won
            ? `🎉 Você ganhou R$${payout.toFixed(2)} — ${APP_BRAND}`
            : `📊 Mercado encerrado — ${APP_BRAND}`;
          const html = won
            ? `<h2>Parabéns, ${u.username}! 🎉</h2>
               <p>Você apostou corretamente em <strong>"${m.title}"</strong> e ganhou <strong>R$${payout.toFixed(2)}</strong>.</p>
               <p>Seu saldo já foi atualizado. Continue apostando!</p>
               <p><a href="${APP_URL}">Acessar ${APP_BRAND}</a></p>`
            : `<h2>Resultado do mercado</h2>
               <p>O mercado <strong>"${m.title}"</strong> foi encerrado com resultado: <strong>${outcome === 'yes' ? 'SIM' : 'NÃO'}</strong>.</p>
               <p>Desta vez não foi, mas há muitos outros mercados abertos esperando por você.</p>
               <p><a href="${APP_URL}">Ver mercados</a></p>`;
          sendEmail(u.email, subject, html).catch(() => {});
        });
      }).catch(() => {});
    }

    // Buscar stats completos do mercado para o relatório detalhado
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'won') as total_winners,
        COUNT(*) FILTER (WHERE status = 'lost') as total_losers,
        COUNT(*) as total_bets,
        COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(amount), 0) as total_wagered,
        COALESCE(SUM(taxa), 0) as total_taxa
      FROM bets WHERE market_id = $1
    `, [req.params.id]);

    const stats = statsResult.rows[0];
    const totalWagered = parseFloat(stats.total_wagered);
    const totalPaidFinal = parseFloat(stats.total_paid);
    const houseRetained = totalWagered - totalPaidFinal;

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'INFO', msg: 'Mercado resolvido',
      market_id: req.params.id, title: m.title, outcome,
      winners: parseInt(stats.total_winners), losers: parseInt(stats.total_losers),
      total_paid: totalPaidFinal.toFixed(2), total_wagered: totalWagered.toFixed(2),
      house_retained: houseRetained.toFixed(2), newly_processed: newlyProcessed
    }));

    // Log de auditoria
    await logAudit({
      action: 'market_resolved',
      resourceType: 'market',
      resourceId: req.params.id,
      adminId: null, // TODO: extrair de JWT quando implementado
      ipAddress: req.ip,
      details: {
        title: m.title,
        outcome,
        winners: parseInt(stats.total_winners),
        losers: parseInt(stats.total_losers),
        total_paid: totalPaidFinal,
        total_wagered: totalWagered
      }
    });

    res.json({
      ok: true,
      outcome,
      title: m.title,
      winners: parseInt(stats.total_winners),
      losers: parseInt(stats.total_losers),
      total_bets: parseInt(stats.total_bets),
      total_paid: totalPaidFinal.toFixed(2),
      total_wagered: totalWagered.toFixed(2),
      total_taxa: parseFloat(stats.total_taxa).toFixed(2),
      house_retained: houseRetained.toFixed(2),
      newly_processed: newlyProcessed
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Admin market resolution failed', {
      marketId: req.params.id,
      outcome: req.body.outcome,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao resolver mercado' });
  } finally {
    client.release();
  }
});

// ── REABRIR MERCADO ───────────────────────────────────────────────────────────
router.post('/markets/:id/reopen', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!market.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mercado não encontrado' });
    }

    // Estorna payouts dos vencedores (debita o que foi pago)
    const { revert_payouts = false, new_ends_at } = req.body;

    if (revert_payouts) {
      const wonBets = await client.query(
        "SELECT user_id, potential_payout FROM bets WHERE market_id = $1 AND status = 'won'",
        [req.params.id]
      );
      for (const b of wonBets.rows) {
        await client.query(
          'UPDATE users SET balance = GREATEST(balance - $1, 0) WHERE id = $2',
          [b.potential_payout, b.user_id]
        );
      }
      // Volta todas apostas para 'open'
      await client.query(
        "UPDATE bets SET status = 'open', payout = NULL WHERE market_id = $1 AND status IN ('won','lost')",
        [req.params.id]
      );
    }

    const endsAt = new_ends_at || market.rows[0].ends_at;
    await client.query(
      `UPDATE markets SET resolved_at = NULL, resolved_outcome = NULL, status = 'open', ends_at = $1 WHERE id = $2`,
      [endsAt, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, message: 'Mercado reaberto com sucesso' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── STATS BOTS ─────────────────────────────────────────────────────────────────
router.get('/bots/stats', async (req, res) => {
  try {
    const config = await getBotConfig();
    const totalBets = await pool.query(`
      SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as volume
      FROM bets b JOIN users u ON u.id = b.user_id
      WHERE COALESCE(u.is_bot, false) = true
    `);
    const todayBets = await pool.query(`
      SELECT COUNT(*) as total, COALESCE(SUM(b.amount),0) as volume
      FROM bets b JOIN users u ON u.id = b.user_id
      WHERE COALESCE(u.is_bot, false) = true AND b.created_at > NOW() - INTERVAL '24 hours'
    `);
    const botBalances = await pool.query(`
      SELECT username, balance FROM users WHERE COALESCE(is_bot, false) = true ORDER BY username LIMIT 20
    `);
    const activityByHour = await pool.query(`
      SELECT date_trunc('hour', b.created_at) as hora,
        COUNT(*) as apostas,
        COALESCE(SUM(b.amount),0) as volume
      FROM bets b JOIN users u ON u.id = b.user_id
      WHERE COALESCE(u.is_bot, false) = true AND b.created_at > NOW() - INTERVAL '48 hours'
      GROUP BY hora ORDER BY hora ASC
    `);
    const marketActivity = await pool.query(`
      SELECT m.title, m.category,
        COUNT(b.id) as bot_bets,
        COALESCE(SUM(b.amount),0) as bot_volume,
        ROUND((m.q_yes::numeric / NULLIF(m.q_yes::numeric + m.q_no::numeric, 0) * 100), 1) as prob_yes
      FROM markets m
      LEFT JOIN bets b ON b.market_id = m.id
        AND b.user_id IN (SELECT id FROM users WHERE COALESCE(is_bot,false)=true)
      WHERE m.resolved_at IS NULL
      GROUP BY m.id, m.title, m.category, m.q_yes, m.q_no
      ORDER BY bot_bets DESC LIMIT 10
    `);
    res.json({
      total: totalBets.rows[0],
      today: todayBets.rows[0],
      bots: botBalances.rows,
      activity_by_hour: activityByHour.rows,
      market_activity: marketActivity.rows,
      bot_enabled: config.enabled,
      config
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/real/stats', async (req, res) => {
  try {
    await ensureAdminMeta();
    const realUsers = await pool.query(`
      SELECT
        id,
        username,
        COALESCE(balance, 0) AS balance,
        rank_total_bets,
        rank_profit,
        rank_win_rate
      FROM users
      WHERE COALESCE(is_bot, false) = false
    `);

    const decoratedUsers = realUsers.rows.map((row) => {
      const synthetic = syntheticDisplayProfile(row.id, row.username);
      return {
        username: row.username,
        balance: parseFloat(row.balance || 0),
        total_bets: parseInt(row.rank_total_bets || synthetic.total_bets, 10),
        total_profit: parseFloat(row.rank_profit || synthetic.total_profit),
        win_rate: parseFloat(row.rank_win_rate || synthetic.win_rate)
      };
    }).sort((a, b) => b.total_profit - a.total_profit || a.username.localeCompare(b.username));

    const totals = decoratedUsers.reduce((acc, row) => {
      acc.total_users += 1;
      acc.total_balance += row.balance;
      acc.display_bets += row.total_bets;
      acc.display_profit += row.total_profit;
      acc.avg_win_rate += row.win_rate;
      return acc;
    }, {
      total_users: 0,
      total_balance: 0,
      display_bets: 0,
      display_profit: 0,
      avg_win_rate: 0
    });

    if (totals.total_users > 0) {
      totals.avg_win_rate = totals.avg_win_rate / totals.total_users;
    }

    res.json({
      totals,
      preview: decoratedUsers.slice(0, 8)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/real/randomize-ranking', async (req, res) => {
  try {
    await ensureAdminMeta();
    const updated = await pool.query(`
      UPDATE users
      SET
        rank_total_bets = FLOOR(random() * 85 + 18)::int,
        rank_profit = ROUND((random() * 14000 + 400)::numeric, 2),
        rank_win_rate = ROUND((random() * 28 + 60)::numeric, 1)
      WHERE COALESCE(is_bot, false) = false
      RETURNING id
    `);

    res.json({ ok: true, updated: updated.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bots/config', async (req, res) => {
  try {
    const config = await getBotConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/config', async (req, res) => {
  try {
    const config = await setBotConfig(req.body || {});
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEED MERCADOS TECH ────────────────────────────────────────────────────────
router.post('/seed/tech-markets', async (req, res) => {
  try {
    const techMarkets = [
      { title: 'ChatGPT ultrapassa 1 bilhão de usuários em 2026?', description: 'Resolvido como SIM se a OpenAI divulgar oficialmente a marca de 1 bilhão de usuários ativos mensais do ChatGPT até 31/12/2026. Fonte: comunicado oficial OpenAI.', q_yes: 130, q_no: 70 },
      { title: 'Apple lança óculos de realidade mista no Brasil em 2026?', description: 'Resolvido como SIM se o Apple Vision Pro (ou sucessor) estiver disponível para compra no Brasil até 31/12/2026. Fonte: site oficial Apple Brasil.', q_yes: 80, q_no: 120 },
      { title: 'Meta lança modelo de IA open source que supera GPT-4 em 2026?', description: 'Resolvido como SIM se algum modelo open source da Meta atingir score superior ao GPT-4 nos benchmarks MMLU ou HumanEval publicados até 31/12/2026.', q_yes: 110, q_no: 90 },
      { title: 'Startup brasileira de IA é avaliada acima de R$1 bilhão em 2026?', description: 'Resolvido como SIM se uma startup de IA com sede no Brasil atingir valuation público acima de R$1 bilhão em rodada de investimento até 31/12/2026. Fonte: Crunchbase ou Startups.com.br.', q_yes: 90, q_no: 110 },
      { title: 'X (Twitter) perde 20% dos usuários ativos em 2026?', description: 'Resolvido como SIM se relatórios oficiais ou análises independentes confirmarem queda de ≥20% nos usuários ativos mensais do X em 2026 vs. 2025.', q_yes: 85, q_no: 115 },
      { title: 'Bitcoin atinge US$150.000 até dezembro de 2026?', description: 'Resolvido como SIM se o preço do Bitcoin atingir ou superar US$150.000 em qualquer exchange líquida (Binance, Coinbase, Kraken) até 31/12/2026. Fonte: CoinGecko.', q_yes: 120, q_no: 80 },
      { title: 'Governo brasileiro regulamenta IA até junho de 2026?', description: 'Resolvido como SIM se o Brasil publicar no Diário Oficial lei ou decreto específico regulamentando o uso de Inteligência Artificial até 30/06/2026.', q_yes: 95, q_no: 105 },
      { title: 'TikTok é banido nos EUA definitivamente em 2026?', description: 'Resolvido como SIM se o aplicativo TikTok for removido das app stores americanas ou proibido por lei federal nos EUA de forma permanente até 31/12/2026. Fonte: Federal Register ou decisão judicial final.', q_yes: 75, q_no: 125 },
    ];

    const inserted = [];
    for (const m of techMarkets) {
      const exists = await pool.query('SELECT id FROM markets WHERE title = $1', [m.title]);
      if (exists.rows.length) { inserted.push({ title: m.title, status: 'já existe' }); continue; }
      const r = await pool.query(
        `INSERT INTO markets (title, category, ends_at, description, q_yes, q_no, b, status)
         VALUES ($1, 'tech', '2026-12-31 23:59:59', $2, $3, $4, 100, 'open') RETURNING id`,
        [m.title, m.description, m.q_yes, m.q_no]
      );
      // Seed de 10 pontos históricos para o gráfico não ficar vazio
      const baseProb = Math.round((m.q_yes / (m.q_yes + m.q_no)) * 100);
      for (let i = 10; i >= 1; i--) {
        const drift = (Math.random() - 0.5) * 8;
        const p = Math.min(95, Math.max(5, baseProb + drift));
        await pool.query(
          `INSERT INTO market_history (market_id, prob_yes, prob_no, volume, created_at)
           VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${i * 3} days')`,
          [r.rows[0].id, p.toFixed(2), (100 - p).toFixed(2), Math.round(Math.random() * 500 + 50)]
        );
      }
      inserted.push({ title: m.title, id: r.rows[0].id, status: 'criado' });
    }
    res.json({ ok: true, markets: inserted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEED MERCADOS TECH BRASIL ─────────────────────────────────────────────────
router.post('/seed/tech-brasil', async (req, res) => {
  try {
    const techBR = [
      { title: 'Nubank atinge 120 milhões de clientes até dezembro de 2026?', description: 'Resolvido como SIM se o Nubank divulgar oficialmente ter alcançado 120 milhões de clientes ativos globais até 31/12/2026. Fonte: relatório de resultados ou comunicado oficial Nubank/Nu Holdings.', q_yes: 115, q_no: 85, ends: '2026-12-31' },
      { title: 'Mercado Livre (MELI) fecha acima de US$2.500 no fim de 2026?', description: 'Resolvido como SIM se a ação MELI (Nasdaq) fechar acima de US$2.500,00 no último pregão de 2026 (31/12/2026). Fonte: Nasdaq oficial.', q_yes: 105, q_no: 95, ends: '2026-12-31' },
      { title: 'PETR4 fecha acima de R$40 no último pregão de 2026?', description: 'Resolvido como SIM se a ação PETR4 (Petrobras PN) fechar acima de R$40,00 no último pregão da B3 em 2026. Fonte: B3.', q_yes: 95, q_no: 105, ends: '2026-12-31' },
      { title: 'VALE3 fecha acima de R$65 no último pregão de 2026?', description: 'Resolvido como SIM se a ação VALE3 fechar acima de R$65,00 no último pregão da B3 em 2026. Fonte: B3.', q_yes: 90, q_no: 110, ends: '2026-12-31' },
      { title: 'Magazine Luiza (MGLU3) sobe acima de R$5 até dezembro de 2026?', description: 'Resolvido como SIM se MGLU3 atingir ou superar R$5,00 em qualquer pregão da B3 até 31/12/2026. Fonte: B3.', q_yes: 80, q_no: 120, ends: '2026-12-31' },
      { title: 'Banco Inter dobra base para 50 milhões de clientes em 2026?', description: 'Resolvido como SIM se o Banco Inter divulgar oficialmente ter atingido 50 milhões de clientes ativos até 31/12/2026. Fonte: relatório de resultados Inter&Co.', q_yes: 85, q_no: 115, ends: '2026-12-31' },
      { title: 'iFood é vendido ou faz IPO na B3 até dezembro de 2026?', description: 'Resolvido como SIM se o iFood anunciar venda a outra empresa ou abertura de capital na B3 até 31/12/2026. Fonte: comunicado oficial iFood ou Prosus.', q_yes: 70, q_no: 130, ends: '2026-12-31' },
      { title: 'Embraer (EMBR3) fecha acima de R$60 no último pregão de 2026?', description: 'Resolvido como SIM se EMBR3 fechar acima de R$60,00 no último pregão da B3 em 2026. Fonte: B3.', q_yes: 110, q_no: 90, ends: '2026-12-31' },
      { title: 'IBOVESPA fecha acima de 170.000 pontos no último pregão de 2026?', description: 'Resolvido como SIM se o índice IBOVESPA fechar acima de 170.000 pontos no último pregão da B3 em 2026. Fonte: B3.', q_yes: 100, q_no: 100, ends: '2026-12-31' },
      { title: 'Totvs lança produto com IA generativa para PMEs até junho de 2026?', description: 'Resolvido como SIM se a Totvs lançar oficialmente produto ou módulo com IA generativa voltado para PMEs até 30/06/2026. Fonte: comunicado oficial Totvs.', q_yes: 120, q_no: 80, ends: '2026-06-30' },
    ];

    const inserted = [];
    for (const m of techBR) {
      const exists = await pool.query('SELECT id FROM markets WHERE title = $1', [m.title]);
      if (exists.rows.length) { inserted.push({ title: m.title, status: 'já existe' }); continue; }
      const r = await pool.query(
        `INSERT INTO markets (title, category, ends_at, description, q_yes, q_no, b, status)
         VALUES ($1, 'tech', $2, $3, $4, $5, 100, 'open') RETURNING id`,
        [m.title, m.ends + ' 23:59:59', m.description, m.q_yes, m.q_no]
      );
      const baseProb = Math.round((m.q_yes / (m.q_yes + m.q_no)) * 100);
      for (let i = 14; i >= 1; i--) {
        const drift = (Math.random() - 0.5) * 10;
        const p = Math.min(95, Math.max(5, baseProb + drift));
        await pool.query(
          `INSERT INTO market_history (market_id, prob_yes, prob_no, volume, created_at)
           VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${i * 2} days')`,
          [r.rows[0].id, p.toFixed(2), (100 - p).toFixed(2), Math.round(Math.random() * 800 + 100)]
        );
      }
      inserted.push({ title: m.title, id: r.rows[0].id, status: 'criado' });
    }
    res.json({ ok: true, markets: inserted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BOT SIMULADOR ─────────────────────────────────────────────────────────────
const BOT_NAMES = ['AlgoTrader','QuantBot','PrevBot','MarketMaker','ArbitraBot','TrendBot','DataDriven','SignalBot','AutoPrev','StatBot','NLP_Bot','MLTrader','DeepBet','BayesBot','FutureBot','OracleBot','ProbBot','EdgeBot','SharpeBot','KellyBot'];

async function ensureBots() {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('bot_secret_2026', 8);
  const bots = [];
  for (const name of BOT_NAMES) {
    const email = `${name.toLowerCase()}@botprev.internal`;
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) {
      bots.push(exists.rows[0].id);
    } else {
      const r = await pool.query(
        `INSERT INTO users (username, email, password_hash, balance, is_bot)
         VALUES ($1, $2, $3, 50000, true) RETURNING id`,
        [name, email, hash]
      );
      bots.push(r.rows[0].id);
    }
  }
  return bots;
}

async function runBotRound({ rounds = 10, market_ids = null, category = null, min_amount = 5, max_amount = 800 } = {}) {
  const TAXA_CASA = 0.02;
  const results = { bets_placed: 0, volume: 0, errors: 0 };
  try {
    const botIds = await ensureBots();

    let marketsQ;
    if (market_ids && market_ids.length > 0) {
      marketsQ = await pool.query(
        `SELECT id, q_yes, q_no FROM markets WHERE id = ANY($1) AND resolved_at IS NULL AND ends_at > NOW()`,
        [market_ids]
      );
    } else if (category) {
      marketsQ = await pool.query(
        `SELECT id, q_yes, q_no FROM markets WHERE resolved_at IS NULL AND ends_at > NOW() AND category = $1 ORDER BY RANDOM() LIMIT 20`,
        [category]
      );
    } else {
      marketsQ = await pool.query(
        `SELECT id, q_yes, q_no FROM markets WHERE resolved_at IS NULL AND ends_at > NOW() ORDER BY RANDOM() LIMIT 20`
      );
    }
    const activeMarkets = marketsQ.rows;
    if (!activeMarkets.length) return results;

    for (let i = 0; i < rounds; i++) {
      try {
        const market = activeMarkets[Math.floor(Math.random() * activeMarkets.length)];
        const botId = botIds[Math.floor(Math.random() * botIds.length)];

        const q_yes = parseFloat(market.q_yes);
        const q_no = parseFloat(market.q_no);
        const total = q_yes + q_no;
        const prob_yes = q_yes / total;

        // Viés realista: bots tendem a apostar no lado mais provável
        const rand = Math.random();
        const side = rand < (prob_yes * 0.6 + 0.2) ? 'yes' : 'no';

        const minAmount = Math.max(1, parseFloat(min_amount || 5));
        const maxAmount = Math.max(minAmount, parseFloat(max_amount || 800));
        const amt = parseFloat((Math.random() * (maxAmount - minAmount) + minAmount).toFixed(2));
        await pool.query('BEGIN');
        const user = await pool.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [botId]);
        if (!user.rows.length || parseFloat(user.rows[0].balance) < amt) {
          // Reabastece bots que ficaram sem saldo
          await pool.query('UPDATE users SET balance = 50000 WHERE id = $1', [botId]);
          await pool.query('ROLLBACK');
          continue;
        }

        const prob_before = side === 'yes' ? q_yes / total : q_no / total;
        const taxa = amt * TAXA_CASA;
        const potential_payout = ((amt - taxa) / prob_before).toFixed(2);

        if (side === 'yes') {
          await pool.query('UPDATE markets SET q_yes = q_yes + $1, volume = COALESCE(volume,0) + $1 WHERE id = $2', [amt, market.id]);
          market.q_yes = q_yes + amt;
        } else {
          await pool.query('UPDATE markets SET q_no = q_no + $1, volume = COALESCE(volume,0) + $1 WHERE id = $2', [amt, market.id]);
          market.q_no = q_no + amt;
        }

        await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amt, botId]);
        await pool.query(
          `INSERT INTO bets (user_id, market_id, side, amount, potential_payout, status, taxa)
           VALUES ($1,$2,$3,$4,$5,'open',$6)`,
          [botId, market.id, side, amt, potential_payout, taxa]
        );

        const newTotal = parseFloat(market.q_yes) + parseFloat(market.q_no);
        const newProbYes = (parseFloat(market.q_yes) / newTotal * 100).toFixed(2);
        await pool.query(
          `INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1,$2,$3,$4)`,
          [market.id, newProbYes, (100 - parseFloat(newProbYes)).toFixed(2), amt]
        );

        await pool.query('COMMIT');
        results.bets_placed++;
        results.volume += amt;
      } catch (e) {
        await pool.query('ROLLBACK').catch(() => {});
        results.errors++;
      }
    }
  } catch (e) {
    console.error('Bot error:', e.message);
  }
  results.volume = parseFloat(results.volume.toFixed(2));
  return results;
}

router.post('/bots/simulate', async (req, res) => {
  const { rounds = 50, market_ids, category = null, min_amount = 5, max_amount = 800 } = req.body;
  const start = Date.now();
  const results = await runBotRound({
    rounds: Math.min(rounds, 500),
    market_ids,
    category,
    min_amount,
    max_amount
  });
  res.json({ ...results, time_ms: Date.now() - start });
});

router.post('/bots/enable', async (req, res) => {
  const config = await setBotConfig({ enabled: true });
  res.json({ ok: true, message: 'Bot automatico ativado', config });
});

router.post('/bots/disable', async (req, res) => {
  const config = await setBotConfig({ enabled: false });
  res.json({ ok: true, message: 'Bot automatico desativado', config });
});

// POST /admin/bots/reload-balances — define o saldo de TODOS os bots em uma única operação SQL
// Substitui o padrão anterior de N requests paralelos (um por bot)
router.post('/bots/reload-balances', async (req, res) => {
  const { amount } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt < 0 || !Number.isFinite(amt)) {
    return res.status(400).json({ error: 'amount deve ser um número positivo' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET balance = $1 WHERE COALESCE(is_bot, false) = true RETURNING id, username, balance`,
      [amt]
    );
    res.json({
      ok: true,
      updated: result.rowCount,
      amount: amt,
      bots: result.rows.map(function(r) {
        return { id: r.id, username: r.username, balance: parseFloat(r.balance) };
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── USER COMPLIANCE DETAIL ────────────────────────────────────────────────────

/**
 * GET /admin/users/:userId/compliance
 * Retorna todos os dados de compliance de um usuário para o painel admin.
 */
router.get('/users/:userId/compliance', async (req, res) => {
  const { userId } = req.params;
  try {
    const [userRes, kycRes, pepRes, coafRes, suitRes, riskTermRes, lgpdRes] = await Promise.all([
      pool.query(`
        SELECT
          u.id, u.username, u.email, u.full_name, u.cpf,
          u.date_of_birth, u.balance, u.created_at,
          u.kyc_status, u.kyc_submitted_at, u.kyc_approved_at,
          u.kyc_rejected_at, u.kyc_rejection_reason, u.kyc_provider_id,
          u.pep_status, u.pep_checked_at,
          u.sanctions_status, u.sanctions_checked_at,
          u.suitability_profile, u.suitability_score,
          u.suitability_completed_at, u.suitability_expires_at,
          u.risk_term_accepted_at, u.risk_term_version,
          u.lgpd_consent_at, u.lgpd_consent_ip, u.data_deletion_requested_at,
          u.admin_notes, u.risk_level, u.last_reviewed_at, u.reviewed_by,
          u.two_fa_enabled, u.two_fa_enabled_at,
          u.self_excluded_until, u.self_excluded_reason
        FROM users u WHERE u.id = $1
      `, [userId]),
      pool.query(
        `SELECT * FROM kyc_reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId]
      ),
      pool.query(
        `SELECT * FROM pep_reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [userId]
      ),
      pool.query(
        `SELECT * FROM coaf_flags WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT id, profile, score, answers, completed_at, expires_at, overridden_by
         FROM suitability_responses WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 5`,
        [userId]
      ),
      pool.query(
        `SELECT term_version, accepted_at, ip_address FROM risk_term_acceptances
         WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 5`,
        [userId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT consent_type, policy_version, accepted_at, ip_address FROM lgpd_consents
         WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 5`,
        [userId]
      ).catch(() => ({ rows: [] }))
    ]);

    if (!userRes.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      ok: true,
      user: userRes.rows[0],
      kyc_reviews: kycRes.rows,
      pep_reviews: pepRes.rows,
      coaf_flags: coafRes.rows,
      suitability_history: suitRes.rows,
      risk_term_history: riskTermRes.rows,
      lgpd_history: lgpdRes.rows,
    });
  } catch (err) {
    logger.error('User compliance detail error', { userId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/users/:userId/coaf-flag
 * Insere um flag COAF manual para o usuário.
 */
router.post('/users/:userId/coaf-flag', async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  try {
    const user = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });

    await pool.query(`
      INSERT INTO coaf_flags (user_id, month_total, threshold, status, resolution_notes)
      VALUES ($1, 0, 10000, 'pending', $2)
    `, [userId, reason || 'Flag manual inserido pelo admin']);

    logger.info('Manual COAF flag inserted', { userId, username: user.rows[0].username });
    res.json({ ok: true, message: 'Flag COAF inserido com sucesso' });
  } catch (err) {
    logger.error('Manual COAF flag error', { userId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/users/:userId/compliance
 * Atualiza notas internas, nível de risco e overrides de compliance.
 */
router.patch('/users/:userId/compliance', async (req, res) => {
  const { userId } = req.params;
  const { admin_notes, risk_level, pep_status, kyc_status, kyc_rejection_reason } = req.body;

  try {
    const currentResult = await pool.query(
      `SELECT admin_notes, risk_level, pep_status, kyc_status, kyc_rejection_reason
       FROM users
       WHERE id = $1`,
      [userId]
    );
    if (!currentResult.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    const current = currentResult.rows[0];

    const nextValues = {
      admin_notes: admin_notes !== undefined ? admin_notes : current.admin_notes,
      risk_level: risk_level !== undefined ? risk_level : current.risk_level,
      pep_status: pep_status !== undefined ? pep_status : current.pep_status,
      kyc_status: kyc_status !== undefined ? kyc_status : current.kyc_status,
      kyc_rejection_reason: kyc_rejection_reason !== undefined ? kyc_rejection_reason : current.kyc_rejection_reason
    };

    await pool.query(
      `UPDATE users
       SET last_reviewed_at = NOW(),
           reviewed_by = $1,
           admin_notes = $2,
           risk_level = $3,
           pep_status = $4,
           kyc_status = $5,
           kyc_rejection_reason = $6
       WHERE id = $7`,
      [
        'admin',
        nextValues.admin_notes,
        nextValues.risk_level,
        nextValues.pep_status,
        nextValues.kyc_status,
        nextValues.kyc_rejection_reason,
        userId
      ]
    );
    logger.info('User compliance updated', { userId, updates: Object.keys(req.body) });
    res.json({ ok: true });
  } catch (err) {
    logger.error('User compliance update error', { userId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /admin/users/:userId
 * Exclui uma conta de usuário completamente (para fins de teste/recadastro).
 * Protegido por adminAuth — apenas administradores podem usar.
 */
router.delete('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar se usuário existe e não tem saldo real
    const check = await client.query(
      'SELECT username, email, balance FROM users WHERE id = $1',
      [userId]
    );
    if (!check.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    const u = check.rows[0];
    if (parseFloat(u.balance) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Usuário tem saldo de R$${parseFloat(u.balance).toFixed(2)}. Zere o saldo antes de excluir.`
      });
    }

    // Corrigir auto-referência (outros usuários indicados por este)
    // users.referred_by não tem ON DELETE CASCADE
    await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [userId]);

    // Excluir tabelas filhas — baseado nas tabelas reais do banco
    // Todas têm ON DELETE CASCADE mas listamos explicitamente por segurança
    await client.query('DELETE FROM kyc_reviews WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM pep_reviews WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM coaf_flags WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM suitability_responses WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM market_comments WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM bets WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM deposits WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM withdrawals WHERE user_id = $1', [userId]);

    // referral_bonuses tem duas FKs para users (referrer_id e referred_id)
    await client.query('DELETE FROM referral_bonuses WHERE referrer_id = $1 OR referred_id = $1', [userId]);

    // Tabelas opcionais com user_id — deletar com .catch() pois podem não existir em todos ambientes
    await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM user_audit_logs WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM audit_logs WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM bonus_transactions WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM risk_term_acceptances WHERE user_id = $1', [userId]).catch(() => {});
    // blacklisted_tokens não tem user_id (apenas token + expired_at) — ignorar

    // Deletar o usuário
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');

    logger.warn('User account deleted by admin', { userId, username: u.username, email: u.email });
    res.json({ ok: true, message: `Conta "${u.username}" (${u.email}) excluída com sucesso.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('User delete error', { userId, error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── SANDBOX DE TESTES ─────────────────────────────────────────────────────────

/**
 * GET /admin/sandbox/users
 * Lista os 100 usuários mais recentes para o selector do sandbox.
 */
router.get('/sandbox/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, kyc_status, suitability_profile
      FROM users
      WHERE COALESCE(is_bot, FALSE) = FALSE
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/simulate/kyc
 * Roda o fluxo completo de KYC (bureau + PEP + sanções) para um usuário
 * com os dados fornecidos pelo admin, sem exigir sessão do usuário.
 *
 * Body: { user_id, cpf, full_name, date_of_birth, apply: boolean }
 * Retorna o resultado detalhado de cada etapa do pipeline.
 * Se apply=true, salva os resultados no DB.
 */
router.post('/simulate/kyc', async (req, res) => {
  const { user_id, cpf: rawCpf, full_name, date_of_birth, apply = false } = req.body;

  if (!user_id || !rawCpf || !full_name || !date_of_birth) {
    return res.status(400).json({ error: 'user_id, cpf, full_name e date_of_birth são obrigatórios' });
  }

  // Valida CPF
  const cpfResult = validateCPF(rawCpf);
  if (!cpfResult.valid) {
    return res.status(400).json({ error: cpfResult.error || 'CPF inválido' });
  }
  const cpf = cpfResult.cleaned;

  // Valida idade mínima 18 anos
  const dob = new Date(date_of_birth);
  if (isNaN(dob)) return res.status(400).json({ error: 'Data de nascimento inválida' });
  const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) return res.status(400).json({ error: 'Usuário deve ter 18 anos ou mais' });

  try {
    // 1. Bureau (CPF)
    const bureauResult = await verifyCPF({ cpf, fullName: full_name, dateOfBirth: date_of_birth });

    let pepResult = null;
    let sanctionsResult = null;
    let finalStatus = 'rejected';
    let finalMessage = '';

    if (!bureauResult.ok) {
      finalStatus = 'bureau_error';
      finalMessage = 'Bureau indisponível — não foi possível verificar o CPF';
    } else if (bureauResult.status === 'rejected') {
      finalStatus = 'rejected';
      finalMessage = `Rejeitado pelo bureau: ${bureauResult.rejectionReason || 'CPF inválido ou situação irregular'}`;
    } else {
      // 2. PEP + Sanções
      const screening = await runFullScreening({ userId: user_id, cpf, fullName: full_name });
      pepResult = screening.pepResult;
      sanctionsResult = screening.sanctionsResult;

      if (sanctionsResult && sanctionsResult.isSanctioned) {
        finalStatus = 'rejected';
        finalMessage = 'Verificação de identidade não aprovada. (sanção detectada)';
      } else if (pepResult && pepResult.isPep) {
        finalStatus = 'submitted';
        finalMessage = 'PEP identificado — aguardando revisão manual do admin';
      } else {
        finalStatus = 'approved';
        finalMessage = 'Identidade verificada com sucesso!';
      }
    }

    // 3. Aplica ao DB se solicitado
    if (apply && bureauResult.ok) {
      const kycStatus = finalStatus === 'approved' ? 'approved'
        : finalStatus === 'submitted' ? 'submitted'
        : 'rejected';

      await pool.query(
        `UPDATE users SET
          cpf = $1,
          full_name = $2,
          date_of_birth = $3,
          kyc_status = $4,
          kyc_submitted_at = NOW(),
          kyc_provider_id = $5,
          ${kycStatus === 'approved' ? 'kyc_approved_at = NOW(),' : ''}
          ${kycStatus === 'rejected' ? `kyc_rejection_reason = '${sanctionsResult?.isSanctioned ? 'sanctions_match' : 'bureau_rejected'}',` : ''}
          last_reviewed_at = NOW(),
          reviewed_by = 'admin_sandbox'
        WHERE id = $6`,
        [cpf, full_name.trim(), date_of_birth, kycStatus, bureauResult.providerId, user_id]
      );
      logger.info('[SANDBOX] KYC simulado e aplicado', { user_id, finalStatus });
    }

    res.json({
      ok: true,
      apply,
      finalStatus,
      finalMessage,
      bureau: {
        provider: bureauResult.provider,
        status: bureauResult.status,
        providerId: bureauResult.providerId,
        rejectionReason: bureauResult.rejectionReason || null,
      },
      pep: pepResult ? {
        isPep: pepResult.isPep,
        confidence: pepResult.confidence,
        source: pepResult.source,
        matchedKeywords: pepResult.details?.matchedKeywords || [],
      } : null,
      sanctions: sanctionsResult ? {
        isSanctioned: sanctionsResult.isSanctioned,
        lists: sanctionsResult.lists || [],
        matchType: sanctionsResult.details?.matchType || null,
      } : null,
    });
  } catch (err) {
    logger.error('[SANDBOX] Erro na simulação KYC', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/simulate/suitability
 * Calcula o perfil de investidor com respostas fornecidas pelo admin,
 * sem exigir sessão do usuário.
 *
 * Body: { user_id, answers: { objetivo, perda, experiencia, horizonte, renda }, apply: boolean }
 */
router.post('/simulate/suitability', async (req, res) => {
  const { user_id, answers, apply = false } = req.body;

  if (!user_id || !answers) {
    return res.status(400).json({ error: 'user_id e answers são obrigatórios' });
  }

  const validationError = validateAnswers(answers);
  if (validationError) return res.status(400).json({ error: validationError });

  const { profile, score, limits, profileData } = calculateProfile(answers);
  const expiresAt = calcExpiresAt();

  try {
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE users SET
            suitability_profile = $1,
            suitability_score = $2,
            suitability_completed_at = NOW(),
            suitability_expires_at = $3
          WHERE id = $4`,
          [profile, score, expiresAt, user_id]
        );
        await client.query(
          `INSERT INTO suitability_responses (user_id, profile, score, answers, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [user_id, profile, score, JSON.stringify(answers), expiresAt]
        );
        await client.query('COMMIT');
        logger.info('[SANDBOX] Suitability simulada e aplicada', { user_id, profile, score });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    res.json({
      ok: true,
      apply,
      profile,
      profileLabel: profileData.label,
      profileDescription: profileData.description,
      score,
      limits,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    logger.error('[SANDBOX] Erro na simulação Suitability', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── BLOCO 7: LGPD ─────────────────────────────────────────────────────────────

/**
 * GET /admin/data-deletion-requests
 * Lista todas as solicitações de exclusão de dados pendentes.
 */
router.get('/data-deletion-requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        d.id, d.user_id, d.requested_at, d.status, d.ip_address, d.notes,
        u.username, u.email, u.balance
      FROM data_deletion_requests d
      JOIN users u ON u.id = d.user_id
      ORDER BY d.requested_at DESC
    `);
    res.json({ ok: true, requests: result.rows });
  } catch (err) {
    logger.error('data-deletion-requests error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Exporta runBotRound para uso no cron do servidor
module.exports = router;
module.exports.runBotRound = runBotRound;
module.exports.getBotConfig = getBotConfig;
