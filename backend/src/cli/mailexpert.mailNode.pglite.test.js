import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's mailbox and domain commands end to end: the real services on PGlite with every
// migration, a mailcow in memory (services/testing/fakeMailcow.js behind safeFetch) and the fake
// tenant driver (TENANT_DRIVER=fake, the panel's demo/stand mode). What the CLI writes must be what
// the panel's routes write, journal included, with the actor "cli" or the --as administrator.

// closed: the pool was ended (the CLI's finish()); a query after that fails, as pg's does.
const dbState = vi.hoisted(() => ({ db: null, closed: false }));
const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => (dbState.closed
    ? Promise.reject(new Error('Cannot use a pool after calling end on the pool'))
    : dbState.db.query(sql, params)),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => { dbState.closed = true; } },
}));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { createFakeMailcow } = await import('../services/testing/fakeMailcow.js');
const { saveMailNodeConfig } = await import('../services/mailNode/mailcow.js');
const { saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('../services/tenant/driver.js');
const { TENANT_FIXTURES } = await import('../services/tenant/fakes.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { registerTenantJobKinds } = await import('../services/tenant/tenantJobs.js');
const { DOMAIN_SYNC_KIND, registerTenantDomainJobKind } = await import('../services/tenant/tenantDomains.js');
const { finish, run } = await import('./mailexpert.js');

const ADMIN = '62000000-0000-4000-8000-000000000001';
const USER = '62000000-0000-4000-8000-000000000002';
const TENANT = {
  tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
};
let db;
let mc;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

// The backend's job worker, which the CLI never is: runs whatever is due.
async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

async function cli(argv, { interactive = false, answers = [], ask = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive, ask: ask ?? (async () => answers.shift() ?? ''),
    sleep: runDue, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
const account = async (email) => (await db.query('SELECT * FROM email_accounts WHERE lower(email_address) = $1', [email])).rows[0];
const domainRow = async (domain) => (await db.query('SELECT * FROM mail_node_domains WHERE domain = $1', [domain])).rows[0];
async function addAccount(email, { host = 'mail.example.com' } = {}) {
  const { rows } = await db.query(
    `INSERT INTO email_accounts (added_by, name, email_address, mail_node, imap_host, sender_name)
     VALUES ($1, $2, $2, true, $3, 'Old') RETURNING id`, [ADMIN, email, host],
  );
  return rows[0].id;
}
// The journal writes in the background (recordAudit is not awaited): wait for it.
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query(
    `INSERT INTO users (id, username, email, password_hash, is_admin) VALUES
       ($1, 'admin', 'admin@example.com', 'x', true), ($2, 'user', 'user@example.com', 'x', false)`,
    [ADMIN, USER],
  );
  registerTenantJobKinds();
  registerTenantDomainJobKind();
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await db?.close();
});

beforeEach(async () => {
  dbState.closed = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM account_aliases; DELETE FROM email_accounts;
    DELETE FROM mail_node_domains; DELETE FROM mail_node_seat_assignments; DELETE FROM integration_config;`);
  mc = createFakeMailcow({
    domains: { 'example.com': { relayhost: 0 }, 'new.example': { relayhost: 0 } },
    mailboxes: [{ username: 'old@example.com' }],
  });
  fake.current = mc;
  setTenantDriver(null);
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'node-api-key', quotaMb: 5120, deleteAfterDays: 5, panelIps: [] });
  await saveEopSettings({ eopHost: 'eop.example.net', licenses: 10 });
  await db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('example.com', 'ready', 'created'), ('new.example', 'dns_ok', 'created')");
});

describe('mailexpert mailbox', () => {
  it('creates a node mailbox as the panel does, journaled as "cli", without printing its password', async () => {
    const result = await cli(['mailbox', 'create', 'Anna@Example.com', '--name', 'Anna', '--ru', 'Анна Петрова', '--en', 'Anna Petrova', '--json']);
    expect(result.code, result.err).toBe(0);
    const row = await account('anna@example.com');
    expect(row).toMatchObject({ mail_node: true, name: 'Anna', sender_name: 'Анна Петрова', imap_host: 'mail.example.com', added_by: null });
    const { rows: aliases } = await db.query('SELECT name, email FROM account_aliases WHERE account_id = $1', [row.id]);
    expect(aliases).toEqual([{ name: 'Anna Petrova', email: 'anna@example.com' }]);
    // The node got the mailbox with a password only MailExpert knows; nothing prints it.
    const password = mc.writes.find((w) => w.path === 'add/mailbox').body.password;
    expect(password).toBeTruthy();
    expect(row.auth_pass).toBe(`enc:${password}`);
    expect(result.out + result.err).not.toContain(password);
    expect(result.out).not.toMatch(/auth_pass|enc:|node-api-key/);
    expect(result.json()).toMatchObject({ email: 'anna@example.com', senderName: 'Анна Петрова', secondSenderNames: ['Anna Petrova'] });
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({
      actor_user_id: null, actor_email: 'cli', account_email: 'anna@example.com', action: 'mailbox.added',
      details: { mailNode: true, reused: false, via: 'cli' },
    });
  });

  it('journals the --as administrator, and refuses --as for anyone else', async () => {
    const refused = await cli(['mailbox', 'create', 'bob@example.com', '--as', 'user@example.com']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('(admin_not_found)');
    expect(mc.writes.filter((w) => w.path === 'add/mailbox')).toEqual([]);

    expect((await cli(['mailbox', 'create', 'bob@example.com', '--as', 'Admin@Example.com'])).code).toBe(0);
    expect((await account('bob@example.com')).added_by).toBe(ADMIN);
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ actor_user_id: ADMIN, actor_email: 'admin@example.com', action: 'mailbox.added', details: { via: 'cli' } });
  });

  it('refuses what the panel refuses, with its codes, and changes nothing', async () => {
    const notReady = await cli(['mailbox', 'create', 'x@new.example', '--json']);
    expect(notReady.code).toBe(1);
    expect(notReady.json()).toEqual({ error: 'Mailboxes can be created only on a domain that finished its onboarding', code: 'domain_not_ready' });
    await addAccount('taken@example.com');
    expect((await cli(['mailbox', 'create', 'taken@example.com'])).err).toContain('(mailbox_exists)');
    expect((await cli(['mailbox', 'create', 'bad name@example.com'])).err).toContain('(local_part_invalid)');
    expect(mc.writes.filter((w) => w.path === 'add/mailbox')).toEqual([]);
  });

  it('lists the node mailboxes, filtered by domain, and shows one', async () => {
    await addAccount('old@example.com');
    await addAccount('other@new.example');
    const all = await cli(['mailbox', 'list', '--json']);
    expect(all.code, all.err).toBe(0);
    expect(all.json().mailboxes.map((m) => [m.email, m.onNode])).toEqual([['old@example.com', true], ['other@new.example', false]]);
    expect(all.json().disk).toMatchObject({ usedPercent: 12, warn: false });
    const filtered = await cli(['mailbox', 'list', '--domain', 'example.com']);
    expect(filtered.out).toContain('old@example.com');
    expect(filtered.out).not.toContain('other@new.example');
    const shown = await cli(['mailbox', 'show', 'OLD@example.com', '--json']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.json()).toMatchObject({ email: 'old@example.com', senderName: 'Old', node: { active: true }, deletion: null });
    expect((await cli(['mailbox', 'show', 'nobody@example.com'])).err).toContain('(mailbox_not_found)');
  });

  it('names a mailbox by its ID when two rows share the address', async () => {
    const id = await addAccount('twin@example.com');
    await addAccount('Twin@example.com');
    expect((await cli(['mailbox', 'show', 'twin@example.com'])).err).toContain('(mailbox_ambiguous)');
    expect((await cli(['mailbox', 'show', id])).code).toBe(0);
  });

  it('sets the names: the second sender name is always an alias with the mailbox\'s own address (D-16)', async () => {
    const id = await addAccount('old@example.com');
    const set = await cli(['mailbox', 'set-names', 'old@example.com', '--name', 'Old box', '--sender-name', 'Иван', '--second-sender-name', 'Ivan', '--json']);
    expect(set.code, set.err).toBe(0);
    expect(await account('old@example.com')).toMatchObject({ name: 'Old box', sender_name: 'Иван' });
    let aliases = (await db.query('SELECT name, email FROM account_aliases WHERE account_id = $1', [id])).rows;
    expect(aliases).toEqual([{ name: 'Ivan', email: 'old@example.com' }]);
    // Renamed in place, then removed with "".
    await cli(['mailbox', 'set-names', 'old@example.com', '--en', 'Ivan P.']);
    aliases = (await db.query('SELECT name, email FROM account_aliases WHERE account_id = $1', [id])).rows;
    expect(aliases).toEqual([{ name: 'Ivan P.', email: 'old@example.com' }]);
    await cli(['mailbox', 'set-names', 'old@example.com', '--en', '']);
    expect((await db.query('SELECT 1 FROM account_aliases WHERE account_id = $1', [id])).rows).toEqual([]);
    expect((await cli(['mailbox', 'set-names', 'old@example.com', '--sender-name', 'a\nb'])).err).toContain('(sender_name_invalid)');
  });

  it('refuses a second sender name equal to the sender name, either way round, and keeps the alias', async () => {
    const id = await addAccount('old@example.com');
    await cli(['mailbox', 'set-names', 'old@example.com', '--sender-name', 'Ivan', '--second-sender-name', 'Ivan Petrov']);
    const same = await cli(['mailbox', 'set-names', 'old@example.com', '--second-sender-name', 'IVAN']);
    expect(same.code).toBe(1);
    expect(same.err).toContain('(sender_name_alt_same)');
    const reverse = await cli(['mailbox', 'set-names', 'old@example.com', '--sender-name', 'ivan petrov']);
    expect(reverse.err).toContain('(sender_name_alt_same)');
    expect(await account('old@example.com')).toMatchObject({ sender_name: 'Ivan' });
    expect((await db.query('SELECT name FROM account_aliases WHERE account_id = $1', [id])).rows).toEqual([{ name: 'Ivan Petrov' }]);
  });

  it('refuses an empty --name as required, not as invalid characters', async () => {
    await addAccount('old@example.com');
    const result = await cli(['mailbox', 'set-names', 'old@example.com', '--name', '  ']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('The mailbox name cannot be empty (name_required)');
  });

  it('writes the names and the second name in one transaction', async () => {
    const id = await addAccount('old@example.com');
    await db.exec(`CREATE FUNCTION refuse_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no aliases'; END $$;
      CREATE TRIGGER refuse_alias BEFORE INSERT ON account_aliases FOR EACH ROW EXECUTE FUNCTION refuse_alias();`);
    try {
      const result = await cli(['mailbox', 'set-names', 'old@example.com', '--name', 'New name', '--sender-name', 'Новое', '--en', 'New']);
      expect(result.code).toBe(3);
    } finally {
      await db.exec('DROP TRIGGER refuse_alias ON account_aliases; DROP FUNCTION refuse_alias();');
    }
    expect(await account('old@example.com')).toMatchObject({ name: 'old@example.com', sender_name: 'Old' });
    expect((await db.query('SELECT 1 FROM account_aliases WHERE account_id = $1', [id])).rows).toEqual([]);
  });

  it('answers not_mail_node for the ID of a mailbox that is not on the node, as the route does', async () => {
    const { rows: [row] } = await db.query(
      "INSERT INTO email_accounts (added_by, name, email_address, mail_node) VALUES ($1, 'g', 'g@gmail.example', false) RETURNING id", [ADMIN],
    );
    const result = await cli(['mailbox', 'show', row.id, '--json']);
    expect(result.code).toBe(1);
    expect(result.json()).toEqual({ error: 'Only a mailbox on the mail node waits before it is deleted: remove this one directly', code: 'not_mail_node' });
    expect((await cli(['mailbox', 'show', 'g@gmail.example'])).err).toContain('(mailbox_not_found)');
  });

  it('asks to delete a mailbox with the typed address and a reason, then cancels it, both journaled', async () => {
    const id = await addAccount('old@example.com');
    const mismatch = await cli(['mailbox', 'delete', 'old@example.com', '--reason', 'Left', '--confirm-address', 'olt@example.com']);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('(confirmation_mismatch)');
    expect((await cli(['mailbox', 'delete', 'old@example.com', '--reason', '  ', '--confirm-address', 'old@example.com'])).err)
      .toContain('(deletion_reason_required)');

    const asked = await cli(['mailbox', 'delete', id, '--reason', 'Left the company'], { interactive: true, answers: ['OLD@example.com'] });
    expect(asked.code, asked.err).toBe(0);
    const row = await account('old@example.com');
    expect(row.delete_after).toBeTruthy();
    expect(row).toMatchObject({ deletion_reason: 'Left the company', deletion_requested_by: null });
    expect((await cli(['mailbox', 'delete', id, '--reason', 'again', '--confirm-address', 'old@example.com'])).err)
      .toContain('(deletion_already_requested)');

    expect((await cli(['mailbox', 'cancel-deletion', 'old@example.com'])).code).toBe(0);
    expect((await account('old@example.com')).delete_after).toBeNull();
    const entries = await auditSettled(2);
    expect(entries.map((e) => [e.action, e.actor_email, e.details.via, e.details.reason])).toEqual([
      ['mailbox.deletion_requested', 'cli', 'cli', 'Left the company'],
      ['mailbox.deletion_cancelled', 'cli', 'cli', 'Left the company'],
    ]);
    expect((await cli(['mailbox', 'cancel-deletion', 'old@example.com'])).err).toContain('(deletion_not_requested)');
  });

  it('refuses a mailbox on another mail host, as the panel does', async () => {
    await addAccount('moved@example.com', { host: 'old-node.example.com' });
    const result = await cli(['mailbox', 'delete', 'moved@example.com', '--reason', 'x', '--confirm-address', 'moved@example.com']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('(mail_node_host_mismatch)');
  });

  it('reports the mail node\'s failure with exit 3', async () => {
    mc.node.down = true;
    const result = await cli(['mailbox', 'list', '--json']);
    expect(result.code).toBe(3);
    expect(result.json().code).toBe('mail_node_unreachable');
  });
});

describe('mailexpert domain', () => {
  it('lists the domains with their onboarding state and shows one with its steps', async () => {
    const list = await cli(['domain', 'list', '--json']);
    expect(list.code, list.err).toBe(0);
    expect(list.json().domains.map((d) => [d.domain, d.state, d.onNode])).toEqual([['example.com', 'ready', true], ['new.example', 'dns_ok', true]]);
    await db.query(`UPDATE mail_node_domains SET steps = '{"node_configured":{"at":"2026-10-01T10:00:00Z","email":"admin@example.com"}}' WHERE domain = 'new.example'`);
    const shown = await cli(['domain', 'show', 'new.example']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toMatch(/state:\s+dns_ok/);
    expect(shown.out).toMatch(/node_configured\s+2026-10-01 10:00Z\s+admin@example.com/);
    expect((await cli(['domain', 'show', 'nowhere.example'])).err).toContain('(domain_not_found)');
  });

  it('restarts the onboarding after confirmation, applies the node settings again and journals both as "cli"', async () => {
    await db.query(`UPDATE mail_node_domains SET steps = '{"node_configured":{"at":"2026-10-01T10:00:00Z"}}' WHERE domain = 'new.example'`);
    expect((await cli(['domain', 'restart', 'new.example'])).code).toBe(2);
    expect((await domainRow('new.example')).state).toBe('dns_ok');
    const result = await cli(['domain', 'restart', 'new.example', '--yes', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, domain: 'new.example', state: 'node_created' });
    expect(await domainRow('new.example')).toMatchObject({ state: 'node_created', steps: {} });
    expect(mc.writes.some((w) => w.path === 'edit/domain' && w.body.items[0] === 'new.example')).toBe(true);
    const entries = await auditSettled(2);
    expect(entries.find((e) => e.action === 'mail_node.domain_state_changed')).toMatchObject({
      actor_email: 'cli', details: { domain: 'new.example', from: 'dns_ok', to: 'node_created', how: 'restarted', via: 'cli' },
    });
    expect(entries.find((e) => e.action === 'mail_node.applied')).toMatchObject({ actor_email: 'cli', details: { via: 'cli', scope: 'domain' } });
    await db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('fresh.example', 'node_created', 'created')");
    expect((await cli(['domain', 'restart', 'fresh.example', '--yes'])).err).toContain('(domain_nothing_to_restart)');
  });

  describe('with the fake tenant driver', () => {
    let driver;
    beforeEach(async () => {
      driver = createFakeTenantDriver();
      setTenantDriver(driver);
      await saveEopSettings(TENANT);
    });

    it('queues the domain\'s tenant steps and waits for the backend to run them', async () => {
      const queued = await cli(['domain', 'sync', 'new.example', '--json']);
      expect(queued.code, queued.err).toBe(0);
      expect(queued.json()).toMatchObject({ created: true, job: { kind: DOMAIN_SYNC_KIND, status: 'queued' } });
      const waited = await cli(['domain', 'sync', 'new.example', '--wait', '--json']);
      expect(waited.code, waited.err).toBe(0);
      expect(waited.json().job.status).toBe('done');
      expect((await domainRow('new.example')).tenant_sync).toBeTruthy();
      expect((await cli(['domain', 'sync', 'nowhere.example'])).err).toContain('(domain_not_found)');
    });

    it('holds a domain on Internal Relay or lets it become Authoritative, journaled', async () => {
      await db.query("UPDATE mail_node_domains SET hold_internal_relay = true WHERE domain = 'example.com'");
      expect((await cli(['domain', 'allow-authoritative', 'example.com'])).code).toBe(2);
      const allowed = await cli(['domain', 'allow-authoritative', 'example.com', '--yes', '--json']);
      expect(allowed.code, allowed.err).toBe(0);
      expect(allowed.json()).toEqual({ domain: 'example.com', holdInternalRelay: false });
      expect((await domainRow('example.com')).hold_internal_relay).toBe(false);
      // Released: a run is queued that may make it Authoritative.
      expect((await db.query('SELECT 1 FROM jobs WHERE kind = $1', [DOMAIN_SYNC_KIND])).rows).toHaveLength(1);
      expect((await cli(['domain', 'hold', 'example.com'])).code).toBe(0);
      expect((await domainRow('example.com')).hold_internal_relay).toBe(true);
      const entries = (await auditSettled(2)).filter((e) => e.action === 'tenant.domain_hold_changed');
      expect(entries.map((e) => [e.details.hold, e.actor_email, e.details.via])).toEqual([[false, 'cli', 'cli'], [true, 'cli', 'cli']]);
      await db.query("UPDATE mail_node_domains SET state = 'authoritative' WHERE domain = 'example.com'");
      expect((await cli(['domain', 'hold', 'example.com'])).err).toContain('(domain_authoritative)');
    });

    it('approves the move to Internal Relay only for a domain waiting for it', async () => {
      expect((await cli(['domain', 'internal-relay', 'example.com', '--yes'])).err).toContain('(internal_relay_not_needed)');
      await db.query(`UPDATE mail_node_domains SET tenant_sync = '{"acceptedDomain":{"ok":true,"code":"authoritative_in_tenant"}}' WHERE domain = 'example.com'`);
      const result = await cli(['domain', 'internal-relay', 'example.com', '--yes', '--as', 'admin@example.com']);
      expect(result.code, result.err).toBe(0);
      expect((await domainRow('example.com')).internal_relay_approved_at).toBeTruthy();
      const { rows: [job] } = await db.query('SELECT created_by FROM jobs WHERE kind = $1', [DOMAIN_SYNC_KIND]);
      expect(job.created_by).toBe(ADMIN);
      const [entry] = (await auditSettled(1)).filter((e) => e.action === 'tenant.internal_relay_approved');
      expect(entry).toMatchObject({ actor_user_id: ADMIN, details: { domain: 'example.com', via: 'cli' } });
    });

    it('approves the removal of held alias contacts after showing them', async () => {
      expect((await cli(['domain', 'approve-alias-removal', 'example.com', '--yes'])).err).toContain('(alias_contacts_not_held)');
      await db.query(`UPDATE mail_node_domains SET state = 'authoritative',
        tenant_sync = '{"mirror":{"ok":true,"heldAliasContacts":["info@example.com"]}}' WHERE domain = 'example.com'`);
      const declined = await cli(['domain', 'approve-alias-removal', 'example.com'], { interactive: true, answers: ['n'] });
      expect(declined.code).toBe(1);
      expect(declined.err).toContain('info@example.com');
      expect((await domainRow('example.com')).alias_contacts_approved_at).toBeNull();
      const approved = await cli(['domain', 'approve-alias-removal', 'example.com'], { interactive: true, answers: ['yes'] });
      expect(approved.code, approved.err).toBe(0);
      expect((await domainRow('example.com')).alias_contacts_approved_at).toBeTruthy();
      const [entry] = (await auditSettled(1)).filter((e) => e.action === 'tenant.alias_contacts_removal_approved');
      expect(entry).toMatchObject({ actor_email: 'cli', details: { domain: 'example.com', addresses: ['info@example.com'], via: 'cli' } });
    });

    it('approves only the alias contacts it showed: a run that changed them meanwhile approves nothing', async () => {
      await db.query(`UPDATE mail_node_domains SET state = 'authoritative',
        tenant_sync = '{"mirror":{"ok":true,"heldAliasContacts":["info@example.com"]}}' WHERE domain = 'example.com'`);
      // While the administrator reads the question, a tenant run holds another alias too.
      const ask = async () => {
        await db.query(`UPDATE mail_node_domains
          SET tenant_sync = '{"mirror":{"ok":true,"heldAliasContacts":["info@example.com","sales@example.com"]}}' WHERE domain = 'example.com'`);
        return 'y';
      };
      const result = await cli(['domain', 'approve-alias-removal', 'example.com'], { interactive: true, ask });
      expect(result.code).toBe(1);
      expect(result.err).toContain('(alias_contacts_changed)');
      expect((await domainRow('example.com')).alias_contacts_approved_at).toBeNull();
      expect((await db.query('SELECT 1 FROM jobs WHERE kind = $1', [DOMAIN_SYNC_KIND])).rows).toEqual([]);
    });

    it('keeps the queued tenant run and the journal when the CLI closes its pool right after the answer', async () => {
      await cli(['mailbox', 'create', 'late@example.com']);
      await db.query(`UPDATE mail_node_domains SET steps = '{"node_configured":{"at":"2026-10-01T10:00:00Z"}}' WHERE domain = 'new.example'`);
      await cli(['domain', 'restart', 'new.example', '--yes']);
      // What main() does: finish(), then exit. Nothing after it may need the pool.
      await finish();
      expect(dbState.closed).toBe(true);
      const { rows: jobs } = await db.query(
        "SELECT payload->>'domain' AS domain, payload->>'via' AS via, max_attempts FROM jobs WHERE kind = $1 ORDER BY id", [DOMAIN_SYNC_KIND],
      );
      expect(jobs).toEqual([
        { domain: 'example.com', via: 'cli', max_attempts: 6 },
        { domain: 'new.example', via: 'cli', max_attempts: 6 },
      ]);
      expect((await audit()).map((e) => e.action)).toEqual(expect.arrayContaining(['mailbox.added', 'mail_node.domain_state_changed']));
    });
  });

  it('refuses the tenant actions without a tenant driver', async () => {
    const result = await cli(['domain', 'sync', 'example.com', '--json']);
    expect(result.code).toBe(1);
    expect(result.json().code).toBe('tenant_driver_missing');
  });
});
