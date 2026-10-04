import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// Stands in for the real requireAdmin (which verifies against the users table on every call):
// flip `session.isAdmin` to run a request as an ordinary signed-in user.
const session = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => true,
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (_req, res, next) => (
    session.isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    providerIdBackfillStates: vi.fn(async () => new Map()),
    threadRecomputeStates: vi.fn(async () => new Map()),
    disconnectAccount: vi.fn(async () => {}),
    clearConnectCooldown: vi.fn(),
    connectAccount: vi.fn(async () => {}),
    startThreadRecompute: vi.fn(async () => {}),
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));
vi.mock('../services/threading/recompute.js', () => ({ previewRecompute: vi.fn() }));
vi.mock('../services/threading/providerThreadIndex.js', () => ({ providerThreadIndexState: vi.fn() }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { recordAudit } from '../services/auditLog.js';
import { previewRecompute } from '../services/threading/recompute.js';
import { providerThreadIndexState } from '../services/threading/providerThreadIndex.js';

const ID = '11111111-1111-4111-8111-111111111111';
const BAD_ID = 'not-a-uuid';

const GMAIL_ROW = {
  id: ID, name: 'Mailbox', email_address: 'box@gmail.com', protocol: 'imap',
  imap_host: 'imap.gmail.com', enabled: true, thread_mode: 'rfc',
};
const OTHER_ROW = {
  id: ID, name: 'Mailbox', email_address: 'box@example.com', protocol: 'imap',
  imap_host: 'imap.example.com', enabled: true, thread_mode: 'gmail',
};

describe('POST /api/accounts/:id/threading', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    session.isAdmin = true;
    query.mockReset();
    previewRecompute.mockReset();
    providerThreadIndexState.mockReset();
  });

  async function post(path, body) {
    return fetch(`${base}/api/accounts/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('preview', () => {
    it('returns the numbers from previewRecompute', async () => {
      query.mockResolvedValueOnce({ rows: [GMAIL_ROW] });
      previewRecompute.mockResolvedValue({ rows: 10, changing: 3, subjectOnly: 1, threadsNow: 5, threadsAfter: 4 });

      const res = await post(`${ID}/threading/preview`, { mode: 'gmail' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rows: 10, changing: 3, subjectOnly: 1, threadsNow: 5, threadsAfter: 4 });
      expect(previewRecompute).toHaveBeenCalledWith(query, ID, 'gmail');
    });

    it('rejects an unknown mode with 400', async () => {
      const res = await post(`${ID}/threading/preview`, { mode: 'nope' });
      expect(res.status).toBe(400);
      expect(previewRecompute).not.toHaveBeenCalled();
    });

    it('is 404 for an unknown mailbox', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const res = await post(`${ID}/threading/preview`, { mode: 'rfc' });
      expect(res.status).toBe(404);
    });

    it('is 400 for a malformed UUID', async () => {
      const res = await post(`${BAD_ID}/threading/preview`, { mode: 'rfc' });
      expect(res.status).toBe(400);
    });

    it('is 403 for a signed-in user who is not an admin', async () => {
      session.isAdmin = false;

      const res = await post(`${ID}/threading/preview`, { mode: 'rfc' });

      expect(res.status).toBe(403);
      expect(previewRecompute).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('mode switch', () => {
    it('refuses gmail for a non-Gmail mailbox with reason not_gmail', async () => {
      query.mockResolvedValueOnce({ rows: [OTHER_ROW] });

      const res = await post(`${ID}/threading/mode`, { mode: 'gmail' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'threading_switch_blocked', reason: 'not_gmail' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(recordAudit).not.toHaveBeenCalled();
      expect(imapManager.startThreadRecompute).not.toHaveBeenCalled();
    });

    it('refuses gmail with reason index_invalid when the index check fails', async () => {
      query.mockResolvedValueOnce({ rows: [GMAIL_ROW] });
      providerThreadIndexState.mockResolvedValue('invalid');

      const res = await post(`${ID}/threading/mode`, { mode: 'gmail' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'threading_switch_blocked', reason: 'index_invalid' });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses gmail with reason ids_missing and the count when live rows still lack provider_thread_id', async () => {
      query
        .mockResolvedValueOnce({ rows: [GMAIL_ROW] })
        .mockResolvedValueOnce({ rows: [{ missing: '7' }] });
      providerThreadIndexState.mockResolvedValue('valid');

      const res = await post(`${ID}/threading/mode`, { mode: 'gmail' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'threading_switch_blocked', reason: 'ids_missing', count: 7 });
      expect(recordAudit).not.toHaveBeenCalled();
      expect(imapManager.startThreadRecompute).not.toHaveBeenCalled();
    });

    it('permits a switch to gmail when every gate passes: writes the mode, audits, reconnects and recomputes', async () => {
      query
        .mockResolvedValueOnce({ rows: [GMAIL_ROW] }) // load
        .mockResolvedValueOnce({ rows: [{ missing: '0' }] }) // ids_missing check
        .mockResolvedValueOnce({ rows: [] }) // UPDATE thread_mode
        .mockResolvedValueOnce({ rows: [{ ...GMAIL_ROW, thread_mode: 'gmail' }] }); // reconnect re-read
      providerThreadIndexState.mockResolvedValue('valid');

      const res = await post(`${ID}/threading/mode`, { mode: 'gmail' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, mode: 'gmail' });

      const updateCall = query.mock.calls.find(([sql]) => /UPDATE email_accounts SET thread_mode/.test(sql));
      expect(updateCall[1]).toEqual(['gmail', ID]);

      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', accountId: ID, action: 'mailbox.threading_changed',
        details: { from: 'rfc', to: 'gmail' },
      });

      await new Promise(resolve => setImmediate(resolve));
      expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ID);
      expect(imapManager.clearConnectCooldown).toHaveBeenCalledWith(ID);
      expect(imapManager.connectAccount).toHaveBeenCalled();
      expect(imapManager.startThreadRecompute).toHaveBeenCalledWith(GMAIL_ROW, 'gmail');
    });

    it('switching to rfc passes every gate regardless of provider or index state', async () => {
      query
        .mockResolvedValueOnce({ rows: [OTHER_ROW] }) // load (non-gmail host, currently gmail mode)
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [{ ...OTHER_ROW, thread_mode: 'rfc' }] }); // reconnect re-read

      const res = await post(`${ID}/threading/mode`, { mode: 'rfc' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, mode: 'rfc' });
      expect(providerThreadIndexState).not.toHaveBeenCalled();
      expect(recordAudit).toHaveBeenCalledWith({
        actorUserId: 'user-1', accountId: ID, action: 'mailbox.threading_changed',
        details: { from: 'gmail', to: 'rfc' },
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(imapManager.startThreadRecompute).toHaveBeenCalledWith(OTHER_ROW, 'rfc');
    });

    it('rejects an unknown mode with 400', async () => {
      const res = await post(`${ID}/threading/mode`, { mode: 'nope' });
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('is 404 for an unknown mailbox', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const res = await post(`${ID}/threading/mode`, { mode: 'rfc' });
      expect(res.status).toBe(404);
    });

    it('is 400 for a malformed UUID', async () => {
      const res = await post(`${BAD_ID}/threading/mode`, { mode: 'rfc' });
      expect(res.status).toBe(400);
    });

    it('is 403 for a signed-in user who is not an admin', async () => {
      session.isAdmin = false;

      const res = await post(`${ID}/threading/mode`, { mode: 'rfc' });

      expect(res.status).toBe(403);
      expect(query).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      expect(imapManager.startThreadRecompute).not.toHaveBeenCalled();
    });

    it('does not reconnect a disabled mailbox', async () => {
      const disabledRow = { ...OTHER_ROW, enabled: false };
      query
        .mockResolvedValueOnce({ rows: [disabledRow] })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE

      const res = await post(`${ID}/threading/mode`, { mode: 'rfc' });

      expect(res.status).toBe(200);
      await new Promise(resolve => setImmediate(resolve));
      expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
      expect(imapManager.startThreadRecompute).toHaveBeenCalledWith(disabledRow, 'rfc');
    });
  });
});
