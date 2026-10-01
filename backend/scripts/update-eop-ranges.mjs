// Prints the current EOP ranges as the EOP_RANGES block of src/services/mailNode/eopRanges.js, to
// paste over the old one. Run from backend/:
//
//   EOP_CLIENT_REQUEST_ID=<guid> node scripts/update-eop-ranges.mjs
//   node scripts/update-eop-ranges.mjs --client-request-id <guid>
//
// The Microsoft 365 endpoints web service wants a ClientRequestId (a GUID; without it it answers 400)
// and asks for one GUID per installation, kept the same on every call: generate it once (for example
// with `node -e "console.log(crypto.randomUUID())"`) and keep it with the installation's notes.
// Without one the script makes a new GUID for this run and says so. The service answers 429 to
// frequent `endpoints` requests: run it by hand, not on a schedule. Its `version` answer carries a
// field the documentation does not list; unknown fields are skipped.
import { randomUUID } from 'node:crypto';
import { EOP_RANGES, rangesFromEndpoints } from '../src/services/mailNode/eopRanges.js';

const BASE = 'https://endpoints.office.com';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientRequestId() {
  const at = process.argv.indexOf('--client-request-id');
  const given = (at >= 0 ? process.argv[at + 1] : process.env.EOP_CLIENT_REQUEST_ID)?.trim();
  if (given) {
    if (!GUID_RE.test(given)) throw new Error('The client request id must be a GUID');
    return given;
  }
  const made = randomUUID();
  console.error(`No EOP_CLIENT_REQUEST_ID given: this run uses ${made}. Keep one GUID per installation.`);
  return made;
}

const id = clientRequestId();

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
