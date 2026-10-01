import { BlockList, isIP } from 'node:net';

// The addresses Microsoft Exchange Online Protection sends and receives SMTP from: the Microsoft 365
// endpoints web service, worldwide instance, the Exchange entry with TCP 25 (eop-panel-requirements.md,
// section 2.10). The bypass check (R-19, services/mailNode/nodeAlerts.js) counts a relay inside these
// ranges as EOP even when its name is not <EOP_HOST>.
//
// A static list on purpose: the panel makes no call to Microsoft. To update it, run
// `node scripts/update-eop-ranges.mjs` in backend/ (it asks endpoints.office.com, filters the entries
// with rangesFromEndpoints below and prints the new EOP_RANGES block to paste here) and bump
// `version` and `retrieved`. A later stage (R-40) keeps the list current by itself.
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
