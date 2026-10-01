// The domain onboarding table against PGlite with every real migration: the states the table
// accepts, "Done" and "mark ready" moving a domain on (and refusing out of order), adoption by an
// administrator, and the startup adoption of domains that already hold panel mailboxes, with the
// journal entries it writes through the real recordAudit.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const {
  DOMAIN_STATES, MANUAL_STEPS, UNKNOWN_STATE, adoptDomain, adoptDomainsWithMailboxes, bindNodeIdentities,
  canCreateMailboxes, confirmStep, getDomainRow, isRecreated, listDomainRows, markReady, mergeDomains,
  nextStep, nodeRefusal, recordCreatedDomain,
} = await import('./domains.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const OTHER = '60000000-0000-4000-8000-000000000002';
let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query(
    `INSERT INTO users (id, username, email, is_admin) VALUES ($1, 'admin', 'admin@example.com', true), ($2, 'other', '', true)`,
    [ADMIN, OTHER],
  );
});
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.query('DELETE FROM mail_node_domains');
  await db.query('DELETE FROM mailbox_audit_log');
  await db.query('DELETE FROM email_accounts');
});

const stateOf = async (domain) => (await getDomainRow(domain))?.state ?? null;
const auditRows = async () => (await db.query(
  'SELECT actor_user_id, actor_email, account_id, action, details FROM mailbox_audit_log ORDER BY id',
)).rows;

describe('the mail_node_domains table (migration 0079)', () => {
  it('accepts the onboarding states only', async () => {
    for (const state of DOMAIN_STATES) {
      await db.query('INSERT INTO mail_node_domains (domain, state) VALUES ($1, $2)', [`${state.replace(/_/g, '-')}.example`, state]);
    }
    await expect(db.query("INSERT INTO mail_node_domains (domain, state) VALUES ('x.example', 'unknown')")).rejects.toThrow();
    await expect(db.query("INSERT INTO mail_node_domains (domain, origin) VALUES ('y.example', 'guessed')")).rejects.toThrow();
    await expect(db.query("INSERT INTO mail_node_domains (domain, dkim_mode) VALUES ('z.example', 'both')")).rejects.toThrow();
    await expect(db.query("INSERT INTO mail_node_domains (domain, mailbox_send_limit) VALUES ('w.example', 0)")).rejects.toThrow();
  });

  it('starts a new row at node_created with no confirmed steps', async () => {
    await db.query("INSERT INTO mail_node_domains (domain) VALUES ('fresh.example')");
    const { rows } = await db.query("SELECT state, origin, steps, expected_mx FROM mail_node_domains WHERE domain = 'fresh.example'");
    expect(rows[0]).toEqual({ state: 'node_created', origin: 'created', steps: {}, expected_mx: [] });
  });
});

