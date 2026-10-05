import { randomBytes } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt } from '../services/encryption.js';
import { recordAudit } from '../services/auditLog.js';
import {
  MICROSOFT_AUTH_URL, getMsConfig, microsoftSubject, refreshMicrosoftToken, verifiedMicrosoftAddress,
} from '../services/oauth/microsoftOAuth.js';
import { redactEmail } from '../utils/redact.js';
import { isUuid } from '../utils/uuid.js';
import { isAdminRequest } from '../middleware/auth.js';
import googleOAuthRoutes from './oauthGoogle.js';

// Cache JWKS fetchers per tenant — createRemoteJWKSet handles caching internally.
const jwksCache = new Map();
function getMsJwks(tenantId) {
  if (!jwksCache.has(tenantId)) {
    jwksCache.set(tenantId, createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    ));
  }
  return jwksCache.get(tenantId);
}

const router = Router();

// Google authorization-code + PKCE flow: GET /oauth/google and /oauth/google/callback.
router.use('/google', googleOAuthRoutes);

// In-memory store for pending device code flows — keyed by userId.
// Device codes expire in 15 minutes so no persistence is needed.
const deviceFlows = new Map();

const PROVIDER = 'microsoft';
// Stable codes the callback redirects with (`/?oauth_error=<code>&oauth_provider=microsoft`) and
// the device-code poll answers with; provider text never reaches the browser.
const CALLBACK_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'authentication_failed', 'already_connected', 'account_mismatch', 'redirect_not_configured',
]);

class MicrosoftOAuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const errorRedirect = (code) => `/?oauth_error=${code}&oauth_provider=${PROVIDER}`;
const stableCode = (err) => (err instanceof MicrosoftOAuthError && CALLBACK_ERROR_CODES.has(err.code)
  ? err.code
  : 'authentication_failed');

// The two flows, as in routes/oauthGoogle.js: `add` creates a mailbox and refuses an address
// that already has one; `reconnect` (`?account=<id>`) renews the tokens of that one Microsoft
// mailbox. Neither ever touches a mailbox of another provider, one added with a password or one
// on the mail node.
async function resolveFlow(accountParam) {
  if (accountParam === undefined || accountParam === '') return { mode: 'add', accountId: null, email: null };
  if (!isUuid(accountParam)) throw new MicrosoftOAuthError('invalid_state');
  const { rows } = await query(
    'SELECT id, email_address, oauth_provider, mail_node FROM email_accounts WHERE id = $1',
    [accountParam],
  );
  const row = rows[0];
  if (!row || row.oauth_provider !== PROVIDER || row.mail_node) throw new MicrosoftOAuthError('invalid_state');
  return { mode: 'reconnect', accountId: row.id, email: row.email_address };
}

// Mailboxes connect on their own; adding a Microsoft mailbox or renewing its sign-in by hand is an
// administrator's job (the panel offers both only to administrators). Both start legs refuse anyone
// else, so the callback and the device-code poll only ever finish a flow an administrator began.

