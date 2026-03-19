/**
 * pep-screening.js — Triagem PEP e Sanções Internacionais
 *
 * BACEN Circular 3.978/2020 — obrigatoriedade de identificação de PEP
 * Lei 9.613/98 Art. 11 — proibição de tipping-off (não revelar ao usuário que está em lista)
 *
 * Providers:
 *   PEP_PROVIDER=stub    → lógica local por keywords/CPF (desenvolvimento)
 *   PEP_PROVIDER=serpro  → API Serpro (produção) — não implementado
 *   PEP_PROVIDER=idwall  → API Idwall (produção) — não implementado
 *
 * Fluxo de decisão após triagem:
 *   isSanctioned → auto-rejeitar KYC (mensagem vaga ao usuário)
 *   isPep        → manter 'submitted', aguarda revisão manual do admin
 *   clear        → auto-aprovar (comportamento padrão do stub)
 */
const pool = require('./db');
const logger = require('./logger');

const PEP_PROVIDER = process.env.PEP_PROVIDER || 'stub';

// ── Listas do stub ────────────────────────────────────────────────────────────

/**
 * Cargos PEP conforme taxonomia BACEN Circular 3.978/2020 e FATF Recommendations.
 * Apenas funções públicas relevantes (não inclui cargos de baixo escalão).
 */
const PEP_KEYWORDS = [
  'presidente', 'vice-presidente', 'ministro', 'ministro de estado',
  'secretario', 'secretaria', 'governador', 'vice-governador',
  'senador', 'deputado', 'vereador', 'prefeito', 'vice-prefeito',
  'juiz', 'desembargador', 'procurador', 'promotor', 'defensor',
  'delegado', 'general', 'almirante', 'brigadeiro', 'coronel',
  'embaixador', 'consul',
];

/**
 * CPFs e nomes para teste de sanções (apenas stub).
 * CPF 00000000191 é o único CPF válido com todos os dígitos iguais.
 */
const STUB_SANCTIONED_CPFS  = ['00000000191'];
const STUB_SANCTIONED_NAMES = ['SANCTIONED TEST USER', 'PESSOA SANCIONADA TESTE'];

// ── Utilitário ────────────────────────────────────────────────────────────────

/**
 * Normaliza string para comparação: uppercase + remove acentos.
 * Necessário para evitar falsos negativos (ex: "Jéssica" → "JESSICA").
 */
