import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../db.js';
import { currentOf } from '../panelUpdate/latest.js';

// The mail node's agent (scripts/deploy/mail-node/node-agent.sh): a service on the node host that
// long-polls the panel for jobs over HTTPS (it opens no port on the node), runs the ones it knows
// (a status report, a backup of the node, an update of the node's scripts to the panel's commit)
// and reports their progress. It authenticates with its own
// token: the panel keeps only the token's sha256, shows the token once, and a rotation or a
// revocation ends the old one at once. Tables: node_agent (one row) and node_agent_jobs (migration
// 0093). The routes are routes/mailNodeAgent.js.

export const AGENT_JOB_KINDS = Object.freeze(['status', 'backup', 'update']);
// Kinds that change the node: one of them at a time (a backup during an update, or an update
// during a backup, is refused).
const EXCLUSIVE_KINDS = Object.freeze(['backup', 'update']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const JOB_STATES = new Set(['queued', 'running', 'succeeded', 'failed']);
const FINAL_STATES = new Set(['succeeded', 'failed']);

// The agent polls at least every 50 seconds: seen within three minutes is connected.
export const CONNECTED_WITHIN_MS = 3 * 60 * 1000;
// The longest one poll may wait (the panel's nginx gives /api/ 60 seconds).
export const MAX_POLL_WAIT_MS = 50 * 1000;
// How often a waiting poll looks at the table again, besides the wake-up of an enqueue here.
const POLL_RECHECK_MS = 5000;
// A job queued this long was never picked up (the agent is offline); one running past its kind's
// bound has lost its agent. Both are failed so the screen never waits for ever.
export const QUEUED_TIMEOUT_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// The bounds of the steps of an update on the node (scripts/deploy/mail-node/node-update.sh, which
// applies the same numbers): the pre-update backup (node-backup.sh, bounded as a backup job) with
// up to an hour waiting for another backup's lock, the fetch, setup.sh at the new commit and again
// at the previous one on a rollback (or after a failed mailcow update: one or the other runs),
// mailcow's own update (update.sh, setup.sh again, the start and the wait for healthy containers,
// each bounded by what is left of these 30 minutes), mailcow started again after a failed update,
// and the checks after.
export const UPDATE_STEP_BOUNDS_MS = Object.freeze({
  fetch: 5 * MINUTE_MS,
  backup: 6 * 60 * MINUTE_MS,
  backupLockWait: 60 * MINUTE_MS,
  setup: 30 * MINUTE_MS,
  rollbackSetup: 30 * MINUTE_MS,
  mailcow: 30 * MINUTE_MS,
  mailcowRestart: 10 * MINUTE_MS,
  checks: 10 * MINUTE_MS,
});
// The longest an update may run at all, whatever it reports: its steps' bounds added up.
export const UPDATE_CEILING_MS = Object.values(UPDATE_STEP_BOUNDS_MS).reduce((a, b) => a + b, 0);
export const RUNNING_TIMEOUT_MS = Object.freeze({
  status: 15 * MINUTE_MS,
  backup: 6 * 60 * MINUTE_MS,
  update: UPDATE_CEILING_MS,
});
// An update runs detached from the agent (node-update.sh), which may restart meanwhile (setup.sh
// restarts it when its files change) and poll again. The update reports at least every 15 seconds:
// one reported within this bound is alive. It is not failed as an orphan by the agent's poll, and
// it is not failed for its length below UPDATE_CEILING_MS; one silent past this bound has died
// (update_silent).
export const UPDATE_HEARTBEAT_MS = 5 * MINUTE_MS;

// What the server keeps of the agent's reports.
export const MAX_LOG_TAIL = 8000;
export const MAX_STEP = 200;
const MAX_ERROR = 500;
const MAX_RECENT_JOBS = 50;

const TOKEN_PREFIX = 'mxna_';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

export class NodeAgentError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Enqueues wake the poll waiting in this process at once; another process's enqueue is seen at the
// next recheck.
const wakeups = new EventEmitter();
wakeups.setMaxListeners(50);

export const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

export function newToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

// The token from an Authorization header ("Bearer <token>"), or null.
export function bearerToken(header) {
  const match = /^Bearer ([^\s]+)$/.exec(String(header ?? ''));
  return match && TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

// Issues the agent's token, replacing the one before (a rotation ends it at once). Returns the
// token, the only time it exists outside the agent's file.
const failActiveJobs = (client, error) => client.query(
  `UPDATE node_agent_jobs SET state = 'failed', error = $1, finished_at = now(), updated_at = now()
    WHERE state IN ('queued', 'running')`,
  [error]
);

export async function issueToken(userId) {
  const token = newToken();
  return withTransaction(async (client) => {
    const { rows: before } = await client.query('SELECT token_hash FROM node_agent WHERE id = 1 FOR UPDATE');
    const rotated = !!before[0]?.token_hash;
    const { rows } = await client.query(
      `INSERT INTO node_agent (id, token_hash, token_created_at, token_created_by, last_seen_at)
       VALUES (1, $1, now(), $2, NULL)
       ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_created_at = EXCLUDED.token_created_at,
         token_created_by = EXCLUDED.token_created_by, last_seen_at = NULL
       RETURNING token_created_at`,
      [hashToken(token), userId ?? null]
    );
    // The old token's agent can no longer report what it holds.
    if (rotated) await failActiveJobs(client, 'agent_token_rotated');
    return { token, createdAt: rows[0].token_created_at, rotated };
  });
}

// Revokes the token: the agent is refused from its next request. Its waiting and running jobs fail
// now, since nobody can report them any more. Returns whether there was a token.
export async function revokeToken() {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'UPDATE node_agent SET token_hash = NULL, last_seen_at = NULL WHERE id = 1 AND token_hash IS NOT NULL'
    );
    await failActiveJobs(client, 'agent_revoked');
    return rowCount > 0;
  });
}

