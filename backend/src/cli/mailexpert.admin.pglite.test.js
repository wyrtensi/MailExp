import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's admin commands (user, settings, sso, integration) end to end: the real services
// the admin routes use, on PGlite with every migration. What a change asks of the backend's process
// (sign-outs, reloads, the Access sync) is queued as an admin_effects job; the test runs the job
// worker with recording hooks, as the backend would with its own.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  return { db: null };
});
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));
// The issuer's host check resolves DNS; here every host is allowed.
vi.mock('../services/hostValidation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  validateHost: vi.fn(async () => null),
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { ADMIN_EFFECTS_JOB_KIND, registerAdminEffectsJobKind } = await import('../services/admin/adminEffects.js');
const { decrypt } = await import('../services/encryption.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '65000000-0000-4000-8000-000000000001';
const OTHER_ADMIN = '65000000-0000-4000-8000-000000000002';
const USER = '65000000-0000-4000-8000-000000000003';
const SECRET = 'oidc-client-secret-0123456789';
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

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
async function auditSettled(count) {
  for (let i = 0; i < 50; i += 1) {
    if ((await audit()).length >= count) return audit();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return audit();
}
const userRow = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const effectJobs = async () => (await db.query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id', [ADMIN_EFFECTS_JOB_KIND])).rows;
const setting = async (key) => (await db.query('SELECT value FROM system_settings WHERE key = $1', [key])).rows[0]?.value;

// The backend's worker applying the queued effects with recording hooks.
async function runEffects() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  hooks = {
    signOutUser: vi.fn(async () => {}),
    onUserDelete: vi.fn(async () => {}),
    requestAccessSync: vi.fn(),
    reload: {
      auth_limits: vi.fn(), sync_intervals: vi.fn(), categorization: vi.fn(), connection_policy: vi.fn(), microsoft: vi.fn(),
    },
  };
  registerAdminEffectsJobKind(hooks);
}, 120000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
  await db.exec(`DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM user_identities; DELETE FROM oidc_providers;
    DELETE FROM users; DELETE FROM integration_config WHERE provider = 'microsoft';
    DELETE FROM system_settings WHERE key IN ('internal_auth_disabled', 'auth_max_attempts', 'mfa_enforcement', 'sync_interval_sec', 'registration_open');`);
  await db.query(`INSERT INTO users (id, username, email, password_hash, is_admin, totp_enabled, totp_secret) VALUES
    ($1, 'admin', 'admin@example.com', 'x', true, false, NULL),
    ($2, 'user', 'user@example.com', 'x', false, true, 'totp-secret')`, [ADMIN, USER]);
  for (const fn of [hooks.signOutUser, hooks.onUserDelete, hooks.requestAccessSync, ...Object.values(hooks.reload)]) fn.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('mailexpert user', () => {
  it('lists and shows users as the API answers them', async () => {
    const list = await cli(['user', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/admin@example\.com/);
    expect(list.out).toMatch(/user@example\.com/);
    expect((await cli(['user', 'list', '--json'])).json()).toMatchObject({ total: 2, users: [{ id: ADMIN, isAdmin: true }, { id: USER, totpEnabled: true }] });

    const show = await cli(['user', 'show', 'USER@example.com', '--json']);
    expect(show.json().user).toMatchObject({ id: USER, email: 'user@example.com', isAdmin: false });
    expect(await cli(['user', 'show', 'nobody@example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_found)') });
  });

  it('approves an email, as an admin with --admin, journaled as the CLI', async () => {
    const result = await cli(['user', 'create', 'New@Example.com', '--admin', '--json']);
    expect(result.code).toBe(0);
    const { user, job } = result.json();
    expect(user).toMatchObject({ email: 'new@example.com', isAdmin: true });
    expect(job).toMatchObject({ kind: ADMIN_EFFECTS_JOB_KIND });
    const entries = await auditSettled(2);
    expect(entries.map((e) => e.action)).toEqual(['user.added', 'user.admin_changed']);
    expect(entries[0]).toMatchObject({ actor_user_id: null, actor_email: 'cli', details: { email: 'new@example.com', via: 'cli' } });

    await runEffects();
    expect(hooks.requestAccessSync).toHaveBeenCalledWith('user_added');
    expect(await cli(['user', 'create', 'new@example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(user_exists)') });
    expect(await cli(['user', 'create', 'not-an-email'])).toMatchObject({ code: 1, err: expect.stringContaining('(email_invalid)') });
  });

  it('keeps the last active admin', async () => {
    for (const args of [['--no-admin'], ['--disable'], ['--email', '']]) {
      expect(await cli(['user', 'set', 'admin@example.com', ...args])).toMatchObject({ code: 1, err: expect.stringContaining('(last_admin)') });
    }
    expect(await cli(['user', 'delete', 'admin@example.com', '--yes'])).toMatchObject({ code: 1, err: expect.stringContaining('(last_admin)') });
    expect((await userRow(ADMIN)).is_admin).toBe(true);
    expect(await effectJobs()).toEqual([]);
  });

  it('refuses changing a bootstrap admin', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'user@example.com');
    expect(await cli(['user', 'set', 'user@example.com', '--disable'])).toMatchObject({ code: 1, err: expect.stringContaining('(bootstrap_admin)') });
  });

  it('disables a user and signs them out through the backend', async () => {
    const result = await cli(['user', 'set', 'user@example.com', '--disable', '--json']);
    expect(result.code).toBe(0);
    expect(result.json().user.disabledAt).toEqual(expect.any(String));
    expect((await userRow(USER)).disabled_at).not.toBeNull();
    expect(hooks.signOutUser).not.toHaveBeenCalled();
    await runEffects();
    expect(hooks.signOutUser).toHaveBeenCalledWith(USER);
    expect(hooks.requestAccessSync).toHaveBeenCalledWith('user_changed');
    expect((await auditSettled(1)).map((e) => e.action)).toEqual(['user.disabled']);
  });

  it('replaces an email, refusing one taken, and signs the user out', async () => {
    await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'other', 'other@example.com', 'x', true)", [OTHER_ADMIN]);
    expect(await cli(['user', 'set', 'user@example.com', '--email', 'other@example.com'])).toMatchObject({ code: 1, err: expect.stringContaining('(email_taken)') });
    const result = await cli(['user', 'set', 'user@example.com', '--email', 'renamed@example.com']);
    expect(result.code).toBe(0);
    expect((await userRow(USER)).email).toBe('renamed@example.com');
    await runEffects();
    expect(hooks.signOutUser).toHaveBeenCalledWith(USER);
  });

  it('refuses contradicting or missing flags as usage errors', async () => {
    expect((await cli(['user', 'set', 'user@example.com', '--admin', '--no-admin'])).code).toBe(2);
    expect((await cli(['user', 'set', 'user@example.com', '--disable', '--enable'])).code).toBe(2);
    expect((await cli(['user', 'set', 'user@example.com'])).code).toBe(2);
  });

  it('refuses the --as administrator changing their own account', async () => {
    expect(await cli(['user', 'set', 'admin@example.com', '--disable', '--as', 'admin@example.com']))
      .toMatchObject({ code: 1, err: expect.stringContaining('(self_change)') });
  });

  it('deletes a user after confirmation, then the backend signs out and cleans up', async () => {
    expect(await cli(['user', 'delete', 'user@example.com'])).toMatchObject({ code: 2, err: expect.stringContaining('confirmation_required') });
    expect(await userRow(USER)).toBeTruthy();
    const result = await cli(['user', 'delete', 'user@example.com', '--yes', '--as', 'admin@example.com']);
    expect(result.code).toBe(0);
    expect(await userRow(USER)).toBeUndefined();
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ action: 'user.deleted', actor_user_id: ADMIN, actor_email: 'admin@example.com', details: { userId: USER, via: 'cli' } });
    await runEffects();
    expect(hooks.signOutUser).toHaveBeenCalledWith(USER);
    expect(hooks.onUserDelete).toHaveBeenCalledWith(USER);
    expect(hooks.requestAccessSync).toHaveBeenCalledWith('user_deleted');
  });

  it('resets a user\'s 2FA', async () => {
    expect((await cli(['user', 'totp-reset', 'user@example.com', '--yes'])).code).toBe(0);
    const row = await userRow(USER);
    expect([row.totp_enabled, row.totp_secret]).toEqual([false, null]);
    expect(await cli(['user', 'totp-reset', 'admin@example.com', '--yes', '--as', 'admin@example.com']))
      .toMatchObject({ code: 1, err: expect.stringContaining('(self_change)') });
  });
});