// Step 1: redirect user to Microsoft login
router.get('/microsoft', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // The screen-lock gate in index.js (#235) covers only /api. Only the start legs are refused:
  // the provider's callback lands in another tab while this one's auto-lock keeps counting.
  if (req.session.locked) return res.redirect(errorRedirect('locked'));
  if (!(await isAdminRequest(req))) return res.redirect(errorRedirect('admin_required'));

  const { clientId, tenantId, redirectUri } = getMsConfig();
  if (!clientId || !tenantId) return res.redirect(errorRedirect('not_configured'));

  let flow;
  try {
    flow = await resolveFlow(req.query.account);
  } catch (err) {
    return res.redirect(errorRedirect(stableCode(err)));
  }

  // Only the device-code flow is set up (no redirect URI): say so, with the mailbox to reconnect,
  // so the panel runs the device-code flow for it instead (POST /microsoft/device { account }).
  if (!redirectUri) {
    const account = flow.accountId ? `&oauth_account=${encodeURIComponent(flow.accountId)}` : '';
    return res.redirect(`${errorRedirect('redirect_not_configured')}${account}`);
  }

  // Generate a random CSRF nonce for the state parameter and store it alongside
  // the userId so the callback can verify it without trusting the state value.
  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;
  req.session.oauthMode = flow.mode;
  req.session.oauthAccountId = flow.accountId;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    state: oauthNonce,
    prompt: 'select_account',
  });
  if (flow.email) params.set('login_hint', flow.email);

  // Save session before redirecting so the nonce is committed to the store
  // before the external provider redirects back with the authorization code.
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/authorize?${params}`);
});

// Step 2: Microsoft redirects back here with auth code
// Not refused for a locked session, by design: the provider sends the browser back in another
// tab while the panel tab's auto-lock keeps counting, so a flow started unlocked must still
// finish. A locked session cannot start one (the start legs refuse it), so this only completes
// a flow begun before the lock, for the user who began it.
router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    // Microsoft's error_description is provider text: logged by code only, never echoed.
    console.error(`Microsoft OAuth error: ${typeof error === 'string' ? error.slice(0, 64) : 'unknown'}`);
    return res.redirect(errorRedirect(error === 'access_denied' ? 'access_denied' : 'authentication_failed'));
  }

  // Validate CSRF nonce BEFORE making any external requests
  if (!state || state !== req.session.oauthNonce) {
    return res.redirect(errorRedirect('invalid_state'));
  }
  const userId = req.session.oauthUserId;
  const flow = { mode: req.session.oauthMode, accountId: req.session.oauthAccountId ?? null };
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;
  delete req.session.oauthMode;
  delete req.session.oauthAccountId;
  if (!userId) return res.redirect(errorRedirect('invalid_state'));
  // A state issued before the two flows existed says neither: refused, as the Google flow does.
  if (flow.mode !== 'add' && flow.mode !== 'reconnect') return res.redirect(errorRedirect('invalid_state'));

  const { clientId, clientSecret, tenantId, redirectUri } = getMsConfig();

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new MicrosoftOAuthError('authentication_failed');

    // Authorization-code flow uses the client secret → confidential client.
    await processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient: false, ...flow });

    // Redirect back to app with success
    res.redirect('/?oauth_success=microsoft');
  } catch (err) {
    const stable = stableCode(err);
    console.error(`Microsoft OAuth callback failed: ${stable} (${err?.name || 'Error'})`);
    res.redirect(errorRedirect(stable));
  }
});

// Validates the ID token and returns { email, subject, displayName } of the person who signed in.
async function microsoftIdentity(idToken, { tenantId, clientId }) {
  if (!idToken) throw new MicrosoftOAuthError('authentication_failed');
  const verifyOpts = { audience: clientId };
  // For multi-tenant ('common'/'organizations'/'consumers'), issuers vary per tenant,
  // so we skip issuer validation and rely on audience + signature instead.
  const fixedTenants = new Set(['common', 'organizations', 'consumers']);
  if (!fixedTenants.has(tenantId)) {
    verifyOpts.issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getMsJwks(tenantId), verifyOpts));
  } catch (jwtErr) {
    console.error(`Microsoft id_token validation failed: ${jwtErr?.code || jwtErr?.name || 'Error'}`);
    throw new MicrosoftOAuthError('authentication_failed');
  }
  // With a multi-tenant authority the keys are Microsoft's common set, so a token from ANY tenant
  // verifies, an attacker's own tenant included. This check only makes sure the token is
  // consistent with itself (its issuer names its own tenant); it does not limit which tenant may
  // sign in and does not prove who the user is. That is done by the verified address and the
  // tid+oid subject below (services/oauth/microsoftOAuth.js).
  if (fixedTenants.has(tenantId) && payload.tid && payload.iss) {
    const expectedIss = `https://login.microsoftonline.com/${payload.tid}/v2.0`;
    if (payload.iss !== expectedIss) {
      console.error('Microsoft id_token issuer does not match its tenant');
      throw new MicrosoftOAuthError('authentication_failed');
    }
  }
  const subject = microsoftSubject(payload);
  if (!subject) throw new MicrosoftOAuthError('authentication_failed');
  const email = verifiedMicrosoftAddress(payload, { singleTenant: !fixedTenants.has(tenantId) });
  if (!email) throw new MicrosoftOAuthError('email_not_verified');
  return { email, subject, displayName: typeof payload.name === 'string' ? payload.name : null };
}

