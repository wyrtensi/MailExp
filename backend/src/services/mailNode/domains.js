import { query } from '../db.js';
import { recordAudit } from '../auditLog.js';

// The panel's record of the mail node's domains and their onboarding (table mail_node_domains,
// migration 0079). The node lists the domains it has; this table says which of them the panel
// knows and how far each got. A domain on the node without a row is 'unknown'.

// Onboarding in order: the domain exists on the node, the node is set up for it (relayhost, DKIM,
// limits), its DNS is right, the tenant verified it, it is an Internal Relay accepted domain, the
// Outbound connector delivers it to the node, it takes mailboxes, and at last the tenant rejects
// unknown recipients itself (DBEB).
export const DOMAIN_STATES = Object.freeze([
  'node_created', 'node_configured', 'dns_ok', 'tenant_verified', 'internal_relay',
  'connector_ready', 'ready', 'authoritative',
]);
export const UNKNOWN_STATE = 'unknown';
export const MAILBOX_READY_STATES = Object.freeze(['ready', 'authoritative']);
// Steps a person confirms with "Done": every state up to 'ready', since the panel checks none of
// them yet. 'authoritative' is never confirmed by hand: only a complete recipient mirror in the
// tenant may make it reject unknown addresses.
export const MANUAL_STEPS = Object.freeze(DOMAIN_STATES.slice(1, DOMAIN_STATES.indexOf('ready') + 1));
// The actor of what MailExpert does by itself, as imapManager's MAIL_NODE_ACTOR.
export const SYSTEM_ACTOR = 'MailExpert';

export function canCreateMailboxes(state) {
  return MAILBOX_READY_STATES.includes(state);
}

// The step "Done" confirms next, or null when nothing is left to confirm by hand.
export function nextStep(state) {
  const next = DOMAIN_STATES[DOMAIN_STATES.indexOf(state) + 1];
  return state !== UNKNOWN_STATE && MANUAL_STEPS.includes(next) ? next : null;
}

const ACTOR_EMAIL = "(SELECT COALESCE(NULLIF(email, ''), username) FROM users WHERE id = $2)";

function toDomain(row) {
  return {
    domain: row.domain,
    state: row.state,
    origin: row.origin,
    addedAt: row.added_at,
    addedBy: row.added_by_email ?? null,
    stateChangedAt: row.state_changed_at,
    steps: row.steps ?? {},
    maxMailboxes: row.max_mailboxes ?? null,
    nodeCreated: row.node_created ?? null,
    apply: applyOf(row),
  };
}

// The last "apply" of the domain's node settings (services/mailNode/nodeApply.js): when it ran, each
// item's outcome and the DKIM record mailcow publishes. Null before the first one.
function applyOf(row) {
  if (!row.apply_result) return null;
  return { at: row.applied_at ?? null, items: row.apply_result.items ?? [], dkim: row.apply_result.dkim ?? null };
}

export async function listDomainRows() {
  const { rows } = await query(`
    SELECT d.domain, d.state, d.origin, d.added_at, d.state_changed_at, d.steps, d.max_mailboxes, d.node_created,
           d.apply_result, d.applied_at, COALESCE(NULLIF(u.email, ''), u.username) AS added_by_email
      FROM mail_node_domains d
      LEFT JOIN users u ON u.id = d.added_by
     ORDER BY d.domain`);
  return rows.map(toDomain);
}

// The row's state and the node identity it is bound to, or null when the panel has no row.
export async function getDomainRow(domain) {
  const { rows } = await query('SELECT state, node_created FROM mail_node_domains WHERE domain = $1', [domain]);
  return rows[0] ? { state: rows[0].state, nodeCreated: rows[0].node_created ?? null } : null;
}

