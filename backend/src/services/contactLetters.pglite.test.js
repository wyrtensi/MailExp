// Behavioural coverage for contactLetters.js against a real (in-process) Postgres engine.
//
// The mocked-query tests in contactLetters.test.js only assert on the SQL text and the
// parameter arrays built in JS — they'd still pass if the CASE branches were swapped, the
// trash/spam skip were dropped, or DISTINCT ON picked the wrong copy. This file runs the actual
// SQL (including migration 0071's message_recipient_addresses() function and its GIN index)
// against PGlite, with a minimal schema covering only the columns contactLetters.js reads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PGlite } from '@electric-sql/pglite';

const dbState = { query: null };
vi.mock('./db.js', () => ({ query: (...args) => dbState.query(...args) }));

const { contactLetters } = await import('./contactLetters.js');

const dir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(dir, '..', '..', 'migrations');

// The real runner (services/migrations.js) executes a "-- no-transaction" migration one
// statement at a time outside a transaction, for CREATE INDEX CONCURRENTLY. A manual check
// showed PGlite accepts CONCURRENTLY directly, so no stripping was needed here.
async function runMigrationFile(pglite, filename) {
  const sql = readFileSync(join(migrationsDir, filename), 'utf8');
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await pglite.query(statement);
  }
}

const ACCT_SALES = '00000000-0000-0000-0000-000000000001';
const ACCT_OPS = '00000000-0000-0000-0000-000000000002';
const ACCT_DISABLED = '00000000-0000-0000-0000-000000000003';

const CONTACT_MAYA = '10000000-0000-0000-0000-000000000001';
const CONTACT_SELF_MAILBOX = '10000000-0000-0000-0000-000000000002'; // address == ACCT_SALES's own

const M1 = '20000000-0000-0000-0000-000000000001'; // in: plain incoming letter
const M2 = '20000000-0000-0000-0000-000000000002'; // out: sent through the alias
const M3 = '20000000-0000-0000-0000-000000000003'; // Gmail-label dup of M1's message_id, copy A
const M3B = '20000000-0000-0000-0000-00000000003b'; // Gmail-label dup of M1's message_id, copy B
const M4 = '20000000-0000-0000-0000-000000000004'; // trash: must be skipped
const M5 = '20000000-0000-0000-0000-000000000005'; // spam: must be skipped
const M6 = '20000000-0000-0000-0000-000000000006'; // drafts: must be skipped
const M7 = '20000000-0000-0000-0000-000000000007'; // disabled account: must be excluded
const M8 = '20000000-0000-0000-0000-000000000008'; // pagination tie, letter A
const M9 = '20000000-0000-0000-0000-000000000009'; // pagination tie, letter B
const M_SELF_SENT = '30000000-0000-0000-0000-000000000001'; // precedence: own address, not to contact2
const M_CROSS_MAILBOX = '30000000-0000-0000-0000-000000000002'; // sales@ writes to ops@ — a genuine 'in' for contact2
const M_SELF_ADDRESSED_INBOX = '30000000-0000-0000-0000-000000000003'; // sales@ -> sales@, in INBOX: 'in'
const M_SELF_ADDRESSED_SENT = '30000000-0000-0000-0000-000000000004'; // sales@ -> sales@, in Sent: 'out'
const M_SELF_DEDUP_INBOX = '30000000-0000-0000-0000-000000000005'; // same letter filed in both Inbox...
const M_SELF_DEDUP_SENT = '30000000-0000-0000-0000-000000000006'; // ...and Sent — Inbox copy must survive

let db;

