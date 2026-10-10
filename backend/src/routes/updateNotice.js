// GET /api/update: the sidebar's "update available" notice, for administrators only (they are the
// ones who update the panel). It is the same cached check of the promoted `latest` as
// Administration -> Panel update (services/panelUpdate/latest.js, updateNotice), so the two never
// disagree; the browser only talks to MailExpert. Never throws into the response.
import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getLatestStatus, updateNotice } from '../services/panelUpdate/latest.js';
import { APP_VERSION } from '../services/appVersion.js';

export function createUpdateNoticeRouter({ getStatus = getLatestStatus } = {}) {
  const router = Router();
  router.get('/', requireAdmin, async (_req, res) => {
    try {
      res.json(updateNotice(await getStatus()));
    } catch {
      res.json({ current: APP_VERSION, latest: null, updateAvailable: false, disabled: false });
    }
  });
  return router;
}

export default createUpdateNoticeRouter();
