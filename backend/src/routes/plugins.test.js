import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// The signed-in user is u1; `session.admin` says whether requireAdmin lets them through.
const session = vi.hoisted(() => ({ admin: true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, res, next) => (session.admin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
vi.mock('../plugins/activation.js', () => ({
  getEnabledPlugins: vi.fn(),
  setPluginEnabled: vi.fn(),
}));
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import express from 'express';
import { pluginRegistry } from '../plugins/registry.js';
import { getEnabledPlugins, setPluginEnabled } from '../plugins/activation.js';
import { recordAudit } from '../services/auditLog.js';
import pluginsRoutes from './plugins.js';

const MANIFEST = { id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1 };

let listSpy, hasSpy, getSpy, runHookSpy;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

let server, base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

let logSpy;
beforeEach(() => {
  session.admin = true;
  getEnabledPlugins.mockReset();
  setPluginEnabled.mockReset().mockResolvedValue({ enabled: new Set(), changed: true });
  recordAudit.mockClear();
  listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([MANIFEST]);
  hasSpy = vi.spyOn(pluginRegistry, 'has').mockImplementation((id) => id === 'gtd');
  getSpy = vi.spyOn(pluginRegistry, 'get').mockImplementation((id) => (id === 'gtd' ? MANIFEST : undefined));
  runHookSpy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  listSpy.mockRestore(); hasSpy.mockRestore(); getSpy.mockRestore(); runHookSpy.mockRestore(); logSpy.mockRestore();
});

const req = (method, path, body) => fetch(`${base}/api/plugins${path}`, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

describe('GET /api/plugins', () => {
  it('lists registered plugins with the panel-wide switch', async () => {
    getEnabledPlugins.mockResolvedValueOnce(new Set(['gtd']));
    const res = await req('GET', '/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1, enabled: true },
    ]);
  });

  it('is readable by a user who is not an administrator', async () => {
    session.admin = false;
    getEnabledPlugins.mockResolvedValueOnce(new Set());
    const res = await req('GET', '/');
    expect(res.status).toBe(200);
    expect((await res.json())[0].enabled).toBe(false);
  });
});

describe('PATCH /api/plugins/:id', () => {
  it('enables a plugin for everyone, journals it, fires the hook and echoes the state', async () => {
    const res = await req('PATCH', '/gtd', { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'gtd', enabled: true });
    expect(setPluginEnabled).toHaveBeenCalledWith('gtd', true);
    expect(recordAudit).toHaveBeenCalledWith([{
      actorUserId: 'u1', action: 'plugin.enabled', details: { pluginId: 'gtd', name: 'Getting Things Done' },
    }]);
    expect(runHookSpy).toHaveBeenCalledWith('onPluginActivationChanged', { pluginId: 'gtd', enabled: true });
  });

  it('disables a plugin and journals plugin.disabled', async () => {
    const res = await req('PATCH', '/gtd', { enabled: false });
    expect(res.status).toBe(200);
    expect(setPluginEnabled).toHaveBeenCalledWith('gtd', false);
    expect(recordAudit.mock.calls[0][0][0].action).toBe('plugin.disabled');
    expect(runHookSpy).toHaveBeenCalledWith('onPluginActivationChanged', { pluginId: 'gtd', enabled: false });
  });

  it('journals nothing when the plugin was already in that state', async () => {
    setPluginEnabled.mockResolvedValueOnce({ enabled: new Set(['gtd']), changed: false });
    const res = await req('PATCH', '/gtd', { enabled: true });
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('403s a user who is not an administrator without touching the switch', async () => {
    session.admin = false;
    const res = await req('PATCH', '/gtd', { enabled: true });
    expect(res.status).toBe(403);
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(runHookSpy).not.toHaveBeenCalled();
  });

  it('404s an unknown plugin without touching the switch', async () => {
    const res = await req('PATCH', '/nope', { enabled: true });
    expect(res.status).toBe(404);
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(runHookSpy).not.toHaveBeenCalled();
  });

  it('400s when enabled is missing or non-boolean (the old per-user body included)', async () => {
    expect((await req('PATCH', '/gtd', {})).status).toBe(400);
    expect((await req('PATCH', '/gtd', { enabled: 'yes' })).status).toBe(400);
    expect((await req('PATCH', '/gtd', { activated: true })).status).toBe(400);
    expect(setPluginEnabled).not.toHaveBeenCalled();
  });
});
