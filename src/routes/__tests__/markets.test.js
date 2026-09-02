jest.mock('../../lib/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../../lib/cache', () => ({
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  del: jest.fn()
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// Limpa filas de mockResolvedValueOnce entre TODOS os testes do arquivo
afterEach(() => jest.clearAllMocks());

const request = require('supertest');
const pool = require('../../lib/db');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/markets', require('../markets'));

describe('GET /markets', () => {
  afterEach(() => jest.clearAllMocks());

  it('retorna lista de mercados', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: '1', title: 'Mercado A', status: 'open' },
        { id: '2', title: 'Mercado B', status: 'open' }
      ]
    });
    const res = await request(app).get('/markets');
    expect(res.status).toBe(200);
    // A rota devolve um envelope paginado, nao um array cru
    expect(Array.isArray(res.body.markets)).toBe(true);
    expect(res.body.markets.length).toBe(2);
    expect(res.body).toMatchObject({ limit: 20, offset: 0 });
  });
});

describe('GET /markets/stats', () => {
  it('retorna total_volume, active_markets e active_traders', async () => {
    // /stats usa um client dedicado (pool.connect) com statement_timeout
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({})                                   // SET LOCAL statement_timeout
        .mockResolvedValueOnce({ rows: [{ total_volume: '12345.67' }] })
        .mockResolvedValueOnce({ rows: [{ active_markets: '5' }] })
        .mockResolvedValueOnce({ rows: [{ active_traders: '42' }] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);

    const res = await request(app).get('/markets/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_volume');
    expect(res.body).toHaveProperty('active_markets');
    expect(res.body).toHaveProperty('active_traders');
    expect(res.body.total_volume).toBe(12345.67);
    expect(res.body.active_markets).toBe(5);
    expect(res.body.active_traders).toBe(42);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('GET /markets/:id', () => {
  it('retorna 404 para mercado inexistente', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })   // market
      .mockResolvedValueOnce({ rows: [] });  // history
    const res = await request(app).get('/markets/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('retorna mercado com histórico', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: '1', title: 'Test Market', q_yes: 100, q_no: 100 }]
      })
      .mockResolvedValueOnce({
        rows: [{ prob_yes: 50, prob_no: 50, volume: 100, created_at: new Date() }]
      });

    const res = await request(app).get('/markets/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('history');
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});
