import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/contactLetters.js', () => ({
  contactLetters: vi.fn(),
  CONTACT_LETTERS_DEFAULT_LIMIT: 20,
}));

import express from 'express';
import contactRoutes from './contacts.js';
import { contactLetters } from '../services/contactLetters.js';

describe('GET /api/contacts/:id/letters', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/contacts', contactRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { contactLetters.mockReset(); });

  it('passes limit and offset through and returns the service result', async () => {
    contactLetters.mockResolvedValueOnce({
      received: 2, sent: 1, lastDate: '2026-09-16T08:45:00.000Z', total: 3,
      items: [{ id: 'm1', account_id: 'a1', folder: 'INBOX', subject: 'Hi', snippet: 's', date: '2026-09-16T08:45:00.000Z', direction: 'in' }],
    });

    const res = await fetch(`${base}/api/contacts/22222222-2222-4222-8222-222222222222/letters?limit=5&offset=10`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: 2, sent: 1, lastDate: '2026-09-16T08:45:00.000Z', total: 3,
      items: [{ id: 'm1', account_id: 'a1', folder: 'INBOX', subject: 'Hi', snippet: 's', date: '2026-09-16T08:45:00.000Z', direction: 'in' }],
    });
    expect(contactLetters).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', { limit: '5', offset: '10' });
  });

  it('defaults limit and offset when not given', async () => {
    contactLetters.mockResolvedValueOnce({ received: 0, sent: 0, lastDate: null, total: 0, items: [] });

    const res = await fetch(`${base}/api/contacts/22222222-2222-4222-8222-222222222222/letters`);

    expect(res.status).toBe(200);
    expect(contactLetters).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', { limit: 20, offset: 0 });
  });

  it('404s for an unknown contact', async () => {
    contactLetters.mockResolvedValueOnce(null);

    const res = await fetch(`${base}/api/contacts/44444444-4444-4444-8444-444444444444/letters`);

    expect(res.status).toBe(404);
  });

  it('500s if the service throws, without leaking the error', async () => {
    contactLetters.mockRejectedValueOnce(new Error('db exploded'));

    const res = await fetch(`${base}/api/contacts/22222222-2222-4222-8222-222222222222/letters`);

    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/db exploded/);
  });
});
