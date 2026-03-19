const router = require('express').Router();
const pool = require('../lib/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../lib/logger');
const auth = require('../middleware/auth');
const { createEmailVerification, consumeEmailVerification } = require('../lib/emailVerification');
const { APP_BRAND } = require('../lib/appConfig');
const { getUserAuditLogs, logUserAction } = require('../lib/user-audit');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

async function send2faCode(user) {
  return createEmailVerification({
    purpose: '2fa_login',
    email: user.email,
    userId: user.id,
    payload: {},
    subject: `Codigo de acesso — ${APP_BRAND}`,
    heading: 'Verificação em duas etapas',
    intro: `Use o codigo abaixo para entrar na sua conta na ${APP_BRAND}.`
  });
}

function generateCode(username) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return (String(username || '').substring(0, 4).toUpperCase() + rand).substring(0, 8);
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, ref, lgpd_consent } = req.body;
    const cleanName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    logger.info('User registration attempt', {
      email: normalizedEmail,
      ip: req.ip,
      hasReferral: !!ref
    });

    if (!lgpd_consent) {
      return res.status(400).json({ error: 'Consentimento LGPD obrigatório' });
    }

    if (!cleanName || !normalizedEmail || !password) {
      logger.warn('Registration validation failed', {
        email: normalizedEmail,
        reason: 'missing_fields',
        ip: req.ip
      });
      return res.status(400).json({ error: 'name, email e password sao obrigatorios' });
    }

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (exists.rows.length) {
      logger.warn('Registration failed - email already exists', {
        email: normalizedEmail,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Email ja cadastrado' });
    }

    const usernameExists = await pool.query('SELECT id FROM users WHERE username = $1', [cleanName]);
    if (usernameExists.rows.length) return res.status(400).json({ error: 'Nome de usuario ja cadastrado' });

    const hash = await bcrypt.hash(password, 10);

    let referralCode = generateCode(cleanName);
    const codeExists = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
    if (codeExists.rows.length) {
      referralCode = referralCode.substring(0, 6) + Math.floor(Math.random() * 99);
    }

    let referrerId = null;
    if (ref) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref]);
      if (referrer.rows.length) referrerId = referrer.rows[0].id;
    }

    await createEmailVerification({
      purpose: 'register',
      email: normalizedEmail,
      payload: {
        name: cleanName,
        password_hash: hash,
        referral_code: referralCode,
        referred_by: referrerId,
        lgpd_consent: true,
        lgpd_ip: req.ip,
        lgpd_user_agent: req.headers['user-agent'] || null
      },
      subject: `Confirme seu cadastro na ${APP_BRAND}`,
      heading: 'Confirme seu cadastro',
      intro: `Use o codigo abaixo para concluir a criacao da sua conta na ${APP_BRAND} para ${cleanName}.`
    });

    logger.info('Registration email verification sent', {
      email: normalizedEmail,
      ip: req.ip
    });

    res.json({
      ok: true,
      requires_verification: true,
      email: normalizedEmail,
      message: 'Enviamos um codigo de verificacao para o seu email.'
    });
  } catch (err) {
    logger.error('Registration failed', {
      email: req.body.email,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao registrar. Tente novamente.' });
  }
});

