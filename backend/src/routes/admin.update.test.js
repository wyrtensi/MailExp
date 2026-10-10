import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same mock surface as admin.audit.test.js, except that requireAdmin is the real one (answered by
// the mocked query) and the GitHub check and the journal reconciler are stubbed.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({
  imapManager: { disconnectAccount: vi.fn(async () => {}), wss: { clients: new Set() } },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({ ...(await importOriginal()), createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({})),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));
vi.mock('./auth.js', () => ({ destroyUserSessions: vi.fn(async () => {}) }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../services/auditLog.js', async (importOriginal) => ({
  ...(await importOriginal()), recordAudit: vi.fn(async () => {}),
}));
vi.mock('../services/panelUpdate/latest.js', () => ({ getLatestStatus: vi.fn() }));
vi.mock('../services/panelUpdate/spool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getSpool: vi.fn(actual.getSpool) };
});
vi.mock('../services/panelUpdate/reconcile.js', () => ({ reconcileUpdateAudit: vi.fn(async () => {}) }));
vi.mock('../services/mailNode/nodeAgent.js', async (importOriginal) => ({
  ...(await importOriginal()), getNodeUpdateState: vi.fn(),
}));

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';
import { recordAudit } from '../services/auditLog.js';
import { getLatestStatus } from '../services/panelUpdate/latest.js';
import { reconcileUpdateAudit } from '../services/panelUpdate/reconcile.js';
import { getNodeUpdateState } from '../services/mailNode/nodeAgent.js';
import { SpoolError, getSpool } from '../services/panelUpdate/spool.js';

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const RID = '33333333-3333-4333-8333-333333333333';
const CUR = 'a'.repeat(40);
const LATEST = '0123456789abcdef0123456789abcdef01234567';
const TARGET = 'sha-0123456789ab';
const realGetSpool = getSpool.getMockImplementation();
const NODE = {
  configured: true, connected: true, scriptsCommit: CUR, panelCommit: CUR,
  job: { id: '7', kind: 'update', state: 'running', step: 'setup.sh' },
};

const status = (over = {}) => ({
  current: { sha: CUR, version: 'sha-aaaaaaaaaaaa', release: '1.0.0' },
  latest: { version: TARGET, sha: LATEST, release: '1.0.1', checkedAt: '2026-10-05T11:00:00.000Z' },
  compare: { status: 'ahead', aheadBy: 3, url: `https://github.com/wyrtensi/MailExpert/compare/${CUR}...${LATEST}` },
  updateAvailable: true, disabled: false, checkError: null,
  ...over,
});

const result = (over = {}) => ({
  id: RID, action: 'update', target: TARGET, state: 'succeeded', terminal: true, message: 'Done', from: 'sha-aaaaaaaaaaaa', fromRelease: '1.0.0', targetRelease: '1.0.1',
  receivedAt: '2026-10-05T11:50:00.000Z', updatedAt: '2026-10-05T11:59:00.000Z', startedAt: '2026-10-05T11:51:00.000Z',
  finishedAt: '2026-10-05T11:59:00.000Z', exitCode: 0, preflight: null, autoRollback: false, next: [], log: [],
  logFile: '/opt/mailexpert/state/updater/x.log', journal: 'journalctl -u mailexpert-updater.service',
  ...over,
});

