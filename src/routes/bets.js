const router = require('express').Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const cache = require('../lib/cache');
const logger = require('../lib/logger');
const { logUserAction } = require('../lib/user-audit');

const TAXA_CASA = 0.02;
const CACHE_KEY_RANKING = 'ranking:list';

router.post('/', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { market_id, side, amount } = req.body;

    logger.info('Bet placement attempt', {
      userId: req.user.id,
      marketId: market_id,
      side,
      amount,
      ip: req.ip
    });

    if (!['yes', 'no'].includes(side)) {
      logger.warn('Bet validation failed - invalid side', {
        userId: req.user.id,
        side,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Side deve ser yes ou no' });
    }

    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      logger.warn('Bet validation failed - invalid amount', {
        userId: req.user.id,
        amount,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Valor invalido' });
    }

    await client.query('BEGIN');

    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [market_id]
    );

    if (!market.rows.length) {
      logger.warn('Bet validation failed - market not found', {
        userId: req.user.id,
        marketId: market_id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mercado nao encontrado' });
    }

    if (market.rows[0].resolved_at) {
      logger.warn('Bet validation failed - market already resolved', {
        userId: req.user.id,
        marketId: market_id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este mercado ja foi resolvido' });
    }

    if (market.rows[0].ends_at && new Date() > new Date(market.rows[0].ends_at)) {
      logger.warn('Bet validation failed - market betting closed', {
        userId: req.user.id,
        marketId: market_id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este mercado ja encerrou as apostas' });
    }

    const user = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (!user.rows.length) {
      logger.warn('Bet validation failed - user not found', {
        userId: req.user.id,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }

    if (parseFloat(user.rows[0].balance) < amt) {
      logger.warn('Bet validation failed - insufficient balance', {
        userId: req.user.id,
        userBalance: user.rows[0].balance,
        requestAmount: amt,
        ip: req.ip
      });
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const marketRow = market.rows[0];
    const qYes = parseFloat(marketRow.q_yes);
    const qNo = parseFloat(marketRow.q_no);
    const total = qYes + qNo;
    const probBefore = side === 'yes' ? qYes / total : qNo / total;
    const taxa = amt * TAXA_CASA;
    const amountLiquido = amt - taxa;
    const potentialPayout = (amountLiquido / probBefore).toFixed(2);

    if (side === 'yes') {
      await client.query(
        'UPDATE markets SET q_yes = q_yes + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2',
        [amt, market_id]
      );
    } else {
      await client.query(
        'UPDATE markets SET q_no = q_no + $1, volume = COALESCE(volume, 0) + $1 WHERE id = $2',
        [amt, market_id]
      );
    }

    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [
      amt,
      req.user.id
    ]);

    const bet = await client.query(
      `INSERT INTO bets (user_id, market_id, side, amount, potential_payout, status, taxa)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, market_id, side, amt, potentialPayout, 'open', taxa]
    );

    const newMarket = await client.query(
      'SELECT q_yes, q_no FROM markets WHERE id = $1',
      [market_id]
    );

    const newQYes = parseFloat(newMarket.rows[0].q_yes);
    const newQNo = parseFloat(newMarket.rows[0].q_no);
    const newTotal = newQYes + newQNo;
    const newProbYes = Math.round((newQYes / newTotal) * 100);

    await client.query(
      'INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1, $2, $3, $4)',
      [
        market_id,
        ((newQYes / newTotal) * 100).toFixed(2),
        ((newQNo / newTotal) * 100).toFixed(2),
        amt
      ]
    );

    await client.query('COMMIT');

    logger.info('Bet placed successfully', {
      userId: req.user.id,
      betId: bet.rows[0].id,
      marketId: market_id,
      side,
      amount: amt,
      potentialPayout: potentialPayout,
      ip: req.ip
    });

    // Log user action for compliance
    await logUserAction({
      userId: req.user.id,
      action: 'bet_placed',
      resourceType: 'bet',
      resourceId: bet.rows[0].id,
      details: {
        marketId: market_id,
        side,
        amount: amt,
        potentialPayout,
        taxa
      },
      ipAddress: req.ip
    });

    cache.del(CACHE_KEY_RANKING); // Aposta muda o ranking de volume

    const newBalance = parseFloat(user.rows[0].balance) - amt;

    res.json({
      bet: bet.rows[0],
      new_balance: newBalance,
      new_prob_yes: newProbYes,
      new_prob_no: 100 - newProbYes
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Bet placement failed', {
      userId: req.user.id,
      marketId: req.body.market_id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao colocar aposta' });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, m.title AS market_title
       FROM bets b
       JOIN markets m ON m.id = b.market_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Failed to fetch user bets', {
      userId: req.user.id,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Erro ao buscar apostas' });
  }
});

// GET apostas do usuário filtradas por mercado (para saber posição antes de vender)
router.get('/my/market/:market_id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT side, SUM(amount) as total_amount, COUNT(*) as count
      FROM bets
      WHERE user_id = $1 AND market_id = $2 AND status = 'open'
      GROUP BY side
    `, [req.user.id, req.params.market_id]);
    const position = { yes: 0, no: 0 };
    result.rows.forEach(r => { position[r.side] = parseFloat(r.total_amount); });
    res.json(position);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /bets/sell — vende uma posição aberta
router.post('/sell', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { market_id, side, amount } = req.body;

    logger.info('Bet sell attempt', {
      userId: req.user.id,
      marketId: market_id,
      side,
      amount,
      ip: req.ip
    });

    if (!['yes', 'no'].includes(side)) {
      logger.warn('Sell validation failed - invalid side', {
        userId: req.user.id,
        side,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Side deve ser yes ou no' });
    }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      logger.warn('Sell validation failed - invalid amount', {
        userId: req.user.id,
        amount,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Valor inválido' });
    }

    await client.query('BEGIN');

    // Trava o mercado e o usuário — tudo dentro da transação
    const market = await client.query('SELECT * FROM markets WHERE id = $1 FOR UPDATE', [market_id]);
    if (!market.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Mercado não encontrado' }); }
    if (market.rows[0].resolved_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Mercado já resolvido' }); }

    // Checa posição DENTRO da transação com lock para evitar double-sell
    const posQ = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM bets WHERE user_id=$1 AND market_id=$2 AND side=$3 AND status='open'`,
      [req.user.id, market_id, side]
    );
    const openAmt = parseFloat(posQ.rows[0].total);
    if (openAmt < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Posição insuficiente. Você tem R$${openAmt.toFixed(2)} aberto no lado ${side.toUpperCase()}` });
    }

    const m = market.rows[0];
    const q_yes = parseFloat(m.q_yes);
    const q_no = parseFloat(m.q_no);
    const total = q_yes + q_no;
    const current_prob = side === 'yes' ? q_yes / total : q_no / total;

    const sell_value_gross = amt * current_prob;
    const taxa = sell_value_gross * TAXA_CASA;
    const sell_value_net = sell_value_gross - taxa;

    // Reduz q_yes ou q_no
    if (side === 'yes') {
      await client.query('UPDATE markets SET q_yes = GREATEST(q_yes - $1, 10) WHERE id = $2', [amt, market_id]);
    } else {
      await client.query('UPDATE markets SET q_no = GREATEST(q_no - $1, 10) WHERE id = $2', [amt, market_id]);
    }

    // Credita saldo ao usuário
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [sell_value_net, req.user.id]);

    // Marca as apostas como 'sold'
    await client.query(`
      WITH bets_to_sell AS (
        SELECT id, amount,
          SUM(amount) OVER (ORDER BY created_at ASC) as running_total
        FROM bets WHERE user_id=$1 AND market_id=$2 AND side=$3 AND status='open'
      )
      UPDATE bets SET status='sold' WHERE id IN (
        SELECT id FROM bets_to_sell WHERE running_total <= $4
      )
    `, [req.user.id, market_id, side, amt]);

    // Registra no histórico
    const newM = await client.query('SELECT q_yes, q_no FROM markets WHERE id = $1', [market_id]);
    const nq_yes = parseFloat(newM.rows[0].q_yes);
    const nq_no = parseFloat(newM.rows[0].q_no);
    const new_total = nq_yes + nq_no;
    const new_prob_yes = (nq_yes / new_total * 100).toFixed(2);
    await client.query(
      `INSERT INTO market_history (market_id, prob_yes, prob_no, volume) VALUES ($1,$2,$3,$4)`,
      [market_id, new_prob_yes, (100 - parseFloat(new_prob_yes)).toFixed(2), sell_value_gross]
    );

    const userQ = await client.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    await client.query('COMMIT');

    logger.info('Bet sold successfully', {
      userId: req.user.id,
      marketId: market_id,
      side,
      amount: amt,
      sellValue: sell_value_net,
      taxa,
      ip: req.ip
    });

    // Log user action for compliance
    await logUserAction({
      userId: req.user.id,
      action: 'bet_sold',
      resourceType: 'bet',
      resourceId: market_id,
      details: {
        side,
        amount: amt,
        sellValue: sell_value_net,
        taxa
      },
      ipAddress: req.ip
    });

    cache.del(CACHE_KEY_RANKING);

    res.json({
      ok: true,
      sell_value: parseFloat(sell_value_net.toFixed(2)),
      taxa: parseFloat(taxa.toFixed(2)),
      new_balance: parseFloat(userQ.rows[0].balance),
      new_prob_yes: Math.round(parseFloat(new_prob_yes)),
      new_prob_no: Math.round(100 - parseFloat(new_prob_yes))
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Bet sell failed', {
      userId: req.user.id,
      marketId: req.body.market_id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao vender aposta' });
  } finally {
    client.release();
  }
});

router.get('/quote', async (req, res) => {
  try {
    const { market_id, side, amount } = req.query;

    if (!['yes', 'no'].includes(side)) {
      return res.status(400).json({ error: 'side deve ser yes ou no' });
    }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      return res.status(400).json({ error: 'amount inválido' });
    }

    const market = await pool.query('SELECT * FROM markets WHERE id = $1', [market_id]);
    if (!market.rows.length) return res.status(404).json({ error: 'Mercado nao encontrado' });

    const m = market.rows[0];
    if (m.resolved_at) return res.status(400).json({ error: 'Mercado já resolvido' });
    if (m.ends_at && new Date() > new Date(m.ends_at)) {
      return res.status(400).json({ error: 'Mercado expirado' });
    }

    const qYes = parseFloat(m.q_yes);
    const qNo = parseFloat(m.q_no);
    const total = qYes + qNo;

    // Prob atual (antes da compra)
    const currentProb = side === 'yes' ? qYes / total : qNo / total;

    // Prob simulada após a compra
    const newTotal = total + amt;
    const newQ = side === 'yes' ? qYes + amt : qNo + amt;
    const afterProb = newQ / newTotal;

    // Slippage = variação percentual da prob causada pela compra
    const slippagePct = Math.abs(afterProb - currentProb) / currentProb * 100;

    const taxa = amt * TAXA_CASA;
    const amountLiquido = amt - taxa;
    const payout = (amountLiquido / afterProb).toFixed(2);

    res.json({
      prob: (currentProb * 100).toFixed(1),
      prob_after: (afterProb * 100).toFixed(1),
      slippage_pct: slippagePct.toFixed(2),
      slippage_warning: slippagePct > 5,
      payout,
      taxa: taxa.toFixed(2),
      amount_liquid: amountLiquido.toFixed(2)
    });
  } catch (err) {
    logger.error('Quote calculation failed', {
      marketId: req.query.market_id,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Erro ao calcular cotacao' });
  }
});

// GET /bets/market/:market_id/book — Retorna o "livro de ordens" (apostas recentes abertas)
router.get('/market/:market_id/book', async (req, res) => {
  try {
    const { market_id } = req.params;
    const result = await pool.query(
      `SELECT side, amount, potential_payout, created_at
       FROM bets
       WHERE market_id = $1 AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 40`,
      [market_id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Failed to fetch order book', {
      marketId: req.params.market_id,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Erro ao buscar livro de ordens' });
  }
});

// GET /bets/portfolio — posições abertas do usuário agrupadas por mercado+lado
router.get('/portfolio', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.market_id,
        m.title                                                            AS market_title,
        b.side,
        SUM(b.amount)                                                      AS amount,
        SUM(b.potential_payout)                                            AS potential_payout,
        ROUND(
          (CASE WHEN b.side = 'yes' THEN m.q_yes ELSE m.q_no END)
          / NULLIF(m.q_yes + m.q_no, 0) * 100
        , 1)                                                               AS prob_side,
        m.ends_at,
        m.resolved_at
      FROM bets b
      JOIN markets m ON m.id = b.market_id
      WHERE b.user_id = $1 AND b.status = 'open'
      GROUP BY b.market_id, m.title, b.side, m.q_yes, m.q_no, m.ends_at, m.resolved_at
      ORDER BY m.title, b.side
    `, [req.user.id]);

    res.json(result.rows.map(r => ({
      market_id:        r.market_id,
      market_title:     r.market_title,
      side:             r.side,
      amount:           parseFloat(r.amount).toFixed(2),
      potential_payout: parseFloat(r.potential_payout).toFixed(2),
      prob_side:        parseFloat(r.prob_side),
      potential:        ((parseFloat(r.potential_payout) / parseFloat(r.amount) - 1) * 100).toFixed(2),
      ends_at:          r.ends_at,
      resolved_at:      r.resolved_at
    })));
  } catch (err) {
    logger.error('Failed to fetch portfolio', {
      userId: req.user.id,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Erro ao buscar portfolio' });
  }
});

// GET /bets/pnl?period=all|month|week|day
router.get('/pnl', auth, async (req, res) => {
  const { period = 'all' } = req.query;
  let dateFilter = '';
  if (period === 'day')   dateFilter = "AND created_at >= NOW() - INTERVAL '1 day'";
  if (period === 'week')  dateFilter = "AND created_at >= NOW() - INTERVAL '7 days'";
  if (period === 'month') dateFilter = "AND created_at >= NOW() - INTERVAL '30 days'";

  try {
    // Query 1: P&L stats filtradas pelo período selecionado
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'won')  AS win_count,
        COUNT(*) FILTER (WHERE status = 'lost') AS loss_count,
        COALESCE(SUM(amount)  FILTER (WHERE status IN ('won','lost')), 0) AS total_wagered,
        COALESCE(SUM(payout)  FILTER (WHERE status = 'won'), 0)           AS total_payout,
        COALESCE(SUM(payout - amount) FILTER (WHERE status IN ('won','lost')), 0) AS total_pnl
      FROM bets WHERE user_id = $1 ${dateFilter}
    `, [req.user.id]);

    // Query 2: posições abertas SEMPRE sem filtro de período
    const openStats = await pool.query(`
      SELECT
        COALESCE(SUM(potential_payout) FILTER (WHERE status = 'open'), 0) AS open_value,
        COALESCE(SUM(amount)           FILTER (WHERE status = 'open'), 0) AS open_invested
      FROM bets WHERE user_id = $1
    `, [req.user.id]);

    const history = await pool.query(`
      SELECT DATE(created_at) AS date,
        COALESCE(SUM(payout - amount) FILTER (WHERE status IN ('won','lost')), 0) AS daily_pnl
      FROM bets
      WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [req.user.id]);

    const s = stats.rows[0];
    const o = openStats.rows[0];
    const wins = parseInt(s.win_count) || 0;
    const losses = parseInt(s.loss_count) || 0;
    res.json({
      total_pnl:     parseFloat(s.total_pnl).toFixed(2),
      total_wagered: parseFloat(s.total_wagered).toFixed(2),
      total_payout:  parseFloat(s.total_payout).toFixed(2),
      open_value:    parseFloat(o.open_value).toFixed(2),
      open_invested: parseFloat(o.open_invested).toFixed(2),
      win_count: wins, loss_count: losses,
      win_rate: (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0',
      history: history.rows.map(r => ({ date: r.date, pnl: parseFloat(r.daily_pnl).toFixed(2) }))
    });
  } catch(err) {
    logger.error('Failed to fetch P&L', {
      userId: req.user.id,
      period: req.query.period,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Erro ao buscar P&L' });
  }
});

module.exports = router;
