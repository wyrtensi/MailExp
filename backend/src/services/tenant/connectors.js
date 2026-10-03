import { asRows } from './exoRunner.js';

// R-25: the owner makes both connectors once with the EAC wizard; the panel keeps their key
// properties as the reference and compares every later read with it, so a change made in EAC (TLS,
// smart host, certificate name) does not break mail silently. The Outbound connector's
// RecipientDomains are not compared: they change with every domain the panel onboards, and the
// domain's tenant job (services/tenant/tenantDomains.js) adds a missing domain back itself.
//
// The reference is taken from the first good read when there is none, and again by an
// administrator's "Take as the reference" after a deliberate change. Kept in the tenant state
// (services/tenant/tenantJobs.js): connectors { at, ok, inbound, outbound } and connectorReference
// { at, by, inbound, outbound }.

export const INBOUND_KEYS = Object.freeze([
  'Enabled', 'ConnectorType', 'RequireTls', 'RestrictDomainsToCertificate', 'RestrictDomainsToIPAddresses',
  'TlsSenderCertificateName', 'SenderDomains', 'SenderIPAddresses', 'TreatMessagesAsInternal', 'CloudServicesMailEnabled',
]);
export const OUTBOUND_KEYS = Object.freeze([
  'Enabled', 'ConnectorType', 'SmartHosts', 'UseMXRecord', 'TlsSettings', 'TlsDomain', 'AllAcceptedDomains',
  'IsTransportRuleScoped', 'CloudServicesMailEnabled',
]);
const MAX_CONNECTORS = 20;

// A property as compared: lists sorted and lower-cased, strings lower-cased, absent as null.
function normalize(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean).sort();
  if (typeof value === 'string') return value.trim().toLowerCase();
  return value;
}

// The connectors of a read, each with its name and the compared properties (and, outbound, the
// RecipientDomains shown but not compared).
export function summarizeConnectors(rows, keys, { domains = false } = {}) {
  return asRows(rows).slice(0, MAX_CONNECTORS).map((row) => ({
    name: String(row.Name ?? row.Identity ?? ''),
    properties: Object.fromEntries(keys.map((key) => [key, normalize(row[key])])),
    ...(domains ? { recipientDomains: normalize(row.RecipientDomains) ?? [] } : {}),
  }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function compareSide(direction, reference, current) {
  const drift = [];
  const now = new Map(current.map((c) => [c.name.toLowerCase(), c]));
  const before = new Map(reference.map((c) => [c.name.toLowerCase(), c]));
  for (const [key, ref] of before) {
    const cur = now.get(key);
    if (!cur) {
      drift.push({ direction, name: ref.name, kind: 'missing' });
      continue;
    }
    const changes = Object.keys(ref.properties)
      .filter((prop) => !same(ref.properties[prop], cur.properties[prop] ?? null))
      .map((prop) => ({ property: prop, was: ref.properties[prop], now: cur.properties[prop] ?? null }));
    if (changes.length) drift.push({ direction, name: cur.name, kind: 'changed', changes });
  }
  for (const [key, cur] of now) if (!before.has(key)) drift.push({ direction, name: cur.name, kind: 'added' });
  return drift;
}

// What differs between the reference and a read: [{ direction, name, kind: changed | missing |
// added, changes: [{ property, was, now }] }]. Empty without either.
export function connectorDrift(reference, current) {
  if (!reference || !current?.ok) return [];
  return [
    ...compareSide('inbound', reference.inbound ?? [], current.inbound ?? []),
    ...compareSide('outbound', reference.outbound ?? [], current.outbound ?? []),
  ];
}

// Reads both kinds of connectors through the session: { at, ok, inbound, outbound }.
export async function readConnectors(session, at) {
  const [inbound, outbound] = [
    await session.exo.run('get_inbound_connectors'),
    await session.exo.run('get_outbound_connectors'),
  ];
  return {
    at, ok: true,
    inbound: summarizeConnectors(inbound, INBOUND_KEYS),
    outbound: summarizeConnectors(outbound, OUTBOUND_KEYS, { domains: true }),
  };
}
