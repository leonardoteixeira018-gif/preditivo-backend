/**
 * adminAudit.js — Registra ações administrativas no banco para rastreabilidade.
 * CVM Sandbox exige audit trail de todas as decisões de compliance e operações.
 * Não-fatal: falha no log não interrompe a ação do admin.
 */
const pool = require('./db');
const logger = require('./logger');

/**
 * Registra uma ação administrativa.
 * @param {string} adminUser  — identificador do admin (ex: 'admin', email)
 * @param {string} action     — ação realizada (ex: 'resolve_market', 'kyc_approve')
 * @param {string} entityType — tipo da entidade afetada (ex: 'market', 'user')
 * @param {string} entityId   — ID da entidade afetada
 * @param {object} details    — detalhes adicionais (antes/depois, motivo, etc.)
 * @param {string} ip         — IP do admin
 */
async function logAdminAction(adminUser, action, entityType, entityId, details, ip) {
  try {
    await pool.query(`
      INSERT INTO admin_audit_logs (admin_user, action, entity_type, entity_id, details, ip)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      adminUser || 'admin',
      action,
      entityType || null,
      entityId ? String(entityId) : null,
      JSON.stringify(details || {}),
      ip || null,
    ]);
  } catch (err) {
    // Não-fatal: tabela pode não existir ainda (startup)
    logger.error('[adminAudit] Erro ao registrar ação admin', { action, error: err.message });
  }
}

module.exports = { logAdminAction };
