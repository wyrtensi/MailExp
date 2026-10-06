import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A slow, successful token refresh must not overwrite the credentials a reconnect committed while
// the provider call was in flight (audit 2026-10-06, finding 21). The reconnect is represented by
// the same columns the OAuth callbacks write; the provider responses are fixtures.

const state = vi.hoisted(() => ({ db: null }));
vi.mock('../db.js', () => ({
  query: (sql, params) => state.db.query(sql, params),
  withTransaction: (fn) => state.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));

const { createRealSchemaDb } = await import('../testing/realSchema.js');
const { refreshGoogleToken } = await import('./googleOAuth.js');
const { refreshMicrosoftToken } = await import('./microsoftOAuth.js');
const { encrypt, decrypt } = await import('../encryption.js');

const ACCOUNT = '41000000-0000-4000-8000-000000000001';
const OLD_APP = '51000000-0000-4000-8000-000000000001';
const NEW_APP = '51000000-0000-4000-8000-000000000002';
const OLD_CLIENT = '111111111111-aaa.apps.googleusercontent.com';

const savedEnv = {};
for (const key of ['ENCRYPTION_KEY', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID']) savedEnv[key] = process.env[key];

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '11'.repeat(32);
  process.env.MS_CLIENT_ID = 'fixture-client';
  process.env.MS_CLIENT_SECRET = 'fixture-secret';
  process.env.MS_TENANT_ID = 'common';
  state.db = await createRealSchemaDb();
  await state.db.query(
    `INSERT INTO google_oauth_apps (id, label, client_id, client_secret, project_number) VALUES
      ($1, 'Old fixture', $3, $5, '111111111111'),
      ($2, 'New fixture', $4, $5, '222222222222')`,
    [OLD_APP, NEW_APP, OLD_CLIENT, '222222222222-bbb.apps.googleusercontent.com', encrypt('fixture-secret')],
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await state.db.exec('DELETE FROM email_accounts');
});

afterAll(async () => {
  await state.db.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const readAccount = async () => (await state.db.query('SELECT * FROM email_accounts WHERE id = $1', [ACCOUNT])).rows[0];

// Hold the provider's token response until the test releases it.
function holdTokenResponse() {
  const reached = deferred();
  const response = deferred();
  vi.stubGlobal('fetch', async () => {
    reached.resolve();
    return response.promise;
  });
  return {
    reached: reached.promise,
    respond: (body) => response.resolve({ ok: true, json: async () => body }),
  };
}

describe('Google refresh racing a reconnect', () => {
  async function insertGoogleAccount() {
    await state.db.query(
      `INSERT INTO email_accounts (id, name, email_address, oauth_provider, oauth_app_id, oauth_access_token, oauth_refresh_token)
       VALUES ($1, 'Fixture', 'mailbox@example.com', 'google', $2, $3, $4)`,
      [ACCOUNT, OLD_APP, encrypt('old-access'), encrypt('old-refresh')],
    );
    return readAccount();
  }

  // The update the Google callback commits for a reconnect through another app.
  const reconnectThroughNewApp = () => state.db.query(
    `UPDATE email_accounts SET oauth_app_id = $2, oauth_access_token = $3, oauth_refresh_token = $4,
       oauth_token_expiry = now() + interval '1 hour', oauth_reconnect_required = false WHERE id = $1`,
    [ACCOUNT, NEW_APP, encrypt('new-consent-access'), encrypt('new-consent-refresh')],
  );

  it.each([
    ['with a rotated refresh token', { access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 }],
    ['without a refresh token', { access_token: 'stale-access', expires_in: 3600 }],
  ])('keeps the reconnect credentials when the late response comes %s', async (_label, body) => {
    const account = await insertGoogleAccount();
    const provider = holdTokenResponse();
    const pending = refreshGoogleToken(account);
    await provider.reached;
    await reconnectThroughNewApp();
    provider.respond(body);
    const result = await pending;

    const stored = await readAccount();
    expect(stored.oauth_app_id).toBe(NEW_APP);
    expect(decrypt(stored.oauth_access_token)).toBe('new-consent-access');
    expect(decrypt(stored.oauth_refresh_token)).toBe('new-consent-refresh');
    // The caller goes on with the stored credentials, not the discarded ones.
    expect(result.oauth_app_id).toBe(NEW_APP);
    expect(decrypt(result.oauth_access_token)).toBe('new-consent-access');
  });

  it('fails when the mailbox was deleted during the provider call', async () => {
    const account = await insertGoogleAccount();
    const provider = holdTokenResponse();
    const pending = refreshGoogleToken(account);
    await provider.reached;
    await state.db.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]);
    provider.respond({ access_token: 'stale-access', expires_in: 3600 });
    await expect(pending).rejects.toMatchObject({ code: 'authentication_failed' });
  });

  it('saves a refresh that no reconnect raced', async () => {
    const account = await insertGoogleAccount();
    vi.stubGlobal('fetch', async (_url, options) => {
      expect(options.body.get('client_id')).toBe(OLD_CLIENT);
      expect(options.body.get('refresh_token')).toBe('old-refresh');
      return { ok: true, json: async () => ({ access_token: 'refreshed-access', expires_in: 3600 }) };
    });
    const result = await refreshGoogleToken(account);

    const stored = await readAccount();
    expect(result.oauth_access_token).toBe('refreshed-access');
    expect(stored.oauth_app_id).toBe(OLD_APP);
    expect(decrypt(stored.oauth_access_token)).toBe('refreshed-access');
    expect(decrypt(stored.oauth_refresh_token)).toBe('old-refresh');
  });
});

describe('Microsoft refresh racing a reconnect', () => {
  async function insertMicrosoftAccount() {
    await state.db.query(
      `INSERT INTO email_accounts (id, name, email_address, oauth_provider, oauth_access_token, oauth_refresh_token, oauth_public_client)
       VALUES ($1, 'Fixture', 'mailbox@example.com', 'microsoft', $2, $3, false)`,
      [ACCOUNT, encrypt('old-access'), encrypt('old-refresh')],
    );
    return readAccount();
  }

  it('keeps the device-code reconnect tokens and public client mode', async () => {
    const account = await insertMicrosoftAccount();
    const provider = holdTokenResponse();
    const pending = refreshMicrosoftToken(account);
    await provider.reached;
    // The update a device-code reconnect commits.
    await state.db.query(
      `UPDATE email_accounts SET oauth_access_token = $2, oauth_refresh_token = $3, oauth_public_client = true,
         oauth_token_expiry = now() + interval '1 hour', oauth_reconnect_required = false WHERE id = $1`,
      [ACCOUNT, encrypt('new-consent-access'), encrypt('new-consent-refresh')],
    );
    provider.respond({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 });
    const result = await pending;

    const stored = await readAccount();
    expect(stored.oauth_public_client).toBe(true);
    expect(decrypt(stored.oauth_access_token)).toBe('new-consent-access');
    expect(decrypt(stored.oauth_refresh_token)).toBe('new-consent-refresh');
    expect(result.oauth_public_client).toBe(true);
    expect(decrypt(result.oauth_access_token)).toBe('new-consent-access');
  });

  it('discards the refresh when a reconnect changed only the client mode', async () => {
    const account = await insertMicrosoftAccount();
    const provider = holdTokenResponse();
    const pending = refreshMicrosoftToken(account);
    await provider.reached;
    // The stored refresh token stays byte-for-byte the same; only the flow changes.
    await state.db.query('UPDATE email_accounts SET oauth_public_client = true WHERE id = $1', [ACCOUNT]);
    provider.respond({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 });
    const result = await pending;

    const stored = await readAccount();
    expect(stored.oauth_public_client).toBe(true);
    expect(stored.oauth_refresh_token).toBe(account.oauth_refresh_token);
    expect(decrypt(stored.oauth_access_token)).toBe('old-access');
    expect(result.oauth_public_client).toBe(true);
  });

  it('fails with a stable code when the mailbox was deleted during the provider call', async () => {
    const account = await insertMicrosoftAccount();
    const provider = holdTokenResponse();
    const pending = refreshMicrosoftToken(account);
    await provider.reached;
    await state.db.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]);
    provider.respond({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 });
    await expect(pending).rejects.toMatchObject({ code: 'account_not_found' });
  });

  it('records the public client mode a self-healed refresh discovered', async () => {
    const account = await insertMicrosoftAccount();
    const secrets = [];
    vi.stubGlobal('fetch', async (_url, options) => {
      secrets.push(options.body.has('client_secret'));
      if (options.body.has('client_secret')) {
        return { ok: false, json: async () => ({ error: 'invalid_client', error_description: 'AADSTS90023: Public clients cannot send a client secret.' }) };
      }
      return { ok: true, json: async () => ({ access_token: 'healed-access', refresh_token: 'healed-refresh', expires_in: 3600 }) };
    });
    const result = await refreshMicrosoftToken(account);

    const stored = await readAccount();
    expect(secrets).toEqual([true, false]);
    expect(result.oauth_public_client).toBe(true);
    expect(stored.oauth_public_client).toBe(true);
    expect(decrypt(stored.oauth_access_token)).toBe('healed-access');
    expect(decrypt(stored.oauth_refresh_token)).toBe('healed-refresh');
  });

  it('saves a refresh that no reconnect raced', async () => {
    const account = await insertMicrosoftAccount();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
    }));
    const result = await refreshMicrosoftToken(account);

    const stored = await readAccount();
    expect(result.oauth_access_token).toBe('refreshed-access');
    expect(stored.oauth_public_client).toBe(false);
    expect(decrypt(stored.oauth_access_token)).toBe('refreshed-access');
    expect(decrypt(stored.oauth_refresh_token)).toBe('rotated-refresh');
  });
});
