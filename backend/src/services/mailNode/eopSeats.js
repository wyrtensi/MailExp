import { query, withTransaction } from '../db.js';
import { getEopSettings, tenantConfigured } from './eopSettings.js';
import { parseWholeNumber } from './mailcow.js';
import { getTenantDriver } from '../tenant/driver.js';

// EOP seats (docs/superpowers/specs/2026-10-07-eop-seats-design.md): every mail node mailbox is
// protected by EOP and holds one EOP licence ("seat"). The screens show used, temporarily
// unavailable (held) and free; never the purchased number.
//
// Purchased: prepaidUnits.enabled of the EOP_ENTERPRISE subscription in Graph GET /subscribedSkus
// (right LicenseAssignment.Read.All), read by the tenant jobs (services/tenant/tenantJobs.js: the poll
// every 6 hours, "Reconcile", after a seat request) and kept in integration_config
// 'mail_node_eop_seats' ({ at, ok, purchased, found, skus, error, errorAt }); a failed read keeps the
// last good number with the error beside it, stale after 3 days. Without a tenant driver, with
// TENANT_DRIVER=fake or with the tenant not configured, the administrator enters it: the EOP settings
// field `licenses`, which the TERRL budget takes too. consumedUnits is not used: node mailboxes are
// mail contacts in the tenant (D-5), which take no licence assignment.
//
// The ledger (mail_node_seat_assignments, migration 0095) says who held which seat when; a row
// outlives its mailbox (evidence for a licence audit). The latest row of a seat decides its state:
// live (released_at NULL; pending_until while a creation is in flight), held (released, free_from
// ahead: Microsoft's rule against reassigning a licence within 90 days; the hold is a setting,
// 'mail_node_seat_settings' { holdDays }) or free. Deactivation and a deletion request release a
// seat into hold; activation and the cancel of a deletion take the mailbox's own held seat back, or a
// free one. Every take runs under one transactional advisory lock.

export const EOP_SKU_PART_NUMBER = 'EOP_ENTERPRISE';
export const SEATS_PROVIDER = 'mail_node_eop_seats';
export const SEAT_SETTINGS_PROVIDER = 'mail_node_seat_settings';
const SEATS_LOCK = 'mail_node:eop_seats';
export const SEATS_STALE_MS = 3 * 24 * 60 * 60 * 1000;
export const PENDING_MINUTES = 10;
export const MAX_SEAT_REQUEST = 1000;
export const DEFAULT_HOLD_DAYS = 90;
export const MAX_HOLD_DAYS = 3650;

// The latest row of every seat.
const LATEST = `
  SELECT DISTINCT ON (seat_no) id, seat_no, account_id, email, released_at, release_reason, free_from, pending_until
    FROM mail_node_seat_assignments ORDER BY seat_no, id DESC`;

const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

// The EOP subscriptions of a GET /subscribedSkus answer: { found, purchased, warning, skus }.
// purchased = prepaidUnits.enabled + prepaidUnits.warning (units in warning, a lapsed payment say,
// still work; the alert eop_seats_warning says so); suspended and locked-out units do not count.
// Several EOP subscriptions add up; none means 0 seats.
export function parseSubscribedSkus(answer) {
  const rows = Array.isArray(answer?.value) ? answer.value : [];
  const eop = rows.filter((row) => String(row?.skuPartNumber ?? '').toUpperCase() === EOP_SKU_PART_NUMBER);
  if (!eop.length) return { found: false, purchased: 0, warning: 0, skus: [] };
  const skus = eop.map((row) => ({
    skuId: row.skuId ?? null,
    appliesTo: row.appliesTo ?? null,
    capabilityStatus: row.capabilityStatus ?? null,
    enabled: whole(row.prepaidUnits?.enabled),
    suspended: whole(row.prepaidUnits?.suspended),
    warning: whole(row.prepaidUnits?.warning),
    consumedUnits: whole(row.consumedUnits),
  }));
  return {
    found: true,
    purchased: skus.reduce((sum, sku) => sum + sku.enabled + sku.warning, 0),
    warning: skus.reduce((sum, sku) => sum + sku.warning, 0),
    skus,
  };
}

// 'graph' when the tenant gives the number (a real driver and the four tenant fields), else 'manual'.
export function seatSource(eop, driver) {
  return driver && driver.kind !== 'fake' && tenantConfigured(eop ?? {}) ? 'graph' : 'manual';
}

