import { cloudflareEnvState } from '../auth/authSettings.js';
import { decrypt } from '../encryption.js';
import { UUID_RE } from '../../utils/uuid.js';
import { CloudflareAccessError, createCloudflareAccessClient } from './cloudflareAccessClient.js';
import { ACCOUNT_ID_RE, API_TOKEN_RE, loadStoredConfig } from './settings.js';

// "Проверить" on the admin screen and `mailexpert access verify`: whether the sync's token and IDs
// work against Cloudflare, without writing anything anywhere. Each check answers a code only; the
// screen and the CLI turn the codes into sentences. Response texts from Cloudflare are never
// passed on (they can quote emails or account details), and the token is never in the answer.
//
// What is checked, in order, with the call each check makes:
//   token     GET /user/tokens/verify, or /accounts/<id>/tokens/verify for an account-owned token
//   app       GET /accounts/<id>/access/apps/<app>      "Access: Apps and Policies" Read
//   audience  the app's aud against CF_ACCESS_AUDIENCE (no call)
//   policy    GET .../apps/<app>/policies/<policy>      the same group; must be an Allow policy
// Edit, the right a run needs to write the policy, cannot be checked without a write: the first
// run that changes the policy confirms it (the screen says so).


export class AccessSyncVerifyError extends Error {
  constructor(code) {
    super(`Cannot verify the Cloudflare Access settings: ${code}`);
    this.name = 'AccessSyncVerifyError';
    this.code = code;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// The code of a failed call: refused (401: the token is wrong, revoked or expired), forbidden
// (403: the token lacks the permission on this account, or the account ID is not the token's),
// not_found (404), unavailable (Cloudflare's own trouble or its rate limit), unreachable (network,
// timeout), not_attached (getPolicy: a reusable policy not attached to the application).
export function failureCode(err) {
  if (!(err instanceof CloudflareAccessError)) return 'unexpected';
  if (err.status === 'network' || err.status === 'timeout') return 'unreachable';
  if (err.status === 'not_attached') return 'not_attached';
  if (err.status === 400 || err.status === 401) return 'refused';
  if (err.status === 403) return 'forbidden';
  if (err.status === 404) return 'not_found';
  return 'unavailable';
}

// The settings to check: the stored ones, with whatever the form gives in their place (an unsaved
// token or ID). Nothing given here is stored. Throws AccessSyncVerifyError: invalid_id,
// token_invalid, verify_incomplete (no account or no token), token_undecryptable (the stored token no
// longer decrypts: ENCRYPTION_KEY changed).
export async function resolveVerifyConfig(input = {}, { load = loadStoredConfig } = {}) {
  const stored = await load();
  const pick = (field) => text(input?.[field]).toLowerCase() || stored[field] || '';
  const config = { accountId: pick('accountId'), appId: pick('appId'), policyId: pick('policyId') };
  if ((config.accountId && !ACCOUNT_ID_RE.test(config.accountId))
    || (config.appId && !UUID_RE.test(config.appId))
    || (config.policyId && !UUID_RE.test(config.policyId))) {
    throw new AccessSyncVerifyError('invalid_id');
  }
  const given = text(input?.apiToken);
  if (given && !API_TOKEN_RE.test(given)) throw new AccessSyncVerifyError('token_invalid');
  let apiToken = given;
  if (!apiToken && stored.apiToken) {
    try {
      apiToken = decrypt(stored.apiToken);
    } catch {
      throw new AccessSyncVerifyError('token_undecryptable');
    }
  }
  if (!config.accountId || !apiToken) throw new AccessSyncVerifyError('verify_incomplete');
  return { ...config, apiToken, tokenFromForm: !!given };
}

// Runs the checks. Answers { ok, checks: [{ id, status: 'ok'|'failed'|'skipped', code, ... }] }:
// ok is true when no check failed. A skipped check needs something not given (an app ID, a
// policy ID, CF_ACCESS_AUDIENCE) or a check before it that failed.
export async function verifyAccessSyncConfig(config, { fetchImpl, audience = cloudflareEnvState().audience } = {}) {
  const client = createCloudflareAccessClient({
    accountId: config.accountId, appId: config.appId, apiToken: config.apiToken, ...(fetchImpl ? { fetchImpl } : {}),
  });
  const checks = [];
  const add = (check) => { checks.push(check); return check; };

  try {
    const token = await client.verifyToken();
    add(token.status === 'active'
      ? { id: 'token', status: 'ok', code: 'active', expiresOn: token.expiresOn, owner: token.owner }
      : { id: 'token', status: 'failed', code: `token_${token.status}`, expiresOn: token.expiresOn });
  } catch (err) {
    add({ id: 'token', status: 'failed', code: failureCode(err) });
  }

  let app = null;
  if (!config.appId) {
    add({ id: 'app', status: 'skipped', code: 'no_app_id' });
  } else {
    try {
      app = await client.getApp();
      add({ id: 'app', status: 'ok', code: 'found', name: typeof app?.name === 'string' ? app.name : null });
    } catch (err) {
      add({ id: 'app', status: 'failed', code: failureCode(err) });
    }
  }

  if (!app) add({ id: 'audience', status: 'skipped', code: 'no_app' });
  else if (!audience) add({ id: 'audience', status: 'skipped', code: 'not_configured' });
  else add(app.aud === audience ? { id: 'audience', status: 'ok', code: 'match' } : { id: 'audience', status: 'failed', code: 'mismatch' });

  if (!config.appId || !config.policyId) {
    add({ id: 'policy', status: 'skipped', code: config.appId ? 'no_policy_id' : 'no_app_id' });
  } else {
    try {
      const policy = await client.getPolicy(config.policyId);
      add(policy?.decision === 'allow'
        ? { id: 'policy', status: 'ok', code: 'found', reusable: policy.reusable === true }
        : { id: 'policy', status: 'failed', code: 'not_allow' });
    } catch (err) {
      add({ id: 'policy', status: 'failed', code: failureCode(err) });
    }
  }

  return { ok: checks.every((check) => check.status !== 'failed'), checks };
}
