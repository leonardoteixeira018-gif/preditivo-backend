const router = require('express').Router();
const pool = require('../lib/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');

function generateCode(username) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (username.substring(0, 4).toUpperCase() + rand).substring(0, 8);
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, ref } = req.body;
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email já cadastrado' });

    const hash = await bcrypt.hash(password, 10);

    // Gera código único
    let code = generateCode(name);
    let codeExists = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (codeExists.rows.length) code = code.substring(0,6) + Math.floor(Math.random()*99);

    // Verifica se ref é válido
    let referrerId = null;
    if (ref) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref]);
      if (referrer.rows.length) referrerId = referrer.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username as name, email, balance, bonus_balance`,
      [name, email, hash, code, referrerId]
    );

    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return res.status(400).json({ error: 'Usuário não encontrado' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Senha incorreta' });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.username, email: user.email, balance: user.balance, bonus_balance: user.bonus_balance } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username as name, email, balance, bonus_balance FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET username = $1, password_hash = $2 WHERE id = $3', [name, hash, req.user.id]);
    } else {
      await pool.query('UPDATE users SET username = $1 WHERE id = $2', [name, req.user.id]);
    }
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
