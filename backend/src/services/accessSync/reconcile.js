// Three-way reconcile of an Access policy's include list with MailExpert's active users. The
// baseline is the set of emails MailExpert itself wrote last time: only those are MailExpert's to
// remove, and one missing from Cloudflare means someone removed it there. An email someone added
// in Cloudflare becomes a user (importCandidates) and from then on is MailExpert's like the rest.
// Every other rule — groups, email domains, emails that are not imported — is left as it is.

const lower = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const ruleEmail = (rule) => lower(rule?.email?.email);
const ruleDomain = (rule) => lower(rule?.email_domain?.domain);
const isEmailRule = (rule) => !!ruleEmail(rule);

// Whether an email_domain rule of the policy still lets an email in.
export function domainAdmits(policy) {
  const domains = new Set((policy.include ?? []).map(ruleDomain).filter(Boolean));
  const excludedEmails = new Set((policy.exclude ?? []).map(ruleEmail).filter(Boolean));
  const excludedDomains = new Set((policy.exclude ?? []).map(ruleDomain).filter(Boolean));
  return (email) => {
    const at = email.slice(email.lastIndexOf('@') + 1);
    return domains.has(at) && !excludedEmails.has(email) && !excludedDomains.has(at);
  };
}

// Active users whose email MailExpert wrote but Cloudflare no longer lists or admits.
export function removedInCloudflare({ policy, baseline, activeEmails, pinned }) {
  const listed = new Set((policy.include ?? []).map(ruleEmail).filter(Boolean));
  // A policy without a single email looks wiped or misread, not like a decision about each user.
  if (listed.size === 0) return [];
  const active = new Set(activeEmails);
  const admits = domainAdmits(policy);
  return [...new Set(baseline)]
    .filter((email) => active.has(email) && !listed.has(email) && !pinned.has(email) && !admits(email))
    .sort();
}

// Emails the policy lists that MailExpert did not write: someone added them in Cloudflare, so they
// are candidates to become users (the runner drops those that already have a user or a
// tombstone). An email the policy also excludes is not admitted, and a bootstrap admin gets an
// admin account on their first sign-in instead.
export function importCandidates({ policy, baseline, pinned }) {
  const owned = new Set(baseline);
  const excludedEmails = new Set((policy.exclude ?? []).map(ruleEmail).filter(Boolean));
  const excludedDomains = new Set((policy.exclude ?? []).map(ruleDomain).filter(Boolean));
  return [...new Set((policy.include ?? []).map(ruleEmail).filter(Boolean))]
    .filter((email) => !owned.has(email) && !pinned.has(email) && !excludedEmails.has(email)
      && !excludedDomains.has(email.slice(email.lastIndexOf('@') + 1)))
    .sort();
}

// Every email an include list names, sorted: what the policy admits by address.
export function listedEmails(include) {
  return [...new Set((include ?? []).map(ruleEmail).filter(Boolean))].sort();
}

// Whether a run would import too many users to trust it.
export function exceedsImportLimit(count, maxImports) {
  return count > maxImports;
}

// Whether a run would disable too many users to trust it.
export function exceedsDisableLimit(count, activeCount, maxDisables) {
  return count > 0 && (count > maxDisables || count * 2 > activeCount);
}

export function buildInclude({ policy, baseline, desired }) {
  const current = policy.include ?? [];
  const owned = new Set(baseline);
  const wanted = [...new Set(desired)].sort();
  const wantedSet = new Set(wanted);
  const listed = new Set(current.map(ruleEmail).filter(Boolean));

  const kept = current.filter((rule) => {
    if (!isEmailRule(rule)) return true;
    const email = ruleEmail(rule);
    return !owned.has(email) && !wantedSet.has(email);
  });
  const include = [...kept, ...wanted.map((email) => ({ email: { email } }))];
  const added = wanted.filter((email) => !listed.has(email));
  const removed = [...listed].filter((email) => owned.has(email) && !wantedSet.has(email)).sort();
  return { include, changed: added.length > 0 || removed.length > 0, added, removed };
}
