// Prints the current EOP ranges as the EOP_RANGES block of src/services/mailNode/eopRanges.js, to
// paste over the old one. Run from backend/: `node scripts/update-eop-ranges.mjs`.
//
// The Microsoft 365 endpoints web service wants a ClientRequestId (a GUID; without it it answers 400)
// and answers 429 to frequent `endpoints` requests: run it by hand, not on a schedule. Its `version`
// answer carries a field the documentation does not list; unknown fields are skipped.
import { randomUUID } from 'node:crypto';
import { EOP_RANGES, rangesFromEndpoints } from '../src/services/mailNode/eopRanges.js';

const BASE = 'https://endpoints.office.com';
const id = randomUUID();

async function getJson(path) {
  const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}clientrequestid=${id}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const versions = await getJson('/version/worldwide');
const version = String((Array.isArray(versions) ? versions[0] : versions)?.latest ?? '');
const ranges = rangesFromEndpoints(await getJson('/endpoints/worldwide?ServiceAreas=Exchange'));
if (!ranges.ipv4.length) throw new Error('No Exchange entry with TCP 25 in the answer: nothing to print');

const list = (items) => items.map((cidr) => `'${cidr}'`).join(', ');
console.log(`Stored version ${EOP_RANGES.version}, current ${version}.`);
console.log(`export const EOP_RANGES = Object.freeze({
  source: '${EOP_RANGES.source}',
  version: '${version}',
  retrieved: '${new Date().toISOString().slice(0, 10)}',
  ipv4: Object.freeze([${list(ranges.ipv4)}]),
  ipv6: Object.freeze([${list(ranges.ipv6)}]),
});`);
