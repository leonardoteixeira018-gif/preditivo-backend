const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { sendEmail } = require('./email');

const CODE_EXPIRATION_MINUTES = 10;

/**
 * Gera um código OTP de 6 dígitos usando crypto.randomBytes (CSPRNG).
 * Math.random() é pseudoaleatório e inadequado para tokens de segurança.
 */
function generateVerificationCode() {
  // Gera 3 bytes aleatórios (24 bits) → int [0, 16777215]
  // Módulo 900000 reduz bias para < 0.1% — aceitável para OTP de 6 dígitos
  const randomInt = crypto.randomBytes(3).readUIntBE(0, 3) % 900000;
  return String(100000 + randomInt);
}

async function createEmailVerification({
  purpose,
  email,
  payload = {},
  userId = null,
  subject,
  heading,
  intro,
  db = pool
}) {
  const code = generateVerificationCode();
  const codeHash = await bcrypt.hash(code, 8);

  await db.query(
    `DELETE FROM email_verifications
     WHERE purpose = $1
       AND email = $2
       AND consumed_at IS NULL`,
    [purpose, email]
  );

  await db.query(
    `INSERT INTO email_verifications (purpose, email, user_id, code_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '${CODE_EXPIRATION_MINUTES} minutes')`,
    [purpose, email, userId, codeHash, JSON.stringify(payload)]
  );

  await sendEmail(
    email,
    subject,
    `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
        <h2 style="margin:0 0 12px 0">${heading}</h2>
        <p style="font-size:15px;line-height:1.6">${intro}</p>
        <div style="margin:24px 0;padding:16px;border-radius:12px;background:#f3f5f7;text-align:center">
          <div style="font-size:13px;color:#667085;margin-bottom:8px">Codigo de verificacao</div>
          <div style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</div>
        </div>
        <p style="font-size:14px;line-height:1.6;color:#667085">
          Este codigo expira em ${CODE_EXPIRATION_MINUTES} minutos. Se voce nao solicitou esta acao, ignore este email.
        </p>
      </div>
    `,
    { strict: true }
  );

  return { ok: true, expires_in_minutes: CODE_EXPIRATION_MINUTES };
}

async function consumeEmailVerification({ purpose, email, code, userId = null, db = pool }) {
  const result = await db.query(
    `SELECT *
     FROM email_verifications
     WHERE purpose = $1
       AND email = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()
       ${userId ? 'AND user_id = $3' : ''}
     ORDER BY created_at DESC
     LIMIT 1`,
    userId ? [purpose, email, userId] : [purpose, email]
  );

  if (!result.rows.length) {
    throw new Error('Codigo expirado ou nao encontrado');
  }

  const verification = result.rows[0];
  const valid = await bcrypt.compare(String(code || ''), verification.code_hash);
  if (!valid) {
    await db.query(
      'UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1',
      [verification.id]
    );
    throw new Error('Codigo invalido');
  }

  await db.query(
    'UPDATE email_verifications SET consumed_at = NOW() WHERE id = $1',
    [verification.id]
  );

  return verification;
}

module.exports = {
  createEmailVerification,
  consumeEmailVerification,
  CODE_EXPIRATION_MINUTES
};
