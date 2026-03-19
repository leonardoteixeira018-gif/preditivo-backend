/**
 * kyc.js — Utilitários KYC/AML
 * Validação de CPF, helpers de status e monitoramento COAF
 */
const pool = require('./db');
const logger = require('./logger');

// ── CPF VALIDATION ─────────────────────────────────────────────────────────

/**
 * Valida CPF com verificação de dígitos.
 * Aceita formatos: "123.456.789-09" ou "12345678909"
 * @param {string} raw
 * @returns {{ valid: boolean, cleaned: string, error?: string }}
 */
function validateCPF(raw) {
  const cpf = String(raw || '').replace(/\D/g, '');

  if (cpf.length !== 11) {
    return { valid: false, cleaned: cpf, error: 'CPF deve ter 11 dígitos' };
  }

  // Rejeita sequências iguais (111.111.111-11, etc.)
  if (/^(\d)\1{10}$/.test(cpf)) {
    return { valid: false, cleaned: cpf, error: 'CPF inválido' };
  }

  // Calcula primeiro dígito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cpf[i]) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(cpf[9])) {
    return { valid: false, cleaned: cpf, error: 'CPF inválido' };
  }

  // Calcula segundo dígito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cpf[i]) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(cpf[10])) {
    return { valid: false, cleaned: cpf, error: 'CPF inválido' };
  }

  return { valid: true, cleaned: cpf };
}

/**
 * Formata CPF limpo para exibição: "123.456.789-09"
 */
function formatCPF(cpf) {
  const c = String(cpf).replace(/\D/g, '');
  return c.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/**
 * Mascara CPF para logs (exibe apenas últimos 2 dígitos): "***.***.***-09"
 */
function maskCPF(cpf) {
  const c = String(cpf).replace(/\D/g, '');
  return `***.***.**${c.slice(8, 9)}-${c.slice(9)}`;
}

// ── KYC STATUS ──────────────────────────────────────────────────────────────

const KYC_STATUS = {
  PENDING:   'pending',    // Aguardando envio dos dados
  SUBMITTED: 'submitted',  // Dados enviados, aguardando revisão
  APPROVED:  'approved',   // KYC aprovado
  REJECTED:  'rejected',   // KYC rejeitado (requer novo envio)
};

/**
 * Retorna o status KYC atual de um usuário.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getKycStatus(userId) {
  const result = await pool.query(
    'SELECT kyc_status FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0]?.kyc_status || KYC_STATUS.PENDING;
}

/**
 * Verifica se o usuário pode realizar operações financeiras.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isKycApproved(userId) {
  const status = await getKycStatus(userId);
  return status === KYC_STATUS.APPROVED;
}

// ── COAF MONITORING ────────────────────────────────────────────────────────

const COAF_THRESHOLD_MONTH = 10000; // R$ 10.000 acumulados no mês

/**
 * Monitora depósitos para compliance COAF.
 * Se o total acumulado no mês ultrapassar R$ 10.000, cria um flag para revisão.
 * Deve ser chamado após cada confirmação de depósito.
 *
 * @param {string} userId
 * @param {string} depositId
 * @param {number} amount - valor do depósito confirmado
 */
async function checkCoafThreshold(userId, depositId, amount) {
  try {
    // Calcula total do mês corrente (depósitos confirmados)
    const result = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_month
      FROM deposits
      WHERE user_id = $1
        AND status = 'confirmed'
        AND date_trunc('month', created_at) = date_trunc('month', NOW())
    `, [userId]);

    const totalMonth = parseFloat(result.rows[0].total_month);

    if (totalMonth >= COAF_THRESHOLD_MONTH) {
      // Verifica se já existe flag para este mês
      const existing = await pool.query(`
        SELECT id FROM coaf_flags
        WHERE user_id = $1
          AND date_trunc('month', created_at) = date_trunc('month', NOW())
          AND status = 'pending'
        LIMIT 1
      `, [userId]);

      if (!existing.rows.length) {
        await pool.query(`
          INSERT INTO coaf_flags
            (user_id, trigger_deposit_id, total_month_amount, status)
          VALUES ($1, $2, $3, 'pending')
        `, [userId, depositId, totalMonth]);

        logger.warn('COAF: limiar mensal atingido — flag criado para revisão', {
          userId,
          depositId,
          totalMonth,
          threshold: COAF_THRESHOLD_MONTH
        });
      }
    }
  } catch (err) {
    // Não propaga — monitoring não deve quebrar o fluxo principal
    logger.error('COAF threshold check failed', { userId, error: err.message });
  }
}

module.exports = {
  validateCPF,
  formatCPF,
  maskCPF,
  KYC_STATUS,
  getKycStatus,
  isKycApproved,
  checkCoafThreshold,
  COAF_THRESHOLD_MONTH,
};
