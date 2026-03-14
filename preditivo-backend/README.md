# Bubuya. - Backend

API REST da plataforma de mercados de previsao Bubuya.

## Stack
- Node.js + Express
- PostgreSQL via Supabase
- JWT para autenticacao
- Resend para emails transacionais
- InfinitePay para checkout de deposito
- Railway para deploy

## Estado atual do produto
O backend hoje suporta:
- cadastro com verificacao por email
- login com JWT
- listagem e detalhe de mercados
- apostas e cotacao de apostas
- ranking publico
- depositos manuais e checkout via InfinitePay
- saques com confirmacao por email
- painel admin para operacao
- simulacao de bots e separacao entre usuarios reais e artificiais

O produto atual e uma plataforma web centralizada com operacao assistida por painel admin. Itens de Web3 e smart contracts nao sao prioridade imediata de lancamento.

---

## Setup

### 1. Banco de dados
1. Crie um projeto no [Supabase](https://supabase.com).
2. No SQL Editor, rode [`src/sql/schema.sql`](C:/Users/SAMSUNG/OneDrive/Desktop/mercado%20preditivo/preditivo-backend/src/sql/schema.sql).
3. Copie a connection string PostgreSQL para `DATABASE_URL`.

### 2. Variaveis de ambiente
Copie [`.env.example`](C:/Users/SAMSUNG/OneDrive/Desktop/mercado%20preditivo/preditivo-backend/.env.example) para `.env` e preencha os campos necessarios.

Variaveis principais:
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `APP_BRAND`
- `APP_DOMAIN`
- `APP_URL`
- `SUPPORT_EMAIL`
- `INFINITEPAY_HANDLE`
- `INFINITEPAY_REDIRECT_URL`
- `INFINITEPAY_WEBHOOK_URL`

### 3. Instalar dependencias
```bash
npm install
```

### 4. Rodar localmente
```bash
npm run dev
```

### 5. Deploy no Railway
1. Crie um projeto no [Railway](https://railway.app).
2. Conecte este repositorio.
3. Configure as variaveis de ambiente.
4. Valide o health check em `/health`.

---

## Endpoints principais

### Health
| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/health` | Status basico da API |

### Auth
| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/auth/register` | Inicia cadastro e envia codigo por email |
| POST | `/auth/register/verify` | Conclui cadastro com codigo |
| POST | `/auth/login` | Login |
| GET | `/auth/me` | Perfil do usuario autenticado |

### Mercados
| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/markets` | Lista mercados |
| GET | `/markets/stats` | Estatisticas agregadas da plataforma |
| GET | `/markets/:id` | Detalhe de um mercado com historico |
| POST | `/markets` | Cria mercado (admin) |
| PATCH | `/markets/:id/description` | Atualiza descricao (admin) |
| POST | `/markets/:id/resolve` | Resolve mercado e paga vencedores (admin) |

### Apostas
| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/bets` | Faz aposta |
| GET | `/bets/my` | Lista apostas do usuario |
| GET | `/bets/quote` | Simula aposta |

### Depositos
| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/deposits` | Solicita deposito manual |
| POST | `/deposits/infinitepay/checkout` | Cria checkout na InfinitePay |
| POST | `/deposits/infinitepay/webhook` | Recebe webhook de pagamento |
| GET | `/deposits/my` | Lista depositos do usuario |

### Saques
| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/withdrawals` | Inicia saque e envia codigo por email |
| POST | `/withdrawals/verify` | Confirma saque com codigo |
| GET | `/withdrawals/my` | Lista saques do usuario |

### Ranking
| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/ranking` | Ranking publico |

### Admin
O painel admin cobre operacao de mercados, depositos, saques, receita e bots. As rotas exigem `x-admin-secret`.

---

## Fluxos criticos

### Cadastro
1. Usuario envia nome, email e senha em `/auth/register`
2. Backend envia codigo por email
3. Usuario confirma em `/auth/register/verify`
4. Conta e criada e o JWT e retornado

### Deposito via InfinitePay
1. Usuario solicita checkout em `/deposits/infinitepay/checkout`
2. Frontend redireciona para o link da InfinitePay
3. InfinitePay notifica o backend via webhook
4. Deposito e conciliado e o saldo e creditado

### Saque
1. Usuario solicita saque em `/withdrawals`
2. Backend envia codigo por email
3. Usuario confirma em `/withdrawals/verify`
4. Saque fica registrado para processamento operacional

### Resolucao de mercado
1. Admin resolve o mercado
2. Backend fecha o mercado
3. Vencedores recebem credito
4. Emails de resultado sao enviados

---

## Roadmap imediato
Os proximos passos do produto para lancamento nao sao blockchain. A prioridade agora e operacao estavel.

- [ ] Validar producao ponta a ponta com usuarios reais
- [ ] Garantir conciliacao confiavel de deposito e saque
- [ ] Revisar textos, branding e emails em toda a experiencia
- [ ] Fechar regras e datas dos mercados em destaque
- [ ] Rodar beta fechado com grupo pequeno
- [ ] Ajustar monitoramento e rotina diaria de operacao

## Roadmap posterior
Depois do lancamento inicial:
- antifraude e limites operacionais
- analytics e metricas de conversao
- melhorias de UX mobile
- automacoes operacionais
- estudo de recursos Web3 se fizer sentido comercial
