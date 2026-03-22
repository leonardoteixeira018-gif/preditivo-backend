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

const logger = (() => {
  try { return require('./logger'); } catch { return console; }
})();

function getKey() {
  const hex = process.env.CPF_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null; // sem chave → modo plaintext
  return Buffer.from(hex, 'hex');
}

function isEncryptionEnabled() {
  return !!getKey();
}

/**
 * Criptografa um CPF com AES-256-GCM.
 * Se CPF_ENCRYPTION_KEY não estiver configurada, armazena em plaintext com aviso.
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — "enc:iv:tag:cipher" ou plaintext se chave ausente
 */
function encryptCPF(cpf) {
  const key = getKey();
  if (!key) {
    logger.warn('[cpf-crypto] CPF_ENCRYPTION_KEY não configurada — armazenando plaintext. Configure a chave para conformidade LGPD Art. 46.');
    return cpf; // fallback: plaintext (inseguro, apenas para desenvolvimento)
  }
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
    return stored; // Valor legado ou plaintext (sem chave) — retorna como está
  }
  const key = getKey();
  if (!key) {
    logger.warn('[cpf-crypto] CPF_ENCRYPTION_KEY não configurada — não é possível descriptografar valor criptografado.');
    return null;
  }
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
 * Se chave ausente, retorna HMAC com chave derivada do CPF (menos seguro mas funcional).
 * @param {string} cpf — CPF normalizado (somente dígitos)
 * @returns {string} — HMAC hex
 */
function cpfHmac(cpf) {
  const key = getKey();
  if (!key) {
    // Sem chave: usa SHA-256 simples para busca de duplicatas (sem HMAC)
    return crypto.createHash('sha256').update(cpf, 'utf8').digest('hex');
  }
  return crypto.createHmac('sha256', key).update(cpf, 'utf8').digest('hex');
}

module.exports = { encryptCPF, decryptCPF, cpfHmac };
