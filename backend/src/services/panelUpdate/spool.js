// The update spool: the only channel between the backend container and the host's updater (root).
//
//   <dir>/request/  written by the backend: one <uuid>.json per request, made under <uuid>.tmp
//                   (created exclusively, mode 0600, fsynced) and renamed, since the host watches
//                   *.json only and must never see a half-written file.
//   <dir>/result/   written by the host: <uuid>.json per request and updater.json. Mounted
//                   read-only here, but still read as untrusted data: regular files only, bounded
//                   size, parsed in a try and validated field by field; anything else is ignored.
//
// UPDATE_SPOOL_DIR names the directory; without it (dev, plain docker-compose) the feature is off.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isRelease } from '../appVersion.js';

export const TARGET_RE = /^sha-[0-9a-f]{12}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

const MAX_REQUEST_BYTES = 4096;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_REQUESTED_BY = 254;
const STALE_MS = 30 * 60 * 1000;
const FRESH_TMP_MS = 60 * 1000;

const ACTIONS = new Set(['check', 'update']);
export const TERMINAL_STATES = new Set(['ready', 'blocked', 'refused', 'error', 'succeeded', 'failed', 'rolled_back', 'rollback_failed']);
const STATES = new Set([...TERMINAL_STATES, 'checking', 'updating', 'rolling_back']);

// Bounds on what is passed on from a result, whatever the host wrote.
const MAX_LIST = 200;
const MAX_LINE = 2000;
const MAX_TEXT = 8000;

export class SpoolError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function spoolDirFromEnv(env = process.env) {
  const dir = String(env.UPDATE_SPOOL_DIR || '').trim();
  return dir || null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoOrNull = (v) => (typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : null);
const textOrNull = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : null);
const versionOrNull = (v) => (typeof v === 'string' && TARGET_RE.test(v) ? v : null);

// A list of strings, or undefined when the value is not one.
function strings(v) {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) return undefined;
  return v.slice(0, MAX_LIST).map((s) => s.slice(0, MAX_LINE));
}

function normalizePreflight(p) {
  if (p === null || p === undefined) return null;
  if (!isObject(p) || typeof p.ok !== 'boolean') return undefined;
  const lists = {};
  for (const key of ['problems', 'warnings', 'next', 'info']) {
    lists[key] = p[key] === undefined ? [] : strings(p[key]);
    if (!lists[key]) return undefined;
  }
  let pendingMigrations = null;
  if (p.pendingMigrations !== null && p.pendingMigrations !== undefined) {
    pendingMigrations = strings(p.pendingMigrations);
    if (!pendingMigrations) return undefined;
  }
  const applied = p.migrationsApplied;
  return {
    ok: p.ok,
    ...lists,
    pendingMigrations,
    migrationsApplied: Number.isSafeInteger(applied) && applied >= 0 ? applied : null,
  };
}

// The result as the API passes it on: exactly the contract's keys, or null when the file does not
// hold an acceptable result for the id its name carries.
export function normalizeResult(raw, id) {
  if (!isObject(raw) || raw.id !== id || !STATES.has(raw.state)) return null;
  // A request the host could not read is refused with only its id known (action/target null).
  const unreadable = raw.state === 'refused';
  const action = ACTIONS.has(raw.action) ? raw.action : null;
  const target = versionOrNull(raw.target);
  // (null or left out; any other value is malformed).
  if (!action && !(unreadable && raw.action == null)) return null;
  if (!target && !(unreadable && raw.target == null)) return null;
  const preflight = normalizePreflight(raw.preflight);
  if (preflight === undefined) return null;
  const next = raw.next === undefined ? [] : strings(raw.next);
  const log = raw.log === undefined ? [] : strings(raw.log);
  if (!next || !log) return null;
  const exitCode = Number.isSafeInteger(raw.exitCode) && raw.exitCode >= 0 && raw.exitCode <= 255 ? raw.exitCode : null;
  return {
    id,
    action,
    target,
    state: raw.state,
    terminal: TERMINAL_STATES.has(raw.state),
    message: textOrNull(raw.message) ?? '',
    from: versionOrNull(raw.from),
    // The x.y.z of both commits (backend/package.json there), for display only.
    fromRelease: isRelease(raw.fromRelease) ? raw.fromRelease : null,
    targetRelease: isRelease(raw.targetRelease) ? raw.targetRelease : null,
    receivedAt: isoOrNull(raw.receivedAt),
    updatedAt: isoOrNull(raw.updatedAt),
    startedAt: isoOrNull(raw.startedAt),
    finishedAt: isoOrNull(raw.finishedAt),
    exitCode,
    preflight,
    autoRollback: raw.autoRollback === true,
    next,
    log,
    logFile: textOrNull(raw.logFile, 4096),
    journal: textOrNull(raw.journal, 4096),
  };
}

const timeOf = (r) => Date.parse(r.receivedAt ?? '') || Date.parse(r.updatedAt ?? '') || 0;

