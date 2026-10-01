import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-2' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    clearConnectCooldown: vi.fn(),
    isConnecting: vi.fn(() => false),
    connectAccount: vi.fn(() => Promise.resolve(true)),
    disconnectAccount: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';

const ID = '66666666-6666-4666-8666-666666666666';
const STORED = {
  id: ID, protocol: 'pop3', enabled: true, email_address: 'team@example.com', oauth_provider: null,
  imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
  smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  auth_user: 'team@example.com', auth_pass: 'enc:old', smtp_auth_user: null, smtp_auth_pass: null,
};

let stored;
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
  stored = { ...STORED };
  query.mockReset().mockImplementation(async (sql) => {
    if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ ...STORED }] };
    if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [stored] };
    if (sql === 'SELECT id, email_address, mail_node, imap_host, oauth_provider, oauth_refresh_token, oauth_access_token FROM email_accounts WHERE id = $1') {
      return { rows: stored ? [{ id: ID, email_address: stored.email_address, mail_node: false, oauth_provider: stored.oauth_provider ?? null, oauth_refresh_token: null, oauth_access_token: null }] : [] };
    }
    if (sql === 'SELECT * FROM email_accounts WHERE id = $1') return { rows: stored ? [stored] : [] };
    return { rows: [] };
  });
});

const send = (method, path, body) => fetch(`${base}/api/accounts${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('mailbox actions are journaled', () => {
  it('records a new mailbox', async () => {
    const res = await send('POST', '', { name: 'Team', email_address: 'team@example.com', protocol: 'pop3' });
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-2', accountId: ID, action: 'mailbox.added', details: { protocol: 'pop3', oauthProvider: null },
    });
  });

  it('records nothing when the settings form saves unchanged server fields', async () => {
    const res = await send('PUT', `/${ID}`, {
      name: 'Renamed', color: '#000000', signature: null, imap_host: 'imap.example.com', imap_port: '993',
      imap_skip_tls_verify: false, smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    });
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('records the names of changed connection fields without their values', async () => {
    const res = await send('PUT', `/${ID}`, { imap_host: 'mail.example.net', imap_port: 143, auth_pass: 'new-secret', smtp_auth_pass: '' });
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'imap_port', 'imap_tls', 'auth_pass'] } },
    ]);
    expect(JSON.stringify(recordAudit.mock.calls)).not.toMatch(/new-secret|mail\.example\.net|143/);
  });

  it('records a cleared stored password as a change', async () => {
    stored = { ...STORED, smtp_auth_pass: 'enc:smtp' };
    await send('PUT', `/${ID}`, { smtp_auth_pass: '' });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['smtp_auth_pass'] } },
    ]);
  });

  it('records disabling and enabling only when the state changes', async () => {
    await send('PUT', `/${ID}`, { enabled: true });
    expect(recordAudit).not.toHaveBeenCalled();

    await send('PUT', `/${ID}`, { enabled: false, auth_user: 'other@example.com' });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.connection_changed', details: { fields: ['auth_user'] } },
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.disabled', details: {} },
    ]);

    recordAudit.mockClear();
    stored = { ...STORED, enabled: false };
    await send('PUT', `/${ID}`, { enabled: true });
    expect(recordAudit).toHaveBeenCalledWith([
      { actorUserId: 'user-2', accountId: ID, action: 'mailbox.enabled', details: {} },
    ]);
  });

  it('records a deleted mailbox by address after the row is gone', async () => {
    const res = await send('DELETE', `/${ID}`);
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-2', accountEmail: 'team@example.com', action: 'mailbox.deleted', details: { mailNode: false },
    });
    const deleteOrder = query.mock.invocationCallOrder[query.mock.calls.findIndex(([sql]) => sql === 'DELETE FROM email_accounts WHERE id = $1')];
    expect(recordAudit.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
  });

  it('records nothing for a mailbox that does not exist', async () => {
    stored = null;
    expect((await send('DELETE', `/${ID}`)).status).toBe(404);
    expect((await send('PUT', `/${ID}`, { enabled: false })).status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
