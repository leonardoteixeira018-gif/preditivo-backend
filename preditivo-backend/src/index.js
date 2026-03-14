require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const pool = require('./lib/db');
const { APP_URL } = require('./lib/appConfig');

const appOrigin = new URL(APP_URL).origin;
const altOrigin = appOrigin.includes('://www.')
  ? appOrigin.replace('://www.', '://')
  : appOrigin.replace('://', '://www.');
const allowedOrigins = [appOrigin, altOrigin, 'http://localhost:3000'];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS bloqueado para a origem ${origin}`));
  },
  credentials: true
}));

app.use(express.json());
app.use('/auth', require('./routes/auth'));
app.use('/markets', require('./routes/markets'));
app.use('/bets', require('./routes/bets'));
app.use('/ranking', require('./routes/ranking'));
app.use('/deposits', require('./routes/deposits'));
app.use('/withdrawals', require('./routes/withdrawals'));
app.use('/referrals', require('./routes/referrals'));
app.use('/admin', require('./routes/admin'));
app.use('/transak', require('./routes/transak'));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_total_bets INTEGER').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_profit DECIMAL(18,2)').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_win_rate DECIMAL(5,2)').catch(() => {});
  await pool.query('ALTER TABLE markets ADD COLUMN image_url TEXT').catch(() => {});

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ').catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT false').catch(() => {});
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

  const { runBotRound, getBotConfig } = require('./routes/admin');
  console.log('Bot cron iniciado');

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
        console.log(`Bot: ${result.bets_placed} apostas | vol R$${result.volume}`);
      }
    } catch (err) {
      console.error('Bot cron error:', err.message);
    }
  }, 30000);
});
