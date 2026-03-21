const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const pool = require('../lib/db');
const logger = require('../lib/logger');
const auth = require('../middleware/auth');
const requireKyc = require('../middleware/requireKyc');
const requireSuitability = require('../middleware/requireSuitability');
const requireRiskTerm = require('../middleware/requireRiskTerm');
const { ensureCustomer, createPixCharge, getPixQrCode } = require('../lib/asaas');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de webhooks excedido' }
});

const REFERRAL_MIN_DEPOSIT = 100;
const REFERRER_BONUS = 50;
const REFERRED_BONUS = 20;
const MIN_DEPOSIT = 5;

// ── Asaas webhook validation ─────────────────────────────────────────────────
// Asaas inclui o campo '$asaas_access_token' no body de cada webhook.
// Configure ASAAS_WEBHOOK_TOKEN no Railway com o mesmo valor configurado no
// painel Asaas em Configurações > Notificações.
function validateAsaasWebhook(req) {
  const token = req.body?.['$asaas_access_token'];
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[SECURITY] ASAAS_WEBHOOK_TOKEN nao configurada em producao — rejeitando webhook');
      return false;
    }
    logger.warn('[WEBHOOK] ASAAS_WEBHOOK_TOKEN ausente — validacao ignorada (apenas dev)');
    return true;
  }

  if (!token) {
    logger.warn('[SECURITY] Webhook Asaas rejeitado: token ausente no payload');
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Asaas event normalizer ───────────────────────────────────────────────────
function normalizeAsaasEvent(body) {
  const event = body.event || '';
  const payment = body.payment || {};

  let status = 'pending';
  if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) {
    status = 'confirmed';
  } else if (['PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED'].includes(event)) {
    status = 'failed';
  }

  return {
    status,
    paymentId: payment.id || null,
    externalReference: payment.externalReference || null,
    value: payment.value || null,
    raw: body
  };
}