describe('mailexpert settings', () => {
  it('sets a setting with the route\'s checks and has the backend reload it', async () => {
    expect((await cli(['settings', 'set', 'auth_max_attempts', '7'])).code).toBe(0);
    expect(await setting('auth_max_attempts')).toBe('7');
    await runEffects();
    expect(hooks.reload.auth_limits).toHaveBeenCalled();
    expect(hooks.reload.connection_policy).toHaveBeenCalled();

    expect(await cli(['settings', 'set', 'auth_max_attempts', '500'])).toMatchObject({ code: 1, err: expect.stringContaining('between 1 and 100') });
    expect(await cli(['settings', 'set', 'sync_interval_sec', '45'])).toMatchObject({ code: 1, err: expect.stringContaining('(invalid_field)') });
    expect(await cli(['settings', 'set', 'mfa_enforcement', 'sometimes'])).toMatchObject({ code: 1 });
    expect((await cli(['settings', 'set', 'registration_open', 'maybe'])).code).toBe(2);
    expect((await cli(['settings', 'set', 'no_such_key', 'x'])).code).toBe(2);
    expect((await cli(['settings', 'set', 'mfa_enforcement', 'required'])).code).toBe(0);
    expect((await cli(['settings', 'set', 'registration_open', 'false'])).code).toBe(0);
    expect(await setting('registration_open')).toBe('false');
  });

  it('shows the settings it manages', async () => {
    await cli(['settings', 'set', 'mfa_enforcement', 'required']);
    expect((await cli(['settings', 'get', 'mfa_enforcement'])).out.trim()).toBe('required');
    expect((await cli(['settings', 'get', '--json'])).json().settings).toMatchObject({ mfa_enforcement: 'required' });
    expect((await cli(['settings', 'get'])).out).toMatch(/auth_max_attempts:\s+\(not set\)/);
    expect((await cli(['settings', 'get', 'access_sync_config'])).code).toBe(2);
  });

  it('turns password login off only with an SSO provider and the --as admin\'s SSO identity', async () => {
    expect(await cli(['settings', 'set', 'internal_auth_disabled', 'true'])).toMatchObject({ code: 1, err: expect.stringContaining('(no_sso_provider)') });
    const { rows: [provider] } = await db.query(
      "INSERT INTO oidc_providers (name, slug, issuer_url, client_id, client_secret) VALUES ('IdP', 'idp', 'https://idp.example.com', 'c', 's') RETURNING id",
    );
    expect(await cli(['settings', 'set', 'internal_auth_disabled', 'true'])).toMatchObject({ code: 1, err: expect.stringContaining('(sso_identity_required)') });
    await db.query("INSERT INTO user_identities (user_id, provider_id, issuer, subject) VALUES ($1, $2, 'https://idp.example.com', 'sub')", [ADMIN, provider.id]);
    expect((await cli(['settings', 'set', 'internal_auth_disabled', 'true', '--as', 'admin@example.com'])).code).toBe(0);
    expect(await setting('internal_auth_disabled')).toBe('true');
    // Password login back on needs nothing: the way back in.
    expect((await cli(['settings', 'set', 'internal_auth_disabled', 'false'])).code).toBe(0);
  });
});

