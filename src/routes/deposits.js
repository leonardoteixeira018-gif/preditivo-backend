const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const pool = require('../lib/db');
const logger = require('../lib/logger');
const auth = require('../middleware/auth');
const { createCheckoutLink } = require('../lib/infinitepay');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de webhooks excedido' }
});

// A InfinitePay pode usar tanto token na URL quanto HMAC signature no header.
// Configure INFINITEPAY_WEBHOOK_TOKEN e INFINITEPAY_WEBHOOK_SECRET no Railway.
// A URL registrada na InfinitePay deve ser: /deposits/infinitepay/webhook/:token

/**
 * Valida token do webhook (segurança via URL)
 */
function verifyWebhookToken(token) {
  const expected = process.env.INFINITEPAY_WEBHOOK_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] INFINITEPAY_WEBHOOK_TOKEN não configurada em produção — rejeitando webhook');
      return false;
    }
    console.warn('[WEBHOOK] INFINITEPAY_WEBHOOK_TOKEN ausente — validação ignorada (apenas dev)');
    return true;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(token || ''), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Valida assinatura HMAC do webhook (segurança via payload)
 * InfinitePay envia X-Signature ou X-Webhook-Signature header com HMAC-SHA256 do payload
 */
function validateInfinitePaySignature(req) {
  // Tentar encontrar header de signature (case-insensitive)
  const signature =
    req.headers['x-infinitepay-signature'] ||
    req.headers['x-signature'] ||
    req.headers['x-webhook-signature'] ||
    req.headers['signature'];

  const secret = process.env.INFINITEPAY_WEBHOOK_SECRET;

  // Se não estiver configurado, loggar warning mas não rejeitar (compatibilidade)
  if (!signature || !secret) {
    console.warn('[WEBHOOK] Webhook signature validation não configurada (header ou secret ausente)');
    return true;
  }

  try {
    // Raw body como string (não parsed)
    const rawBody = JSON.stringify(req.body || {});

    // Calcular HMAC esperado (SHA256)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    // Comparação segura contra timing attacks
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!valid) {
      console.warn(`[SECURITY] Webhook com assinatura inválida rejeitado — IP: ${req.ip}`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[SECURITY] Erro ao validar webhook signature: ${err.message}`);
    return false;
  }
}

const REFERRAL_MIN_DEPOSIT = 100;
const REFERRER_BONUS = 50;
const REFERRED_BONUS = 20;
const MIN_DEPOSIT = 10;

function normalizeDepositStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['paid', 'approved', 'completed', 'confirmed', 'succeeded', 'success'].includes(value)) {
    return 'confirmed';
  }
  if (['cancelled', 'canceled', 'expired', 'failed', 'refused'].includes(value)) {
    return 'failed';
  }
  return 'pending';
}

function extractInfinitePayWebhook(body) {
  return {
    status: normalizeDepositStatus(
      body.status ||
      body.payment_status ||
      body.event ||
      body.type
    ),
    orderNsu:
      body.order_nsu ||
      body.orderNsu ||
      body.metadata?.order_nsu ||
      body.metadata?.orderNsu ||
      body.reference ||
      body.external_reference ||
      body.externalReference ||
      null,
    raw: body
  };
}

router.post('/infinitepay/webhook/:token', webhookLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    logger.info('Webhook received from InfinitePay', {
      ip: req.ip,
      tokenPrefix: req.params.token.substring(0, 10) + '***'
    });

    // Validar token na URL PRIMEIRO
    if (!verifyWebhookToken(req.params.token)) {
      logger.warn('Webhook rejected - invalid token', { ip: req.ip });
      return res.status(401).json({ error: 'Token inválido' });
    }

    // Validar assinatura HMAC do payload SEGUNDO
    if (!validateInfinitePaySignature(req)) {
      logger.warn('Webhook rejected - invalid signature', { ip: req.ip });
      return res.status(401).json({ error: 'Assinatura inválida' });
    }

    const event = extractInfinitePayWebhook(req.body || {});
    if (!event.orderNsu) {
      logger.warn('Webhook rejected - missing order_nsu', { ip: req.ip });
      return res.status(400).json({ error: 'order_nsu ausente' });
    }

    logger.info('Webhook validation passed', {
      orderNsu: event.orderNsu,
      status: event.status
    });

    await client.query('BEGIN');

    const depositResult = await client.query(
      `SELECT *
       FROM deposits
       WHERE code = $1 OR provider_reference = $1
       FOR UPDATE`,
      [event.orderNsu]
    );

    if (!depositResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deposito nao encontrado' });
    }

    const deposit = depositResult.rows[0];
    if (deposit.status === 'confirmed') {
      await client.query('ROLLBACK');
      return res.json({ ok: true, message: 'Deposito ja processado' });
    }

    if (event.status !== 'confirmed') {
      await client.query(
        `UPDATE deposits
         SET status = $1
         WHERE id = $2`,
        [event.status, deposit.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, message: `Status ${event.status} registrado` });
    }

    await client.query(
      `UPDATE deposits
       SET status = 'confirmed'
       WHERE id = $1`,
      [deposit.id]
    );

    await client.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2',
      [deposit.amount, deposit.user_id]
    );

    await processReferralBonus(deposit.user_id, deposit.amount, client);
    await client.query('COMMIT');

    const userInfo = await client.query('SELECT email, username FROM users WHERE id = $1', [deposit.user_id]);
    if (userInfo.rows.length) {
      const { sendEmail } = require('../lib/email');
      const { APP_BRAND } = require('../lib/appConfig');
      await sendEmail(
        userInfo.rows[0].email,
        `Deposito confirmado — ${APP_BRAND}`,
        `<h1>Ola, ${userInfo.rows[0].username}!</h1>
         <p>Seu deposito de <strong>R$${parseFloat(deposit.amount).toFixed(2)}</strong> foi confirmado e o saldo ja esta disponivel na sua conta.</p>
         <p>Boa sorte nas suas previsoes!</p>`
      );
    }

    res.json({ ok: true, message: 'Deposito confirmado' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { amount, code, method } = req.body;
    const numAmount = parseFloat(amount || 0);

    if (isNaN(numAmount) || numAmount < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Valor minimo de deposito e R$${MIN_DEPOSIT.toFixed(2)}` });
    }

    const result = await pool.query(
      'INSERT INTO deposits (user_id, amount, code, status, method) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, numAmount, code, 'pending', method || 'pix']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/infinitepay/checkout', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const amount = parseFloat(req.body.amount || 0);
    if (!amount || amount < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Valor minimo de deposito e R$${MIN_DEPOSIT}` });
    }

    const userResult = await client.query(
      'SELECT id, username, email FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const orderNsu = `INF-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const token = process.env.INFINITEPAY_WEBHOOK_TOKEN;
    const backendUrl = process.env.BACKEND_URL || 'https://preditivo-backend-production.up.railway.app';
    const webhookUrl = token ? `${backendUrl}/deposits/infinitepay/webhook/${token}` : undefined;
    const checkout = await createCheckoutLink({ amount, webhookUrl });

    await client.query('BEGIN');
    const depositResult = await client.query(
      `INSERT INTO deposits (user_id, amount, code, status, method)
       VALUES ($1, $2, $3, 'pending', 'infinitepay')
       RETURNING *`,
      [req.user.id, amount, orderNsu]
    );
    await client.query('COMMIT');

    res.json({
      ok: true,
      deposit: depositResult.rows[0],
      checkout_url: checkout.checkoutUrl
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processReferralBonus(userId, amount, db = pool) {
  try {
    if (parseFloat(amount) < REFERRAL_MIN_DEPOSIT) return;

    // UPDATE atômico: só marca first_deposit_done se ainda era FALSE e há referral.
    // Evita double-bonus em webhooks duplicados/paralelos (TOCTOU fix).
    const claim = await db.query(
      `UPDATE users SET first_deposit_done = TRUE
       WHERE id = $1 AND first_deposit_done = FALSE AND referred_by IS NOT NULL
       RETURNING referred_by`,
      [userId]
    );
    if (!claim.rows.length) return; // já processado ou sem referral

    const referrerId = claim.rows[0].referred_by;

    await db.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1, bonus_locked = COALESCE(bonus_locked, 0) + $1, bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE id = $2',
      [REFERRED_BONUS, userId]
    );

    await db.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1, bonus_locked = COALESCE(bonus_locked, 0) + $1, bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE id = $2',
      [REFERRER_BONUS, referrerId]
    );

    await db.query(
      'INSERT INTO referral_bonuses (referrer_id, referred_id, type, referrer_amount, referred_amount) VALUES ($1,$2,$3,$4,$5)',
      [referrerId, userId, 'deposit', REFERRER_BONUS, REFERRED_BONUS]
    );
  } catch (err) {
    console.error('Referral bonus error:', err.message);
  }
}

module.exports = router;
module.exports.processReferralBonus = processReferralBonus;
