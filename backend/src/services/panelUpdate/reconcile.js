// Journals how a panel update went: started, finished or failed.
//
// The backend restarts in the middle of its own update, so these entries cannot be written by the
// request that asked for the update. Instead the results the host's updater leaves in the spool are
// read on each GET /api/admin/update and every 30 s, and any entry the journal does not hold yet
// (by details->>'requestId' and action) is written under the administrator of the matching
// panel.update_requested entry. One pass runs at a time; dedupe relies on that and on a single
// backend process, there is no unique constraint in the table.
import { query as dbQuery } from '../db.js';
import { recordAudit as dbRecordAudit } from '../auditLog.js';
import { getSpool as defaultGetSpool } from './spool.js';

const REQUESTED = 'panel.update_requested';
const STARTED = 'panel.update_started';
const FINISHED = 'panel.update_finished';
const FAILED = 'panel.update_failed';
const ACTIONS = [REQUESTED, STARTED, FINISHED, FAILED];

const STARTED_STATES = new Set(['updating', 'rolling_back', 'succeeded', 'failed', 'rolled_back', 'rollback_failed']);
const FAILED_STATES = new Set(['failed', 'rolled_back', 'rollback_failed', 'refused', 'blocked', 'error']);

const DAY_MS = 24 * 60 * 60 * 1000;

// The journal entries a result calls for, in the order they happened.
function entriesFor(result) {
  const base = { requestId: result.id, target: result.target, from: result.from };
  const out = [];
  if (STARTED_STATES.has(result.state)) out.push({ action: STARTED, details: { ...base, state: 'updating', exitCode: null } });
  if (result.state === 'succeeded') out.push({ action: FINISHED, details: { ...base, state: result.state, exitCode: result.exitCode } });
  if (FAILED_STATES.has(result.state)) out.push({ action: FAILED, details: { ...base, state: result.state, exitCode: result.exitCode } });
  return out;
}

const keyOf = (requestId, action) => `${requestId}:${action}`;

export function createReconciler({ getSpool = defaultGetSpool, query = dbQuery, recordAudit = dbRecordAudit } = {}) {
  const journaled = new Set(); // keys the journal was seen to hold
  let running = null;

  async function pass() {
    const results = (await getSpool().readResults()).filter((r) => r.action === 'update');
    const wanted = results.flatMap((r) => entriesFor(r).map((e) => ({ ...e, result: r })))
      .filter((e) => !journaled.has(keyOf(e.result.id, e.action)));
    if (!wanted.length) return;

    const ids = [...new Set(wanted.map((e) => e.result.id))];
    const since = Math.min(...wanted.map((e) => Date.parse(e.result.receivedAt ?? e.result.updatedAt ?? '') || 0));
    const { rows } = await query(
      `SELECT action, details->>'requestId' AS request_id, actor_user_id, actor_email
         FROM mailbox_audit_log
        WHERE action = ANY($1::text[]) AND details->>'requestId' = ANY($2::text[]) AND occurred_at >= $3`,
      [ACTIONS, ids, new Date(Math.max(0, since - DAY_MS)).toISOString()],
    );
    const actors = new Map();
    for (const row of rows) {
      if (row.action === REQUESTED) actors.set(row.request_id, row);
      else journaled.add(keyOf(row.request_id, row.action));
    }

    const entries = wanted.filter((e) => !journaled.has(keyOf(e.result.id, e.action))).map((e) => {
      const actor = actors.get(e.result.id);
      return {
        action: e.action,
        actorUserId: actor?.actor_user_id ?? null,
        actorEmail: actor?.actor_email ?? null,
        details: e.details,
      };
    });
    if (entries.length) await recordAudit(entries);
  }

  // Never rejects: a failure is logged by its code only and the next pass tries again.
  return function reconcile() {
    running ??= pass()
      .catch((err) => { console.error('[panel-update] Journal reconcile failed:', err?.code || err?.name || 'Error'); })
      .finally(() => { running = null; });
    return running;
  };
}

let defaultReconcile = null;

export function reconcileUpdateAudit() {
  defaultReconcile ??= createReconciler();
  return defaultReconcile();
}

// Runs the reconciler every 30 s without keeping the process alive. Returns a stop function.
export function startUpdateAuditReconciler({ reconcile = reconcileUpdateAudit, intervalMs = 30_000 } = {}) {
  const timer = setInterval(() => { reconcile().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