describe('mailexpert sso', () => {
  it('adds a provider with the secret from stdin, never printing it', async () => {
    const result = await cli(['sso', 'add', '--name', 'Corp IdP', '--slug', 'corp', '--issuer', 'https://idp.example.com', '--client-id', 'client-1', '--json'], { stdin: `${SECRET}\n` });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(SECRET);
    expect(result.json().provider).toMatchObject({ slug: 'corp', enabled: true, client_id: 'client-1', login_match_claim: 'email' });
    const { rows: [stored] } = await db.query("SELECT client_secret FROM oidc_providers WHERE slug = 'corp'");
    expect(stored.client_secret).not.toBe(SECRET);
    expect(decrypt(stored.client_secret)).toBe(SECRET);

    const list = await cli(['sso', 'list']);
    expect(list.out).toMatch(/corp/);
    expect(list.out).not.toContain(SECRET);
    expect(await cli(['sso', 'add', '--name', 'X', '--slug', 'corp', '--issuer', 'https://idp.example.com', '--client-id', 'c'], { stdin: SECRET }))
      .toMatchObject({ code: 1, err: expect.stringContaining('(slug_taken)') });
    expect(await cli(['sso', 'add', '--name', 'X', '--slug', 'Bad Slug', '--issuer', 'https://idp.example.com', '--client-id', 'c'], { stdin: SECRET }))
      .toMatchObject({ code: 1, err: expect.stringContaining('(slug_invalid)') });
    expect(await cli(['sso', 'add', '--name', 'X', '--slug', 'plain', '--issuer', 'http://idp.example.com', '--client-id', 'c'], { stdin: SECRET }))
      .toMatchObject({ code: 1, err: expect.stringContaining('(issuer_not_https)') });
    expect(await cli(['sso', 'add', '--name', 'X', '--slug', 'nosecret', '--issuer', 'https://idp.example.com', '--client-id', 'c']))
      .toMatchObject({ code: 1, err: expect.stringContaining('(fields_required)') });
  });

  it('changes a provider by slug, the secret only with --secret, and keeps the last one while password login is off', async () => {
    await cli(['sso', 'add', '--name', 'Corp', '--slug', 'corp', '--issuer', 'https://idp.example.com', '--client-id', 'c'], { stdin: SECRET });
    const before = (await db.query("SELECT client_secret FROM oidc_providers WHERE slug = 'corp'")).rows[0].client_secret;
    expect((await cli(['sso', 'set', 'corp', '--name', 'Corp SSO', '--allowed-domains', 'example.com'])).code).toBe(0);
    let row = (await db.query("SELECT * FROM oidc_providers WHERE slug = 'corp'")).rows[0];
    expect([row.name, row.allowed_domains, row.client_secret]).toEqual(['Corp SSO', 'example.com', before]);
    expect((await cli(['sso', 'set', 'corp', '--secret'], { stdin: 'new-secret-value' })).code).toBe(0);
    row = (await db.query("SELECT * FROM oidc_providers WHERE slug = 'corp'")).rows[0];
    expect(decrypt(row.client_secret)).toBe('new-secret-value');

    await db.query("INSERT INTO system_settings (key, value) VALUES ('internal_auth_disabled', 'true')");
    expect(await cli(['sso', 'set', row.id, '--disable'])).toMatchObject({ code: 1, err: expect.stringContaining('(last_provider)') });
    expect(await cli(['sso', 'remove', 'corp', '--yes'])).toMatchObject({ code: 1, err: expect.stringContaining('(last_provider)') });
    await db.query("UPDATE system_settings SET value = 'false' WHERE key = 'internal_auth_disabled'");
    expect((await cli(['sso', 'remove', 'corp', '--yes'])).code).toBe(0);
    expect((await db.query('SELECT * FROM oidc_providers')).rows).toEqual([]);
    expect(await cli(['sso', 'set', 'corp', '--name', 'x'])).toMatchObject({ code: 1, err: expect.stringContaining('(not_found)') });
  });
});

