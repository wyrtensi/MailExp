import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';
import { joinTxtChunks } from './txtRecord.js';

// The DNS and certificate checks of the mail node (eop-panel-requirements.md, R-14 and R-15): what
// a domain publishes against what it must publish for mail through EOP, and the node's own name,
// address and submission certificate. Pure: no database, no mailcow; services/mailNode/dnsCheckJob.js
// feeds them, keeps the results and runs them on a schedule.
//
// Every check answers { check, status, code, found, expected, records, detail }:
// - status 'error': a record the runbook (docs/operations/mail-node.md, sections 3 and 6) requires is
//   missing or does not match, or the lookup itself failed;
// - status 'warning': the record is there and mail flows, but it carries something it should not
//   (the node's address in SPF, an MTA-STS policy, an AAAA of the node), or the value to compare with
//   is not entered yet (then `found` shows what DNS has);
// - code: why, for the screens to translate; found / expected: what DNS has and what it must have;
//   records: what to publish, { type, name, value }, for the administrator to copy.
// The results only ever warn: nothing here moves a domain's onboarding (owner's decision 2026-10-01).

export const DNS_STATUSES = Object.freeze(['ok', 'warning', 'error']);
// Microsoft's SPF include for mail EOP sends out.
export const MICROSOFT_SPF_INCLUDE = 'include:spf.protection.outlook.com';
export const SPF_RECORD = `v=spf1 ${MICROSOFT_SPF_INCLUDE} -all`;
// What the runbook starts DMARC with: no policy, reports later.
export const DMARC_RECORD = 'v=DMARC1; p=none';
// A certificate that ends sooner warns (the alert threshold of R-18).
export const CERT_WARN_DAYS = 14;
export const SUBMISSION_PORT = 587;
// One lookup: a server that does not answer is asked again once.
const LOOKUP_TIMEOUT_MS = 3000;
const LOOKUP_TRIES = 2;
const CERT_TIMEOUT_MS = 15000;
// Nothing is published under the name: no answer, not a failure.
const NOTHING = new Set(['ENOTFOUND', 'ENODATA']);
const RANK = { ok: 0, warning: 1, error: 2 };

export class DnsCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DnsCheckError';
    this.code = code;
  }
}

// A resolver of its own for one run, so no answer outlives the run. server: the DNS_CHECK_RESOLVER
// setting, an IP address with an optional port ("172.19.0.7", "172.19.0.7:5353", "[2001:db8::53]:53");
// empty asks the servers the system uses.
export function createResolver(server = process.env.DNS_CHECK_RESOLVER, { timeoutMs = LOOKUP_TIMEOUT_MS, tries = LOOKUP_TRIES } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries });
  const text = String(server ?? '').trim();
  if (text) {
    const address = text.startsWith('[') ? text.slice(1, text.indexOf(']')) : text.replace(/:\d+$/, '');
    if (!isIP(address)) throw new DnsCheckError('dns_resolver_invalid', 'DNS_CHECK_RESOLVER must be an IP address with an optional port');
    resolver.setServers([text]);
  }
  return resolver;
}

export function overallStatus(checks) {
  return checks.reduce((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), 'ok');
}

// A DNS name as the checks compare it: lowercase, without the root dot.
const hostName = (value) => String(value ?? '').trim().toLowerCase().replace(/\.$/, '');

export function reverseName(ipv4) {
  return `${ipv4.split('.').reverse().join('.')}.in-addr.arpa`;
}

