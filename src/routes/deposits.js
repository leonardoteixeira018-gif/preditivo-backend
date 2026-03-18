const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const { createCheckoutLink } = require('../lib/infinitepay');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de webhooks excedido' }
});

function verifyInfinitePaySignature(req) {
  const secret = process.env.INFINITEPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Em desenvolvimento local, permite sem assinatura. Em produção (NODE_ENV=production), rejeita.
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] INFINITEPAY_WEBHOOK_SECRET não configurada em produção — rejeitando webhook');
      return false;
    }
    console.warn('[WEBHOOK] INFINITEPAY_WEBHOOK_SECRET ausente — validação ignorada (apenas dev)');
    return true;
  }

  const signature =
    req.headers['x-infinitepay-signature'] ||
    req.headers['x-signature'] ||
    req.headers['x-hmac-sha256'];

  if (!signature) {
    console.warn('[WEBHOOK] Header de assinatura ausente');
    return false;
  }

  const rawBody = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.replace(/^sha256=/, '')),
      Buffer.from(expected)
    );
  } catch {
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

router.post('/infinitepay/webhook', webhookLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!verifyInfinitePaySignature(req)) {
      console.warn(`[SECURITY] Webhook com assinatura inválida rejeitado — IP: ${req.ip}`);
      return res.status(401).json({ error: 'Assinatura inválida' });
    }

    const event = extractInfinitePayWebhook(req.body || {});
    if (!event.orderNsu) {
      return res.status(400).json({ error: 'order_nsu ausente' });
    }

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
    const checkout = await createCheckoutLink({ amount });

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
