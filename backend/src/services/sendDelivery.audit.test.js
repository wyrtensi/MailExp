import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deliverOutgoingMessage } from './sendDelivery.js';

// oauth_provider is 'microsoft' (non-Gmail OAuth) so this exercises serverAutoSaves without the
// Gmail-API send path — sendDelivery.gmailApiWiring.test.js covers the Gmail-specific behavior.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'microsoft' };
const sendMail = vi.fn();
let errorSpy;
beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO mailbox_audit_log')) throw Object.assign(new Error('journal down'), { code: '57P01' });
    return { rows: [{ id: 'book1' }] };
  });
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
afterEach(() => { errorSpy.mockRestore(); });

const auditInsert = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mailbox_audit_log'));
const deliver = () => deliverOutgoingMessage({
  account,
  actorUserId: 'u1',
  imapManager: { syncFolderOnDemand: vi.fn(async () => {}), findUidByMessageId: vi.fn(async () => null) },
  mail: {
    options: {
      messageId: '<m1@example.com>', from: 'Me <me@example.com>', to: 'you@example.com', cc: 'cc@example.com',
      bcc: 'hidden@example.com', subject: 'Quarterly numbers', text: 'Confidential body text',
    },
    meta: {
      to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'],
      subject: 'Quarterly numbers', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Confidential body text',
    },
  },
});

describe('sending is journaled', () => {
  it('records the accepted message as its author sent it, without subject or body, and a journal failure keeps the send successful', async () => {
    await expect(deliver()).resolves.toMatchObject({ messageId: '<m1@example.com>' });
    await vi.waitFor(() => expect(auditInsert()).toBeTruthy());
    const [, [payload]] = auditInsert();
    expect(JSON.parse(payload)).toEqual([{
      actor_user_id: 'u1', actor_email: null, account_id: 'a1', account_email: null, action: 'message.sent',
      details: {
        messageId: '<m1@example.com>',
        to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['hidden@example.com'],
      },
    }]);
    expect(payload).not.toMatch(/Quarterly numbers|Confidential body text/);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('[audit] Failed to record entries:', '57P01'));
  });

  it('records nothing when the SMTP server rejects the message', async () => {
    sendMail.mockRejectedValueOnce(new Error('550 rejected'));
    await expect(deliver()).rejects.toThrow();
    expect(auditInsert()).toBeUndefined();
  });
});