// The stored hash when a presented token is the agent's (compared by hash, in constant time), or
// null; a match records the agent as seen. Later writes for the agent check the hash is still the
// current one, so a poll or report already under way ends with a rotation or revocation.
export async function authenticateAgent(token) {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const stored = await readStoredHash();
  if (!matchesHash(token, stored)) return null;
  await query('UPDATE node_agent SET last_seen_at = now() WHERE id = 1');
  return stored;
}

async function readStoredHash() {
  const { rows } = await query('SELECT token_hash FROM node_agent WHERE id = 1');
  const stored = rows[0]?.token_hash;
  return stored && /^[0-9a-f]{64}$/.test(stored) ? stored : null;
}

function matchesHash(token, stored) {
  if (!stored) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(stored, 'hex'));
}

// Whether a token may be the agent's, against a copy of the stored hash this process reads at most
// once per STORED_HASH_TTL_MS: the refusal limit (routes/mailNodeAgent.js) asks it while refused
// tokens are answered 429, so they cost no database read, and only a match goes on to
// authenticateAgent (which reads the hash afresh and refuses a revoked token). The copy may lag a
// rotation, in this process or another (the panel CLI), by up to the TTL: a new token can be
// answered 429 that long while the limit holds, and the agent retries after its backoff.
const STORED_HASH_TTL_MS = 1000;
let storedHashCopy = { hash: null, at: -Infinity };
// One read at a time: concurrent requests share it.
let storedHashRead = null;

export async function mayBeAgentToken(token) {
  if (!token || !TOKEN_PATTERN.test(token)) return false;
  if (Date.now() - storedHashCopy.at >= STORED_HASH_TTL_MS) {
    storedHashRead ??= readStoredHash()
      .then((hash) => { storedHashCopy = { hash, at: Date.now() }; })
      .finally(() => { storedHashRead = null; });
    await storedHashRead;
  }
  return matchesHash(token, storedHashCopy.hash);
}

// Tests: the next mayBeAgentToken reads the stored hash.
export function resetStoredHashCopy() {
  storedHashCopy = { hash: null, at: -Infinity };
}

