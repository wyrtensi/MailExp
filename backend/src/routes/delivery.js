import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { MailNodeError, getMailNodeConfig } from '../services/mailNode/mailcow.js';
import { getEopSettings } from '../services/mailNode/eopSettings.js';
import { readPostfixLog } from '../services/mailNode/postfixLog.js';
import {
  captureLetter, logCoverage, presentOutcome, readOutcomes, sentAtOf,
} from '../services/deliveryStatus.js';
import { onOtherMailHost } from './mailNode.js';

// "Delivery details" of a letter (R-17; services/deliveryStatus.js), mounted at /api/mail: for
// anyone who can open the letter (every mailbox is shared by all users of the install), what
// became of it per recipient. The server finds everything from the letter itself: its mailbox and
// Message-ID, then, for a mailbox on the mail node, the queue entries of that Message-ID queued by
// the mailbox in the node's Postfix log (the shared cached read of services/mailNode/postfixLog.js).
// No queue id or log line is taken from the client, and none is answered: only this letter's
// stored outcomes. Other mailboxes get the marks of delivery reports only.
const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

router.get('/messages/:id/delivery', async (req, res) => {
  const { rows } = await query(
    `SELECT m.message_id, m.date, a.id AS account_id, a.mail_node, a.imap_host
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND m.is_deleted = false`,
    [req.params.id],
  );
  const letter = rows[0];
  if (!letter) return res.status(404).json({ error: 'Message not found', code: 'message_not_found' });
  if (!letter.message_id) return res.json({ messageId: null, node: false, log: null, recipients: [] });

  const cfg = letter.mail_node ? await getMailNodeConfig() : null;
  const node = !!cfg && !onOtherMailHost(letter, cfg);
  let read = null;
  let found = false;
  let error = null;
  if (node) {
    try {
      const { eopHost } = await getEopSettings();
      read = await readPostfixLog(cfg);
      ({ found } = await captureLetter({ accountId: letter.account_id, messageId: letter.message_id, log: read, eopHost }));
    } catch (err) {
      if (!(err instanceof MailNodeError)) throw err;
      error = err.code;
    }
  }

  const outcomes = await readOutcomes(letter.account_id, letter.message_id);
  let log = null;
  if (node) {
    const stored = outcomes.some((outcome) => outcome.log);
    const sentAt = await sentAtOf(letter.account_id, letter.message_id, letter.date);
    log = {
      coverage: error ? (stored ? 'stored' : 'unavailable') : logCoverage({ found, stored, sentAt, oldestAt: read.oldestAt }),
      error,
      oldestAt: read?.oldestAt ?? null,
      sentAt,
    };
  }
  res.json({ messageId: letter.message_id, node, log, recipients: outcomes.map(presentOutcome) });
});

export default router;
