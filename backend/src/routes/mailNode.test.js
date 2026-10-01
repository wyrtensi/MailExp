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
    setMailboxRateLimit: vi.fn(async (_cfg, emails) => ({ done: emails, failed: [], reason: null })),
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
    restartOnboarding: vi.fn(async () => ({ from: 'ready', to: 'node_created' })),
    acknowledgeNodeIdentity: vi.fn(async ({ nodeCreated }) => ({ from: '2026-09-01 10:00:00', to: nodeCreated })),
  };
});
const applied = vi.hoisted(() => ({
  domain: (domain) => ({ at: '2026-10-01T10:00:00.000Z', domain, items: [{ item: 'dkim', target: domain, status: 'ok' }], dkim: null }),
}));
vi.mock('../services/mailNode/nodeApply.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    applyNode: vi.fn(async () => ({ at: '2026-10-01T10:00:00.000Z', node: [{ item: 'prefilter', target: null, status: 'ok' }], domains: [] })),
    applyDomain: vi.fn(async ({ domain }) => applied.domain(domain)),
    applyPrefilter: vi.fn(async () => ({ item: 'prefilter', target: null, status: 'changed', at: '2026-10-01T10:00:00.000Z' })),
    getNodeApplyResult: vi.fn(async () => null),
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
  MailNodeError, addDomain, listDomains, saveMailNodeConfig, setMailboxQuota, setMailboxRateLimit,
} from '../services/mailNode/mailcow.js';
import { applyDomain, applyNode, applyPrefilter, getNodeApplyResult } from '../services/mailNode/nodeApply.js';
import {
  acknowledgeNodeIdentity, adoptDomain, confirmStep, markReady, recordCreatedDomain, restartOnboarding,
} from '../services/mailNode/domains.js';
import { EOP_DEFAULTS, saveEopSettings } from '../services/mailNode/eopSettings.js';

