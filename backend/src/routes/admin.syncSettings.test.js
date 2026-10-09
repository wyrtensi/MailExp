import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { applySyncSettings: vi.fn(async () => {}), disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({ ...(await importOriginal()), createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: '00000000-0000-0000-0000-00000000000a', username: 'admin@example.com' };
    next();
  });
  app.use('/api/admin', adminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// system_settings as a map: written by the key/value upsert, read back by loadSyncSettings.
const stored = new Map();
beforeEach(() => {
  stored.clear();
  query.mockReset();
  imapManager.applySyncSettings.mockClear();
  query.mockImplementation(async (sql, params = []) => {
    if (/INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)/.test(sql)) {
      stored.set(params[0], params[1]);
      return { rows: [] };
    }
    if (sql.includes('FROM system_settings WHERE key = ANY')) {
      return { rows: params[0].filter((key) => stored.has(key)).map((key) => ({ key, value: stored.get(key) })) };
    }
    return { rows: [] };
  });
});

const patch = (body) => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('PATCH /api/admin/settings mailbox sync intervals', () => {
  it('stores both intervals and applies them to the running mailboxes', async () => {
    expect(await patch({ sync_interval_sec: 30, folder_sync_interval_sec: 0 })).toEqual({ status: 200, body: { ok: true } });
    expect(Object.fromEntries(stored)).toEqual({ sync_interval_sec: '30', folder_sync_interval_sec: '0' });
    expect(imapManager.applySyncSettings).toHaveBeenCalledWith({ syncIntervalSec: 30, folderSyncIntervalSec: 0 });
  });

  it('changes one interval and keeps the other', async () => {
    stored.set('folder_sync_interval_sec', '3600');
    expect((await patch({ sync_interval_sec: '120' })).status).toBe(200);
    expect(imapManager.applySyncSettings).toHaveBeenCalledWith({ syncIntervalSec: 120, folderSyncIntervalSec: 3600 });
  });

  it('rejects values the settings screen does not offer before writing anything', async () => {
    for (const body of [{ sync_interval_sec: 45 }, { folder_sync_interval_sec: 'never' }, { sync_interval_sec: 30, folder_sync_interval_sec: 61 }]) {
      expect(await patch(body)).toMatchObject({ status: 400, body: { code: 'invalid_field' } });
    }
    expect(stored.size).toBe(0);
    expect(imapManager.applySyncSettings).not.toHaveBeenCalled();
  });

  it('leaves mailbox timers alone when no interval is sent', async () => {
    expect((await patch({ registration_open: true })).status).toBe(200);
    expect(imapManager.applySyncSettings).not.toHaveBeenCalled();
  });
});