// ── POST /deposits/asaas/webhook ─────────────────────────────────────────────
router.post('/asaas/webhook', webhookLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    logger.info('Webhook received from Asaas', { ip: req.ip, event: req.body?.event });

    if (!validateAsaasWebhook(req)) {
      logger.warn('Asaas webhook rejected - invalid token', { ip: req.ip });
      return res.status(401).json({ error: 'Token invalido' });
    }

    const event = normalizeAsaasEvent(req.body || {});

    if (!event.paymentId) {
      logger.warn('Asaas webhook rejected - missing payment.id', { body: req.body });
      return res.status(400).json({ error: 'payment.id ausente' });
    }

    logger.info('Asaas webhook validation passed', {
      paymentId: event.paymentId,
      externalReference: event.externalReference,
      status: event.status
    });

    await client.query('BEGIN');

    // Busca por provider_reference (payment ID do Asaas) — fallback por externalReference (deposit UUID)
    let depositResult = await client.query(
      `SELECT * FROM deposits WHERE provider_reference = $1 FOR UPDATE`,
      [event.paymentId]
    );
    if (!depositResult.rows.length && event.externalReference) {
      depositResult = await client.query(
        `SELECT * FROM deposits WHERE id = $1 FOR UPDATE`,
        [event.externalReference]
      );
    }

    if (!depositResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deposito nao encontrado' });
    }

    const deposit = depositResult.rows[0];

    // Idempotência: já confirmado, ignora
    if (deposit.status === 'confirmed') {
      await client.query('ROLLBACK');
      return res.json({ ok: true, message: 'Deposito ja processado' });
    }

    // Status não-confirmado (pending, failed, overdue): apenas atualiza
    if (event.status !== 'confirmed') {
      await client.query(
        `UPDATE deposits SET status = $1, provider_payload = provider_payload || $2::jsonb WHERE id = $3`,
        [event.status, JSON.stringify(event.raw), deposit.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, message: `Status ${event.status} registrado` });
    }

    // ── Confirmação do depósito ──────────────────────────────────────────────
    await client.query(
      `UPDATE deposits
       SET status = 'confirmed', provider_payload = provider_payload || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(event.raw), deposit.id]
    );

    await client.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2',
      [deposit.amount, deposit.user_id]
    );

    await processReferralBonus(deposit.user_id, deposit.amount, client);
    await client.query('COMMIT');

    // ── PLD/FT: Monitoramento automático COAF (Lei 9.613/98 Art. 11) ────────
    try {
      const COAF_THRESHOLD = parseFloat(process.env.COAF_THRESHOLD || '10000');
      const monthlyRes = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS monthly_total
         FROM deposits
         WHERE user_id = $1
           AND status = 'confirmed'
           AND created_at >= date_trunc('month', NOW())`,
        [deposit.user_id]
      );
      const monthlyTotal = parseFloat(monthlyRes.rows[0].monthly_total);
      if (monthlyTotal >= COAF_THRESHOLD) {
        const existingFlag = await pool.query(
          `SELECT id FROM coaf_flags
           WHERE user_id = $1
             AND created_at >= date_trunc('month', NOW())
             AND status = 'pending'
           LIMIT 1`,
          [deposit.user_id]
        );
        if (existingFlag.rows.length) {
          await pool.query(
            `UPDATE coaf_flags SET month_total = $1 WHERE id = $2`,
            [monthlyTotal, existingFlag.rows[0].id]
          );
          logger.info('PLD/FT: Flag COAF atualizado', { user_id: deposit.user_id, monthly_total: monthlyTotal });
        } else {
          await pool.query(
            `INSERT INTO coaf_flags (user_id, deposit_id, month_total, threshold, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [deposit.user_id, deposit.id, monthlyTotal, COAF_THRESHOLD]
          );
          logger.warn('PLD/FT: Flag COAF criado automaticamente', {
            user_id: deposit.user_id,
            monthly_total: monthlyTotal,
            threshold: COAF_THRESHOLD
          });
        }
      }
    } catch (coafErr) {
      logger.error('PLD/FT COAF auto-check error', { error: coafErr.message });
    }
    // ────────────────────────────────────────────────────────────────────────

    try {
      const userInfo = await pool.query('SELECT email, username FROM users WHERE id = $1', [deposit.user_id]);
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
    } catch (emailErr) {
      logger.error('Email confirmation error', { error: emailErr.message });
    }

    res.json({ ok: true, message: 'Deposito confirmado' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Asaas webhook error', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /deposits/asaas/checkout ────────────────────────────────────────────
router.post('/asaas/checkout', auth, requireRiskTerm, requireKyc, requireSuitability, async (req, res) => {
  const client = await pool.connect();

  try {
    const amount = parseFloat(req.body.amount || 0);
    if (!amount || amount < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Valor minimo de deposito e R$${MIN_DEPOSIT}` });
    }

    const userResult = await client.query(
      'SELECT id, username, email, cpf, full_name, asaas_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const user = userResult.rows[0];

    if (!user.cpf) {
      return res.status(422).json({
        error: 'CPF_REQUIRED',
        message: 'Complete seu KYC para depositar via PIX. CPF nao encontrado.'
      });
    }

    // Garante customer no Asaas (cria se necessário)
    let customerId;
    try {
      customerId = await ensureCustomer({
        asaasCustomerId: user.asaas_customer_id,
        name: user.full_name || user.username,
        cpf: user.cpf,
        email: user.email
      });
    } catch (err) {
      logger.error('Asaas ensureCustomer error', { error: err.message, user_id: user.id });
      return res.status(502).json({ error: 'Gateway de pagamento indisponivel. Tente novamente.' });
    }

    // Salva o customer_id se é novo
    if (customerId !== user.asaas_customer_id) {
      await pool.query('UPDATE users SET asaas_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    // Cria o depósito no banco e a cobrança no Asaas
    const depositCode = `ASA-${user.id.slice(0, 8)}-${Date.now()}`;

    await client.query('BEGIN');

    const depositResult = await client.query(
      `INSERT INTO deposits (user_id, amount, code, status, method)
       VALUES ($1, $2, $3, 'pending', 'asaas')
       RETURNING *`,
      [user.id, amount, depositCode]
    );
    const deposit = depositResult.rows[0];

    let charge;
    try {
      charge = await createPixCharge({
        customerId,
        amount,
        externalReference: deposit.id,
        description: 'Deposito Bubuya'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Asaas createPixCharge error', { error: err.message, user_id: user.id });
      return res.status(502).json({ error: 'Gateway de pagamento indisponivel. Tente novamente.' });
    }

    await client.query(
      `UPDATE deposits
       SET provider_reference = $1, provider_payload = $2::jsonb
       WHERE id = $3`,
      [charge.id, JSON.stringify(charge), deposit.id]
    );
    await client.query('COMMIT');

    // Busca QR Code (fora da transação — read-only)
    let pix = null;
    try {
      const qr = await getPixQrCode(charge.id);
      pix = {
        qr_code: qr.payload,
        qr_code_image: qr.encodedImage
      };
    } catch (err) {
      logger.error('Asaas getPixQrCode error', { error: err.message, paymentId: charge.id });
      // Depósito e cobrança já existem — não reverter
      return res.status(207).json({
        ok: true,
        deposit,
        pix: null,
        warning: 'QR Code temporariamente indisponivel. O deposito foi criado e sera confirmado automaticamente apos o pagamento.'
      });
    }

    logger.info('Asaas checkout created', {
      deposit_id: deposit.id,
      payment_id: charge.id,
      amount,
      user_id: user.id
    });

    res.json({ ok: true, deposit, pix });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Asaas checkout error', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /deposits/my ──────────────────────────────────────────────────────────
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

// ── POST /deposits (depósito manual — admin) ──────────────────────────────────
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

// ── Referral bonus helper ─────────────────────────────────────────────────────
async function processReferralBonus(userId, amount, db = pool) {
  try {
    if (parseFloat(amount) < REFERRAL_MIN_DEPOSIT) return;

    const claim = await db.query(
      `UPDATE users SET first_deposit_done = TRUE
       WHERE id = $1 AND first_deposit_done = FALSE AND referred_by IS NOT NULL
       RETURNING referred_by`,
      [userId]
    );
    if (!claim.rows.length) return;

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
    logger.error('Referral bonus error', { error: err.message });
  }
}

module.exports = router;
module.exports.processReferralBonus = processReferralBonus;