// Whether the node reports another creation time for the domain than the row is bound to: the domain
// may have been deleted on the node and made again by hand, so its node settings may need applying
// again. Only a warning for administrators: a mailcow that prints the time another way would trip it
// too, so it never changes the row's state or what the domain may do. Unknown on either side (an
// older mailcow, a row not bound yet) is no sign at all.
export function isRecreated(row, nodeDomain) {
  return !!(row?.nodeCreated && nodeDomain?.created && row.nodeCreated !== nodeDomain.created);
}

// Why "Done" or "mark ready" may not touch a row now, or null: the node does not list its domain.
export function nodeRefusal(nodeDomain) {
  return nodeDomain ? null : 'domain_not_on_node';
}

// Binds rows not bound yet (created in the panel, taken in at startup) to the node's identity of
// their domain, the first time the panel sees it. Only ever fills an empty value: a domain the node
// does not list, or lists without a creation time, leaves its row as it is. Returns the rows with
// the bound values.
export async function bindNodeIdentities(nodeDomains, rows) {
  const created = new Map(nodeDomains.map((d) => [d.domain, d.created]));
  return Promise.all(rows.map(async (row) => {
    const value = created.get(row.domain);
    if (row.nodeCreated || !value) return row;
    await query('UPDATE mail_node_domains SET node_created = $2 WHERE domain = $1 AND node_created IS NULL', [row.domain, value]);
    return { ...row, nodeCreated: value };
  }));
}

