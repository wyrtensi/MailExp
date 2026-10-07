import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const registry = vi.hoisted(() => ({
  createGoogleApp: vi.fn(),
  listGoogleApps: vi.fn(),
  getGoogleAppSummary: vi.fn(),
  setGoogleAppStatus: vi.fn(),
  updateGoogleApp: vi.fn(),
  deleteGoogleApp: vi.fn(),
  getEffectiveGoogleRedirectUri: vi.fn(async () => 'https://mail.example.com/oauth/google/callback'),
}));
const redis = vi.hoisted(() => ({
  redisClient: { isOpen: false, connect: vi.fn(async () => {}), quit: vi.fn(async () => {}) },
  countGoogleReservations: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: redis.redisClient }));
vi.mock('../services/oauth/googleAppSelection.js', () => ({ countGoogleReservations: redis.countGoogleReservations }));
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

const APP_ID = '0b9d6c1e-3f4a-4b5c-8d7e-9a0b1c2d3e4f';
const SUMMARY_ROW = {
  id: APP_ID, label: 'Google 1', client_id: '1-a.apps.googleusercontent.com', project_number: '1',
  user_limit: 5, status: 'active', grants_count: 2, accounts_count: 3, gmail_api_disabled_at: null,
  created_at: new Date('2026-09-01T10:00:00Z'),
};
const out = () => console.log.mock.calls.flat().join('\n');
const err = () => console.error.mock.calls.flat().join('\n');

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
  registry.getGoogleAppSummary.mockReset();
  registry.setGoogleAppStatus.mockReset().mockResolvedValue([]);
  registry.updateGoogleApp.mockReset().mockResolvedValue({ id: APP_ID, label: 'L', user_limit: 5 });
  registry.deleteGoogleApp.mockReset().mockResolvedValue(undefined);
  redis.countGoogleReservations.mockReset().mockResolvedValue(2);
  redis.redisClient.connect.mockClear();
  redis.redisClient.quit.mockClear();
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

describe('googleApp.js list --json', () => {
  it('prints the API shape without the Redis-backed fields', async () => {
    registry.listGoogleApps.mockResolvedValue([SUMMARY_ROW]);
    expect(await run(['list', '--json'])).toBe(0);
    const { apps } = JSON.parse(out());
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: APP_ID, clientId: SUMMARY_ROW.client_id, grantsCount: 2, accountsCount: 3 });
    expect(apps[0]).not.toHaveProperty('reservedCount');
    expect(JSON.stringify(apps)).not.toMatch(/secret/i);
  });
});

describe('googleApp.js show', () => {
  it('prints used and free seats, counting in-flight reservations, and closes Redis', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(SUMMARY_ROW);
    expect(await run(['show', APP_ID])).toBe(0);
    expect(redis.countGoogleReservations).toHaveBeenCalledWith(APP_ID);
    expect(redis.redisClient.quit).toHaveBeenCalled();
    expect(out()).toMatch(/used seats:\s+2/);
    expect(out()).toMatch(/free seats:\s+1/);
    expect(out()).toMatch(/mailboxes:\s+3/);
  });

  it('marks an active app as full when seats reach the limit', async () => {
    registry.getGoogleAppSummary.mockResolvedValue({ ...SUMMARY_ROW, user_limit: 4 });
    expect(await run(['show', APP_ID, '--json'])).toBe(0);
    expect(JSON.parse(out()).app).toMatchObject({ full: true, reservedCount: 2, userLimit: 4 });
  });

  it('still answers when Redis is unreachable', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(SUMMARY_ROW);
    redis.redisClient.connect.mockRejectedValueOnce(new Error('down'));
    expect(await run(['show', APP_ID])).toBe(0);
    expect(out()).toMatch(/unavailable/);
    expect(out()).toMatch(/free seats:\s+unknown/);
  });

  it('exits 1 for an unknown app and 2 for a malformed or missing id', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(null);
    expect(await run(['show', APP_ID])).toBe(1);
    expect(err()).toMatch(/app not found/);
    expect(await run(['show', 'nope'])).toBe(2);
    expect(await run(['show'])).toBe(2);
  });
});

