const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../lib/db');

function verifySignature(body, signature) {
  if (!process.env.TRANSAK_SECRET_KEY || !signature) return true;

  const computed = crypto
    .createHmac('sha256', process.env.TRANSAK_SECRET_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

  return computed === signature;
}

router.post('/webhook', async (req, res) => {
  const client = await pool.connect();

  try {
    const signature = req.headers['x-transak-signature'];
    if (!verifySignature(req.body, signature)) {
      console.error('Transak: assinatura invalida');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const {
      status,
      partnerOrderId,
      fiatAmount,
      cryptoAmount,
      cryptoCurrency,
      id: transakOrderId
    } = req.body;

    if (status !== 'COMPLETED') {
      return res.json({ ok: true, msg: `Status ${status} ignorado` });
    }

    if (!partnerOrderId || !transakOrderId) {
      return res.status(400).json({ error: 'Dados insuficientes no webhook' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM deposits WHERE transak_order_id = $1 FOR UPDATE',
      [transakOrderId]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, msg: 'Ja processado' });
    }

    const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [
      partnerOrderId
    ]);
    if (!userCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    const amount = parseFloat(fiatAmount);

    await client.query(
      `INSERT INTO deposits (user_id, amount, status, method, transak_order_id)
       VALUES ($1, $2, 'confirmed', 'usdc', $3)`,
      [partnerOrderId, amount, transakOrderId]
    );

    await client.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2',
      [amount, partnerOrderId]
    );

    await client.query('COMMIT');

    console.log(
      `Transak deposito confirmado: user=${partnerOrderId} R$${amount} (${cryptoAmount} ${cryptoCurrency})`
    );
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Transak webhook erro:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
