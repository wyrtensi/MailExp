import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// End-to-end through the REAL gmailApiSender.js + REAL mailSendTransport.js, with only `fetch`
// and the account-lookup/DB-adjacent layers mocked (smtpTransport.js, oauth/tokenManager.js,
// oauth/googleApps.js). mailSendTransport.test.js already covers the orchestration logic against
// a mocked gmailApiSender.js; this instead proves the two modules actually compose correctly —
// in particular that a real Gmail API rejection (mocked at the fetch/HTTP boundary, the way it
// would really arrive) drives the real SMTP fallback, under the one createAccountSendTransport
// call routes/send.js and services/ruleForwarder.js both make.
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
  oauthRefreshFailureResult: vi.fn(),
}));
vi.mock('./oauth/tokenManager.js', async () => {
  const actual = await vi.importActual('./oauth/tokenManager.js');
  return {
    ...actual,
    ensureFreshOAuthAccount: vi.fn(async (account) => account),
    markReconnectRequired: vi.fn(),
  };
});
vi.mock('./oauth/googleApps.js', () => ({ markGmailApiDisabled: vi.fn(), clearGmailApiDisabled: vi.fn() }));

import { createAccountSmtpTransport } from './smtpTransport.js';
import { markGmailApiDisabled, clearGmailApiDisabled } from './oauth/googleApps.js';
import { createAccountSendTransport } from './mailSendTransport.js';

const gmailAccount = {
  id: 'acc-1', oauth_provider: 'google', oauth_app_id: 'app-1',
  oauth_access_token: 'plain-access-token', oauth_refresh_token: 'plain-refresh-token',
};
const mailOptions = { messageId: '<ours@mailexpert.local>', from: 'me@example.com', to: 'you@example.com', subject: 'Hi', text: 'Hello', bcc: 'hidden@example.com' };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('mailSendTransport + gmailApiSender, end to end (mocked fetch only)', () => {
  let fetchMock;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    markGmailApiDisabled.mockResolvedValue(undefined);
    clearGmailApiDisabled.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('sends a real raw message (Bcc kept) over the API on the first try', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'msg-1', threadId: 'deadbeef' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { payload: { headers: [] } })); // Message-ID GET, no override

    const { transport } = await createAccountSendTransport(gmailAccount);
    const info = await transport.sendMail(mailOptions, { threadId: null });

    expect(info).toEqual({ via: 'api', messageId: mailOptions.messageId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sendUrl, sendInit] = fetchMock.mock.calls[0];
    expect(sendUrl).toContain('upload/gmail/v1/users/me/messages/send');
    expect(sendInit.body.toString('utf8')).toContain('Bcc: hidden@example.com');
    expect(clearGmailApiDisabled).toHaveBeenCalledWith('app-1');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('falls back to SMTP when Gmail responds that the API is disabled for the project, flagging the app', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {
      error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] },
    }));
    const smtpSendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: gmailAccount, transport: { sendMail: smtpSendMail } });

    const { transport } = await createAccountSendTransport(gmailAccount);
    const info = await transport.sendMail(mailOptions, { threadId: null });

    expect(info).toEqual({ via: 'smtp', messageId: mailOptions.messageId });
    expect(fetchMock).toHaveBeenCalledTimes(1); // one Gmail API attempt, no Message-ID GET on the SMTP path
    expect(markGmailApiDisabled).toHaveBeenCalledWith('app-1');
    expect(smtpSendMail).toHaveBeenCalledWith(mailOptions);
  });

  it('falls back to SMTP on a network error before any HTTP response, without flagging the app', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const smtpSendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: gmailAccount, transport: { sendMail: smtpSendMail } });

    const { transport } = await createAccountSendTransport(gmailAccount);
    const info = await transport.sendMail(mailOptions, { threadId: null });

    expect(info.via).toBe('smtp');
    expect(markGmailApiDisabled).not.toHaveBeenCalled();
  });

  it('does not fall back on a 5xx — propagates as uncertain instead (could have been accepted)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: 'Backend Error' } }));
    const { transport } = await createAccountSendTransport(gmailAccount);
    let caught;
    try { await transport.sendMail(mailOptions, { threadId: null }); } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(caught.definite).toBeUndefined();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('retries once without threadId on a stale-threadId 404, then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { message: 'Requested entity was not found.' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'msg-1' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { payload: { headers: [] } }));

    const { transport } = await createAccountSendTransport(gmailAccount);
    const info = await transport.sendMail(mailOptions, { threadId: 'deadbeef' });

    expect(info.via).toBe('api');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstBody = fetchMock.mock.calls[0][1].body.toString('utf8');
    const secondBody = fetchMock.mock.calls[1][1].body.toString('utf8');
    expect(firstBody).toContain('"threadId":"deadbeef"');
    expect(secondBody).not.toContain('threadId');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });
});
