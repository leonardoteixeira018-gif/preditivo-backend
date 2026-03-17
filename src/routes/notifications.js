const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

// GET /notifications/my — notificações do usuário autenticado
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, title, body, is_read, meta, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    const notifications = result.rows;
    const unread_count = notifications.filter(n => !n.is_read).length;
    res.json({ unread_count, notifications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /notifications/read-all — marcar todas como lidas
router.patch('/read-all', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