describe('googleApp.js enable / close / disable', () => {
  it('maps each command to the status the panel sends', async () => {
    expect(await run(['enable', APP_ID])).toBe(0);
    expect(registry.setGoogleAppStatus).toHaveBeenLastCalledWith(APP_ID, 'active');
    expect(await run(['close', APP_ID])).toBe(0);
    expect(registry.setGoogleAppStatus).toHaveBeenLastCalledWith(APP_ID, 'closed');
    expect(await run(['disable', APP_ID])).toBe(0);
    expect(registry.setGoogleAppStatus).toHaveBeenLastCalledWith(APP_ID, 'disabled');
  });

  it('reports the mailboxes a disable flagged for reconnect', async () => {
    registry.setGoogleAppStatus.mockResolvedValue(['m1', 'm2']);
    expect(await run(['disable', APP_ID])).toBe(0);
    expect(out()).toMatch(/2 mailbox\(es\) flagged for reconnect/);
  });

  it('exits 1 on an unknown app and 2 on a bad id', async () => {
    registry.setGoogleAppStatus.mockRejectedValueOnce(new GoogleAppError('app_not_found'));
    expect(await run(['disable', APP_ID])).toBe(1);
    expect(await run(['disable', 'x'])).toBe(2);
    expect(registry.setGoogleAppStatus).toHaveBeenCalledTimes(1);
  });
});

describe('googleApp.js delete', () => {
  it('requires --yes', async () => {
    expect(await run(['delete', APP_ID])).toBe(2);
    expect(registry.deleteGoogleApp).not.toHaveBeenCalled();
    expect(await run(['delete', APP_ID, '--yes'])).toBe(0);
    expect(registry.deleteGoogleApp).toHaveBeenCalledWith(APP_ID);
  });

  it('is refused while mailboxes are bound, like the panel', async () => {
    registry.deleteGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_in_use'));
    expect(await run(['delete', APP_ID, '--yes'])).toBe(1);
    expect(err()).toMatch(/connected mailboxes/);
  });
});

describe('googleApp.js set-limit / set-label', () => {
  it('updates the limit', async () => {
    expect(await run(['set-limit', APP_ID, '5'])).toBe(0);
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(APP_ID, { userLimit: 5 });
  });

  it('refuses a non-integer limit through the service error', async () => {
    registry.updateGoogleApp.mockRejectedValue(new GoogleAppError('user_limit_invalid'));
    for (const bad of ['abc', '1.5', '']) {
      expect(await run(['set-limit', APP_ID, bad])).toBe(1);
      expect(registry.updateGoogleApp).toHaveBeenLastCalledWith(APP_ID, { userLimit: Number.NaN });
    }
  });

  it('needs both arguments', async () => {
    expect(await run(['set-limit', APP_ID])).toBe(2);
    expect(await run(['set-label', APP_ID])).toBe(2);
  });

  it('updates the label and reports an invalid one', async () => {
    expect(await run(['set-label', APP_ID, 'New name'])).toBe(0);
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(APP_ID, { label: 'New name' });
    registry.updateGoogleApp.mockRejectedValueOnce(new GoogleAppError('label_invalid'));
    expect(await run(['set-label', APP_ID, ' '])).toBe(1);
  });
});

describe('googleApp.js replace-secret', () => {
  it('reads the secret from stdin, trimmed, and never echoes it', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(SUMMARY_ROW);
    expect(await run(['replace-secret', APP_ID], stdinOf('  GOCSPX-new-secret\n'))).toBe(0);
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(APP_ID, { clientSecret: 'GOCSPX-new-secret' });
    expect(out() + err()).not.toMatch(/GOCSPX-new-secret/);
  });

  it('refuses an empty stdin instead of silently keeping the old secret', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(SUMMARY_ROW);
    expect(await run(['replace-secret', APP_ID], stdinOf('  \n'))).toBe(1);
    expect(registry.updateGoogleApp).not.toHaveBeenCalled();
  });

  it('refuses the redaction placeholder and a pasted client JSON', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(SUMMARY_ROW);
    expect(await run(['replace-secret', APP_ID], stdinOf('••••'))).toBe(1);
    expect(await run(['replace-secret', APP_ID], stdinOf(WEB_CLIENT_JSON))).toBe(1);
    expect(registry.updateGoogleApp).not.toHaveBeenCalled();
    expect(err()).not.toMatch(/GOCSPX-secret/);
  });

  it('exits 1 for an unknown app and takes no secret as an argument', async () => {
    registry.getGoogleAppSummary.mockResolvedValue(null);
    expect(await run(['replace-secret', APP_ID], stdinOf('s'))).toBe(1);
    expect(await run(['replace-secret', APP_ID, 'GOCSPX-argv'], stdinOf('s'))).toBe(2);
  });
});

describe('googleApp.js usage', () => {
  it('exits 2 with no command or an unknown one, 0 for --help', async () => {
    expect(await run([])).toBe(2);
    expect(await run(['bogus'])).toBe(2);
    expect(await run(['--help'])).toBe(0);
  });
});
