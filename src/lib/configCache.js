/**
 * configCache.js — Cache em memória para configurações operacionais da plataforma.
 * Carrega do banco na inicialização e permite hot-reload via admin.
 * Evita query ao banco a cada aposta — leitura síncrona e rápida.
 */
const pool = require('./db');
const logger = require('./logger');

const DEFAULT_LIMITS = {
  conservador: { max_bet_single: 100,  max_month_total: 500,   max_market_total: 100  },
  moderado:    { max_bet_single: 500,  max_month_total: 2000,  max_market_total: 500  },
  arrojado:    { max_bet_single: 2000, max_month_total: 10000, max_market_total: 2000 },
};

// Cópia em memória — inicializada com defaults, sobrescrita pelo DB no startup
let _limits = JSON.parse(JSON.stringify(DEFAULT_LIMITS));

/**
 * Carrega limites do banco de dados.
 * Chamado uma vez no startup e opcionalmente após updates via admin.
 */
async function loadFromDB() {
  try {
    const res = await pool.query(
      "SELECT key, value FROM platform_config WHERE key LIKE 'limits_%'"
    );
    for (const row of res.rows) {
      const profile = row.key.replace('limits_', '');
      if (_limits[profile] !== undefined) {
        _limits[profile] = { ..._limits[profile], ...row.value };
        logger.info('[configCache] Limites carregados do DB', { profile, limits: _limits[profile] });
      }
    }
  } catch (err) {
    logger.warn('[configCache] Tabela platform_config não existe ainda — usando defaults', { error: err.message });
  }
}

/** Retorna os limites de um perfil (síncrono). */
function getLimits(profile) {
  return _limits[profile] || _limits.conservador;
}

/** Atualiza limites de um perfil em memória (após salvar no DB). */
function setLimits(profile, limits) {
  _limits[profile] = { ..._limits[profile], ...limits };
}

/** Retorna todos os limites. */
function getAllLimits() {
  return JSON.parse(JSON.stringify(_limits));
}

module.exports = { loadFromDB, getLimits, setLimits, getAllLimits, DEFAULT_LIMITS };
