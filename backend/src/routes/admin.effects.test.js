import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The admin_effects job the panel CLI queues runs in the backend with the admin routes' own hooks
// (ADMIN_EFFECT_HOOKS): registered at startup through registerAdminEffectsJob, it signs users out,
// asks for the Access sync and reloads what the process keeps in memory, process.env included.

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { applySyncSettings: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => String(v).replace(/^enc:/, ''), isEncrypted: (v) => String(v).startsWith('enc:') }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn(async () => {}) }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../services/accessSync/index.js', () => ({
  requestAccessSync: vi.fn(), runAccessSyncNow: vi.fn(), withAccessSyncLock: vi.fn((op) => op()),
}));

const { query } = await import('../services/db.js');
const { destroyUserSessions } = await import('./auth.js');
const { closeUserSockets } = await import('../services/websocket.js');
const { pluginRegistry } = await import('../plugins/registry.js');
const { requestAccessSync } = await import('../services/accessSync/index.js');
const { reloadAuthSettings } = await import('../services/authLimiter.js');
const { jobKind, unregisterJobKind } = await import('../services/jobQueue.js');
const { ADMIN_EFFECTS_JOB_KIND } = await import('../services/admin/adminEffects.js');
const { ADMIN_EFFECT_HOOKS, registerAdminEffectsJob } = await import('./admin.js');

const USER_ID = '00000000-0000-0000-0000-00000000000b';
const MS_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(MS_KEYS.map((key) => [key, process.env[key]]));
  vi.clearAllMocks();
});
afterEach(() => {
  for (const key of MS_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  unregisterJobKind(ADMIN_EFFECTS_JOB_KIND);
});

const runHandler = (effects) => jobKind(ADMIN_EFFECTS_JOB_KIND).handler({ id: 1, payload: { effects } }, {});

describe('the admin_effects job in the backend', () => {
  it('is registered at startup with the routes\' hooks', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8');
    expect(source).toMatch(/^registerAdminEffectsJob\(\);$/m);
    expect(source).toMatch(/import adminRoutes, \{ registerAdminEffectsJob \} from '\.\/routes\/admin\.js';/);
  });

  it('signs the user out, cleans up and asks for the Access sync', async () => {
    registerAdminEffectsJob();
    await runHandler({ signOut: [USER_ID], userDeleted: [USER_ID], accessSync: 'user_deleted', reload: ['auth_limits'] });
    expect(destroyUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(closeUserSockets).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(pluginRegistry.runHook).toHaveBeenCalledWith('onUserDelete', { userId: USER_ID });
    expect(requestAccessSync).toHaveBeenCalledWith('user_deleted');
    expect(reloadAuthSettings).toHaveBeenCalled();
  });

  it('reloads the Microsoft client into process.env, clearing a field the row no longer has', async () => {
    registerAdminEffectsJob();
    Object.assign(process.env, { MS_CLIENT_ID: 'old-id', MS_CLIENT_SECRET: 'old-secret', MS_TENANT_ID: 'old-tenant', MS_REDIRECT_URI: 'https://old/cb' });
    query.mockResolvedValueOnce({ rows: [{ config: { clientId: 'new-id', clientSecret: 'enc:new-secret', tenantId: '' } }] });
    await runHandler({ reload: ['microsoft'] });
    expect(process.env.MS_CLIENT_ID).toBe('new-id');
    expect(process.env.MS_CLIENT_SECRET).toBe('new-secret');
    expect(process.env.MS_TENANT_ID).toBeUndefined();
    expect(process.env.MS_REDIRECT_URI).toBeUndefined();

    query.mockResolvedValueOnce({ rows: [] });
    await ADMIN_EFFECT_HOOKS.reload.microsoft();
    for (const key of MS_KEYS) expect(process.env[key]).toBeUndefined();
  });
});
