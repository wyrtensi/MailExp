// senderHistory.js against a real (in-process) Postgres: the dedup tie-break and the direction
// of each letter are decided by the SQL/JS pairing, so they are tested by running it — mirrors
// conversation.pglite.test.js's setup.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('./db.js', () => ({ query: (...args) => dbState.query(...args) }));

const { senderHistory } = await import('./senderHistory.js');

const SALES = '00000000-0000-0000-0000-000000000001';
const id = (n) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

let db;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY, email_address text NOT NULL, folder_mappings jsonb);
    CREATE TABLE account_aliases (account_id uuid NOT NULL, email text NOT NULL);
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, name text NOT NULL,
                          special_use text, no_select boolean NOT NULL DEFAULT false);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, account_id uuid NOT NULL, message_id text,
      folder text NOT NULL, subject text, snippet text, date timestamptz,
      from_email text, to_addresses jsonb, cc_addresses jsonb,
      is_deleted boolean NOT NULL DEFAULT false
    );
  `);
  const mappings = JSON.stringify({ trash: 'Trash', spam: 'Junk', drafts: 'Drafts', sent: 'Sent' });
  await db.query('INSERT INTO email_accounts VALUES ($1, $2, $3)', [SALES, 'sales@x.example', mappings]);
  await db.query(`INSERT INTO folders (account_id, path, name, special_use) VALUES
    ($1, 'INBOX', 'INBOX', NULL), ($1, 'Sent', 'Sent', '\\Sent')`, [SALES]);

  const row = (n, folder, messageId, date, from, to, cc = []) => [
    id(n), SALES, folder, `Subject ${n}`, `Snippet ${n}`, date, messageId, from, JSON.stringify(to), JSON.stringify(cc),
  ];
  const rows = [
    // The open letter: a plain incoming letter from maya, so her address is the correspondent.
    row(1, 'INBOX', '<open@c>', '2026-09-20T10:00:00Z', 'maya@c.example', [{ email: 'sales@x.example' }]),
    // Earlier: the mailbox wrote to maya while cc'ing itself, filed only in Inbox — no Sent copy.
    // Outside Sent, self-cc means it is also a received copy: 'in'.
    row(2, 'INBOX', '<cc-self-inbox@x>', '2026-09-10T09:00:00Z', 'sales@x.example', [{ email: 'maya@c.example' }], [{ email: 'sales@x.example' }]),
    // Same shape, but this one sits in the account's own Sent folder: 'out'.
    row(3, 'Sent', '<cc-self-sent@x>', '2026-09-11T09:00:00Z', 'sales@x.example', [{ email: 'maya@c.example' }], [{ email: 'sales@x.example' }]),
    // A plain reply to maya, no self-cc: 'out' even though it also happens to sit in Sent.
    row(4, 'Sent', '<plain-reply@x>', '2026-09-12T09:00:00Z', 'sales@x.example', [{ email: 'maya@c.example' }]),
    // Same self-cc'd letter (same message_id) filed in both Inbox and Sent — the dedup must keep
    // exactly one copy, and it must be the Inbox one, reading as 'in'.
    row(5, 'INBOX', '<dedup@x>', '2026-09-13T09:00:00Z', 'sales@x.example', [{ email: 'maya@c.example' }], [{ email: 'sales@x.example' }]),
    row(6, 'Sent', '<dedup@x>', '2026-09-13T09:00:00Z', 'sales@x.example', [{ email: 'maya@c.example' }], [{ email: 'sales@x.example' }]),
  ];
  for (const r of rows) {
    await db.query(`INSERT INTO messages (id, account_id, folder, subject, snippet, date, message_id, from_email, to_addresses, cc_addresses)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r);
  }
});

afterAll(async () => { await db?.close(); });

describe('senderHistory', () => {
  it('marks a letter cc\'d to the mailbox itself "in" outside Sent, and "out" inside Sent', async () => {
    const result = await senderHistory(id(1));
    expect(result.correspondent).toBe('maya@c.example');
    const outsideSent = result.items.find((i) => i.id === id(2));
    const insideSent = result.items.find((i) => i.id === id(3));
    expect(outsideSent?.direction).toBe('in');
    expect(insideSent?.direction).toBe('out');
  });

  it('marks a plain reply "out", Sent folder or not', async () => {
    const result = await senderHistory(id(1));
    const plainReply = result.items.find((i) => i.id === id(4));
    expect(plainReply?.direction).toBe('out');
  });

  it('dedups a self-cc\'d letter filed in both Inbox and Sent to its Inbox copy, read as received', async () => {
    const result = await senderHistory(id(1));
    const survivors = result.items.filter((i) => [id(5), id(6)].includes(i.id));
    expect(survivors.length).toBe(1);
    expect(survivors[0].id).toBe(id(5));
    expect(survivors[0].folder).toBe('INBOX');
    expect(survivors[0].direction).toBe('in');
  });
});
