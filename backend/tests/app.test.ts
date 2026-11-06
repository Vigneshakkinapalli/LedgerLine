import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/pool.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) }));
import { app } from '../src/app.js';

describe('API foundation', () => {
  it('reports database health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', database: 'ok' });
    expect(response.headers['x-correlation-id']).toBeTruthy();
  });
  it('rejects zero and negative amounts', async () => {
    for (const amountPaise of ['0', '-1', '1.5', 'not-a-number']) {
      const response = await request(app).post('/api/v1/validation/amount').send({ amountPaise });
      expect(response.status, amountPaise).toBe(400);
    }
  });
  it('accepts a positive integer amount as a string', async () => {
    const response = await request(app).post('/api/v1/validation/amount').send({ amountPaise: '10050' });
    expect(response.status).toBe(200);
    expect(response.body.amountPaise).toBe('10050');
  });
  it('returns a consistent not-found error', async () => {
    const response = await request(app).get('/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
