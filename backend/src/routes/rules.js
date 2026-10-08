import { Router } from 'express';
import { routeActor } from '../services/actor.js';
import {
  claimRulesRun, createRule, deleteRule, listRules, normalizeActions, recordRulesRun, ruleRefusal, rulesRunTargets,
  runClaimedRules, updateRule, validateActions, validateConditions,
} from '../services/rules/ruleActions.js';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { isUuid, uuidParam } from '../utils/uuid.js';

// Inbox rules: services/rules/ruleActions.js holds the checks and the journal, shared with the
// panel CLI. The validators stay importable from here.
export { normalizeActions, validateActions, validateConditions };

const router = Router();
router.use(requireAuth);
router.param('id', uuidParam('id'));

const refuse = (res, result) => {
  const [status, body] = ruleRefusal(result);
  return res.status(status).json(body);
};

router.get('/', async (req, res) => {
  try {
    res.json(await listRules());
  } catch (err) {
    console.error('GET /rules error:', err.message);
    res.status(500).json({ error: 'Failed to load rules' });
  }
});

router.post('/run', async (req, res) => {
  const imapMgr = req.app.get('imapManager');
  const { accountId } = req.body;

  let targets;
  try {
    targets = await rulesRunTargets(accountId);
  } catch (err) {
    console.error('POST /rules/run account lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to run rules' });
  }
  if (targets.error) return refuse(res, targets);
  const { accountIds } = targets;

  // The sweep can take minutes on a large mailbox — well past any proxy
  // timeout, which used to surface as a 504 while the run kept going
  // server-side. Respond immediately and run in the background; the
  // rules_run_complete WebSocket event delivers the result to whoever started
  // it. A mailbox is swept by one run at a time, whoever started it.
  if (!claimRulesRun(accountIds)) return refuse(res, { error: 'already_running' });
  const userId = req.session.userId;
  res.status(202).json({ ok: true, started: true });

  recordRulesRun(accountIds, routeActor(req), { allMailboxes: !accountId })
    .catch(err => console.error('POST /rules/run audit error:', err.message));

  (async () => {
    const { ok, processed, matched } = await runClaimedRules(accountIds, imapMgr);
    imapMgr?.broadcast?.(ok ? { type: 'rules_run_complete', ok, processed, matched } : { type: 'rules_run_complete', ok: false }, userId);
  })();
});

router.post('/', async (req, res) => {
  try {
    const result = await createRule(req.body, routeActor(req));
    if (result.error) return refuse(res, result);
    res.status(201).json(result.rule);
  } catch (err) {
    console.error('POST /rules error:', err.message);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await updateRule(req.params.id, req.body, routeActor(req));
    if (result.error) return refuse(res, result);
    res.json(result.rule);
  } catch (err) {
    console.error('PUT /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteRule(req.params.id, routeActor(req));
    if (result.error) return refuse(res, result);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

router.patch('/reorder', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  if (!ids.every(isUuid)) return res.status(400).json({ error: 'Invalid id', code: 'invalid_id' });
  try {
    // Every id must be an existing rule before anything is renumbered
    const found = await query(
      'SELECT id FROM inbox_rules WHERE id = ANY($1::uuid[])',
      [ids]
    );
    if (found.rows.length !== ids.length) {
      return res.status(403).json({ error: 'One or more rules not found' });
    }
    for (let i = 0; i < ids.length; i++) {
      await query('UPDATE inbox_rules SET priority = $1 WHERE id = $2', [i, ids[i]]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /rules/reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder rules' });
  }
});

export default router;