const TOKEN_CURRENT = 'EXISTS (SELECT 1 FROM node_agent WHERE id = 1 AND token_hash = $1)';

const capText = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);
const commitOrNull = (value) => (typeof value === 'string' && SHA_PATTERN.test(value) ? value : null);
const TAG_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
const tagOrNull = (value) => (typeof value === 'string' && TAG_PATTERN.test(value) ? value : null);
// How the node's mailcow compares with the version its MailExpert checkout pins (node-agent.sh
// mailcow_relation).
const MAILCOW_RELATIONS = new Set(['match', 'behind', 'newer', 'diverged', 'unknown']);
// The end of a log, which holds the outcome.
const capTail = (value, max) => (typeof value === 'string' && value ? value.slice(-max) : null);
const wholeNumber = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

// The fields of the node's backup-last.json (node-backup.sh) the panel shows.
function presentBackupLast(last) {
  if (!last || typeof last !== 'object' || Array.isArray(last)) return null;
  const finishedAt = capText(last.finished_at, 40);
  if (!finishedAt || Number.isNaN(Date.parse(finishedAt))) return null;
  return {
    finishedAt: new Date(finishedAt).toISOString(),
    tag: capText(last.tag, 20),
    seconds: wholeNumber(last.seconds),
    dumpBytes: wholeNumber(last.dump_bytes),
    processedBytes: wholeNumber(last.processed_bytes),
    addedBytes: wholeNumber(last.added_bytes),
    partial: last.partial === true,
    verified: last.verified === true,
  };
}

// The agent's status report, kept to known fields of bounded size: the agent runs on another
// host, the panel trusts only the shape it expects.
export function sanitizeStatus(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const containers = input.containers && typeof input.containers === 'object' ? input.containers : {};
  const backup = input.backup && typeof input.backup === 'object' ? input.backup : {};
  const problems = Array.isArray(containers.problems)
    ? containers.problems.filter((p) => typeof p === 'string' && p).slice(0, 30).map((p) => p.slice(0, 100))
    : [];
  return {
    scriptsCommit: capText(input.scriptsCommit, 64),
    mailcowVersion: capText(input.mailcowVersion, 100),
    // mailcow's release on the node, the version the node's checkout pins, the head of mailcow's
    // master, and how the first two compare.
    mailcowCommit: commitOrNull(input.mailcowCommit),
    mailcowTag: tagOrNull(input.mailcowTag),
    mailcowPinTag: tagOrNull(input.mailcowPinTag),
    mailcowPinCommit: commitOrNull(input.mailcowPinCommit),
    mailcowUpstreamCommit: commitOrNull(input.mailcowUpstreamCommit),
    mailcowRelation: MAILCOW_RELATIONS.has(input.mailcowRelation) ? input.mailcowRelation : 'unknown',
    containers: {
      total: wholeNumber(containers.total),
      running: wholeNumber(containers.running),
      problems,
    },
    backup: {
      configured: backup.configured === true,
      ok: backup.ok === true,
      problem: capText(backup.problem, MAX_ERROR),
      last: presentBackupLast(backup.last),
    },
  };
}

export async function recordStatus(body, tokenHash) {
  const status = sanitizeStatus(body);
  const { rowCount } = await query(
    'UPDATE node_agent SET status = $2::jsonb, status_at = now() WHERE id = 1 AND token_hash = $1',
    [tokenHash, JSON.stringify(status)]
  );
  if (!rowCount) throw new NodeAgentError('agent_unauthorized');
  return status;
}

function presentJob(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    kind: row.kind,
    params: row.params ?? {},
    state: row.state,
    step: row.step ?? null,
    logTail: row.log_tail ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
  };
}

// Expiry runs at most this often (every read and poll asks for it).
const EXPIRE_EVERY_MS = 30 * 1000;
let lastExpiry = 0;
// Tests: the next expireStaleJobs runs at once.
export function resetExpiryThrottle() {
  lastExpiry = 0;
}

