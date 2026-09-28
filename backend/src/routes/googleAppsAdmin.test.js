import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const registry = vi.hoisted(() => ({
  listGoogleApps: vi.fn(),
  getGoogleAppSummary: vi.fn(),
  createGoogleApp: vi.fn(),
  updateGoogleApp: vi.fn(),
  deleteGoogleApp: vi.fn(),
  setGoogleAppStatus: vi.fn(async () => []),
  getEffectiveGoogleRedirectUri: vi.fn(async () => 'https://mail.example.com/oauth/google/callback'),
}));
vi.mock('../services/oauth/googleApps.js', () => {
  class GoogleAppError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  return { ...registry, GoogleAppError, GOOGLE_APP_STATUSES: ['active', 'closed', 'disabled'] };
});
vi.mock('../services/oauth/googleAppSelection.js', () => ({
  countGoogleReservations: vi.fn(async () => 1),
}));

import express from 'express';
import googleAppsAdminRoutes from './googleAppsAdmin.js';
import { GoogleAppError } from '../services/oauth/googleApps.js';

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const manager = { disconnectAccount: vi.fn(async () => {}) };
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.set('imapManager', manager);
  app.use('/api/admin/google-apps', googleAppsAdminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/google-apps`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  Object.values(registry).forEach((fn) => fn.mockReset());
  registry.setGoogleAppStatus.mockResolvedValue([]);
  registry.getGoogleAppSummary.mockResolvedValue(ROW);
  registry.getEffectiveGoogleRedirectUri.mockResolvedValue('https://mail.example.com/oauth/google/callback');
  manager.disconnectAccount.mockClear();
});

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ROW = {
  id: ID, label: 'Google 1', client_id: '1-a.apps.googleusercontent.com', project_number: '1',
  user_limit: 2, status: 'active', created_at: '2026-09-21T00:00:00.000Z', grants_count: 1, accounts_count: 1,
};

describe('/api/admin/google-apps', () => {
  it('lists apps with reservations counted and a computed full flag, never a secret', async () => {
    registry.listGoogleApps.mockResolvedValue([ROW]);
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toEqual([{
      id: ID, label: 'Google 1', clientId: ROW.client_id, projectNumber: '1', userLimit: 2, status: 'active',
      grantsCount: 1, reservedCount: 1, accountsCount: 1, full: true, createdAt: ROW.created_at,
    }]);
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it('creates an app and maps registry errors to stable codes', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    let res = await send('POST', '', { label: 'Google 1', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.app.clientId).toBe(ROW.client_id);
    expect(created.warnings).toEqual([]);

    registry.createGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_same_project'));
    res = await send('POST', '', { label: 'G', clientId: ROW.client_id, clientSecret: 's' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_same_project' });
  });

  it('creates an app from an imported client JSON, defaulting the label to the project id', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    const clientJson = JSON.stringify({
      web: {
        client_id: ROW.client_id,
        client_secret: 'GOCSPX-secret',
        project_id: 'my-project-123',
        redirect_uris: ['https://mail.example.com/oauth/google/callback'],
      },
    });
    const res = await send('POST', '', { clientJson });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual([]);
    expect(registry.createGoogleApp).toHaveBeenCalledWith({
      label: 'my-project-123', clientId: ROW.client_id, clientSecret: 'GOCSPX-secret', userLimit: 100,
    });
  });

  it('keeps an explicit label over the client JSON project id', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y', project_id: 'proj' } });
    await send('POST', '', { label: 'Custom label', clientJson });
    expect(registry.createGoogleApp).toHaveBeenCalledWith(expect.objectContaining({ label: 'Custom label' }));
  });

  it('warns when the imported client JSON is missing the panel callback URL', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y', redirect_uris: ['https://other.example.com/cb'] } });
    const res = await send('POST', '', { clientJson });
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual([
      { code: 'redirect_uri_missing', expected: 'https://mail.example.com/oauth/google/callback' },
    ]);
  });

  it('warns that no callback is configured yet when the panel has none', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    registry.getEffectiveGoogleRedirectUri.mockResolvedValue(null);
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } });
    const res = await send('POST', '', { clientJson });
    expect((await res.json()).warnings).toEqual([{ code: 'callback_not_configured' }]);
  });

  it('refuses a client JSON together with a manual client id or secret', async () => {
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } });
    let res = await send('POST', '', { clientJson, clientId: 'manual-id' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_json_conflict' });

    res = await send('POST', '', { clientJson, clientSecret: 'manual-secret' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_json_conflict' });
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
  });

  it('maps a service-account key and a desktop client to their own error codes', async () => {
    let res = await send('POST', '', { clientJson: JSON.stringify({ type: 'service_account' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_json_service_account' });

    res = await send('POST', '', { clientJson: JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_json_not_web' });

    res = await send('POST', '', { clientJson: 'not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_json_invalid' });
    expect(registry.createGoogleApp).not.toHaveBeenCalled();
  });

  it('never logs the client secret while importing a client JSON', async () => {
    registry.createGoogleApp.mockResolvedValueOnce(ROW);
    const clientJson = JSON.stringify({ web: { client_id: 'x', client_secret: 'super-secret-value' } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await send('POST', '', { clientJson });
    } finally {
      expect([...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ')).not.toMatch(/super-secret-value/);
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('refuses a secret typed around the redaction placeholder', async () => {
    const res = await send('PATCH', `/${ID}`, { clientSecret: 'x••••••••' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'client_secret_redacted' });
    expect(registry.updateGoogleApp).not.toHaveBeenCalled();
  });

  it('keeps the stored secret when the placeholder comes back', async () => {
    registry.updateGoogleApp.mockResolvedValue(ROW);
    await send('PATCH', `/${ID}`, { label: 'Renamed', clientSecret: '••••••••' });
    expect(registry.updateGoogleApp).toHaveBeenCalledWith(ID, { label: 'Renamed', clientSecret: null, userLimit: undefined });
  });

  it('re-reads the app after the update so the response carries fresh counts, not the stale update result', async () => {
    registry.updateGoogleApp.mockResolvedValue({ ...ROW, label: 'stale', grants_count: 0, accounts_count: 0 });
    registry.getGoogleAppSummary.mockResolvedValue({ ...ROW, label: 'Renamed', grants_count: 2, accounts_count: 2, user_limit: 2 });
    const res = await send('PATCH', `/${ID}`, { label: 'Renamed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.app).toEqual({
      id: ID, label: 'Renamed', clientId: ROW.client_id, projectNumber: '1', userLimit: 2, status: 'active',
      grantsCount: 2, reservedCount: 1, accountsCount: 2, full: true, createdAt: ROW.created_at,
    });
    expect(registry.getGoogleAppSummary).toHaveBeenCalledWith(ID);
  });

  it('reports app_not_found when the app is gone by the time it re-reads', async () => {
    registry.updateGoogleApp.mockResolvedValue(ROW);
    registry.getGoogleAppSummary.mockResolvedValue(null);
    const res = await send('PATCH', `/${ID}`, { label: 'Renamed' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'app_not_found' });
  });

  it('disabling drops the IMAP connections of the flagged mailboxes', async () => {
    registry.getGoogleAppSummary.mockResolvedValue({ ...ROW, status: 'disabled' });
    registry.setGoogleAppStatus.mockResolvedValue(['acc-1', 'acc-2']);
    const res = await send('PATCH', `/${ID}`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(registry.setGoogleAppStatus).toHaveBeenCalledWith(ID, 'disabled');
    expect(manager.disconnectAccount.mock.calls.map((c) => c[0])).toEqual(['acc-1', 'acc-2']);
  });

  it('refuses to delete an app with mailboxes and rejects a malformed id', async () => {
    registry.deleteGoogleApp.mockRejectedValueOnce(new GoogleAppError('app_in_use'));
    let res = await send('DELETE', `/${ID}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app_in_use' });

    res = await send('DELETE', '/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
