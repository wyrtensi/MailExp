import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { recordAudit } from '../services/auditLog.js';
import {
  QUARANTINE_NODE_SETTINGS,
  deleteQuarantineItem,
  getMailNodeConfig,
  getQuarantineItem,
  learnSpamQuarantineItem,
  listQuarantine,
  releaseQuarantineItem,
  writeQuarantineSettings,
} from '../services/mailNode/mailcow.js';
import {
  findHistoryEntry,
  getQuarantineSettingsAppliedAt,
  getQuarantineUserView,
  historyForQuarantine,
  markQuarantineSettingsApplied,
  nodeDomainNames,
  panelNodeMailboxes,
  parseQuarantineLetter,
  readRspamdHistory,
  setQuarantineUserView,
  spamRowsFor,
  topSymbols,
  withDeadline,
} from '../services/mailNode/quarantine.js';
import { mailNodeFailure, onOtherMailHost } from './mailNode.js';
import { getSpamRuleState } from '../services/mailNode/nodeApply.js';

// The mail node's quarantine and rspamd history (R-20; services/mailNode/quarantine.js), mounted
// at /api/mail-node next to routes/mailNode.js:
// - the quarantine: administrators see every entry, and with the "users see the quarantine"
//   setting every signed-in user sees the entries addressed to the panel's node mailboxes; the
//   letter comes as parsed parts the screen shows only in the safe text view. Releasing, deleting,
//   "delete and train as spam" and writing mailcow's quarantine settings are for administrators
//   and journaled;
// - "why is this letter in Spam": rspamd's verdict on one letter of a node mailbox, for anyone who
//   can open the letter (every mailbox is shared by all users of the install).
const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

// The newest entries a listing returns.
const MAX_LIST = 2000;
// Symbols "why is this letter in Spam" shows.
const MAX_VERDICT_SYMBOLS = 15;
// How long a listing waits for rspamd's history before it answers without the symbols.
const LIST_HISTORY_WAIT_MS = 4000;

