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
  two_fa_secret VARCHAR(100),
  two_fa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  two_fa_enabled_at TIMESTAMPTZ,
  wallet_address VARCHAR(42),
  avatar_url TEXT,
  -- FASE 5 (BLOCO 1): KYC / AML
  cpf VARCHAR(11) UNIQUE,
  full_name TEXT,
  date_of_birth DATE,
  kyc_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  kyc_submitted_at TIMESTAMPTZ,
  kyc_approved_at TIMESTAMPTZ,
  kyc_rejected_at TIMESTAMPTZ,
  kyc_rejection_reason TEXT,
  kyc_provider_id TEXT,
  -- FASE 5 (BLOCO 2): PEP / Sanções
  pep_status           VARCHAR(20) DEFAULT 'not_checked',
  pep_checked_at       TIMESTAMPTZ,
  sanctions_status     VARCHAR(20) DEFAULT 'not_checked',
  sanctions_checked_at TIMESTAMPTZ,
  -- BLOCO 3: Suitability / Perfil de Investidor (CVM Sandbox)
  suitability_profile      VARCHAR(20),             -- conservador | moderado | arrojado
  suitability_score        INTEGER,
  suitability_completed_at TIMESTAMPTZ,
  suitability_expires_at   TIMESTAMPTZ,             -- expira em 12 meses
  -- BLOCO 5: Termo de Ciência de Riscos (CVM 30/2021)
  risk_term_accepted_at    TIMESTAMPTZ,
  risk_term_version        VARCHAR(10),
  -- BLOCO 7: LGPD (Lei 13.709/2018)
  lgpd_consent_at          TIMESTAMPTZ,
  lgpd_consent_ip          VARCHAR(50),
  data_deletion_requested_at TIMESTAMPTZ,
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
  risk_flag BOOLEAN NOT NULL DEFAULT FALSE,  -- FASE 4: detecção de saque rápido após depósito
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

-- ---- FASE 5 (BLOCO 1): KYC / AML ----

-- Histórico de revisões KYC por usuário
CREATE TABLE IF NOT EXISTS kyc_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(30) NOT NULL,        -- submitted | approved | rejected | document_submitted
  actor TEXT NOT NULL DEFAULT 'system', -- 'system' | 'admin:<id>' | 'bureau:<provider>'
  notes TEXT,
  provider VARCHAR(40),               -- stub | idwall | serpro
  provider_id TEXT,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kyc_reviews_user_id ON kyc_reviews(user_id, created_at DESC);

-- Flags de monitoramento PLD/FT (COAF)
-- Criados quando o usuário ultrapassa R$10.000 em depósitos no mês
CREATE TABLE IF NOT EXISTS coaf_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deposit_id UUID REFERENCES deposits(id) ON DELETE SET NULL,
  month_total DECIMAL(18,2) NOT NULL,
  threshold DECIMAL(18,2) NOT NULL DEFAULT 10000,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | dismissed | reported
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coaf_flags_user_status ON coaf_flags(user_id, status);
CREATE INDEX IF NOT EXISTS idx_coaf_flags_status ON coaf_flags(status, created_at DESC);

-- ---- FASE 5 (BLOCO 2): PEP / Sanções Internacionais ----

-- Histórico de triagens PEP (Pessoa Exposta Politicamente) e sanções internacionais
-- BACEN Circular 3.978/2020 — FATF Recommendations — OFAC SDN / ONU / UE
CREATE TABLE IF NOT EXISTS pep_reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screening_type VARCHAR(20) NOT NULL CHECK (screening_type IN ('pep', 'sanctions')),
  result         VARCHAR(20) NOT NULL CHECK (result IN ('clear', 'flagged', 'sanctioned')),
  confidence     DECIMAL(5,4) NOT NULL DEFAULT 0,  -- 0.0000 a 1.0000
  source         VARCHAR(50) NOT NULL DEFAULT 'stub', -- stub | serpro | idwall
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pep_reviews_user_id
  ON pep_reviews(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pep_reviews_type_result
  ON pep_reviews(screening_type, result);

-- ---- BLOCO 3: Suitability / Perfil de Investidor ----

-- Histórico de respostas ao questionário de suitability
-- O perfil válido é sempre o mais recente com expires_at > NOW()
CREATE TABLE IF NOT EXISTS suitability_responses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers       JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile       VARCHAR(20) NOT NULL,  -- conservador | moderado | arrojado
  score         INTEGER,               -- NULL quando sobrescrito por admin
  overridden_by TEXT,                  -- 'admin' quando sobrescrito manualmente
  expires_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suitability_user_id
  ON suitability_responses(user_id, completed_at DESC);

-- ---- BLOCO 5: Termo de Ciência de Riscos (CVM 30/2021) ----

-- Histórico de aceites do Termo de Ciência de Riscos
CREATE TABLE IF NOT EXISTS risk_term_acceptances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_version VARCHAR(10) NOT NULL DEFAULT 'v1.0',
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   VARCHAR(50),
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_term_user
  ON risk_term_acceptances(user_id, accepted_at DESC);

-- ---- BLOCO 7: LGPD (Lei 13.709/2018) ----

-- Histórico de consentimentos LGPD por usuário
CREATE TABLE IF NOT EXISTS lgpd_consents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type VARCHAR(30) NOT NULL, -- 'registration' | 'updated_policy'
  policy_version VARCHAR(10) NOT NULL DEFAULT 'v1.0',
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   VARCHAR(50),
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_lgpd_consents_user ON lgpd_consents(user_id, accepted_at DESC);

-- Solicitações de exclusão de dados (direito ao esquecimento — Art. 18 VI LGPD)
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | completed | rejected
  ip_address   VARCHAR(50),
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_data_deletion_user ON data_deletion_requests(user_id);
