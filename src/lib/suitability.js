/**
 * suitability.js — Perfil de Investidor (Suitability)
 *
 * Exigência regulatória CVM Sandbox / Resolução CVM 30/2021.
 * Todo usuário (novo ou existente) deve responder o questionário antes de operar.
 * O perfil expira em 12 meses e deve ser renovado.
 *
 * Perfis: conservador | moderado | arrojado
 */

// ── Questionário ──────────────────────────────────────────────────────────────

/**
 * 5 perguntas, cada uma com 3 opções valendo 1, 2 ou 3 pontos.
 * Total possível: 5–15 pontos.
 */
const QUESTIONS = [
  {
    id: 'objetivo',
    text: 'O que você busca ao participar de mercados preditivos?',
    options: [
      { value: 'a', label: 'Diversão e entretenimento', points: 1 },
      { value: 'b', label: 'Renda complementar com risco controlado', points: 2 },
      { value: 'c', label: 'Alto retorno financeiro, aceito riscos maiores', points: 3 },
    ]
  },
  {
    id: 'perda',
    text: 'Se você perdesse 30% do valor aplicado, como reagiria?',
    options: [
      { value: 'a', label: 'Retiraria tudo imediatamente', points: 1 },
      { value: 'b', label: 'Aguardaria uma recuperação', points: 2 },
      { value: 'c', label: 'Aproveitaria para aumentar minha posição', points: 3 },
    ]
  },
  {
    id: 'experiencia',
    text: 'Qual é a sua experiência com investimentos?',
    options: [
      { value: 'a', label: 'Nenhuma ou apenas poupança/CDB', points: 1 },
      { value: 'b', label: 'Fundos de investimento e ações básicas', points: 2 },
      { value: 'c', label: 'Derivativos, opções ou mercados complexos', points: 3 },
    ]
  },
  {
    id: 'horizonte',
    text: 'Por quanto tempo pretende manter recursos na plataforma?',
    options: [
      { value: 'a', label: 'Menos de 6 meses', points: 1 },
      { value: 'b', label: 'De 6 meses a 2 anos', points: 2 },
      { value: 'c', label: 'Mais de 2 anos', points: 3 },
    ]
  },
  {
    id: 'renda',
    text: 'Qual é a sua renda mensal aproximada?',
    options: [
      { value: 'a', label: 'Até R$ 3.000', points: 1 },
      { value: 'b', label: 'Entre R$ 3.000 e R$ 10.000', points: 2 },
      { value: 'c', label: 'Acima de R$ 10.000', points: 3 },
    ]
  }
];

// ── Perfis e limites operacionais ─────────────────────────────────────────────

const PROFILES = {
  conservador: {
    label: 'Conservador',
    scoreMin: 5,
    scoreMax: 8,
    description: 'Você prefere segurança e baixo risco. Apostas com limites reduzidos.',
    limits: {
      max_bet_single:   100,   // Valor máximo por aposta individual (R$)
      max_month_total:  500,   // Valor máximo total apostado por mês (R$)
      max_market_total: 100,   // Valor máximo exposto em um único mercado (R$)
    }
  },
  moderado: {
    label: 'Moderado',
    scoreMin: 9,
    scoreMax: 12,
    description: 'Você equilibra risco e retorno. Limites intermediários.',
    limits: {
      max_bet_single:   500,
      max_month_total:  2000,
      max_market_total: 500,
    }
  },
  arrojado: {
    label: 'Arrojado',
    scoreMin: 13,
    scoreMax: 15,
    description: 'Você aceita riscos maiores em busca de retornos elevados.',
    limits: {
      max_bet_single:   2000,
      max_month_total:  10000,
      max_market_total: 2000,
    }
  }
};

// Validade do perfil em meses
const SUITABILITY_VALIDITY_MONTHS = 12;

// ── Funções de cálculo ────────────────────────────────────────────────────────

/**
 * Valida as respostas do questionário.
 * @param {object} answers — { objetivo: 'a'|'b'|'c', perda: ..., ... }
 * @returns {string|null} — mensagem de erro ou null se válido
 */
function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object') {
    return 'Respostas inválidas';
  }

  for (const q of QUESTIONS) {
    const answer = answers[q.id];
    if (!answer) {
      return `Resposta obrigatória para a pergunta: "${q.text}"`;
    }
    const validValues = q.options.map(o => o.value);
    if (!validValues.includes(answer)) {
      return `Resposta inválida para a pergunta "${q.id}". Valores aceitos: ${validValues.join(', ')}`;
    }
  }

  return null;
}

/**
 * Calcula o perfil de investidor com base nas respostas.
 * @param {object} answers — { objetivo: 'a'|'b'|'c', perda: ..., ... }
 * @returns {{ profile: string, score: number, limits: object, profileData: object }}
 */
function calculateProfile(answers) {
  let totalScore = 0;

  for (const q of QUESTIONS) {
    const answer = answers[q.id];
    const option = q.options.find(o => o.value === answer);
    totalScore += option ? option.points : 0;
  }

  // Determina o perfil pelo score total
  let profile = 'conservador';
  for (const [key, data] of Object.entries(PROFILES)) {
    if (totalScore >= data.scoreMin && totalScore <= data.scoreMax) {
      profile = key;
      break;
    }
  }

  const profileData = PROFILES[profile];

  return {
    profile,
    score: totalScore,
    limits: profileData.limits,
    profileData: {
      label: profileData.label,
      description: profileData.description
    }
  };
}

/**
 * Retorna os limites operacionais de um perfil.
 * Lê do configCache (hot-reload via admin) com fallback para PROFILES hardcoded.
 * @param {string} profile — 'conservador'|'moderado'|'arrojado'
 * @returns {object} limits
 */
function getLimits(profile) {
  try {
    const configCache = require('./configCache');
    return configCache.getLimits(profile);
  } catch {
    return (PROFILES[profile] || PROFILES.conservador).limits;
  }
}

/**
 * Calcula a data de expiração do perfil (12 meses a partir de hoje).
 * @returns {Date}
 */
function calcExpiresAt() {
  const d = new Date();
  d.setMonth(d.getMonth() + SUITABILITY_VALIDITY_MONTHS);
  return d;
}

module.exports = {
  QUESTIONS,
  PROFILES,
  SUITABILITY_VALIDITY_MONTHS,
  validateAnswers,
  calculateProfile,
  getLimits,
  calcExpiresAt,
};
