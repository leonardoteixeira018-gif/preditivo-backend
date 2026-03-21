const router = require('express').Router();
const pool = require('../lib/db');
const logger = require('../lib/logger');
const auth = require('../middleware/auth');

// ── POST /lgpd/request-deletion — solicitar exclusão de dados ────────────────
// LGPD Art. 17 — direito à eliminação dos dados pessoais
router.post('/request-deletion', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Verifica se já existe solicitação pendente
    const existing = await pool.query(
      `SELECT id FROM data_deletion_requests WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    if (existing.rows.length) {
      return res.status(409).json({
        error: 'Já existe uma solicitação de exclusão pendente para sua conta.',
        request_id: existing.rows[0].id
      });
    }

    // Cria a solicitação
    const result = await pool.query(
      `INSERT INTO data_deletion_requests (user_id, status, ip_address, notes)
       VALUES ($1, 'pending', $2, $3)
       RETURNING id, status, requested_at`,
      [userId, req.ip, req.body.reason || null]
    );

    // Marca na tabela de usuários também
    await pool.query(
      `UPDATE users SET data_deletion_requested_at = NOW() WHERE id = $1`,
      [userId]
    );

    logger.info('LGPD deletion request created', { user_id: userId, request_id: result.rows[0].id });

    res.status(201).json({
      ok: true,
      message: 'Solicitação registrada. Seu pedido será analisado em até 15 dias úteis conforme a LGPD (Art. 18).',
      request: result.rows[0]
    });
  } catch (err) {
    logger.error('LGPD deletion request error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /lgpd/deletion-status — status da solicitação ────────────────────────
router.get('/deletion-status', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, requested_at, notes
       FROM data_deletion_requests
       WHERE user_id = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.json({ has_request: false });
    }

    res.json({ has_request: true, request: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /lgpd/my-data — portabilidade: exporta os dados do usuário ─────────
// LGPD Art. 18 — direito à portabilidade
router.get('/my-data', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, deposits, withdrawals, bets, kyc, suitability] = await Promise.all([
      pool.query(
        `SELECT id, username, email, full_name, date_of_birth, kyc_status,
                suitability_profile, created_at, lgpd_consent_at, risk_term_accepted_at
         FROM users WHERE id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT id, amount, status, method, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT id, amount, status, pix_key_type, created_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT b.id, m.title AS market, b.side, b.amount, b.status, b.created_at
         FROM bets b JOIN markets m ON m.id = b.market_id
         WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT action, created_at, notes FROM kyc_reviews WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT profile, score, completed_at, expires_at FROM suitability_responses WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 1`,
        [userId]
      )
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      user: user.rows[0],
      deposits: deposits.rows,
      withdrawals: withdrawals.rows,
      bets: bets.rows,
      kyc_history: kyc.rows,
      suitability: suitability.rows[0] || null
    });
  } catch (err) {
    logger.error('LGPD data export error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
