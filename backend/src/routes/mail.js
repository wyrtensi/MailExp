import { STATUS_STALE_MS } from '../services/folderStatus.js';
import { Router } from 'express';
import { ZipArchive } from 'archiver';
import { query } from '../services/db.js';
import { claimForExpunge, finishExpunge, releaseExpungeClaim } from '../services/expungeClaims.js';
import { SENDER_HISTORY_DEFAULT_LIMIT, SENDER_HISTORY_MAX_LIMIT, senderHistory } from '../services/senderHistory.js';
import { conversation } from '../services/conversation.js';
import { shouldBlockImages } from '../utils/imageBlocking.js';
import { threadingDiagnostics } from '../services/threadingDiagnostics.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { isConnectionRefusal, isMailboxBusyError, extractImapError } from '../services/imapManager.js';
import { MAILBOX_BUSY_CODE, mailboxBusyBody, sendMailboxBusy, sendMovePending, movePendingBody, MOVE_PENDING_CODE } from '../utils/mailboxBusy.js';
import { isPendingUid } from '../services/moveQueue.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls, rewriteAnchorHrefs } from '../services/emailSanitizer.js';
import { snippetFromBody, decodeMimeWords, parseRawHeaders, parseMailboxList, buildHeadersFromMessage } from '../services/messageParser.js';
import { resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, resolveArchiveFolder, isAllMailFolder, resolveSpamFolder, resolveAllSpamPaths, getDeleteStrategy, adjustFolderCounts, fanOutReadToSiblings, fanOutStarToSiblings, fanOutBulkReadToSiblings } from '../utils/mailUtils.js';
import { pluginRegistry } from '../plugins/registry.js';
import { recordAudit } from '../services/auditLog.js';
import { listMessages } from '../services/messageService.js';
import { recordSyncSignal } from '../services/diagnosticsRing.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';
import { validateHost } from '../services/hostValidation.js';
import { safeFetch } from '../services/safeFetch.js';
import { deliveryStateColumn } from '../services/deliveryStatus.js';
import { safeFilename, attachmentDisposition, truncateFilename } from '../utils/contentDisposition.js';

const router = Router();
router.use(requireAuth);

// Whether an account-scoped plugin that maintains label sibling rows (currently GTD) is active for
// this account — the modern replacement for the former email_accounts.gtd_enabled gate on the
// read/star sibling fan-out. Core stays plugin-agnostic: it asks the registry, never GTD directly.
// Folds plugin activation in (strictly safer than the old raw column — a deactivated plugin no
// longer triggers fan-out). The fan-out itself is still additionally gated on the message actually
// having siblings, so a non-plugin account stays byte-identical to pre-GTD.
const accountMaintainsLabelSiblings = (accountId) =>
  pluginRegistry.hasActiveAsync('inboxIngest', { account: { id: accountId } });

// Validate a folder name / path component: no control chars, max 255 chars.
function isValidFolderName(name) {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function areValidUUIDs(ids) {
  return ids.every(id => typeof id === 'string' && UUID_RE.test(id));
}

// Process IMAP operations in bounded batches so a 500-message bulk action does not spawn
// hundreds of parallel temporary IMAP connections (#434, bulk-star).
async function runInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Strip NUL bytes from strings before DB writes. PostgreSQL UTF-8 text columns
// reject 0x00, and malformed MIME bodies can contain embedded NUL characters.
function sanitizeDbText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\0/g, '');
}

// Returns true if a snippet contains content that should never appear in plain-text
// preview, indicating it was generated from unclean HTML and needs regeneration:
//   - &entity; — undecoded HTML entities from before the entity-stripping fix
//   - ##marker## — unexpanded template placeholders (UPS, Epsilon marketing mail)
//   - --> — dangling HTML comment end leaked by comment-stripping gap
function snippetIsGarbled(s) {
  return s && (
    /&[a-z][a-z0-9]*;/i.test(s) ||   // undecoded HTML entity
    /##[^#]*##/.test(s) ||             // unexpanded template placeholder
    /-->/.test(s) ||                   // dangling HTML comment fragment
    /\{[^}]*[:;][^}]*\}/.test(s) ||   // stored CSS rule block
    /<[a-z][^>]*>/i.test(s) ||         // raw HTML tag
    /<\/[a-z][a-z0-9:-]*\s*>/i.test(s) || // stray closing HTML tag
    /([=_*#~-])\1{3,}/.test(s) ||      // decorative divider run
    /\[[^\]]+\]\(https?:\/\//.test(s)  // Markdown link syntax from ESP text/plain generators
  );
}

// Fire-and-forget notification to label plugins after an ordinary mail mutation. Groups the
// acted rows by account and dispatches the generic `onMailMutation` hook per account; a label
// plugin (GTD) decides whether the mutation touched one of its labelled threads and broadcasts
// its own refresh — either a live sibling post-mutation, or one of the acted rows sitting
// in a label folder pre-mutation (covers removing the last label copy of a thread, which leaves
// no post-mutation sibling to find). Rows are the pre-mutation message rows so their message_id
// and folder are captured before a move/delete can drop them; the hook swallows per-plugin
// errors, so a completed mutation is never turned into a 500.
// Journal entries for messages a user deleted. Rows are the pre-delete message rows; only the
// Message-ID, folder and sender are recorded, never the subject or body.
function deletedMessageEntries(userId, rows, permanent) {
  return rows.map((m) => ({
    actorUserId: userId,
    accountId: m.account_id,
    action: 'message.deleted',
    details: { messageId: m.message_id ?? null, folder: m.folder, from: m.from_email ?? null, permanent },
  }));
}

function notifyMailMutation(rows) {
  for (const accountId of new Set(rows.map(m => m.account_id).filter(Boolean))) {
    imapManager.scheduleCountRefresh?.(accountId);
  }
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    pluginRegistry.runHook('onMailMutation', {
      imapManager: imapManager.pluginFacade, accountId, messageIds: [...mids], actedFolders: [...folders],
    }).catch(err => console.warn('onMailMutation hook failed:', err.message));
  }
}

// Get messages (unified or per-account/folder)
router.get('/messages', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category } = req.query;

  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });

  // Validate category param — only allow known values to prevent SQL injection via the
  // WHERE clause in listMessages (even though it uses parameterised queries, belt-and-suspenders).
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  const safeCategory = VALID_CATEGORIES.has(category) ? category : undefined;

  const { messages, total, threaded: isThreaded, resolvedAccountId } = await listMessages({
    accountId,
    folder,
    limit,
    offset,
    unreadOnly,
    threaded,
    category: safeCategory,
  });

  if (resolvedAccountId && messages.length) {
    imapManager.prefetchFolderBodies(resolvedAccountId, messages.map(r => r.id))
      .catch(err => console.warn('Folder body prefetch error:', err.message));
  }

  // Phase 1 reliability instrumentation: count "ghost" rows served — a UID is known but
  // its envelope hasn't been fetched, so the row renders as Unknown / (no subject). This is
  // the visible #407 symptom; measuring it turns "sometimes there are ghost rows" into a rate.
  if (resolvedAccountId && messages.length) {
    const ghosts = messages.filter(m =>
      !m.message_id && (!m.subject || m.subject === '(no subject)') && !m.snippet).length;
    if (ghosts > 0) recordSyncSignal('ghost_rows_served', { accountId: resolvedAccountId, magnitude: ghosts });
  }

  res.json({ messages, total, ...(isThreaded ? { threaded: true } : {}) });
});

router.get('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const result = await query(`
      SELECT m.id, m.uid, m.folder, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses, m.eop_category,
             ${deliveryStateColumn('m')} AS delivery_state,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.id = $1
        AND m.is_deleted = false
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /messages/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load message' });
  }
});

// Resolve a message by a DURABLE reference, for deep links (#270). The row's UUID PK is
// regenerated when an email is moved/resynced (rows are purged + re-inserted), so a deep
// link keyed on the UUID dies once the email changes folder. We instead match the stable
// RFC Message-ID header first, then fall back to the UUID for legacy links and push
// notifications (which still embed the UUID and are short-lived anyway). Columns and the
// is_deleted filter mirror GET /messages/:id. Distinct path so it never
// collides with the greedy /messages/:id route.
router.get('/resolve-message', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return res.status(400).json({ error: 'Missing ref' });
  const rawAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (rawAccountId && !UUID_RE.test(rawAccountId)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  const accountId = rawAccountId || null;
  const COLS = `m.id, m.uid, m.folder, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses, m.eop_category,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color`;
  try {
    // Durable match on the stable Message-ID header. When the same email exists in more
    // than one folder (e.g. INBOX + Archive), prefer the INBOX copy, then the most recent.
    // account_id, id make the pick deterministic: one email delivered to two mailboxes has an
    // INBOX copy in each with the same Date, and a link without a mailbox (older links carry
    // none) must not open, and mark read, a different mailbox's copy from one click to the next.
    let result = await query(`
      SELECT ${COLS}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.message_id = $1
        AND m.is_deleted = false
        AND ($2::uuid IS NULL OR m.account_id = $2)
      ORDER BY (m.folder = 'INBOX') DESC, m.date DESC NULLS LAST, m.account_id, m.id
      LIMIT 1
    `, [ref, accountId]);
    // Legacy links / push notifications carry the UUID primary key.
    if (result.rows.length === 0 && UUID_RE.test(ref)) {
      result = await query(`
        SELECT ${COLS}
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.id = $1
          AND m.is_deleted = false
          AND ($2::uuid IS NULL OR m.account_id = $2)
      `, [ref, accountId]);
    }
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /resolve-message error:', err.message);
    res.status(500).json({ error: 'Failed to resolve message' });
  }
});

