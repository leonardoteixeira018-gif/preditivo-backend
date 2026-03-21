// v2026.03.17b — fix: processRollover fora da transação + migrations bonus_locked/bonus_bets_count
require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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

app.use(express.json({
  limit: '10mb', // aumentado para suportar anexos base64 (PDFs, imagens) de até ~7MB
  verify(req, res, buf) {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
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

// adminLoginLimiter: proteção contra brute force do login admin
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 tentativas — suficiente para erros de digitação normais
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login admin. Tente novamente em 15 minutos.' }
});

// adminLimiter: limite generoso para uso normal do painel admin
// O painel faz múltiplas chamadas paralelas por aba/drawer, então precisa de margem
const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 300, // 300 req/min — ~5 req/s, mais que suficiente para 1 admin humano
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

// betUserLimiter: limita apostas por usuário (não por IP) — previne abuso
// O keyGenerator usa user_id do JWT se disponível, caso contrário usa IP
const betUserLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,             // 10 apostas/min por usuário
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Muitas apostas em pouco tempo. Aguarde 1 minuto.' }
});

// withdrawalUserLimiter: limita saques por usuário
const withdrawalUserLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,              // 5 req/min por usuário
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Muitas requisições de saque. Aguarde 1 minuto.' }
});

// depositUserLimiter: limita checkouts por usuário
const depositUserLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,              // 5 req/min por usuário
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Muitas requisições de depósito. Aguarde 1 minuto.' }
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
// ⚠️ admin-auth DEVE vir ANTES de admin.js — admin.js aplica adminAuth globalmente
// e bloquearia o POST /admin/login antes de chegar ao roteador de autenticação
app.use('/admin', require('./routes/admin-auth')); // Login/logout (sem auth)
app.use('/admin', require('./routes/admin'));       // Todas as outras rotas (exige auth)

// Webhook: limiter específico
app.use('/deposits/asaas/webhook', webhookLimiter);

// Rate limiters por usuário para rotas autenticadas críticas
app.use('/bets', betUserLimiter);
app.use('/withdrawals', withdrawalUserLimiter);
app.use('/deposits/asaas/checkout', depositUserLimiter);

// General limiter para todas as demais rotas (não afeta /admin)
app.use(generalLimiter);

