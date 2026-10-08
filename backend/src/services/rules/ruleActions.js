import { query } from '../db.js';
import { applyInboxRules, isDangerousRegex } from '../inboxRules.js';
import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { MAILBOX_REF_ERRORS, findMailboxId } from '../../utils/requireMailbox.js';

// Inbox rules, shared by the rules API (routes/rules.js, /api/rules) and the panel CLI
// (cli/commands/rule.js): the same checks, the same journal (rule.created, rule.updated,
// rule.deleted, rule.run). A rule belongs to one mailbox (account_id); rules are shared, so
// everyone who can open the mailbox sees all of its rules, with who made each one (created_by).
// Running the rules on the inbox is the backend's (imapManager): the route starts it at once, the
// CLI queues it (services/admin/adminEffects.js, runRules).

// code -> [HTTP status, message]. A refusal may carry its own message (invalid_condition,
// invalid_action); the mailbox refusals answer as utils/requireMailbox.js does.
export const RULE_ERRORS = Object.freeze({
  not_arrays: [400, 'conditions and actions must be arrays'],
  invalid_condition: [400, 'Invalid condition'],
  invalid_action: [400, 'Invalid action'],
  account_required: [400, 'accountId is required'],
  invalid_account: [400, 'Invalid account id'],
  account_not_found: [404, 'Account not found'],
  move_folder_not_found: [400, 'Move destination folder not found for this account'],
  not_found: [404, 'Rule not found'],
  already_running: [409, 'Rules are already running'],
});

// The API's answer to a refusal: [status, body]. A catalogued refusal carries its key as the code.
export function ruleRefusal(result) {
  if (MAILBOX_REF_ERRORS[result.error]) return MAILBOX_REF_ERRORS[result.error];
  if (!RULE_ERRORS[result.error]) return [500, { error: result.message ?? result.error }];
  const [status, message] = RULE_ERRORS[result.error];
  return [status, { error: result.message ?? message, code: result.error }];
}

const DESTINATION_ACTIONS = new Set(['move', 'archive', 'delete']);
const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

// Fields where the condition value must be a non-empty string.
// has_attachment has no value; all others are string-match conditions.
const FIELDS_REQUIRING_VALUE = new Set(['from', 'to', 'subject', 'body', 'header']);

// Validates condition shapes. Returns an error string on the first problem,
// or null when all conditions are valid.
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

// Every rule, in the order they run (priority, then age), with its author.
export async function listRules() {
  const result = await query(
    `SELECT r.*, ${AUTHOR_NAME} FROM inbox_rules r LEFT JOIN users u ON u.id = r.created_by
     ORDER BY r.priority ASC, r.created_at ASC`,
  );
  return result.rows;
}

// One rule with its author: { rule } or { error: 'not_found' }.
export async function getRule(id) {
  const { rows: [rule] } = await query(
    `SELECT r.*, ${AUTHOR_NAME} FROM inbox_rules r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
    [id],
  );
  return rule ? { rule } : { error: 'not_found' };
}

// The checks of a rule's body before it is written: { mailboxId, normalizedActions } or a refusal.
async function checkRuleBody(body) {
  const { accountId, conditions, actions } = body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) return { error: 'not_arrays' };
  const conditionError = validateConditions(conditions);
  if (conditionError) return { error: 'invalid_condition', message: conditionError };
  const normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return { error: 'invalid_action', message: actionError };
  const mailbox = await findMailboxId(accountId);
  if (mailbox.error) return mailbox;
  const mailboxId = mailbox.id;
  const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
  if (moveAction) {
    const folderResult = await query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
       FROM folders WHERE account_id = $1`,
      [mailboxId, moveAction.value.trim()],
    );
    const { total, match } = folderResult.rows[0];
    if (parseInt(total) > 0 && parseInt(match) === 0) return { error: 'move_folder_not_found' };
  }
  return { mailboxId, normalizedActions };
}

// The author the journal names when it is not the actor (the CLI's --user): details.onBehalfOf.
const onBehalf = (author) => (author ? { onBehalfOf: author.email ?? author.id } : {});

// Adds a rule at the end of the order. body: { name, accountId, conditionLogic, conditions,
// actions, enabled, stopProcessing }, as POST /api/rules takes it. The rule's author is the actor,
// or author ({ id, email }: the CLI acting for a user). Answers { rule } or { error, message? }.
export async function createRule(body, actor, { author = null } = {}) {
  const { name, conditionLogic, conditions, enabled, stopProcessing } = body || {};
  const checked = await checkRuleBody(body || {});
  if (checked.error) return checked;
  const { mailboxId, normalizedActions } = checked;
  const countResult = await query('SELECT COUNT(*) AS cnt FROM inbox_rules');
  const priority = parseInt(countResult.rows[0].cnt);
  const result = await query(
    withAuthor(`INSERT INTO inbox_rules
       (created_by, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`),
    [
      author?.id ?? actor?.userId ?? null,
      mailboxId,
      name || '',
      enabled !== false,
      !!stopProcessing,
      priority,
      conditionLogic === 'OR' ? 'OR' : 'AND',
      JSON.stringify(conditions),
      JSON.stringify(normalizedActions),
    ],
  );
  const rule = result.rows[0];
  recordAudit(auditOf(actor, {
    accountId: mailboxId, action: 'rule.created',
    details: { ...ruleAuditDetails({ ...rule, name: name || '', actions: normalizedActions }), ...onBehalf(author) },
  }));
  return { rule };
}

