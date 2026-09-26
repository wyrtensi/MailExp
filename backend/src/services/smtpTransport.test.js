import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
// Transports refresh through the token manager (single entry point), never a provider module.
vi.mock('./oauth/tokenManager.js', () => ({ ensureFreshOAuthAccount: vi.fn(async account => account) }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v) }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));

const nodemailer = (await import('nodemailer')).default;
const { ensureFreshOAuthAccount } = await import('./oauth/tokenManager.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { resolveForConnection } = await import('./hostValidation.js');
const {
  createAccountSmtpTransport,
  createSmtpTransport,
  isPreDeliveryConnectionError,
  smtpClientName,
} = await import('./smtpTransport.js');
const { noteRestoredPassword } = await import('./mailNode/currentPassword.js');

const resolved = {
  host: '203.0.113.10',
  servername: 'smtp.example.com',
  addresses: ['203.0.113.10', '203.0.113.11'],
};

afterEach(() => vi.restoreAllMocks());

describe('createSmtpTransport', () => {
  it('tries the next validated address after a connection-stage failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstError = Object.assign(new Error('Connection timeout'), {
      code: 'ETIMEDOUT',
      command: 'CONN',
    });
    const sendMail = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ accepted: ['user@example.com'] });
    const close = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail, close }));

    const transport = createSmtpTransport(
      resolved,
      { port: 465, secure: true, tls: { servername: resolved.servername } },
      createTransport,
    );
    const result = await transport.sendMail({ to: 'user@example.com' });

    expect(result.accepted).toEqual(['user@example.com']);
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(createTransport.mock.calls.map(([options]) => options.host))
      .toEqual(resolved.addresses);
    expect(createTransport.mock.calls[0][0].connectionTimeout)
      .toBeLessThanOrEqual(10_000);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AUTH', 'EAUTH'],
    ['MAIL FROM', 'EENVELOPE'],
    ['DATA', 'ETIMEDOUT'],
  ])('does not retry an ambiguous or post-connect %s failure', async (command, code) => {
    const error = Object.assign(new Error(`${command} failed`), { code, command });
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
    }));

    const transport = createSmtpTransport(
      resolved,
      { port: 587, secure: false },
      createTransport,
    );
    await expect(transport.sendMail({ to: 'user@example.com' })).rejects.toBe(error);

    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('applies the same address fallback to SMTP verification', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstError = Object.assign(new Error('Connection refused'), {
      command: 'CONN',
    });
    const verify = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce(true);
    const createTransport = vi.fn(() => ({ verify, close: vi.fn() }));
    const transport = createSmtpTransport(
      resolved,
      { port: 587, secure: false },
      createTransport,
    );

    await expect(transport.verify()).resolves.toBe(true);
    expect(createTransport.mock.calls.map(([options]) => options.host))
      .toEqual(resolved.addresses);
  });

  it('recognizes only CONN errors as unambiguously pre-delivery', () => {
    expect(isPreDeliveryConnectionError({ command: 'CONN' })).toBe(true);
    expect(isPreDeliveryConnectionError({ command: 'AUTH' })).toBe(false);
    expect(isPreDeliveryConnectionError(new Error('timeout'))).toBe(false);
  });
});

// EHLO name (upstream #492, adapted). nodemailer's default is os.hostname(), and in a container
// that is a bare label, so it sends `EHLO [127.0.0.1]`: a loopback HELO from a remote address,
// which spam filters read as forgery. The panel must not name itself instead (neither its host
// nor its product), so it gives the domain of the sending address, else "localhost".
describe('EHLO name', () => {
  const transportWith = () => {
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ accepted: ['a@b.example'] }),
      verify: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    }));
    return { createTransport, transport: createSmtpTransport(resolved, { port: 465, secure: true }, createTransport) };
  };

  it('introduces itself with the domain of the From address, never [127.0.0.1]', async () => {
    const { createTransport, transport } = transportWith();
    await transport.sendMail({ from: '"Doe, Anna" <anna@Corp.Example>', to: 'a@b.example' });
    expect(createTransport.mock.calls[0][0].name).toBe('corp.example');
  });

  it('prefers the envelope sender, which is what MAIL FROM carries', async () => {
    const { createTransport, transport } = transportWith();
    await transport.sendMail({ from: 'anna@corp.example', envelope: { from: 'bounce@lists.example', to: ['a@b.example'] } });
    expect(createTransport.mock.calls[0][0].name).toBe('lists.example');
  });

  it('keeps the name on every address it fails over to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connErr = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
    const sendMail = vi.fn().mockRejectedValueOnce(connErr).mockResolvedValueOnce({ accepted: ['a@b.example'] });
    const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
    await createSmtpTransport(resolved, { port: 465 }, createTransport).sendMail({ from: 'anna@corp.example' });
    expect(createTransport.mock.calls.map(([o]) => o.name)).toEqual(['corp.example', 'corp.example']);
  });

  it('says "localhost" to verify(), which has no sender', async () => {
    const { createTransport, transport } = transportWith();
    await transport.verify();
    expect(createTransport.mock.calls[0][0].name).toBe('localhost');
  });

  it('sets it on account transports too (send and rule forwards)', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    resolveForConnection.mockResolvedValue(resolved);
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() });
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com', auth_pass: 'pw', imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ from: 'Office <office@team.example>', to: 'a@b.example' });
    expect(nodemailer.createTransport.mock.calls[0][0].name).toBe('team.example');
  });

  it.each([
    ['anna@corp.example', 'corp.example'],
    [{ name: 'Anna', address: 'anna@corp.example' }, 'corp.example'],
    [['anna@corp.example'], 'corp.example'],
    ['user@почта.рф', 'xn--80a1acny.xn--p1ai'], // EHLO takes the A-label
    ['root', 'localhost'],
    ['a@[192.0.2.1]', 'localhost'],               // an address literal is the same IP signal
    ['a@192.0.2.1', 'localhost'],
    ['a@intranet', 'localhost'],                  // a bare label is no better than the default
    ['', 'localhost'],
    [undefined, 'localhost'],
  ])('smtpClientName(%j) is %s', (from, name) => {
    expect(smtpClientName(from)).toBe(name);
  });
});