// The key of a DKIM record, the value of its p= tag with every blank taken out, or null when the
// text is no DKIM record. mailcow's own DNS check compares the same p= value
// (data/web/inc/ajax/dns_diagnostics.php:402-406, /v=DKIM1;.*k=rsa;.*p=([^;]*)/i); reading the tags
// one by one lets their order and the blanks a DNS host adds not matter.
export function dkimPublicKey(text) {
  const tags = new Map(joinTxtChunks(text).split(';').map((tag) => {
    const at = tag.indexOf('=');
    return at < 0 ? [tag.trim().toLowerCase(), ''] : [tag.slice(0, at).trim().toLowerCase(), tag.slice(at + 1)];
  }));
  if (!tags.has('p') || (tags.has('v') && tags.get('v').trim().toUpperCase() !== 'DKIM1')) return null;
  return tags.get('p').replace(/\s+/g, '');
}

// One lookup: { records } (empty when nothing is published) or { failed } with the resolver's code.
async function lookup(run) {
  try {
    return { records: await run() };
  } catch (err) {
    if (NOTHING.has(err?.code)) return { records: [] };
    return { failed: err?.code || 'error' };
  }
}

const item = (check, status, fields = {}) => ({ check, status, code: null, found: [], expected: null, records: [], ...fields });
const failedItem = (check, name, failed) => item(check, 'error', { code: 'dns_lookup_failed', detail: failed, name });

// TXT records of a name, each joined from its strings.
async function txtOf(resolver, name) {
  const { records, failed } = await lookup(() => resolver.resolveTxt(name));
  return failed ? { failed } : { records: records.map((chunks) => chunks.join('').trim()) };
}

// MX: exactly the expected hosts, no other. The expected values come from the tenant (entered by
// hand until the tenant driver exists); the form of the name (*.mail.protection.outlook.com or
// under mx.microsoft) is taken as it is, never derived from the domain.
async function mxCheck(resolver, domain, expectedMx) {
  const { records, failed } = await lookup(() => resolver.resolveMx(domain));
  if (failed) return failedItem('mx', domain, failed);
  const found = [...records].sort((a, b) => a.priority - b.priority).map((r) => hostName(r.exchange));
  const expected = [...new Set((expectedMx ?? []).map(hostName).filter(Boolean))];
  if (!expected.length) return item('mx', 'warning', { code: 'mx_expected_missing', name: domain, found });
  const fields = { name: domain, found, expected, records: expected.map((mx) => ({ type: 'MX', name: domain, value: `0 ${mx}` })) };
  if (!found.length) return item('mx', 'error', { ...fields, code: 'mx_missing' });
  if (expected.some((mx) => !found.includes(mx))) return item('mx', 'error', { ...fields, code: 'mx_mismatch' });
  if (found.some((mx) => !expected.includes(mx))) return item('mx', 'error', { ...fields, code: 'mx_extra' });
  return item('mx', 'ok', fields);
}

const SPF_VERSION = /^v=spf1(\s|$)/i;

// SPF: one v=spf1 record (two make receivers ignore both) with Microsoft's include. Mail leaves
// through EOP only: the node's own address in it lets mail that skipped EOP pass SPF.
function spfCheck(domain, txt, nodeIp) {
  if (txt.failed) return failedItem('spf', domain, txt.failed);
  const found = txt.records.filter((r) => SPF_VERSION.test(r));
  const fields = { name: domain, found, expected: [SPF_RECORD], records: [{ type: 'TXT', name: domain, value: SPF_RECORD }] };
  if (!found.length) return item('spf', 'error', { ...fields, code: 'spf_missing' });
  if (found.length > 1) return item('spf', 'error', { ...fields, code: 'spf_multiple' });
  const terms = found[0].toLowerCase().split(/\s+/).map((term) => term.replace(/^[+?~-]/, ''));
  if (!terms.includes(MICROSOFT_SPF_INCLUDE)) return item('spf', 'error', { ...fields, code: 'spf_no_include' });
  if (nodeIp && (terms.includes(`ip4:${nodeIp}`) || terms.includes(`ip4:${nodeIp}/32`))) {
    return item('spf', 'warning', { ...fields, code: 'spf_node_ip' });
  }
  return item('spf', 'ok', fields);
}

