// The domain onboarding table against PGlite with every real migration: the states the table
// accepts, "Done" and "mark ready" moving a domain on (and refusing out of order), adoption by an
// administrator, and the startup adoption of domains that already hold panel mailboxes, with the
// journal entries it writes through the real recordAudit.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';

const dbState = { db: null };
vi.mock('../db.js', () => ({ query: (sql, params) => dbState.db.query(sql, params) }));

const {
  DOMAIN_STATES, MANUAL_STEPS, UNKNOWN_STATE, acknowledgeNodeIdentity, adoptDomain, adoptDomainsWithMailboxes,
  bindNodeIdentities, canCreateMailboxes, confirmStep, getDomainRow, isRecreated, listDomainRows, markReady,
  mergeDomains, nextStep, nodeRefusal, recordCreatedDomain, restartOnboarding,
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
    // The owner's choices and typed values for the domain stay; what described it on the node and in
    // the tenant goes.
    // Stage 7b: the accepted domain type stays (the domain is still in the tenant).
    expect(raw).toEqual({
      relayhost_id: null, dns_check: null, dns_checked_at: null, tenant: null, accepted_domain_type: 'InternalRelay',
      expected_mx: ['mx.example'], dkim_mode: 'eop', mailbox_send_limit: 20,
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

  it('never overwrites a row by adoption, whatever the node reports', async () => {
    await recordCreatedDomain({ domain: 'remade.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'remade.example', userId: ADMIN });
    await db.query("UPDATE mail_node_domains SET node_created = '2026-09-01 10:00:00', relayhost_id = 3 WHERE domain = 'remade.example'");
    expect(await adoptDomain({ domain: 'remade.example', userId: OTHER, nodeCreated: '2026-09-30 12:00:00' })).toBe(false);
    expect(await adoptDomain({ domain: 'remade.example', userId: OTHER, nodeCreated: null })).toBe(false);
    const [row] = await listDomainRows();
    expect(row).toMatchObject({ state: 'ready', origin: 'created', addedBy: 'admin@example.com', nodeCreated: '2026-09-01 10:00:00' });
    expect((await db.query("SELECT relayhost_id FROM mail_node_domains WHERE domain = 'remade.example'")).rows[0].relayhost_id).toBe(3);
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
  it('warns of a domain made again on the node only when both sides know a time, and refuses nothing for it', () => {
    const row = { state: 'ready', nodeCreated: '2026-09-01 10:00:00' };
    expect(isRecreated(row, { created: '2026-09-30 12:00:00' })).toBe(true);
    expect(isRecreated(row, { created: '2026-09-01 10:00:00' })).toBe(false);
    expect(isRecreated(row, { created: null })).toBe(false);
    expect(isRecreated({ state: 'ready', nodeCreated: null }, { created: '2026-09-30 12:00:00' })).toBe(false);
    expect(nodeRefusal(undefined)).toBe('domain_not_on_node');
    expect(nodeRefusal({ created: '2026-09-30 12:00:00' })).toBeNull();
    expect(nodeRefusal({ created: null })).toBeNull();
  });

  it('binds nothing and changes no row when the node lists no domain, other domains, no creation times or another time', async () => {
    await recordCreatedDomain({ domain: 'unbound.example', userId: ADMIN, maxMailboxes: 10 });
    await recordCreatedDomain({ domain: 'bound.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'bound.example', userId: ADMIN });
    await db.query("UPDATE mail_node_domains SET node_created = '2026-09-01 10:00:00' WHERE domain = 'bound.example'");
    const snapshot = async () => (await db.query('SELECT * FROM mail_node_domains ORDER BY domain')).rows;
    const before = await snapshot();
    for (const node of [
      [],
      [{ domain: 'other.example', created: '2026-09-30 12:00:00' }],
      [{ domain: 'unbound.example', created: null }, { domain: 'bound.example', created: null }],
      [{ domain: 'bound.example', created: '2026-12-31 00:00:00' }],
    ]) {
      const rows = await bindNodeIdentities(node, await listDomainRows());
      expect(rows.map((r) => [r.domain, r.state, r.nodeCreated])).toEqual([
        ['bound.example', 'ready', '2026-09-01 10:00:00'], ['unbound.example', 'node_created', null],
      ]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('accepts the time the node reports now, changing nothing else', async () => {
    await recordCreatedDomain({ domain: 'moved.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'moved.example', userId: ADMIN });
    await db.query("UPDATE mail_node_domains SET node_created = '2026-09-01 10:00:00', relayhost_id = 4 WHERE domain = 'moved.example'");
    expect(await acknowledgeNodeIdentity({ domain: 'moved.example', nodeCreated: '2026-09-30 12:00:00' }))
      .toEqual({ from: '2026-09-01 10:00:00', to: '2026-09-30 12:00:00' });
    const [row] = await listDomainRows();
    expect(row).toMatchObject({ state: 'ready', nodeCreated: '2026-09-30 12:00:00' });
    expect(row.steps.ready).toMatchObject({ markedReady: true });
    expect((await db.query("SELECT relayhost_id FROM mail_node_domains WHERE domain = 'moved.example'")).rows[0].relayhost_id).toBe(4);
    expect(await acknowledgeNodeIdentity({ domain: 'moved.example', nodeCreated: '2026-09-30 12:00:00' })).toEqual({ error: 'domain_not_recreated' });
    expect(await acknowledgeNodeIdentity({ domain: 'missing.example', nodeCreated: '2026-09-30 12:00:00' })).toEqual({ error: 'domain_not_found' });
    // A row not bound yet has no warning: the next listing binds it, accepting does not.
    await recordCreatedDomain({ domain: 'unbound.example', userId: ADMIN, maxMailboxes: 10 });
    expect(await acknowledgeNodeIdentity({ domain: 'unbound.example', nodeCreated: '2026-09-30 12:00:00' })).toEqual({ error: 'domain_not_recreated' });
    expect((await getDomainRow('unbound.example')).nodeCreated).toBeNull();
  });
});

describe('restartOnboarding', () => {
  it('starts a domain over from any state, keeping where it came from and the owner\'s choices', async () => {
    await recordCreatedDomain({ domain: 'again.example', userId: ADMIN, maxMailboxes: 30 });
    await markReady({ domain: 'again.example', userId: ADMIN });
    await db.query(`UPDATE mail_node_domains SET state = 'authoritative', relayhost_id = 7, dns_check = '{"mx": true}',
      dns_checked_at = NOW(), tenant = '{"verified": true}', accepted_domain_type = 'Authoritative',
      expected_mx = '["mx.example"]', node_created = '2026-09-01 10:00:00', dkim_mode = 'eop', mailbox_send_limit = 20
      WHERE domain = 'again.example'`);
    const before = (await listDomainRows())[0].steps;
    expect(await restartOnboarding({ domain: 'again.example', userId: OTHER })).toEqual({ from: 'authoritative', to: 'node_created', steps: before });
    expect(before.ready).toMatchObject({ userId: ADMIN, markedReady: true });
    const [row] = await listDomainRows();
    expect(row).toMatchObject({
      state: 'node_created', steps: {}, origin: 'created', addedBy: 'admin@example.com', maxMailboxes: 30, nodeCreated: null,
    });
    const { rows: [raw] } = await db.query(`SELECT relayhost_id, dns_check, dns_checked_at, tenant, accepted_domain_type,
      expected_mx, dkim_mode, mailbox_send_limit, state_changed_by FROM mail_node_domains WHERE domain = 'again.example'`);
    // Stage 7b: the domain stays in the tenant with its type, and moving it to Internal Relay is
    // approved by the restart itself (the next run does it instead of waiting for a decision).
    expect(raw).toEqual({
      relayhost_id: null, dns_check: null, dns_checked_at: null, tenant: null, accepted_domain_type: 'Authoritative',
      expected_mx: ['mx.example'], dkim_mode: 'eop', mailbox_send_limit: 20, state_changed_by: OTHER,
    });
    const { rows: [approval] } = await db.query("SELECT internal_relay_approved_at FROM mail_node_domains WHERE domain = 'again.example'");
    expect(approval.internal_relay_approved_at).not.toBeNull();
    expect(await restartOnboarding({ domain: 'missing.example', userId: ADMIN })).toEqual({ error: 'domain_not_found' });
    // Now at the first step with nothing to clear: refused, nothing changes.
    expect(await restartOnboarding({ domain: 'again.example', userId: ADMIN })).toEqual({ error: 'domain_nothing_to_restart' });
    const { rows: [after] } = await db.query("SELECT state_changed_by FROM mail_node_domains WHERE domain = 'again.example'");
    expect(after.state_changed_by).toBe(OTHER);
  });

  it('keeps the values to publish typed by hand, and they alone are no reason to restart', async () => {
    await recordCreatedDomain({ domain: 'typed.example', userId: ADMIN, maxMailboxes: 30 });
    const manual = { verificationTxt: 'MS=ms1', dkimSelector1Cname: 's1.example', dkimSelector2Cname: 's2.example', source: 'manual' };
    await db.query("UPDATE mail_node_domains SET expected_mx = '[\"mx.example\"]', tenant = $1 WHERE domain = 'typed.example'", [manual]);
    expect(await restartOnboarding({ domain: 'typed.example', userId: ADMIN })).toEqual({ error: 'domain_nothing_to_restart' });
    await markReady({ domain: 'typed.example', userId: ADMIN });
    await restartOnboarding({ domain: 'typed.example', userId: ADMIN });
    await recordCreatedDomain({ domain: 'typed.example', userId: ADMIN, maxMailboxes: 30 });
    const { rows: [raw] } = await db.query("SELECT expected_mx, tenant FROM mail_node_domains WHERE domain = 'typed.example'");
    expect(raw).toEqual({ expected_mx: ['mx.example'], tenant: manual });
  });

  it('says which state and steps a known domain had when it is added to the node again', async () => {
    expect(await recordCreatedDomain({ domain: 'twice.example', userId: ADMIN, maxMailboxes: 10 })).toEqual({ from: null, steps: null });
    await confirmStep({ domain: 'twice.example', step: 'node_configured', userId: ADMIN });
    const before = await recordCreatedDomain({ domain: 'twice.example', userId: OTHER, maxMailboxes: 20 });
    expect(before.from).toBe('node_configured');
    expect(before.steps.node_configured).toMatchObject({ userId: ADMIN, email: 'admin@example.com' });
    expect(await stateOf('twice.example')).toBe('node_created');
  });

  it('leaves the mailboxes of the domain and their cached letters alone, on restart and on adding the domain again', async () => {
    await recordCreatedDomain({ domain: 'kept.example', userId: ADMIN, maxMailboxes: 10 });
    await markReady({ domain: 'kept.example', userId: ADMIN });
    const { rows: [account] } = await db.query(
      `INSERT INTO email_accounts (added_by, name, email_address, mail_node) VALUES ($1, 'Info', 'info@kept.example', true) RETURNING id`,
      [ADMIN],
    );
    await db.query("INSERT INTO folders (account_id, path, name) VALUES ($1, 'INBOX', 'INBOX')", [account.id]);
    await db.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, from_email) VALUES ($1, 1, 'INBOX', '<a@kept.example>', 'x@example.com'),
         ($1, 2, 'INBOX', '<b@kept.example>', 'y@example.com')`,
      [account.id],
    );
    const snapshot = async () => ({
      accounts: (await db.query('SELECT * FROM email_accounts ORDER BY id')).rows,
      folders: (await db.query('SELECT * FROM folders ORDER BY id')).rows,
      messages: (await db.query('SELECT * FROM messages ORDER BY id')).rows,
    });
    const before = await snapshot();
    expect(before.messages).toHaveLength(2);
    await restartOnboarding({ domain: 'kept.example', userId: ADMIN });
    expect(await snapshot()).toEqual(before);
    await recordCreatedDomain({ domain: 'kept.example', userId: OTHER, maxMailboxes: 20 });
    expect(await snapshot()).toEqual(before);
    expect(await stateOf('kept.example')).toBe('node_created');
  });
});

describe('no automatic removal of domain rows', () => {
  it('has no statement in the panel that deletes a mail_node_domains row', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    const offenders = [];
    for (const file of files) {
      const text = await readFile(join(root, file), 'utf8');
      if (/DELETE\s+FROM\s+mail_node_domains|TRUNCATE[^;]*mail_node_domains/i.test(text)) offenders.push(file);
    }
    expect(files.length).toBeGreaterThan(50);
    // The migrations too: the table is new (0079), so no migration may delete its rows.
    const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url));
    const sqlFiles = (await readdir(migrations)).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toContain('0079_mail_node_domains.sql');
    for (const file of sqlFiles) {
      const text = await readFile(join(migrations, file), 'utf8');
      if (/DELETE\s+FROM\s+mail_node_domains|TRUNCATE[^;]*mail_node_domains|DROP\s+TABLE[^;]*mail_node_domains/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
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
        state: 'unknown', origin: null, addedAt: null, addedBy: null, stateChangedAt: null, steps: {}, apply: null, dns: null, expected: null, tenantSync: null, holdInternalRelay: true, internalRelayApprovedAt: null, nextStep: null,
      },
      {
        domain: 'b.example', active: true, maxMailboxes: 500, mailboxes: 2, onNode: true,
        state: 'dns_ok', origin: 'created', addedAt: 't1', addedBy: 'admin@example.com', stateChangedAt: 't2', steps: { dns_ok: {} }, apply: null,
        dns: null, expected: null, tenantSync: null, holdInternalRelay: true, internalRelayApprovedAt: null, nextStep: 'tenant_verified',
      },
      {
        domain: 'gone.example', active: false, maxMailboxes: 0, mailboxes: 0, onNode: false,
        state: 'ready', origin: 'existing_mailboxes', addedAt: 't3', addedBy: null, stateChangedAt: 't3', steps: {}, apply: null, dns: null,
        expected: null, tenantSync: null, holdInternalRelay: true, internalRelayApprovedAt: null, nextStep: null,
      },
    ]);
  });

  it('keeps the state of a domain made again on the node, with both creation times for the warning', () => {
    const rows = [{ domain: 'b.example', state: 'ready', origin: 'created', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, maxMailboxes: 500, nodeCreated: '2026-09-01 10:00:00' }];
    const [, b] = mergeDomains([node[1], { ...node[0], created: '2026-09-30 12:00:00' }], rows);
    expect(b).toMatchObject({
      domain: 'b.example', state: 'ready', origin: 'created', recreated: true, nodeCreated: '2026-09-01 10:00:00', created: '2026-09-30 12:00:00',
    });
    const [, same] = mergeDomains([node[1], { ...node[0], created: '2026-09-01 10:00:00' }], rows);
    expect(same.state).toBe('ready');
    expect(same.recreated).toBeUndefined();
    const [, unknownTime] = mergeDomains([node[1], { ...node[0], created: null }], rows);
    expect(unknownTime.state).toBe('ready');
    expect(unknownTime.recreated).toBeUndefined();
  });

  it('shows every row with its state and the node unknown when the node could not be read', () => {
    const rows = [
      { domain: 'b.example', state: 'ready', origin: 'created', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, maxMailboxes: 500, nodeCreated: 'x' },
      { domain: 'a.example', state: 'dns_ok', origin: 'adopted', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, maxMailboxes: null },
    ];
    expect(mergeDomains(null, rows)).toEqual([
      {
        domain: 'a.example', active: null, maxMailboxes: null, mailboxes: null, onNode: null,
        state: 'dns_ok', origin: 'adopted', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, apply: null, dns: null, expected: null, tenantSync: null, holdInternalRelay: true, internalRelayApprovedAt: null, nextStep: 'tenant_verified',
      },
      {
        domain: 'b.example', active: null, maxMailboxes: 500, mailboxes: null, onNode: null,
        state: 'ready', origin: 'created', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, apply: null, dns: null, expected: null, tenantSync: null, holdInternalRelay: true, internalRelayApprovedAt: null, nextStep: null,
      },
    ]);
  });

  it('shows every row as off the node, not gone, when the node lists no domain at all', () => {
    const rows = [{ domain: 'b.example', state: 'ready', origin: 'created', addedAt: 't1', addedBy: 'a', stateChangedAt: 't2', steps: {}, maxMailboxes: 500 }];
    expect(mergeDomains([], rows)).toEqual([expect.objectContaining({ domain: 'b.example', state: 'ready', onNode: false })]);
  });
});