describe('createAccountSmtpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionPolicy.mockResolvedValue({
      allowPrivateHosts: false,
      allowInsecureTls: false,
    });
    resolveForConnection.mockResolvedValue(resolved);
    nodemailer.createTransport.mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ accepted: ['user@example.com'] }),
      close: vi.fn(),
    });
  });

  it('uses decrypted password credentials without exposing them in the result', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'test-password',
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(result.error).toBeUndefined();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'sender@example.com', pass: 'test-password' },
        secure: false,
      })
    );
  });

  it('prefers separate SMTP credentials when the account has them', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.relay.example',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'imap-password',
      smtp_auth_user: 'relay-user',
      smtp_auth_pass: 'relay-password',
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(result.error).toBeUndefined();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'relay-user', pass: 'relay-password' },
      })
    );
  });

  it('falls back to the IMAP login for whichever SMTP credential is unset', async () => {
    // Separate SMTP username, but no separate SMTP password -> reuse the IMAP password.
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.relay.example',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'imap-password',
      smtp_auth_user: 'relay-user',
      smtp_auth_pass: null,
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'relay-user', pass: 'imap-password' },
      })
    );
  });

  it('sends a mail node mailbox with its restored password, even from a row read before the restore', async () => {
    noteRestoredPassword('node-1', 'old-password', 'restored-password');
    const result = await createAccountSmtpTransport({
      id: 'node-1',
      mail_node: true,
      smtp_host: 'mail.example.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'box@example.com',
      auth_pass: 'old-password',
      smtp_auth_pass: null,
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'box@example.com', pass: 'restored-password' } })
    );
  });

  const oauthAccount = (over = {}) => ({
    id: 'account-1',
    oauth_provider: 'google',
    oauth_access_token: 'expired-token',
    oauth_token_expiry: new Date(0),
    auth_user: 'sender@gmail.com',
    email_address: 'sender@gmail.com',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_tls: 'SSL',
    ...over,
  });
  const inAnHour = () => new Date(Date.now() + 3600_000);
  const authRejected = () => Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
    code: 'EAUTH', responseCode: 535, command: 'AUTH XOAUTH2',
  });
  const tokenError = code => Object.assign(new Error('OAuth token refresh failed'), { name: 'OAuthTokenError', code });

  it.each(['google', 'microsoft'])('refreshes an expired %s token through the token manager before creating the transport', async (provider) => {
    const expired = oauthAccount({ oauth_provider: provider });
    ensureFreshOAuthAccount.mockResolvedValueOnce({ ...expired, oauth_access_token: 'fresh-token', oauth_token_expiry: inAnHour() });

    const result = await createAccountSmtpTransport(expired);
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(1);
    expect(ensureFreshOAuthAccount.mock.calls[0][0]).toBe(expired);
    expect(result.account.oauth_access_token).toBe('fresh-token');
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: { type: 'OAuth2', user: 'sender@gmail.com', accessToken: 'fresh-token' },
    }));
    expect(nodemailer.createTransport.mock.calls.every(([opts]) => opts.auth.accessToken !== 'expired-token')).toBe(true);
  });

  it('requires TLS on a STARTTLS account so a stripped STARTTLS cannot fall back to plaintext', async () => {
    // The transport is built on the first send.
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: 'u', auth_pass: 'p',
    });
    await result.transport.sendMail({ to: 'user@example.com' });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, secure: false }));
  });

  it('does not ask for STARTTLS on an implicit-TLS account', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com', smtp_port: 465, smtp_tls: 'SSL', auth_user: 'u', auth_pass: 'p',
    });
    await result.transport.sendMail({ to: 'user@example.com' });
    expect(nodemailer.createTransport.mock.calls[0][0].requireTLS).toBeUndefined();
  });

  it('never sends password accounts through the token manager', async () => {
    await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: 'u', auth_pass: 'p',
    });
    expect(ensureFreshOAuthAccount).not.toHaveBeenCalled();
  });

  it('returns a stable reconnect-required result without building a transport', async () => {
    ensureFreshOAuthAccount.mockRejectedValueOnce(tokenError('oauth_reconnect_required'));
    const result = await createAccountSmtpTransport(oauthAccount());
    expect(result).toEqual({ status: 409, code: 'oauth_reconnect_required', error: expect.any(String) });
    expect(result.error).not.toMatch(/expired-token/);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('returns a retryable result when the refresh fails transiently', async () => {
    ensureFreshOAuthAccount.mockRejectedValueOnce(tokenError('oauth_refresh_failed'));
    const result = await createAccountSmtpTransport(oauthAccount());
    expect(result).toMatchObject({ status: 503, code: 'oauth_refresh_failed' });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  describe('SMTP AUTH rejection on an OAuth account', () => {
    it('forces one refresh and retries the send once with the new token', async () => {
      const account = oauthAccount({ oauth_access_token: 'rejected-token', oauth_token_expiry: inAnHour() });
      const sends = [vi.fn().mockRejectedValue(authRejected()), vi.fn().mockResolvedValue({ accepted: ['user@example.com'] })];
      nodemailer.createTransport.mockImplementation(() => ({ sendMail: sends.shift(), close: vi.fn() }));
      ensureFreshOAuthAccount
        .mockImplementationOnce(async a => a)
        .mockImplementationOnce(async a => ({ ...a, oauth_access_token: 'forced-token' }));

      const result = await createAccountSmtpTransport(account);
      const info = await result.transport.sendMail({ to: 'user@example.com' });

      expect(info.accepted).toEqual(['user@example.com']);
      expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(2);
      expect(ensureFreshOAuthAccount.mock.calls[1][1]).toMatchObject({ force: true });
      expect(nodemailer.createTransport.mock.calls.map(([o]) => o.auth.accessToken)).toEqual(['rejected-token', 'forced-token']);
    });

    it('does not retry a second time when the refreshed token is also rejected', async () => {
      const rejected = authRejected();
      nodemailer.createTransport.mockImplementation(() => ({ sendMail: vi.fn().mockRejectedValue(rejected), close: vi.fn() }));
      ensureFreshOAuthAccount
        .mockImplementationOnce(async a => a)
        .mockImplementationOnce(async a => ({ ...a, oauth_access_token: 'forced-token' }));

      const result = await createAccountSmtpTransport(oauthAccount({ oauth_token_expiry: inAnHour() }));
      await expect(result.transport.sendMail({ to: 'user@example.com' })).rejects.toBe(rejected);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
      expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(2);
    });

    it('surfaces reconnect-required from the forced refresh without a second send', async () => {
      nodemailer.createTransport.mockImplementation(() => ({ sendMail: vi.fn().mockRejectedValue(authRejected()), close: vi.fn() }));
      ensureFreshOAuthAccount
        .mockImplementationOnce(async a => a)
        .mockRejectedValueOnce(tokenError('oauth_reconnect_required'));

      const result = await createAccountSmtpTransport(oauthAccount({ oauth_token_expiry: inAnHour() }));
      const err = await result.transport.sendMail({ to: 'user@example.com' }).catch(e => e);
      expect(err.code).toBe('oauth_reconnect_required');
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a post-AUTH rejection', { code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM' }],
      ['a DATA-stage failure', { code: 'EMESSAGE', responseCode: 535, command: 'DATA' }],
      ['a client-side credential error', { code: 'EAUTH', command: 'API' }],
    ])('does not refresh or resend after %s', async (_label, shape) => {
      const failure = Object.assign(new Error('failed'), shape);
      nodemailer.createTransport.mockImplementation(() => ({ sendMail: vi.fn().mockRejectedValue(failure), close: vi.fn() }));
      const result = await createAccountSmtpTransport(oauthAccount({ oauth_token_expiry: inAnHour() }));
      await expect(result.transport.sendMail({ to: 'user@example.com' })).rejects.toBe(failure);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(1);
    });

    it('does not retry an AUTH rejection for a password account', async () => {
      nodemailer.createTransport.mockImplementation(() => ({ sendMail: vi.fn().mockRejectedValue(authRejected()), close: vi.fn() }));
      const result = await createAccountSmtpTransport({
        smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: 'u', auth_pass: 'p',
      });
      await expect(result.transport.sendMail({ to: 'user@example.com' })).rejects.toMatchObject({ code: 'EAUTH' });
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      expect(ensureFreshOAuthAccount).not.toHaveBeenCalled();
    });
  });

  it('returns a policy error instead of creating a plain-text transport', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com',
      smtp_port: 25,
      smtp_tls: 'none',
      auth_user: 'sender@example.com',
      auth_pass: 'test-password',
    });

    expect(result).toEqual({
      status: 403,
      error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
