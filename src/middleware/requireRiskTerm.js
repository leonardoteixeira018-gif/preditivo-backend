const pool = require('../lib/db');
const logger = require('../lib/logger');

const CURRENT_TERM_VERSION = 'v1.0';

module.exports = async function requireRiskTerm(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Não autenticado' });

    const result = await pool.query(
      'SELECT risk_term_accepted_at, risk_term_version FROM users WHERE id = $1',
      [userId]
    );
    const row = result.rows[0];
    if (row?.risk_term_accepted_at && row?.risk_term_version === CURRENT_TERM_VERSION) {
      return next();
    }
    logger.warn('Operação bloqueada: termo de riscos não aceito', { userId, path: req.path });
    return res.status(403).json({
      error: 'RISK_TERM_REQUIRED',
      message: 'Você precisa aceitar o Termo de Ciência de Riscos antes de operar.',
      term_version: CURRENT_TERM_VERSION,
    });
  } catch (err) {
    logger.error('requireRiskTerm error', { error: err.message });
    return res.status(500).json({ error: 'Erro interno' });
  }
};
