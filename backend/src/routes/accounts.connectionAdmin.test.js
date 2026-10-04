import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Probe: the server settings of a mailbox (where it connects, how it signs in) are an
// administrator's to change. A signed-in user who is not one gets a 403 and nothing is written or
// reconnected, so the stored password or OAuth token is never sent to a host they chose.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
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
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { recordAudit } from '../services/auditLog.js';

const ID = '77777777-7777-4777-8777-777777777777';
const STORED = {
  id: ID, protocol: 'imap', enabled: true, mail_node: false, email_address: 'team@example.com', oauth_provider: 'microsoft',
  imap_host: 'outlook.office365.com', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
  smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  auth_user: 'team@example.com', auth_pass: null, smtp_auth_user: null, smtp_auth_pass: null,
};

let isAdmin;
let stored;
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'user-1' }; next(); });
  app.use('/api/accounts', accountRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  isAdmin = false;
  stored = { ...STORED };
  query.mockReset().mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT id, disabled_at FROM users')) return { rows: [{ id: 'user-1', disabled_at: null }] };
    if (sql.startsWith('SELECT is_admin, disabled_at FROM users')) return { rows: [{ is_admin: isAdmin, disabled_at: null }] };
    if (sql.includes('SET oauth_subject = NULL')) return { rows: stored.oauth_provider ? [{ id: ID, oauth_provider: stored.oauth_provider }] : [] };
    if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [stored] };
    if (sql === 'SELECT * FROM email_accounts WHERE id = $1') return { rows: [stored] };
    return { rows: [] };
  });
});

const put = (body) => fetch(`${base}/api/accounts/${ID}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const wrote = () => query.mock.calls.some(([sql]) => /^\s*UPDATE email_accounts/.test(sql));
// The reconnect chain is queued after the response: give it a turn before asserting it never ran.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

describe('server settings of a mailbox are admin-only', () => {
  it.each([
    [{ imap_host: 'imap.attacker.example' }],
    [{ imap_port: 143 }],
    [{ imap_skip_tls_verify: true }],
    [{ smtp_host: 'smtp.attacker.example' }],
    [{ smtp_port: 465 }],
    [{ smtp_tls: 'SSL' }],
    [{ auth_user: 'someone@example.com' }],
    [{ auth_pass: 'secret' }],
    [{ smtp_auth_user: 'relay@example.com' }],
    [{ smtp_auth_pass: 'secret' }],
    [{ name: 'Renamed', imap_host: 'imap.attacker.example' }],
  ])('refuses %o from a user who is not an administrator, and reconnects nothing', async (body) => {
    const res = await put(body);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('connection_admin_only');
    await settle();
    expect(wrote()).toBe(false);
    expect(pluginRegistry.collectHook).not.toHaveBeenCalled();
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('lets a user who is not an administrator edit the other fields, and drops resent server values', async () => {
    const res = await put({
      name: 'Team', color: '#000000', signature: null, sort_order: 2, folder_mappings: { spam: 'Junk' },
      imap_host: 'outlook.office365.com', imap_port: '993', imap_skip_tls_verify: false,
      smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    });
    expect(res.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => /^\s*UPDATE email_accounts/.test(sql))[0];
    expect(update).toMatch(/name = .*color = .*sort_order = .*folder_mappings = .*signature = /);
    expect(update).not.toMatch(/imap_|smtp_|auth_/);
    await settle();
    // Unchanged server values do not start a reconnect.
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('lets an administrator change them, and reconnects with the new settings', async () => {
    isAdmin = true;
    const res = await put({ imap_host: 'imap.example.net' });
    expect(res.status).toBe(200);
    expect(wrote()).toBe(true);
    await settle();
    expect(imapManager.connectAccount).toHaveBeenCalled();
  });

  it('treats a disabled administrator as not one', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT is_admin, disabled_at FROM users')) return { rows: [{ is_admin: true, disabled_at: new Date() }] };
      if (sql.startsWith('SELECT id, disabled_at FROM users')) return { rows: [{ id: 'user-1', disabled_at: null }] };
      if (sql === 'SELECT * FROM email_accounts WHERE id = $1') return { rows: [stored] };
      return { rows: [] };
    });
    expect((await put({ imap_host: 'imap.example.net' })).status).toBe(403);
  });

  it('gives plugins a frozen copy of the update', async () => {
    isAdmin = true;
    await put({ name: 'Team' });
    const [, ctx] = pluginRegistry.collectHook.mock.calls[0];
    expect(Object.isFrozen(ctx.updates)).toBe(true);
  });
});

describe('resetting the OAuth binding of a mailbox', () => {
  const reset = () => fetch(`${base}/api/accounts/${ID}/oauth-subject/reset`, { method: 'POST' });

  it('is refused to a user who is not an administrator', async () => {
    expect((await reset()).status).toBe(403);
    expect(query.mock.calls.some(([sql]) => sql.includes('oauth_subject = NULL'))).toBe(false);
  });

  it('clears the subject of a Google or Microsoft mailbox and journals it', async () => {
    isAdmin = true;
    expect((await reset()).status).toBe(200);
    const [sql] = query.mock.calls.find(([q]) => q.includes('oauth_subject = NULL'));
    expect(sql).toMatch(/oauth_provider IN \('google', 'microsoft'\) AND mail_node IS NOT TRUE/);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', accountId: ID, action: 'mailbox.oauth_subject_reset', details: { oauthProvider: 'microsoft' },
    });
  });

  it('answers 404 for a mailbox without OAuth', async () => {
    isAdmin = true;
    stored = { ...STORED, oauth_provider: null };
    expect((await reset()).status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
