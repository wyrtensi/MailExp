import { query, withTransaction } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { UUID_RE } from '../../utils/uuid.js';

// Cloudflare Access sync settings and the state between runs, stored in system_settings. The API
// token is stored encrypted and only ever written: nothing here returns it to a client.
export const ACCESS_SYNC_CONFIG_KEY = 'access_sync_config';
export const ACCESS_SYNC_STATE_KEY = 'access_sync_state';
export const DEFAULT_MAX_DISABLES = 10;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const EMPTY_CONFIG = Object.freeze({ enabled: false, accountId: '', appId: '', policyId: '', apiToken: null });

export class AccessSyncConfigError extends Error {
  constructor(code) {
    super(`Invalid Access sync settings: ${code}`);
    this.name = 'AccessSyncConfigError';
    this.code = code;
  }
}

// ACCESS_SYNC_MAX_DISABLES: the most users one run may disable. 0 stops every run that would
// disable anyone.
export function accessSyncMaxDisables(env = process.env) {
  const raw = String(env.ACCESS_SYNC_MAX_DISABLES ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_DISABLES;
}

// ACCESS_SYNC_MAX_IMPORTS: the most emails one run may import from the policy as new users. 0
// stops every run that would import anyone.
export const DEFAULT_MAX_IMPORTS = 10;
export function accessSyncMaxImports(env = process.env) {
  const raw = String(env.ACCESS_SYNC_MAX_IMPORTS ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_IMPORTS;
}

// The settings and the state are read and written by more than one process: the backend (its
// screen and its runs) and the panel CLI (`mailexpert access config|token`). Every change that
// reads one of them and writes back runs in a transaction holding this advisory lock, so a run's
// state write and a settings save never interleave (withAccessSyncLock in index.js serialises only
// within one process).
const ACCESS_SYNC_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('mailexpert:access_sync'))";
const DEFAULT_DB = { query: (...args) => query(...args) };

// withAccessSyncTransaction(fn): fn(db) inside a transaction that holds the sync's advisory lock;
// db.query runs in that transaction.
export function withAccessSyncTransaction(fn) {
  return withTransaction(async (client) => {
    await client.query(ACCESS_SYNC_LOCK_SQL);
    return fn(client);
  });
}

async function readJson(key, db = DEFAULT_DB) {
  const { rows } = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

async function writeJson(key, value, db = DEFAULT_DB) {
  await db.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

export async function loadStoredConfig(db = DEFAULT_DB) {
  const stored = await readJson(ACCESS_SYNC_CONFIG_KEY, db);
  return { ...EMPTY_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// What the admin screen sees: whether a token is stored, never the token.
export function publicConfig(stored) {
  return {
    enabled: !!stored.enabled,
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiTokenSet: !!stored.apiToken,
  };
}

// Settings a run can use, or null while the sync is off or not filled in. A token that no longer
// decrypts (a changed ENCRYPTION_KEY) comes back as null so the run can report it.
export async function loadRunConfig() {
  const stored = await loadStoredConfig();
  if (!stored.enabled || !stored.accountId || !stored.appId || !stored.policyId || !stored.apiToken) return null;
  return {
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiToken: decrypt(stored.apiToken),
  };
}

// Whether the sync is turned on, for callers outside a run that only need that one flag (the
// Cloudflare sign-in gate in userIdentity.js).
export async function isAccessSyncEnabled() {
  return (await loadStoredConfig()).enabled === true;
}

const emailList = (value) => (Array.isArray(value) ? value.filter((email) => typeof email === 'string') : []);

// baseline: the emails MailExpert wrote to the policy last time (reconcile.js). policyEmails: every
// email the policy listed after the last successful run, for the users screen's access state.
// abortedCandidates / abortedImports: what a run stopped by the mass-change limit would have
// disabled / imported, so the journal names each new set once. retryAttempt: how many retries in
// a row a retriable failure has had (scheduler.js).
export async function loadState(db = DEFAULT_DB) {
  const stored = await readJson(ACCESS_SYNC_STATE_KEY, db);
  return {
    baseline: emailList(stored?.baseline),
    policyEmails: emailList(stored?.policyEmails),
    abortedCandidates: Array.isArray(stored?.abortedCandidates) ? stored.abortedCandidates : null,
    abortedImports: Array.isArray(stored?.abortedImports) ? stored.abortedImports : null,
    retryAttempt: Number.isInteger(stored?.retryAttempt) ? stored.retryAttempt : 0,
    lastRun: stored?.lastRun && typeof stored.lastRun === 'object' ? stored.lastRun : null,
  };
}

export function saveState(state, db = DEFAULT_DB) {
  return writeJson(ACCESS_SYNC_STATE_KEY, state, db);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// Saves settings from the admin screen. A blank token keeps the stored one. Pointing the sync at
// another account, application or policy forgets the baseline: the emails written to the old
// policy would otherwise look removed from the new one and disable their users. The baseline is
// reset before the new config is written, not after: a reset followed by a failed config write is
// harmless (an empty baseline never disables anyone), while the old order could pair a new policy
// with a stale baseline if the config write succeeded but the state write then failed.
export async function saveConfig(input) {
  return (await updateConfig(() => input)).saved;
}

// updateConfig(build, { afterRead }): saveConfig's checks and writes, with the input built from the
// stored settings (build(stored)) and the read, the state reset and the write in one transaction
// under the sync's advisory lock. A partial change (the CLI's `access config --enable`, `access
// token`) then never overwrites a save another process made meanwhile, and a run's state write
// (runner.js) can never land between the reset and the new settings. afterRead is a test hook.
// Answers { before, saved }.
export function updateConfig(build, { afterRead = null } = {}) {
  return withAccessSyncTransaction(async (db) => {
    const stored = await loadStoredConfig(db);
    if (afterRead) await afterRead();
    const saved = await writeConfig(build(stored), stored, db);
    return { before: stored, saved };
  });
}

async function writeConfig(input, stored, db) {
  if (typeof input?.enabled !== 'boolean') throw new AccessSyncConfigError('invalid_field');
  const next = {
    enabled: input.enabled,
    accountId: text(input.accountId).toLowerCase(),
    appId: text(input.appId).toLowerCase(),
    policyId: text(input.policyId).toLowerCase(),
    apiToken: stored.apiToken,
  };
  if ((next.accountId && !ACCOUNT_ID_RE.test(next.accountId))
    || (next.appId && !UUID_RE.test(next.appId))
    || (next.policyId && !UUID_RE.test(next.policyId))) {
    throw new AccessSyncConfigError('invalid_id');
  }
  const token = text(input.apiToken);
  if (next.enabled && !(next.accountId && next.appId && next.policyId && (token || next.apiToken))) {
    throw new AccessSyncConfigError('incomplete');
  }
  if (token) next.apiToken = encrypt(token);

  if (next.accountId !== stored.accountId || next.appId !== stored.appId || next.policyId !== stored.policyId) {
    await saveState({
      ...(await loadState(db)), baseline: [], policyEmails: [], abortedCandidates: null, abortedImports: null, retryAttempt: 0,
    }, db);
  }
  await writeJson(ACCESS_SYNC_CONFIG_KEY, next, db);
  return next;
}
