import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { validateHost, resolveForConnection } from '../hostValidation.js';
import { createSmtpTransport } from '../smtpTransport.js';
import { getConnectionPolicy } from '../connectionPolicy.js';

// The system SMTP (system_settings.system_email_config) that sends invites, sign-in codes and other
// system mail, shared by the admin API (routes/admin.js, /api/admin/system-email) and the panel CLI
// (cli/commands/systemEmail.js): the same checks. The password is stored encrypted and never
// answered. Not journaled, by the screen or the CLI.

// code -> [HTTP status, message]. A refusal may carry its own message (host_refused, smtp_failed).
export const SYSTEM_EMAIL_ERRORS = Object.freeze({
  fields_required: [400, 'SMTP host and username are required'],
  host_refused: [400, 'Host refused'],
  not_configured: [400, 'No system email configured'],
  config_corrupted: [500, 'Corrupted system email config'],
  password_missing: [400, 'No password stored — save the configuration first'],
  smtp_failed: [400, 'The SMTP server refused'],
});

// What the screen shows in place of a stored password; saving it back keeps the password.
export const PASSWORD_PLACEHOLDER = '••••••••';
const KEY = 'system_email_config';

async function storedValue() {
  const result = await query(`SELECT value FROM system_settings WHERE key = '${KEY}'`);
  return result.rows.length ? result.rows[0].value : null;
}

// The stored config with the password replaced by the placeholder ('' when none): { config } or
// { config: null } when none is stored or it cannot be read.
export async function getSystemEmail() {
  const value = await storedValue();
  if (value === null) return { config: null };
  try {
    const cfg = JSON.parse(value);
    return { config: { ...cfg, pass: cfg.pass ? PASSWORD_PLACEHOLDER : '' } };
  } catch {
    return { config: null };
  }
}

// Saves the config: { host, port, tls, user, pass, fromName, fromEmail }. The host passes the
// admin's "Allow private / local hosts" policy, as the account routes do (#358). A missing pass,
// or the placeholder, keeps the stored password. Answers { ok } or { error, message? }.
export async function saveSystemEmail(body) {
  const { host, port, tls, user, pass, fromName, fromEmail } = body || {};
  if (!host || !user) return { error: 'fields_required' };

  const policy = await getConnectionPolicy();
  const hostErr = await validateHost(host, { allowPrivate: policy.allowPrivateHosts });
  if (hostErr) return { error: 'host_refused', message: hostErr };

  // The existing config keeps its encrypted password when the field was not changed.
  let existingPass = null;
  const existing = await storedValue();
  if (existing !== null) {
    try { existingPass = JSON.parse(existing).pass; } catch { /* keep existingPass null */ }
  }
  const encryptedPass = pass && pass !== PASSWORD_PLACEHOLDER ? encrypt(pass) : (existingPass || null);

  const cfg = {
    host: host.trim(),
    port: parseInt(port) || 587,
    tls: tls || 'STARTTLS',
    user: user.trim(),
    pass: encryptedPass,
    fromName: (fromName || '').trim() || 'MailExpert',
    fromEmail: (fromEmail || '').trim() || user.trim(),
  };
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('${KEY}', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(cfg)],
  );
  return { ok: true };
}

// Connects to the stored server and signs in, greeting it as the real send does (services/
// mailer.js sends from this address, so the test checks the same EHLO name). Sends no letter.
// Answers { ok } or { error, message? }.
export async function testSystemEmail() {
  const value = await storedValue();
  if (value === null) return { error: 'not_configured' };
  let cfg;
  try { cfg = JSON.parse(value); } catch {
    return { error: 'config_corrupted' };
  }
  const pass = cfg.pass ? decrypt(cfg.pass) : null;
  if (!pass) return { error: 'password_missing' };
  try {
    const policy = await getConnectionPolicy();
    const testResolved = await resolveForConnection(cfg.host, { allowPrivate: policy.allowPrivateHosts });
    const testTls = { rejectUnauthorized: true };
    if (testResolved.servername) testTls.servername = testResolved.servername;
    const transport = createSmtpTransport(testResolved, {
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass },
      tls: testTls,
    });
    await transport.verify(cfg.fromEmail || cfg.user);
    return { ok: true };
  } catch (err) {
    return { error: 'smtp_failed', message: err.message };
  }
}

// Removes the config: system mail is not sent until it is saved again. Answers { ok, removed }.
export async function removeSystemEmail() {
  const result = await query(`DELETE FROM system_settings WHERE key = '${KEY}'`);
  return { ok: true, removed: (result?.rowCount ?? 0) > 0 };
}
