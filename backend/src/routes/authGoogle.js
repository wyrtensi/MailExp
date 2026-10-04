import { createHash } from 'crypto';
import { Router } from 'express';
import { getAuthSettings } from '../services/auth/authSettings.js';
import { bindSessionUser, resolveVerifiedUser } from '../services/auth/userIdentity.js';
import { logAuthEvent } from '../services/authEvents.js';
import { buildGoogleSignInUrl, exchangeGoogleCode, verifyGoogleIdToken } from '../services/oauth/googleOAuth.js';
import { consumeOAuthState, createOAuthState } from '../services/oauth/oauthState.js';
import { allowedRequestOrigin } from '../utils/publicOrigins.js';

// Mounted at /oauth/login/google: sign-in to MailExpert itself with Google, for a host that
// is not behind Cloudflare Access. Redirects carry stable codes only — never provider error
// text, authorization codes or tokens.
const router = Router();

const PROVIDER = 'auth-google';
export const SIGN_IN_CALLBACK_PATH = '/oauth/login/google/callback';
const SIGN_IN_ERROR_CODES = new Set([
  'access_denied', 'invalid_state', 'not_configured', 'email_not_verified',
  'not_allowed', 'user_disabled', 'authentication_failed', 'locked',
]);

class SignInError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SignInError';
    this.code = code;
  }
}

const stateDigest = (state) => createHash('sha256').update(String(state)).digest('hex');
const loginError = (code) => `/login?auth_error=${code}`;

function signInSettings() {
  const settings = getAuthSettings();
  return settings.mode === 'google' && settings.googleSignIn ? settings : null;
}

router.get('/', async (req, res) => {
  const settings = signInSettings();
  if (!settings) return res.status(404).json({ error: 'Not found' });
  // The screen-lock gate in index.js (#235) covers only /api. Signing in again from a locked
  // session would swap it for an unlocked one without the PIN. /login sends a signed-in user
  // on to the lock screen.
  if (req.session?.locked) return res.redirect(loginError('locked'));
  const origin = allowedRequestOrigin(req);
  if (!origin) return res.redirect(loginError('not_configured'));

  try {
    const { state, codeChallenge } = await createOAuthState({ provider: PROVIDER });
    // Bind the flow to this browser, so a callback link from someone else cannot sign it in.
    req.session.googleSignInState = stateDigest(state);
    res.redirect(buildGoogleSignInUrl({
      clientId: settings.googleSignIn.clientId,
      state,
      codeChallenge,
      redirectUri: `${origin}${SIGN_IN_CALLBACK_PATH}`,
    }));
  } catch (err) {
    console.error(`Google sign-in start failed: ${err?.name || 'Error'}`);
    res.redirect(loginError('authentication_failed'));
  }
});

router.get('/callback', async (req, res) => {
  const settings = signInSettings();
  if (!settings) return res.status(404).json({ error: 'Not found' });
  const { code, state, error } = req.query;

  try {
    // Consume first so a state is burned whatever the outcome.
    const pending = await consumeOAuthState({ provider: PROVIDER, state, anonymous: true });
    const expected = req.session.googleSignInState;
    delete req.session.googleSignInState;
    // Also covers a sign-in that started before the session locked.
    if (req.session.locked) throw new SignInError('locked');

    if (error !== undefined) {
      throw new SignInError(error === 'access_denied' ? 'access_denied' : 'authentication_failed');
    }
    if (!pending || !expected || expected !== stateDigest(state)) throw new SignInError('invalid_state');
    const origin = allowedRequestOrigin(req);
    if (!origin) throw new SignInError('not_configured');
    if (typeof code !== 'string' || !code) throw new SignInError('authentication_failed');

    const { clientId, clientSecret } = settings.googleSignIn;
    const tokens = await exchangeGoogleCode({
      clientId,
      clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${origin}${SIGN_IN_CALLBACK_PATH}`,
    });
    const identity = await verifyGoogleIdToken({ idToken: tokens.idToken, clientId });
    const result = await resolveVerifiedUser({ email: identity.email, source: 'google', settings });
    if (result.error) throw new SignInError(result.error);

    await bindSessionUser(req, result.user, 'google');
    logAuthEvent('sso_login', { username: result.user.username, userId: result.user.id, ip: req.ip, success: true });
    res.redirect('/');
  } catch (err) {
    const stable = SIGN_IN_ERROR_CODES.has(err?.code) ? err.code : 'authentication_failed';
    // Log the stable code and error class only; messages may carry provider details.
    console.error(`Google sign-in failed: ${stable} (${err?.name || 'Error'})`);
    res.redirect(loginError(stable));
  }
});

export default router;
