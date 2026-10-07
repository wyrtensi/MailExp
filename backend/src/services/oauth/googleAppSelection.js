import { createHash, randomBytes } from 'crypto';
import { query, withTransaction } from '../db.js';
import { redisClient } from '../redis.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauthState.js';

// Which Google OAuth app a consent flow goes through. An unverified app accepts at most
// user_limit distinct Google accounts for its whole life, so a seat is taken by every email the
// app has ever issued tokens to (google_oauth_grants) plus the flows started but not finished
// (reservations in Redis). Selection runs under one advisory lock so two backend processes
// cannot both hand out an app's last seat.

const SELECTION_LOCK = "SELECT pg_advisory_xact_lock(hashtext('google-oauth-app-selection'))";
const APPS_WITH_SEATS = `
  SELECT a.id, a.status, a.user_limit,
         (SELECT count(*) FROM google_oauth_grants g WHERE g.project_number = a.project_number)::int AS grants,
         EXISTS (SELECT 1 FROM google_oauth_grants g WHERE g.project_number = a.project_number AND g.email = lower($1)) AS granted
  FROM google_oauth_apps a
  ORDER BY a.created_at, a.id`;

export class GoogleAppSelectionError extends Error {
  constructor(code) {
    super(`Google OAuth app selection failed: ${code}`);
    this.name = 'GoogleAppSelectionError';
    this.code = code;
  }
}

const reservationKey = (appId) => `oauth:google:reservations:${appId}`;

// Reservations name an email only by its hash, so Redis never holds the address itself.
export function googleEmailDigest(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

// Every consent flow holds its own reservation, `<email digest>:<reservation id>`, so a flow that
// ends (or fails) releases only its own: another flow for the same address still holds the seat.
// A seat is one address, so the count is of distinct digests. A member without an id is a
// reservation stored before reservations named their flow; it is counted the same way and expires
// with its TTL.
const reservationMember = (email, reservation) =>
  (reservation ? `${googleEmailDigest(email)}:${reservation}` : googleEmailDigest(email));
const memberDigest = (member) => String(member).split(':')[0];

// Digests of the addresses with a live reservation in one app. Expired ones are dropped first.
async function reservedDigests(appId, now) {
  const key = reservationKey(appId);
  await redisClient.zRemRangeByScore(key, '-inf', now);
  return new Set((await redisClient.zRange(key, 0, -1)).map(memberDigest));
}

// Live reservations of one app, one per address.
export async function countGoogleReservations(appId, now = Date.now()) {
  return (await reservedDigests(appId, now)).size;
}

async function hasLiveReservation(appId, email, now) {
  return (await reservedDigests(appId, now)).has(googleEmailDigest(email));
}

// Adds this flow's reservation and returns its id.
async function reserveSeat(appId, email, now) {
  const key = reservationKey(appId);
  const reservation = randomBytes(16).toString('hex');
  await redisClient.zAdd(key, { score: now + OAUTH_STATE_TTL_SECONDS * 1000, value: reservationMember(email, reservation) });
  // The set itself never outlives its newest reservation.
  await redisClient.expire(key, OAUTH_STATE_TTL_SECONDS);
  return reservation;
}

// Called on the callback once the grant is journaled (so a seat never looks free while the code
// exchange is in flight), on every callback path that ends before that, and by a start that fails
// after reserving. A brief double count (reservation + grant) is intended. `reservation` is the
// id selectGoogleApp returned for this flow; without one, only a reservation stored before
// reservations named their flow is released.
export async function releaseGoogleSeat(appId, email, reservation = null) {
  if (!appId || !email) return;
  try {
    await redisClient.zRem(reservationKey(appId), reservationMember(email, reservation));
  } catch (err) {
    console.error(`Google OAuth reservation release failed: ${err?.name || 'Error'}`);
  }
}

async function hasFreeSeat(app, now) {
  return app.grants + await countGoogleReservations(app.id, now) < app.user_limit;
}

// Picks the app for one address and, when that costs a new seat, reserves it. Every caller names
// the address: adding goes through POST /api/oauth/google/start (under the CSRF check), and a
// reconnect names the mailbox. Returns { appId, reserved } and, when `reserved`, the flow's
// `reservation` id: the caller keeps it in the OAuth state and passes it to releaseGoogleSeat when
// the flow ends or it gives up before the callback.
export async function selectGoogleApp({ email, account = null } = {}) {
  if (!email) throw new TypeError('selectGoogleApp needs an email');
  return withTransaction(async (client) => {
    await client.query(SELECTION_LOCK);
    const { rows } = await client.query(APPS_WITH_SEATS, [email]);
    const usable = rows.filter((app) => app.status !== 'disabled');
    if (!usable.length) throw new GoogleAppSelectionError('not_configured');

    // A reconnect stays where its refresh token lives.
    const own = account?.oauth_app_id ? usable.find((app) => app.id === account.oauth_app_id) : null;
    if (own) return { appId: own.id, reserved: false };

    // Google already counted this email in that app: going back there costs no seat.
    const known = usable.find((app) => app.granted);
    if (known) return { appId: known.id, reserved: false };

    const now = Date.now();
    const active = usable.filter((app) => app.status === 'active');
    // A repeated start for the same email keeps its app: its seat is already counted, and the new
    // flow adds its own reservation next to the other one.
    for (const app of active) {
      if (await hasLiveReservation(app.id, email, now)) {
        return { appId: app.id, reserved: true, reservation: await reserveSeat(app.id, email, now) };
      }
    }
    for (const app of active) {
      if (await hasFreeSeat(app, now)) {
        return { appId: app.id, reserved: true, reservation: await reserveSeat(app.id, email, now) };
      }
    }
    throw new GoogleAppSelectionError('no_app_capacity');
  });
}

// Whether a new Gmail address can be connected right now. A hint for the UI, not a promise:
// selection itself decides under the lock.
export async function googleHasCapacity() {
  const { rows } = await query(APPS_WITH_SEATS, [null]);
  const now = Date.now();
  for (const app of rows.filter((a) => a.status === 'active')) {
    if (await hasFreeSeat(app, now)) return true;
  }
  return false;
}
