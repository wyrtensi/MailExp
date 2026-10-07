import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { recordAudit } from '../services/auditLog.js';
import { redactEmail } from '../utils/redact.js';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  hasGoogleMailScope,
  revokeGoogleToken,
  verifyGoogleIdToken,
} from '../services/oauth/googleOAuth.js';
import { recordGoogleGrant, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { createOAuthState, consumeOAuthState } from '../services/oauth/oauthState.js';
import { addSecondSenderName } from '../utils/senderNames.js';
import { GoogleAppSelectionError, releaseGoogleSeat, selectGoogleApp } from '../services/oauth/googleAppSelection.js';
import { consumeGoogleLaunch } from '../services/oauth/googleLaunch.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';
import { isUuid } from '../utils/uuid.js';
import { THREAD_MODE_GMAIL } from '../services/threading/threadId.js';

// Mounted at /oauth/google. Redirect targets carry only stable codes — never provider
// error text, authorization codes or tokens: /?oauth_success=google&oauth_result=<created|updated>,
// plus &oauth_notice=sender_name_duplicate when the form's second sender name was dropped, or
// /?oauth_error=<code>&oauth_provider=google.
const router = Router();

const PROVIDER = 'google';
// Codes the panel knows how to render; anything else collapses to authentication_failed.
const CALLBACK_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'missing_refresh_token', 'scope_missing', 'authentication_failed',
  'already_connected', 'account_mismatch', 'no_app_capacity',
]);
const ACCOUNT_COLORS = ['#ea4335', '#4285f4', '#34a853', '#fbbc05'];
const FLOW_MODES = new Set(['add', 'reconnect']);

class CallbackError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const errorRedirect = (code) => `/?oauth_error=${code}&oauth_provider=${PROVIDER}`;

// `?account=<id>` names the Gmail mailbox to reconnect; nothing else starts a flow here. Adding a
// mailbox goes through POST /api/oauth/google/start, where the CSRF check covers the seat it
// reserves, and the address never travels in a MailExpert URL.
async function resolveReconnectTarget(req) {
  const id = typeof req.query.account === 'string' ? req.query.account : '';
  if (!isUuid(id)) throw new CallbackError('invalid_state');
  const { rows } = await query(
    'SELECT id, email_address, oauth_provider, oauth_app_id FROM email_accounts WHERE id = $1',
    [id],
  );
  const account = rows[0];
  if (!account || account.oauth_provider !== PROVIDER) throw new CallbackError('invalid_state');
  return { email: account.email_address.toLowerCase(), account };
}

// Step 1 of a reconnect: pick the app, create state + PKCE and send the user to Google.
router.get('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // The screen-lock gate in index.js (#235) covers only /api. Only the start legs are refused:
  // the provider's callback lands in another tab while this one's auto-lock keeps counting.
  if (req.session.locked) return res.redirect(errorRedirect('locked'));

  let selected = null;
  let target = null;
  try {
    target = await resolveReconnectTarget(req);
    selected = await selectGoogleApp({ email: target.email, account: target.account });
    const config = await resolveGoogleConfig({ appId: selected.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    const { state, codeChallenge } = await createOAuthState({
      provider: PROVIDER,
      userId: req.session.userId,
      loginHint: target.email,
      appId: config.appId,
      mode: 'reconnect',
      email: target.email,
      accountId: target.account.id,
    });
    res.redirect(buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      state,
      codeChallenge,
      redirectUri: config.redirectUri,
      loginHint: target.email,
    }));
  } catch (err) {
    if (selected?.reserved) await releaseGoogleSeat(selected.appId, target.email);
    const known = err instanceof CallbackError || err instanceof GoogleAppSelectionError;
    if (!known) console.error(`Google OAuth start failed: ${err?.name || 'Error'}`);
    res.redirect(errorRedirect(known ? err.code : 'authentication_failed'));
  }
});

// Step 1b of the Gmail form: follow the one-time path created by POST /api/oauth/google/start.
router.get('/launch', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // A launch path minted before the lock must not start the flow afterwards.
  if (req.session.locked) return res.redirect(errorRedirect('locked'));
  const flow = typeof req.query.flow === 'string' ? req.query.flow : '';
  const url = await consumeGoogleLaunch({ flow, userId: req.session.userId });
  res.redirect(url || errorRedirect('invalid_state'));
});

