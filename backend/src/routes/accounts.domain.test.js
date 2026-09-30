import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
// The account row and its second sender name are written in one transaction on the same mock.
vi.mock('../services/db.js', () => {
  const query = vi.fn();
  return { query, withTransaction: vi.fn(async (fn) => fn({ query })) };
});
// Every request runs as an ordinary signed-in user: the domain mailbox is open to everyone.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res) => res.status(403).json({ error: 'Admin access required' }),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn(() => Promise.resolve(true)),
    disconnectAccount: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));
const node = vi.hoisted(() => ({ cfg: null }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getMailNodeConfig: vi.fn(async () => node.cfg),
    listDomains: vi.fn(async () => [{ domain: 'example.com', active: true }, { domain: 'off.example', active: false }]),
    provisionMailbox: vi.fn(async (_cfg, { localPart, domain }) => ({
      email: `${localPart}@${domain}`, password: 'generated-password', reused: false,
    })),
    disableMailbox: vi.fn(async () => {}),
    getMailbox: vi.fn(async () => null),
  };
});
// The panel's onboarding state of each domain: only ready (and authoritative) ones take mailboxes.
const domainStates = vi.hoisted(() => new Map());
vi.mock('../services/mailNode/domains.js', async (importActual) => ({
  ...(await importActual()),
  getDomainState: vi.fn(async (domain) => domainStates.get(domain) ?? null),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { recordAudit } from '../services/auditLog.js';
import { MailNodeError, disableMailbox, getMailbox, listDomains, provisionMailbox } from '../services/mailNode/mailcow.js';

const ID = '77777777-7777-4777-8777-777777777777';
const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 };

describe('domain mailboxes in /api/accounts', () => {
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

  let inserted;
  let aliasInserted;
  beforeEach(() => {
    vi.clearAllMocks();
    node.cfg = CFG;
    domainStates.clear();
    domainStates.set('example.com', 'ready').set('off.example', 'ready').set('dbeb.example', 'authoritative').set('pending.example', 'connector_ready');
    inserted = null;
    aliasInserted = null;
    query.mockReset().mockImplementation(async (sql, params) => {
      if (sql.includes('lower(email_address)')) return { rows: [] };
      if (sql.includes('INSERT INTO email_accounts')) {
        inserted = { sql, params };
        return { rows: [{ id: ID, email_address: params[2], name: params[1], protocol: 'imap', mail_node: true, auth_pass: params[4], sender_name: params[5] }] };
      }
      if (sql.includes('INSERT INTO account_aliases')) {
        aliasInserted = params;
        return { rows: [{ id: 'alias-1', name: params[1], email: params[2], reply_to: null, signature: null }] };
      }
      return { rows: [] };
    });
  });

  const post = (body) => fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('lets an ordinary user create one; the server sets host, ports and password', async () => {
    const res = await post({
      kind: 'domain', localPart: 'Info', domain: 'example.com', name: 'Info desk',
      // Connection fields from the body must not reach the account.
      imap_host: 'evil.example.net', smtp_host: 'evil.example.net', auth_pass: 'chosen',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: ID, email_address: 'info@example.com', mail_node: true });
    expect(JSON.stringify(body)).not.toContain('generated-password');
    expect(provisionMailbox).toHaveBeenCalledWith(CFG, { localPart: 'info', domain: 'example.com', name: 'Info desk' });
    expect(inserted.params).toEqual(['user-1', 'Info desk', 'info@example.com', 'mail.example.com', 'enc:generated-password', null]);
    expect(aliasInserted).toBeNull();
    expect(body.aliases).toEqual([]);
    expect(inserted.sql).toContain("993,true,false,$4,587,'STARTTLS'");
    expect(JSON.stringify(inserted.params)).not.toContain('evil');
    expect(imapManager.connectAccount).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mailbox.added', details: expect.objectContaining({ mailNode: true }),
    }));
  });

  it('sends under the sender name, and the second name becomes an alias with the same address', async () => {
    const res = await post({
      kind: 'domain', localPart: 'sales', domain: 'example.com', name: 'Sales desk',
      senderName: ' Иван Петров ', senderNameAlt: 'Ivan Petrov',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(inserted.params[5]).toBe('Иван Петров');
    expect(inserted.sql).toContain('sender_name');
    expect(aliasInserted).toEqual([ID, 'Ivan Petrov', 'sales@example.com']);
    expect(body.sender_name).toBe('Иван Петров');
    expect(body.aliases).toEqual([expect.objectContaining({ name: 'Ivan Petrov', email: 'sales@example.com' })]);
  });

  it('refuses a sender name that would add a header, before touching mailcow', async () => {
    const res = await post({ kind: 'domain', localPart: 'sales', domain: 'example.com', senderName: 'Sales\r\nBcc: x@evil.example' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('sender_name_invalid');
    expect(provisionMailbox).not.toHaveBeenCalled();
  });

  it('keeps manual server setup behind the admin check', async () => {
    const res = await post({ name: 'x', email_address: 'x@example.com', imap_host: 'imap.example.com' });
    expect(res.status).toBe(403);
  });

  it('refuses without a mail node, before touching mailcow', async () => {
    node.cfg = null;
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('mail_node_not_configured');
    expect(provisionMailbox).not.toHaveBeenCalled();
  });

  it('refuses a domain that has not finished its onboarding, or one the panel does not know, before touching mailcow', async () => {
    for (const domain of ['pending.example', 'other.example']) {
      const res = await post({ kind: 'domain', localPart: 'info', domain });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('domain_not_ready');
    }
    expect(listDomains).not.toHaveBeenCalled();
    expect(provisionMailbox).not.toHaveBeenCalled();
  });

  it('creates a mailbox on an authoritative domain too', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'dbeb.example', active: true }]);
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'dbeb.example' });
    expect(res.status).toBe(200);
    expect(provisionMailbox).toHaveBeenCalledWith(CFG, { localPart: 'info', domain: 'dbeb.example', name: 'info@dbeb.example' });
  });

  it('refuses a bad local part, a ready domain the node lacks or has inactive, and an address already added', async () => {
    let res = await post({ kind: 'domain', localPart: 'a b', domain: 'example.com' });
    expect((await res.json()).code).toBe('local_part_invalid');
    domainStates.set('other.example', 'ready');
    res = await post({ kind: 'domain', localPart: 'info', domain: 'other.example' });
    expect((await res.json()).code).toBe('domain_unknown');
    res = await post({ kind: 'domain', localPart: 'info', domain: 'off.example' });
    expect((await res.json()).code).toBe('domain_unknown');
    query.mockImplementation(async (sql) => (sql.includes('lower(email_address)') ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('mailbox_exists');
    expect(provisionMailbox).not.toHaveBeenCalled();
  });

  it('answers 502 with the node message when mailcow refuses', async () => {
    provisionMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: max_mailbox_exceeded'));
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The mail node refused: max_mailbox_exceeded', code: 'mail_node_refused' });
    expect(inserted).toBeNull();
  });

  it('disables the new mailbox again when the account row cannot be written', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO email_accounts')) throw new Error('db down');
      return { rows: [] };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    errorSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(disableMailbox).toHaveBeenCalledWith(CFG, 'info@example.com');
  });

  describe('DELETE', () => {
    const del = () => fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });

    it('disables a mail node mailbox on the node, then deletes the row', async () => {
      const order = [];
      disableMailbox.mockImplementationOnce(async () => { order.push('disable'); });
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT id, email_address, mail_node')) return { rows: [{ id: ID, email_address: 'info@example.com', mail_node: true }] };
        if (sql.startsWith('DELETE')) order.push('delete');
        return { rows: [] };
      });
      const res = await del();
      expect(res.status).toBe(200);
      expect(disableMailbox).toHaveBeenCalledWith(CFG, 'info@example.com');
      expect(order).toEqual(['disable', 'delete']);
    });

    it('keeps the row when the node cannot disable the mailbox', async () => {
      disableMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)'));
      query.mockImplementation(async (sql) => (
        sql.startsWith('SELECT id, email_address, mail_node')
          ? { rows: [{ id: ID, email_address: 'info@example.com', mail_node: true }] }
          : { rows: [] }
      ));
      const res = await del();
      expect(res.status).toBe(502);
      expect((await res.json()).code).toBe('mail_node_unreachable');
      expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    });

    it('deletes the row when the node refuses because the mailbox is gone', async () => {
      disableMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: access_denied'));
      getMailbox.mockResolvedValueOnce(null);
      query.mockImplementation(async (sql) => (
        sql.startsWith('SELECT id, email_address, mail_node')
          ? { rows: [{ id: ID, email_address: 'info@example.com', mail_node: true }] }
          : { rows: [] }
      ));
      const res = await del();
      expect(res.status).toBe(200);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(true);
    });

    it('keeps the row when the node refuses and the mailbox is still there', async () => {
      disableMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: something'));
      getMailbox.mockResolvedValueOnce({ email: 'info@example.com', active: true });
      query.mockImplementation(async (sql) => (
        sql.startsWith('SELECT id, email_address, mail_node')
          ? { rows: [{ id: ID, email_address: 'info@example.com', mail_node: true }] }
          : { rows: [] }
      ));
      const res = await del();
      expect(res.status).toBe(502);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    });

    it('deletes any other mailbox without calling the node', async () => {
      query.mockImplementation(async (sql) => (
        sql.startsWith('SELECT id, email_address, mail_node')
          ? { rows: [{ id: ID, email_address: 'x@gmail.com', mail_node: false }] }
          : { rows: [] }
      ));
      const res = await del();
      expect(res.status).toBe(200);
      expect(disableMailbox).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(true);
    });
  });

  describe('PUT', () => {
    const STORED = {
      id: ID, email_address: 'info@example.com', mail_node: true, name: 'Info',
      imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
      smtp_host: 'mail.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
      auth_user: 'info@example.com', auth_pass: 'enc:generated-password', smtp_auth_user: null, smtp_auth_pass: null,
    };
    const put = (body) => fetch(`${base}/api/accounts/${ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    beforeEach(() => {
      query.mockImplementation(async (sql) => (sql.startsWith('SELECT * FROM email_accounts') ? { rows: [STORED] } : { rows: [STORED] }));
    });

    it('refuses to point a mail node mailbox at another server or change its login', async () => {
      for (const change of [{ imap_host: 'evil.example.net' }, { smtp_host: 'evil.example.net' }, { auth_user: 'x' }, { auth_pass: 'x' }]) {
        const res = await put(change);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('mail_node_connection_locked');
      }
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });

    it('accepts the form resending the unchanged server settings with a new name', async () => {
      const res = await put({
        name: 'Info desk', imap_host: 'mail.example.com', imap_port: 993, imap_skip_tls_verify: false,
        smtp_host: 'mail.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
      });
      expect(res.status).toBe(200);
    });
  });
});