const ERRORS = {
  mail_node_not_configured: [409, 'The mail node is not set up'],
  quarantine_admin_only: [403, 'Only administrators see the quarantine'],
  quarantine_item_invalid: [400, 'Quarantine entry must be a number'],
  quarantine_item_not_found: [404, 'No such quarantine entry'],
  quarantine_user_view_invalid: [400, 'userView must be true or false'],
  quarantine_settings_unconfirmed: [400, 'Writing the quarantine settings needs { confirm: true }: it overwrites every quarantine setting in mailcow'],
  message_not_found: [404, 'Message not found'],
  message_not_mail_node: [400, 'The letter is not in a mail node mailbox'],
  mail_node_host_mismatch: [409, 'The mailbox is on another mail host than the one in the mail node settings'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

async function isAdmin(req) {
  const { rows } = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  return !!rows[0]?.is_admin;
}

// Who is asking and what they may see: { admin, mailboxes } where mailboxes is the panel's node
// mailboxes (address -> account id); null after answering 403 for a user without the setting.
async function viewer(req, res) {
  const admin = await isAdmin(req);
  if (!admin && !(await getQuarantineUserView())) {
    refuse(res, 'quarantine_admin_only');
    return null;
  }
  return { admin, mailboxes: await panelNodeMailboxes() };
}

function itemId(req, res) {
  const raw = String(req.params.itemId ?? '');
  if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) {
    refuse(res, 'quarantine_item_invalid');
    return null;
  }
  return Number(raw);
}

async function nodeConfig(res) {
  const cfg = await getMailNodeConfig();
  if (!cfg) refuse(res, 'mail_node_not_configured');
  return cfg;
}

// The panel's own settings for the quarantine, and the mailcow settings it writes on request
// (nodeSettings) with when it last did (nodeSettingsAppliedAt, null: never).
async function settingsAnswer() {
  return {
    userView: await getQuarantineUserView(),
    nodeSettingsAppliedAt: await getQuarantineSettingsAppliedAt(),
    nodeSettings: QUARANTINE_NODE_SETTINGS,
  };
}

router.get('/quarantine/settings', requireAdmin, async (req, res) => {
  res.json(await settingsAnswer());
});

router.put('/quarantine/settings', requireAdmin, async (req, res) => {
  const userView = req.body?.userView;
  if (typeof userView !== 'boolean') return refuse(res, 'quarantine_user_view_invalid');
  const before = await getQuarantineUserView();
  if (before !== userView) {
    await setQuarantineUserView(userView);
    recordAudit({
      actorUserId: req.session.userId, action: 'mail_node.config_changed', details: { settings: 'quarantine', fields: ['userView'] },
    });
  }
  res.json({ ok: true, userView });
});

// "Enable quarantine on this node" / "Re-apply": writes every quarantine setting of mailcow
// (QUARANTINE_NODE_SETTINGS). mailcow cannot report them, and the call resets whatever it is not
// given, so it runs only with { confirm: true } after the screen's warning, and is journaled.
router.post('/quarantine/node-settings', requireAdmin, async (req, res) => {
  if (req.body?.confirm !== true) return refuse(res, 'quarantine_settings_unconfirmed');
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  const before = await getQuarantineSettingsAppliedAt();
  try {
    await writeQuarantineSettings(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  const at = await markQuarantineSettingsApplied();
  const { max_size: maxSize, retention_size: retentionSize, max_age: maxAge, release_format: releaseFormat } = QUARANTINE_NODE_SETTINGS;
  recordAudit({
    actorUserId: req.session.userId,
    action: 'mail_node.quarantine_settings_applied',
    details: { reapplied: !!before, ...(before ? { previous: before } : {}), maxSize, retentionSize, maxAge, releaseFormat },
  });
  res.json({ ok: true, ...(await settingsAnswer()), nodeSettingsAppliedAt: at });
});

// The entries, newest first, each with the panel's account id of its mailbox (null for a mailbox
// the panel does not have) and, when rspamd's recent history still holds the scan, the symbols that
// weighed most. A history that cannot be read in LIST_HISTORY_WAIT_MS leaves the symbols out, never
// the list. For an administrator an empty quarantine comes with the number of letters the history
// shows refused or marked as spam for the panel's mailboxes (spamInHistory): some means mailcow's
// quarantine is probably off.
router.get('/quarantine', async (req, res) => {
  const who = await viewer(req, res);
  if (!who) return undefined;
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  let items;
  try {
    items = await listQuarantine(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (!who.admin) items = items.filter((item) => who.mailboxes.has(item.rcpt));
  const total = items.length;
  items = items.slice(0, MAX_LIST);
  const history = await withDeadline(readRspamdHistory(cfg).catch((err) => {
    console.error(`Mail node rspamd history for the quarantine failed: ${err?.code || 'error'}`);
    return null;
  }), LIST_HISTORY_WAIT_MS);
  res.json({
    admin: who.admin,
    total,
    truncated: total > items.length,
    historyRead: history !== null,
    ...(who.admin && total === 0 && history ? { spamInHistory: spamRowsFor(history, who.mailboxes) } : {}),
    items: items.map((item) => {
      const row = history ? historyForQuarantine(item, history) : null;
      return { ...item, accountId: who.mailboxes.get(item.rcpt) ?? null, topSymbols: row ? topSymbols(row.symbols) : null };
    }),
  });
});

// One entry with its letter parsed for the safe text view. A user without administrator rights
// gets 404 for an entry addressed to a mailbox the panel does not have, as if it did not exist, and
// neither the login that sent it (user) nor the symbols' details (options: addresses, URLs).
router.get('/quarantine/:itemId', async (req, res) => {
  const id = itemId(req, res);
  if (id === null) return undefined;
  const who = await viewer(req, res);
  if (!who) return undefined;
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  let item;
  try {
    item = await getQuarantineItem(cfg, id);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  if (!item || (!who.admin && !who.mailboxes.has(item.rcpt))) return refuse(res, 'quarantine_item_not_found');
  const { msg, user, symbols, ...entry } = item;
  res.json({
    ...entry,
    ...(who.admin ? { user } : {}),
    symbols: who.admin ? symbols : symbols.map(({ name, score, description }) => ({ name, score, description })),
    accountId: who.mailboxes.get(item.rcpt) ?? null,
    admin: who.admin,
    letter: parseQuarantineLetter(msg),
    // Section 5.14: which version of the spam rule the node held when last checked (ok, outdated,
    // missing, unknown; null before the first check), for what a release does with EOP's verdict.
    spamRule: (await getSpamRuleState().catch(() => null))?.state ?? null,
  });
});

// The entry as the listing shows it, for the journal and to answer 404 before acting.
async function listedItem(res, cfg, id) {
  try {
    const item = (await listQuarantine(cfg)).find((q) => q.id === id);
    if (!item) refuse(res, 'quarantine_item_not_found');
    return item ?? null;
  } catch (err) {
    mailNodeFailure(res, err);
    return null;
  }
}

async function journal(req, action, item, extra = {}) {
  const accountId = (await panelNodeMailboxes()).get(item.rcpt) ?? null;
  recordAudit({
    actorUserId: req.session.userId,
    action,
    ...(accountId ? { accountId } : { accountEmail: item.rcpt || null }),
    details: { id: item.id, qid: item.qid, rcpt: item.rcpt, sender: item.sender, score: item.score, action: item.action, ...extra },
  });
}

// An administrator's action on one entry: answers 404 for an entry gone from the node, runs it,
// journals it with what training did and what the node warned about.
function entryAction(run, action) {
  return async (req, res) => {
    const id = itemId(req, res);
    if (id === null) return undefined;
    const cfg = await nodeConfig(res);
    if (!cfg) return undefined;
    const item = await listedItem(res, cfg, id);
    if (!item) return undefined;
    let result;
    try {
      result = (await run(cfg, id)) ?? null;
    } catch (err) {
      return mailNodeFailure(res, err);
    }
    const warnings = result?.warnings ?? [];
    await journal(req, action, item, result ? { learned: result.learned, ...(warnings.length ? { warnings } : {}) } : {});
    return res.json({ ok: true, ...(result ? { learned: result.learned, warnings } : {}) });
  };
}

// Release: the node delivers the letter to its mailbox past rspamd, removes the entry and trains
// rspamd with it as ham (and its fuzzy hash as ham).
router.post('/quarantine/:itemId/release', requireAdmin, entryAction(releaseQuarantineItem, 'mail_node.quarantine_released'));
// "Delete and train as spam": the node removes the entry and trains rspamd with it as spam.
router.post('/quarantine/:itemId/learn-spam', requireAdmin, entryAction(learnSpamQuarantineItem, 'mail_node.quarantine_learned_spam'));
router.delete('/quarantine/:itemId', requireAdmin, entryAction(deleteQuarantineItem, 'mail_node.quarantine_deleted'));

// "Why is this letter in Spam": rspamd's verdict on a letter of a node mailbox, found in the node's
// recent history (the last letters rspamd checked, read at most once a minute) by its Message-ID,
// else by recipient, subject and time; with the EOP category the sync stored. Read-only.
router.get('/messages/:id/spam-verdict', async (req, res) => {
  const { rows } = await query(
    `SELECT m.message_id, m.date, m.subject, m.eop_category, a.id AS account_id, a.email_address, a.imap_host, a.mail_node
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1`,
    [req.params.id],
  );
  const message = rows[0];
  if (!message) return refuse(res, 'message_not_found');
  if (!message.mail_node) return refuse(res, 'message_not_mail_node');
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  if (onOtherMailHost(message, cfg)) return refuse(res, 'mail_node_host_mismatch');
  const { rows: aliases } = await query('SELECT lower(email) AS email FROM account_aliases WHERE account_id = $1', [message.account_id]);
  let history;
  try {
    history = await readRspamdHistory(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  const found = findHistoryEntry(history, {
    messageId: message.message_id,
    recipients: [message.email_address.toLowerCase(), ...aliases.map((a) => a.email)],
    date: message.date,
    subject: message.subject,
    nodeDomains: await nodeDomainNames(),
  });
  const row = found?.row;
  res.json({
    eopCategory: message.eop_category ?? null,
    historyRows: history.length,
    rspamd: row ? {
      matchedBy: found.matchedBy,
      time: row.time,
      score: row.score,
      spamScore: row.spamScore,
      rejectScore: row.rejectScore,
      action: row.action,
      skipped: row.skipped,
      symbols: row.symbols.filter((s) => s.score !== 0).slice(0, MAX_VERDICT_SYMBOLS)
        .map(({ name, score, description }) => ({ name, score, description })),
    } : null,
  });
});

export default router;
