import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  // 'broken' stands for a value encrypted with another key: decrypt() returns null for it.
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v === 'broken' ? null : v),
}));

const { query, withTransaction } = await import('../db.js');
const {
  GoogleAppError,
  parseGoogleClientId,
  getGoogleAppById,
  getDefaultGoogleApp,
  getEffectiveGoogleRedirectUri,
  resolveGoogleConfig,
  recordGoogleGrant,
  setGoogleAppStatus,
  importLegacyGoogleConfig,
  listGoogleApps,
  getGoogleAppSummary,
  createGoogleApp,
  updateGoogleApp,
  deleteGoogleApp,
  findKnownGoogleEmails,
} = await import('./googleApps.js');

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const APP = {
  id: 'app-1',
  label: 'Google 1',
  client_id: CLIENT_ID,
  client_secret: 'enc(app-secret)',
  project_number: '123456789012',
  user_limit: 100,
  status: 'active',
  created_at: new Date('2026-09-15T00:00:00Z'),
};

// Transaction client that routes SQL by pattern and records every call.
function scriptedClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  delete process.env.GOOGLE_REDIRECT_URI;
});
afterEach(() => {
  delete process.env.GOOGLE_REDIRECT_URI;
});

describe('parseGoogleClientId', () => {
  it('returns the Google Cloud project number of a web client ID', () => {
    expect(parseGoogleClientId(CLIENT_ID)).toBe('123456789012');
    expect(parseGoogleClientId(`  ${CLIENT_ID}  `)).toBe('123456789012');
  });

  it.each([
    ['no project number', 'abc123.apps.googleusercontent.com'],
    ['another domain', '123-abc.apps.example.com'],
    ['an upper-case suffix', '123-ABC.apps.googleusercontent.com'],
    ['a number', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseGoogleClientId(value)).toBeNull();
  });
});

describe('app lookups', () => {
  it('picks the oldest app that is not disabled as the default', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await getDefaultGoogleApp()).toEqual(APP);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FROM google_oauth_apps/);
    expect(sql).toMatch(/status <> 'disabled'/);
    expect(sql).toMatch(/ORDER BY created_at, id LIMIT 1/);
  });

  it('returns null when there is no default app', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDefaultGoogleApp()).toBeNull();
  });

  it('loads an app by id in any status and skips the query without an id', async () => {
    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await getGoogleAppById('app-1')).toMatchObject({ id: 'app-1', status: 'disabled' });
    expect(query.mock.calls[0][1]).toEqual(['app-1']);

    query.mockClear();
    expect(await getGoogleAppById(null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('getEffectiveGoogleRedirectUri', () => {
  it('prefers the stored callback URL over the environment', async () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://env.example.com/oauth/google/callback';
    query.mockResolvedValue({ rows: [{ config: { redirectUri: REDIRECT_URI } }] });
    expect(await getEffectiveGoogleRedirectUri()).toBe(REDIRECT_URI);
    expect(query.mock.calls[0][0]).toMatch(/integration_config/);
  });

  it('falls back to the environment when nothing is stored', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [] });
    expect(await getEffectiveGoogleRedirectUri()).toBe(REDIRECT_URI);
  });

  it('is null without a stored value or the environment', async () => {
    query.mockResolvedValue({ rows: [{ config: {} }] });
    expect(await getEffectiveGoogleRedirectUri()).toBeNull();
  });
});

describe('resolveGoogleConfig', () => {
  it('combines the default app with the callback URL and decrypts the secret', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toEqual({
      appId: 'app-1', clientId: CLIENT_ID, clientSecret: 'app-secret', redirectUri: REDIRECT_URI,
    });
    expect(query.mock.calls[0][0]).toMatch(/status <> 'disabled'/);
  });

  it('uses the requested app instead of the default one', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [{ ...APP, id: 'app-2', status: 'closed' }] });
    expect(await resolveGoogleConfig({ appId: 'app-2' })).toMatchObject({ appId: 'app-2' });
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['app-2']);
  });

  it('sends a browser that came through another public origin back to that origin', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig({ origin: 'https://direct.example.com' })).toMatchObject({
      redirectUri: 'https://direct.example.com/oauth/google/callback',
    });
    expect(await resolveGoogleConfig({ origin: null })).toMatchObject({ redirectUri: REDIRECT_URI });
  });

  it('is null without a callback URL, without an app, for a disabled app or an undecryptable secret', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toBeNull();

    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [] });
    expect(await resolveGoogleConfig()).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await resolveGoogleConfig({ appId: 'app-1' })).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, client_secret: 'broken' }] });
    expect(await resolveGoogleConfig()).toBeNull();
  });
});

