require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: ['https://preditivo.vercel.app', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());
app.use('/auth',        require('./routes/auth'));
app.use('/markets',     require('./routes/markets'));
app.use('/bets',        require('./routes/bets'));
app.use('/ranking',     require('./routes/ranking'));
app.use('/deposits',    require('./routes/deposits'));
app.use('/withdrawals', require('./routes/withdrawals'));
app.use('/referrals',   require('./routes/referrals'));
app.use('/admin',       require('./routes/admin'));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