// The node's domains with the panel's record of each, plus rows whose domain the node does not list
// (onNode: false). A domain whose node creation time differs from the bound one keeps its state and
// carries recreated: true with the bound time (nodeCreated) next to the node's (created), for the
// administrator's warning. Without the node's list (nodeDomains null: the node is unreachable or
// failed) every row is shown as the panel knows it with onNode: null, so no domain drops out of
// the view. Sorted by name.
export function mergeDomains(nodeDomains, rows) {
  const known = new Map(rows.map((row) => [row.domain, row]));
  const panel = (row) => (row
    ? {
      state: row.state, origin: row.origin, addedAt: row.addedAt, addedBy: row.addedBy, stateChangedAt: row.stateChangedAt,
      steps: row.steps, apply: row.apply ?? null,
    }
    : { state: UNKNOWN_STATE, origin: null, addedAt: null, addedBy: null, stateChangedAt: null, steps: {}, apply: null });
  const listed = nodeDomains ?? [];
  const merged = listed.map((d) => {
    const row = known.get(d.domain);
    const recreated = isRecreated(row, d);
    return {
      ...d, onNode: true, ...panel(row), nextStep: nextStep(row?.state ?? UNKNOWN_STATE),
      ...(recreated ? { recreated, nodeCreated: row.nodeCreated } : {}),
    };
  });
  const onNode = new Set(listed.map((d) => d.domain));
  const unreachable = nodeDomains === null;
  for (const row of rows) {
    if (onNode.has(row.domain)) continue;
    merged.push({
      domain: row.domain,
      active: unreachable ? null : false,
      maxMailboxes: row.maxMailboxes ?? (unreachable ? null : 0),
      mailboxes: unreachable ? null : 0,
      onNode: unreachable ? null : false,
      ...panel(row), nextStep: nextStep(row.state),
    });
  }
  return merged.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Starting the onboarding over clears everything that described the domain as it was on the node
// and in the tenant: relayhost, the last apply of its node settings, DNS and tenant results, the
// accepted domain type, the expected MX and the node identity (bound again when the panel next lists
// the domains). The domain's DKIM mode and send limit stay: they are the owner's choices for the
// domain, applied again to the node domain, not something the node held. Mailboxes on the domain are
// not touched.
const RESTART_SET = `
  state = 'node_created', steps = '{}', state_changed_by = $2, state_changed_at = NOW(), updated_at = NOW(),
  relayhost_id = NULL, apply_result = NULL, applied_at = NULL, dns_check = NULL, dns_checked_at = NULL, tenant = NULL,
  accepted_domain_type = NULL, expected_mx = '[]', node_created = NULL`;

// A domain the panel just created on the node. Adding a domain again after it was removed from the
// node starts its onboarding over: the node lost its settings with it. The node identity is bound
// when the panel next lists the domains. Returns the state and the confirmed steps the row had
// before (from: null, steps: null for a domain the panel did not know), for the journal.
export async function recordCreatedDomain({ domain, userId, maxMailboxes }) {
  const { rows } = await query(`
    WITH old AS (SELECT state, steps FROM mail_node_domains WHERE domain = $1)
    INSERT INTO mail_node_domains (domain, state, origin, added_by, max_mailboxes, state_changed_by)
    VALUES ($1, 'node_created', 'created', $2, $3, $2)
    ON CONFLICT (domain) DO UPDATE
    SET ${RESTART_SET}, added_by = $2, added_at = NOW(), origin = 'created', max_mailboxes = $3
    RETURNING (SELECT state FROM old) AS from_state, (SELECT steps FROM old) AS from_steps
  `, [domain, userId, maxMailboxes]);
  return { from: rows[0]?.from_state ?? null, steps: rows[0]?.from_steps ?? null };
}

// An administrator takes in a domain made on the node by hand, one the panel has no row for. Its
// onboarding starts at the beginning: the panel cannot tell what was set up. False when the panel
// has a row for the domain already: adoption never overwrites one ("Restart onboarding" starts a
// known domain over, on purpose and journaled).
export async function adoptDomain({ domain, userId, nodeCreated = null }) {
  const { rows } = await query(`
    INSERT INTO mail_node_domains (domain, state, origin, added_by, state_changed_by, node_created)
    VALUES ($1, 'node_created', 'adopted', $2, $2, $3)
    ON CONFLICT (domain) DO NOTHING
    RETURNING domain
  `, [domain, userId, nodeCreated]);
  return rows.length > 0;
}

// A row at the first step with nothing confirmed and nothing recorded about the node or the tenant:
// restarting it would change nothing.
const PRISTINE = `state = 'node_created' AND steps = '{}'::jsonb AND relayhost_id IS NULL AND dns_check IS NULL
  AND dns_checked_at IS NULL AND tenant IS NULL AND accepted_domain_type IS NULL AND expected_mx = '[]'::jsonb`;

// "Restart onboarding": an administrator starts a domain's onboarding over, from any state. Where
// the domain came from, who added it and its mailbox limit stay. Answers { from, to, steps } with
// the steps that were confirmed before (who and when, for the journal), or { error }:
// domain_nothing_to_restart for a row that has nothing to clear.
export async function restartOnboarding({ domain, userId }) {
  const { rows } = await query(`
    WITH old AS (
      SELECT domain, state, steps, (${PRISTINE}) AS pristine FROM mail_node_domains WHERE domain = $1 FOR UPDATE
    )
    UPDATE mail_node_domains d
       SET ${RESTART_SET}
      FROM old
     WHERE d.domain = old.domain AND NOT old.pristine
    RETURNING old.state AS from_state, old.steps AS from_steps
  `, [domain, userId]);
  if (!rows.length) return { error: (await getDomainRow(domain)) ? 'domain_nothing_to_restart' : 'domain_not_found' };
  return { from: rows[0].from_state, to: 'node_created', steps: rows[0].from_steps ?? {} };
}

// An administrator accepts the creation time the node reports now (a mailcow that prints it another
// way, or a domain made again by hand whose settings were applied again): the row is bound to it and
// the warning goes. Nothing else changes. Only a row with the warning, one bound to another time,
// is changed: a row not bound yet is bound by the next listing, not here (domain_not_recreated).
// Answers { from, to } or { error }.
export async function acknowledgeNodeIdentity({ domain, nodeCreated }) {
  const { rows } = await query(`
    WITH old AS (SELECT domain, node_created FROM mail_node_domains WHERE domain = $1 FOR UPDATE)
    UPDATE mail_node_domains d
       SET node_created = $2::text, updated_at = NOW()
      FROM old
     WHERE d.domain = old.domain AND old.node_created IS NOT NULL AND old.node_created <> $2::text
    RETURNING old.node_created AS from_created
  `, [domain, nodeCreated]);
  if (!rows.length) return { error: (await getDomainRow(domain)) ? 'domain_not_recreated' : 'domain_not_found' };
  return { from: rows[0].from_created ?? null, to: nodeCreated };
}

async function refusal(domain) {
  return (await getDomainRow(domain)) ? 'step_out_of_order' : 'domain_not_found';
}

// "Done" on the next step: moves the domain one state on and records who confirmed it and when.
// Only the step that follows the current state is accepted, so two administrators confirming at
// once move it once. Answers { from, to } or { error }.
export async function confirmStep({ domain, step, userId }) {
  if (!MANUAL_STEPS.includes(step)) return { error: 'step_invalid' };
  const from = DOMAIN_STATES[DOMAIN_STATES.indexOf(step) - 1];
  const { rows } = await query(`
    UPDATE mail_node_domains
       SET state = $3,
           steps = steps || jsonb_build_object($3::text, jsonb_build_object('at', NOW(), 'userId', $2::uuid, 'email', ${ACTOR_EMAIL})),
           state_changed_by = $2, state_changed_at = NOW(), updated_at = NOW()
     WHERE domain = $1 AND state = $4
    RETURNING domain
  `, [domain, userId, step, from]);
  if (!rows.length) return { error: await refusal(domain) };
  return { from, to: step };
}

// Moves a domain straight to 'ready' from any earlier state: a pilot or a test stand without a
// tenant. The skipped steps stay unconfirmed; the 'ready' entry says it was set by hand.
export async function markReady({ domain, userId }) {
  const before = DOMAIN_STATES.slice(0, DOMAIN_STATES.indexOf('ready'));
  const { rows } = await query(`
    WITH old AS (SELECT domain, state FROM mail_node_domains WHERE domain = $1 FOR UPDATE)
    UPDATE mail_node_domains d
       SET state = 'ready',
           steps = d.steps || jsonb_build_object('ready', jsonb_build_object('at', NOW(), 'userId', $2::uuid, 'email', ${ACTOR_EMAIL}, 'markedReady', true)),
           state_changed_by = $2, state_changed_at = NOW(), updated_at = NOW()
      FROM old
     WHERE d.domain = old.domain AND old.state = ANY($3::text[])
    RETURNING old.state AS from_state
  `, [domain, userId, before]);
  if (!rows.length) return { error: (await getDomainRow(domain)) ? 'domain_already_ready' : 'domain_not_found' };
  return { from: rows[0].from_state, to: 'ready' };
}

// At startup, before the server takes requests: a domain where the panel already has node
// mailboxes was working before the panel kept this table, so it is taken in as 'ready' and
// mailboxes can still be created there. Domains the panel knows are left as they are, so this runs
// on every start. Journaled with MailExpert as the actor. Returns the domains taken in.
export async function adoptDomainsWithMailboxes() {
  const { rows } = await query(`
    INSERT INTO mail_node_domains (domain, state, origin)
    SELECT DISTINCT split_part(lower(email_address), '@', 2), 'ready', 'existing_mailboxes'
      FROM email_accounts
     WHERE mail_node AND split_part(lower(email_address), '@', 2) <> ''
    ON CONFLICT (domain) DO NOTHING
    RETURNING domain
  `);
  const domains = rows.map((row) => row.domain).sort();
  if (domains.length) {
    await recordAudit(domains.map((domain) => ({
      actorEmail: SYSTEM_ACTOR, action: 'mail_node.domain_adopted',
      details: { domain, state: 'ready', origin: 'existing_mailboxes' },
    })));
  }
  return domains;
}
