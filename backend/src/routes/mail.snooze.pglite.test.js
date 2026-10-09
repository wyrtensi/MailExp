// POST /messages/:id/snooze against a real (in-process) Postgres. A message moved out of
// Snoozed by hand keeps its snooze record until the wake-up sweep removes it, a few minutes
// after its wake time; until then the record must not refuse a new snooze, and the new snooze
// must be the only record so the old wake time cannot wake the message early.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('../services/db.js', () => ({ query: (...args) => dbState.query(...args) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: '00000000-0000-4000-8000-0000000000aa' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    ensureFolder: vi.fn(async () => {}),
    moveMessage: vi.fn(async () => 500),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  },
}));

const express = (await import('express')).default;
const mailRoutes = (await import('./mail.js')).default;

const ACCOUNT = '00000000-0000-4000-8000-00000000000a';
const MSG = '10000000-0000-4000-8000-000000000001';

let db;
let server;
let base;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY, name text, folder_mappings jsonb);
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, name text NOT NULL,
                          delimiter varchar(10), special_use text, no_select boolean NOT NULL DEFAULT false,
                          total_count int NOT NULL DEFAULT 0, unread_count int NOT NULL DEFAULT 0);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, uid int, folder text NOT NULL, message_id text, thread_id text,
      in_reply_to text, thread_references text, is_read boolean NOT NULL DEFAULT true,
      account_id uuid NOT NULL, is_deleted boolean NOT NULL DEFAULT false
    );
    CREATE TABLE snoozed_messages (
      id serial PRIMARY KEY, snoozed_by uuid, account_id uuid NOT NULL, message_id_header text NOT NULL,
      original_folder text NOT NULL, snooze_until timestamptz NOT NULL, snoozed_folder text NOT NULL
    );
  `);
  await db.query("INSERT INTO email_accounts (id, name) VALUES ($1, 'sales')", [ACCOUNT]);

  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await db?.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM snoozed_messages;');
});

const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const snooze = (until) => fetch(`${base}/api/mail/messages/${MSG}/snooze`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }),
});
const records = async () => (await db.query(
  'SELECT message_id_header, snooze_until FROM snoozed_messages ORDER BY id'
)).rows;

describe('POST /api/mail/messages/:id/snooze in Postgres', () => {
  it('snoozes again a message moved out of Snoozed by hand, replacing the leftover record', async () => {
    // Snoozed earlier until tomorrow, then moved back to INBOX by hand.
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'INBOX', '<a@x>', $2)`, [MSG, ACCOUNT]);
    await db.query(`INSERT INTO snoozed_messages (account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
      VALUES ($1, '<a@x>', 'INBOX', $2, 'Snoozed')`, [ACCOUNT, inDays(1)]);

    const until = inDays(3);
    const res = await snooze(until);
    expect(res.status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].snooze_until).toISOString()).toBe(until);
  });

  it('still refuses a message whose snooze is live, i.e. that sits in its Snoozed folder', async () => {
    // A second row of the same letter is still in Snoozed under its live record.
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id) VALUES ($1, 7, 'INBOX', '<a@x>', $2)`, [MSG, ACCOUNT]);
    await db.query(`INSERT INTO messages (id, uid, folder, message_id, account_id)
      VALUES ('10000000-0000-4000-8000-000000000002', 8, 'Snoozed', '<a@x>', $1)`, [ACCOUNT]);
    await db.query(`INSERT INTO snoozed_messages (account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
      VALUES ($1, '<a@x>', 'INBOX', $2, 'Snoozed')`, [ACCOUNT, inDays(1)]);

    const res = await snooze(inDays(3));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Message is already snoozed');
    expect(await records()).toHaveLength(1);
  });
});
