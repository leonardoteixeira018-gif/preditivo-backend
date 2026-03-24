const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const webpush = require('web-push');

// Configurar VAPID apenas se as chaves estiverem definidas
let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    let subject = process.env.VAPID_MAILTO || 'mailto:suporte@futoro.com.br';
    // Garante prefixo mailto: caso o env venha sem ele
    if (!subject.startsWith('mailto:') && !subject.startsWith('https:')) {
      subject = 'mailto:' + subject;
    }
    webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  } catch (err) {
    console.error('web-push VAPID config error (push notifications desativadas):', err.message);
  }
}

// GET /notifications/vapid-public-key — retorna a chave pública VAPID para o frontend
router.get('/vapid-public-key', (req, res) => {
  if (!vapidConfigured || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications não configuradas' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /notifications/push-subscribe — registrar subscription de push
router.post('/push-subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'subscription inválida' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription)
       VALUES ($1, $2)
       ON CONFLICT (user_id, (subscription->>'endpoint')) DO NOTHING`,
      [req.user.id, JSON.stringify(subscription)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /notifications/push-unsubscribe — remover subscription
router.post('/push-unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatório' });
    await pool.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND subscription->>'endpoint' = $2`,
      [req.user.id, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Helper — enviar push para um usuário (exportado para uso em admin.js)
async function sendPushToUser(userId, title, body, url = '/') {
  if (!vapidConfigured) return;
  try {
    const subs = await pool.query(
      'SELECT id, subscription FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const expired = [];
    await Promise.allSettled(subs.rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, url }));
      } catch (err) {
        // 410 Gone = subscription expirada, remover
        if (err.statusCode === 410 || err.statusCode === 404) {
          expired.push(row.id);
        }
      }
    }));
    if (expired.length > 0) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [expired]);
    }
  } catch (err) {
    console.error('sendPushToUser error:', err.message);
  }
}

module.exports.sendPushToUser = sendPushToUser;
