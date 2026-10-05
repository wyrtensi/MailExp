// insertCopiedSibling (a label applied on a UIDPLUS server) makes a full-row copy from its own
// column list, and that list fell behind the table: it lacked plugin_annotations (the GTD gist
// cache), so every labelled copy paid another AI call to regenerate the gist (upstream
// maathimself/mailflow@52d7e600). Run it against the real schema, and hold its column list to
// the messages table so the next new column needs a decision here instead of being dropped.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));

const { insertCopiedSibling } = await import('./imapManager.js');

// Columns a copy deliberately does not carry over from the source row: its id (the copy gets its
// own), generated columns, and per-row sync or expunge bookkeeping. uid and folder are in the
// list, but set from the COPY ($4, $5) rather than copied.
const NOT_COPIED = [
  'id', 'is_deleted', 'synced_at', 'search_vector', 'thread_key', 'snippet_attempted_at',
  'expunge_claim', 'expunge_claimed_at',
];

const ACCOUNT = '52000000-0000-4000-8000-000000000001';

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120_000);
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts;');
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
  await db.query(
    "INSERT INTO folders (account_id, path, name) VALUES ($1, 'INBOX', 'INBOX'), ($1, 'Todo', 'Todo')",
    [ACCOUNT],
  );
});

describe('insertCopiedSibling on the real schema', () => {
  it('carries the plugin annotations to the copy', async () => {
    const annotations = { gtd: { gist: 'Reply to the invoice question' } };
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, from_email, plugin_annotations)
       VALUES ($1, 11, 'INBOX', '<11@example.com>', 'sender@example.com', $2)`,
      [ACCOUNT, JSON.stringify(annotations)],
    );
    await insertCopiedSibling(ACCOUNT, 11, 'INBOX', 'Todo', 501);
    const { rows } = await db.query(
      "SELECT plugin_annotations FROM messages WHERE account_id = $1 AND folder = 'Todo' AND uid = 501",
      [ACCOUNT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].plugin_annotations).toEqual(annotations);
  });

  it('copies every column of messages except the ones a copy deliberately leaves out', async () => {
    const spy = vi.spyOn(db, 'query');
    await insertCopiedSibling(ACCOUNT, 11, 'INBOX', 'Todo', 501);
    const sql = spy.mock.calls.map(([s]) => s).find(s => s.includes('INSERT INTO messages'));
    spy.mockRestore();
    const insertCols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
    expect(new Set(insertCols).size).toBe(insertCols.length);
    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'",
    );
    const expected = rows.map(r => r.column_name).filter(c => !NOT_COPIED.includes(c));
    expect([...insertCols].sort()).toEqual(expected.sort());
  });
});