function normalize(str) {
  return String(str || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ── Stub implementations ──────────────────────────────────────────────────────

async function stubScreenPEP({ cpf, fullName }) {
  const normalizedName = normalize(fullName);
  const matchedKeywords = PEP_KEYWORDS.filter(kw => normalizedName.includes(normalize(kw)));

  if (matchedKeywords.length === 0) {
    return { isPep: false, confidence: 0, source: 'stub', details: {} };
  }

  const confidence = Math.min(matchedKeywords.length * 0.3, 0.95);
  return {
    isPep: true,
    confidence,
    source: 'stub',
    details: { matchedKeywords }
  };
}

async function stubScreenSanctions({ cpf, fullName }) {
  if (STUB_SANCTIONED_CPFS.includes(cpf)) {
    return {
      isSanctioned: true,
      lists: ['STUB_TEST'],
      details: { matchType: 'cpf', matchedCpf: cpf }
    };
  }

  const normalizedName = normalize(fullName);
  const matchedName = STUB_SANCTIONED_NAMES.find(n => normalizedName.includes(n));
  if (matchedName) {
    return {
      isSanctioned: true,
      lists: ['STUB_TEST'],
      details: { matchType: 'name', matchedName }
    };
  }

  return { isSanctioned: false, lists: [], details: {} };
}

// ── Provider stubs (integração futura) ───────────────────────────────────────

async function serproScreenPEP() {
  throw new Error('SERPRO PEP screening: não implementado. Configure PEP_PROVIDER=stub para desenvolvimento.');
}

async function serproScreenSanctions() {
  throw new Error('SERPRO sanctions screening: não implementado. Configure PEP_PROVIDER=stub para desenvolvimento.');
}

async function idwallScreenPEP() {
  throw new Error('Idwall PEP screening: não implementado. Configure PEP_PROVIDER=stub para desenvolvimento.');
}

async function idwallScreenSanctions() {
  throw new Error('Idwall sanctions screening: não implementado. Configure PEP_PROVIDER=stub para desenvolvimento.');
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

async function screenPEP({ cpf, fullName }) {
  switch (PEP_PROVIDER) {
    case 'serpro': return serproScreenPEP({ cpf, fullName });
    case 'idwall': return idwallScreenPEP({ cpf, fullName });
    default:       return stubScreenPEP({ cpf, fullName });
  }
}

async function screenSanctions({ cpf, fullName }) {
  switch (PEP_PROVIDER) {
    case 'serpro': return serproScreenSanctions({ cpf, fullName });
    case 'idwall': return idwallScreenSanctions({ cpf, fullName });
    default:       return stubScreenSanctions({ cpf, fullName });
  }
}

// ── runFullScreening ──────────────────────────────────────────────────────────

/**
 * Executa triagem completa (PEP + sanções) e persiste resultados no banco.
 *
 * IMPORTANTE: Esta função nunca propaga erros — uma falha do provider
 * retorna resultado neutro para não bloquear o fluxo KYC principal.
 * O admin pode reprocessar manualmente via /kyc/admin/:userId/approve.
 *
 * @param {{ userId: string, cpf: string, fullName: string }} params
 * @returns {Promise<{ pepResult: object, sanctionsResult: object, error?: string }>}
 */
async function runFullScreening({ userId, cpf, fullName }) {
  const client = await pool.connect();

  try {
    const [pepResult, sanctionsResult] = await Promise.all([
      screenPEP({ cpf, fullName }),
      screenSanctions({ cpf, fullName })
    ]);

    const pepStatus        = pepResult.isPep          ? 'flagged'    : 'clear';
    const sanctionsStatus  = sanctionsResult.isSanctioned ? 'sanctioned' : 'clear';

    await client.query('BEGIN');

    await client.query(`
      UPDATE users SET
        pep_status           = $1,
        pep_checked_at       = NOW(),
        sanctions_status     = $2,
        sanctions_checked_at = NOW()
      WHERE id = $3
    `, [pepStatus, sanctionsStatus, userId]);

    await client.query(`
      INSERT INTO pep_reviews
        (user_id, screening_type, result, confidence, source, details)
      VALUES ($1, 'pep', $2, $3, $4, $5)
    `, [
      userId,
      pepStatus === 'flagged' ? 'flagged' : 'clear',
      pepResult.confidence,
      pepResult.source,
      JSON.stringify(pepResult.details || {})
    ]);

    await client.query(`
      INSERT INTO pep_reviews
        (user_id, screening_type, result, confidence, source, details)
      VALUES ($1, 'sanctions', $2, $3, $4, $5)
    `, [
      userId,
      sanctionsResult.isSanctioned ? 'sanctioned' : 'clear',
      1.0,
      PEP_PROVIDER,
      JSON.stringify({ lists: sanctionsResult.lists, ...sanctionsResult.details })
    ]);

    await client.query('COMMIT');

    logger.info('[PEP-SCREENING] Triagem completa', {
      userId,
      pepStatus,
      sanctionsStatus,
      provider: PEP_PROVIDER,
      isPep: pepResult.isPep,
      isSanctioned: sanctionsResult.isSanctioned
    });

    return { pepResult, sanctionsResult };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // Não propaga — resultado neutro para não bloquear fluxo KYC principal
    logger.error('[PEP-SCREENING] runFullScreening falhou — resultado neutro aplicado', {
      userId,
      provider: PEP_PROVIDER,
      error: err.message
    });

    return {
      pepResult:        { isPep: false, confidence: 0, source: 'error', details: { error: err.message } },
      sanctionsResult:  { isSanctioned: false, lists: [], details: { error: err.message } },
      error: err.message
    };

  } finally {
    client.release();
  }
}

module.exports = {
  screenPEP,
  screenSanctions,
  runFullScreening,
  PEP_PROVIDER,
};
