import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stage 7b on the real schema and the real queue with the fake tenant (fakes.js
// createFakeTenantModel) and a mocked mail node: a domain taken from "DNS is right" to
// Authoritative step by step (R-23, R-24, R-25, R-29), EOP DKIM (R-26), the waits (the accepted
// domain's delay, a verification not visible yet), idempotency (a second run only reads),
// throttling (the job queued again with what it did kept), batches, the mirror's safety rules, the
// recipient removed before a node mailbox is deleted (R-33), the routes and the connector
// reference (R-25).

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
const node = vi.hoisted(() => ({ cfg: null, mailboxes: [], aliases: [], domains: [] }));
vi.mock('../mailNode/mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  listMailboxes: vi.fn(async (cfg, { domain } = {}) => node.mailboxes.filter((m) => !domain || m.email.endsWith(`@${domain}`))),
  listDomainAliases: vi.fn(async (cfg, domain) => node.aliases.filter((a) => a.address.endsWith(`@${domain}`) || a.address === `@${domain}`)),
  listDomains: vi.fn(async () => node.domains),
}));
vi.mock('../mailNode/nodeApply.js', async (importActual) => ({
  ...(await importActual()),
  applyQuietly: vi.fn(async () => null),
}));
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: '60000000-0000-4000-8000-000000000001' }; next(); },
  requireAdmin: (_req, res, next) => (auth.admin ? next() : res.status(403).json({ error: 'Admin only' })),
}));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { default: express } = await import('express');
const { default: tenantRoutes } = await import('../../routes/mailNodeTenant.js');
const { default: mailNodeRoutes } = await import('../../routes/mailNode.js');
const { MailNodeError, listMailboxes } = await import('../mailNode/mailcow.js');
const { claimDueJobs, runJob } = await import('../jobQueue.js');
const { saveEopSettings } = await import('../mailNode/eopSettings.js');
const { BEFORE_NODE_DELETE, runDueDeletions } = await import('../mailNode/mailboxDeletion.js');
const { createFakeTenantDriver, setTenantDriver } = await import('./driver.js');
const { TenantError } = await import('./exoRunner.js');
const { TENANT_FIXTURES } = await import('./fakes.js');
const { getTenantState, registerTenantJobKinds } = await import('./tenantJobs.js');
const {
  CONTACT_BATCH, DOMAIN_SYNC_KIND, enqueueDomainSync, enqueueDueDomainSyncs, registerTenantDomainJobKind, removeRecipientBeforeDelete,
} = await import('./tenantDomains.js');

const ADMIN = '60000000-0000-4000-8000-000000000001';
const SETTINGS = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, deleteAfterDays: 5 };
const D = 'example.com';

let db;
let server;
let base;
let driver;
let model;

async function runDue() {
  const ran = [];
  for (const job of await claimDueJobs(10)) {
    await runJob(job);
    ran.push(job);
  }
  return ran;
}
// Runs the domain's queued sync now, whatever its delay.
async function sync(domain = D) {
  await db.query(`UPDATE jobs SET run_at = NOW() WHERE kind = $1 AND status = 'queued'`, [DOMAIN_SYNC_KIND]);
  if (!(await db.query(`SELECT 1 FROM jobs WHERE kind = $1 AND status = 'queued'`, [DOMAIN_SYNC_KIND])).rows.length) {
    await enqueueDomainSync(domain);
  }
  return runDue();
}
const row = async (domain = D) => (await db.query('SELECT * FROM mail_node_domains WHERE domain = $1', [domain])).rows[0];
const jobs = async () => (await db.query(`SELECT * FROM jobs WHERE kind = $1 ORDER BY id`, [DOMAIN_SYNC_KIND])).rows;
const ops = () => driver.fake.exo.calls.map((c) => c.op);
const writes = () => driver.fake.exo.calls.filter((c) => !/^get_/.test(c.op));
const graphWrites = () => driver.fake.graph.requests.filter((r) => r.kind === 'graph' && r.method !== 'GET');
const audit = async () => (await db.query("SELECT action, actor_email, details FROM mailbox_audit_log ORDER BY id")).rows;
const addDomain = (state, domain = D) => db.query(
  "INSERT INTO mail_node_domains (domain, state, origin) VALUES ($1, $2, 'created')", [domain, state],
);
const addAccount = async (email, extra = {}) => {
  const { rows } = await db.query(
    `INSERT INTO email_accounts (added_by, name, email_address, mail_node, imap_host) VALUES ($1, $2, $2, true, 'mail.example.com') RETURNING id`,
    [ADMIN, email],
  );
  if (extra.deletion) await db.query("UPDATE email_accounts SET delete_after = NOW() - interval '1 minute', deletion_reason = 'r' WHERE id = $1", [rows[0].id]);
  return rows[0].id;
};
const setMailboxes = (...emails) => { node.mailboxes = emails.map((email) => ({ email, active: true, state: 1 })); };

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  registerTenantJobKinds();
  registerTenantDomainJobKind({ beforeNodeDelete: BEFORE_NODE_DELETE });
  const app = express();
  app.use(express.json());
  app.use('/api/mail-node', tenantRoutes);
  app.use('/api/mail-node', mailNodeRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail-node`;
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await new Promise((resolve) => server?.close(resolve));
  await db.close();
});
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  auth.admin = true;
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM email_accounts; DELETE FROM mail_node_domains;
    DELETE FROM integration_config;`);
  await saveEopSettings(SETTINGS);
  node.cfg = CFG;
  node.aliases = [];
  node.domains = [{ domain: D, active: true, maxMailboxes: 500, mailboxes: 0 }];
  setMailboxes();
  driver = createFakeTenantDriver();
  model = driver.fake.model;
  setTenantDriver(driver);
});

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

