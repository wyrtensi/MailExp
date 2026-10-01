import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ isAdmin: true }));
// The GET /domains admin check reads users.is_admin; every other query answers no rows.
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql) => (sql.includes('is_admin') ? { rows: [{ is_admin: session.isAdmin }] } : { rows: [] })),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
  requireAdmin: (_req, res, next) => (
    session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
vi.mock('../services/mailNode/diskWatch.js', () => ({ DISK_WARN_PERCENT: 85, checkMailNodeDisk: vi.fn(async () => null) }));
const node = vi.hoisted(() => ({ cfg: null }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getMailNodeConfig: vi.fn(async () => node.cfg),
    saveMailNodeConfig: vi.fn(async () => {}),
    listDomains: vi.fn(async () => [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1 }]),
    addDomain: vi.fn(async () => {}),
    listMailboxes: vi.fn(async () => [{ email: 'info@example.com', active: true, quotaMb: 5120, usedBytes: 2048 }]),
    getMailbox: vi.fn(async () => ({ email: 'info@example.com', quotaMb: 5120 })),
    setMailboxQuota: vi.fn(async () => {}),
    getDiskStatus: vi.fn(async () => ({ usedPercent: 90, used: '36G', total: '40G' })),
  };
});
const panel = vi.hoisted(() => ({ rows: [], eop: null, row: null }));
vi.mock('../services/mailNode/domains.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    listDomainRows: vi.fn(async () => panel.rows),
    recordCreatedDomain: vi.fn(async () => {}),
    getDomainRow: vi.fn(async () => panel.row),
    adoptDomain: vi.fn(async () => true),
    confirmStep: vi.fn(async ({ step }) => ({ from: 'node_created', to: step })),
    markReady: vi.fn(async () => ({ from: 'dns_ok', to: 'ready' })),
  };
});
vi.mock('../services/mailNode/eopSettings.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getEopSettings: vi.fn(async () => panel.eop ?? actual.EOP_DEFAULTS),
    saveEopSettings: vi.fn(async () => {}),
  };
});

import express from 'express';
import mailNodeRoutes from './mailNode.js';
import { query } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';
import {
  MailNodeError, addDomain, listDomains, saveMailNodeConfig, setMailboxQuota,
} from '../services/mailNode/mailcow.js';
import { adoptDomain, confirmStep, markReady, recordCreatedDomain } from '../services/mailNode/domains.js';
import { EOP_DEFAULTS, saveEopSettings } from '../services/mailNode/eopSettings.js';

const ID = '77777777-7777-4777-8777-777777777777';
const CFG = { mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 5120, diskPingUrl: null };

