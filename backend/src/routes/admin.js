import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { invalidateConnectionPolicyCache } from '../services/connectionPolicy.js';
import { reloadAuthSettings } from '../services/authLimiter.js';
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { uuidParam } from '../utils/uuid.js';
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
import { reconnectAccount } from '../services/accounts/connection.js';
import { claimRulesRun, runClaimedRules } from '../services/rules/ruleActions.js';
import { listAuditEntries } from '../services/admin/auditQuery.js';
import { listAuthEvents } from '../services/authEvents.js';
import { INVITE_ERRORS, createInvite, listInvites, revokeInvite } from '../services/admin/invites.js';
import {
  SYSTEM_EMAIL_ERRORS, getSystemEmail, removeSystemEmail, saveSystemEmail, testSystemEmail,
} from '../services/admin/systemEmail.js';

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
  // A mailbox the CLI added or whose connection it changed.
  reconnectAccount: (accountId) => reconnectAccount(imapManager, accountId, { onlyActive: true }),
  // The CLI's "rule run": the sweep runs in the background, as POST /api/rules/run's does; a
  // mailbox already being swept is left to that run.
  runRules(accountIds) {
    if (!claimRulesRun(accountIds)) {
      console.warn('[admin] rules run skipped: a run is already sweeping one of these mailboxes');
      return;
    }
    runClaimedRules(accountIds, imapManager).then((result) => {
      console.log(`[admin] rules run ${result.ok ? `done: ${result.processed} processed, ${result.matched} matched` : 'failed'}`);
    });
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
  res.json(await listAuthEvents({ limit, offset }));
});

// ── Audit log ─────────────────────────────────────────────────────────────────

// Newest first, 100 per page. `from` is inclusive, `to` exclusive; `before` is the nextCursor
// of the previous page (services/admin/auditQuery.js, shared with the panel CLI).
router.get('/audit', async (req, res) => {
  const { account, user, action, from, to, before } = req.query;
  const result = await listAuditEntries({ account, user, action, from, to, before });
  if (result.error) return res.status(400).json({ error: 'Invalid audit filter', code: 'invalid_filter' });
  res.json(result);
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
  res.json(await listInvites({ limit, offset }));
});

// services/admin/invites.js holds the checks and the letter; these routes answer a refusal by its
// message only, as they always have.
function sendRefusal(res, catalog, result) {
  const [status, message] = catalog[result.error] ?? [500, result.error];
  return res.status(status).json({ error: result.message ?? message });
}

router.post('/invites', async (req, res) => {
  const result = await createInvite(req.body?.email, req.session.userId);
  if (result.error) return sendRefusal(res, INVITE_ERRORS, result);
  res.json({ ok: true, ...result });
});

router.delete('/invites/:id', async (req, res) => {
  await revokeInvite(req.params.id);
  res.json({ ok: true });
});

// ── System email (SMTP for sending invites & system messages) ──────────────────

// services/admin/systemEmail.js, shared with the panel CLI.
router.get('/system-email', async (req, res) => {
  res.json(await getSystemEmail());
});

router.post('/system-email', async (req, res) => {
  const result = await saveSystemEmail(req.body);
  if (result.error) return sendRefusal(res, SYSTEM_EMAIL_ERRORS, result);
  res.json({ ok: true });
});

router.post('/system-email/test', async (req, res) => {
  const result = await testSystemEmail();
  if (result.error) return sendRefusal(res, SYSTEM_EMAIL_ERRORS, result);
  res.json({ ok: true });
});

router.delete('/system-email', async (req, res) => {
  await removeSystemEmail();
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
