import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { demoRequest } from './index.js';
import { demoNodeTime } from './clock.js';

// Guards against the crash class fixed alongside this test: an unhandled request in demo mode
// used to fall through to a fake `{ ok: true, demo: true }` success, so a screen expecting
// `{ users: [...] }` (or similar) off a GET read `undefined` off it and crashed the whole app,
// or a write's caller (`const { user } = await api.admin.createUser(...)`) crashed the same way
// on click. Every path pattern api.js can call — GET and write alike — must now either have a
// concrete demo answer, or be listed in a REJECTED table with the reason it legitimately has
// none, so a newly added endpoint with no demo support fails this test instead of shipping a
// silent crash.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PATH = path.join(__dirname, '../utils/api.js');

// Mirrors how api.js actually calls the server: a literal string/template passed to request(...)
// or (for the couple of calls that bypass it) demoRequestImpl(...). `${expr}` segments become
// ':param'; anything from a literal '?' onward (a query string) is dropped, since query params
// are supplied per-call below, not part of the route pattern.
function extractPatterns(source, methods) {
  const re = new RegExp(`(?:request|demoRequestImpl)\\(\\s*'(${methods.join('|')})'\\s*,\\s*(?:'([^']*)'|\`([^\`]*)\`)`, 'g');
  const patterns = new Set();
  let m;
  while ((m = re.exec(source))) {
    const verb = m[1];
    const raw = m[2] ?? m[3];
    const normalized = raw.split(/\$\{[^}]*\}/).join(':param');
    const q = normalized.indexOf('?');
    patterns.add(`${verb} ${q === -1 ? normalized : normalized.slice(0, q)}`);
  }
  return patterns;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET coverage
// ─────────────────────────────────────────────────────────────────────────────

// pattern (as extractPatterns produces it, minus the "GET " prefix) -> a concrete path, with real
// demo fixture ids substituted for every :param, to actually call.
const CONCRETE_PATH = {
  '/oauth/microsoft/device/poll': '/oauth/microsoft/device/poll',
  '/mail/messages/:param/attachments/:param': '/mail/messages/demo-001/attachments/1',
  '/mail/messages/:param/raw.eml': '/mail/messages/demo-001/raw.eml',
  '/mail/messages/:param/body:param': '/mail/messages/demo-001/body',
  '/auth/me': '/auth/me',
  '/auth/config': '/auth/config',
  '/auth/preferences': '/auth/preferences',
  '/auth/registration-status': '/auth/registration-status',
  '/auth/profile/recovery-email': '/auth/profile/recovery-email',
  '/totp/setup': '/totp/setup',
  '/admin/users': '/admin/users',
  '/admin/settings': '/admin/settings',
  '/admin/invites': '/admin/invites',
  '/admin/system-email': '/admin/system-email',
  '/admin/auth-events': '/admin/auth-events?limit=100&offset=0',
  '/admin/audit': '/admin/audit',
  '/admin/access-sync': '/admin/access-sync',
  '/admin/update': '/admin/update',
  '/admin/google-apps': '/admin/google-apps',
  '/admin/oidc': '/admin/oidc',
  '/auth/oidc/providers': '/auth/oidc/providers',
  '/auth/oidc/identities': '/auth/oidc/identities',
  '/accounts': '/accounts',
  '/mail-node/config': '/mail-node/config',
  '/mail-node/domains': '/mail-node/domains',
  '/mail-node/mailboxes': '/mail-node/mailboxes',
  '/mail-node/eop': '/mail-node/eop',
  '/mail-node/apply': '/mail-node/apply',
  '/mail-node/dns-check': '/mail-node/dns-check',
  '/mail-node/queue': '/mail-node/queue',
  '/mail-node/queue/:param:param': '/mail-node/queue/D3A1F2B4C5',
  '/mail-node/alerts': '/mail-node/alerts',
  '/mail-node/eop/budget': '/mail-node/eop/budget',
  '/mail-node/tenant': '/mail-node/tenant',
  '/mail-node/tenant/jobs/:param': '/mail-node/tenant/jobs/9001',
  '/mail-node/tenant/phish-release': '/mail-node/tenant/phish-release',
  '/mail-node/agent': '/mail-node/agent',
  '/mail-node/quarantine': '/mail-node/quarantine',
  '/mail-node/quarantine/:param': '/mail-node/quarantine/41',
  '/mail-node/quarantine/settings': '/mail-node/quarantine/settings',
  '/mail-node/outage-letters': '/mail-node/outage-letters',
  '/mail-node/outages': '/mail-node/outages',
  '/mail-node/outages/:param/letters': '/mail-node/outages/demo-outage-2/letters',
  '/mail-node/messages/:param/spam-verdict': '/mail-node/messages/demo-fx-02-00-00/spam-verdict',
  '/accounts/:param/folders': '/accounts/demo-sales/folders',
  '/accounts/:param/aliases': '/accounts/demo-sales/aliases',
  '/accounts/:param/node-aliases': '/accounts/demo-fx-02/node-aliases',
  '/mail/messages': '/mail/messages?accountId=demo-sales&folder=INBOX',
  '/mail/messages/:param': '/mail/messages/demo-001',
  '/mail/messages/:param/sender-history': '/mail/messages/demo-001/sender-history?limit=5',
  '/mail/messages/:param/conversation': '/mail/messages/demo-001/conversation',
  '/mail/messages/:param/threading': '/mail/messages/demo-001/threading',
  '/mail/resolve-message': '/mail/resolve-message?ref=demo-001',
  '/mail/thread/:param:param': '/mail/thread/demo-renewal?accountId=demo-sales',
  '/mail/unread-counts': '/mail/unread-counts',
  '/mail/mailbox-usage': '/mail/mailbox-usage?accountId=demo-sales',
  '/mail/cleanup-preview': `/mail/cleanup-preview?accountId=demo-sales&fromEmail=${encodeURIComponent('newsletter@aster.example')}`,
  '/mail/messages/:param/headers': '/mail/messages/demo-001/headers',
  '/mail/messages/:param/delivery': '/mail/messages/demo-005/delivery',
  '/mail/messages/:param/bcc': '/mail/messages/demo-001/bcc',
  '/mail/scheduled': '/mail/scheduled?accountId=demo-sales',
  '/mail/scheduled/:param': '/mail/scheduled/demo-job-1',
  '/integrations': '/integrations',
  '/integrations/status': '/integrations/status',
  '/oauth/google/known-emails': '/oauth/google/known-emails?q=archive',
  '/search': '/search?q=renewal',
  '/search/contacts': '/search/contacts?q=maya',
  '/contacts:param': '/contacts',
  '/contacts/:param': '/contacts/demo-contact-1',
  '/contacts/:param/letters:param': '/contacts/demo-contact-1/letters',
  '/rules': '/rules',
  '/block-list': '/block-list',
  '/admin/ai': '/admin/ai',
  '/ai/status': '/ai/status',
  '/admin/ai/codex/status': '/admin/ai/codex/status',
  '/mail/category-counts:param': '/mail/category-counts?accountId=demo-sales',
  '/categories/sources': '/categories/sources',
  '/gtd/sections:param': '/gtd/sections',
  '/plugins': '/plugins',
  '/todoist/status': '/todoist/status',
  '/todoist/projects': '/todoist/projects',
  '/todoist/labels': '/todoist/labels',
};

