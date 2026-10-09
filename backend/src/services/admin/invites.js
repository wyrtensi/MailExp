import crypto from 'crypto';
import { query } from '../db.js';
import { decrypt } from '../encryption.js';
import { resolveForConnection } from '../hostValidation.js';
import { createSmtpTransport, systemSmtpOptions } from '../smtpTransport.js';
import { getConnectionPolicy } from '../connectionPolicy.js';

// Registration invites, shared by the admin API (routes/admin.js, /api/admin/invites) and the
// panel CLI (cli/commands/invite.js): the same checks, the same letter through the system SMTP
// (services/admin/systemEmail.js). Invites are not journaled, by the screen or the CLI.

// code -> [HTTP status, message].
export const INVITE_ERRORS = Object.freeze({
  email_invalid: [400, 'Valid email address required'],
  app_url_missing: [500, 'APP_URL is not configured — set it in .env before sending invites.'],
  not_found: [404, 'Invite not found'],
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INVITE_DAYS = 7;

// A page of invites, newest first: { invites, total }. Each carries its token (the registration
// link's secret), as the screen's list does.
export async function listInvites({ limit = 100, offset = 0 } = {}) {
  const [result, countResult] = await Promise.all([
    query(
      `SELECT i.id, i.email, i.token, i.created_at, i.expires_at, i.used_at,
              u.username as used_by_username
       FROM invites i
       LEFT JOIN users u ON i.used_by = u.id
       ORDER BY i.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query('SELECT COUNT(*) AS total FROM invites'),
  ]);
  return { invites: result.rows, total: parseInt(countResult.rows[0].total) };
}

// The system SMTP's transport and From header, or null when none is usable.
async function systemTransport() {
  const sysResult = await query("SELECT value FROM system_settings WHERE key = 'system_email_config'");
  if (!sysResult.rows.length) return null;
  try {
    const cfg = JSON.parse(sysResult.rows[0].value);
    const pass = cfg.pass ? decrypt(cfg.pass) : null;
    if (!(cfg.host && cfg.user && pass)) return null;
    const policy = await getConnectionPolicy();
    const sysResolved = await resolveForConnection(cfg.host, { allowPrivate: policy.allowPrivateHosts });
    const transport = createSmtpTransport(sysResolved, systemSmtpOptions({
      port: cfg.port || 587, user: cfg.user, pass, resolved: sysResolved, policy,
    }));
    return { transport, fromHeader: `${cfg.fromName || 'MailExpert'} <${cfg.fromEmail || cfg.user}>` };
  } catch {
    return null; // no usable system SMTP
  }
}

function inviteLetter(inviteUrl) {
  return {
    subject: 'You\'ve been invited to MailExpert',
    text: [
      `You've been invited to join MailExpert.`,
      ``,
      `Click the link below to create your account:`,
      `${inviteUrl}`,
      ``,
      `This invite expires in 7 days and can only be used once.`,
    ].join('\n'),
    html: `
          <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #1a1a1a;">
            <div style="margin-bottom: 24px;">
              <span style="font-size: 22px; font-weight: 700; color: #1a1a1a;">Mail</span><span style="font-size: 22px; font-weight: 600; color: #7c6af7;">Flow</span>
            </div>
            <h2 style="margin: 0 0 12px; font-size: 18px; font-weight: 600;">You've been invited</h2>
            <p style="color: #555; line-height: 1.6; margin: 0 0 24px;">
              You've been invited to join MailExpert. Click the button below to create your account.
            </p>
            <a href="${inviteUrl}" style="display: inline-block; padding: 12px 24px; background: #7c6af7; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">
              Accept Invite
            </a>
            <p style="color: #999; font-size: 12px; margin: 24px 0 0;">
              This invite expires in 7 days and can only be used once.<br>
              If you weren't expecting this, you can ignore this email.
            </p>
          </div>
        `,
  };
}

// Makes an invite for the email, valid for 7 days, created by the administrator createdBy (a user
// id: the column is required), and sends it through the system SMTP only: mailboxes belong to the
// team, not to the admin. Answers { inviteUrl, emailSent, emailError } or { error }. As the route
// always has, the invite is stored before APP_URL is checked.
export async function createInvite(rawEmail, createdBy) {
  if (!rawEmail || typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim())) return { error: 'email_invalid' };
  const email = rawEmail;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO invites (email, token, created_by, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email.trim().toLowerCase(), token, createdBy, expiresAt],
  );

  const appUrl = process.env.APP_URL;
  if (!appUrl) return { error: 'app_url_missing' };
  const inviteUrl = `${appUrl}/register?invite=${token}`;

  let emailSent = false;
  let emailError = null;
  try {
    const system = await systemTransport();
    if (system) {
      await system.transport.sendMail({ from: system.fromHeader, to: email, ...inviteLetter(inviteUrl) });
      emailSent = true;
    }
  } catch (err) {
    console.error('Invite email failed:', err.message);
    emailError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication|535|reject/i.test(err.message)
      ? 'Mail server error. Check your SMTP account settings.'
      : 'Failed to send invite email.';
  }
  return { inviteUrl, emailSent, emailError };
}

// Revokes (deletes) an invite: { ok, deleted } — deleted false when there was none, which the API
// still answers as ok.
export async function revokeInvite(id) {
  const result = await query('DELETE FROM invites WHERE id = $1', [id]);
  return { ok: true, deleted: (result?.rowCount ?? 0) > 0 };
}
