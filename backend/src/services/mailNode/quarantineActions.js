import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import {
  QUARANTINE_NODE_SETTINGS, deleteQuarantineItem, getMailNodeConfig, learnSpamQuarantineItem, listQuarantine,
  releaseQuarantineItem, writeQuarantineSettings,
} from './mailcow.js';
import {
  getQuarantineSettingsAppliedAt, getQuarantineUserView, historyForQuarantine, markQuarantineSettingsApplied,
  panelNodeMailboxes, readRspamdHistory, setQuarantineUserView, spamRowsFor, topSymbols, withDeadline,
} from './quarantine.js';

// The mail node's quarantine (R-20; rspamd's, kept by mailcow; services/mailNode/quarantine.js):
// the listing, the administrator's actions on an entry and the quarantine settings, shared by
// routes/mailNodeQuarantine.js and the panel CLI (src/cli/mailexpert.js). They answer a result or
// { error: code } (a key of QUARANTINE_ERRORS); a failure of the node throws (MailNodeError).
// actor: services/actor.js.

export const QUARANTINE_ERRORS = Object.freeze({
  mail_node_not_configured: [409, 'The mail node is not set up'],
  quarantine_admin_only: [403, 'Only administrators see the quarantine'],
  quarantine_item_invalid: [400, 'Quarantine entry must be a number'],
  quarantine_item_not_found: [404, 'No such quarantine entry'],
  quarantine_user_view_invalid: [400, 'userView must be true or false'],
  quarantine_settings_unconfirmed: [400, 'Writing the quarantine settings needs { confirm: true }: it overwrites every quarantine setting in mailcow'],
  message_not_found: [404, 'Message not found'],
  message_not_mail_node: [400, 'The letter is not in a mail node mailbox'],
  mail_node_host_mismatch: [409, 'The mailbox is on another mail host than the one in the mail node settings'],
});

// The newest entries a listing returns.
const MAX_LIST = 2000;
// How long a listing waits for rspamd's history before it answers without the symbols.
const LIST_HISTORY_WAIT_MS = 4000;

// A quarantine entry's id: a whole number from 1, or null.
export function parseQuarantineId(value) {
  const raw = String(value ?? '');
  if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) return null;
  return Number(raw);
}

// An administrator's view: every entry, and the panel's node mailboxes (address -> account id).
export async function adminViewer() {
  return { admin: true, mailboxes: await panelNodeMailboxes() };
}

// --- settings -----------------------------------------------------------------------------------

// The panel's own settings for the quarantine, and the mailcow settings it writes on request
// (nodeSettings) with when it last did (nodeSettingsAppliedAt, null: never).
export async function quarantineSettingsView() {
  return {
    userView: await getQuarantineUserView(),
    nodeSettingsAppliedAt: await getQuarantineSettingsAppliedAt(),
    nodeSettings: QUARANTINE_NODE_SETTINGS,
  };
}

// "Users see the quarantine": { ok, userView }. Journaled when it changes.
export async function setQuarantineUserViewAction(userView, actor) {
  if (typeof userView !== 'boolean') return { error: 'quarantine_user_view_invalid' };
  const before = await getQuarantineUserView();
  if (before !== userView) {
    await setQuarantineUserView(userView);
    recordAudit(auditOf(actor, { action: 'mail_node.config_changed', details: { settings: 'quarantine', fields: ['userView'] } }));
  }
  return { ok: true, userView };
}

