/**
 * serpro-auth.js — Gerenciamento de token OAuth2 do Serpro
 *
 * Serpro usa client_credentials (Basic Auth no token endpoint).
 * O token é cacheado em memória e renovado automaticamente 60s antes de expirar.
 *
 * Variáveis de ambiente:
 *   SERPRO_CLIENT_ID     — Consumer Key do portal developers.serpro.gov.br
 *   SERPRO_CLIENT_SECRET — Consumer Secret
 *   SERPRO_ENV           — 'trial' (padrão) | 'production'
 *
 * Endpoints:
 *   Trial:      https://sandbox.apigateway.serpro.gov.br
 *   Produção:   https://apigateway.serpro.gov.br
 */

const logger = require('./logger');

// ── Cache de token ─────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiresAt = 0;

const SERPRO_BASE = {
  trial:      'https://sandbox.apigateway.serpro.gov.br',
  production: 'https://apigateway.serpro.gov.br',
};

function getBaseUrl() {
  const env = process.env.SERPRO_ENV || 'trial';
  return SERPRO_BASE[env] || SERPRO_BASE.trial;
}

/**
 * Obtém um access_token válido do Serpro.
 * Reutiliza token cacheado se ainda válido (com 60s de margem).
 */
async function getSerproToken() {
  const now = Date.now();

  // Reutilizar token se ainda válido
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return _cachedToken;
  }

  const clientId     = process.env.SERPRO_CLIENT_ID;
  const clientSecret = process.env.SERPRO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SERPRO_CLIENT_ID e SERPRO_CLIENT_SECRET são obrigatórios. Configure no .env ou Railway.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenUrl    = `${getBaseUrl()}/token`;

  logger.info('[SERPRO-AUTH] Solicitando novo token', { env: process.env.SERPRO_ENV || 'trial' });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization':  `Basic ${credentials}`,
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error('[SERPRO-AUTH] Falha ao obter token', { status: res.status, body });
    throw new Error(`Serpro auth error ${res.status}: ${body}`);
  }

  const data = await res.json();
  _cachedToken     = data.access_token;
  _tokenExpiresAt  = now + (parseInt(data.expires_in || 3600) * 1000);

  logger.info('[SERPRO-AUTH] Token obtido com sucesso', {
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  });

  return _cachedToken;
}

module.exports = { getSerproToken, getBaseUrl };
