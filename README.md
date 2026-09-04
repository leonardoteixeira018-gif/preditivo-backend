# Bubuya. — Backend

> Plataforma brasileira de mercados de previsão. Contratos binários sobre eventos do mundo real, com precificação dinâmica via AMM (Automated Market Maker).

---

## Stack Tecnológica

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js 20 + Express 4 |
| Banco de dados | PostgreSQL (Supabase) |
| Autenticação | JWT + blacklist de tokens |
| E-mail | Resend (transacional) |
| Pagamentos | InfinitePay (checkout + webhook) |
| Deploy | Railway (auto-deploy via GitHub) |
| Logs | Winston (estruturado + correlation ID) |
| Cache | SimpleCache in-memory (TTL configurável) |

---

## Estado atual do projeto (auditado em Março 2026)

> Status: experimental / domínio atualmente inativo. O frontend rodava em [bubuya.com.br](https://www.bubuya.com.br), domínio que não está ativo no momento — ver [`preditivo`](https://github.com/leonardotteixeira/preditivo) para o contexto completo do projeto.

Na época em que este README foi escrito pela última vez, a API tinha as seguintes funcionalidades implementadas:

### Usuarios & Auth
- Cadastro com verificação por e-mail + código OTP
- Login JWT com blacklist de tokens (logout real)
- Recuperação de senha por e-mail
- Perfil com histórico de apostas e P&L
- Auditoria de ações do usuário (`user_audit_logs`)

### Mercados
- Listagem com filtro por categoria e paginação
- Detalhe com gráfico de histórico de probabilidade (Chart.js)
- Order Book ao vivo (atualização a cada 10s)
- Timeline de eventos + Regras de resolução
- Seção de discussão/comentários por mercado
- Cache de 30-60s por endpoint (stats, detalhe)

### Negociação
- Compra e venda de contratos SIM/NÃO
- Precificação via AMM: `prob = q_yes / (q_yes + q_no)`
- Taxa de 2% por operação
- Liquidação automática na resolução do mercado
- Proteção anti-abuso: rate limiting por user_id (10 apostas/min)

### Financeiro
- Depósito manual (revisão admin)
- Checkout automatizado via InfinitePay (PIX)
- Webhook de confirmação automática de pagamento
- Saque via PIX com dupla confirmação por e-mail
- Detecção de saque suspeito (cashout < 60min após depósito → `risk_flag`)

### Admin
- Dashboard consolidado com CTE (`GET /admin/dashboard`)
- Gestão de mercados, depósitos, saques, usuários
- Ajuste manual de saldo
- Simulador de bots para liquidez
- Log de auditoria administrativo
- Cache invalidado automaticamente em mutações críticas

### Segurança & Observabilidade
- Rate limiting por IP e por user_id
- Logging estruturado com correlation ID por request
- Detecção de anomalias: cashout rápido + aposta > 50% do saldo
- Blacklist de tokens com cache local (5min TTL)
- CORS configurado explicitamente para domínios de produção

---

## Setup local

### 1. Banco de dados
```bash
# Crie um projeto no Supabase e rode o schema:
psql $DATABASE_URL < src/sql/schema.sql
```

### 2. Variáveis de ambiente
```bash
cp .env.example .env
# Preencha todas as variáveis
```

Variáveis obrigatórias:
```
DATABASE_URL
JWT_SECRET
ADMIN_SECRET
RESEND_API_KEY
EMAIL_FROM
APP_URL
INFINITEPAY_HANDLE
INFINITEPAY_REDIRECT_URL
INFINITEPAY_WEBHOOK_URL
```

### 3. Instalar e rodar
```bash
npm install
npm run dev     # desenvolvimento (nodemon)
npm start       # produção
```

### 4. Validar
```bash
curl http://localhost:3000/health
# → { "ok": true, "db": "ok" }
```

---

## Endpoints da API

### Health
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status da API e conexão com DB |

### Auth
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/register` | Cadastro (envia OTP por e-mail) |
| POST | `/auth/register/verify` | Confirma OTP e cria conta |
| POST | `/auth/login` | Login → JWT |
| POST | `/auth/logout` | Invalida token (blacklist) |
| GET | `/auth/me` | Perfil do usuário autenticado |
| POST | `/auth/forgot-password` | Envia link de recuperação |
| POST | `/auth/reset-password` | Redefine senha com token |
| GET | `/auth/audit/my-logs` | Histórico de ações do próprio usuário |

### Mercados
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/markets` | Lista mercados (paginação opcional) |
| GET | `/markets/stats` | Estatísticas globais da plataforma |
| GET | `/markets/:id` | Detalhe + histórico de probabilidade |
| POST | `/markets` | Cria mercado (admin) |
| PATCH | `/markets/:id/description` | Atualiza regras (admin) |
| PATCH | `/markets/:id/image` | Atualiza imagem (admin) |
| POST | `/markets/:id/resolve` | Resolve mercado + paga vencedores (admin) |

### Apostas
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/bets` | Executa compra de contrato |
| POST | `/bets/sell` | Executa venda de contrato |
| GET | `/bets/my` | Lista apostas abertas do usuário |
| GET | `/bets/quote` | Simula aposta sem executar |

### Depósitos
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/deposits` | Solicita depósito manual |
| POST | `/deposits/infinitepay/checkout` | Cria checkout PIX (InfinitePay) |
| POST | `/deposits/infinitepay/webhook` | Webhook de confirmação (InfinitePay) |
| GET | `/deposits/my` | Lista depósitos do usuário |

### Saques
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/withdrawals` | Solicita saque (envia OTP) |
| POST | `/withdrawals/verify` | Confirma saque com OTP |
| GET | `/withdrawals/my` | Lista saques do usuário |

### Ranking & Comentários
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/ranking` | Ranking público de usuários |
| GET | `/comments/:marketId` | Comentários de um mercado |
| POST | `/comments` | Posta comentário |

### Admin
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/admin/dashboard` | Dashboard consolidado (CTE + cache 30s) |
| GET | `/admin/users` | Lista usuários |
| POST | `/admin/deposits/:id/confirm` | Confirma depósito manual |
| POST | `/admin/deposits/:id/reject` | Rejeita depósito |
| POST | `/admin/withdrawals/:id/pay` | Marca saque como pago |
| POST | `/admin/withdrawals/:id/cancel` | Cancela saque |
| POST | `/admin/markets` | Cria mercado |
| POST | `/admin/markets/:id/resolve` | Resolve mercado |
| POST | `/admin/balance-adjust` | Ajuste manual de saldo |
| GET | `/admin-auth/audit-logs` | Log de auditoria admin |

---

## Roadmap

### FASE 1 — MVP (concluída)
- Autenticação completa (registro, login, logout, recuperação de senha)
- CRUD de mercados + sistema de apostas com AMM
- Depósitos e saques com PIX
- Checkout automatizado InfinitePay
- Painel Admin funcional
- Deploy em produção (Railway + Supabase)

### FASE 2 — Segurança & auditoria (concluída)
- Logging estruturado com Winston e correlation ID
- Auditoria de ações de usuários (`user_audit_logs`)
- Remoção de mensagens de erro sensíveis das respostas da API
- Endpoint de histórico de auditoria para usuários e admins
- Blacklist de tokens com persistência em banco

### FASE 3 — Performance & escalabilidade (concluída)
- Cache in-memory com TTL (mercados, stats, dashboard)
- Invalidação de cache em mutações críticas
- Rate limiting por user_id (não apenas por IP)
- Otimização de queries com CTEs e Promise.all
- Cache local de blacklist de tokens (evita query no DB a cada request)

### FASE 4 — Dashboard admin & detecção de anomalias (concluída)
- Dashboard consolidado com CTE em query única
- Detecção de saque rápido pós-depósito (< 60 min) → `risk_flag`
- Log de aposta desproporcional ao saldo (> 50%)
- Migração inline: coluna `risk_flag` em `withdrawals`

### FASE 5 — Compliance KYC/AML (implementada, sem uso real)
_Motivada pela regulação CVM aplicável a esse tipo de contrato — ver "Contexto regulatório" abaixo_
- Coleta e validação de CPF (dígito verificador + bureau Serpro/Idwall)
- Upload de documento de identidade + selfie
- Status KYC: `pending | approved | rejected`
- Bloqueio de apostas e saques sem KYC aprovado
- Triagem PEP (Pessoa Exposta Politicamente) e sanções internacionais
- Relatório automático ao COAF (transações > R$10.000/mês)

### FASE 6 — Suitability & limites operacionais (planejada, não iniciada)
_Exigência regulatória CVM_
- Questionário de perfil de investidor (5-8 perguntas)
- Classificação: conservador / moderado / arrojado
- Limites de exposição por perfil de risco
- Limites por mercado e volume máximo por usuário/mês
- Segregação de fundos via parceiro regulado (Celcoin/Asaas/Stark Bank)

### FASE 7 — Candidatura Sandbox CVM (planejada, não iniciada)
- Constituição jurídica formal (CNPJ + compliance officer)
- Política de privacidade LGPD completa
- Canal de ouvidoria com SLA de 5 dias úteis
- Documentação técnica e jurídica para formulário CVM (2.000+ chars/seção)
- Submissão na próxima rodada de admissão do Sandbox Regulatório

### FASE 8 — Pós-Sandbox / autorização permanente (ideia de longo prazo)
- Integração com corretoras e distribuidores parceiros
- API pública para criadores de mercado terceiros
- Mercados com liquidez institucional
- Expansão para contratos de mais categorias reguladas

---

## Contexto regulatório

Contratos SIM/NÃO com liquidação em dinheiro sobre eventos futuros se aproximam da definição de valor mobiliário do Art. 2º, IX da Lei 6.385/76 — por isso o roadmap inclui KYC/AML e suitability (Fases 5 e 6) mesmo sem uso real ainda: foi um exercício de pensar a plataforma como se precisasse eventualmente se enquadrar num regime regulatório (o Sandbox Regulatório da CVM, Instrução CVM 626, seria o caminho aplicável), não uma candidatura em andamento. Kalshi e Polymarket, nos EUA, operam nesse mesmo tipo de contrato sob regulação da CFTC — foram a referência usada para pensar o desenho do produto.

---

## Estrutura do Projeto

```
preditivo-backend/
├── src/
│   ├── index.js              # Entry point, middlewares, startup migrations
│   ├── lib/
│   │   ├── cache.js          # SimpleCache in-memory com TTL
│   │   ├── logger.js         # Winston com correlation ID
│   │   └── user-audit.js     # Log de ações de usuários
│   ├── middleware/
│   │   └── auth.js           # JWT + blacklist com cache local
│   ├── routes/
│   │   ├── auth.js
│   │   ├── markets.js
│   │   ├── bets.js
│   │   ├── deposits.js
│   │   ├── withdrawals.js
│   │   ├── ranking.js
│   │   ├── comments.js
│   │   ├── admin.js
│   │   └── admin-auth.js
│   └── sql/
│       └── schema.sql
├── .env.example
├── package.json
└── README.md
```

---

## Status

Experimental / domínio atualmente inativo. Este backend foi desenvolvido para dar suporte ao [`preditivo`](https://github.com/leonardotteixeira/preditivo) (frontend do Bubuya) e permanece como parte do meu portfólio — as fases de compliance regulatório (5-7) foram planejadas mas não colocadas em prática, e o projeto está parado no estágio atual.

## Licença

Código-fonte disponível para fins de portfólio. Todos os direitos reservados © Leonardo Teixeira.
