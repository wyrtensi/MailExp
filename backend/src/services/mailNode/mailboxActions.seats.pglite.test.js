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
  listMailboxFilters: vi.fn(async () => []),
  addMailboxFilter: vi.fn(async () => {}),
  deleteMailboxFilters: vi.fn(async () => {}),
  editMailboxFilter: vi.fn(async () => {}),
}));
vi.mock('./domains.js', async (importActual) => ({ ...(await importActual()), getDomainRow: vi.fn(async () => ({ state: 'ready' })) }));
vi.mock('./nodeApply.js', () => ({ newMailboxRateLimit: vi.fn(async () => ({ value: 50, frame: 'h' })), defaultRateLimit: vi.fn() }));
vi.mock('../tenant/tenantDomains.js', async (importActual) => ({ ...(await importActual()), kickDomainSync: vi.fn(async () => null) }));

const {
  MailNodeError, addMailboxFilter, deleteMailbox, deleteMailboxFilters, listMailboxFilters, provisionMailbox,
} = await import('./mailcow.js');
const { saveEopSettings } = await import('./eopSettings.js');
const { setTenantDriver } = await import('../tenant/driver.js');
const { seatCounts } = await import('./eopSeats.js');
const {
  activateNodeMailbox, cancelMailboxDeletion, createNodeMailbox, deactivateNodeMailbox, requestMailboxDeletion,
} = await import('./mailboxActions.js');

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

  it('never leaves a mailbox without a ledger row: a reservation that expired meanwhile fails the creation cleanly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The pending row is gone by the time the row is inserted (it expired and another creation swept it).
    provisionMailbox.mockImplementationOnce(async (_cfg, { localPart, domain }) => {
      await db.query('DELETE FROM mail_node_seat_assignments');
      return { email: `${localPart}@${domain}`, password: 'p', reused: false };
    });
    expect(await create('a')).toEqual({ error: 'mailbox_create_failed' });
    expect((await db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
    expect(await seatCounts()).toEqual({ used: 0, held: 0 });
    expect(deleteMailbox).toHaveBeenCalled();
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

describe('deactivation and activation', () => {
  it('deactivates with a reason: read-only, seat on hold, journaled; activation takes the same seat back', async () => {
    const { recordAudit } = await import('../auditLog.js');
    const { account } = await create('a');
    const off = await deactivateNodeMailbox({ accountId: account.id, reason: 'Left on leave' }, ACTOR);
    expect(off.account).toMatchObject({ deactivation_reason: 'Left on leave', deactivated_by_email: 'anna@example.com' });
    expect(off.account.deactivated_at).not.toBeNull();
    expect(await seatCounts()).toEqual({ used: 0, held: 1 });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.deactivated', details: expect.objectContaining({ reason: 'Left on leave', seat: 1 }) }));
    expect(await create('b')).toEqual({ error: 'no_free_seats' });
    const on = await activateNodeMailbox({ accountId: account.id }, ACTOR);
    expect(on.account.deactivated_at).toBeNull();
    expect(await seatCounts()).toEqual({ used: 1, held: 0 });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.activated', details: expect.objectContaining({ seat: 1, reclaimed: true }) }));
  });

  it('refuses what makes no sense', async () => {
    const { account } = await create('a');
    expect(await deactivateNodeMailbox({ accountId: account.id, reason: ' ' }, ACTOR)).toEqual({ error: 'deactivation_reason_required' });
    expect(await activateNodeMailbox({ accountId: account.id }, ACTOR)).toEqual({ error: 'not_deactivated' });
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    expect(await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR)).toEqual({ error: 'already_deactivated' });
  });

  it('a deactivated mailbox may be asked for deletion; cancelling it leaves it deactivated; activation waits for the cancel', async () => {
    const { account } = await create('a');
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    expect(await activateNodeMailbox({ accountId: account.id }, ACTOR)).toEqual({ error: 'deletion_pending' });
    const back = await cancelMailboxDeletion({ accountId: account.id }, ACTOR);
    expect(back.account.deactivated_at).not.toBeNull();
    expect(await seatCounts()).toEqual({ used: 0, held: 1 });
  });

  it('refuses to deactivate a mailbox pending deletion', async () => {
    const { account } = await create('a');
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    expect(await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR)).toEqual({ error: 'mailbox_pending_deletion' });
  });

  it('activation after the hold needs a free seat, refused at 0', async () => {
    const { account } = await create('a');
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    await db.query("UPDATE mail_node_seat_assignments SET free_from = NOW() - interval '1 minute'");
    await create('b');
    expect(await activateNodeMailbox({ accountId: account.id }, ACTOR)).toEqual({ error: 'no_free_seats' });
  });
});

describe('the read-only filter on the node', () => {
  it('closes local delivery when the mailbox becomes read-only and opens it when it works again', async () => {
    await saveEopSettings({ licenses: 2 });
    const { account } = await create('a');
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    expect(addMailboxFilter).toHaveBeenCalledWith(CFG, expect.objectContaining({ email: 'a@example.com', type: 'prefilter', desc: 'mailexpert-read-only' }));
    listMailboxFilters.mockResolvedValueOnce([{ id: 7, type: 'prefilter', desc: 'mailexpert-read-only', active: true }]);
    await activateNodeMailbox({ accountId: account.id }, ACTOR);
    expect(deleteMailboxFilters).toHaveBeenCalledWith(CFG, [7]);
    addMailboxFilter.mockClear();
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    expect(addMailboxFilter).toHaveBeenCalledTimes(1);
  });

  it('changes nothing in the database when the node cannot take the filter', async () => {
    const { account } = await create('a');
    addMailboxFilter.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'down'));
    await expect(deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR)).rejects.toThrow('down');
    expect((await db.query('SELECT deactivated_at FROM email_accounts WHERE id = $1', [account.id])).rows[0].deactivated_at).toBeNull();
  });

  it('takes the filter off again when the change after it throws on a mailbox that was working', async () => {
    const { account } = await create('a');
    await db.exec("ALTER TABLE email_accounts ADD CONSTRAINT deactivate_blocked CHECK (deactivated_at IS NULL)");
    try {
      addMailboxFilter.mockClear();
      deleteMailboxFilters.mockClear();
      // The first read (closing) finds none; the second (undoing) finds ours.
      listMailboxFilters.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 9, type: 'prefilter', desc: 'mailexpert-read-only', active: true }]);
      await expect(deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR)).rejects.toThrow();
      expect(addMailboxFilter).toHaveBeenCalledTimes(1);
      expect(deleteMailboxFilters).toHaveBeenCalledWith(CFG, [9]);
      expect(await seatCounts()).toEqual({ used: 1, held: 0 });
    } finally {
      await db.exec('ALTER TABLE email_accounts DROP CONSTRAINT deactivate_blocked');
    }
  });

  it('runs two actions on one mailbox one after the other: the second sees the first', async () => {
    const { account } = await create('a');
    addMailboxFilter.mockClear();
    const [one, two] = await Promise.all([
      deactivateNodeMailbox({ accountId: account.id, reason: 'one' }, ACTOR),
      deactivateNodeMailbox({ accountId: account.id, reason: 'two' }, ACTOR),
    ]);
    expect([one.error, two.error].sort()).toEqual(['already_deactivated', undefined]);
    expect(addMailboxFilter).toHaveBeenCalledTimes(1);
  });

  it('takes the mailbox lock before anything else of an action', async () => {
    const { account } = await create('a');
    const seen = [];
    const original = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation((fn) => original((tx) => fn({
      query: (sql, params) => { seen.push(sql); return tx.query(sql, params); },
    })));
    try {
      await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    } finally {
      spy.mockRestore();
    }
    expect(seen[0]).toMatch(/pg_advisory_xact_lock/);
  });

  it('puts the filter back when an activation is refused for want of a seat', async () => {
    const { account } = await create('a');
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    await db.query("UPDATE mail_node_seat_assignments SET free_from = NOW() - interval '1 minute'");
    await create('b');
    addMailboxFilter.mockClear();
    deleteMailboxFilters.mockClear();
    listMailboxFilters.mockResolvedValueOnce([{ id: 7, type: 'prefilter', desc: 'mailexpert-read-only', active: true }]);
    expect(await activateNodeMailbox({ accountId: account.id }, ACTOR)).toEqual({ error: 'no_free_seats' });
    expect(deleteMailboxFilters).toHaveBeenCalledWith(CFG, [7]);
    expect(addMailboxFilter).toHaveBeenCalledTimes(1);
  });

  it('does not touch the node when the mailbox is not deactivated, or when a cancel leaves it deactivated', async () => {
    const { account } = await create('a');
    expect(await activateNodeMailbox({ accountId: account.id }, ACTOR)).toEqual({ error: 'not_deactivated' });
    expect(await cancelMailboxDeletion({ accountId: account.id }, ACTOR)).toEqual({ error: 'deletion_not_requested' });
    expect(listMailboxFilters).not.toHaveBeenCalled();
    expect(addMailboxFilter).not.toHaveBeenCalled();
    await deactivateNodeMailbox({ accountId: account.id, reason: 'r' }, ACTOR);
    await requestMailboxDeletion({ accountId: account.id, email: 'a@example.com', reason: 'r' }, ACTOR);
    deleteMailboxFilters.mockClear();
    await cancelMailboxDeletion({ accountId: account.id }, ACTOR);
    expect(deleteMailboxFilters).not.toHaveBeenCalled();
  });
});
