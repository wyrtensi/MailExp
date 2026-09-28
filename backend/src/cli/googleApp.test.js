import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const registry = vi.hoisted(() => ({
  createGoogleApp: vi.fn(),
  listGoogleApps: vi.fn(),
  getEffectiveGoogleRedirectUri: vi.fn(async () => 'https://mail.example.com/oauth/google/callback'),
}));
vi.mock('../services/oauth/googleApps.js', () => {
  class GoogleAppError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return { ...registry, GoogleAppError };
});
vi.mock('../services/db.js', () => ({ pool: { end: vi.fn(async () => {}) } }));

const { run } = await import('./googleApp.js');
const { GoogleAppError } = await import('../services/oauth/googleApps.js');

function stdinOf(text) {
  return Readable.from([text]);
}

const CREATED_ROW = {
  id: 'app-1', label: 'my-project-123', client_id: '123-abc.apps.googleusercontent.com', user_limit: 100,
};

const WEB_CLIENT_JSON = JSON.stringify({
  web: {
    client_id: '123-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-secret',
    project_id: 'my-project-123',
    redirect_uris: ['https://mail.example.com/oauth/google/callback'],
  },
});

beforeEach(() => {
  registry.createGoogleApp.mockReset().mockResolvedValue(CREATED_ROW);
  registry.listGoogleApps.mockReset();
  registry.getEffectiveGoogleRedirectUri.mockReset().mockResolvedValue('https://mail.example.com/oauth/google/callback');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('googleApp.js add', () => {
  it('creates an app from stdin JSON, defaulting the label to the project id and the limit to 100', async () => {
    const code = await run(['add'], stdinOf(WEB_CLIENT_JSON));
    expect(code).toBe(0);
    expect(registry.createGoogleApp).toHaveBeenCalledWith({
      label: 'my-project-123', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', userLimit: 100,
    });
  });

  it('accepts --label and --user-limit', async () => {
    const code = await run(['add', '--label', 'My App', '--user-limit', '25'], stdinOf(WEB_CLIENT_JSON));
    expect(code).toBe(0);
    expect(registry.createGoogleApp).toHaveBeenCalledWith(expect.objectContaining({ label: 'My App', userLimit: 25 }));
  });

  it('rejects a non-numeric or non-positive --user-limit without reading stdin', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      registry.createGoogleApp.mockClear();
      const code = await run(['add', '--user-limit', bad], stdinOf(WEB_CLIENT_JSON));
      expect(code).toBe(1);
      expect(registry.createGoogleApp).not.toHaveBeenCalled();
    }
  });

  it('rejects an unknown flag or a flag missing its value', async () => {
    expect(await run(['add', '--bogus', 'x'], stdinOf(WEB_CLIENT_JSON))).toBe(1);
    expect(await run(['add', '--label'], stdinOf(WEB_CLIENT_JSON))).toBe(1);
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
  });

  it('exits 1 with no secret printed on a service-account key', async () => {
    const errorSpy = console.error;
    const code = await run(['add'], stdinOf(JSON.stringify({ type: 'service_account', private_key: 'super-secret-key' } )));
    expect(code).toBe(1);
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(' ')).not.toMatch(/super-secret-key/);
  });

  it('exits 1 on a desktop (installed) client', async () => {
    const code = await run(['add'], stdinOf(JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } })));
    expect(code).toBe(1);
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
  });

  it('exits 1 on malformed JSON', async () => {
    const code = await run(['add'], stdinOf('not json'));
    expect(code).toBe(1);
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
  });

  it('exits 1 and reports a registry error (e.g. a duplicate project) without throwing', async () => {
    registry.createGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_same_project'));
    const code = await run(['add'], stdinOf(WEB_CLIENT_JSON));
    expect(code).toBe(1);
  });

  it('warns when the imported redirect URIs are missing the panel callback, and exits 0', async () => {
    const json = JSON.stringify({ web: { client_id: 'x', client_secret: 'y', project_id: 'p' } });
    const code = await run(['add'], stdinOf(json));
    expect(code).toBe(0);
    expect(console.warn.mock.calls.flat().join(' ')).toMatch(/redirect URI/);
  });

  it('warns that no callback is configured yet when the panel has none', async () => {
    registry.getEffectiveGoogleRedirectUri.mockResolvedValue(null);
    const code = await run(['add'], stdinOf(WEB_CLIENT_JSON));
    expect(code).toBe(0);
    expect(console.warn.mock.calls.flat().join(' ')).toMatch(/no Google callback URL/);
  });
});

describe('googleApp.js list', () => {
  it('prints each app on its own line', async () => {
    registry.listGoogleApps.mockResolvedValue([
      { id: 'a1', status: 'active', label: 'Google 1', client_id: '1-a.apps.googleusercontent.com', user_limit: 100 },
    ]);
    const code = await run(['list']);
    expect(code).toBe(0);
    expect(console.log.mock.calls.flat().join(' ')).toMatch(/Google 1/);
  });

  it('says when there are none', async () => {
    registry.listGoogleApps.mockResolvedValue([]);
    const code = await run(['list']);
    expect(code).toBe(0);
    expect(console.log.mock.calls.flat().join(' ')).toMatch(/no Google apps/);
  });
});

describe('googleApp.js usage', () => {
  it('exits 2 with no command or an unknown one, 0 for --help', async () => {
    expect(await run([])).toBe(2);
    expect(await run(['bogus'])).toBe(2);
    expect(await run(['--help'])).toBe(0);
  });
});
