import { Router } from 'express';
import { runAccessSyncNow } from '../services/accessSync/index.js';
import {
  ACCESS_SYNC_ERRORS, accessSyncSnapshot, accessSyncTombstones, journalSyncRequested, saveAccessSyncConfig,
} from '../services/accessSync/actions.js';
import { routeActor } from '../services/actor.js';

// Cloudflare Access sync settings for admins; mounted by routes/admin.js behind requireAdmin. The
// actions are shared with the panel CLI (services/accessSync/actions.js).
const router = Router();

router.get('/', async (_req, res) => {
  res.json(await accessSyncSnapshot());
});

// Emails of deleted users the sync does not import again; POST /api/admin/users/allow lets one in.
router.get('/tombstones', async (_req, res) => {
  res.json({ tombstones: await accessSyncTombstones() });
});

router.put('/', async (req, res) => {
  const result = await saveAccessSyncConfig(req.body, routeActor(req));
  if (result.error) {
    const [status, message] = ACCESS_SYNC_ERRORS[result.error] ?? [400, 'Invalid Cloudflare Access settings'];
    return res.status(status).json({ error: message, code: result.error });
  }
  console.log(`[admin] ${req.session.userId} changed the Cloudflare Access sync settings`);
  return res.json(await accessSyncSnapshot());
});

router.post('/run', async (req, res) => {
  journalSyncRequested(routeActor(req));
  const result = await runAccessSyncNow();
  res.json({ result, ...(await accessSyncSnapshot()) });
});

export default router;
