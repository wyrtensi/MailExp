import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));

import express from 'express';
import contactRoutes from './contacts.js';
import { query } from '../services/db.js';

describe('contact websites', () => {
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
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      if (/SELECT \* FROM contacts/.test(sql)) {
        return { rows: [{ id: '22222222-2222-4222-8222-222222222222', uid: 'u1', display_name: 'Dana', emails: [], phones: [], urls: [] }] };
      }
      return { rows: [{ id: '22222222-2222-4222-8222-222222222222', uid: 'u1', emails: [], phones: [], urls: [] }] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/contacts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const writeCall = (verb) => query.mock.calls.find(([sql]) => sql.includes(verb));

  it('stores a new contact\'s websites normalised and in its vCard', async () => {
    const res = await send('POST', '', { displayName: 'Dana', urls: [{ value: 'dana.example.com', type: 'work' }] });
    expect(res.status).toBe(201);
    const [sql, params] = writeCall('INSERT INTO contacts');
    expect(sql).toMatch(/urls/);
    expect(params).toContain(JSON.stringify([{ value: 'https://dana.example.com', type: 'work' }]));
    expect(params[2]).toMatch(/URL;TYPE=WORK:https:\/\/dana\.example\.com/);
  });

  it('updates websites on an existing contact', async () => {
    const res = await send('PATCH', '/22222222-2222-4222-8222-222222222222', { urls: [{ value: 'https://new.example.com', type: 'home' }] });
    expect(res.status).toBe(200);
    const [sql, params] = writeCall('UPDATE contacts SET');
    expect(sql).toMatch(/urls = /);
    expect(params).toContain(JSON.stringify([{ value: 'https://new.example.com', type: 'home' }]));
  });

  it('rejects a website that is not an http or https address', async () => {
    const res = await send('POST', '', { displayName: 'Dana', urls: [{ value: 'javascript:alert(1)' }] });
    expect(res.status).toBe(400);
    expect(writeCall('INSERT INTO contacts')).toBeUndefined();
  });

  it('finds contacts by website and returns websites in the list', async () => {
    const res = await send('GET', '?q=dana.example');
    expect(res.status).toBe(200);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/jsonb_array_elements\(c\.urls\)/);
    expect(sql).toMatch(/c\.urls/);
  });
});
