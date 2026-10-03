import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { MailNodeError, getMailNodeConfig } from '../services/mailNode/mailcow.js';
import { getEopSettings } from '../services/mailNode/eopSettings.js';
import { readPostfixLog } from '../services/mailNode/postfixLog.js';
import {
  captureLetter, logCoverage, presentOutcome, readOutcomes, sentLetterOf,
} from '../services/deliveryStatus.js';
import { onOtherMailHost } from './mailNode.js';
import { recordAudit } from '../services/auditLog.js';
import { resolveTraceSource } from '../services/mailNode/traceSource.js';
import {
  presentTrace, readTrace, requestTrace, traceableLetter,
} from '../services/tenant/messageTrace.js';

// "Delivery details" of a letter (R-17; services/deliveryStatus.js), mounted at /api/mail: for
// anyone who can open the letter (every mailbox is shared by all users of the install), what
// became of it per recipient. Only for a letter its mailbox sent (the journal's message.sent, or a
// copy in its Sent folder from its own login address): any other letter answers owned: false and
// nothing else, whatever aliases the mailbox has. The server finds everything from the letter
// itself: its mailbox and Message-ID, then, for a mailbox on the mail node, the queue entries the
// mailbox queued with that Message-ID in the node's Postfix log (the shared cached read of
// services/mailNode/postfixLog.js). No queue id or log line is taken from the client, and none is
// answered: only this letter's stored outcomes. Other mailboxes get the marks of delivery reports.
// A log that cannot be read, or a failure while looking the letter up in it, leaves the stored
// outcomes and says the log was unavailable.
const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

router.get('/messages/:id/delivery', async (req, res) => {
  const { rows } = await query(
    `SELECT m.message_id, a.id AS account_id, a.email_address, a.mail_node, a.imap_host
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND m.is_deleted = false`,
    [req.params.id],
  );
  const letter = rows[0];
  if (!letter) return res.status(404).json({ error: 'Message not found', code: 'message_not_found' });
  const empty = { messageId: letter.message_id ?? null, owned: false, node: false, log: null, recipients: [] };
  if (!letter.message_id) return res.json(empty);
  const sent = await sentLetterOf(letter.account_id, letter.message_id);
  if (!sent.owned) return res.json(empty);

  const cfg = letter.mail_node ? await getMailNodeConfig() : null;
  const node = !!cfg && !onOtherMailHost(letter, cfg);
  let read = null;
  let found = false;
  let error = null;
  if (node) {
    try {
      const { eopHost } = await getEopSettings();
      read = await readPostfixLog(cfg);
      ({ found } = await captureLetter({
        accountId: letter.account_id, login: letter.email_address, messageId: letter.message_id, log: read, eopHost,
      }));
    } catch (err) {
      if (!(err instanceof MailNodeError)) console.error('Delivery details: the node log lookup failed:', err?.code || err?.message || 'error');
      error = err instanceof MailNodeError ? err.code : 'lookup_failed';
    }
  }

  const outcomes = await readOutcomes(letter.account_id, letter.message_id);
  let log = null;
  if (node) {
    const stored = outcomes.some((outcome) => outcome.log);
    log = {
      coverage: error ? (stored ? 'stored' : 'unavailable') : logCoverage({ found, stored, sentAt: sent.sentAt, oldestAt: read.oldestAt }),
      error,
      oldestAt: read?.oldestAt ?? null,
      sentAt: sent.sentAt,
    };
  }
  // R-30: what Microsoft's trace said, when it was asked (or can be). Only for the node's letters.
  let eopTrace = null;
  if (node) {
    const connected = !!(await resolveTraceSource().catch(() => null));
    const traceable = traceableLetter({ sentAt: sent.sentAt });
    eopTrace = {
      available: connected && traceable.ok,
      reason: !connected ? 'trace_not_connected' : (traceable.ok ? null : traceable.code),
      trace: presentTrace(await readTrace(letter.account_id, letter.message_id)),
    };
  }
  res.json({
    messageId: letter.message_id, owned: true, node, log, recipients: outcomes.map((row) => presentOutcome(row)), eopTrace,
  });
});

// R-30: "Ask Microsoft's message trace" for a letter the node mailbox sent. Queues the trace job
// (services/tenant/messageTrace.js) and answers the stored trace at once (202 when a job was
// queued); the screen asks GET .../delivery again until the trace is done or failed. A letter
// traced less than five minutes ago answers its stored trace (200).
const TRACE_REFUSALS = {
  message_not_found: [404, 'Message not found'],
  trace_not_sent: [409, 'Only a letter this mailbox sent can be traced'],
  trace_not_node: [409, 'Only a letter of a mailbox on the mail node can be traced'],
  trace_not_connected: [409, 'The message trace of the Microsoft tenant is not connected'],
  trace_sent_at_unknown: [409, 'When the letter was sent is not known'],
  trace_too_old: [409, 'Microsoft keeps the message trace for 90 days'],
};
const refuseTrace = (res, code) => {
  const [status, error] = TRACE_REFUSALS[code];
  return res.status(status).json({ error, code });
};

router.post('/messages/:id/eop-trace', async (req, res) => {
  const { rows } = await query(
    `SELECT m.message_id, a.id AS account_id, a.email_address, a.mail_node, a.imap_host
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND m.is_deleted = false`,
    [req.params.id],
  );
  const letter = rows[0];
  if (!letter) return refuseTrace(res, 'message_not_found');
  if (!letter.message_id) return refuseTrace(res, 'trace_not_sent');
  const sent = await sentLetterOf(letter.account_id, letter.message_id);
  if (!sent.owned) return refuseTrace(res, 'trace_not_sent');
  const cfg = letter.mail_node ? await getMailNodeConfig() : null;
  if (!cfg || onOtherMailHost(letter, cfg)) return refuseTrace(res, 'trace_not_node');
  if (!(await resolveTraceSource())) return refuseTrace(res, 'trace_not_connected');
  const traceable = traceableLetter({ sentAt: sent.sentAt });
  if (!traceable.ok) return refuseTrace(res, traceable.code);
  const { trace, queued, cooldownUntil } = await requestTrace({
    accountId: letter.account_id, messageId: letter.message_id, sentAt: sent.sentAt, userId: req.session.userId,
  });
  if (queued) {
    recordAudit({
      actorUserId: req.session.userId, accountId: letter.account_id, action: 'tenant.message_traced', details: { messageId: letter.message_id },
    });
  }
  return res.status(queued ? 202 : 200).json({ queued, cooldownUntil: cooldownUntil ?? null, trace: presentTrace(trace) });
});

export default router;
