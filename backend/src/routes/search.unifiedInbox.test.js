import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

import express from 'express';
import searchRoutes from './search.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

describe('GET /api/search unified account scope', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  it('searches only opted-in accounts when no account is selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['included']);
  });

  it('keeps an opted-out account searchable when explicitly selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice&accountId=excluded`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['excluded']);
  });
});

// Search covers every folder of the selected mailbox(es) by default; Gmail's own default
// "All Mail" search excludes Trash and Spam the same way, and that's what the owner picked
// here too. Route-level (not just the resolveSearchFolderScope unit tests) so the actual SQL
// sent to the DB is what's asserted on, not just the helper functions in isolation.
describe('GET /api/search default folder scope excludes Trash and Spam', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  const searchSql = async (qs) => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acct-1', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/search?${qs}`);
    expect(response.status).toBe(200);
    return query.mock.calls[1][0];
  };

  it('excludes Trash- and Junk-like folders when no folder param narrows the search', async () => {
    const sql = await searchSql('q=invoice');
    expect(sql).toContain('\\Trash');
    expect(sql).toMatch(/spam\|junk/);
  });

  it('does not exclude anything once a folder param narrows the search', async () => {
    const sql = await searchSql('q=invoice&folder=INBOX');
    expect(sql).not.toContain('\\Trash');
    expect(sql).not.toMatch(/spam\|junk/);
  });

  it('in:trash / in:junk opt back in to their own folder, still excluding nothing extra', async () => {
    const trashSql = await searchSql('q=' + encodeURIComponent('in:trash invoice'));
    expect(trashSql).not.toContain('\\Trash'); // no blanket exclusion once explicitly scoped
    const junkSql = await searchSql('q=' + encodeURIComponent('in:junk invoice'));
    expect(junkSql).not.toMatch(/spam\|junk/);
  });
});