// The purchased number: { purchased, mode, source, at, stale, notReconciled, error, subscriptionMissing }.
// mode: where it should come from; source: where it came from. In graph mode before the first good
// read the manual number stands in (notReconciled). subscriptionMissing: the last good read found no
// EOP_ENTERPRISE subscription, so purchased is 0 for that reason and the screens say so instead of
// only "no free seat".
export function purchasedSeats({ eop, read, source, now = Date.now() }) {
  const manual = Number.isInteger(eop?.licenses) ? eop.licenses : null;
  if (source !== 'graph') {
    return {
      purchased: manual, warning: 0, mode: 'manual', source: 'manual', at: null, stale: false, notReconciled: false, error: null,
      subscriptionMissing: false,
    };
  }
  const at = Date.parse(read?.at ?? '');
  const error = read?.ok === false ? (read.error ?? null) : null;
  if (!Number.isInteger(read?.purchased) || !Number.isFinite(at)) {
    // Never read: stale once the first failed try is older than 3 days (a missing permission, say).
    const first = Date.parse(read?.firstErrorAt ?? '');
    const never = Number.isFinite(first) && now - first > SEATS_STALE_MS;
    return {
      purchased: manual, warning: 0, mode: 'graph', source: 'manual', at: null, stale: never, notReconciled: true, error,
      subscriptionMissing: false,
    };
  }
  return {
    purchased: read.purchased, warning: whole(read.warning), mode: 'graph', source: 'graph', at: read.at,
    stale: now - at > SEATS_STALE_MS, notReconciled: false, error, subscriptionMissing: read.found === false,
  };
}

async function readConfig(provider, db) {
  const { rows } = await db.query('SELECT config FROM integration_config WHERE provider = $1', [provider]);
  return rows[0]?.config ?? null;
}

