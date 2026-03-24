/**
 * Script de seed — insere 15 mercados iniciais via API REST.
 *
 * Uso:
 *   ADMIN_TOKEN=<token> node scripts/seed-markets.js
 *
 * Opcionalmente configure API_URL para apontar para outro ambiente:
 *   API_URL=http://localhost:3001 ADMIN_TOKEN=<token> node scripts/seed-markets.js
 */

const API_URL = process.env.API_URL || 'https://preditivo-backend-production.up.railway.app';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required. Run: ADMIN_TOKEN=<token> node scripts/seed-markets.js');
  process.exit(1);
}

const MARKETS = [
  // ── POLÍTICA ──────────────────────────────────────────────────────────────
  {
    title: 'Lula termina o mandato em 2026?',
    description: 'Resolvido como SIM se Luiz Inácio Lula da Silva concluir o mandato presidencial até 31/12/2026 sem renúncia, afastamento ou impeachment.',
    category: 'politica',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 72
  },
  {
    title: 'Reforma tributária é regulamentada até junho de 2026?',
    description: 'Resolvido como SIM se o Congresso Nacional publicar no Diário Oficial a regulamentação completa da Reforma Tributária aprovada em 2023 até 30/06/2026.',
    category: 'politica',
    ends_at: '2026-06-30T23:59:59',
    initial_prob: 58
  },
  {
    title: 'Oposição vence as eleições presidenciais de 2026?',
    description: 'Resolvido como SIM se o candidato vencedor do segundo turno das eleições presidenciais de outubro/novembro 2026 for do campo oposicionista (não PT/PDT/PSOL).',
    category: 'politica',
    ends_at: '2026-11-30T23:59:59',
    initial_prob: 45
  },
  {
    title: 'PEC do voto impresso é aprovada pelo Congresso em 2026?',
    description: 'Resolvido como SIM se uma PEC reinstituindo o voto impresso auditável for aprovada em dois turnos por ambas as casas do Congresso até 31/12/2026.',
    category: 'politica',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 20
  },

  // ── ECONOMIA ──────────────────────────────────────────────────────────────
  {
    title: 'IPCA fecha 2025 abaixo de 5%?',
    description: 'Resolvido como SIM se o IPCA acumulado de 2025 (dezembro/2024 a dezembro/2025) for inferior a 5,00% conforme divulgação oficial do IBGE.',
    category: 'economia',
    ends_at: '2026-01-15T23:59:59',
    initial_prob: 55
  },
  {
    title: 'Dólar ultrapassa R$6,50 até junho de 2026?',
    description: 'Resolvido como SIM se a taxa de câmbio PTAX (BRL/USD) divulgada pelo Banco Central atingir ou superar R$6,50 em qualquer dia útil até 30/06/2026.',
    category: 'economia',
    ends_at: '2026-06-30T23:59:59',
    initial_prob: 48
  },
  {
    title: 'Selic cai abaixo de 10% em 2026?',
    description: 'Resolvido como SIM se o Copom reduzir a taxa Selic para abaixo de 10,00% a.a. em qualquer reunião ordinária realizada até 31/12/2026.',
    category: 'economia',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 35
  },

  // ── FUTEBOL ───────────────────────────────────────────────────────────────
  {
    title: 'Brasil se classifica para a Copa do Mundo 2026?',
    description: 'Resolvido como SIM se a seleção brasileira garantir vaga na Copa do Mundo FIFA 2026 através das eliminatórias sul-americanas até o prazo de inscrição.',
    category: 'futebol',
    ends_at: '2025-11-30T23:59:59',
    initial_prob: 88
  },
  {
    title: 'Flamengo é campeão do Brasileirão 2025?',
    description: 'Resolvido como SIM se o Flamengo terminar a Série A do Campeonato Brasileiro 2025 na primeira colocação, conforme tabela oficial da CBF.',
    category: 'futebol',
    ends_at: '2025-12-15T23:59:59',
    initial_prob: 28
  },
  {
    title: 'Um clube brasileiro vence a Libertadores 2025?',
    description: 'Resolvido como SIM se o campeão da Copa Libertadores da América 2025 for um clube brasileiro, conforme resultado da final.',
    category: 'futebol',
    ends_at: '2025-11-30T23:59:59',
    initial_prob: 55
  },

  // ── TECNOLOGIA ────────────────────────────────────────────────────────────
  {
    title: 'Apple lança iPhone dobrável até dezembro de 2026?',
    description: 'Resolvido como SIM se a Apple anunciar e disponibilizar para venda um iPhone com tela dobrável (foldable) até 31/12/2026. Fonte: comunicado oficial Apple.',
    category: 'tech',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 42
  },
  {
    title: 'ChatGPT atinge 1 bilhão de usuários até 2026?',
    description: 'Resolvido como SIM se a OpenAI divulgar oficialmente que o ChatGPT possui 1 bilhão de usuários ativos mensais até 31/12/2026.',
    category: 'tech',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 38
  },

  // ── ENTRETENIMENTO ────────────────────────────────────────────────────────
  {
    title: 'BBB 26 estreia antes de fevereiro de 2026?',
    description: 'Resolvido como SIM se a Globo divulgar a data oficial de estreia do Big Brother Brasil 26 para antes de 01/02/2026, e o programa estrear dentro desse prazo.',
    category: 'entretenimento',
    ends_at: '2026-02-01T23:59:59',
    initial_prob: 60
  },
  {
    title: 'Série brasileira é indicada ao Emmy Internacional 2026?',
    description: 'Resolvido como SIM se ao menos uma produção original brasileira (streaming ou TV aberta) constar na lista de indicadas ao Emmy Internacional 2026 em qualquer categoria.',
    category: 'entretenimento',
    ends_at: '2026-10-31T23:59:59',
    initial_prob: 70
  },

  // ── MERCADO FINANCEIRO ────────────────────────────────────────────────────
  {
    title: 'Ibovespa ultrapassa 150.000 pontos até dezembro de 2026?',
    description: 'Resolvido como SIM se o índice Ibovespa (IBOV) fechar acima de 150.000 pontos em qualquer pregão da B3 até 31/12/2026. Fonte: B3.',
    category: 'mercado',
    ends_at: '2026-12-31T23:59:59',
    initial_prob: 52
  }
];

async function createMarket(market) {
  const res = await fetch(`${API_URL}/markets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`
    },
    body: JSON.stringify(market)
  });
  return res.json();
}

(async () => {
  console.log(`\nSeed de mercados — ${API_URL}\n${'─'.repeat(60)}`);
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const market of MARKETS) {
    try {
      const result = await createMarket(market);
      if (result.error) {
        console.log(`⚠  ${market.title.slice(0, 55)} — ${result.error}`);
        errors++;
      } else {
        console.log(`✅ ${market.title.slice(0, 55)} [${result.id?.slice(0,8)}]`);
        created++;
      }
    } catch (err) {
      console.log(`❌ ${market.title.slice(0, 55)} — ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Criados: ${created}  Erros: ${errors}  Total: ${MARKETS.length}\n`);
})();
