const { APP_BRAND, SUPPORT_EMAIL } = require('./appConfig');

async function sendEmail(to, subject, html, options = {}) {
  const { strict = false } = options;

  try {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY nao configurada');
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: `${APP_BRAND} <${process.env.EMAIL_FROM || SUPPORT_EMAIL}>`,
        to,
        subject,
        html
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Falha ao enviar email');
    }

    return data;
  } catch (err) {
    console.log('Email error:', err.message);
    if (strict) throw err;
    return { error: err.message };
  }
}

module.exports = { sendEmail };
