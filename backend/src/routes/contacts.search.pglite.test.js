import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

const state = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => state.db.query(sql, params),
}));

import routes from './contacts.js';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const users = [
  '08000000-0000-4000-8000-000000000001',
  '08000000-0000-4000-8000-000000000002',
];
let server;
let base;

beforeAll(async () => {
  state.db = await createRealSchemaDb();
  for (const [index, id] of users.entries()) {
    await state.db.query('INSERT INTO users (id, username) VALUES ($1, $2)', [id, `search-user-${index}`]);
  }
  const { rows: books } = await state.db.query('SELECT id FROM address_books LIMIT 1');
  await state.db.query(`INSERT INTO contacts
    (address_book_id, uid, display_name, primary_email, emails, phones, urls, organization)
    VALUES ($1, 'search-fixture', 'Synthetic Person', 'primary@example.com',
      '[{"value":"secondary@example.com"}]', '[{"value":"+15551234567"}]',
      '[{"value":"https://example.com/website-only"}]', 'Synthetic Organization')`, [books[0].id]);
  const app = express();
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = { userId, destroy: () => {} };
    next();
  });
  app.use('/api/contacts', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/contacts`;
}, 30000);

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await state.db?.close();
});

async function search(q, userId = users[0]) {
  return fetch(`${base}?q=${encodeURIComponent(q)}`, {
    headers: userId ? { 'x-test-user': userId } : {},
  });
}

describe('contact search on the real schema', () => {
  it.each([
    ['name', '  SYNTHETIC PERSON  '],
    ['primary email', 'PRIMARY@'],
    ['secondary email', 'SECONDARY@'],
    ['phone', '1234567'],
    ['URL', 'WEBSITE-ONLY'],
    ['organization', 'SYNTHETIC ORGANIZATION'],
  ])('finds a contact by %s', async (_field, q) => {
    const res = await search(q);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.contacts.map(contact => contact.uid)).toEqual(['search-fixture']);
  });

  it.each(['', '   '])('lists all contacts for an empty query %j', async q => {
    const res = await search(q);
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
  });

  it('returns an empty result when nothing matches', async () => {
    const res = await search('absent-contact');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: [], total: 0 });
  });

  it('shares search results between signed-in users', async () => {
    const res = await search('website-only', users[1]);
    expect(res.status).toBe(200);
    expect((await res.json()).contacts.map(contact => contact.uid)).toEqual(['search-fixture']);
  });

  it('requires sign-in', async () => {
    expect((await search('website-only', null)).status).toBe(401);
  });
});
