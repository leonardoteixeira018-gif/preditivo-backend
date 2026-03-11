const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');

async function sendEmail(to, subject, html) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Preditivo <onboarding@resend.dev>',
        to,
        subject,
        html
      })
    });
    const data = await res.json();
    console.log('Email sent:', data.id || data.error);
  } catch(e) {
    console.log('Email error:', e.message);
  }
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });

    const history = await pool.query(
      'SELECT prob_yes, prob_no, volume, created_at FROM market_history WHERE market_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ ...market.rows[0], history: history.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { title, description, category, closes_at } = req.body;
    const result = await pool.query(
      'INSERT INTO markets (title, description, category, closes_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description, category, closes_at, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/description', async (req, res) => {
  try {
    const { description } = req.body;
    await pool.query('UPDATE markets SET description = $1 WHERE id = $2', [description, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const { outcome } = req.body;
    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });
    if (market.rows[0].resolved_at) return res.status(400).json({ error: 'Mercado ja resolvido' });

    const m = market.rows[0];

    await pool.query(
      'UPDATE markets SET status = $1, resolved_outcome = $2, resolved_at = NOW() WHERE id = $3',
      ['resolved', outcome, m.id]
    );

    // Pagar vencedores
    const winners = await pool.query(
      'SELECT b.*, u.email, u.username FROM bets b JOIN users u ON u.id = b.user_id WHERE b.market_id = $1 AND b.side = $2 AND b.status = $3',
      [m.id, outcome, 'open']
    );

    for (const bet of winners.rows) {
      const payout = parseFloat(bet.potential_payout);
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payout, bet.user_id]);
      await pool.query('UPDATE bets SET status = $1, payout = $2 WHERE id = $3', ['won', payout, bet.id]);

      // Email vencedor
      await sendEmail(
        bet.email,
        'Voce ganhou! Mercado resolvido — Preditivo',
        `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
          <h2 style="color:#00e676">Parabens, ${bet.username}!</h2>
          <p style="color:#5a6878;margin-bottom:20px">Voce apostou certo no mercado:</p>
          <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin-bottom:20px">
            <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
            <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#00e676">${outcome.toUpperCase()}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Sua aposta: <strong style="color:#e8edf2">R$${parseFloat(bet.amount).toFixed(2)}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Retorno creditado: <strong style="color:#00e676">R$${payout.toFixed(2)}</strong></div>
          </div>
          <a href="https://preditivo.vercel.app" style="display:inline-block;background:#00e676;color:#080c10;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none">Ver meu saldo</a>
        </div>`
      );
    }

    // Marcar perdedores
    const losers = await pool.query(
      'SELECT b.*, u.email, u.username FROM bets b JOIN users u ON u.id = b.user_id WHERE b.market_id = $1 AND b.side != $2 AND b.status = $3',
      [m.id, outcome, 'open']
    );

    for (const bet of losers.rows) {
      await pool.query('UPDATE bets SET status = $1 WHERE id = $2', ['lost', bet.id]);

      // Email perdedor
      await sendEmail(
        bet.email,
        'Resultado do mercado — Preditivo',
        `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
          <h2 style="color:#e8edf2">Resultado do mercado</h2>
          <p style="color:#5a6878;margin-bottom:20px">Ola ${bet.username}, o mercado foi resolvido:</p>
          <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin-bottom:20px">
            <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
            <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#ff4757">${outcome.toUpperCase()}</strong></div>
            <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Sua aposta: <strong style="color:#e8edf2">R$${parseFloat(bet.amount).toFixed(2)} em ${bet.side.toUpperCase()}</strong></div>
          </div>
          <p style="color:#5a6878;font-size:0.85rem;margin-bottom:20px">Nao desanime — explore outros mercados e tente novamente.</p>
          <a href="https://preditivo.vercel.app" style="display:inline-block;background:#0e1419;color:#00e676;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;border:1px solid rgba(0,230,118,0.3)">Ver mercados</a>
        </div>`
      );
    }

    // Email admin
    await sendEmail(
      'l245602@dac.unicamp.br',
      `[Admin] Mercado resolvido: ${m.title}`,
      `<div style="font-family:sans-serif;background:#080c10;color:#e8edf2;padding:32px;border-radius:12px;max-width:500px">
        <h2 style="color:#00b4ff">Mercado resolvido</h2>
        <div style="background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;margin:16px 0">
          <div style="font-weight:600;margin-bottom:12px">${m.title}</div>
          <div style="color:#5a6878;font-size:0.9rem">Resultado: <strong style="color:#e8edf2">${outcome.toUpperCase()}</strong></div>
          <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Vencedores pagos: <strong style="color:#00e676">${winners.rows.length}</strong></div>
          <div style="color:#5a6878;font-size:0.9rem;margin-top:6px">Perdedores: <strong style="color:#ff4757">${losers.rows.length}</strong></div>
        </div>
        <a href="https://preditivo.vercel.app/admin.html" style="display:inline-block;background:#00b4ff;color:#080c10;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none">Ver painel admin</a>
      </div>`
    );

    res.json({
      success: true,
      winners_paid: winners.rows.length,
      losers: losers.rows.length,
      outcome
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