app.use('/auth', require('./routes/auth'));
app.use('/markets', require('./routes/markets'));
app.use('/bets', require('./routes/bets'));
app.use('/ranking', require('./routes/ranking'));
app.use('/deposits', require('./routes/deposits'));
app.use('/withdrawals', require('./routes/withdrawals'));
app.use('/referrals', require('./routes/referrals'));
app.use('/transak', require('./routes/transak'));
app.use('/notifications', require('./routes/notifications'));
app.use('/kyc', require('./routes/kyc'));
app.use('/suitability', require('./routes/suitability'));
app.use('/complaints', require('./routes/complaints'));
app.use('/lgpd', require('./routes/lgpd'));

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
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_users_asaas_customer_id ON users(asaas_customer_id) WHERE asaas_customer_id IS NOT NULL').catch(() => {});
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

  // FASE 4: coluna risk_flag para detecção de saques suspeitos
  await pool.query('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS risk_flag BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});

  // FASE 5 (BLOCO 1): KYC / AML — colunas na tabela users
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf VARCHAR(11)").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'pending'").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_approved_at TIMESTAMPTZ").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_rejected_at TIMESTAMPTZ").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_provider_id TEXT").catch(() => {});
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cpf ON users(cpf) WHERE cpf IS NOT NULL").catch(() => {});

  // FASE 5 (BLOCO 1): tabela kyc_reviews — histórico de revisões KYC
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kyc_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action VARCHAR(30) NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      provider VARCHAR(40),
      provider_id TEXT,
      provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kyc_reviews_user_id ON kyc_reviews(user_id, created_at DESC)').catch(() => {});

  // FASE 5 (BLOCO 1): tabela coaf_flags — registros de monitoramento PLD/FT
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coaf_flags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deposit_id UUID REFERENCES deposits(id) ON DELETE SET NULL,
      month_total DECIMAL(18,2) NOT NULL,
      threshold DECIMAL(18,2) NOT NULL DEFAULT 10000,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      resolution_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_coaf_flags_user_status ON coaf_flags(user_id, status)').catch(() => {});

  // FASE 5 (BLOCO 2): PEP / Sanções — colunas em users
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pep_status VARCHAR(20) DEFAULT 'not_checked'").catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pep_checked_at TIMESTAMPTZ').catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS sanctions_status VARCHAR(20) DEFAULT 'not_checked'").catch(() => {});
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sanctions_checked_at TIMESTAMPTZ').catch(() => {});

  // FASE 5 (BLOCO 2): tabela pep_reviews — histórico de triagens PEP e sanções
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pep_reviews (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      screening_type VARCHAR(20) NOT NULL CHECK (screening_type IN ('pep', 'sanctions')),
      result         VARCHAR(20) NOT NULL CHECK (result IN ('clear', 'flagged', 'sanctioned')),
      confidence     DECIMAL(5,4) NOT NULL DEFAULT 0,
      source         VARCHAR(50) NOT NULL DEFAULT 'stub',
      details        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pep_reviews_user_id ON pep_reviews(user_id, created_at DESC)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pep_reviews_type_result ON pep_reviews(screening_type, result)').catch(() => {});

  // FASE 6 (BLOCO 3): Suitability — colunas em users
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS suitability_profile VARCHAR(20)").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS suitability_score INTEGER").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS suitability_completed_at TIMESTAMPTZ").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS suitability_expires_at TIMESTAMPTZ").catch(() => {});

  // FASE 6 (BLOCO 3): tabela suitability_responses — histórico de respostas do questionário
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suitability_responses (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
      profile      VARCHAR(20) NOT NULL,
      score        INTEGER,
      overridden_by TEXT,
      expires_at   TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_suitability_user_id ON suitability_responses(user_id, completed_at DESC)').catch(() => {});

  // COMPLIANCE ADMIN: colunas de controle interno por usuário
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT 'normal'").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(100)").catch(() => {});

  // BLOCO 5: Termo de Ciência de Riscos
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_term_accepted_at TIMESTAMPTZ").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_term_version VARCHAR(10)").catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS risk_term_acceptances (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    term_version VARCHAR(10) NOT NULL DEFAULT 'v1.0',
    accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address   VARCHAR(50),
    user_agent   TEXT
  )`).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_risk_term_user ON risk_term_acceptances(user_id, accepted_at DESC)").catch(()=>{});

  // BLOCO 7: LGPD (Lei 13.709/2018)
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lgpd_consent_at TIMESTAMPTZ").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lgpd_consent_ip VARCHAR(50)").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS data_deletion_requested_at TIMESTAMPTZ").catch(()=>{});

  // BLOCO 9: Proteção ao Investidor — auto-exclusão temporária
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS self_excluded_until TIMESTAMPTZ").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS self_excluded_reason VARCHAR(100)").catch(()=>{});

  // BLOCO 8: 2FA TOTP (Google Authenticator / Authy)
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_secret VARCHAR(100)").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN NOT NULL DEFAULT FALSE").catch(()=>{});
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled_at TIMESTAMPTZ").catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lgpd_consents (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consent_type VARCHAR(30) NOT NULL,
      policy_version VARCHAR(10) NOT NULL DEFAULT 'v1.0',
      accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address   VARCHAR(50),
      user_agent   TEXT
    )
  `).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_lgpd_consents_user ON lgpd_consents(user_id, accepted_at DESC)").catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_deletion_requests (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status       VARCHAR(20) NOT NULL DEFAULT 'pending',
      ip_address   VARCHAR(50),
      notes        TEXT
    )
  `).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_data_deletion_user ON data_deletion_requests(user_id)").catch(()=>{});

  // ── A: Ouvidoria / Canal de Reclamações ──────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaints (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category     VARCHAR(50) NOT NULL,
      description  TEXT NOT NULL,
      status       VARCHAR(20) NOT NULL DEFAULT 'open',
      admin_response TEXT,
      responded_at TIMESTAMPTZ,
      responded_by TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints(user_id, created_at DESC)").catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, created_at DESC)").catch(()=>{});
  // Campos extras para sistema de tickets
  await pool.query("ALTER TABLE complaints ADD COLUMN IF NOT EXISTS internal_notes TEXT").catch(()=>{});

  // complaint_messages: thread de mensagens por ticket
  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaint_messages (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      sender_type  VARCHAR(10) NOT NULL CHECK (sender_type IN ('user','admin')),
      message      TEXT NOT NULL,
      is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_complaint_msgs ON complaint_messages(complaint_id, created_at ASC)").catch(()=>{});

  // complaint_attachments: arquivos (base64) por ticket
  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaint_attachments (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      message_id   UUID REFERENCES complaint_messages(id) ON DELETE CASCADE,
      filename     VARCHAR(255),
      data         TEXT NOT NULL,
      mime_type    VARCHAR(50),
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(()=>{});

  // ── B: Configuração de limites operacionais ──────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_config (
      key        VARCHAR(100) PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `).catch(()=>{});
  // Seed dos limites padrão — ON CONFLICT DO NOTHING para não sobrescrever o que o admin já salvou
  await pool.query(`
    INSERT INTO platform_config (key, value) VALUES
      ('limits_conservador', '{"max_bet_single":100,"max_month_total":500,"max_market_total":100}'),
      ('limits_moderado',    '{"max_bet_single":500,"max_month_total":2000,"max_market_total":500}'),
      ('limits_arrojado',    '{"max_bet_single":2000,"max_month_total":10000,"max_market_total":2000}')
    ON CONFLICT (key) DO NOTHING
  `).catch(()=>{});

  // ── C: Auditoria de ações admin ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user  TEXT NOT NULL DEFAULT 'admin',
      action      VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id   TEXT,
      details     JSONB,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(()=>{});
  await pool.query("CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC)").catch(()=>{});

  // Carrega limites do banco no cache em memória
  const configCache = require('./lib/configCache');
  await configCache.loadFromDB();

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