const ID = '77777777-7777-4777-8777-777777777777';
const CFG = { mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 5120, diskPingUrl: null, deleteAfterDays: 5, panelIps: [] };

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

  // An apply started after the answer (applyInBackground) runs on the next turn of the event loop.
  const settled = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

  const call = (method, path, body) => fetch(`${base}/api/mail-node${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  it('shows the settings to an administrator with the key redacted', async () => {
    const body = await (await call('GET', '/config')).json();
    expect(body).toEqual({
      configured: true, mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, diskPingUrl: '', deleteAfterDays: 5, panelIps: [],
    });
    session.isAdmin = false;
    expect((await call('GET', '/config')).status).toBe(403);
  });

  it('checks the key against the node before saving', async () => {
    node.cfg = null;
    const res = await call('PUT', '/config', { mailHost: 'Mail.Example.com', apiKey: 'new-key', quotaMb: '5120', diskPingUrl: 'https://hc.example.com/p/1' });
    expect(res.status).toBe(200);
    const saved = { mailHost: 'mail.example.com', apiKey: 'new-key', quotaMb: 5120, diskPingUrl: 'https://hc.example.com/p/1', deleteAfterDays: 5, panelIps: [] };
    expect(listDomains).toHaveBeenCalledWith(saved);
    expect(saveMailNodeConfig).toHaveBeenCalledWith(saved);
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.config_changed',
      details: { settings: 'node', fields: ['mailHost', 'apiKey', 'quotaMb', 'diskPingUrl', 'deleteAfterDays', 'panelIps'] },
    });
    // A new node gets the panel's settings right after the answer.
    await settled();
    expect(applyNode).toHaveBeenCalledWith({ userId: 'user-1', trigger: 'node_settings' });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain('new-key');
  });

  it('keeps the stored key when the placeholder comes back', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 1024 });
    expect(saveMailNodeConfig).toHaveBeenCalledWith({
      mailHost: 'mail.example.com', apiKey: 'stored-key', quotaMb: 1024, diskPingUrl: null, deleteAfterDays: 5, panelIps: [],
    });
    // Only the quota changed, which the node settings do not hold: nothing is applied.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { settings: 'node', fields: ['quotaMb'] } }));
    expect(applyNode).not.toHaveBeenCalled();
  });

  it('saves the days a mailbox keeps working after its deletion is asked for, 1 to 90', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, deleteAfterDays: '14' });
    expect(saveMailNodeConfig).toHaveBeenCalledWith(expect.objectContaining({ deleteAfterDays: 14 }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { settings: 'node', fields: ['deleteAfterDays'] } }));
    for (const bad of [0, 91, 'x', 2.5]) {
      const res = await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', deleteAfterDays: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('delete_after_days_invalid');
    }
    expect(saveMailNodeConfig).toHaveBeenCalledTimes(1);
  });

  it('journals nothing when nothing changed', async () => {
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120 });
    expect(saveMailNodeConfig).toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('keeps the panel addresses for the fail2ban whitelist and applies them to the node', async () => {
    const res = await call('PUT', '/config', {
      mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120, panelIps: '203.0.113.10, 2001:DB8::/64\n203.0.113.10',
    });
    expect(await res.json()).toEqual({ ok: true, applying: true });
    expect(saveMailNodeConfig).toHaveBeenCalledWith(expect.objectContaining({ panelIps: ['203.0.113.10', '2001:db8::/64'] }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { settings: 'node', fields: ['panelIps'] } }));
    await settled();
    expect(applyNode).toHaveBeenCalledWith({ userId: 'user-1', trigger: 'node_settings' });
    // Left out, the stored addresses stay.
    node.cfg = { ...CFG, panelIps: ['203.0.113.10'] };
    await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', quotaMb: 5120 });
    expect(saveMailNodeConfig).toHaveBeenLastCalledWith(expect.objectContaining({ panelIps: ['203.0.113.10'] }));
    for (const bad of ['mail.example.com', '0.0.0.0/0', '10.0.0.0/16', '2001:db8::/32', '::/0', '203.0.113.10/33', 'x/24']) {
      const refused = await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', panelIps: bad });
      expect(refused.status, bad).toBe(400);
      expect((await refused.json()).code).toBe('panel_ips_invalid');
    }
    expect(saveMailNodeConfig).toHaveBeenCalledTimes(2);
  });

  it('answers the save without waiting for the apply, which may fail on its own', async () => {
    let finish;
    applyNode.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = reject; }));
    const res = await call('PUT', '/config', { mailHost: 'mail.example.com', apiKey: '••••••••', panelIps: '203.0.113.10' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applying: true });
    expect(saveMailNodeConfig).toHaveBeenCalled();
    await settled();
    expect(applyNode).toHaveBeenCalledTimes(1);
    finish(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
    await settled();
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
    expect(await res.json()).toEqual({ ok: true, domain: 'new.example', state: 'node_created', apply: applied.domain('new.example') });
    // mailcow signs by default: the domain gets a 2048-bit key with selector "dkim".
    expect(addDomain).toHaveBeenCalledWith(CFG, { domain: 'new.example', mailboxes: 50, dkimKeySize: 2048 });
    expect(applyDomain).toHaveBeenCalledWith({ domain: 'new.example', userId: 'user-1', trigger: 'domain_added' });
    expect(recordCreatedDomain).toHaveBeenCalledWith({ domain: 'new.example', userId: 'user-1', maxMailboxes: 50 });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_added', details: { domain: 'new.example', mailboxes: 50 },
    });
    expect((await (await call('POST', '/domains', { domain: 'bad' })).json()).code).toBe('domain_invalid');
    session.isAdmin = false;
    res = await call('POST', '/domains', { domain: 'x.example' });
    expect(res.status).toBe(403);
  });

  it('makes a new domain without a DKIM key when the tenant signs', async () => {
    panel.eop = { ...EOP_DEFAULTS, dkimMode: 'eop' };
    await call('POST', '/domains', { domain: 'tenant.example', mailboxes: 10 });
    expect(addDomain).toHaveBeenCalledWith(CFG, { domain: 'tenant.example', mailboxes: 10, dkimKeySize: 0 });
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

  it('refuses "Done" and mark ready for a row whose domain the node does not list', async () => {
    for (const path of ['/domains/gone.example/steps/node_configured', '/domains/gone.example/ready']) {
      const res = await call('POST', path);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('domain_not_on_node');
    }
    panel.row = null;
    expect((await (await call('POST', '/domains/example.com/ready')).json()).code).toBe('domain_not_found');
    expect(confirmStep).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('moves a domain whose node creation time differs: that is a warning, not a refusal', async () => {
    panel.row = { state: 'dns_ok', nodeCreated: '2026-09-01 10:00:00' };
    const remade = [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }];
    listDomains.mockResolvedValueOnce(remade).mockResolvedValueOnce(remade);
    expect((await call('POST', '/domains/example.com/steps/tenant_verified')).status).toBe(200);
    expect((await call('POST', '/domains/example.com/ready')).status).toBe(200);
    expect(confirmStep).toHaveBeenCalledTimes(1);
    expect(markReady).toHaveBeenCalledTimes(1);
  });

  it('refuses "Done" and mark ready without touching the row while the node cannot be read', async () => {
    listDomains.mockRejectedValue(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)'));
    try {
      for (const path of ['/domains/example.com/steps/node_configured', '/domains/example.com/ready', '/domains/example.com/acknowledge']) {
        const res = await call('POST', path, { created: '2026-09-30 12:00:00' });
        expect(res.status, path).toBe(502);
        expect((await res.json()).code).toBe('mail_node_unreachable');
      }
    } finally {
      listDomains.mockReset().mockResolvedValue([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1 }]);
    }
    expect(confirmStep).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
    expect(acknowledgeNodeIdentity).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('keeps the state of a domain made again on the node by hand and warns the administrator', async () => {
    const remade = [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }];
    listDomains.mockResolvedValueOnce(remade);
    panel.rows = [{ domain: 'example.com', state: 'ready', origin: 'created', addedAt: 't', addedBy: null, stateChangedAt: 't', steps: {}, maxMailboxes: 500, nodeCreated: '2026-09-01 10:00:00' }];
    const [domain] = (await (await call('GET', '/domains')).json()).domains;
    expect(domain).toMatchObject({
      domain: 'example.com', state: 'ready', recreated: true, nodeCreated: '2026-09-01 10:00:00', created: '2026-09-30 12:00:00',
    });
    session.isAdmin = false;
    listDomains.mockResolvedValueOnce(remade);
    expect((await (await call('GET', '/domains')).json()).domains).toEqual([{ domain: 'example.com', active: true, state: 'ready' }]);
    expect(query.mock.calls.some(([sql]) => /UPDATE|DELETE|INSERT/.test(sql))).toBe(false);
  });

  describe('when the node fails', () => {
    const rows = [
      { domain: 'example.com', state: 'ready', origin: 'created', addedAt: 't', addedBy: null, stateChangedAt: 't', steps: {}, maxMailboxes: 500, nodeCreated: '2026-09-01 10:00:00' },
      { domain: 'pending.example', state: 'dns_ok', origin: 'created', addedAt: 't', addedBy: null, stateChangedAt: 't', steps: {}, maxMailboxes: 10, nodeCreated: null },
    ];
    const writes = () => query.mock.calls.filter(([sql]) => /UPDATE|DELETE|INSERT/.test(sql));

    for (const [name, err] of [
      ['unreachable', new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)')],
      ['answering an error', new MailNodeError('mail_node_failed', 'The mail node answered HTTP 500')],
      ['refusing the key', new MailNodeError('mail_node_auth', 'The mail node refused the API key')],
    ]) {
      it(`shows an administrator every known domain with its state and the node ${name}, changing nothing`, async () => {
        listDomains.mockRejectedValueOnce(err);
        panel.rows = rows;
        const res = await call('GET', '/domains');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.node).toEqual({ error: err.message, code: err.code });
        expect(body.domains.map((d) => [d.domain, d.state, d.onNode])).toEqual([
          ['example.com', 'ready', null], ['pending.example', 'dns_ok', null],
        ]);
        expect(writes()).toEqual([]);
      });
    }

    it('answers everyone else with the node error: no mailbox can be created then', async () => {
      session.isAdmin = false;
      listDomains.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)'));
      panel.rows = rows;
      const res = await call('GET', '/domains');
      expect(res.status).toBe(502);
      expect((await res.json()).code).toBe('mail_node_unreachable');
      expect(writes()).toEqual([]);
    });

    it('shows every known domain, not an empty list, when the node lists none or only some', async () => {
      panel.rows = rows;
      listDomains.mockResolvedValueOnce([]);
      let body = await (await call('GET', '/domains')).json();
      expect(body.domains.map((d) => [d.domain, d.state, d.onNode])).toEqual([
        ['example.com', 'ready', false], ['pending.example', 'dns_ok', false],
      ]);
      listDomains.mockResolvedValueOnce([{ domain: 'pending.example', active: true, maxMailboxes: 10, mailboxes: 0 }]);
      body = await (await call('GET', '/domains')).json();
      expect(body.domains.map((d) => [d.domain, d.state, d.onNode])).toEqual([
        ['example.com', 'ready', false], ['pending.example', 'dns_ok', true],
      ]);
      expect(writes()).toEqual([]);
    });
  });

  it('restarts a domain\'s onboarding, journaled with the steps it cleared, for administrators only and without asking the node', async () => {
    node.cfg = null;
    const cleared = { ready: { at: 't', userId: 'u', email: 'admin@example.com', markedReady: true } };
    restartOnboarding.mockResolvedValueOnce({ from: 'ready', to: 'node_created', steps: cleared });
    const res = await call('POST', '/domains/Example.com/restart');
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com', state: 'node_created', apply: applied.domain('example.com') });
    expect(restartOnboarding).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1' });
    expect(listDomains).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_state_changed',
      details: { domain: 'example.com', from: 'ready', to: 'node_created', how: 'restarted', steps: cleared },
    });
    restartOnboarding.mockResolvedValueOnce({ error: 'domain_not_found' });
    expect((await call('POST', '/domains/missing.example/restart')).status).toBe(404);
    restartOnboarding.mockResolvedValueOnce({ error: 'domain_nothing_to_restart' });
    const nothing = await call('POST', '/domains/example.com/restart');
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).code).toBe('domain_nothing_to_restart');
    expect((await (await call('POST', '/domains/bad/restart')).json()).code).toBe('domain_invalid');
    session.isAdmin = false;
    expect((await call('POST', '/domains/example.com/restart')).status).toBe(403);
    expect(restartOnboarding).toHaveBeenCalledTimes(3);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    // The settings are applied again only for the domain that did start over.
    expect(applyDomain).toHaveBeenCalledTimes(1);
    expect(applyDomain).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1', trigger: 'onboarding_restarted' });
  });

  it('accepts the creation time the administrator saw and the node still reports, journaled with both times', async () => {
    const seen = { created: '2026-09-30 12:00:00' };
    const remade = [{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 1, created: '2026-09-30 12:00:00' }];
    panel.row = { state: 'ready', nodeCreated: '2026-09-01 10:00:00' };
    listDomains.mockResolvedValueOnce(remade);
    const res = await call('POST', '/domains/example.com/acknowledge', seen);
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com' });
    expect(acknowledgeNodeIdentity).toHaveBeenCalledWith({ domain: 'example.com', nodeCreated: '2026-09-30 12:00:00' });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_identity_acknowledged',
      details: { domain: 'example.com', from: '2026-09-01 10:00:00', to: '2026-09-30 12:00:00' },
    });
    // Without the time the administrator saw nothing is accepted.
    let refused = await call('POST', '/domains/example.com/acknowledge');
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('node_created_required');
    // The node reports yet another time by now: refused, the administrator reloads the list.
    listDomains.mockResolvedValueOnce([{ ...remade[0], created: '2026-10-01 09:00:00' }]);
    refused = await call('POST', '/domains/example.com/acknowledge', seen);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('domain_node_changed');
    // The node sends no creation time: nothing to accept.
    expect((await (await call('POST', '/domains/example.com/acknowledge', seen)).json()).code).toBe('domain_not_recreated');
    acknowledgeNodeIdentity.mockResolvedValueOnce({ error: 'domain_not_recreated' });
    listDomains.mockResolvedValueOnce(remade);
    expect((await call('POST', '/domains/example.com/acknowledge', seen)).status).toBe(409);
    expect((await (await call('POST', '/domains/gone.example/acknowledge', seen)).json()).code).toBe('domain_not_on_node');
    session.isAdmin = false;
    expect((await call('POST', '/domains/example.com/acknowledge', seen)).status).toBe(403);
    expect(acknowledgeNodeIdentity).toHaveBeenCalledTimes(2);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('journals the state and steps a known domain had when it is added to the node again', async () => {
    const steps = { node_configured: { at: 't', email: 'admin@example.com' } };
    recordCreatedDomain.mockResolvedValueOnce({ from: 'dns_ok', steps });
    await call('POST', '/domains', { domain: 'again.example', mailboxes: 20 });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'user-1', action: 'mail_node.domain_added',
      details: { domain: 'again.example', mailboxes: 20, from: 'dns_ok', steps },
    });
  });

  it('adopts a node domain the panel does not know, journaled', async () => {
    let res = await call('POST', '/domains/Example.com/adopt');
    expect(await res.json()).toEqual({ ok: true, domain: 'example.com', state: 'node_created', apply: applied.domain('example.com') });
    expect(applyDomain).toHaveBeenCalledWith({ domain: 'example.com', userId: 'user-1', trigger: 'domain_adopted' });
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
      expect(body).toEqual({
        ...EOP_DEFAULTS, dkimMode: 'mailcow', sendLimitPerHour: 50, tlsPolicy: 'secure', tlsPolicyParameters: null,
        tenantConfigured: false, tenantDriverActive: false,
      });
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
      expect(await res.json()).toEqual({
        ...EOP_DEFAULTS, ...saved, tenantConfigured: false, tenantDriverActive: false,
        applying: true,
      });
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', action: 'mail_node.config_changed',
        details: { settings: 'eop', fields: ['eopHost', 'certificateHost', 'terrl', 'tenantId'] },
      });
      // The next hop changed: the node gets it right after the answer.
      await settled();
      expect(applyNode).toHaveBeenCalledWith({ userId: 'user-1', trigger: 'eop_settings' });
    });

    it('applies nothing when only tenant fields change, or while the node is not set up', async () => {
      await call('PUT', '/eop', { terrl: '48248', tenantId: TENANT });
      node.cfg = null;
      const res = await call('PUT', '/eop', { eopHost: 'contoso-com.mail.protection.outlook.com' });
      expect(res.status).toBe(200);
      expect((await res.json()).applying).toBeUndefined();
      await settled();
      expect(applyNode).not.toHaveBeenCalled();
    });

    it('keeps the TLS policy for the next hop and checks it with its parameters', async () => {
      let res = await call('PUT', '/eop', { tlsPolicy: 'fingerprint', tlsPolicyParameters: '  match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A   ' });
      expect(res.status).toBe(200);
      expect(saveEopSettings).toHaveBeenCalledWith({ tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' });
      await settled();
      expect(applyNode).toHaveBeenCalledWith({ userId: 'user-1', trigger: 'eop_settings' });
      // A fingerprint policy without the fingerprint checks nothing: refused, also against the stored parameters.
      res = await call('PUT', '/eop', { tlsPolicy: 'fingerprint' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('tls_parameters_invalid');
      panel.eop = { ...EOP_DEFAULTS, tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' };
      res = await call('PUT', '/eop', { tlsPolicyParameters: '' });
      expect((await res.json()).code).toBe('tls_parameters_invalid');
      // Parameters that do not fit the policy: a name for fingerprint, a fingerprint for secure,
      // match= for encrypt, the stored fingerprint left behind when the policy changes.
      res = await call('PUT', '/eop', { tlsPolicyParameters: 'match=nexthop' });
      expect((await res.json()).code).toBe('tls_parameters_invalid');
      panel.eop = null;
      for (const body of [{ tlsPolicy: 'secure', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' }, { tlsPolicy: 'encrypt', tlsPolicyParameters: 'match=nexthop' }]) {
        res = await call('PUT', '/eop', body);
        expect((await res.json()).code, body.tlsPolicy).toBe('tls_parameters_invalid');
      }
      panel.eop = { ...EOP_DEFAULTS, tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=E2:67:08:C1:02:E1:AB:0B:F9:61:F7:CD:AD:0E:AB:F0:7C:94:67:EB:BC:85:BA:A0:50:68:17:4B:65:67:C9:0A' };
      res = await call('PUT', '/eop', { tlsPolicy: 'encrypt' });
      expect((await res.json()).code).toBe('tls_parameters_invalid');
      res = await call('PUT', '/eop', { tlsPolicy: 'secure', tlsPolicyParameters: 'match=nexthop:dot-nexthop' });
      expect(res.status).toBe(200);
      expect(saveEopSettings).toHaveBeenCalledTimes(2);
    });

    it('refuses a bad value before saving anything', async () => {
      for (const [body, code] of [
        [{ eopHost: '10.0.0.1' }, 'eop_host_invalid'],
        [{ dkimMode: 'both' }, 'dkim_mode_invalid'],
        [{ sendLimitPerHour: 0 }, 'send_limit_invalid'],
        [{ terrl: 'many' }, 'terrl_invalid'],
        [{ tenantId: 'contoso' }, 'tenant_id_invalid'],
        [{ certThumbprint: 'abc' }, 'thumbprint_invalid'],
        [{ tlsPolicy: 'none' }, 'tls_policy_invalid'],
        [{ tlsPolicy: 'may' }, 'tls_policy_invalid'],
        [{ tlsPolicyParameters: 'match' }, 'tls_parameters_invalid'],
      ]) {
        const res = await call('PUT', '/eop', body);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe(code);
      }
      expect(saveEopSettings).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  it('lists the mailboxes MailExpert made with usage, send limits and the disk reading', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: ID, email_address: 'Info@example.com', node_rl_value: 200, node_rl_frame: 'd' },
        { id: 'other', email_address: 'gone@example.com', node_rl_value: null, node_rl_frame: null },
      ],
    });
    const body = await (await call('GET', '/mailboxes')).json();
    expect(body.disk).toEqual({ usedPercent: 90, used: '36G', total: '40G', warn: true });
    expect(body.mailboxes).toEqual([
      {
        accountId: ID, email: 'Info@example.com', onNode: true, active: true, quotaMb: 5120, usedBytes: 2048,
        rateLimit: null, rateLimitOverride: { value: 200, frame: 'd' }, rateLimitDefault: { value: 50, frame: 'h' },
      },
      {
        accountId: 'other', email: 'gone@example.com', onNode: false, active: false, quotaMb: null, usedBytes: null,
        rateLimit: null, rateLimitOverride: null, rateLimitDefault: { value: 50, frame: 'h' },
      },
    ]);
  });

  describe('send limit of a mailbox', () => {
    const mailbox = (extra = {}) => ({ rows: [{ email_address: 'Info@example.com', imap_host: 'mail.example.com', node_rl_value: null, node_rl_frame: null, ...extra }] });

    it('sets an administrator\'s limit on the node first, then keeps it, journaled', async () => {
      query.mockResolvedValueOnce(mailbox());
      const res = await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: '200', frame: 'd' });
      expect(await res.json()).toEqual({ ok: true, rateLimit: { value: 200, frame: 'd' }, rateLimitOverride: { value: 200, frame: 'd' } });
      expect(setMailboxRateLimit).toHaveBeenCalledWith(CFG, ['info@example.com'], { value: 200, frame: 'd' });
      // Every row of the address gets it.
      expect(query).toHaveBeenCalledWith(
        'UPDATE email_accounts SET node_rl_value = $2, node_rl_frame = $3 WHERE mail_node = true AND lower(email_address) = $1',
        ['info@example.com', 200, 'd'],
      );
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', accountId: ID, action: 'mailbox.rate_limit_changed',
        details: { value: 200, frame: 'd', override: true, from: null },
      });
    });

    it('goes back to the default (the domain\'s, else the EOP settings\') when the limit is cleared', async () => {
      panel.eop = { ...EOP_DEFAULTS, sendLimitPerHour: 30 };
      query.mockResolvedValueOnce(mailbox({ node_rl_value: 200, node_rl_frame: 'd' }));
      const res = await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: null });
      expect(await res.json()).toEqual({ ok: true, rateLimit: { value: 30, frame: 'h' }, rateLimitOverride: null });
      expect(setMailboxRateLimit).toHaveBeenCalledWith(CFG, ['info@example.com'], { value: 30, frame: 'h' });
      expect(query).toHaveBeenCalledWith(
        'UPDATE email_accounts SET node_rl_value = $2, node_rl_frame = $3 WHERE mail_node = true AND lower(email_address) = $1',
        ['info@example.com', null, null],
      );
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
        details: { value: 30, frame: 'h', override: false, from: { value: 200, frame: 'd' } },
      }));
    });

    it('keeps nothing the node refused', async () => {
      query.mockResolvedValueOnce(mailbox());
      setMailboxRateLimit.mockResolvedValueOnce({ done: [], failed: ['info@example.com'], reason: 'access_denied' });
      const res = await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: 10, frame: 'h' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'The mail node refused: access_denied', code: 'mail_node_refused' });
      expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE email_accounts'), expect.anything());
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses a bad limit, an unknown mailbox, another host and anyone but an administrator', async () => {
      for (const body of [{ value: 0, frame: 'h' }, { value: 10001, frame: 'h' }, { value: 10, frame: 'w' }, { value: 1.5, frame: 'h' }, {}]) {
        const res = await call('PUT', `/mailboxes/${ID}/rate-limit`, body);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('rate_limit_invalid');
      }
      expect((await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: 10, frame: 'h' })).status).toBe(404);
      query.mockResolvedValueOnce(mailbox({ imap_host: 'old-node.example.com' }));
      expect((await (await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: 10, frame: 'h' })).json()).code).toBe('mail_node_host_mismatch');
      session.isAdmin = false;
      expect((await call('PUT', `/mailboxes/${ID}/rate-limit`, { value: 10, frame: 'h' })).status).toBe(403);
      expect(setMailboxRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('applying the settings to the node', () => {
    it('applies the node and every known domain on request and answers the result', async () => {
      const res = await call('POST', '/apply');
      expect(await res.json()).toEqual({ at: '2026-10-01T10:00:00.000Z', node: [{ item: 'prefilter', target: null, status: 'ok' }], domains: [] });
      expect(applyNode).toHaveBeenCalledWith({ userId: 'user-1', trigger: 'manual' });
      applyNode.mockRejectedValueOnce(new MailNodeError('mail_node_not_configured', 'The mail node is not set up', 409));
      expect((await call('POST', '/apply')).status).toBe(409);
    });

    it('shows the node\'s last result', async () => {
      getNodeApplyResult.mockResolvedValueOnce({ at: 't', items: [{ item: 'tls_policy', target: 'eop.example', status: 'ok' }] });
      expect(await (await call('GET', '/apply')).json()).toEqual({ node: { at: 't', items: [{ item: 'tls_policy', target: 'eop.example', status: 'ok' }] } });
    });

    it('applies one domain the node lists, deleting a DKIM key only when the administrator confirmed it', async () => {
      let res = await call('POST', '/domains/Example.com/apply');
      expect(await res.json()).toEqual(applied.domain('example.com'));
      expect(applyDomain).toHaveBeenLastCalledWith({ domain: 'example.com', userId: 'user-1', trigger: 'manual', confirmDkimDelete: false });
      await call('POST', '/domains/example.com/apply', { confirmDkimDelete: true });
      expect(applyDomain).toHaveBeenLastCalledWith({ domain: 'example.com', userId: 'user-1', trigger: 'manual', confirmDkimDelete: true });
      // Only the literal true confirms.
      await call('POST', '/domains/example.com/apply', { confirmDkimDelete: 'yes' });
      expect(applyDomain).toHaveBeenLastCalledWith(expect.objectContaining({ confirmDkimDelete: false }));
      res = await call('POST', '/domains/elsewhere.example/apply');
      expect((await res.json()).code).toBe('domain_not_on_node');
      panel.row = null;
      expect((await (await call('POST', '/domains/example.com/apply')).json()).code).toBe('domain_not_found');
      expect(applyDomain).toHaveBeenCalledTimes(3);
    });

    it('writes the spam filing rule only by its own action', async () => {
      const res = await call('POST', '/apply/prefilter');
      expect(await res.json()).toEqual({ item: 'prefilter', target: null, status: 'changed', at: '2026-10-01T10:00:00.000Z' });
      expect(applyPrefilter).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('is for administrators only', async () => {
      session.isAdmin = false;
      for (const [method, path] of [['GET', '/apply'], ['POST', '/apply'], ['POST', '/apply/prefilter'], ['POST', '/domains/example.com/apply']]) {
        expect((await call(method, path)).status, path).toBe(403);
      }
      expect(applyNode).not.toHaveBeenCalled();
      expect(applyDomain).not.toHaveBeenCalled();
      expect(applyPrefilter).not.toHaveBeenCalled();
    });
  });

  it('changes the quota of a mail node mailbox only, journaled with the quota before', async () => {
    query.mockResolvedValueOnce({ rows: [{ email_address: 'info@example.com', imap_host: 'mail.example.com' }] });
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

  it('refuses to change the quota of a mailbox on another host than the node the settings name', async () => {
    query.mockResolvedValueOnce({ rows: [{ email_address: 'info@example.com', imap_host: 'old-node.example.com' }] });
    const res = await call('PUT', `/mailboxes/${ID}/quota`, { quotaMb: 10240 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('mail_node_host_mismatch');
    expect(setMailboxQuota).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