describe('a domain through its tenant steps', () => {
  it('goes from "DNS is right" to Authoritative, each step after a read back', async () => {
    await addDomain('node_configured');
    await sync();
    // R-23 before "DNS is right": the domain is in the tenant and its TXT is known, nothing verified.
    let r = await row();
    expect(r.state).toBe('node_configured');
    expect(model.domains.get(D)).toMatchObject({ isVerified: false });
    expect(r.tenant).toMatchObject({ verificationTxt: expect.stringMatching(/^MS=ms\d{8}$/), source: 'tenant' });
    expect(r.tenant_sync.graph).toMatchObject({ present: true, verified: false });
    expect(graphWrites().map((q) => `${q.method} ${q.path}`)).toEqual(['POST /domains']);

    // A person confirms the DNS; the next run verifies and goes on as far as the tenant allows.
    await db.query("UPDATE mail_node_domains SET state = 'dns_ok' WHERE domain = $1", [D]);
    setMailboxes('a@example.com', 'b@example.com');
    await addAccount('a@example.com');
    await addAccount('b@example.com');
    await sync();
    r = await row();
    expect(r.state).toBe('connector_ready');
    expect(Object.keys(r.steps).sort()).toEqual(['connector_ready', 'internal_relay', 'tenant_verified']);
    expect(r.steps.tenant_verified).toMatchObject({ email: 'MailExpert', tenantDriver: true });
    expect(r.expected_mx).toEqual(['example-com.mail.protection.outlook.com']);
    expect(r.accepted_domain_type).toBe('InternalRelay');
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect(model.domains.get(D)).toMatchObject({ isVerified: true, supportedServices: ['Email'] });
    expect(model.outbound[0].RecipientDomains).toContain(D);
    // The mirror already runs on Internal Relay (D-4): both contacts, hidden.
    expect([...model.recipients.keys()].sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(model.recipients.get('a@example.com')).toMatchObject({ HiddenFromAddressListsEnabled: true, ExternalEmailAddress: 'SMTP:a@example.com' });
    expect(r.tenant_sync.mirror).toMatchObject({ ok: true, desired: 2, present: 2, created: ['a@example.com', 'b@example.com'] });
    const accounts = (await db.query('SELECT email_address, tenant_recipient_at FROM email_accounts ORDER BY email_address')).rows;
    expect(accounts.every((a) => a.tenant_recipient_at)).toBe(true);
    // 'ready' stays a person's step: the owner switches the MX first.
    expect(r.accepted_domain_type).not.toBe('Authoritative');

    await db.query("UPDATE mail_node_domains SET state = 'ready' WHERE domain = $1", [D]);
    await sync();
    // Held on Internal Relay by default (Q1): the mirror is complete, the switch waits.
    r = await row();
    expect(r.state).toBe('ready');
    expect(r.hold_internal_relay).toBe(true);
    expect(r.tenant_sync.authoritative).toMatchObject({ ok: true, held: true, mirrorComplete: true });
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    driver.fake.exo.calls.length = 0;
    const released = await post('/tenant/domains/example.com/hold', { hold: false });
    expect(released.status).toBe(200);
    await sync();
    r = await row();
    expect(r.state).toBe('authoritative');
    expect(r.accepted_domain_type).toBe('Authoritative');
    expect(model.accepted.get(D).type).toBe('Authoritative');
    expect(writes().map((c) => c.op)).toEqual(['set_accepted_domain_authoritative']);
    const entries = (await audit()).filter((e) => e.action === 'mail_node.domain_state_changed').map((e) => `${e.details.from}>${e.details.to}`);
    expect(entries).toEqual(['dns_ok>tenant_verified', 'tenant_verified>internal_relay', 'internal_relay>connector_ready', 'ready>authoritative']);
    expect((await audit()).find((e) => e.action === 'tenant.recipients_synced').details).toEqual({ domain: D, created: 2, removed: 0, retargeted: 0 });
  });

  it('a second run only reads (idempotent)', async () => {
    await addDomain('dns_ok');
    setMailboxes('a@example.com');
    await sync();
    expect((await row()).state).toBe('connector_ready');
    driver.fake.exo.calls.length = 0;
    driver.fake.graph.requests.length = 0;
    await sync();
    expect(writes()).toEqual([]);
    expect(graphWrites()).toEqual([]);
    expect((await row()).state).toBe('connector_ready');
  });

  it('waits for a verification Microsoft cannot see yet, without failing', async () => {
    await addDomain('dns_ok');
    model.options.verifiable = false;
    const [job] = await sync();
    const r = await row();
    expect(r.state).toBe('dns_ok');
    expect(r.tenant_sync.graph.verifyError).toMatchObject({ code: 'domain_not_verified' });
    expect((await jobs()).find((j) => j.id === job.id).status).toBe('done');
    model.options.verifiable = true;
    await sync();
    expect((await row()).state).toBe('connector_ready');
  });

  it('looks again 1, 2 ... minutes later while Get-AcceptedDomain does not show the domain (R-23, R-24)', async () => {
    await addDomain('dns_ok');
    model.options.acceptedDelayReads = 2;
    await sync();
    let r = await row();
    expect(r.state).toBe('tenant_verified');
    expect(r.tenant_sync.acceptedDomain).toMatchObject({ visible: false, polls: 1 });
    const follow = (await jobs()).filter((j) => j.status === 'queued');
    expect(follow).toHaveLength(1);
    expect(new Date(follow[0].run_at) - Date.now()).toBeGreaterThan(50000);
    await sync();
    expect((await row()).tenant_sync.acceptedDomain.polls).toBe(2);
    await sync();
    r = await row();
    expect(r.state).toBe('connector_ready');
    expect(r.tenant_sync.acceptedDomain).toMatchObject({ visible: true, type: 'InternalRelay', polls: 0 });
  });

  it('leaves a domain the tenant already had as Authoritative alone until an administrator approves Internal Relay (Q2)', async () => {
    await addDomain('ready');
    model.domains.set(D, { id: D, isVerified: true, supportedServices: ['Email'] });
    model.accepted.set(D, { type: 'Authoritative', misses: 0 });
    setMailboxes('a@example.com');
    await sync();
    let r = await row();
    expect(model.accepted.get(D).type).toBe('Authoritative');
    expect(writes()).toEqual([]);
    expect(r.tenant_sync.acceptedDomain).toMatchObject({ ok: false, code: 'authoritative_in_tenant' });
    expect(r.tenant_sync.graph.preexisting).toBe(true);
    expect(r.accepted_domain_type).toBe('Authoritative');
    // The decision is an administrator's explicit action.
    auth.admin = false;
    expect((await post('/tenant/domains/example.com/internal-relay')).status).toBe(403);
    auth.admin = true;
    expect((await post('/tenant/domains/example.com/internal-relay')).status).toBe(202);
    await sync();
    r = await row();
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect(r.tenant_sync.acceptedDomain).toMatchObject({ visible: true, type: 'InternalRelay' });
    expect((await audit()).map((e) => e.action)).toContain('tenant.internal_relay_approved');
    expect((await post('/tenant/domains/example.com/internal-relay')).status).toBe(409);
  });

  it('puts an Authoritative type it set itself back to Internal Relay before the mirror is complete (R-24)', async () => {
    // A domain the driver added: the tenant's default type (Authoritative) is not a decision.
    await addDomain('dns_ok');
    await sync();
    model.accepted.get(D).type = 'Authoritative';
    await db.query("UPDATE mail_node_domains SET state = 'ready' WHERE domain = $1", [D]);
    await sync();
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect((await row()).state).toBe('ready');
  });

  it('names the problem when no Outbound connector can be chosen (R-25)', async () => {
    await addDomain('dns_ok');
    // An EAC name with brackets and '&': the worker gets the Guid, so it works (M2).
    model.addOutbound({ Name: 'To node [EU] & backup', Identity: 'To node [EU] & backup' });
    await sync();
    let r = await row();
    expect(r.state).toBe('internal_relay');
    expect(r.tenant_sync.connector).toMatchObject({ ok: false, code: 'outbound_connector_ambiguous', names: ['To mail node', 'To node [EU] & backup'] });
    await saveEopSettings({ outboundConnector: 'To node [EU] & backup' });
    await sync();
    r = await row();
    expect(r.state).toBe('connector_ready');
    expect(model.outbound[1].RecipientDomains).toEqual([D]);
    expect(driver.fake.exo.calls.find((c) => c.op === 'add_outbound_connector_domain').args.connector).toBe(model.outbound[1].Guid);
  });
});

describe('EOP DKIM (R-26)', () => {
  it('makes the config, keeps its CNAMEs for the DNS check and enables it once they are published', async () => {
    await saveEopSettings({ dkimMode: 'eop' });
    await addDomain('dns_ok');
    model.options.dkimPublished = false;
    await sync();
    let r = await row();
    expect(r.tenant).toMatchObject({
      dkimSelector1Cname: 'selector1-example-com._domainkey.contoso.n-v1.dkim.mail.microsoft',
      dkimSelector2Cname: 'selector2-example-com._domainkey.contoso.n-v1.dkim.mail.microsoft',
    });
    expect(r.tenant_sync.dkim).toMatchObject({ ok: true, enabled: false, enableError: { code: 'exo_failed' } });
    model.options.dkimPublished = true;
    await sync();
    r = await row();
    expect(r.tenant_sync.dkim).toMatchObject({ enabled: true, status: 'Valid' });
    expect(r.tenant_sync.dkim.enableError).toBeUndefined();
    expect(ops().filter((op) => op === 'new_dkim_signing_config')).toHaveLength(1);
  });

  it('is left alone while mailcow signs (D-1)', async () => {
    await addDomain('dns_ok');
    await sync();
    expect(ops()).not.toContain('get_dkim_signing_config');
  });
});

describe('the recipient mirror (R-29)', () => {
  beforeEach(async () => {
    await addDomain('dns_ok');
    await sync();
    driver.fake.exo.calls.length = 0;
  });

  it('keeps an alias contact on an Authoritative domain until an administrator allows its removal (section 5.14)', async () => {
    setMailboxes('a@example.com');
    await db.query("UPDATE mail_node_domains SET state = 'ready', hold_internal_relay = false WHERE domain = $1", [D]);
    await sync();
    await sync();
    expect((await row()).state).toBe('authoritative');
    // A contact the 7b mirror made for an alias still on the node: it lets mail to the alias in.
    model.recipients.set('sales@example.com', {
      ...TENANT_FIXTURES.exo.get_recipients[0], Identity: 'sales@example.com', PrimarySmtpAddress: 'sales@example.com',
      ExternalEmailAddress: 'SMTP:sales@example.com', HiddenFromAddressListsEnabled: true,
    });
    node.aliases = [{ address: 'sales@example.com', targets: ['a@example.com'], active: true }];
    driver.fake.exo.calls.length = 0;
    await sync();
    let r = await row();
    expect(model.recipients.has('sales@example.com')).toBe(true);
    expect(writes().map((c) => c.op)).not.toContain('remove_mail_contact');
    expect(r.tenant_sync.mirror).toMatchObject({ heldAliasContacts: ['sales@example.com'], nodeAliases: ['sales@example.com'], complete: true });
    expect(r.state).toBe('authoritative');

    // Not held anywhere: refused. Held: allowed, journaled, removed by the next run.
    expect((await post('/tenant/domains/other.example.org/alias-contacts/remove')).status).toBe(404);
    let res = await post(`/tenant/domains/${D}/alias-contacts/remove`);
    expect(res.status).toBe(202);
    await runDue();
    r = await row();
    expect(r.alias_contacts_approved_at).not.toBeNull();
    expect(model.recipients.has('sales@example.com')).toBe(false);
    expect(r.tenant_sync.mirror.heldAliasContacts).toEqual([]);
    expect((await audit()).map((e) => e.action)).toContain('tenant.alias_contacts_removal_approved');
    res = await post(`/tenant/domains/${D}/alias-contacts/remove`);
    expect(res.status).toBe(409);
  });

  it('removes a contact nobody needs and one made for a node alias, lists the aliases and holds Authoritative back for a catch-all (D-6)', async () => {
    const stale = (address) => ({ ...TENANT_FIXTURES.exo.get_recipients[0], Identity: address, PrimarySmtpAddress: address, ExternalEmailAddress: `SMTP:${address}` });
    model.recipients.set('old@example.com', stale('old@example.com'));
    // Made by the 7b mirror for a hand-made alias: the mirror covers only what the panel owns now.
    model.recipients.set('sales@example.com', stale('sales@example.com'));
    setMailboxes('a@example.com');
    node.aliases = [{ address: 'sales@example.com', targets: ['a@example.com'], active: true }, { address: '@example.com', targets: ['a@example.com'], active: true }];
    await db.query("UPDATE mail_node_domains SET state = 'ready', hold_internal_relay = false WHERE domain = $1", [D]);
    await sync();
    expect((await row()).tenant_sync.mirror.removed.sort()).toEqual(['old@example.com', 'sales@example.com']);
    await sync();
    const r = await row();
    expect([...model.recipients.keys()].sort()).toEqual(['a@example.com']);
    expect(r.tenant_sync.mirror).toMatchObject({ catchAll: '@example.com', complete: false, removed: [], nodeAliases: ['sales@example.com'] });
    expect(r.state).toBe('ready');
    node.aliases = node.aliases.slice(0, 1);
    await sync();
    expect((await row()).state).toBe('authoritative');
  });

  it('removes nothing when the node answers no mailbox while the panel has some', async () => {
    setMailboxes('a@example.com');
    await addAccount('a@example.com');
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(true);
    setMailboxes();
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(true);
    expect((await row()).tenant_sync.mirror).toMatchObject({ suspicious: true });
  });

  it('keeps the mirror untouched when the node cannot be read', async () => {
    vi.mocked(listMailboxes).mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'down'));
    await sync();
    expect(writes()).toEqual([]);
    expect((await row()).tenant_sync.mirror).toMatchObject({ ok: false, error: { code: 'mail_node_unreachable' } });
  });

  it('works in batches and goes on by itself', async () => {
    setMailboxes(...Array.from({ length: 30 }, (_, i) => `u${String(i).padStart(2, '0')}@example.com`));
    await sync();
    // A contact is two writes (made, hidden): a batch of CONTACT_BATCH writes.
    expect(writes()).toHaveLength(CONTACT_BATCH);
    const mirror = (await row()).tenant_sync.mirror;
    expect(mirror.left).toBeGreaterThan(0);
    expect((await jobs()).filter((j) => j.status === 'queued')).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) await sync();
    expect(model.recipients.size).toBe(30);
    expect([...model.recipients.values()].every((c) => c.HiddenFromAddressListsEnabled)).toBe(true);
  });

  it('keeps what it did and queues the job again when EXO throttles', async () => {
    setMailboxes('a@example.com', 'b@example.com', 'c@example.com');
    let made = 0;
    driver.fake.exo.answers.new_mail_contact = (args) => {
      made += 1;
      if (made === 2) throw new TenantError('exo_throttled', 'Micro delay applied');
      return model.exo.new_mail_contact(args);
    };
    await sync();
    const job = (await jobs()).at(-1);
    expect(job).toMatchObject({ status: 'queued', error_code: 'exo_throttled' });
    expect(new Date(job.run_at) - Date.now()).toBeGreaterThan(30000);
    expect([...model.recipients.keys()]).toEqual(['a@example.com']);
    delete driver.fake.exo.answers.new_mail_contact;
    await sync();
    expect([...model.recipients.keys()].sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('takes a contact made by a run whose answer was lost as made', async () => {
    setMailboxes('a@example.com');
    driver.fake.exo.answers.new_mail_contact = (args) => {
      model.exo.new_mail_contact(args);
      throw new TenantError('exo_exists', 'The proxy address is already being used');
    };
    await sync();
    expect((await row()).tenant_sync.mirror).toMatchObject({ ok: true, created: ['a@example.com'] });
  });

  it('makes contacts of variant B and moves them when the variant changes (D-7)', async () => {
    setMailboxes('a@example.com');
    await sync();
    await saveEopSettings({ dbebExternalDomain: 'relay.example.net' });
    await sync();
    expect(model.recipients.get('a@example.com')).toMatchObject({ PrimarySmtpAddress: 'a@example.com', ExternalEmailAddress: 'SMTP:a@relay.example.net' });
    expect((await row()).tenant_sync.mirror).toMatchObject({ variant: 'B', present: 1 });
  });
});

describe('the recipient before the node mailbox (R-29 with R-33)', () => {
  it('removes the contact first; a contact already gone is fine', async () => {
    await addDomain('authoritative');
    model.recipients.set('a@example.com', { ...TENANT_FIXTURES.exo.get_recipients[0], Identity: 'a@example.com', PrimarySmtpAddress: 'a@example.com' });
    await removeRecipientBeforeDelete({ email_address: 'A@example.com' });
    expect(model.recipients.has('a@example.com')).toBe(false);
    await removeRecipientBeforeDelete({ email_address: 'a@example.com' });
  });

  it('drops the contact of a read-only mailbox and makes it again when it works again (EOP seats design)', async () => {
    await addDomain('dns_ok');
    setMailboxes('a@example.com');
    const id = await addAccount('a@example.com');
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(true);
    await db.query("UPDATE email_accounts SET delete_after = NOW() + interval '5 days', deletion_reason = 'r' WHERE id = $1", [id]);
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(false);
    await db.query('UPDATE email_accounts SET delete_after = NULL, deletion_reason = NULL, deactivated_at = NOW() WHERE id = $1', [id]);
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(false);
    await db.query('UPDATE email_accounts SET deactivated_at = NULL WHERE id = $1', [id]);
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(true);
  });

  it('keeps an Authoritative domain\'s mailbox pending while the tenant cannot be reached', async () => {
    await addDomain('authoritative');
    const id = await addAccount('a@example.com', { deletion: true });
    setTenantDriver(null);
    const deleteMailbox = vi.spyOn(await import('../mailNode/mailcow.js'), 'deleteMailbox');
    await runDueDeletions();
    const { rows: [a] } = await db.query('SELECT deletion_last_error FROM email_accounts WHERE id = $1', [id]);
    expect(a.deletion_last_error).toBe('tenant_driver_missing');
    expect(deleteMailbox).not.toHaveBeenCalled();
    setTenantDriver(driver);
    driver.fake.exo.answers.remove_mail_contact = new TenantError('worker_unreachable', 'down');
    await expect(removeRecipientBeforeDelete({ email_address: 'a@example.com' })).rejects.toMatchObject({ deletionCode: 'tenant_recipient_not_removed' });
  });

  it('lets an Internal Relay domain\'s deletion go on when the contact cannot be removed', async () => {
    await addDomain('internal_relay');
    driver.fake.exo.answers.remove_mail_contact = new TenantError('worker_unreachable', 'down');
    await expect(removeRecipientBeforeDelete({ email_address: 'a@example.com' })).resolves.toBeUndefined();
    await addDomain('dns_ok', 'other.example');
    driver.fake.exo.calls.length = 0;
    await removeRecipientBeforeDelete({ email_address: 'a@other.example' });
    expect(ops()).toEqual([]);
  });

  it('leaves out of the mirror a mailbox whose deletion has started', async () => {
    await addDomain('dns_ok');
    setMailboxes('a@example.com');
    const id = await addAccount('a@example.com');
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(true);
    await db.query('UPDATE email_accounts SET deletion_started_at = NOW(), delete_after = NOW() WHERE id = $1', [id]);
    await sync();
    expect(model.recipients.has('a@example.com')).toBe(false);
  });
});

describe('the queue and the routes', () => {
  it('queues one sync per domain while one waits, and the poll\'s slot every domain', async () => {
    await addDomain('node_created');
    await addDomain('authoritative', 'b.example');
    const first = await enqueueDomainSync(D);
    expect((await enqueueDomainSync(D)).job.id).toBe(first.job.id);
    const now = Date.now();
    const queued = await enqueueDueDomainSyncs(now);
    // example.com has one queued already; b.example gets its slot.
    expect(queued.map((j) => j.payload.domain)).toEqual(['b.example']);
    expect(await enqueueDueDomainSyncs(now)).toEqual([]);
    setTenantDriver(null);
    expect(await enqueueDueDomainSyncs(now + 3600000)).toEqual([]);
  });

  it('runs one sync of a domain at a time, without spending attempts (M1)', async () => {
    await addDomain('dns_ok');
    // Another live run holds the domain.
    await db.query('UPDATE mail_node_domains SET sync_lock_job = 999999, sync_locked_at = NOW() WHERE domain = $1', [D]);
    const { job } = await enqueueDomainSync(D);
    await runDue();
    const all = await jobs();
    expect(all.find((j) => j.id === job.id)).toMatchObject({ status: 'done', attempts: 1 });
    const next = all.find((j) => j.id !== job.id);
    expect(next).toMatchObject({ status: 'queued', attempts: 0 });
    expect(new Date(next.run_at) - Date.now()).toBeGreaterThan(20000);
    expect(driver.fake.graph.requests.filter((r) => r.kind === 'graph')).toEqual([]);
    // A lock left by a run that died is taken over; a finished run releases it.
    await db.query("UPDATE mail_node_domains SET sync_locked_at = NOW() - interval '31 minutes' WHERE domain = $1", [D]);
    await sync();
    const r = await row();
    expect(r.state).toBe('connector_ready');
    expect(r.sync_lock_job).toBeNull();
  });

  it('refuses the tenant buttons to anyone but administrators', async () => {
    await addDomain('dns_ok');
    auth.admin = false;
    expect((await post('/tenant/domains/example.com/sync')).status).toBe(403);
    expect((await post('/tenant/connectors/reference')).status).toBe(403);
    expect((await post('/tenant/domains/example.com/hold', { hold: false })).status).toBe(403);
  });

  it('holds a domain on Internal Relay until turned off, never an Authoritative one (Q1)', async () => {
    await addDomain('dns_ok');
    expect((await post('/tenant/domains/example.com/hold', { hold: 'no' })).status).toBe(400);
    expect((await post('/tenant/domains/nope.example/hold', { hold: true })).status).toBe(404);
    expect((await post('/tenant/domains/example.com/hold', { hold: false })).status).toBe(200);
    expect((await row()).hold_internal_relay).toBe(false);
    expect((await audit()).find((e) => e.action === 'tenant.domain_hold_changed').details).toEqual({ domain: D, hold: false });
    await db.query("UPDATE mail_node_domains SET state = 'authoritative' WHERE domain = $1", [D]);
    expect((await post('/tenant/domains/example.com/hold', { hold: true })).status).toBe(409);
  });

  it('refuses "mark ready" while the driver runs the tenant steps (I3)', async () => {
    await addDomain('dns_ok');
    const res = await post('/domains/example.com/ready');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('mark_ready_by_tenant_driver');
    expect((await row()).state).toBe('dns_ok');
  });

  it('POST /tenant/domains/:domain/sync queues the job; "Done" on a driver step is refused', async () => {
    await addDomain('dns_ok');
    let res = await post('/tenant/domains/example.com/sync');
    expect(res.status).toBe(202);
    expect((await res.json()).job.kind).toBe(DOMAIN_SYNC_KIND);
    expect((await post('/tenant/domains/nope.example/sync')).status).toBe(404);
    expect((await post('/tenant/domains/bad;domain/sync')).status).toBe(400);
    res = await post('/domains/example.com/steps/tenant_verified');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('step_by_tenant_driver');
    // Without the driver the checklist is a person's again.
    setTenantDriver(null);
    res = await post('/domains/example.com/steps/tenant_verified');
    expect(res.status).toBe(200);
    expect((await post('/tenant/domains/example.com/sync')).status).toBe(409);
  });

  it('a step confirmed by a person queues the domain\'s sync', async () => {
    await addDomain('node_configured');
    expect((await post('/domains/example.com/steps/dns_ok')).status).toBe(200);
    expect((await jobs()).map((j) => j.payload.domain)).toEqual([D]);
  });
});

describe('the fixes of the 7b review', () => {
  const ready = async () => {
    await addDomain('dns_ok');
    await sync();
    await db.query("UPDATE mail_node_domains SET state = 'ready', hold_internal_relay = false WHERE domain = $1", [D]);
    driver.fake.exo.calls.length = 0;
  };

  it('C1: a write that keeps failing is shown and not retried every two seconds', async () => {
    await ready();
    setMailboxes('a@example.com');
    driver.fake.exo.answers.new_mail_contact = new TenantError('exo_failed', 'The name is too long');
    await sync();
    const r = await row();
    expect(r.tenant_sync.mirror).toMatchObject({ ok: false, left: 0, failed: [expect.objectContaining({ address: 'a@example.com', code: 'exo_failed' })] });
    expect((await jobs()).filter((j) => j.status === 'queued')).toEqual([]);
    expect(r.state).toBe('ready');
  });

  it('C1: what the budget left goes on at once, a failure among it does not count', async () => {
    await ready();
    setMailboxes(...Array.from({ length: 14 }, (_, i) => `u${String(i).padStart(2, '0')}@example.com`));
    driver.fake.exo.answers.new_mail_contact = (args) => {
      if (args.address === 'u00@example.com') throw new TenantError('exo_failed', 'refused');
      return model.exo.new_mail_contact(args);
    };
    await sync();
    const mirror = (await row()).tenant_sync.mirror;
    // 25 writes: u00 failed (1), 12 made and hidden (24): u13 is left.
    expect(mirror.left).toBe(1);
    expect((await jobs()).filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('I1: an empty node answer never wipes contacts the panel does not know', async () => {
    await ready();
    model.recipients.set('manual@example.com', { ...TENANT_FIXTURES.exo.get_recipients[0], Identity: 'manual@example.com', PrimarySmtpAddress: 'manual@example.com', ExternalEmailAddress: 'SMTP:manual@example.com' });
    setMailboxes();
    await sync();
    expect(model.recipients.has('manual@example.com')).toBe(true);
    expect((await row()).tenant_sync.mirror).toMatchObject({ suspicious: true, complete: false });
    expect((await row()).state).toBe('ready');
  });

  it('I2: "exists" from New-MailContact counts only once a read shows the contact; else address_taken', async () => {
    await ready();
    setMailboxes('a@example.com');
    const id = await addAccount('a@example.com');
    // Held by a recipient Get-Recipient does not show.
    driver.fake.exo.answers.new_mail_contact = new TenantError('exo_exists', 'The proxy address "SMTP:a@example.com" is already being used');
    await sync();
    let r = await row();
    expect(r.tenant_sync.mirror).toMatchObject({ ok: false, created: [], present: 0, failed: [expect.objectContaining({ address: 'a@example.com', code: 'address_taken' })] });
    expect(r.state).toBe('ready');
    expect((await db.query('SELECT tenant_recipient_at FROM email_accounts WHERE id = $1', [id])).rows[0].tenant_recipient_at).toBeNull();
    expect((await audit()).filter((e) => e.action === 'tenant.recipients_synced')).toEqual([]);
    // Made by a run whose answer was lost: the read finds it.
    driver.fake.exo.answers.new_mail_contact = (args) => {
      model.exo.new_mail_contact(args);
      throw new TenantError('exo_exists', 'already exists');
    };
    await sync();
    r = await row();
    expect(r.tenant_sync.mirror).toMatchObject({ ok: true, created: ['a@example.com'] });
  });

  it('M3: a mailbox whose address another tenant recipient holds does not wait for the tenant', async () => {
    await ready();
    setMailboxes('team@example.com');
    const id = await addAccount('team@example.com');
    model.addRecipient({ PrimarySmtpAddress: 'team@example.com', EmailAddresses: ['SMTP:team@example.com'], RecipientTypeDetails: 'UserMailbox' });
    await sync();
    expect((await row()).tenant_sync.mirror.conflicts).toEqual(['team@example.com']);
    expect((await db.query('SELECT tenant_recipient_at FROM email_accounts WHERE id = $1', [id])).rows[0].tenant_recipient_at).not.toBeNull();
  });

  it('I3: no Authoritative while the Outbound connector does not hold the domain', async () => {
    await ready();
    setMailboxes('a@example.com');
    model.outbound[0].RecipientDomains = [];
    driver.fake.exo.answers.add_outbound_connector_domain = new TenantError('exo_failed', 'Access denied');
    await sync();
    await sync();
    const r = await row();
    expect(r.tenant_sync.mirror.complete).toBe(true);
    expect(r.tenant_sync.connector).toMatchObject({ ok: false });
    expect(r.state).toBe('ready');
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect(ops()).not.toContain('set_accepted_domain_authoritative');
  });

  it('I5: variant B on an Authoritative domain moves the contacts in place, never removes them', async () => {
    await ready();
    setMailboxes('a@example.com');
    await sync();
    await sync();
    expect((await row()).state).toBe('authoritative');
    driver.fake.exo.calls.length = 0;
    await saveEopSettings({ dbebExternalDomain: 'relay.example.net' });
    await sync();
    expect(ops()).not.toContain('remove_mail_contact');
    expect(ops()).not.toContain('new_mail_contact');
    expect(ops()).toContain('set_mail_contact_external');
    expect(model.recipients.get('a@example.com')).toMatchObject({ ExternalEmailAddress: 'SMTP:a@relay.example.net' });
    const r = await row();
    expect(r.state).toBe('authoritative');
    expect(r.tenant_sync.mirror).toMatchObject({ retargeted: ['a@example.com'], present: 1, variant: 'B' });
  });

  it('I4: an onboarding started over keeps the domain on Internal Relay and its contacts removed before the mailbox', async () => {
    await ready();
    setMailboxes('a@example.com');
    await sync();
    await sync();
    expect((await row()).state).toBe('authoritative');
    expect((await post('/domains/example.com/restart')).status).toBe(200);
    let r = await row();
    expect(r.state).toBe('node_created');
    expect(r.accepted_domain_type).toBe('Authoritative');
    // The mailbox deleted now still loses its contact first: the domain is Authoritative in the tenant.
    await removeRecipientBeforeDelete({ email_address: 'a@example.com' });
    expect(model.recipients.has('a@example.com')).toBe(false);
    // The next run moves the domain to Internal Relay (the restart approved it) without waiting.
    await sync();
    r = await row();
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect(r.accepted_domain_type).toBe('InternalRelay');
    expect(r.state).toBe('node_created');
  });
});

describe('the connector reference (R-25)', () => {
  it('is the first good read, then what an administrator takes', async () => {
    expect((await post('/tenant/connectors/reference')).status).toBe(409);
    await post('/tenant/poll');
    await runDue();
    let state = await getTenantState();
    expect(state.connectorReference).toMatchObject({ auto: true, outbound: [expect.objectContaining({ name: 'To mail node' })] });
    let answer = await (await fetch(`${base}/tenant`)).json();
    expect(answer.connectorDrift).toEqual([]);

    model.inbound[0].TlsSenderCertificateName = 'other.example.com';
    await post('/tenant/poll');
    await runDue();
    answer = await (await fetch(`${base}/tenant`)).json();
    expect(answer.connectorDrift).toEqual([expect.objectContaining({ direction: 'inbound', name: 'From mail node', kind: 'changed' })]);

    const res = await post('/tenant/connectors/reference');
    expect(res.status).toBe(200);
    state = await getTenantState();
    expect(state.connectorReference).toMatchObject({ auto: false, by: ADMIN });
    answer = await (await fetch(`${base}/tenant`)).json();
    expect(answer.connectorDrift).toEqual([]);
    expect((await audit()).map((e) => e.action)).toContain('tenant.connector_reference_taken');
  });
});
