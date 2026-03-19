/**
 * didit-bureau.js — Integração com Didit KYC (https://didit.me)
 *
 * Fluxo assíncrono:
 *  1. Backend cria sessão → recebe verification_url
 *  2. Usuário é redirecionado para Didit (foto doc + selfie)
 *  3. Didit notifica via webhook quando concluído
 *  4. Backend atualiza status do usuário
 *
 * Variáveis de ambiente:
 *   DIDIT_API_KEY      — API Key (x-api-key)
 *   DIDIT_WORKFLOW_ID  — Workflow ID do console Didit (ou APP_ID)
 *   DIDIT_WEBHOOK_SECRET — Secret para verificar assinatura do webhook
 */

const crypto = require('crypto');
const logger  = require('./logger');

const DIDIT_API_BASE = 'https://verification.didit.me';

// ── Criar sessão de verificação ──────────────────────────────────────────────

/**
 * Cria uma sessão de verificação de identidade no Didit.
 * @returns {Promise<{ session_id, verification_url, session_token }>}
 */
async function createDiditSession({ userId, fullName, cpf, dateOfBirth, callbackUrl }) {
  const apiKey    = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;

  if (!apiKey || !workflowId) {
    throw new Error('DIDIT_API_KEY e DIDIT_WORKFLOW_ID são obrigatórios no Railway.');
  }

  // Separar primeiro e último nome para expected_details
  const parts     = (fullName || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  // Nota: expected_details é opcional. Incluímos apenas first_name e last_name
  // pois date_of_birth não é suportado por todos os workflows Didit v3.
  const body = {
    workflow_id: workflowId,
    callback:    callbackUrl,
    vendor_data: String(userId),
    expected_details: {
      first_name: firstName,
      last_name:  lastName,
    },
  };

  logger.info('[DIDIT] Criando sessão de verificação', {
    userId,
    workflowId,
    callbackUrl,
  });

  const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
    method:  'POST',
    headers: {
      'x-api-key':    apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error('[DIDIT] Falha ao criar sessão', { status: res.status, err, userId });
    throw new Error(`Didit session error ${res.status}: ${err}`);
  }

  const data = await res.json();
  logger.info('[DIDIT] Sessão criada com sucesso', {
    userId,
    sessionId: data.session_id,
    status:    data.status,
  });

  return data;
}

// ── Consultar decisão da sessão ──────────────────────────────────────────────

/**
 * Busca o resultado de uma sessão via polling (alternativa ao webhook).
 */
async function getSessionDecision(sessionId) {
  const apiKey = process.env.DIDIT_API_KEY;

  const res = await fetch(`${DIDIT_API_BASE}/v3/session/${sessionId}/decision/`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Didit decision fetch error ${res.status}: ${err}`);
  }

  return await res.json();
}

// ── Verificar assinatura do webhook ─────────────────────────────────────────

/**
 * Verifica a assinatura HMAC do webhook do Didit.
 * Retorna true se válida (ou se DIDIT_WEBHOOK_SECRET não estiver configurado).
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;

  // Se não configurado, aceitar (sem validação)
  if (!secret) {
    logger.warn('[DIDIT] DIDIT_WEBHOOK_SECRET não configurado — webhook aceito sem validação');
    return true;
  }

  // Verificar timestamp (janela de 5 minutos)
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp || '0')) > 300) {
    logger.warn('[DIDIT] Webhook rejeitado: timestamp muito antigo', { timestamp });
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature || '', 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Mapear status do Didit para status interno ───────────────────────────────

/**
 * Converte status do Didit para o status KYC interno.
 *
 * Didit statuses: "Not Started" | "In Progress" | "In Review" |
 *                 "Approved" | "Declined" | "Abandoned" | "Expired"
 */
function mapDiditStatus(diditStatus) {
  switch (diditStatus) {
    case 'Approved':    return 'approved';
    case 'Declined':    return 'rejected';
    case 'In Review':   return 'submitted'; // revisão manual no Didit
    case 'In Progress':
    case 'Not Started': return 'submitted'; // em andamento
    case 'Abandoned':
    case 'Expired':     return 'pending';   // precisa tentar novamente
    default:            return 'submitted';
  }
}

module.exports = {
  createDiditSession,
  getSessionDecision,
  verifyWebhookSignature,
  mapDiditStatus,
};