// Reads a small regular file as JSON: { value, mtimeMs }, or null for anything else (absent,
// symlink, directory, device, too big, not JSON).
async function readJsonFile(path, maxBytes) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > maxBytes) return null;
  } catch {
    return null;
  }
  let handle;
  try {
    // O_NOFOLLOW where the platform has it, so a symlink swapped in after the lstat is refused too.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return null;
    return { value: JSON.parse(buf.subarray(0, bytesRead).toString('utf8')), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function listDir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export function createSpool(dir) {
  const enabled = !!dir;
  const requestDir = enabled ? join(dir, 'request') : null;
  const resultDir = enabled ? join(dir, 'result') : null;

  async function writeRequest({ action, target, requestedBy, now = new Date() }) {
    if (!enabled) throw new SpoolError('updater_not_installed');
    if (!ACTIONS.has(action) || typeof target !== 'string' || !TARGET_RE.test(target)) throw new SpoolError('invalid_request');
    const id = randomUUID();
    const body = JSON.stringify({
      id, action, target, requestedAt: now.toISOString(), requestedBy: String(requestedBy ?? '').slice(0, MAX_REQUESTED_BY),
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new SpoolError('invalid_request');

    const tmp = join(requestDir, `${id}.tmp`);
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tmp, join(requestDir, `${id}.json`));
    } catch (err) {
      await handle?.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      // ENOENT: the spool directories are not there, the mechanism is not installed. EACCES/EPERM:
      // they are there but this process may not write them (another uid than install.sh recorded).
      if (err?.code === 'ENOENT') throw new SpoolError('updater_not_installed');
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        console.error(`[panel-update] Spool request directory is not writable (${err.code}): the backend's uid cannot write it; install.sh records the uid of the backend image, re-run install.sh.`);
        throw new SpoolError('spool_not_writable');
      }
      throw err;
    }
    return id;
  }

  // Every acceptable result, newest first.
  async function readResults() {
    if (!enabled) return [];
    const out = [];
    for (const name of await listDir(resultDir)) {
      const m = RESULT_NAME_RE.exec(name);
      if (!m) continue;
      const file = await readJsonFile(join(resultDir, name), MAX_RESULT_BYTES);
      const result = file && normalizeResult(file.value, m[1]);
      if (!result) continue;
      if (!result.updatedAt) result.updatedAt = new Date(file.mtimeMs).toISOString();
      out.push(result);
    }
    return out.sort((a, b) => timeOf(b) - timeOf(a) || (b.updatedAt > a.updatedAt ? 1 : -1));
  }

  async function readResult(id) {
    if (!enabled || !ID_RE.test(id)) return null;
    const file = await readJsonFile(join(resultDir, `${id}.json`), MAX_RESULT_BYTES);
    const result = file && normalizeResult(file.value, id);
    if (result && !result.updatedAt) result.updatedAt = new Date(file.mtimeMs).toISOString();
    return result || null;
  }

  async function readUpdater() {
    const none = { installed: false, version: null, rolledBack: null };
    if (!enabled) return none;
    const file = await readJsonFile(join(resultDir, 'updater.json'), MAX_REQUEST_BYTES);
    if (!isObject(file?.value) || file.value.installed !== true) return none;
    return { installed: true, version: versionOrNull(file.value.version), rolledBack: versionOrNull(file.value.rolledBack) };
  }

  // The requests not taken by the host yet: how many *.json there are, the oldest readable one,
  // and whether a *.tmp younger than a minute is being written.
  async function readRequests({ now = Date.now() } = {}) {
    const out = { pending: null, count: 0, freshTmp: false };
    if (!enabled) return out;
    let oldest = Infinity;
    for (const name of await listDir(requestDir)) {
      if (name.endsWith('.tmp')) {
        try {
          const st = await lstat(join(requestDir, name));
          if (now - st.mtimeMs < FRESH_TMP_MS) out.freshTmp = true;
        } catch { /* gone meanwhile */ }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      out.count += 1;
      const m = RESULT_NAME_RE.exec(name);
      if (!m) continue;
      const file = await readJsonFile(join(requestDir, name), MAX_REQUEST_BYTES);
      if (!file || file.value?.id !== m[1] || !ACTIONS.has(file.value.action)) continue;
      if (file.mtimeMs < oldest) {
        oldest = file.mtimeMs;
        out.pending = { id: m[1], action: file.value.action };
      }
    }
    return out;
  }

  async function hasRequest(id) {
    if (!enabled || !ID_RE.test(id)) return false;
    try {
      return (await lstat(join(requestDir, `${id}.json`))).isFile();
    } catch {
      return false;
    }
  }

  return { enabled, writeRequest, readResults, readResult, readUpdater, readRequests, hasRequest };
}

// A non-terminal result that has not changed for 30 minutes is no longer running.
export function isStale(result, now = Date.now()) {
  const t = Date.parse(result.updatedAt ?? '');
  return !Number.isFinite(t) || now - t > STALE_MS;
}

// Busy: a request waiting for the host (or one being written), or the newest update still running.
// results: newest first, as readResults returns them.
export function isBusy({ count, freshTmp, results, now = Date.now() }) {
  if (count > 0 || freshTmp) return true;
  const run = results.find((r) => r.action === 'update');
  return !!run && !run.terminal && !isStale(run, now);
}

let defaultSpool = null;

// The process-wide spool for UPDATE_SPOOL_DIR, read as the server runs.
export function getSpool(env = process.env) {
  const dir = spoolDirFromEnv(env);
  if (!defaultSpool || defaultSpool.dir !== dir) defaultSpool = { dir, spool: createSpool(dir) };
  return defaultSpool.spool;
}
