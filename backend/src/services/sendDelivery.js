// Hands a built letter to the mail server and does what follows a send: the journal's message.sent,
// learning the recipients as contacts, the Sent copy and its sync. Runs from the send_message job
// (services/sendQueue.js) when the undo window or the scheduled time has passed; routes/send.js
// builds the letter beforehand.
//
// Failures are thrown as JobError with the outcome the queue applies (services/jobQueue.js):
//   retry           certainly nothing was delivered and trying again may work (a 4xx reply, the
//                   server unreachable, an OAuth refresh that failed for a moment)
//   fail            certainly nothing was delivered and trying again will not help (a 5xx reply,
//                   rejected credentials, an account that needs reconnecting)
//   needs_attention the connection broke after the letter may have been accepted: never resent
//                   automatically, the author decides
// The message is safe to show the author: never a server's raw reply or internal detail.
import nodemailer from 'nodemailer';
import { createHash, randomUUID } from 'crypto';
import { query } from './db.js';
import { redactEmail } from '../utils/redact.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { generateVCard } from '../utils/vcard.js';
import { defaultAddressBookId } from './addressBooks.js';
import { recordAudit } from './auditLog.js';
import { createAccountSendTransport } from './mailSendTransport.js';
import { gmailThreadIdFromProviderThreadId } from './gmailApiSender.js';
import { pluginRegistry } from '../plugins/registry.js';
import { OAUTH_SEND_FAILURES } from './oauth/constants.js';
import { smtpFailureIsDefinite, sendFailureIsDefinite, smtpConnectionFailure } from './smtpErrors.js';
import { JobError } from './jobQueue.js';
import { addressOf, recordOutcomes, trimDiagnostic } from './deliveryStatus.js';
import { statusCodeIn } from './mailNode/deliveryCodes.js';

export function sanitizeSmtpError(err) {
  const msg = err.message || '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (/535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username/i.test(msg)) {
    return 'Authentication failed. Check your email account credentials.';
  }
  if (/throttl|rate.?limit|too many|4\.2\.|4\.7\.94/i.test(msg)) {
    return 'The mail server is rate limiting sends. Please try again shortly.';
  }
  if (/550|5\.[13]\.|reject|blacklist|spam|not.?accept/i.test(msg)) {
    return 'Message was rejected by the mail server.';
  }
  if (/TLS|SSL|certificate|handshake/i.test(msg)) {
    return 'Secure connection to the mail server failed. Check your TLS settings.';
  }
  return 'Failed to send message. Please try again.';
}

// Extract name and email from an RFC 5322 address string.
// Handles "Name <email>", "Name<email>", bare "<email>", and bare "email" forms.
export function parseAddress(str) {
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}

function mapRecipientList(list) {
  return (list || []).map(addr => parseAddress(addr));
}

function scheduleSentMetadataUpsert(imapManager, account, sentFolder, mailOptions, meta) {
  if (!sentFolder || !mailOptions.messageId) return;
  setImmediate(async () => {
    for (const delay of [3000, 10000, 20000]) {
      await new Promise(r => setTimeout(r, delay));
      try {
        const uid = await imapManager.findUidByMessageId(account, sentFolder, mailOptions.messageId);
        if (uid) {
          await imapManager.upsertSentMessageRecord(account, sentFolder, uid, meta);
          return;
        }
      } catch (err) {
        console.warn('Post-send sent metadata upsert failed:', err.message);
      }
    }
  });
}

