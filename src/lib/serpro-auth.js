/**
 * serpro-auth.js — Gerenciamento de token OAuth2 do Serpro
 *
 * Serpro usa client_credentials (Basic Auth no token endpoint).
 * O token é cacheado em memória e renovado automaticamente 60s antes de expirar.
 *
 * Variáveis de ambiente:
 *   SERPRO_CLIENT_ID     — Consumer Key da Área do Cliente (cliente.serpro.gov.br)
 *   SERPRO_CLIENT_SECRET — Consumer Secret
 *   SERPRO_ENV           — 'production' (único ambiente disponível na nova gateway)
 *
 * Endpoints (nova gateway — migrada em 2024):
 *   Token:  https://gateway.apiserpro.serpro.gov.br/tokenServer
 *   CPF:    https://gateway.apiserpro.serpro.gov.br/consulta-cpf/v1/cpf/{ni}
 *   PEP:    https://gateway.apiserpro.serpro.gov.br/consulta-pep/v1/pep/{ni}
 */

const logger = require('./logger');

// ── Cache de token ─────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiresAt = 0;

// Nova gateway unificada do Serpro (migrada em 2024 — não há mais sandbox separado)
const SERPRO_GATEWAY = 'https://gateway.apiserpro.serpro.gov.br';

function getBaseUrl() {
  return SERPRO_GATEWAY;
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
  const tokenUrl    = `${getBaseUrl()}/tokenServer`;

  logger.info('[SERPRO-AUTH] Solicitando novo token', { gateway: SERPRO_GATEWAY });

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
