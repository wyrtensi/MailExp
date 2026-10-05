import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

const { query } = await import('../services/db.js');
const { closeUserSockets } = await import('../services/websocket.js');
const { requireAuth, requireAdmin } = await import('./auth.js');

const wss = { clients: new Set() };

async function run(middleware, session) {
  const req = {
    session: { ...session, destroy: vi.fn((cb) => cb?.()) },
    app: { get: (key) => (key === 'imapManager' ? { wss } : undefined) },
  };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const next = vi.fn();
  await middleware(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  query.mockReset();
  closeUserSockets.mockReset();
});

describe('requireAuth', () => {
  it('asks for sign-in without a session user', async () => {
    const { res, next } = await run(requireAuth, {});
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an active user through', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', disabled_at: null }] });
    const { next } = await run(requireAuth, { userId: 'u1' });
    expect(next).toHaveBeenCalledWith();
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, disabled_at FROM users WHERE id = \$1/);
  });

  it('ends the session of a deleted user', async () => {
    query.mockResolvedValue({ rows: [] });
    const { req, res } = await run(requireAuth, { userId: 'u1' });
    expect(res.statusCode).toBe(401);
    expect(req.session.destroy).toHaveBeenCalled();
    expect(closeUserSockets).toHaveBeenCalledWith(wss, 'u1');
  });

  it('refuses and signs out a disabled user', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', disabled_at: new Date() }] });
    const { req, res, next } = await run(requireAuth, { userId: 'u1' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'user_disabled', code: 'user_disabled' });
    expect(req.session.destroy).toHaveBeenCalled();
    expect(closeUserSockets).toHaveBeenCalledWith(wss, 'u1');
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the sockets alone for an active user', async () => {
    query.mockResolvedValue({ rows: [{ id: 'u1', disabled_at: null }] });
    await run(requireAuth, { userId: 'u1' });
    expect(closeUserSockets).not.toHaveBeenCalled();
  });
});

describe('requireAdmin', () => {
  it('refuses a disabled admin and a non-admin and lets an active admin through', async () => {
    query.mockResolvedValue({ rows: [{ is_admin: true, disabled_at: new Date() }] });
    expect((await run(requireAdmin, { userId: 'u1' })).res.body).toEqual({ error: 'user_disabled', code: 'user_disabled' });

    query.mockResolvedValue({ rows: [{ is_admin: false, disabled_at: null }] });
    expect((await run(requireAdmin, { userId: 'u1' })).res.body).toEqual({ error: 'Admin access required' });

    query.mockResolvedValue({ rows: [{ is_admin: true, disabled_at: null }] });
    expect((await run(requireAdmin, { userId: 'u1' })).next).toHaveBeenCalledWith();
  });
});
