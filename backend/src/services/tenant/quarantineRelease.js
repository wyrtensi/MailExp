import { query, withTransaction } from '../db.js';
import { JobError, enqueueJob, registerJobKind } from '../jobQueue.js';
import { insertAuditEntries, recordAudit } from '../auditLog.js';
import { getEopSettings } from '../mailNode/eopSettings.js';
import { SYSTEM_ACTOR } from '../mailNode/domains.js';
import { getTenantDriver, tenantOf } from './driver.js';
import { TenantError, asRows, parseQuarantineId } from './exoRunner.js';
import { saveTenantState, tenantContext } from './tenantJobs.js';

// R-42 (decision D-2): high confidence phishing stays in EOP's quarantine (HighConfidencePhishAction
// allows only Quarantine and Redirect), and the panel releases it to the node's mailboxes, where
// the R-11 Sieve rule files it into Junk (PHSH/HPHSH, also with SFV:SKQ, which a released message
// carries) and the panel shows it in the safe view (R-41). R-31 (an administrator releasing by hand,
// the Tenant Allow/Block List) applies only if phishing stayed in quarantine, which D-2 decided
// against: it is not built, and the worker releases no other quarantine type (it reads the message
// again and refuses with quarantine_not_allowed), never -AllowSender or the TABL.
//
// The release is OFF by default (mail_node_phish_release) until experiment 17 confirms the shapes
// of Get-QuarantineMessage on a live tenant; an administrator turns it on (journaled).
//
// The job tenant_quarantine_release runs every poll slot (10 minutes) and on "Release now". One run
// at a time: a run holds RUN_LOCK_PROVIDER (a run that died frees it after RUN_LOCK_STALE_MINUTES);
// a second one (a slot and a button at once, a lease that expired) ends at once.
// 1. candidates: the messages Get-QuarantineMessage lists (pinned by the worker to inbound
//    HighConfPhish not yet released, up to MAX_PAGES pages of 100) that the table does not hold as
//    final, alternating with the rows left behind (oldest first): 'releasing' (the process stopped
//    after the claim), 'failed' with attempts left, and, every RECHECK_EXHAUSTED_MS, the rows whose
//    attempts ran out (a read settles them if the release did happen after all);
// 2. per message (at most MAX_MESSAGES_PER_RUN a run): read it by its Identity (only then are its
//    recipients shown) and apply the guards (decide()); a message that passes is claimed (the row
//    goes 'releasing' atomically, so two runs never both release it), released with -ReleaseToAll,
//    and marked released with its journal entry in one transaction, the entry only on a real
//    transition to 'released'. The switch is read again before each claim (cached RELEASE_CHECK_MS).
//    A follow-up job comes 30 s later only when the run left candidates and changed something.
//
// Guards: the type is high confidence phishing; the direction is inbound (outbound phishing from a
// node mailbox is never released to the internet); every recipient is on a domain of the node
// that receives mail through EOP (states connector_ready, ready, authoritative); the message is not
// released, being released or denied already. A message kept by a guard stays 'skipped' with its
// reason; while it is still in the quarantine (until it expires) the alert tenant_phish_held says
// so, together with the messages whose attempts ran out.
//
// Attempts (MAX_RELEASE_ATTEMPTS): a failed read by Identity and a failed release count one each;
// a message the quarantine does not know is 'gone' only when a second read says so too.
// Idempotency: the row is the claim, and a 'releasing' row is resolved by reading the message back
// before anything is sent again: released -> released (by the panel), not released -> released
// again (attempts + 1). A release whose answer is lost (worker timeout) stays 'releasing' for that
// read. That this never releases twice rests on two Inferred facts (experiment 24): EOP shows the
// message released within CLAIM_STALE_MINUTES, and a second Release- without -Force is refused.
// Throttling ends the run with what it did kept and queues the job again after Retry-After or 1, 2,
// 4 ... minutes; it costs the message no attempt.

