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
  };
}

export async function listDomainRows() {
  const { rows } = await query(`
    SELECT d.domain, d.state, d.origin, d.added_at, d.state_changed_at, d.steps, d.max_mailboxes, d.node_created,
           COALESCE(NULLIF(u.email, ''), u.username) AS added_by_email
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

// Whether the node's domain is another one than the row was onboarded with: deleted on the node and
// made again by hand. Unknown on either side (an older mailcow, a row not bound yet) is no proof.
export function isRecreated(row, nodeDomain) {
  return !!(row?.nodeCreated && nodeDomain?.created && row.nodeCreated !== nodeDomain.created);
}

// Why "Done" or "mark ready" may not touch a row now, or null: the node no longer has its domain,
// or has another domain of that name.
export function nodeRefusal(row, nodeDomain) {
  if (!nodeDomain) return 'domain_not_on_node';
  return isRecreated(row, nodeDomain) ? 'domain_recreated' : null;
}

// Binds rows not bound yet (created in the panel, taken in at startup) to the node's identity of
// their domain, the first time the panel sees it. Returns the rows with the bound values.
export async function bindNodeIdentities(nodeDomains, rows) {
  const created = new Map(nodeDomains.map((d) => [d.domain, d.created]));
  return Promise.all(rows.map(async (row) => {
    const value = created.get(row.domain);
    if (row.nodeCreated || !value) return row;
    await query('UPDATE mail_node_domains SET node_created = $2 WHERE domain = $1 AND node_created IS NULL', [row.domain, value]);
    return { ...row, nodeCreated: value };
  }));
}

// The node's domains with the panel's record of each, plus rows whose domain the node no longer
// has (onNode: false). A domain re-created on the node by hand shows as unknown (recreated: true)
// until an administrator adopts it again. Sorted by name.
export function mergeDomains(nodeDomains, rows) {
  const known = new Map(rows.map((row) => [row.domain, row]));
  const panel = (row) => (row
    ? { state: row.state, origin: row.origin, addedAt: row.addedAt, addedBy: row.addedBy, stateChangedAt: row.stateChangedAt, steps: row.steps }
    : { state: UNKNOWN_STATE, origin: null, addedAt: null, addedBy: null, stateChangedAt: null, steps: {} });
  const merged = nodeDomains.map((d) => {
    const row = known.get(d.domain);
    const recreated = isRecreated(row, d);
    const shown = recreated ? null : row;
    return { ...d, onNode: true, ...panel(shown), nextStep: nextStep(shown?.state ?? UNKNOWN_STATE), ...(recreated ? { recreated } : {}) };
  });
  const onNode = new Set(nodeDomains.map((d) => d.domain));
  for (const row of rows) {
    if (onNode.has(row.domain)) continue;
    merged.push({
      domain: row.domain, active: false, maxMailboxes: row.maxMailboxes ?? 0, mailboxes: 0, onNode: false,
      ...panel(row), nextStep: nextStep(row.state),
    });
  }
  return merged.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Starting the onboarding over clears everything that described the domain as it was on the node
// and in the tenant: relayhost, DNS and tenant results, the accepted domain type, the expected MX
// and the node identity. The domain's DKIM mode and send limit stay: they are the owner's choices
// for the domain, applied again to the new node domain, not something the node held.
const RESTART_SET = `
  state = 'node_created', added_by = $2, added_at = NOW(), steps = '{}', state_changed_by = $2,
  state_changed_at = NOW(), updated_at = NOW(), relayhost_id = NULL, dns_check = NULL,
  dns_checked_at = NULL, tenant = NULL, accepted_domain_type = NULL, expected_mx = '[]'`;

// A domain the panel just created on the node. Adding a domain again after it was removed from the
// node starts its onboarding over: the node lost its settings with it. The node identity is bound
// when the panel next lists the domains.
export async function recordCreatedDomain({ domain, userId, maxMailboxes }) {
  await query(`
    INSERT INTO mail_node_domains (domain, state, origin, added_by, max_mailboxes, state_changed_by)
    VALUES ($1, 'node_created', 'created', $2, $3, $2)
    ON CONFLICT (domain) DO UPDATE
    SET ${RESTART_SET}, origin = 'created', max_mailboxes = $3, node_created = NULL
  `, [domain, userId, maxMailboxes]);
}

// An administrator takes in a domain made on the node by hand: one the panel has no row for, or one
// deleted on the node and made again (its node identity differs from the row's). Its onboarding
// starts at the beginning: the panel cannot tell what was set up. False when the panel knows this
// very domain already.
export async function adoptDomain({ domain, userId, nodeCreated = null }) {
  const { rows } = await query(`
    INSERT INTO mail_node_domains (domain, state, origin, added_by, state_changed_by, node_created)
    VALUES ($1, 'node_created', 'adopted', $2, $2, $3)
    ON CONFLICT (domain) DO UPDATE
    SET ${RESTART_SET}, origin = 'adopted', max_mailboxes = NULL, node_created = EXCLUDED.node_created
    WHERE mail_node_domains.node_created IS NOT NULL AND EXCLUDED.node_created IS NOT NULL
      AND mail_node_domains.node_created <> EXCLUDED.node_created
    RETURNING domain
  `, [domain, userId, nodeCreated]);
  return rows.length > 0;
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
