const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/db');

// POST /auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Preencha todos os campos' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, balance`,
      [username, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email ou usuário já cadastrado' });
    }
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email e senha obrigatórios' });

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1', [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, balance: user.balance }
    });
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /auth/me
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, email, balance, wallet_address, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