// "Enable quarantine on this node" / "Re-apply": writes every quarantine setting of mailcow
// (QUARANTINE_NODE_SETTINGS). mailcow cannot report them, and the call resets whatever it is not
// given, so it runs only with confirm after a warning, and is journaled.
export async function applyQuarantineNodeSettings({ confirm = false } = {}, actor) {
  if (confirm !== true) return { error: 'quarantine_settings_unconfirmed' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const before = await getQuarantineSettingsAppliedAt();
  await writeQuarantineSettings(cfg);
  const at = await markQuarantineSettingsApplied();
  const { max_size: maxSize, retention_size: retentionSize, max_age: maxAge, release_format: releaseFormat } = QUARANTINE_NODE_SETTINGS;
  recordAudit(auditOf(actor, {
    action: 'mail_node.quarantine_settings_applied',
    details: { reapplied: !!before, ...(before ? { previous: before } : {}), maxSize, retentionSize, maxAge, releaseFormat },
  }));
  return { ok: true, ...(await quarantineSettingsView()), nodeSettingsAppliedAt: at };
}

// --- the listing --------------------------------------------------------------------------------

// The entries, newest first, each with the panel's account id of its mailbox (null for a mailbox
// the panel does not have) and, when rspamd's recent history still holds the scan, the symbols that
// weighed most. A history that cannot be read in LIST_HISTORY_WAIT_MS leaves the symbols out, never
// the list. For an administrator an empty quarantine comes with the number of letters the history
// shows refused or marked as spam for the panel's mailboxes (spamInHistory): some means mailcow's
// quarantine is probably off. who: { admin, mailboxes } (a user without administrator rights sees
// only the entries addressed to the panel's mailboxes).
export async function listNodeQuarantine(who) {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  let items = await listQuarantine(cfg);
  if (!who.admin) items = items.filter((item) => who.mailboxes.has(item.rcpt));
  const total = items.length;
  items = items.slice(0, MAX_LIST);
  const history = await withDeadline(readRspamdHistory(cfg).catch((err) => {
    console.error(`Mail node rspamd history for the quarantine failed: ${err?.code || 'error'}`);
    return null;
  }), LIST_HISTORY_WAIT_MS);
  return {
    admin: who.admin,
    total,
    truncated: total > items.length,
    historyRead: history !== null,
    ...(who.admin && total === 0 && history ? { spamInHistory: spamRowsFor(history, who.mailboxes) } : {}),
    items: items.map((item) => {
      const row = history ? historyForQuarantine(item, history) : null;
      return { ...item, accountId: who.mailboxes.get(item.rcpt) ?? null, topSymbols: row ? topSymbols(row.symbols) : null };
    }),
  };
}

// --- an administrator's action on one entry -----------------------------------------------------

// release: the node delivers the letter to its mailbox past rspamd, removes the entry and trains
// rspamd with it as ham (and its fuzzy hash as ham). learn_spam ("Delete and train as spam"): the
// node removes the entry and trains rspamd with it as spam. delete: the node removes the entry.
export const QUARANTINE_ENTRY_ACTIONS = Object.freeze({
  release: { run: releaseQuarantineItem, action: 'mail_node.quarantine_released' },
  learn_spam: { run: learnSpamQuarantineItem, action: 'mail_node.quarantine_learned_spam' },
  delete: { run: deleteQuarantineItem, action: 'mail_node.quarantine_deleted' },
});

// Refuses an entry gone from the node (quarantine_item_not_found), runs the action, journals it with
// what training did and what the node warned about: { ok, learned?, warnings? }.
export async function quarantineEntryAction(rawId, kind, actor) {
  const id = parseQuarantineId(rawId);
  if (id === null) return { error: 'quarantine_item_invalid' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const item = (await listQuarantine(cfg)).find((q) => q.id === id);
  if (!item) return { error: 'quarantine_item_not_found' };
  const { run, action } = QUARANTINE_ENTRY_ACTIONS[kind];
  const result = (await run(cfg, id)) ?? null;
  const warnings = result?.warnings ?? [];
  const accountId = (await panelNodeMailboxes()).get(item.rcpt) ?? null;
  recordAudit(auditOf(actor, {
    action,
    ...(accountId ? { accountId } : { accountEmail: item.rcpt || null }),
    details: {
      id: item.id, qid: item.qid, rcpt: item.rcpt, sender: item.sender, score: item.score, action: item.action,
      ...(result ? { learned: result.learned, ...(warnings.length ? { warnings } : {}) } : {}),
    },
  }));
  return { ok: true, ...(result ? { learned: result.learned, warnings } : {}) };
}
