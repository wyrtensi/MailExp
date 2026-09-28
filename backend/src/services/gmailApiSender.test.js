import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GMAIL_API_UPLOAD_URL,
  GMAIL_API_MESSAGE_URL,
  buildRawMessage,
  gmailThreadIdFromProviderThreadId,
  classifyGmailApiResponseError,
  classifyGmailApiNetworkError,
  postGmailApiSend,
  getSentMessageIdHeader,
} from './gmailApiSender.js';

describe('buildRawMessage', () => {
  it('keeps the Bcc header in the raw RFC 822 message', async () => {
    const raw = await buildRawMessage({
      messageId: '<abc@example.com>',
      from: 'Me <me@example.com>',
      to: 'you@example.com',
      bcc: 'hidden@example.com',
      subject: 'Hi',
      text: 'Hello',
    });
    expect(Buffer.isBuffer(raw)).toBe(true);
    const text = raw.toString('utf8');
    expect(text).toMatch(/^Bcc: hidden@example\.com/m);
    expect(text).toMatch(/^Message-ID: <abc@example\.com>/m);
    expect(text).toContain('Hello');
  });

  it('rejects when nodemailer/MailComposer reports a build error', async () => {
    // An attachment content that is neither a Buffer/string nor a stream-like object makes
    // MailComposer's build() fail — exercising the reject() branch of the promise wrapper.
    await expect(buildRawMessage({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hi',
      text: 'Hello',
      attachments: [{ filename: 'x.bin', content: { not: 'a buffer or stream' } }],
    })).rejects.toBeTruthy();
  });
});

describe('gmailThreadIdFromProviderThreadId', () => {
  it('converts the stored decimal X-GM-THRID to Gmail API hex', () => {
    expect(gmailThreadIdFromProviderThreadId('16')).toBe('10');
    expect(gmailThreadIdFromProviderThreadId('18446744073709551615')).toBe('ffffffffffffffff');
  });
  it('returns null for anything that is not a plain decimal id', () => {
    expect(gmailThreadIdFromProviderThreadId(null)).toBeNull();
    expect(gmailThreadIdFromProviderThreadId(undefined)).toBeNull();
    expect(gmailThreadIdFromProviderThreadId('')).toBeNull();
    expect(gmailThreadIdFromProviderThreadId('not-a-number')).toBeNull();
    expect(gmailThreadIdFromProviderThreadId('12.5')).toBeNull();
    expect(gmailThreadIdFromProviderThreadId('-5')).toBeNull();
  });
});

describe('classifyGmailApiResponseError', () => {
  it('treats accessNotConfigured as a fallback that also flags the app', () => {
    const c = classifyGmailApiResponseError(403, {
      error: { message: 'Gmail API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] },
    });
    expect(c).toMatchObject({ kind: 'fallback', disableApi: true, reason: 'accessNotConfigured' });
  });

  it('treats a daily sending limit as terminal, not a fallback', () => {
    const c = classifyGmailApiResponseError(429, { error: { message: 'User-rate limit exceeded... dailyLimitExceeded', errors: [{ reason: 'dailyLimitExceeded' }] } });
    expect(c).toMatchObject({ kind: 'terminal', code: 'gmail_quota_exceeded' });
  });

  it('treats plain API rate limiting as a fallback (a different quota than the mailbox limit)', () => {
    const c = classifyGmailApiResponseError(429, { error: { message: 'Rate limit exceeded', errors: [{ reason: 'rateLimitExceeded' }] } });
    expect(c).toMatchObject({ kind: 'fallback', reason: 'rate_limited' });
  });

  it('treats "User-rate limit exceeded ... (Mail sending)" (a 429) as the mailbox quota, terminal', () => {
    const c = classifyGmailApiResponseError(429, { error: { message: 'User-rate limit exceeded. (Mail sending)' } });
    expect(c).toMatchObject({ kind: 'terminal', code: 'gmail_quota_exceeded' });
  });

  it('does not treat a 403 that merely mentions "quota" as the daily limit — that also covers per-minute throttling', () => {
    const c = classifyGmailApiResponseError(403, { error: { message: 'Quota exceeded for quota metric X per minute' } });
    expect(c.code).not.toBe('gmail_quota_exceeded');
  });

  it('maps insufficientPermissions/ACCESS_TOKEN_SCOPE_INSUFFICIENT to a reconnect classification, not a fallback or a generic refusal', () => {
    const byReason = classifyGmailApiResponseError(403, { error: { message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } });
    expect(byReason).toMatchObject({ kind: 'reconnect', status: 403 });
    const byMessage = classifyGmailApiResponseError(403, { error: { message: 'Request had insufficient authentication scopes. (ACCESS_TOKEN_SCOPE_INSUFFICIENT)' } });
    expect(byMessage.kind).toBe('reconnect');
  });

  it('keeps Google\'s real HTTP status separate from the status shown to our own caller', () => {
    // A daily-limit 403 from Google is reported to our caller as 429 (Too Many Requests), but the
    // real Google status (403) is what mailSendTransport.js's threadId-retry logic must see.
    const c = classifyGmailApiResponseError(403, { error: { message: 'dailyLimitExceeded', errors: [{ reason: 'dailyLimitExceeded' }] } });
    expect(c.status).toBe(403);
    expect(c.responseStatus).toBe(429);
  });

  it('treats a 5xx as uncertain, not a fallback — Google may have accepted it before failing', () => {
    expect(classifyGmailApiResponseError(503, { error: { message: 'Backend Error' } })).toMatchObject({ kind: 'uncertain', status: 503 });
  });

  it('treats an invalid recipient as terminal', () => {
    const c = classifyGmailApiResponseError(400, { error: { message: 'Invalid To header' } });
    expect(c).toMatchObject({ kind: 'terminal', code: 'gmail_invalid_recipient', status: 400 });
  });

  it('treats a too-large message as terminal', () => {
    const c = classifyGmailApiResponseError(413, { error: { message: 'Message too large' } });
    expect(c).toMatchObject({ kind: 'terminal', code: 'gmail_message_too_large' });
  });

  it('treats an unrecognized 4xx as a generic terminal refusal', () => {
    const c = classifyGmailApiResponseError(400, { error: { message: 'Precondition check failed.' } });
    expect(c).toMatchObject({ kind: 'terminal', code: 'gmail_access_refused' });
  });
});

describe('classifyGmailApiNetworkError', () => {
  it('falls back for a pre-send DNS/connect failure', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(classifyGmailApiNetworkError(err)).toMatchObject({ kind: 'fallback', reason: 'ENOTFOUND' });
  });
  it('is uncertain for our own AbortController timeout', () => {
    expect(classifyGmailApiNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toEqual({ kind: 'uncertain' });
  });
  it('is uncertain for a reset with no clear pre-send signal', () => {
    const err = Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });
    expect(classifyGmailApiNetworkError(err)).toEqual({ kind: 'uncertain' });
  });
});

