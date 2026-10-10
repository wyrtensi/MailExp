// Pure helpers for Settings -> Panel update (admins only). The data is the answer of
// GET /api/admin/update: the panel's version, the promoted `latest`, the comparison, the state of
// the host's update mechanism, the newest preflight check (`check`) and the newest update run
// (`run`). The host (systemd units running the deploy scripts) writes the check and run results;
// the backend only relays them. Nothing here touches the network or the DOM.

import { nodeUpdateActive } from './nodeAgent.js';

export const POLL_INTERVAL_MS = 3000;
// A run the host has not touched for this long is not running any more (the host rewrites the
// result at least every 10 s while it updates); the backend applies the same limit to `busy`.
export const STALE_AFTER_MS = 30 * 60 * 1000;
// How long a success keeps offering the page reload (the frontend build changed with it).
export const RELOAD_OFFER_MS = 30 * 60 * 1000;
// How long after a request the screen keeps polling even if the answer still shows nothing busy.
export const POLL_GRACE_MS = 15000;
export const LOG_LINES_SHOWN = 25;

const VERSION_RE = /^sha-[0-9a-f]{12}$/;
const PREFIX_RE = /^\/[A-Za-z0-9_./-]*$/;

const TERMINAL_STATES = new Set(['ready', 'blocked', 'refused', 'error', 'succeeded', 'failed', 'rolled_back', 'rollback_failed']);

// state -> translation key and how the outcome is coloured: good, warn or bad (neutral for a state
// still in progress).
const STATE_INFO = Object.freeze({
  queued: { key: 'admin.panelUpdate.stateQueued', tone: 'neutral' },
  checking: { key: 'admin.panelUpdate.stateChecking', tone: 'neutral' },
  updating: { key: 'admin.panelUpdate.stateUpdating', tone: 'neutral' },
  rolling_back: { key: 'admin.panelUpdate.stateRollingBack', tone: 'warn' },
  ready: { key: 'admin.panelUpdate.stateReady', tone: 'good' },
  blocked: { key: 'admin.panelUpdate.stateBlocked', tone: 'warn' },
  refused: { key: 'admin.panelUpdate.stateRefused', tone: 'warn' },
  error: { key: 'admin.panelUpdate.stateError', tone: 'bad' },
  succeeded: { key: 'admin.panelUpdate.stateSucceeded', tone: 'good' },
  failed: { key: 'admin.panelUpdate.stateFailed', tone: 'bad' },
  rolled_back: { key: 'admin.panelUpdate.stateRolledBack', tone: 'warn' },
  rollback_failed: { key: 'admin.panelUpdate.stateRollbackFailed', tone: 'bad' },
});

// What each refusal of POST /admin/update[/check] says; `error` is the server's code.
const REQUEST_ERROR_KEYS = Object.freeze({
  busy: 'admin.panelUpdate.errorBusy',
  not_latest: 'admin.panelUpdate.errorNotLatest',
  no_update: 'admin.panelUpdate.errorNoUpdate',
  updater_not_installed: 'admin.panelUpdate.errorNotInstalled',
  rolled_back: 'admin.panelUpdate.errorRolledBack',
  spool_not_writable: 'admin.panelUpdate.errorSpoolNotWritable',
  invalid_target: 'admin.panelUpdate.errorInvalidTarget',
  confirm_mismatch: 'admin.panelUpdate.errorConfirmMismatch',
  not_found: 'admin.panelUpdate.errorNotFound',
});

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function stateInfo(state) {
  return STATE_INFO[state] ?? { key: 'admin.panelUpdate.stateUnknown', tone: 'neutral' };
}

export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version);
}

const time = (iso) => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : null;
};

// A result still in progress whose last write is recent enough to believe.
export function isActiveResult(result, now = Date.now()) {
  if (!result || result.terminal) return false;
  const at = time(result.updatedAt);
  // A queued stub has no timestamps: the request file is there, the host has not taken it yet.
  if (at === null) return result.state === 'queued';
  return now - at < STALE_AFTER_MS;
}

// Whether the screen keeps asking the server: something is running or waiting for the host.
export function needsPolling(data, now = Date.now()) {
  if (!data) return false;
  return !!(data.busy || data.pending || isActiveResult(data.run, now) || isActiveResult(data.check, now)
    // The node's part (the agent's update job) after the panel's.
    || nodeUpdateActive(data.node));
}

// "The panel is restarting": the backend is gone for a moment while the containers are replaced
// (the proxy answers 502/503/504, or the connection fails with no status at all).
export function isRestartingError(err) {
  if (!err) return false;
  if (err.status == null) return true;
  return err.status === 502 || err.status === 503 || err.status === 504;
}

// The refusal's `code` (backend routes/adminUpdate.js); an older backend sent the same token as
// the error text only.
export function requestErrorKey(err) {
  for (const token of [err?.code, err?.message]) {
    if (typeof token === 'string' && Object.hasOwn(REQUEST_ERROR_KEYS, token)) return REQUEST_ERROR_KEYS[token];
  }
  return null;
}

// The state of the update at a glance, for the headline.
//   disabled   the server's update check is switched off
//   error      the check of GitHub failed (checkError: rate_limited or unavailable)
//   unknown    no answer from GitHub yet (latest is null)
//   ahead      a newer promoted version exists
//   current    the panel runs the promoted version (or a newer one)
//   diverged   the panel's commit is not on the promoted line
export function updateStatus(data) {
  if (!data) return 'unknown';
  if (data.disabled) return 'disabled';
  if (data.checkError) return 'error';
  if (!data.latest) return 'unknown';
  if (data.updateAvailable) return 'ahead';
  switch (data.compare?.status) {
    case 'diverged': return 'diverged';
    case 'identical': return 'current';
    case 'behind': return 'current';
    default: return data.current?.version && data.current.version === data.latest.version ? 'current' : 'unknown';
  }
}

