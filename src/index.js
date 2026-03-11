require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Rotas
app.use('/auth',    require('./routes/auth'));
app.use('/markets', require('./routes/markets'));
app.use('/bets',    require('./routes/bets'));
app.use('/ranking', require('./routes/ranking'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));

app.use('/deposits', require('./routes/deposits'));
app.use('/admin', require('./routes/admin'));