describe('postGmailApiSend', () => {
  const rawMessage = Buffer.from('From: a@b.c\r\nTo: d@e.f\r\n\r\nhi');
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock; });
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('POSTs a multipart body with threadId metadata and returns the Message resource on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg1', threadId: 'abc' }) });
    const result = await postGmailApiSend({ accessToken: 'tok', rawMessage, threadId: 'abc', signal: undefined });
    expect(result).toEqual({ id: 'msg1', threadId: 'abc' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GMAIL_API_UPLOAD_URL}?uploadType=multipart`);
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    const bodyText = init.body.toString('utf8');
    expect(bodyText).toContain('"threadId":"abc"');
    expect(bodyText).toContain('Content-Type: message/rfc822');
    expect(bodyText).toContain('hi');
  });

  it('omits threadId from the metadata part when none is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg1' }) });
    await postGmailApiSend({ accessToken: 'tok', rawMessage, threadId: null, signal: undefined });
    const bodyText = fetchMock.mock.calls[0][1].body.toString('utf8');
    expect(bodyText).toContain('--mailexpert_');
    expect(bodyText.split('\r\n\r\n')[0]).not.toContain('threadId');
  });

  it('reports a 401 with the auth_retry classification', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) });
    await expect(postGmailApiSend({ accessToken: 'tok', rawMessage, signal: undefined }))
      .rejects.toMatchObject({ gmailClassification: { kind: 'auth_retry' } });
  });

  it('classifies a definite 4xx as a thrown error with .definite = true', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid To header' } }) });
    await expect(postGmailApiSend({ accessToken: 'tok', rawMessage, signal: undefined }))
      .rejects.toMatchObject({ definite: true, code: 'gmail_invalid_recipient', status: 400 });
  });

  it('classifies a fetch()-level DNS failure as a fallback-kind error', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    await expect(postGmailApiSend({ accessToken: 'tok', rawMessage, signal: undefined }))
      .rejects.toMatchObject({ gmailClassification: { kind: 'fallback' } });
  });

  it('leaves an AbortController timeout uncertain (no .definite)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    let caught;
    try { await postGmailApiSend({ accessToken: 'tok', rawMessage, signal: undefined }); } catch (err) { caught = err; }
    expect(caught.gmailClassification).toEqual({ kind: 'uncertain' });
    expect(caught.definite).toBeUndefined();
  });
});

describe('getSentMessageIdHeader', () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock; });
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('returns the Message-ID header Gmail stored', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ payload: { headers: [{ name: 'Message-ID', value: '<real@gmail.com>' }] } }) });
    const id = await getSentMessageIdHeader({ accessToken: 'tok', id: 'msg1', signal: undefined });
    expect(id).toBe('<real@gmail.com>');
    expect(fetchMock.mock.calls[0][0]).toBe(`${GMAIL_API_MESSAGE_URL('msg1')}?format=metadata&metadataHeaders=Message-ID`);
  });

  it('returns null on a non-2xx response, without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(getSentMessageIdHeader({ accessToken: 'tok', id: 'missing', signal: undefined })).resolves.toBeNull();
  });

  it('propagates a network failure — the caller (mailSendTransport.js) treats this as best-effort and swallows it', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(getSentMessageIdHeader({ accessToken: 'tok', id: 'msg1', signal: undefined })).rejects.toThrow('network down');
  });
});
