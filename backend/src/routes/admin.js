import { Router } from 'express';
import crypto from 'crypto';
import { query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { validateHost, resolveForConnection } from '../services/hostValidation.js';
import { createSmtpTransport } from '../services/smtpTransport.js';
import { getConnectionPolicy, invalidateConnectionPolicyCache } from '../services/connectionPolicy.js';
import { reloadAuthSettings } from '../services/authLimiter.js';
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { UUID_RE, uuidParam } from '../utils/uuid.js';
import { AUDIT_ACTIONS } from '../services/auditLog.js';
import { routeActor } from '../services/actor.js';
import { applyAdminEffects, registerAdminEffectsJobKind } from '../services/admin/adminEffects.js';
import {
  ADMIN_USER_ERRORS, createUser, deleteUser, disableUserTotp, listUsers, updateUser,
} from '../services/admin/users.js';
import {
  SYSTEM_SETTINGS_CODED, SYSTEM_SETTINGS_ERRORS, updateSystemSettings,
} from '../services/admin/systemSettings.js';
import {
  OIDC_PROVIDER_ERRORS, createOidcProvider, deleteOidcProvider, listOidcProviders, updateOidcProvider,
} from '../services/auth/oidcProviders.js';
import { reloadMicrosoftEnv } from '../services/integrations/microsoft.js';
import { closeUserSockets } from '../services/websocket.js';
import { destroyUserSessions } from './auth.js';
import accessSyncRoutes from './accessSync.js';
import googleAppsAdminRoutes from './googleAppsAdmin.js';
import adminUpdateRoutes from './adminUpdate.js';
import { requestAccessSync } from '../services/accessSync/index.js';
import { loadSyncSettings } from '../services/syncSettings.js';

const router = Router();
router.use(requireAdmin);
// Reject a malformed :id (user UUID) with a 400 before it reaches a uuid-typed query.
router.param('id', uuidParam('id'));
router.use('/access-sync', accessSyncRoutes);
router.use('/google-apps', googleAppsAdminRoutes);
// Updating the panel from the admin UI; the sub-router validates its own :id.
router.use('/update', adminUpdateRoutes);

// ── Users ──────────────────────────────────────────────────────────────────────

// A refusal of services/admin/users.js as the API answers it: the message and the code, or only the
// message where these routes never answered a code.
function sendUserRefusal(res, result, { withCode = true } = {}) {
  const [status, message] = ADMIN_USER_ERRORS[result.error] ?? [500, result.error];
  return res.status(status).json({ error: result.message ?? message, ...(withCode ? { code: result.error } : {}) });
}

// End every session and live socket of a user who just lost access.
async function signOutEverywhere(userId) {
  await destroyUserSessions(userId);
  closeUserSockets(imapManager.wss, userId);
}

// What an admin change still asks of this process (services/admin/adminEffects.js). The panel CLI
// queues the same effects; the backend's job worker applies them with these hooks (index.js).
export const ADMIN_EFFECT_HOOKS = Object.freeze({
  signOutUser: signOutEverywhere,
  // Let plugins clean up any user-scoped data the FK cascade can't reach (GTD removes the
  // imported pet, stored under a slug derived from the user id rather than an FK). Best-effort
  // and after the delete; the hook swallows per-plugin errors.
  onUserDelete: (userId) => pluginRegistry.runHook('onUserDelete', { userId }),
  requestAccessSync: (trigger) => requestAccessSync(trigger),
  reload: {
    auth_limits: () => reloadAuthSettings(),
    // Running mailboxes pick the new cadence up without reconnecting.
    async sync_intervals() {
      try {
        await imapManager.applySyncSettings(await loadSyncSettings());
      } catch (err) {
        console.error('Applying mailbox sync intervals failed:', err.message);
      }
    },
    categorization: () => invalidateGlobalCategorizationCache(),
    connection_policy: () => invalidateConnectionPolicyCache(),
    microsoft: () => reloadMicrosoftEnv(),
  },
});

const applyEffects = (effects) => applyAdminEffects(effects, ADMIN_EFFECT_HOOKS);

// Called once at startup (index.js): the backend's job worker applies what the CLI queued.
export function registerAdminEffectsJob() {
  registerAdminEffectsJobKind(ADMIN_EFFECT_HOOKS);
}

router.get('/users', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0,   0);
  res.json(await listUsers({ limit, offset }));
});

// Approving an email is what lets a person sign in when AUTH_MODE=google.
router.post('/users', async (req, res) => {
  const result = await createUser(req.body?.email, routeActor(req));
  if (result.error) return sendUserRefusal(res, result);
  await applyEffects(result.effects);
  console.log(`[admin] ${req.session.userId} approved user ${result.user.id}`);
  return res.status(result.created ? 201 : 200).json({ user: result.user });
});

router.post('/users/:id/totp/disable', async (req, res) => {
  const { id } = req.params;
  const result = await disableUserTotp(id, routeActor(req));
  if (result.error) return sendUserRefusal(res, result, { withCode: false });
  console.log(`[admin] ${req.session.username} disabled 2FA for user ${result.username} (${id})`);
  res.json({ ok: true });
});