// DKIM in mailcow mode: the TXT under the node's selector carries the key mailcow signs with
// (get/dkim; its 255-character pieces joined). key: { name, txt, fromLastApply }, or null when the
// node has no key or could not be asked.
async function dkimTxtCheck(resolver, domain, key) {
  if (!key) return item('dkim_txt', 'warning', { code: 'dkim_key_unknown', name: `dkim._domainkey.${domain}` });
  const value = joinTxtChunks(key.txt);
  const txt = await txtOf(resolver, key.name);
  if (txt.failed) return failedItem('dkim_txt', key.name, txt.failed);
  const found = txt.records.filter((r) => dkimPublicKey(r) !== null);
  const fields = {
    name: key.name, found, expected: [value], records: [{ type: 'TXT', name: key.name, value }],
    ...(key.fromLastApply ? { keyFromLastApply: true } : {}),
  };
  if (!found.length) return item('dkim_txt', 'error', { ...fields, code: 'dkim_missing' });
  const wanted = dkimPublicKey(value);
  if (!wanted || !found.some((r) => dkimPublicKey(r) === wanted)) return item('dkim_txt', 'error', { ...fields, code: 'dkim_mismatch' });
  return item('dkim_txt', 'ok', fields);
}

const SELECTORS = ['selector1', 'selector2'];

// DKIM by EOP: the two selector CNAMEs point where Get-DkimSigningConfig says (Selector1CNAME,
// Selector2CNAME; entered by hand until the tenant driver reads them).
async function dkimCnameCheck(resolver, domain, cnames) {
  const names = SELECTORS.map((s) => `${s}._domainkey.${domain}`);
  const answers = await Promise.all(names.map((name) => lookup(() => resolver.resolveCname(name))));
  const failed = answers.find((a) => a.failed);
  if (failed) return failedItem('dkim_cname', names.join(', '), failed.failed);
  const found = answers.map((a) => hostName(a.records[0] ?? ''));
  const expected = cnames ? SELECTORS.map((s) => hostName(cnames[s])) : null;
  if (!expected || expected.some((v) => !v)) {
    return item('dkim_cname', 'warning', { code: 'dkim_cname_expected_missing', name: names.join(', '), found: found.filter(Boolean) });
  }
  const fields = {
    name: names.join(', '), found: found.filter(Boolean), expected,
    records: names.map((name, i) => ({ type: 'CNAME', name, value: expected[i] })),
  };
  if (found.some((v) => !v)) return item('dkim_cname', 'error', { ...fields, code: 'dkim_cname_missing' });
  if (found.some((v, i) => v !== expected[i])) return item('dkim_cname', 'error', { ...fields, code: 'dkim_cname_mismatch' });
  return item('dkim_cname', 'ok', fields);
}

const DMARC_VERSION = /^v\s*=\s*DMARC1\s*(;|$)/i;

// DMARC: one record under _dmarc that starts with v=DMARC1 (anything else there is ignored by
// receivers, as two records are).
async function dmarcCheck(resolver, domain) {
  const name = `_dmarc.${domain}`;
  const txt = await txtOf(resolver, name);
  if (txt.failed) return failedItem('dmarc', name, txt.failed);
  const valid = txt.records.filter((r) => DMARC_VERSION.test(r));
  const fields = { name, found: txt.records, records: [{ type: 'TXT', name, value: DMARC_RECORD }] };
  if (!txt.records.length) return item('dmarc', 'error', { ...fields, code: 'dmarc_missing' });
  if (!valid.length) return item('dmarc', 'error', { ...fields, code: 'dmarc_invalid' });
  if (valid.length > 1) return item('dmarc', 'error', { ...fields, code: 'dmarc_multiple' });
  return item('dmarc', 'ok', fields);
}

