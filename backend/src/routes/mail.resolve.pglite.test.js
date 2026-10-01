// GET /resolve-message against a real (in-process) Postgres. A deep link resolves a Message-ID,
// and one email delivered to two mailboxes has a copy with that Message-ID in each, usually
// with the same Date. Which copy a link opens, and marks read, is decided by the query's
// ORDER BY, so it is tested by running it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('../services/db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;

// SALES sorts before OPS.
const SALES = '00000000-0000-4000-8000-00000000000a';
const OPS = '00000000-0000-4000-8000-00000000000b';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MID = '<shared@c.example>';

let db;
let server;
let base;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY, name text, email_address text, color text);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, uid int, folder text NOT NULL, message_id text, subject text,
      from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb, reply_to jsonb,
      in_reply_to text, date timestamptz, snippet text,
      is_read boolean NOT NULL DEFAULT false, is_starred boolean NOT NULL DEFAULT false,
      has_attachments boolean NOT NULL DEFAULT false, account_id uuid NOT NULL, category text,
      list_unsubscribe text, list_unsubscribe_post text, unsubscribed_at timestamptz,
      delivery_addresses jsonb, eop_category text, is_deleted boolean NOT NULL DEFAULT false
    );
  `);
  await db.query("INSERT INTO email_accounts (id, name) VALUES ($1, 'sales'), ($2, 'ops')", [SALES, OPS]);
  // Inserted so that insertion order never happens to give the expected answer: OPS's copy
  // first, and of SALES's two INBOX UIDs (providers do store one letter twice) the higher id.
  const rows = [
    [2, OPS, 'INBOX'],
    [4, SALES, 'INBOX'],
    [1, SALES, 'INBOX'],
    [3, SALES, 'All Mail'],
  ];
  for (const [n, account, folder] of rows) {
    await db.query(`INSERT INTO messages (id, account_id, folder, message_id, date)
      VALUES ($1, $2, $3, $4, '2026-09-01T10:00:00Z')`, [id(n), account, folder, MID]);
  }

  const app = express();
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await db?.close();
});

async function resolve(params) {
  const response = await fetch(`${base}/api/mail/resolve-message?${new URLSearchParams(params)}`);
  expect(response.status).toBe(200);
  return (await response.json()).id;
}

describe('GET /api/mail/resolve-message in Postgres', () => {
  it('opens the copy of the mailbox the link names', async () => {
    expect(await resolve({ ref: MID, accountId: OPS })).toBe(id(2));
    expect(await resolve({ ref: MID, accountId: SALES })).toBe(id(1));
  });

  it('picks the same copy every time for a link without a mailbox', async () => {
    // The INBOX copies share the Date; without a tie-break Postgres may return any of them, so
    // an old link could open, and mark read, a different mailbox's copy on each click.
    expect(await resolve({ ref: MID })).toBe(id(1));
  });

  it('picks the same UID when a mailbox holds the letter twice', async () => {
    expect(await resolve({ ref: MID, accountId: SALES })).toBe(id(1));
  });
});
