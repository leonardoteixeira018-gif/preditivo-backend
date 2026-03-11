-- ================================================
-- SCHEMA PREDITIVO — rodar no Supabase SQL Editor
-- ================================================

-- USUÁRIOS
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  balance DECIMAL(18,2) DEFAULT 1000.00,
  wallet_address VARCHAR(42),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- MERCADOS
CREATE TABLE markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('politica','economia','futebol','tech')),
  description TEXT,
  ends_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  outcome BOOLEAN, -- TRUE = SIM venceu, FALSE = NÃO venceu, NULL = não resolvido
  -- LMSR state
  q_yes DECIMAL(18,8) DEFAULT 100.0,
  q_no  DECIMAL(18,8) DEFAULT 100.0,
  b     DECIMAL(18,8) DEFAULT 100.0, -- liquidez do LMSR
  volume DECIMAL(18,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- APOSTAS
CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  market_id UUID NOT NULL REFERENCES markets(id),
  side BOOLEAN NOT NULL, -- TRUE = SIM, FALSE = NÃO
  amount DECIMAL(18,2) NOT NULL,
  shares DECIMAL(18,8) NOT NULL,
  price_at_bet DECIMAL(8,6) NOT NULL, -- probabilidade no momento da aposta
  payout DECIMAL(18,2), -- preenchido quando mercado resolve
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ÍNDICES
CREATE INDEX idx_bets_user ON bets(user_id);
CREATE INDEX idx_bets_market ON bets(market_id);
CREATE INDEX idx_markets_category ON markets(category);
CREATE INDEX idx_markets_ends_at ON markets(ends_at);

-- VIEW: ranking de usuários
CREATE VIEW ranking AS
SELECT
  u.id,
  u.username,
  u.balance,
  COUNT(b.id) as total_bets,
  COALESCE(SUM(b.payout), 0) as total_payout,
  COALESCE(SUM(b.amount), 0) as total_wagered,
  COALESCE(SUM(b.payout) - SUM(b.amount), 0) as profit
FROM users u
LEFT JOIN bets b ON b.user_id = u.id AND b.payout IS NOT NULL
GROUP BY u.id, u.username, u.balance
ORDER BY profit DESC;

-- MERCADOS INICIAIS
INSERT INTO markets (title, category, ends_at, q_yes, q_no, b) VALUES
('PT vence as eleições presidenciais de 2026?', 'politica', '2026-10-31', 108.0, 92.0, 100.0),
('IPCA fecha 2025 abaixo de 4%?', 'economia', '2025-12-31', 82.0, 118.0, 100.0),
('Flamengo é campeão do Brasileirão 2025?', 'futebol', '2025-12-15', 66.0, 134.0, 100.0),
('Dólar passa dos R$6,50 antes de julho de 2025?', 'economia', '2025-07-01', 134.0, 66.0, 100.0),
('Brasil classifica para a Copa do Mundo 2026?', 'futebol', '2026-03-31', 176.0, 24.0, 100.0),
('SELIC cai abaixo de 10% em 2025?', 'economia', '2025-12-31', 36.0, 164.0, 100.0),
('Nubank lança conta em dólar até 2025?', 'tech', '2025-12-31', 58.0, 142.0, 100.0),
('PEC da reforma tributária aprovada em 2025?', 'politica', '2025-08-31', 122.0, 78.0, 100.0);
