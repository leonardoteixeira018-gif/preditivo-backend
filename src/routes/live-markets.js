/**
 * Live Camera Markets Routes
 *
 * - GET /live-markets/:id/live-stream (SSE)
 *   Cliente conecta e recebe updates em tempo real
 *
 * - POST /internal/live-count (Worker only)
 *   Worker envia contagem de veículos (com secret)
 *
 * - GET /live-markets/:camera_id/history
 *   Histórico de rodadas passadas
 */

const router = require('express').Router();
const pool = require('../lib/db');
const cache = require('../lib/cache');

// Armazena conexões SSE ativas em memória
// { marketId: Set<response> }
const sseConnections = new Map();

// ============================================================================
// SSE - Server-Sent Events: Real-time count streaming
// ============================================================================

/**
 * GET /live-markets/:id/live-stream
 *
 * Cliente (frontend) conecta e recebe:
 * - Contagem em tempo real (a cada frame)
 * - Notificação de fim de rodada
 * - Heartbeat para manter conexão viva
 */
router.get('/:id/live-stream', async (req, res) => {
  const marketId = req.params.id;

  try {
    // Verificar se mercado existe e é do tipo live_count
    const market = await pool.query(
      'SELECT id, market_type, current_count, round_duration_seconds FROM markets WHERE id = $1',
      [marketId]
    );

    if (market.rows.length === 0) {
      return res.status(404).json({ error: 'Mercado não encontrado' });
    }

    if (market.rows[0].market_type !== 'live_count') {
      return res.status(400).json({ error: 'Este não é um mercado ao vivo' });
    }

    // Setup SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Adicionar conexão ao set
    if (!sseConnections.has(marketId)) {
      sseConnections.set(marketId, new Set());
    }
    sseConnections.get(marketId).add(res);

    // Enviar contagem inicial
    res.write(`data: ${JSON.stringify({
      type: 'count',
      value: market.rows[0].current_count,
      timestamp: new Date().toISOString()
    })}\n\n`);

    // Heartbeat a cada 30s para manter conexão viva
    const heartbeatInterval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }, 30000);

    // Cleanup ao desconectar
    res.on('close', () => {
      clearInterval(heartbeatInterval);
      sseConnections.get(marketId).delete(res);
      if (sseConnections.get(marketId).size === 0) {
        sseConnections.delete(marketId);
      }
    });

  } catch (err) {
    console.error('Error in SSE stream:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// INTERNAL ROUTES: Worker-only endpoints (x-worker-secret header)
// ============================================================================

/**
 * POST /internal/live-count
 *
 * Worker envia contagem de veículos a cada segundo
 *
 * Body:
 * {
 *   camera_id: "sp304-km157-piracicaba",
 *   market_id: "uuid",
 *   count_frame: 5,      // carros neste frame
 *   count_total: 127,    // total acumulado
 *   round_end: false     // true = fim da rodada, fazer resolução
 * }
 *
 * Header: x-worker-secret: {WORKER_SECRET}
 */
router.post('/live-count', async (req, res) => {
  try {
    // Validar worker secret
    const workerSecret = req.headers['x-worker-secret'];
    if (workerSecret !== process.env.WORKER_SECRET) {
      return res.status(403).json({ error: 'Worker secret inválida' });
    }

    const { camera_id, market_id, count_frame, count_total, round_end, detections, frame_width, frame_height } = req.body;

    if (!camera_id || !market_id || count_frame === undefined || count_total === undefined) {
      return res.status(400).json({ error: 'Campos obrigatórios: camera_id, market_id, count_frame, count_total' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Atualizar contagem atual no mercado
      await client.query(
        'UPDATE markets SET current_count = $1 WHERE id = $2',
        [count_total, market_id]
      );

      // 2. Registrar evento de contagem
      await client.query(
        `INSERT INTO live_count_events (market_id, camera_id, count_frame, count_total, worker_ts)
         VALUES ($1, $2, $3, $4, NOW())`,
        [market_id, camera_id, count_frame, count_total]
      );

      await client.query('COMMIT');

      // 3. Broadcast contagem + detections para todos os clientes SSE conectados
      broadcastToMarket(market_id, {
        type: 'count',
        value: count_total,
        detections: detections || [],
        frame_width: frame_width || null,
        frame_height: frame_height || null,
        timestamp: new Date().toISOString()
      });

      // 4. Se fim de rodada, resolver mercado e criar próxima rodada
      if (round_end) {
        try {
          const result = await endRoundAndCreateNext(client, market_id, count_total);

          // Broadcast fim de rodada
          broadcastToMarket(market_id, {
            type: 'round_end',
            outcome: result.outcome,
            final_count: count_total,
            next_market_id: result.next_market_id,
            timestamp: new Date().toISOString()
          });

          return res.json({
            ok: true,
            outcome: result.outcome,
            final_count: count_total,
            next_market_id: result.next_market_id
          });
        } catch (err) {
          // Erro na resolução, mas não falhar a contagem
          console.error('Error ending round:', err);
          return res.status(500).json({ error: 'Erro ao resolver rodada: ' + err.message });
        }
      }

      res.json({ ok: true, count: count_total });

    } finally {
      client.release();
    }

  } catch (err) {
    console.error('Error in /internal/live-count:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUBLIC ROUTES: Histórico e info de câmeras
// ============================================================================

/**
 * GET /live-markets/:camera_id/history?limit=20
 *
 * Retorna histórico das últimas rodadas de uma câmera
 * com resultado, contagem final, volume de apostas
 */
router.get('/:camera_id/history', async (req, res) => {
  try {
    const { camera_id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const history = await pool.query(
      `SELECT
        id,
        title,
        round_number,
        count_threshold,
        current_count,
        resolved_outcome,
        volume,
        created_at,
        resolved_at
      FROM markets
      WHERE camera_id = $1
      ORDER BY round_number DESC
      LIMIT $2`,
      [camera_id, limit]
    );

    res.json(history.rows);

  } catch (err) {
    console.error('Error in /history:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /live-markets/cameras
 *
 * Lista todas as câmeras disponíveis
 */
router.get('/cameras', async (req, res) => {
  try {
    const cached = cache.get('cameras:list');
    if (cached) return res.json(cached);

    const cameras = await pool.query(
      'SELECT * FROM cameras WHERE active = true ORDER BY name'
    );

    cache.set('cameras:list', cameras.rows, 60_000);
    res.json(cameras.rows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /live-markets/:camera_id/current
 *
 * Retorna o mercado aberto atual de uma câmera
 * Usado pelo worker Python para saber qual market_id processar
 */
router.get('/:camera_id/current', async (req, res) => {
  try {
    const { camera_id } = req.params;

    const market = await pool.query(
      `SELECT id, title, round_number, count_threshold, current_count,
              round_duration_seconds, betting_open_seconds, created_at, ends_at
       FROM markets
       WHERE camera_id = $1 AND status = 'open' AND market_type = 'live_count'
       ORDER BY round_number DESC
       LIMIT 1`,
      [camera_id]
    );

    if (market.rows.length === 0) {
      return res.status(404).json({ error: 'Nenhum mercado aberto' });
    }

    res.json(market.rows[0]);

  } catch (err) {
    console.error('Error in /current:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Broadcast mensagem para todos os clientes SSE de um mercado
 */
function broadcastToMarket(marketId, message) {
  if (!sseConnections.has(marketId)) return;

  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of sseConnections.get(marketId)) {
    res.write(data);
  }
}

/**
 * Resolve mercado atual e cria próxima rodada
 *
 * Transactional: tudo ou nada
 */
async function endRoundAndCreateNext(client, marketId, finalCount) {
  try {
    // 1. Get current market
    const market = await client.query(
      'SELECT * FROM markets WHERE id = $1 FOR UPDATE',
      [marketId]
    );

    if (market.rows.length === 0) {
      throw new Error('Mercado não encontrado');
    }

    const m = market.rows[0];

    // 2. Determine outcome based on threshold
    const outcome = finalCount >= m.count_threshold ? 'yes' : 'no';

    // 3. Update current market
    await client.query(
      `UPDATE markets
       SET status = 'resolved', resolved_outcome = $1, resolved_at = NOW()
       WHERE id = $2`,
      [outcome, marketId]
    );

    // 4. Payout winners (users who bet on winning side)
    const winners = await client.query(
      `SELECT b.*, u.id as user_id
       FROM bets b
       JOIN users u ON u.id = b.user_id
       WHERE b.market_id = $1 AND b.side = $2 AND b.status = 'open'`,
      [marketId, outcome]
    );

    for (const bet of winners.rows) {
      await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [bet.potential_payout, bet.user_id]
      );
      await client.query(
        'UPDATE bets SET status = $1, payout = $2 WHERE id = $3',
        ['won', bet.potential_payout, bet.id]
      );
    }

    // 5. Mark losers
    const losers = await client.query(
      `SELECT b.id
       FROM bets b
       WHERE b.market_id = $1 AND b.side != $2 AND b.status = 'open'`,
      [marketId, outcome]
    );

    for (const bet of losers.rows) {
      await client.query(
        'UPDATE bets SET status = $1, payout = 0 WHERE id = $2',
        ['lost', bet.id]
      );
    }

    // 6. Create next round
    const nextRound = await createNextMarketRound(client, m);

    // 7. Invalidate caches
    cache.del(`market:${marketId}`);
    cache.del('markets:list');

    return {
      outcome,
      final_count: finalCount,
      next_market_id: nextRound.id
    };

  } catch (err) {
    throw err;
  }
}

/**
 * Cria próxima rodada para uma câmera
 */
async function createNextMarketRound(client, prevMarket) {
  const now = new Date();
  const endsAt = new Date(now.getTime() + (prevMarket.round_duration_seconds * 1000));

  // Distribuir liquidez 50/50 para novo mercado
  const nextRound = await client.query(
    `INSERT INTO markets (
      title, category, market_type, camera_id, camera_embed_url,
      count_threshold, round_duration_seconds, betting_open_seconds,
      current_count, round_number, parent_camera_market_id, auto_resolve,
      ends_at, q_yes, q_no, b, volume, status
    ) VALUES (
      $1, 'live', 'live_count', $2, $3,
      $4, $5, $6,
      0, $7, $8, true,
      $9, 100, 100, 100, 0, 'open'
    )
    RETURNING *`,
    [
      `${prevMarket.title.split('(')[0]}(Rodada ${prevMarket.round_number + 1})`,
      prevMarket.camera_id,
      prevMarket.camera_embed_url,
      prevMarket.count_threshold,
      prevMarket.round_duration_seconds,
      prevMarket.betting_open_seconds,
      prevMarket.round_number + 1,
      prevMarket.parent_camera_market_id || prevMarket.id,
      endsAt
    ]
  );

  return nextRound.rows[0];
}

module.exports = router;
module.exports.broadcastToMarket = broadcastToMarket;
