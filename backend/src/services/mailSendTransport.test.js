import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
  oauthRefreshFailureResult: vi.fn(),
}));
vi.mock('./oauth/tokenManager.js', () => ({ ensureFreshOAuthAccount: vi.fn() }));
vi.mock('./oauth/googleApps.js', () => ({ markGmailApiDisabled: vi.fn(), clearGmailApiDisabled: vi.fn() }));
vi.mock('./gmailApiSender.js', () => ({
  GMAIL_API_TIMEOUT_MS: 100,
  buildRawMessage: vi.fn(),
  postGmailApiSend: vi.fn(),
  getSentMessageIdHeader: vi.fn(),
}));

import { createAccountSmtpTransport, oauthRefreshFailureResult } from './smtpTransport.js';
import { ensureFreshOAuthAccount } from './oauth/tokenManager.js';
import { markGmailApiDisabled, clearGmailApiDisabled } from './oauth/googleApps.js';
import { buildRawMessage, postGmailApiSend, getSentMessageIdHeader } from './gmailApiSender.js';
import { createAccountSendTransport, _resetGmailSendTransportWarningForTests } from './mailSendTransport.js';

const gmailAccount = {
  id: 'acc-1', oauth_provider: 'google', oauth_app_id: 'app-1',
  oauth_access_token: 'plain-access-token',
};
const rawMessage = Buffer.from('raw');
const mailOptions = { messageId: '<ours@mailexpert.local>', from: 'me@example.com', to: 'you@example.com', subject: 'Hi', text: 'Hello' };

function fallbackErr(reason, extra = {}) {
  return Object.assign(new Error(`fallback:${reason}`), { gmailApi: true, gmailClassification: { kind: 'fallback', reason, disableApi: false, ...extra } });
}
function terminalErr(code, status, googleMessage = '') {
  return Object.assign(new Error(`terminal:${code}`), { gmailApi: true, definite: true, code, status, gmailClassification: { kind: 'terminal', code, status, googleMessage } });
}
function authRetryErr() {
  return Object.assign(new Error('auth'), { gmailApi: true, gmailClassification: { kind: 'auth_retry' } });
}
function uncertainErr() {
  return Object.assign(new Error('aborted'), { name: 'AbortError', gmailApi: true, gmailClassification: { kind: 'uncertain' } });
}