export const QUARANTINE_RELEASE_KIND = 'tenant_quarantine_release';
export const RELEASE_SETTINGS_PROVIDER = 'mail_node_phish_release';
export const RUN_LOCK_PROVIDER = 'mail_node_phish_release_run';
export const MAX_MESSAGES_PER_RUN = 25;
export const MAX_PAGES = 5;
export const PAGE_SIZE = 100;
export const MAX_RELEASE_ATTEMPTS = 3;
// The domain states whose mail comes through EOP to the node: the release goes only to them.
export const RELEASE_DOMAIN_STATES = Object.freeze(['connector_ready', 'ready', 'authoritative']);
export const RECHECK_EXHAUSTED_MS = 6 * 60 * 60 * 1000;
export const RELEASE_CHECK_MS = 5 * 1000;
const MAX_JOB_ATTEMPTS = 4;
const FOLLOW_UP_MS = 30 * 1000;
// A claim older than this is a run that died; a younger one belongs to a run still going.
export const CLAIM_STALE_MINUTES = 10;
const RUN_LOCK_STALE_MINUTES = 30;
const RETENTION_DAYS = 45;
const TEXT_MAX = 300;
const UNCERTAIN = new Set(['worker_timeout', 'worker_unreachable']);
const THROTTLED = new Set(['exo_throttled', 'graph_throttled']);

const lower = (value) => String(value ?? '').trim().toLowerCase();
const trim = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
};
const isoOrNull = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const listOf = (value) => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);

// Off unless an administrator turned it on.
export async function getReleaseSettings() {
  const { rows } = await query('SELECT config FROM integration_config WHERE provider = $1', [RELEASE_SETTINGS_PROVIDER]);
  const config = rows[0]?.config ?? {};
  return { enabled: config.enabled === true, changedAt: config.changedAt ?? null, changedBy: config.changedBy ?? null };
}

// The switch, journaled when it changes.
export async function setReleaseEnabled(enabled, { userId = null, now = Date.now() } = {}) {
  const before = await getReleaseSettings();
  const config = { enabled: !!enabled, changedAt: new Date(now).toISOString(), changedBy: userId };
  await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [RELEASE_SETTINGS_PROVIDER, config]);
  if (before.enabled !== config.enabled) {
    recordAudit({ actorUserId: userId, action: 'tenant.phish_release_changed', details: { enabled: config.enabled } });
  }
  return config;
}

// What a run does with a message read by its Identity: { act: 'release' } | { act: 'released' } |
// { act: 'skip', reason } | { act: 'wait', reason }. domains: the node's domains, lower case.
export function decide(row, domains) {
  const types = listOf(row?.QuarantineTypes).map(lower);
  const phish = types.includes('highconfphish') || /high\s*conf(idence)?\s*phish/i.test(String(row?.Type ?? ''));
  if (!phish) return { act: 'skip', reason: 'not_high_conf_phish' };
  if (lower(row?.Direction) !== 'inbound') return { act: 'skip', reason: 'outbound' };
  const status = lower(row?.ReleaseStatus).replace(/[\s_]/g, '');
  if (status === 'released' || status === 'approved') return { act: 'released' };
  if (status === 'denied') return { act: 'skip', reason: 'release_denied' };
  if (status === 'preparingtorelease' || status === 'requested') return { act: 'wait', reason: status };
  if (status && status !== 'notreleased' && status !== 'error') return { act: 'wait', reason: 'status_unknown' };
  const recipients = recipientsOf(row);
  if (!recipients.length) return { act: 'skip', reason: 'no_recipients' };
  const known = new Set(domains);
  if (recipients.some((address) => !known.has(address.slice(address.lastIndexOf('@') + 1)))) {
    return { act: 'skip', reason: 'foreign_recipients' };
  }
  return { act: 'release' };
}

export function recipientsOf(row) {
  return [...new Set(listOf(row?.RecipientAddress).map(lower).filter((a) => a.includes('@')))].sort();
}

