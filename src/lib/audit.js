const pool = require('./db');

/**
 * Registra ação de admin em audit_logs para rastreamento
 * @param {Object} options
 * @param {string} options.action - Tipo de ação (ex: 'deposit_confirmed', 'market_resolved')
 * @param {string} options.resourceType - Tipo de recurso (ex: 'deposit', 'market', 'user')
 * @param {string} options.resourceId - ID do recurso afetado
 * @param {string} options.adminId - ID do admin que fez a ação (opcional)
 * @param {string} options.ipAddress - IP do admin
 * @param {Object} options.details - Dados adicionais em JSON
 */
async function logAudit({
  action,
  resourceType,
  resourceId,
  adminId,
  ipAddress,
  details
}) {
  try {
    await pool.query(`
      INSERT INTO audit_logs (action, resource_type, resource_id, admin_id, ip_address, details, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      action,
      resourceType,
      resourceId,
      adminId || null,
      ipAddress || null,
      details ? JSON.stringify(details) : null
    ]);
  } catch (err) {
    console.error('[AUDIT] Erro ao registrar auditoria:', err.message);
    // Não rejeitar a operação se auditoria falhar
  }
}

/**
 * Recupera logs de auditoria com filtros
 */
async function getAuditLogs(filters = {}) {
  try {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (filters.action) {
      query += ` AND action = $${paramCount++}`;
      params.push(filters.action);
    }

    if (filters.resourceType) {
      query += ` AND resource_type = $${paramCount++}`;
      params.push(filters.resourceType);
    }

    if (filters.resourceId) {
      query += ` AND resource_id = $${paramCount++}`;
      params.push(filters.resourceId);
    }

    if (filters.adminId) {
      query += ` AND admin_id = $${paramCount++}`;
      params.push(filters.adminId);
    }

    if (filters.fromDate) {
      query += ` AND timestamp >= $${paramCount++}`;
      params.push(filters.fromDate);
    }

    if (filters.toDate) {
      query += ` AND timestamp <= $${paramCount++}`;
      params.push(filters.toDate);
    }

    query += ' ORDER BY timestamp DESC LIMIT 1000';

    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('[AUDIT] Erro ao recuperar logs:', err.message);
    return [];
  }
}

module.exports = {
  logAudit,
  getAuditLogs
};
