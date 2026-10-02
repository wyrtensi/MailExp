import { BlockList, isIP } from 'node:net';

// The addresses Microsoft Exchange Online Protection sends and receives SMTP from: the Microsoft 365
// endpoints web service, worldwide instance, the Exchange entry with TCP 25 (eop-panel-requirements.md,
// section 2.10), for the node's forwarding hosts and firewall (R-12, R-40). The bypass check (R-19)
// does not use them: an address in these ranges is any tenant's EOP, a recipient's Microsoft 365 MX
// included, so only the name <EOP_HOST> marks this tenant's path.
//
// A static list on purpose: the panel makes no call to Microsoft. To update it, run
// `EOP_CLIENT_REQUEST_ID=<the installation's GUID> node scripts/update-eop-ranges.mjs` in backend/
// (it asks endpoints.office.com, filters the entries
// with rangesFromEndpoints below and prints the new EOP_RANGES block to paste here) and bump
// `version` and `retrieved`. On the node host the timer of scripts/deploy/mail-node/eop-ranges.sh
// (R-40) keeps the firewall's copy current by itself, with the same filter; the panel's copy is the
// source of the forwarding hosts (R-12, services/mailNode/nodeApply.js), which show its version.
export const EOP_RANGES = Object.freeze({
  source: 'https://endpoints.office.com/endpoints/worldwide?ServiceAreas=Exchange (serviceArea Exchange, tcpPorts 25)',
  version: '2026081400',
  retrieved: '2026-10-01',
  ipv4: Object.freeze(['40.92.0.0/15', '40.107.0.0/16', '52.100.0.0/14', '104.47.0.0/17']),
  ipv6: Object.freeze(['2a01:111:f400::/48', '2a01:111:f403::/48']),
});

function blockListOf(ranges) {
  const list = new BlockList();
  for (const [family, cidrs] of [['ipv4', ranges.ipv4], ['ipv6', ranges.ipv6]]) {
    for (const cidr of cidrs) {
      const [address, prefix] = cidr.split('/');
      list.addSubnet(address, Number(prefix), family);
    }
  }
  return list;
}

const defaultList = blockListOf(EOP_RANGES);

// Whether an address (IPv4 or IPv6, as Postfix writes it in relay=host[address]) is inside the EOP
// ranges. Anything that is not an address is not.
export function isEopAddress(address, ranges = null) {
  const ip = typeof address === 'string' ? address.trim().replace(/^ipv6:/i, '') : '';
  const family = isIP(ip);
  if (!family) return false;
  const list = ranges ? blockListOf(ranges) : defaultList;
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

// One CIDR of the given family (4 or 6): an address and a prefix within the family's length.
function isCidr(value, family) {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || !/^\d{1,3}$/.test(prefix ?? '')) return false;
  return isIP(address) === family && Number(prefix) <= (family === 4 ? 32 : 128);
}

// The ranges as the node's forwarding hosts take them: { version, cidrs } with IPv4 first, IPv6
// lowercased, no repeats. Null for a list the panel must not apply: no version, no IPv4 range, or
// any entry that is not a CIDR of its family. The same rules as the host's timer (R-40): an empty or
// malformed list is never applied, so it never takes away the ranges already in place.
export function eopRangeList(ranges = EOP_RANGES) {
  if (!ranges || typeof ranges !== 'object') return null;
  const version = String(ranges.version ?? '').trim();
  const ipv4 = Array.isArray(ranges.ipv4) ? ranges.ipv4 : [];
  const ipv6 = (Array.isArray(ranges.ipv6) ? ranges.ipv6 : []).map((c) => (typeof c === 'string' ? c.toLowerCase() : c));
  if (!version || !ipv4.length) return null;
  if (!ipv4.every((c) => isCidr(c, 4)) || !ipv6.every((c) => isCidr(c, 6))) return null;
  return { version, cidrs: [...new Set([...ipv4, ...ipv6])] };
}

// The ranges of an `endpoints` answer of the web service: the entries of the Exchange service area
// that carry TCP 25, never chosen by id (ids change between versions). Unknown fields are skipped.
export function rangesFromEndpoints(endpoints) {
  const ipv4 = new Set();
  const ipv6 = new Set();
  for (const entry of Array.isArray(endpoints) ? endpoints : []) {
    if (entry?.serviceArea !== 'Exchange') continue;
    const ports = String(entry.tcpPorts ?? '').split(',').map((p) => p.trim());
    if (!ports.includes('25')) continue;
    for (const cidr of Array.isArray(entry.ips) ? entry.ips : []) {
      const [address] = String(cidr).split('/');
      const family = isIP(address);
      if (family === 4) ipv4.add(cidr);
      else if (family === 6) ipv6.add(cidr);
    }
  }
  return { ipv4: [...ipv4].sort(), ipv6: [...ipv6].sort() };
}
