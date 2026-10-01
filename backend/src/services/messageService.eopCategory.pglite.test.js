// The EOP category rides along with the list rows (flat and threaded) on the real schema, so the
// reading pane can decide on safe view (R-41) before the letter's body has loaded.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from './testing/realSchema.js';

const dbState = { db: null };
vi.mock('./db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const { listMessages } = await import('./messageService.js');

const ACCOUNT = '50000000-0000-4000-8000-000000000001';
const PHISH = '51000000-0000-4000-8000-000000000001';
const PLAIN = '51000000-0000-4000-8000-000000000002';
let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM folders; DELETE FROM email_accounts;');
  await db.query("INSERT INTO email_accounts (id, name, email_address) VALUES ($1, 'Office', 'office@example.com')", [ACCOUNT]);
  await db.query(
    `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, date, eop_category)
     VALUES ($1, $3, 1, 'INBOX', '<p@example.com>', 'Verify', '2026-10-01T10:00:00Z', 'PHSH'),
            ($2, $3, 2, 'INBOX', '<n@example.com>', 'Hello', '2026-10-01T09:00:00Z', NULL)`,
    [PHISH, PLAIN, ACCOUNT],
  );
});

const categories = (rows) => Object.fromEntries(rows.map(r => [r.id, r.eop_category]));

describe('listMessages answers eop_category', () => {
  it('in the flat list', async () => {
    const { messages } = await listMessages({ accountId: ACCOUNT, folder: 'INBOX' });
    expect(categories(messages)).toEqual({ [PHISH]: 'PHSH', [PLAIN]: null });
  });

  it('in the threaded list', async () => {
    const { messages } = await listMessages({ accountId: ACCOUNT, folder: 'INBOX', threaded: true });
    expect(categories(messages)).toEqual({ [PHISH]: 'PHSH', [PLAIN]: null });
  });
});