// The tenant's verification TXT (Graph verificationDnsRecords "text"; entered by hand until the
// tenant driver reads it). Without one, the MS= records DNS has are shown.
function tenantTxtCheck(domain, txt, expected) {
  if (txt.failed) return failedItem('tenant_txt', domain, txt.failed);
  const wanted = String(expected ?? '').trim();
  if (!wanted) {
    return item('tenant_txt', 'warning', { code: 'tenant_txt_expected_missing', name: domain, found: txt.records.filter((r) => /^MS=/i.test(r)) });
  }
  const fields = {
    name: domain, found: txt.records.filter((r) => /^MS=/i.test(r) || r.toLowerCase() === wanted.toLowerCase()),
    expected: [wanted], records: [{ type: 'TXT', name: domain, value: wanted }],
  };
  if (!txt.records.some((r) => r.toLowerCase() === wanted.toLowerCase())) return item('tenant_txt', 'error', { ...fields, code: 'tenant_txt_missing' });
  return item('tenant_txt', 'ok', fields);
}

// MTA-STS: a published policy makes senders deliver only to the hosts in its mx: lines. mailcow's
// own policy names the node; behind EOP the mail must go to the EOP MX, so a policy naming the node
// breaks inbound mail. The panel cannot read the policy (mailcow's API has no get for it), so any
// policy published is a warning to look at it.
async function mtaStsCheck(resolver, domain) {
  const name = `_mta-sts.${domain}`;
  const txt = await txtOf(resolver, name);
  if (txt.failed) return failedItem('mta_sts', name, txt.failed);
  const found = txt.records.filter((r) => /^v=STSv1/i.test(r));
  if (!found.length) return item('mta_sts', 'ok', { name });
  return item('mta_sts', 'warning', { code: 'mta_sts_published', name, found });
}

// The checks of one domain. dkimMode: who signs ('mailcow': the node's key in TXT; 'eop': the
// selector CNAMEs); dkimKey: the node's key, { name, txt, fromLastApply }; dkimCnames: the
// expected { selector1, selector2 } (also checked in mailcow mode once entered: both may sign);
// tenantTxt: the expected verification value; nodeIp: the node's IPv4, for SPF.
export async function checkDomainDns({
  domain, expectedMx = [], dkimMode = 'mailcow', dkimKey = null, dkimCnames = null, tenantTxt = null, nodeIp = null, resolver,
}) {
  const name = hostName(domain);
  const apexTxt = await txtOf(resolver, name);
  const cnamesEntered = !!(dkimCnames && SELECTORS.some((s) => dkimCnames[s]));
  const checks = [
    await mxCheck(resolver, name, expectedMx),
    spfCheck(name, apexTxt, nodeIp),
    ...(dkimMode === 'mailcow' ? [await dkimTxtCheck(resolver, name, dkimKey)] : []),
    ...(dkimMode === 'eop' || cnamesEntered ? [await dkimCnameCheck(resolver, name, cnamesEntered ? dkimCnames : null)] : []),
    await dmarcCheck(resolver, name),
    tenantTxtCheck(name, apexTxt, tenantTxt),
    await mtaStsCheck(resolver, name),
  ];
  return { checks, overall: overallStatus(checks) };
}

