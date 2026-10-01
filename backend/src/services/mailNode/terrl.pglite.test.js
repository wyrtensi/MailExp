// The TERRL count against PGlite with the real migrations: which journal entries count.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const { computeTerrlBudget, journalSince } = await import('./terrl.js');
const { parsePostfixLog } = await import('./postfixLog.js');

let db;
beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.query('DELETE FROM mailbox_audit_log');
  await db.query('DELETE FROM mail_node_domains');
  await db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('stage.test', 'ready'), ('second.test', 'ready')");
});

const NOW = Date.parse('2026-10-01T12:00:00Z');
async function sent(at, accountEmail, details) {
  await db.query(
    "INSERT INTO mailbox_audit_log (occurred_at, account_email, action, details) VALUES ($1, $2, 'message.sent', $3)",
    [new Date(at).toISOString(), accountEmail, details],
  );
}

describe('journalSince', () => {
  it('reads the sent messages of node mailboxes within the window only', async () => {
    await sent(NOW - 3600000, 'Info@Stage.test', { to: ['a@example.org'] });
    await sent(NOW - 25 * 3600000, 'info@stage.test', { to: ['old@example.org'] });
    await sent(NOW - 3600000, 'someone@gmail.com', { to: ['gmail@example.org'] });
    await db.query("INSERT INTO mailbox_audit_log (occurred_at, account_email, action, details) VALUES ($1, 'info@stage.test', 'message.deleted', '{}')", [new Date(NOW).toISOString()]);
    expect(await journalSince(new Date(NOW - 24 * 3600000))).toEqual([{ to: ['a@example.org'] }]);
  });
});

describe('computeTerrlBudget', () => {
  it('counts the journal and the log together, without the node domains', async () => {
    await sent(NOW - 3600000, 'info@stage.test', { to: ['a@example.org', 'b@second.test'], cc: ['A@example.org'], bcc: [] });
    await sent(NOW - 1800000, 'sales@second.test', { to: ['Partner <p@example.net>'], cc: [], bcc: [] });
    const log = {
      oldestAt: new Date(NOW - 2 * 3600000).toISOString(),
      lines: parsePostfixLog([
        { time: String((NOW - 600000) / 1000), program: 'postfix/smtp', message: 'AB12CD34EF5: to=<forwarded@example.com>, relay=eop.test.local[172.22.1.13]:25, dsn=2.6.0, status=sent (250 2.6.0 ok)' },
        { time: String((NOW - 600000) / 1000), program: 'postfix/smtp', message: 'AB12CD34EF6: to=<a@example.org>, relay=eop.test.local[172.22.1.13]:25, dsn=2.6.0, status=sent (250 2.6.0 ok)' },
      ]).lines,
    };
    const budget = await computeTerrlBudget({ eop: { eopHost: 'eop.test.local', terrl: 4 }, log, now: NOW });
    expect(budget).toMatchObject({
      used: 3, limit: 4, percent: 75, warn: false, windowStart: '2026-09-30T12:00:00.000Z',
      log: { read: true, covered: false, oldestAt: log.oldestAt },
    });
    expect(await computeTerrlBudget({ eop: { terrl: 4 }, log: null, now: NOW })).toMatchObject({ used: 2, log: { read: false } });
  });
});