// Patterns the demo deliberately has no success answer for — it must still reject the way a
// real failed request does (never the generic fallback), and each entry says why.
const REJECTED_GET = {
  '/auth/invite/:param': {
    path: '/auth/invite/some-invite-token',
    reason: 'public pre-login registration flow; the demo signs straight in and never renders it',
  },
  '/auth/2fa/enrollment/setup': {
    path: '/auth/2fa/enrollment/setup',
    reason: 'only valid mid-login with a pending unauthenticated session (the real server 400s '
      + 'the same way outside one); the demo is always already signed in',
    match: /No pending enrollment/,
  },
  '/auth/push/vapid-key': {
    path: '/auth/push/vapid-key',
    reason: 'the real server answers 503 when no VAPID keys are configured, and the demo never '
      + 'has any; usePushNotifications already reads the rejection as "push unavailable"',
    match: /not configured/,
  },
  '/gtd/pet/:param/meta': {
    path: '/gtd/pet/demo-pet/meta',
    reason: 'no pet is ever imported in the demo (GtdSettings’ import flow has nothing to '
      + 'upload to); this matches the real 404 for a slug with no stored pet',
    match: /Pet not found/,
  },
};

test('every GET path pattern api.js can call has an explicit demo answer', async () => {
  const source = fs.readFileSync(API_PATH, 'utf8');
  const patterns = new Set([...extractPatterns(source, ['GET'])].map(key => key.slice('GET '.length)));
  assert.ok(patterns.size > 40, 'sanity check: the extractor should find dozens of GET call sites in api.js');

  const covered = new Set([...Object.keys(CONCRETE_PATH), ...Object.keys(REJECTED_GET)]);
  const missing = [...patterns].filter(p => !covered.has(p));
  assert.deepEqual(
    missing, [],
    `add a demo answer in frontend/src/demo/index.js and a table entry in this test for: ${missing.join(', ')}`,
  );

  for (const [pattern, concretePath] of Object.entries(CONCRETE_PATH)) {
    const result = await demoRequest('GET', concretePath).catch((err) => {
      throw new Error(`${pattern} (${concretePath}) should resolve in demo mode, but rejected: ${err.message}`);
    });
    assert.notDeepEqual(
      result, { ok: true, demo: true },
      `${pattern} (${concretePath}) fell through to the generic demo fallback instead of a real answer`,
    );
  }

  for (const [pattern, { path: rejectPath, reason, match }] of Object.entries(REJECTED_GET)) {
    await assert.rejects(
      () => demoRequest('GET', rejectPath),
      match || /./,
      `${pattern} (${rejectPath}) should reject like a real failed request (${reason})`,
    );
  }
});

test('an unhandled GET in demo mode rejects instead of returning a fake success', async () => {
  await assert.rejects(
    () => demoRequest('GET', '/some/made-up/endpoint'),
    /Not available in demo mode/,
  );
});

