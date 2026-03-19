/**
 * kyc-bureau.js — Interface de integração com bureau de identidade
 *
 * Abstrai a comunicação com provedores externos (Serpro, Idwall, Unico Check).
 * Em modo STUB (padrão atual), simula a resposta do bureau.
 * Para ativar a integração real, configure BUREAU_PROVIDER no .env.
 *
 * BUREAU_PROVIDER=stub    → Modo desenvolvimento (aprovação automática após 2s)
 * BUREAU_PROVIDER=idwall  → Integração Idwall (produção)
 * BUREAU_PROVIDER=serpro  → Integração Serpro (produção — Receita Federal via Serpro)
 *
 * Serpro CPF API (consulta-cpf-df):
 *   GET {baseUrl}/consulta-cpf-df/v1/cpf/{cpf}
 *   Authorization: Bearer {token}
 *   Role: INTER_CONSULTA_CPF
 *
 * Códigos de situação Receita Federal:
 *   0 = Regular          → approved
 *   2 = Suspensa          → rejected
 *   3 = Titular Falecido  → rejected
 *   4 = Pend. Regulariz.  → rejected
 *   5 = Cancel. Espólio   → rejected
 *   6 = Cancel. Multiplic.→ rejected
 *   8 = Nula              → rejected
 *   9 = Cancel. de Ofício → rejected
 */
const logger = require('./logger');
const { getSerproToken, getBaseUrl } = require('./serpro-auth');

const PROVIDER = process.env.BUREAU_PROVIDER || 'stub';

// ── STUB (desenvolvimento / sandbox CVM) ────────────────────────────────────

// CPFs de teste especiais para o Sandbox
const STUB_TEST_CPFS = {
  '00000000272': { status: 'rejected', rejectionReason: 'cpf_situacao_3', label: 'CPF cancelado (teste)' },
  '00000000191': { status: 'rejected', rejectionReason: 'cpf_situacao_3', label: 'CPF cancelado (teste)' },
};

// Nome que contém "DIVERGENTE" aciona mismatch de nome no stub
const STUB_MISMATCH_MARKER = 'DIVERGENTE';

