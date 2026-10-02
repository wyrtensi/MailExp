import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// LAST_RECEIVED_AT_SQL on the real schema: which letters count as "received", per mailbox.

const { createRealSchemaDb } = await import('./testing/realSchema.js');
const { LAST_RECEIVED_AT_SQL } = await import('./accountLastReceived.js');

const SALES = '60000000-0000-4000-8000-000000000001';
const OPS = '60000000-0000-4000-8000-000000000002';
const EMPTY = '60000000-0000-4000-8000-000000000003';
const DAY = 86400000;

let db;
let uid = 0;

beforeAll(async () => {
  db = await createRealSchemaDb();
}, 120000);
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('DELETE FROM messages; DELETE FROM email_accounts;');
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host) VALUES
       ($1, 'Sales', 'sales@lr.test', 'mail.test'), ($2, 'Ops', 'ops@lr.test', 'mail.test'),
       ($3, 'Empty', 'empty@lr.test', 'mail.test')`,
    [SALES, OPS, EMPTY],
  );
});

const letter = (accountId, { folder = 'INBOX', daysAgo, deleted = false, noDate = false }) => {
  uid += 1;
  return db.query(
    `INSERT INTO messages (account_id, uid, folder, subject, date, is_deleted) VALUES ($1, $2, $3, 'x', $4, $5)`,
    [accountId, uid, folder, noDate ? null : new Date(Date.now() - daysAgo * DAY).toISOString(), deleted],
  );
};

const received = async () => {
  const { rows } = await db.query(`SELECT id, ${LAST_RECEIVED_AT_SQL} AS last_received_at FROM email_accounts`);
  return Object.fromEntries(rows.map(row => [row.id, row.last_received_at ? new Date(row.last_received_at).getTime() : null]));
};
const daysAgoOf = (time) => Math.round((Date.now() - time) / DAY);

describe('LAST_RECEIVED_AT_SQL', () => {
  it('is the date of the newest inbox letter of each mailbox', async () => {
    await letter(SALES, { daysAgo: 5 });
    await letter(SALES, { daysAgo: 1 });
    await letter(SALES, { daysAgo: 9 });
    await letter(OPS, { daysAgo: 3 });
    const got = await received();
    expect(daysAgoOf(got[SALES])).toBe(1);
    expect(daysAgoOf(got[OPS])).toBe(3);
  });

  it('is null for a mailbox with no inbox mail', async () => {
    await letter(SALES, { daysAgo: 1 });
    const got = await received();
    expect(got[EMPTY]).toBeNull();
    expect(got[OPS]).toBeNull();
  });

  it('counts the inbox only: sent mail, drafts and other folders are not received', async () => {
    await letter(SALES, { daysAgo: 8 });
    await letter(SALES, { folder: 'Sent', daysAgo: 0 });
    await letter(SALES, { folder: 'Drafts', daysAgo: 0 });
    await letter(SALES, { folder: 'Archive', daysAgo: 0 });
    expect(daysAgoOf((await received())[SALES])).toBe(8);
  });

  it('leaves out deleted letters', async () => {
    await letter(SALES, { daysAgo: 6 });
    await letter(SALES, { daysAgo: 0, deleted: true });
    expect(daysAgoOf((await received())[SALES])).toBe(6);
  });

  it('leaves out letters dated in the future and letters without a date', async () => {
    await letter(SALES, { daysAgo: 4 });
    await letter(SALES, { daysAgo: -30 });
    await letter(SALES, { noDate: true });
    expect(daysAgoOf((await received())[SALES])).toBe(4);
  });
});
