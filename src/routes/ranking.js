const router = require('express').Router();
const pool = require('../lib/db');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ranking LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
