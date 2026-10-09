import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The system SMTP (invites, sign-in codes, password resets, its connection test) honors the
// encryption saved with it (screen and `system-email set --tls`) as mailbox sending honors
// smtp_tls (createAccountSmtpTransport): SSL is implicit TLS on any port; STARTTLS must upgrade,
// because nodemailer upgrades only when EHLO advertises it, so a server that leaves it out, or
// anyone on the path who strips it, would get AUTH and the letter in cleartext; none is plain
// text, allowed only when the admin allows insecure connections and refused before connecting
// otherwise.
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'smtp-secret'), encrypt: vi.fn(v => v) }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), validateHost: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./smtpTransport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSmtpTransport: vi.fn(),
}));

const { query } = await import('./db.js');
const { resolveForConnection } = await import('./hostValidation.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { createSmtpTransport, systemSmtpOptions, INSECURE_TLS_NOT_ALLOWED } = await import('./smtpTransport.js');
const { sendSystemEmail } = await import('./mailer.js');
const { testSystemEmail, SYSTEM_EMAIL_ERRORS } = await import('./admin/systemEmail.js');
const { createInvite } = await import('./admin/invites.js');

const config = ({ port, tls }) => JSON.stringify({
  host: 'smtp.example.com', port, ...(tls === undefined ? {} : { tls }), user: 'system@example.com', pass: 'ENCRYPTED',
  fromName: 'MailExpert', fromEmail: 'system@example.com',
});

let stored;
beforeEach(() => {
  vi.clearAllMocks();
  stored = { port: 587, tls: 'STARTTLS' };
  process.env.APP_URL = 'https://mail.example.com';
  query.mockImplementation(async (sql) => (
    sql.includes('system_email_config') ? { rows: [{ value: config(stored) }] } : { rows: [] }
  ));
  resolveForConnection.mockResolvedValue({ host: '203.0.113.10', servername: 'smtp.example.com' });
  createSmtpTransport.mockReturnValue({
    sendMail: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue(true),
  });
});

afterEach(() => vi.restoreAllMocks());

const resolved = { host: '203.0.113.10', servername: 'smtp.example.com' };
const options = (tls, port, allowInsecureTls) => systemSmtpOptions({
  port, tls, user: 'u', pass: 'p', resolved, policy: { allowInsecureTls },
});

describe('systemSmtpOptions', () => {
  it.each([false, true])('STARTTLS must upgrade on a non-465 port (allow insecure TLS: %s)', (allow) => {
    expect(options('STARTTLS', 587, allow)).toEqual({
      port: 587, secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' },
      tls: { rejectUnauthorized: true, servername: 'smtp.example.com' },
    });
    expect(options('STARTTLS', 465, allow)).toMatchObject({ secure: true });
    expect(options('STARTTLS', 465, allow).requireTLS).toBeUndefined();
  });

  it.each([false, true])('SSL is implicit TLS on any port (allow insecure TLS: %s)', (allow) => {
    for (const port of [465, 587, 2465]) {
      const opts = options('SSL', port, allow);
      expect(opts).toMatchObject({ port, secure: true });
      expect(opts.requireTLS).toBeUndefined();
      expect(opts.ignoreTLS).toBeUndefined();
    }
  });

  it('none is refused before connecting unless insecure TLS is allowed', () => {
    for (const port of [25, 587]) {
      expect(() => options('none', port, false)).toThrow(expect.objectContaining({
        code: INSECURE_TLS_NOT_ALLOWED,
        message: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
      }));
    }
  });

  it('none is plain text when insecure TLS is allowed', () => {
    const opts = options('none', 25, true);
    expect(opts).toMatchObject({ port: 25, secure: false, ignoreTLS: true });
    expect(opts.requireTLS).toBeUndefined();
  });

  it.each([false, true])('a config saved without a tls value counts as STARTTLS (allow insecure TLS: %s)', (allow) => {
    expect(options(undefined, 587, allow)).toMatchObject({ secure: false, requireTLS: true });
    expect(options(undefined, 465, allow)).toMatchObject({ secure: true });
  });

  it('always verifies the certificate', () => {
    expect(systemSmtpOptions({ port: 465, tls: 'SSL', user: 'u', pass: 'p', resolved: { host: 'h' }, policy: {} }).tls)
      .toEqual({ rejectUnauthorized: true });
  });
});

const callers = {
  sendSystemEmail: () => sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' }),
  testSystemEmail: () => testSystemEmail(),
  createInvite: () => createInvite('invitee@example.com', 'admin-id'),
};

describe.each(Object.entries(callers))('%s through the system SMTP', (_name, call) => {
  it.each([
    ['STARTTLS', 587, false, { port: 587, secure: false, requireTLS: true }],
    ['STARTTLS', 587, true, { port: 587, secure: false, requireTLS: true }],
    ['SSL', 465, false, { port: 465, secure: true }],
    ['SSL', 587, true, { port: 587, secure: true }],
    ['none', 25, true, { port: 25, secure: false, ignoreTLS: true }],
  ])('builds the transport for tls %s on %s (allow insecure TLS: %s)', async (tls, port, allow, expected) => {
    stored = { tls, port };
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: allow });
    await call();
    expect(createSmtpTransport).toHaveBeenCalledOnce();
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject(expected);
  });

  it('opens no connection for tls none while insecure TLS is not allowed', async () => {
    stored = { tls: 'none', port: 25 };
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await call().catch(() => {});
    expect(createSmtpTransport).not.toHaveBeenCalled();
  });
});

describe('the plain-text refusal, as each caller reports it', () => {
  beforeEach(() => {
    stored = { tls: 'none', port: 25 };
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
  });

  it('is in the system email refusal catalog', () => {
    expect(SYSTEM_EMAIL_ERRORS[INSECURE_TLS_NOT_ALLOWED])
      .toEqual([400, 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"']);
  });

  it('the connection test (screen and CLI) answers it with its code', async () => {
    expect(await testSystemEmail()).toEqual({ error: INSECURE_TLS_NOT_ALLOWED });
  });

  it('sendSystemEmail rejects with the code', async () => {
    await expect(sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' }))
      .rejects.toMatchObject({ code: INSECURE_TLS_NOT_ALLOWED });
  });

  it('an invite is created, its letter not sent, and the reason logged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createInvite('invitee@example.com', 'admin-id');
    expect(result).toMatchObject({ emailSent: false });
    expect(result.emailError).toMatch(/Plain-text SMTP is not allowed/);
    expect(errors).toHaveBeenCalledWith('Invite email failed:', expect.stringMatching(/Plain-text SMTP is not allowed/));
  });
});