// Auto-learn sent recipients so they rank above inbound-only senders in autocomplete.
// Fire-and-forget — a DB error here must never affect the send.
function learnRecipients(allRecipients) {
  if (!allRecipients.length) return;
  const now = new Date();
  setImmediate(async () => {
    try {
      const addressBookId = await defaultAddressBookId();

      const results = await Promise.allSettled(allRecipients.map(addr => {
        const { name, email } = parseAddress(addr);
        if (!email) return Promise.resolve();
        const primaryEmail = email.toLowerCase();
        const displayName = name || primaryEmail;
        const uid    = randomUUID();
        const emails = [{ value: primaryEmail, type: 'other', primary: true }];
        const vcard  = generateVCard({ uid, displayName, emails });
        const etag   = createHash('md5').update(vcard).digest('hex');
        // Upsert by (address book, primary_email) — bump send_count and promote from is_auto.
        // On conflict, preserve an existing vcard; only fill it in if the row had none.
        return query(`
          INSERT INTO contacts (
            address_book_id, uid, vcard, etag,
            display_name, primary_email, emails, is_auto, send_count, last_sent
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, 1, $8)
          ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE
            SET send_count   = contacts.send_count + 1,
                last_sent    = $8,
                is_auto      = false,
                display_name = CASE WHEN contacts.is_auto THEN $5 ELSE contacts.display_name END,
                vcard        = COALESCE(contacts.vcard, EXCLUDED.vcard),
                etag         = COALESCE(contacts.etag,  EXCLUDED.etag),
                updated_at   = NOW()
        `, [addressBookId, uid, vcard, etag, displayName, primaryEmail, JSON.stringify(emails), now]);
      }));

      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) console.warn('Contact upsert errors:', failed.map(r => r.reason?.message));
    } catch (err) {
      console.warn('Contact upsert setup error:', err.message);
    }
  });
}

// The recipients the outgoing server refused at RCPT while it took the letter for the others
// (upstream maathimself/mailflow#518). Nodemailer resolves such a send with info.rejected (the
// addresses) and info.rejectedErrors (one error per refusal: .recipient, .response, .responseCode)
// instead of failing it; refusing every recipient throws (EENVELOPE) and is a failed send.
// Resolves [{ recipient, statusCode, diagnostic, responseCode }]: recipient lower case,
// statusCode the enhanced status code of the reply ("5.1.1") or else its basic code ("550"),
// diagnostic the server's reply. Exported for tests.
export function refusedRecipients(info) {
  const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
  const errors = Array.isArray(info?.rejectedErrors) ? info.rejectedErrors : [];
  const out = [];
  const seen = new Set();
  for (const value of rejected) {
    const recipient = addressOf(typeof value === 'string' ? value : value?.address);
    if (!recipient || seen.has(recipient)) continue;
    seen.add(recipient);
    const err = errors.find(e => addressOf(e?.recipient) === recipient) ?? null;
    const reply = trimDiagnostic(err?.response);
    const responseCode = Number.isInteger(err?.responseCode) ? err.responseCode : null;
    out.push({
      recipient,
      statusCode: statusCodeIn(reply) ?? (responseCode ? String(responseCode) : null),
      diagnostic: reply,
      responseCode,
    });
  }
  return out;
}

// Records the refusals in the letter's delivery status (R-17, services/deliveryStatus.js) as failed
// for those recipients, with the server's reply. Never rejects: the letter went out to the others.
async function recordRefusals(accountId, messageId, refused, at) {
  if (!refused.length || !messageId) return;
  try {
    await recordOutcomes(accountId, messageId, 'submission', refused.map(r => ({
      recipient: r.recipient,
      state: 'failed',
      at,
      statusCode: r.statusCode,
      diagnostic: r.diagnostic,
      details: { reply: r.diagnostic, responseCode: r.responseCode },
    })));
  } catch (err) {
    console.error('Recording the refused recipients of a sent letter failed:', err.message);
  }
}

// A transport that could not be set up (createAccountSendTransport's { status, error, code }):
// nothing was sent. An OAuth refresh that failed for a moment is retried; the rest needs someone.
function setupFailure(result) {
  const outcome = result.code === 'oauth_refresh_failed' || result.status === 503 ? 'retry' : 'fail';
  return new JobError(result.error || 'The mailbox could not send mail.', { outcome, code: result.code || 'send_setup_failed' });
}

