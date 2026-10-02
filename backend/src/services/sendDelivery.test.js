import { describe, it, expect, vi, beforeEach } from 'vitest';

// What becomes of a send job when the mail server answers: delivered, retried (certainly nothing
// was delivered and it may pass), failed (certainly nothing was delivered, and it will not pass), or
// needs attention (the letter may have been accepted). The send queue applies the outcome
// (services/jobQueue.js); here the transport is a mock.
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deliverOutgoingMessage } from './sendDelivery.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'microsoft', // non-Gmail OAuth: exercises serverAutoSaves without the Gmail-API send path
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
const sendMail = vi.fn();
const markEffectStarted = vi.fn(async () => {});
const onDelivered = vi.fn(async () => {});
const imapManager = { syncFolderOnDemand: vi.fn(async () => {}), findUidByMessageId: vi.fn(async () => null) };

const mail = (recipients = { to: ['you@example.com'] }) => {
  const to = recipients.to ?? [];
  const cc = recipients.cc ?? [];
  const bcc = recipients.bcc ?? [];
  return {
    options: {
      messageId: '<m1@example.com>', from: 'Me <me@example.com>',
      to: to.join(', ') || undefined, cc: cc.join(', ') || undefined, bcc: bcc.join(', ') || undefined,
      subject: 'Test', text: 'Hello',
    },
    meta: { to, cc, bcc, subject: 'Test', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Hello' },
  };
};
const deliver = (recipients) => deliverOutgoingMessage({ account, mail: mail(recipients), actorUserId: 'u1', imapManager, markEffectStarted, onDelivered });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async () => ({ rows: [{ id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});

describe('a delivered letter', () => {
  it('marks the effect before handing it over and reports it delivered by its Message-ID', async () => {
    sendMail.mockImplementation(async () => {
      expect(markEffectStarted).toHaveBeenCalledOnce();
      expect(onDelivered).not.toHaveBeenCalled();
      return {};
    });
    const result = await deliver();
    expect(onDelivered).toHaveBeenCalledWith('<m1@example.com>');
    expect(result).toEqual({ messageId: '<m1@example.com>', sentFolder: null, sentCopySaved: null });
  });

  it('stays delivered, with a Sent-copy warning, after a post-delivery failure', async () => {
    resolveSentFolder.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await deliver();
    expect(result.sentCopySaved).toBe(false);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('stays delivered when recording the delivery fails', async () => {
    onDelivered.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(deliver()).resolves.toMatchObject({ messageId: '<m1@example.com>' });
  });

  it('sends a message addressed only in Bcc without an empty To header', async () => {
    await deliver({ to: [], bcc: ['hidden@example.com'] });
    const options = sendMail.mock.calls[0][0];
    expect(options.to).toBeUndefined();
    expect(options.bcc).toContain('hidden@example.com');
  });
});

describe('a failure that certainly delivered nothing', () => {
  it('fails on an SMTP rejection', async () => {
    // nodemailer puts the server's reply code on the error; a reply means DATA was not accepted.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'smtp_rejected', message: 'Message was rejected by the mail server.' });
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it('retries a temporary SMTP reply', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('451 4.7.1 Greylisted, try again later'), { code: 'EENVELOPE', responseCode: 451, command: 'RCPT TO' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'smtp_temporary' });
  });

  it('retries when the server could not be reached, with a specific host:port error', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({
      jobOutcome: 'retry', code: 'smtp_connection_failed',
      message: "Could not connect to smtp.gmail.com:465 (connection refused). The server's network may block outgoing mail ports.",
    });
  });

  it('retries when connecting times out, or DNS or TLS fails', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'smtp_connection_failed', message: expect.stringContaining('(timed out)') });
    sendMail.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.gmail.com'), { code: 'EDNS', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', message: expect.stringContaining('(host not found)') });
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Error initiating TLS - self signed certificate'), { code: 'ETLS', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', message: expect.stringContaining('(TLS handshake failed)') });
  });

  it('fails on an auth rejection with the generic message', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535 5.7.8 authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'smtp_auth_failed', message: 'Authentication failed. Check your email account credentials.' });
  });
});

describe('a failure that may have delivered the letter', () => {
  it('needs attention when the connection breaks with no server reply', async () => {
    // nodemailer tags a mid-session close as CONN too, so it may come after DATA was accepted.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'needs_attention', code: 'send_uncertain' });
    expect(markEffectStarted).toHaveBeenCalledOnce();
  });
});

describe('OAuth reconnect-required on send', () => {
  it('fails before the effect when the transport cannot be set up', async () => {
    createAccountSmtpTransport.mockResolvedValueOnce({
      status: 409, code: 'oauth_reconnect_required',
      error: 'Access to this account was revoked or has expired. Reconnect the account to send mail.',
    });
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'oauth_reconnect_required' });
    expect(markEffectStarted).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('fails when a forced refresh during the send needs a reconnect', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('OAuth access was revoked or expired — reconnect the account'), { name: 'OAuthTokenError', code: 'oauth_reconnect_required' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'oauth_reconnect_required' });
  });

  it('retries a transient refresh failure during the send', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('OAuth token refresh failed: oauth_refresh_failed'), { name: 'OAuthTokenError', code: 'oauth_refresh_failed' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'oauth_refresh_failed' });
  });
});
