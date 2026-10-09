import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// forwardRuleMessage must go through the shared createAccountSendTransport (services/
// mailSendTransport.js) rather than talking to SMTP directly — that is what makes a rule forward
// from a Gmail mailbox use the Gmail API. ruleForwarder.test.js mocks smtpTransport.js directly
// and exercises the definite/uncertain reservation logic in depth; this file only confirms the
// wiring: a Gmail account's forward is handed to createAccountSendTransport, and its transport
// (which may itself be a Gmail-API-then-SMTP-fallback transport) is what actually sends.
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./mailSendTransport.js', () => ({ createAccountSendTransport: vi.fn() }));

import { query } from './db.js';
import { createAccountSendTransport } from './mailSendTransport.js';
import { forwardRuleMessage } from './ruleForwarder.js';
import { buildRawMessage } from './gmailApiSender.js';
import { parseRawHeaders } from './messageParser.js';

// The loop token is keyed with a key derived from ENCRYPTION_KEY, which index.js requires.
beforeEach(() => { vi.stubEnv('ENCRYPTION_KEY', 'a1'.repeat(32)); });
afterEach(() => { vi.unstubAllEnvs(); });

const account = {
  id: 'account-1', sender_name: 'Mailbox', email_address: 'mailbox@example.com', oauth_provider: 'google',
};
const messageRow = {
  id: 'message-1', account_id: account.id, uid: 42, folder: 'INBOX', subject: 'Quarterly review',
  from_name: 'Example Sender', from_email: 'sender@example.com',
  to_addresses: [{ address: 'team@example.com' }], cc_addresses: [], date: '2026-07-29T12:00:00.000Z',
  body_text: 'Original body', body_html: '<p>Original body</p>', attachments: [],
};

describe('forwardRuleMessage on a Gmail mailbox', () => {
  let transport, imapManager, input;
  beforeEach(() => {
    vi.clearAllMocks();
    transport = { sendMail: vi.fn().mockResolvedValue({ via: 'api', messageId: '<fwd@gmail.com>' }) };
    createAccountSendTransport.mockResolvedValue({ account, transport });
    imapManager = {
      fetchHeaders: vi.fn(async () => 'Subject: Quarterly review'),
      fetchMessageBody: vi.fn(),
      fetchMultipleAttachments: vi.fn().mockResolvedValue(new Map()),
      moveQueue: { serverLocation: vi.fn(async (row) => ({ folder: row.folder, uid: Number(row.uid) })) },
    };
    input = { ruleId: 'rule-1', message: { id: messageRow.id }, account, imapManager, recipient: 'recipient@example.com' };
    query
      // The mailbox's fresh state: it may send.
      .mockResolvedValueOnce({ rows: [{ enabled: true, mail_node: false, delete_after: null, deactivated_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it('sends the forward through createAccountSendTransport, not a direct SMTP transport', async () => {
    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(createAccountSendTransport).toHaveBeenCalledWith(account);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  // The Gmail API path builds the raw message from the same mailOptions with MailComposer, so the
  // loop header must survive that build too, or a loop through a Gmail mailbox never stops.
  it('carries the loop header in the raw message the Gmail API sends', async () => {
    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    const mailOptions = transport.sendMail.mock.calls[0][0];
    expect(mailOptions.headers['X-MailExpert-Loop']).toMatch(/^[0-9a-f]{16}$/);

    const raw = (await buildRawMessage(mailOptions)).toString();
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(parseRawHeaders(headerBlock)['x-mailexpert-loop']).toBe(mailOptions.headers['X-MailExpert-Loop']);
  });

  it('a forward from a Gmail mailbox that comes back is stopped like any other', async () => {
    await forwardRuleMessage(input);
    const token = transport.sendMail.mock.calls[0][0].headers['X-MailExpert-Loop'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(forwardRuleMessage({
        ...input, message: { id: 'message-2', parsedHeaders: parseRawHeaders(`X-MailExpert-Loop: ${token}`) },
      })).resolves.toBe('loop');
      expect(transport.sendMail).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