beforeAll(async () => {
  db = new PGlite();
  dbState.query = async (text, params) => db.query(text, params);

  // Minimal schema: only the columns contactLetters.js's queries touch.
  await db.query(`
    CREATE TABLE email_accounts (
      id uuid PRIMARY KEY,
      email_address text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      folder_mappings jsonb,
      include_in_unified_inbox boolean NOT NULL DEFAULT true
    )
  `);
  await db.query(`
    CREATE TABLE account_aliases (
      account_id uuid NOT NULL,
      email text NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE contacts (
      id uuid PRIMARY KEY,
      emails jsonb
    )
  `);
  await db.query(`
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      folder text NOT NULL,
      subject text,
      snippet text,
      date timestamptz,
      message_id text,
      from_email text,
      to_addresses jsonb DEFAULT '[]'::jsonb,
      cc_addresses jsonb DEFAULT '[]'::jsonb,
      is_deleted boolean NOT NULL DEFAULT false
    )
  `);

  // Runs migration 0071 (the function + GIN index the 'out' branch depends on) as a file, the
  // way the real runner would apply it. Also runs 0070 for its own sake — it only touches
  // email_accounts's default and existing rows, so it's a light sanity check that the file is
  // syntactically valid against this engine, not something contactLetters.js depends on.
  await runMigrationFile(db, '0070_unified_inbox_all_mailboxes.sql');
  await runMigrationFile(db, '0071_message_recipient_addresses_index.sql');

  const mappings = JSON.stringify({ inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' });

  // acct-sales: sales@x.example, alias help@x.example. acct-ops: ops@x.example. acct-disabled:
  // a third mailbox, same shape, but disabled — proves a disabled account is excluded.
  await db.query(`
    INSERT INTO email_accounts (id, email_address, enabled, folder_mappings) VALUES
      ($1::uuid, 'sales@x.example', true, $4::jsonb),
      ($2::uuid, 'ops@x.example', true, $4::jsonb),
      ($3::uuid, 'disabled@x.example', false, $4::jsonb)
  `, [ACCT_SALES, ACCT_OPS, ACCT_DISABLED, mappings]);
  await db.query('INSERT INTO account_aliases (account_id, email) VALUES ($1::uuid, $2)', [ACCT_SALES, 'help@x.example']);

  await db.query(`
    INSERT INTO contacts (id, emails) VALUES ($1::uuid, $3::jsonb), ($2::uuid, $4::jsonb)
  `, [
    CONTACT_MAYA, CONTACT_SELF_MAILBOX,
    JSON.stringify([{ value: 'maya@c.example' }]),
    JSON.stringify([{ value: 'sales@x.example' }]), // a contact whose address is also our mailbox
  ]);

  const rcpt = (addr) => JSON.stringify([{ email: addr }]);
  const messages = [
    [M1, ACCT_SALES, 'INBOX', 'maya@c.example', rcpt('sales@x.example'), '2026-09-01T10:00:00Z', 'msg-1'],
    [M2, ACCT_SALES, 'Sent', 'help@x.example', rcpt('maya@c.example'), '2026-09-02T10:00:00Z', 'msg-2'],
    // Gmail-label duplicate of M1's conversation: same message_id, a second copy in another
    // folder of the SAME mailbox — must count once, not twice.
    [M3, ACCT_SALES, 'INBOX', 'maya@c.example', rcpt('sales@x.example'), '2026-09-01T10:00:00Z', 'msg-1'],
    [M3B, ACCT_SALES, '[Gmail]/Important', 'maya@c.example', rcpt('sales@x.example'), '2026-09-01T10:00:00Z', 'msg-1'],
    [M4, ACCT_SALES, 'Trash', 'maya@c.example', rcpt('sales@x.example'), '2026-09-03T10:00:00Z', 'msg-4'],
    [M5, ACCT_SALES, 'Spam', 'maya@c.example', rcpt('sales@x.example'), '2026-09-04T10:00:00Z', 'msg-5'],
    [M6, ACCT_SALES, 'Drafts', 'sales@x.example', rcpt('maya@c.example'), '2026-09-05T10:00:00Z', 'msg-6'],
    [M7, ACCT_DISABLED, 'INBOX', 'maya@c.example', rcpt('disabled@x.example'), '2026-09-06T10:00:00Z', 'msg-7'],
    [M8, ACCT_SALES, 'INBOX', 'maya@c.example', rcpt('sales@x.example'), '2026-09-07T10:00:00Z', 'msg-8'],
    [M9, ACCT_SALES, 'INBOX', 'maya@c.example', rcpt('sales@x.example'), '2026-09-07T10:00:00Z', 'msg-9'],
    // Precedence: at acct-sales, a letter FROM sales@x.example itself, addressed to someone who
    // is NOT contact2 — must be excluded from contact2's correspondence entirely: not 'in' (own
    // wins over the from_email match), and not 'out' either (contact2's address isn't a recipient).
    [M_SELF_SENT, ACCT_SALES, 'Sent', 'sales@x.example', rcpt('external@other.example'), '2026-09-08T10:00:00Z', 'msg-precedence'],
    // 'in' for contact2 at acct-ops: sales@x.example writes to ops@x.example. sales@x.example is
    // NOT acct-ops's own address there, so this is a normal incoming letter for contact2.
    [M_CROSS_MAILBOX, ACCT_OPS, 'INBOX', 'sales@x.example', rcpt('ops@x.example'), '2026-09-09T10:00:00Z', 'msg-cross-mailbox'],
    // Self-sent for contact2 (contact2's address == acct-sales's own address): 'in' outside Sent...
    [M_SELF_ADDRESSED_INBOX, ACCT_SALES, 'INBOX', 'sales@x.example', rcpt('sales@x.example'), '2026-09-10T10:00:00Z', 'msg-self-inbox'],
    // ...and 'out' when the same shape of letter sits in the account's own Sent folder.
    [M_SELF_ADDRESSED_SENT, ACCT_SALES, 'Sent', 'sales@x.example', rcpt('sales@x.example'), '2026-09-11T10:00:00Z', 'msg-self-sent'],
    // Same self-sent letter (same message_id) filed in both Inbox and Sent, as Gmail does: the
    // dedup must keep exactly one copy, and it must be the Inbox one (direction 'in').
    [M_SELF_DEDUP_INBOX, ACCT_SALES, 'INBOX', 'sales@x.example', rcpt('sales@x.example'), '2026-09-12T10:00:00Z', 'msg-self-dedup'],
    [M_SELF_DEDUP_SENT, ACCT_SALES, 'Sent', 'sales@x.example', rcpt('sales@x.example'), '2026-09-12T10:00:00Z', 'msg-self-dedup'],
  ];
  for (const [id, accountId, folder, from, to, date, messageId] of messages) {
    await db.query(`
      INSERT INTO messages (id, account_id, folder, from_email, to_addresses, date, message_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::timestamptz, $7)
    `, [id, accountId, folder, from, to, date, messageId]);
  }
});

afterAll(async () => {
  await db?.close?.();
});

describe('contactLetters — behavioural (PGlite)', () => {
  it('counts a plain incoming letter as received and a reply sent via an alias as sent', async () => {
    const result = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    const inItem = result.items.find((i) => [M1, M3, M3B].includes(i.id));
    const outItem = result.items.find((i) => i.id === M2);
    expect(inItem?.direction).toBe('in');
    expect(outItem?.direction).toBe('out');
  });

  it('never counts trash, spam or drafts', async () => {
    const result = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    expect(result.items.some((i) => i.folder === 'Trash')).toBe(false);
    expect(result.items.some((i) => i.folder === 'Spam')).toBe(false);
    expect(result.items.some((i) => i.folder === 'Drafts')).toBe(false);
  });

  it('excludes a disabled account even when the address matches', async () => {
    const result = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    expect(result.items.some((i) => i.account_id === ACCT_DISABLED)).toBe(false);
  });

  it('counts a letter synced to two folders (Gmail labels) once, not twice', async () => {
    const result = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    // M1, M3 and M3B all share message_id 'msg-1' in the same mailbox (acct-sales): exactly one
    // of the three ids must survive the dedup, not two or three.
    const survivors = result.items.filter((i) => [M1, M3, M3B].includes(i.id));
    expect(survivors.length).toBe(1);
    expect(survivors[0].account_id).toBe(ACCT_SALES);
  });

  it('counts equal the list total across a full page', async () => {
    const result = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    expect(result.items.length).toBe(result.total);
    expect(result.received + result.sent).toBe(result.total);
  });

  it('paginates stably across a same-timestamp tie: two pages of 1 cover both tied letters once each', async () => {
    const page1 = await contactLetters(CONTACT_MAYA, { limit: 50, offset: 0 });
    const tied = page1.items.filter((i) => [M8, M9].includes(i.id));
    expect(tied.length).toBe(2);
    const tiedStart = page1.items.findIndex((i) => i.id === tied[0].id);

    const first = await contactLetters(CONTACT_MAYA, { limit: 1, offset: tiedStart });
    const second = await contactLetters(CONTACT_MAYA, { limit: 1, offset: tiedStart + 1 });
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect([first.items[0].id, second.items[0].id].sort()).toEqual([M8, M9].sort());
  });

  it('precedence: an own address always wins, even for a contact whose address is one of our mailboxes', async () => {
    const result = await contactLetters(CONTACT_SELF_MAILBOX, { limit: 50, offset: 0 });
    // The self-sent letter to a third party must not appear at all (neither in nor out).
    expect(result.items.some((i) => i.id === M_SELF_SENT)).toBe(false);
    // The genuine cross-mailbox incoming letter must count as 'in'.
    const crossMailbox = result.items.find((i) => i.id === M_CROSS_MAILBOX);
    expect(crossMailbox?.direction).toBe('in');
  });

  it('a letter the mailbox sent to itself is "in" outside Sent, and "out" inside Sent', async () => {
    const result = await contactLetters(CONTACT_SELF_MAILBOX, { limit: 50, offset: 0 });
    const inbox = result.items.find((i) => i.id === M_SELF_ADDRESSED_INBOX);
    const sent = result.items.find((i) => i.id === M_SELF_ADDRESSED_SENT);
    expect(inbox?.direction).toBe('in');
    expect(sent?.direction).toBe('out');
  });

  it('dedups a self-sent letter filed in both Inbox and Sent to its Inbox copy, read as received', async () => {
    const result = await contactLetters(CONTACT_SELF_MAILBOX, { limit: 50, offset: 0 });
    const survivors = result.items.filter((i) => [M_SELF_DEDUP_INBOX, M_SELF_DEDUP_SENT].includes(i.id));
    expect(survivors.length).toBe(1);
    expect(survivors[0].id).toBe(M_SELF_DEDUP_INBOX);
    expect(survivors[0].folder).toBe('INBOX');
    expect(survivors[0].direction).toBe('in');
  });

  it('is null for an unknown contact', async () => {
    expect(await contactLetters('99999999-9999-9999-9999-999999999999')).toBeNull();
  });
});