// Classifies a failed transport.sendMail (see the header). Exported for tests.
export function deliveryFailure(err, account) {
  if (Object.hasOwn(OAUTH_SEND_FAILURES, err?.code)) {
    const failure = OAUTH_SEND_FAILURES[err.code];
    return new JobError(failure.error, { outcome: err.code === 'oauth_refresh_failed' ? 'retry' : 'fail', code: err.code });
  }
  // A classified Gmail API rejection, or the SMTP transport setup failing while falling back from
  // the API (services/mailSendTransport.js sets .definite/.status/.code on these).
  if (err?.definite === true && typeof err?.status === 'number') {
    const transient = err.code === 'gmail_quota_exceeded' || err.status === 429;
    return new JobError(err.message, { outcome: transient ? 'retry' : 'fail', code: err.code || 'send_rejected' });
  }
  if (!sendFailureIsDefinite(err)) {
    return new JobError(
      'The connection to the mail server broke while sending. The message may have been delivered: check Sent before sending it again.',
      { outcome: 'needs_attention', code: 'send_uncertain' }
    );
  }
  const connection = smtpConnectionFailure(err, account);
  if (connection) return new JobError(connection.error, { outcome: 'retry', code: 'smtp_connection_failed' });
  const responseCode = Number(err?.responseCode);
  // A 4xx reply is the server saying "not now": greylisting, a rate limit, a full queue.
  if (responseCode >= 400 && responseCode < 500) {
    return new JobError(sanitizeSmtpError(err), { outcome: 'retry', code: 'smtp_temporary' });
  }
  if (err?.code === 'EAUTH') return new JobError(sanitizeSmtpError(err), { outcome: 'fail', code: 'smtp_auth_failed' });
  // Unreachable or refusing server without nodemailer's connection codes: still pre-delivery.
  if (smtpFailureIsDefinite(err) && !Number.isInteger(responseCode)) {
    return new JobError(sanitizeSmtpError(err), { outcome: 'retry', code: 'smtp_connection_failed' });
  }
  return new JobError(sanitizeSmtpError(err), { outcome: 'fail', code: 'smtp_rejected' });
}

const GMAIL_IMAP_HOSTS = new Set(['imap.gmail.com', 'imap.googlemail.com']);
const GMAIL_SMTP_HOSTS = new Set(['smtp.gmail.com', 'smtp.googlemail.com']);

// Whether the mail server files the Sent copy itself, so the panel must not APPEND one. OAuth
// providers (Gmail, Microsoft) do. So does Gmail added with manual IMAP/SMTP settings: a letter
// sent through Gmail's own SMTP server lands in that Gmail mailbox's Sent (support.google.com/mail
// /answer/78892), and an APPEND would at best duplicate it. Matched by exact host: the Workspace
// relay (smtp-relay.gmail.com) files nothing, nor does Gmail SMTP for a mailbox kept elsewhere.
export function serverSavesSentCopy(account) {
  if (account?.oauth_provider) return true;
  const host = (value) => String(value ?? '').trim().toLowerCase();
  return GMAIL_IMAP_HOSTS.has(host(account?.imap_host)) && GMAIL_SMTP_HOSTS.has(host(account?.smtp_host));
}

