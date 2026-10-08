import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));

import express from 'express';
import contactRoutes from './contacts.js';
import { query } from '../services/db.js';

// Contacts are one install-wide set kept inside the install; every contact is editable.
describe('contacts are shared', () => {
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
    query.mockReset().mockImplementation(async (sql) => (
      sql.includes('COUNT(*)')
        ? { rows: [{ count: '0' }] }
        : { rows: [{ id: '22222222-2222-4222-8222-222222222222', uid: 'u1', address_book_id: 'shared-book', emails: [], phones: [] }] }
    ));
  });

  const send = (method, path, body) => fetch(`${base}/api/contacts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const noOwnerOrSync = () => query.mock.calls.every(([sql]) => !/user_id|address_books|sync_token|source/.test(sql));

  it('lists every contact', async () => {
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    expect(noOwnerOrSync()).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([50, 0]);
    expect(query.mock.calls[0][0]).not.toMatch(/read_only/);
  });

  it('creates a contact in the shared book', async () => {
    const res = await send('POST', '', { displayName: 'Dana', emails: [{ value: 'Dana@Example.com' }] });
    expect(res.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO contacts'));
    expect(sql).toMatch(/address_book_id, uid, vcard, etag/);
    expect(params[0]).toBe('shared-book');
    expect(params).toContain('dana@example.com');
    expect(noOwnerOrSync()).toBe(true);
  });

  it('edits a contact whoever created it', async () => {
    const res = await send('PATCH', '/22222222-2222-4222-8222-222222222222', { displayName: 'Dana B' });
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT * FROM contacts WHERE id = $1', ['22222222-2222-4222-8222-222222222222']);
    const [, params] = query.mock.calls.find(([s]) => s.includes('UPDATE contacts SET'));
    // The 12th parameter is the contact's websites.
    expect(params).toHaveLength(12);
    expect(params[10]).toBe('22222222-2222-4222-8222-222222222222');
    expect(noOwnerOrSync()).toBe(true);
  });

  it('finds a contact photo by address alone', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await send('GET', '/photo?email=Dana@Example.com')).status).toBe(404);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE primary_email = lower\(\$1\)/);
    expect(params).toEqual(['Dana@Example.com']);
  });

  it('deletes a contact whoever created it', async () => {
    expect((await send('DELETE', '/22222222-2222-4222-8222-222222222222')).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('DELETE FROM contacts WHERE id = $1 RETURNING id', ['22222222-2222-4222-8222-222222222222']);
  });
});
