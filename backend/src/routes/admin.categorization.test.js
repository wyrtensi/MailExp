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
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';

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
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const stored = new Map();
beforeEach(() => {
  stored.clear();
  query.mockReset();
  invalidateGlobalCategorizationCache.mockClear();
  query.mockImplementation(async (sql, params = []) => {
    if (/INSERT INTO system_settings \(key, value, updated_at\) VALUES \(\$1, \$2, NOW\(\)\)/.test(sql)) {
      stored.set(params[0], params[1]);
    }
    return { rows: [] };
  });
});

const patch = (body) => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

describe('PATCH /api/admin/settings categorization', () => {
  it('switches categorization for the whole install', async () => {
    expect(await patch({ categorization_enabled: true })).toEqual({ status: 200, body: { ok: true } });
    expect(Object.fromEntries(stored)).toEqual({ categorization_enabled: 'true' });
    expect(invalidateGlobalCategorizationCache).toHaveBeenCalledTimes(1);
  });

  it('rejects anything but a boolean before writing', async () => {
    expect(await patch({ categorization_enabled: 'yes', registration_open: true })).toMatchObject({ status: 400, body: { code: 'invalid_field' } });
    expect(stored.size).toBe(0);
    expect(invalidateGlobalCategorizationCache).not.toHaveBeenCalled();
  });
});
