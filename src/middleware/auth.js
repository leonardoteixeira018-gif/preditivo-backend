const jwt = require('jsonwebtoken');
const pool = require('../lib/db');

// Cache local de tokens na blacklist — evita query no banco a cada request autenticado
// TTL: 5 minutos. Tokens válidos não estão no cache (só os revogados).
const _blacklistCache = new Map();
const BLACKLIST_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function isTokenBlacklisted(token) {
  if (_blacklistCache.has(token)) {
    return _blacklistCache.get(token);
  }
  const result = await pool.query(
    'SELECT 1 FROM blacklisted_tokens WHERE token = $1 LIMIT 1',
    [token]
  );
  const blocked = result.rows.length > 0;
  // Só armazena no cache se estiver bloqueado (tokens válidos entram/saem com frequência)
  if (blocked) {
    _blacklistCache.set(token, true);
    setTimeout(() => _blacklistCache.delete(token), BLACKLIST_CACHE_TTL);
  }
  return blocked;
}

module.exports = async (req, res, next) => {
  const bearerToken = req.headers.authorization?.split(' ')[1];
  const cookieToken = req.cookies?.auth_token;
  // Prioridade: Bearer token (header) > cookie — o frontend sempre envia o Bearer token
  // O cookie é fallback para contextos onde o header não pode ser enviado
  const token = bearerToken || cookieToken;
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: 'Token expired (logged out)' });
    }
    req.authToken = token;
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
