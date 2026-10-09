// Live check of MailExpert against a real mailcow (scripts/deploy/test/e2e-mailcow.sh starts both).
// Runs in the backend image, next to the panel: every step goes through the panel's HTTP API the
// way the screens do, and the mailcow API is read directly only to confirm what the panel did.
//
// Env: PANEL (http://backend:3000), MAIL_HOST, API_KEY, NODE_EXTRA_CA_CERTS (the test CA).
import assert from 'node:assert/strict';
import { ImapFlow } from 'imapflow';

const PANEL = process.env.PANEL;
const MAIL_HOST = process.env.MAIL_HOST;
const API_KEY = process.env.API_KEY;
// A new domain per run, so a kept mailcow can be reused.
const DOMAIN = process.env.E2E_DOMAIN || `t${Date.now().toString(36)}.test`;
let cookie = '';
let step = 0;

const log = (msg) => console.log(`[e2e-mailcow] ${msg}`);
const pass = (msg) => log(`ok ${++step}: ${msg}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function panel(method, path, body) {
  const res = await fetch(`${PANEL}/api${path}`, {
    method,
    headers: {
      'X-Requested-With': 'MailExpert',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function mailcow(method, path, body) {
  const res = await fetch(`https://${MAIL_HOST}/api/v1/${path}`, {
    method,
    headers: { 'X-API-Key': API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
const nodeMailbox = async (email) => {
  const data = await mailcow('GET', `get/mailbox/${encodeURIComponent(email)}`);
  return data && data.username ? data : null;
};

async function until(what, fn, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function imapLogin(user, pass) {
  const client = new ImapFlow({ host: MAIL_HOST, port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  }
}

const accountBy = async (email) => (await panel('GET', '/accounts')).data.find((a) => a.email_address === email);
const inbox = async (accountId) => {
  const { data } = await panel('GET', `/mail/messages?accountId=${accountId}&folder=INBOX&limit=50`);
  return data?.messages ?? [];
};
// Connected and synced once: the server lists its folders and the row has no sync error.
async function connected(email) {
  return until(`${email} to connect`, async () => {
    const account = await accountBy(email);
    if (!account || account.sync_error) return null;
    const folders = await panel('GET', `/accounts/${account.id}/folders`);
    return Array.isArray(folders.data) && folders.data.some((f) => f.path === 'INBOX') ? account : null;
  });
}

// 1. The first user of a fresh install is its administrator.
let r = await panel('POST', '/auth/register', { username: 'admin', password: 'e2e-admin-password-1' });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.user.isAdmin, true);
// The test node resolves to a private address; a real node is public.
r = await panel('PATCH', '/admin/settings', { allow_private_hosts: true });
assert.equal(r.status, 200, JSON.stringify(r.data));
pass('administrator signed in; private hosts allowed for the test node');

r = await panel('GET', '/integrations/status');
assert.deepEqual(r.data.domainMail, { configured: false });

// 2. Settings: a wrong key is refused and nothing is saved; the right one is checked and saved.
r = await panel('PUT', '/mail-node/config', { mailHost: MAIL_HOST, apiKey: 'WRONG-KEY-0000', quotaMb: 5120 });
assert.equal(r.status, 502, JSON.stringify(r.data));
assert.equal(r.data.code, 'mail_node_auth');
assert.deepEqual((await panel('GET', '/integrations/status')).data.domainMail, { configured: false });
r = await panel('PUT', '/mail-node/config', { mailHost: MAIL_HOST, apiKey: API_KEY, quotaMb: 5120 });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.deepEqual((await panel('GET', '/integrations/status')).data.domainMail, { configured: true });
pass('mail node settings: wrong key refused, right key checked and saved');

// 3. A domain from MailExpert.
r = await panel('POST', '/mail-node/domains', { domain: DOMAIN, mailboxes: 50 });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await panel('GET', '/mail-node/domains');
const domain = r.data.domains.find((d) => d.domain === DOMAIN);
assert.ok(domain?.active, JSON.stringify(r.data));
assert.equal(domain.maxMailboxes, 50);
const nodeDomain = await mailcow('GET', `get/domain/${DOMAIN}`);
assert.equal(Number(nodeDomain.max_quota_for_mbox) / 1048576, 102400);
// The stand has no tenant: the domain is marked ready by hand so it takes mailboxes.
assert.equal(domain.state, 'node_created');
r = await panel('POST', `/mail-node/domains/${DOMAIN}/ready`);
assert.equal(r.status, 200, JSON.stringify(r.data));
// Every node mailbox holds an EOP seat. Without a tenant the purchased number is the Licenses field
// of the EOP settings, as an administrator enters it.
r = await panel('PUT', '/mail-node/eop', { licenses: 50 });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await panel('GET', '/mail-node/seats');
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.mode, 'manual', JSON.stringify(r.data));
assert.equal(r.data.free, 50, JSON.stringify(r.data));
pass(`domain ${DOMAIN} created on the node with 50 mailboxes and marked ready; 50 EOP seats entered`);

// 4. Two mailboxes: created on the node with 5 GB and connected by the panel.
for (const localPart of ['sales', 'support']) {
  r = await panel('POST', '/accounts', { kind: 'domain', localPart, domain: DOMAIN, name: localPart });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mail_node, true);
  assert.equal(r.data.imap_host, MAIL_HOST);
  assert.equal(JSON.stringify(r.data).includes('auth_pass'), false);
}
for (const email of [`sales@${DOMAIN}`, `support@${DOMAIN}`]) {
  const m = await nodeMailbox(email);
  assert.equal(Number(m.active_int ?? m.active), 1);
  assert.equal(Number(m.quota) / 1048576, 5120);
  await connected(email);
}
pass('two mailboxes created on the node (5120 MB each) and connected over IMAP');

// 5. Mail between them through the node: SMTP submission, local delivery, IMAP sync.
const sales = await accountBy(`sales@${DOMAIN}`);
const support = await accountBy(`support@${DOMAIN}`);
const subject = `e2e hello ${Date.now()}`;
r = await panel('POST', '/mail/send', { accountId: sales.id, to: [`support@${DOMAIN}`], subject, body: 'Hello from the live check.' });
assert.equal(r.status, 200, JSON.stringify(r.data));
await until('the letter in support INBOX', async () => {
  await panel('POST', '/mail/sync', { accountId: support.id });
  return (await inbox(support.id)).find((m) => m.subject === subject);
}, 180000);
pass('a letter sent from sales reached support INBOX in MailExpert');

// 6. Quota and usage as the admin screen shows them, and a quota change reaches the node.
r = await panel('GET', '/mail-node/mailboxes');
assert.equal(r.status, 200, JSON.stringify(r.data));
const row = r.data.mailboxes.find((m) => m.email === `support@${DOMAIN}`);
assert.equal(row.onNode, true);
assert.equal(row.quotaMb, 5120);
assert.equal(typeof r.data.disk.usedPercent, 'number', JSON.stringify(r.data.disk));
r = await panel('PUT', `/mail-node/mailboxes/${support.id}/quota`, { quotaMb: 10240 });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(Number((await nodeMailbox(`support@${DOMAIN}`)).quota) / 1048576, 10240);
pass(`admin table: quota, usage and disk (${r.data ? `${row.usedBytes} bytes used` : ''}); quota raised to 10240 MB on the node`);

// 7. The server settings of a node mailbox cannot be pointed elsewhere.
r = await panel('PUT', `/accounts/${support.id}`, { imap_host: 'evil.example.net' });
assert.equal(r.status, 400);
assert.equal(r.data.code, 'mail_node_connection_locked');
pass('server settings of a node mailbox are locked');

// 8. Deleting a node mailbox is scheduled: the address typed and a reason given, the mailbox keeps
// working until its date (the deletion job then deletes it on the node; covered by
// mailboxDeletion.pglite.test.js, since this run cannot wait days). While pending, the address
// cannot be created again; anyone may cancel. A disabled mailbox left on the node is refused
// instead of taken over.
r = await panel('DELETE', `/accounts/${support.id}`);
assert.equal(r.status, 409, JSON.stringify(r.data));
assert.equal(r.data.code, 'mail_node_deletion_request_required');
r = await panel('POST', `/accounts/${support.id}/deletion`, { email: `support@${DOMAIN}`, reason: 'e2e check' });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.ok(r.data.delete_after, JSON.stringify(r.data));
assert.equal(r.data.deletion_reason, 'e2e check');
const stillThere = await nodeMailbox(`support@${DOMAIN}`);
assert.equal(Number(stillThere.active_int ?? stillThere.active), 1, 'the mailbox keeps working until its date');
const pendingLetter = `e2e while pending ${Date.now()}`;
r = await panel('POST', '/mail/send', { accountId: sales.id, to: [`support@${DOMAIN}`], subject: pendingLetter, body: 'Still delivered.' });
assert.equal(r.status, 200, JSON.stringify(r.data));
await until('the letter sent while the deletion is pending', async () => {
  await panel('POST', '/mail/sync', { accountId: support.id });
  return (await inbox(support.id)).find((m) => m.subject === pendingLetter);
}, 180000);
r = await panel('POST', '/accounts', { kind: 'domain', localPart: 'support', domain: DOMAIN, name: 'support again' });
assert.equal(r.status, 409, JSON.stringify(r.data));
assert.equal(r.data.code, 'mailbox_pending_deletion');
r = await panel('DELETE', `/accounts/${support.id}/deletion`);
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.delete_after, null);
const parkedPassword = 'Parked-password-1!';
const parked = await mailcow('POST', 'add/mailbox', {
  local_part: 'parked', domain: DOMAIN, name: 'parked', password: parkedPassword, password2: parkedPassword, quota: 1024, active: 0,
});
assert.equal(parked[0]?.type, 'success', JSON.stringify(parked));
r = await panel('POST', '/accounts', { kind: 'domain', localPart: 'parked', domain: DOMAIN });
assert.equal(r.status, 409, JSON.stringify(r.data));
assert.equal(r.data.code, 'mailbox_disabled_on_node');
pass('deletion scheduled with a reason, mailbox kept working, address refused while pending, cancelled; a disabled one is refused');