// Shared: validate tokens, create or renew the mailbox, connect IMAP.
async function processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient = false, mode, accountId = null }) {
  const { access_token, refresh_token, expires_in, id_token } = tokens;
  const expiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSecs * 1000);

  // The access_token is scoped to outlook.office.com (IMAP/SMTP) and cannot be used
  // with graph.microsoft.com, so id_token is the right source for who signed in.
  const { email, subject, displayName } = await microsoftIdentity(id_token, { tenantId, clientId });

  // Serialize the check-then-insert per mailbox address with a transaction-scoped advisory
  // lock. Two OAuth callbacks racing for the same mailbox would otherwise both miss the SELECT
  // and each INSERT, producing duplicate account rows. Mailboxes are shared, so the address alone
  // names one.
  const { account, created } = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-account:${email}`]);

    // A reconnect reads the mailbox it names, by id, and compares its address; an add looks for
    // any mailbox with the address.
    const existing = mode === 'reconnect'
      ? await client.query(
        'SELECT id, email_address, oauth_provider, oauth_subject, mail_node FROM email_accounts WHERE id = $1',
        [accountId],
      )
      : await client.query(
        `SELECT id, email_address, oauth_provider, oauth_subject, mail_node FROM email_accounts
          WHERE lower(email_address) = lower($1) ORDER BY created_at LIMIT 1`,
        [email],
      );
    const row = existing.rows[0] || null;

    let id;
    if (mode === 'reconnect') {
      if (!row || row.oauth_provider !== PROVIDER || row.mail_node) throw new MicrosoftOAuthError('invalid_state');
      // The person picked another account on Microsoft's page than the mailbox being reconnected.
      if (String(row.email_address).toLowerCase() !== email) throw new MicrosoftOAuthError('account_mismatch');
      // Same address, other Microsoft user (another tenant claiming the domain, or a recreated
      // account): never hand it this mailbox. A mailbox connected before the subject was stored
      // takes the subject of its first verified reconnect.
      if (row.oauth_subject && row.oauth_subject !== subject) throw new MicrosoftOAuthError('account_mismatch');
      id = row.id;
      // A fresh consent clears a reconnect flag set by the token manager on invalid_grant;
      // otherwise the flag would refuse every later refresh of the new refresh token.
      // The WHERE repeats the checks above, so a row changed meanwhile is left alone.
      const updated = await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1, oauth_refresh_token = COALESCE($2, oauth_refresh_token), oauth_token_expiry = $3,
          oauth_public_client = $4, oauth_subject = $5,
          auth_user = email_address,
          imap_host = 'outlook.office365.com', imap_port = 993, imap_tls = true,
          smtp_host = 'smtp.office365.com', smtp_port = 587, smtp_tls = 'STARTTLS',
          oauth_reconnect_required = false, sync_error = NULL
        WHERE id = $6 AND oauth_provider = 'microsoft' AND mail_node IS NOT TRUE
          AND (oauth_subject IS NULL OR oauth_subject = $5)
      `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, publicClient, subject, id]);
      if (!updated.rowCount) throw new MicrosoftOAuthError('invalid_state');
    } else {
      // Adding never takes over an existing mailbox, whatever it is.
      if (row) throw new MicrosoftOAuthError('already_connected');
      const colors = ['#0078d4', '#106ebe', '#005a9e', '#004578'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const result = await client.query(`
        INSERT INTO email_accounts (
          added_by, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_subject
        ) VALUES ($1,$2,$3,$4,'imap',
          'outlook.office365.com', 993, true,
          'smtp.office365.com', 587, 'STARTTLS',
          $3,
          'microsoft', $5, $6, $7,
          $8, $9)
        RETURNING *
      `, [userId, displayName || email, email, color, encrypt(access_token), encrypt(refresh_token), expiry, publicClient, subject]);
      id = result.rows[0].id;
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [id]);
    return { account: accountResult.rows[0], created: mode !== 'reconnect' };
  });

  recordAudit({
    actorUserId: userId,
    accountId: account.id,
    action: created ? 'mailbox.added' : 'mailbox.reconnected',
    details: created ? { protocol: 'imap', oauthProvider: PROVIDER } : { oauthProvider: PROVIDER },
  });

  // Fresh tokens from a (re)consent: lift any auth cooldown left by the old, rejected grant.
  imapManager.clearConnectCooldown(account.id);
  const connect = () => imapManager.connectAccount(account);
  // A renewed mailbox may still hold a connection built from the old token: restart it.
  const run = created ? connect() : Promise.resolve(imapManager.disconnectAccount(account.id)).catch(() => {}).then(connect);
  Promise.resolve(run).catch(err =>
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err?.message)
  );
  return email;
}

