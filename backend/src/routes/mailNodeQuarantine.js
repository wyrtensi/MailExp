import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { routeActor } from '../services/actor.js';
import { getMailNodeConfig, getQuarantineItem } from '../services/mailNode/mailcow.js';
import {
  findHistoryEntry,
  getQuarantineUserView,
  nodeDomainNames,
  panelNodeMailboxes,
  parseQuarantineLetter,
  readRspamdHistory,
} from '../services/mailNode/quarantine.js';
import {
  QUARANTINE_ERRORS, applyQuarantineNodeSettings, listNodeQuarantine, parseQuarantineId, quarantineEntryAction,
  quarantineSettingsView, setQuarantineUserViewAction,
} from '../services/mailNode/quarantineActions.js';
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

// Symbols "why is this letter in Spam" shows.
const MAX_VERDICT_SYMBOLS = 15;

function refuse(res, code) {
  const [status, error] = QUARANTINE_ERRORS[code];
  return res.status(status).json({ error, code });
}

// A shared action's answer (services/mailNode/quarantineActions.js, which the panel CLI shares):
// its refusal, the node's failure or its result.
async function answer(res, run) {
  let result;
  try {
    result = await run();
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  return result.error ? refuse(res, result.error) : res.json(result);
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
  const id = parseQuarantineId(req.params.itemId);
  if (id === null) refuse(res, 'quarantine_item_invalid');
  return id;
}

async function nodeConfig(res) {
  const cfg = await getMailNodeConfig();
  if (!cfg) refuse(res, 'mail_node_not_configured');
  return cfg;
}

// The panel's own settings for the quarantine, and the mailcow settings it writes on request
// (nodeSettings) with when it last did (nodeSettingsAppliedAt, null: never).
router.get('/quarantine/settings', requireAdmin, async (req, res) => {
  res.json(await quarantineSettingsView());
});

router.put('/quarantine/settings', requireAdmin, (req, res) => answer(res, () => (
  setQuarantineUserViewAction(req.body?.userView, routeActor(req))
)));

// "Enable quarantine on this node" / "Re-apply": writes every quarantine setting of mailcow. It
// resets whatever it is not given, so it runs only with { confirm: true } after the screen's
// warning, and is journaled.
router.post('/quarantine/node-settings', requireAdmin, (req, res) => answer(res, () => (
  applyQuarantineNodeSettings({ confirm: req.body?.confirm === true }, routeActor(req))
)));

// The entries, newest first, with the panel's account id of each mailbox and the symbols that
// weighed most when rspamd's history still holds the scan; a user without administrator rights
// sees only those addressed to the panel's node mailboxes.
router.get('/quarantine', async (req, res) => {
  const who = await viewer(req, res);
  if (!who) return undefined;
  return answer(res, () => listNodeQuarantine(who));
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

// An administrator's action on one entry: answers 404 for an entry gone from the node, runs it,
// journals it with what training did and what the node warned about.
const entryAction = (kind) => (req, res) => answer(res, () => quarantineEntryAction(req.params.itemId, kind, routeActor(req)));

// Release: the node delivers the letter to its mailbox past rspamd, removes the entry and trains
// rspamd with it as ham (and its fuzzy hash as ham).
router.post('/quarantine/:itemId/release', requireAdmin, entryAction('release'));
// "Delete and train as spam": the node removes the entry and trains rspamd with it as spam.
router.post('/quarantine/:itemId/learn-spam', requireAdmin, entryAction('learn_spam'));
router.delete('/quarantine/:itemId', requireAdmin, entryAction('delete'));

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
