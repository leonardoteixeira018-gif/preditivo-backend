const router = require('express').Router();
const pool = require('../lib/db');
const logger = require('../lib/logger');
const auth = require('../middleware/auth');

const CATEGORIES = ['resolucao_mercado', 'kyc_bloqueio', 'saque_bloqueado', 'suitability', 'privacidade', 'outro'];
const MAX_DESCRIPTION = 2000;
const MAX_MESSAGE = 1000;

// ── POST /complaints — abre reclamação ───────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { category, description } = req.body;

    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'Categoria inválida',
        valid_categories: CATEGORIES
      });
    }

    if (!description || description.trim().length < 10) {
      return res.status(400).json({ error: 'Descrição muito curta (mínimo 10 caracteres)' });
    }

    if (description.length > MAX_DESCRIPTION) {
      return res.status(400).json({ error: `Descrição muito longa (máximo ${MAX_DESCRIPTION} caracteres)` });
    }

    const result = await pool.query(
      `INSERT INTO complaints (user_id, category, description, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING id, category, description, status, created_at`,
      [req.user.id, category, description.trim()]
    );

    const complaint = result.rows[0];

    // Primeira mensagem = própria descrição
    await pool.query(
      `INSERT INTO complaint_messages (complaint_id, sender_type, message)
       VALUES ($1, 'user', $2)`,
      [complaint.id, description.trim()]
    );

    logger.info('Complaint created', { complaint_id: complaint.id, user_id: req.user.id, category });

    res.status(201).json({ ok: true, complaint });
  } catch (err) {
    logger.error('Create complaint error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /complaints/my — lista reclamações do usuário ────────────────────────
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, category, description, status, admin_response, responded_at, created_at
       FROM complaints
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    // Busca mensagens de cada reclamação
    const complaints = await Promise.all(result.rows.map(async (c) => {
      const msgs = await pool.query(
        `SELECT id, sender_type, message, created_at
         FROM complaint_messages
         WHERE complaint_id = $1 AND is_internal = FALSE
         ORDER BY created_at ASC`,
        [c.id]
      );
      return { ...c, messages: msgs.rows, attachments: [] };
    }));

    res.json({ complaints });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /complaints/:id — detalhe + mensagens ────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const complaintResult = await pool.query(
      `SELECT * FROM complaints WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!complaintResult.rows.length) {
      return res.status(404).json({ error: 'Reclamação não encontrada' });
    }

    const messages = await pool.query(
      `SELECT id, sender_type, message, is_internal, created_at
       FROM complaint_messages
       WHERE complaint_id = $1 AND is_internal = FALSE
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({
      complaint: complaintResult.rows[0],
      messages: messages.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /complaints/:id/messages — usuário adiciona mensagem ────────────────
router.post('/:id/messages', auth, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim().length < 2) {
      return res.status(400).json({ error: 'Mensagem muito curta' });
    }
    if (message.length > MAX_MESSAGE) {
      return res.status(400).json({ error: `Mensagem muito longa (máximo ${MAX_MESSAGE} caracteres)` });
    }

    const complaintResult = await pool.query(
      `SELECT id, status FROM complaints WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!complaintResult.rows.length) {
      return res.status(404).json({ error: 'Reclamação não encontrada' });
    }
    if (complaintResult.rows[0].status === 'closed') {
      return res.status(400).json({ error: 'Reclamação encerrada — abra uma nova se necessário' });
    }

    const result = await pool.query(
      `INSERT INTO complaint_messages (complaint_id, sender_type, message)
       VALUES ($1, 'user', $2)
       RETURNING id, sender_type, message, created_at`,
      [req.params.id, message.trim()]
    );

    res.status(201).json({ ok: true, message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
