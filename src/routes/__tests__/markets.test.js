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
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });
});

describe('GET /markets/stats', () => {
  it('retorna total_volume, active_markets e active_traders', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_volume: '12345.67' }] })
      .mockResolvedValueOnce({ rows: [{ total: '5' }] })
      .mockResolvedValueOnce({ rows: [{ total: '42' }] });

    const res = await request(app).get('/markets/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_volume');
    expect(res.body).toHaveProperty('active_markets');
    expect(res.body).toHaveProperty('active_traders');
    expect(res.body.active_markets).toBe(5);
    expect(res.body.active_traders).toBe(42);
  });
});

describe('GET /markets/:id', () => {
  it('retorna 404 para mercado inexistente', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
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
