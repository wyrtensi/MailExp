// Updating the panel from the admin UI (/api/admin/update, mounted behind admin.js's requireAdmin).
//
// The backend never updates anything itself: it learns the promoted `latest` build from GitHub
// (services/panelUpdate/latest.js), drops a request into the update spool for the host's updater
// (services/panelUpdate/spool.js) and reports the result files the updater writes back. The old
// semver banner (/api/update, services/updateCheck.js) is a separate thing and stays as it is.
import { Router } from 'express';
import { query as dbQuery } from '../services/db.js';
import { recordAudit as dbRecordAudit } from '../services/auditLog.js';
import { auditOf, routeActor } from '../services/actor.js';
import { uuidParam } from '../utils/uuid.js';
import { getLatestStatus } from '../services/panelUpdate/latest.js';
import { SpoolError, TARGET_RE, getSpool as defaultGetSpool, isBusy } from '../services/panelUpdate/spool.js';
import { reconcileUpdateAudit } from '../services/panelUpdate/reconcile.js';
import { getNodeUpdateState } from '../services/mailNode/nodeAgent.js';

export const UPDATE_LINKS = Object.freeze({
  runbook: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/deployment.md#откат-обновления',
  rollback: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/README.md#10-откат',
});

export function createAdminUpdateRouter({
  getStatus = getLatestStatus,
  getSpool = defaultGetSpool,
  reconcile = reconcileUpdateAudit,
  getNode = getNodeUpdateState,
  query = dbQuery,
  recordAudit = dbRecordAudit,
  now = () => Date.now(),
} = {}) {
  const router = Router();
  router.param('id', uuidParam('id'));

  // Requests are checked for busy and written one at a time, so two clicks cannot both get through.
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function spoolState(spool) {
    const [updater, requests, results] = await Promise.all([
      spool.readUpdater(), spool.readRequests({ now: now() }), spool.readResults(),
    ]);
    return { updater, requests, results, busy: isBusy({ ...requests, results, now: now() }) };
  }

  async function requesterName(userId) {
    const { rows } = await query('SELECT email, username FROM users WHERE id = $1', [userId]);
    return String(rows[0]?.email || rows[0]?.username || userId || '').slice(0, 254);
  }

  // The node's part of the update (the agent's update job); null when it cannot be read.
  async function nodeState() {
    try {
      return await getNode();
    } catch (err) {
      console.error('[panel-update] Node update state unavailable:', err?.code || err?.name || 'Error');
      return null;
    }
  }

  router.get('/', async (req, res) => {
    await reconcile();
    const spool = getSpool();
    const [status, state, node] = await Promise.all([
      getStatus({ refresh: req.query.refresh === '1' }),
      spoolState(spool),
      nodeState(),
    ]);
    const latestVersion = status.latest?.version ?? null;
    res.json({
      current: status.current,
      latest: status.latest,
      compare: status.compare,
      updateAvailable: status.updateAvailable,
      disabled: status.disabled,
      checkError: status.checkError,
      updater: {
        spool: spool.enabled, installed: state.updater.installed, version: state.updater.version, rolledBack: state.updater.rolledBack,
      },
      busy: state.busy,
      pending: state.requests.pending,
      check: (latestVersion && state.results.find((r) => r.action === 'check' && r.target === latestVersion)) || null,
      run: state.results.find((r) => r.action === 'update') || null,
      node,
      links: UPDATE_LINKS,
    });
  });

  // Validates and writes a request: { id, status } or an answer already sent (null).
  async function request(req, res, action) {
    const spool = getSpool();
    const updater = await spool.readUpdater();
    if (!spool.enabled || !updater.installed) {
      res.status(503).json({ error: 'updater_not_installed', code: 'updater_not_installed' });
      return null;
    }
    const target = req.body?.target;
    if (typeof target !== 'string' || !TARGET_RE.test(target)) {
      res.status(400).json({ error: 'invalid_target', code: 'invalid_target' });
      return null;
    }
    if (action === 'update' && req.body?.confirm !== target) {
      res.status(400).json({ error: 'confirm_mismatch', code: 'confirm_mismatch' });
      return null;
    }
    const status = await getStatus();
    if (!status.latest || status.latest.version !== target) {
      res.status(409).json({ error: 'not_latest', code: 'not_latest' });
      return null;
    }
    // The host refuses a version somebody rolled back from until a newer build is promoted.
    if (updater.rolledBack && updater.rolledBack === target) {
      res.status(409).json({ error: 'rolled_back', code: 'rolled_back' });
      return null;
    }
    if (action === 'update' && !status.updateAvailable) {
      res.status(409).json({ error: 'no_update', code: 'no_update' });
      return null;
    }
    const requestedBy = await requesterName(req.session.userId);
    return serialized(async () => {
      if ((await spoolState(spool)).busy) {
        res.status(409).json({ error: 'busy', code: 'busy' });
        return null;
      }
      try {
        const id = await spool.writeRequest({ action, target, requestedBy, now: new Date(now()) });
        return { id, status };
      } catch (err) {
        if (err instanceof SpoolError && (err.code === 'updater_not_installed' || err.code === 'spool_not_writable')) {
          res.status(503).json({ error: err.code, code: err.code });
          return null;
        }
        throw err;
      }
    });
  }

  router.post('/check', async (req, res) => {
    const made = await request(req, res, 'check');
    if (made) res.status(202).json({ id: made.id });
  });

  router.post('/', async (req, res) => {
    const made = await request(req, res, 'update');
    if (!made) return;
    recordAudit([auditOf(routeActor(req), {
      action: 'panel.update_requested',
      details: { requestId: made.id, target: req.body.target, from: made.status.current?.version ?? null },
    })]);
    console.log(`[admin] ${req.session.userId} requested a panel update to ${req.body.target} (${made.id})`);
    res.status(202).json({ id: made.id });
  });

  router.get('/:id', async (req, res) => {
    const spool = getSpool();
    const id = req.params.id.toLowerCase();
    const result = await spool.readResult(id);
    if (result) return res.json(result);
    if (await spool.hasRequest(id)) return res.json({ id, state: 'queued', terminal: false });
    return res.status(404).json({ error: 'not_found', code: 'not_found' });
  });

  return router;
}

export default createAdminUpdateRouter();
