// Letters waiting to be sent (services/sendQueue.js): in their undo window, scheduled for later,
// or kept after a failure. Mailboxes are shared, so everyone sees what waits in a mailbox; its
// author and administrators can undo, edit, reschedule, send again or cancel it.
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { cancelScheduled, getScheduled, listScheduled, parseSendAt, rescheduleScheduled } from '../services/sendQueue.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID_RE = /^[1-9]\d{0,17}$/;
const CANCEL_REASONS = new Set(['undo', 'edit', 'discard']);

// Who is asking: read on every request, so a revoked admin loses the right at once.
async function viewer(req) {
  const { rows: [user] } = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  return { userId: req.session.userId, isAdmin: !!user?.is_admin };
}

function jobId(req, res) {
  if (!JOB_ID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return req.params.id;
}

function answerRefusal(res, err) {
  if (err?.status && err?.code) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

router.get('/scheduled', async (req, res) => {
  const accountId = typeof req.query.accountId === 'string' && req.query.accountId ? req.query.accountId : null;
  if (accountId && !UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  const letters = await listScheduled({ accountId, ...(await viewer(req)) });
  res.json({ letters });
});

router.get('/scheduled/:id', async (req, res) => {
  const id = jobId(req, res);
  if (!id) return undefined;
  const letter = await getScheduled(id, await viewer(req));
  if (!letter) return res.status(404).json({ error: 'Scheduled letter not found', code: 'not_found' });
  res.json({ letter });
});

// Cancels the letter. reason 'undo' or 'edit' answers what was composed, so the composer reopens
// with it; 'discard' (the default) answers nothing more.
router.post('/scheduled/:id/cancel', async (req, res) => {
  const id = jobId(req, res);
  if (!id) return undefined;
  const reason = CANCEL_REASONS.has(req.body?.reason) ? req.body.reason : 'discard';
  try {
    res.json(await cancelScheduled(id, { ...(await viewer(req)), reason }));
  } catch (err) {
    answerRefusal(res, err);
  }
});

// Moves a waiting letter to sendAt, or (resend: true) sends again one that failed or needs
// attention, at sendAt or now.
router.patch('/scheduled/:id', async (req, res) => {
  const id = jobId(req, res);
  if (!id) return undefined;
  const resend = req.body?.resend === true;
  let sendAt;
  if (resend && !req.body?.sendAt) {
    sendAt = new Date();
  } else {
    const parsed = parseSendAt(req.body?.sendAt);
    if (parsed.error || !parsed.sendAt) {
      return res.status(400).json({ error: parsed.error || 'sendAt is required', code: parsed.code || 'send_at_invalid' });
    }
    sendAt = parsed.sendAt;
  }
  try {
    await rescheduleScheduled(id, { ...(await viewer(req)), sendAt, resend });
    res.json({ letter: await getScheduled(id, await viewer(req)) });
  } catch (err) {
    answerRefusal(res, err);
  }
});

export default router;