// Get all messages belonging to a thread (for threaded view expansion)
router.get('/thread/:threadId', async (req, res) => {
  const { threadId } = req.params;
  if (!threadId) return res.status(400).json({ error: 'threadId required' });
  // The same conversation sent to two mailboxes has one thread key in both. A thread opened in
  // one mailbox names it, so reading, moving or deleting that thread never reaches the other.
  const scopedAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
  if (scopedAccountId !== null && !UUID_RE.test(scopedAccountId)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }

  try {
    const accountsResult = await query(
      'SELECT id, include_in_unified_inbox, folder_mappings FROM email_accounts WHERE enabled = true'
    );
    const accountIds = scopedAccountId !== null
      ? accountsResult.rows.filter(row => row.id === scopedAccountId).map(row => row.id)
      : req.query.unified === 'true'
        ? resolveAccountScope(accountsResult.rows).accountIds
        : accountsResult.rows.map(row => row.id);
    if (!accountIds.length) return res.json({ messages: [] });

    // Show all non-deleted messages in the thread regardless of folder. This includes
    // Sent replies (which have distinct message_ids) alongside received messages.
    // DISTINCT ON deduplicates the same message appearing in multiple folders (e.g. Gmail's
    // All Mail), preferring the INBOX copy.
    //
    // The key is scoped to the account. One email delivered to two mailboxes is two separate
    // mailbox items sharing a Message-ID. Every thread row names its mailbox, so a scoped call
    // holds one account anyway; a call without accountId spans several, and a bare message_id
    // key there silently dropped one mailbox's copy. Same-account duplicates (All Mail, the Sent
    // twin) still collapse.
    //
    // A row without a Message-ID keys on its own id, as in services/conversation.js: DISTINCT ON
    // treats NULLs as equal, so a bare message_id key collapsed every such letter of the thread
    // into one, and a thread-wide action built from this list left the others behind.
    const result = await query(`
      WITH deduped AS (
        SELECT DISTINCT ON (m.account_id, COALESCE(m.message_id, m.id::text))
               m.id, m.uid, m.folder, m.message_id, m.thread_id, m.subject,
               m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
               m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses, m.eop_category,
               ${deliveryStateColumn('m', 'a')} AS delivery_state,
               a.name AS account_name, a.email_address AS account_email, a.color AS account_color
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.is_deleted = false
          AND m.account_id = ANY($1)
          AND m.thread_key = $2
        ORDER BY m.account_id,
                 COALESCE(m.message_id, m.id::text),
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      )
      -- account_id, id break the tie: two mailboxes' copies of one email carry the same Date,
      -- so date alone would order them arbitrarily between requests.
      SELECT * FROM deduped ORDER BY date ASC, account_id, id
    `, [accountIds, threadId]);

    // Mark the rows that live in a Drafts folder. A thread-wide delete sends every id it is
    // given to bulk-delete, which expunges a draft instead of moving it to Trash, so an unsent
    // reply written in Gmail's web client would be destroyed as collateral of deleting the
    // conversation around it. The client drops these rows from thread-wide actions; the flag is
    // resolved here, with resolveAllDraftsPaths, so it cannot disagree with the delete route.
    const draftsPaths = new Map();
    for (const row of result.rows) {
      if (draftsPaths.has(row.account_id)) continue;
      const mappings = accountsResult.rows.find(a => a.id === row.account_id)?.folder_mappings;
      draftsPaths.set(row.account_id, await resolveAllDraftsPaths(row.account_id, mappings));
    }
    const messages = result.rows.map(row => ({
      ...row,
      is_draft: draftsPaths.get(row.account_id).has(row.folder),
    }));

    res.json({ messages });
  } catch (err) {
    console.error('Thread fetch error:', err);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// Counts are snapshots independently measured on the IMAP server, never cache tallies.
router.get('/unread-counts', async (req, res) => {
  const result = await query(`SELECT a.id AS account_id, a.include_in_unified_inbox,
      f.server_unread_count AS count, f.server_total_count, f.server_counts_at, f.server_count_revision, f.status_attempt_revision, f.status_error
    FROM email_accounts a LEFT JOIN folders f ON f.account_id=a.id AND f.path='INBOX'
    WHERE a.enabled`);
  const byAccount = {}, snapshots = {};
  let total = 0, complete = true;
  for (const row of result.rows) {
    const known = row.count != null && row.server_counts_at != null;
    const count = known ? Number(row.count) : null;
    byAccount[row.account_id] = count;
    const stale = !known || !!row.status_error || Date.now() - new Date(row.server_counts_at).getTime() > STATUS_STALE_MS;
    snapshots[row.account_id] = { totalCount: known && row.server_total_count != null ? Number(row.server_total_count) : null, revision: row.server_count_revision || '0', attemptRevision: row.status_attempt_revision || row.server_count_revision || '0', observedAt: row.server_counts_at || null, stale, known };
    if (row.include_in_unified_inbox !== false) {
      if (known) total += count;
      if (stale) complete = false;
    }
  }
  res.set('Cache-Control', 'no-store');
  res.json({ total, byAccount, snapshots, complete });
});

// Hard cap on a live IMAP body fetch. Connection acquisition is already bounded at 30s
// inside imapManager, but the FETCH itself is not — on a half-open/stalled connection
// (e.g. an account mid-reconnect, as happens on large flaky mailboxes) it can hang
// indefinitely, and with no response the client's body spinner spins forever. 40s sits
// above the 30s connect bound so a legitimately slow connect still completes.
const BODY_FETCH_TIMEOUT_MS = 40000;

// Reject with a tagged error if `promise` doesn't settle within `ms`. The underlying
// fetch keeps running and releases its pooled client via withFreshClient's own cleanup;
// we just stop making the HTTP request wait on it. clearTimeout avoids keeping the
// event loop alive after the race settles.
function fetchWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('BODY_FETCH_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Get full message body + attachments list
// The earlier correspondence of this letter's mailbox with the same person (services/senderHistory.js).
router.get('/messages/:id/sender-history', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  const limit = req.query.limit === undefined
    ? SENDER_HISTORY_DEFAULT_LIMIT
    : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SENDER_HISTORY_MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be a whole number from 1 to ${SENDER_HISTORY_MAX_LIMIT}` });
  }
  const history = await senderHistory(id, { limit });
  if (!history) return res.status(404).json({ error: 'Message not found' });
  res.json(history);
});

// Every letter of this letter's conversation in its mailbox, oldest first (services/conversation.js).
router.get('/messages/:id/conversation', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const result = await conversation(id);
    if (!result) return res.status(404).json({ error: 'Message not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /messages/:id/conversation error:', err.message);
    res.status(500).json({ error: 'Failed to load the conversation' });
  }
});

// Why this letter is in its conversation (services/threadingDiagnostics.js): headers, the
// Gmail thread number, the reason and the mailbox's threading mode.
router.get('/messages/:id/threading', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  const diagnostics = await threadingDiagnostics(id);
  if (!diagnostics) return res.status(404).json({ error: 'Message not found' });
  res.json(diagnostics);
});

// A full IMAP pool (imapManager's poolExhausted) is our own connection budget, not a broken
// server: every pooled connection of the mailbox is busy and the request waited its turn out.
// A login held back (providerRefusing) is the same shape: nothing was sent. Both are
// isMailboxBusyError and answer 503 with a stable code (utils/mailboxBusy.js): mailbox_busy, or
// mailbox_auth_rejected when the hold is a rejected password, which retrying will not fix.
export { MAILBOX_BUSY_CODE };

// The bulk routes run one IMAP call per (account, source folder) group. A busy pool fails only
// the group it hit: groups the server already applied must still be committed (DB rows, folder
// counts, audit), or the UI restores mail that is gone on the server and a retry fails on UIDs
// that no longer exist. So the routes answer 503 mailbox_busy only when NO group succeeded, and
// otherwise their usual partial-success shape (the ids that went through) plus busy: true.
// Once an account is busy its remaining groups are skipped: each would wait out the same pool.
//
// One code speaks for every busy mailbox of the request, so mailbox_auth_rejected is used only
// when each of them was held back by a rejected password. Mixed with a mailbox that was merely
// busy, the answer is mailbox_busy: retrying helps that one, and the rejected one shows its own
// error on the account and answers mailbox_auth_rejected on the retry.
function bulkBusyTracker() {
  const busyAccounts = new Map(); // accountId -> held back by a rejected password
  const reason = () => ({ authRejected: busyAccounts.size > 0 && [...busyAccounts.values()].every(Boolean) });
  return {
    skip: accountId => busyAccounts.has(accountId),
    // fn's result, or null when the pool was busy for this group.
    async run(accountId, fn) {
      try {
        return await fn();
      } catch (err) {
        if (!isMailboxBusyError(err)) throw err;
        busyAccounts.set(accountId, !!err.authRejected);
        return null;
      }
    },
    get busy() { return busyAccounts.size > 0; },
    // What sendMailboxBusy needs to pick the code when no group went through.
    get reason() { return reason(); },
    // Spread into a partial-success response.
    flag() { return busyAccounts.size ? { busy: true, code: mailboxBusyBody(reason()).code } : {}; },
  };
}

// DB-first moves (services/moveQueue.js): user moves, archive, delete to Trash and spam/not-spam.
// The rows move in the database now, the server MOVE is queued and runs in the background, so a
// busy mailbox never fails a move and never answers mailbox_busy. `rows` are message rows of ONE
// account as the route read them (folder and is_read before the move); folder counts follow here.
// allMail: the destination is Gmail's All Mail, which is not synced: its counts are not kept and
// the row goes once the server has moved the letter. Returns the rows that moved (a row already in
// `dest` counts).
async function queueMove(accountId, rows, dest, { allMail = false, movedBy = null } = {}) {
  const results = await imapManager.moveQueue.enqueue(accountId, rows, dest, { dropRow: allMail, movedBy });
  const movedIds = new Set(results.map(r => r.id));
  const moved = rows.filter(m => movedIds.has(m.id));
  // Counted from the folder and read state the move saw under its lock, not from the route's own
  // read: another request may have moved the row in between. Gmail's All Mail keeps no counts.
  const counted = results.filter(r => r.from !== dest);
  const untracked = new Set(allMail ? [dest] : []);
  const froms = [...new Set(counted.map(r => r.from))];
  if (froms.length) {
    const { rows: virtual } = await query(
      `SELECT path FROM folders WHERE account_id = $1 AND path = ANY($2::text[]) AND special_use = '\\All'`,
      [accountId, froms]
    );
    for (const { path } of virtual) untracked.add(path);
  }
  const deltas = new Map();
  const add = (path, total, unread) => {
    if (untracked.has(path)) return;
    const d = deltas.get(path) || { total: 0, unread: 0 };
    d.total += total;
    d.unread += unread;
    deltas.set(path, d);
  };
  for (const r of counted) {
    const unread = r.isRead ? 0 : 1;
    add(r.from, -1, -unread);
    add(dest, 1, unread);
  }
  for (const [path, { total, unread }] of deltas) adjustFolderCounts(accountId, path, total, unread);
  return moved;
}

router.get('/messages/:id/body', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  // Remote images follow the preferences of whoever opens the message.
  const result = await query(`
    SELECT m.*, u.preferences FROM messages m
    LEFT JOIN users u ON u.id = $2
    WHERE m.id = $1
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Return cached body if available — but re-fetch when the cached HTML still
  // contains unresolved cid: references, or http:// image URLs that were cached
  // before the http→https upgrade was added (would be blocked as mixed content).
  const hasCidRefs  = message.body_html && /\bcid:/i.test(message.body_html);
  const hasHttpImgs = message.body_html && (
    // <img src="http://"> cached before the http→https upgrade
    /<img[^>]+src=["']http:\/\//i.test(message.body_html) ||
    // background="http://" on table/td/tr elements (marketing email table layouts)
    /background=["']http:\/\//i.test(message.body_html) ||
    // CSS url(http://) in inline style attributes or <style> blocks
    /url\(\s*['"]?http:\/\//i.test(message.body_html)
  );
  // Calendar-only invites cached before they were rendered as a card (#423) hold
  // raw VCALENDAR text and no HTML. Re-fetch them once; the fetch stores the card.
  // Requiring a VEVENT keeps calendar data the renderer cannot parse from being
  // re-fetched on every open.
  const hasRawInvite = !message.body_html && typeof message.body_text === 'string'
    && /^\s*BEGIN:VCALENDAR/i.test(message.body_text) && /^BEGIN:VEVENT/im.test(message.body_text);
  if ((message.body_html || message.body_text) && !hasCidRefs && !hasHttpImgs && !hasRawInvite) {
    const attachments = message.attachments
      ? (typeof message.attachments === 'string' ? JSON.parse(message.attachments) : message.attachments)
      : [];
    // Apply head-stripping to already-cached HTML so emails stored before this
    // fix was deployed are cleaned up immediately on first view.
    let html = message.body_html ? stripEmailHead(message.body_html) : null;
    if (html !== message.body_html) {
      // Update cache so subsequent views don't need to re-strip
      query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
    }
    // Rewrite eBay imageser URLs to direct image URLs for emails cached before this fix.
    // imageser requires eBay session cookies (never sent cross-site) and returns 1 byte
    // without them; the real image is always in the `imageUrl` query parameter.
    if (html && html.includes('svcs.ebay.com/imageser')) {
      const rewritten = rewriteEbayImageserUrls(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Normalise bare-domain hrefs (e.g. href="benchmade.com") cached before href
    // normalisation was added to sanitizeEmail().  Without this, clicking such links
    // in the sandboxed iframe resolves them against the mailexpert origin and opens a
    // new mailexpert tab instead of the sender's website.
    if (html && /<a\b[^>]*\shref=["'](?!https?:\/\/|mailto:|cid:|tel:|\/\/|[#/.])/i.test(html)) {
      const rewritten = rewriteAnchorHrefs(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Backfill snippet when absent, or regenerate if garbled (undecoded HTML entities
    // from before the entity-stripping fix — e.g. "&zwnj;" in preview text).
    if (!message.snippet || snippetIsGarbled(message.snippet)) {
      const snip = snippetFromBody(message.body_text, html);
      if (snip) {
        query('UPDATE messages SET snippet = $1 WHERE id = $2', [sanitizeDbText(snip), id]).catch(() => {});
      }
    }

    // Apply remote-image blocking at response time — never write the blocked variant
    // back to the DB so the canonical cached HTML always has images intact.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = html;
    let hasBlockedRemoteImages = false;
    if (!skipBlocking && html && shouldBlockImages(message.preferences, message) && hasRemoteImages(html)) {
      responseHtml = blockRemoteImages(html);
      hasBlockedRemoteImages = true;
    }
    return res.json({ html: responseHtml, text: message.body_text, attachments, hasBlockedRemoteImages, senderEmail: message.sender_email, senderName: message.sender_name, eopCategory: message.eop_category ?? null });
  }

  // Fetch from IMAP — signal user activity so background jobs back off during this request.
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);

    // A letter whose move is pending is read at its source until the MOVE (moveQueue.js).
    const loc = await imapManager.moveQueue.serverLocation(message, account);
    if (!loc) return sendMovePending(res);
    const { html, text, attachments } = await fetchWithTimeout(
      imapManager.fetchMessageBody(account, loc.uid, loc.folder),
      BODY_FETCH_TIMEOUT_MS
    );

    const safeHtml = html ? sanitizeDbText(sanitizeEmail(html)) : null;
    const safeText = sanitizeDbText(text);
    const snip = sanitizeDbText(snippetFromBody(safeText, safeHtml || html));

    // Only cache when we actually got body content — don't overwrite a prior
    // successful cache with null if a transient IMAP fetch returns nothing.
    if (safeHtml || text || (attachments && attachments.length > 0)) {
      await query(
        `UPDATE messages
         SET body_html = $1, body_text = $2, attachments = $3,
             snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
         WHERE id = $4`,
        [safeHtml, safeText, JSON.stringify(attachments || []), id, snip]
      );
    }

    // Apply remote-image blocking at response time — safeHtml (unblocked) is what
    // was written to the DB cache above, preserving the canonical body.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = safeHtml;
    let hasBlockedRemoteImages = false;
    if (!skipBlocking && safeHtml && shouldBlockImages(message.preferences, message) && hasRemoteImages(safeHtml)) {
      responseHtml = blockRemoteImages(safeHtml);
      hasBlockedRemoteImages = true;
    }
    res.json({ html: responseHtml, text: safeText, attachments: attachments || [], hasBlockedRemoteImages, senderEmail: message.sender_email, senderName: message.sender_name, eopCategory: message.eop_category ?? null });
  } catch (err) {
    const msg = err.message || 'Unknown error';
    console.error('Body fetch error:', msg);
    // Detect Gmail/IMAP throttling and surface a helpful message
    const isThrottle = /THROTTL/i.test(msg);
    if (isThrottle) {
      return res.status(503).json({
        error: 'The mail server is temporarily throttling access. Please wait a few minutes and try again.',
        throttled: true,
      });
    }
    if (msg === 'BODY_FETCH_TIMEOUT') {
      return res.status(504).json({
        error: 'This message is taking too long to load — the mail server may be temporarily unreachable. Please try again.',
        timeout: true,
      });
    }
    // Our own pool budget (poolExhausted), a backoff holding new logins back (providerRefusing),
    // or a server refusing one outright: none is a broken message, and each is worth retrying
    // shortly, so the same 503 busy answer the UI already explains instead of a raw 500.
    if (isMailboxBusyError(err) || isConnectionRefusal(msg)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: msg });
  }
});

// Get full raw headers
router.get('/messages/:id/headers', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.* FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    let headers = '';
    try {
      // A letter whose MOVE is in flight has no location for a moment: the headers are then
      // rebuilt from the row below.
      const loc = await imapManager.moveQueue.serverLocation(message, account);
      if (loc) headers = await imapManager.fetchHeaders(account, loc.uid, loc.folder);
    } catch (fetchErr) {
      console.warn('Headers IMAP fetch failed:', fetchErr.message);
    }

    if (!headers?.trim()) {
      headers = buildHeadersFromMessage(message);
    }

    // This exists only to REPAIR a subject we never stored, so it is gated on the stored one
    // being missing. It used to re-derive the subject every time and hand it back
    // unconditionally; MessageHeaderModal pushes that value up through onSubjectResolved, so
    // any flaw in header decoding silently rewrote the list and the open message with a worse
    // value than the one already on screen. That is how #454 became visible. Never replacing
    // a subject we already have keeps a decoding bug contained to this modal.
    let resolvedSubject = message.subject;
    const storedSubjectMissing = !message.subject || message.subject === '(no subject)';
    if (storedSubjectMissing && headers?.trim()) {
      const parsed = parseRawHeaders(headers);
      const imapSubject = decodeMimeWords(parsed.subject || '').trim();
      if (imapSubject && imapSubject !== '(no subject)') {
        resolvedSubject = imapSubject;
        await query('UPDATE messages SET subject = $1 WHERE id = $2', [imapSubject, id]);
      }
    }

    res.json({ headers, subject: resolvedSubject });
  } catch (err) {
    console.error('Headers fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message headers' });
  }
});

// Bcc recipients of a draft, for reopening it in the composer. A draft's Bcc exists only in its
// own headers, and saving a reopened draft expunges that copy, so failing to read it has to be an
// error, never an empty list — an empty list is exactly what erased it before (upstream #499).
// bcc_addresses (0058) is NOT NULL DEFAULT '[]', so an empty stored array does not prove the
// draft has no Bcc: any row no writer ever set it on (a draft first seen by sync, saved before
// 0058, or saved by another client) got the same '[]' by default. Only a NON-EMPTY stored array
// is trusted; anything else is read from the server copy instead, which needs no NULL-vs-'[]'
// distinction — a draft this app really did save without a Bcc simply has no Bcc header there,
// so the read still answers [].
router.get('/messages/:id/bcc', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const unreadable = "Could not read this draft's Bcc recipients from the mail server.";
  try {
    // Mailboxes are shared install-wide (migration 0056 dropped their owner column), like every
    // other per-message route in this file — no per-user ownership check here.
    const result = await query(`
      SELECT m.account_id, m.uid, m.folder, m.message_id, m.bcc_addresses FROM messages m
      WHERE m.id = $1
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    const message = result.rows[0];
    const known = typeof message.bcc_addresses === 'string' ? JSON.parse(message.bcc_addresses) : message.bcc_addresses;
    if (Array.isArray(known) && known.length) return res.json({ bcc: known });

    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);

    // A letter whose MOVE is in flight has no location for a moment (moveQueue.js).
    const loc = await imapManager.moveQueue.serverLocation(message, account);
    if (!loc) return sendMovePending(res);

    const headers = parseRawHeaders(await fetchWithTimeout(
      imapManager.fetchHeaders(account, loc.uid, loc.folder),
      BODY_FETCH_TIMEOUT_MS
    ));
    if (!Object.keys(headers).length) {
      console.warn(`Draft Bcc: no headers for uid ${loc.uid} in ${loc.folder}`);
      return res.status(502).json({ error: unreadable });
    }
    // Stops a uid that now holds some other message from handing back that message's Bcc.
    const norm = v => String(v || '').replace(/[<>\s]/g, '').toLowerCase();
    if (message.message_id && norm(message.message_id) !== norm(headers['message-id'])) {
      console.warn(`Draft Bcc: uid ${loc.uid} in ${loc.folder} holds ${headers['message-id'] || 'no Message-ID'}, not ${message.message_id}`);
      return res.status(409).json({ error: 'This draft changed on the mail server. Refresh the folder and try again.' });
    }
    res.json({ bcc: (headers.bcc || '').split('\n').flatMap(line => parseMailboxList(line)) });
  } catch (err) {
    console.warn('Draft Bcc fetch failed:', err.message);
    res.status(502).json({ error: unreadable });
  }
});

const ZIP_MAX_FILES = 100;
const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const ZIP_MAX_FILE_BYTES  =  50 * 1024 * 1024; //  50 MB per file

// Download all attachments as a ZIP archive
router.get('/messages/:id/attachments.zip', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.* FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);

  if (attachments.length === 0) return res.status(404).json({ error: 'No attachments' });
  if (attachments.length > ZIP_MAX_FILES) return res.status(400).json({ error: `Too many attachments (max ${ZIP_MAX_FILES})` });

  const knownTotal = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  if (knownTotal > ZIP_MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: 'Total attachment size exceeds the 150 MB ZIP limit.' });
  }

  // Exclude per-file oversize items; unknown-size (0) are allowed through.
  const eligible = attachments.filter(a => !a.size || a.size <= ZIP_MAX_FILE_BYTES);
  if (eligible.length === 0) return res.status(413).json({ error: 'All attachments exceed the 50 MB per-file limit.' });

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const account = accountResult.rows[0];

    const loc = await imapManager.moveQueue.serverLocation(message, account);
    if (!loc) return sendMovePending(res);
    const bufferMap = await imapManager.fetchMultipleAttachments(account, loc.uid, loc.folder, eligible);
    if (bufferMap.size === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    // Deduplicate filenames: invoice.pdf → invoice (2).pdf
    const usedNames = new Set();
    const entries = [];
    for (const att of eligible) {
      const buf = bufferMap.get(att.part);
      if (!buf) continue;
      // Archiver strips leading word/drive prefixes ending in a colon.
      const originalName = safeFilename(att.filename).replace(/:/g, '_');
      let name = originalName;
      const dot = originalName.lastIndexOf('.');
      let n = 2;
      while (usedNames.has(name)) {
        name = dot > 0 ? `${originalName.slice(0, dot)} (${n})${originalName.slice(dot)}` : `${originalName} (${n})`;
        n++;
      }
      usedNames.add(name);
      entries.push({ name, buf });
    }

    if (entries.length === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    const zipName = truncateFilename(message.subject || 'attachments', 100) + '-attachments.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(zipName));

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', err => {
      console.error('ZIP archive error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP' });
    });
    archive.pipe(res);
    for (const { name, buf } of entries) {
      archive.append(buf, { name });
    }
    archive.finalize();
  } catch (err) {
    console.error('ZIP fetch error:', err);
    if (res.headersSent) return;
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to create ZIP' });
  }
});

// Download attachment
router.get('/messages/:id/attachments/:part', async (req, res) => {
  const { id, part } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  let partNum;
  try {
    partNum = decodeURIComponent(part);
  } catch {
    return res.status(400).json({ error: 'Invalid attachment part identifier' });
  }

  const result = await query(`
    SELECT m.* FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Find attachment metadata
  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);
  const att = attachments.find(a => a.part === partNum);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });

  // Reject oversized attachments before opening an IMAP connection.
  // att.size comes from the IMAP BODYSTRUCTURE response and is generally accurate.
  // A size of 0 means unknown — allow the fetch to proceed in that case.
  const ATTACHMENT_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
  if (att.size > ATTACHMENT_SIZE_LIMIT) {
    return res.status(413).json({ error: 'Attachment exceeds the 50 MB download limit.' });
  }

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const loc = await imapManager.moveQueue.serverLocation(message, accountResult.rows[0]);
    if (!loc) return sendMovePending(res);
    const buffer = await imapManager.fetchAttachment(accountResult.rows[0], loc.uid, loc.folder, partNum);

    if (!buffer) return res.status(404).json({ error: 'Could not fetch attachment' });

    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', attachmentDisposition(att.filename));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// Download the full message as an .eml file (#381). The raw RFC 822 source, exactly as the
// server stores it, so attachments and original headers survive the round trip into any
// other mail client. Mailboxes are shared install-wide (migration 0056 dropped their owner
// column), same as every other message read here — no per-user ownership filter. Resolved
// through moveQueue.serverLocation like every other IMAP read here — the DB row's own uid
// can be a pending-move placeholder that doesn't exist on the server yet (see
// moveQueue.js's header comment).
router.get('/messages/:id/raw.eml', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query('SELECT m.* FROM messages m WHERE m.id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const loc = await imapManager.moveQueue.serverLocation(message, accountResult.rows[0]);
    if (!loc) return sendMovePending(res);

    // Reject an oversized message before buffering its raw source, the same way the
    // attachment route rejects an oversized attachment before buffering it. A message's raw
    // source is the sum of all its parts, so it can exceed the attachment cap even when every
    // individual attachment is under it. There is no cached size column for a message (unlike
    // an attachment's BODYSTRUCTURE-derived size), so this is a cheap live RFC822.SIZE fetch
    // first. size === null means the server didn't answer — proceed rather than block a
    // legitimate download on a quirky server.
    const RAW_MESSAGE_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB, same cap as attachments
    const size = await imapManager.fetchMessageSize(accountResult.rows[0], loc.uid, loc.folder);
    if (size != null && size > RAW_MESSAGE_SIZE_LIMIT) {
      // Stable code so the frontend can show its own localized message instead of
      // string-matching the English text (same convention as mailbox_busy/move_pending).
      return res.status(413).json({ error: 'Message exceeds the 50 MB download limit.', code: 'message_too_large' });
    }

    const buffer = await imapManager.fetchRawMessage(accountResult.rows[0], loc.uid, loc.folder);
    if (!buffer) return res.status(404).json({ error: 'Could not fetch message source' });

    // truncateFilename cuts by UTF-16 unit but never splits a surrogate pair: a plain .slice()
    // could leave a lone surrogate from a subject whose 80th unit lands inside an emoji, and
    // encodeURIComponent in attachmentDisposition's rfc5987() throws on one
    // (URIError: malformed URI sequence), 500ing the whole download. Same helper as the
    // attachments ZIP name and safeFilename's 255 cap — one way to truncate a filename.
    const name = `${truncateFilename(message.subject || 'message', 80)}.eml`;
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', attachmentDisposition(name));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Raw message fetch error:', err);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to fetch message source' });
  }
});

// Where to store a read/star change now: the letter's own folder and uid, or null when its move
// has not reached the server yet. Such a letter has no server uid to store at (its row holds a
// placeholder), so the value goes onto the queued move, which stores it at the destination after
// the MOVE: the flag never lands at the old uid after the move (moveQueue.deferFlags). A move that
// settled meanwhile gives the new location instead.
async function flagTarget(message, flag, value) {
  if (!isPendingUid(message.uid)) return { uid: message.uid, folder: message.folder };
  const { deferred, located } = await imapManager.moveQueue.deferFlags([message], flag, value);
  if (deferred.has(message.id)) return null;
  return located.get(message.id) || null;
}

// Mark read/unread
router.patch('/messages/:id/read', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { read } = req.body;

  const result = await query(`
    SELECT m.*,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Run DB update and account fetch concurrently — no dependency between them.
  // read_changed_at tells the IMAP sync not to overwrite this change for 30 s,
  // preventing a race where a concurrent sync fetch sees the old IMAP flag.
  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = $2', [read, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  // Keep the cached folder unread_count in sync so pagination totals stay accurate.
  if (!!message.is_read !== !!read) {
    adjustFolderCounts(message.account_id, message.folder, 0, read ? -1 : 1);
    // Notify other open clients so a read/unread on one device reflects on the rest in place,
    // without a full folder refetch (the originating device already applied it).
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_read: read }] });
  }

  // GTD: a labeled message owns a sibling row per folder. Fan the read change out to
  // those rows (and their folder unread counts) so label views don't go stale. Gated on
  // gtd_enabled (so a non-GTD account is byte-identical to pre-GTD behaviour) AND on the
  // message actually having siblings — a plain single-folder message keeps the PK-only
  // fast path. The IMAP \Seen flag is written to the acted folder only (below): Gmail
  // propagates \Seen message-wide server-side, and per-copy writes to N folders would
  // multiply round-trips — an asymmetry accepted in the GTD design.
  if (Number(message.sibling_count) > 1 && await accountMaintainsLabelSiblings(message.account_id)) {
    await fanOutReadToSiblings(message.account_id, message.message_id, read);
  }

  try {
    const target = await flagTarget(message, '\\Seen', read);
    if (target) {
      await imapManager.setFlag(accountResult.rows[0], target.uid, target.folder, '\\Seen', read);
      imapManager._resolveFlagPush(message.account_id, id, '\\Seen'); // confirmed — drop any stale queued op
    }
  } catch (err) {
    console.error('IMAP flag update failed:', err.message);
    // Push failed — queue a durable retry so a later flag-sync pull can't silently revert
    // the user's change once the 30s local-wins window lapses.
    imapManager._enqueueFlagPush(message.account_id, id, '\\Seen', read);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows read state).
  notifyMailMutation([message]);

  res.json({ ok: true, is_read: read });
});

// Star/unstar
router.patch('/messages/:id/star', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { starred } = req.body;

  const result = await query(`
    SELECT m.*,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Run DB update and account fetch concurrently — no dependency between them.
  // star_changed_at tells the IMAP sync not to overwrite this change for 30 s.
  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = $2', [starred, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  // GTD: fan the star change out to the message's sibling label rows (see the read
  // handler). Gated on gtd_enabled to keep a non-GTD account byte-identical to pre-GTD.
  // Stars don't affect folder unread counts, so no count adjustment. The IMAP \Flagged
  // write below stays on the acted folder only.
  if (Number(message.sibling_count) > 1 && await accountMaintainsLabelSiblings(message.account_id)) {
    await fanOutStarToSiblings(message.account_id, message.message_id, starred);
  }

  try {
    const target = await flagTarget(message, '\\Flagged', starred);
    if (target) {
      await imapManager.setFlag(accountResult.rows[0], target.uid, target.folder, '\\Flagged', starred);
      imapManager._resolveFlagPush(message.account_id, id, '\\Flagged'); // confirmed — drop any stale queued op
    }
  } catch (err) {
    console.error('IMAP star update failed:', err.message);
    // Push failed — queue a durable retry so a later flag-sync pull can't silently revert it.
    imapManager._enqueueFlagPush(message.account_id, id, '\\Flagged', starred);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows star state).
  notifyMailMutation([message]);
  // Reflect the star change on other open clients in place (no full refetch).
  if (!!message.is_starred !== !!starred) {
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_starred: starred }] });
  }

  res.json({ ok: true, is_starred: starred });
});

// The mailbox a manual sync targets, if it exists. Answers 400/404 itself and returns
// null then.
async function findManualSyncTarget(req, res) {
  const accountId = req.body?.accountId;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required', code: 'account_required' });
    return null;
  }
  if (!UUID_RE.test(accountId)) {
    res.status(400).json({ error: 'Invalid account id' });
    return null;
  }
  const { rows } = await query(
    'SELECT id, enabled, protocol FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return rows[0];
}

const manualSyncable = (account) => account.enabled && account.protocol === 'imap';

// Manual sync (INBOX) of one mailbox. The server services every mailbox, so a request while its
// sync runs or right after one finished starts nothing and says so.
router.post('/sync', async (req, res) => {
  const account = await findManualSyncTarget(req, res);
  if (!account) return;
  const { started } = manualSyncable(account) ? imapManager.requestSync(account.id) : { started: false };
  res.json(started ? { ok: true } : { ok: true, skipped: true });
});

// Manual folder-structure resync of one mailbox ("Sync folders now" in the sidebar account menu
// and on the accounts settings page). Refreshes the folder LIST so folders created or renamed in
// other clients appear without waiting for a reconnect; the folders_synced broadcast tells clients
// when to refetch the folder list.
router.post('/sync-folders', async (req, res) => {
  const account = await findManualSyncTarget(req, res);
  if (!account) return;
  const { started } = manualSyncable(account) ? imapManager.requestFolderSync(account.id) : { started: false };
  res.json(started ? { ok: true } : { ok: true, skipped: true });
});

// On-demand folder sync — called when the user navigates to a folder with no local messages
router.post('/sync-folder', async (req, res) => {
  const { accountId, folder } = req.body;
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });
  if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });

  const check = await query(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Fire-and-forget — response returns immediately, WebSocket sync_complete notifies frontend
  imapManager.syncFolderOnDemand(check.rows[0], folder)
    .catch(err => console.error('syncFolderOnDemand error:', err.message));

  res.json({ ok: true });
});

