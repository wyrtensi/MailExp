// The seat ledger against PGlite with every migration (0095): used, held and free; the last seat
// goes to one of two creations; a released seat waits its hold, comes back to its own mailbox, and
// is free for another after the hold; the hold change re-dates the waiting seats; requests close
// once purchased covers them.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));

const { saveEopSettings } = await import('./eopSettings.js');
const { setTenantDriver } = await import('../tenant/driver.js');
const {
  closeFulfilledRequests, confirmSeat, dropPendingSeat, getSeats, lockSeats, releaseSeat, reserveSeat, returnSeat,
  saveSeatRead, seatCounts, setHoldDays,
} = await import('./eopSeats.js');

const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: '3F2A9C4D5E6B7A8C9D0E1F2A3B4C5D6E7F8A9B0C',
};
const A = '80000000-0000-4000-8000-00000000000a';
const B = '80000000-0000-4000-8000-00000000000b';
let db;
const tx = (fn) => db.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) }));

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
});
afterAll(async () => { setTenantDriver(undefined); await db?.close(); });
beforeEach(async () => {
  setTenantDriver(null);
  await db.exec('DELETE FROM mail_node_seat_assignments; DELETE FROM mail_node_seat_requests; DELETE FROM integration_config;');
});

// A confirmed seat for an account id, as a creation leaves it.
async function assign(accountId, email) {
  const { assignmentId, seat } = await reserveSeat(email);
  await tx((client) => confirmSeat(assignmentId, accountId, client));
  return seat;
}
const release = (accountId, days = 90) => tx((client) => releaseSeat(accountId, 'deactivated', days, client));
const giveBack = (accountId, email, purchased) => tx(async (client) => {
  await lockSeats(client);
  return returnSeat({ accountId, email, purchased }, client);
});

describe('the counter', () => {
  it('counts live seats as used and released ones within the hold as held', async () => {
    await saveEopSettings({ licenses: 5 });
    await assign(A, 'a@example.com');
    await assign(B, 'b@example.com');
    await release(B);
    expect(await seatCounts()).toEqual({ used: 1, held: 1 });
    const seats = await getSeats();
    expect(seats).toMatchObject({ purchased: 5, used: 1, held: 1, free: 3, over: false, holdDays: 90 });
    expect(seats.heldSeats).toEqual([expect.objectContaining({ seat: 2, accountId: B, email: 'b@example.com', reason: 'deactivated' })]);
  });

  it('shows over when purchased is below used, never a negative free', async () => {
    await saveEopSettings({ licenses: 2 });
    await assign(A, 'a@example.com');
    await assign(B, 'b@example.com');
    await saveEopSettings({ licenses: 1 });
    expect(await getSeats()).toMatchObject({ used: 2, free: 0, over: true });
  });

  it('takes the Graph read with a real driver and the tenant configured', async () => {
    setTenantDriver({ kind: 'worker' });
    await saveEopSettings({ ...TENANT, licenses: 1 });
    expect(await getSeats()).toMatchObject({ purchased: 1, mode: 'graph', source: 'manual', notReconciled: true });
    await saveSeatRead({ at: new Date().toISOString(), ok: true, purchased: 8 });
    expect(await getSeats()).toMatchObject({ purchased: 8, mode: 'graph', source: 'graph', free: 8, stale: false });
  });
});

describe('taking a seat', () => {
  it('refuses while the purchased number is unknown', async () => {
    expect(await reserveSeat('a@example.com')).toEqual({ error: 'seats_unknown' });
  });

  it('gives the last seat to one of two creations at once', async () => {
    await saveEopSettings({ licenses: 2 });
    await assign(A, 'a@example.com');
    const results = await Promise.all([reserveSeat('b@example.com'), reserveSeat('c@example.com')]);
    expect(results.filter((r) => r.assignmentId).length).toBe(1);
    expect(results.filter((r) => r.error === 'no_free_seats').length).toBe(1);
  });

  it('frees the seat when a failed creation drops its pending row', async () => {
    await saveEopSettings({ licenses: 1 });
    const { assignmentId } = await reserveSeat('a@example.com');
    expect(await reserveSeat('b@example.com')).toEqual({ error: 'no_free_seats' });
    await dropPendingSeat(assignmentId);
    expect((await reserveSeat('b@example.com')).seat).toBe(1);
  });

  it('does not give a held seat to another mailbox; after the hold it does, the old row stays', async () => {
    await saveEopSettings({ licenses: 1 });
    await assign(A, 'a@example.com');
    await release(A);
    expect(await reserveSeat('b@example.com')).toEqual({ error: 'no_free_seats' });
    await db.query("UPDATE mail_node_seat_assignments SET free_from = NOW() - interval '1 minute'");
    expect((await reserveSeat('b@example.com')).seat).toBe(1);
    const { rows } = await db.query('SELECT email, released_at IS NOT NULL AS released FROM mail_node_seat_assignments ORDER BY id');
    expect(rows).toEqual([{ email: 'a@example.com', released: true }, { email: 'b@example.com', released: false }]);
  });

  it('frees at once with a hold of 0 days', async () => {
    await saveEopSettings({ licenses: 1 });
    await assign(A, 'a@example.com');
    await release(A, 0);
    expect((await reserveSeat('b@example.com')).seat).toBe(1);
  });
});

