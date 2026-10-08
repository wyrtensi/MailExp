import { getAuthSettings } from '../auth/authSettings.js';
import { loadState, loadStoredConfig } from './settings.js';

// Where a user stands in the Cloudflare Access policy, for the users screen and `mailexpert user`:
//
//   not_synced             the sync is off (or the panel does not sign in through Google/Access)
//   in_access              active, and the policy listed the email at the last successful run
//   pending                active, not written to the policy yet (the next run writes it)
//   admitted_by_rule       active, created at a Cloudflare Access sign-in that a domain or group
//                          rule admitted: the sync does not write this address into the policy
//   removed_in_cloudflare  removed from the policy in Cloudflare: disabled by the sync, or waiting
//                          to be disabled by a run the mass-change limit stopped
//   null                   no email, or disabled by an administrator (the policy follows: the
//                          sync removes the emails it wrote for users who are not active)
export const ACCESS_STATES = Object.freeze(['not_synced', 'in_access', 'pending', 'admitted_by_rule', 'removed_in_cloudflare']);
export const ACCESS_LOGIN_SOURCE = 'login';

export const ACCESS_REMOVED_SOURCE = 'cloudflare_access';

// What accessStateOf needs, read once per request.
export async function loadAccessStateContext({ settings = getAuthSettings() } = {}) {
  const [config, state] = await Promise.all([loadStoredConfig(), loadState()]);
  return {
    synced: settings.mode === 'google' && config.enabled === true,
    policyEmails: new Set(state.policyEmails ?? []),
    awaitingDisable: new Set(state.abortedCandidates ?? []),
  };
}

// row: a users row with email, disabled_at, disabled_source and access_source.
export function accessStateOf(row, context) {
  if (!context) return null;
  if (!context.synced) return 'not_synced';
  const email = row.email?.toLowerCase();
  if (!email) return null;
  if (row.disabled_at) return row.disabled_source === ACCESS_REMOVED_SOURCE ? 'removed_in_cloudflare' : null;
  if (context.awaitingDisable.has(email)) return 'removed_in_cloudflare';
  if (context.policyEmails.has(email)) return 'in_access';
  return row.access_source === ACCESS_LOGIN_SOURCE ? 'admitted_by_rule' : 'pending';
}
