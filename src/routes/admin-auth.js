const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { getAuditLogs } = require('../lib/audit');

/**
 * POST /admin/login
 * Autentica admin e retorna JWT válido por 1 hora
 */
router.post('/login', async (req, res) => {
  const { secret } = req.body;

  if (!secret) {
    return res.status(400).json({ error: 'Secret é obrigatório' });
  }

  const expectedSecret = process.env.ADMIN_SECRET;

  if (!expectedSecret) {
    console.error('[SECURITY] ADMIN_SECRET não configurado no .env');
    return res.status(500).json({ error: 'Erro de configuração do servidor' });
  }

  try {
    // Comparação segura contra timing attacks
    const valid = crypto.timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(expectedSecret)
    );

    if (!valid) {
      console.warn(`[SECURITY] Invalid admin login attempt from ${req.ip}`);
      return res.status(403).json({ error: 'Secret inválida' });
    }
  } catch (err) {
    // Tamanhos diferentes
    console.warn(`[SECURITY] Admin secret length mismatch from ${req.ip}`);
    return res.status(403).json({ error: 'Secret inválida' });
  }

  try {
    // Gerar JWT admin (válido por 1 hora)
    const token = jwt.sign(
      { type: 'admin', issuedAt: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log(`[AUDIT] Admin login successful from ${req.ip}`);

    res.json({
      ok: true,
      token,
      expiresIn: 3600,
      message: 'Login bem-sucedido. Token válido por 1 hora.'
    });
  } catch (err) {
    console.error('[ERROR] Erro ao gerar admin token:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar token' });
  }
});

/**
 * POST /admin/logout
 * Realiza logout (token é invalidado automaticamente no cliente)
 */
router.post('/logout', (req, res) => {
  console.log(`[AUDIT] Admin logout from ${req.ip}`);
  res.json({ ok: true, message: 'Logout realizado com sucesso' });
});

/**
 * GET /admin/audit-logs
 * Recupera logs de auditoria com filtros opcionais
 */
router.get('/audit-logs', adminAuth, async (req, res) => {
  try {
    const filters = {};

    if (req.query.action) filters.action = req.query.action;
    if (req.query.resourceType) filters.resourceType = req.query.resourceType;
    if (req.query.resourceId) filters.resourceId = req.query.resourceId;
    if (req.query.adminId) filters.adminId = req.query.adminId;

    if (req.query.fromDate) {
      filters.fromDate = new Date(req.query.fromDate);
      if (isNaN(filters.fromDate.getTime())) {
        return res.status(400).json({ error: 'fromDate inválida' });
      }
    }

    if (req.query.toDate) {
      filters.toDate = new Date(req.query.toDate);
      if (isNaN(filters.toDate.getTime())) {
        return res.status(400).json({ error: 'toDate inválida' });
      }
    }

    const logs = await getAuditLogs(filters);
    res.json({ ok: true, logs, count: logs.length });
  } catch (err) {
    console.error('[ERROR] Erro ao recuperar audit logs:', err.message);
    res.status(500).json({ error: 'Erro ao recuperar logs' });
  }
});

module.exports = router;