describe('mailexpert integration microsoft', () => {
  it('stores the client with the secret from stdin, shows it masked, and has the backend reload it', async () => {
    expect((await cli(['integration', 'microsoft', 'show', '--json'])).json()).toEqual({ config: null });
    const set = await cli(['integration', 'microsoft', 'set', '--client-id', 'ms-client', '--tenant-id', 'common', '--secret'], { stdin: 'ms-secret-value\n' });
    expect(set.code).toBe(0);
    const { rows: [row] } = await db.query("SELECT config FROM integration_config WHERE provider = 'microsoft'");
    expect(row.config).toMatchObject({ clientId: 'ms-client', tenantId: 'common' });
    expect(decrypt(row.config.clientSecret)).toBe('ms-secret-value');
    await runEffects();
    expect(hooks.reload.microsoft).toHaveBeenCalled();

    const show = await cli(['integration', 'microsoft', 'show']);
    expect(show.out).toMatch(/client secret:\s+set/);
    expect(show.out).not.toContain('ms-secret-value');
    expect((await cli(['integration', 'microsoft', 'show', '--json'])).out).not.toContain('ms-secret-value');

    // Another field alone keeps the stored secret and the other fields.
    expect((await cli(['integration', 'microsoft', 'set', '--redirect-uri', 'https://mail.example.com/api/oauth/microsoft/callback'])).code).toBe(0);
    const { rows: [after] } = await db.query("SELECT config FROM integration_config WHERE provider = 'microsoft'");
    expect(after.config).toMatchObject({ clientId: 'ms-client', tenantId: 'common', redirectUri: 'https://mail.example.com/api/oauth/microsoft/callback' });
    expect(decrypt(after.config.clientSecret)).toBe('ms-secret-value');

    expect(await cli(['integration', 'microsoft', 'set', '--secret'], { stdin: '••••abc' })).toMatchObject({ code: 1, err: expect.stringContaining('(client_secret_redacted)') });
    expect((await cli(['integration', 'microsoft', 'set'])).code).toBe(2);
    expect((await cli(['integration', 'microsoft', 'show', '--client-id', 'x'])).code).toBe(2);

    expect((await cli(['integration', 'microsoft', 'remove', '--yes'])).code).toBe(0);
    expect((await db.query("SELECT 1 FROM integration_config WHERE provider = 'microsoft'")).rows).toEqual([]);
    expect((await cli(['integration', 'google', 'show'])).code).toBe(2);
  });
});
