import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { applyInboxRules, isDangerousRegex } from '../services/inboxRules.js';
import { requireMailbox } from '../utils/requireMailbox.js';
import { recordAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth);

const DESTINATION_ACTIONS = new Set(['move', 'archive', 'delete']);
const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

// Fields where the condition value must be a non-empty string.
// has_attachment has no value; all others are string-match conditions.
const FIELDS_REQUIRING_VALUE = new Set(['from', 'to', 'subject', 'body', 'header']);

// Validates condition shapes. Returns an error string on the first problem,
// or null when all conditions are valid. Exported for unit testing.
export function validateConditions(conditions) {
  for (const cond of conditions) {
    if (!cond || typeof cond.field !== 'string') {
      return 'Each condition must have a valid field';
    }
    if (FIELDS_REQUIRING_VALUE.has(cond.field) && !String(cond.value || '').trim()) {
      return 'Condition value cannot be empty';
    }
    if (cond.field === 'header' && !String(cond.headerName || '').trim()) {
      return 'Header name is required for header conditions';
    }
    if (cond.field === 'read_status' && !['read', 'unread'].includes(String(cond.value))) {
      return 'Read status condition must be "read" or "unread"';
    }
    if (cond.operator === 'regex' && isDangerousRegex(String(cond.value || ''))) {
      return 'Regex pattern is invalid or too complex (possible catastrophic backtracking)';
    }
  }
  return null;
}

export function validateActions(actions) {
  for (const action of actions) {
    if (action.type !== 'forward') continue;
    const value = typeof action.value === 'string' ? action.value.trim() : '';
    if (!FORWARD_EMAIL_RE.test(value) || /[\r\n\0]/.test(value)) {
      return 'Forward action requires one valid email address';
    }
  }
  return null;
}

// Strip duplicate destination and forward actions (keeping the first) and trim
// move and forward values.
// Silently drops malformed entries (null, non-object, missing/non-string type).
export function normalizeActions(actions) {
  let destSeen = false;
  let forwardSeen = false;
  return actions
    .filter(a => {
      if (!a || typeof a.type !== 'string') return false;
      if (DESTINATION_ACTIONS.has(a.type)) {
        if (destSeen) return false;
        destSeen = true;
      }
      if (a.type === 'forward') {
        if (forwardSeen) return false;
        forwardSeen = true;
      }
      return true;
    })
    .map(a => (
      ['move', 'forward'].includes(a.type) && typeof a.value === 'string'
        ? { ...a, value: a.value.trim() }
        : a
    ));
}

// Rules are shared: everyone who can open a mailbox sees all of its rules, with who made each one
// (created_by_name: the author's email, else username) and every action, a forward target too.
const AUTHOR_NAME = "COALESCE(NULLIF(u.email, ''), u.username) AS created_by_name";

// The rule row as the list shows it, author included, from a statement that returns one rule.
const withAuthor = (statement) => `WITH r AS (${statement})
  SELECT r.*, ${AUTHOR_NAME} FROM r LEFT JOIN users u ON u.id = r.created_by`;

// The address a rule forwards to, or null.
function forwardTarget(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const forward = list.find((action) => action?.type === 'forward' && typeof action.value === 'string');
  return forward ? forward.value : null;
}

// What the audit log keeps of a rule: its name, its action types and where it forwards to.
function ruleAuditDetails(rule) {
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  return {
    ruleId: rule.id,
    name: rule.name || '',
    actions: actions.map((action) => action?.type).filter((type) => typeof type === 'string'),
    forwardTo: forwardTarget(actions),
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, ${AUTHOR_NAME} FROM inbox_rules r LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.priority ASC, r.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /rules error:', err.message);
    res.status(500).json({ error: 'Failed to load rules' });
  }
});

router.post('/run', async (req, res) => {
  const imapMgr = req.app.get('imapManager');
  const { accountId } = req.body;

  let accountIds;
  try {
    if (accountId) {
      const mailboxId = await requireMailbox(accountId, res);
      if (!mailboxId) return;
      accountIds = [mailboxId];
    } else {
      const mailboxes = await query('SELECT id FROM email_accounts');
      accountIds = mailboxes.rows.map(r => r.id);
    }
  } catch (err) {
    console.error('POST /rules/run account lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to run rules' });
  }

  // The sweep can take minutes on a large mailbox — well past any proxy
  // timeout, which used to surface as a 504 while the run kept going
  // server-side. Respond immediately and run in the background; the
  // rules_run_complete WebSocket event delivers the result to whoever started
  // it. A mailbox is swept by one run at a time, whoever started it.
  if (accountIds.some(id => runInFlight.has(id))) return res.status(409).json({ error: 'Rules are already running' });
  accountIds.forEach(id => runInFlight.add(id));
  const userId = req.session.userId;
  res.status(202).json({ ok: true, started: true });

  // A hand-started run applies (forwarding included) to mail already in the inbox: journal it per
  // mailbox, with the rules it runs.
  query('SELECT id, account_id FROM inbox_rules WHERE enabled = true AND account_id = ANY($1) ORDER BY priority, created_at', [accountIds])
    .then(({ rows }) => {
      const byAccount = new Map();
      for (const rule of rows) byAccount.set(rule.account_id, [...(byAccount.get(rule.account_id) ?? []), rule.id]);
      const entries = [...byAccount].map(([mailboxId, ruleIds]) => ({
        actorUserId: userId, accountId: mailboxId, action: 'rule.run', details: { ruleIds, allMailboxes: !accountId },
      }));
      if (entries.length) recordAudit(entries);
    })
    .catch(err => console.error('POST /rules/run audit error:', err.message));

  (async () => {
    try {
      const { processed, matched } = await runRulesSweep(accountIds, imapMgr);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: true, processed, matched }, userId);
    } catch (err) {
      console.error('POST /rules/run sweep error:', err.message);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: false }, userId);
    } finally {
      accountIds.forEach(id => runInFlight.delete(id));
    }
  })();
});