// Device-code failures reach the browser only as these stable messages: Microsoft's
// error_description (AADSTS text, trace IDs) is provider text and is never echoed.
const DEVICE_START_FAILED = { error: 'Failed to start device code flow', code: 'device_code_start_failed' };
const DEVICE_TOKEN_FAILED = { status: 'error', error: 'Token exchange failed', code: 'device_code_token_failed' };

// Log detail for a thrown device-code error. A JSON parse error quotes the start of the
// response body, so only its type is logged.
function deviceErrorDetail(err) {
  if (err instanceof SyntaxError) return 'unparseable provider response';
  return err?.cause?.code ? `${err.message} (${err.cause.code})` : err?.message;
}

// Step 1: initiate device code flow — returns user_code + verification_uri to the frontend.
// `account` (body or query) names the Microsoft mailbox to reconnect; without it, a mailbox is added.
router.post('/microsoft/device', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // Same answer as the /api lock gate in index.js, which does not cover /oauth.
  if (req.session.locked) return res.status(423).json({ error: 'Locked', locked: true });
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
  const { clientId, tenantId } = getMsConfig();
  if (!clientId || !tenantId) {
    return res.status(400).json({ error: 'Microsoft integration not configured. Set Client ID and Tenant ID in the Integrations tab.' });
  }

  let flow;
  try {
    flow = await resolveFlow(req.body?.account ?? req.query.account);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid mailbox', code: stableCode(err) });
  }

  try {
    const dcRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const dc = await dcRes.json();
    if (!dcRes.ok) {
      console.error(`Device code init rejected: HTTP ${dcRes.status}, error=${dc.error || 'unknown'}`);
      return res.status(500).json(DEVICE_START_FAILED);
    }

    deviceFlows.set(req.session.userId, {
      deviceCode: dc.device_code,
      tenantId,
      clientId,
      mode: flow.mode,
      accountId: flow.accountId,
      expiresAt: Date.now() + dc.expires_in * 1000,
    });

    res.json({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      expiresIn: dc.expires_in,
      interval: dc.interval || 5,
    });
  } catch (err) {
    console.error('Device code init error:', deviceErrorDetail(err));
    res.status(500).json(DEVICE_START_FAILED);
  }
});

// Step 2: poll for token — called repeatedly by the frontend until resolved.
router.get('/microsoft/device/poll', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // The poll is made by the panel tab that is now locked, so refusing it costs nothing; the
  // pending flow is kept, so polling can resume after unlock until it expires.
  if (req.session.locked) return res.status(423).json({ error: 'Locked', locked: true });
  const flow = deviceFlows.get(req.session.userId);
  if (!flow) return res.status(400).json({ status: 'error', error: 'No pending device code flow' });
  if (Date.now() > flow.expiresAt) {
    deviceFlows.delete(req.session.userId);
    return res.json({ status: 'expired' });
  }

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${flow.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: flow.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tokens = await tokenRes.json();

    if (tokens.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (tokens.error === 'authorization_declined') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'declined' });
    }
    if (tokens.error === 'expired_token') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'expired' });
    }
    if (!tokenRes.ok) {
      deviceFlows.delete(req.session.userId);
      console.error(`Device code token exchange rejected: HTTP ${tokenRes.status}, error=${tokens.error || 'unknown'}`);
      return res.json(DEVICE_TOKEN_FAILED);
    }

    deviceFlows.delete(req.session.userId);
    // Device-code flow never uses a client secret → public client. Its refresh must
    // omit the secret too, or Microsoft rejects it with AADSTS90023 (#216).
    await processMicrosoftTokens(req.session.userId, tokens, {
      tenantId: flow.tenantId, clientId: flow.clientId, publicClient: true, mode: flow.mode, accountId: flow.accountId,
    });
    res.json({ status: 'success' });
  } catch (err) {
    deviceFlows.delete(req.session.userId);
    if (err instanceof MicrosoftOAuthError) {
      const code = stableCode(err);
      console.error(`Device code sign-in refused: ${code}`);
      return res.json({ status: 'error', error: 'Microsoft sign-in refused', code });
    }
    console.error('Device code poll error:', deviceErrorDetail(err));
    res.json(DEVICE_TOKEN_FAILED);
  }
});

// Re-exported so existing transport imports keep working; the implementation lives
// in services/oauth/microsoftOAuth.js next to the other OAuth provider modules.
export { refreshMicrosoftToken };

export default router;
