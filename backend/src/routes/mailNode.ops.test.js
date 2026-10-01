// The node operation routes of /api/mail-node: the mail queue (R-16), the alerts (R-18) and the
// TERRL budget (R-21).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'admin-1' }; next(); },
  requireAdmin: (_req, res, next) => (session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
vi.mock('../services/mailNode/diskWatch.js', () => ({ DISK_WARN_PERCENT: 85, checkMailNodeDisk: vi.fn(async () => null) }));
const node = vi.hoisted(() => ({ cfg: null, queue: [], postcat: '', log: null }));
vi.mock('../services/mailNode/mailcow.js', async (importActual) => ({
  ...(await importActual()),
  getMailNodeConfig: vi.fn(async () => node.cfg),
  listQueue: vi.fn(async () => {
    if (node.queue instanceof Error) throw node.queue;
    return node.queue;
  }),
  getQueuedMessageText: vi.fn(async () => ({ text: node.postcat, truncated: false })),
  queueAction: vi.fn(async () => {}),
  flushQueue: vi.fn(async () => {}),
  deleteQueued: vi.fn(async () => {}),
  // The log goes through the real, shared reader (services/mailNode/postfixLog.js).
  getPostfixLog: vi.fn(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    if (node.log instanceof Error) throw node.log;
    return node.log;
  }),
  listAliasDomains: vi.fn(async () => ['alias.test']),
}));
vi.mock('../services/mailNode/terrl.js', async (importActual) => ({
  ...(await importActual()),
  computeTerrlBudget: vi.fn(async ({ log }) => ({ used: 3, limit: 100, percent: 3, warn: false, log: { read: !!log } })),
}));
const alerts = vi.hoisted(() => ({ state: null, settings: { pingUrl: null, deferredCount: 20, deferredMinutes: 60 } }));
vi.mock('../services/mailNode/nodeAlerts.js', async (importActual) => ({
  ...(await importActual()),
  getAlertState: vi.fn(async () => alerts.state),
  getAlertSettings: vi.fn(async () => alerts.settings),
  saveAlertSettings: vi.fn(async () => {}),
  checkAlertsNow: vi.fn(async () => alerts.state),
}));
vi.mock('../services/mailNode/eopSettings.js', async (importActual) => ({
  ...(await importActual()),
  getEopSettings: vi.fn(async () => ({ eopHost: 'eop.test.local', terrl: 100 })),
}));

import express from 'express';
import mailNodeRoutes from './mailNode.js';
import { recordAudit } from '../services/auditLog.js';
import { MailNodeError, deleteQueued, flushQueue, getPostfixLog, queueAction } from '../services/mailNode/mailcow.js';
import { clearPostfixLogCache } from '../services/mailNode/postfixLog.js';
import { clearAliasDomainCache } from '../services/mailNode/terrl.js';
import { checkAlertsNow, saveAlertSettings } from '../services/mailNode/nodeAlerts.js';
import { computeTerrlBudget } from '../services/mailNode/terrl.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, panelIps: [] };
const ITEM = {
  queueId: '53A99193F13', queue: 'deferred', arrivedAt: new Date(Date.now() - 600000).toISOString(), size: 360, forcedExpire: false,
  sender: 'someone@stage.test', recipients: [{ address: 'test@example.com', reason: '451 4.7.500 Server busy' }],
};
const POSTCAT = [
  '*** ENVELOPE RECORDS deferred/5/53A99193F13 ***', 'sender: someone@stage.test', 'recipient: test@example.com',
  '*** MESSAGE CONTENTS deferred/5/53A99193F13 ***', 'Subject: hello', 'From: someone@stage.test', '', 'Body text.',
  '*** HEADER EXTRACTED deferred/5/53A99193F13 ***', '*** MESSAGE FILE END deferred/5/53A99193F13 ***',
].join('\n');