export function checkErrorKey(checkError) {
  return checkError === 'rate_limited'
    ? 'admin.panelUpdate.checkRateLimited'
    : 'admin.panelUpdate.checkUnavailable';
}

// The target of an update: the promoted version, a valid sha-<12> only.
export function updateTarget(data) {
  const version = data?.latest?.version;
  return isValidVersion(version) ? version : null;
}

// pendingMigrations null means the host did not read the schema: treat that as "there are some".
//   none     the schema was read and nothing is pending
//   pending  these migrations are pending
//   unknown  not known (null) or no check yet
export function migrationsInfo(preflight) {
  if (!preflight) return { kind: 'unknown', list: [] };
  const list = preflight.pendingMigrations;
  if (list === null || list === undefined) return { kind: 'unknown', list: [] };
  return list.length ? { kind: 'pending', list } : { kind: 'none', list: [] };
}

// Whether a failed update would roll itself back: only the host decides (`autoRollback`), and only
// when the schema was read and no migration is pending. Without a check result it is unknown.
export function rollbackInfo(check) {
  if (!check?.preflight) return 'unknown';
  const { kind } = migrationsInfo(check.preflight);
  if (kind !== 'none') return 'manual';
  return check.autoRollback ? 'auto' : 'manual';
}

// The promoted version is one somebody rolled back from: the host refuses it as a target until a
// newer build is promoted.
export function isRolledBack(data) {
  const rolledBack = data?.updater?.rolledBack;
  return isValidVersion(rolledBack) && rolledBack === data?.latest?.version;
}

// A check of the promoted version is wanted and not running or recorded yet: do it once, by itself.
export function needsAutoCheck(data) {
  if (!data || data.disabled || data.checkError || isRolledBack(data)) return false;
  if (!data.updateAvailable || !updateTarget(data)) return false;
  if (!data.updater?.installed) return false;
  if (data.busy || data.pending) return false;
  return !data.check;
}

// Why the "Update" button is disabled, or null when it is not. `starting` is a request this screen
// has sent and not seen answered.
export function updateBlockReason(data, { starting = false } = {}) {
  if (!data) return 'loading';
  if (starting || data.busy || data.pending) return 'busy';
  if (!data.updater?.installed) return 'not_installed';
  if (isRolledBack(data)) return 'rolled_back';
  if (!data.updateAvailable || !updateTarget(data)) return 'no_update';
  if (data.check?.state === 'blocked' || data.check?.state === 'refused') return 'blocked';
  return null;
}

export function canCheck(data, { starting = false } = {}) {
  return !!data && !starting && !data.busy && !data.pending && !data.disabled && !data.checkError
    && !!data.updater?.installed && !isRolledBack(data) && !!data.updateAvailable && !!updateTarget(data);
}

// <PREFIX> of the install, from the host's log path (<PREFIX>/state/updater/<id>.log); null when
// the path is not of that shape or holds anything but plain path characters.
export function installPrefix(logFile) {
  if (typeof logFile !== 'string') return null;
  const match = /^(.*)\/state\/updater\/[^/]+$/.exec(logFile);
  if (!match || !match[1] || !PREFIX_RE.test(match[1])) return null;
  return match[1];
}

// The command for a manual rollback to the version the update started from; null when either part
// is missing or not what the host writes.
export function rollbackCommand(run) {
  const prefix = installPrefix(run?.logFile);
  if (!prefix || !isValidVersion(run?.from)) return null;
  return `sudo ${prefix}/app/scripts/deploy/rollback.sh --to ${run.from}`;
}

// Whether the run ended in a way that wants the runbook: the update failed and the host could not,
// or did not, bring the old version back on its own.
export function needsRunbook(run) {
  return run?.state === 'failed' || run?.state === 'rollback_failed';
}

// A finished update that changed the frontend build: the page in the tab is the old one.
export function shouldOfferReload(run, now = Date.now()) {
  if (run?.state !== 'succeeded') return false;
  const at = time(run.finishedAt ?? run.updatedAt);
  return at !== null && now - at < RELOAD_OFFER_MS;
}

// The last lines of the run's log, empty lines dropped.
export function logTail(lines, limit = LOG_LINES_SHOWN) {
  if (!Array.isArray(lines)) return [];
  return lines.filter((line) => typeof line === 'string' && line.trim() !== '').slice(-limit);
}

export function shortVersion(version) {
  return typeof version === 'string' && version ? version : null;
}

const RELEASE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseOrNull = (release) => (typeof release === 'string' && RELEASE_RE.test(release) ? release : null);

// A build as people read it: its release and its sha-<12> ("1.0.1 (sha-0123456789ab)"), either
// alone when the other is unknown, null when both are.
export function versionLabel(version, release) {
  const sha = shortVersion(version);
  const rel = releaseOrNull(release);
  if (rel && sha) return `${rel} (${sha})`;
  return rel ?? sha;
}

// The offered build in the sidebar's notice (/api/update answers its release, or its sha-<12>
// when it has none): "v1.0.1", "sha-0123456789ab", null when there is nothing to name.
export function noticeVersion(latest) {
  const rel = releaseOrNull(latest);
  if (rel) return `v${rel}`;
  return typeof latest === 'string' && latest ? latest : null;
}

// A list of host messages as plain strings, anything else dropped.
export function textList(list) {
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
}

// The compare page of GitHub, only when it is https and on github.com.
export function safeGithubUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.href : null;
  } catch {
    return null;
  }
}
