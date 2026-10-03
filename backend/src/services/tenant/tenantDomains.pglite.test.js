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
    driver.fake.exo.calls.length = 0;
    await sync();
    r = await row();
    expect(r.state).toBe('authoritative');
    expect(r.accepted_domain_type).toBe('Authoritative');
    expect(model.accepted.get(D).type).toBe('Authoritative');
    expect(writes().map((c) => c.op)).toEqual(['set_accepted_domain_authoritative']);
    const entries = (await audit()).filter((e) => e.action === 'mail_node.domain_state_changed').map((e) => `${e.details.from}>${e.details.to}`);
    expect(entries).toEqual(['dns_ok>tenant_verified', 'tenant_verified>internal_relay', 'internal_relay>connector_ready', 'ready>authoritative']);
    expect((await audit()).find((e) => e.action === 'tenant.recipients_synced').details).toEqual({ domain: D, created: 2, removed: 0 });
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

  it('puts an Authoritative accepted domain back to Internal Relay before the mirror is complete (R-24)', async () => {
    await addDomain('ready');
    model.domains.set(D, { id: D, isVerified: true, supportedServices: ['Email'] });
    model.accepted.set(D, { type: 'Authoritative', misses: 0 });
    // A mailbox whose contact cannot be made keeps the mirror incomplete.
    setMailboxes('a@example.com');
    driver.fake.exo.answers.new_mail_contact = new TenantError('exo_failed', 'Something else');
    await sync();
    const r = await row();
    expect(model.accepted.get(D).type).toBe('InternalRelay');
    expect(r.state).toBe('ready');
    expect(r.tenant_sync.mirror).toMatchObject({ ok: false, failed: [expect.objectContaining({ address: 'a@example.com', code: 'exo_failed' })] });
  });

  it('names the problem when no Outbound connector can be chosen (R-25)', async () => {
    await addDomain('dns_ok');
    model.outbound.push({ ...model.outbound[0], Name: 'Second', Identity: 'Second', RecipientDomains: [] });
    await sync();
    let r = await row();
    expect(r.state).toBe('internal_relay');
    expect(r.tenant_sync.connector).toMatchObject({ ok: false, code: 'outbound_connector_ambiguous', names: ['To mail node', 'Second'] });
    await saveEopSettings({ outboundConnector: 'Second' });
    await sync();
    r = await row();
    expect(r.state).toBe('connector_ready');
    expect(model.outbound[1].RecipientDomains).toEqual([D]);
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

  it('removes a contact nobody needs, mirrors aliases and holds Authoritative back for a catch-all (D-6)', async () => {
    model.recipients.set('old@example.com', { ...TENANT_FIXTURES.exo.get_recipients[0], Identity: 'old@example.com', PrimarySmtpAddress: 'old@example.com', ExternalEmailAddress: 'SMTP:old@example.com' });
    setMailboxes('a@example.com');
    node.aliases = [{ address: 'sales@example.com', targets: ['a@example.com'], active: true }, { address: '@example.com', targets: ['a@example.com'], active: true }];
    await db.query("UPDATE mail_node_domains SET state = 'ready' WHERE domain = $1", [D]);
    await sync();
    await sync();
    const r = await row();
    expect([...model.recipients.keys()].sort()).toEqual(['a@example.com', 'sales@example.com']);
    expect(r.tenant_sync.mirror).toMatchObject({ catchAll: '@example.com', complete: false, removed: [] });
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

  it('runs one sync of a domain at a time', async () => {
    await addDomain('dns_ok');
    const { job } = await enqueueDomainSync(D);
    await db.query("UPDATE jobs SET status = 'running', claim_token = 'other' WHERE id = $1", [job.id]);
    await enqueueDomainSync(D);
    await runDue();
    const second = (await jobs()).find((j) => j.id !== job.id);
    expect(second).toMatchObject({ status: 'queued', error_code: 'domain_sync_busy' });
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
