import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// Stands in for the real requireAdmin (which checks the users table): flip `session.isAdmin`
// to run a request as an ordinary signed-in user.
const session = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => !!session.isAdmin,
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res, next) => (
    session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
vi.mock('../index.js', () => ({
  imapManager: { connectAccount: vi.fn(() => Promise.resolve(true)) },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '77777777-7777-4777-8777-777777777777';
const BODY = {
  name: 'Team', email_address: 'team@example.com', protocol: 'imap',
  imap_host: 'imap.example.com', imap_port: 993, smtp_host: 'smtp.example.com', smtp_port: 587,
  auth_user: 'team@example.com', auth_pass: 'secret',
};

// Setting up a server by hand is an admin task until PR 9 adds the domain mailbox kind; everyone
// else adds Gmail through the Google flow.
describe('POST /api/accounts (manual server setup)', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    session.isAdmin = true;
    query.mockReset().mockResolvedValue({ rows: [{ id: ID, protocol: 'imap', email_address: BODY.email_address }] });
  });

  const post = (body) => fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('refuses an ordinary user without touching the database', async () => {
    session.isAdmin = false;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('lets an administrator add a mailbox, which keeps the default rfc threading', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    const [sql] = query.mock.calls.find(([s]) => /INSERT INTO email_accounts/.test(s));
    expect(sql).not.toMatch(/thread_mode/);
  });
});
