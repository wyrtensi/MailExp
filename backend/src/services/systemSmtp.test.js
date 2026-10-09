import { beforeEach, describe, expect, it, vi } from 'vitest';

// The system SMTP (invites, sign-in codes, password resets, its connection test) on a non-465
// port. nodemailer upgrades to TLS only when EHLO advertises STARTTLS, so a server that leaves it
// out, or anyone on the path who strips it, would get the AUTH credentials and the letter in
// cleartext. Mailbox sending already requires STARTTLS (createAccountSmtpTransport); the system
// SMTP must too, unless the admin allows insecure connections.
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
const { createSmtpTransport, systemSmtpOptions } = await import('./smtpTransport.js');
const { sendSystemEmail } = await import('./mailer.js');
const { testSystemEmail } = await import('./admin/systemEmail.js');
const { createInvite } = await import('./admin/invites.js');

const config = (port) => JSON.stringify({
  host: 'smtp.example.com', port, tls: 'STARTTLS', user: 'system@example.com', pass: 'ENCRYPTED',
  fromName: 'MailExpert', fromEmail: 'system@example.com',
});

let port;
beforeEach(() => {
  vi.clearAllMocks();
  port = 587;
  process.env.APP_URL = 'https://mail.example.com';
  query.mockImplementation(async (sql) => (
    sql.includes('system_email_config') ? { rows: [{ value: config(port) }] } : { rows: [] }
  ));
  resolveForConnection.mockResolvedValue({ host: '203.0.113.10', servername: 'smtp.example.com' });
  createSmtpTransport.mockReturnValue({
    sendMail: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue(true),
  });
});

const callers = {
  sendSystemEmail: () => sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' }),
  testSystemEmail: () => testSystemEmail(),
  createInvite: () => createInvite('invitee@example.com', 'admin-id'),
};

describe('systemSmtpOptions', () => {
  const resolved = { host: '203.0.113.10', servername: 'smtp.example.com' };

  it('requires STARTTLS on a non-465 port unless insecure connections are allowed', () => {
    expect(systemSmtpOptions({ port: 587, user: 'u', pass: 'p', resolved, policy: { allowInsecureTls: false } }))
      .toEqual({
        port: 587, secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' },
        tls: { rejectUnauthorized: true, servername: 'smtp.example.com' },
      });
    expect(systemSmtpOptions({ port: 25, user: 'u', pass: 'p', resolved, policy: { allowInsecureTls: true } }).requireTLS)
      .toBe(false);
  });

  it('uses implicit TLS on 465, where STARTTLS does not apply', () => {
    const options = systemSmtpOptions({ port: 465, user: 'u', pass: 'p', resolved: { host: 'h' }, policy: {} });
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
    expect(options.tls).toEqual({ rejectUnauthorized: true });
  });
});

describe.each(Object.entries(callers))('%s through the system SMTP', (_name, call) => {
  it('requires STARTTLS on port 587', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    await call();
    expect(createSmtpTransport).toHaveBeenCalledOnce();
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('lets the admin allow a server without STARTTLS', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: true });
    await call();
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject({ requireTLS: false });
  });

  it('keeps implicit TLS on port 465', async () => {
    port = 465;
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    await call();
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });
});
