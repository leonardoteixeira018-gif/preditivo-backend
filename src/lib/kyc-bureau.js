/**
 * kyc-bureau.js — Interface de integração com bureau de identidade
 *
 * Abstrai a comunicação com provedores externos (Serpro, Idwall, Unico Check).
 * Em modo STUB (padrão atual), simula a resposta do bureau.
 * Para ativar a integração real, configure BUREAU_PROVIDER no .env.
 *
 * BUREAU_PROVIDER=stub    → Modo desenvolvimento (aprovação automática após 2s)
 * BUREAU_PROVIDER=idwall  → Integração Idwall (produção)
 * BUREAU_PROVIDER=serpro  → Integração Serpro (produção)
 */
const logger = require('./logger');

const PROVIDER = process.env.BUREAU_PROVIDER || 'stub';

// ── STUB (desenvolvimento / sandbox CVM) ────────────────────────────────────

async function stubVerifyCPF({ cpf, fullName, dateOfBirth }) {
  // Simula latência de bureau real
  await new Promise(resolve => setTimeout(resolve, 300));

  logger.info('[KYC-BUREAU:stub] CPF verification', {
    cpf: cpf.slice(0, 3) + '***',
    provider: 'stub'
  });

  // Em stub, qualquer CPF válido passa
  return {
    ok: true,
    provider: 'stub',
    providerId: `stub_${Date.now()}`,
    status: 'approved',
    rawResponse: { mode: 'development' }
  };
}

async function stubVerifyDocument({ userId, documentType, documentFront, documentBack, selfie }) {
  await new Promise(resolve => setTimeout(resolve, 300));

  logger.info('[KYC-BUREAU:stub] Document verification', {
    userId,
    documentType,
    provider: 'stub'
  });

  return {
    ok: true,
    provider: 'stub',
    providerId: `stub_doc_${Date.now()}`,
    status: 'submitted', // Em stub, documento vai para revisão manual
    rawResponse: { mode: 'development' }
  };
}

// ── IDWALL (produção) ───────────────────────────────────────────────────────

async function idwallVerifyCPF({ cpf, fullName, dateOfBirth }) {
  const apiKey = process.env.IDWALL_API_KEY;
  if (!apiKey) throw new Error('IDWALL_API_KEY não configurada');

  const response = await fetch('https://api-v2.idwall.co/reports/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey
    },
    body: JSON.stringify({
      matrix: 'default_cpf',
      parameters: {
        'cpf': cpf,
        'nome': fullName,
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('[KYC-BUREAU:idwall] CPF verification failed', { status: response.status, error: err });
    return { ok: false, provider: 'idwall', error: err };
  }

  const data = await response.json();
  logger.info('[KYC-BUREAU:idwall] CPF verification response', {
    reportId: data.result?.id,
    status: data.result?.status
  });

  return {
    ok: true,
    provider: 'idwall',
    providerId: data.result?.id,
    status: 'submitted',
    rawResponse: data
  };
}

async function idwallVerifyDocument({ userId, documentType, documentFront, documentBack, selfie }) {
  // Implementar conforme SDK Idwall
  // https://docs.idwall.co/docs/sdk-web
  logger.info('[KYC-BUREAU:idwall] Document upload not yet implemented in production');
  return { ok: false, provider: 'idwall', error: 'document_upload_not_implemented' };
}

// ── DISPATCHER ──────────────────────────────────────────────────────────────

/**
 * Verifica CPF no bureau configurado.
 */
async function verifyCPF(params) {
  switch (PROVIDER) {
    case 'idwall': return idwallVerifyCPF(params);
    case 'serpro': throw new Error('Serpro não implementado ainda');
    default:       return stubVerifyCPF(params);
  }
}

/**
 * Envia documentos para verificação no bureau configurado.
 */
async function verifyDocument(params) {
  switch (PROVIDER) {
    case 'idwall': return idwallVerifyDocument(params);
    case 'serpro': throw new Error('Serpro não implementado ainda');
    default:       return stubVerifyDocument(params);
  }
}

module.exports = {
  verifyCPF,
  verifyDocument,
  PROVIDER,
};