describe('createAccountSendTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GMAIL_SEND_TRANSPORT;
    _resetGmailSendTransportWarningForTests();
    buildRawMessage.mockResolvedValue(rawMessage);
    ensureFreshOAuthAccount.mockImplementation(async (account) => account);
    markGmailApiDisabled.mockResolvedValue(undefined);
    clearGmailApiDisabled.mockResolvedValue(undefined);
  });
  afterEach(() => { delete process.env.GMAIL_SEND_TRANSPORT; });

  it('delegates non-Gmail accounts straight to createAccountSmtpTransport, unchanged', async () => {
    const account = { id: 'a2', oauth_provider: 'microsoft' };
    const expected = { account, transport: { sendMail: vi.fn() } };
    createAccountSmtpTransport.mockResolvedValue(expected);
    const result = await createAccountSendTransport(account);
    expect(result).toBe(expected);
    expect(ensureFreshOAuthAccount).not.toHaveBeenCalled();
  });

  it('delegates a Gmail account straight to SMTP when GMAIL_SEND_TRANSPORT=smtp', async () => {
    process.env.GMAIL_SEND_TRANSPORT = 'smtp';
    const expected = { account: gmailAccount, transport: { sendMail: vi.fn() } };
    createAccountSmtpTransport.mockResolvedValue(expected);
    const result = await createAccountSendTransport(gmailAccount);
    expect(result).toBe(expected);
    expect(postGmailApiSend).not.toHaveBeenCalled();
  });

  it('warns once and defaults to api for an unrecognized GMAIL_SEND_TRANSPORT value', async () => {
    process.env.GMAIL_SEND_TRANSPORT = 'carrier-pigeon';
    postGmailApiSend.mockResolvedValue({ id: 'm1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (await createAccountSendTransport(gmailAccount)).transport.sendMail(mailOptions, {});
    await (await createAccountSendTransport(gmailAccount)).transport.sendMail(mailOptions, {});
    expect(warn.mock.calls.filter(c => String(c[0]).includes('GMAIL_SEND_TRANSPORT')).length).toBe(1);
    warn.mockRestore();
  });

  it('returns the top-level OAuth refresh failure mapping and never attempts a send', async () => {
    const err = Object.assign(new Error('refresh failed'), { code: 'oauth_reconnect_required' });
    ensureFreshOAuthAccount.mockRejectedValue(err);
    oauthRefreshFailureResult.mockReturnValue({ status: 409, code: 'oauth_reconnect_required', error: 'Reconnect' });
    const result = await createAccountSendTransport(gmailAccount);
    expect(result).toEqual({ status: 409, code: 'oauth_reconnect_required', error: 'Reconnect' });
    expect(buildRawMessage).not.toHaveBeenCalled();
  });

  it('rethrows an unmapped OAuth refresh error', async () => {
    const err = new Error('boom');
    ensureFreshOAuthAccount.mockRejectedValue(err);
    oauthRefreshFailureResult.mockReturnValue(null);
    await expect(createAccountSendTransport(gmailAccount)).rejects.toBe(err);
  });

  it('reports a corrupted/missing access token as a 502', async () => {
    ensureFreshOAuthAccount.mockResolvedValue({ ...gmailAccount, oauth_access_token: null });
    const result = await createAccountSendTransport(gmailAccount);
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/reconnect/i);
  });

  describe('sendMail via the Gmail API', () => {
    it('sends via the API, passes threadId, and clears a stale gmail_api_disabled_at flag', async () => {
      postGmailApiSend.mockResolvedValue({ id: 'msg-1', threadId: 'deadbeef' });
      getSentMessageIdHeader.mockResolvedValue(null);
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, { threadId: 'deadbeef' });
      expect(info).toEqual({ via: 'api', messageId: mailOptions.messageId });
      expect(buildRawMessage).toHaveBeenCalledWith(mailOptions);
      expect(postGmailApiSend).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: 'plain-access-token', rawMessage, threadId: 'deadbeef',
      }));
      expect(clearGmailApiDisabled).toHaveBeenCalledWith('app-1');
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('adopts the Message-ID Gmail reports when it differs from ours', async () => {
      postGmailApiSend.mockResolvedValue({ id: 'msg-1' });
      getSentMessageIdHeader.mockResolvedValue('<real@gmail.com>');
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, {});
      expect(info.messageId).toBe('<real@gmail.com>');
    });

    it('refreshes the token once and retries after a 401, without falling back to SMTP', async () => {
      postGmailApiSend.mockRejectedValueOnce(authRetryErr()).mockResolvedValueOnce({ id: 'msg-1' });
      getSentMessageIdHeader.mockResolvedValue(null);
      ensureFreshOAuthAccount.mockImplementation(async (account, opts) => {
        if (opts?.force) return { ...account, oauth_access_token: 'refreshed-token' };
        return account;
      });
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, {});
      expect(info.via).toBe('api');
      expect(postGmailApiSend).toHaveBeenCalledTimes(2);
      expect(postGmailApiSend.mock.calls[1][0].accessToken).toBe('refreshed-token');
      expect(ensureFreshOAuthAccount).toHaveBeenCalledWith(expect.anything(), { force: true });
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('reports gmail_api_auth_failed when the retried token is rejected again', async () => {
      postGmailApiSend.mockRejectedValue(authRetryErr());
      ensureFreshOAuthAccount.mockImplementation(async (account, opts) => (opts?.force ? { ...account, oauth_access_token: 'still-bad' } : account));
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).rejects.toMatchObject({ code: 'gmail_api_auth_failed', status: 502, definite: true });
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('propagates a reconnect-required refresh failure during the 401 retry unchanged', async () => {
      postGmailApiSend.mockRejectedValue(authRetryErr());
      const oauthErr = Object.assign(new Error('reconnect'), { code: 'oauth_reconnect_required' });
      ensureFreshOAuthAccount.mockImplementation(async (account, opts) => { if (opts?.force) throw oauthErr; return account; });
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).rejects.toBe(oauthErr);
    });

    it('retries once without threadId when Gmail rejects only the threading metadata', async () => {
      postGmailApiSend
        .mockRejectedValueOnce(terminalErr('gmail_access_refused', 502, 'Invalid thread ID for the given recipients'))
        .mockResolvedValueOnce({ id: 'msg-1' });
      getSentMessageIdHeader.mockResolvedValue(null);
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, { threadId: 'abc' });
      expect(info.via).toBe('api');
      expect(postGmailApiSend).toHaveBeenCalledTimes(2);
      expect(postGmailApiSend.mock.calls[0][0].threadId).toBe('abc');
      expect(postGmailApiSend.mock.calls[1][0].threadId).toBeNull();
    });

    it('falls back to SMTP and flags the app when Gmail API is disabled for the project', async () => {
      postGmailApiSend.mockRejectedValue(fallbackErr('accessNotConfigured', { disableApi: true }));
      const smtpSendMail = vi.fn().mockResolvedValue({});
      createAccountSmtpTransport.mockResolvedValue({ account: gmailAccount, transport: { sendMail: smtpSendMail } });
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, {});
      expect(info).toEqual({ via: 'smtp', messageId: mailOptions.messageId });
      expect(markGmailApiDisabled).toHaveBeenCalledWith('app-1');
      expect(smtpSendMail).toHaveBeenCalledWith(mailOptions);
    });

    it('falls back to SMTP for a pre-send network error, without flagging the app', async () => {
      postGmailApiSend.mockRejectedValue(fallbackErr('ENOTFOUND'));
      const smtpSendMail = vi.fn().mockResolvedValue({});
      createAccountSmtpTransport.mockResolvedValue({ account: gmailAccount, transport: { sendMail: smtpSendMail } });
      const { transport } = await createAccountSendTransport(gmailAccount);
      const info = await transport.sendMail(mailOptions, {});
      expect(info.via).toBe('smtp');
      expect(markGmailApiDisabled).not.toHaveBeenCalled();
    });

    it('falls back to SMTP for a 5xx/429 (not accepted)', async () => {
      postGmailApiSend.mockRejectedValue(fallbackErr('http_503'));
      const smtpSendMail = vi.fn().mockResolvedValue({});
      createAccountSmtpTransport.mockResolvedValue({ account: gmailAccount, transport: { sendMail: smtpSendMail } });
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).resolves.toMatchObject({ via: 'smtp' });
    });

    it('does not fall back for a terminal rejection — propagates it with .definite = true', async () => {
      postGmailApiSend.mockRejectedValue(terminalErr('gmail_invalid_recipient', 400));
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).rejects.toMatchObject({ code: 'gmail_invalid_recipient', status: 400, definite: true });
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('does not fall back for an uncertain failure (e.g. our own timeout) — propagates it unclassified', async () => {
      const err = uncertainErr();
      postGmailApiSend.mockRejectedValue(err);
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).rejects.toBe(err);
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('reports a definite error when the SMTP fallback itself cannot be set up', async () => {
      postGmailApiSend.mockRejectedValue(fallbackErr('http_500'));
      createAccountSmtpTransport.mockResolvedValue({ status: 502, error: 'SMTP password is corrupted' });
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).rejects.toMatchObject({ status: 502, message: 'SMTP password is corrupted', definite: true });
    });

    it('never throws past a successful send when the Message-ID verification GET fails', async () => {
      postGmailApiSend.mockResolvedValue({ id: 'msg-1' });
      getSentMessageIdHeader.mockRejectedValue(new Error('network blip'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).resolves.toMatchObject({ via: 'api', messageId: mailOptions.messageId });
      warn.mockRestore();
    });

    it('never throws past a successful send when clearing the disabled flag fails', async () => {
      postGmailApiSend.mockResolvedValue({ id: 'msg-1' });
      getSentMessageIdHeader.mockResolvedValue(null);
      clearGmailApiDisabled.mockRejectedValue(new Error('db down'));
      const { transport } = await createAccountSendTransport(gmailAccount);
      await expect(transport.sendMail(mailOptions, {})).resolves.toMatchObject({ via: 'api' });
    });
  });
});
