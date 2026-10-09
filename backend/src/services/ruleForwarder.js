import { createHmac } from 'crypto';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { query } from './db.js';
import { deriveKey } from './encryption.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { parseHeadersInput } from './messageParser.js';
import { createAccountSendTransport } from './mailSendTransport.js';
import { sendFailureIsDefinite } from './smtpErrors.js';
import { isDisabledMailbox, isReadOnlyNodeMailbox } from '../utils/senderNames.js';
import { ATTACHMENT_LIMIT_ERROR, MAX_ATTACHMENT_BYTES } from '../utils/attachmentLimit.js';

const LOOP_HEADER = 'X-MailExpert-Loop';
// The most tokens a forward carries: its own and the newest nine it received.
const MAX_LOOP_TOKENS = 10;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseAddresses(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatAddress(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return '';

  const email = address.address || address.email || '';
  return address.name ? `${address.name} <${email}>` : email;
}

function formatAddresses(value) {
  return parseAddresses(value).map(formatAddress).filter(Boolean).join(', ');
}

function formatUtcDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString();
}

function forwardSubject(value) {
  const subject = String(value ?? '');
  return /^Fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function htmlToPlainText(value) {
  const namedEntities = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:blockquote|div|h[1-6]|li|p|pre|tr)\s*>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&#([0-9]+);/g, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&([a-z]+);/gi, (_, name) =>
      namedEntities.get(name.toLowerCase()) ?? ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttachments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function forwardedHeaders(row) {
  const from = formatAddress({
    name: row.from_name,
    address: row.from_email,
  });
  return [
    ['From', from],
    ['Date', formatUtcDate(row.date)],
    ['Subject', row.subject || ''],
    ['To', formatAddresses(row.to_addresses)],
    ['Cc', formatAddresses(row.cc_addresses)],
  ].filter(([, value]) => value);
}

// A forward is a new message, so when a copy lands back in a mailbox that forwards it (two
// mailboxes whose rules forward to each other, an all-mailboxes rule forwarding to another of
// the user's or a shared mailbox, a rule forwarding to its own alias) nothing ties it to the
// mail it came from: the reservation in inbox_rule_forwards is keyed on the source row, and
// every returning copy is a new row. It would go round forever, re-attaching up to the
// attachment limit on every pass.
//
// So each forward carries the tokens of the message it was made from plus its own mailbox's,
// and a mailbox that finds its own token has already forwarded this mail. The token is per
// mailbox address, not per rule, recipient or account row: a copy that comes back cannot fan
// out through the mailbox's other forward rules, and two connections of one shared mailbox
// count as one. It is an HMAC of the address under a key derived from ENCRYPTION_KEY: a sender
// knows the address but not the key, so cannot work out a mailbox's token to stop its rules
// forwarding their mail, and the header does not list the addresses on the way.
function loopToken(account) {
  const key = deriveKey('rule-forward-loop');
  if (!key) throw new Error('ENCRYPTION_KEY is not set or invalid — cannot make the forward loop token');
  return createHmac('sha256', key)
    .update((account.email_address || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

// Only well-formed tokens are passed on: the header may have come from the sender.
function receivedLoopTokens(parsedHeaders) {
  const value = parsedHeaders?.[LOOP_HEADER.toLowerCase()];
  return typeof value === 'string' ? value.match(/\b[0-9a-f]{16}\b/g) || [] : [];
}

// A message from a manual sweep (run rules now) is a DB row with no headers. Read them only for a
// message a forward rule matched, not for the whole sweep. Unreadable headers fail the forward
// (the rule engine leaves the source in place and a later sweep retries it): forwarding without
// the loop check could send a copy that has already been round this mailbox once more.
async function fetchLoopTokens(message, account, imapManager) {
  const headers = parseHeadersInput(await imapManager.fetchHeaders(account, message.uid, message.folder));
  if (!Object.keys(headers).length) throw new Error('Forward source headers unavailable');
  return receivedLoopTokens(headers);
}

function isForwardLoop(loopTokens, account, ruleId, message) {
  if (!loopTokens.includes(loopToken(account))) return false;
  console.warn(`ruleForwarder: rule ${ruleId} did not forward message ${message.id}: forwarding loop detected`);
  return true;
}

export function buildForwardMessage({
  row,
  account,
  recipient,
  text,
  html,
  attachments = [],
  loopTokens = [],
}) {
  const headers = forwardedHeaders(row);
  const forwardHeaderText = [
    '---------- Forwarded message ----------',
    ...headers.map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
  const forwardHeaderHtml = [
    '<div>---------- Forwarded message ----------<br>',
    ...headers.map(([label, value]) =>
      `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}<br>`),
    '</div><br>',
  ].join('');
  const safeHtml = html ? sanitizeEmail(html) : html;
  const plainBody = text || htmlToPlainText(safeHtml);

  return {
    from: `${account.sender_name || account.name} <${account.email_address}>`,
    to: recipient,
    // The newest nine received tokens and this mailbox's. The header stays short, and tokens a
    // sender adds are pushed out instead of stopping the forward, so the hop bound cannot be
    // used to block it. A loop through up to ten mailboxes is caught; one through more is not.
    // Both send paths carry it: SMTP through nodemailer, the Gmail API through MailComposer.
    headers: {
      [LOOP_HEADER]: [...loopTokens.slice(-(MAX_LOOP_TOKENS - 1)), loopToken(account)].join(', '),
    },
    subject: forwardSubject(row.subject),
    text: `${forwardHeaderText}\n\n${plainBody}`,
    ...(safeHtml ? { html: `${forwardHeaderHtml}${safeHtml}` } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function ensureAttachmentLimit(attachments) {
  const totalBytes = attachments.reduce(
    (sum, attachment) => sum + (attachment.content?.length || 0),
    0
  );
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(ATTACHMENT_LIMIT_ERROR);
  }
}

async function loadForwardContent({ row, account, imapManager }) {
  let text = row.body_text;
  let html = row.body_html;
  let fetchedParts = [];
  // Where the server has the letter: a user may have moved it (DB-first, moveQueue.js) since the
  // rule matched, leaving a placeholder uid on the row; its queued move's source is still right.
  const loc = await imapManager.moveQueue.serverLocation(row, account);
  if (!loc) throw new Error('Forward source is being moved on the mail server');
  if (!text && !html) {
    // allowLogin: a forward runs once per new message and has no retry, so a refusal backoff
    // must not make it fail without even one login attempt (see fetchMessageBody).
    // failFastWhenHeld: it runs inside the sync tick, so a fetch the login gate holds back must
    // fail at once rather than queue for a busy pooled session; otherwise it waits as usual.
    const fetched = await imapManager.fetchMessageBody(
      account,
      loc.uid,
      loc.folder,
      { allowLogin: true, failFastWhenHeld: true }
    );
    text = fetched.text;
    html = fetched.html;
    fetchedParts = parseAttachments(fetched.attachments);
  }

  const storedParts = [];
  const seenParts = new Set();
  for (const attachment of [
    ...parseAttachments(row.attachments),
    ...fetchedParts,
  ]) {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      attachment.part === undefined ||
      attachment.part === null
    ) {
      continue;
    }
    const partKey = String(attachment.part);
    if (seenParts.has(partKey)) continue;
    seenParts.add(partKey);
    storedParts.push(attachment);
  }
  const knownBytes = storedParts.reduce(
    (sum, attachment) =>
      sum + (Number.isFinite(Number(attachment.size))
        ? Number(attachment.size)
        : 0),
    0
  );
  if (knownBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(ATTACHMENT_LIMIT_ERROR);
  }

  let fetchedAttachments = [];
  if (storedParts.length) {
    const buffers = await imapManager.fetchMultipleAttachments(
      account,
      loc.uid,
      loc.folder,
      storedParts,
      { failFastWhenHeld: true }
    );
    fetchedAttachments = storedParts.map(attachment => {
      const content = buffers.get(attachment.part);
      if (!content) {
        throw new Error('Forward attachment unavailable');
      }
      return {
        filename: attachment.filename || 'attachment',
        content,
        contentType: attachment.type || 'application/octet-stream',
      };
    });
  }

  const safeHtml = html ? sanitizeEmail(html) : html;
  const embedded = embedInlineDataImages(safeHtml);
  const attachments = [
    ...embedded.attachments,
    ...fetchedAttachments,
  ];
  ensureAttachmentLimit(attachments);

  return {
    text,
    html: embedded.html,
    attachments,
  };
}

export async function forwardRuleMessage({
  ruleId,
  message,
  account,
  imapManager,
  recipient,
}) {
  // An arrival carries its headers: checked first, it needs no database, and a looping copy must
  // not reserve anything. A swept row is checked once the mailbox is known to send at all.
  let loopTokens = message.parsedHeaders ? receivedLoopTokens(message.parsedHeaders) : null;
  if (loopTokens && isForwardLoop(loopTokens, account, ruleId, message)) return 'loop';
  // A turned-off mailbox, or a read-only mail node mailbox (EOP seats design), does not forward. Read
  // fresh: the account object a rule runs with may predate the change.
  const { rows: [state] } = await query(
    'SELECT enabled, mail_node, delete_after, deactivated_at FROM email_accounts WHERE id = $1', [account.id],
  );
  if (isDisabledMailbox(state)) {
    console.warn(`ruleForwarder: rule ${ruleId} not forwarded: the mailbox is disabled`);
    return 'disabled';
  }
  if (isReadOnlyNodeMailbox(state)) {
    console.warn(`ruleForwarder: rule ${ruleId} not forwarded: the mailbox is read-only`);
    return 'read_only';
  }
  if (!loopTokens) {
    loopTokens = await fetchLoopTokens(message, account, imapManager);
    if (isForwardLoop(loopTokens, account, ruleId, message)) return 'loop';
  }
  const reserved = await query(
    `INSERT INTO inbox_rule_forwards (rule_id, message_id)
     VALUES ($1, $2)
     ON CONFLICT (rule_id, message_id) DO NOTHING
     RETURNING id`,
    [ruleId, message.id]
  );
  if (!reserved.rows.length) {
    const existing = await query(
      `SELECT status
       FROM inbox_rule_forwards
       WHERE rule_id = $1 AND message_id = $2`,
      [ruleId, message.id]
    );
    if (existing.rows[0]?.status === 'sent') return 'duplicate';
    throw new Error('Forward delivery pending');
  }

  const reservationId = reserved.rows[0].id;
  let delivered = false;
  try {
    const rowResult = await query(
      `SELECT id, account_id, uid, folder, subject, from_name, from_email,
              to_addresses, cc_addresses, date, body_text, body_html, attachments
       FROM messages
       WHERE id = $1 AND account_id = $2`,
      [message.id, account.id]
    );
    if (!rowResult.rows.length) {
      throw new Error('Forward source message not found');
    }
    const row = rowResult.rows[0];

    const content = await loadForwardContent({ row, account, imapManager });
    const mailOptions = buildForwardMessage({
      row,
      account,
      recipient,
      loopTokens,
      ...content,
    });

    const sendTransport = await createAccountSendTransport(account);
    if (sendTransport.error) throw new Error(sendTransport.error);
    if (!sendTransport.transport) throw new Error('Mail transport is unavailable');

    try {
      await sendTransport.transport.sendMail(mailOptions);
    } catch (sendErr) {
      // A definite failure (the server rejected it, or refused the connection outright) never
      // delivered anything — safe to drop the reservation below and let the rule retry this
      // message on its next match. Anything else (a connection break with no reply, or a Gmail
      // API timeout with no result — see services/mailSendTransport.js) is uncertain: the
      // message may already be on its way, so `.definite = false` keeps the reservation and
      // stops a retry from sending a second copy.
      const definite = sendFailureIsDefinite(sendErr);
      throw Object.assign(new Error(definite ? 'Forward delivery failed' : 'Forward delivery uncertain — leaving it pending to avoid a duplicate'), {
        cause: sendErr,
        definite,
      });
    }
    delivered = true;
    await query(
      `UPDATE inbox_rule_forwards
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1`,
      [reservationId]
    );
    return 'sent';
  } catch (err) {
    // err.definite === false marks the one uncertain case above: leave the reservation pending
    // (it blocks this rule+message pair forever, which is correct — the message may already be
    // sent) rather than deleting it and letting the tick retry into a possible duplicate. Every
    // other failure — including every failure that happens before a send is even attempted —
    // never delivered anything, so it is always safe to delete and retry.
    if (!delivered && err.definite !== false) {
      await query(
        `DELETE FROM inbox_rule_forwards
         WHERE id = $1 AND status = 'pending'`,
        [reservationId]
      ).catch(() => {});
    }
    throw err;
  }
}