describe('/api/mail-node node operations', () => {
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
    node.queue = [ITEM];
    node.postcat = POSTCAT;
    node.log = [{ time: '1790881379', program: 'postfix/qmgr', priority: 'info', message: '53A99193F13: removed' }];
    clearPostfixLogCache();
    clearAliasDomainCache();
    alerts.state = { at: '2026-10-01T19:10:00.000Z', alerts: [], errors: [] };
  });

  const call = (method, path, body) => fetch(`${base}/api/mail-node${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });

  it('is for administrators only', async () => {
    session.isAdmin = false;
    for (const [method, path] of [['GET', '/queue'], ['GET', '/queue/53A99193F13'], ['POST', '/queue/flush'], ['POST', '/queue/53A99193F13/hold'],
      ['GET', '/alerts'], ['POST', '/alerts/check'], ['PUT', '/alerts/settings'], ['GET', '/eop/budget']]) {
      expect((await call(method, path)).status, `${method} ${path}`).toBe(403);
    }
  });

  it('lists the queue with counts and ages', async () => {
    const body = await (await call('GET', '/queue')).json();
    expect(body).toMatchObject({ total: 1, counts: { deferred: 1, hold: 0 }, items: [{ queueId: '53A99193F13', sender: 'someone@stage.test' }] });
    expect(body.oldestDeferredSeconds).toBeGreaterThanOrEqual(600);
  });

  it('answers 409 without a node and 502 when the node fails', async () => {
    node.cfg = null;
    expect((await call('GET', '/queue')).status).toBe(409);
    node.cfg = CFG;
    node.queue = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)');
    const res = await call('GET', '/queue');
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mail_node_unreachable');
  });

  it('shows one message without its body unless asked', async () => {
    const plain = await (await call('GET', '/queue/53a99193f13')).json();
    expect(plain).toMatchObject({ queueId: '53A99193F13', envelope: { sender: 'someone@stage.test' }, body: null });
    expect(plain.headers).toEqual([{ name: 'Subject', value: 'hello' }, { name: 'From', value: 'someone@stage.test' }]);
    expect((await (await call('GET', '/queue/53A99193F13?body=1')).json()).body).toBe('Body text.');
    node.postcat = 'postcat: fatal: open queue file 53A99193F13: No such file or directory';
    expect((await call('GET', '/queue/53A99193F13')).status).toBe(404);
    expect((await call('GET', '/queue/ALL')).status).toBe(400);
  });

  it('holds, releases and delivers a message in the queue and journals its envelope', async () => {
    for (const action of ['hold', 'unhold', 'deliver']) {
      expect(await (await call('POST', `/queue/53A99193F13/${action}`)).json()).toEqual({ ok: true, action, queueId: '53A99193F13' });
      expect(queueAction).toHaveBeenLastCalledWith(CFG, ['53A99193F13'], action);
    }
    expect(recordAudit).toHaveBeenLastCalledWith({
      actorUserId: 'admin-1', action: 'mail_node.queue_action',
      details: { action: 'deliver', queueId: '53A99193F13', queue: 'deferred', sender: 'someone@stage.test', size: 360, recipients: ['test@example.com'] },
    });
  });

  it('deletes one message only when confirmed, and never offers anything wider', async () => {
    expect((await call('POST', '/queue/53A99193F13/delete')).status).toBe(400);
    expect(deleteQueued).not.toHaveBeenCalled();
    expect((await call('POST', '/queue/53A99193F13/delete', { confirm: true })).status).toBe(200);
    expect(deleteQueued).toHaveBeenCalledWith(CFG, ['53A99193F13']);
    for (const action of ['super_delete', 'flush', 'requeue']) {
      expect((await call('POST', `/queue/53A99193F13/${action}`, { confirm: true })).status).toBe(400);
    }
    expect((await call('POST', '/queue/ALL/delete', { confirm: true })).status).toBe(400);
  });

  it('refuses a message no longer in the queue', async () => {
    node.queue = [];
    expect((await call('POST', '/queue/53A99193F13/deliver')).status).toBe(404);
    expect(queueAction).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('flushes the whole queue and journals it', async () => {
    expect(await (await call('POST', '/queue/flush')).json()).toEqual({ ok: true, action: 'flush' });
    expect(flushQueue).toHaveBeenCalledWith(CFG);
    expect(recordAudit).toHaveBeenCalledWith({ actorUserId: 'admin-1', action: 'mail_node.queue_action', details: { action: 'flush' } });
  });

  it('shows the alerts and checks them now', async () => {
    expect(await (await call('GET', '/alerts')).json()).toMatchObject({ state: alerts.state, settings: alerts.settings, defaults: { deferredCount: 20 } });
    expect(await (await call('POST', '/alerts/check')).json()).toEqual({ state: alerts.state });
    expect(checkAlertsNow).toHaveBeenCalledWith({ userId: 'admin-1', trigger: 'manual' });
    alerts.state = null;
    expect((await call('POST', '/alerts/check')).status).toBe(502);
  });

  it('saves the alert settings and journals the fields that changed', async () => {
    const res = await call('PUT', '/alerts/settings', { pingUrl: 'https://hc.example.com/p/alerts', deferredCount: 20, deferredMinutes: 30 });
    expect(await res.json()).toEqual({ settings: { pingUrl: 'https://hc.example.com/p/alerts', deferredCount: 20, deferredMinutes: 30 } });
    expect(saveAlertSettings).toHaveBeenCalledWith({ pingUrl: 'https://hc.example.com/p/alerts', deferredCount: 20, deferredMinutes: 30 });
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'admin-1', action: 'mail_node.config_changed', details: { settings: 'alerts', fields: ['pingUrl', 'deferredMinutes'] },
    });
    expect((await call('PUT', '/alerts/settings', { pingUrl: 'http://insecure' })).status).toBe(400);
  });

  it('keeps the licenses and the tenant creation date with the EOP settings', async () => {
    expect((await call('PUT', '/eop', { licenses: 0 })).status).toBe(400);
    expect((await (await call('PUT', '/eop', { tenantCreatedOn: '2999-01-01' })).json()).code).toBe('tenant_created_invalid');
    expect(await (await call('PUT', '/eop', { licenses: '500', tenantCreatedOn: '2026-09-14' })).json())
      .toMatchObject({ licenses: 500, tenantCreatedOn: '2026-09-14' });
  });

  it('gives the TERRL budget, from the journal alone when the node does not answer', async () => {
    expect(await (await call('GET', '/eop/budget')).json()).toMatchObject({ used: 3, limit: 100, log: { read: true } });
    expect(computeTerrlBudget).toHaveBeenLastCalledWith(expect.objectContaining({ aliasDomains: ['alias.test'] }));
    clearPostfixLogCache();
    node.log = new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ETIMEDOUT)');
    expect(await (await call('GET', '/eop/budget')).json()).toMatchObject({ log: { read: false } });
    expect(computeTerrlBudget).toHaveBeenLastCalledWith(expect.objectContaining({ log: null, eop: { eopHost: 'eop.test.local', terrl: 100 } }));
  });

  it('reads the node log once for budget requests close together', async () => {
    const answers = await Promise.all([call('GET', '/eop/budget'), call('GET', '/eop/budget'), call('GET', '/eop/budget')]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    await call('GET', '/eop/budget');
    expect(getPostfixLog).toHaveBeenCalledTimes(1);
    expect(computeTerrlBudget).toHaveBeenCalledTimes(4);
  });

  it('journals reading a body, with the id and the envelope only', async () => {
    await call('GET', '/queue/53A99193F13');
    expect(recordAudit).not.toHaveBeenCalled();
    await call('GET', '/queue/53A99193F13?body=1');
    expect(recordAudit).toHaveBeenCalledWith({
      actorUserId: 'admin-1', action: 'mail_node.queue_action',
      details: { action: 'view_body', queueId: '53A99193F13', queue: 'deferred', sender: 'someone@stage.test', recipients: ['test@example.com'] },
    });
  });

  it('answers 502, not 404, when postcat fails some other way', async () => {
    node.postcat = 'err: invalid';
    const res = await call('GET', '/queue/53A99193F13');
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mail_node_failed');
  });

  it('refuses "try now" for a held message', async () => {
    node.queue = [{ ...ITEM, queue: 'hold' }];
    const res = await call('POST', '/queue/53A99193F13/deliver');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('queue_item_held');
    expect(queueAction).not.toHaveBeenCalled();
  });
});