// Fails jobs past their bounds: queued and never picked up, or running without word from the agent.
// An update is judged by its reports (UPDATE_HEARTBEAT_MS) under its ceiling, not by a fixed length:
// its backup alone may take hours.
export async function expireStaleJobs() {
  const now = Date.now();
  if (now - lastExpiry < EXPIRE_EVERY_MS) return;
  lastExpiry = now;
  await query(
    `UPDATE node_agent_jobs SET state = 'failed', error = 'not_picked_up', finished_at = now(), updated_at = now()
      WHERE state = 'queued' AND created_at < now() - ($1::double precision * interval '1 millisecond')`,
    [QUEUED_TIMEOUT_MS]
  );
  await query(
    `UPDATE node_agent_jobs SET state = 'failed', error = 'update_silent', finished_at = now(), updated_at = now()
      WHERE state = 'running' AND kind = 'update' AND updated_at < now() - ($1::double precision * interval '1 millisecond')`,
    [UPDATE_HEARTBEAT_MS]
  );
  for (const [kind, ms] of Object.entries(RUNNING_TIMEOUT_MS)) {
    await query(
      `UPDATE node_agent_jobs SET state = 'failed', error = 'timed_out', finished_at = now(), updated_at = now()
        WHERE state = 'running' AND kind = $1 AND started_at < now() - ($2::double precision * interval '1 millisecond')`,
      [kind, ms]
    );
  }
}

export async function getAgentState() {
  await expireStaleJobs();
  const { rows } = await query('SELECT * FROM node_agent WHERE id = 1');
  const row = rows[0];
  const lastSeenAt = row?.last_seen_at ?? null;
  const configured = !!row?.token_hash;
  return {
    configured,
    tokenCreatedAt: configured ? row.token_created_at : null,
    connected: configured && !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < CONNECTED_WITHIN_MS,
    lastSeenAt,
    status: row?.status ?? null,
    statusAt: row?.status_at ?? null,
  };
}

export async function listJobs(limit = 20) {
  await expireStaleJobs();
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), MAX_RECENT_JOBS);
  const { rows } = await query('SELECT * FROM node_agent_jobs ORDER BY created_at DESC, id DESC LIMIT $1', [n]);
  return rows.map(presentJob);
}

// Queues a job for the agent. Refused without an agent token (nothing would pick it up), while a
// job of the same kind is queued or running, and for a backup or an update while either is.
// The agent's row is locked meanwhile, so two requests cannot both pass the check.
export async function enqueueJob({ kind, params = {}, createdBy = null }) {
  if (!AGENT_JOB_KINDS.includes(kind)) throw new NodeAgentError('job_kind_invalid');
  await expireStaleJobs();
  let job;
  try {
    job = await withTransaction(async (client) => {
      const { rows: agent } = await client.query('SELECT token_hash FROM node_agent WHERE id = 1 FOR UPDATE');
      if (!agent[0]?.token_hash) throw new NodeAgentError('agent_not_set_up');
      const kinds = EXCLUSIVE_KINDS.includes(kind) ? EXCLUSIVE_KINDS : [kind];
      const { rows: active } = await client.query(
        "SELECT 1 FROM node_agent_jobs WHERE kind = ANY($1::text[]) AND state IN ('queued', 'running') LIMIT 1",
        [kinds]
      );
      if (active.length) throw new NodeAgentError('job_active');
      const { rows } = await client.query(
        'INSERT INTO node_agent_jobs (kind, params, created_by) VALUES ($1, $2::jsonb, $3) RETURNING *',
        [kind, JSON.stringify(params), createdBy]
      );
      return presentJob(rows[0]);
    });
  } catch (err) {
    if (err?.code === '23505') throw new NodeAgentError('job_active');
    throw err;
  }
  wakeups.emit('job');
  return job;
}

// --- The node update --------------------------------------------------------------------------

// The commit the panel runs (BUILD_SHA), which the node's scripts are brought to; null on a build
// without one (a stand, a development build).
export function panelCommit(env = process.env) {
  return currentOf(env).sha;
}