// Sends the letter. mail: { options, meta } as routes/send.js built it (options: nodemailer
// options with Buffer attachments; meta: normalized to/cc/bcc, subject, fromName, fromEmail,
// snippet). actorUserId: the author, journaled as the sender. markEffectStarted: called right
// before the letter goes to the mail server. onDelivered(messageId, { rejected }): called once the
// server took the letter, before anything else (the job records itself done there); its failure
// never turns a delivered letter into a failed send. rejected: the addresses the server refused at
// RCPT while it took the letter for the others (refusedRecipients), [] for none. Resolves
// { messageId, rejected, sentFolder, sentCopySaved }; with detachPostSend, resolves
// { messageId, rejected, postSend } as soon as the server took the letter, postSend
// being the Sent copy work (a promise of { sentFolder, sentCopySaved } that never rejects), so the
// caller (a queue worker slot) is free before the up to 20 s APPEND.
export async function deliverOutgoingMessage({
  account: inputAccount, mail, actorUserId, imapManager, markEffectStarted = async () => {}, onDelivered = async () => {},
  detachPostSend = false,
}) {
  const mailOptions = { ...mail.options };
  const meta = mail.meta;

  const sendTransport = await createAccountSendTransport(inputAccount);
  if (sendTransport.error) throw setupFailure(sendTransport);
  const account = sendTransport.account;
  const transport = sendTransport.transport;

  // Gmail API threading: when replying, look up the original's X-GM-THRID (stored decimal, see
  // services/threading/providerIds.js) and convert it to the hex form the API's `threadId`
  // expects. Only meaningful for a Gmail mailbox; ignored by the SMTP path and by the fallback.
  // message_id is stored with or without angle brackets depending on the ingest path (see
  // gtdTransitions.js's runTransitionsForSentMessage and mailAccess.js's
  // getThreadKeysForMessageIdHeaders), so both forms are matched here too.
  let threadId = null;
  if (mailOptions.inReplyTo && account.oauth_provider === 'google') {
    const repliedToId = mailOptions.inReplyTo.replace(/[<>]/g, '').trim();
    const threadRow = await query(
      `SELECT provider_thread_id FROM messages
        WHERE account_id = $1 AND message_id = ANY($2::text[]) AND provider_thread_id IS NOT NULL LIMIT 1`,
      [account.id, [repliedToId, `<${repliedToId}>`]]
    );
    threadId = gmailThreadIdFromProviderThreadId(threadRow.rows[0]?.provider_thread_id ?? null);
  }

  // A server that saves the Sent copy itself: skip APPEND and sync after a delay. All other
  // accounts use direct IMAP APPEND so sent mail reliably appears regardless of what the SMTP
  // server does.
  const serverAutoSaves = serverSavesSentCopy(account);

  // For servers that don't auto-save, generate the raw MIME now so we can APPEND it.
  // Use CRLF newlines ('windows'): RFC 5322 / IMAP APPEND require CRLF. A bare-LF message is
  // stored verbatim by strict servers (e.g. PurelyMail/Dovecot), and downstream clients then
  // mis-parse the headers — the reporter saw Subject and the To display-name dropped (#365). This
  // only affects accounts whose server does not auto-save (those skip this path); the SMTP-
  // delivered copy uses a separate transport that is already CRLF, so only the Sent copy was wrong.
  let rawMessage = null;
  if (!serverAutoSaves) {
    const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
    const streamInfo = await streamTransport.sendMail(mailOptions);
    const chunks = [];
    await new Promise((resolve, reject) => {
      streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      streamInfo.message.on('end', resolve);
      streamInfo.message.on('error', reject);
    });
    rawMessage = Buffer.concat(chunks);
  }

  await markEffectStarted();
  let sendInfo;
  try {
    sendInfo = await transport.sendMail(mailOptions, { threadId });
  } catch (err) {
    // A connection/handshake failure never reached AUTH, so it always names the account's own
    // configured host — safe (and useful) to log.
    const connectionFailure = smtpConnectionFailure(err, account);
    if (connectionFailure) {
      console.error(`Send failed: ${err.message} [${connectionFailure.code}=${connectionFailure.reason} target=${connectionFailure.host}:${connectionFailure.port}]`);
    } else {
      console.error('Send failed:', err.message);
    }
    throw deliveryFailure(err, account);
  }

  // Delivered. Nothing below may report the send as failed.
  // The Gmail API path normally keeps our own Message-ID (it sends the raw message as-is), but
  // when it differs — verified via a post-send metadata GET, see gmailApiSender.js — adopt
  // Gmail's id so the Sent-row reconciliation below (by Message-ID) actually finds the copy.
  if (sendInfo?.messageId && sendInfo.messageId !== mailOptions.messageId) {
    mailOptions.messageId = sendInfo.messageId;
  }
  const refused = refusedRecipients(sendInfo);
  const rejected = refused.map(r => r.recipient);
  if (refused.length) {
    // Codes only: the server's reply usually repeats the address unredacted.
    const codes = refused.map(r => r.statusCode).filter(Boolean);
    console.warn(`SMTP refused ${refused.length} recipient(s) for ${redactEmail(account.email_address)}: ${rejected.map(redactEmail).join(', ')}${codes.length ? ` (${codes.join(', ')})` : ''}`);
  }
  try {
    await onDelivered(mailOptions.messageId, { rejected });
  } catch (err) {
    console.error('Recording a delivered send failed:', err.message);
  }
  // Journal the accepted message by its Message-ID and recipients; never its subject or body.
  recordAudit({
    actorUserId,
    accountId: account.id,
    action: 'message.sent',
    details: { messageId: mailOptions.messageId, to: meta.to, cc: meta.cc, bcc: meta.bcc },
  });

  // A refused address is not learned as one the author writes to.
  const refusedSet = new Set(rejected);
  learnRecipients([...meta.to, ...meta.cc, ...meta.bcc].filter(addr => !refusedSet.has(addressOf(addr))));
  await recordRefusals(account.id, mailOptions.messageId, refused, new Date().toISOString());

  const postSend = saveSentCopy({ account, mailOptions, meta, rawMessage, serverAutoSaves, imapManager });
  if (detachPostSend) return { messageId: mailOptions.messageId, rejected, postSend };
  return { messageId: mailOptions.messageId, rejected, ...(await postSend) };
}