describe('recordGoogleGrant', () => {
  it('upserts one journal row per app and lower-cased email, keeping a known subject', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordGoogleGrant({ appId: 'app-1', email: 'User@Gmail.com', sub: 'sub-1' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO google_oauth_grants \(app_id, email, google_sub\) VALUES \(\$1, lower\(\$2\), \$3\)/);
    expect(sql).toMatch(/ON CONFLICT \(app_id, email\) DO UPDATE SET google_sub = COALESCE\(google_oauth_grants\.google_sub, EXCLUDED\.google_sub\)/);
    expect(params).toEqual(['app-1', 'User@Gmail.com', 'sub-1']);
  });

  it('runs on a transaction client when one is passed', async () => {
    const { client } = scriptedClient([[/INSERT INTO google_oauth_grants/, { rows: [] }]]);
    await recordGoogleGrant({ appId: 'app-1', email: 'u@gmail.com' }, client);
    expect(client.query.mock.calls[0][1]).toEqual(['app-1', 'u@gmail.com', null]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('setGoogleAppStatus', () => {
  it('flags every mailbox of a disabled app for reconnect and returns their ids', async () => {
    const { client, calls } = scriptedClient([
      [/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }],
      [/^\s*UPDATE email_accounts/, { rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));

    expect(await setGoogleAppStatus('app-1', 'disabled')).toEqual(['acc-1', 'acc-2']);
    expect(calls[0][1]).toEqual(['app-1', 'disabled']);
    const [accountSql, accountParams] = calls[1];
    expect(accountSql).toMatch(/oauth_reconnect_required = true/);
    expect(accountSql).toMatch(/sync_error = 'oauth_reconnect_required'/);
    expect(accountSql).toMatch(/WHERE oauth_app_id = \$1/);
    expect(accountParams).toEqual(['app-1']);
  });

  it.each(['active', 'closed'])('leaves mailboxes alone when the status becomes %s', async (status) => {
    const { client, calls } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await setGoogleAppStatus('app-1', status)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('rejects an unknown status without a transaction', async () => {
    const err = await setGoogleAppStatus('app-1', 'paused').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAppError);
    expect(err.code).toBe('app_status_invalid');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('reports a missing app', async () => {
    const { client } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    const err = await setGoogleAppStatus('app-9', 'closed').catch((e) => e);
    expect(err.code).toBe('app_not_found');
  });
});

describe('importLegacyGoogleConfig', () => {
  let errorSpy;
  let logSpy;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  function importDb({ appExists = false, config = null } = {}) {
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/^\s*SELECT 1 FROM google_oauth_apps/, { rows: appExists ? [{ '?column?': 1 }] : [] }],
      [/^\s*SELECT config FROM integration_config/, { rows: config ? [{ config }] : [] }],
      [/^\s*INSERT INTO google_oauth_apps/, { rows: [{ id: 'app-new' }] }],
      [/^\s*UPDATE email_accounts SET oauth_app_id/, { rows: [], rowCount: 2 }],
      [/^\s*INSERT INTO google_oauth_grants/, { rows: [] }],
      [/^\s*UPDATE integration_config/, { rows: [] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    return calls;
  }
  const findCall = (calls, re) => calls.find(([sql]) => re.test(sql));

  it('does nothing once an app exists', async () => {
    const calls = importDb({ appExists: true, config: { clientId: CLIENT_ID, clientSecret: 'enc(s)' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
  });

  it('imports the stored client, binds Gmail accounts, fills the journal and keeps only the callback URL', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'enc(stored-secret)', redirectUri: REDIRECT_URI } });

    expect(await importLegacyGoogleConfig()).toBe('app-new');

    expect(findCall(calls, /pg_advisory_xact_lock/)[0]).toMatch(/hashtext\('google-oauth-app-import'\)/);
    const [insertSql, insertParams] = findCall(calls, /INSERT INTO google_oauth_apps/);
    expect(insertSql).toMatch(/'Google 1'/);
    expect(insertParams).toEqual([CLIENT_ID, 'enc(stored-secret)', '123456789012']);
    const [bindSql, bindParams] = findCall(calls, /UPDATE email_accounts SET oauth_app_id/);
    expect(bindSql).toMatch(/oauth_provider = 'google' AND oauth_app_id IS NULL/);
    expect(bindParams).toEqual(['app-new']);
    const [grantSql, grantParams] = findCall(calls, /INSERT INTO google_oauth_grants/);
    expect(grantSql).toMatch(/SELECT DISTINCT \$1::uuid, lower\(email_address\)/);
    expect(grantSql).toMatch(/ON CONFLICT \(app_id, email\) DO NOTHING/);
    expect(grantParams).toEqual(['app-new']);
    expect(findCall(calls, /UPDATE integration_config/)[0]).toMatch(/jsonb_build_object\('redirectUri', config->'redirectUri'\)/);
  });

  it('encrypts a legacy plaintext secret', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'plain-secret' } });
    await importLegacyGoogleConfig();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1][1]).toBe('enc(plain-secret)');
  });

  it('falls back to the environment when nothing is stored', async () => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    const calls = importDb();
    expect(await importLegacyGoogleConfig()).toBe('app-new');
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)[1]).toEqual([CLIENT_ID, 'enc(env-secret)', '123456789012']);
    expect(findCall(calls, /UPDATE integration_config/)).toBeUndefined();
  });

  it('does nothing without any stored or environment client', async () => {
    const calls = importDb();
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reports a client ID that is not a Google OAuth client ID instead of importing it', async () => {
    const calls = importDb({ config: { clientId: 'gid', clientSecret: 'enc(top-secret)' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toMatch(/not a Google OAuth client ID/);
    expect(logged).not.toMatch(/top-secret|gid/);
  });

  it('reports a stored secret that cannot be decrypted', async () => {
    const calls = importDb({ config: { clientId: CLIENT_ID, clientSecret: 'broken' } });
    expect(await importLegacyGoogleConfig()).toBeNull();
    expect(findCall(calls, /INSERT INTO google_oauth_apps/)).toBeUndefined();
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/cannot be decrypted/);
  });
});

describe('app registry for the admin screen', () => {
  it('lists apps with seat and mailbox counts and never selects the secret', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'app-1', grants_count: 3, accounts_count: 2 }] });
    const apps = await listGoogleApps();
    expect(apps).toEqual([{ id: 'app-1', grants_count: 3, accounts_count: 2 }]);
    expect(query.mock.calls[0][0]).not.toMatch(/client_secret/);
  });

  it('getGoogleAppSummary reads one app by id with the same counted columns, never the secret', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'app-1', grants_count: 3, accounts_count: 2 }] });
    const app = await getGoogleAppSummary('app-1');
    expect(app).toEqual({ id: 'app-1', grants_count: 3, accounts_count: 2 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/client_secret/);
    expect(sql).toMatch(/\(SELECT count\(\*\) FROM google_oauth_grants g WHERE g\.app_id = a\.id\)::int AS grants_count/);
    expect(sql).toMatch(/\(SELECT count\(\*\) FROM email_accounts e WHERE e\.oauth_app_id = a\.id\)::int AS accounts_count/);
    expect(sql).toMatch(/WHERE a\.id = \$1/);
    expect(params).toEqual(['app-1']);
  });

  it('getGoogleAppSummary is null when the app is missing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getGoogleAppSummary('gone')).toBeNull();
  });

  it('creates an app with an encrypted secret under the registry lock', async () => {
    const { client, calls } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [] }],
      [/WHERE project_number = \$1/, { rows: [] }],
      [/INSERT INTO google_oauth_apps/, (p) => ({ rows: [{ id: 'app-2', label: p[0], client_id: p[1] }] })],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    const created = await createGoogleApp({ label: ' Google 2 ', clientId: CLIENT_ID, clientSecret: 's3cret' });
    expect(created).toEqual({ id: 'app-2', label: 'Google 2', client_id: CLIENT_ID });
    const insert = calls.find(([sql]) => /INSERT INTO google_oauth_apps/.test(sql));
    expect(insert[1]).toEqual(['Google 2', CLIENT_ID, 'enc(s3cret)', '123456789012', 100]);
    expect(insert[0]).not.toMatch(/RETURNING[^;]*client_secret/);
  });

  it.each([
    [{ label: '', clientId: CLIENT_ID, clientSecret: 's' }, 'label_invalid'],
    [{ label: 'x'.repeat(101), clientId: CLIENT_ID, clientSecret: 's' }, 'label_invalid'],
    [{ label: 'G', clientId: 'nope', clientSecret: 's' }, 'client_id_invalid'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: '' }, 'client_secret_required'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: 's', userLimit: 0 }, 'user_limit_invalid'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: 's', userLimit: 1.5 }, 'user_limit_invalid'],
    [{ label: 'G', clientId: CLIENT_ID, clientSecret: 's', userLimit: 2147483648 }, 'user_limit_invalid'],
  ])('rejects %j with %s before touching the database', async (input, code) => {
    await expect(createGoogleApp(input)).rejects.toMatchObject({ code });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a client ID already added, then a second client of the same project', async () => {
    let { client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [{ id: 'app-1' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(createGoogleApp({ label: 'G', clientId: CLIENT_ID, clientSecret: 's' })).rejects.toMatchObject({ code: 'app_exists' });

    ({ client } = scriptedClient([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/WHERE client_id = \$1/, { rows: [] }],
      [/WHERE project_number = \$1/, { rows: [{ id: 'app-1' }] }],
    ]));
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(createGoogleApp({ label: 'G', clientId: '123456789012-other.apps.googleusercontent.com', clientSecret: 's' }))
      .rejects.toMatchObject({ code: 'app_same_project' });
  });

  it('updates only the fields given and keeps the secret when none is sent', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'app-1', label: 'Renamed' }] });
    await updateGoogleApp('app-1', { label: 'Renamed' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/COALESCE\(\$3, client_secret\)/);
    expect(params).toEqual(['app-1', 'Renamed', null, null]);
  });

  it('encrypts a new secret on update and reports a missing app', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(updateGoogleApp('app-9', { clientSecret: 'new' })).rejects.toMatchObject({ code: 'app_not_found' });
    expect(query.mock.calls[0][1]).toEqual(['app-9', null, 'enc(new)', null]);
  });

  it('rejects a user limit above the int32 range on update, without touching the database', async () => {
    await expect(updateGoogleApp('app-1', { userLimit: 2147483648 })).rejects.toMatchObject({ code: 'user_limit_invalid' });
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes only an app without mailboxes', async () => {
    let { client } = scriptedClient([
      [/FROM email_accounts WHERE oauth_app_id = \$1/, { rows: [{ n: 1 }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(deleteGoogleApp('app-1')).rejects.toMatchObject({ code: 'app_in_use' });

    ({ client } = scriptedClient([
      [/FROM email_accounts WHERE oauth_app_id = \$1/, { rows: [{ n: 0 }] }],
      [/DELETE FROM google_oauth_apps/, { rows: [], rowCount: 0 }],
    ]));
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(deleteGoogleApp('app-9')).rejects.toMatchObject({ code: 'app_not_found' });
  });
});

describe('findKnownGoogleEmails', () => {
  it('searches grants without a mailbox, escaping LIKE wildcards', async () => {
    query.mockResolvedValueOnce({ rows: [{ email: 'a_b@gmail.com' }] });
    await expect(findKnownGoogleEmails('A_B%')).resolves.toEqual(['a_b@gmail.com']);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['a\\_b\\%']);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/LIMIT 8/);
    expect(sql).toMatch(/ESCAPE/);
  });
});
