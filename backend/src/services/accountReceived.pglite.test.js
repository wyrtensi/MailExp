import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// email_accounts.last_received_at on the real schema: noteInboxArrival only moves it forward and
// never past now, and migration 0085 fills it once from the inbox as it is.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('./db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const { createRealSchemaDb } = await import('./testing/realSchema.js');
const { noteInboxArrival, recordInboxArrival } = await import('./accountReceived.js');

const SALES = '60000000-0000-4000-8000-000000000001';
const OPS = '60000000-0000-4000-8000-000000000002';
const DAY = 86400000;

let db;
let uid = 0;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host) VALUES
       ($1, 'Sales', 'sales@lr.test', 'mail.test'), ($2, 'Ops', 'ops@lr.test', 'mail.test')`,
    [SALES, OPS],
  );
});

const ago = (days) => Date.now() - days * DAY;
const stored = async (id) => {
  const { rows } = await db.query('SELECT last_received_at FROM email_accounts WHERE id = $1', [id]);
  return rows[0].last_received_at ? new Date(rows[0].last_received_at).getTime() : null;
};
const daysAgoOf = (time) => Math.round((Date.now() - time) / DAY);

describe('noteInboxArrival', () => {
  it('sets the date of the first arrival and returns it', async () => {
    const iso = await noteInboxArrival(SALES, ago(2));
    expect(daysAgoOf(Date.parse(iso))).toBe(2);
    expect(daysAgoOf(await stored(SALES))).toBe(2);
    expect(await stored(OPS)).toBeNull();
  });

  it('moves forward only: a late delivery of an older letter changes nothing and says so', async () => {
    await noteInboxArrival(SALES, ago(2));
    expect(await noteInboxArrival(SALES, ago(9))).toBeNull();
    expect(daysAgoOf(await stored(SALES))).toBe(2);
    const iso = await noteInboxArrival(SALES, ago(1));
    expect(daysAgoOf(Date.parse(iso))).toBe(1);
  });

  it('counts a letter dated in the future as arriving now, never ahead of it', async () => {
    const before = Date.now();
    const iso = await noteInboxArrival(SALES, Date.now() + 30 * DAY);
    const at = Date.parse(iso);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('ignores a value that is not a time', async () => {
    expect(await noteInboxArrival(SALES, NaN)).toBeNull();
    expect(await stored(SALES)).toBeNull();
  });

  it('is not undone by what happens to the letter afterwards: nothing reads the inbox', async () => {
    await noteInboxArrival(SALES, ago(1));
    // The letter arrives and is archived at once: the inbox holds nothing, the arrival stands.
    await db.query(`INSERT INTO messages (account_id, uid, folder, subject, date) VALUES ($1, 1, 'Archive', 'x', $2)`,
      [SALES, new Date(ago(1)).toISOString()]);
    expect(daysAgoOf(await stored(SALES))).toBe(1);
  });
});

describe('recordInboxArrival', () => {
  const run = async (accountId, at) => {
    const broadcast = vi.fn();
    await recordInboxArrival({ id: accountId, email_address: 'x@lr.test' }, at, broadcast);
    return broadcast;
  };

  it('tells the clients the new date, which is what a letter that arrived already read needs (new_messages carries unread ones only)', async () => {
    const broadcast = await run(SALES, ago(1));
    expect(broadcast).toHaveBeenCalledTimes(1);
    const event = broadcast.mock.calls[0][0];
    expect(event.type).toBe('account_received');
    expect(event.accountId).toBe(SALES);
    expect(daysAgoOf(Date.parse(event.lastReceivedAt))).toBe(1);
    expect(daysAgoOf(await stored(SALES))).toBe(1);
  });

  it('says nothing when the date did not move', async () => {
    await noteInboxArrival(SALES, ago(1));
    expect(await run(SALES, ago(5))).not.toHaveBeenCalled();
  });

  it('does not throw when the database fails: the sync batch goes on', async () => {
    const broadcast = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = dbState.db;
    dbState.db = { query: async () => { throw new Error('db down'); } };
    try {
      await recordInboxArrival({ id: SALES }, ago(1), broadcast);
    } finally {
      dbState.db = real;
      warn.mockRestore();
    }
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('migration 0085 backfill', () => {
  const migration = readFileSync(new URL('../../migrations/0085_account_last_received.sql', import.meta.url), 'utf8');
  const letter = (accountId, { folder = 'INBOX', daysAgo, deleted = false, noDate = false }) => {
    uid += 1;
    return db.query(
      `INSERT INTO messages (account_id, uid, folder, subject, date, is_deleted) VALUES ($1, $2, $3, 'x', $4, $5)`,
      [accountId, uid, folder, noDate ? null : new Date(ago(daysAgo)).toISOString(), deleted],
    );
  };

  it('fills the newest live inbox letter of each mailbox, leaving others null', async () => {
    await letter(SALES, { daysAgo: 5 });
    await letter(SALES, { daysAgo: 1 });
    await letter(SALES, { folder: 'Sent', daysAgo: 0 });
    await letter(SALES, { daysAgo: 0, deleted: true });
    await letter(SALES, { daysAgo: -30 });
    await letter(SALES, { noDate: true });
    await db.exec(migration);
    expect(daysAgoOf(await stored(SALES))).toBe(1);
    expect(await stored(OPS)).toBeNull();
  });

  it('does not overwrite a date the sync has already recorded', async () => {
    await letter(SALES, { daysAgo: 5 });
    await noteInboxArrival(SALES, ago(1));
    await db.exec(migration);
    expect(daysAgoOf(await stored(SALES))).toBe(1);
  });
});
