CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  bonus_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  bonus_locked DECIMAL(18,2) NOT NULL DEFAULT 0,
  bonus_bets_count INTEGER NOT NULL DEFAULT 0,
  first_deposit_done BOOLEAN NOT NULL DEFAULT FALSE,
  referral_code VARCHAR(20) UNIQUE,
  referred_by UUID REFERENCES users(id),
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  rank_total_bets INTEGER,
  rank_profit DECIMAL(18,2),
  rank_win_rate DECIMAL(5,2),
  email_verified_at TIMESTAMPTZ,
  wallet_address VARCHAR(42),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'politica',
  description TEXT,
  ends_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_outcome VARCHAR(3) CHECK (resolved_outcome IN ('yes', 'no')),
  q_yes DECIMAL(18,8) NOT NULL DEFAULT 100,
  q_no DECIMAL(18,8) NOT NULL DEFAULT 100,
  b DECIMAL(18,8) NOT NULL DEFAULT 100,
  volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side VARCHAR(3) NOT NULL CHECK (side IN ('yes', 'no')),
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  potential_payout DECIMAL(18,2) NOT NULL,
  payout DECIMAL(18,2),
  taxa DECIMAL(18,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_history (
  id BIGSERIAL PRIMARY KEY,
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  prob_yes DECIMAL(8,2) NOT NULL,
  prob_no DECIMAL(8,2) NOT NULL,
  volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  code TEXT,
  method VARCHAR(20) NOT NULL DEFAULT 'pix',
  transak_order_id TEXT UNIQUE,
  provider_reference TEXT UNIQUE,
  provider_status TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  pix_key TEXT NOT NULL,
  pix_key_type VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_bonuses (
  id BIGSERIAL PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  referrer_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  referred_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
CREATE INDEX IF NOT EXISTS idx_markets_ends_at ON markets(ends_at);
CREATE INDEX IF NOT EXISTS idx_market_history_market_id ON market_history(market_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_bonuses_referrer_id ON referral_bonuses(referrer_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_lookup ON email_verifications(purpose, email, consumed_at, expires_at);

CREATE OR REPLACE VIEW ranking AS
SELECT
  u.id,
  u.username,
  u.balance,
  COUNT(b.id) AS total_bets,
  COALESCE(SUM(b.payout), 0) AS total_payout,
  COALESCE(SUM(b.amount), 0) AS total_wagered,
  COALESCE(SUM(b.payout) - SUM(b.amount), 0) AS profit
FROM users u
LEFT JOIN bets b ON b.user_id = u.id
GROUP BY u.id, u.username, u.balance
ORDER BY profit DESC, u.created_at ASC;


-- ---- Comentários em mercados ----
CREATE TABLE IF NOT EXISTS market_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_market_comments_market_id ON market_comments(market_id, created_at DESC);

-- ---- Auditoria de ações admin ----
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID,
  admin_id UUID,
  ip_address VARCHAR(50),
  details JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para queries rápidas de auditoria admin
CREATE INDEX IF NOT EXISTS idx_audit_action_timestamp ON audit_logs(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_admin_timestamp ON audit_logs(admin_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);

-- ---- Auditoria de ações de usuário ----
CREATE TABLE IF NOT EXISTS user_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  details JSONB,
  ip_address VARCHAR(50),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para queries rápidas de auditoria de usuário
CREATE INDEX IF NOT EXISTS idx_user_audit_user_id ON user_audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_audit_action ON user_audit_logs(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_audit_timestamp ON user_audit_logs(timestamp DESC);
