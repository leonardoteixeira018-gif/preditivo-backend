const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const MIN_WITHDRAWAL = 20;

router.post('/', auth, async (req, res) => {
  try {
    const { amount, pix_key, pix_key_type } = req.body;
    if (!amount || amount < MIN_WITHDRAWAL) {
      return res.status(400).json({ error: 'Valor minimo de saque e R$' + MIN_WITHDRAWAL });
    }
    if (!pix_key || !pix_key_type) {
      return res.status(400).json({ error: 'Chave PIX obrigatoria' });
    }

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows.length) return res.status(404).json({ error: 'Usuario nao encontrado' });

    const balance = parseFloat(user.rows[0].balance);
    const locked = parseFloat(user.rows[0].bonus_locked || 0);
    const withdrawable = balance - locked; // saldo disponível para saque

    if (withdrawable < MIN_WITHDRAWAL) {
      return res.status(400).json({ 
        error: `Saldo disponível para saque: R$${withdrawable.toFixed(2)}. R$${locked.toFixed(2)} estão bloqueados (complete mais ${3 - parseInt(user.rows[0].bonus_bets_count || 0)} apostas para liberar).`
      });
    }
    if (parseFloat(amount) > withdrawable) {
      return res.status(400).json({ 
        error: `Valor máximo para saque: R$${withdrawable.toFixed(2)} (R$${locked.toFixed(2)} bloqueados por bônus)`
      });
    }

    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
    const result = await pool.query(
      'INSERT INTO withdrawals (user_id, amount, pix_key, pix_key_type, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, amount, pix_key, pix_key_type, 'pending']
    );

    const new_balance = balance - parseFloat(amount);
    res.json({ withdrawal: result.rows[0], new_balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
