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
O backend e frontend suportam atualmente:
- Cadastro com verificação por e-mail e login JWT.
- Listagem e detalhe de mercados com histórico.
- **Negociação de contratos (Previsões)** com cotações dinâmicas.
- Ranking público de usuários e performance.
- Depósitos manuais e **Checkout automatizado via InfinitePay**.
- Saques com dupla confirmação (E-mail).
- Painel Admin para gestão de mercados, usuários, receita e simulação de bots.
- **Integração Web3**: Conexão com MetaMask para futura expansão.
- **Interface Profissional**: Rodapé institucional e comunicação de "Mercado de Previsão" (não apostas).

O produto atual é uma plataforma web centralizada onde o preço dos contratos reflete as probabilidades do mundo real.

---

## Setup

### 1. Banco de dados
1. Crie um projeto no [Supabase](https://supabase.com).
2. No SQL Editor, rode [`src/sql/schema.sql`](src/sql/schema.sql).
3. Copie a connection string PostgreSQL para `DATABASE_URL`.

### 2. Variaveis de ambiente
Copie [`.env.example`](.env.example) para `.env` e preencha os campos necessarios.

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

- [x] Implementar integração de checkout InfinitePay (Frontend + Backend)
- [x] Adicionar suporte inicial para carteiras Web3 (MetaMask)
- [x] Reformular comunicação para "Mercado de Previsão" (Remover termos de apostas tradicionais)
- [x] Criar rodapé institucional (Quem Somos, Como Funciona, Aviso Legal)
- [ ] Validar resolução de mercado real com distribuição de lucros
- [ ] Testar depósito real via InfinitePay (Fluxo de Webhook)
- [ ] Revisar e-mails transacionais com a nova terminologia profissional
- [ ] Rodar beta fechado com grupo pequeno (5-10 usuários)
- [ ] Definir rotina de monitoramento operacional e log de pagamentos

## Roadmap posterior
Depois do lancamento inicial:
- antifraude e limites operacionais
- analytics e metricas de conversao
- melhorias de UX mobile
- automacoes operacionais
- estudo de recursos Web3 se fizer sentido comercial
