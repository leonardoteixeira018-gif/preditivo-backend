const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

// Gera código único de referral para o usuário
function generateCode(username) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (username.substring(0, 4).toUpperCase() + rand).substring(0, 8);
}

// GET /referrals/me — retorna código e histórico de indicações
router.get('/me', auth, async (req, res) => {
  try {
    // Garante que o usuário tem um código
    let user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0].referral_code) {
      let code = generateCode(user.rows[0].username);
      // Garante unicidade
      let exists = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
      if (exists.rows.length) code = code + Math.floor(Math.random()*9);
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.user.id]);
      user.rows[0].referral_code = code;
    }

    const bonuses = await pool.query(`
      SELECT rb.*, u.username as referred_username
      FROM referral_bonuses rb
      LEFT JOIN users u ON u.id = rb.referred_id
      WHERE rb.referrer_id = $1
      ORDER BY rb.created_at DESC
    `, [req.user.id]);

    const totalBonus = await pool.query(
      'SELECT COALESCE(SUM(referrer_amount), 0) as total FROM referral_bonuses WHERE referrer_id = $1',
      [req.user.id]
    );

    res.json({
      referral_code: user.rows[0].referral_code,
      bonus_balance: parseFloat(user.rows[0].bonus_balance || 0),
      total_earned: parseFloat(totalBonus.rows[0].total),
      referrals: bonuses.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
