import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
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
    providerIdBackfillStates: vi.fn(async () => new Map()),
    threadRecomputeStates: vi.fn(async () => new Map()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '66666666-6666-4666-8666-666666666666';

// Mailboxes belong to the install: whoever is signed in lists, changes and deletes all of them,
// and a new mailbox only remembers who added it.
describe('mailboxes are shared by every user', () => {
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
    query.mockReset().mockImplementation(async () => ({ rows: [{ id: ID, protocol: 'pop3' }] }));
  });

  const ownerFilters = () => query.mock.calls.filter(([sql]) => /user_id/.test(sql));

  it('lists every mailbox', async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toMatch(/FROM email_accounts\s+ORDER BY sort_order, created_at/);
    expect(query.mock.calls[0][1]).toBeUndefined();
    expect(ownerFilters()).toEqual([]);
  });

  it('records who added a mailbox', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team', email_address: 'team@example.com', protocol: 'pop3' }),
    });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls.find(([s]) => /INSERT INTO email_accounts/.test(s));
    expect(sql).toMatch(/INSERT INTO email_accounts \(\s*added_by, name/);
    expect(params[0]).toBe('user-2');
  });

  it('deletes a mailbox someone else added', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      'SELECT id, email_address, mail_node, oauth_provider, oauth_refresh_token, oauth_access_token FROM email_accounts WHERE id = $1',
      [ID]
    );
    expect(query).toHaveBeenCalledWith('DELETE FROM email_accounts WHERE id = $1', [ID]);
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ID);
    expect(ownerFilters()).toEqual([]);
  });

  it('checks aliases against the mailbox only', async () => {
    await fetch(`${base}/api/accounts/${ID}/aliases/${ID}`, { method: 'DELETE' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE a\.id = \$1 AND e\.id = \$2/);
    expect(params).toEqual([ID, ID]);
  });
});
