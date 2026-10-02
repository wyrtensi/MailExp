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
  res.json({ messageId: letter.message_id, owned: true, node, log, recipients: outcomes.map((row) => presentOutcome(row)) });
});

export default router;
