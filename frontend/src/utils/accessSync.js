// Helpers for the Cloudflare Access sync tab. Shapes mirror GET/PUT /api/admin/access-sync and
// the lastRun record of backend/src/services/accessSync/runner.js.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACCESS_SYNC_OUTCOME_KEYS = Object.freeze({
  updated: 'admin.accessSync.outcomeUpdated',
  unchanged: 'admin.accessSync.outcomeUnchanged',
  aborted: 'admin.accessSync.outcomeAborted',
  empty: 'admin.accessSync.outcomeEmpty',
  failed: 'admin.accessSync.outcomeFailed',
});

// Run errors the server names by code. Any other error is Cloudflare's status and error codes,
// shown as they are.
export const ACCESS_SYNC_ERROR_KEYS = Object.freeze({
  token_unreadable: 'admin.accessSync.errorTokenUnreadable',
  policy_not_allow: 'admin.accessSync.errorPolicyNotAllow',
  policy_not_attached: 'admin.accessSync.errorNotAttached',
  internal_error: 'admin.accessSync.errorInternal',
});

const SAVE_ERROR_KEYS = Object.freeze({
  invalid_id: 'admin.accessSync.errorInvalidId',
  incomplete: 'admin.accessSync.errorIncomplete',
  token_invalid: 'admin.accessSync.errorTokenInvalid',
  verify_incomplete: 'admin.accessSync.errorVerifyIncomplete',
  token_undecryptable: 'admin.accessSync.errorTokenUnreadableVerify',
});

const IDLE_KEYS = Object.freeze({
  not_configured: 'admin.accessSync.notConfigured',
  not_google_mode: 'admin.accessSync.notGoogleMode',
});

// The form starts from the stored settings; the token field always starts empty.
export function accessSyncForm(config) {
  return {
    enabled: !!config?.enabled,
    accountId: config?.accountId ?? '',
    appId: config?.appId ?? '',
    policyId: config?.policyId ?? '',
    apiToken: '',
  };
}

// The first problem that stops the form from saving, as a translation key, or null.
export function accessSyncFormError(form, apiTokenSet) {
  const accountId = form.accountId.trim();
  const appId = form.appId.trim();
  const policyId = form.policyId.trim();
  if ((accountId && !ACCOUNT_ID_RE.test(accountId)) || (appId && !UUID_RE.test(appId)) || (policyId && !UUID_RE.test(policyId))) {
    return 'admin.accessSync.errorInvalidId';
  }
  if (form.enabled && !(accountId && appId && policyId && (apiTokenSet || form.apiToken.trim()))) {
    return 'admin.accessSync.errorIncomplete';
  }
  return null;
}

// Body for PUT /api/admin/access-sync. A blank token is left out, which keeps the stored one.
export function accessSyncPayload(form) {
  const body = {
    enabled: form.enabled,
    accountId: form.accountId.trim(),
    appId: form.appId.trim(),
    policyId: form.policyId.trim(),
  };
  const token = form.apiToken.trim();
  if (token) body.apiToken = token;
  return body;
}

export function accessSyncSaveErrorKey(code) {
  return SAVE_ERROR_KEYS[code] ?? null;
}

// The last run line: the outcome's key with its values, and a key for a named error.
export function accessSyncRunSummary(lastRun, maxDisables) {
  const key = ACCESS_SYNC_OUTCOME_KEYS[lastRun?.outcome];
  if (!key) return null;
  return {
    key,
    values: {
      added: lastRun.added ?? 0,
      removed: lastRun.removed ?? 0,
      imported: lastRun.imported ?? 0,
      disabled: lastRun.disabled ?? 0,
      wouldDisable: lastRun.wouldDisable ?? 0,
      wouldImport: lastRun.wouldImport ?? 0,
      max: maxDisables,
      error: lastRun.error ?? '',
    },
    errorKey: ACCESS_SYNC_ERROR_KEYS[lastRun.error] ?? null,
  };
}

// The lines under the last run's summary, each { key, values }: emails the run could not import
// and, after a failure that may pass, when it is retried (or that the retries ran out and the
// hourly run tries again). formatTime turns the ISO time into the screen's own format.
export function accessSyncRunNotes(lastRun, formatTime = (iso) => iso) {
  if (!lastRun) return [];
  const notes = [];
  if (lastRun.errors > 0) notes.push({ key: 'admin.accessSync.importErrors', values: { count: lastRun.errors } });
  if (lastRun.nextRetryAt) {
    notes.push({ key: 'admin.accessSync.nextRetry', values: { time: formatTime(lastRun.nextRetryAt), attempt: lastRun.retryAttempt ?? 1 } });
  } else if (lastRun.retriable) {
    notes.push({ key: 'admin.accessSync.retriesExhausted', values: {} });
  }
  return notes;
}

