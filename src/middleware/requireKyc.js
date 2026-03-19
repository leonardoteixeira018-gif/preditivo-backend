/**
 * requireKyc.js — Middleware de verificação KYC
 *
 * Bloqueia operações financeiras se o usuário não tiver KYC aprovado.
 * Deve ser aplicado APÓS o middleware `auth` (que popula req.user).
 *
 * Resposta quando bloqueado:
 * 403 { error: 'KYC_REQUIRED', message: '...', kyc_status: '...' }
 */
const pool = require('../lib/db');
const logger = require('../lib/logger');

module.exports = async function requireKyc(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const result = await pool.query(
      'SELECT kyc_status FROM users WHERE id = $1',
      [userId]
    );

    const status = result.rows[0]?.kyc_status || 'pending';

    if (status === 'approved') {
      return next();
    }

    logger.warn('Operação bloqueada por KYC não aprovado', {
      userId,
      kycStatus: status,
      path: req.path,
      method: req.method,
      ip: req.ip
    });

    const messages = {
      pending:   'É necessário verificar sua identidade antes de operar. Acesse Meu Perfil > Verificação.',
      submitted: 'Seus documentos estão em análise. Em breve você receberá uma confirmação por e-mail.',
      rejected:  'Sua verificação de identidade foi rejeitada. Acesse Meu Perfil > Verificação para reenviar.',
    };

    return res.status(403).json({
      error: 'KYC_REQUIRED',
      kyc_status: status,
      message: messages[status] || messages.pending
    });
  } catch (err) {
    logger.error('requireKyc middleware error', { error: err.message });
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
};
