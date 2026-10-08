import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => `enc:${v}`, decrypt: (v) => v.replace(/^enc:/, '') }));

import express from 'express';
import todoistRoutes from './todoist.js';
import { query } from '../services/db.js';

// Todoist's own answers never become the panel's: a revoked token upstream (401) must not read as
// the panel session expiring, and neither a database error nor Todoist's body reaches the browser.
describe('Todoist errors', () => {
  let server;
  let base;
  const realFetch = global.fetch;
  let upstream;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/todoist', todoistRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [{ id: 1, config: { token: 'enc:tok' } }] });
    upstream = vi.fn();
    global.fetch = (url, opts) => (String(url).startsWith(base) ? realFetch(url, opts) : upstream(url, opts));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  const send = (method, path, body) => fetch(`${base}/api/todoist${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('a token Todoist refuses is a 409 todoist_token_invalid, not a 401', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized: token abc123' }), { status: 401 }));
    for (const path of ['/projects', '/labels']) {
      const res = await send('GET', path);
      expect(res).toEqual({ status: 409, body: { error: expect.any(String), code: 'todoist_token_invalid' } });
      expect(res.body.error).not.toContain('abc123');
    }
  });

  it('another Todoist failure is a 502 todoist_unavailable without its body', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ error: 'internal detail xyz' }), { status: 500 }));
    const res = await send('POST', '/tasks', { content: 'Call Dana' });
    expect(res).toMatchObject({ status: 502, body: { code: 'todoist_unavailable' } });
    expect(res.body.error).not.toContain('xyz');
  });

  it('a Todoist that cannot be reached is a 502 todoist_unavailable', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    expect(await send('GET', '/projects')).toMatchObject({ status: 502, body: { code: 'todoist_unavailable' } });
  });

  it('a user without Todoist gets a 409 todoist_not_connected', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await send('GET', '/projects')).toMatchObject({ status: 409, body: { code: 'todoist_not_connected' } });
  });

  it('a missing task title is a 400 todoist_task_title_required', async () => {
    expect(await send('POST', '/tasks', { content: ' ' })).toMatchObject({ status: 400, body: { code: 'todoist_task_title_required' } });
    expect(await send('POST', '/tasks', { content: 5 })).toMatchObject({ status: 400, body: { code: 'todoist_task_title_required' } });
  });

  it('connect refuses a missing or rejected token with a code', async () => {
    expect(await send('POST', '/connect', {})).toMatchObject({ status: 400, body: { code: 'todoist_token_required' } });
    upstream.mockResolvedValue(new Response('', { status: 401 }));
    expect(await send('POST', '/connect', { token: 'bad' })).toMatchObject({ status: 400, body: { code: 'todoist_token_invalid' } });
  });

  it('a database failure is a 500 todoist_failed without the database text', async () => {
    query.mockRejectedValue(new Error('relation "user_integrations" does not exist'));
    for (const [method, path] of [['GET', '/status'], ['DELETE', '/disconnect']]) {
      const res = await send(method, path);
      expect(res).toMatchObject({ status: 500, body: { code: 'todoist_failed' } });
      expect(res.body.error).not.toContain('relation');
    }
    upstream.mockResolvedValue(new Response('[]', { status: 200 }));
    const res = await send('POST', '/connect', { token: 'good' });
    expect(res).toMatchObject({ status: 500, body: { code: 'todoist_failed' } });
    expect(res.body.error).not.toContain('relation');
  });

  it('still answers what Todoist gave when it works', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ results: [{ id: 'p1' }] }), { status: 200 }));
    expect(await send('GET', '/projects')).toEqual({ status: 200, body: [{ id: 'p1' }] });
  });
});