// The node's name: A <MAIL_HOST> is the node's address and nothing else, PTR of the address is
// <MAIL_HOST>, and no AAAA (the node runs with IPv6 off, decision D-13, so a sender trying it fails
// before it falls back). Without the node's address only what DNS has is shown.
export async function checkNodeDns({ mailHost, nodeIp = null, resolver }) {
  const host = hostName(mailHost);
  const a = await lookup(() => resolver.resolve4(host));
  const checks = [];
  if (a.failed) checks.push(failedItem('node_a', host, a.failed));
  else if (!nodeIp) checks.push(item('node_a', 'warning', { code: 'node_ip_missing', name: host, found: a.records }));
  else {
    const fields = { name: host, found: a.records, expected: [nodeIp], records: [{ type: 'A', name: host, value: nodeIp }] };
    if (!a.records.length) checks.push(item('node_a', 'error', { ...fields, code: 'a_missing' }));
    else if (a.records.length !== 1 || a.records[0] !== nodeIp) checks.push(item('node_a', 'error', { ...fields, code: 'a_mismatch' }));
    else checks.push(item('node_a', 'ok', fields));
  }
  if (!nodeIp) checks.push(item('node_ptr', 'warning', { code: 'node_ip_missing' }));
  else {
    const ptrName = reverseName(nodeIp);
    const ptr = await lookup(() => resolver.reverse(nodeIp));
    if (ptr.failed) checks.push(failedItem('node_ptr', ptrName, ptr.failed));
    else {
      const found = ptr.records.map(hostName);
      const fields = { name: ptrName, found, expected: [host], records: [{ type: 'PTR', name: ptrName, value: host }] };
      if (!found.length) checks.push(item('node_ptr', 'error', { ...fields, code: 'ptr_missing' }));
      else if (!found.includes(host)) checks.push(item('node_ptr', 'error', { ...fields, code: 'ptr_mismatch' }));
      else checks.push(item('node_ptr', 'ok', fields));
    }
  }
  const aaaa = await lookup(() => resolver.resolve6(host));
  if (aaaa.failed) checks.push(failedItem('node_aaaa', host, aaaa.failed));
  else if (aaaa.records.length) checks.push(item('node_aaaa', 'warning', { code: 'aaaa_present', name: host, found: aaaa.records }));
  else checks.push(item('node_aaaa', 'ok', { name: host }));
  return { checks, overall: overallStatus(checks) };
}

// Why a chain did not verify. The server sent the leaf without its intermediate: OpenSSL finds no
// issuer for the leaf at all, and EOP refuses the relay with 550 5.7.64 TenantAttribution (checked
// with a three-tier test chain: leaf alone -> UNABLE_TO_VERIFY_LEAF_SIGNATURE, a full chain to an
// unknown root -> UNABLE_TO_GET_ISSUER_CERT_LOCALLY).
const CHAIN_INCOMPLETE = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT']);
// Dates are judged on their own (cert_expiry); a chain that fails only on them is complete.
const DATE_ERRORS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const DAY_MS = 86400000;

// The certificate the node presents on 587, judged: its end date, the names it must carry
// (<MAIL_HOST> and the certificate name the EOP connector checks), and whether the chain it sends
// reaches a trusted root. cert: { authorized, authorizationError, validTo, subject, issuer,
// subjectAltName, matches(name) }.
export function judgeCertificate(cert, { names, now = Date.now() }) {
  const info = { subject: cert.subject ?? null, issuer: cert.issuer ?? null, subjectAltName: cert.subjectAltName ?? null };
  const ends = Date.parse(cert.validTo);
  const daysLeft = Math.floor((ends - now) / DAY_MS);
  const expiry = { expiresAt: Number.isFinite(ends) ? new Date(ends).toISOString() : null, daysLeft, ...info };
  let expiryItem;
  if (!Number.isFinite(ends) || ends <= now) expiryItem = item('cert_expiry', 'error', { ...expiry, code: 'cert_expired' });
  else if (daysLeft < CERT_WARN_DAYS) expiryItem = item('cert_expiry', 'warning', { ...expiry, code: 'cert_expiring' });
  else expiryItem = item('cert_expiry', 'ok', expiry);

  const missing = names.filter((name) => !cert.matches(name));
  const nameFields = { expected: names, found: cert.subjectAltName ? [cert.subjectAltName] : [], ...info };
  const nameItem = missing.length
    ? item('cert_name', 'error', { ...nameFields, code: 'cert_name_mismatch', missing })
    : item('cert_name', 'ok', nameFields);

  const reason = cert.authorized ? null : String(cert.authorizationError ?? 'UNKNOWN');
  let chainItem;
  if (!reason || DATE_ERRORS.has(reason)) chainItem = item('cert_chain', 'ok', info);
  else if (CHAIN_INCOMPLETE.has(reason)) chainItem = item('cert_chain', 'error', { ...info, code: 'cert_chain_incomplete', detail: reason });
  else chainItem = item('cert_chain', 'error', { ...info, code: 'cert_untrusted', detail: reason });
  return [expiryItem, nameItem, chainItem];
}

