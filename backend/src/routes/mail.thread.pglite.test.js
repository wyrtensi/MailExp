// GET /thread/:threadId against a real (in-process) Postgres. Which copy of a letter the thread
// keeps, and in what order, is decided by the SQL's DISTINCT ON and ORDER BY, so they are tested
// by running it: a mocked query cannot tell a key that keeps both mailboxes' copies from one
// that drops one, and cannot notice an ORDER BY that does not start with the DISTINCT ON key,
// which Postgres rejects at run time.
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

// SALES sorts before OPS, so the date tie between their copies must come out SALES first.
const SALES = '00000000-0000-4000-8000-00000000000a';
const OPS = '00000000-0000-4000-8000-00000000000b';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db;
let server;
let base;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (
      id uuid PRIMARY KEY, name text, email_address text, color text, folder_mappings jsonb,
      enabled boolean NOT NULL DEFAULT true, include_in_unified_inbox boolean NOT NULL DEFAULT true
    );
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, name text NOT NULL,
                          special_use text, no_select boolean NOT NULL DEFAULT false);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, uid int, folder text NOT NULL, message_id text, thread_id text,
      thread_key text, subject text, from_name text, from_email text, to_addresses jsonb,
      cc_addresses jsonb, reply_to jsonb, in_reply_to text, date timestamptz, snippet text,
      is_read boolean NOT NULL DEFAULT false, is_starred boolean NOT NULL DEFAULT false,
      has_attachments boolean NOT NULL DEFAULT false, account_id uuid NOT NULL, category text,
      list_unsubscribe text, list_unsubscribe_post text, unsubscribed_at timestamptz,
      delivery_addresses jsonb, eop_category text, is_deleted boolean NOT NULL DEFAULT false
    );
  `);
  await db.query("INSERT INTO email_accounts (id, name) VALUES ($1, 'sales'), ($2, 'ops')", [SALES, OPS]);

  // Inserted so that insertion order never happens to give the expected answer: the copies
  // that must lose come first, and OPS's copy comes before SALES's.
  const rows = [
    [1, SALES, 'All Mail', '<x@c>', '2026-09-01T10:00:00Z'], // label copy of 3
    [2, SALES, 'Sent', '<x@c>', '2026-09-01T10:00:00Z'], // Sent twin of 3
    [4, OPS, 'INBOX', '<x@c>', '2026-09-01T10:00:00Z'], // the same letter delivered to ops@
    [3, SALES, 'INBOX', '<x@c>', '2026-09-01T10:00:00Z'],
    [5, SALES, 'Sent', '<y@x>', '2026-09-02T10:00:00Z'], // the reply
    [6, SALES, 'INBOX', '<z@c>', '2026-09-03T10:00:00Z', true], // deleted
    // Two letters with one Date whose Message-IDs sort opposite to their row ids: the dedup
    // hands them over in Message-ID order, and only the id tie-break puts them in a fixed one.
    [7, SALES, 'INBOX', '<q@c>', '2026-09-04T10:00:00Z'],
    [8, SALES, 'INBOX', '<p@c>', '2026-09-04T10:00:00Z'],
    // Two letters without a Message-ID: nothing says they are copies of one letter.
    [9, SALES, 'INBOX', null, '2026-09-05T10:00:00Z'],
    [10, SALES, 'INBOX', null, '2026-09-06T10:00:00Z'],
  ];
  for (const [n, account, folder, messageId, date, deleted = false] of rows) {
    await db.query(`INSERT INTO messages (id, account_id, folder, message_id, thread_key, date, is_deleted)
      VALUES ($1, $2, $3, $4, 't1', $5, $6)`, [id(n), account, folder, messageId, date, deleted]);
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

async function thread(query = '') {
  const response = await fetch(`${base}/api/mail/thread/t1${query}`);
  expect(response.status).toBe(200);
  const { messages } = await response.json();
  return messages.map(m => m.id);
}

describe('GET /api/mail/thread in Postgres', () => {
  it('keeps each mailbox copy of a letter when the call spans mailboxes', async () => {
    expect(await thread()).toEqual([id(3), id(4), id(5), id(7), id(8), id(9), id(10)]);
  });

  it('keeps the same copies in a unified call', async () => {
    expect(await thread('?unified=true')).toEqual([id(3), id(4), id(5), id(7), id(8), id(9), id(10)]);
  });

  it('holds a scoped call to its mailbox', async () => {
    expect(await thread(`?accountId=${SALES}`)).toEqual([id(3), id(5), id(7), id(8), id(9), id(10)]);
    expect(await thread(`?accountId=${OPS}`)).toEqual([id(4)]);
  });

  it('orders letters that share a Date by mailbox, then row id', async () => {
    const ids = await thread();
    expect(ids.slice(0, 2)).toEqual([id(3), id(4)]); // SALES before OPS
    expect(ids.slice(3, 5)).toEqual([id(7), id(8)]);
  });

  it('keeps every letter without a Message-ID instead of collapsing them into one', async () => {
    // A thread action builds its id list from this route, so a dropped row would be left
    // behind by an archive, delete or move of the conversation.
    const ids = await thread(`?accountId=${SALES}`);
    expect(ids).toContain(id(9));
    expect(ids).toContain(id(10));
  });

  it('collapses the label copy and the Sent twin into the INBOX copy within one mailbox', async () => {
    const ids = await thread(`?accountId=${SALES}`);
    expect(ids).toContain(id(3));
    expect(ids).not.toContain(id(1));
    expect(ids).not.toContain(id(2));
  });
});