function facts(row) {
  return {
    messageId: trim(row?.MessageId),
    sender: trim(lower(row?.SenderAddress)),
    subject: trim(row?.Subject),
    recipients: recipientsOf(row),
    receivedAt: isoOrNull(row?.ReceivedTime),
    expiresAt: isoOrNull(row?.Expires),
  };
}
const storedFacts = (stored) => facts(stored ? {
  MessageId: stored.message_id, SenderAddress: stored.sender, Subject: stored.subject, RecipientAddress: stored.recipients,
} : {});

// Writes what a run learned about a message (not the claim): a final state or a failure. Answers
// the row's attempts after the write.
async function record(identity, state, f, { reason = null, error = null, byPanel = null, releasedAt = null, attemptsDelta = 0 } = {}, db = { query }) {
  const { rows } = await db.query(`
    INSERT INTO tenant_quarantine_releases
      (identity, message_id, sender, subject, recipients, received_at, expires_at, state, reason, error, attempts, by_panel, released_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, GREATEST($11, 0), COALESCE($12, false), $13)
    ON CONFLICT (identity) DO UPDATE SET
      message_id = COALESCE(EXCLUDED.message_id, tenant_quarantine_releases.message_id),
      sender = COALESCE(EXCLUDED.sender, tenant_quarantine_releases.sender),
      subject = COALESCE(EXCLUDED.subject, tenant_quarantine_releases.subject),
      recipients = CASE WHEN cardinality(EXCLUDED.recipients) > 0 THEN EXCLUDED.recipients ELSE tenant_quarantine_releases.recipients END,
      received_at = COALESCE(EXCLUDED.received_at, tenant_quarantine_releases.received_at),
      expires_at = COALESCE(EXCLUDED.expires_at, tenant_quarantine_releases.expires_at),
      state = EXCLUDED.state, reason = EXCLUDED.reason, error = EXCLUDED.error,
      attempts = GREATEST(tenant_quarantine_releases.attempts + $11, 0),
      by_panel = COALESCE($12, tenant_quarantine_releases.by_panel),
      released_at = COALESCE(EXCLUDED.released_at, tenant_quarantine_releases.released_at),
      updated_at = NOW()
    RETURNING attempts
  `, [identity, f.messageId, f.sender, f.subject, f.recipients, f.receivedAt, f.expiresAt, state, reason, error, attemptsDelta, byPanel, releasedAt]);
  return rows[0]?.attempts ?? 0;
}

// A failure that costs the message an attempt: 'failed' with its reason, or attempts_exhausted
// once they ran out (held, alerted, re-read every RECHECK_EXHAUSTED_MS).
async function recordFailure(identity, f, reason, error, stored) {
  const after = (stored?.attempts ?? 0) + 1;
  await record(identity, 'failed', f, {
    reason: after >= MAX_RELEASE_ATTEMPTS ? 'attempts_exhausted' : reason, error, attemptsDelta: 1,
  });
}

const touch = (identity, error = null) => query(
  'UPDATE tenant_quarantine_releases SET error = COALESCE($2, error), updated_at = NOW() WHERE identity = $1', [identity, error],
);

// The claim: a new message, a failed one, or a claim left by a run that died becomes 'releasing'
// with one more attempt. Answers its attempts, or null when another run holds it.
async function claim(identity, f) {
  const { rows } = await query(`
    INSERT INTO tenant_quarantine_releases
      (identity, message_id, sender, subject, recipients, received_at, expires_at, state, attempts)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'releasing', 1)
    ON CONFLICT (identity) DO UPDATE SET
      state = 'releasing', attempts = tenant_quarantine_releases.attempts + 1, error = NULL, reason = NULL,
      recipients = EXCLUDED.recipients, updated_at = NOW()
      WHERE (tenant_quarantine_releases.state = 'failed' AND tenant_quarantine_releases.attempts < $9)
         OR (tenant_quarantine_releases.state = 'releasing'
             AND tenant_quarantine_releases.updated_at < NOW() - make_interval(mins => $8::int))
    RETURNING attempts
  `, [identity, f.messageId, f.sender, f.subject, f.recipients, f.receivedAt, f.expiresAt, CLAIM_STALE_MINUTES, MAX_RELEASE_ATTEMPTS]);
  return rows.length ? rows[0].attempts : null;
}