describe('returning a seat', () => {
  it('gives the mailbox its own held seat back, the same ledger row, even at 0 free', async () => {
    await saveEopSettings({ licenses: 1 });
    await assign(A, 'a@example.com');
    await release(A);
    expect(await giveBack(A, 'a@example.com', 1)).toEqual({ seat: 1, reclaimed: true });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM mail_node_seat_assignments');
    expect(rows[0].n).toBe(1);
    expect(await seatCounts()).toEqual({ used: 1, held: 0 });
  });

  it('needs a free seat once the own seat went past its hold, refused at 0', async () => {
    await saveEopSettings({ licenses: 1 });
    await assign(A, 'a@example.com');
    await release(A);
    await db.query("UPDATE mail_node_seat_assignments SET free_from = NOW() - interval '1 minute'");
    await assign(B, 'b@example.com');
    expect(await giveBack(A, 'a@example.com', 1)).toEqual({ error: 'no_free_seats' });
    expect(await giveBack(A, 'a@example.com', 2)).toEqual({ seat: 2, reclaimed: false });
  });
});

describe('the hold period', () => {
  it('re-dates the seats still waiting', async () => {
    await saveEopSettings({ licenses: 1 });
    await assign(A, 'a@example.com');
    await release(A);
    // Two changes at once: each journals the value the other left, never the same old one twice.
    const [first, second] = await Promise.all([setHoldDays(30), setHoldDays(0)]);
    expect([first, second].map((r) => r.to)).toEqual([30, 0]);
    expect(first.from).toBe(90);
    expect(second.from).toBe(30);
    await setHoldDays(90);
    expect(await setHoldDays(0)).toEqual({ from: 90, to: 0 });
    expect(await seatCounts()).toEqual({ used: 0, held: 0 });
    expect((await getSeats()).holdDays).toBe(0);
  });
});

describe('closeFulfilledRequests', () => {
  it('closes a request once purchased reaches the number at request plus the seats asked for', async () => {
    await db.query(`INSERT INTO mail_node_seat_requests (provider, seats, purchased_at_request) VALUES ('manual', 2, 5), ('manual', 1, NULL)`);
    expect(await closeFulfilledRequests(6)).toHaveLength(1);
    expect((await getSeats()).requests.map((r) => r.seats)).toEqual([2]);
    expect(await closeFulfilledRequests(7)).toHaveLength(1);
    expect((await getSeats()).requests).toEqual([]);
  });
});

describe('the backfill of migration 0095', () => {
  it('gave existing node mailboxes seats when the ledger was empty', async () => {
    // createRealSchemaDb applies the migrations on an empty schema: nothing to backfill, nothing
    // made up. The statement itself is exercised by running it again on rows made here.
    await db.query(`INSERT INTO users (id, username, email) VALUES ('70000000-0000-4000-8000-000000000001', 'anna', 'anna@example.com') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO email_accounts (added_by, name, email_address, mail_node) VALUES
      ('70000000-0000-4000-8000-000000000001', 'a', 'A@example.com', true),
      ('70000000-0000-4000-8000-000000000001', 'b', 'b@example.com', true)`);
    // One statement gives both rows the same created_at: make the creation order explicit.
    await db.query("UPDATE email_accounts SET created_at = NOW() - interval '1 day' WHERE email_address = 'A@example.com'");
    await db.query("UPDATE email_accounts SET delete_after = NOW() + interval '5 days', deletion_requested_at = NOW() WHERE email_address = 'b@example.com'");
    const sql = (await import('node:fs')).readFileSync(new URL('../../../migrations/0095_eop_seats.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    const { rows } = await db.query('SELECT seat_no, email, release_reason FROM mail_node_seat_assignments ORDER BY seat_no');
    expect(rows).toEqual([
      { seat_no: 1, email: 'a@example.com', release_reason: null },
      { seat_no: 2, email: 'b@example.com', release_reason: 'deletion_requested' },
    ]);
    await db.exec('DELETE FROM email_accounts');
  });
});
