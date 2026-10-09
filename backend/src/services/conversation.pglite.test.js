// conversation.js against a real (in-process) Postgres: the thread scope, the folder rules, the
// Gmail-label dedup and the direction of each letter are decided by the SQL, so they are tested
// by running it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('./db.js', () => ({ query: (...args) => dbState.query(...args) }));

const { conversation } = await import('./conversation.js');

const SALES = '00000000-0000-0000-0000-000000000001';
const OPS = '00000000-0000-0000-0000-000000000002';
const id = (n) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

let db;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);
  await db.exec(`
    CREATE TABLE email_accounts (id uuid PRIMARY KEY, email_address text NOT NULL, folder_mappings jsonb);
    CREATE TABLE account_aliases (account_id uuid NOT NULL, email text NOT NULL);
    CREATE TABLE message_delivery_status (account_id uuid NOT NULL, message_id text NOT NULL, recipient text NOT NULL,
                          state text NOT NULL, event_at timestamptz, updated_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE folders (account_id uuid NOT NULL, path text NOT NULL, name text NOT NULL,
                          delimiter varchar(10), special_use text, no_select boolean NOT NULL DEFAULT false);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, account_id uuid NOT NULL, thread_key text, message_id text,
      folder text NOT NULL, subject text, snippet text, date timestamptz,
      from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
      has_attachments boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false
    );
  `);
  const mappings = JSON.stringify({ trash: 'Trash', spam: 'Junk', drafts: 'Drafts', sent: 'Sent' });
  await db.query('INSERT INTO email_accounts VALUES ($1, $2, $3), ($4, $5, $3)',
    [SALES, 'sales@x.example', mappings, OPS, 'ops@x.example']);
  await db.query("INSERT INTO account_aliases VALUES ($1, 'team@x.example')", [SALES]);
  await db.query(`INSERT INTO folders (account_id, path, name, special_use) VALUES
    ($1, 'INBOX', 'INBOX', NULL), ($1, 'Sent', 'Sent', '\\Sent'), ($1, 'Trash', 'Trash', '\\Trash'),
    ($1, 'Junk', 'Junk', '\\Junk'), ($1, 'Drafts', 'Drafts', '\\Drafts'), ($1, 'All Mail', 'All Mail', '\\All')`, [SALES]);

  const row = (n, account, folder, messageId, date, from, extra = {}) => [
    id(n), account, extra.thread ?? 't1', messageId, folder, `Subject ${n}`, `Snippet ${n}`,
    date, extra.fromName ?? null, from, JSON.stringify(extra.to ?? []), JSON.stringify([]), extra.deleted ?? false,
  ];
  const rows = [
    row(1, SALES, 'INBOX', '<a@c>', '2026-09-01T10:00:00Z', 'maya@c.example', { to: [{ email: 'sales@x.example' }] }),
    row(2, SALES, 'All Mail', '<a@c>', '2026-09-01T10:00:00Z', 'maya@c.example'), // label copy of 1
    row(3, SALES, 'Sent', '<b@x>', '2026-09-02T10:00:00Z', 'Team@x.example', { to: [{ email: 'maya@c.example' }] }),
    row(4, SALES, 'Drafts', '<c@x>', '2026-09-03T10:00:00Z', 'sales@x.example'),
    row(5, SALES, 'Trash', '<d@c>', '2026-09-04T10:00:00Z', 'maya@c.example'),
    row(6, SALES, 'Junk', '<e@c>', '2026-09-05T10:00:00Z', 'maya@c.example'),
    row(7, SALES, 'INBOX', '<f@c>', '2026-09-06T10:00:00Z', 'maya@c.example', { deleted: true }),
    row(8, SALES, 'INBOX', '<g@c>', '2026-09-07T10:00:00Z', 'boss@c.example', { thread: 't2' }),
    row(9, OPS, 'INBOX', '<a@c>', '2026-09-01T10:00:00Z', 'maya@c.example'), // same thread, other mailbox
    // Self-sent (from = to = sales@x.example): 'in' outside Sent, 'out' in Sent.
    row(10, SALES, 'INBOX', '<self1@x>', '2026-09-10T10:00:00Z', 'sales@x.example', { thread: 't3', to: [{ email: 'sales@x.example' }] }),
    row(11, SALES, 'Sent', '<self2@x>', '2026-09-11T10:00:00Z', 'sales@x.example', { thread: 't4', to: [{ email: 'sales@x.example' }] }),
    // Same self-sent letter filed in both Inbox and Sent (Gmail keeps a copy in each) — the
    // dedup must keep exactly one copy, and it must be the Inbox one (see the SQL tie-break).
    row(12, SALES, 'INBOX', '<self3@x>', '2026-09-12T10:00:00Z', 'sales@x.example', { thread: 't5', to: [{ email: 'sales@x.example' }] }),
    row(13, SALES, 'Sent', '<self3@x>', '2026-09-12T10:00:00Z', 'sales@x.example', { thread: 't5', to: [{ email: 'sales@x.example' }] }),
  ];
  for (const r of rows) {
    await db.query(`INSERT INTO messages (id, account_id, thread_key, message_id, folder, subject, snippet, date,
      from_name, from_email, to_addresses, cc_addresses, is_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, r);
  }
});

afterAll(async () => { await db?.close(); });

describe('conversation', () => {
  it('lists the thread of this mailbox oldest first, one copy per letter, trash, spam and deleted left out', async () => {
    const result = await conversation(id(3));
    expect(result.threadKey).toBe('t1');
    expect(result.items.map((i) => i.id)).toEqual([id(1), id(3), id(4)]);
    expect(result.total).toBe(3);
  });

  it('marks each letter received, sent (also through an alias) or draft', async () => {
    const result = await conversation(id(1));
    expect(result.items.map((i) => i.direction)).toEqual(['in', 'out', 'draft']);
  });

  it('keeps the Inbox copy of a letter that also sits under a Gmail label', async () => {
    const result = await conversation(id(2));
    expect(result.items[0].id).toBe(id(1));
    expect(result.items[0].folder).toBe('INBOX');
  });

  it('never reaches the same conversation in another mailbox', async () => {
    const result = await conversation(id(9));
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });

  it('keeps the newest letters of a thread longer than the cap and counts them all', async () => {
    const { CONVERSATION_MAX_LETTERS } = await import('./conversation.js');
    const extra = CONVERSATION_MAX_LETTERS + 5;
    for (let n = 0; n < extra; n++) {
      const date = new Date(Date.UTC(2026, 7, 1, 0, n)).toISOString();
      await db.query(`INSERT INTO messages (id, account_id, thread_key, message_id, folder, date, from_email)
        VALUES ($1, $2, 'long', $3, 'INBOX', $4, 'maya@c.example')`,
        [`30000000-0000-0000-0000-${String(n).padStart(12, '0')}`, SALES, `<long-${n}@c>`, date]);
    }
    const result = await conversation('30000000-0000-0000-0000-000000000000');
    expect(result.total).toBe(extra);
    expect(result.items).toHaveLength(CONVERSATION_MAX_LETTERS);
    expect(result.items.at(-1).id).toBe(`30000000-0000-0000-0000-${String(extra - 1).padStart(12, '0')}`);
    expect(result.items[0].id).toBe(`30000000-0000-0000-0000-${String(5).padStart(12, '0')}`);
  });

  it('is null for an unknown or deleted letter', async () => {
    expect(await conversation(id(7))).toBeNull();
    expect(await conversation('20000000-0000-0000-0000-00000000ffff')).toBeNull();
  });

  it('marks a letter the mailbox sent to itself "in" outside Sent, and "out" inside Sent', async () => {
    const outsideSent = await conversation(id(10));
    expect(outsideSent.items.map((i) => i.direction)).toEqual(['in']);

    const insideSent = await conversation(id(11));
    expect(insideSent.items.map((i) => i.direction)).toEqual(['out']);
  });

  it('carries the delivery mark of a sent letter, never of an Inbox copy (R-17)', async () => {
    await db.query(`INSERT INTO message_delivery_status (account_id, message_id, recipient, state, event_at) VALUES
      ($1, '<b@x>', 'maya@c.example', 'bounced', NOW()), ($1, '<self3@x>', 'sales@x.example', 'bounced', NOW())`, [SALES]);
    try {
      const thread = await conversation(id(1));
      expect(thread.items.map((i) => [i.id, i.delivery_state])).toEqual([[id(1), null], [id(3), 'failed'], [id(4), null]]);
      // The self-sent letter is shown by its Inbox copy: no mark there.
      expect((await conversation(id(12))).items[0].delivery_state).toBeNull();
    } finally {
      await db.query('DELETE FROM message_delivery_status');
    }
  });

  it('dedups a self-sent letter filed in both Inbox and Sent to its Inbox copy, read as received', async () => {
    const result = await conversation(id(12));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].folder).toBe('INBOX');
    expect(result.items[0].direction).toBe('in');
  });
});
