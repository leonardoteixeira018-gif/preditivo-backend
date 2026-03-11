const jwt = require('jsonwebtoken');
router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (password) {
      const bcrypt = require('bcrypt');
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
module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