test('/auth/me answers the signed-in role (admin by default, plain user via demoUser=user)', async () => {
  const originalStorage = globalThis.localStorage;
  let stored = null;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  try {
    const admin = await demoRequest('GET', '/auth/me');
    assert.equal(admin.user.isAdmin, true);

    stored = 'user';
    const plain = await demoRequest('GET', '/auth/me');
    assert.equal(plain.user.isAdmin, false);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

// "Watch as a user": the admin routes answer 403 as the backend's requireAdmin does, and what an
// ordinary user may read still answers.
test('as a plain user the admin routes answer 403, the user routes still answer', async () => {
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'user', setItem: () => {} };
  try {
    const denied = [
      ['PUT', '/mail-node/tenant/phish-release', { enabled: false }],
      ['GET', '/mail-node/tenant'],
      ['GET', '/mail-node/eop'],
      ['GET', '/mail-node/config'],
      ['POST', '/mail-node/apply'],
      ['GET', '/mail-node/quarantine/settings'],
      ['POST', '/mail-node/quarantine/1/release'],
      ['GET', '/mail-node/outages'],
      ['GET', '/admin/users'],
      ['GET', '/admin/update'],
      ['POST', '/admin/update', { target: 'sha-dddddddddddd', confirm: 'sha-dddddddddddd' }],
      ['GET', '/admin/ai'],
      ['GET', '/integrations'],
      ['POST', '/integrations/microsoft', {}],
      ['POST', '/categories/sources', {}],
      ['POST', '/accounts', { name: 'x' }],
      ['POST', '/accounts/demo-gmail/threading/preview', {}],
      ['PATCH', '/plugins/gtd', { enabled: false }],
    ];
    for (const [method, requestPath, body] of denied) {
      await assert.rejects(() => demoRequest(method, requestPath, body), (err) => {
        assert.equal(err.status, 403, `${method} ${requestPath}`);
        assert.equal(err.message, 'Admin access required');
        return true;
      });
    }
    // Refused before any change: the switch is still on for the administrator.
    globalThis.localStorage = { getItem: () => 'admin', setItem: () => {} };
    assert.equal((await demoRequest('GET', '/mail-node/tenant/phish-release')).enabled, true);
    globalThis.localStorage = { getItem: () => 'user', setItem: () => {} };

    for (const requestPath of ['/mail-node/domains', '/mail-node/outage-letters', '/integrations/status', '/categories/sources', '/accounts', '/plugins']) {
      await demoRequest('GET', requestPath);
    }
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Write coverage (POST/PUT/PATCH/DELETE)
// ─────────────────────────────────────────────────────────────────────────────
//
// Many writes are CRUD chains (a POST creates a row, a PATCH/PUT/DELETE then needs its real id),
// so this runs as one ordered sequence with a shared `ctx` carrying ids forward, instead of a
// flat table. `answer(...)` calls a pattern and asserts it resolves (the real backend shape is
// spot-checked with extra assertions where it matters); `reject(...)` asserts it rejects with a
// reason. Both record the pattern as covered so the final test can catch anything api.js gained
// that neither function above ever exercised.

const coveredWritePatterns = new Set();

async function answer(pattern, method, requestPath, body) {
  coveredWritePatterns.add(`${method} ${pattern}`);
  return demoRequest(method, requestPath, body).catch((err) => {
    throw new Error(`${method} ${pattern} (${requestPath}) should resolve in demo mode, but rejected: ${err.message}`);
  });
}

async function reject(pattern, method, requestPath, body, match) {
  coveredWritePatterns.add(`${method} ${pattern}`);
  await assert.rejects(() => demoRequest(method, requestPath, body), match || /./, `${method} ${pattern} (${requestPath}) should reject`);
}

test('login-flow writes reject: unreachable in demo (App.jsx bypasses sign-in entirely)', async () => {
  await reject('/auth/login', 'POST', '/auth/login', { username: 'demo', password: 'x' });
  await reject('/auth/register', 'POST', '/auth/register', { username: 'x', password: 'y' });
  await reject('/auth/forgot-password', 'POST', '/auth/forgot-password', { email: 'x@example.com' });
  await reject('/auth/reset-password', 'POST', '/auth/reset-password', { token: 'x', password: 'y' });
  await reject('/auth/2fa/challenge', 'POST', '/auth/2fa/challenge', { code: '123456' });
  await reject('/auth/2fa/send-email-otp', 'POST', '/auth/2fa/send-email-otp');
  await reject('/auth/2fa/verify-email-otp', 'POST', '/auth/2fa/verify-email-otp', { code: '123456' });
  await reject('/auth/2fa/enrollment/enable', 'POST', '/auth/2fa/enrollment/enable', { code: '123456' }, /No pending enrollment/);
});

test('a real AI chat call rejects — no provider behind it in demo', async () => {
  await reject('/ai/chat', 'POST', '/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }, /demo mode/);
});

test('session, profile, avatar, recovery-email and 2FA-management writes answer', async () => {
  const logout = await answer('/auth/logout', 'POST', '/auth/logout');
  assert.equal(logout.ok, true);
  await answer('/auth/lock', 'POST', '/auth/lock');
  await answer('/auth/unlock', 'POST', '/auth/unlock', { pin: '1234' });
  await answer('/auth/lock-pin', 'POST', '/auth/lock-pin', { pin: '1234' });
  await answer('/auth/lock-pin', 'DELETE', '/auth/lock-pin', { currentPin: '1234' });
  await answer('/auth/profile', 'PATCH', '/auth/profile', { displayName: 'Coverage Name' });
  await answer('/auth/avatar', 'POST', '/auth/avatar', { avatar: 'data:image/png;base64,AA==' });
  await answer('/auth/avatar', 'DELETE', '/auth/avatar');
  const recovery = await answer('/auth/profile/recovery-email', 'PATCH', '/auth/profile/recovery-email', { email: 'me@example.com' });
  assert.equal(recovery.ok, true);
  await answer('/totp/enable', 'POST', '/totp/enable', { code: '123456' });
  await answer('/totp/disable', 'POST', '/totp/disable', { password: 'x' });
  await answer('/totp/cancel', 'POST', '/totp/cancel');
  await answer('/auth/preferences/whitelist-add', 'POST', '/auth/preferences/whitelist-add', { domain: 'example.com' });
});

test('push subscribe/unsubscribe reject: gated behind vapid-key, which the demo never has', async () => {
  await reject('/auth/push/subscribe', 'POST', '/auth/push/subscribe', { endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } }, /not configured/);
  await reject('/auth/push/unsubscribe', 'POST', '/auth/push/unsubscribe', {}, /not configured/);
});

test('admin user management round-trips through in-memory state', async () => {
  const created = await answer('/admin/users', 'POST', '/admin/users', { email: 'newadmin@example.com' });
  assert.equal(created.user.email, 'newadmin@example.com');
  const id = created.user.id;
  const patched = await answer('/admin/users/:param', 'PATCH', `/admin/users/${id}`, { isAdmin: true });
  assert.equal(patched.user.isAdmin, true);
  await answer('/admin/users/:param/totp/disable', 'POST', '/admin/users/demo-colleague/totp/disable');
  await answer('/admin/users/:param', 'DELETE', `/admin/users/${id}`);
  const list = await demoRequest('GET', '/admin/users');
  assert.equal(list.users.some(u => u.id === id), false);
});

test('admin invites round-trip through in-memory state', async () => {
  const created = await answer('/admin/invites', 'POST', '/admin/invites', { email: 'invitee@example.com' });
  assert.equal(typeof created.inviteUrl, 'string');
  const { invites } = await demoRequest('GET', '/admin/invites');
  const invite = invites.find(i => i.email === 'invitee@example.com');
  assert.ok(invite, 'the created invite should be listed');
  await answer('/admin/invites/:param', 'DELETE', `/admin/invites/${invite.id}`);
});

test('admin system email round-trips and its test send rejects', async () => {
  await answer('/admin/system-email', 'POST', '/admin/system-email', {
    host: 'smtp.demo.local', port: 587, user: 'demo', pass: 'x', fromName: 'MailExpert', fromEmail: 'demo@demo.local',
  });
  await reject('/admin/system-email/test', 'POST', '/admin/system-email/test', {}, /test email/);
  await answer('/admin/system-email', 'DELETE', '/admin/system-email');
});

test('admin Google Workspace apps round-trip through in-memory state', async () => {
  const created = await answer('/admin/google-apps', 'POST', '/admin/google-apps', { label: 'Demo Google App', clientId: 'client-123' });
  assert.deepEqual(created.warnings, []);
  const id = created.app.id;
  const patched = await answer('/admin/google-apps/:param', 'PATCH', `/admin/google-apps/${id}`, { label: 'Renamed' });
  assert.equal(patched.app.label, 'Renamed');
  await answer('/admin/google-apps/:param', 'DELETE', `/admin/google-apps/${id}`);
});

test('admin Google Workspace apps accept an imported client JSON, defaulting the label and warning about the callback', async () => {
  const clientJson = JSON.stringify({
    web: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x', project_id: 'demo-project-123' },
  });
  const created = await answer('/admin/google-apps', 'POST', '/admin/google-apps', { clientJson });
  assert.equal(created.app.clientId, '123-abc.apps.googleusercontent.com');
  assert.equal(created.app.label, 'demo-project-123');
  assert.ok(created.warnings.some((w) => w.code === 'callback_not_configured' || w.code === 'redirect_uri_missing'));
  await answer('/admin/google-apps/:param', 'DELETE', `/admin/google-apps/${created.app.id}`);

  await reject('/admin/google-apps', 'POST', '/admin/google-apps', { clientJson: JSON.stringify({ type: 'service_account' }) }, /service account/);
});

test('admin SSO provider CRUD round-trips, and unlinking your only identity rejects', async () => {
  const created = await answer('/admin/oidc', 'POST', '/admin/oidc', {
    name: 'Demo IdP', slug: 'demo-idp', issuer_url: 'https://idp.example.com', client_id: 'client', client_secret: 'secret',
  });
  const id = created.provider.id;
  const patched = await answer('/admin/oidc/:param', 'PATCH', `/admin/oidc/${id}`, { name: 'Renamed IdP' });
  assert.equal(patched.provider.name, 'Renamed IdP');
  await answer('/admin/oidc/:param', 'DELETE', `/admin/oidc/${id}`);
  await reject('/auth/oidc/identities/:param', 'DELETE', '/auth/oidc/identities/some-identity-id', undefined, /only login method/);
});

test('manual IMAP mailbox add, edit, aliases and delete round-trip through ACCOUNT_FIXTURES', async () => {
  const account = await answer('/accounts', 'POST', '/accounts', {
    name: 'Demo Manual', email_address: 'manual@demo.mailexpert.local',
    imap_host: 'imap.demo.local', imap_port: 993, smtp_host: 'smtp.demo.local', smtp_port: 587, smtp_tls: 'STARTTLS',
  });
  const id = account.id;
  const edited = await answer('/accounts/:param', 'PUT', `/accounts/${id}`, { name: 'Renamed Mailbox' });
  assert.equal(edited.name, 'Renamed Mailbox');
  await answer('/accounts/:param/reconnect', 'POST', `/accounts/${id}/reconnect`);
  await answer('/accounts/:param/reindex', 'POST', `/accounts/${id}/reindex`);
  await answer('/accounts/:param/oauth-subject/reset', 'POST', `/accounts/${id}/oauth-subject/reset`);
  await answer('/accounts/:param/threading/preview', 'POST', `/accounts/${id}/threading/preview`, { mode: 'rfc' });
  await answer('/accounts/:param/threading/mode', 'POST', `/accounts/${id}/threading/mode`, { mode: 'rfc' });
  const alias = await answer('/accounts/:param/aliases', 'POST', `/accounts/${id}/aliases`, { name: 'Alt Name', email: 'alt@demo.mailexpert.local' });
  const aliasedEdit = await answer('/accounts/:param/aliases/:param', 'PUT', `/accounts/${id}/aliases/${alias.id}`, { name: 'Alt Renamed', email: alias.email });
  assert.equal(aliasedEdit.name, 'Alt Renamed');
  await answer('/accounts/:param/aliases/:param', 'DELETE', `/accounts/${id}/aliases/${alias.id}`);
  await answer('/accounts/:param', 'DELETE', `/accounts/${id}`);
});

test('mailbox and message-list actions answer with real ids', async () => {
  await answer('/mail/messages/bulk-read', 'POST', '/mail/messages/bulk-read', { ids: ['demo-006'], read: true });
  await answer('/mail/messages/bulk-star', 'POST', '/mail/messages/bulk-star', { ids: ['demo-006'], starred: true });
  await answer('/mail/messages/:param/star', 'PATCH', '/mail/messages/demo-006/star', { starred: true });
  await answer('/mail/mark-all-read', 'POST', '/mail/mark-all-read', { accountId: 'demo-ops', folder: 'Projects/Launch' });
  await answer('/mail/messages/bulk-move', 'POST', '/mail/messages/bulk-move', { ids: ['demo-007'], folder: 'Archive' });
  await answer('/mail/messages/bulk-archive', 'POST', '/mail/messages/bulk-archive', { ids: ['demo-004'] });
  await answer('/mail/messages/:param/spam', 'POST', '/mail/messages/demo-005/spam');
  await answer('/mail/messages/:param/ham', 'POST', '/mail/messages/demo-008/ham');
  await answer('/mail/messages/:param/snooze', 'POST', '/mail/messages/demo-009/snooze');
  const unsub = await answer('/mail/messages/:param/unsubscribe', 'POST', '/mail/messages/demo-003/unsubscribe');
  assert.equal(unsub.type, 'mailto');
  await answer('/mail/messages/:param/category', 'PATCH', '/mail/messages/demo-002/category', { category: 'primary' });
  await answer('/mail/messages/bulk-delete', 'POST', '/mail/messages/bulk-delete', { ids: ['demo-002'] });
  await answer('/mail/messages/:param', 'DELETE', '/mail/messages/demo-004');
});

test('drafts, sync and folder management answer', async () => {
  // Undo send and send later: a sent letter waits as a job; undo gives it back, a scheduled one moves.
  const queued = await demoRequest('POST', '/mail/send', { accountId: 'demo-sales', to: ['x@example.com'], subject: 'Coverage', body: 'Hi' });
  assert.equal(queued.scheduled, false);
  const undone = await answer('/mail/scheduled/:param/cancel', 'POST', `/mail/scheduled/${queued.jobId}/cancel`, { reason: 'undo' });
  assert.equal(undone.compose.subject, 'Coverage');
  const later = await demoRequest('POST', '/mail/send', {
    accountId: 'demo-sales', to: ['x@example.com'], subject: 'Later', body: 'Hi', sendAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  assert.equal(later.scheduled, true);
  const moved = await answer('/mail/scheduled/:param', 'PATCH', `/mail/scheduled/${later.jobId}`, { sendAt: new Date(Date.now() + 7200e3).toISOString() });
  assert.equal(moved.letter.id, later.jobId);
  const edited = await answer('/mail/scheduled/:param/cancel', 'POST', `/mail/scheduled/${later.jobId}/cancel`, { reason: 'edit' });
  assert.equal(edited.scheduled, true);
  await reject('/mail/scheduled/:param', 'PATCH', `/mail/scheduled/${queued.jobId}`, { sendAt: new Date(Date.now() - 1000).toISOString() }, /already passed/);
  const draft = await answer('/mail/draft', 'POST', '/mail/draft', { accountId: 'demo-sales', subject: 'Draft for coverage', body: 'Hello' });
  await answer('/mail/draft/:param', 'DELETE', `/mail/draft/${draft.uid}?accountId=demo-sales&folder=Drafts`);
  await answer('/mail/sync', 'POST', '/mail/sync', { accountId: 'demo-sales' });
  await answer('/mail/sync-folder', 'POST', '/mail/sync-folder', { accountId: 'demo-sales', folder: 'INBOX' });
  await answer('/mail/sync-folders', 'POST', '/mail/sync-folders', { accountId: 'demo-sales' });
  const folder = await answer('/mail/folders', 'POST', '/mail/folders', { accountId: 'demo-sales', name: 'Coverage' });
  const renamed = await answer('/mail/folders/rename', 'POST', '/mail/folders/rename', { accountId: 'demo-sales', oldPath: folder.path, newName: 'CoverageRenamed' });
  await answer('/mail/folders/empty', 'POST', '/mail/folders/empty', { accountId: 'demo-sales', path: renamed.newPath });
  await answer('/mail/folders/delete', 'POST', '/mail/folders/delete', { accountId: 'demo-sales', path: renamed.newPath });
});

test('diagnostics report answers a sanitized snapshot', async () => {
  const report = await answer('/diagnostics/report', 'POST', '/diagnostics/report', { salt: 'x' });
  assert.equal(typeof report.counts.unreadTotal, 'number');
});

test('integrations config round-trips per provider', async () => {
  await answer('/integrations/:param', 'POST', '/integrations/microsoft', { clientId: 'x' });
  await answer('/integrations/:param', 'DELETE', '/integrations/microsoft');
});

test('contacts CRUD answers (already covered functionally in demo/index.test.js; here for pattern coverage)', async () => {
  const contact = await answer('/contacts', 'POST', '/contacts', { displayName: 'Coverage Contact', emails: [{ value: 'coverage@example.com' }] });
  await answer('/contacts/:param', 'PATCH', `/contacts/${contact.id}`, { notes: 'updated' });
  await answer('/contacts/:param', 'DELETE', `/contacts/${contact.id}`);
});

test('inbox rules round-trip through in-memory state', async () => {
  const rule = await answer('/rules', 'POST', '/rules', { accountId: 'demo-sales', name: 'Coverage rule', conditions: [], actions: [] });
  await answer('/rules/:param', 'PUT', `/rules/${rule.id}`, { name: 'Renamed rule' });
  await answer('/rules/reorder', 'PATCH', '/rules/reorder', { ids: [rule.id] });
  await answer('/rules/run', 'POST', '/rules/run', { accountId: 'demo-sales' });
  await answer('/rules/:param', 'DELETE', `/rules/${rule.id}`);
});

test('block list round-trips through in-memory state', async () => {
  const entry = await answer('/block-list', 'POST', '/block-list', { accountId: 'demo-sales', emailAddress: 'blocked@example.com' });
  await answer('/block-list/:param', 'DELETE', `/block-list/${entry.id}`);
});

test('admin AI config round-trips; provider test/codex sign-in reject', async () => {
  await answer('/admin/ai', 'PATCH', '/admin/ai', { provider: 'openai', apiKey: 'sk-test' });
  await reject('/admin/ai/test', 'POST', '/admin/ai/test', {}, /demo mode/);
  await reject('/admin/ai/codex/device', 'POST', '/admin/ai/codex/device', {}, /demo mode/);
  await reject('/admin/ai/codex/device/poll', 'POST', '/admin/ai/codex/device/poll', { flowId: '11111111-1111-1111-1111-111111111111' }, /demo mode/);
  await answer('/admin/ai/codex/device', 'DELETE', '/admin/ai/codex/device');
  await answer('/admin/ai/codex', 'DELETE', '/admin/ai/codex');
  await answer('/admin/ai', 'DELETE', '/admin/ai');
});

test('the panel update reports a panel without an update mechanism; starting or checking rejects', async () => {
  const state = await demoRequest('GET', '/admin/update');
  assert.equal(state.updater.installed, false);
  assert.equal(state.updateAvailable, false);
  await reject('/admin/update/check', 'POST', '/admin/update/check', { target: 'sha-dddddddddddd' }, /demo mode/);
  await reject('/admin/update', 'POST', '/admin/update', { target: 'sha-dddddddddddd', confirm: 'sha-dddddddddddd' }, /demo mode/);
});

test('category sources round-trip; AI classification rejects', async () => {
  const source = await answer('/categories/sources', 'POST', '/categories/sources', { sourceType: 'manual', value: 'spam.example.com' });
  await answer('/categories/sources/:param', 'PATCH', `/categories/sources/${source.source.id}`, { enabled: false });
  await answer('/categories/sources/:param/refresh', 'POST', `/categories/sources/${source.source.id}/refresh`);
  await answer('/categories/sources/:param', 'DELETE', `/categories/sources/${source.source.id}`);
  await answer('/categories/recategorize/:param', 'POST', '/categories/recategorize/demo-sales');
  await reject('/categories/ai-classify/:param', 'POST', '/categories/ai-classify/demo-001', undefined, /demo mode/);
});

test('GTD classify/done/folders answer; pet import rejects', async () => {
  await answer('/gtd/classify', 'POST', '/gtd/classify', { messageId: 'demo-001', state: 'next' });
  await answer('/gtd/classify/undo', 'POST', '/gtd/classify/undo', { messageId: 'demo-001', state: 'next' });
  await answer('/gtd/classify', 'DELETE', '/gtd/classify', { messageId: 'demo-001', state: 'next' });
  await answer('/gtd/done', 'POST', '/gtd/done', { id: 'demo-006', states: ['next'] });
  await answer('/gtd/folders/ensure', 'POST', '/gtd/folders/ensure', { accountId: 'demo-sales', folders: ['GTD/Next'] });
  await reject('/gtd/pet/import', 'POST', '/gtd/pet/import', {}, /demo mode/);
});

test('the panel-wide plugin switch answers; Todoist connect/tasks reject', async () => {
  const plugin = await answer('/plugins/:param', 'PATCH', '/plugins/gtd', { enabled: false });
  assert.equal(plugin.enabled, false);
  const list = await answer('/plugins', 'GET', '/plugins');
  assert.equal(list.find(p => p.id === 'gtd').enabled, false);
  await answer('/plugins/:param', 'PATCH', '/plugins/gtd', { enabled: true });
  await reject('/todoist/connect', 'POST', '/todoist/connect', { token: 'x' }, /demo mode/);
  await answer('/todoist/disconnect', 'DELETE', '/todoist/disconnect');
  await reject('/todoist/tasks', 'POST', '/todoist/tasks', {}, /demo mode/);
});

test('already-handled writes from part 1 of the demo-settings fix still answer', async () => {
  await answer('/auth/preferences', 'PATCH', '/auth/preferences', { theme: 'dark' });
  await answer('/oauth/microsoft/device', 'POST', '/oauth/microsoft/device');
  await answer('/admin/settings', 'PATCH', '/admin/settings', { registration_open: true });
  await answer('/admin/access-sync', 'PUT', '/admin/access-sync', { enabled: false });
  await answer('/admin/access-sync/run', 'POST', '/admin/access-sync/run');
  await answer('/mail-node/config', 'PUT', '/mail-node/config', {});
  await answer('/mail-node/domains', 'POST', '/mail-node/domains', { domain: 'coverage.demo.mailexpert.local' });
  const step = await answer('/mail-node/domains/:param/steps/:param', 'POST', '/mail-node/domains/coverage.demo.mailexpert.local/steps/node_configured');
  assert.equal(step.state, 'node_configured');
  const ready = await answer('/mail-node/domains/:param/ready', 'POST', '/mail-node/domains/coverage.demo.mailexpert.local/ready');
  assert.equal(ready.state, 'ready');
  const adopted = await answer('/mail-node/domains/:param/adopt', 'POST', '/mail-node/domains/legacy.demo.mailexpert.local/adopt');
  assert.equal(adopted.state, 'node_created');
  const acknowledged = await answer('/mail-node/domains/:param/acknowledge', 'POST', '/mail-node/domains/branch.demo.mailexpert.local/acknowledge', { created: demoNodeTime('2026-09-29 16:40:00') });
  assert.equal(acknowledged.state, 'ready');
  const scheduled = await answer('/accounts/:param/deletion', 'POST', '/accounts/demo-fx-44/deletion', {
    email: 'compliance@example.org', reason: 'Coverage run',
  });
  assert.ok(scheduled.delete_after);
  const cancelled = await answer('/accounts/:param/deletion', 'DELETE', '/accounts/demo-fx-44/deletion');
  assert.equal(cancelled.delete_after, null);
  const restarted = await answer('/mail-node/domains/:param/restart', 'POST', '/mail-node/domains/coverage.demo.mailexpert.local/restart');
  assert.equal(restarted.state, 'node_created');
  const eop = await answer('/mail-node/eop', 'PUT', '/mail-node/eop', { terrl: '48248' });
  assert.equal(eop.terrl, 48248);
  const mailboxes = await demoRequest('GET', '/mail-node/mailboxes');
  if (mailboxes.mailboxes[0]) {
    await answer('/mail-node/mailboxes/:param/quota', 'PUT', `/mail-node/mailboxes/${mailboxes.mailboxes[0].accountId}/quota`, { quotaMb: 8192 });
  } else {
    coveredWritePatterns.add('PUT /mail-node/mailboxes/:param/quota'); // no fixture mailbox this run; shape already covered in demo/index.test.js
  }
  if (mailboxes.mailboxes[0]) {
    const limit = await answer('/mail-node/mailboxes/:param/rate-limit', 'PUT', `/mail-node/mailboxes/${mailboxes.mailboxes[0].accountId}/rate-limit`, { value: 20, frame: 'h' });
    assert.deepEqual(limit.rateLimitOverride, { value: 20, frame: 'h' });
  } else {
    coveredWritePatterns.add('PUT /mail-node/mailboxes/:param/rate-limit'); // no fixture mailbox this run; shape already covered in demo/index.test.js
  }
  const node = await answer('/mail-node/apply', 'POST', '/mail-node/apply');
  assert.ok(Array.isArray(node.node) && Array.isArray(node.domains));
  const domainApply = await answer('/mail-node/domains/:param/apply', 'POST', '/mail-node/domains/coverage.demo.mailexpert.local/apply', { confirmDkimDelete: false });
  assert.equal(domainApply.domain, 'coverage.demo.mailexpert.local');
  const prefilter = await answer('/mail-node/apply/prefilter', 'POST', '/mail-node/apply/prefilter');
  assert.equal(prefilter.item, 'prefilter');
  const dnsAll = await answer('/mail-node/dns-check', 'POST', '/mail-node/dns-check');
  assert.equal(dnsAll.started, true);
  const dnsDomain = await answer('/mail-node/domains/:param/dns-check', 'POST', '/mail-node/domains/coverage.demo.mailexpert.local/dns-check');
  assert.equal(dnsDomain.domain, 'coverage.demo.mailexpert.local');
  const expected = await answer('/mail-node/domains/:param/dns-expected', 'PUT', '/mail-node/domains/coverage.demo.mailexpert.local/dns-expected', { expectedMx: 'coverage-demo.mail.protection.outlook.com' });
  assert.deepEqual(expected.fields, ['mx']);
  const released = await answer('/mail-node/quarantine/:param/release', 'POST', '/mail-node/quarantine/40/release');
  assert.equal(released.learned, true);
  assert.deepEqual(await answer('/mail-node/quarantine/:param', 'DELETE', '/mail-node/quarantine/38'), { ok: true });
  const learned = await answer('/mail-node/quarantine/:param/learn-spam', 'POST', '/mail-node/quarantine/41/learn-spam');
  assert.equal(learned.ok, true);
  const nodeSettings = await answer('/mail-node/quarantine/node-settings', 'POST', '/mail-node/quarantine/node-settings', { confirm: true });
  assert.equal(nodeSettings.nodeSettings.release_format, 'raw');
  assert.ok(nodeSettings.nodeSettingsAppliedAt);
  const quarantineSettings = await answer('/mail-node/quarantine/settings', 'PUT', '/mail-node/quarantine/settings', { userView: false });
  assert.equal(quarantineSettings.userView, false);
  await answer('/oauth/google/start', 'POST', '/oauth/google/start', { email: `coverage-${Date.now()}@gmail.com` });
});

test('the node operations answer: queue actions, alerts, budget', async () => {
  const queue = await demoRequest('GET', '/mail-node/queue');
  const held = queue.items.find(item => item.queue === 'hold');
  await reject('/mail-node/queue/:param/:param', 'POST', `/mail-node/queue/${held.queueId}/deliver`, {}, /released first/);
  const released = await answer('/mail-node/queue/:param/:param', 'POST', `/mail-node/queue/${held.queueId}/unhold`);
  assert.equal(released.action, 'unhold');
  await reject('/mail-node/queue/:param/:param', 'POST', `/mail-node/queue/${held.queueId}/delete`, {}, /confirmed/);
  await answer('/mail-node/queue/:param/:param', 'POST', `/mail-node/queue/${held.queueId}/delete`, { confirm: true });
  assert.ok(!(await demoRequest('GET', '/mail-node/queue')).items.some(item => item.queueId === held.queueId));
  const flushed = await answer('/mail-node/queue/flush', 'POST', '/mail-node/queue/flush');
  assert.equal(flushed.action, 'flush');
  const checked = await answer('/mail-node/alerts/check', 'POST', '/mail-node/alerts/check');
  assert.ok(Array.isArray(checked.state.alerts));
  const saved = await answer('/mail-node/alerts/settings', 'PUT', '/mail-node/alerts/settings', { pingUrl: 'https://hc.example.com/p/alerts', deferredCount: 5, deferredMinutes: 30 });
  assert.equal(saved.settings.deferredMinutes, 30);
  await reject('/mail-node/alerts/settings', 'PUT', '/mail-node/alerts/settings', { pingUrl: 'http://insecure.example' }, /https/);
});

test('the outage windows answer: by hand, closed, changed, deleted, the trace, the retention (R-43)', async () => {
  await reject('/mail-node/outages', 'POST', '/mail-node/outages', { startedAt: '2026-10-01T10:00:00Z' }, /reason/);
  const added = await answer('/mail-node/outages', 'POST', '/mail-node/outages', { startedAt: '2026-10-01T10:00:00Z', reason: 'Planned maintenance', planned: true });
  assert.equal(added.window.open, true);
  const changed = await answer('/mail-node/outages/:param', 'PUT', `/mail-node/outages/${added.window.id}`, { startedAt: '2026-10-01T09:50:00Z', reason: 'Began earlier' });
  assert.equal(changed.window.startedAt, '2026-10-01T09:50:00.000Z');
  const closed = await answer('/mail-node/outages/:param/close', 'POST', `/mail-node/outages/${added.window.id}/close`, { endedAt: '2026-10-01T11:00:00Z', reason: 'Back' });
  assert.equal(closed.window.open, false);
  await reject('/mail-node/outages/:param', 'DELETE', `/mail-node/outages/${added.window.id}`, { confirm: true }, /reason/);
  assert.deepEqual(await answer('/mail-node/outages/:param', 'DELETE', `/mail-node/outages/${added.window.id}`, { confirm: true, reason: 'Marked twice' }), { ok: true });
  const traced = await answer('/mail-node/outages/trace', 'POST', '/mail-node/outages/trace');
  assert.equal(traced.connected, true);
  const settings = await answer('/mail-node/outage-settings', 'PUT', '/mail-node/outage-settings', { retentionDays: 14 });
  assert.equal(settings.settings.retentionDays, 14);
  await reject('/mail-node/outage-settings', 'PUT', '/mail-node/outage-settings', { retentionDays: 0 }, /1 to 90/);
});

test('the Microsoft tenant answers: test, poll and the anti-spam policy finish at once (stage 7a)', async () => {
  const tested = await answer('/mail-node/tenant/test', 'POST', '/mail-node/tenant/test');
  assert.equal(tested.job.status, 'done');
  const polled = await answer('/mail-node/tenant/poll', 'POST', '/mail-node/tenant/poll');
  assert.equal(polled.job.kind, 'tenant_poll');
  const read = await answer('/mail-node/tenant/antispam', 'POST', '/mail-node/tenant/antispam');
  assert.equal(read.job.kind, 'tenant_antispam_read');
  const tenant = await demoRequest('GET', '/mail-node/tenant');
  assert.equal(tenant.driver, 'fake');
  assert.equal(tenant.state.connection.ok, true);
  // Section 5.14: the demo's poll set phishing to MoveToJmf, as the backend does; nothing conflicts.
  assert.deepEqual(tenant.state.antispam.conflicts, []);
  assert.equal(tenant.state.antispam.policy.PhishSpamAction, 'MoveToJmf');
  assert.equal(tenant.state.antispam.enforcement.ok, true);
  assert.equal((await demoRequest('GET', `/mail-node/tenant/jobs/${tested.job.id}`)).job.id, tested.job.id);
  // Stage 7b: one domain's tenant steps and the connector reference.
  const synced = await answer('/mail-node/tenant/domains/:param/sync', 'POST', '/mail-node/tenant/domains/demo.mailexpert.local/sync');
  assert.equal(synced.job.kind, 'tenant_domain_sync');
  const reference = await answer('/mail-node/tenant/connectors/reference', 'POST', '/mail-node/tenant/connectors/reference');
  assert.equal(reference.reference.auto, false);
  assert.deepEqual((await demoRequest('GET', '/mail-node/tenant')).connectorDrift, []);
  const held = await answer('/mail-node/tenant/domains/:param/hold', 'POST', '/mail-node/tenant/domains/demo.mailexpert.local/hold', { hold: false });
  assert.equal(held.holdInternalRelay, true);
  await reject('/mail-node/tenant/domains/:param/internal-relay', 'POST', '/mail-node/tenant/domains/demo.mailexpert.local/internal-relay', {}, /does not wait/);
  await reject('/mail-node/tenant/domains/:param/alias-contacts/remove', 'POST', '/mail-node/tenant/domains/demo.mailexpert.local/alias-contacts/remove', {}, /no alias contacts/);
  // Stage 7c: the spam and phishing release (R-42, section 5.14) and a letter's trace (R-30).
  // On as on a new install; "Release now" is refused while it is off.
  const release = await demoRequest('GET', '/mail-node/tenant/phish-release');
  assert.equal(release.enabled, true);
  // The earlier run had no spam rule on the node: high confidence phishing only, the spam waits.
  assert.equal(release.run.rule.state, 'missing');
  assert.equal(release.run.counts.ruleWaiting, 1);
  assert.deepEqual([...new Set(release.releases.map(r => r.type))], ['HighConfPhish']);
  // The rule was applied above (/mail-node/apply/prefilter): the next run releases the spam.
  const ran = await answer('/mail-node/tenant/phish-release/run', 'POST', '/mail-node/tenant/phish-release/run');
  assert.equal(ran.job.kind, 'tenant_quarantine_release');
  const after = await demoRequest('GET', '/mail-node/tenant/phish-release');
  assert.equal(after.run.rule.state, 'ok');
  assert.equal(after.run.counts.ruleWaiting, 0);
  assert.equal(after.releases.find(r => r.type === 'Spam')?.state, 'released');
  const off = await answer('/mail-node/tenant/phish-release', 'PUT', '/mail-node/tenant/phish-release', { enabled: false });
  assert.equal(off.enabled, false);
  await reject('/mail-node/tenant/phish-release/run', 'POST', '/mail-node/tenant/phish-release/run', {}, /paused/);
  await answer('/mail-node/tenant/phish-release', 'PUT', '/mail-node/tenant/phish-release', { enabled: true });
  await reject('/mail/messages/:param/eop-trace', 'POST', '/mail/messages/demo-001/eop-trace', {}, /this mailbox sent/);
});

test('the node agent: a token shown once, a backup job that finishes, a revocation', async () => {
  const before = await demoRequest('GET', '/mail-node/agent');
  assert.equal(before.connected, true);
  assert.equal(before.status.backup.ok, true);
  const issued = await answer('/mail-node/agent/token', 'POST', '/mail-node/agent/token');
  assert.match(issued.token, /^mxna_/);
  assert.equal(issued.rotated, true);
  const queued = await answer('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'backup' });
  assert.equal(queued.job.kind, 'backup');
  await reject('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'backup' }, /already waiting or running/);
  const revoked = await answer('/mail-node/agent/token', 'DELETE', '/mail-node/agent/token');
  assert.equal(revoked.revoked, true);
  const after = await demoRequest('GET', '/mail-node/agent');
  assert.equal(after.configured, false);
  assert.equal(after.jobs[0].error, 'agent_revoked');
  await reject('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'backup' }, /not connected/);
  await answer('/mail-node/agent/token', 'POST', '/mail-node/agent/token');
});

test('the node update: the panel commit, one job at a time, the node part on the panel update', async () => {
  const before = await demoRequest('GET', '/mail-node/agent');
  assert.match(before.panelCommit, /^[0-9a-f]{40}$/);
  // mailcow: the node behind the version the release pins, which the update brings it to.
  assert.equal(before.pinnedMailcow.tag, '2026-09a');
  assert.equal(before.status.mailcowRelation, 'behind');
  const queued = await answer('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'update' });
  assert.equal(queued.job.kind, 'update');
  assert.equal(queued.job.params.sha, before.panelCommit);
  await reject('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'backup' }, /already waiting or running/);
  await reject('/mail-node/agent/jobs', 'POST', '/mail-node/agent/jobs', { kind: 'update' }, /already waiting or running/);
  const panel = await demoRequest('GET', '/admin/update');
  assert.equal(panel.node.configured, true);
  assert.equal(panel.node.job.kind, 'update');
  assert.deepEqual(panel.node.pinnedMailcow, before.pinnedMailcow);
  assert.equal(panel.node.mailcow.tag, '2026-09');
});

test('every write path pattern api.js can call was exercised above, answered or rejected', async () => {
  const source = fs.readFileSync(API_PATH, 'utf8');
  const patterns = extractPatterns(source, ['POST', 'PUT', 'PATCH', 'DELETE']);
  assert.ok(patterns.size > 100, 'sanity check: the extractor should find over a hundred write call sites in api.js');

  const missing = [...patterns].filter(p => !coveredWritePatterns.has(p));
  assert.deepEqual(
    missing, [],
    `add a demo answer or a rejection (with reason) above for: ${missing.join(', ')}`,
  );
});

test('an unhandled write in demo mode rejects instead of returning a fake success', async () => {
  // Writes used to fall back to a fake { ok: true, demo: true } here; that fallback is gone too
  // now, so a write with no demo support fails loudly instead of a caller silently crashing on
  // a field it expected off the response.
  await assert.rejects(
    () => demoRequest('POST', '/some/made-up/write'),
    /Not available in demo mode/,
  );
});
