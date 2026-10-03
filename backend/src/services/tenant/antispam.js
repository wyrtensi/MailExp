// R-28: the tenant's default anti-spam policy, read only, and where its actions do not fit the
// filing layout of R-11. For recipients outside the cloud EOP files nothing into Junk: with
// MoveToJmf (or AddXHeader) it delivers the letter to the node with X-Forefront-Antispam-Report,
// and the node's Sieve rule files spam, bulk, spoofing and phishing into Junk, where employees see
// it. High confidence phishing stays in EOP's quarantine and the panel releases it (decision D-2,
// R-42). An action that keeps a letter from the node (Quarantine, Delete, Redirect) hides it from
// the employees; ModifySubject still delivers with the headers, so it only notes the change.
// Nothing here changes the policy: Set-HostedContentFilterPolicy is the owner's decision (D-2).

export const POLICY_ACTION_FIELDS = Object.freeze([
  'SpamAction', 'HighConfidenceSpamAction', 'BulkSpamAction', 'PhishSpamAction', 'HighConfidencePhishAction',
]);

// field -> the actions that fit the layout.
const EXPECTED = Object.freeze({
  SpamAction: ['MoveToJmf', 'AddXHeader'],
  HighConfidenceSpamAction: ['MoveToJmf', 'AddXHeader'],
  BulkSpamAction: ['MoveToJmf', 'AddXHeader'],
  PhishSpamAction: ['MoveToJmf', 'AddXHeader'],
  HighConfidencePhishAction: ['Quarantine'],
});

// What an action that does not fit means: [code, severity].
function mismatch(field, action) {
  if (action === 'Delete') return ['deleted', 'error'];
  if (action === 'Quarantine') return ['quarantined', 'warning'];
  if (action === 'Redirect') return [field === 'HighConfidencePhishAction' ? 'redirect_not_decided' : 'redirected', 'warning'];
  if (action === 'ModifySubject') return ['subject_only', 'info'];
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
