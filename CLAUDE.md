# CLAUDE.md — guia para agentes de IA

API da Bubuya (mercados de previsão). Node 20 + Express 4, PostgreSQL (Supabase), JWT, Winston, Jest + supertest. O README descreve produto, endpoints e setup — leia antes.

## Comandos

```bash
npm run dev      # nodemon, porta 3000 (precisa de .env — copie de .env.example)
npm test         # Jest; os testes mockam o banco e o e-mail, rodam sem infra
npm start        # produção (Railway)
```

## Mapa do código

- `src/index.js` — bootstrap do Express, middlewares globais (CORS explícito, rate limit por IP, request logger com correlation ID), registro das rotas.
- `src/routes/*.js` — um router por domínio (`auth`, `markets`, `bets`, `deposits`, `withdrawals`, `kyc`, `suitability`, `admin`, `ranking`, `referrals`, `lgpd`…).
- `src/middleware/*` — `auth` (JWT + blacklist), `adminAuth`, `requireKyc`, `requireSuitability`, `requireRiskTerm`, `requireNotExcluded`. Toda rota de negociação passa por essa cadeia; não a contorne.
- `src/lib/*` — integrações e regras puras: `lmsr.js` (precificação AMM), `cache.js` (TTL in-memory), `infinitepay.js`/`asaas.js` (pagamentos), `email.js` + `emailTemplates.js` (Resend), `kyc*.js`, `pep-screening.js`, `cpf-crypto.js` (CPF cifrado em repouso), `audit.js`/`user-audit.js`/`adminAudit.js`.
- `src/sql/` — schema e migrações manuais.

## Regras de negócio que não podem quebrar

- Preço = `q_yes / (q_yes + q_no)`; taxa de 2% por operação; liquidação só na resolução do mercado.
- Toda mutação financeira (aposta, depósito, saque, ajuste de saldo) roda em **transação** e grava auditoria.
- Saque exige dupla confirmação por e-mail; cashout < 60 min após depósito marca `risk_flag`.
- Rate limit de apostas por `user_id` (10/min) além do limite por IP.
- Logout invalida o token (blacklist) — não remova esse comportamento "para simplificar".

## Convenções

- Commits em português, prefixo `feat:`, `fix:`, `refactor:`, `test:`, `chore:`.
- Respostas de erro sempre `{ error: "mensagem" }` com status HTTP correto; nunca vaze stack trace.
- Log via `logger` (Winston), nunca `console.log` em código de rota.
- Novo endpoint = rota + middleware adequado + teste em `src/routes/__tests__/` mockando `lib/db`.
- Segredos só em variáveis de ambiente; `.env.example` lista todas as chaves com valor vazio.

## Testes

Padrão dos testes existentes (`auth.test.js`, `bets.test.js`, `markets.test.js`): `jest.mock('../../lib/db')`, monta um `express()` mínimo com o router, chama com `supertest`, controla `pool.query.mockResolvedValueOnce` por passo. Siga esse padrão; não suba banco real em teste.

## Fluxo esperado

1. Ler a rota e os middlewares envolvidos.
2. Alterar o mínimo; se mexer em dinheiro, revisar transação + auditoria.
3. `npm test` verde antes de commitar.
