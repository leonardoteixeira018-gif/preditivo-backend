// Mock do DB antes de importar o app
jest.mock('../../lib/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const request = require('supertest');

// Silencia logs durante testes
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

const pool = require('../../lib/db');

// Setup mínimo do express só com as rotas necessárias
const express = require('express');
const app = express();
app.use(express.json());
app.use('/bets', require('../bets'));

describe('GET /bets/quote', () => {
  afterEach(() => jest.clearAllMocks());

  it('retorna 400 para side inválido', async () => {
    const res = await request(app)
      .get('/bets/quote?market_id=abc&side=maybe&amount=100');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/side/i);
  });

  it('retorna 400 para amount inválido', async () => {
    const res = await request(app)
      .get('/bets/quote?market_id=abc&side=yes&amount=-10');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
  });

  it('retorna 404 para mercado inexistente', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/bets/quote?market_id=00000000-0000-0000-0000-000000000000&side=yes&amount=100');
    expect(res.status).toBe(404);
  });

  it('retorna 400 para mercado resolvido', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: '1', q_yes: 100, q_no: 100, resolved_at: new Date(), ends_at: null }]
    });
    const res = await request(app)
      .get('/bets/quote?market_id=1&side=yes&amount=100');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolvido/i);
  });

  it('retorna 400 para mercado expirado', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: '1', q_yes: 100, q_no: 100, resolved_at: null, ends_at: new Date('2020-01-01') }]
    });
    const res = await request(app)
      .get('/bets/quote?market_id=1&side=yes&amount=100');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expirado/i);
  });

  it('retorna prob, payout e slippage para mercado válido', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: '1', q_yes: 500, q_no: 500, resolved_at: null, ends_at: futureDate }]
    });
    const res = await request(app)
      .get('/bets/quote?market_id=1&side=yes&amount=100');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('prob');
    expect(res.body).toHaveProperty('payout');
    expect(res.body).toHaveProperty('slippage_pct');
    expect(res.body).toHaveProperty('slippage_warning');
    expect(res.body).toHaveProperty('taxa');
  });

  it('calcula prob corretamente (50% para mercado balanceado)', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: '1', q_yes: 1000, q_no: 1000, resolved_at: null, ends_at: futureDate }]
    });
    const res = await request(app)
      .get('/bets/quote?market_id=1&side=yes&amount=50');
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.prob)).toBeCloseTo(50, 0);
  });
});

describe('POST /bets — autenticação', () => {
  it('retorna 401 sem token JWT', async () => {
    const res = await request(app)
      .post('/bets')
      .send({ market_id: '1', side: 'yes', amount: 100 });
    expect(res.status).toBe(401);
  });
});
