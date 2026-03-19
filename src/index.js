// v2026.03.17b — fix: processRollover fora da transação + migrations bonus_locked/bonus_bets_count
require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const app = express();

app.set('trust proxy', 1); // Confia no primeiro proxy (Railway/Vercel)

const pool = require('./lib/db');
const logger = require('./lib/logger');
const { APP_URL } = require('./lib/appConfig');
const requestLogger = require('./middleware/requestLogger');

const appOrigin = new URL(APP_URL).origin;
const altOrigin = appOrigin.includes('://www.')
  ? appOrigin.replace('://www.', '://')
  : appOrigin.replace('://', '://www.');

// CORS: adicionar origens permitidas (com e sem www, localhost, vercel, etc)
const allowedOrigins = [
  appOrigin,
  altOrigin,
  'https://bubuya.com.br',        // Sem www
  'https://www.bubuya.com.br',    // Com www
  'http://localhost:3000',
  'http://localhost:8000'
];

app.use(cors({
  origin(origin, callback) {
    // Permitir: sem origin (requests locais), origens na lista, ou dominios conhecidos
    if (!origin || allowedOrigins.includes(origin) ||
        origin?.endsWith('.vercel.app') ||
        origin?.endsWith('.github.io') ||
        origin?.endsWith('.railway.app')) {
      return callback(null, true);
    }
    logger.warn(`CORS bloqueado para origem: ${origin}`, { origin });
    return callback(new Error(`CORS bloqueado para a origem ${origin}`));
  },
  credentials: true
}));

app.use(express.json());
app.use(requestLogger);

// Limitadores de taxa
// authLimiter: protege rotas sensíveis de login/registro contra força bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// generalLimiter: proteção básica para rotas públicas
// 1000 req/15min = ~67 req/min por IP — razoável para uso normal
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Limite de requisições excedido. Tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// adminLoginLimiter: proteção contra brute force do login admin (muito agressivo)
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3, // Máximo 3 tentativas
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login admin. Tente novamente em 15 minutos.' }
});

// adminLimiter: limite agressivo para operações admin (5 req/min)
const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 5, // Máximo 5 requisições por minuto
  message: { error: 'Limite de requisições admin excedido. Tente novamente em 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// webhookLimiter: proteção para endpoints de webhook
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 20, // Máximo 20 webhooks por minuto
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.path.includes('webhook'),
  message: { error: 'Webhook rate limit exceeded' }
});

// Limitadores de auth
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/forgot-password', authLimiter);
app.use('/auth/reset-password', authLimiter);

// Admin login: limiter específico muito agressivo
app.use('/admin/login', adminLoginLimiter);

// Admin: limiter próprio + router ANTES do generalLimiter.
// Quando o adminRouter responde, a req encerra — generalLimiter nunca executa para /admin/*
app.use('/admin', adminLimiter);
app.use('/admin', require('./routes/admin'));

// Webhook: limiter específico
app.use('/deposits/infinitepay/webhook', webhookLimiter);

// General limiter para todas as demais rotas (não afeta /admin)
app.use(generalLimiter);

app.use('/auth', require('./routes/auth'));
app.use('/admin', require('./routes/admin-auth')); // Novo endpoint de login admin
app.use('/markets', require('./routes/markets'));
app.use('/bets', require('./routes/bets'));
app.use('/ranking', require('./routes/ranking'));
app.use('/deposits', require('./routes/deposits'));
app.use('/withdrawals', require('./routes/withdrawals'));
app.use('/referrals', require('./routes/referrals'));
app.use('/transak', require('./routes/transak'));
app.use('/notifications', require('./routes/notifications'));

app.get('/health', async (req, res) => {
  const checks = {
    database: 'unknown',
    memory: process.memoryUsage(),
    uptime_s: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };

  try {
    // Verificar DB
    await pool.query('SELECT 1');
    checks.database = 'connected';

    res.status(200).json({
      status: 'healthy',
      ...checks,
      version: process.env.npm_package_version || '1.0.0'
    });
  } catch (err) {
    logger.error('Health check failed', { error: err.message });

    res.status(503).json({
      status: 'unhealthy',
      ...checks,
      database: 'disconnected'
    });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada' }));
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', msg: err.message, stack: err.stack }));
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: `Servidor rodando na porta ${PORT}` }));

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_total_bets INTEGER').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_profit DECIMAL(18,2)').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_win_rate DECIMAL(5,2)').catch(() => {});
  await pool.query('ALTER TABLE markets ADD COLUMN image_url TEXT').catch(() => {});

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT false').catch(() => {});

  // Colunas de bônus — necessárias para processRollover funcionar
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance DECIMAL(18,2) NOT NULL DEFAULT 0").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_locked DECIMAL(18,2) NOT NULL DEFAULT 0").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_bets_count INTEGER NOT NULL DEFAULT 0").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42)").catch(() => {});
  await pool.query('ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider_reference TEXT').catch(() => {});
  await pool.query('ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider_status TEXT').catch(() => {});
  await pool.query('ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider_payload JSONB NOT NULL DEFAULT \'{}\'::jsonb').catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      purpose VARCHAR(40) NOT NULL,
      email VARCHAR(255) NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      code_hash VARCHAR(255) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blacklisted_tokens (
      token TEXT PRIMARY KEY,
      expired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT false,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT').catch(() => {});

  // Índices adicionais para queries críticas
  await pool.query('CREATE INDEX IF NOT EXISTS idx_bets_user_market ON bets(user_id, market_id)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_bets_status_market ON bets(market_id, status)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deposits_user_status ON deposits(user_id, status)').catch(() => {});

  // Comentários em mercados
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_market_comments_market_id ON market_comments(market_id, created_at DESC)').catch(() => {});

  // Push subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_user_endpoint
    ON push_subscriptions(user_id, (subscription->>'endpoint'))
  `).catch(() => {});

  // Auto-fechar mercados expirados a cada 5 minutos
  const { closeExpiredMarkets } = require('./routes/markets');
  setInterval(() => closeExpiredMarkets().catch(err =>
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', msg: 'closeExpiredMarkets', error: err.message }))
  ), 5 * 60 * 1000);

  const { runBotRound, getBotConfig } = require('./routes/admin');
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: 'Bot cron iniciado' }));

  setInterval(async () => {
    try {
      const config = await getBotConfig();
      if (!config.enabled) return;

      const result = await runBotRound({
        rounds: config.rounds_per_cycle,
        category: config.category || null,
        min_amount: config.min_amount,
        max_amount: config.max_amount
      });

      if (result.bets_placed > 0) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: `Bot: ${result.bets_placed} apostas | vol R$${result.volume}` }));
      }
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', msg: 'Bot cron error', error: err.message }));
    }
  }, 30000);
});