// Mailboxes with a background "Run rules on inbox" sweep in flight.
const runInFlight = new Set();

// Applies each mailbox's rules to every INBOX message of the given mailboxes, in
// batches. Per-account failures are logged and skipped so one bad account
// never aborts the rest. Returns the totals for the completion notice.
async function runRulesSweep(accountIds, imapMgr) {
  let processed = 0;
  let matched = 0;

  for (const acctId of accountIds) {
    try {
      const rulesCheck = await query(
        'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE enabled = true AND account_id = $1',
        [acctId]
      );
      if (parseInt(rulesCheck.rows[0].cnt, 10) === 0) continue;

      const acctResult = await query(
        'SELECT * FROM email_accounts WHERE id = $1',
        [acctId]
      );
      const account = acctResult.rows[0];
      if (!account) continue;

      const BATCH = 500;
      let lastId = null;
      while (true) {
        const msgResult = await query(
          `SELECT id, uid, folder, from_email, from_name, to_addresses, subject, has_attachments, is_read
           FROM messages
           WHERE account_id = $1 AND lower(folder) = 'inbox'
             -- uid > 0: a letter whose move is pending holds a placeholder uid (moveQueue.js);
             -- a rule would move, flag or delete it at a uid the server does not have. It is
             -- left to the next run, once its move has settled.
             AND uid > 0
             ${lastId ? 'AND id > $3' : ''}
           ORDER BY id
           LIMIT $2`,
          lastId ? [acctId, BATCH, lastId] : [acctId, BATCH]
        );
        if (!msgResult.rows.length) break;

        lastId = msgResult.rows[msgResult.rows.length - 1].id;

        const messages = msgResult.rows.map(row => {
          let toArr = [];
          try {
            const raw = typeof row.to_addresses === 'string'
              ? JSON.parse(row.to_addresses)
              : row.to_addresses;
            if (Array.isArray(raw)) {
              toArr = raw.map(a => ({ email: a.address || a.email || '', name: a.name || '' }));
            }
          } catch { /* malformed to_addresses — leave toArr empty */ }
          return {
            id: row.id,
            uid: row.uid,
            folder: row.folder,
            fromEmail: row.from_email || '',
            fromName: row.from_name || '',
            to: toArr,
            subject: row.subject || '',
            hasAttachments: !!row.has_attachments,
            isRead: !!row.is_read,
            is_read: !!row.is_read,
            parsedHeaders: {},
          };
        });

        const before = messages.length;
        const { remaining } = await applyInboxRules(messages, account, imapMgr);
        processed += before;
        matched += before - remaining.length;

        if (msgResult.rows.length < BATCH) break;
      }
    } catch (err) {
      console.error(`Rules sweep error for account ${acctId}:`, err.message);
    }
  }

  return { processed, matched };
}

router.post('/', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  const normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [mailboxId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    const countResult = await query('SELECT COUNT(*) AS cnt FROM inbox_rules');
    const priority = parseInt(countResult.rows[0].cnt);
    const result = await query(
      withAuthor(`INSERT INTO inbox_rules
         (created_by, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`),
      [
        req.session.userId,
        mailboxId,
        name || '',
        enabled !== false,
        !!stopProcessing,
        priority,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
      ]
    );
    const rule = result.rows[0];
    recordAudit({
      actorUserId: req.session.userId, accountId: mailboxId, action: 'rule.created',
      details: ruleAuditDetails({ ...rule, name: name || '', actions: normalizedActions }),
    });
    res.status(201).json(rule);
  } catch (err) {
    console.error('POST /rules error:', err.message);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  const normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [mailboxId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    // The rule as it was, for the audit log: what it forwarded to before this change.
    const before = await query('SELECT id, account_id, name, actions FROM inbox_rules WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Rule not found' });
    const result = await query(
      withAuthor(`UPDATE inbox_rules
       SET name = $1, account_id = $2, enabled = $3, stop_processing = $4,
           condition_logic = $5, conditions = $6, actions = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`),
      [
        name || '',
        mailboxId,
        enabled !== false,
        !!stopProcessing,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    const rule = result.rows[0];
    const previous = before.rows[0];
    recordAudit({
      actorUserId: req.session.userId, accountId: mailboxId, action: 'rule.updated',
      details: {
        ...ruleAuditDetails({ ...rule, name: name || '', actions: normalizedActions }),
        enabled: enabled !== false,
        previousForwardTo: forwardTarget(previous.actions),
        ...(previous.account_id !== mailboxId ? { previousAccountId: previous.account_id } : {}),
      },
    });
    res.json(rule);
  } catch (err) {
    console.error('PUT /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM inbox_rules WHERE id = $1 RETURNING id, account_id, name, actions',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    const rule = result.rows[0];
    recordAudit({
      actorUserId: req.session.userId, accountId: rule.account_id, action: 'rule.deleted',
      details: ruleAuditDetails(rule),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

router.patch('/reorder', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
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
