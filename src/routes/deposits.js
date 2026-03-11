const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

const REFERRAL_MIN_DEPOSIT = 100;
const REFERRER_BONUS = 50;
const REFERRED_BONUS = 20;

router.post('/', auth, async (req, res) => {
  try {
    const { amount, code } = req.body;
    const result = await pool.query(
      'INSERT INTO deposits (user_id, amount, code, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, amount, code, 'pending']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

async function processReferralBonus(userId, amount) {
  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) return;
    const u = user.rows[0];
    if (!u.referred_by || u.first_deposit_done || parseFloat(amount) < REFERRAL_MIN_DEPOSIT) return;

    await pool.query('UPDATE users SET first_deposit_done = TRUE WHERE id = $1', [userId]);

    // Bônus do indicado: soma no balance total E registra como locked
    await pool.query(
      'UPDATE users SET balance = balance + $1, bonus_locked = bonus_locked + $1 WHERE id = $2',
      [REFERRED_BONUS, userId]
    );

    // Bônus do indicador: soma no balance total E registra como locked
    await pool.query(
      'UPDATE users SET balance = balance + $1, bonus_locked = bonus_locked + $1 WHERE id = $2',
      [REFERRER_BONUS, u.referred_by]
    );

    await pool.query(
      'INSERT INTO referral_bonuses (referrer_id, referred_id, type, referrer_amount, referred_amount) VALUES ($1,$2,$3,$4,$5)',
      [u.referred_by, userId, 'deposit', REFERRER_BONUS, REFERRED_BONUS]
    );

    console.log('Referral bonus paid:', { referrer: u.referred_by, referred: userId });
  } catch (err) {
    console.error('Referral bonus error:', err.message);
  }
}

module.exports = router;
module.exports.processReferralBonus = processReferralBonus;
