import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: async () => true,
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({ imapManager: { providerIdBackfillStates: vi.fn(), threadRecomputeStates: vi.fn(async () => new Map()) } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ROW = {
  name: 'Mailbox', protocol: 'imap', oauth_reconnect_required: false, enabled: true,
  sync_error: null, signature: null, last_sync: new Date(),
};

describe('GET /api/accounts Gmail id backfill', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.providerIdBackfillStates.mockReset(); });

  it('adds the state for Gmail mailboxes and null for the others', async () => {
    const running = { status: 'running', percent: 40, error: null };
    imapManager.providerIdBackfillStates.mockResolvedValue(new Map([['g1', running]]));
    query
      .mockResolvedValueOnce({ rows: [
        { ...ROW, id: 'g1', email_address: 'box@gmail.com', imap_host: 'imap.gmail.com' },
        { ...ROW, id: 'o1', email_address: 'box@example.com', imap_host: 'imap.example.com' },
      ] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await fetch(`${base}/api/accounts`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map(a => [a.id, a.provider_ids_backfill])).toEqual([['g1', running], ['o1', null]]);
    expect(imapManager.providerIdBackfillStates).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'g1' }), expect.objectContaining({ id: 'o1' }),
    ]);
  });
});
