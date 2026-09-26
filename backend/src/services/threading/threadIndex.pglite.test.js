// The thread re-root against a real (in-process) Postgres engine and the real migrations
// (upstream maathimself/mailflow@5b16e3fc, #495): soft-deleted rows follow a resolved root because
// the ancestor lookup reads them, and the full index of migration 0076 serves the re-root UPDATE,
// which no longer carries an is_deleted predicate that the old partial index needed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null, seen: [] };
vi.mock('../db.js', () => ({
  query: (sql, params) => { dbState.seen.push({ sql, params }); return dbState.db.query(sql, params); },
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));

const { rerootThreadChildren } = await import('../imapManager.js');
const { computeThreading } = await import('./threadId.js');

const migration = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations', '0076_thread_id_index_covers_deleted.sql');
const ACCOUNT = '60000000-0000-4000-8000-000000000001';
let db;

// Every migration, 0076 included, applied as the runner applies them.
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  dbState.seen = [];
  await db.exec('DELETE FROM messages; DELETE FROM email_accounts;');
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
});

const threadIndexes = async () => (await db.query(
  "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'messages' AND indexdef LIKE '%(account_id, thread_id)%' ORDER BY indexname"
)).rows;

describe('migration 0076', () => {
  it('replaces the partial thread index with a full one', async () => {
    const rows = await threadIndexes();
    expect(rows.map(r => r.indexname)).toEqual(['idx_messages_account_thread']);
    expect(rows[0].indexdef).not.toMatch(/WHERE/);
  });

  it('can run again, as after a crash before it was recorded, and ends the same', async () => {
    const statements = readFileSync(migration, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    for (const statement of statements) await db.query(statement);
    expect((await threadIndexes()).map(r => r.indexname)).toEqual(['idx_messages_account_thread']);
  });
});

describe('re-rooting provisional children', () => {
  it('uses the full thread index, not a scan of the account', async () => {
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, thread_id, is_deleted)
       SELECT $1, g, 'INBOX', '<m' || g || '@x>', '<t' || (g % 500) || '@x>', g % 7 = 0
       FROM generate_series(1, 3000) g`,
      [ACCOUNT]
    );
    await db.query('ANALYZE messages');
    await rerootThreadChildren(ACCOUNT, '<root@x>', '<t1@x>');
    const { sql, params } = dbState.seen.find(q => q.sql.includes('UPDATE messages SET thread_id'));
    await db.query('SET enable_seqscan = off');
    try {
      const plan = (await db.query(`EXPLAIN ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('idx_messages_account_thread');
      expect(plan).not.toMatch(/Seq Scan on messages/);
    } finally {
      await db.query('SET enable_seqscan = on');
    }
  });

  it('moves a soft-deleted child too, so a later reply to it joins the real thread', async () => {
    // <c> arrived before its parent <p> and hung provisionally on <p>; then it was deleted.
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, thread_id, is_deleted) VALUES
         ($1, 1, 'INBOX', '<root@x>', '<root@x>', false),
         ($1, 2, 'Trash', '<c@x>', '<p@x>', true)`,
      [ACCOUNT]
    );
    // <p> arrives, itself a reply to <root>: its children move to <root>.
    await rerootThreadChildren(ACCOUNT, '<root@x>', '<p@x>');
    const child = (await db.query("SELECT thread_id FROM messages WHERE message_id = '<c@x>'")).rows[0];
    expect(child.thread_id).toBe('<root@x>');

    // A reply that references only <c> (its References were trimmed) takes <c>'s key.
    const { threadId } = await computeThreading(ACCOUNT, '<r@x>', '<c@x>', '<c@x>');
    expect(threadId).toBe('<root@x>');
  });
});