// The mailcow version this panel's release pins (deploy/mailcow-version, copied into the image as
// /app/mailcow-version by backend/Dockerfile; the repository's file in development): {tag, commit},
// or null when it cannot be read. The node's update takes its own copy from its checkout, never
// this one; the panel only shows it.
const HERE = dirname(fileURLToPath(import.meta.url));
export const MAILCOW_VERSION_FILES = Object.freeze([
  resolve(HERE, '../../../mailcow-version'),
  resolve(HERE, '../../../../deploy/mailcow-version'),
]);
let pinnedCache;

export function parseMailcowVersion(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^(MAILCOW_TAG|MAILCOW_COMMIT)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  const tag = tagOrNull(values.MAILCOW_TAG);
  const commit = commitOrNull(values.MAILCOW_COMMIT);
  return tag && commit ? { tag, commit } : null;
}

export function pinnedMailcow({ files = MAILCOW_VERSION_FILES, read = readFileSync } = {}) {
  if (pinnedCache !== undefined && files === MAILCOW_VERSION_FILES) return pinnedCache;
  let pinned = null;
  for (const file of files) {
    try {
      pinned = parseMailcowVersion(read(file, 'utf8'));
    } catch {
      continue;
    }
    if (pinned) break;
  }
  if (files === MAILCOW_VERSION_FILES) pinnedCache = pinned;
  return pinned;
}

// "Update node now": an update job to the panel's commit. The commit comes from the panel's own
// build, never from the request.
export async function enqueueNodeUpdate({ createdBy = null, env = process.env } = {}) {
  const sha = panelCommit(env);
  if (!sha) throw new NodeAgentError('panel_version_unknown');
  return enqueueJob({ kind: 'update', params: { sha }, createdBy });
}

// After a panel update: the node's update to the panel's commit, queued by the panel itself when
// the agent is connected, its last status report names another commit, nothing is backing up or
// updating the node, and no update job to this commit was ever queued (a failed one is tried again
// only by an administrator's "Update node now"). Returns the job, or null with nothing done.
export async function queueNodeUpdateIfBehind({ env = process.env } = {}) {
  const sha = panelCommit(env);
  if (!sha) return null;
  const state = await getAgentState();
  if (!state.configured || !state.connected) return null;
  const nodeCommit = state.status?.scriptsCommit;
  if (typeof nodeCommit !== 'string' || !SHA_PATTERN.test(nodeCommit) || nodeCommit === sha) return null;
  const { rows } = await query(
    "SELECT 1 FROM node_agent_jobs WHERE kind = 'update' AND params->>'sha' = $1 LIMIT 1",
    [sha]
  );
  if (rows.length) return null;
  try {
    return await enqueueJob({ kind: 'update', params: { sha, automatic: true } });
  } catch (err) {
    // Busy (a backup or an update runs) or the token went away: the next pass looks again.
    if (err instanceof NodeAgentError) return null;
    throw err;
  }
}

// The node's part of an update, for the panel update screen: whether the agent is connected, the
// commit it reported last, and the last update job.
export async function getNodeUpdateState({ env = process.env } = {}) {
  const state = await getAgentState();
  const { rows } = await query(
    "SELECT * FROM node_agent_jobs WHERE kind = 'update' ORDER BY created_at DESC, id DESC LIMIT 1"
  );
  return {
    configured: state.configured,
    connected: state.connected,
    scriptsCommit: state.status?.scriptsCommit ?? null,
    panelCommit: panelCommit(env),
    // mailcow on the node and the version this release pins: the update brings it there.
    mailcow: {
      commit: state.status?.mailcowCommit ?? null,
      tag: state.status?.mailcowTag ?? null,
      relation: state.status?.mailcowRelation ?? 'unknown',
    },
    pinnedMailcow: pinnedMailcow(),
    job: presentJob(rows[0]),
  };
}

