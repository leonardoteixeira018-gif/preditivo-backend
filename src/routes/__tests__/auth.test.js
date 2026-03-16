jest.mock('../../lib/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../../lib/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(true)
}));
jest.mock('../../lib/emailVerification', () => ({
  createEmailVerification: jest.fn().mockResolvedValue({ ok: true }),
  consumeEmailVerification: jest.fn(),
  CODE_EXPIRATION_MINUTES: 10
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// Limpa fila de mockResolvedValueOnce entre todos os testes
afterEach(() => jest.clearAllMocks());

const request = require('supertest');
const pool = require('../../lib/db');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/auth', require('../auth'));

describe('POST /auth/login', () => {
  afterEach(() => jest.clearAllMocks());

  it('retorna 400 para usuário não encontrado', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'naoexiste@test.com', password: '123456' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('retorna 400 para senha incorreta', async () => {
    // bcrypt hash de "correctpassword"
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('correctpassword', 10);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-id',
        email: 'test@test.com',
        password_hash: hash,
        username: 'testuser',
        balance: 0,
        bonus_balance: 0,
        two_fa_enabled: false
      }]
    });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@test.com', password: 'wrongpassword' });
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/me', () => {
  it('retorna 401 sem token', async () => {
    // Middleware JWT rejeita antes de qualquer query — não precisa de mock de DB
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/forgot-password', () => {
  afterEach(() => jest.clearAllMocks());

  it('retorna resposta genérica para email inexistente', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'naoexiste@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Não deve revelar se email existe ou não
    expect(res.body.message).toMatch(/se o email existir/i);
  });

  it('retorna 400 sem email', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
  });

  it('envia código e retorna resposta genérica para email válido', async () => {
    const { createEmailVerification } = require('../../lib/emailVerification');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'user-id' }]
    });
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'existe@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(createEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'password_reset' })
    );
  });
});