// Mark all read (DB + IMAP)
router.post('/mark-all-read', async (req, res) => {
  const { accountId, folder = 'INBOX' } = req.body;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });
  const check = await query(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  await query('UPDATE messages SET is_read = true, read_changed_at = NOW() WHERE account_id = $1 AND folder = $2', [accountId, folder]);
  await query('UPDATE folders SET unread_count = 0 WHERE account_id = $1 AND path = $2', [accountId, folder])
    .catch(err => console.error('Folder count update failed:', err.message));
  // Also update IMAP so the change survives the next sync (non-fatal if it fails)
  imapManager.markAllReadImap(check.rows[0], folder).catch(err =>
    console.warn('markAllReadImap failed:', err.message)
  );
  imapManager.scheduleCountRefresh?.(accountId);
  imapManager.broadcast({ type: 'sync_complete', accountId });
  res.json({ ok: true });
});

// Create folder
router.post('/folders', async (req, res) => {
  const { accountId, name, parentPath } = req.body;
  if (!accountId || !name?.trim()) return res.status(400).json({ error: 'accountId and name required' });
  if (!isValidFolderName(name.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (parentPath && !isValidFolderName(parentPath)) return res.status(400).json({ error: 'Invalid parent path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Join parent and leaf with '/' and let ensureFolder translate: it splits on
  // '/' and imapflow joins the segments with the server's real hierarchy
  // delimiter and namespace, so a parent stored in native form (INBOX.Foo)
  // plus a new leaf lands at INBOX.Foo.Bar on a dot-delimited server. The raw
  // mailboxCreate this replaces ignored both, so a folder created through
  // MailExpert could be stored under a path the server never had — and creating
  // a subfolder beneath such a ghost silently vanished on the next
  // folder-structure sync.
  const requested = parentPath ? `${parentPath}/${name.trim()}` : name.trim();

  try {
    const { path } = await imapManager.ensureFolder(check.rows[0], requested, { resolvePath: true });
    // Store the account's delimiter too — rows inserted without one (NULL)
    // poison later delimiter lookups for subfolder creation and rename.
    const delimResult = await query(
      `SELECT delimiter FROM folders
       WHERE account_id = $1 AND delimiter IS NOT NULL AND delimiter <> ''
       LIMIT 1`,
      [accountId]
    );
    await query(
      `INSERT INTO folders (account_id, path, name, delimiter) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, path) DO NOTHING`,
      [accountId, path, name.trim(), delimResult.rows[0]?.delimiter || null]
    );
    res.json({ ok: true, path });
  } catch (err) {
    console.error('Create folder error:', err);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// Delete folder
router.post('/folders/delete', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // A queued move into or out of the folder (or its subfolders) would lose its letter or its
  // destination: the delete waits for them. The hold keeps new ones from starting meanwhile.
  const delim = (await query('SELECT delimiter FROM folders WHERE account_id = $1 AND path = $2', [accountId, path])).rows[0]?.delimiter || '/';
  const release = imapManager.moveQueue.holdFolder(accountId, path, { kind: 'delete', delimiter: delim });
  try {
    if (await movesTouchFolder(accountId, path, delim)) return sendMovePending(res);
    try {
      await imapManager.deleteFolder(check.rows[0], path);
    } catch (err) {
      console.error(`IMAP deleteFolder failed for ${path}:`, err.message);
      if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
      return res.status(500).json({ error: 'Failed to delete folder on server' });
    }
    await query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [accountId, path]);
    await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
    res.json({ ok: true });
  } finally {
    release();
  }
});

// Whether a DB-first move (services/moveQueue.js) goes into or out of `path` or its subtree.
// states: only moves in these states (default: any).
async function movesTouchFolder(accountId, path, delim, states = null) {
  const prefix = delim ? path + delim : null;
  const { rows } = await query(
    `SELECT 1 FROM message_moves
      WHERE account_id = $1
        AND ($4::text[] IS NULL OR state = ANY($4::text[]))
        AND (src_folder = $2 OR dest_folder = $2
             OR ($3::text IS NOT NULL AND (starts_with(src_folder, $3) OR starts_with(dest_folder, $3))))
      LIMIT 1`,
    [accountId, path, prefix, states]
  );
  return rows.length > 0;
}

// Rename folder
router.post('/folders/rename', async (req, res) => {
  const { accountId, oldPath, newName } = req.body;
  if (!accountId || !oldPath || !newName?.trim()) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidFolderName(newName.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (!isValidFolderName(oldPath)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Build the new path by replacing only the last path component
  const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 AND path = $2', [accountId, oldPath]);
  const delim = delimResult.rows[0]?.delimiter || '/';
  const parts = oldPath.split(delim);
  parts[parts.length - 1] = newName.trim();
  const newPath = parts.join(delim);

  // A move whose MOVE is on its way names the old path on the server: the rename waits for it.
  // Queued moves follow the rename (their paths are rewritten below). The hold keeps the worker
  // from starting one of them, and new moves from coming in, meanwhile.
  const release = imapManager.moveQueue.holdFolder(accountId, oldPath, { kind: 'rename', delimiter: delim });
  try {
    if (await movesTouchFolder(accountId, oldPath, delim, ['moving', 'awaiting_uid'])) return sendMovePending(res);
    await imapManager.renameFolder(check.rows[0], oldPath, newPath);
    // IMAP RENAME moves the entire subtree server-side — mirror that in the DB.
    // Updating only the exact path left every child folder (and its messages)
    // under the old path: the next folder sync then upserted the renamed tree
    // from LIST (a visible duplicate), while the per-folder message sync kept
    // trying to open the stale old child paths forever.
    const childPrefix = oldPath + delim;
    // If a sync raced us and already inserted rows at the new paths, drop the
    // stale old rows instead of colliding with the unique (account_id, path) /
    // (account_id, uid, folder) constraints.
    await query(`
      DELETE FROM folders old
      WHERE old.account_id = $1
        AND (old.path = $2 OR substr(old.path, 1, length($3)) = $3)
        AND EXISTS (
          SELECT 1 FROM folders n
          WHERE n.account_id = $1
            AND n.path = $4 || substr(old.path, length($2) + 1)
        )`, [accountId, oldPath, childPrefix, newPath]);
    await query(`
      UPDATE folders SET path = $4 || substr(path, length($2) + 1), updated_at = NOW()
      WHERE account_id = $1
        AND (path = $2 OR substr(path, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    await query(
      'UPDATE folders SET name = $1, updated_at = NOW() WHERE account_id = $2 AND path = $3',
      [newName.trim(), accountId, newPath]
    );
    await query(`
      DELETE FROM messages old
      WHERE old.account_id = $1
        AND (old.folder = $2 OR substr(old.folder, 1, length($3)) = $3)
        AND EXISTS (
          SELECT 1 FROM messages n
          WHERE n.account_id = $1
            AND n.folder = $4 || substr(old.folder, length($2) + 1)
            AND n.uid = old.uid
        )`, [accountId, oldPath, childPrefix, newPath]);
    await query(`
      UPDATE messages SET folder = $4 || substr(folder, length($2) + 1)
      WHERE account_id = $1
        AND (folder = $2 OR substr(folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    // Pending snoozes follow both their parked folder and their wakeup destination.
    await query(`
      UPDATE snoozed_messages SET
        original_folder = CASE WHEN original_folder = $2 OR substr(original_folder, 1, length($3)) = $3
                               THEN $4 || substr(original_folder, length($2) + 1) ELSE original_folder END,
        snoozed_folder = CASE WHEN snoozed_folder = $2 OR substr(snoozed_folder, 1, length($3)) = $3
                              THEN $4 || substr(snoozed_folder, length($2) + 1) ELSE snoozed_folder END
      WHERE account_id = $1
        AND (original_folder = $2 OR substr(original_folder, 1, length($3)) = $3
             OR snoozed_folder = $2 OR substr(snoozed_folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    // Queued moves into or out of the renamed tree follow it; their guards are keyed by path.
    await query(`
      UPDATE message_moves SET
        src_folder = CASE WHEN src_folder = $2 OR substr(src_folder, 1, length($3)) = $3
                          THEN $4 || substr(src_folder, length($2) + 1) ELSE src_folder END,
        dest_folder = CASE WHEN dest_folder = $2 OR substr(dest_folder, 1, length($3)) = $3
                           THEN $4 || substr(dest_folder, length($2) + 1) ELSE dest_folder END,
        updated_at = now()
      WHERE account_id = $1
        AND (src_folder = $2 OR substr(src_folder, 1, length($3)) = $3
             OR dest_folder = $2 OR substr(dest_folder, 1, length($3)) = $3)`,
      [accountId, oldPath, childPrefix, newPath]);
    await imapManager.moveQueue.reguardAccount(accountId);
    res.json({ ok: true, newPath });
  } catch (err) {
    console.error('Rename folder error:', err);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to rename folder' });
  } finally {
    release();
  }
});

// Guards against two overlapping empties of the same (account, folder) — a double-click or a
// second device would otherwise start two background deletes over the same folder.
const emptyInFlight = new Set();

// Empty folder (delete all messages). Emptying a large folder is a slow IMAP operation (chunked
// delete + expunge over the provider), so it runs in the BACKGROUND: the request returns 202
// immediately and the outcome is reported over WebSocket (folder_emptied). This keeps the UI from
// hanging on big folders. On failure the DB rows are left in place so the next sync reconciles.
router.post('/folders/empty', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  const account = check.rows[0];

  const inflightKey = `${accountId}:${path}`;
  if (emptyInFlight.has(inflightKey)) return res.status(409).json({ error: 'This folder is already being emptied' });

  // DB-first moves (services/moveQueue.js). For the whole empty the folder is held: no MOVE into
  // or out of it runs and nothing is moved out of it; a letter moved in meanwhile keeps its
  // placeholder row, which the empty leaves alone, and its MOVE runs afterwards. A move out that
  // is already queued would find its letter expunged: the empty waits for it. The hold comes
  // first, so the worker cannot start such a move after the check.
  const release = imapManager.moveQueue.holdFolder(accountId, path, { kind: 'empty' });
  let started = false;
  try {
    const movesOut = await query(
      'SELECT 1 FROM message_moves WHERE account_id = $1 AND src_folder = $2 LIMIT 1',
      [accountId, path]
    );
    if (movesOut.rows.length) return sendMovePending(res);
    emptyInFlight.add(inflightKey);
    started = true;
  } finally {
    if (!started) release();
  }

  res.status(202).json({ ok: true, started: true });

  (async () => {
    try {
      await imapManager.emptyFolder(account, path);
      // Every row removed here is a message the user deleted for good; journal each one.
      // uid > 0: a placeholder is a letter moved in during the empty; its MOVE runs afterwards.
      const removed = await query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid > 0 RETURNING message_id, from_email',
        [accountId, path],
      );
      recordAudit(deletedMessageEntries(
        req.session.userId,
        (removed.rows ?? []).map((m) => ({ ...m, account_id: accountId, folder: path })),
        true,
      ));
      await query(
        'UPDATE folders SET total_count = 0, unread_count = 0 WHERE account_id = $1 AND path = $2',
        [accountId, path]
      );
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: true });
      imapManager.broadcast({ type: 'sync_complete', accountId });
    } catch (err) {
      console.error(`Async emptyFolder failed for ${path}:`, err.message);
      // The request already answered 202, so a busy mailbox is reported here, with the same code.
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: false, ...(isMailboxBusyError(err) ? { code: mailboxBusyBody(err).code } : {}) });
    } finally {
      emptyInFlight.delete(inflightKey);
      release();
    }
  })();
});

// Bulk mark read/unread
router.post('/messages/bulk-read', async (req, res) => {
  const { ids, read } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }
  if (typeof read !== 'boolean') {
    return res.status(400).json({ error: 'read must be a boolean' });
  }

  try {
    const result = await query(
      `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id, m.message_id FROM messages m
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, updated: [] });

    // Skip messages whose state already matches — avoid spurious DB writes and IMAP round-trips.
    const toUpdate = owned.filter(m => !!m.is_read !== !!read);
    if (!toUpdate.length) return res.json({ ok: true, updated: [] });

    await query(
      'UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = ANY($2::uuid[])',
      [read, toUpdate.map(m => m.id)]
    );

    // Adjust cached unread counts per account+folder.
    const folderDeltas = {};
    for (const msg of toUpdate) {
      const key = `${msg.account_id}:${msg.folder}`;
      if (!folderDeltas[key]) folderDeltas[key] = { accountId: msg.account_id, folder: msg.folder, delta: 0 };
      folderDeltas[key].delta += read ? -1 : 1;
    }
    for (const { accountId, folder, delta } of Object.values(folderDeltas)) {
      adjustFolderCounts(accountId, folder, 0, delta);
    }

    // GTD: fan the read change out to sibling label rows of every updated message that
    // belongs to a gtd_enabled account, adjusting each sibling folder's unread count.
    // Gating on gtd_enabled keeps a non-GTD account byte-identical to pre-GTD (no extra
    // fan-out query); the fan-out itself is also self-limiting for messages without
    // siblings. IMAP \Seen is still written per acted row only (below); Gmail propagates
    // it message-wide server-side.
    // gtdUpdatedIds is scoped to toUpdate (rows whose read-state actually changed), so a
    // message already at the target state never triggers sibling fan-out here — unlike the
    // single-message handler above, which fans out unconditionally regardless of whether the
    // acted message's own state changed. That asymmetry is acceptable: nothing else in this
    // path can push a sibling out of sync with its head, and the label-folder tick already
    // self-heals any divergence on the next read.
    const acctIds = [...new Set(toUpdate.map(m => m.account_id))];
    const gtdAccts = new Set();
    await Promise.all(acctIds.map(async (aid) => {
      if (await accountMaintainsLabelSiblings(aid)) gtdAccts.add(aid);
    }));
    const gtdUpdatedIds = toUpdate.filter(m => gtdAccts.has(m.account_id)).map(m => m.id);
    if (gtdUpdatedIds.length) await fanOutBulkReadToSiblings(gtdUpdatedIds, read);
    // Reflect the bulk read/unread change on other open clients in place (no full refetch).
    imapManager.broadcast({ type: 'message_flags', changes: toUpdate.map(m => ({ id: m.id, is_read: read })) });

    // IMAP: one STORE per (account, folder) group, not one per letter. setFlagsGroups reserves
    // the order of every group of the mailbox at once and stops the mailbox's remaining groups
    // after a rejected login or a busy mailbox, as the other bulk routes do (bulkBusyTracker).
    // A group that failed or was not tried goes onto the flag-push queue,
    // which retries it once logins are allowed again; the DB already holds the new state, so
    // nothing is lost. A group that went through resolves any push still queued for its letters.
    // A letter whose move has not reached the server has no uid to store at: its value goes onto
    // the queued move (see flagTarget). A move that settled meanwhile gives the new location.
    const toStore = toUpdate.filter(m => !isPendingUid(m.uid));
    const pendingMoves = toUpdate.filter(m => isPendingUid(m.uid));
    if (pendingMoves.length) {
      const { located } = await imapManager.moveQueue.deferFlags(pendingMoves, '\\Seen', read);
      for (const m of pendingMoves) {
        const loc = located.get(m.id);
        if (loc) toStore.push({ ...m, ...loc });
      }
    }
    const byAccount = new Map();
    for (const msg of toStore) {
      if (!byAccount.has(msg.account_id)) byAccount.set(msg.account_id, new Map());
      const byFolder = byAccount.get(msg.account_id);
      if (!byFolder.has(msg.folder)) byFolder.set(msg.folder, []);
      byFolder.get(msg.folder).push(msg);
    }
    for (const [accountId, byFolder] of byAccount) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const folders = [...byFolder];
      const results = account
        ? await imapManager.setFlagsGroups(account, folders.map(([folder, msgs]) => ({ folder, uids: msgs.map(m => m.uid) })), '\\Seen', read)
        : folders.map(() => ({ stored: false, error: new Error('account not found') }));
      folders.forEach(([folder, msgs], i) => {
        const { stored, error } = results[i];
        if (error) console.error(`bulk-read IMAP ${folder} (${msgs.length} letters):`, error.message);
        for (const msg of msgs) {
          if (stored) imapManager._resolveFlagPush(accountId, msg.id, '\\Seen'); // confirmed
          // Durable retry so a later flag-sync pull can't revert this message to unread.
          else imapManager._enqueueFlagPush(accountId, msg.id, '\\Seen', read);
        }
      });
    }

    // Refresh GTD section data for any updated thread that carries a GTD label.
    notifyMailMutation(toUpdate);

    res.json({ ok: true, updated: toUpdate.map(m => m.id) });
  } catch (err) {
    console.error('bulk-read error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
});

// ── Deleting: what the request means ────────────────────────────────────────
//
// A delete means one of two things: move the letter to Trash, or delete forever a letter the user
// sees in Trash. The row alone cannot tell them apart. A move to Trash keeps the row's id (the move
// queue needs it), so a second delete of a letter already moved there (a double click, a retry, a
// second tab, two people at once, a delete while the move is still queued) finds the row in Trash
// exactly like a delete from the Trash view does. Only the request can say which it is.
//
// So the client names the folder it listed each letter in: `folder` on DELETE /messages/:id,
// `folders: { [id]: folder }` on bulk-delete. A letter is deleted forever only when the row is in
// Trash AND the client saw it in Trash (or the request says `permanent: true`). A row in Trash
// that the client saw anywhere else was moved there already: the delete is done, and nothing
// happens. A request without the field (an older client, a notification action, the unsubscribe
// toast's "Move to trash") only ever moves to Trash. bulk: read `folders` (or `seen`, below)
// only, never `folder`.
function deleteIntent(body, { bulk = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const folders = b.folders && typeof b.folders === 'object' && !Array.isArray(b.folders) ? b.folders : {};
  const bySeen = bulk ? seenByFolder(b) : null;
  return {
    permanent: b.permanent === true,
    seen: (id) => {
      let f = b.folder;
      if (bulk) f = Object.prototype.hasOwnProperty.call(folders, id) ? folders[id] : (bySeen?.get(id) ?? null);
      return typeof f === 'string' ? f : null;
    },
  };
}

// bulk-delete's `seen: { [folder]: [ids] }`: the compact form of `folders`, each folder named once,
// and its ids need not be repeated in `ids`. The page-close flush uses it to fit the browser's
// keepalive budget. Map<id, folder>, or null when absent or not that shape.
function seenByFolder(body) {
  const seen = body?.seen;
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return null;
  const out = new Map();
  for (const [folder, list] of Object.entries(seen)) {
    if (!Array.isArray(list)) return null;
    for (const id of list) out.set(id, folder);
  }
  return out;
}

function wantsForever(intent, id, allTrashPaths) {
  return intent.permanent || allTrashPaths.has(intent.seen(id));
}

// Delete forever `rows` (one account, all in `folder` with a server uid, as the route read them).
// No transaction or row lock is held across the server delete (it can take minutes): the rows are
// claimed first (services/expungeClaims.js). A claimed row is not moved by the move queue and not
// claimed by another permanent delete. Only rows still at the folder and uid the route read are
// claimed, so a letter someone moved out of Trash meanwhile is left alone ('changed'), and so is
// one another permanent delete holds. imapDelete(uids) resolves to { succeeded, failed } (uids),
// or to null when the mailbox was busy (nothing deleted). The rows the server deleted are removed;
// the claim on the rest is released. Returns { deleted, changed, gone }, each a list of the rows
// given (deleted with is_read as removed), or null when busy.
async function expungeClaimed(folder, rows, imapDelete) {
  const { token, claimed } = await claimForExpunge(folder, rows);
  const still = rows.filter(r => claimed.has(r.id));
  const unclaimed = rows.filter(r => !claimed.has(r.id));
  let gone = [];
  let changed = [];
  if (unclaimed.length) {
    const { rows: present } = await query('SELECT id FROM messages WHERE id = ANY($1::uuid[])', [unclaimed.map(r => r.id)]);
    const exists = new Set(present.map(r => r.id));
    gone = unclaimed.filter(r => !exists.has(r.id));
    changed = unclaimed.filter(r => exists.has(r.id));
  }
  if (!still.length) return { deleted: [], changed, gone };
  let removed = new Map();
  let outcome;
  try {
    outcome = await imapDelete(still.map(r => r.uid));
    if (outcome) {
      const ok = new Set(outcome.succeeded.map(String));
      removed = await finishExpunge(token, folder, still.filter(r => ok.has(String(r.uid))));
    }
  } finally {
    // What was not removed goes back to normal. A failure here leaves the claim to the sweep.
    const keep = still.filter(r => !removed.has(r.id)).map(r => r.id);
    await releaseExpungeClaim(token, keep)
      .catch(err => console.error(`Releasing a permanent-delete claim failed: ${err.message}`));
  }
  if (!outcome) return null;
  const deleted = still.filter(r => removed.has(r.id)).map(r => ({ ...r, is_read: removed.get(r.id).is_read }));
  return { deleted, changed, gone };
}

// Bulk star/unstar (#434). Shaped like bulk-read above: skip rows already at the target
// state (no spurious row versions or IMAP round-trips), optimistic DB write with the 30s
// local-wins stamp (star_changed_at, same guard the single-message star handler uses), GTD
// sibling fan-out gated the same way, then per-message IMAP \Flagged writes in bounded
// batches with the durable retry queue on failure. Stars never touch unread counts, so no
// folder count adjustment (unlike bulk-read). Mailboxes are shared install-wide (migration
// 0056 dropped their owner column), so — like bulk-read — this has no per-user filter.
router.post('/messages/bulk-star', async (req, res) => {
  const { ids, starred } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }
  if (typeof starred !== 'boolean') {
    return res.status(400).json({ error: 'starred must be a boolean' });
  }

  try {
    const result = await query(
      `SELECT m.id, m.uid, m.folder, m.is_starred, m.account_id, m.message_id FROM messages m
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, updated: [] });

    // Skip messages whose state already matches — avoid spurious DB writes and IMAP round-trips.
    const toUpdate = owned.filter(m => !!m.is_starred !== !!starred);
    if (!toUpdate.length) return res.json({ ok: true, updated: [] });

    await query(
      'UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = ANY($2::uuid[])',
      [starred, toUpdate.map(m => m.id)]
    );

    // GTD sibling fan-out, gated exactly like the single-message star handler. Per message
    // because the star fan-out is keyed by Message-ID; bounded by the 500-id cap above.
    const acctIds = [...new Set(toUpdate.map(m => m.account_id))];
    const gtdAccts = new Set();
    await Promise.all(acctIds.map(async (aid) => {
      if (await accountMaintainsLabelSiblings(aid)) gtdAccts.add(aid);
    }));
    for (const msg of toUpdate) {
      if (msg.message_id && gtdAccts.has(msg.account_id)) {
        await fanOutStarToSiblings(msg.account_id, msg.message_id, starred);
      }
    }

    // Reflect the bulk star change on other open clients in place (no full refetch).
    imapManager.broadcast({ type: 'message_flags', changes: toUpdate.map(m => ({ id: m.id, is_starred: starred })) });

    // A letter whose move has not reached the server has no uid to store at yet: its value
    // goes onto the queued move (deferFlags), same as bulk-read. A move that settled
    // meanwhile gives the new location; still pending leaves it for the flag-sync pull once
    // the move lands.
    const toStore = toUpdate.filter(m => !isPendingUid(m.uid));
    const pendingMoves = toUpdate.filter(m => isPendingUid(m.uid));
    if (pendingMoves.length) {
      const { located } = await imapManager.moveQueue.deferFlags(pendingMoves, '\\Flagged', starred);
      for (const m of pendingMoves) {
        const loc = located.get(m.id);
        if (loc) toStore.push({ ...m, ...loc });
      }
    }

    const byAccount = new Map();
    for (const msg of toStore) {
      if (!byAccount.has(msg.account_id)) byAccount.set(msg.account_id, []);
      byAccount.get(msg.account_id).push(msg);
    }
    for (const [accountId, msgs] of byAccount) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const results = account
        ? await runInBatches(msgs, 3, msg => imapManager.setFlag(account, msg.uid, msg.folder, '\\Flagged', starred))
        : msgs.map(() => ({ status: 'rejected', reason: new Error('account not found') }));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`bulk-star IMAP ${msgs[i].id}:`, extractImapError(r.reason));
          imapManager._enqueueFlagPush(accountId, msgs[i].id, '\\Flagged', starred);
        } else {
          imapManager._resolveFlagPush(accountId, msgs[i].id, '\\Flagged'); // confirmed
        }
      });
    }

    // Refresh GTD section data for any updated thread that carries a GTD label.
    notifyMailMutation(toUpdate);

    res.json({ ok: true, updated: toUpdate.map(m => m.id) });
  } catch (err) {
    console.error('bulk-star error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
});

// Bulk delete (move to trash)
//
// Moving to Trash is DB-first (queueMove): the rows are in Trash at once and the server MOVE is
// queued, so it never answers mailbox_busy. Deleting forever what the client saw in Trash (or a
// draft) stays server-first: the expunge must have happened before the rows go, or a failed
// expunge would leave a letter the server still has and the panel does not, which the next
// backfill would bring back as new mail. Only that part can still be busy. A letter already in
// Trash that the client saw elsewhere is left alone and reported deleted (deleteIntent).
router.post('/messages/bulk-delete', async (req, res) => {
  const bySeen = seenByFolder(req.body);
  if (req.body?.seen !== undefined && !bySeen) {
    return res.status(400).json({ error: 'seen must map folders to arrays of ids' });
  }
  if (req.body?.ids !== undefined && !Array.isArray(req.body.ids)) {
    return res.status(400).json({ error: 'ids array required' });
  }
  const ids = [...new Set([...(req.body?.ids ?? []), ...(bySeen ? bySeen.keys() : [])])];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message id format' });
  }
  const intent = deleteIntent(req.body, { bulk: true });

  const busy = bulkBusyTracker();
  try {
    const result = await query(
      `SELECT m.*, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, deleted: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    // expungeSucceeded: permanently deleted (seen in Trash, or a draft).
    // trashMoved: moved into Trash in the database, MOVE queued.
    // alreadyTrashed: in Trash already, seen elsewhere by the client: nothing to do.
    // movePending: to be expunged, but still waiting for an earlier move, or moved or claimed by
    // another request while this one looked (move_pending).
    // failedGroups: groups that threw; their letters are left out of `deleted`.
    const expungeSucceeded = [];
    const trashMoved = [];
    const alreadyTrashed = [];
    const movePending = [];
    let failedGroups = 0;

    // Journaled and counted as each group goes through, not after the loop: a later group that
    // throws must not leave letters already deleted forever (or moved) unjournaled and uncounted.
    const commitExpunged = (rows) => {
      expungeSucceeded.push(...rows);
      const srcDeltas = {};
      for (const msg of rows) {
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcDeltas[key]) srcDeltas[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcDeltas[key].total++;
        if (!msg.is_read) srcDeltas[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(srcDeltas)) {
        adjustFolderCounts(accountId, path, -total, -unread);
        imapManager.broadcast({ type: 'folder_updated', folder: path, accountId });
      }
      recordAudit(deletedMessageEntries(req.session.userId, rows, true));
    };
    const commitMoved = (rows) => {
      trashMoved.push(...rows);
      recordAudit(deletedMessageEntries(req.session.userId, rows, false));
    };
    const groupFailed = (what, err) => {
      if (isMailboxBusyError(err)) throw err;
      failedGroups++;
      console.error(`bulk-delete ${what} failed:`, err);
    };

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      let account, trashPath, allTrashPaths, allDraftsPaths;
      try {
        const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
        account = accountResult.rows[0];
        trashPath = await resolveTrashFolder(accountId, msgs[0].folder_mappings);
        allTrashPaths = await resolveAllTrashPaths(accountId, msgs[0].folder_mappings);
        allDraftsPaths = await resolveAllDraftsPaths(accountId, msgs[0].folder_mappings);
      } catch (err) {
        groupFailed(`account ${accountId}`, err);
        continue;
      }

      // Drafts, and letters the client saw in Trash, are permanently deleted. A letter in Trash
      // the client saw elsewhere is there already. The rest move to Trash.
      const isDraft = m => allDraftsPaths.has(m.folder);
      const eligible = trashPath ? msgs : msgs.filter(isDraft);
      if (!trashPath && eligible.length < msgs.length) {
        console.error(`bulk-delete: no Trash folder found for account ${accountId} — skipping ${msgs.length - eligible.length} messages`);
      }
      const inTrash = m => !isDraft(m) && allTrashPaths.has(m.folder);
      const toExpunge = eligible.filter(m => isDraft(m) || (inTrash(m) && wantsForever(intent, m.id, allTrashPaths)));
      alreadyTrashed.push(...eligible.filter(m => inTrash(m) && !wantsForever(intent, m.id, allTrashPaths)));
      const toMove    = eligible.filter(m => !isDraft(m) && !inTrash(m));

      // A letter whose move into Trash has not reached the server has no uid there to expunge.
      movePending.push(...toExpunge.filter(m => isPendingUid(m.uid)));
      const expungeNow = toExpunge.filter(m => !isPendingUid(m.uid));

      // Permanently delete, grouped by actual folder, under a claim (expungeClaimed).
      if (expungeNow.length) {
        const byExpungeFolder = {};
        for (const msg of expungeNow) {
          (byExpungeFolder[msg.folder] = byExpungeFolder[msg.folder] || []).push(msg);
        }
        for (const [expungeFolder, folderMsgs] of Object.entries(byExpungeFolder)) {
          if (busy.skip(accountId)) break;
          let outcome;
          try {
            outcome = await expungeClaimed(expungeFolder, folderMsgs,
              uids => busy.run(accountId, () => imapManager.bulkPermanentDelete(account, uids, expungeFolder)));
          } catch (err) {
            groupFailed(`expunge from ${expungeFolder}`, err);
            continue;
          }
          if (!outcome) continue;
          commitExpunged(outcome.deleted);
          movePending.push(...outcome.changed);
          const done = new Set(outcome.deleted.map(m => m.id));
          for (const m of folderMsgs) {
            if (!done.has(m.id) && !outcome.changed.includes(m) && !outcome.gone.includes(m)) {
              console.error(`bulk-delete IMAP expunge uid ${m.uid} from ${expungeFolder}: IMAP delete failed`);
            }
          }
        }
      }

      if (toMove.length) {
        try {
          const moved = await queueMove(accountId, toMove, trashPath, { movedBy: req.session.userId });
          commitMoved(moved);
          if (moved.length) imapManager.broadcast({ type: 'folder_updated', folder: trashPath, accountId });
        } catch (err) {
          groupFailed(`move to ${trashPath}`, err);
        }
      }
    }

    // Nothing went through: a busy mailbox, letters still being moved, or failures.
    if (!expungeSucceeded.length && !trashMoved.length && !alreadyTrashed.length) {
      if (busy.busy) return sendMailboxBusy(res, busy.reason);
      if (failedGroups) return res.status(500).json({ error: 'Failed to delete messages' });
      if (movePending.length) return sendMovePending(res);
    }

    // Refresh GTD section data for any deleted thread that still carries a GTD label sibling.
    notifyMailMutation(owned);

    const deleted = [...expungeSucceeded.map(m => m.id), ...trashMoved.map(m => m.id), ...alreadyTrashed.map(m => m.id)];
    // A busy mailbox explains the rest first; otherwise letters still being moved do. A group that
    // failed otherwise is told by its letters missing from `deleted`.
    const why = busy.busy ? busy.flag() : (movePending.length ? { code: MOVE_PENDING_CODE } : {});
    res.json({ ok: true, deleted, ...why });
  } catch (err) {
    console.error('bulk-delete error:', err);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    res.status(500).json({ error: 'Failed to delete messages' });
  }
});

// ── Mailbox cleanup (bloat analysis + per-sender preview) ──────────────────────
// Both routes are READ-ONLY and strictly scoped to the caller's own account. Nothing here
// deletes: the actual cleanup is performed by the client feeding the returned ids to the
// existing /messages/bulk-delete (move-to-Trash) endpoint in <=500 batches.

// Analyze an INBOX for "bloat": how much is bulk mail, the top bulk senders (Tier 1 cleanup
// targets, exact from_email addresses), and promo-keyword buckets (Tier 2 guidance).
router.get('/mailbox-usage', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  const acct = await query('SELECT id, folder_mappings FROM email_accounts WHERE id = $1', [accountId]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });
  // Whether Archive is a usable cleanup action for this account (#403): the client
  // offers Archive vs Trash and needs to know if an archive folder can be resolved.
  const archiveFolder = await resolveArchiveFolder(accountId, acct.rows[0].folder_mappings);

  const summary = await query(
    `SELECT count(*)::int AS inbox_total, count(*) FILTER (WHERE is_bulk)::int AS bulk_total
     FROM messages WHERE account_id = $1 AND folder = 'INBOX'`,
    [accountId]
  );
  // Group senders case-insensitively so a sender that uses mixed-case addresses
  // (Promo@x vs promo@x) is one row whose count matches the delete — cleanup-preview
  // matches lower(from_email), so a case-sensitive count here would understate what
  // clicking the row actually trashes. min(from_email) is a real observed casing for
  // display; the delete lower-matches it and so still captures every case variant.
  const senders = await query(
    `SELECT min(from_email) AS from_email, max(from_name) AS from_name, count(*)::int AS count
     FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk
       AND from_email IS NOT NULL AND from_email <> ''
     GROUP BY lower(from_email) ORDER BY count DESC, lower(min(from_email)) LIMIT 25`,
    [accountId]
  );

  // Tier 2 promo keyword buckets (fixed set), counted over INBOX in one pass. Informational only.
  const KEYWORDS = ['% off', 'deal', 'sale', 'newsletter', 'coupon', 'webinar', 'last chance'];
  const filters = KEYWORDS
    .map((_, i) => `count(*) FILTER (WHERE subject ILIKE $${i + 2} OR coalesce(snippet,'') ILIKE $${i + 2})::int AS k${i}`)
    .join(', ');
  const kw = await query(
    `SELECT ${filters} FROM messages WHERE account_id = $1 AND folder = 'INBOX'`,
    [accountId, ...KEYWORDS.map(k => `%${k}%`)]
  );

  res.json({
    accountId,
    inboxTotal: summary.rows[0].inbox_total,
    bulkTotal: summary.rows[0].bulk_total,
    archiveAvailable: Boolean(archiveFolder),
    tier1Senders: senders.rows.map(r => ({ fromEmail: r.from_email, fromName: r.from_name || '', count: r.count })),
    tier2Keywords: KEYWORDS.map((k, i) => ({ keyword: k, count: kw.rows[0][`k${i}`] })),
  });
});

// Return the INBOX message ids for ONE specific sender, so the client can move exactly those to
// Trash via /messages/bulk-delete. Read-only; strictly scoped to the caller's account, INBOX, and
// an EXACT (case-insensitive) from_email match — never a wildcard, never another folder. Scoped to
// is_bulk so it trashes exactly the bulk messages the sender list counted (mailbox-usage counts
// bulk-only): a non-bulk message from that sender (a receipt, a personal note) is never surprise-
// trashed. Idempotent: once those messages are trashed, a re-run returns an empty set.
router.get('/cleanup-preview', async (req, res) => {
  const { accountId, fromEmail } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  if (!fromEmail || typeof fromEmail !== 'string' || !fromEmail.trim()) return res.status(400).json({ error: 'fromEmail required' });
  const acct = await query('SELECT id FROM email_accounts WHERE id = $1', [accountId]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });

  const rows = await query(
    `SELECT id FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk AND lower(from_email) = lower($2)`,
    [accountId, fromEmail.trim()]
  );
  res.json({ accountId, fromEmail: fromEmail.trim(), count: rows.rows.length, ids: rows.rows.map(r => r.id) });
});

// Bulk move to folder. DB-first (queueMove): the rows are in the destination at once and the
// server MOVE is queued, so a busy mailbox never fails it.
router.post('/messages/bulk-move', async (req, res) => {
  const { ids, folder } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !folder) {
    return res.status(400).json({ error: 'ids array and folder required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!isValidFolderName(folder)) {
    return res.status(400).json({ error: 'Invalid destination folder' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message id format' });
  }

  try {
    const result = await query(
      `SELECT m.* FROM messages m
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, moved: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const movedIds = [];
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      // Verify the destination folder exists for this account
      const folderCheck = await query(
        'SELECT 1 FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (!folderCheck.rows.length) {
        console.warn(`bulk-move: folder "${folder}" not found for account ${accountId}, skipping`);
        continue;
      }
      const moved = await queueMove(accountId, msgs, folder, { movedBy: req.session.userId });
      movedIds.push(...moved.map(m => m.id));
      // Every client refreshes its view: the rows left their folders and are in the destination.
      if (moved.length) imapManager.broadcast({ type: 'folder_updated', folder, accountId });
    }

    // Refresh GTD section data for any moved thread that still carries a GTD label sibling.
    notifyMailMutation(owned);

    res.json({ ok: true, moved: movedIds });
  } catch (err) {
    console.error('bulk-move error:', err);
    res.status(500).json({ error: 'Failed to move messages' });
  }
});

// Bulk archive — moves messages to the archive folder for each account. DB-first, as bulk-move.
router.post('/messages/bulk-archive', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }

  try {
    const result = await query(
      `SELECT m.*, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, archived: [], noArchiveFolder: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const archivedIds = [];
    const noArchiveFolder = [];
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const archiveFolder = await resolveArchiveFolder(accountId, msgs[0].folder_mappings);
      if (!archiveFolder) {
        noArchiveFolder.push(accountId);
        continue;
      }
      // Gmail's All Mail (special_use '\All') is excluded from sync and backfill, so a letter
      // archived there leaves our view: its row is dropped once the server has moved it, and
      // All Mail counts are not kept.
      const allMail = await isAllMailFolder(accountId, archiveFolder);
      const moved = await queueMove(accountId, msgs, archiveFolder, { allMail, movedBy: req.session.userId });
      archivedIds.push(...moved.map(m => m.id));
      if (moved.length) imapManager.broadcast({ type: 'folder_updated', folder: archiveFolder, accountId });
    }

    // Refresh GTD section data for any archived thread that still carries a GTD label sibling.
    notifyMailMutation(owned);

    res.json({ ok: true, archived: archivedIds, noArchiveFolder });
  } catch (err) {
    console.error('bulk-archive error:', err);
    res.status(500).json({ error: 'Failed to archive messages' });
  }
});

// Gather the reply-chain conversation that should be snoozed alongside `msg`.
//
// Snoozing a single message doesn't work on Gmail: Gmail groups the inbox by
// conversation, so moving one message to Snoozed only strips \Inbox from that
// message — its thread siblings keep \Inbox and the whole conversation stays in
// the inbox (#271). MailExpert's own inbox is thread-grouped too. So we snooze the
// entire conversation, but bounded to the RFC 5322 reply chain (Message-ID /
// In-Reply-To / References links) rather than thread_id: the reply chain is the
// conversation the user actually means, and a mailbox in `gmail` mode groups
// thread_id by Gmail's own provider thread number, which spans folders and can lump
// hundreds of unrelated messages together (e.g. identical automated-notification
// emails), which must never be swept into Snoozed.
//
// Returns the messages in `msg`'s source folder reachable from `msg` through
// header links (always including `msg` itself); excludes already-snoozed messages.
export async function gatherSnoozeConversation(msg) {
  if (!msg.thread_id) return [msg];

  // Load the whole thread across ALL folders. thread_id is a superset of the true
  // conversation, and the messages that hold a real conversation together — the
  // other party's replies, your own Sent messages, the thread root — frequently
  // live in Sent / All Mail rather than the inbox. They must be present as graph
  // connectors or a genuine thread fragments and only part of it snoozes. The
  // reply-chain walk below filters out the subject-only collisions that a stale,
  // subject-grouped thread_id may still carry from before the subject fallback was
  // dropped (e.g. identical automated-notification emails).
  const pool = (await query(
    `SELECT id, uid, account_id, folder, message_id, in_reply_to, thread_references, is_read
     FROM messages
     WHERE account_id = $1 AND thread_id = $2 AND message_id IS NOT NULL`,
    [msg.account_id, msg.thread_id]
  )).rows;

  // Ensure the triggering message is present (the query above could miss it on a
  // transient read skew).
  if (!pool.some(r => r.message_id === msg.message_id)) pool.push(msg);

  const refsOf = (r) => {
    const ids = (r.thread_references || '').match(/<[^>]+>/g) || [];
    if (r.in_reply_to) ids.push(r.in_reply_to);
    return ids;
  };

  // Undirected reply-chain graph over the whole thread; take the connected
  // component containing `msg`. Messages with no header link into that component
  // (subject-only collisions) are left out.
  const adj = new Map();
  const node = (m) => { let s = adj.get(m); if (!s) { s = new Set(); adj.set(m, s); } return s; };
  for (const r of pool) node(r.message_id);
  for (const r of pool) {
    for (const ref of refsOf(r)) {
      if (adj.has(ref)) { node(r.message_id).add(ref); node(ref).add(r.message_id); }
    }
  }
  const seen = new Set([msg.message_id]);
  const queue = [msg.message_id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }

  // Snooze only the conversation members in the acted-on message's source folder
  // (the inbox copies — Sent copies carry no \Inbox and shouldn't move), skipping
  // any already snoozed. Already-snoozed messages stay valid graph connectors above.
  const already = new Set(
    (await query(
      'SELECT message_id_header FROM snoozed_messages WHERE account_id = $1 AND message_id_header = ANY($2)',
      [msg.account_id, [...seen]]
    )).rows.map(r => r.message_id_header)
  );
  // Dedupe by Message-ID so a message that somehow has two rows in the source
  // folder isn't moved (and recorded) twice.
  const picked = new Map();
  for (const r of pool) {
    if (seen.has(r.message_id) && r.folder === msg.folder && !already.has(r.message_id) && !picked.has(r.message_id)) {
      picked.set(r.message_id, r);
    }
  }
  // Return the acted-on message first so the caller can treat a failure moving it
  // as fatal before any sibling has been touched (no partial snooze on error).
  const rest = [...picked.values()].filter(r => r.message_id !== msg.message_id);
  // msg always qualifies (it's the acted-on, not-yet-snoozed message in its own
  // folder); fall back to it directly if the pool row for it was missed.
  const self = picked.get(msg.message_id) || msg;
  return [self, ...rest];
}

// Snooze a message: move it to a Snoozed IMAP folder and record when to restore it
router.post('/messages/:id/snooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { until } = req.body;
  if (!until) return res.status(400).json({ error: 'until is required' });

  const untilDate = new Date(until);
  if (isNaN(untilDate.getTime())) return res.status(400).json({ error: 'until must be a valid ISO date' });
  if (untilDate <= new Date()) return res.status(400).json({ error: 'until must be in the future' });
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  if (untilDate > maxDate) return res.status(400).json({ error: 'until must be within 30 days' });

  // The message must exist
  const msgResult = await query(
    `SELECT m.* FROM messages m
     WHERE m.id = $1`,
    [id]
  );
  if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = msgResult.rows[0];

  if (!msg.message_id) return res.status(400).json({ error: 'Message has no Message-ID header — cannot snooze' });

  const snoozedFolder = 'Snoozed';

  if (msg.folder === snoozedFolder) {
    return res.status(400).json({ error: 'Message is already in Snoozed folder' });
  }
  // Snooze stays server-first (it needs the Snoozed folder on the server first, and the wakeup
  // finds the letter there): a letter whose move has not reached the server cannot be snoozed yet.
  if (isPendingUid(msg.uid)) return sendMovePending(res);

  // Check if already snoozed
  const existing = await query(
    'SELECT id FROM snoozed_messages WHERE account_id = $1 AND message_id_header = $2',
    [msg.account_id, msg.message_id]
  );
  if (existing.rows.length) return res.status(400).json({ error: 'Message is already snoozed' });

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  // Snooze the whole reply-chain conversation, not just this message (see
  // gatherSnoozeConversation for why Gmail requires this and why it's bounded
  // to the header reply chain rather than thread_id).
  // Letters of the conversation whose own move is pending are not in this folder on the server.
  const convo = (await gatherSnoozeConversation(msg)).filter(m => m.id === msg.id || !isPendingUid(m.uid));

  try {
    await imapManager.ensureFolder(account, snoozedFolder);
  } catch (err) {
    console.error(`Snooze ensureFolder failed for message ${id}:`, err.message);
    if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
    return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
  }

  for (const tm of convo) {
    imapManager._guardMoveUid(tm.account_id, tm.folder, tm.uid);
    try {
      let snoozedUid;
      try {
        snoozedUid = await imapManager.moveMessage(account, tm.uid, tm.folder, snoozedFolder);
      } catch (err) {
        console.error(`Snooze IMAP move failed for message ${tm.id}:`, err.message);
        // The message the user acted on must succeed; a failed sibling is logged
        // and skipped so the rest of the conversation still snoozes.
        if (tm.id === msg.id) {
          if (isMailboxBusyError(err)) return sendMailboxBusy(res, err);
          return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
        }
        continue;
      }
      if (snoozedUid != null) {
        await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [snoozedFolder, snoozedUid, tm.id]);
      } else {
        imapManager._guardMoveUid(tm.account_id, snoozedFolder, tm.uid);
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [snoozedFolder, tm.id]);
        setTimeout(() => imapManager._unguardMoveUid(tm.account_id, snoozedFolder, tm.uid), 10_000);
      }

      await query(
        `INSERT INTO snoozed_messages (snoozed_by, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.session.userId, tm.account_id, tm.message_id, tm.folder, untilDate.toISOString(), snoozedFolder]
      );

      adjustFolderCounts(tm.account_id, tm.folder, -1, tm.is_read ? 0 : -1);
      adjustFolderCounts(tm.account_id, snoozedFolder, 1, tm.is_read ? 0 : 1);
    } finally {
      imapManager._unguardMoveUid(tm.account_id, tm.folder, tm.uid);
    }
  }

  // Refresh GTD section data if the snoozed conversation carries a GTD label (its in_inbox flips).
  notifyMailMutation(convo);

  res.json({ ok: true });
});

// Delete (move to trash; drafts are permanently deleted)
router.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.* FROM messages m
    WHERE m.id = $1
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];
  const intent = deleteIntent(req.body);

  // Delete forever, server-first, under a claim (expungeClaimed). A letter whose move is pending
  // has no uid here yet; one moved, changed or claimed by another delete meanwhile waits too.
  // Returns true when the response was sent with an error.
  const expungeOne = async (failMessage) => {
    if (isPendingUid(message.uid)) { sendMovePending(res); return true; }
    let outcome;
    try {
      outcome = await expungeClaimed(message.folder, [message], async ([uid]) => {
        await imapManager.permanentDeleteMessage(account, uid, message.folder);
        return { succeeded: [uid], failed: [] };
      });
    } catch (err) {
      console.error(`IMAP permanent delete failed: ${err.message}`);
      if (isMailboxBusyError(err)) { sendMailboxBusy(res, err); return true; }
      res.status(500).json({ error: failMessage });
      return true;
    }
    if (outcome.changed.length) { sendMovePending(res); return true; }
    if (!outcome.deleted.length) { res.status(404).json({ error: 'Message not found' }); return true; }
    const [gone] = outcome.deleted;
    adjustFolderCounts(message.account_id, message.folder, -1, gone.is_read ? 0 : -1);
    return false;
  };

  // Drafts bypass Trash and are permanently deleted (consistent with all major email clients).
  const allDraftsPaths = await resolveAllDraftsPaths(message.account_id, account.folder_mappings);
  if (allDraftsPaths.has(message.folder)) {
    if (await expungeOne('Failed to delete draft')) return;
    recordAudit(deletedMessageEntries(req.session.userId, [message], true));
    imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id });
    return res.json({ ok: true });
  }

  const trashPath = await resolveTrashFolder(message.account_id, account.folder_mappings);
  const allTrashPaths = await resolveAllTrashPaths(message.account_id, account.folder_mappings);
  const strategy = getDeleteStrategy(message.folder, trashPath, allTrashPaths);

  if (strategy.action === 'no_trash') {
    return res.status(422).json({ error: 'No Trash folder configured for this account' });
  }

  // In Trash already, and the client did not see it there: an earlier delete moved it (or is
  // moving it). The delete is done; deleting it forever is not what was asked (deleteIntent).
  if (strategy.action === 'expunge' && !wantsForever(intent, id, allTrashPaths)) {
    return res.json({ ok: true, alreadyInTrash: true });
  }

  if (strategy.action === 'move') {
    // DB-first: the row is in Trash at once and the server MOVE is queued (queueMove).
    const moved = await queueMove(message.account_id, [message], trashPath, { movedBy: req.session.userId });
    if (!moved.length) {
      const answer = await notMovedAnswer(id);
      return res.status(answer.status).json({ error: answer.error, ...(answer.code ? { code: answer.code } : {}) });
    }
    imapManager.broadcast({ type: 'folder_updated', folder: trashPath, accountId: message.account_id });
  } else if (await expungeOne('Failed to delete message')) {
    // strategy.action === 'expunge': the client saw the letter in Trash and it is still there.
    return;
  }
  recordAudit(deletedMessageEntries(req.session.userId, [message], strategy.action === 'expunge'));
  imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id });
  // Refresh GTD section data if this thread still carries a GTD label sibling (same staleness the
  // bulk-delete route addresses, reached via the single-message delete button).
  notifyMailMutation([message]);
  res.json({ ok: true });
});

// ── Antispam (v0.1) ─────────────────────────────────────────────────────────
// Manual "Mark as Spam" / "Mark as Not Spam" endpoints.
// They move the message to the account's spam folder (or back to INBOX for
// ham) via IMAP, persist the user override in messages.spam_user_override,
// and log the decision to spam_training_log so future releases can train
// per-user models on it.
//
// No automatic classification runs here — that ships in v0.2 (ML) and v0.3 (SA).

// Where the training log records a letter: where the server has it (its folder and uid, or the
// source of its queued move). A letter whose MOVE is on its way has no known place: the uid and
// folder are left empty rather than recording a placeholder uid (moveQueue.js) or the folder it
// is only on its way to; message_id_header stays the key.
async function trainingLocation(message) {
  const loc = await imapManager.moveQueue.serverLocation(message);
  return loc ? { uid: loc.uid, folder: loc.folder } : { uid: null, folder: null };
}

// A single-letter move that moved nothing: the row is gone (404), or it could not move now (its
// folder is being emptied, renamed or deleted: 409 move_pending).
async function notMovedAnswer(messageId) {
  const { rows } = await query('SELECT 1 FROM messages WHERE id = $1', [messageId]);
  return rows.length
    ? { ok: false, status: 409, ...movePendingBody() }
    : { ok: false, status: 404, error: 'Message not found' };
}

// Helper: move a single message to a destination folder, update DB, log to
// training_log, and broadcast folder_updated. Shared between /spam and /ham.
async function moveForSpamLabel(messageId, userId, destinationFolder, label) {
  const result = await query(`
    SELECT m.*, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1
  `, [messageId]);

  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const message = result.rows[0];

  // No-op: message already in the destination folder.
  if (message.folder === destinationFolder) {
    // Still record the training label so the user's intent is captured
    // (e.g. re-confirming a verdict), but skip the IMAP move.
    const at = await trainingLocation(message);
    await query(
      `INSERT INTO spam_training_log
         (trained_by, account_id, message_id_header, message_uid, folder, label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, message.account_id, message.message_id, at.uid, at.folder, label]
    );
    await query(
      `UPDATE messages SET spam_user_override = $1, spam_verdict = $1, spam_analyzed_at = NOW() WHERE id = $2`,
      [label, messageId]
    );
    return { ok: true, status: 200, body: { ok: true, alreadyInFolder: true, folder: destinationFolder } };
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];

  // Where the server has the letter, before the move changes the row.
  const at = await trainingLocation(message);
  // DB-first: the row is in the destination at once and the server MOVE is queued (queueMove).
  const moved = await queueMove(account.id, [message], destinationFolder, { movedBy: userId });
  if (!moved.length) return notMovedAnswer(messageId);
  await query(
    `UPDATE messages SET spam_user_override = $1, spam_verdict = $1, spam_analyzed_at = NOW() WHERE id = $2`,
    [label, messageId]
  );

  // Training log: capture the decision for future model training. The destination uid is not
  // known until the queued MOVE runs, so the letter is recorded where the server had it when the
  // user acted (trainingLocation); message_id_header is the stable key.
  await query(
    `INSERT INTO spam_training_log
       (trained_by, account_id, message_id_header, message_uid, folder, label, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
    [userId, account.id, message.message_id, at.uid, at.folder, label]
  );

  // If folder_mappings.spam is not yet configured, learn from the discovered folder.
  if (label === 'spam' && !account.folder_mappings?.spam) {
    await query(
      `UPDATE email_accounts SET folder_mappings = folder_mappings || jsonb_build_object('spam', $1::text)
       WHERE id = $2 AND NOT (folder_mappings ? 'spam')`,
      [destinationFolder, account.id]
    ).catch(err => console.warn('Failed to auto-persist folder_mappings.spam:', err.message));
  }

  imapManager.broadcast({ type: 'folder_updated', folder: destinationFolder, accountId: account.id });

  // Refresh GTD section data if the (un)spammed message's thread carries a GTD label. Covers both
  // /spam and /ham, which share this mover. The already-in-folder no-op path above returns
  // early without a move, so GTD section data is untouched there.
  notifyMailMutation([message]);

  return { ok: true, status: 200, body: { ok: true, folder: destinationFolder, newUid: null } };
}

// POST /api/mail/messages/:id/spam
// Moves the message to the account's spam/junk folder and records the user
// override as spam. Coexists with the future ML/SA auto-classification:
// spam_user_override always wins over auto verdicts.
router.post('/messages/:id/spam', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await query(`
    SELECT m.account_id, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1
  `, [id]);

  if (!lookup.rows.length) return res.status(404).json({ error: 'Message not found' });
  const spamFolder = await resolveSpamFolder(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!spamFolder) return res.status(422).json({ error: 'No spam folder configured for this account' });

  const result = await moveForSpamLabel(id, req.session.userId, spamFolder, 'spam');
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  res.json(result.body);
});

// GET /api/mail/category-counts
// Returns unread message counts per category for the INBOX. Used by the
// category tab bar to show unread badges. Scoped to the user; optionally
// filtered to a single account via ?accountId=.
router.get('/category-counts', async (req, res) => {
  const { accountId } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE enabled = true'
  );
  const { accountIds: scopedIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedIds.length) return res.json({ counts: {} });

  const result = await query(`
    SELECT COALESCE(m.category, 'primary') AS category,
           COUNT(*) FILTER (WHERE m.is_read = false)::int AS unread_count
    FROM messages m
    WHERE m.account_id = ANY($1)
      AND m.folder = 'INBOX'
      AND m.is_deleted = false
    GROUP BY COALESCE(m.category, 'primary')
  `, [scopedIds]);

  const counts = {};
  for (const row of result.rows) {
    counts[row.category] = row.unread_count;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ counts });
});

// PATCH /api/mail/messages/:id/category
// Manually override the computed category for a single message.
router.patch('/messages/:id/category', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { category } = req.body;
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  const result = await query(
    `UPDATE messages SET category = $1
     WHERE id = $2
     RETURNING id`,
    [category === 'primary' ? null : category, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true, category });
});

// POST /api/mail/messages/:id/unsubscribe
// Processes a one-click unsubscribe (RFC 8058) or returns parsed
// unsubscribe options for the frontend to handle (URL open, mailto compose).
router.post('/messages/:id/unsubscribe', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.list_unsubscribe, m.list_unsubscribe_post
    FROM messages m
    WHERE m.id = $1 AND m.is_deleted = false
  `, [id]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const { list_unsubscribe: rawUnsub, list_unsubscribe_post: rawUnsubPost } = result.rows[0];
  if (!rawUnsub) return res.status(400).json({ error: 'No unsubscribe header' });
  const list_unsubscribe = decodeMimeWords(rawUnsub);
  const list_unsubscribe_post = rawUnsubPost ? decodeMimeWords(rawUnsubPost) : rawUnsubPost;

  // Parse angle-bracket-wrapped URLs/mailtos from the header value.
  // e.g. "<https://example.com/unsub>, <mailto:list@example.com?subject=unsubscribe>"
  const refs = [...list_unsubscribe.matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const httpsUrl = refs.find(r => /^https:\/\//i.test(r));
  const mailtoUrl = refs.find(r => /^mailto:/i.test(r));

  const isOneClick = /List-Unsubscribe=One-Click/i.test(list_unsubscribe_post || '');

  // RFC 8058 one-click: POST to the https URL on behalf of the user.
  if (isOneClick && httpsUrl) {
    // Validate the URL host — DNS-resolved check blocks hostnames that resolve to private IPs.
    let parsed;
    try { parsed = new URL(httpsUrl); } catch {
      return res.status(400).json({ error: 'Invalid unsubscribe URL' });
    }
    const hostErr = await validateHost(parsed.hostname);
    if (hostErr) return res.status(400).json({ error: 'Unsubscribe URL not allowed' });

    try {
      // safeFetch validates the resolved IP of the initial host AND every redirect
      // hop, so an attacker-supplied List-Unsubscribe URL can't redirect to an
      // internal address. (The validateHost above stays as a fast pre-check.) No User-Agent of
      // our own: the panel does not name itself to the sender's server (undici's default).
      const unsub = await safeFetch(httpsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(10000),
      });
      if (unsub.ok) {
        await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
        return res.json({ ok: true, type: 'one-click' });
      }
      console.warn(`One-click unsubscribe returned ${unsub.status} for ${httpsUrl}`);
      // Fall through to URL/mailto fallback
    } catch (err) {
      console.warn('One-click unsubscribe failed:', err.message);
      // Fall through to URL/mailto options instead
    }
  }

  // Return parsed options for the frontend to handle.
  // Mark unsubscribed_at optimistically — the user has been given the mechanism to complete it.
  await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
  res.json({
    ok: true,
    type: httpsUrl ? 'url' : 'mailto',
    url: httpsUrl || null,
    mailto: mailtoUrl || null,
  });
});

// POST /api/mail/messages/:id/ham
// Moves a message back from the spam folder to INBOX and records the override
// as ham (not spam). Only meaningful when the message is currently in a
// spam-like folder; returns 400 otherwise.
router.post('/messages/:id/ham', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await query(`
    SELECT m.account_id, m.folder, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1
  `, [id]);

  if (!lookup.rows.length) return res.status(404).json({ error: 'Message not found' });
  const allSpam = await resolveAllSpamPaths(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!allSpam.has(lookup.rows[0].folder)) {
    return res.status(400).json({ error: 'Message is not in the spam folder' });
  }

  // Resolve inbox folder per account — Gmail, Exchange and others may not use
  // the literal 'INBOX' (e.g. 'Inbox' on Dovecot, 'Posteingang', etc.).
  // Same pattern as folder_mappings.sent / .drafts in send.js and draft.js.
  const inboxFolder = lookup.rows[0].folder_mappings?.inbox || 'INBOX';
  const result = await moveForSpamLabel(id, req.session.userId, inboxFolder, 'ham');
  if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  res.json(result.body);
});

export default router;
