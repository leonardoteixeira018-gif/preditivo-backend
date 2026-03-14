const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const { createEmailVerification, consumeEmailVerification } = require('../lib/emailVerification');
const { APP_BRAND } = require('../lib/appConfig');

const MIN_WITHDRAWAL = 20;

async function getWithdrawContext(userId) {
  const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user.rows.length) {
    throw new Error('Usuario nao encontrado');
  }

  const row = user.rows[0];
  const balance = parseFloat(row.balance || 0);
  const locked = parseFloat(row.bonus_locked || 0);
  const withdrawable = balance - locked;

  return { row, balance, locked, withdrawable };
}

function validateWithdrawalRequest({ amount, pixKey, pixKeyType, withdrawable, locked, balance }) {
  if (!amount || amount < MIN_WITHDRAWAL) {
    return 'Valor minimo de saque e R$' + MIN_WITHDRAWAL;
  }

  if (!pixKey || !pixKeyType) {
    return 'Chave PIX obrigatoria';
  }

  if (withdrawable < MIN_WITHDRAWAL) {
    return `Saldo disponivel para saque: R$${withdrawable.toFixed(2)}. R$${locked.toFixed(2)} estao bloqueados.`;
  }

  if (amount > withdrawable || amount > balance) {
    return `Valor maximo para saque: R$${withdrawable.toFixed(2)} (R$${locked.toFixed(2)} bloqueados por bonus)`;
  }

  return null;
}

router.post('/', auth, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    const pixKey = String(req.body.pix_key || '').trim();
    const pixKeyType = String(req.body.pix_key_type || '').trim();

    const { row, balance, locked, withdrawable } = await getWithdrawContext(req.user.id);
    const validationError = validateWithdrawalRequest({
      amount,
      pixKey,
      pixKeyType,
      withdrawable,
      locked,
      balance
    });

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    await createEmailVerification({
      purpose: 'withdrawal',
      email: row.email,
      userId: req.user.id,
      payload: {
        amount,
        pix_key: pixKey,
        pix_key_type: pixKeyType
      },
      subject: `Confirme seu saque na ${APP_BRAND}`,
      heading: 'Confirme sua solicitacao de saque',
      intro: `Use o codigo abaixo para confirmar seu saque de R$${amount.toFixed(2)} para a chave PIX ${pixKey}.`
    });

    res.json({
      ok: true,
      requires_verification: true,
      email: row.email,
      message: 'Enviamos um codigo para confirmar o saque.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const code = String(req.body.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'code e obrigatorio' });
    }

    await client.query('BEGIN');

    const user = await client.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const userRow = user.rows[0];
    const verification = await consumeEmailVerification({
      purpose: 'withdrawal',
      email: userRow.email,
      userId: req.user.id,
      code,
      db: client
    });

    const payload = verification.payload || {};
    const amount = parseFloat(payload.amount || 0);
    const pixKey = String(payload.pix_key || '').trim();
    const pixKeyType = String(payload.pix_key_type || '').trim();

    const lockedUser = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const current = lockedUser.rows[0];
    const balance = parseFloat(current.balance || 0);
    const locked = parseFloat(current.bonus_locked || 0);
    const withdrawable = balance - locked;

    const validationError = validateWithdrawalRequest({
      amount,
      pixKey,
      pixKeyType,
      withdrawable,
      locked,
      balance
    });

    if (validationError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: validationError });
    }

    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
    const result = await client.query(
      'INSERT INTO withdrawals (user_id, amount, pix_key, pix_key_type, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, amount, pixKey, pixKeyType, 'pending']
    );

    await client.query('COMMIT');

    const newBalance = balance - amount;
    res.json({ withdrawal: result.rows[0], new_balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const status = /Codigo|Valor maximo|Saldo disponivel/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
