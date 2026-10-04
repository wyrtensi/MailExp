// R-28: the tenant's default anti-spam policy, and where its actions do not fit the filing layout
// of R-11. For recipients outside the cloud EOP files nothing into Junk: with MoveToJmf (or
// AddXHeader) it delivers the letter to the node with X-Forefront-Antispam-Report, and the node's
// Sieve rule files spam, bulk, spoofing and phishing into Junk, where employees see it. High
// confidence phishing stays in EOP's quarantine and the panel releases it (decision D-2, R-42). An
// action that keeps a letter from the node (Quarantine, Delete, Redirect) hides it from the
// employees; ModifySubject still delivers with the headers, so it only notes the change.
//
// The owner's decision after stage 7 (section 5.14 of eop-panel-requirements.md): ordinary
// phishing and spam land in the employees' Spam automatically. The panel no longer only warns: it
// sets SpamAction, HighConfidenceSpamAction, PhishSpamAction and (D-11) BulkSpamAction of the
// Default policy to MoveToJmf
// (ENFORCED: one fixed worker operation per field; services/tenant/tenantJobs.js syncAntispam
// reads, writes only the fields that differ, reads again and journals). Learn
// (Set-HostedContentFilterPolicy) allows MoveToJmf for those three verdicts; HighConfidencePhishAction
// takes only Quarantine and Redirect, and secure by default turns a MoveToJmf there into Quarantine,
// so high confidence phishing keeps the release path (R-42). Only Default is changed: custom
// policies and the Standard/Strict presets are left alone, their mail goes through the release.

export const POLICY_ACTION_FIELDS = Object.freeze([
  'SpamAction', 'HighConfidenceSpamAction', 'BulkSpamAction', 'PhishSpamAction', 'HighConfidencePhishAction',
]);

// The fields the panel sets to MoveToJmf, with the worker operation that sets each.
export const ENFORCED_ACTION = 'MoveToJmf';
export const ENFORCED = Object.freeze({
  SpamAction: 'set_spam_action_junk',
  HighConfidenceSpamAction: 'set_high_confidence_spam_action_junk',
  PhishSpamAction: 'set_phish_spam_action_junk',
  // D-11 (bulk to Spam), the owner's default after stage 7.
  BulkSpamAction: 'set_bulk_spam_action_junk',
});

// field -> the actions that fit the layout. An enforced field fits only with MoveToJmf: anything
// else is what the panel changes.
const EXPECTED = Object.freeze({
  SpamAction: [ENFORCED_ACTION],
  HighConfidenceSpamAction: [ENFORCED_ACTION],
  BulkSpamAction: [ENFORCED_ACTION],
  PhishSpamAction: [ENFORCED_ACTION],
  HighConfidencePhishAction: ['Quarantine'],
});

// What an action that does not fit means: [code, severity].
function mismatch(field, action) {
  if (action === 'Delete') return ['deleted', 'error'];
  if (action === 'Quarantine') return ['quarantined', 'warning'];
  if (action === 'Redirect') return [field === 'HighConfidencePhishAction' ? 'redirect_not_decided' : 'redirected', 'warning'];
  if (action === 'ModifySubject') return ['subject_only', 'info'];
  if (action === 'AddXHeader') return ['header_only', 'info'];
  if (action === 'NoAction') return ['no_action', 'warning'];
  return ['unexpected', 'warning'];
}

// The policy as the panel keeps it: the action fields, the bulk threshold and when it changed.
export function summarizePolicy(row) {
  if (!row || typeof row !== 'object') return null;
  const policy = { identity: String(row.Identity ?? 'Default') };
  for (const field of POLICY_ACTION_FIELDS) policy[field] = row[field] == null ? null : String(row[field]);
  policy.BulkThreshold = Number.isFinite(Number(row.BulkThreshold)) ? Number(row.BulkThreshold) : null;
  const redirect = row.RedirectToRecipients;
  // One address may come as a string rather than a list of one.
  policy.RedirectToRecipients = (Array.isArray(redirect) ? redirect : (redirect ? [redirect] : [])).map(String).slice(0, 20);
  policy.WhenChanged = row.WhenChanged ? String(row.WhenChanged) : null;
  return policy;
}

// The actions that do not fit: [{ field, action, expected, code, severity }], in field order.
export function policyConflicts(policy) {
  if (!policy) return [];
  const conflicts = [];
  for (const field of POLICY_ACTION_FIELDS) {
    const action = policy[field];
    if (!action || EXPECTED[field].includes(action)) continue;
    const [code, severity] = mismatch(field, action);
    conflicts.push({ field, action, expected: EXPECTED[field], code, severity });
  }
  return conflicts;
}

// What the panel writes: [{ field, from, op }] for each enforced field whose action is known and is
// not MoveToJmf. A field the answer did not carry is not written blind.
export function enforcementPlan(policy) {
  if (!policy) return [];
  return Object.entries(ENFORCED)
    .filter(([field]) => policy[field] && policy[field] !== ENFORCED_ACTION)
    .map(([field, op]) => ({ field, from: policy[field], op }));
}