// Marks a message released and journals it, together; the entry only when this call moved the row
// to 'released' (two overlapping runs never journal one release twice). Answers whether it did.
export async function markReleased(identity, f, { byPanel, now }) {
  return withTransaction(async (tx) => {
    const at = new Date(now).toISOString();
    let { rows } = await tx.query(`
      UPDATE tenant_quarantine_releases SET state = 'released', reason = NULL, error = NULL, by_panel = $2, released_at = $3,
             message_id = COALESCE($4, message_id), sender = COALESCE($5, sender), subject = COALESCE($6, subject),
             recipients = CASE WHEN cardinality($7::text[]) > 0 THEN $7::text[] ELSE recipients END,
             received_at = COALESCE($8, received_at), expires_at = COALESCE($9, expires_at), updated_at = NOW()
       WHERE identity = $1 AND state <> 'released'
      RETURNING identity`,
    [identity, !!byPanel, at, f.messageId, f.sender, f.subject, f.recipients, f.receivedAt, f.expiresAt]);
    if (!rows.length) {
      ({ rows } = await tx.query(`
        INSERT INTO tenant_quarantine_releases
          (identity, message_id, sender, subject, recipients, received_at, expires_at, state, by_panel, released_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'released', $8, $9)
        ON CONFLICT (identity) DO NOTHING
        RETURNING identity`,
      [identity, f.messageId, f.sender, f.subject, f.recipients, f.receivedAt, f.expiresAt, !!byPanel, at]));
    }
    const moved = rows.length > 0;
    if (moved && byPanel) {
      await insertAuditEntries(tx, [{
        actorEmail: SYSTEM_ACTOR,
        action: 'tenant.quarantine_released',
        details: { identity, messageId: f.messageId, sender: f.sender, recipients: f.recipients, receivedAt: f.receivedAt },
      }]);
    }
    return moved;
  });
}

class Throttled extends Error {
  constructor(err) {
    super(err.message);
    this.code = err.code;
    this.retryAfterMs = err.retryAfterMs ?? null;
  }
}
class Paused extends Error {}
const isThrottled = (err) => err instanceof TenantError && THROTTLED.has(err.code);
const isCode = (err, code) => err instanceof TenantError && err.code === code;
const failureText = (err) => `${err?.code ?? 'tenant_failed'}: ${String(err?.message ?? '').slice(0, 200)}`;

// The message with exactly this Identity, or null (Learn: an -Identity that does not exist answers
// every message; the worker keeps only the exact one, and so does the panel).
async function readMessage(session, identity) {
  const rows = asRows(await session.exo.run('get_quarantine_message', { identity }));
  return rows.find((row) => lower(row.Identity) === identity) ?? null;
}

