import { query } from './db.js';
import { deliveryStateColumn } from './deliveryStatus.js';
import { resolveAllDraftsPaths, resolveAllSentPaths, resolveAllSpamPaths, resolveAllTrashPaths } from '../utils/mailUtils.js';

// "The whole conversation" under an open letter, as Gmail stacks it: every letter of the open
// letter's thread in the same mailbox, oldest first, each marked with its direction. Only this
// mailbox (the same conversation in another mailbox is that mailbox's business), never trash or
// spam; a draft is listed and marked as one. A letter synced into several folders (Gmail labels)
// counts once, the Inbox copy preferred over Sent, and either over any other label — this also
// makes a self-sent letter's dedup deterministic (see direction below): its Inbox copy wins.
//
// Direction matches mailboxBanner()/contactLetters.js exactly: an own sender is 'out' only when
// the surviving copy sits in the account's own Sent folder, or none of its recipients is the
// account itself; a letter the mailbox sent to ITSELF (own address among its own recipients) is
// also a received copy — Gmail keeps it in both Sent and Inbox — so outside Sent it is 'in'.
// A thread longer than CONVERSATION_MAX_LETTERS keeps its newest letters; `total` still counts
// all of them.

export const CONVERSATION_MAX_LETTERS = 100;

const lower = (value) => String(value ?? '').trim().toLowerCase();

function addressList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// { threadKey, total, items: [{ id, folder, subject, snippet, date, from_name, from_email,
//   to_addresses, cc_addresses, has_attachments, delivery_state, direction: 'in' | 'out' | 'draft' }] },
// oldest first; null when the message does not exist.
export async function conversation(messageId) {
  const found = await query(`
    SELECT m.account_id, m.thread_key, a.email_address, a.folder_mappings,
           COALESCE((SELECT array_agg(al.email) FROM account_aliases al WHERE al.account_id = a.id), '{}') AS alias_emails
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = $1 AND m.is_deleted = false
  `, [messageId]);
  if (!found.rows.length) return null;
  const { account_id: accountId, thread_key: threadKey, folder_mappings: mappings } = found.rows[0];
  if (!threadKey) return { threadKey: null, total: 0, items: [] };

  const own = [...new Set([found.rows[0].email_address, ...(found.rows[0].alias_emails || [])]
    .map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
  const [trash, spam, drafts, sent] = await Promise.all([
    resolveAllTrashPaths(accountId, mappings),
    resolveAllSpamPaths(accountId, mappings),
    resolveAllDraftsPaths(accountId, mappings),
    resolveAllSentPaths(accountId, mappings),
  ]);
  const inboxPath = 'INBOX';

  const { rows } = await query(`
    WITH letters AS (
      SELECT DISTINCT ON (COALESCE(m.message_id, m.id::text))
             m.id, m.folder, m.subject, m.snippet, m.date, m.from_name, m.from_email,
             m.to_addresses, m.cc_addresses, m.has_attachments,
             ${deliveryStateColumn('m', 'a')} AS delivery_state
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
      WHERE m.account_id = $1
        AND m.thread_key = $2
        AND m.is_deleted = false
        AND NOT (m.folder = ANY($3::text[]))
      ORDER BY COALESCE(m.message_id, m.id::text),
               -- Inbox preferred over Sent, either over any other label. This also decides which
               -- copy of a self-sent letter (filed in both Inbox and Sent) survives the dedup —
               -- Inbox wins, so its direction below reads as the received copy it also is.
               CASE WHEN m.folder = $4 THEN 0 WHEN m.folder = ANY($5::text[]) THEN 1 ELSE 2 END,
               m.id
    )
    SELECT * FROM (
      SELECT letters.*, count(*) OVER () AS total
      FROM letters
      ORDER BY date DESC NULLS LAST, id DESC
      LIMIT $6
    ) newest
    ORDER BY date ASC NULLS FIRST, id ASC
  `, [accountId, threadKey, [...trash, ...spam], inboxPath, [...sent], CONVERSATION_MAX_LETTERS]);

  return {
    threadKey,
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      id: r.id,
      folder: r.folder,
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      from_name: r.from_name,
      from_email: r.from_email,
      to_addresses: r.to_addresses,
      cc_addresses: r.cc_addresses,
      has_attachments: r.has_attachments,
      delivery_state: r.delivery_state ?? null,
      direction: letterDirection(r, own, sent, drafts),
    })),
  };
}

// 'draft' when the letter sits in a Drafts folder. Otherwise, for a letter someone else wrote,
// always 'in'. For a letter this account (or an alias) wrote, 'out' only when it sits in the
// account's own Sent folder or none of its recipients is the account itself — see the module
// comment for why a self-sent letter is 'in' outside Sent.
function letterDirection(row, own, sentPaths, draftPaths) {
  if (draftPaths.has(row.folder)) return 'draft';
  const from = lower(row.from_email);
  if (!own.includes(from)) return 'in';
  if (sentPaths.has(row.folder)) return 'out';
  const recipients = [...addressList(row.to_addresses), ...addressList(row.cc_addresses)]
    .map((entry) => lower(typeof entry === 'string' ? entry : entry?.email));
  return recipients.some((address) => own.includes(address)) ? 'in' : 'out';
}
