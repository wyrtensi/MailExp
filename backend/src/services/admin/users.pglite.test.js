import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Tombstones, the Access sync's import and the users' access state, end to end on PGlite with
// every migration: an administrator deletes a user, Cloudflare still lists the email, and neither
// the sync nor a Cloudflare Access sign-in brings the user back until an administrator allows the
// email again.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  process.env.AUTH_MODE = 'google';
  return { db: null };
});
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn() }));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { recordAudit } = await import('../auditLog.js');
const { saveConfig } = await import('../accessSync/settings.js');
const { runAccessSync } = await import('../accessSync/runner.js');
const { listTombstones } = await import('../accessSync/tombstones.js');
const { resolveVerifiedUser } = await import('../auth/userIdentity.js');
const { allowEmail, createUser, deleteUser, listUsers, updateUser } = await import('./users.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const SETTINGS = { mode: 'google', bootstrapAdminEmails: new Set() };
const rule = (email) => ({ email: { email } });

let db;
let policy;
let adminId;

const cloudflare = () => ({
  getPolicy: async () => structuredClone(policy),
  updatePolicy: async (next) => { policy = structuredClone(next); return next; },
});
const sync = () => runAccessSync({ trigger: 'test', signOutUser: async () => {}, createClient: cloudflare, settings: SETTINGS, env: {} });
const listed = () => policy.include.map((r) => r.email?.email).filter(Boolean).sort();
const ACTOR = () => ({ userId: adminId });
const emails = async () => (await db.query('SELECT email FROM users ORDER BY email')).rows.map((r) => r.email);
const stateOf = async (email) => (await listUsers()).users.find((u) => u.email === email)?.accessState;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  recordAudit.mockClear();
  await db.exec("DELETE FROM users; DELETE FROM access_tombstones; DELETE FROM system_settings WHERE key LIKE 'access_sync%';");
  ({ rows: [{ id: adminId }] } = await db.query(
    "INSERT INTO users (username, email, is_admin) VALUES ('admin@example.com', 'admin@example.com', true) RETURNING id",
  ));
  policy = { id: POLICY, name: 'Allow', decision: 'allow', include: [rule('admin@example.com')], exclude: [], require: [] };
  await saveConfig({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiToken: 'cf-token-0123456789abcdef' });
});