// Reads SMTP replies line by line: next() resolves with the next complete reply (the last line of a
// multi-line one decides), { code, lines }.
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  const waiting = [];
  const ready = [];
  socket.on('data', (data) => {
    buffer += data.toString('latin1');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        const take = waiting.shift();
        if (take) take(reply);
        else ready.push(reply);
      }
    }
  });
  return { next: () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => waiting.push(resolve))) };
}

class SmtpStepError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// The node's submission port: greeting, EHLO, STARTTLS, then the TLS handshake with the name the
// panel uses, the certificate judged without trusting it first (rejectUnauthorized: false), so an
// incomplete chain is reported instead of only failing. Connects through the system resolver, as
// the panel does for IMAP and SMTP. Returns the judged items, or one cert_connect item when the
// port could not be reached or offers no STARTTLS.
export async function checkSubmissionCertificate({ host, names, port = SUBMISSION_PORT, timeoutMs = CERT_TIMEOUT_MS, now }) {
  let socket;
  let secure;
  let timer;
  const failure = (code, detail) => [item('cert_connect', 'error', { code, detail, name: `${host}:${port}` })];
  try {
    const run = (async () => {
      socket = net.connect({ host, port });
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', (err) => reject(new SmtpStepError('cert_unreachable', err.code || 'error')));
      });
      socket.on('error', () => {});
      const replies = replyReader(socket);
      const closed = new Promise((_, reject) => socket.once('close', () => reject(new SmtpStepError('cert_unreachable', 'ECONNRESET'))));
      const next = () => Promise.race([replies.next(), closed]);
      const greeting = await next();
      if (greeting.code !== 220) throw new SmtpStepError('cert_unreachable', greeting.lines.at(-1));
      socket.write('EHLO mailexpert.invalid\r\n');
      const ehlo = await next();
      if (ehlo.code !== 250) throw new SmtpStepError('cert_unreachable', ehlo.lines.at(-1));
      if (!ehlo.lines.some((line) => /^250[ -]STARTTLS\b/i.test(line))) throw new SmtpStepError('starttls_unavailable');
      socket.write('STARTTLS\r\n');
      const start = await next();
      if (start.code !== 220) throw new SmtpStepError('starttls_refused', start.lines.at(-1));
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      // The names are judged apart (cert_name): authorizationError then speaks of the chain alone.
      secure = tls.connect({
        socket, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, checkServerIdentity: () => undefined,
      });
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', (err) => reject(new SmtpStepError('cert_handshake_failed', err.code || err.message)));
      });
      const x509 = secure.getPeerX509Certificate();
      if (!x509) throw new SmtpStepError('cert_handshake_failed', 'no certificate');
      const cert = {
        authorized: secure.authorized, authorizationError: secure.authorizationError ?? null, validTo: x509.validTo,
        subject: x509.subject, issuer: x509.issuer, subjectAltName: x509.subjectAltName ?? null,
        matches: (name) => x509.checkHost(name) !== undefined,
      };
      secure.end('QUIT\r\n');
      return judgeCertificate(cert, { names, now });
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SmtpStepError('cert_unreachable', 'ETIMEDOUT')), timeoutMs);
    });
    return await Promise.race([run, timeout]);
  } catch (err) {
    if (err instanceof SmtpStepError) return failure(err.code, err.detail);
    return failure('cert_unreachable', err?.code || 'error');
  } finally {
    clearTimeout(timer);
    secure?.destroy();
    socket?.destroy();
  }
}