describe('/api/mail-node', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail-node', mailNodeRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    session.isAdmin = true;
    node.cfg = CFG;
    panel.rows = [];
    panel.row = { state: 'node_created', nodeCreated: null };
    panel.eop = null;
  });

  const call = (method, path, body) => fetch(`${base}/api/mail-node${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  it('shows the settings to an administrator with the key redacted', async () => {
    const body = await (await call('GET', '/config')).json();
    expect(body).toEqual({ configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '' });
    session.isAdmin = false;
    expect((await call('GET', '/config')).status).toBe(403);
  });

  it('checks the key against the node before saving', async () => {
    node.cfg = null;
    const res = await call('PUT', '/config', { mailHost: 'Mail.Example.com', apiKey: 'new-key', quotaMb: '5120', diskPingUrl: 'https://hc.example.com/p/1' });
    expect(res.status).toBe(200);
    const saved = { mailHost: 'mail.example.com', apiKey: 'new-key', quotaMb: 5120, diskPingUrl: 'https://hc.example.com/p/1' };
    expect(listDomains).toHaveBeenCalledWith(saved);
    expect(saveMailNodeConfig).toHaveBeenCalledWith(saved);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.config_changed',
      details: { settings: 'node', fields: ['mailHost', 'apiKey', 'quotaMb', 'diskPingUrl'] },
    });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain('new-key');
  });

  it('keeps the stored key when the placeholder comes back', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 1024 });
    expect(saveMailNodeConfig).toHaveBeenCalledWith({ mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 1024, diskPingUrl: null });
    // Only the quota changed.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { settings: 'node', fields: ['quotaMb'] } }));
  });

  it('journals nothing when nothing changed', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120 });
    expect(saveMailNodeConfig).toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('asks for the key again when the host changes, so the stored key never goes to a new host', async () => {
    const res = await call('PUT', '/config', { mailHost: 'other.example.net', apiKey: '••••••••' });
    expect((await res.json()).code).toBe('api_key_required');
    expect(listDomains).not.toHaveBeenCalled();
  });

  it('does not save settings the node refuses', async () => {
    listDomains.mockRejectedValueOnce(new MailNodeError('mail_node_auth', 'The mail node refused the API key'));
    const res = await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'wrong' });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mail_node_auth');
    expect(saveMailNodeConfig).not.toHaveBeenCalled();
  });

  it('refuses a bad host, quota, ping URL or a missing first key', async () => {
    expect((await (await call('PUT', '/config', { mailHost: '10.0.0.5', apiKey: 'k' })).json()).code).toBe('mail_host_invalid');
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 0 })).json()).code).toBe('quota_invalid');
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: 'k', diskPingUrl: 'http://x.example' })).json()).code).toBe('ping_url_invalid');
    node.cfg = null;
    expect((await (await call('PUT', '/config', { mailHost: 'mail.example.com' })).json()).code).toBe('api_key_required');
    expect(saveMailNodeConfig).not.toHaveBeenCalled();
  });

  it('shows an administrator every node domain with its onboarding state, unknown without a row', async () => {
    listDomains.mockResolvedValueOnce([
      { domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1 },
      { domain: 'manual.example', active: true, maxMailboxes: 10, mailboxes: 0 },
    ]);
    panel.rows = [{ domain: 'example.com', state: 'dns_ok', origin: 'created', addedAt: 't', addedBy: 'admin@example.com', stateChangedAt: 't', steps: {}, maxMailboxes: 500 }];
    const body = await (await call('GET', '/domains')).json();
    expect(body.domains.map((d) => [d.domain, d.state, d.nextStep])).toEqual([
      ['example.com', 'dns_ok', 'tenant_verified'],
      ['manual.example', 'unknown', null],
    ]);
  });

  it('lists to everyone else only the domains a mailbox can be created on', async () => {
    session.isAdmin = false;
    listDomains.mockResolvedValueOnce([
      { domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1 },
      { domain: 'pending.example', active: true, maxMailboxes: 10, mailboxes: 0 },
      { domain: 'manual.example', active: true, maxMailboxes: 10, mailboxes: 0 },
      { domain: 'off.example', active: false, maxMailboxes: 10, mailboxes: 0 },
      { domain: 'dbeb.example', active: true, maxMailboxes: 10, mailboxes: 0 },
    ]);
    const row = (domain, state) => ({ domain, state, origin: 'created', addedAt: 't', addedBy: null, stateChangedAt: 't', steps: {}, maxMailboxes: 10 });
    panel.rows = [row('example.com', 'ready'), row('pending.example', 'connector_ready'), row('off.example', 'ready'), row('dbeb.example', 'authoritative')];
    const res = await call('GET', '/domains');
    expect(res.status).toBe(200);
    expect((await res.json()).domains).toEqual([
      { domain: 'dbeb.example', active: true, state: 'authoritative' },
      { domain: 'example.com', active: true, state: 'ready' },
    ]);
  });

  it('lets only an administrator add a domain, which starts its onboarding', async () => {
    let res = await call('POST', '/domains', { domain: 'New.Example', mailboxes: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, domain: 'new.example', state: 'node_created' });
    expect(addDomain).toHaveBeenCalledWith(CFG, { domain: 'new.example', mailboxes: 50 });
    expect(recordCreatedDomain).toHaveBeenCalledWith({ domain: 'new.example', userId: 'user-1', maxMailboxes: 50 });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_added', details: { domain: 'new.example', mailboxes: 50 },
    });
    expect((await (await call('POST', '/domains', { domain: 'bad' })).json()).code).toBe('domain_invalid');
    session.isAdmin = false;
    res = await call('POST', '/domains', { domain: 'x.example' });
    expect(res.status).toBe(403);
  });

  it('records no domain the node refused to create', async () => {
    addDomain.mockRejectedValueOnce(new MailNodeError('mail_node_refused', 'The mail node refused: domain_exists'));
    const res = await call('POST', '/domains', { domain: 'example.com' });
    expect(res.status).toBe(502);
    expect(recordCreatedDomain).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('refuses adopt, "Done" and mark ready to a user who is not an administrator', async () => {
    session.isAdmin = false;
    for (const path of ['/domains/example.com/adopt', '/domains/example.com/steps/node_configured', '/domains/example.com/ready']) {
      expect((await call('POST', path)).status, path).toBe(403);
    }
    expect(adoptDomain).not.toHaveBeenCalled();
    expect(confirmStep).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('binds a domain to the node identity it is adopted with', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }]);
    await call('POST', '/domains/example.com/adopt');
    expect(adoptDomain).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1', nodeCreated: '2026-09-30 12:00:00' });
  });

  it('refuses "Done" and mark ready for a row whose domain left the node or was made again there', async () => {
    for (const path of ['/domains/gone.example/steps/node_configured', '/domains/gone.example/ready']) {
      const res = await call('POST', path);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('domain_not_on_node');
    }
    panel.row = { state: 'ready', nodeCreated: '2026-09-01 10:00:00' };
    const remade = [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }];
    listDomains.mockResolvedValueOnce(remade).mockResolvedValueOnce(remade);
    for (const path of ['/domains/example.com/steps/node_configured', '/domains/example.com/ready']) {
      const res = await call('POST', path);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('domain_recreated');
    }
    panel.row = null;
    expect((await (await call('POST', '/domains/example.com/ready')).json()).code).toBe('domain_not_found');
    expect(confirmStep).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('shows a domain made again on the node by hand as unknown, the old row aside', async () => {
    listDomains.mockResolvedValueOnce([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }]);
    panel.rows = [{ domain: 'example.com', state: 'ready', origin: 'created', addedAt: 't', addedBy: null, stateChangedAt: 't', steps: {}, maxMailboxes: 500, nodeCreated: '2026-09-01 10:00:00' }];
    const [domain] = (await (await call('GET', '/domains')).json()).domains;
    expect(domain).toMatchObject({ domain: 'example.com', state: 'unknown', recreated: true, nextStep: null });
    session.isAdmin = false;
    listDomains.mockResolvedValueOnce([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }]);
    expect((await (await call('GET', '/domains')).json()).domains).toEqual([]);
  });

  it('adopts a node domain the panel does not know, journaled', async () => {
    let res = await call('POST', '/domains/Example.com/adopt');
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com', state: 'node_created' });
    expect(adoptDomain).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1', nodeCreated: undefined });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_adopted',
      details: { domain: 'example.com', state: 'node_created', origin: 'adopted' },
    });
    res = await call('POST', '/domains/elsewhere.example/adopt');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('domain_not_on_node');
    adoptDomain.mockResolvedValueOnce(false);
    res = await call('POST', '/domains/example.com/adopt');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('domain_known');
    expect((await (await call('POST', '/domains/bad/adopt')).json()).code).toBe('domain_invalid');
    session.isAdmin = false;
    expect((await call('POST', '/domains/example.com/adopt')).status).toBe(403);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('confirms the next step with "Done" and journals the state change', async () => {
    const res = await call('POST', '/domains/example.com/steps/node_configured');
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com', state: 'node_configured' });
    expect(confirmStep).toHaveBeenCalledWith({ domain: 'example.com', step: 'node_configured', userId: 'user-1' });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_state_changed',
      details: { domain: 'example.com', from: 'node_created', to: 'node_configured', how: 'step_confirmed' },
    });
  });

  it('answers the state machine refusals with their codes and journals none', async () => {
    const cases = [['step_out_of_order', 409], ['step_invalid', 400], ['domain_not_found', 404]];
    for (const [code, status] of cases) {
      confirmStep.mockResolvedValueOnce({ error: code });
      const res = await call('POST', '/domains/example.com/steps/dns_ok');
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
    markReady.mockResolvedValueOnce({ error: 'domain_already_ready' });
    const res = await call('POST', '/domains/example.com/ready');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('domain_already_ready');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('marks a domain ready by hand, journaled, for administrators only', async () => {
    const res = await call('POST', '/domains/example.com/ready');
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com', state: 'ready' });
    expect(markReady).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1' });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_state_changed',
      details: { domain: 'example.com', from: 'dns_ok', to: 'ready', how: 'marked_ready' },
    });
    session.isAdmin = false;
    expect((await call('POST', '/domains/example.com/ready')).status).toBe(403);
    expect((await call('POST', '/domains/example.com/steps/dns_ok')).status).toBe(403);
  });

  describe('EOP settings', () => {
    const TENANT = '11111111-2222-4333-8444-555555555555';

    it('shows the defaults to an administrator only: mailcow signs, 50 messages an hour', async () => {
      const body = await (await call('GET', '/eop')).json();
      expect(body).toEqual({ ...EOP_DEFAULTS, dkimMode: 'mailcow', sendLimitPerHour: 50, tenantConfigured: false, tenantDriverActive: false });
      session.isAdmin = false;
      expect((await call('GET', '/eop')).status).toBe(403);
      expect((await call('PUT', '/eop', { dkimMode: 'eop' })).status).toBe(403);
    });

    it('saves checked settings and journals the names of the fields that changed', async () => {
      const res = await call('PUT', '/eop', {
        eopHost: 'Contoso-com.mail.protection.outlook.com', certificateHost: 'mail.example.com', dkimMode: 'mailcow',
        sendLimitPerHour: '50', terrl: '48248', tenantId: TENANT, appId: '', certThumbprint: '',
      });
      expect(res.status).toBe(200);
      const saved = {
        eopHost: 'contoso-com.mail.protection.outlook.com', certificateHost: 'mail.example.com', dkimMode: 'mailcow',
        sendLimitPerHour: 50, terrl: 48248, tenantId: TENANT, appId: null, certThumbprint: null,
      };
      expect(saveEopSettings).toHaveBeenCalledWith(saved);
      expect(await res.json()).toEqual({ ...saved, tenantConfigured: false, tenantDriverActive: false });
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', action: 'mail_node.config_changed',
        details: { settings: 'eop', fields: ['eopHost', 'certificateHost', 'terrl', 'tenantId'] },
      });
    });

    it('refuses a bad value before saving anything', async () => {
      for (const [body, code] of [
        [{ eopHost: '10.0.0.1' }, 'eop_host_invalid'],
        [{ dkimMode: 'both' }, 'dkim_mode_invalid'],
        [{ sendLimitPerHour: 0 }, 'send_limit_invalid'],
        [{ terrl: 'many' }, 'terrl_invalid'],
        [{ tenantId: 'contoso' }, 'tenant_id_invalid'],
        [{ certThumbprint: 'abc' }, 'thumbprint_invalid'],
      ]) {
        const res = await call('PUT', '/eop', body);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe(code);
      }
      expect(saveEopSettings).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  it('lists the mailboxes MailExpert made with usage and the disk reading', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, email_address: 'Info@example.com' }, { id: 'other', email_address: 'gone@example.com' }] });
    const body = await (await call('GET', '/mailboxes')).json();
    expect(body.disk).toEqual({ usedPercent: 90, used: '36G', total: '40G', warn: true });
    expect(body.mailboxes).toEqual([
      { accountId: ID, email: 'Info@example.com', onNode: true, active: true, quotaMb: 5120, usedBytes: 2048 },
      { accountId: 'other', email: 'gone@example.com', onNode: false, active: false, quotaMb: null, usedBytes: null },
    ]);
  });

  it('changes the quota of a mail node mailbox only, journaled with the quota before', async () => {
    query.mockResolvedValueOnce({ rows: [{ email_address: 'info@example.com' }] });
    let res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 10240 });
    expect(res.status).toBe(200);
    expect(setMailboxQuota).toHaveBeenCalledWith(CFG, 'info@example.com', 10240);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', accountId: ID, action: 'mailbox.quota_changed', details: { quotaMb: 10240, from: 5120 },
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    query.mockResolvedValueOnce({ rows: [] });
    res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 10240 });
    expect(res.status).toBe(404);
    res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 999999 });
    expect((await res.json()).code).toBe('quota_invalid');
  });
});
