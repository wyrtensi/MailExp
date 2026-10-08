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

// Why a manual run did nothing, or null when it ran.
export function accessSyncIdleKey(result) {
  return IDLE_KEYS[result?.outcome] ?? null;
}
