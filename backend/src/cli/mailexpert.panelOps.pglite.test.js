import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's operations groups (invite, system-email, audit, account, mailbox oauth-reset) end
// to end: the real services the admin and accounts routes use, on PGlite with every migration. The
// SMTP transport and DNS are stubbed. Connecting a mailbox is the backend's: the CLI queues an
// admin_effects job, which the test runs with recording hooks.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ef'.repeat(32);
  return { db: null };
});
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));
const hostState = vi.hoisted(() => ({ refuse: new Set() }));
vi.mock('../services/hostValidation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  validateHost: vi.fn(async (host) => (hostState.refuse.has(host) ? 'Host resolves to a private address' : null)),
  resolveForConnection: vi.fn(async (host) => ({ host: '192.0.2.10', servername: host })),
}));
const smtp = vi.hoisted(() => ({ verify: null, sendMail: null }));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSmtpTransport: vi.fn(() => ({ verify: smtp.verify, sendMail: smtp.sendMail })),
  createAccountSmtpTransport: vi.fn(),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { ADMIN_EFFECTS_JOB_KIND, registerAdminEffectsJobKind } = await import('../services/admin/adminEffects.js');
const { decrypt } = await import('../services/encryption.js');
const { invalidateConnectionPolicyCache } = await import('../services/connectionPolicy.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '66000000-0000-4000-8000-000000000001';
const USER = '66000000-0000-4000-8000-000000000002';
const PASSWORD = 'imap-password-0123456789';
let db;
let hooks;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function cli(argv, { stdin = '', interactive = false, answer = '' } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive, ask: async () => answer, readStdin: async () => stdin, stdinIsTerminal: false,
    sleep: async () => {}, now: Date.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, account_id, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}
const effectJobs = async () => (await db.query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id', [ADMIN_EFFECTS_JOB_KIND])).rows;
const account = async (id) => (await db.query('SELECT * FROM email_accounts WHERE id = $1', [id])).rows[0];
const setting = async (key) => (await db.query('SELECT value FROM system_settings WHERE key = $1', [key])).rows[0]?.value;
async function runEffects() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}
async function addAccount(email, extra = {}) {
  const row = { name: email, email_address: email, imap_host: 'imap.example.com', imap_port: 993, smtp_host: 'smtp.example.com', smtp_port: 587, ...extra };
  const keys = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO email_accounts (added_by, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [ADMIN, ...keys.map((key) => row[key])],
  );
  return rows[0].id;
}
async function policy(values) {
  for (const [key, value] of Object.entries(values)) {
    await db.query(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, String(value)]);
  }
  invalidateConnectionPolicyCache();
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  hooks = { reconnectAccount: vi.fn(async () => {}), runRules: vi.fn(async () => {}) };
  registerAdminEffectsJobKind(hooks);
}, 120000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('APP_URL', 'https://panel.example.com');
  smtp.verify = vi.fn(async () => true);
  smtp.sendMail = vi.fn(async () => ({}));
  hostState.refuse.clear();
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM invites; DELETE FROM auth_events;
    DELETE FROM email_accounts; DELETE FROM users;
    DELETE FROM system_settings WHERE key IN ('system_email_config', 'allow_private_hosts', 'allow_nonstandard_ports');`);
  invalidateConnectionPolicyCache();
  await db.query(`INSERT INTO users (id, username, email, password_hash, is_admin) VALUES
    ($1, 'admin', 'admin@example.com', 'x', true), ($2, 'user', 'user@example.com', 'x', false)`, [ADMIN, USER]);
  hooks.reconnectAccount.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('mailexpert invite', () => {
  it('needs an administrator with --as: an invite has a creator', async () => {
    expect(await cli(['invite', 'create', 'new@example.com'])).toMatchObject({ code: 2, err: expect.stringContaining('--as') });
    expect((await db.query('SELECT * FROM invites')).rows).toEqual([]);
  });

  it('creates an invite, sends it through the system SMTP and lists it without the token', async () => {
    await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'relay', '--password-stdin'], { stdin: 'smtp-pass\n' });
    const result = await cli(['invite', 'create', 'New@Example.com', '--as', 'admin@example.com', '--json']);
    expect(result.code).toBe(0);
    const answer = result.json();
    expect(answer).toMatchObject({ ok: true, emailSent: true, emailError: null });
    expect(answer.inviteUrl).toMatch(/^https:\/\/panel\.example\.com\/register\?invite=[0-9a-f]{64}$/);
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'New@Example.com', from: 'MailExpert <relay>' }));
    const [row] = (await db.query('SELECT * FROM invites')).rows;
    expect(row).toMatchObject({ email: 'new@example.com', created_by: ADMIN });

    const list = await cli(['invite', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/new@example\.com/);
    expect(list.out).not.toContain(row.token);
    expect((await cli(['invite', 'list', '--json'])).json()).toMatchObject({ total: 1, invites: [{ id: row.id, email: 'new@example.com' }] });
  });

  it('refuses an invalid email and says when no letter went out', async () => {
    expect(await cli(['invite', 'create', 'nope', '--as', 'admin@example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(email_invalid)') });
    const result = await cli(['invite', 'create', 'new@example.com', '--as', 'admin@example.com']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/not sent/);
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it('revokes an invite after confirmation', async () => {
    await cli(['invite', 'create', 'new@example.com', '--as', 'admin@example.com']);
    const [{ id }] = (await db.query('SELECT id FROM invites')).rows;
    expect(await cli(['invite', 'revoke', id])).toMatchObject({ code: 2, err: expect.stringContaining('confirmation_required') });
    expect((await cli(['invite', 'revoke', id, '--yes'])).code).toBe(0);
    expect((await db.query('SELECT id FROM invites')).rows).toEqual([]);
    expect(await cli(['invite', 'revoke', id, '--yes'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_found)') });
    expect((await cli(['invite', 'revoke', 'not-a-uuid', '--yes'])).code).toBe(2);
  });
});

describe('mailexpert system-email', () => {
  it('saves the config with the password from stdin only, never printing it', async () => {
    expect((await cli(['system-email', 'show', '--json'])).json()).toEqual({ config: null });
    const set = await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'relay', '--port', '465', '--from-email', 'noreply@example.com', '--password-stdin'], { stdin: 'smtp-pass\n' });
    expect(set.code).toBe(0);
    const stored = JSON.parse(await setting('system_email_config'));
    expect(stored).toMatchObject({ host: 'smtp.example.com', port: 465, tls: 'STARTTLS', user: 'relay', fromName: 'MailExpert', fromEmail: 'noreply@example.com' });
    expect(decrypt(stored.pass)).toBe('smtp-pass');

    const show = await cli(['system-email', 'show']);
    expect(show.out).toMatch(/smtp\.example\.com/);
    expect(show.out).not.toContain('smtp-pass');
    expect((await cli(['system-email', 'show', '--json'])).json().config).toMatchObject({ host: 'smtp.example.com', pass: '••••••••' });

    // A change without --password-stdin keeps the password and the other fields.
    expect((await cli(['system-email', 'set', '--from-name', 'Panel'])).code).toBe(0);
    const after = JSON.parse(await setting('system_email_config'));
    expect(after).toMatchObject({ host: 'smtp.example.com', port: 465, fromName: 'Panel', fromEmail: 'noreply@example.com' });
    expect(decrypt(after.pass)).toBe('smtp-pass');
  });

  it('keeps the spaces around a password, dropping only the line end', async () => {
    await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'relay', '--password-stdin'], { stdin: '  pass word \r\n' });
    expect(decrypt(JSON.parse(await setting('system_email_config')).pass)).toBe('  pass word ');
  });

  it('refuses what the screen refuses', async () => {
    expect(await cli(['system-email', 'set', '--host', 'smtp.example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(fields_required)') });
    hostState.refuse.add('10.0.0.5');
    expect(await cli(['system-email', 'set', '--host', '10.0.0.5', '--user', 'u'])).toMatchObject({ code: 1, err: expect.stringContaining('(host_refused)') });
    expect(await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'u', '--password-stdin'], { stdin: '' }))
      .toMatchObject({ code: 1, err: expect.stringContaining('(password_missing)') });
    expect((await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'u', '--port', 'abc'])).code).toBe(2);
  });

  it('refuses a plain-text test before connecting while insecure TLS is not allowed', async () => {
    await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'relay', '--port', '25', '--tls', 'none', '--password-stdin'], { stdin: 'smtp-pass' });
    expect(await cli(['system-email', 'test'])).toMatchObject({
      code: 1, err: expect.stringContaining('(insecure_tls_not_allowed)'),
    });
    expect(smtp.verify).not.toHaveBeenCalled();
  });

  it('tests the stored server without sending a letter, and removes it after confirmation', async () => {
    expect(await cli(['system-email', 'test'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_configured)') });
    await cli(['system-email', 'set', '--host', 'smtp.example.com', '--user', 'relay', '--password-stdin'], { stdin: 'smtp-pass' });
    expect((await cli(['system-email', 'test'])).code).toBe(0);
    expect(smtp.verify).toHaveBeenCalledWith('relay');
    expect(smtp.sendMail).not.toHaveBeenCalled();
    smtp.verify = vi.fn(async () => { throw new Error('535 authentication failed'); });
    expect(await cli(['system-email', 'test'])).toMatchObject({ code: 1, err: expect.stringContaining('535 authentication failed (smtp_failed)') });

    expect((await cli(['system-email', 'remove'])).code).toBe(2);
    expect((await cli(['system-email', 'remove', '--yes'])).code).toBe(0);
    expect(await setting('system_email_config')).toBeUndefined();
  });
});

describe('mailexpert audit', () => {
  it('lists journal entries with the API\'s filters, newest first', async () => {
    const mailbox = await addAccount('box@example.com');
    await db.query(`INSERT INTO mailbox_audit_log (occurred_at, actor_user_id, actor_email, account_id, account_email, action, details) VALUES
      ('2026-10-01T10:00:00Z', $1, 'admin@example.com', $2, 'box@example.com', 'mailbox.added', '{}'),
      ('2026-10-02T10:00:00Z', NULL, 'cli', NULL, NULL, 'user.added', '{"via":"cli"}'),
      ('2026-10-03T10:00:00Z', $1, 'admin@example.com', $2, 'box@example.com', 'mailbox.connection_changed', '{"fields":["imap_host"]}')`, [ADMIN, mailbox]);

    const all = await cli(['audit', 'list', '--json']);
    expect(all.json().entries.map((e) => e.action)).toEqual(['mailbox.connection_changed', 'user.added', 'mailbox.added']);
    expect((await cli(['audit', 'list', '--action', 'user.added', '--json'])).json().entries).toHaveLength(1);
    expect((await cli(['audit', 'list', '--since', '2026-10-02T00:00:00Z', '--json'])).json().entries).toHaveLength(2);
    expect((await cli(['audit', 'list', '--until', '2026-10-02T00:00:00Z', '--json'])).json().entries).toHaveLength(1);
    expect((await cli(['audit', 'list', '--account', 'box@example.com', '--json'])).json().entries).toHaveLength(2);
    expect((await cli(['audit', 'list', '--user', 'admin@example.com', '--json'])).json().entries).toHaveLength(2);

    const page = await cli(['audit', 'list', '--limit', '1', '--json']);
    expect(page.json()).toMatchObject({ entries: [{ action: 'mailbox.connection_changed' }], nextCursor: expect.any(String) });
    const next = await cli(['audit', 'list', '--limit', '1', '--before', page.json().nextCursor, '--json']);
    expect(next.json().entries.map((e) => e.action)).toEqual(['user.added']);

    const human = await cli(['audit', 'list', '--limit', '2']);
    expect(human.out).toMatch(/mailbox\.connection_changed/);
    expect(human.out).toMatch(/--before /);
  });

  it('refuses an unknown action or a bad time as usage errors', async () => {
    expect((await cli(['audit', 'list', '--action', 'nope'])).code).toBe(2);
    expect((await cli(['audit', 'list', '--since', 'yesterday-ish'])).code).toBe(2);
    expect((await cli(['audit', 'list', '--limit', '0'])).code).toBe(2);
    expect(await cli(['audit', 'list', '--user', 'nobody@example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_found)') });
  });

  it('lists sign-in events', async () => {
    await db.query(`INSERT INTO auth_events (event_type, username, user_id, ip, success) VALUES
      ('login', 'admin', $1, '192.0.2.1', true), ('login', 'user', $2, '192.0.2.2', false)`, [ADMIN, USER]);
    const result = await cli(['audit', 'auth-events', '--json']);
    expect(result.json()).toMatchObject({ total: 2 });
    expect(result.json().events).toHaveLength(2);
    expect((await cli(['audit', 'auth-events'])).out).toMatch(/192\.0\.2\.2/);
  });
});

describe('mailexpert mailbox oauth-reset', () => {
  it('forgets an OAuth mailbox\'s bound account, journaled as the CLI', async () => {
    const id = await addAccount('owner@gmail.example', { oauth_provider: 'google', oauth_subject: 'sub-1' });
    expect((await cli(['mailbox', 'oauth-reset', 'owner@gmail.example'])).code).toBe(2);
    expect((await cli(['mailbox', 'oauth-reset', 'Owner@Gmail.example', '--yes'])).code).toBe(0);
    expect((await account(id)).oauth_subject).toBeNull();
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ action: 'mailbox.oauth_subject_reset', account_id: id, actor_email: 'cli', details: { oauthProvider: 'google', via: 'cli' } });
  });

  it('refuses a mailbox that is not an OAuth one', async () => {
    await addAccount('plain@example.com');
    expect(await cli(['mailbox', 'oauth-reset', 'plain@example.com', '--yes'])).toMatchObject({ code: 1, err: expect.stringContaining('(oauth_mailbox_not_found)') });
    expect(await cli(['mailbox', 'oauth-reset', 'none@example.com', '--yes'])).toMatchObject({ code: 1, err: expect.stringContaining('(account_not_found)') });
  });
});

describe('mailexpert account', () => {
  it('creates a manual IMAP mailbox with the password from stdin, and the backend connects it', async () => {
    const result = await cli(['account', 'create', 'team@example.com', '--imap-host', 'imap.example.com', '--smtp-host', 'smtp.example.com', '--as', 'admin@example.com', '--json'],
      { stdin: `${PASSWORD}\n` });
    expect(result.code).toBe(0);
    const { account: created, job } = result.json();
    expect(created).toMatchObject({ email_address: 'team@example.com', name: 'team@example.com', imap_port: 993, smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: 'team@example.com' });
    expect(JSON.stringify(result.json())).not.toContain(PASSWORD);
    const row = await account(created.id);
    expect(decrypt(row.auth_pass)).toBe(PASSWORD);
    expect(row).toMatchObject({ added_by: ADMIN, imap_tls: true, mail_node: false });
    expect(job).toMatchObject({ kind: ADMIN_EFFECTS_JOB_KIND });
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ action: 'mailbox.added', actor_user_id: ADMIN, details: { protocol: 'imap', via: 'cli' } });
    await runEffects();
    expect(hooks.reconnectAccount).toHaveBeenCalledWith(created.id);
  });

  it('create --smtp-login stores a separate SMTP login that "create --help" offers; without it SMTP uses the IMAP login', async () => {
    const help = await cli(['account', 'create', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--smtp-login');
    const args = ['account', 'create', 'team@example.com', '--imap-host', 'imap.example.com', '--smtp-host', 'smtp.example.com', '--json'];
    const separate = await cli([...args, '--smtp-login', 'smtp-user'], { stdin: PASSWORD });
    expect(separate.code).toBe(0);
    expect(await account(separate.json().account.id)).toMatchObject({ auth_user: 'team@example.com', smtp_auth_user: 'smtp-user' });
    await db.query('DELETE FROM email_accounts');
    const plain = await cli(args, { stdin: PASSWORD });
    expect(await account(plain.json().account.id)).toMatchObject({ smtp_auth_user: null });
  });

  it('keeps the route\'s checks: hosts, ports, control characters, a password', async () => {
    const create = (args, stdin = PASSWORD) => cli(['account', 'create', 'team@example.com', '--imap-host', 'imap.example.com', '--smtp-host', 'smtp.example.com', ...args], { stdin });
    hostState.refuse.add('10.0.0.5');
    expect(await cli(['account', 'create', 'team@example.com', '--imap-host', '10.0.0.5', '--smtp-host', 'smtp.example.com'], { stdin: PASSWORD }))
      .toMatchObject({ code: 1, err: expect.stringContaining('IMAP: Host resolves to a private address (servers_refused)') });
    expect(await create(['--imap-port', '1143'])).toMatchObject({ code: 1, err: expect.stringContaining('IMAP: Port 1143 is not allowed') });
    expect(await create(['--name', 'Team\r\nBcc: x'])).toMatchObject({ code: 1, err: expect.stringContaining('(name_email_control_chars)') });
    expect(await create([], '')).toMatchObject({ code: 1, err: expect.stringContaining('(password_missing)') });
    expect(await create([], '\n')).toMatchObject({ code: 1, err: expect.stringContaining('(password_missing)') });
    expect((await create(['--smtp-tls', 'maybe'])).code).toBe(2);
    expect((await db.query('SELECT id FROM email_accounts')).rows).toEqual([]);

    await policy({ allow_nonstandard_ports: true });
    expect((await create(['--imap-port', '1143'])).code).toBe(0);
  });

  it('lists mailboxes, or those a user added, without secrets', async () => {
    await addAccount('a@example.com', { auth_pass: 'enc-secret' });
    await db.query("INSERT INTO email_accounts (added_by, name, email_address) VALUES ($1, 'b', 'b@example.com')", [USER]);
    const all = await cli(['account', 'list', '--json']);
    expect(all.json().accounts.map((a) => a.email_address).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(JSON.stringify(all.json())).not.toContain('enc-secret');
    const mine = await cli(['account', 'list', '--user', 'user@example.com', '--json']);
    expect(mine.json().accounts.map((a) => a.email_address)).toEqual(['b@example.com']);
    expect((await cli(['account', 'list'])).out).toMatch(/a@example\.com/);
  });

  it('changes the connection with the route\'s checks and journal, and asks the backend to reconnect', async () => {
    const id = await addAccount('team@example.com', { auth_user: 'team@example.com', protocol: 'imap' });
    const result = await cli(['account', 'set-connection', 'team@example.com', '--imap-host', 'imap2.example.com', '--imap-port', '143', '--password-stdin', '--json'], { stdin: 'new-pass' });
    expect(result.code).toBe(0);
    const row = await account(id);
    expect(row).toMatchObject({ imap_host: 'imap2.example.com', imap_port: 143, imap_tls: false });
    expect(decrypt(row.auth_pass)).toBe('new-pass');
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'imap_port', 'imap_tls', 'auth_pass'], via: 'cli' } });
    await runEffects();
    expect(hooks.reconnectAccount).toHaveBeenCalledWith(id);

    // SMTP-only changes need no reconnect.
    hooks.reconnectAccount.mockClear();
    const smtpOnly = await cli(['account', 'set-connection', id, '--smtp-port', '465', '--smtp-tls', 'SSL', '--smtp-password-stdin', '--json'], { stdin: ' smtp pass \n' });
    expect(smtpOnly.json().job).toBeNull();
    expect(decrypt((await account(id)).smtp_auth_pass)).toBe(' smtp pass ');

    expect((await cli(['account', 'set-connection', id])).code).toBe(2);
    expect((await cli(['account', 'set-connection', id, '--password-stdin', '--smtp-password-stdin'])).code).toBe(2);
    expect(await cli(['account', 'set-connection', id, '--smtp-port', '2525'])).toMatchObject({ code: 1, err: expect.stringContaining('SMTP: Port 2525 is not allowed') });
  });

  it('refuses the servers of a mail node mailbox', async () => {
    const id = await addAccount('node@example.com', { mail_node: true });
    expect(await cli(['account', 'set-connection', id, '--imap-host', 'elsewhere.example.com']))
      .toMatchObject({ code: 1, err: expect.stringContaining('(mail_node_connection_locked)') });
    expect((await account(id)).imap_host).toBe('imap.example.com');
    expect(await effectJobs()).toEqual([]);
  });
});