// Why an address is tombstoned (backend accessSync/tombstones.js), as a translation key.
const TOMBSTONE_REASON_KEYS = Object.freeze({
  deleted: 'admin.accessSync.tombstoneReasonDeleted',
  email_changed: 'admin.accessSync.tombstoneReasonEmailChanged',
});

export function tombstoneReasonKey(reason) {
  return TOMBSTONE_REASON_KEYS[reason] ?? TOMBSTONE_REASON_KEYS.deleted;
}

// Why a manual run did nothing, or null when it ran.
export function accessSyncIdleKey(result) {
  return IDLE_KEYS[result?.outcome] ?? null;
}

// Body for POST /api/admin/access-sync/verify: the IDs exactly as the form has them (an emptied
// one is checked as not set, as Save would store it), and the token only when one is typed: the
// token is write-only, so a blank field means the stored token. Nothing sent here is stored.
export function accessSyncVerifyPayload(form) {
  const body = {
    accountId: String(form.accountId ?? '').trim(),
    appId: String(form.appId ?? '').trim(),
    policyId: String(form.policyId ?? '').trim(),
  };
  const token = String(form.apiToken ?? '').trim();
  if (token) body.apiToken = token;
  return body;
}

const VERIFY_LABEL_KEYS = Object.freeze({
  token: 'admin.accessSync.verifyToken',
  app: 'admin.accessSync.verifyApp',
  audience: 'admin.accessSync.verifyAudience',
  policy: 'admin.accessSync.verifyPolicy',
});

// Keys by "<check>:<code>" first, then by code alone (the failures every call can have).
const VERIFY_CHECK_KEYS = Object.freeze({
  'token:token_disabled': 'admin.accessSync.checkTokenDisabled',
  'token:token_expired': 'admin.accessSync.checkTokenExpired',
  'token:forbidden': 'admin.accessSync.checkTokenWrongAccount',
  'token:not_found': 'admin.accessSync.checkTokenWrongAccount',
  'app:not_found': 'admin.accessSync.checkAppNotFound',
  'audience:match': 'admin.accessSync.checkAudienceOk',
  'audience:mismatch': 'admin.accessSync.checkAudienceMismatch',
  'audience:not_configured': 'admin.accessSync.checkAudienceNotConfigured',
  'audience:no_app': 'admin.accessSync.checkNoApp',
  'policy:not_found': 'admin.accessSync.checkPolicyNotFound',
  'policy:not_allow': 'admin.accessSync.checkNotAllow',
  'policy:not_attached': 'admin.accessSync.checkNotAttached',
  no_app_id: 'admin.accessSync.checkNoAppId',
  no_policy_id: 'admin.accessSync.checkNoPolicyId',
  refused: 'admin.accessSync.checkRefused',
  forbidden: 'admin.accessSync.checkForbidden',
  not_found: 'admin.accessSync.checkNotFound',
  unavailable: 'admin.accessSync.checkUnavailable',
  unreachable: 'admin.accessSync.checkUnreachable',
  unexpected: 'admin.accessSync.checkUnexpected',
});

// One line of the verify result (backend/src/services/accessSync/verify.js): the check's label
// key, the sentence key with its values, and the status (ok, failed, skipped). An unknown code
// comes back as raw, with key null.
export function accessSyncVerifyLine(check) {
  const line = { labelKey: VERIFY_LABEL_KEYS[check.id] ?? check.id, key: null, values: {}, status: check.status };
  if (check.id === 'token' && check.code === 'active') {
    return check.expiresOn
      ? { ...line, key: 'admin.accessSync.checkTokenOkExpires', values: { date: check.expiresOn } }
      : { ...line, key: 'admin.accessSync.checkTokenOk' };
  }
  if (check.id === 'app' && check.code === 'found') return { ...line, key: 'admin.accessSync.checkAppOk', values: { name: check.name ?? '' } };
  if (check.id === 'policy' && check.code === 'found') {
    return { ...line, key: check.reusable ? 'admin.accessSync.checkPolicyOkReusable' : 'admin.accessSync.checkPolicyOk' };
  }
  const key = VERIFY_CHECK_KEYS[`${check.id}:${check.code}`] ?? VERIFY_CHECK_KEYS[check.code] ?? null;
  return key ? { ...line, key } : { ...line, raw: check.code };
}