// The Sent copy after a delivered send: APPEND it (a server that does not save it itself) or seed
// its row once the server shows it, then sync Sent. Resolves { sentFolder, sentCopySaved }; never
// rejects.
async function saveSentCopy({ account, mailOptions, meta, rawMessage, serverAutoSaves, imapManager }) {
  let sentFolder = null;
  // sentCopySaved: null = not applicable (server auto-saves, or no Sent folder resolved);
  // true/false = whether OUR IMAP APPEND landed the Sent copy.
  let sentCopySaved = null;
  try {
    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect,
    // but a mapping pointing at a non-selectable folder is ignored in favour of \Sent — #386).
    sentFolder = await resolveSentFolder(account.id, account.folder_mappings);
    console.log(`Post-send: ${redactEmail(account.email_address)} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

    const sentMeta = sentFolder ? {
      messageId: mailOptions.messageId,
      subject: meta.subject,
      fromName: meta.fromName,
      fromEmail: meta.fromEmail,
      to: mapRecipientList(meta.to),
      cc: mapRecipientList(meta.cc),
      snippet: meta.snippet,
      date: new Date(),
      // Carried so the Sent row threads into its conversation via the References chain
      // rather than orphaning at its own Message-ID (#378).
      inReplyTo: mailOptions.inReplyTo || null,
      references: mailOptions.references || null,
    } : null;

    if (sentFolder) {
      if (rawMessage) {
        // Non-auto-saving account: APPEND the Sent copy ourselves — exactly ONCE. IMAP
        // APPEND is NOT idempotent (unlike a \Seen flag), so we must not retry: a retry
        // whose first attempt merely timed out (but still lands on the server) would store
        // a SECOND copy. Bound the wait so a stalled connection can't hang the job;
        // the abandoned append can at worst still save the single copy. On failure, tell
        // the author and schedule a fallback sync in case the append landed late. Audit [2].
        sentCopySaved = false;
        try {
          const { uid } = await Promise.race([
            imapManager.appendToSent(account, sentFolder, rawMessage),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Sent APPEND timed out')), 20000)),
          ]);
          sentCopySaved = true;
          if (uid && sentMeta) {
            await imapManager.upsertSentMessageRecord(account, sentFolder, uid, sentMeta)
              .catch(err => console.warn('Sent metadata upsert failed:', err.message));
          }
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder, { background: true })
              // Once the Sent copy is in the DB, notify label plugins the message synced: GTD
              // re-runs transitions for its thread (a reply to a Todo/Someday thread means the
              // owner acted, so that label should drop). The sent message reaches no other hook
              // (Sent isn't INBOX, and the tick watches only the state folders), so this is the
              // only trigger. The hook swallows per-plugin errors — the next inbound sync / tick
              // self-heals.
              .then(() => pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId }))
              .catch(e => console.error(`Post-append sync failed: ${e.message}`));
          }, 1000);
        } catch (appendErr) {
          console.error(`IMAP append to Sent failed for ${redactEmail(account.email_address)}/${sentFolder}: ${appendErr.message}`);
          // The append may still have landed (or land shortly) — pull the folder so a
          // late-completing append self-corrects the DB rather than staying invisible.
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder, { background: true })
              .catch(e => console.error(`Post-append fallback sync failed: ${e.message}`));
          }, 8000);
        }
      } else {
        // Server auto-saves via SMTP; seed metadata once the Sent copy is searchable.
        if (sentMeta) scheduleSentMetadataUpsert(imapManager, account, sentFolder, mailOptions, sentMeta);
        // Server auto-saves via SMTP; just sync after a delay. Two attempts because the
        // provider (e.g. Gmail) can be slow to expose the sent message; the 3s pass usually
        // catches it, the 15s pass is the safety net. GTD transitions run after each: the 3s
        // attempt may miss (Sent copy not yet visible → empty thread set → no-op) and the 15s
        // attempt then catches it; if 3s already stripped, 15s is an idempotent no-op.
        const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder, { background: true })
          .then(() => {
            console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`);
            return pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId });
          })
          .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
        setTimeout(() => syncAttempt('3s'), 3000);
        setTimeout(() => syncAttempt('15s'), 15000);
      }
    }
  } catch (err) {
    // The server accepted the letter. A Sent-folder or metadata failure must not invite the
    // author to send it again.
    console.error('Post-send processing failed:', err.message);
    sentCopySaved = false;
  }
  return { sentFolder, sentCopySaved };
}