describe('the onboarding state machine', () => {
  it('confirms by hand every step up to ready, never authoritative', () => {
    expect(MANUAL_STEPS).toEqual(['node_configured', 'dns_ok', 'tenant_verified', 'internal_relay', 'connector_ready', 'ready']);
    expect(nextStep('node_created')).toBe('node_configured');
    expect(nextStep('connector_ready')).toBe('ready');
    expect(nextStep('ready')).toBeNull();
    expect(nextStep('authoritative')).toBeNull();
    expect(nextStep(UNKNOWN_STATE)).toBeNull();
    expect(DOMAIN_STATES.filter(canCreateMailboxes)).toEqual(['ready', 'authoritative']);
    expect(canCreateMailboxes(UNKNOWN_STATE)).toBe(false);
  });

  it('walks a created domain to ready with "Done", recording who and when for each step', async () => {
    await recordCreatedDomain({ domain: 'new.example', userId: ADMIN, maxMailboxes: 50 });
    expect(await stateOf('new.example')).toBe('node_created');
    let state = 'node_created';
    for (const step of MANUAL_STEPS) {
      const userId = step === 'dns_ok' ? OTHER : ADMIN;
      expect(await confirmStep({ domain: 'new.example', step, userId })).toEqual({ from: state, to: step });
      state = step;
    }
    expect(await stateOf('new.example')).toBe('ready');
    const [row] = await listDomainRows();
    expect(row).toMatchObject({ domain: 'new.example', state: 'ready', origin: 'created', addedBy: 'admin@example.com', maxMailboxes: 50 });
    expect(Object.keys(row.steps)).toEqual(expect.arrayContaining(MANUAL_STEPS));
    expect(row.steps.node_configured).toMatchObject({ userId: ADMIN, email: 'admin@example.com' });
    // A user without an email is shown by username.
    expect(row.steps.dns_ok).toMatchObject({ userId: OTHER, email: 'other' });
    expect(Number.isNaN(Date.parse(row.steps.ready.at))).toBe(false);
  });

  it('refuses a step out of order, an unknown step and an unknown domain, and moves once when confirmed twice', async () => {
    await recordCreatedDomain({ domain: 'new.example', userId: ADMIN, maxMailboxes: 50 });
    expect(await confirmStep({ domain: 'new.example', step: 'dns_ok', userId: ADMIN })).toEqual({ error: 'step_out_of_order' });
    expect(await confirmStep({ domain: 'new.example', step: 'authoritative', userId: ADMIN })).toEqual({ error: 'step_invalid' });
    expect(await confirmStep({ domain: 'new.example', step: 'node_created', userId: ADMIN })).toEqual({ error: 'step_invalid' });
    expect(await confirmStep({ domain: 'missing.example', step: 'node_configured', userId: ADMIN })).toEqual({ error: 'domain_not_found' });
    const [first, second] = await Promise.all([
      confirmStep({ domain: 'new.example', step: 'node_configured', userId: ADMIN }),
      confirmStep({ domain: 'new.example', step: 'node_configured', userId: OTHER }),
    ]);
    expect([first, second]).toEqual([{ from: 'node_created', to: 'node_configured' }, { error: 'step_out_of_order' }]);
    expect(await stateOf('new.example')).toBe('node_configured');
  });

  it('marks a domain ready from any earlier state, and not twice', async () => {
    await recordCreatedDomain({ domain: 'pilot.example', userId: ADMIN, maxMailboxes: 10 });
    await confirmStep({ domain: 'pilot.example', step: 'node_configured', userId: ADMIN });
    expect(await markReady({ domain: 'pilot.example', userId: OTHER })).toEqual({ from: 'node_configured', to: 'ready' });
    const [row] = await listDomainRows();
    expect(row.state).toBe('ready');
    expect(row.steps.ready).toMatchObject({ userId: OTHER, markedReady: true });
    expect(row.steps.dns_ok).toBeUndefined();
    expect(await markReady({ domain: 'pilot.example', userId: ADMIN })).toEqual({ error: 'domain_already_ready' });
    await db.query("UPDATE mail_node_domains SET state = 'authoritative' WHERE domain = 'pilot.example'");
    expect(await markReady({ domain: 'pilot.example', userId: ADMIN })).toEqual({ error: 'domain_already_ready' });
    expect(await stateOf('pilot.example')).toBe('authoritative');
    expect(await markReady({ domain: 'missing.example', userId: ADMIN })).toEqual({ error: 'domain_not_found' });
  });

  it('starts the onboarding over when a domain is added to the node again, forgetting what the node held', async () => {
    await recordCreatedDomain({ domain: 'again.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'again.example', userId: ADMIN });
    await db.query(`UPDATE mail_node_domains SET relayhost_id = 7, dns_check = '{"mx": true}', dns_checked_at = NOW(),
      tenant = '{"verified": true}', accepted_domain_type = 'InternalRelay', expected_mx = '["mx.example"]',
      node_created = '2026-09-01 10:00:00', dkim_mode = 'eop', mailbox_send_limit = 20 WHERE domain = 'again.example'`);
    await recordCreatedDomain({ domain: 'again.example', userId: OTHER, maxMailboxes: 20 });
    const [row] = await listDomainRows();
    expect(row).toMatchObject({ state: 'node_created', steps: {}, maxMailboxes: 20, addedBy: 'other', nodeCreated: null });
    const { rows: [raw] } = await db.query(`SELECT relayhost_id, dns_check, dns_checked_at, tenant, accepted_domain_type,
      expected_mx, dkim_mode, mailbox_send_limit FROM mail_node_domains WHERE domain = 'again.example'`);
    // The owner's choices for the domain stay; what described it on the node and in the tenant goes.
    expect(raw).toEqual({
      relayhost_id: null, dns_check: null, dns_checked_at: null, tenant: null, accepted_domain_type: null,
      expected_mx: [], dkim_mode: 'eop', mailbox_send_limit: 20,
    });
  });

  it('adopts a domain made by hand at the beginning of the onboarding, once', async () => {
    expect(await adoptDomain({ domain: 'manual.example', userId: ADMIN, nodeCreated: '2026-09-01 10:00:00' })).toBe(true);
    expect(await adoptDomain({ domain: 'manual.example', userId: OTHER, nodeCreated: '2026-09-01 10:00:00' })).toBe(false);
    const [row] = await listDomainRows();
    expect(row).toMatchObject({
      domain: 'manual.example', state: 'node_created', origin: 'adopted', addedBy: 'admin@example.com', maxMailboxes: null,
      nodeCreated: '2026-09-01 10:00:00',
    });
  });

  it('adopts again a domain deleted on the node and made again by hand, starting over', async () => {
    await recordCreatedDomain({ domain: 'remade.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'remade.example', userId: ADMIN });
    await db.query("UPDATE mail_node_domains SET node_created = '2026-09-01 10:00:00', relayhost_id = 3 WHERE domain = 'remade.example'");
    expect(await adoptDomain({ domain: 'remade.example', userId: OTHER, nodeCreated: '2026-09-30 12:00:00' })).toBe(true);
    const [row] = await listDomainRows();
    expect(row).toMatchObject({ state: 'node_created', origin: 'adopted', steps: {}, addedBy: 'other', nodeCreated: '2026-09-30 12:00:00' });
    expect((await db.query("SELECT relayhost_id FROM mail_node_domains WHERE domain = 'remade.example'")).rows[0].relayhost_id).toBeNull();
    // Without a node identity on either side the panel cannot tell, so the row stays.
    await db.query("UPDATE mail_node_domains SET node_created = NULL WHERE domain = 'remade.example'");
    expect(await adoptDomain({ domain: 'remade.example', userId: ADMIN, nodeCreated: '2026-10-01 09:00:00' })).toBe(false);
  });

  it('binds rows not bound yet to the node identity the first time the node lists the domain', async () => {
    await recordCreatedDomain({ domain: 'new.example', userId: ADMIN, maxMailboxes: 10 });
    await adoptDomain({ domain: 'bound.example', userId: ADMIN, nodeCreated: '2026-09-01 10:00:00' });
    const node = [
      { domain: 'new.example', created: '2026-09-30 12:00:00' },
      { domain: 'bound.example', created: '2026-09-30 12:00:00' },
    ];
    const rows = await bindNodeIdentities(node, await listDomainRows());
    expect(rows.map((r) => [r.domain, r.nodeCreated])).toEqual([
      ['bound.example', '2026-09-01 10:00:00'], ['new.example', '2026-09-30 12:00:00'],
    ]);
    expect(await getDomainRow('new.example')).toEqual({ state: 'node_created', nodeCreated: '2026-09-30 12:00:00' });
    expect(await getDomainRow('bound.example')).toEqual({ state: 'node_created', nodeCreated: '2026-09-01 10:00:00' });
  });
});

describe('adoptDomainsWithMailboxes (startup)', () => {
  async function addAccount(email, mailNode) {
    await db.query(
      `INSERT INTO email_accounts (added_by, name, email_address, mail_node) VALUES ($1, $2, $2, $3)`,
      [ADMIN, email, mailNode],
    );
  }

  it('takes in as ready every domain with panel node mailboxes, journaled as MailExpert, and nothing else', async () => {
    await addAccount('info@Stage.Test', true);
    await addAccount('sales@stage.test', true);
    await addAccount('desk@second.example', true);
    await addAccount('someone@gmail.com', false);
    // A domain the panel already knows keeps its state.
    await recordCreatedDomain({ domain: 'second.example', userId: ADMIN, maxMailboxes: 10 });

    expect(await adoptDomainsWithMailboxes()).toEqual(['stage.test']);
    expect(await stateOf('stage.test')).toBe('ready');
    expect(await stateOf('second.example')).toBe('node_created');
    expect(await stateOf('gmail.com')).toBeNull();
    const [row] = (await listDomainRows()).filter((r) => r.domain === 'stage.test');
    expect(row).toMatchObject({ origin: 'existing_mailboxes', addedBy: null, steps: {} });
    expect(await auditRows()).toEqual([{
      actor_user_id: null, actor_email: 'MailExpert', account_id: null, action: 'mail_node.domain_adopted',
      details: { domain: 'stage.test', state: 'ready', origin: 'existing_mailboxes' },
    }]);
  });

  it('does nothing on the next start', async () => {
    await addAccount('info@stage.test', true);
    await adoptDomainsWithMailboxes();
    await db.query('DELETE FROM mailbox_audit_log');
    expect(await adoptDomainsWithMailboxes()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('the node identity of a row', () => {
  it('tells a domain made again on the node from the one onboarded, only when both sides know', () => {
    const row = { state: 'ready', nodeCreated: '2026-09-01 10:00:00' };
    expect(isRecreated(row, { created: '2026-09-30 12:00:00' })).toBe(true);
    expect(isRecreated(row, { created: '2026-09-01 10:00:00' })).toBe(false);
    expect(isRecreated(row, { created: null })).toBe(false);
    expect(isRecreated({ state: 'ready', nodeCreated: null }, { created: '2026-09-30 12:00:00' })).toBe(false);
    expect(nodeRefusal(row, undefined)).toBe('domain_not_on_node');
    expect(nodeRefusal(row, { created: '2026-09-30 12:00:00' })).toBe('domain_recreated');
    expect(nodeRefusal(row, { created: '2026-09-01 10:00:00' })).toBeNull();
  });
});

describe('mergeDomains', () => {
  const node = [
    { domain: 'b.example', active: true, maxMailboxes: 500, mailboxes: 2 },
    { domain: 'a.example', active: true, maxMailboxes: 500, mailboxes: 0 },
  ];

  it('shows a node domain without a row as unknown, and a row the node lacks as off the node', () => {
    const rows = [
      { domain: 'b.example', state: 'dns_ok', origin: 'created', addedAt: 't1', addedBy: 'admin@example.com', stateChangedAt: 't2', steps: { dns_ok: {} }, maxMailboxes: 500 },
      { domain: 'gone.example', state: 'ready', origin: 'existing_mailboxes', addedAt: 't3', addedBy: null, stateChangedAt: 't3', steps: {}, maxMailboxes: null },
    ];
    expect(mergeDomains(node, rows)).toEqual([
      {
        domain: 'a.example', active: true, maxMailboxes: 500, mailboxes: 0, onNode: true,
        state: 'unknown', origin: null, addedAt: null, addedBy: null, stateChangedAt: null, steps: {}, nextStep: null,
      },
      {
        domain: 'b.example', active: true, maxMailboxes: 500, mailboxes: 2, onNode: true,
        state: 'dns_ok', origin: 'created', addedAt: 't1', addedBy: 'admin@example.com', stateChangedAt: 't2', steps: { dns_ok: {} }, nextStep: 'tenant_verified',
      },
      {
        domain: 'gone.example', active: false, maxMailboxes: 0, mailboxes: 0, onNode: false,
        state: 'ready', origin: 'existing_mailboxes', addedAt: 't3', addedBy: null, stateChangedAt: 't3', steps: {}, nextStep: null,
      },
    ]);
  });

  it('shows a domain made again on the node as unknown, not in the old row state', () => {
    const rows = [{ domain: 'b.example', state: 'ready', origin: 'created', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, maxMailboxes: 500, nodeCreated: '2026-09-01 10:00:00' }];
    const [, b] = mergeDomains([node[1], { ...node[0], created: '2026-09-30 12:00:00' }], rows);
    expect(b).toMatchObject({ domain: 'b.example', state: 'unknown', recreated: true, nextStep: null, origin: null, steps: {} });
    const [, same] = mergeDomains([node[1], { ...node[0], created: '2026-09-01 10:00:00' }], rows);
    expect(same.state).toBe('ready');
    expect(same.recreated).toBeUndefined();
  });
});
