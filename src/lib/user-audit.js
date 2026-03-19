const logger = require('./logger');
const pool = require('./db');

/**
 * Registra ações de usuário em logs + DB para compliance
 * @param {Object} options
 * @param {string} options.userId - ID do usuário
 * @param {string} options.action - Tipo de ação (bet_placed, withdrawal_initiated, etc)
 * @param {string} options.resourceType - Tipo de recurso (bet, withdrawal, market, etc)
 * @param {string} options.resourceId - ID do recurso afetado
 * @param {Object} options.details - Dados adicionais
 * @param {string} options.ipAddress - IP do usuário
 */
async function logUserAction({
  userId,
  action,
  resourceType,
  resourceId,
  details,
  ipAddress
}) {
  try {
    // Log estruturado em Winston
    logger.info('User action', {
      userId,
      action,
      resourceType,
      resourceId,
      details,
      ip: ipAddress
    });

    // Também gravar em DB para compliance + auditoria
    // Nota: Não bloqueia a operação se falhar
    pool.query(`
      INSERT INTO user_audit_logs (user_id, action, resource_type, resource_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      userId,
      action,
      resourceType,
      resourceId,
      details ? JSON.stringify(details) : null,
      ipAddress || null
    ]).catch(err => {
      logger.warn('Failed to log user action to DB', {
        userId,
        action,
        error: err.message
      });
    });
  } catch (err) {
    logger.error('Error logging user action', {
      userId,
      action,
      error: err.message
    });
  }
}

/**
 * Recupera logs de auditoria do usuário
 */
async function getUserAuditLogs(userId, limit = 100) {
  try {
    const result = await pool.query(`
      SELECT id, action, resource_type, resource_id, details, ip_address, timestamp
      FROM user_audit_logs
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [userId, limit]);

    return result.rows;
  } catch (err) {
    logger.error('Error retrieving user audit logs', {
      userId,
      error: err.message
    });
    return [];
  }
}

module.exports = {
  logUserAction,
  getUserAuditLogs
};