router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const result = await updateUser(id, req.body || {}, routeActor(req));
  if (result.error) return sendUserRefusal(res, result);
  await applyEffects(result.effects);
  console.log(`[admin] ${req.session.userId} updated user ${id}`);
  return res.json({ ok: true, user: result.user });
});

router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  const result = await deleteUser(id, routeActor(req));
  // Refusing the actor's own account answered no code; the guard refusals do.
  if (result.error) return sendUserRefusal(res, result, { withCode: result.error !== 'self_change' });
  await applyEffects(result.effects);
  console.log(`[admin] ${req.session.userId} deleted user ${id}`);
  res.json({ ok: true });
});

// ── System settings ────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  const result = await query('SELECT key, value FROM system_settings');
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  res.json({ settings });
});

router.get('/auth-events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const [eventsResult, countResult] = await Promise.all([
    query(
      `SELECT id, event_type, username, user_id, ip, success, created_at
       FROM auth_events ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    query('SELECT COUNT(*) AS total FROM auth_events'),
  ]);
  res.json({ events: eventsResult.rows, total: parseInt(countResult.rows[0].total) });
});

// ── Audit log ─────────────────────────────────────────────────────────────────

const AUDIT_PAGE_SIZE = 100;
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);
// The cursor is produced by the database with microsecond precision, which a JS Date would lose.
const AUDIT_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_(\d{1,19})$/;

class AuditFilterError extends Error {}

function parseAuditTime(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw new AuditFilterError();
  return date.toISOString();
}

// Newest first, 100 per page. `from` is inclusive, `to` exclusive; `before` is the nextCursor
// of the previous page.
router.get('/audit', async (req, res) => {
  const { account, user, action, from, to, before } = req.query;
  const where = [];
  const params = [];
  const add = (clause, ...values) => {
    const placeholders = values.map((value) => { params.push(value); return `$${params.length}`; });
    where.push(clause(...placeholders));
  };

  try {
    if (account !== undefined) {
      if (typeof account !== 'string' || !UUID_RE.test(account)) throw new AuditFilterError();
      add((p) => `account_id = ${p}`, account);
    }
    if (user !== undefined) {
      if (typeof user !== 'string' || !UUID_RE.test(user)) throw new AuditFilterError();
      add((p) => `actor_user_id = ${p}`, user);
    }
    if (action !== undefined) {
      if (!AUDIT_ACTION_SET.has(action)) throw new AuditFilterError();
      add((p) => `action = ${p}`, action);
    }
    if (from !== undefined) add((p) => `occurred_at >= ${p}`, parseAuditTime(from));
    if (to !== undefined) add((p) => `occurred_at < ${p}`, parseAuditTime(to));
    if (before !== undefined) {
      const match = typeof before === 'string' ? AUDIT_CURSOR_RE.exec(before) : null;
      if (!match) throw new AuditFilterError();
      add((at, id) => `(occurred_at, id) < (${at}::timestamptz, ${id}::bigint)`, match[1], match[2]);
    }
  } catch (err) {
    if (!(err instanceof AuditFilterError)) throw err;
    return res.status(400).json({ error: 'Invalid audit filter', code: 'invalid_filter' });
  }

  params.push(AUDIT_PAGE_SIZE + 1);
  const { rows } = await query(
    `SELECT id::text AS id, occurred_at,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            actor_user_id, actor_email, account_id, account_email, action, details
       FROM mailbox_audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page[page.length - 1];
  res.json({
    entries: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      accountId: r.account_id,
      accountEmail: r.account_email,
      action: r.action,
      details: r.details,
    })),
    nextCursor: rows.length > AUDIT_PAGE_SIZE ? `${last.cursor_at}_${last.id}` : null,
  });
});

router.patch('/settings', async (req, res) => {
  const result = await updateSystemSettings(req.body, routeActor(req));
  await applyEffects(result.effects);
  if (result.error) {
    const [status, message] = SYSTEM_SETTINGS_ERRORS[result.error] ?? [500, result.error];
    return res.status(status).json({
      error: result.message ?? message,
      ...(SYSTEM_SETTINGS_CODED.has(result.error) ? { code: result.error } : {}),
    });
  }
  res.json({ ok: true });
});

// ── Invites ────────────────────────────────────────────────────────────────────

router.get('/invites', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0,   0);
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
  res.json({ invites: result.rows, total: parseInt(countResult.rows[0].total) });
});

