// Adiciona no topo do arquivo
async function processRollover(userId) {
  try {
    const user = await pool.query(
      'SELECT bonus_locked, bonus_bets_count FROM users WHERE id = $1', [userId]
    );
    if (!user.rows.length) return;
    const u = user.rows[0];
    const locked = parseFloat(u.bonus_locked || 0);
    const count = parseInt(u.bonus_bets_count || 0);

    if (locked <= 0) return; // sem bônus travado

    const newCount = count + 1;

    if (newCount >= 3) {
      // Libera o bônus — zera o locked e o contador
      await pool.query(
        'UPDATE users SET bonus_bets_count = 0, bonus_locked = 0 WHERE id = $1',
        [userId]
      );
      console.log('Rollover completo — bônus liberado para:', userId);
    } else {
      await pool.query(
        'UPDATE users SET bonus_bets_count = $1 WHERE id = $2',
        [newCount, userId]
      );
    }
  } catch (err) {
    console.error('Rollover error:', err.message);
  }
}

// Adiciona ANTES do module.exports
router.post('/markets/:id/resolve', async (req, res) => {
  try {
    const { outcome } = req.body; // 'yes' ou 'no'
    if (!['yes', 'no'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome deve ser yes ou no' });
    }

    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado não encontrado' });
    if (market.rows[0].resolved_at) return res.status(400).json({ error: 'Mercado já resolvido' });

    // Marca mercado como resolvido
    await pool.query(
      'UPDATE markets SET resolved_at = NOW(), resolved_outcome = $1, status = $2 WHERE id = $3',
      [outcome, 'resolved', req.params.id]
    );

    // Busca todas as apostas abertas desse mercado
    const bets = await pool.query(
      "SELECT * FROM bets WHERE market_id = $1 AND status = 'open'",
      [req.params.id]
    );

    for (const bet of bets.rows) {
      if (bet.side === outcome) {
        // Ganhou — paga o payout
        await pool.query(
          "UPDATE bets SET status = 'won' WHERE id = $1",
          [bet.id]
        );
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [bet.potential_payout, bet.user_id]
        );
      } else {
        // Perdeu
        await pool.query(
          "UPDATE bets SET status = 'lost' WHERE id = $1",
          [bet.id]
        );
      }
      // Incrementa contador de rollover para qualquer aposta resolvida
      await processRollover(bet.user_id);
    }

    res.json({ ok: true, resolved: bets.rows.length + ' apostas processadas' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