// 9. A mailbox made by hand in mailcow is taken over: its old password stops working.
const handPassword = 'Hand-made-password-1!';
const made = await mailcow('POST', 'add/mailbox', {
  local_part: 'manual', domain: DOMAIN, name: 'manual', password: handPassword, password2: handPassword, quota: 1024, active: 1,
});
assert.equal(made[0]?.type, 'success', JSON.stringify(made));
assert.equal(await imapLogin(`manual@${DOMAIN}`, handPassword), true);
r = await panel('POST', '/accounts', { kind: 'domain', localPart: 'manual', domain: DOMAIN });
assert.equal(r.status, 200, JSON.stringify(r.data));
await connected(`manual@${DOMAIN}`);
// Dovecot caches a successful login for auth_cache_ttl (mailcow: 5 minutes), so the old
// password keeps working until that entry expires; open sessions are not cut at all.
await until('the old password to be refused', async () => !(await imapLogin(`manual@${DOMAIN}`, handPassword)), 400000);
pass('a hand-made mailbox was taken over: connected, old password refused once the login cache expired');

// 10. A mailbox removed by hand in mailcow: its deletion can still be scheduled (the job lets the
// row go when the node no longer has the mailbox).
const manual = await accountBy(`manual@${DOMAIN}`);
const removed = await mailcow('POST', 'delete/mailbox', [`manual@${DOMAIN}`]);
assert.equal(removed[0]?.type, 'success', JSON.stringify(removed));
r = await panel('POST', `/accounts/${manual.id}/deletion`, { email: `manual@${DOMAIN}`, reason: 'removed by hand' });
assert.equal(r.status, 200, JSON.stringify(r.data));
pass('the deletion of a mailbox already gone from the node can be scheduled');

// 11. The same address twice in MailExpert is refused before the node is touched.
r = await panel('POST', '/accounts', { kind: 'domain', localPart: 'sales', domain: DOMAIN });
assert.equal(r.status, 409);
assert.equal(r.data.code, 'mailbox_exists');
pass('an address already in MailExpert is refused');

log(`all ${step} checks passed`);