describe('two-way Access sync with tombstones', () => {
  it('imports an email added in Cloudflare and owns it from then on', async () => {
    await sync();
    policy.include.push(rule('new@example.com'), { group: { id: 'g-1' } });
    expect(await sync()).toMatchObject({ outcome: 'unchanged', imported: 1 });
    expect(await emails()).toEqual(['admin@example.com', 'new@example.com']);
    expect(await stateOf('new@example.com')).toBe('in_access');
    expect(recordAudit).toHaveBeenCalledWith([expect.objectContaining({ action: 'access.user_imported' })]);

    // Removed in Cloudflare: disabled and marked, and it stays disabled when the email comes back.
    policy.include = policy.include.filter((r) => r.email?.email !== 'new@example.com');
    expect(await sync()).toMatchObject({ disabled: 1 });
    expect(await stateOf('new@example.com')).toBe('removed_in_cloudflare');
    policy.include.push(rule('new@example.com'));
    expect(await sync()).toMatchObject({ imported: 0 });
    expect((await listUsers()).users.find((u) => u.email === 'new@example.com').disabledAt).not.toBeNull();
    expect(await resolveVerifiedUser({ email: 'new@example.com', source: 'cloudflare', settings: SETTINGS }))
      .toEqual({ error: 'user_disabled' });
  });

  it('does not bring back a deleted user through the sync or an Access sign-in until allowed again', async () => {
    const { user } = await createUser('gone@example.com', ACTOR());
    await sync();
    expect(listed()).toContain('gone@example.com');

    await deleteUser(user.id, ACTOR());
    expect(await listTombstones()).toEqual([
      { email: 'gone@example.com', createdAt: expect.any(Date), createdBy: 'admin@example.com', reason: 'deleted' },
    ]);
    // Cloudflare still lists it (someone put it back by hand): neither path recreates the user.
    expect(await resolveVerifiedUser({ email: 'gone@example.com', source: 'cloudflare', settings: SETTINGS }))
      .toEqual({ error: 'user_deleted' });
    await sync();
    expect(listed()).not.toContain('gone@example.com');
    policy.include.push(rule('gone@example.com'));
    expect(await sync()).toMatchObject({ imported: 0 });
    expect(await emails()).toEqual(['admin@example.com']);

    const allowed = await allowEmail('gone@example.com', ACTOR());
    expect(allowed).toMatchObject({ created: true, tombstoneCleared: true, user: { email: 'gone@example.com', accessState: 'in_access' } });
    expect(await listTombstones()).toEqual([]);
  });

  it('creates an Access-admitted email on first sign-in and lets an approval clear a tombstone', async () => {
    policy.include.push(rule('walkin@example.com'));
    await sync();
    const result = await resolveVerifiedUser({ email: 'walkin@example.com', source: 'cloudflare', settings: SETTINGS });
    expect(result.user).toMatchObject({ email: 'walkin@example.com', is_admin: false, access_source: null });
    expect(await stateOf('walkin@example.com')).toBe('in_access');
    await sync();
    expect(listed()).toContain('walkin@example.com');

    await deleteUser(result.user.id, ACTOR());
    expect((await createUser('walkin@example.com', ACTOR())).user).toMatchObject({ email: 'walkin@example.com' });
    expect(await listTombstones()).toEqual([]);
  });

  it('enables a disabled user when allowed again, and an admin enable clears the sync mark', async () => {
    const { user } = await createUser('off@example.com', ACTOR());
    await db.query("UPDATE users SET disabled_at = NOW(), disabled_source = 'cloudflare_access' WHERE id = $1", [user.id]);
    expect(await allowEmail('off@example.com', ACTOR())).toMatchObject({ created: false, enabled: true, user: { disabledAt: null } });

    await db.query("UPDATE users SET disabled_at = NOW(), disabled_source = 'cloudflare_access' WHERE id = $1", [user.id]);
    await updateUser(user.id, { disabled: false }, ACTOR());
    expect((await db.query('SELECT disabled_source FROM users WHERE id = $1', [user.id])).rows[0].disabled_source).toBeNull();
  });

  it('does not pin a user a domain rule admitted, and adopts them once the policy lists the address', async () => {
    policy.include.push({ email_domain: { domain: 'example.org' } });
    await sync();
    const { user } = await resolveVerifiedUser({ email: 'dom@example.org', source: 'cloudflare', settings: SETTINGS });
    expect(user.access_source).toBe('login');
    expect(await stateOf('dom@example.org')).toBe('admitted_by_rule');
    await sync();
    expect(listed()).toEqual(['admin@example.com']);
    expect(await stateOf('dom@example.org')).toBe('admitted_by_rule');

    policy.include.push(rule('dom@example.org'));
    await sync();
    expect((await db.query("SELECT access_source FROM users WHERE email = 'dom@example.org'")).rows[0].access_source).toBeNull();
    expect(await stateOf('dom@example.org')).toBe('in_access');
    // Owned now: removed in Cloudflare together with the domain rule, the user is disabled.
    policy.include = policy.include.filter((r) => r.email?.email !== 'dom@example.org' && !r.email_domain);
    expect(await sync()).toMatchObject({ disabled: 1 });
  });

  it('an administrator\'s approval ends the "admitted by a rule" mark', async () => {
    policy.include.push({ email_domain: { domain: 'example.org' } });
    const { user } = await resolveVerifiedUser({ email: 'dom@example.org', source: 'cloudflare', settings: SETTINGS });
    expect(user.access_source).toBe('login');
    expect(await allowEmail('dom@example.org', ACTOR())).toMatchObject({ created: false, enabled: false, user: { accessState: 'pending' } });
    await sync();
    expect(listed()).toContain('dom@example.org');
  });

  it('tombstones the old address when an administrator changes or clears an email', async () => {
    const { user } = await createUser('old@example.com', ACTOR());
    await sync();
    expect(listed()).toContain('old@example.com');

    await updateUser(user.id, { email: 'new@example.com' }, ACTOR());
    expect(await listTombstones()).toEqual([
      { email: 'old@example.com', createdAt: expect.any(Date), createdBy: 'admin@example.com', reason: 'email_changed' },
    ]);
    expect(await resolveVerifiedUser({ email: 'old@example.com', source: 'cloudflare', settings: SETTINGS }))
      .toEqual({ error: 'user_deleted' });
    await sync();
    expect(listed()).toEqual(['admin@example.com', 'new@example.com']);
    // Put back by hand in Cloudflare: still not imported.
    policy.include.push(rule('old@example.com'));
    expect(await sync()).toMatchObject({ imported: 0 });
    expect(await emails()).toEqual(['admin@example.com', 'new@example.com']);

    // Clearing the email tombstones it too; giving the old address back clears its tombstone.
    await updateUser(user.id, { email: null }, ACTOR());
    expect((await listTombstones()).map((t) => [t.email, t.reason])).toEqual(
      expect.arrayContaining([['new@example.com', 'email_changed'], ['old@example.com', 'email_changed']]),
    );
    await updateUser(user.id, { email: 'old@example.com' }, ACTOR());
    expect((await listTombstones()).map((t) => t.email)).toEqual(['new@example.com']);
  });

  it('tombstones the address of a deleted legacy user named by it', async () => {
    const { rows: [{ id }] } = await db.query("INSERT INTO users (username) VALUES ('Legacy@Example.com') RETURNING id");
    await deleteUser(id, ACTOR());
    expect((await listTombstones()).map((t) => t.email)).toEqual(['legacy@example.com']);
    expect(await resolveVerifiedUser({ email: 'legacy@example.com', source: 'cloudflare', settings: SETTINGS }))
      .toEqual({ error: 'user_deleted' });
  });

  it('says not_synced while the sync is off', async () => {
    await saveConfig({ enabled: false, accountId: ACCOUNT, appId: APP, policyId: POLICY });
    expect(await stateOf('admin@example.com')).toBe('not_synced');
  });
});
