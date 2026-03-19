/**
 * requireSuitability.js — Middleware de verificação de Suitability
 *
 * Bloqueia operações financeiras se o usuário não tiver perfil de investidor ativo e válido.
 * Aplica-se a TODOS os usuários — novos e existentes.
 *
 * Deve ser aplicado APÓS os middlewares `auth` e `requireKyc`.
 *
 * Resposta quando bloqueado:
 *   403 { error: 'SUITABILITY_REQUIRED', message: '...', suitability_status: '...' }
 *
 * Status possíveis:
 *   'pending'  — nunca respondeu
 *   'expired'  — respondeu mas venceu (12 meses)
 */
const pool = require('../lib/db');
const logger = require('../lib/logger');

module.exports = async function requireSuitability(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const result = await pool.query(
      'SELECT suitability_profile, suitability_expires_at, kyc_status FROM users WHERE id = $1',
      [userId]
    );

    const row = result.rows[0];

    // Defense in depth: bloquear também se KYC não aprovado
    if (row?.kyc_status !== 'approved') {
      logger.warn('Operação bloqueada por requireSuitability: KYC não aprovado', {
        userId,
        kycStatus: row?.kyc_status || null,
        path: req.path,
        method: req.method,
        ip: req.ip
      });
      return res.status(403).json({
        error: 'KYC_REQUIRED',
        message: 'Verificação de identidade necessária para operar.'
      });
    }

    const profile   = row?.suitability_profile;
    const expiresAt = row?.suitability_expires_at ? new Date(row.suitability_expires_at) : null;
    const now       = new Date();

    // Perfil ativo e dentro da validade
    if (profile && expiresAt && expiresAt > now) {
      return next();
    }

    const status = !profile ? 'pending' : 'expired';

    logger.warn('Operação bloqueada: suitability não completado ou expirado', {
      userId,
      suitabilityStatus: status,
      profile: profile || null,
      expiresAt: expiresAt?.toISOString() || null,
      path: req.path,
      method: req.method,
      ip: req.ip
    });

    const messages = {
      pending: 'É necessário responder o questionário de perfil de investidor antes de operar. Acesse Meu Perfil > Perfil de Investidor.',
      expired: 'Seu perfil de investidor expirou. Responda novamente o questionário para continuar operando. Acesse Meu Perfil > Perfil de Investidor.',
    };

    return res.status(403).json({
      error: 'SUITABILITY_REQUIRED',
      suitability_status: status,
      message: messages[status]
    });

  } catch (err) {
    logger.error('requireSuitability middleware error', { error: err.message });
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
};
