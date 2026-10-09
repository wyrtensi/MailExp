import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The System Email "Test" button must greet the SMTP server with the same EHLO name as the real
// send (services/mailer.js sends from cfg.fromEmail || cfg.user). A test that said "localhost"
// while the mail says the sender's domain could pass where the send fails, or the reverse.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAdmin: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({
  imapManager: { applySyncSettings: vi.fn(async () => {}), disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null), resolveForConnection: vi.fn(async () => ({ host: '192.0.2.1' })) }));
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
import { createSmtpTransport } from '../services/smtpTransport.js';

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

let verify;
beforeEach(() => {
  verify = vi.fn(async () => true);
  createSmtpTransport.mockReset();
  createSmtpTransport.mockReturnValue({ verify, sendMail: vi.fn() });
});
const withConfig = (cfg) => query.mockResolvedValue({ rows: [{ value: JSON.stringify(cfg) }] });
const test = () => fetch(`${base}/api/admin/system-email/test`, { method: 'POST' });

describe('POST /system-email/test', () => {
  it('verifies with the From address the system mail is sent from', async () => {
    withConfig({ host: 'smtp.example.com', port: 587, user: 'relay-login', pass: 'pw', fromEmail: 'noreply@corp.example' });
    expect((await test()).status).toBe(200);
    expect(verify).toHaveBeenCalledWith('noreply@corp.example');
  });

  it('falls back to the login, as the send does, when no From address is set', async () => {
    withConfig({ host: 'smtp.example.com', port: 587, user: 'relay@corp.example', pass: 'pw' });
    expect((await test()).status).toBe(200);
    expect(verify).toHaveBeenCalledWith('relay@corp.example');
  });
});
