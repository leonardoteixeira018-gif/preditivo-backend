const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../lib/db');

function verifySignature(body, signature) {
  if (!process.env.TRANSAK_SECRET_KEY || !signature) return true; // skip in dev
  const computed = crypto
    .createHmac('sha256', process.env.TRANSAK_SECRET_KEY)
    .update(JSON.stringify(body))
    .digest('hex');
  return computed === signature;
}

router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-transak-signature'];
    if (!verifySignature(req.body, signature)) {
      console.error('Transak: assinatura inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const {
      status,
      partnerOrderId,  // user_id
      fiatAmount,
      fiatCurrency,
      cryptoAmount,
      cryptoCurrency,
      id: transakOrderId
    } = req.body;

    console.log('Transak webhook recebido:', { status, partnerOrderId, fiatAmount, cryptoAmount });

    // Só processa pagamentos concluídos
    if (status !== 'COMPLETED') {
      return res.json({ ok: true, msg: `Status ${status} ignorado` });
    }

    if (!partnerOrderId || !transakOrderId) {
      return res.status(400).json({ error: 'Dados insuficientes no webhook' });
    }

    // Idempotência: evita creditar duas vezes o mesmo pedido
    const existing = await pool.query(
      'SELECT id FROM deposits WHERE transak_order_id = $1',
      [transakOrderId]
    );
    if (existing.rows.length) {
      console.log('Transak: pedido já processado:', transakOrderId);
      return res.json({ ok: true, msg: 'Já processado' });
    }

    // Verifica se o usuário existe
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [partnerOrderId]);
    if (!userCheck.rows.length) {
      console.error('Transak: usuário não encontrado:', partnerOrderId);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const amount = parseFloat(fiatAmount);

    await pool.query('BEGIN');

    // Registra o depósito como confirmado
    await pool.query(
      `INSERT INTO deposits (user_id, amount, status, method, transak_order_id)
       VALUES ($1, $2, 'confirmed', 'usdc', $3)`,
      [partnerOrderId, amount, transakOrderId]
    );

    // Credita o saldo
    await pool.query(
      'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2',
      [amount, partnerOrderId]
    );

    await pool.query('COMMIT');

    console.log(`✅ Transak depósito confirmado: user=${partnerOrderId} R$${amount} (${cryptoAmount} ${cryptoCurrency})`);
    res.json({ ok: true });

  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Transak webhook erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
