// The mail node's quarantine and rspamd's verdict on a letter (R-20 in
// docs/architecture/mail-node-research/eop-panel-requirements.md): the words for rspamd's actions,
// what releasing an entry does, and why a letter of a node mailbox is in Spam. The screens are
// MailNodeQuarantine.jsx and SpamVerdict.jsx; the server is backend/src/routes/mailNodeQuarantine.js.

// rspamd's actions as mailcow reports them. Spelled out literally so the i18n coverage test finds them.
const ACTION_KEYS = {
  reject: 'message.spamVerdict.action.reject',
  'soft reject': 'message.spamVerdict.action.softReject',
  'rewrite subject': 'message.spamVerdict.action.rewriteSubject',
  'add header': 'message.spamVerdict.action.addHeader',
  greylist: 'message.spamVerdict.action.greylist',
  'no action': 'message.spamVerdict.action.noAction',
};

// The key for an action, or null for one rspamd may add later (shown as written).
export function rspamdActionKey(action) {
  return ACTION_KEYS[String(action ?? '').toLowerCase()] ?? null;
}

// A score as rspamd prints it, without trailing zeros: 16.1, 8, -0.1.
export function formatScore(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return '';
  return String(Number(Number(score).toFixed(2)));
}

// What releasing an entry does, by what rspamd did with the letter:
// - refused at the door (reject): the letter exists only in the quarantine, releasing delivers it;
// - delivered to the mailbox's Spam folder (add header, rewrite subject): the quarantine holds a
//   copy, and mailcow's duplicate rule throws a released second copy away; the letter is moved
//   out of Spam in the mailbox itself, releasing only teaches rspamd it was not spam.
export function releaseNoteKey(action) {
  const value = String(action ?? '').toLowerCase();
  if (value === 'add header' || value === 'rewrite subject') return 'admin.quarantine.noteDelivered';
  if (value === 'reject' || value === 'soft reject') return 'admin.quarantine.noteRejected';
  return 'admin.quarantine.noteOther';
}

// Entries whose sender, recipient or subject holds the text typed (case aside).
export function filterQuarantine(items, text) {
  const needle = String(text ?? '').trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => [item.sender, item.rcpt, item.subject].some((v) => String(v ?? '').toLowerCase().includes(needle)));
}

// An attachment's size for the screen: { key, value } in bytes, KB or MB.
export function sizeLabel(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return { key: 'admin.quarantine.sizeBytes', value: String(n) };
  if (n < 1024 ** 2) return { key: 'admin.quarantine.sizeKb', value: String(Math.round(n / 1024)) };
  return { key: 'admin.quarantine.sizeMb', value: (n / 1024 ** 2).toFixed(1) };
}

// Whether the panel's spam filing rule (R-11, backend services/mailNode/nodeApply.js) files a letter
// with this EOP verdict in Spam: phishing and malware always, spam, bulk and spoofing unless EOP
// released it from its own quarantine (SFV:SKQ). A released quarantine entry goes through the rule
// like any letter, so such a letter lands in Spam again.
const EOP_ALWAYS_SPAM = new Set(['PHSH', 'HPHSH', 'HPHISH', 'MALW']);
export function eopSendsToSpam(eop) {
  const verdict = String(eop?.verdict ?? '').toUpperCase();
  const category = String(eop?.category ?? '').toUpperCase();
  if (EOP_ALWAYS_SPAM.has(category)) return true;
  if (verdict === 'SKQ') return false;
  return ['SPM', 'SKS', 'SKB'].includes(verdict) || ['SPM', 'HSPM', 'BULK', 'SPOOF'].includes(category);
}

// Why the letter is in Spam, as keys in the order they matter: rspamd marked it as spam (its score
// reached the spam score), EOP's category put it there through the panel's rule, or neither (a
// person, an inbox rule or the sender's own filter moved it). Without rspamd's row only the EOP
// reason can be told. The sync keeps EOP's category, not its verdict (messages.eop_category).
export function spamReasons({ rspamd, eopCategory }) {
  const reasons = [];
  const action = String(rspamd?.action ?? '').toLowerCase();
  if (action === 'add header' || action === 'rewrite subject' || action === 'reject' || action === 'soft reject') {
    reasons.push('message.spamVerdict.reasonRspamd');
  }
  if (eopSendsToSpam({ category: eopCategory })) reasons.push('message.spamVerdict.reasonEop');
  if (!reasons.length && rspamd) reasons.push('message.spamVerdict.reasonOther');
  return reasons;
}
