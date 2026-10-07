import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
