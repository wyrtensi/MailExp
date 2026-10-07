import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
// The account row and its second sender name are written in one transaction on the same mock.
vi.mock('../services/db.js', () => {
  const query = vi.fn();
  return { query, withTransaction: vi.fn(async (fn) => fn({ query })) };
});
// Every request runs as an ordinary signed-in user: the domain mailbox is open to everyone.
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => false,
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
    deleteMailbox: vi.fn(async () => ({ warnings: [] })),
    listAliasesTo: vi.fn(async () => []),
    getMailbox: vi.fn(async () => null),
    // The read-only filter of a mailbox pending deletion (mailboxActions.js closeLocalDelivery).
    listMailboxFilters: vi.fn(async () => []),
    addMailboxFilter: vi.fn(async () => {}),
    deleteMailboxFilters: vi.fn(async () => {}),
  };
});
// The pending deletion of a node mailbox (services/mailNode/mailboxDeletion.js, covered against
// PGlite there): here only what the routes ask of it.
vi.mock('../services/mailNode/mailboxDeletion.js', () => ({
  requestDeletion: vi.fn(async () => ({ deleteAfter: '2026-10-06T10:00:00.000Z', days: 5 })),
  cancelDeletion: vi.fn(async () => ({ deleteAfter: '2026-10-06T10:00:00.000Z', reason: 'Left the company' })),
}));
// The EOP seats (services/mailNode/eopSeats.js, covered against PGlite there): a seat is free
// unless a test says otherwise.
const seats = vi.hoisted(() => ({ free: true }));
vi.mock('../services/mailNode/eopSeats.js', () => ({
  reserveSeat: vi.fn(async () => (seats.free ? { assignmentId: 1, seat: 1 } : { error: 'no_free_seats' })),
  confirmSeat: vi.fn(async () => {}),
  dropPendingSeat: vi.fn(async () => {}),
  getHoldDays: vi.fn(async () => 90),
  seatSupply: vi.fn(async () => ({ purchased: 10 })),
}));
// Deactivation and activation (covered against PGlite in mailboxActions.seats.pglite.test.js): only
// the routes' own checks are asserted here.
vi.mock('../services/mailNode/mailboxActions.js', async (importActual) => ({
  ...(await importActual()),
  deactivateNodeMailbox: vi.fn(async () => ({ account: { id: '77777777-7777-4777-8777-777777777777', mail_node: true, deactivated_at: '2026-10-07T00:00:00.000Z' } })),
  activateNodeMailbox: vi.fn(async () => ({ error: 'no_free_seats' })),
}));
// The send limit a new mailbox gets (services/mailNode/nodeApply.js, covered against PGlite there).
vi.mock('../services/mailNode/nodeApply.js', () => ({ newMailboxRateLimit: vi.fn(async () => ({ value: 50, frame: 'h' })) }));
// The panel's onboarding state of each domain: only ready (and authoritative) ones take mailboxes.
const domainStates = vi.hoisted(() => new Map());
vi.mock('../services/mailNode/domains.js', async (importActual) => ({
  ...(await importActual()),
  getDomainRow: vi.fn(async (domain) => (domainStates.has(domain) ? { state: domainStates.get(domain), nodeCreated: '2026-09-01 10:00:00' } : null)),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { recordAudit } from '../services/auditLog.js';
import { cancelDeletion, requestDeletion } from '../services/mailNode/mailboxDeletion.js';
import {
  MailNodeError, deleteMailbox, listAliasesTo, listDomains, provisionMailbox,
} from '../services/mailNode/mailcow.js';

const ID = '77777777-7777-4777-8777-777777777777';
const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, deleteAfterDays: 5 };

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
    seats.free = true;
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
    expect(provisionMailbox).toHaveBeenCalledWith(CFG, {
      localPart: 'info', domain: 'example.com', name: 'Info desk', rateLimit: { value: 50, frame: 'h' },
    });
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

  it('refuses with no_free_seats (409) without asking the node', async () => {
    seats.free = false;
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com', senderName: 'Info' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_free_seats');
    expect(provisionMailbox).not.toHaveBeenCalled();
  });

  it('lets only administrators deactivate and activate', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}/deactivation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'r' }),
    });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/api/accounts/${ID}/deactivation`, { method: 'DELETE' })).status).toBe(403);
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

  it('creates a mailbox on a ready domain whose node creation time differs: that only warns administrators', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'example.com', active: true, created: '2026-09-30 08:00:00' }]);
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(200);
    expect(provisionMailbox).toHaveBeenCalledTimes(1);
  });

  it('creates a mailbox on a ready domain the node lists without a creation time', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'example.com', active: true, created: null }]);
    expect((await post({ kind: 'domain', localPart: 'info', domain: 'example.com' })).status).toBe(200);
  });

  it('refuses a mailbox while the node cannot be read, without writing anything', async () => {
    listDomains.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mail_node_unreachable');
    expect(provisionMailbox).not.toHaveBeenCalled();
    expect(inserted).toBeNull();
  });

  it('refuses an address the node holds as a disabled mailbox, with its own code', async () => {
    provisionMailbox.mockRejectedValueOnce(new MailNodeError('mailbox_disabled_on_node', 'The mail node has a disabled mailbox with this address: delete it in mailcow first', 409));
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('mailbox_disabled_on_node');
    expect(inserted).toBeNull();
  });

  it('creates a mailbox on an authoritative domain too', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'dbeb.example', active: true }]);
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'dbeb.example' });
    expect(res.status).toBe(200);
    expect(provisionMailbox).toHaveBeenCalledWith(CFG, {
      localPart: 'info', domain: 'dbeb.example', name: 'info@dbeb.example', rateLimit: { value: 50, frame: 'h' },
    });
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

  it('deletes the new mailbox again when the account row cannot be written', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO email_accounts')) throw new Error('db down');
      return { rows: [] };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
    errorSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(deleteMailbox).toHaveBeenCalledWith(CFG, 'info@example.com');
  });

  it('leaves a mailbox it took over active when the row cannot be written, so a retry takes it over again', async () => {
    let failInsert = true;
    const baseline = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO email_accounts') && failInsert) throw new Error('db down');
      return baseline(sql, params);
    });
    provisionMailbox.mockResolvedValue({ email: 'desk@example.com', password: 'p', reused: true });
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let res = await post({ kind: 'domain', localPart: 'desk', domain: 'example.com' });
      errorSpy.mockRestore();
      expect(res.status).toBe(500);
      // Nothing undone on the node: no delete, and the mailbox is not disabled either.
      expect(deleteMailbox).not.toHaveBeenCalled();
      failInsert = false;
      res = await post({ kind: 'domain', localPart: 'desk', domain: 'example.com' });
      expect(res.status).toBe(200);
      expect(provisionMailbox).toHaveBeenCalledTimes(2);
    } finally {
      provisionMailbox.mockReset().mockImplementation(async (_cfg, { localPart, domain }) => ({
        email: `${localPart}@${domain}`, password: 'generated-password', reused: false,
      }));
    }
  });

  describe('DELETE and the pending deletion of a node mailbox', () => {
    const del = () => fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });
    const askDelete = (body) => fetch(`${base}/api/accounts/${ID}/deletion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const cancel = () => fetch(`${base}/api/accounts/${ID}/deletion`, { method: 'DELETE' });

    const ROW = { id: ID, email_address: 'Info@example.com', mail_node: true, imap_host: 'mail.example.com' };
    // extra: the row after the action; before: what the action finds when it locks the row.
    const nodeRow = (extra = {}, before = {}) => query.mockImplementation(async (sql) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{ ...ROW, ...(extra.imap_host ? { imap_host: extra.imap_host } : {}), ...before }] };
      return sql.startsWith('SELECT id, email_address, mail_node') || sql.startsWith('SELECT * FROM email_accounts')
        ? { rows: [{ ...ROW, ...extra }] }
        : { rows: [] };
    });
    const rowDeleted = () => query.mock.calls.some(([sql]) => sql.startsWith('DELETE'));

    it('never removes a node mailbox at once: its deletion has to be asked for', async () => {
      nodeRow();
      const res = await del();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('mail_node_deletion_request_required');
      expect(deleteMailbox).not.toHaveBeenCalled();
      expect(rowDeleted()).toBe(false);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('lets an ordinary user ask to delete a node mailbox with its address typed and a reason, journaled with both', async () => {
      nodeRow({ delete_after: '2026-10-06T10:00:00.000Z', deletion_reason: 'Left the company' });
      const res = await askDelete({ email: ' info@EXAMPLE.com ', reason: '  Left the company  ' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: ID, delete_after: '2026-10-06T10:00:00.000Z', deletion_reason: 'Left the company' });
      expect(requestDeletion).toHaveBeenCalledWith(expect.objectContaining({ accountId: ID, userId: 'user-1', reason: 'Left the company', holdDays: 90 }));
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', accountId: ID, action: 'mailbox.deletion_requested',
        details: { mailNode: true, deleteAfter: '2026-10-06T10:00:00.000Z', days: 5, reason: 'Left the company' },
      });
      // Nothing is asked of the node now: the mailbox keeps working until its date.
      expect(deleteMailbox).not.toHaveBeenCalled();
      expect(rowDeleted()).toBe(false);
    });

    it('refuses the request without the full address, without a reason or with a reason too long', async () => {
      nodeRow();
      const cases = [
        [{ email: 'info@example', reason: 'r' }, 'confirmation_mismatch'],
        [{ reason: 'r' }, 'confirmation_mismatch'],
        [{ email: 'info@example.com' }, 'deletion_reason_required'],
        [{ email: 'info@example.com', reason: '   ' }, 'deletion_reason_required'],
        [{ email: 'info@example.com', reason: 'x'.repeat(501) }, 'deletion_reason_too_long'],
      ];
      for (const [body, code] of cases) {
        const res = await askDelete(body);
        expect(res.status, code).toBe(400);
        expect((await res.json()).code).toBe(code);
      }
      expect(requestDeletion).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('keeps line breaks of the reason, drops invisible format characters and turns other control characters into spaces', async () => {
      nodeRow();
      await askDelete({ email: 'info@example.com', reason: 'Closed\r\nby\u0007 order‮​ done\rok' });
      expect(requestDeletion).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Closed\nby  order done\nok' }));
    });

    it('refuses the request up front without the mail node, or for a mailbox on another host', async () => {
      node.cfg = null;
      nodeRow();
      let res = await askDelete({ email: 'info@example.com', reason: 'r' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('mail_node_not_configured');
      node.cfg = CFG;
      nodeRow({ imap_host: 'old-node.example.com' });
      res = await askDelete({ email: 'info@example.com', reason: 'r' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('mail_node_host_mismatch');
      expect(requestDeletion).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses a request for another mailbox, an unknown one and one already pending', async () => {
      nodeRow({ mail_node: false });
      let res = await askDelete({ email: 'info@example.com', reason: 'r' });
      expect((await res.json()).code).toBe('not_mail_node');
      query.mockImplementation(async () => ({ rows: [] }));
      res = await askDelete({ email: 'info@example.com', reason: 'r' });
      expect(res.status).toBe(404);
      nodeRow();
      requestDeletion.mockResolvedValueOnce({ error: 'deletion_already_requested' });
      res = await askDelete({ email: 'info@example.com', reason: 'r' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('deletion_already_requested');
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('lets anyone cancel a pending deletion, journaled with the date and reason it had', async () => {
      nodeRow();
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(cancelDeletion).toHaveBeenCalledWith(expect.objectContaining({ accountId: ID, purchased: 10 }));
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', accountId: ID, action: 'mailbox.deletion_cancelled',
        details: { mailNode: true, deleteAfter: '2026-10-06T10:00:00.000Z', reason: 'Left the company' },
      });
      for (const [code, status] of [['deletion_not_requested', 409], ['deletion_in_progress', 409], ['account_not_found', 404]]) {
        cancelDeletion.mockResolvedValueOnce({ error: code });
        const refused = await cancel();
        expect(refused.status).toBe(status);
        expect((await refused.json()).code).toBe(code);
      }
      expect(recordAudit).toHaveBeenCalledTimes(1);
    });

    it('refuses to create the address again while its mailbox is pending deletion', async () => {
      query.mockImplementation(async (sql) => (
        sql.includes('lower(email_address)') ? { rows: [{ delete_after: '2026-10-06T10:00:00.000Z' }] } : { rows: [] }
      ));
      const res = await post({ kind: 'domain', localPart: 'info', domain: 'example.com' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('mailbox_pending_deletion');
      expect(provisionMailbox).not.toHaveBeenCalled();
    });

    it('lists the node aliases that deliver to the mailbox and the days before it goes, for the confirmation', async () => {
      listAliasesTo.mockResolvedValueOnce([{ address: 'sales@example.com', onlyTarget: true }]);
      nodeRow();
      let res = await fetch(`${base}/api/accounts/${ID}/node-aliases`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ aliases: [{ address: 'sales@example.com', onlyTarget: true }], deleteAfterDays: 5 });
      expect(listAliasesTo).toHaveBeenCalledWith(CFG, 'Info@example.com');
      nodeRow({ imap_host: 'old-node.example.com' });
      res = await fetch(`${base}/api/accounts/${ID}/node-aliases`);
      expect((await res.json()).code).toBe('mail_node_host_mismatch');
      nodeRow({ mail_node: false });
      res = await fetch(`${base}/api/accounts/${ID}/node-aliases`);
      expect(res.status).toBe(404);
      nodeRow();
      listAliasesTo.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
      res = await fetch(`${base}/api/accounts/${ID}/node-aliases`);
      expect(res.status).toBe(502);
      expect(listAliasesTo).toHaveBeenCalledTimes(2);
    });

    it('removes any other mailbox at once, without calling the node', async () => {
      query.mockImplementation(async (sql) => (
        sql.startsWith('SELECT id, email_address, mail_node')
          ? { rows: [{ id: ID, email_address: 'x@gmail.com', mail_node: false }] }
          : { rows: [] }
      ));
      const res = await del();
      expect(res.status).toBe(200);
      expect(deleteMailbox).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(true);
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mailbox.deleted', details: { mailNode: false } }));
      // Asking to delete it later is for node mailboxes only.
      expect((await (await askDelete({ email: 'x@gmail.com', reason: 'r' })).json()).code).toBe('not_mail_node');
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

    it('refuses to disable a mail node mailbox: it is deleted instead', async () => {
      for (const enabled of [false, 0]) {
        const res = await put({ enabled });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('mail_node_disable_unsupported');
      }
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('lets a mail node mailbox paused before stay paused or be resumed', async () => {
      query.mockImplementation(async () => ({ rows: [{ ...STORED, enabled: false }] }));
      expect((await put({ enabled: false })).status).toBe(200);
      expect((await put({ enabled: true })).status).toBe(200);
    });

    it('still lets any other mailbox be disabled', async () => {
      query.mockImplementation(async () => ({ rows: [{ ...STORED, mail_node: false, enabled: true }] }));
      const res = await put({ enabled: false });
      expect(res.status).toBe(200);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(true);
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