router.post('/register/verify', async (req, res) => {
  const client = await pool.connect();

  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    if (!normalizedEmail || !code) {
      return res.status(400).json({ error: 'email e code sao obrigatorios' });
    }

    await client.query('BEGIN');

    const verification = await consumeEmailVerification({
      purpose: 'register',
      email: normalizedEmail,
      code,
      db: client
    });

    const payload = verification.payload || {};
    const exists = await client.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [normalizedEmail, payload.name]
    );
    if (exists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Conta ja criada com este email ou usuario' });
    }

    const result = await client.query(
      `INSERT INTO users (
         username, email, password_hash, referral_code, referred_by,
         balance, bonus_balance, bonus_locked, bonus_bets_count, first_deposit_done, email_verified_at
       )
       VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, FALSE, NOW())
       RETURNING id, username AS name, email, balance, bonus_balance`,
      [payload.name, normalizedEmail, payload.password_hash, payload.referral_code, payload.referred_by]
    );

    const newUserId = result.rows[0].id;

    // BLOCO 7: LGPD — registrar consentimento de privacidade
    if (payload.lgpd_consent) {
      await client.query(
        `INSERT INTO lgpd_consents (user_id, consent_type, policy_version, ip_address, user_agent)
         VALUES ($1, 'registration', 'v1.0', $2, $3)`,
        [newUserId, payload.lgpd_ip || null, payload.lgpd_user_agent || null]
      ).catch(() => {});
      await client.query(
        `UPDATE users SET lgpd_consent_at = NOW(), lgpd_consent_ip = $1 WHERE id = $2`,
        [payload.lgpd_ip || null, newUserId]
      ).catch(() => {});
    }

    await client.query('COMMIT');
    const { sendEmail } = require('../lib/email');
    await sendEmail(
      normalizedEmail,
      `Boas-vindas a ${APP_BRAND}!`,
      `<h1>Ola, ${payload.name}!</h1>
       <p>Seu cadastro na ${APP_BRAND} foi confirmado com sucesso.</p>
       <p>Voce ja pode comecar a apostar nos seus mercados favoritos.</p>
       <p><a href="${process.env.APP_URL || '#'}">Clique aqui para acessar a plataforma</a></p>`
    );

    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    res.json({ token, user: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const status = /Codigo|Conta ja criada/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const { password } = req.body;

    logger.info('Login attempt', {
      email: normalizedEmail,
      ip: req.ip
    });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (!result.rows.length) {
      logger.warn('Login failed - user not found', {
        email: normalizedEmail,
        ip: req.ip
      });
      return res.status(400).json({ error: 'Usuario nao encontrado' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn('Login failed - invalid password', {
        email: normalizedEmail,
        ip: req.ip,
        userId: user.id
      });
      return res.status(400).json({ error: 'Senha incorreta' });
    }

    if (user.two_fa_enabled) {
      logger.info('2FA TOTP required', {
        email: normalizedEmail,
        userId: user.id,
        ip: req.ip
      });
      const tempToken = jwt.sign(
        { userId: user.id, two_fa_pending: true },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ ok: true, requires_2fa: true, temp_token: tempToken });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    logger.info('User login successful', {
      email: normalizedEmail,
      userId: user.id,
      ip: req.ip
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.username,
        email: user.email,
        balance: user.balance,
        bonus_balance: user.bonus_balance
      }
    });
  } catch (err) {
    logger.error('Login error', {
      email: req.body.email,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao fazer login. Tente novamente.' });
  }
});

// Verificar código 2FA após login
router.post('/login/2fa', async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    if (!normalizedEmail || !code) {
      return res.status(400).json({ error: 'email e code sao obrigatorios' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (!userResult.rows.length) return res.status(400).json({ error: 'Usuario nao encontrado' });
    const user = userResult.rows[0];

    await consumeEmailVerification({ purpose: '2fa_login', email: normalizedEmail, userId: user.id, code });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.username,
        email: user.email,
        balance: user.balance,
        bonus_balance: user.bonus_balance
      }
    });
  } catch (err) {
    const status = /invalido|expirado|nao encontrado/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Enviar código para ativar 2FA
router.post('/2fa/enable', auth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    await createEmailVerification({
      purpose: '2fa_enable',
      email: user.email,
      userId: user.id,
      payload: {},
      subject: `Ativar verificação em duas etapas — ${APP_BRAND}`,
      heading: 'Ativar verificação em duas etapas',
      intro: `Use o codigo abaixo para confirmar a ativação do 2FA na sua conta na ${APP_BRAND}.`
    });
    res.json({ ok: true, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmar código e habilitar 2FA
router.post('/2fa/enable/verify', auth, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    await consumeEmailVerification({ purpose: '2fa_enable', email: user.email, userId: user.id, code });
    await pool.query('UPDATE users SET two_fa_enabled = true WHERE id = $1', [user.id]);
    res.json({ ok: true, two_fa_enabled: true });
  } catch (err) {
    const status = /invalido|expirado|nao encontrado/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Desativar 2FA (pede senha para confirmar)
router.post('/2fa/disable', auth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password obrigatorio' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Senha incorreta' });

    await pool.query('UPDATE users SET two_fa_enabled = false WHERE id = $1', [user.id]);
    res.json({ ok: true, two_fa_enabled: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username AS name, email, balance, bonus_balance, two_fa_enabled, avatar_url,
              kyc_status, kyc_submitted_at, kyc_approved_at, kyc_rejected_at, kyc_rejection_reason,
              suitability_profile, suitability_score, suitability_completed_at, suitability_expires_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, password, avatar_url } = req.body;

    // Validar tamanho do avatar (base64 ~700KB limit → ~512KB imagem)
    if (avatar_url && avatar_url.length > 720000) {
      return res.status(400).json({ error: 'Imagem muito grande. Use uma foto menor.' });
    }

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE users SET username = $1, password_hash = $2, avatar_url = COALESCE($3, avatar_url) WHERE id = $4',
        [name, hash, avatar_url || null, req.user.id]
      );
    } else if (avatar_url !== undefined) {
      // Pode atualizar só o avatar sem nome/senha
      await pool.query(
        'UPDATE users SET username = $1, avatar_url = $2 WHERE id = $3',
        [name || req.user.id, avatar_url, req.user.id]
      );
    } else {
      await pool.query('UPDATE users SET username = $1 WHERE id = $2', [name, req.user.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', auth, async (req, res) => {
  try {
    const token = req.authToken;
    if (token) {
      await pool.query('INSERT INTO blacklisted_tokens (token) VALUES ($1) ON CONFLICT DO NOTHING', [token]);
    }
    clearAuthCookie(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /audit/my-logs — recupera histórico de auditoria do usuário
router.get('/audit/my-logs', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 100, 10), 500); // Max 500 logs
    const logs = await getUserAuditLogs(req.user.id, limit);

    logger.info('User audit logs retrieved', {
      userId: req.user.id,
      logCount: logs.length,
      ip: req.ip
    });

    res.json({
      ok: true,
      logs,
      count: logs.length
    });
  } catch (err) {
    logger.error('Failed to retrieve user audit logs', {
      userId: req.user.id,
      error: err.message,
      stack: err.stack,
      ip: req.ip
    });
    res.status(500).json({ error: 'Erro ao buscar histórico de auditoria' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email e obrigatorio' });

    const user = await pool.query('SELECT id, username FROM users WHERE email = $1', [email]);
    if (!user.rows.length) {
      return res.json({ ok: true, message: 'Se o email existir, enviamos as instrucoes' });
    }

    const row = user.rows[0];
    await createEmailVerification({
      purpose: 'password_reset',
      email,
      userId: row.id,
      subject: `Recuperacao de senha — ${APP_BRAND}`,
      heading: 'Recuperacao de senha',
      intro: `Ola, ${row.username}. Use o codigo abaixo para resetar sua senha.`
    });

    res.json({ ok: true, message: 'Enviamos um codigo para o seu email' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!normalizedEmail || !code || !password) {
      return res.status(400).json({ error: 'Email, codigo e senha sao obrigatorios' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no minimo 6 caracteres' });
    }

    await client.query('BEGIN');
    const verification = await consumeEmailVerification({
      purpose: 'password_reset',
      email: normalizedEmail,
      code,
      db: client
    });

    const hash = await bcrypt.hash(password, 10);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, verification.user_id]);
    await client.query('COMMIT');

    const { sendEmail } = require('../lib/email');
    await sendEmail(
      normalizedEmail,
      `Senha redefinida — ${APP_BRAND}`,
      `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2>Senha redefinida com sucesso</h2>
        <p>Voce ja pode fazer login com a nova senha.</p>
        <p style="color:#888;font-size:14px">Se nao foi voce, entre em contato com o suporte imediatamente.</p>
      </div>`
    );

    res.json({ ok: true, message: 'Senha atualizada com sucesso' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const status = /Codigo/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── BLOCO 5: Termo de Ciência de Riscos ──────────────────────────────────────

const CURRENT_TERM_VERSION = 'v1.0';

// GET /auth/risk-term-status — retorna status de aceite do termo de riscos
router.get('/risk-term-status', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT risk_term_accepted_at, risk_term_version FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    const accepted = !!(row?.risk_term_accepted_at && row?.risk_term_version === CURRENT_TERM_VERSION);
    res.json({
      accepted,
      accepted_at: row?.risk_term_accepted_at || null,
      term_version: row?.risk_term_version || null,
      current_version: CURRENT_TERM_VERSION,
    });
  } catch (err) {
    logger.error('risk-term-status error', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /auth/accept-risk-term — registra aceite do termo de riscos
router.post('/accept-risk-term', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] || null;

    // Registra na tabela de histórico
    await pool.query(
      `INSERT INTO risk_term_acceptances (user_id, term_version, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [userId, CURRENT_TERM_VERSION, ip, userAgent]
    );

    // Atualiza users
    await pool.query(
      `UPDATE users SET risk_term_accepted_at = NOW(), risk_term_version = $1 WHERE id = $2`,
      [CURRENT_TERM_VERSION, userId]
    );

    logger.info('Termo de riscos aceito', { userId, termVersion: CURRENT_TERM_VERSION, ip });

    res.json({
      ok: true,
      accepted_at: new Date().toISOString(),
      term_version: CURRENT_TERM_VERSION,
    });
  } catch (err) {
    logger.error('accept-risk-term error', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── BLOCO 7: LGPD (Lei 13.709/2018) ──────────────────────────────────────────

// GET /auth/my-data — Direito de acesso (Art. 18 LGPD)
router.get('/my-data', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRes, betsRes, depositsRes, withdrawalsRes, kycRes, suitRes] = await Promise.all([
      pool.query(
        `SELECT id, username, email, full_name, cpf, date_of_birth,
                balance, bonus_balance, created_at, email_verified_at,
                kyc_status, kyc_submitted_at, kyc_approved_at,
                suitability_profile, suitability_score, suitability_completed_at,
                risk_term_accepted_at, risk_term_version,
                lgpd_consent_at, lgpd_consent_ip, data_deletion_requested_at,
                pep_status, sanctions_status, wallet_address, avatar_url
         FROM users WHERE id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT id, market_id, side, amount, potential_payout, payout, status, created_at
         FROM bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId]
      ),
      pool.query(
        `SELECT id, amount, method, status, created_at
         FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId]
      ),
      pool.query(
        `SELECT id, amount, pix_key_type, status, created_at
         FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId]
      ),
      pool.query(
        `SELECT id, action, actor, notes, provider, created_at
         FROM kyc_reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, profile, score, completed_at, expires_at
         FROM suitability_responses WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 10`,
        [userId]
      ).catch(() => ({ rows: [] }))
    ]);

    if (!userRes.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    logger.info('LGPD my-data accessed', { userId, ip: req.ip });

    res.json({
      ok: true,
      user: userRes.rows[0],
      bets: betsRes.rows,
      deposits: depositsRes.rows,
      withdrawals: withdrawalsRes.rows,
      kyc_history: kycRes.rows,
      suitability_history: suitRes.rows
    });
  } catch (err) {
    logger.error('my-data error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// POST /auth/request-data-deletion — Direito ao esquecimento (Art. 18 VI LGPD)
router.post('/request-data-deletion', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const ip = req.ip;

    // Verificar saldo
    const userRes = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const balance = parseFloat(userRes.rows[0].balance || 0);
    if (balance > 0) {
      return res.status(400).json({
        error: `Você possui saldo de R$${balance.toFixed(2)}. Saque todo o saldo antes de solicitar a exclusão.`
      });
    }

    // Verificar se já existe request pendente
    const existing = await pool.query(
      `SELECT id FROM data_deletion_requests WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Já existe uma solicitação de exclusão pendente para sua conta.' });
    }

    // Registrar solicitação
    await pool.query(
      `INSERT INTO data_deletion_requests (user_id, ip_address) VALUES ($1, $2)`,
      [userId, ip]
    );

    // Marcar no usuário
    await pool.query(
      `UPDATE users SET data_deletion_requested_at = NOW() WHERE id = $1`,
      [userId]
    );

    logger.info('Data deletion requested', { userId, ip });

    res.json({
      ok: true,
      message: 'Solicitação registrada. Seus dados serão removidos em até 30 dias conforme Art. 18 da Lei 13.709/2018.'
    });
  } catch (err) {
    logger.error('request-data-deletion error', { error: err.message });
    res.status(500).json({ error: 'Erro ao registrar solicitação' });
  }
});

// ── BLOCO 8: 2FA TOTP (Google Authenticator / Authy) ─────────────────────────

// POST /auth/2fa/setup — Gera secret TOTP e QR code (sem ativar ainda)
router.post('/2fa/setup', auth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    if (user.two_fa_enabled) {
      return res.status(400).json({ error: '2FA já está ativo nesta conta.' });
    }

    const secret = speakeasy.generateSecret({
      name: 'Bubuya (' + user.email + ')',
      issuer: 'Bubuya'
    });

    await pool.query(
      'UPDATE users SET two_fa_secret = $1 WHERE id = $2',
      [secret.base32, user.id]
    );

    const qr_code = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      qr_code,
      secret: secret.base32,
      message: 'Escaneie o QR code no Google Authenticator ou Authy'
    });
  } catch (err) {
    logger.error('2fa/setup error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/2fa/verify-setup — Confirma código TOTP e ativa 2FA
router.post('/2fa/verify-setup', auth, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    if (!user.two_fa_secret) {
      return res.status(400).json({ error: 'Inicie o setup primeiro em /auth/2fa/setup' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.two_fa_secret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!verified) {
      return res.status(400).json({ error: 'Código inválido. Verifique o app e tente novamente.' });
    }

    await pool.query(
      'UPDATE users SET two_fa_enabled = TRUE, two_fa_enabled_at = NOW() WHERE id = $1',
      [user.id]
    );

    logUserAction({ userId: user.id, action: '2fa_enabled', resourceType: 'user', resourceId: user.id, ipAddress: req.ip });

    res.json({ ok: true, message: 'Autenticação de dois fatores ativada com sucesso!' });
  } catch (err) {
    logger.error('2fa/verify-setup error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/2fa/disable — Desativar 2FA (requer código TOTP atual)
router.post('/2fa/disable', auth, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    if (!user.two_fa_enabled || !user.two_fa_secret) {
      return res.status(400).json({ error: '2FA não está ativo nesta conta.' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.two_fa_secret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!verified) {
      return res.status(401).json({ error: 'Código inválido. Verifique o app e tente novamente.' });
    }

    await pool.query(
      'UPDATE users SET two_fa_enabled = FALSE, two_fa_secret = NULL, two_fa_enabled_at = NULL WHERE id = $1',
      [user.id]
    );

    logUserAction({ userId: user.id, action: '2fa_disabled', resourceType: 'user', resourceId: user.id, ipAddress: req.ip });

    res.json({ ok: true, message: '2FA desativado.' });
  } catch (err) {
    logger.error('2fa/disable error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/2fa/validate — Valida código TOTP durante login (usa temp_token)
router.post('/2fa/validate', async (req, res) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) {
      return res.status(400).json({ error: 'temp_token e code são obrigatórios' });
    }

    let payload;
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    if (!payload.two_fa_pending || !payload.userId) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!userResult.rows.length) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    const user = userResult.rows[0];

    if (!user.two_fa_enabled || !user.two_fa_secret) {
      return res.status(401).json({ error: '2FA não está ativo nesta conta.' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.two_fa_secret,
      encoding: 'base32',
      token: String(code).trim(),
      window: 1
    });

    if (!verified) {
      return res.status(401).json({ error: 'Código inválido ou expirado' });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    logger.info('2FA validate — login successful', { userId: user.id, ip: req.ip });

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.username,
        email: user.email,
        balance: user.balance,
        bonus_balance: user.bonus_balance
      }
    });
  } catch (err) {
    logger.error('2fa/validate error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── BLOCO 9: Auto-exclusão Temporária (Proteção ao Investidor) ────────────────

const ALLOWED_EXCLUSION_PERIODS = [30, 60, 90, 180, 365];

// POST /auth/self-exclude — ativa auto-exclusão temporária
router.post('/self-exclude', auth, async (req, res) => {
  try {
    const { period_days, reason } = req.body;
    const days = parseInt(period_days, 10);

    if (!ALLOWED_EXCLUSION_PERIODS.includes(days)) {
      return res.status(400).json({
        error: `period_days deve ser um dos valores: ${ALLOWED_EXCLUSION_PERIODS.join(', ')}`
      });
    }

    const cleanReason = String(reason || 'Solicitação do usuário').substring(0, 100);

    const result = await pool.query(
      `UPDATE users
       SET self_excluded_until = NOW() + ($1 || ' days')::INTERVAL,
           self_excluded_reason = $2
       WHERE id = $3
       RETURNING self_excluded_until`,
      [days, cleanReason, req.user.id]
    );

    const excluded_until = result.rows[0].self_excluded_until;

    logger.info('User self-excluded', { userId: req.user.id, days, reason: cleanReason, excluded_until, ip: req.ip });

    res.json({
      ok: true,
      excluded_until,
      message: `Conta suspensa temporariamente por ${days} dias.`
    });
  } catch (err) {
    logger.error('self-exclude error', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DELETE /auth/self-exclude — remove auto-exclusão (apenas após prazo ou admin)
router.delete('/self-exclude', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT self_excluded_until FROM users WHERE id = $1',
      [req.user.id]
    );

    const until = result.rows[0]?.self_excluded_until;

    if (until && new Date(until) > new Date()) {
      return res.status(403).json({
        error: 'EXCLUSION_ACTIVE',
        message: 'A auto-exclusão ainda está vigente e não pode ser removida antes do prazo.',
        excluded_until: until
      });
    }

    await pool.query(
      'UPDATE users SET self_excluded_until = NULL, self_excluded_reason = NULL WHERE id = $1',
      [req.user.id]
    );

    logger.info('User self-exclusion removed', { userId: req.user.id, ip: req.ip });

    res.json({ ok: true });
  } catch (err) {
    logger.error('delete self-exclude error', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /auth/self-exclusion-status — consulta status da auto-exclusão
router.get('/self-exclusion-status', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT self_excluded_until, self_excluded_reason FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    const until = row?.self_excluded_until;
    const active = !!(until && new Date(until) > new Date());

    res.json({
      active,
      excluded_until: until || null,
      reason: row?.self_excluded_reason || null
    });
  } catch (err) {
    logger.error('self-exclusion-status error', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
