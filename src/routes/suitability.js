/**
 * suitability.js — Rotas de Perfil de Investidor
 *
 * Usuário (requer auth):
 *   GET  /suitability/questions   → retorna as perguntas do questionário
 *   GET  /suitability/status      → perfil atual, limites, expiração
 *   POST /suitability/submit      → responde o questionário e calcula o perfil
 *
 * Admin (requer x-admin-secret):
 *   GET  /suitability/admin/stats → resumo de perfis de todos os usuários
 *   POST /suitability/admin/:userId/override → sobrescreve perfil manualmente
 */
const router = require('express').Router();
const pool   = require('../lib/db');
const auth   = require('../middleware/auth');
const logger = require('../lib/logger');
const { logUserAction } = require('../lib/user-audit');
const {
  QUESTIONS,
  PROFILES,
  validateAnswers,
  calculateProfile,
  calcExpiresAt,
} = require('../lib/suitability');

const ADMIN_SECRET = process.env.ADMIN_SECRET;

function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

// ── Rotas de usuário ──────────────────────────────────────────────────────────

/**
 * GET /suitability/questions
 * Retorna as perguntas do questionário (não requer auth — pode ser exibido na tela de onboarding).
 */
router.get('/questions', (req, res) => {
  res.json({
    ok: true,
    questions: QUESTIONS,
    validity_months: 12,
    profiles: Object.entries(PROFILES).map(([key, p]) => ({
      key,
      label: p.label,
      description: p.description,
      limits: p.limits
    }))
  });
});

/**
 * GET /suitability/status
 * Retorna o perfil atual do usuário autenticado.
 */
router.get('/status', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        suitability_profile,
        suitability_score,
        suitability_completed_at,
        suitability_expires_at
      FROM users
      WHERE id = $1
    `, [req.user.id]);

    const row       = result.rows[0];
    const profile   = row?.suitability_profile;
    const expiresAt = row?.suitability_expires_at ? new Date(row.suitability_expires_at) : null;
    const now       = new Date();
    const isActive  = profile && expiresAt && expiresAt > now;

    // Busca o histórico de respostas mais recente
    const history = await pool.query(`
      SELECT id, profile, score, completed_at, expires_at
      FROM suitability_responses
      WHERE user_id = $1
      ORDER BY completed_at DESC
      LIMIT 5
    `, [req.user.id]);

    const { PROFILES } = require('../lib/suitability');

    res.json({
      ok: true,
      has_profile: !!profile,
      is_active: isActive,
      profile: profile || null,
      profile_label: profile ? PROFILES[profile]?.label : null,
      score: row?.suitability_score || null,
      limits: profile ? PROFILES[profile]?.limits : null,
      completed_at: row?.suitability_completed_at || null,
      expires_at: expiresAt || null,
      expires_in_days: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24))) : null,
      history: history.rows
    });
  } catch (err) {
    logger.error('Suitability status error', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /suitability/submit
 * Recebe as respostas do questionário, calcula o perfil e salva.
 * Body: { answers: { objetivo: 'a'|'b'|'c', perda: ..., experiencia: ..., horizonte: ..., renda: ... } }
 *
 * Funciona para usuários novos E existentes (sem perfil ou com perfil expirado).
 */
router.post('/submit', auth, async (req, res) => {
  try {
    const { answers } = req.body;

    const validationError = validateAnswers(answers);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { profile, score, limits, profileData } = calculateProfile(answers);
    const expiresAt = calcExpiresAt();

    logger.info('Suitability questionnaire submitted', {
      userId: req.user.id,
      profile,
      score,
      ip: req.ip
    });

    await pool.query(`
      UPDATE users SET
        suitability_profile      = $1,
        suitability_score        = $2,
        suitability_completed_at = NOW(),
        suitability_expires_at   = $3
      WHERE id = $4
    `, [profile, score, expiresAt, req.user.id]);

    await pool.query(`
      INSERT INTO suitability_responses
        (user_id, answers, profile, score, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.user.id, JSON.stringify(answers), profile, score, expiresAt]);

    await logUserAction(req.user.id, 'suitability_completed', 'user', req.user.id, {
      profile,
      score
    }, req.ip);

    logger.info('Suitability profile assigned', {
      userId: req.user.id,
      profile,
      score,
      expiresAt: expiresAt.toISOString()
    });

    res.json({
      ok: true,
      profile,
      profile_label: profileData.label,
      profile_description: profileData.description,
      score,
      limits,
      expires_at: expiresAt,
      message: `Seu perfil de investidor é ${profileData.label}. Você já pode operar dentro dos seus limites.`
    });

  } catch (err) {
    logger.error('Suitability submit error', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── Rotas de admin ────────────────────────────────────────────────────────────

/**
 * GET /suitability/admin/stats
 * Resumo de perfis: quantos usuários em cada perfil, quantos sem perfil, quantos expirados.
 */
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE suitability_profile IS NULL)                                       AS sem_perfil,
        COUNT(*) FILTER (WHERE suitability_profile IS NOT NULL AND suitability_expires_at < NOW()) AS expirados,
        COUNT(*) FILTER (WHERE suitability_profile = 'conservador' AND suitability_expires_at > NOW()) AS conservador,
        COUNT(*) FILTER (WHERE suitability_profile = 'moderado'    AND suitability_expires_at > NOW()) AS moderado,
        COUNT(*) FILTER (WHERE suitability_profile = 'arrojado'    AND suitability_expires_at > NOW()) AS arrojado
      FROM users
      WHERE COALESCE(is_bot, FALSE) = FALSE
    `);

    res.json({ ok: true, stats: result.rows[0] });
  } catch (err) {
    logger.error('Suitability admin stats error', { error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /suitability/admin/:userId/override
 * Sobrescreve o perfil de um usuário manualmente (ex: revisão por compliance officer).
 * Body: { profile: 'conservador'|'moderado'|'arrojado', reason: string }
 */
router.post('/admin/:userId/override', adminAuth, async (req, res) => {
  const { userId } = req.params;
  const { profile, reason } = req.body;

  const validProfiles = Object.keys(PROFILES);
  if (!validProfiles.includes(profile)) {
    return res.status(400).json({ error: `Perfil inválido. Use: ${validProfiles.join(', ')}` });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Motivo da sobrescrita é obrigatório' });
  }

  try {
    const user = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const expiresAt = calcExpiresAt();

    await pool.query(`
      UPDATE users SET
        suitability_profile      = $1,
        suitability_score        = NULL,
        suitability_completed_at = NOW(),
        suitability_expires_at   = $2
      WHERE id = $3
    `, [profile, expiresAt, userId]);

    await pool.query(`
      INSERT INTO suitability_responses
        (user_id, answers, profile, score, expires_at, overridden_by)
      VALUES ($1, $2, $3, NULL, $4, 'admin')
    `, [userId, JSON.stringify({ override: true, reason }), profile, expiresAt]);

    logger.info('Suitability profile overridden by admin', {
      targetUserId: userId,
      username: user.rows[0].username,
      profile,
      reason
    });

    res.json({
      ok: true,
      message: `Perfil de ${user.rows[0].username} alterado para ${profile}`
    });
  } catch (err) {
    logger.error('Suitability admin override error', { userId, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
