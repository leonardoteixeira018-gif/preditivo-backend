const router = require('express').Router();
const pool = require('../lib/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const { createEmailVerification, consumeEmailVerification } = require('../lib/emailVerification');
const { APP_BRAND } = require('../lib/appConfig');

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
    const { name, email, password, ref } = req.body;
    const cleanName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!cleanName || !normalizedEmail || !password) {
      return res.status(400).json({ error: 'name, email e password sao obrigatorios' });
    }

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email ja cadastrado' });

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
        referred_by: referrerId
      },
      subject: `Confirme seu cadastro na ${APP_BRAND}`,
      heading: 'Confirme seu cadastro',
      intro: `Use o codigo abaixo para concluir a criacao da sua conta na ${APP_BRAND} para ${cleanName}.`
    });

    res.json({
      ok: true,
      requires_verification: true,
      email: normalizedEmail,
      message: 'Enviamos um codigo de verificacao para o seu email.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (!result.rows.length) return res.status(400).json({ error: 'Usuario nao encontrado' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Senha incorreta' });

    if (user.two_fa_enabled) {
      await send2faCode(user);
      return res.json({ requires_2fa: true, email: user.email });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
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
    res.status(500).json({ error: err.message });
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
      'SELECT id, username AS name, email, balance, bonus_balance, two_fa_enabled, avatar_url FROM users WHERE id = $1',
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
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      await pool.query('INSERT INTO blacklisted_tokens (token) VALUES ($1) ON CONFLICT DO NOTHING', [token]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

module.exports = router;
