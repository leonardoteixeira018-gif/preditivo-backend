const router = require('express').Router();
const pool = require('../lib/db');

function syntheticRankingProfile(userId, username) {
  const seed = `${userId}:${username || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }

  const normalized = Math.abs(hash);
  return {
    total_bets: 18 + (normalized % 83),
    total_profit: 450 + (normalized % 14000),
    win_rate: 58 + (normalized % 29)
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username AS name,
        u.rank_total_bets,
        u.rank_profit,
        u.rank_win_rate,
        COUNT(b.id) AS total_bets,
        COALESCE(SUM(CASE WHEN b.status = 'won' THEN b.potential_payout - b.amount ELSE 0 END), 0) AS total_profit,
        COALESCE(SUM(CASE WHEN b.status IN ('won','lost') AND b.status = 'won' THEN 1 ELSE 0 END)::float
          / NULLIF(COUNT(CASE WHEN b.status IN ('won','lost') THEN 1 END), 0) * 100, 0) AS win_rate
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
      WHERE COALESCE(u.is_bot, false) = false
      GROUP BY
        u.id,
        u.username,
        u.rank_total_bets,
        u.rank_profit,
        u.rank_win_rate
      ORDER BY total_profit DESC
      LIMIT 50
    `);

    const ranking = result.rows.map((row) => {
      const synthetic = syntheticRankingProfile(row.id, row.name);
      const actualBets = parseInt(row.total_bets || 0, 10);
      const actualProfit = parseFloat(row.total_profit || 0);
      const actualWinRate = parseFloat(row.win_rate || 0);

      return {
        id: row.id,
        name: row.name,
        total_bets: Math.max(actualBets, parseInt(row.rank_total_bets || synthetic.total_bets, 10)),
        total_profit: Math.max(actualProfit, parseFloat(row.rank_profit || synthetic.total_profit)),
        win_rate: Math.max(actualWinRate, parseFloat(row.rank_win_rate || synthetic.win_rate))
      };
    }).sort((a, b) => b.total_profit - a.total_profit);

    res.json(ranking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