// Step 2: Google redirects back with a code (or an error) and the state.
// Not refused for a locked session, by design: the provider sends the browser back in another
// tab while the panel tab's auto-lock keeps counting, so a flow started unlocked must still
// finish. A locked session cannot start one (the start legs refuse it), so this only completes
// a flow begun before the lock, for the user who began it.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  let issued = null;
  let pending = null;
  // Kept reserved until the grant is journaled, so a concurrent start never sees this seat as
  // free while the code exchange is in flight; released as soon as the journal write lands, or
  // in the catch below on any path that ends before that.
  let released = false;

  try {
    // Consume first so a state is burned whatever the outcome.
    pending = await consumeOAuthState({ provider: PROVIDER, state });

    if (error !== undefined) {
      throw new CallbackError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    // The flow must finish in the same MailExpert session that started it.
    if (!pending || !req.session?.userId || req.session.userId !== pending.userId) {
      throw new CallbackError('invalid_state');
    }
    // Only the two flows this version starts: a state issued before the update (the removed
    // upsert mode) or without an address cannot say what to check, so it is refused.
    if (!FLOW_MODES.has(pending.mode) || !pending.email) throw new CallbackError('invalid_state');
    // Finish with the app chosen at start: its client is the one Google issued the code to.
    const config = await resolveGoogleConfig({ appId: pending.appId, origin: allowedRequestOrigin(req) });
    if (!config) throw new CallbackError('not_configured');
    if (typeof code !== 'string' || !code) throw new CallbackError('authentication_failed');

    const tokens = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: config.redirectUri,
    });
    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId: config.clientId });
    issued = { appId: config.appId, tokens, email: identity.email };
    // Google counts this account against the app's user cap once it issued tokens, even if
    // the consent is refused below.
    await recordGoogleGrant({ appId: config.appId, email: identity.email, sub: identity.sub });
    // Now that the journal has the email, the reservation can go. A brief double count
    // (reservation + grant) is intended: it is only more conservative than the alternative of
    // releasing before the exchange, which would let the seat look free while it is in flight.
    if (pending.appId) {
      await releaseGoogleSeat(pending.appId, pending.email);
      released = true;
    }
    // The user may pick another Google account on Google's page than the one asked for.
    if (identity.email.toLowerCase() !== pending.email) throw new CallbackError('account_mismatch');
    if (!hasGoogleMailScope(tokens.scope)) throw new CallbackError('scope_missing');

    const { account, result, previousAppId, previousRefreshToken, senderNameDropped } =
      await saveGoogleAccount(pending, identity, tokens, config.appId);
    issued = null; // the tokens are stored now: nothing to revoke
    recordGoogleConsent({ userId: pending.userId, account, result, previousAppId, appId: config.appId });
    if (result === 'updated' && previousAppId && previousAppId !== config.appId) {
      // The old token belongs to a client the mailbox left; best effort, the reply does not wait.
      revokeGoogleToken(decrypt(previousRefreshToken)).catch(() => {});
    }

    reconnectAccount(account, result);
    // The second sender name from the form was not kept (same as the main one): say so.
    const notice = senderNameDropped ? '&oauth_notice=sender_name_duplicate' : '';
    res.redirect(`/?oauth_success=${PROVIDER}&oauth_result=${result}${notice}`);
  } catch (err) {
    const stable = typeof err?.code === 'string' && CALLBACK_ERROR_CODES.has(err.code)
      ? err.code
      : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google OAuth callback failed: ${stable} (${err?.name || 'Error'})`);
    if (pending?.appId && pending.email && !released) await releaseGoogleSeat(pending.appId, pending.email);
    if (issued) await revokeRefusedGrant(issued);
    res.redirect(errorRedirect(stable));
  }
});

// A refused consent must not leave a live grant behind. Google revokes a person's access to the
// whole project, not to one token, so skip it when that address already has a working mailbox on
// this app: revoking would cut that mailbox off too.
async function revokeRefusedGrant({ appId, tokens, email }) {
  try {
    const { rows } = await query(
      'SELECT 1 FROM email_accounts WHERE lower(email_address) = lower($1) AND oauth_app_id = $2 LIMIT 1',
      [email, appId],
    );
    if (rows.length) return;
    await revokeGoogleToken(tokens.refreshToken || tokens.accessToken);
  } catch (err) {
    console.error(`Google OAuth refused-grant cleanup failed: ${err?.name || 'Error'}`);
  }
}

// Create the mailbox of an `add` flow or refresh the one a `reconnect` names, under a
// transaction-scoped advisory lock so racing callbacks for one address cannot insert duplicates.
// Mailboxes are shared, so the address alone names one; userId only records who added it. The
// account is bound to the app whose client issued the tokens.
async function saveGoogleAccount(pending, identity, tokens, appId) {
  const email = identity.email.toLowerCase();
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${email}`]);

    // The app may have been disabled or removed while the code was exchanged, and disabling flags
    // only the mailboxes bound to it at that moment. FOR SHARE makes a disable that comes later
    // wait for this transaction, so it then flags the mailbox written here.
    const app = await client.query('SELECT status FROM google_oauth_apps WHERE id = $1 FOR SHARE', [appId]);
    if (!app.rows.length || app.rows[0].status === 'disabled') throw new CallbackError('not_configured');

    const existing = await client.query(
      `SELECT id, oauth_provider, oauth_refresh_token, oauth_app_id, oauth_subject, oauth_reconnect_required FROM email_accounts
       WHERE lower(email_address) = lower($1)
       ORDER BY created_at LIMIT 1`,
      [email],
    );
    const row = existing.rows[0] || null;
    if (pending.mode === 'add' && row) throw new CallbackError('already_connected');
    if (pending.mode === 'reconnect' && (!row || row.id !== pending.accountId || row.oauth_provider !== PROVIDER)) {
      throw new CallbackError('invalid_state');
    }
    // A Gmail address is never reissued, so another subject means another Google account.
    if (row?.oauth_subject && row.oauth_subject !== identity.sub) throw new CallbackError('account_mismatch');

    let accountId;
    let result;
    let previousAppId = null;
    let senderNameDropped = false;
    if (row) {
      previousAppId = row.oauth_app_id;
      // A stored refresh token only works with the app that issued it, so it can be kept
      // only when the account stays on the same app, and never when the mailbox is flagged for
      // reconnect: that flag is set when Google rejected the stored token (invalid_grant), so
      // keeping it would report success and fail again on the next refresh. The consent URL asks
      // for offline access with prompt=consent, so Google normally returns a new one.
      const canKeepStoredRefresh = !!row.oauth_refresh_token && row.oauth_app_id === appId && !row.oauth_reconnect_required;
      if (!encryptedRefresh && !canKeepStoredRefresh) throw new CallbackError('missing_refresh_token');
      accountId = row.id;
      result = 'updated';
      await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1,
          oauth_refresh_token = COALESCE($2, oauth_refresh_token),
          oauth_token_expiry = $3,
          oauth_provider = 'google', oauth_public_client = false, auth_user = email_address,
          imap_host = 'imap.gmail.com', imap_port = 993, imap_tls = true,
          smtp_host = 'smtp.gmail.com', smtp_port = 465, smtp_tls = 'SSL',
          oauth_app_id = $4, oauth_subject = $5,
          oauth_reconnect_required = false, sync_error = NULL
        WHERE id = $6
      `, [encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub, accountId]);
    } else {
      if (!encryptedRefresh) throw new CallbackError('missing_refresh_token');
      const color = ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)];
      // A new Gmail mailbox threads by Gmail's own thread number from its first sync: the sync
      // stores X-GM-THRID for every message of a Gmail host, and rows the app appends itself are
      // rekeyed by the provider id backfill. Existing mailboxes keep their mode (owner decision
      // 2026-09-21); switching one is the admin's threading action.
      const inserted = await client.query(`
        INSERT INTO email_accounts (
          added_by, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_reconnect_required, include_in_unified_inbox,
          oauth_app_id, oauth_subject, thread_mode, sender_name
        ) VALUES ($1, $2, $3, $4, 'imap',
          'imap.gmail.com', 993, true,
          'smtp.gmail.com', 465, 'SSL',
          $3,
          'google', $5, $6, $7,
          false, false, true,
          $8, $9, $10, $11)
        RETURNING id
      `, [pending.userId, identity.name || email, email, color, encryptedAccess, encryptedRefresh, tokens.expiresAt, appId, identity.sub, THREAD_MODE_GMAIL, pending.senderName]);
      accountId = inserted.rows[0].id;
      // Without a main name the mailbox sends under the Google profile name, known only now: a
      // second name equal to it would list the same From twice.
      const mainName = (pending.senderName || identity.name || email).toLowerCase();
      const secondName = pending.senderNameAlt && pending.senderNameAlt.toLowerCase() !== mainName ? pending.senderNameAlt : null;
      await addSecondSenderName(client, { accountId, email, senderNameAlt: secondName });
      senderNameDropped = !!pending.senderNameAlt && !secondName;
      result = 'created';
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return {
      account: accountResult.rows[0], result, previousAppId, previousRefreshToken: row?.oauth_refresh_token ?? null, senderNameDropped,
    };
  });
}

// Journal the consent: a new mailbox is an addition, an existing one a reconnect, and moving the
// mailbox to another Google app also changes its connection.
function recordGoogleConsent({ userId, account, result, previousAppId, appId }) {
  const entry = { actorUserId: userId, accountId: account.id };
  if (result === 'created') {
    recordAudit([{ ...entry, action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: PROVIDER } }]);
    return;
  }
  const entries = [{ ...entry, action: 'mailbox.reconnected', details: { oauthProvider: PROVIDER } }];
  if (previousAppId !== appId) {
    entries.push({ ...entry, action: 'mailbox.connection_changed', details: { fields: ['oauth_app_id'] } });
  }
  recordAudit(entries);
}

// Bring the mailbox online with the new tokens. An updated account may still hold a
// connection built from the old (possibly revoked) token, so restart it.
function reconnectAccount(account, result) {
  const connect = () => {
    // Fresh tokens from a (re)consent: lift any auth cooldown left by the old, rejected grant.
    imapManager.clearConnectCooldown(account.id);
    return imapManager.connectAccount(account);
  };
  const run = result === 'updated'
    ? Promise.resolve(imapManager.disconnectAccount(account.id)).catch(() => {}).then(connect)
    : connect();
  Promise.resolve(run).catch((err) =>
    console.error(`Google OAuth connect failed for ${redactEmail(account.email_address)}: ${err?.name || 'Error'}`),
  );
}

export default router;