async function stubVerifyCPF({ cpf, fullName, dateOfBirth }) {
  // Simula latência de bureau real
  await new Promise(resolve => setTimeout(resolve, 300));

  logger.info('[KYC-BUREAU:stub] CPF verification', {
    cpf: cpf.slice(0, 3) + '***',
    provider: 'stub'
  });

  // CPFs especiais de teste
  const testCase = STUB_TEST_CPFS[cpf];
  if (testCase) {
    return {
      ok: true,
      provider: 'stub',
      providerId: `stub_${Date.now()}`,
      status: 'rejected',
      rejectionReason: testCase.rejectionReason,
      rawResponse: { mode: 'development', testCase: testCase.label }
    };
  }

  // Nome com marcador "DIVERGENTE" simula mismatch de nome
  const nameNorm = String(fullName || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (nameNorm.includes(STUB_MISMATCH_MARKER)) {
    return {
      ok: true,
      provider: 'stub',
      providerId: `stub_${Date.now()}`,
      status: 'rejected',
      rejectionReason: 'name_mismatch',
      nameFromBureau: 'TITULAR DO CPF (SIMULADO)',
      rawResponse: { mode: 'development', testCase: 'name_mismatch_simulation' }
    };
  }

  // Em stub, qualquer outro CPF válido passa
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

// ── SERPRO (produção — Receita Federal) ─────────────────────────────────────

/**
 * Códigos de situação CPF da Receita Federal.
 * Apenas código "0" indica CPF Regular (aprovado).
 */
const SERPRO_CPF_SITUATION = {
  '0': { label: 'Regular',                        approved: true  },
  '2': { label: 'Suspensa',                        approved: false },
  '3': { label: 'Titular Falecido',                approved: false },
  '4': { label: 'Pendente de Regularização',       approved: false },
  '5': { label: 'Cancelada por Encerramento de Espólio', approved: false },
  '6': { label: 'Cancelada por Multiplicidade',    approved: false },
  '8': { label: 'Nula',                            approved: false },
  '9': { label: 'Cancelada de Ofício',             approved: false },
};

/**
 * Normaliza string para comparação de nomes: uppercase sem acentos.
 */
function normalizeName(str) {
  return String(str || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z\s]/g, '')
    .trim();
}

/**
 * Comparação tolerante de nomes.
 * Aceita se todos os tokens do nome mais curto estiverem no nome mais longo.
 * Evita falsos negativos por abreviações e nomes do meio.
 *
 * @returns {{ match: boolean, score: number, reason: string }}
 */
function compareNames(nameFromUser, nameFromBureau) {
  const userTokens   = normalizeName(nameFromUser).split(/\s+/).filter(Boolean);
  const bureauTokens = normalizeName(nameFromBureau).split(/\s+/).filter(Boolean);

  if (userTokens.length === 0 || bureauTokens.length === 0) {
    return { match: false, score: 0, reason: 'empty_name' };
  }

  // Quantos tokens do usuário estão no nome do bureau
  const matched = userTokens.filter(t => bureauTokens.includes(t));
  const score   = matched.length / userTokens.length;

  // Tolerância: pelo menos 60% dos tokens batem (cobre nomes abreviados / meio nome omitido)
  const match = score >= 0.6;

  return {
    match,
    score: Math.round(score * 100) / 100,
    reason: match ? 'name_match' : 'name_mismatch',
  };
}

async function serproVerifyCPF({ cpf, fullName, dateOfBirth }) {
  const token   = await getSerproToken();
  const baseUrl = getBaseUrl();

  // CPF sem formatação (somente dígitos)
  const cpfDigits = String(cpf).replace(/\D/g, '');
  const url       = `${baseUrl}/consulta-cpf-df/v1/cpf/${cpfDigits}`;

  logger.info('[KYC-BUREAU:serpro] Consultando CPF na Receita Federal', {
    cpf: cpfDigits.slice(0, 3) + '***',
    env: process.env.SERPRO_ENV || 'trial',
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Role':          'INTER_CONSULTA_CPF',
      'Content-Type':  'application/json',
    },
  });

  // CPF não encontrado
  if (res.status === 404) {
    logger.warn('[KYC-BUREAU:serpro] CPF não encontrado na Receita Federal', {
      cpf: cpfDigits.slice(0, 3) + '***',
    });
    return {
      ok: false,
      provider: 'serpro',
      providerId: null,
      status: 'rejected',
      rejectionReason: 'cpf_not_found',
      rawResponse: { status: 404 },
    };
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error('[KYC-BUREAU:serpro] Erro na consulta CPF', {
      status: res.status,
      body,
      cpf: cpfDigits.slice(0, 3) + '***',
    });
    throw new Error(`Serpro CPF API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // Ex. de resposta: { ni: '12345678901', nome: 'JOAO DA SILVA', situacao: { codigo: '0', descricao: 'Regular' }, nascimento: '01011990' }
  const situacaoCodigo = String(data.situacao?.codigo ?? '');
  const situation      = SERPRO_CPF_SITUATION[situacaoCodigo];
  const isApproved     = situation?.approved ?? false;

  logger.info('[KYC-BUREAU:serpro] Situação CPF obtida', {
    cpf:       cpfDigits.slice(0, 3) + '***',
    situacao:  situacaoCodigo,
    descricao: situation?.label ?? data.situacao?.descricao,
    approved:  isApproved,
  });

  if (!isApproved) {
    return {
      ok: true,
      provider: 'serpro',
      providerId: `serpro_${cpfDigits.slice(0, 3)}`,
      status: 'rejected',
      rejectionReason: `cpf_situacao_${situacaoCodigo}`,
      rawResponse: data,
    };
  }

  // CPF regular → compara nome declarado com nome na Receita Federal
  const nameComparison = compareNames(fullName, data.nome || '');

  logger.info('[KYC-BUREAU:serpro] Comparação de nomes', {
    cpf:         cpfDigits.slice(0, 3) + '***',
    nameMatch:   nameComparison.match,
    score:       nameComparison.score,
    reason:      nameComparison.reason,
    bureauName:  (data.nome || '').substring(0, 4) + '***',
    userNameLen: (fullName || '').length,
  });

  if (!nameComparison.match) {
    return {
      ok: true,
      provider: 'serpro',
      providerId: `serpro_${cpfDigits.slice(0, 3)}`,
      status: 'rejected',
      rejectionReason: 'name_mismatch',
      rawResponse: { situacao: data.situacao, nameScore: nameComparison.score },
    };
  }

  return {
    ok: true,
    provider:    'serpro',
    providerId:  `serpro_${cpfDigits}_${Date.now()}`,
    status:      'approved',
    rawResponse: {
      situacao:    data.situacao,
      nameScore:   nameComparison.score,
      nascimento:  data.nascimento,
    },
  };
}

// Serpro não oferece verificação de documentos via API pública —
// cai no stub (revisão manual) quando BUREAU_PROVIDER=serpro
async function serproVerifyDocument(params) {
  logger.info('[KYC-BUREAU:serpro] Verificação de documentos não disponível via Serpro — modo revisão manual', {
    userId: params.userId,
    documentType: params.documentType,
  });
  return {
    ok: true,
    provider:   'serpro',
    providerId: `serpro_doc_${Date.now()}`,
    status:     'submitted', // Vai para revisão manual do admin
    rawResponse: { note: 'serpro_does_not_provide_doc_verification' },
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
    case 'serpro': {
      try {
        return await serproVerifyCPF(params);
      } catch (err) {
        // Falha de rede ou credenciais inválidas — log claro para diagnóstico
        const isNetworkError = err.message?.includes('fetch failed') || err.cause?.code === 'ENOTFOUND';
        logger.error('[KYC-BUREAU:serpro] Falha ao conectar com Serpro', {
          error: err.message,
          cause: err.cause?.code,
          hint: isNetworkError
            ? 'Verifique conectividade com sandbox.apigateway.serpro.gov.br ou configure BUREAU_PROVIDER=stub'
            : 'Verifique SERPRO_CLIENT_ID e SERPRO_CLIENT_SECRET no Railway',
        });
        // Propaga com mensagem descritiva para o route handler retornar 502 (não 500)
        const friendly = new Error('bureau_unreachable');
        friendly.isNetworkError = true;
        throw friendly;
      }
    }
    case 'idwall': return idwallVerifyCPF(params);
    default:       return stubVerifyCPF(params);
  }
}

/**
 * Envia documentos para verificação no bureau configurado.
 */
async function verifyDocument(params) {
  switch (PROVIDER) {
    case 'serpro': return serproVerifyDocument(params);
    case 'idwall': return idwallVerifyDocument(params);
    default:       return stubVerifyDocument(params);
  }
}

module.exports = {
  verifyCPF,
  verifyDocument,
  PROVIDER,
};