let isAdmin;
let server;
let base;
let dir;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: ADMIN_ID, destroy: (cb) => cb?.() }; next(); });
  app.use('/api/admin', adminRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(async () => {
  isAdmin = true;
  query.mockReset();
  query.mockImplementation(async (sql) => {
    if (/SELECT is_admin, disabled_at FROM users/.test(sql)) return { rows: [{ is_admin: isAdmin, disabled_at: null }] };
    if (/SELECT email, username FROM users/.test(sql)) return { rows: [{ email: 'admin@example.com', username: 'admin' }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  recordAudit.mockClear();
  reconcileUpdateAudit.mockClear();
  getLatestStatus.mockReset();
  getLatestStatus.mockResolvedValue(status());
  getNodeUpdateState.mockReset();
  getNodeUpdateState.mockResolvedValue(NODE);
  dir =await mkdtemp(join(tmpdir(), 'admin-update-'));
  await mkdir(join(dir, 'request'));
  await mkdir(join(dir, 'result'));
  await writeFile(join(dir, 'result', 'updater.json'), JSON.stringify({ installed: true, version: 'sha-bbbbbbbbbbbb', updatedAt: '2026-10-05T10:00:00Z', rolledBack: null }));
  vi.stubEnv('UPDATE_SPOOL_DIR', dir);
  getSpool.mockImplementation(realGetSpool);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}/api/admin/update${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const requests = () => readdir(join(dir, 'request'));

describe('/api/admin/update', () => {
  it.each([
    ['GET', ''], ['POST', '/check'], ['POST', ''], ['GET', `/${RID}`],
  ])('%s %s needs an administrator', async (method, path) => {
    isAdmin = false;
    const { status: code } = await call(method, path, method === 'POST' ? { target: TARGET, confirm: TARGET } : undefined);
    expect(code).toBe(403);
    expect(await requests()).toEqual([]);
  });

  describe('GET', () => {
    it('reports the versions, the updater and the newest results', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result()));
      const checkId = '44444444-4444-4444-8444-444444444444';
      await writeFile(join(dir, 'result', `${checkId}.json`), JSON.stringify(result({
        id: checkId, action: 'check', state: 'ready', receivedAt: '2026-10-05T11:40:00.000Z', exitCode: null,
      })));

      const { status: code, body } = await call('GET', '');

      expect(code).toBe(200);
      expect(reconcileUpdateAudit).toHaveBeenCalledTimes(1);
      expect(getLatestStatus).toHaveBeenCalledWith({ refresh: false });
      expect(body).toEqual({
        ...status(),
        updater: { spool: true, installed: true, version: 'sha-bbbbbbbbbbbb', rolledBack: null },
        busy: false,
        pending: null,
        check: expect.objectContaining({ id: checkId, action: 'check', state: 'ready', target: TARGET }),
        run: result(),
        node: NODE,
        links: {
          runbook: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/deployment.md#откат-обновления',
          rollback: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/README.md#10-откат',
        },
      });
    });

    it('passes a forced refresh on', async () => {
      await call('GET', '?refresh=1');
      expect(getLatestStatus).toHaveBeenCalledWith({ refresh: true });
    });

    it('shows a check only for the current latest', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result({ action: 'check', state: 'ready', target: 'sha-111111111111' })));
      expect((await call('GET', '')).body.check).toBeNull();
    });

    it('reports a pending request as busy', async () => {
      const { body: made } = await call('POST', '/check', { target: TARGET });
      const { body } = await call('GET', '');
      expect(body.busy).toBe(true);
      expect(body.pending).toEqual({ id: made.id, action: 'check' });
    });

    it('without a spool the feature is off', async () => {
      vi.stubEnv('UPDATE_SPOOL_DIR', '');
      const { body } = await call('GET', '');
      expect(body.updater).toEqual({ spool: false, installed: false, version: null, rolledBack: null });
      expect(body.busy).toBe(false);
      expect(body.run).toBeNull();
    });
  });

  describe('rolled back versions', () => {
    const rollBack = (version) => writeFile(join(dir, 'result', 'updater.json'), JSON.stringify({ installed: true, version: 'sha-bbbbbbbbbbbb', rolledBack: version }));

    it('GET exposes updater.rolledBack, null unless it is exactly sha-<12>', async () => {
      await rollBack(TARGET);
      expect((await call('GET', '')).body.updater.rolledBack).toBe(TARGET);
      await rollBack('SHA-0123456789AB');
      expect((await call('GET', '')).body.updater.rolledBack).toBeNull();
    });

    it('refuses a check and an update of the rolled back target', async () => {
      await rollBack(TARGET);
      expect(await call('POST', '/check', { target: TARGET })).toEqual({ status: 409, body: { error: 'rolled_back', code: 'rolled_back' } });
      expect(await call('POST', '', { target: TARGET, confirm: TARGET })).toEqual({ status: 409, body: { error: 'rolled_back', code: 'rolled_back' } });
      expect(await requests()).toEqual([]);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('reports not_latest before rolled_back', async () => {
      await rollBack('sha-111111111111');
      expect((await call('POST', '/check', { target: 'sha-111111111111' })).body).toEqual({ error: 'not_latest', code: 'not_latest' });
    });

    it('lets a different target through', async () => {
      await rollBack('sha-111111111111');
      expect((await call('POST', '/check', { target: TARGET })).status).toBe(202);
    });
  });

  describe('a spool the backend cannot write', () => {
    it.each([['/check', { target: TARGET }], ['', { target: TARGET, confirm: TARGET }]])('POST %s answers 503 spool_not_writable', async (path, body) => {
      getSpool.mockImplementation(() => ({
        ...realGetSpool(), writeRequest: async () => { throw new SpoolError('spool_not_writable'); },
      }));
      expect(await call('POST', path, body)).toEqual({ status: 503, body: { error: 'spool_not_writable', code: 'spool_not_writable' } });
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  describe('POST /check', () => {
    it('writes a check request', async () => {
      const { status: code, body } = await call('POST', '/check', { target: TARGET });
      expect(code).toBe(202);
      expect(await requests()).toEqual([`${body.id}.json`]);
      const req = JSON.parse(await readFile(join(dir, 'request', `${body.id}.json`), 'utf8'));
      expect(req).toMatchObject({ id: body.id, action: 'check', target: TARGET, requestedBy: 'admin@example.com' });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses without a spool directory', async () => {
      vi.stubEnv('UPDATE_SPOOL_DIR', '');
      expect(await call('POST', '/check', { target: TARGET })).toEqual({ status: 503, body: { error: 'updater_not_installed', code: 'updater_not_installed' } });
    });

    it('refuses when the host updater is not installed', async () => {
      await rm(join(dir, 'result', 'updater.json'));
      expect(await call('POST', '/check', { target: TARGET })).toEqual({ status: 503, body: { error: 'updater_not_installed', code: 'updater_not_installed' } });
      expect(await requests()).toEqual([]);
    });

    it.each([undefined, 'latest', 'sha-0123456789AB', 'sha-0123', 42])('refuses the target %j', async (target) => {
      expect(await call('POST', '/check', { target })).toEqual({ status: 400, body: { error: 'invalid_target', code: 'invalid_target' } });
      expect(await requests()).toEqual([]);
    });

    it('refuses a target that is not the latest', async () => {
      expect(await call('POST', '/check', { target: 'sha-111111111111' })).toEqual({ status: 409, body: { error: 'not_latest', code: 'not_latest' } });
      getLatestStatus.mockResolvedValue(status({ latest: null }));
      expect((await call('POST', '/check', { target: TARGET })).body).toEqual({ error: 'not_latest', code: 'not_latest' });
      expect(await requests()).toEqual([]);
    });

    it('refuses while a request is pending', async () => {
      await writeFile(join(dir, 'request', `${RID}.json`), '{}');
      expect(await call('POST', '/check', { target: TARGET })).toEqual({ status: 409, body: { error: 'busy', code: 'busy' } });
    });

    it('lets one of two simultaneous requests through', async () => {
      const answers = await Promise.all([call('POST', '/check', { target: TARGET }), call('POST', '/check', { target: TARGET })]);
      expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
      expect(await requests()).toHaveLength(1);
    });
  });

  describe('POST /', () => {
    it('writes an update request and journals it', async () => {
      const { status: code, body } = await call('POST', '', { target: TARGET, confirm: TARGET });
      expect(code).toBe(202);
      const req = JSON.parse(await readFile(join(dir, 'request', `${body.id}.json`), 'utf8'));
      expect(req).toMatchObject({ id: body.id, action: 'update', target: TARGET, requestedBy: 'admin@example.com' });
      expect(recordAudit).toHaveBeenCalledWith([{
        action: 'panel.update_requested', actorUserId: ADMIN_ID,
        details: { requestId: body.id, target: TARGET, from: 'sha-aaaaaaaaaaaa' },
      }]);
    });

    it('refuses a confirmation that does not repeat the target', async () => {
      expect(await call('POST', '', { target: TARGET, confirm: 'sha-111111111111' })).toEqual({ status: 400, body: { error: 'confirm_mismatch', code: 'confirm_mismatch' } });
      expect(await call('POST', '', { target: TARGET })).toEqual({ status: 400, body: { error: 'confirm_mismatch', code: 'confirm_mismatch' } });
      expect(await requests()).toEqual([]);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing newer', async () => {
      getLatestStatus.mockResolvedValue(status({ updateAvailable: false, compare: { status: 'identical', aheadBy: 0, url: null } }));
      expect(await call('POST', '', { target: TARGET, confirm: TARGET })).toEqual({ status: 409, body: { error: 'no_update', code: 'no_update' } });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses a target that is not the latest', async () => {
      const other = 'sha-111111111111';
      expect(await call('POST', '', { target: other, confirm: other })).toEqual({ status: 409, body: { error: 'not_latest', code: 'not_latest' } });
    });

    it('refuses while an update runs', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result({
        state: 'updating', terminal: false, updatedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
      })));
      expect(await call('POST', '', { target: TARGET, confirm: TARGET })).toEqual({ status: 409, body: { error: 'busy', code: 'busy' } });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('a stale run does not block a new update', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result({
        state: 'updating', terminal: false, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      })));
      expect((await call('POST', '', { target: TARGET, confirm: TARGET })).status).toBe(202);
    });

    it('refuses without a spool directory', async () => {
      vi.stubEnv('UPDATE_SPOOL_DIR', '');
      expect(await call('POST', '', { target: TARGET, confirm: TARGET })).toEqual({ status: 503, body: { error: 'updater_not_installed', code: 'updater_not_installed' } });
    });
  });

  describe('GET /:id', () => {
    it('returns the result', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result()));
      expect(await call('GET', `/${RID}`)).toEqual({ status: 200, body: result() });
    });

    it('returns a refused result the host could not attribute', async () => {
      await writeFile(join(dir, 'result', `${RID}.json`), JSON.stringify(result({ action: null, target: null, state: 'refused' })));
      expect((await call('GET', `/${RID}`)).body).toMatchObject({ id: RID, action: null, target: null, state: 'refused' });
    });

    it('reports a request the host has not taken yet as queued', async () => {
      const { body: made } = await call('POST', '/check', { target: TARGET });
      expect(await call('GET', `/${made.id}`)).toEqual({ status: 200, body: { id: made.id, state: 'queued', terminal: false } });
    });

    it('404s an unknown id', async () => {
      expect((await call('GET', `/${RID}`)).status).toBe(404);
    });

    it('400s an id that is not a UUID', async () => {
      expect((await call('GET', '/..%2F..%2Fetc')).status).toBe(400);
      expect((await call('GET', '/not-a-uuid')).status).toBe(400);
    });
  });
});
