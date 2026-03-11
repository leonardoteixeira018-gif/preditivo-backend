# Preditivo — Backend

API REST para a plataforma de mercados de previsão PrevBR.

## Stack
- **Node.js** + Express
- **PostgreSQL** via Supabase
- **LMSR** para precificação dinâmica de probabilidades
- **JWT** para autenticação

---

## Setup em 5 passos

### 1. Banco de dados (Supabase)
1. Crie conta em [supabase.com](https://supabase.com)
2. Crie um novo projeto
3. Vá em **SQL Editor** e rode o arquivo `sql/schema.sql`
4. Copie a **Connection String** em Settings → Database

### 2. Variáveis de ambiente
```bash
cp .env.example .env
# Edite o .env com sua DATABASE_URL e um JWT_SECRET
```

### 3. Instalar dependências
```bash
npm install
```

### 4. Rodar localmente
```bash
npm run dev
```

### 5. Deploy no Railway
1. Crie conta em [railway.app](https://railway.app)
2. New Project → Deploy from GitHub → selecione este repositório
3. Adicione as variáveis de ambiente (DATABASE_URL, JWT_SECRET)
4. Deploy automático ✅

---

## Endpoints

### Auth
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/register` | Criar conta |
| POST | `/auth/login` | Login |
| GET | `/auth/me` | Perfil do usuário logado |

### Mercados
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/markets` | Listar mercados |
| GET | `/markets?category=politica` | Filtrar por categoria |
| GET | `/markets/:id` | Detalhe de um mercado |
| POST | `/markets` | Criar mercado (auth) |
| POST | `/markets/:id/resolve` | Resolver mercado (auth) |

### Apostas
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/bets` | Fazer aposta (auth) |
| GET | `/bets/my` | Minhas apostas (auth) |
| GET | `/bets/quote?market_id=&side=true&amount=50` | Simular aposta |

### Ranking
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/ranking` | Top 50 traders |

---

## Como funciona o LMSR

O LMSR (Logarithmic Market Scoring Rule) é o algoritmo que move as probabilidades automaticamente:

- Cada aposta em SIM aumenta a probabilidade do SIM
- Cada aposta em NÃO aumenta a probabilidade do NÃO
- O parâmetro `b` controla a liquidez (quanto cada aposta move o mercado)
- Shares comprados por $1 valem $1 se o lado vencer

**Exemplo:**
- Mercado começa em 50%/50%
- Alguém aposta $100 no SIM
- Probabilidade vai para ~54%/46%
- Se SIM vencer, essa pessoa recebe suas shares em USDC

---

## Próximos passos
- [ ] Integração com MetaMask (ethers.js)
- [ ] Smart contracts na Polygon (Solidity)
- [ ] WebSockets para odds em tempo real
- [ ] Sistema de oráculos para resolver mercados automaticamente