// One message, from its read by Identity to its outcome: 'released' | 'skipped' | 'waiting' |
// 'failed' | 'busy' | 'gone' | 'checked'. stored: its row, or null. stillOn(): the switch, read
// again before a claim.
async function handleMessage(session, identity, stored, domains, now, stillOn) {
  // A row whose attempts ran out is only read again: settled if the release happened after all,
  // gone if the quarantine dropped it, else left held (no new attempt).
  const exhausted = stored?.state === 'failed' && stored.reason === 'attempts_exhausted';
  let row;
  try {
    row = await readMessage(session, identity);
  } catch (err) {
    if (isThrottled(err)) throw new Throttled(err);
    if (exhausted) {
      await touch(identity, failureText(err));
      return 'checked';
    }
    // Nothing is released blind: the failed read costs an attempt, so it cannot hold the queue.
    await recordFailure(identity, storedFacts(stored), 'read_failed', failureText(err), stored);
    return 'failed';
  }
  if (!row) {
    // Expired or deleted from the quarantine, if a second read says so too.
    if (stored?.reason === 'not_found' || exhausted) {
      await record(identity, 'skipped', storedFacts(stored), { reason: 'gone' });
      return 'gone';
    }
    await recordFailure(identity, storedFacts(stored), 'not_found', null, stored);
    return 'failed';
  }
  const f = facts(row);
  const verdict = decide(row, domains);
  // A message the panel claimed or tried and that EOP now shows released was released by the panel.
  const sentByPanel = stored?.state === 'releasing' || (stored?.state === 'failed' && stored.reason !== 'read_failed' && stored.reason !== 'not_found');
  if (verdict.act === 'released') {
    await markReleased(identity, f, { byPanel: sentByPanel, now });
    return 'released';
  }
  if (exhausted) {
    await touch(identity);
    return 'checked';
  }
  if (verdict.act === 'skip') {
    await record(identity, 'skipped', f, { reason: verdict.reason });
    return 'skipped';
  }
  if (verdict.act === 'wait') return 'waiting';
  if (stored && stored.attempts >= MAX_RELEASE_ATTEMPTS) {
    await record(identity, 'failed', f, { reason: 'attempts_exhausted', error: stored.error });
    return 'failed';
  }
  if (!(await stillOn())) throw new Paused();
  const attempts = await claim(identity, f);
  if (attempts == null) return 'busy';
  try {
    await session.exo.run('release_quarantine_message', { identity });
  } catch (err) {
    if (isThrottled(err)) {
      // Refused, not applied: the attempt is given back and the run ends.
      await record(identity, 'failed', f, { error: failureText(err), attemptsDelta: -1 });
      throw new Throttled(err);
    }
    if (err instanceof TenantError && UNCERTAIN.has(err.code)) {
      // The answer was lost, not the release: the next run reads the message back first.
      await touch(identity, failureText(err));
      return 'failed';
    }
    if (isCode(err, 'quarantine_not_allowed')) {
      // The worker's own read found no inbound high confidence phishing: never released.
      await record(identity, 'skipped', f, { reason: 'worker_refused', error: failureText(err) });
      return 'skipped';
    }
    if (isCode(err, 'exo_not_found')) {
      await record(identity, 'failed', f, { reason: attempts >= MAX_RELEASE_ATTEMPTS ? 'attempts_exhausted' : 'not_found', error: failureText(err) });
      return 'failed';
    }
    await record(identity, 'failed', f, { error: failureText(err), reason: attempts >= MAX_RELEASE_ATTEMPTS ? 'attempts_exhausted' : null });
    return 'failed';
  }
  await markReleased(identity, f, { byPanel: true, now });
  return 'released';
}

// Alternates two lists: a, b, a, b, ... then the rest of the longer one.
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// The switch as a run sees it: read again when older than RELEASE_CHECK_MS.
function switchReader(checkMs = RELEASE_CHECK_MS) {
  let at = 0;
  let on = true;
  return async () => {
    if (Date.now() - at >= checkMs) {
      on = (await getReleaseSettings()).enabled;
      at = Date.now();
    }
    return on;
  };
}

