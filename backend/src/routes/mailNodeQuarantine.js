import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { recordAudit } from '../services/auditLog.js';
import {
  deleteQuarantineItem,
  getMailNodeConfig,
  getQuarantineItem,
  listQuarantine,
  releaseQuarantineItem,
} from '../services/mailNode/mailcow.js';
import {
  HISTORY_ROWS,
  findHistoryEntry,
  getQuarantineUserView,
  historyForQuarantine,
  panelNodeMailboxes,
  parseQuarantineLetter,
  readRspamdHistory,
  setQuarantineUserView,
  topSymbols,
} from '../services/mailNode/quarantine.js';
import { mailNodeFailure, onOtherMailHost } from './mailNode.js';

// The mail node's quarantine and rspamd history (R-20; services/mailNode/quarantine.js), mounted
// at /api/mail-node next to routes/mailNode.js:
// - the quarantine: administrators see every entry, and with the "users see the quarantine"
//   setting every signed-in user sees the entries addressed to the panel's node mailboxes; the
//   letter comes as parsed parts the screen shows only in the safe text view. Releasing and
//   deleting are for administrators and journaled;
// - "why is this letter in Spam": rspamd's verdict on one letter of a node mailbox, for anyone who
//   can open the letter (every mailbox is shared by all users of the install).
const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

// The newest entries a listing returns.
const MAX_LIST = 2000;
// Symbols "why is this letter in Spam" shows.
const MAX_VERDICT_SYMBOLS = 15;

const ERRORS = {
  mail_node_not_configured: [409, 'The mail node is not set up'],
  quarantine_admin_only: [403, 'Only administrators see the quarantine'],
  quarantine_item_invalid: [400, 'Quarantine entry must be a number'],
  quarantine_item_not_found: [404, 'No such quarantine entry'],
  quarantine_user_view_invalid: [400, 'userView must be true or false'],
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

router.get('/quarantine/settings', requireAdmin, async (req, res) => {
  res.json({ userView: await getQuarantineUserView() });
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

// The entries, newest first, each with the panel's account id of its mailbox (null for a mailbox
// the panel does not have) and, when rspamd's recent history still holds the scan, the symbols that
// weighed most. A history that cannot be read leaves the symbols out, never the list.
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
  const history = await readRspamdHistory(cfg).then((rows) => rows, (err) => {
    console.error(`Mail node rspamd history for the quarantine failed: ${err?.code || 'error'}`);
    return null;
  });
  res.json({
    admin: who.admin,
    total,
    truncated: total > items.length,
    historyRead: history !== null,
    items: items.map((item) => {
      const row = history ? historyForQuarantine(item, history) : null;
      return { ...item, accountId: who.mailboxes.get(item.rcpt) ?? null, topSymbols: row ? topSymbols(row.symbols) : null };
    }),
  });
});

// One entry with its letter parsed for the safe text view. A user without administrator rights
// gets 404 for an entry addressed to a mailbox the panel does not have, as if it did not exist.
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
  const { msg, ...entry } = item;
  res.json({ ...entry, accountId: who.mailboxes.get(item.rcpt) ?? null, admin: who.admin, letter: parseQuarantineLetter(msg) });
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

// Release: the node delivers the letter to its mailbox past rspamd and trains rspamd with it as ham.
router.post('/quarantine/:itemId/release', requireAdmin, async (req, res) => {
  const id = itemId(req, res);
  if (id === null) return undefined;
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  const item = await listedItem(res, cfg, id);
  if (!item) return undefined;
  let result;
  try {
    result = await releaseQuarantineItem(cfg, id);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  await journal(req, 'mail_node.quarantine_released', item, { learned: result.learned, ...(result.warnings.length ? { warnings: result.warnings } : {}) });
  res.json({ ok: true, learned: result.learned, warnings: result.warnings });
});

router.delete('/quarantine/:itemId', requireAdmin, async (req, res) => {
  const id = itemId(req, res);
  if (id === null) return undefined;
  const cfg = await nodeConfig(res);
  if (!cfg) return undefined;
  const item = await listedItem(res, cfg, id);
  if (!item) return undefined;
  try {
    await deleteQuarantineItem(cfg, id);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  await journal(req, 'mail_node.quarantine_deleted', item);
  res.json({ ok: true });
});

// "Why is this letter in Spam": rspamd's verdict on a letter of a node mailbox, found in the node's
// recent history (the last HISTORY_ROWS letters rspamd checked, read at most once a minute) by its
// Message-ID, else by recipient, subject and time; with the EOP category the sync stored. Read-only.
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
  });
  const row = found?.row;
  res.json({
    eopCategory: message.eop_category ?? null,
    historyRows: history.length,
    historyDepth: HISTORY_ROWS,
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
