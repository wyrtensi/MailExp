import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));

import express from 'express';
import contactRoutes from './contacts.js';
import { query } from '../services/db.js';

const ID = '22222222-2222-4222-8222-222222222222';

// A contact the form cannot save answers a 4xx with a code the screens translate; a malformed
// field never reaches the vCard builder, whose TypeError used to surface as a 500.
describe('contact refusals', () => {
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
      if (/SELECT \* FROM contacts/.test(sql)) return { rows: [{ id: ID, uid: 'u1', emails: [], phones: [], urls: [] }] };
      return { rows: [{ id: ID, uid: 'u1', emails: [], phones: [], urls: [] }] };
    });
  });

  const send = (method, path, body) => fetch(`${base}/api/contacts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const wrote = () => query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql));

  it.each([
    [{ displayName: 'Dana', emails: 'a@example.com' }],
    [{ displayName: 'Dana', emails: [null] }],
    [{ displayName: 'Dana', emails: [{ value: 42 }] }],
    [{ displayName: 'Dana', phones: [{ value: '1', type: 7 }] }],
    [{ displayName: 42 }],
    [{ displayName: 'Dana', notes: { a: 1 } }],
  ])('a malformed field is a 400 invalid_contact_field: %j', async (body) => {
    expect(await send('POST', '', body)).toMatchObject({ status: 400, body: { code: 'invalid_contact_field' } });
    expect(await send('PATCH', `/${ID}`, body)).toMatchObject({ status: 400, body: { code: 'invalid_contact_field' } });
    expect(wrote()).toBe(false);
  });

  it('a contact with neither name nor address is a 400 contact_name_required', async () => {
    expect(await send('POST', '', {})).toMatchObject({ status: 400, body: { code: 'contact_name_required' } });
  });

  it('a bad website is a 400 invalid_contact_url', async () => {
    const res = await send('POST', '', { displayName: 'Dana', urls: [{ value: 'javascript:alert(1)' }] });
    expect(res).toMatchObject({ status: 400, body: { code: 'invalid_contact_url' } });
  });

  it('a duplicate address is a 409 contact_exists', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO contacts')) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [] };
    });
    const res = await send('POST', '', { emails: [{ value: 'dana@example.com' }] });
    expect(res).toEqual({ status: 409, body: { error: 'A contact with that email already exists', code: 'contact_exists' } });
  });

  it('an unknown contact is a 404 contact_not_found', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await send('GET', `/${ID}`)).toMatchObject({ status: 404, body: { code: 'contact_not_found' } });
    expect(await send('PATCH', `/${ID}`, { displayName: 'x' })).toMatchObject({ status: 404, body: { code: 'contact_not_found' } });
    expect(await send('DELETE', `/${ID}`)).toMatchObject({ status: 404, body: { code: 'contact_not_found' } });
  });
});
