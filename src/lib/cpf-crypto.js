/**
 * cpf-crypto.js — Criptografia AES-256-GCM para CPF (LGPD Art. 46)
 *
 * Variável de ambiente OBRIGATÓRIA:
 *   CPF_ENCRYPTION_KEY  — 64 caracteres hex (32 bytes)
 *   Gerar: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Formato em banco:
 *   Valor criptografado: "enc:<iv_hex>:<tag_hex>:<dados_hex>"
 *   Valor legado (plaintext): sequência de dígitos — tratado por decryptCPF sem modificação
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';

const logger = (() => {
  try { return require('./logger'); } catch { return console; }
})();

function getKey() {
  const hex = process.env.CPF_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      '[cpf-crypto] FATAL: CPF_ENCRYPTION_KEY ausente ou invalida (esperado: 64 hex chars). ' +
      'Configure a variavel de ambiente para conformidade LGPD Art. 46.'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Criptografa um CPF com AES-256-GCM.
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — "enc:iv:tag:cipher"
 */
function encryptCPF(cpf) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(cpf, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descriptografa um CPF armazenado em banco.
 * Suporta: valores criptografados ("enc:...") e valores legados (plaintext).
 * @param {string|null} stored — valor do banco
 * @returns {string|null} — CPF em plaintext ou null
 */
function decryptCPF(stored) {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored; // Valor legado (plaintext) — retorna como está
  }
  const key = getKey();
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Formato de CPF criptografado invalido');
  const [ivHex, tagHex, dataHex] = parts;
  const iv  = Buffer.from(ivHex,  'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

/**
 * HMAC-SHA256 determinístico do CPF — usado para busca de duplicatas no banco.
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — HMAC hex
 */
function cpfHmac(cpf) {
  const key = getKey();
  return crypto.createHmac('sha256', key).update(cpf, 'utf8').digest('hex');
}

module.exports = { encryptCPF, decryptCPF, cpfHmac };
