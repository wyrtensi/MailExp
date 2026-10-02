import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendDelivery.js's own responsibilities around the Gmail API path: looking up threadId, adopting a
// reconciled Message-ID, and turning a `.definite` mail-send error into the right job outcome.
// The Gmail API mechanics themselves (HTTP, classification, SMTP fallback decisions) are covered
// by services/gmailApiSender.test.js and services/mailSendTransport.test.js — here
// createAccountSendTransport is mocked directly so these tests only exercise sendDelivery.js.
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./mailSendTransport.js', () => ({ createAccountSendTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import { query } from './db.js';
import { recordAudit } from './auditLog.js';
import { createAccountSendTransport } from './mailSendTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deliverOutgoingMessage } from './sendDelivery.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google',
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
const sendMail = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async () => ({ rows: [] }));
  createAccountSendTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({ via: 'api', messageId: undefined });
  resolveSentFolder.mockResolvedValue(null);
});

const deliver = ({ inReplyTo, acct = account } = {}) => deliverOutgoingMessage({
  account: acct,
  actorUserId: 'u1',
  imapManager: { syncFolderOnDemand: vi.fn(async () => {}), findUidByMessageId: vi.fn(async () => null) },
  mail: {
    options: {
      messageId: '<ours@example.com>', from: 'Me <me@example.com>', to: 'you@example.com', subject: 'Test', text: 'Hello',
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
    },
    meta: { to: ['you@example.com'], cc: [], bcc: [], subject: 'Test', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Hello' },
  },
});

describe('Gmail API threadId lookup', () => {
  it('looks up provider_thread_id by the replied-to Message-ID and passes threadId as hex', async () => {
    query.mockImplementation(async sql => (sql.includes('FROM messages') ? { rows: [{ provider_thread_id: '291' }] } : { rows: [] })); // 291 decimal = 123 hex
    await deliver({ inReplyTo: '<original@example.com>' });
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: '123' });
    const threadLookup = query.mock.calls.find(c => c[0].includes('FROM messages'));
    // message_id is stored with or without angle brackets depending on the ingest path — both
    // forms must be queried (see gtdTransitions.js's runTransitionsForSentMessage).
    expect(threadLookup[1]).toEqual([account.id, ['original@example.com', '<original@example.com>']]);
    expect(threadLookup[0]).toMatch(/message_id = ANY\(\$2::text\[\]\)/);
  });

  it('passes threadId: null when no matching message has a stored thread id', async () => {
    await deliver({ inReplyTo: '<unknown@example.com>' });
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: null });
  });

  it('does not query for a thread id when not replying', async () => {
    await deliver();
    expect(query.mock.calls.some(c => c[0].includes('FROM messages'))).toBe(false);
    expect(sendMail).toHaveBeenCalledWith(expect.anything(), { threadId: null });
  });

  it('does not query for a thread id for a non-Gmail account even when replying', async () => {
    const msAccount = { ...account, oauth_provider: 'microsoft' };
    createAccountSendTransport.mockResolvedValue({ account: msAccount, transport: { sendMail } });
    await deliver({ inReplyTo: '<original@example.com>', acct: msAccount });
    expect(query.mock.calls.some(c => c[0].includes('FROM messages'))).toBe(false);
  });
});

describe('Message-ID reconciliation', () => {
  it('adopts the Message-ID the transport reports when it differs from ours', async () => {
    sendMail.mockResolvedValue({ via: 'api', messageId: '<real@gmail.com>' });
    await expect(deliver()).resolves.toMatchObject({ messageId: '<real@gmail.com>' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.sent',
      details: expect.objectContaining({ messageId: '<real@gmail.com>' }),
    }));
  });

  it('keeps our own Message-ID when the transport does not report a different one', async () => {
    sendMail.mockResolvedValue({ via: 'api' });
    await deliver();
    expect(recordAudit.mock.calls[0][0].details.messageId).toBe('<ours@example.com>');
  });
});

describe('a definite mail-send failure', () => {
  it('fails with the transport-supplied code and message', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('One of the recipient addresses was rejected.'), {
      code: 'gmail_invalid_recipient', status: 400, definite: true,
    }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'gmail_invalid_recipient', message: 'One of the recipient addresses was rejected.' });
  });

  it('retries a Gmail quota rejection', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('Gmail sending limit reached.'), {
      code: 'gmail_quota_exceeded', status: 429, definite: true,
    }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'gmail_quota_exceeded' });
  });

  it('treats an uncertain (non-SMTP-shaped, non-.definite) failure as send_uncertain', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'needs_attention', code: 'send_uncertain' });
  });

  it('fails on a fallback SMTP setup failure the same way as a Gmail API rejection', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('SMTP password is corrupted or missing — please re-enter your account password in Settings.'), {
      status: 502, definite: true, mailSendFallbackSetupFailed: true,
    }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', message: expect.stringMatching(/SMTP password is corrupted/) });
  });
});
