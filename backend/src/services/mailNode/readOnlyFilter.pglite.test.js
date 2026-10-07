// The read-only filter against a mailcow in memory and PGlite: it remembers and gives back the
// prefilter it displaced, every step is idempotent, and the reconciliation makes the node match the
// rows (a mailbox made read-only by a migration included).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const dbState = { db: null };
const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));
vi.mock('../encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v }));
vi.mock('../safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { closeLocalDelivery, openLocalDelivery, reconcileLocalDelivery } = await import('./readOnlyFilter.js');

const CFG = { mailHost: 'mail.example.com', apiKey: 'k' };
const USER = '70000000-0000-4000-8000-000000000001';
let db;
let mc;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email) VALUES ($1, 'anna', 'anna@example.com')", [USER]);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  mc = createFakeMailcow();
  fake.current = mc;
  await db.exec('DELETE FROM email_accounts');
});

const ownFilter = (email, id = 100, active = 1) => ({
  id, username: email, filter_type: 'prefilter', script_desc: 'sales rules', script_data: 'keep;', active,
});
const addAccount = (email, { host = 'mail.example.com', deleteAfter = false, deactivated = false } = {}) => db.query(
  `INSERT INTO email_accounts (added_by, name, email_address, mail_node, imap_host, delete_after, deactivated_at)
   VALUES ($1, $2, $2, true, $3, $4, $5)`,
  [USER, email, host, deleteAfter ? new Date(Date.now() + 86400000) : null, deactivated ? new Date() : null],
);
const filtersOf = (email) => mc.node.filters.filter((f) => f.username === email);

describe('closing and opening', () => {
  it('adds one filter, however often it is asked', async () => {
    await closeLocalDelivery(CFG, 'a@example.com');
    await closeLocalDelivery(CFG, 'a@example.com');
    expect(filtersOf('a@example.com')).toHaveLength(1);
    expect(filtersOf('a@example.com')[0]).toMatchObject({ script_desc: 'mailexpert-read-only', active: 1 });
  });

  it('remembers the prefilter it displaces and turns it on again when opened', async () => {
    mc.node.filters.push(ownFilter('a@example.com'));
    await closeLocalDelivery(CFG, 'a@example.com');
    const [own, ours] = filtersOf('a@example.com');
    expect(own.active).toBe(0);
    expect(ours.script_desc).toBe('mailexpert-read-only restore=100');
    await openLocalDelivery(CFG, 'a@example.com');
    expect(filtersOf('a@example.com')).toEqual([expect.objectContaining({ id: 100, active: 1 })]);
    await openLocalDelivery(CFG, 'a@example.com');
    expect(filtersOf('a@example.com')).toEqual([expect.objectContaining({ id: 100, active: 1 })]);
  });

  it('finishes after a crash between turning the old filter on and deleting ours', async () => {
    mc.node.filters.push(ownFilter('a@example.com'));
    await closeLocalDelivery(CFG, 'a@example.com');
    const ours = filtersOf('a@example.com')[1];
    // The first step of opening happened: the old filter is on, ours is off but still there.
    filtersOf('a@example.com')[0].active = 1;
    ours.active = 0;
    await openLocalDelivery(CFG, 'a@example.com');
    expect(filtersOf('a@example.com')).toEqual([expect.objectContaining({ id: 100, active: 1 })]);
  });

  it('keeps what an inactive copy of ours remembers when it closes again, and drops that copy', async () => {
    mc.node.filters.push(ownFilter('a@example.com', 100, 0));
    mc.node.filters.push({
      id: 101, username: 'a@example.com', filter_type: 'prefilter', script_desc: 'mailexpert-read-only restore=100', script_data: 'x', active: 0,
    });
    await closeLocalDelivery(CFG, 'a@example.com');
    const ours = filtersOf('a@example.com').filter((f) => f.script_desc.startsWith('mailexpert-read-only'));
    expect(ours).toEqual([expect.objectContaining({ script_desc: 'mailexpert-read-only restore=100', active: 1 })]);
    await openLocalDelivery(CFG, 'a@example.com');
    expect(filtersOf('a@example.com')).toEqual([expect.objectContaining({ id: 100, active: 1 })]);
  });

  it('leaves a mailbox without our filter alone, and other mailboxes alone', async () => {
    mc.node.filters.push(ownFilter('b@example.com'));
    await openLocalDelivery(CFG, 'a@example.com');
    expect(mc.writes.filter((w) => w.path.startsWith('delete') || w.path.startsWith('edit'))).toEqual([]);
  });
});

describe('reconcileLocalDelivery', () => {
  it('closes a mailbox that is read-only in the rows but has no filter (a pending deletion from the migration), opens a working one that has one', async () => {
    await addAccount('pending@example.com', { deleteAfter: true });
    await addAccount('off@example.com', { deactivated: true });
    await addAccount('works@example.com');
    await addAccount('other@elsewhere.example', { host: 'mail.other.example', deleteAfter: true });
    await closeLocalDelivery(CFG, 'works@example.com');
    expect(await reconcileLocalDelivery(CFG)).toEqual({ closed: 2, opened: 1, failed: 0 });
    expect(filtersOf('pending@example.com')).toHaveLength(1);
    expect(filtersOf('off@example.com')).toHaveLength(1);
    expect(filtersOf('works@example.com')).toEqual([]);
    expect(filtersOf('other@elsewhere.example')).toEqual([]);
  });

  it('changes nothing when the node already matches, and puts back a filter that was switched off', async () => {
    await addAccount('pending@example.com', { deleteAfter: true });
    await closeLocalDelivery(CFG, 'pending@example.com');
    mc.writes.length = 0;
    expect(await reconcileLocalDelivery(CFG)).toEqual({ closed: 0, opened: 0, failed: 0 });
    expect(mc.writes).toEqual([]);
    filtersOf('pending@example.com')[0].active = 0;
    expect(await reconcileLocalDelivery(CFG)).toMatchObject({ closed: 1 });
    expect(filtersOf('pending@example.com').filter((f) => f.active)).toHaveLength(1);
  });

  it('counts a mailbox the node refuses and goes on with the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await addAccount('a@example.com', { deleteAfter: true });
    await addAccount('b@example.com', { deleteAfter: true });
    mc.node.refuse['add/filter'] = 'sieve_error';
    expect(await reconcileLocalDelivery(CFG)).toEqual({ closed: 0, opened: 0, failed: 2 });
  });

  it('throws when the node cannot be asked', async () => {
    await addAccount('a@example.com', { deleteAfter: true });
    mc.node.down = true;
    await expect(reconcileLocalDelivery(CFG)).rejects.toMatchObject({ code: 'mail_node_unreachable' });
  });
});