// A poll comes only from an idle agent (it runs one job at a time, then polls): a job still running
// then was lost when the agent restarted (a reboot, an update of its files), and fails now instead
// of blocking the next one until its bound. An update is the exception while it reports: it runs
// detached from the agent (node-update.sh) and outlives the restart setup.sh gives the agent. The
// agent does not poll while it knows an update runs; this guards an agent that does not know (one
// rolled back to an older version). An update silent past UPDATE_HEARTBEAT_MS fails here too.
export async function failOrphanedJobs(tokenHash) {
  await query(
    `UPDATE node_agent_jobs SET state = 'failed', error = 'agent_restarted', finished_at = now(), updated_at = now()
      WHERE state = 'running' AND ${TOKEN_CURRENT}
        AND NOT (kind = 'update' AND updated_at > now() - ($2::double precision * interval '1 millisecond'))`,
    [tokenHash, UPDATE_HEARTBEAT_MS]
  );
}

// The oldest queued job, now running, while tokenHash is still the agent's token; null otherwise.
export async function claimNextJob(tokenHash) {
  await expireStaleJobs();
  const { rows } = await query(
    `UPDATE node_agent_jobs SET state = 'running', started_at = now(), updated_at = now()
      WHERE id = (SELECT id FROM node_agent_jobs WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND ${TOKEN_CURRENT}
      RETURNING *`,
    [tokenHash]
  );
  return presentJob(rows[0]);
}

// A job claimed for a poll whose agent went away before the answer: queued again.
async function unclaimJob(id) {
  await query(
    "UPDATE node_agent_jobs SET state = 'queued', started_at = NULL, updated_at = now() WHERE id = $1 AND state = 'running'",
    [id]
  );
}

// The agent's long poll: a job as soon as one is queued, or null after waitMs.
export async function waitForJob({ tokenHash, waitMs = MAX_POLL_WAIT_MS, signal } = {}) {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_POLL_WAIT_MS);
  for (;;) {
    const job = await claimNextJob(tokenHash);
    if (job) {
      if (signal?.aborted) {
        await unclaimJob(job.id);
        return null;
      }
      return job;
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return null;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakeups.off('job', done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(left, POLL_RECHECK_MS));
      wakeups.on('job', done);
      signal?.addEventListener('abort', done);
    });
  }
}

// The agent's report on a job it runs: running with a step and the end of its log, then
// succeeded or failed. Only a running job takes a report.
export async function reportJob(id, body, tokenHash) {
  const input = body && typeof body === 'object' ? body : {};
  const state = input.state ?? 'running';
  if (!JOB_STATES.has(state) || state === 'queued') throw new NodeAgentError('job_state_invalid');
  if (!/^\d{1,18}$/.test(String(id))) throw new NodeAgentError('job_not_found');
  await expireStaleJobs();
  const final = FINAL_STATES.has(state);
  const { rows } = await query(
    `UPDATE node_agent_jobs SET state = $2,
        step = COALESCE($3, step), log_tail = COALESCE($4, log_tail),
        error = CASE WHEN $2 = 'failed' THEN COALESCE($5, error, 'failed') ELSE error END,
        finished_at = CASE WHEN $6 THEN now() ELSE finished_at END, updated_at = now()
      WHERE id = $1 AND state = 'running' AND EXISTS (SELECT 1 FROM node_agent WHERE id = 1 AND token_hash = $7)
      RETURNING *`,
    [id, state, capText(input.step, MAX_STEP), capTail(input.log, MAX_LOG_TAIL), capText(input.error, MAX_ERROR), final, tokenHash]
  );
  if (rows[0]) return presentJob(rows[0]);
  const { rows: agent } = await query('SELECT 1 FROM node_agent WHERE id = 1 AND token_hash = $1', [tokenHash]);
  if (!agent.length) throw new NodeAgentError('agent_unauthorized');
  const { rows: existing } = await query('SELECT state FROM node_agent_jobs WHERE id = $1', [id]);
  throw new NodeAgentError(existing[0] ? 'job_not_running' : 'job_not_found');
}
