import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's access commands end to end: the real Access sync settings, actions, job queue and
// runner on PGlite with every migration; Cloudflare's API is a fake fetch. The CLI queues the run;
// the test runs the backend's job worker for it, as the backend would.

const dbState = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  return { db: null };
});
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { claimDueJobs, runJob } = await import('../services/jobQueue.js');
const { ACCESS_SYNC_JOB_KIND, registerAccessSyncJobKind } = await import('../services/accessSync/actions.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '64000000-0000-4000-8000-000000000001';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const APP = '11111111-2222-4333-8444-555555555555';
const POLICY = '66666666-7777-4888-9999-000000000000';
const TOKEN = 'cf-token-AbCdEf0123456789xyzXYZ_-0123';
const AUD = 'c'.repeat(64);
let db;
let cloudflare;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function runDue() {
  for (const job of await claimDueJobs(10)) await runJob(job);
}

async function cli(argv, { stdin = '', sleep = runDue } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout, stderr, interactive: false, ask: async () => '', readStdin: async () => stdin, stdinIsTerminal: false,
    sleep, now: Date.now, pollMs: 0,
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
const storedConfig = async () => JSON.parse((await db.query("SELECT value FROM system_settings WHERE key = 'access_sync_config'")).rows[0]?.value ?? 'null');
const accessJobs = async () => (await db.query('SELECT * FROM jobs WHERE kind = $1 ORDER BY id', [ACCESS_SYNC_JOB_KIND])).rows;

// Cloudflare's Access API for one policy: GET answers it, PUT replaces it. status overrides the
// answer (a refused token).
function fakeCloudflare({ status = 200 } = {}) {
  const state = {
    policy: { id: POLICY, name: 'Allow', decision: 'allow', include: [], exclude: [], require: [] },
    calls: [],
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    state.calls.push({ url: String(url), method: init.method, authorization: init.headers?.authorization });
    if (status !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status });
    if (String(url).endsWith('/user/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
    if (String(url).endsWith(`/access/apps/${APP}`)) return Response.json({ success: true, result: { id: APP, name: 'MailExpert', aud: AUD } });
    if (init.method === 'PUT') state.policy = { ...JSON.parse(init.body), id: POLICY };
    return new Response(JSON.stringify({ success: true, result: state.policy }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return state;
}

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  registerAccessSyncJobKind();
}, 120000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('AUTH_MODE', 'google');
  vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
  vi.stubEnv('CF_ACCESS_ISSUER', '');
  vi.stubEnv('CF_ACCESS_AUDIENCE', '');
  await db.exec("DELETE FROM jobs; DELETE FROM mailbox_audit_log; DELETE FROM system_settings WHERE key LIKE 'access_sync%';");
  cloudflare = fakeCloudflare();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// The sync configured and on, as an administrator would leave it.
async function configured() {
  expect((await cli(['access', 'token'], { stdin: `${TOKEN}\n` })).code).toBe(0);
  expect((await cli(['access', 'config', '--account', ACCOUNT, '--app', APP, '--policy', POLICY, '--enable'])).code).toBe(0);
  await db.exec('DELETE FROM jobs; DELETE FROM mailbox_audit_log;');
}

describe('mailexpert access status', () => {
  it('shows the settings without a token and that it never ran', async () => {
    const result = await cli(['access', 'status']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/enabled:\s+no/);
    expect(result.out).toMatch(/api token:\s+not set/);
    expect(result.out).toContain('last run: never');
    const json = (await cli(['access', 'status', '--json'])).json();
    expect(json).toEqual({
      config: { enabled: false, accountId: '', appId: '', policyId: '', apiTokenSet: false },
      lastRun: null, maxDisables: 10, maxImports: 10, tombstones: 0, googleMode: true,
      host: { issuer: null, audienceSet: false },
    });
  });
});

describe('mailexpert access token', () => {
  it('stores the token from stdin encrypted, never prints it and journals only that it changed', async () => {
    const result = await cli(['access', 'token', '--json'], { stdin: `  ${TOKEN}\r\n` });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(TOKEN);
    expect(result.json().config.apiTokenSet).toBe(true);
    expect(result.json().job).toBeNull();
    const stored = await storedConfig();
    expect(stored.apiToken).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({
      actor_user_id: null, actor_email: 'cli', action: 'access.config_changed',
      details: { changed: [], tokenChanged: true, enabled: false, via: 'cli' },
    });
    expect(JSON.stringify(await audit())).not.toContain(TOKEN);
  });

  it('refuses a token that is not one line, and never takes it from an argument', async () => {
    const spaced = await cli(['access', 'token'], { stdin: 'two words in a token value' });
    expect(spaced.code).toBe(1);
    expect(spaced.err).toContain('(token_invalid)');
    expect(spaced.err).not.toContain('two words');
    expect((await cli(['access', 'token'], { stdin: '' })).code).toBe(1);
    const asArg = await cli(['access', 'token', TOKEN]);
    expect(asArg.code).toBe(2);
    expect(await storedConfig()).toBeNull();
  });
});

describe('mailexpert access config', () => {
  it('needs the IDs and a token to turn the sync on, and checks the IDs', async () => {
    const incomplete = await cli(['access', 'config', '--account', ACCOUNT, '--enable', '--json']);
    expect(incomplete.code).toBe(1);
    expect(incomplete.json()).toMatchObject({ code: 'incomplete' });
    const badId = await cli(['access', 'config', '--app', 'not-a-uuid']);
    expect(badId.code).toBe(1);
    expect(badId.err).toContain('(invalid_id)');
    expect((await cli(['access', 'config', '--enable', '--disable'])).code).toBe(2);
    expect((await cli(['access', 'config'])).code).toBe(2);
    expect(await storedConfig()).toBeNull();
  });

  it('keeps what it is not given, queues a run when the sync is on and journals the changed fields', async () => {
    await cli(['access', 'token'], { stdin: TOKEN });
    const ids = await cli(['access', 'config', '--account', ACCOUNT.toUpperCase(), '--app', APP, '--policy', POLICY]);
    expect(ids.code).toBe(0);
    expect(await accessJobs()).toHaveLength(0);
    const on = await cli(['access', 'config', '--enable', '--as', 'admin@example.com', '--json']);
    expect(on.code).toBe(0);
    expect(on.json().config).toEqual({ enabled: true, accountId: ACCOUNT, appId: APP, policyId: POLICY, apiTokenSet: true });
    const jobs = await accessJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', created_by: ADMIN, max_attempts: 1, payload: { via: 'cli' } });
    expect(on.json().job).toEqual({ id: jobs[0].id, status: 'queued' });
    const entries = await auditSettled(3);
    expect(entries.map((e) => e.action)).toEqual(['access.config_changed', 'access.config_changed', 'access.config_changed']);
    expect(entries[1].details).toMatchObject({ changed: ['accountId', 'appId', 'policyId'], tokenChanged: false, enabled: false });
    expect(entries[2]).toMatchObject({ actor_user_id: ADMIN, actor_email: 'admin@example.com', details: { changed: ['enabled'], via: 'cli' } });
    // The token survives a change of the other settings.
    expect((await storedConfig()).apiToken).toMatch(/^enc:v1:/);
    const off = await cli(['access', 'config', '--disable']);
    expect(off.code).toBe(0);
    expect(await accessJobs()).toHaveLength(1);
  });
});

describe('mailexpert access tombstones and allow', () => {
  it('lists a deleted user\'s email, and allow clears it and approves the email again', async () => {
    await db.query("INSERT INTO access_tombstones (email, created_by) VALUES ('gone@example.com', $1)", [ADMIN]);
    const list = await cli(['access', 'tombstones', '--json']);
    expect(list.code).toBe(0);
    expect(list.json().tombstones).toEqual([
      { email: 'gone@example.com', createdAt: expect.any(String), createdBy: 'admin@example.com', reason: 'deleted', inPolicy: false },
    ]);
    expect((await cli(['access', 'status'])).out).toMatch(/deleted users \(tombstones\):\s+1/);

    const allowed = await cli(['access', 'allow', 'Gone@Example.com', '--json']);
    expect(allowed.code).toBe(0);
    expect(allowed.json()).toMatchObject({ created: true, tombstoneCleared: true, user: { email: 'gone@example.com' } });
    expect((await db.query('SELECT count(*)::int AS n FROM access_tombstones')).rows[0].n).toBe(0);
    const actions = (await auditSettled(2)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['access.tombstone_cleared', 'user.added']));
    await db.query("DELETE FROM users WHERE email = 'gone@example.com'");
  });
});

describe('mailexpert access verify', () => {
  it('checks the stored settings with reads only, before the sync is on, and journals nothing', async () => {
    vi.stubEnv('CF_ACCESS_AUDIENCE', AUD);
    expect((await cli(['access', 'token'], { stdin: TOKEN })).code).toBe(0);
    expect((await cli(['access', 'config', '--account', ACCOUNT, '--app', APP, '--policy', POLICY])).code).toBe(0);
    await db.exec('DELETE FROM mailbox_audit_log;');
    const result = await cli(['access', 'verify']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/token:\s+ok: active/);
    expect(result.out).toMatch(/audience:\s+ok: the aud tag of the application matches/);
    expect(result.out).toMatch(/policy:\s+ok: found/);
    expect(result.out).not.toContain(TOKEN);
    expect(cloudflare.calls.every((call) => call.method === 'GET' && call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(await audit()).toEqual([]);
    expect(await accessJobs()).toEqual([]);
  });

  it('exits 1 and names the missing permission when Cloudflare refuses', async () => {
    await configured();
    fakeCloudflare({ status: 403 });
    const result = await cli(['access', 'verify', '--json']);
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ code: 'verify_failed', ok: false });
    expect(result.out).not.toContain(TOKEN);
    const text = await cli(['access', 'verify']);
    expect(text.err).toContain('lacks "Access: Apps and Policies"');
  });

  it('refuses when there is no token to verify', async () => {
    const result = await cli(['access', 'verify', '--json']);
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ code: 'verify_incomplete' });
  });
});

describe('mailexpert access sync', () => {
  it('queues the run for the backend, follows it and prints the outcome', async () => {
    await configured();
    const result = await cli(['access', 'sync', '--json']);
    expect(result.code).toBe(0);
    const { job } = result.json();
    expect(job).toMatchObject({ status: 'done', result: { outcome: 'updated', added: 1, trigger: 'manual' } });
    expect(cloudflare.policy.include).toEqual([{ email: { email: 'admin@example.com' } }]);
    expect(cloudflare.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(cloudflare.calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/apps/${APP}/policies/${POLICY}`);
    expect(cloudflare.calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.out).not.toContain(TOKEN);
    const [entry] = await auditSettled(1);
    expect(entry).toMatchObject({ actor_email: 'cli', action: 'access.sync_requested', details: { via: 'cli' } });
    const again = await cli(['access', 'sync']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('unchanged: the policy already matched the active users');
    const status = (await cli(['access', 'status', '--json'])).json();
    expect(status.lastRun).toMatchObject({ outcome: 'unchanged', trigger: 'manual' });
  });

  it('exits 1 when the sync is not configured or the panel does not sign in through Google', async () => {
    const unconfigured = await cli(['access', 'sync']);
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.err).toContain('(not_configured)');
    await configured();
    vi.stubEnv('AUTH_MODE', 'local');
    const local = await cli(['access', 'sync', '--json']);
    expect(local.code).toBe(1);
    expect(local.json()).toMatchObject({ code: 'not_google_mode' });
    expect(cloudflare.calls).toHaveLength(0);
  });

  it('exits 3 with the error when Cloudflare refuses, the token never in the output', async () => {
    await configured();
    fakeCloudflare({ status: 403 });
    const result = await cli(['access', 'sync']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('failed: Cloudflare getPolicy failed (403): error 10000');
    expect(result.err).not.toContain(TOKEN);
  });

  it('exits 3 when the backend does not run the job in time', async () => {
    await configured();
    const result = await cli(['access', 'sync', '--timeout', '1', '--json'], { sleep: async () => { await new Promise((r) => { setTimeout(r, 600); }); } });
    expect(result.code).toBe(3);
    expect(result.json()).toMatchObject({ code: 'wait_timeout', job: { status: 'queued' } });
  });
});
