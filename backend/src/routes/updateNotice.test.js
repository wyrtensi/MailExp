import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));

import express from 'express';
import { query } from '../services/db.js';
import { createUpdateNoticeRouter } from './updateNotice.js';
import { APP_VERSION } from '../services/appVersion.js';

const STATUS = {
  current: { sha: 'a'.repeat(40), version: 'sha-aaaaaaaaaaaa', release: '1.0.0' },
  latest: { sha: 'b'.repeat(40), version: 'sha-bbbbbbbbbbbb', release: '1.0.1' },
  compare: { status: 'ahead', aheadBy: 2, url: null }, updateAvailable: true, disabled: false, checkError: null,
};

let server;
let base;
let session;
let isAdmin;
const getStatus = vi.fn();
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/update', createUpdateNoticeRouter({ getStatus }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  session = { userId: 'u1', destroy: (cb) => cb?.() };
  isAdmin = true;
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [{ is_admin: isAdmin, disabled_at: null }] }));
  getStatus.mockReset();
  getStatus.mockResolvedValue(STATUS);
});

const get = async () => {
  const res = await fetch(`${base}/api/update`);
  return { status: res.status, body: await res.json() };
};

describe('/api/update', () => {
  it('gives an administrator the card\'s verdict and the releases', async () => {
    expect(await get()).toEqual({ status: 200, body: { current: '1.0.0', latest: '1.0.1', updateAvailable: true, disabled: false } });
  });

  it('refuses a user who is not an administrator, and nobody signed in', async () => {
    isAdmin = false;
    expect((await get()).status).toBe(403);
    session = {};
    expect((await get()).status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('a failed check is no update, not an error', async () => {
    getStatus.mockRejectedValue(new Error('boom'));
    expect(await get()).toEqual({ status: 200, body: { current: APP_VERSION, latest: null, updateAvailable: false, disabled: false } });
  });
});
