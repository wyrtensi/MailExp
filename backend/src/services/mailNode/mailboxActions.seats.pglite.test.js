// The node mailbox actions move EOP seats (EOP seats design) against PGlite: creation takes a free
// seat or is refused without asking the node, a failure gives it back, a deletion request puts it on
// hold, the cancel takes it back (or a free one).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(async () => {}), insertAuditEntries: vi.fn(async () => {}) }));
vi.mock('../encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, deleteAfterDays: 5 };
vi.mock('./mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => CFG),
  getDeleteAfterDays: vi.fn(async () => 5),
  listDomains: vi.fn(async () => [{ domain: 'example.com', active: true }]),
  provisionMailbox: vi.fn(async (_cfg, { localPart, domain }) => ({ email: `${localPart}@${domain}`, password: 'p', reused: false })),
  deleteMailbox: vi.fn(async () => ({ warnings: [] })),
}));
vi.mock('./domains.js', async (importActual) => ({ ...(await importActual()), getDomainRow: vi.fn(async () => ({ state: 'ready' })) }));
vi.mock('./nodeApply.js', () => ({ newMailboxRateLimit: vi.fn(async () => ({ value: 50, frame: 'h' })), defaultRateLimit: vi.fn() }));
vi.mock('../tenant/tenantDomains.js', async (importActual) => ({ ...(await importActual()), kickDomainSync: vi.fn(async () => null) }));

const { provisionMailbox } = await import('./mailcow.js');
const { saveEopSettings } = await import('./eopSettings.js');
const { setTenantDriver } = await import('../tenant/driver.js');
const { seatCounts } = await import('./eopSeats.js');
const { cancelMailboxDeletion, createNodeMailbox, requestMailboxDeletion } = await import('./mailboxActions.js');

const USER = '70000000-0000-4000-8000-000000000001';
const ACTOR = { userId: USER };
let db;
const pending = async () => (await db.query('SELECT count(*)::int AS n FROM mail_node_seat_assignments WHERE pending_until IS NOT NULL')).rows[0].n;
const create = (localPart) => createNodeMailbox({ localPart, domain: 'example.com', senderName: localPart }, ACTOR);

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email) VALUES ($1, 'anna', 'anna@example.com')", [USER]);
});
afterAll(async () => { setTenantDriver(undefined); await db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  setTenantDriver(null);
  await db.exec('DELETE FROM account_aliases; DELETE FROM email_accounts; DELETE FROM mail_node_seat_assignments; DELETE FROM integration_config;');
  await saveEopSettings({ licenses: 1 });
});

describe('creation', () => {
  it('takes a seat, confirmed in the ledger with the mailbox id', async () => {
    const { account } = await create('a');
    const { rows } = await db.query('SELECT seat_no, account_id, email, pending_until FROM mail_node_seat_assignments');
    expect(rows).toEqual([{ seat_no: 1, account_id: account.id, email: 'a@example.com', pending_until: null }]);
  });

  it('is refused at 0 free without asking the node, and while purchased is unknown', async () => {
    await create('a');
    provisionMailbox.mockClear();
    expect(await create('b')).toEqual({ error: 'no_free_seats' });
    expect(provisionMailbox).not.toHaveBeenCalled();
    await saveEopSettings({ licenses: null });
    expect(await create('c')).toEqual({ error: 'seats_unknown' });
  });

  it('gives the seat back when the node fails', async () => {
    provisionMailbox.mockRejectedValueOnce(new Error('node down'));
    await expect(create('a')).rejects.toThrow('node down');
    expect(await pending()).toBe(0);
    expect((await create('a')).account).toBeTruthy();
  });

  it('gives the seat back when the row cannot be inserted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.exec("ALTER TABLE email_accounts ADD CONSTRAINT seats_test_block CHECK (email_address <> 'a@example.com')");
    try {
      expect(await create('a')).toEqual({ error: 'mailbox_create_failed' });
      expect(await pending()).toBe(0);
      expect(await seatCounts()).toEqual({ used: 0, held: 0 });
    } finally {
      await db.exec('ALTER TABLE email_accounts DROP CONSTRAINT seats_test_block');
    }
  });
});

describe('deletion request and cancel', () => {
  it('puts the seat on hold at the request and takes it back at the cancel, even at 0 free', async () => {
    const { account } = await create('a');
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    expect(await seatCounts()).toEqual({ used: 0, held: 1 });
    expect(await create('b')).toEqual({ error: 'no_free_seats' });
    const back = await cancelMailboxDeletion({ accountId: account.id }, ACTOR);
    expect(back.account.delete_after).toBeNull();
    expect(await seatCounts()).toEqual({ used: 1, held: 0 });
  });

  it('refuses the cancel once the own seat went past its hold and none is free', async () => {
    const { account } = await create('a');
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    await db.query("UPDATE mail_node_seat_assignments SET free_from = NOW() - interval '1 minute'");
    await create('b');
    expect(await cancelMailboxDeletion({ accountId: account.id }, ACTOR)).toEqual({ error: 'no_free_seats' });
    expect((await db.query('SELECT delete_after FROM email_accounts WHERE id = $1', [account.id])).rows[0].delete_after).not.toBeNull();
  });
});