async function writeConfig(provider, config, db) {
  await db.query(`
    INSERT INTO integration_config (provider, config) VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, config]);
}

export const getSeatRead = (db = { query }) => readConfig(SEATS_PROVIDER, db);
export const saveSeatRead = (read, db = { query }) => writeConfig(SEATS_PROVIDER, read, db);

export function parseHoldDays(value) {
  return parseWholeNumber(value, 0, MAX_HOLD_DAYS);
}

export async function getHoldDays(db = { query }) {
  return parseHoldDays((await readConfig(SEAT_SETTINGS_PROVIDER, db))?.holdDays) ?? DEFAULT_HOLD_DAYS;
}

// Saves the hold period and re-dates the seats still waiting (the latest row of each seat, when
// released): the change applies to them too. Returns { from, to }.
export async function setHoldDays(days) {
  // The old value is read under the lock, in the transaction, so two changes at once journal a true chain.
  const from = await withTransaction(async (client) => {
    await lockSeats(client);
    const before = await getHoldDays(client);
    await writeConfig(SEAT_SETTINGS_PROVIDER, { holdDays: days }, client);
    await client.query(`
      UPDATE mail_node_seat_assignments a SET free_from = a.released_at + make_interval(days => $1::int)
        FROM (${LATEST}) latest
       WHERE a.id = latest.id AND a.released_at IS NOT NULL`, [days]);
    return before;
  });
  return { from, to: days };
}

// The purchased number now. Reads with the global query: never call it inside a transaction.
export async function seatSupply({ eop = null, now = Date.now() } = {}) {
  const settings = eop ?? await getEopSettings();
  const source = seatSource(settings, getTenantDriver());
  const read = source === 'graph' ? await getSeatRead() : null;
  return purchasedSeats({ eop: settings, read, source, now });
}

export async function lockSeats(client) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SEATS_LOCK]);
}

export async function seatCounts(db = { query }) {
  const { rows: [row] } = await db.query(`
    SELECT count(*) FILTER (WHERE released_at IS NULL AND (pending_until IS NULL OR pending_until > NOW()))::int AS used,
           count(*) FILTER (WHERE released_at IS NOT NULL AND free_from > NOW())::int AS held
      FROM (${LATEST}) latest`);
  return { used: Number(row?.used ?? 0), held: Number(row?.held ?? 0) };
}

// The seats on hold, soonest free first: what the hover on "temporarily unavailable" lists.
export async function heldSeats(db = { query }) {
  const { rows } = await db.query(`
    SELECT seat_no, account_id, email, release_reason, released_at, free_from FROM (${LATEST}) latest
     WHERE released_at IS NOT NULL AND free_from > NOW() ORDER BY free_from, seat_no`);
  return rows.map((row) => ({
    seat: row.seat_no, accountId: row.account_id ?? null, email: row.email, reason: row.release_reason, releasedAt: row.released_at, freeFrom: row.free_from,
  }));
}

export async function openSeatRequests(db = { query }) {
  const { rows } = await db.query(`
    SELECT id, provider, seats, purchased_at_request, requested_by_email, requested_at
      FROM mail_node_seat_requests WHERE closed_at IS NULL ORDER BY requested_at, id`);
  return rows.map((row) => ({
    id: Number(row.id), provider: row.provider, seats: row.seats, purchasedAtRequest: row.purchased_at_request,
    requestedBy: row.requested_by_email ?? null, requestedAt: row.requested_at,
  }));
}

// Everything the screens and the alerts need. free is null while purchased is unknown.
export async function getSeats({ now = Date.now() } = {}) {
  const [supply, counts, held, requests, holdDays] = await Promise.all([
    seatSupply({ now }), seatCounts(), heldSeats(), openSeatRequests(), getHoldDays(),
  ]);
  const known = supply.purchased != null;
  return {
    ...supply,
    used: counts.used,
    held: counts.held,
    free: known ? Math.max(0, supply.purchased - counts.used - counts.held) : null,
    over: known && supply.purchased < counts.used,
    heldSeats: held,
    requests,
    holdDays,
  };
}

// The lowest seat number that is neither live nor on hold (a never-assigned number included).
async function freeSeatNumber(client) {
  const { rows: [row] } = await client.query(`
    SELECT n FROM generate_series(1, (SELECT COALESCE(max(seat_no), 0) + 1 FROM mail_node_seat_assignments)) AS n
     WHERE n NOT IN (SELECT seat_no FROM (${LATEST}) latest WHERE released_at IS NULL OR free_from > NOW())
     ORDER BY n LIMIT 1`);
  return Number(row.n);
}

// Inside the caller's transaction, under the lock: { seat } of a free seat, or { error }.
async function takeFree(client, purchased) {
  if (purchased == null) return { error: 'seats_unknown' };
  // A creation that stopped half way left a pending row: it counts no more and blocks no seat.
  await client.query('DELETE FROM mail_node_seat_assignments WHERE pending_until IS NOT NULL AND pending_until < NOW()');
  const { used, held } = await seatCounts(client);
  if (purchased - used - held < 1) return { error: 'no_free_seats' };
  return { seat: await freeSeatNumber(client) };
}

// A seat for a creation in flight: a pending ledger row, { assignmentId, seat }, or { error:
// seats_unknown | no_free_seats }. The insert of the account row confirms it (confirmSeat) in its own
// transaction; a failed creation drops it (dropPendingSeat); one never confirmed expires.
export async function reserveSeat(email) {
  const { purchased } = await seatSupply();
  return withTransaction(async (client) => {
    await lockSeats(client);
    const free = await takeFree(client, purchased);
    if (free.error) return free;
    const { rows: [row] } = await client.query(`
      INSERT INTO mail_node_seat_assignments (seat_no, email, pending_until)
      VALUES ($1, $2, NOW() + make_interval(mins => $3::int)) RETURNING id`, [free.seat, String(email).toLowerCase(), PENDING_MINUTES]);
    return { assignmentId: Number(row.id), seat: free.seat };
  });
}

// Binds the pending row to the new account. Answers false when the row is gone (it expired and
// another creation swept it): the caller must fail the creation, never keep a mailbox without a ledger row.
export async function confirmSeat(assignmentId, accountId, client) {
  const { rows } = await client.query(
    'UPDATE mail_node_seat_assignments SET account_id = $2, pending_until = NULL WHERE id = $1 AND pending_until IS NOT NULL RETURNING id',
    [assignmentId, accountId],
  );
  return rows.length === 1;
}

// A creation that failed never held the seat: its pending row goes.
export async function dropPendingSeat(assignmentId, db = { query }) {
  if (assignmentId == null) return;
  await db.query('DELETE FROM mail_node_seat_assignments WHERE id = $1 AND pending_until IS NOT NULL', [assignmentId]);
}

// Releases the mailbox's live seat into hold (reason 'deactivated' | 'deletion_requested'), in the
// caller's transaction. Returns { seat, freeFrom } or null when it held none (released already).
export async function releaseSeat(accountId, reason, holdDays, client) {
  const { rows: [row] } = await client.query(`
    UPDATE mail_node_seat_assignments
       SET released_at = NOW(), release_reason = $2, free_from = NOW() + make_interval(days => $3::int)
     WHERE account_id = $1 AND released_at IS NULL
    RETURNING seat_no, free_from`, [accountId, reason, holdDays]);
  return row ? { seat: row.seat_no, freeFrom: row.free_from } : null;
}

// Activation or the cancel of a deletion, in the caller's transaction under the lock: the mailbox's
// own seat back while it is on hold (the same ledger row, released cleared), else a free seat (a new
// row). { seat, reclaimed } or { error: seats_unknown | no_free_seats }.
export async function returnSeat({ accountId, email, purchased }, client) {
  const { rows: [own] } = await client.query(`
    SELECT id, seat_no FROM (${LATEST}) latest
     WHERE account_id = $1 AND released_at IS NOT NULL AND free_from > NOW()`, [accountId]);
  if (own) {
    await client.query('UPDATE mail_node_seat_assignments SET released_at = NULL, release_reason = NULL, free_from = NULL WHERE id = $1', [own.id]);
    return { seat: own.seat_no, reclaimed: true };
  }
  const free = await takeFree(client, purchased);
  if (free.error) return free;
  await client.query('INSERT INTO mail_node_seat_assignments (seat_no, account_id, email) VALUES ($1, $2, $3)',
    [free.seat, accountId, String(email).toLowerCase()]);
  return { seat: free.seat, reclaimed: false };
}

// Whether returnSeat would find a seat for the mailbox now, read without the lock: null, or the
// error it would answer (seats_unknown | no_free_seats). Activation and the cancel of a deletion ask
// it before they touch the node, so a refusal never opens the mailbox's local delivery for a moment
// and the seats lock is never held across a node call; returnSeat under the lock stays the decision.
export async function seatAvailableFor({ accountId, purchased }, db = { query }) {
  const { rows: [own] } = await db.query(`
    SELECT 1 FROM (${LATEST}) latest WHERE account_id = $1 AND released_at IS NOT NULL AND free_from > NOW()`, [accountId]);
  if (own) return null;
  if (purchased == null) return 'seats_unknown';
  const { used, held } = await seatCounts(db);
  return purchased - used - held < 1 ? 'no_free_seats' : null;
}

// The purchased number each request needs before it closes, in creation order (Map id -> number).
// Requests are covered one after another, so one purchase never closes more than it added: a request
// stacks on every earlier one still open when it was made (open now, or closed after it was made),
// which its purchased_at_request does not include yet: max(purchased_at_request, the earlier ones'
// number) + seats. One closed before it was made is already in its purchased_at_request, and a later
// drop of the purchased number is not overstated by it. An unknown number at request counts as 0.
export function requestThresholds(requests) {
  const thresholds = new Map();
  const earlier = [];
  for (const request of requests) {
    const made = new Date(request.requested_at).getTime();
    const base = earlier.reduce((max, prior) => (
      prior.closedAt == null || prior.closedAt > made ? Math.max(max, prior.threshold) : max
    ), request.purchased_at_request ?? 0);
    const threshold = base + request.seats;
    thresholds.set(Number(request.id), threshold);
    earlier.push({ threshold, closedAt: request.closed_at == null ? null : new Date(request.closed_at).getTime() });
  }
  return thresholds;
}

// Closes every open request the purchased number now covers (requestThresholds). Returns the closed
// ids. Every request is read, the closed ones too (a handful: one per seat order). No lock: two runs
// at once compute the same set from the same requests, and closed_at IS NULL makes the second a no-op.
export async function closeFulfilledRequests(purchased, db = { query }) {
  if (!Number.isInteger(purchased)) return [];
  const { rows: requests } = await db.query(`
    SELECT id, seats, purchased_at_request, requested_at, closed_at
      FROM mail_node_seat_requests ORDER BY requested_at, id`);
  const thresholds = requestThresholds(requests);
  const due = requests
    .filter((request) => request.closed_at == null && purchased >= thresholds.get(Number(request.id)))
    .map((request) => Number(request.id));
  if (!due.length) return [];
  const { rows } = await db.query(`
    UPDATE mail_node_seat_requests SET closed_at = NOW()
     WHERE id = ANY($1::bigint[]) AND closed_at IS NULL
    RETURNING id`, [due]);
  const closed = new Set(rows.map((row) => Number(row.id)));
  return due.filter((id) => closed.has(id));
}

// The EOP settings with licenses = the purchased number, for the TERRL budget (services/mailNode/terrl.js).
export async function withSeatLicenses(eop) {
  const { purchased } = await seatSupply({ eop });
  return purchased == null ? eop : { ...eop, licenses: purchased };
}
