import { Router } from 'express';
import { runAccessSyncNow } from '../services/accessSync/index.js';
import {
  ACCESS_SYNC_ERRORS, accessSyncSnapshot, accessSyncTombstones, journalSyncRequested, saveAccessSyncConfig, verifyAccessSync,
} from '../services/accessSync/actions.js';
import { routeActor } from '../services/actor.js';

// Cloudflare Access sync settings for admins; mounted by routes/admin.js behind requireAdmin. The
// actions are shared with the panel CLI (services/accessSync/actions.js).
const router = Router();

const refusal = (res, code) => {
  const [status, message] = ACCESS_SYNC_ERRORS[code] ?? [400, 'Invalid Cloudflare Access settings'];
  return res.status(status).json({ error: message, code });
};

// The snapshot plus whether this administrator signed in through Cloudflare Access (identityGate
// verified Access's signed assertion for this session): the one sign of the tunnel and the Access
// application working that the backend can see. The tunnel and DNS tokens live in the host's
// edge/.env, out of the backend's reach.
const snapshotFor = async (req) => ({ ...(await accessSyncSnapshot()), signedInViaAccess: req.session?.authMethod === 'cloudflare' });

router.get('/', async (req, res) => {
  res.json(await snapshotFor(req));
});

// Emails of deleted users the sync does not import again; POST /api/admin/users/allow lets one in.
router.get('/tombstones', async (_req, res) => {
  res.json({ tombstones: await accessSyncTombstones() });
});

router.put('/', async (req, res) => {
  const result = await saveAccessSyncConfig(req.body, routeActor(req));
  if (result.error) return refusal(res, result.error);
  console.log(`[admin] ${req.session.userId} changed the Cloudflare Access sync settings`);
  return res.json(await snapshotFor(req));
});

// Checks the stored settings, or the form's unsaved ones in their place, against Cloudflare.
// Stores and writes nothing, so nothing is journaled.
router.post('/verify', async (req, res) => {
  const result = await verifyAccessSync(req.body ?? {});
  if (result.error) return refusal(res, result.error);
  console.log(`[admin] ${req.session.userId} verified the Cloudflare Access sync settings: ${result.result.ok ? 'ok' : 'problems found'}`);
  return res.json(result.result);
});

router.post('/run', async (req, res) => {
  journalSyncRequested(routeActor(req));
  const result = await runAccessSyncNow();
  res.json({ result, ...(await snapshotFor(req)) });
});

export default router;