// Replaces a rule (PUT /api/rules/:id: the whole body, checked as on create). Answers { rule } or
// { error, message? }.
export async function updateRule(id, body, actor, { author = null } = {}) {
  const { name, conditionLogic, conditions, enabled, stopProcessing } = body || {};
  const checked = await checkRuleBody(body || {});
  if (checked.error) return checked;
  const { mailboxId, normalizedActions } = checked;
  // The rule as it was, for the audit log: what it forwarded to before this change.
  const before = await query('SELECT id, account_id, name, actions FROM inbox_rules WHERE id = $1', [id]);
  if (!before.rows.length) return { error: 'not_found' };
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
      id,
    ],
  );
  if (!result.rows.length) return { error: 'not_found' };
  const rule = result.rows[0];
  const previous = before.rows[0];
  recordAudit(auditOf(actor, {
    accountId: mailboxId, action: 'rule.updated',
    details: {
      ...ruleAuditDetails({ ...rule, name: name || '', actions: normalizedActions }),
      enabled: enabled !== false,
      previousForwardTo: forwardTarget(previous.actions),
      ...(previous.account_id !== mailboxId ? { previousAccountId: previous.account_id } : {}),
      ...onBehalf(author),
    },
  }));
  return { rule };
}

// Deletes a rule: { ok } or { error: 'not_found' }.
export async function deleteRule(id, actor, { author = null } = {}) {
  const result = await query('DELETE FROM inbox_rules WHERE id = $1 RETURNING id, account_id, name, actions', [id]);
  if (!result.rows.length) return { error: 'not_found' };
  const rule = result.rows[0];
  recordAudit(auditOf(actor, {
    accountId: rule.account_id, action: 'rule.deleted', details: { ...ruleAuditDetails(rule), ...onBehalf(author) },
  }));
  return { ok: true };
}

// --- running the rules on the inbox ---------------------------------------------------------------

// The mailboxes a run sweeps: the one named, or every mailbox. { accountIds } or a refusal.
export async function rulesRunTargets(accountId) {
  if (accountId) {
    const mailbox = await findMailboxId(accountId);
    if (mailbox.error) return mailbox;
    return { accountIds: [mailbox.id] };
  }
  const mailboxes = await query('SELECT id FROM email_accounts');
  return { accountIds: mailboxes.rows.map(r => r.id) };
}

// A hand-started run applies (forwarding included) to mail already in the inbox: journal it per
// mailbox, with the rules it runs. Not awaited by the callers.
export function recordRulesRun(accountIds, actor, { allMailboxes }) {
  return query('SELECT id, account_id FROM inbox_rules WHERE enabled = true AND account_id = ANY($1) ORDER BY priority, created_at', [accountIds])
    .then(({ rows }) => {
      const byAccount = new Map();
      for (const rule of rows) byAccount.set(rule.account_id, [...(byAccount.get(rule.account_id) ?? []), rule.id]);
      const entries = [...byAccount].map(([mailboxId, ruleIds]) => auditOf(actor, {
        accountId: mailboxId, action: 'rule.run', details: { ruleIds, allMailboxes },
      }));
      if (entries.length) recordAudit(entries);
      return entries.length;
    });
}

// Mailboxes with a "Run rules on inbox" sweep in flight, in the backend's process.
const runInFlight = new Set();

// Claims the mailboxes for a sweep: one run per mailbox at a time, whoever started it. False when
// one of them is being swept already.
export function claimRulesRun(accountIds) {
  if (accountIds.some(id => runInFlight.has(id))) return false;
  accountIds.forEach(id => runInFlight.add(id));
  return true;
}

// Sweeps the claimed mailboxes and releases them: { ok: true, processed, matched } or { ok: false }.
// The sweep can take minutes on a large mailbox: callers start it in the background. imapMgr: the
// backend's imapManager.
export async function runClaimedRules(accountIds, imapMgr) {
  try {
    const { processed, matched } = await runRulesSweep(accountIds, imapMgr);
    return { ok: true, processed, matched };
  } catch (err) {
    console.error('POST /rules/run sweep error:', err.message);
    return { ok: false };
  } finally {
    accountIds.forEach(id => runInFlight.delete(id));
  }
}

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
        [acctId],
      );
      if (parseInt(rulesCheck.rows[0].cnt, 10) === 0) continue;

      const acctResult = await query(
        'SELECT * FROM email_accounts WHERE id = $1',
        [acctId],
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
          lastId ? [acctId, BATCH, lastId] : [acctId, BATCH],
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
