/**
 * Futoro — Templates de email transacional
 * Todos os emails passam por emailBase() para garantir identidade visual consistente.
 */

const { APP_URL } = require('./appConfig');

const BLUE   = '#60a5fa';
const GREEN  = '#10b981';
const RED    = '#f43f5e';
const BG     = '#080c14';
const CARD   = '#0d1221';
const BORDER = 'rgba(255,255,255,0.07)';
const TEXT   = '#e2e8f0';
const MUTED  = '#64748b';

/** Envelope HTML comum a todos os emails */
function emailBase(content, preheader = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Futoro</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:'Helvetica Neue',Arial,sans-serif;color:${TEXT}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${preheader}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:${CARD};border:1px solid ${BORDER};border-radius:16px;overflow:hidden">
      <!-- Header -->
      <tr>
        <td style="padding:24px 32px;border-bottom:1px solid ${BORDER};background:rgba(96,165,250,0.04)">
          <span style="font-size:1.3rem;font-weight:800;letter-spacing:0.02em;color:${TEXT}">
            Futoro<span style="color:${BLUE}">.</span>
          </span>
        </td>
      </tr>
      <!-- Body -->
      <tr><td style="padding:32px">${content}</td></tr>
      <!-- Footer -->
      <tr>
        <td style="padding:20px 32px;border-top:1px solid ${BORDER};background:rgba(0,0,0,0.2)">
          <p style="margin:0;font-size:0.75rem;color:${MUTED};line-height:1.5">
            Este é um email automático da Futoro. Não responda a este email.<br>
            Dúvidas? <a href="mailto:suporte@futoro.com.br" style="color:${BLUE};text-decoration:none">suporte@futoro.com.br</a>
          </p>
          <p style="margin:8px 0 0;font-size:0.72rem;color:rgba(100,116,139,0.6)">
            © 2026 Futoro · Mercados de Previsão ·
            <a href="${APP_URL}/privacidade.html" style="color:rgba(100,116,139,0.6);text-decoration:none">Privacidade</a>
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function h1(text) {
  return `<h1 style="margin:0 0 8px;font-size:1.4rem;font-weight:700;color:${TEXT}">${text}</h1>`;
}
function p(text, color) {
  return `<p style="margin:0 0 16px;font-size:0.9rem;line-height:1.6;color:${color || MUTED}">${text}</p>`;
}
function card(content) {
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid ${BORDER};border-radius:10px;padding:20px;margin:20px 0">${content}</div>`;
}
function row(label, value, valueColor) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
    <span style="font-size:0.83rem;color:${MUTED}">${label}</span>
    <span style="font-size:0.83rem;font-weight:600;color:${valueColor || TEXT}">${value}</span>
  </div>`;
}
function btn(text, url, color) {
  const bg = color || BLUE;
  const fg = bg === BLUE ? '#0a0e1a' : '#fff';
  return `<a href="${url}" style="display:inline-block;background:${bg};color:${fg};font-weight:700;font-size:0.88rem;padding:12px 28px;border-radius:8px;text-decoration:none;margin-top:8px">${text}</a>`;
}

// ── Templates individuais ─────────────────────────────────────────────────────

function welcomeEmail(name) {
  return emailBase(
    h1(`Bem-vindo(a), ${name}! 🎉`) +
    p(`Sua conta na <strong style="color:${TEXT}">Futoro</strong> foi criada com sucesso. Você já pode explorar os mercados de previsão e começar a operar.`) +
    card(
      `<div style="font-size:0.83rem;color:${MUTED};line-height:1.8">
        <div>✅ <strong style="color:${TEXT}">Deposite</strong> a partir de R$10 via PIX</div>
        <div>✅ <strong style="color:${TEXT}">Opere</strong> em mercados de política, economia, esportes e tech</div>
        <div>✅ <strong style="color:${TEXT}">Saque</strong> seus lucros a qualquer momento</div>
      </div>`
    ) +
    btn('Explorar mercados →', APP_URL),
    `Bem-vindo(a) à Futoro, ${name}! Sua conta está pronta.`
  );
}

function marketWonEmail(username, marketTitle, betAmount, payout) {
  return emailBase(
    `<div style="text-align:center;margin-bottom:24px">
      <div style="font-size:2.5rem;margin-bottom:8px">🏆</div>
      ${h1('Você acertou!')}
      ${p(`Parabéns, <strong style="color:${TEXT}">${username}</strong>! Sua previsão estava correta.`)}
    </div>` +
    card(
      row('Mercado', marketTitle.length > 45 ? marketTitle.slice(0, 42) + '…' : marketTitle) +
      row('Sua operação', `R$${parseFloat(betAmount).toFixed(2)}`) +
      row('Retorno creditado', `R$${parseFloat(payout).toFixed(2)}`, GREEN)
    ) +
    btn('Ver meu saldo →', APP_URL, GREEN),
    `Você ganhou R$${parseFloat(payout).toFixed(2)} na Futoro!`
  );
}

function marketLostEmail(username, marketTitle, betAmount, betSide, outcome) {
  return emailBase(
    h1('Resultado do mercado') +
    p(`Olá, <strong style="color:${TEXT}">${username}</strong>. O mercado foi resolvido.`) +
    card(
      row('Mercado', marketTitle.length > 45 ? marketTitle.slice(0, 42) + '…' : marketTitle) +
      row('Resultado', outcome.toUpperCase(), RED) +
      row('Sua operação', `R$${parseFloat(betAmount).toFixed(2)} em ${betSide.toUpperCase()}`)
    ) +
    p('Não desanime — cada operação é uma oportunidade de aprender. Explore novos mercados e tente novamente.') +
    btn('Ver mercados →', APP_URL),
    `Resultado: ${outcome.toUpperCase()} — veja os mercados abertos.`
  );
}

function depositConfirmedEmail(username, amount) {
  return emailBase(
    `<div style="text-align:center;margin-bottom:24px">
      <div style="font-size:2.5rem;margin-bottom:8px">✅</div>
      ${h1('Depósito confirmado!')}
    </div>` +
    p(`Olá, <strong style="color:${TEXT}">${username}</strong>! Seu depósito foi processado e o saldo já está disponível.`) +
    card(row('Valor creditado', `R$${parseFloat(amount).toFixed(2)}`, GREEN)) +
    btn('Explorar mercados →', APP_URL, GREEN),
    `R$${parseFloat(amount).toFixed(2)} adicionado ao seu saldo.`
  );
}

function withdrawalApprovedEmail(username, amount) {
  return emailBase(
    `<div style="text-align:center;margin-bottom:24px">
      <div style="font-size:2.5rem;margin-bottom:8px">💸</div>
      ${h1('Saque aprovado!')}
    </div>` +
    p(`Olá, <strong style="color:${TEXT}">${username}</strong>! Seu saque foi aprovado e está sendo processado.`) +
    card(row('Valor solicitado', `R$${parseFloat(amount).toFixed(2)}`, BLUE)) +
    p('O valor será creditado em sua chave PIX em até 1 dia útil.') +
    btn('Ver extrato →', `${APP_URL}/profile.html`),
    `Seu saque de R$${parseFloat(amount).toFixed(2)} foi aprovado.`
  );
}

function withdrawalRejectedEmail(username, amount, reason) {
  return emailBase(
    h1('Saque não aprovado') +
    p(`Olá, <strong style="color:${TEXT}">${username}</strong>. Infelizmente seu saque não pôde ser processado.`) +
    card(
      row('Valor solicitado', `R$${parseFloat(amount).toFixed(2)}`) +
      (reason ? row('Motivo', reason) : '')
    ) +
    p('O valor foi devolvido ao seu saldo. Entre em contato se precisar de ajuda.') +
    btn('Falar com suporte →', 'mailto:suporte@futoro.com.br'),
    `Seu saque de R$${parseFloat(amount).toFixed(2)} não foi aprovado.`
  );
}

module.exports = {
  welcomeEmail,
  marketWonEmail,
  marketLostEmail,
  depositConfirmedEmail,
  withdrawalApprovedEmail,
  withdrawalRejectedEmail,
};
