import { createHash, randomBytes } from 'crypto';
import { redisClient } from '../redis.js';

export const OAUTH_STATE_TTL_SECONDS = 600;

// 32 random bytes encode to 43 base64url characters; anything else was not issued here.
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Key by a hash of the state so the raw value (which travels through the browser and
// the provider) is never used directly as a Redis key.
function stateKey(provider, state) {
  const digest = createHash('sha256').update(state).digest('hex');
  return `oauth:state:${provider}:${digest}`;
}

// Create a single-use state plus a PKCE S256 pair. The verifier stays in Redis; only
// the state and the challenge leave the server. `appId` pins the Google app whose client
// must finish the flow; a sign-in flow has no user yet. `mode` (`add` from the Gmail
// form, `reconnect` by mailbox id) and `email` tell the callback what to check;
// `accountId` names which mailbox is being reconnected. `senderName` and `senderNameAlt` are the
// names a mailbox added from the Gmail form sends under (utils/senderNames.js). `reservation` is
// the id of the seat reservation selectGoogleApp took for this flow, released by the callback.
export async function createOAuthState({
  provider, userId = null, loginHint = null, appId = null, mode = null, email = null, accountId = null,
  senderName = null, senderNameAlt = null, reservation = null,
}) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await redisClient.set(
    stateKey(provider, state),
    JSON.stringify({
      userId: userId || null,
      codeVerifier,
      loginHint: loginHint || null,
      appId: appId || null,
      mode: mode || null,
      email: email ? email.toLowerCase() : null,
      accountId: accountId || null,
      senderName: senderName || null,
      senderNameAlt: senderNameAlt || null,
      reservation: reservation || null,
    }),
    { NX: true, EX: OAUTH_STATE_TTL_SECONDS },
  );
  return { state, codeChallenge };
}

// Atomically fetch and delete the pending flow. Returns null for missing, malformed,
// expired or already used states, and for a state without a user unless the consumer is
// a sign-in flow (`anonymous`).
export async function consumeOAuthState({ provider, state, anonymous = false }) {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return null;
  const raw = await redisClient.getDel(stateKey(provider, state));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.codeVerifier !== 'string') return null;
    const userId = typeof data.userId === 'string' ? data.userId : null;
    if (!userId && !anonymous) return null;
    return {
      userId,
      codeVerifier: data.codeVerifier,
      loginHint: data.loginHint || null,
      appId: typeof data.appId === 'string' ? data.appId : null,
      mode: typeof data.mode === 'string' ? data.mode : null,
      email: typeof data.email === 'string' ? data.email : null,
      accountId: typeof data.accountId === 'string' ? data.accountId : null,
      senderName: typeof data.senderName === 'string' ? data.senderName : null,
      senderNameAlt: typeof data.senderNameAlt === 'string' ? data.senderNameAlt : null,
      reservation: typeof data.reservation === 'string' ? data.reservation : null,
    };
  } catch {
    return null;
  }
}
