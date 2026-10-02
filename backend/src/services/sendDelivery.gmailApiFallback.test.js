import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// End-to-end through the REAL services/sendDelivery.js + REAL services/mailSendTransport.js + REAL
// services/gmailApiSender.js, with only `fetch` and the account-lookup/DB-adjacent layers mocked.
// sendDelivery.gmailApiWiring.test.js already covers sendDelivery.js's own logic against a mocked
// createAccountSendTransport; this instead proves that one send job's delivery covers the whole
// Gmail-API-then-SMTP-fallback sequence as ONE delivery, marked as begun once, before the API call.
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn(), oauthRefreshFailureResult: vi.fn() }));
vi.mock('./oauth/tokenManager.js', async () => {
  const actual = await vi.importActual('./oauth/tokenManager.js');
  return { ...actual, ensureFreshOAuthAccount: vi.fn(async (account) => account) };
});
vi.mock('./oauth/googleApps.js', () => ({ markGmailApiDisabled: vi.fn(), clearGmailApiDisabled: vi.fn() }));

import { query } from './db.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { markGmailApiDisabled, clearGmailApiDisabled } from './oauth/googleApps.js';
import { deliverOutgoingMessage } from './sendDelivery.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google',
  oauth_app_id: 'app-1', oauth_access_token: 'plain-access-token', oauth_refresh_token: 'plain-refresh-token',
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};

let fetchMock;
let smtpSendMail;
const markEffectStarted = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async () => ({ rows: [] }));
  resolveSentFolder.mockResolvedValue(null);
  markGmailApiDisabled.mockResolvedValue(undefined);
  clearGmailApiDisabled.mockResolvedValue(undefined);
  smtpSendMail = vi.fn().mockResolvedValue({});
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: smtpSendMail } });
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});
afterEach(() => { delete global.fetch; });

describe('one send covers a real Gmail-API-then-SMTP-fallback delivery', () => {
  it('tries the Gmail API once and falls back to SMTP within the same delivery', async () => {
    // The Gmail API call: Gmail says its API is off for this project (403 accessNotConfigured).
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }),
    });

    const result = await deliverOutgoingMessage({
      account,
      actorUserId: 'u1',
      imapManager: { syncFolderOnDemand: vi.fn(async () => {}), findUidByMessageId: vi.fn(async () => null) },
      markEffectStarted,
      mail: {
        options: { messageId: '<m1@example.com>', from: 'Me <me@example.com>', to: 'you@example.com', subject: 'Test', text: 'Hello' },
        meta: { to: ['you@example.com'], cc: [], bcc: [], subject: 'Test', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Hello' },
      },
    });

    expect(result.messageId).toBe('<m1@example.com>');
    expect(markEffectStarted).toHaveBeenCalledOnce(); // marked once, before the API call
    expect(fetchMock).toHaveBeenCalledTimes(1); // one Gmail API attempt, no fallback retry loop
    expect(smtpSendMail).toHaveBeenCalledTimes(1); // exactly one SMTP delivery
    expect(markGmailApiDisabled).toHaveBeenCalledWith('app-1');
  });
});
