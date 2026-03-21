/**
 * cpf-crypto.js — Criptografia AES-256-GCM para CPF (LGPD Art. 46)
 *
 * Variável de ambiente obrigatória:
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

function getKey() {
  const hex = process.env.CPF_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'CPF_ENCRYPTION_KEY não configurada ou inválida. ' +
      'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Criptografa um CPF (string de dígitos) com AES-256-GCM.
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — formato "enc:iv:tag:cipher"
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
 * Suporta tanto valores criptografados ("enc:...") quanto valores legados (plaintext).
 * @param {string|null} stored — valor do banco
 * @returns {string|null} — CPF em plaintext ou null
 */
function decryptCPF(stored) {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) {
    // Valor legado (plaintext) — retorna como está
    return stored;
  }
  const key = getKey();
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Formato de CPF criptografado inválido');
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
 * Mesmo CPF → mesmo HMAC (diferente do ciphertext que é sempre único).
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — HMAC hex
 */
function cpfHmac(cpf) {
  const key = getKey();
  return crypto.createHmac('sha256', key).update(cpf, 'utf8').digest('hex');
}

module.exports = { encryptCPF, decryptCPF, cpfHmac };