router.post('/invites', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  // Generate a 32-byte hex token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO invites (email, token, created_by, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email.trim().toLowerCase(), token, req.session.userId, expiresAt]
  );

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    return res.status(500).json({ error: 'APP_URL is not configured — set it in .env before sending invites.' });
  }
  const inviteUrl = `${appUrl}/register?invite=${token}`;

  // Send the invite through the system SMTP only: mailboxes belong to the team, not to the admin.
  let emailSent = false;
  let emailError = null;
  try {
    let transport = null;
    let fromHeader = null;

    // 1. System SMTP (configured in Admin → Users → System Email)
    const sysResult = await query(
      "SELECT value FROM system_settings WHERE key = 'system_email_config'"
    );
    if (sysResult.rows.length) {
      try {
        const cfg = JSON.parse(sysResult.rows[0].value);
        const pass = cfg.pass ? decrypt(cfg.pass) : null;
        if (cfg.host && cfg.user && pass) {
          const policy = await getConnectionPolicy();
          const sysResolved = await resolveForConnection(cfg.host, { allowPrivate: policy.allowPrivateHosts });
          const sysTls = { rejectUnauthorized: true };
          if (sysResolved.servername) sysTls.servername = sysResolved.servername;
          transport = createSmtpTransport(sysResolved, {
            port: cfg.port || 587,
            secure: (cfg.port || 587) === 465,
            auth: { user: cfg.user, pass },
            tls: sysTls,
          });
          fromHeader = `${cfg.fromName || 'MailExpert'} <${cfg.fromEmail || cfg.user}>`;
        }
      } catch { /* no usable system SMTP */ }
    }

    if (transport) {
      await transport.sendMail({
        from: fromHeader,
        to: email,
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
      });
      emailSent = true;
    }
  } catch (err) {
    console.error('Invite email failed:', err.message);
    emailError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication|535|reject/i.test(err.message)
      ? 'Mail server error. Check your SMTP account settings.'
      : 'Failed to send invite email.';
  }

  res.json({ ok: true, inviteUrl, emailSent, emailError });
});

router.delete('/invites/:id', async (req, res) => {
  await query('DELETE FROM invites WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── System email (SMTP for sending invites & system messages) ──────────────────

router.get('/system-email', async (req, res) => {
  const result = await query(
    "SELECT value FROM system_settings WHERE key = 'system_email_config'"
  );
  if (!result.rows.length) return res.json({ config: null });
  try {
    const cfg = JSON.parse(result.rows[0].value);
    // Never expose the raw password — return a sentinel so the UI can show a placeholder
    res.json({ config: { ...cfg, pass: cfg.pass ? '••••••••' : '' } });
  } catch {
    res.json({ config: null });
  }
});

router.post('/system-email', async (req, res) => {
  const { host, port, tls, user, pass, fromName, fromEmail } = req.body;
  if (!host || !user) {
    return res.status(400).json({ error: 'SMTP host and username are required' });
  }

  // Honor the admin's "Allow private / local hosts" policy, exactly as the personal
  // account routes do — a self-hosted System Email relay on a private IP must be
  // accepted when the toggle is on (#358). With it off, the private/reserved check stands.
  const policy = await getConnectionPolicy();
  const hostErr = await validateHost(host, { allowPrivate: policy.allowPrivateHosts });
  if (hostErr) return res.status(400).json({ error: hostErr });

  // Load existing config so we can keep the encrypted password if the field wasn't changed
  let existingPass = null;
  const existing = await query(
    "SELECT value FROM system_settings WHERE key = 'system_email_config'"
  );
  if (existing.rows.length) {
    try { existingPass = JSON.parse(existing.rows[0].value).pass; } catch { /* keep existingPass null */ }
  }

  const encryptedPass = pass && pass !== '••••••••'
    ? encrypt(pass)
    : (existingPass || null);

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
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('system_email_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(cfg)]
  );
  res.json({ ok: true });
});

router.post('/system-email/test', async (req, res) => {
  const result = await query(
    "SELECT value FROM system_settings WHERE key = 'system_email_config'"
  );
  if (!result.rows.length) {
    return res.status(400).json({ error: 'No system email configured' });
  }
  let cfg;
  try { cfg = JSON.parse(result.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted system email config' });
  }
  const pass = cfg.pass ? decrypt(cfg.pass) : null;
  if (!pass) {
    return res.status(400).json({ error: 'No password stored — save the configuration first' });
  }
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
    // Greet the server as the real send does (services/mailer.js sends from this address), so
    // the test checks the same EHLO name the mail will use.
    await transport.verify(cfg.fromEmail || cfg.user);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/system-email', async (req, res) => {
  await query("DELETE FROM system_settings WHERE key = 'system_email_config'");
  res.json({ ok: true });
});

// ── OIDC providers ─────────────────────────────────────────────────────────────

// services/auth/oidcProviders.js holds the checks; these routes answer a refusal by its message.
function sendOidcRefusal(res, result) {
  const [status, message] = OIDC_PROVIDER_ERRORS[result.error] ?? [500, result.error];
  return res.status(status).json({ error: result.message ?? message });
}

router.get('/oidc', async (req, res) => {
  res.json(await listOidcProviders());
});

router.post('/oidc', async (req, res) => {
  const result = await createOidcProvider(req.body);
  if (result.error) return sendOidcRefusal(res, result);
  res.json({ provider: result.provider });
});

router.patch('/oidc/:id', async (req, res) => {
  const result = await updateOidcProvider(req.params.id, req.body);
  if (result.error) return sendOidcRefusal(res, result);
  res.json({ provider: result.provider });
});

router.delete('/oidc/:id', async (req, res) => {
  const result = await deleteOidcProvider(req.params.id);
  if (result.error) return sendOidcRefusal(res, result);
  res.json({ ok: true });
});

export default router;