// One run: { at, ok, paused?, counts, left, error? }. Throws Throttled after saving what it did.
export async function runRelease(context, { now = Date.now(), releaseCheckMs = RELEASE_CHECK_MS } = {}) {
  const at = new Date(now).toISOString();
  const counts = {
    released: 0, skipped: 0, failed: 0, waiting: 0, gone: 0, busy: 0, checked: 0,
  };
  const stillOn = switchReader(releaseCheckMs);
  if (!(await stillOn())) return { at, ok: true, paused: true, counts, left: false };
  await query(`DELETE FROM tenant_quarantine_releases WHERE updated_at < NOW() - make_interval(days => $1::int)`, [RETENTION_DAYS]);
  const { rows: domainRows } = await query('SELECT domain FROM mail_node_domains WHERE state = ANY($1::text[]) ORDER BY domain', [RELEASE_DOMAIN_STATES]);
  const domains = domainRows.map((r) => lower(r.domain));
  if (!domains.length) return { at, ok: true, noDomains: true, counts, left: false };

  const { rows: storedRows } = await query('SELECT * FROM tenant_quarantine_releases ORDER BY updated_at, identity');
  const stored = new Map(storedRows.map((r) => [r.identity, r]));
  // Left behind by earlier runs, oldest first; exhausted rows only every RECHECK_EXHAUSTED_MS.
  const leftovers = storedRows.filter((r) => r.state === 'releasing'
    || (r.state === 'failed' && r.reason !== 'attempts_exhausted' && r.attempts < MAX_RELEASE_ATTEMPTS)
    || (r.state === 'failed' && r.reason === 'attempts_exhausted' && now - Date.parse(new Date(r.updated_at).toISOString()) >= RECHECK_EXHAUSTED_MS))
    .map((r) => r.identity);
  const queued = new Set(leftovers);
  const fresh = [];
  let listed = true;
  for (let page = 1; page <= MAX_PAGES && fresh.length < MAX_MESSAGES_PER_RUN + 1; page += 1) {
    let rows;
    try {
      rows = asRows(await context.session.exo.run('get_quarantine_messages', { page: String(page) }));
    } catch (err) {
      if (isThrottled(err)) throw new Throttled(err);
      if (!leftovers.length && !fresh.length) throw err;
      listed = false;
      break;
    }
    for (const row of rows) {
      const identity = parseQuarantineId(row.Identity);
      if (!identity || queued.has(identity)) continue;
      if (stored.has(identity)) continue; // final, or a leftover already queued
      fresh.push(identity);
      queued.add(identity);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const queue = interleave(fresh, leftovers);
  let done = 0;
  let paused = false;
  for (const identity of queue) {
    if (done >= MAX_MESSAGES_PER_RUN) break;
    done += 1;
    try {
      const outcome = await handleMessage(context.session, identity, stored.get(identity) ?? null, domains, now, stillOn);
      counts[outcome] += 1;
    } catch (err) {
      if (!(err instanceof Paused)) throw err;
      paused = true;
      break;
    }
  }
  // A follow-up only when there is more and this run moved something (no loop over a stuck queue).
  const progressed = counts.released + counts.skipped + counts.gone + counts.failed > 0;
  return {
    at, ok: listed, counts, left: !paused && queue.length > done && progressed,
    ...(paused ? { paused: true } : {}), ...(listed ? {} : { error: { code: 'list_failed' } }),
  };
}

// One run at a time: the lock row names the job; a lock older than RUN_LOCK_STALE_MINUTES is a run
// that died. Answers whether this job holds it.
async function lockRun(jobId) {
  const { rows } = await query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
      WHERE integration_config.config->>'job' IS NULL
         OR integration_config.config->>'job' = $3
         OR integration_config.updated_at < NOW() - make_interval(mins => $4::int)
    RETURNING provider
  `, [RUN_LOCK_PROVIDER, { job: String(jobId) }, String(jobId), RUN_LOCK_STALE_MINUTES]);
  return rows.length > 0;
}
const unlockRun = (jobId) => query(
  `UPDATE integration_config SET config = '{}'::jsonb, updated_at = NOW() WHERE provider = $1 AND config->>'job' = $2`,
  [RUN_LOCK_PROVIDER, String(jobId)],
).catch((err) => console.error(`Phish release lock not freed: ${err?.code || err?.message}`));

export async function handleReleaseJob(job, ctx, { now = Date.now() } = {}) {
  const context = await tenantContext();
  const jobId = job?.id ?? `run-${now}`;
  // Another run is going (a slot and "Release now" at once, or a lease that expired): it does the work.
  if (!(await lockRun(jobId))) return { skipped: 'phish_release_busy' };
  let result;
  try {
    result = await runRelease(context, { now });
  } catch (err) {
    const at = new Date(now).toISOString();
    if (err instanceof Throttled) {
      await saveTenantState({ phishRelease: { at, ok: false, throttled: { code: err.code, retryAfterMs: err.retryAfterMs } } });
      throw new JobError(`The tenant asked to slow down (${err.code})`, { outcome: 'retry', code: err.code, delayMs: err.retryAfterMs ?? null });
    }
    const failure = err instanceof TenantError
      ? { code: err.code, message: String(err.message ?? '').slice(0, TEXT_MAX) }
      : { code: 'tenant_failed', message: 'The release run failed; see the server log' };
    if (!(err instanceof TenantError)) console.error(`Phish release run failed: ${err?.code || err?.name || 'error'}`);
    await saveTenantState({ phishRelease: { at, ok: false, error: failure } });
    return { error: failure.code };
  } finally {
    await unlockRun(jobId);
  }
  if (result.left) await enqueueJob({ kind: QUARANTINE_RELEASE_KIND, delayMs: FOLLOW_UP_MS });
  if (ctx?.complete) await ctx.complete((tx) => saveTenantState({ phishRelease: result }, tx));
  else await saveTenantState({ phishRelease: result });
  return result;
}

// The slot's run, once (the slot is the dedupe key); nothing without a driver, a configured tenant,
// or while off, or while a run is queued or going. Two jobs that still meet (this and "Release now"
// at the same moment) do no harm: the run lock lets one work and the other end at once.
export async function enqueueReleaseSlot(now = Date.now(), slotMs = 10 * 60 * 1000) {
  if (!getTenantDriver()) return null;
  if (!tenantOf(await getEopSettings())) return null;
  if (!(await getReleaseSettings()).enabled) return null;
  const { rows: [busy] } = await query(`SELECT id FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1`, [QUARANTINE_RELEASE_KIND]);
  if (busy) return null;
  const { job } = await enqueueJob({ kind: QUARANTINE_RELEASE_KIND, dedupeKey: `slot-${Math.floor(now / slotMs)}` });
  return job;
}

// For the screen: the newest rows.
export async function listReleases({ limit = 100 } = {}) {
  const { rows } = await query(`SELECT * FROM tenant_quarantine_releases ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return rows.map((row) => {
    const error = row.error ? String(row.error) : null;
    const code = error && /^[a-z][a-z0-9_]{1,63}:/.test(error) ? error.slice(0, error.indexOf(':')) : null;
    return {
      identity: row.identity,
      messageId: row.message_id,
      sender: row.sender,
      subject: row.subject,
      recipients: row.recipients ?? [],
      receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      state: row.state,
      reason: row.reason,
      error,
      errorCode: code,
      attempts: row.attempts,
      byPanel: row.by_panel,
      releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

// The messages the panel keeps in the quarantine and that are still there (not expired): a guard
// skipped them (not 'gone') or their attempts ran out. The alert tenant_phish_held.
export async function heldSummary(now = Date.now()) {
  const { rows: [row] } = await query(`
    SELECT COUNT(*)::int AS count, MIN(expires_at) AS soonest
      FROM tenant_quarantine_releases
     WHERE ((state = 'skipped' AND reason <> 'gone') OR (state = 'failed' AND reason = 'attempts_exhausted'))
       AND (expires_at IS NULL OR expires_at > $1)
  `, [new Date(now).toISOString()]);
  return { count: row?.count ?? 0, soonestExpiresAt: row?.soonest ? new Date(row.soonest).toISOString() : null };
}

export function registerQuarantineReleaseKind() {
  registerJobKind(QUARANTINE_RELEASE_KIND, { maxAttempts: MAX_JOB_ATTEMPTS, handler: (job, ctx) => handleReleaseJob(job, ctx) });
}
