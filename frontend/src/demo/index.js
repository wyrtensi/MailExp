import { fleetAccounts, fleetDomains, fleetLetters } from './fleet.js';
import { demoRole } from '../utils/demoRole.js';
import { DOMAIN_STATES, MAILBOX_READY_STATES, canMarkReady, normalizeEopSettings } from '../utils/mailNode.js';

const ACCOUNT_FIXTURES = [
  {
    id: 'demo-sales',
    name: 'Sales Team',
    sender_name: 'MailExpert Sales',
    email_address: 'sales@demo.mailexpert.local',
    imap_host: 'imap.demo.mailexpert.local', imap_port: 993, smtp_host: 'smtp.demo.mailexpert.local', smtp_port: 587, smtp_tls: 'STARTTLS',
    color: '#7c3aed',
    protocol: 'imap',
    enabled: true,
    include_in_unified_inbox: true,
    sort_order: 0,
    folder_mappings: { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' },
    signature: '<p>MailExpert Sales</p>',
    categorization_enabled: true,
    health: 'healthy',
    aliases: [],
  },
  {
    id: 'demo-ops',
    name: 'Operations',
    sender_name: 'MailExpert Operations',
    email_address: 'ops@demo.mailexpert.local',
    imap_host: 'imap.demo.mailexpert.local', imap_port: 993, smtp_host: 'smtp.demo.mailexpert.local', smtp_port: 587, smtp_tls: 'STARTTLS',
    color: '#0891b2',
    protocol: 'imap',
    enabled: true,
    include_in_unified_inbox: true,
    sort_order: 1,
    folder_mappings: { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' },
    signature: '<p>MailExpert Operations</p>',
    categorization_enabled: true,
    health: 'healthy',
    aliases: [],
  },
];
// 48 generated mailboxes (demo/fleet.js) after the two hand-made ones: 50 in all.
const FLEET_ACCOUNTS = fleetAccounts();
ACCOUNT_FIXTURES.push(...FLEET_ACCOUNTS);

const FOLDER_FIXTURES = [
  { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
  { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
  { path: 'Archive', name: 'Archive', special_use: '\\Archive' },
  { path: 'Spam', name: 'Spam', special_use: '\\Junk' },
  { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
  { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
  { path: 'Projects/Launch', name: 'Launch', special_use: null },
];

// Recipients as the server stores them: { name, email } objects. Fixtures and compose payloads
// give plain addresses.
const recipients = list => (list || []).map(entry => (typeof entry === 'string' ? { name: '', email: entry } : entry));

function message({
  id,
  accountId,
  folder = 'INBOX',
  subject,
  fromName,
  fromEmail,
  date,
  snippet,
  read = false,
  starred = false,
  attachments = false,
  category = 'primary',
  threadId = id,
  toAddresses,
  ccAddresses = [],
  bodyText = snippet,
  // Generated letters carry their own headers and threading (demo/fleet.js); the hand-made
  // ones below leave these out and read through THREADING_OVERRIDES instead.
  messageId,
  inReplyTo,
  references,
  reason,
  providerThreadId,
  providerMessageId,
}) {
  const account = ACCOUNT_FIXTURES.find(item => item.id === accountId);
  const row = {
    id,
    uid: Number(id.replace(/\D/g, '')) || 1,
    message_id: messageId || `<${id}@demo.mailexpert.local>`,
    thread_id: threadId,
    // Same as the stored column: COALESCE(thread_id, id).
    thread_key: threadId ?? id,
    account_id: account.id,
    account_name: account.name,
    account_email: account.email_address,
    account_color: account.color,
    folder,
    subject,
    from_name: fromName,
    from_email: fromEmail,
    to_addresses: recipients(toAddresses || [account.email_address]),
    cc_addresses: recipients(ccAddresses),
    date,
    snippet,
    is_read: read,
    is_starred: starred,
    has_attachments: attachments,
    category,
    body_html: `<p>${bodyText}</p>`,
    body_text: bodyText,
  };
  if (reason !== undefined) {
    Object.assign(row, {
      in_reply_to: inReplyTo ?? null,
      thread_references: references ?? [],
      threading_reason: reason,
      provider_thread_id: providerThreadId ?? null,
      provider_message_id: providerMessageId ?? null,
    });
  }
  return row;
}

const MESSAGE_FIXTURES = [
  message({
    id: 'demo-001', accountId: 'demo-sales', subject: 'Enterprise renewal approved',
    fromName: 'Maya Chen', fromEmail: 'maya@northstar.example', date: '2026-09-16T08:45:00.000Z',
    snippet: 'The renewal is approved. Please send the final order form.',
    bodyText: 'Great news — our procurement team approved the renewal. Please send the final order form for signature.',
    starred: true, attachments: true, threadId: 'demo-renewal',
  }),
  message({
    id: 'demo-002', accountId: 'demo-ops', subject: 'Incident review: queue latency',
    fromName: 'Noah Williams', fromEmail: 'noah@demo.mailexpert.local', date: '2026-09-16T07:20:00.000Z',
    snippet: 'The post-incident review is ready for comments.',
    bodyText: 'The post-incident review is ready. Please add comments before tomorrow morning.', category: 'automated',
  }),
  message({
    id: 'demo-003', accountId: 'demo-sales', subject: 'September product brief',
    fromName: 'Aster Product News', fromEmail: 'newsletter@aster.example', date: '2026-09-15T16:10:00.000Z',
    snippet: 'A faster workspace, smarter triage, and what is coming next.',
    bodyText: 'This month: a faster workspace, smarter triage, and a preview of what is coming next.', category: 'newsletter',
  }),
  message({
    id: 'demo-004', accountId: 'demo-ops', subject: 'Re: Vendor access checklist',
    fromName: 'Priya Shah', fromEmail: 'priya@vendor.example', date: '2026-09-15T12:30:00.000Z',
    snippet: 'All requested access details are attached.',
    bodyText: 'All requested access details are attached. Let me know if security needs anything else.', read: true, attachments: true,
    threadId: 'demo-vendor-access',
  }),
  message({
    id: 'demo-005', accountId: 'demo-sales', folder: 'Sent', subject: 'Re: Enterprise renewal approved',
    fromName: 'MailExpert Sales', fromEmail: 'sales@demo.mailexpert.local', date: '2026-09-15T09:00:00.000Z',
    snippet: 'Thanks, Maya. The order form is attached.', bodyText: 'Thanks, Maya. The order form is attached for signature.',
    read: true, attachments: true, threadId: 'demo-renewal', toAddresses: ['maya@northstar.example'],
  }),
  message({
    id: 'demo-006', accountId: 'demo-ops', folder: 'Projects/Launch', subject: 'Launch runbook v3',
    fromName: 'Lucas Martin', fromEmail: 'lucas@demo.mailexpert.local', date: '2026-09-14T18:25:00.000Z',
    snippet: 'Updated owners and rollback steps are now in the runbook.',
    bodyText: 'I updated the owners, checkpoints, and rollback steps in the launch runbook.', read: true,
  }),
  message({
    id: 'demo-007', accountId: 'demo-sales', folder: 'Archive', subject: 'Q3 pipeline review notes',
    fromName: 'Elena Rossi', fromEmail: 'elena@demo.mailexpert.local', date: '2026-09-13T11:40:00.000Z',
    snippet: 'Notes and follow-ups from the pipeline review.', bodyText: 'Here are the notes and follow-ups from our Q3 pipeline review.', read: true,
  }),
  message({
    id: 'demo-008', accountId: 'demo-ops', folder: 'Spam', subject: 'You have won a cloud server',
    fromName: 'Cloud Prize Desk', fromEmail: 'winner@suspicious.example', date: '2026-09-12T05:15:00.000Z',
    snippet: 'Claim your prize immediately.', bodyText: 'Claim your prize immediately by following this suspicious link.', category: 'promotion',
  }),
  message({
    id: 'demo-009', accountId: 'demo-sales', folder: 'Trash', subject: 'Old conference invitation',
    fromName: 'Events Team', fromEmail: 'events@conference.example', date: '2026-09-10T14:00:00.000Z',
    snippet: 'Your invitation for the summer conference.', bodyText: 'Your invitation for the summer conference is enclosed.', read: true,
  }),
  ...fleetLetters(FLEET_ACCOUNTS).map(message),
];

const CONTACT_FIXTURES = [
  {
    id: 'demo-contact-1', uid: 'demo-contact-1', display_name: 'Maya Chen', first_name: 'Maya', last_name: 'Chen',
    primary_email: 'maya.chen@northstar.example',
    emails: [{ value: 'maya.chen@northstar.example', type: 'work', primary: true }],
    phones: [{ value: '+1 555 0142', type: 'work', primary: true }],
    urls: [{ value: 'https://northstar.example', type: 'work' }],
    organization: 'Northstar', notes: 'Enterprise renewal contact', is_auto: false, send_count: 8,
    last_sent: '2026-09-15T15:42:00.000Z', etag: 'demo-contact-1-v1', created_at: '2026-08-20T09:00:00.000Z',
    updated_at: '2026-09-15T15:42:00.000Z', has_contact_photo: false,
  },
  {
    id: 'demo-contact-2', uid: 'demo-contact-2', display_name: 'Priya Shah', first_name: 'Priya', last_name: 'Shah',
    primary_email: 'priya@vendor.example',
    emails: [{ value: 'priya@vendor.example', type: 'work', primary: true }],
    phones: [{ value: '+1 555 0102', type: 'work', primary: true }],
    organization: 'Vendor Works', notes: '', is_auto: false, send_count: 5, last_sent: null,
    etag: 'demo-contact-2-v1', created_at: '2026-08-25T09:00:00.000Z', updated_at: '2026-09-12T09:00:00.000Z',
    has_contact_photo: false,
  },
  {
    id: 'demo-contact-3', uid: 'demo-contact-3', display_name: 'Lucas Martin', first_name: 'Lucas', last_name: 'Martin',
    primary_email: 'lucas@demo.mailexpert.local',
    emails: [{ value: 'lucas@demo.mailexpert.local', type: 'work', primary: true }], phones: [],
    organization: 'MailExpert', notes: '', is_auto: true, send_count: 3, last_sent: null,
    etag: 'demo-contact-3-v1', created_at: '2026-09-01T09:00:00.000Z', updated_at: '2026-09-14T18:25:00.000Z',
    has_contact_photo: false,
  },
];

// The demo signs in as the administrator, or as an ordinary user (utils/demoRole.js) so the owner
// can see what a manager without admin rights sees.
const DEMO_PLAIN_USER = {
  id: 'demo-colleague',
  username: 'colleague@demo.mailexpert.local',
  email: 'colleague@demo.mailexpert.local',
  authMode: 'local',
  displayName: 'Demo User',
  avatar: null,
  isAdmin: false,
  totpEnabled: false,
  hasPassword: false,
  hasLockPin: false,
  locked: false,
};

const DEMO_USER = {
  id: 'demo-user',
  username: 'demo@mailexpert.local',
  email: 'demo@mailexpert.local',
  authMode: 'local',
  displayName: 'Demo Administrator',
  avatar: null,
  isAdmin: true,
  totpEnabled: false,
  hasPassword: false,
  hasLockPin: false,
  locked: false,
};

// Audit entries for the admin journal screen, newest first. Times are fixed so the demo reads
// the same on every load.
const AUDIT_FIXTURES = [
  {
    id: '9', occurredAt: '2026-09-18T11:20:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: null, accountEmail: null, action: 'mail_node.domain_state_changed',
    details: { domain: 'pilot.demo.mailexpert.local', from: 'node_configured', to: 'dns_ok', how: 'step_confirmed' },
  },
  {
    id: '8', occurredAt: '2026-09-18T09:00:00.000Z', actorUserId: null, actorEmail: 'MailExpert',
    accountId: null, accountEmail: null, action: 'mail_node.domain_adopted',
    details: { domain: 'demo.mailexpert.local', state: 'ready', origin: 'existing_mailboxes' },
  },
  {
    id: '7', occurredAt: '2026-09-17T10:05:00.000Z', actorUserId: null, actorEmail: 'Cloudflare Access',
    accountId: null, accountEmail: null, action: 'access.sync_aborted',
    details: { candidates: ['colleague@demo.mailexpert.local', 'former@demo.mailexpert.local'], activeUsers: 3, maxDisables: 10 },
  },
  {
    id: '6', occurredAt: '2026-09-17T09:40:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.deleted',
    details: { messageId: '<demo-archive@demo.mailexpert.local>', folder: 'INBOX', from: 'newsletter@example.com', permanent: false },
  },
  {
    id: '5', occurredAt: '2026-09-17T09:15:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.sent',
    details: { messageId: '<demo-reply@demo.mailexpert.local>', to: ['buyer@example.com'], cc: [], bcc: [] },
  },
  {
    id: '4', occurredAt: '2026-09-16T16:05:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.connection_changed',
    details: { fields: ['smtp_port'] },
  },
  {
    id: '3', occurredAt: '2026-09-16T12:30:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: null, accountEmail: null, action: 'user.added',
    details: { userId: 'demo-colleague', email: 'colleague@demo.mailexpert.local', isAdmin: false },
  },
  {
    id: '2', occurredAt: '2026-09-15T10:00:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
  {
    id: '1', occurredAt: '2026-09-15T09:55:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
];

// Cloudflare Access sync settings as an admin sees them. The ids are made up.
const ACCESS_SYNC_FIXTURE = {
  config: {
    enabled: true,
    accountId: '0123456789abcdef0123456789abcdef',
    appId: '11111111-2222-4333-8444-555555555555',
    policyId: '66666666-7777-4888-9999-000000000000',
    apiTokenSet: true,
  },
  lastRun: {
    trigger: 'schedule', startedAt: '2026-09-17T09:00:00.000Z', finishedAt: '2026-09-17T09:00:01.000Z',
    outcome: 'updated', added: 1, removed: 0, disabled: 0, wouldDisable: 0, error: null,
  },
  maxDisables: 10,
  googleMode: true,
};

const DEFAULT_PREFERENCES = {
  theme: 'daylight',
  themeFollowsSystem: true,
  language: 'en',
  pageSize: 50,
  threadedView: true,
  categorizationEnabled: true,
  blockRemoteImages: false,
  aiActions: [],
};

// User admin list (GET /admin/users), same shape as publicUser() in backend/src/routes/admin.js —
// not the /auth/me shape above (DEMO_USER/DEMO_PLAIN_USER), which carries different fields.
const ADMIN_USER_FIXTURES = [
  {
    id: 'demo-user', username: 'demo@mailexpert.local', email: 'demo@mailexpert.local',
    isAdmin: true, totpEnabled: false, disabledAt: null, created_at: '2026-08-01T09:00:00.000Z',
    isBootstrapAdmin: true,
  },
  {
    id: 'demo-colleague', username: 'colleague@demo.mailexpert.local', email: 'colleague@demo.mailexpert.local',
    isAdmin: false, totpEnabled: false, disabledAt: null, created_at: '2026-08-10T09:00:00.000Z',
    isBootstrapAdmin: false,
  },
];

// Sign-in history (GET /admin/auth-events), same columns the server selects.
const AUTH_EVENT_FIXTURES = [
  { id: '3', event_type: 'login', username: 'demo@mailexpert.local', user_id: 'demo-user', ip: '203.0.113.10', success: true, created_at: '2026-09-17T08:05:00.000Z' },
  { id: '2', event_type: 'login', username: 'colleague@demo.mailexpert.local', user_id: 'demo-colleague', ip: '203.0.113.24', success: true, created_at: '2026-09-16T14:22:00.000Z' },
  { id: '1', event_type: 'login_failed', username: 'demo@mailexpert.local', user_id: null, ip: '198.51.100.7', success: false, created_at: '2026-09-15T21:40:00.000Z' },
];

// System settings (GET/PATCH /admin/settings). Values are strings, as system_settings stores
// them and every reader compares with === 'true'.
let systemSettings = {
  registration_open: 'false',
  internal_auth_disabled: 'false',
  allow_private_hosts: 'false',
  allow_insecure_tls: 'false',
  allow_nonstandard_ports: 'false',
  mfa_enforcement: 'off',
  mfa_device_trust: '30d',
  auth_max_attempts: '5',
  auth_window_minutes: '15',
  custom_css: '',
};

// A fixed base32 secret and a tiny placeholder QR so the setup screen renders without a real
// authenticator flow — scanning it would not work in the demo, same as everything else here.
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DEMO_TOTP_QR_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

// A category reads as "bulk" the way messageService's is_bulk column would flag it: a
// newsletter, a promotion, or an automated notice — never primary mail.
const BULK_CATEGORIES = new Set(['newsletter', 'promotion', 'automated']);
const CLEANUP_KEYWORDS = ['% off', 'deal', 'sale', 'newsletter', 'coupon', 'webinar', 'last chance'];

function mailboxUsageFor(accountId) {
  const inbox = messages.filter(item => item.account_id === accountId && item.folder === 'INBOX');
  const bulk = inbox.filter(item => BULK_CATEGORIES.has(item.category));
  const bySender = new Map();
  for (const item of bulk) {
    const key = normalizeEmail(item.from_email);
    if (!bySender.has(key)) bySender.set(key, { fromEmail: item.from_email, fromName: item.from_name || '', count: 0 });
    bySender.get(key).count += 1;
  }
  const tier1Senders = [...bySender.values()].sort((a, b) => b.count - a.count).slice(0, 25);
  const tier2Keywords = CLEANUP_KEYWORDS.map(keyword => ({
    keyword,
    count: inbox.filter(item => `${item.subject} ${item.snippet}`.toLocaleLowerCase().includes(keyword)).length,
  }));
  return {
    accountId, inboxTotal: inbox.length, bulkTotal: bulk.length, archiveAvailable: true,
    tier1Senders, tier2Keywords,
  };
}

function cleanupPreviewFor(accountId, fromEmail) {
  const target = normalizeEmail(fromEmail);
  const ids = messages
    .filter(item => item.account_id === accountId && item.folder === 'INBOX'
      && BULK_CATEGORIES.has(item.category) && normalizeEmail(item.from_email) === target)
    .map(item => item.id);
  return { accountId, fromEmail: String(fromEmail || '').trim(), count: ids.length, ids };
}

let messages = structuredClone(MESSAGE_FIXTURES);
let contacts = structuredClone(CONTACT_FIXTURES);
let preferences = structuredClone(DEFAULT_PREFERENCES);
let nextDraftUid = 1000;
let nextMessageSequence = 10;
let accessSync = structuredClone(ACCESS_SYNC_FIXTURE);

// ── Mutable state for write endpoints (Part 2 of the demo-settings fix): every write below
// either answers in the real backend's shape, updating one of these so the matching GET (or a
// re-mount) reads the change back, or is left unhandled on purpose and rejects through the
// catch-all at the end of demoRequest — see routeCoverage.test.js's REJECTED table for which and
// why. Rejecting (never a fake `{ ok: true, demo: true }`) applies to writes now too.
let adminUsers = structuredClone(ADMIN_USER_FIXTURES);
let demoInvites = [];
let demoGoogleApps = [];
let demoOidcProviders = [];
let systemEmailConfig = null;
let integrationsConfig = {};
let aiConfig = null;
let demoRules = [];
let demoBlockList = [];
let categorySources = [];
let pluginsState = [{ id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1, activated: true }];
// accountId -> extra FOLDER_FIXTURES-shaped rows created via POST /mail/folders.
let extraFolders = {};
let recoveryEmailValue = null;
let demoTotpEnabled = false;
// Applied on top of whichever of DEMO_USER/DEMO_PLAIN_USER is active, by PATCH /auth/profile and
// the avatar endpoints — one signed-in identity per browser, so this doesn't need to be per-role.
let profileOverrides = {};
let nextInviteSequence = 1;
let nextGoogleAppSequence = 1;
let nextOidcSequence = 1;
let nextRuleSequence = 1;
let nextBlockListSequence = 1;
let nextAliasSequence = 1;
let nextCategorySourceSequence = 1;

function clone(value) {
  return structuredClone(value);
}

function parsePath(path) {
  return new URL(path, 'https://demo.mailexpert.local');
}

function accountFor(id) {
  return ACCOUNT_FIXTURES.find(account => account.id === id);
}

function visibleMessages() {
  return messages.filter(item => accountFor(item.account_id)?.enabled);
}

function messageById(id) {
  return messages.find(item => item.id === id);
}

function unreadCounts() {
  const byAccount = {};
  const snapshots = {};
  let total = 0;
  for (const account of ACCOUNT_FIXTURES) {
    const inbox = messages.filter(item => item.account_id === account.id && item.folder === 'INBOX');
    const unread = inbox.filter(item => !item.is_read).length;
    byAccount[account.id] = unread;
    snapshots[account.id] = {
      totalCount: inbox.length,
      revision: String(messages.length),
      attemptRevision: String(messages.length),
      observedAt: '2026-09-16T09:00:00.000Z',
      stale: false,
      known: true,
    };
    if (account.include_in_unified_inbox) total += unread;
  }
  return { total, byAccount, snapshots, complete: true };
}

function foldersFor(accountId) {
  const all = [...FOLDER_FIXTURES, ...(extraFolders[accountId] || [])];
  return all.map((folder, index) => {
    const contents = messages.filter(item => item.account_id === accountId && item.folder === folder.path);
    return {
      id: `${accountId}-${index + 1}`,
      account_id: accountId,
      path: folder.path,
      name: folder.name,
      special_use: folder.special_use,
      delimiter: '/',
      no_select: false,
      total_count: contents.length,
      unread_count: contents.filter(item => !item.is_read).length,
      server_total_count: contents.length,
      server_unread_count: contents.filter(item => !item.is_read).length,
      server_counts_at: '2026-09-16T09:00:00.000Z',
      counts_known: true,
      counts_stale: false,
    };
  });
}

function listMessages(url, forceSearch = false) {
  const accountId = url.searchParams.get('accountId');
  const folder = url.searchParams.get('folder') || (forceSearch ? null : 'INBOX');
  const category = url.searchParams.get('category');
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
  const limit = Math.max(0, Number.parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
  let result = visibleMessages();
  if (accountId) result = result.filter(item => item.account_id === accountId);
  if (folder) result = result.filter(item => item.folder === folder);
  if (unreadOnly) result = result.filter(item => !item.is_read);
  if (category) result = result.filter(item => (item.category || 'primary') === category);
  // The one search operator the demo understands: from:<address>, as the sender history uses it.
  const fromOnly = query.match(/^from:"?([^"\s]+)"?$/);
  if (fromOnly) {
    result = result.filter(item => String(item.from_email || '').toLocaleLowerCase() === fromOnly[1]);
  } else if (query) {
    result = result.filter(item => [item.subject, item.from_name, item.from_email, item.snippet, item.body_text]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)));
  }
  result.sort((left, right) => new Date(right.date) - new Date(left.date));
  if (url.searchParams.get('threaded') === 'true' && !forceSearch && !query) {
    return threadedPage(result, { accountId, folder, limit, offset });
  }
  return { messages: result.slice(offset, offset + limit), total: result.length };
}

// Threaded list, as the server builds it (messageService.listMessages): one row per mailbox and
// conversation, the newest letter standing for it with the first letter's subject and sender,
// message_count over distinct letters (INBOX only for an inbox view) and unread_count.
function threadedPage(filtered, { accountId, folder, limit, offset }) {
  const groups = new Map();
  for (const item of filtered) {
    const key = `${item.account_id}\u0000${item.thread_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const inboxOnly = !accountId || folder === 'INBOX';
  const rows = [...groups.values()].map((group) => {
    const newest = group[0];
    const first = group[group.length - 1];
    const whole = messages.filter(m => m.account_id === newest.account_id && m.thread_key === newest.thread_key
      && (!inboxOnly || m.folder === 'INBOX'));
    return {
      ...newest,
      thread_id: newest.thread_key,
      subject: first.subject,
      from_name: first.from_name,
      from_email: first.from_email,
      // The row displays the thread ROOT's sender (from_email above), but a direction badge
      // describes the letter the row shows — the newest one within this view's folder scope
      // (mirrors messageService.js's latest_from_email; see its comment for what this is and
      // is not: a reply in Sent is outside an INBOX view's scope entirely, so it still doesn't
      // affect the badge there).
      latest_from_email: newest.from_email,
      message_count: Math.max(1, new Set(whole.map(m => m.message_id)).size),
      unread_count: group.filter(m => !m.is_read).length,
    };
  });
  return { messages: rows.slice(offset, offset + limit), total: rows.length, threaded: true };
}

function updateMessages(ids, updater) {
  const updated = [];
  for (const id of ids || []) {
    const item = messageById(id);
    if (!item) continue;
    updater(item);
    updated.push(id);
  }
  return updated;
}

function moveMessages(ids, folder) {
  return updateMessages(ids, item => { item.folder = folder; });
}

// A letter moved to Trash is a new row on the server (the IMAP move gives it a new UID), so it
// gets a new id here too. Keeping the old one hid it in Trash: the client guards a deleted id
// for a few seconds so a stale refresh cannot bring it back (utils/pendingDeletes.js).
let nextTrashSequence = 1;
function moveToTrash(item) {
  item.folder = 'Trash';
  item.id = `${item.id.replace(/~trash\d+$/, '')}~trash${nextTrashSequence++}`;
}

function deleteMessages(ids) {
  const deleted = [];
  const remove = new Set();
  for (const id of ids || []) {
    const item = messageById(id);
    if (!item) continue;
    deleted.push(id);
    if (item.folder === 'Trash' || item.folder === 'Drafts') remove.add(id);
    else moveToTrash(item);
  }
  if (remove.size) messages = messages.filter(item => !remove.has(item.id));
  return deleted;
}

function createDraft(body) {
  const account = accountFor(body.accountId) || ACCOUNT_FIXTURES[0];
  const existing = body.existingUid == null
    ? null
    : messages.find(item => item.account_id === account.id && item.uid === Number(body.existingUid));
  const uid = existing?.uid || nextDraftUid++;
  const target = existing || message({
    id: `demo-draft-${uid}`,
    accountId: account.id,
    folder: 'Drafts',
    subject: body.subject || '',
    fromName: account.sender_name,
    fromEmail: account.email_address,
    date: new Date().toISOString(),
    snippet: body.body || '',
    bodyText: body.body || '',
    read: true,
    toAddresses: body.to || [],
  });
  Object.assign(target, {
    uid,
    folder: 'Drafts',
    subject: body.subject || '',
    to_addresses: recipients(body.to),
    cc_addresses: recipients(body.cc),
    snippet: String(body.body || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 240),
    body_html: body.bodyIsHtml ? body.body || '' : `<p>${body.body || ''}</p>`,
    body_text: body.bodyIsHtml ? String(body.body || '').replace(/<[^>]*>/g, ' ').trim() : body.body || '',
    date: new Date().toISOString(),
  });
  if (!existing) messages.push(target);
  return { uid, folder: 'Drafts' };
}

function sendMessage(body) {
  const account = accountFor(body.accountId) || ACCOUNT_FIXTURES[0];
  const sequence = nextMessageSequence++;
  const id = `demo-${String(sequence).padStart(3, '0')}`;
  messages.push(message({
    id,
    accountId: account.id,
    folder: 'Sent',
    subject: body.subject || '',
    fromName: account.sender_name,
    fromEmail: account.email_address,
    date: new Date().toISOString(),
    snippet: String(body.body || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 240),
    bodyText: body.bodyIsHtml ? String(body.body || '').replace(/<[^>]*>/g, ' ').trim() : body.body || '',
    read: true,
    attachments: Array.isArray(body.attachments) && body.attachments.length > 0,
    toAddresses: body.to || [],
  }));
  return { ok: true, messageId: id, sentFolder: 'Sent', sentCopySaved: true };
}

function listContacts(url) {
  const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
  const limit = Math.max(0, Number.parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
  let result = contacts;
  if (query) {
    result = result.filter(contact => [
      contact.display_name, contact.primary_email, contact.organization,
      ...(contact.emails || []).map(entry => entry.value),
      ...(contact.phones || []).map(entry => entry.value),
      ...(contact.urls || []).map(entry => entry.value),
    ].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  }
  return { contacts: result.slice(offset, offset + limit), total: result.length };
}

function contactMethods(values, defaultType) {
  return (Array.isArray(values) ? values : []).map((method, index) => ({
    value: String(method?.value ?? ''),
    type: method?.type || defaultType,
    primary: method?.primary ?? index === 0,
  }));
}

function contactFromPayload(payload, current = {}) {
  const emails = contactMethods(payload.emails ?? current.emails, 'other');
  const phones = contactMethods(payload.phones ?? current.phones, 'mobile');
  const urls = contactMethods(payload.urls ?? current.urls, 'work')
    .map(entry => ({ ...entry, value: /^[a-z][a-z0-9+.-]*:/i.test(entry.value) ? entry.value : `https://${entry.value}` }));
  const primaryEmail = emails[0]?.value?.trim().toLocaleLowerCase() || null;
  const now = new Date().toISOString();
  return {
    ...current,
    display_name: payload.displayName ?? current.display_name ?? '',
    first_name: payload.firstName ?? current.first_name ?? '',
    last_name: payload.lastName ?? current.last_name ?? '',
    primary_email: primaryEmail,
    emails,
    phones,
    urls,
    organization: payload.organization ?? current.organization ?? '',
    notes: payload.notes ?? current.notes ?? '',
    is_auto: current.is_auto ?? false,
    send_count: current.send_count ?? 0,
    last_sent: current.last_sent ?? null,
    etag: `demo-contact-${now}`,
    created_at: current.created_at ?? now,
    updated_at: now,
    has_contact_photo: current.has_contact_photo ?? false,
  };
}

// The mail node as an admin sees it in the demo: its domains with their onboarding, the mailboxes
// made there, the disk. The domains show every kind of row: ready ones (the main domain was taken
// in at the upgrade because it had mailboxes), one ready domain whose node creation time differs
// from the one the panel knows (the warning an administrator accepts or answers with a restart),
// one halfway through its onboarding and one made on the node by hand that the panel does not know
// yet.
const DEMO_ADMIN_EMAIL = 'demo@mailexpert.local';
const demoStep = (at) => ({ at, userId: 'demo-user', email: DEMO_ADMIN_EMAIL });

function nextDemoStep(state) {
  const next = DOMAIN_STATES[DOMAIN_STATES.indexOf(state) + 1];
  return state !== 'unknown' && next && next !== 'authoritative' ? next : null;
}

function demoDomain(node, panel) {
  const row = {
    onNode: true, state: 'unknown', origin: null, addedAt: null, addedBy: null, stateChangedAt: null, steps: {},
    ...node, ...panel,
  };
  return { ...row, nextStep: nextDemoStep(row.state) };
}

const readyDomain = (node) => demoDomain(node, {
  state: 'ready', origin: 'existing_mailboxes', addedAt: '2026-09-18T09:00:00.000Z', stateChangedAt: '2026-09-18T09:00:00.000Z',
});

let mailNodeDomains = [
  readyDomain({ domain: 'demo.mailexpert.local', active: true, maxMailboxes: 500, mailboxes: 0 }),
  ...fleetDomains(FLEET_ACCOUNTS).map(readyDomain),
  demoDomain({ domain: 'pilot.demo.mailexpert.local', active: true, maxMailboxes: 50, mailboxes: 0 }, {
    state: 'dns_ok', origin: 'created', addedAt: '2026-09-18T10:00:00.000Z', addedBy: DEMO_ADMIN_EMAIL,
    stateChangedAt: '2026-09-18T11:20:00.000Z',
    steps: { node_configured: demoStep('2026-09-18T10:30:00.000Z'), dns_ok: demoStep('2026-09-18T11:20:00.000Z') },
  }),
  demoDomain({ domain: 'legacy.demo.mailexpert.local', active: true, maxMailboxes: 20, mailboxes: 0 }),
  demoDomain({ domain: 'branch.demo.mailexpert.local', active: true, maxMailboxes: 100, mailboxes: 0, created: '2026-09-29 16:40:00' }, {
    state: 'ready', origin: 'created', addedAt: '2026-09-02T09:15:00.000Z', addedBy: DEMO_ADMIN_EMAIL,
    stateChangedAt: '2026-09-03T12:00:00.000Z', steps: { ready: { ...demoStep('2026-09-03T12:00:00.000Z'), markedReady: true } },
    recreated: true, nodeCreated: '2026-09-02 09:15:00',
  }),
].sort((a, b) => a.domain.localeCompare(b.domain));

// The EOP settings screen: the defaults with the next hop and certificate filled in, no tenant yet.
let demoEopSettings = {
  eopHost: 'demo-mailexpert-local.mail.protection.outlook.com',
  certificateHost: 'mail.demo.mailexpert.local',
  dkimMode: 'mailcow',
  sendLimitPerHour: 50,
  terrl: null,
  tenantId: null,
  appId: null,
  certThumbprint: null,
};

function eopSettingsAnswer() {
  const s = demoEopSettings;
  return clone({ ...s, tenantConfigured: !!(s.tenantId && s.appId && s.certThumbprint), tenantDriverActive: false });
}

function mailNodeDomainByName(raw) {
  const name = decodeURIComponent(raw).toLowerCase();
  const domain = mailNodeDomains.find(d => d.domain === name);
  if (!domain) throw demoError('The mail node has no such domain', 'domain_not_on_node');
  return domain;
}

function updateMailNodeDomain(name, change) {
  mailNodeDomains = mailNodeDomains.map(d => (d.domain === name ? demoDomain(d, change) : d));
  return mailNodeDomains.find(d => d.domain === name);
}

// The domain without the warning that the node reports another creation time.
function withoutRecreatedWarning(name) {
  mailNodeDomains = mailNodeDomains.map(d => {
    if (d.domain !== name) return d;
    const rest = { ...d };
    delete rest.recreated;
    delete rest.nodeCreated;
    return rest;
  });
}

// Adopt, "Done", "mark ready", "restart onboarding" and accepting the node's creation time, with
// the same refusals as the server (routes/mailNode.js).
function changeMailNodeDomain(action, raw, step) {
  const domain = mailNodeDomainByName(raw);
  const now = new Date().toISOString();
  if (action === 'acknowledge') {
    if (domain.state === 'unknown') throw demoError('The panel does not know this domain', 'domain_not_found');
    if (!domain.recreated) throw demoError('The node reports the creation time the panel knows already', 'domain_not_recreated');
    withoutRecreatedWarning(domain.domain);
    return mailNodeDomains.find(d => d.domain === domain.domain);
  }
  if (action === 'adopt') {
    if (domain.state !== 'unknown') throw demoError('The panel knows this domain already', 'domain_known');
    return updateMailNodeDomain(domain.domain, {
      state: 'node_created', origin: 'adopted', addedAt: now, addedBy: DEMO_ADMIN_EMAIL, stateChangedAt: now, steps: {},
    });
  }
  if (domain.state === 'unknown') throw demoError('The panel does not know this domain', 'domain_not_found');
  if (action === 'restart') {
    // Mailboxes on the domain stay; the node identity is bound again, so the warning goes too.
    withoutRecreatedWarning(domain.domain);
    return updateMailNodeDomain(domain.domain, { state: 'node_created', stateChangedAt: now, steps: {} });
  }
  if (action === 'ready') {
    if (!canMarkReady(domain)) throw demoError('The domain is ready already', 'domain_already_ready');
    return updateMailNodeDomain(domain.domain, {
      state: 'ready', stateChangedAt: now, steps: { ...domain.steps, ready: { ...demoStep(now), markedReady: true } },
    });
  }
  if (step !== domain.nextStep) throw demoError('Only the next onboarding step can be confirmed', 'step_out_of_order');
  return updateMailNodeDomain(domain.domain, { state: step, stateChangedAt: now, steps: { ...domain.steps, [step]: demoStep(now) } });
}
let mailNodeMailboxes = FLEET_ACCOUNTS.filter(account => account.mail_node).map((account, index) => ({
  accountId: account.id, email: account.email_address, onNode: true, active: true, quotaMb: 5120,
  usedBytes: ((index * 37) % 90 + 3) * 10 * 1048576,
}));

// Addresses Google granted before (the grant journal) that are no mailbox now: the Gmail field
// offers them as "Connected before".
const KNOWN_GOOGLE_EMAILS = ['acme.archive.demo@gmail.com', 'acme.legacy.demo@gmail.com', 'acme.interns.demo@gmail.com'];

function demoError(message, code) {
  return Object.assign(new Error(message), { code });
}

const normalizeEmail = value => String(value ?? '').trim().toLowerCase();
const mailboxWithEmail = email => ACCOUNT_FIXTURES.find(account => normalizeEmail(account.email_address) === normalizeEmail(email));

// A new mailbox is not empty in the demo: one letter says it is ready, threaded the way the
// mailbox's mode would thread it.
function welcomeLetter(account) {
  const sequence = nextMessageSequence++;
  const id = `demo-${String(sequence).padStart(3, '0')}`;
  const gmail = account.thread_mode === 'gmail';
  const threadNumber = `19${String(sequence).padStart(17, '0')}`;
  messages.push(message({
    ...(gmail
      ? { threadId: `gmail:${threadNumber}`, reason: 'gmail-thrid', providerThreadId: threadNumber, providerMessageId: `${threadNumber}1` }
      : { reason: 'new-root', threadId: `<${id}@demo.mailexpert.local>` }),
    id, accountId: account.id,
    subject: 'Ящик подключён к MailExpert', fromName: 'MailExpert', fromEmail: 'noreply@demo.mailexpert.local',
    date: new Date().toISOString(), snippet: `Письма на ${account.email_address} теперь видны всей команде.`,
    category: 'automated',
  }));
}

// The second sender name becomes an alias with the mailbox's own address, as on the server
// (backend utils/senderNames.js), so compose's From list offers both names.
function secondSenderName(accountId, email, raw, senderName) {
  const alt = String(raw ?? '').trim();
  if (!alt || alt.toLowerCase() === String(senderName ?? '').toLowerCase()) return [];
  return [{ id: `${accountId}-alias-1`, account_id: accountId, name: alt, email, reply_to: null, signature: null }];
}

// "Mailbox on our domain" in the demo, with the same refusals as POST /api/accounts kind=domain.
function createDomainMailbox(body) {
  const localPart = normalizeEmail(body.localPart);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(localPart) || localPart.includes('..')) {
    throw demoError('Invalid local part', 'local_part_invalid');
  }
  // The server's order: an address already added, then a domain whose onboarding is not done,
  // then one the node lacks or has inactive.
  const email = `${localPart}@${normalizeEmail(body.domain)}`;
  if (mailboxWithEmail(email)) throw demoError('This mailbox is already in MailExpert', 'mailbox_exists');
  const domain = mailNodeDomains.find(d => d.domain === normalizeEmail(body.domain));
  if (!MAILBOX_READY_STATES.includes(domain?.state)) throw demoError('The domain is not ready for mailboxes', 'domain_not_ready');
  if (!domain.active) throw demoError('Unknown domain', 'domain_unknown');
  const senderName = String(body.senderName ?? '').trim() || null;
  const name = String(body.name ?? '').trim() || senderName || email;
  const account = {
    ...clone(ACCOUNT_FIXTURES[0]), id: `demo-node-${email}`, name, sender_name: senderName,
    aliases: secondSenderName(`demo-node-${email}`, email, body.senderNameAlt, senderName),
    imap_host: 'mail.demo.mailexpert.local', smtp_host: 'mail.demo.mailexpert.local',
    email_address: email, color: '#0ea5e9', signature: null, sort_order: ACCOUNT_FIXTURES.length,
    mail_node: true, thread_mode: 'rfc',
  };
  ACCOUNT_FIXTURES.push(account);
  mailNodeMailboxes = [...mailNodeMailboxes, { accountId: account.id, email, onNode: true, active: true, quotaMb: 5120, usedBytes: 0 }];
  mailNodeDomains = mailNodeDomains.map(d => (d.domain === domain.domain ? { ...d, mailboxes: d.mailboxes + 1 } : d));
  welcomeLetter(account);
  return account;
}

// The demo stands in for Google's consent: the Gmail form asks "Allow?" itself and then calls
// start, which here connects the address at once, as the callback would.
function connectGmail(body) {
  const email = normalizeEmail(body.email);
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw demoError('Invalid email', 'email_invalid');
  if (mailboxWithEmail(email)) throw demoError('Already connected', 'already_connected');
  const senderName = String(body.senderName ?? '').trim() || null;
  const account = {
    ...clone(ACCOUNT_FIXTURES[0]), id: `demo-gmail-${email}`, name: email, sender_name: senderName || email.split('@')[0],
    aliases: secondSenderName(`demo-gmail-${email}`, email, body.senderNameAlt, senderName),
    imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com', email_address: email, color: '#ea4335',
    signature: null, sort_order: ACCOUNT_FIXTURES.length, oauth_provider: 'google', thread_mode: 'gmail',
  };
  ACCOUNT_FIXTURES.push(account);
  welcomeLetter(account);
  return { path: null, demo: true, result: 'created' };
}

function demoSenderHistory(id) {
  const current = messageById(id);
  if (!current) return { correspondent: null, total: 0, items: [] };
  const account = ACCOUNT_FIXTURES.find(item => item.id === current.account_id);
  const own = account?.email_address;
  const mappings = account?.folder_mappings || {};
  const ownSet = new Set([account?.email_address, ...(account?.aliases || []).map(a => a.email)].map(normalizeEmail));
  const other = current.from_email === own ? current.to_addresses[0]?.email : current.from_email;
  const earlier = MESSAGE_FIXTURES
    .filter(m => m.id !== id && m.account_id === current.account_id && m.date < current.date)
    .filter(m => m.from_email === other || (m.from_email === own && m.to_addresses.some(r => r.email === other)))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    correspondent: other || null,
    total: earlier.length,
    items: earlier.slice(0, 5).map(m => ({
      id: m.id, folder: m.folder, subject: m.subject, snippet: m.snippet, date: m.date,
      direction: letterDirection(m, mappings, ownSet),
    })),
  };
}

// The open letter's conversation in its mailbox (GET /api/mail/messages/:id/conversation), the
// server's rules (services/conversation.js) over the demo's `messages`: same mailbox and thread
// key, trash and spam left out, one copy per letter, oldest first, drafts marked as drafts.
// Direction matches mailboxBanner()/conversation.js exactly: an own sender is 'out' only in the
// account's Sent folder, or when none of the recipients is the account itself — a letter the
// mailbox sent to itself (own address in own recipients) is also a received copy outside Sent.
function demoConversation(id) {
  const current = messageById(id);
  if (!current) return null;
  const account = accountFor(current.account_id);
  const mappings = account?.folder_mappings || {};
  const own = new Set([account?.email_address, ...(account?.aliases || []).map(a => a.email)].map(normalizeEmail));
  const seen = new Set();
  const items = messages
    .filter(m => m.account_id === current.account_id && m.thread_key === current.thread_key)
    .filter(m => m.folder !== mappings.trash && m.folder !== mappings.spam)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((m) => {
      const key = m.message_id || m.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(m => ({
      id: m.id, folder: m.folder, subject: m.subject, snippet: m.snippet, date: m.date,
      from_name: m.from_name, from_email: m.from_email, to_addresses: m.to_addresses, cc_addresses: m.cc_addresses,
      has_attachments: !!m.has_attachments,
      direction: m.folder === mappings.drafts ? 'draft' : letterDirection(m, mappings, own),
    }));
  return { threadKey: current.thread_key, total: items.length, items };
}

// Shared by demoConversation and demoContactLetters: 'out' when the account (or an alias) wrote
// the letter AND it sits in the account's own Sent folder, or none of its recipients is the
// account itself; otherwise (including every letter someone else wrote) 'in'.
function letterDirection(m, mappings, own) {
  const from = normalizeEmail(m.from_email);
  if (!own.has(from)) return 'in';
  if (mappings.sent && m.folder === mappings.sent) return 'out';
  const recipients = [...(m.to_addresses || []), ...(m.cc_addresses || [])].map(r => normalizeEmail(r.email));
  return recipients.some(r => own.has(r)) ? 'in' : 'out';
}

// A contact's correspondence across every enabled mailbox (GET /api/contacts/:id/letters), the
// same rules the server applies (services/contactLetters.js) over the demo's own `messages`:
// own address = the mailbox's address plus its aliases, per mailbox; trash/spam/drafts are
// skipped per mailbox's own folder mapping; a letter counts once per mailbox by message_id;
// newest first. Precedence matches mailboxBanner() / contactLetters.js exactly: an own address
// as the sender always wins ('out'/'in' via letterDirection, once the contact is confirmed in
// the recipients) — checked BEFORE the contact-address match, so a contact whose address happens
// to be one of our own mailboxes is never misread as having "sent" us its own outgoing mail.
function demoContactLetters(contactId, { limit = 20, offset = 0 } = {}) {
  const contact = contacts.find(item => item.id === contactId);
  if (!contact) return null;

  const addresses = new Set((contact.emails || []).map(e => normalizeEmail(e.value)).filter(Boolean));
  if (!addresses.size) return { received: 0, sent: 0, lastDate: null, total: 0, items: [] };

  const cappedLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || 20, 50));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);

  const matches = messages.reduce((acc, m) => {
    const account = accountFor(m.account_id);
    if (!account?.enabled) return acc;
    const mappings = account.folder_mappings || {};
    if (m.folder === mappings.trash || m.folder === mappings.spam || m.folder === mappings.drafts) return acc;
    const own = new Set([account.email_address, ...(account.aliases || []).map(a => a.email)].map(normalizeEmail));
    const from = normalizeEmail(m.from_email);
    if (own.has(from)) {
      const recipients = [...(m.to_addresses || []), ...(m.cc_addresses || [])].map(r => normalizeEmail(r.email));
      if (recipients.some(r => addresses.has(r))) acc.push({ message: m, direction: letterDirection(m, mappings, own) });
      return acc;
    }
    if (addresses.has(from)) acc.push({ message: m, direction: 'in' });
    return acc;
  }, []);

  const seen = new Set();
  const deduped = [];
  for (const entry of [...matches].sort((a, b) => b.message.date.localeCompare(a.message.date))) {
    const key = `${entry.message.account_id}:${entry.message.message_id || entry.message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  const received = deduped.filter(entry => entry.direction === 'in').length;
  return {
    received,
    sent: deduped.length - received,
    lastDate: deduped.length ? deduped[0].message.date : null,
    total: deduped.length,
    items: deduped.slice(safeOffset, safeOffset + cappedLimit).map(({ message: m, direction }) => ({
      id: m.id, account_id: m.account_id, folder: m.folder, subject: m.subject, snippet: m.snippet,
      date: m.date, direction,
    })),
  };
}

function demoMessageIdFor(id) {
  return `<${id}@demo.mailexpert.local>`;
}

// Per-message threading diagnostics (GET /mail/messages/:id/threading), same shape the server
// answers: one fixture is a reply in its chain, one is a provisional ancestor whose root never
// synced, one is an old row with no recorded reason, everything else reads as its own thread.
const THREADING_OVERRIDES = {
  'demo-005': {
    inReplyTo: demoMessageIdFor('demo-001'),
    references: [demoMessageIdFor('demo-001')],
    reason: 'rfc-root',
    threadId: demoMessageIdFor('demo-001'),
  },
  'demo-004': {
    inReplyTo: '<checklist-kickoff@vendor.example>',
    references: ['<checklist-kickoff@vendor.example>'],
    reason: 'rfc-provisional',
    threadId: '<checklist-kickoff@vendor.example>',
  },
  'demo-009': { reason: null, threadIdNull: true },
};

// Full raw headers (GET /mail/messages/:id/headers), built the same way the server falls back
// to buildHeadersFromMessage when it cannot re-fetch the original ones from IMAP. Pre-existing
// gap: the generic demo fallback answered { headers: [] } here, an array MessageHeaderModal's
// headers.split('\n') cannot handle, crashing the modal on every open in demo mode.
// What the diagnostics and headers say about a letter: a generated one carries its own fields,
// a hand-made one reads THREADING_OVERRIDES (anything not listed there is its own root).
function threadingOf(current) {
  if ('threading_reason' in current) {
    return {
      inReplyTo: current.in_reply_to, references: current.thread_references, reason: current.threading_reason,
      threadId: current.thread_id, providerThreadId: current.provider_thread_id, providerMessageId: current.provider_message_id,
    };
  }
  const override = THREADING_OVERRIDES[current.id] || {};
  return {
    inReplyTo: override.inReplyTo ?? null,
    references: override.references ?? [],
    reason: 'reason' in override ? override.reason : 'new-root',
    threadId: override.threadIdNull ? null : (override.threadId ?? current.message_id),
    providerThreadId: null,
    providerMessageId: null,
  };
}

function demoHeaders(id) {
  const current = messageById(id);
  if (!current) return null;
  const override = threadingOf(current);
  const lines = [];
  lines.push(`From: ${current.from_name} <${current.from_email}>`);
  if (current.to_addresses?.length) lines.push(`To: ${current.to_addresses.map(r => r.email).join(', ')}`);
  if (current.subject) lines.push(`Subject: ${current.subject}`);
  lines.push(`Message-ID: ${current.message_id}`);
  if (current.date) lines.push(`Date: ${new Date(current.date).toUTCString()}`);
  if (override.inReplyTo) lines.push(`In-Reply-To: ${override.inReplyTo}`);
  if (override.references?.length) lines.push(`References: ${override.references.join(' ')}`);
  return { headers: lines.join('\r\n'), subject: current.subject };
}

function demoThreadingDiagnostics(id) {
  const current = messageById(id);
  // The real route answers 404 { error: 'Message not found' } for an unknown id, which the
  // real request() turns into a rejected promise (utils/api.js). Demo mode has no HTTP layer
  // to carry a status code, so it rejects the same way: throwing here makes demoRequest's
  // promise reject with the same message, and MessageHeaderModal's .catch() sees a real failure
  // instead of a silently empty diagnostics object.
  if (!current) throw new Error('Message not found');
  const threading = threadingOf(current);

  // Same grouping the list uses (thread_key), not the display strings above, which only
  // decorate one row.
  const sameThread = messages.filter(m => m.account_id === current.account_id && m.thread_key === current.thread_key);
  const byFolder = new Map();
  for (const m of sameThread) byFolder.set(m.folder, (byFolder.get(m.folder) || 0) + 1);
  const folders = [...byFolder.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));

  return {
    messageId: current.message_id,
    ...threading,
    mode: accountFor(current.account_id)?.thread_mode === 'gmail' ? 'gmail' : 'rfc',
    conversation: { total: new Set(sameThread.map(m => m.message_id)).size, folders },
  };
}

export async function demoRequest(method, path, body = {}) {
  const verb = method.toUpperCase();
  const url = parsePath(path);
  const pathname = url.pathname;

  if (verb === 'GET' && pathname === '/auth/config') return { mode: 'local', cloudflare: false, googleSignIn: false };
  if (verb === 'GET' && pathname === '/auth/me') {
    const base = demoRole() === 'user' ? DEMO_PLAIN_USER : DEMO_USER;
    return { user: { ...clone(base), totpEnabled: demoTotpEnabled, ...clone(profileOverrides) } };
  }
  if (verb === 'GET' && pathname === '/auth/preferences') return clone(preferences);
  if (verb === 'PATCH' && pathname === '/auth/preferences') {
    preferences = { ...preferences, ...clone(body) };
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/accounts') return clone(ACCOUNT_FIXTURES);
  // "Mailbox on our domain": the demo adds it to the account list for this page session.
  if (verb === 'POST' && pathname === '/accounts' && body?.kind === 'domain') return clone(createDomainMailbox(body));
  if (verb === 'POST' && pathname === '/oauth/google/start') return connectGmail(body);
  if (verb === 'GET' && pathname === '/oauth/google/known-emails') {
    const q = normalizeEmail(url.searchParams.get('q'));
    return { emails: KNOWN_GOOGLE_EMAILS.filter(email => email.includes(q) && !mailboxWithEmail(email)) };
  }

  const foldersMatch = pathname.match(/^\/accounts\/([^/]+)\/folders$/);
  if (verb === 'GET' && foldersMatch) return clone(foldersFor(decodeURIComponent(foldersMatch[1])));
  const aliasesMatch = pathname.match(/^\/accounts\/([^/]+)\/aliases$/);
  if (verb === 'GET' && aliasesMatch) return clone(accountFor(decodeURIComponent(aliasesMatch[1]))?.aliases || []);
  if (verb === 'POST' && aliasesMatch) {
    const accountId = decodeURIComponent(aliasesMatch[1]);
    const account = accountFor(accountId);
    if (!account) throw demoError('Account not found');
    const alias = {
      id: `${accountId}-alias-${nextAliasSequence++}`, account_id: accountId,
      name: body?.name || '', email: body?.email || account.email_address,
      reply_to: body?.reply_to || null, signature: body?.signature || null,
    };
    account.aliases = [...(account.aliases || []), alias];
    return clone(alias);
  }
  const aliasItemMatch = pathname.match(/^\/accounts\/([^/]+)\/aliases\/([^/]+)$/);
  if (verb === 'PUT' && aliasItemMatch) {
    const account = accountFor(decodeURIComponent(aliasItemMatch[1]));
    const alias = account?.aliases?.find(a => a.id === decodeURIComponent(aliasItemMatch[2]));
    if (!alias) throw demoError('Alias not found');
    Object.assign(alias, {
      name: body?.name ?? alias.name, email: body?.email ?? alias.email,
      reply_to: body?.reply_to ?? alias.reply_to, signature: body?.signature ?? alias.signature,
    });
    return clone(alias);
  }
  if (verb === 'DELETE' && aliasItemMatch) {
    const account = accountFor(decodeURIComponent(aliasItemMatch[1]));
    if (account) account.aliases = (account.aliases || []).filter(a => a.id !== decodeURIComponent(aliasItemMatch[2]));
    return { ok: true };
  }

  // Manual "IMAP mailbox" add: the real backend performs a live IMAP connection test the demo
  // cannot; assume success (same as the "domain" and Gmail add flows above) and add the account
  // with the submitted connection fields.
  if (verb === 'POST' && pathname === '/accounts' && !body?.kind) {
    const email = normalizeEmail(body?.email_address || body?.email);
    if (email && mailboxWithEmail(email)) throw demoError('This mailbox is already in MailExpert', 'mailbox_exists');
    const account = {
      ...clone(ACCOUNT_FIXTURES[0]),
      id: `demo-manual-${Date.now()}`,
      name: body?.name || email || 'New mailbox',
      sender_name: body?.sender_name || null,
      email_address: email || `mailbox-${Date.now()}@demo.mailexpert.local`,
      imap_host: body?.imap_host || '', imap_port: Number(body?.imap_port) || 993,
      smtp_host: body?.smtp_host || '', smtp_port: Number(body?.smtp_port) || 587,
      smtp_tls: body?.smtp_tls || 'STARTTLS', color: body?.color || '#64748b',
      protocol: 'imap', enabled: true, aliases: [], health: 'healthy', signature: body?.signature || null,
      categorization_enabled: !!body?.categorization_enabled, sort_order: ACCOUNT_FIXTURES.length,
      mail_node: false, thread_mode: 'rfc',
    };
    ACCOUNT_FIXTURES.push(account);
    return clone(account);
  }
  const accountMatch = pathname.match(/^\/accounts\/([^/]+)$/);
  if (verb === 'PUT' && accountMatch) {
    const account = accountFor(decodeURIComponent(accountMatch[1]));
    if (!account) throw demoError('Account not found');
    if (account.mail_node && (body?.imap_host !== undefined || body?.smtp_host !== undefined)) {
      throw demoError('Connection settings are locked for a mailbox on the mail node', 'mail_node_connection_locked');
    }
    if (account.mail_node && body?.enabled !== undefined && !body.enabled && account.enabled !== false) {
      throw demoError('A mail node mailbox cannot be disabled: delete it instead', 'mail_node_disable_unsupported');
    }
    const assignable = ['name', 'sender_name', 'color', 'enabled', 'imap_host', 'imap_port', 'smtp_host', 'smtp_port',
      'smtp_tls', 'folder_mappings', 'signature', 'categorization_enabled', 'sort_order', 'include_in_unified_inbox'];
    for (const key of assignable) if (body?.[key] !== undefined) account[key] = body[key];
    return clone(account);
  }
  if (verb === 'DELETE' && accountMatch) {
    const id = decodeURIComponent(accountMatch[1]);
    const index = ACCOUNT_FIXTURES.findIndex(a => a.id === id);
    const [removed] = index !== -1 ? ACCOUNT_FIXTURES.splice(index, 1) : [];
    // A mail node mailbox is deleted on the node with all its mail, as on the server; the demo's
    // cached letters of any removed mailbox go with it.
    messages = messages.filter(m => m.account_id !== id);
    if (removed?.mail_node) {
      const domain = normalizeEmail(removed.email_address).split('@')[1];
      mailNodeDomains = mailNodeDomains.map(d => (d.domain === domain ? { ...d, mailboxes: Math.max(0, d.mailboxes - 1) } : d));
    }
    mailNodeMailboxes = mailNodeMailboxes.filter(m => m.accountId !== id);
    return { ok: true };
  }
  const reconnectMatch = pathname.match(/^\/accounts\/([^/]+)\/reconnect$/);
  if (verb === 'POST' && reconnectMatch) {
    const account = accountFor(decodeURIComponent(reconnectMatch[1]));
    if (account) account.health = 'healthy';
    return { ok: true };
  }
  const reindexMatch = pathname.match(/^\/accounts\/([^/]+)\/reindex$/);
  if (verb === 'POST' && reindexMatch) return { ok: true, alreadyRunning: false };
  const threadingPreviewMatch = pathname.match(/^\/accounts\/([^/]+)\/threading\/preview$/);
  if (verb === 'POST' && threadingPreviewMatch) {
    const id = decodeURIComponent(threadingPreviewMatch[1]);
    const mode = body?.mode;
    const accountMessages = messages.filter(m => m.account_id === id);
    const threadsNow = new Set(accountMessages.map(m => m.thread_key)).size;
    return { rows: accountMessages.length, changing: 0, subjectOnly: 0, threadsNow, threadsAfter: mode === 'gmail' ? threadsNow : null };
  }
  const threadingModeMatch = pathname.match(/^\/accounts\/([^/]+)\/threading\/mode$/);
  if (verb === 'POST' && threadingModeMatch) {
    const account = accountFor(decodeURIComponent(threadingModeMatch[1]));
    if (!account) throw demoError('Account not found');
    const mode = body?.mode;
    if (mode === 'gmail' && account.oauth_provider !== 'google') {
      const err = demoError('threading_switch_blocked');
      err.reason = 'not_gmail';
      throw err;
    }
    account.thread_mode = mode;
    return { ok: true, mode };
  }

  // Manual sync is per mailbox: the real server answers { ok, skipped } and rejects a request
  // without one, but has nothing real to sync against in the demo — always succeeds.
  if (verb === 'POST' && pathname === '/mail/sync') return { ok: true, skipped: false };
  if (verb === 'POST' && pathname === '/mail/sync-folder') return { ok: true };
  if (verb === 'POST' && pathname === '/mail/sync-folders') return { ok: true };

  if (verb === 'POST' && pathname === '/mail/folders') {
    const { accountId, name, parentPath } = body || {};
    const path = parentPath ? `${parentPath}/${name}` : name;
    extraFolders[accountId] = [...(extraFolders[accountId] || []), { path, name, special_use: null }];
    return { ok: true, path };
  }
  if (verb === 'POST' && pathname === '/mail/folders/delete') {
    const { accountId, path } = body || {};
    extraFolders[accountId] = (extraFolders[accountId] || []).filter(f => f.path !== path);
    messages = messages.filter(m => !(m.account_id === accountId && m.folder === path));
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/mail/folders/rename') {
    const { accountId, oldPath, newName } = body || {};
    const folder = (extraFolders[accountId] || []).find(f => f.path === oldPath);
    const newPath = oldPath.includes('/') ? `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/${newName}` : newName;
    if (folder) { folder.path = newPath; folder.name = newName; }
    for (const m of messages) if (m.account_id === accountId && m.folder === oldPath) m.folder = newPath;
    return { ok: true, newPath };
  }
  if (verb === 'POST' && pathname === '/mail/folders/empty') {
    const { accountId, path } = body || {};
    messages = messages.filter(m => !(m.account_id === accountId && m.folder === path));
    return { ok: true, started: true };
  }

  if (verb === 'POST' && pathname === '/diagnostics/report') {
    return {
      versions: { backend: '3.3.0-demo', gitSha: 'demo' },
      server: { uptimeSeconds: 3600, dbOk: true, redisOk: true },
      accounts: ACCOUNT_FIXTURES.slice(0, 5).map(a => ({ id: a.id, protocol: a.protocol, enabled: a.enabled, health: a.health })),
      folders: [],
      counts: { unreadTotal: unreadCounts().total, unreadByAccountRef: {} },
      warnings: [], syncSignals: [], connection: {}, performance: {},
      config: { aiEnabled: false, aiProvider: null, plugins: {} },
      scrub: {},
    };
  }

  if (verb === 'GET' && pathname === '/mail/unread-counts') return clone(unreadCounts());
  if (verb === 'GET' && pathname === '/mail/messages') return clone(listMessages(url));
  if (verb === 'GET' && (pathname === '/mail/search' || pathname === '/search')) {
    return clone({ ...listMessages(url, true), query: url.searchParams.get('q') || '' });
  }

  // Earlier letters with the same person in the same mailbox, as the server answers it.
  const historyMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/sender-history$/);
  if (verb === 'GET' && historyMatch) return clone(demoSenderHistory(decodeURIComponent(historyMatch[1])));

  // Every letter of the open letter's conversation in its mailbox, as the server answers it.
  const conversationMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/conversation$/);
  if (verb === 'GET' && conversationMatch) {
    const result = demoConversation(decodeURIComponent(conversationMatch[1]));
    if (!result) throw new Error('Message not found');
    return clone(result);
  }

  // Why this letter is in its conversation, as the server answers it.
  const threadingMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/threading$/);
  if (verb === 'GET' && threadingMatch) return clone(demoThreadingDiagnostics(decodeURIComponent(threadingMatch[1])));

  const headersMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/headers$/);
  if (verb === 'GET' && headersMatch) return clone(demoHeaders(decodeURIComponent(headersMatch[1])));

  // No demo letter carries a stored Bcc, so a reopened demo draft always answers "known empty"
  // rather than going through the real route's unknown-Bcc/read-only-open path.
  const bccMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/bcc$/);
  if (verb === 'GET' && bccMatch) return { bcc: [] };

  const bodyMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/body$/);
  if (verb === 'GET' && bodyMatch) {
    const item = messageById(decodeURIComponent(bodyMatch[1]));
    return item ? clone({
      html: item.body_html,
      text: item.body_text,
      attachments: item.has_attachments ? [{
        part: '1',
        filename: 'renewal-order-form.txt',
        type: 'text/plain',
        size: 45,
      }] : [],
      hasBlockedRemoteImages: false,
      // No Sender header distinct from From in the demo letters, as for most real mail.
      senderEmail: null,
      senderName: null,
    }) : {};
  }

  const attachmentMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/attachments\/([^/]+)$/);
  if (verb === 'GET' && attachmentMatch) {
    const item = messageById(decodeURIComponent(attachmentMatch[1]));
    if (!item?.has_attachments || decodeURIComponent(attachmentMatch[2]) !== '1') return {};
    return {
      filename: 'renewal-order-form.txt',
      type: 'text/plain',
      content: 'Demo attachment: renewal order form preview.\n',
    };
  }

  const rawEmlMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/raw\.eml$/);
  if (verb === 'GET' && rawEmlMatch) {
    const item = messageById(decodeURIComponent(rawEmlMatch[1]));
    const subject = item?.subject || 'Demo message';
    return {
      type: 'message/rfc822',
      content: `From: demo@example.com\r\nSubject: ${subject}\r\n\r\nThis is a demo message.\r\n`,
    };
  }

  const starMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/star$/);
  if (verb === 'PATCH' && starMatch) {
    const item = messageById(decodeURIComponent(starMatch[1]));
    if (item) item.is_starred = Boolean(body.starred);
    return { ok: true, is_starred: Boolean(body.starred) };
  }

  const spamMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/(spam|ham)$/);
  if (verb === 'POST' && spamMatch) {
    const folder = spamMatch[2] === 'spam' ? 'Spam' : 'INBOX';
    moveMessages([decodeURIComponent(spamMatch[1])], folder);
    return { ok: true, folder, newUid: null };
  }

  const categoryMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/category$/);
  if (verb === 'PATCH' && categoryMatch) {
    const item = messageById(decodeURIComponent(categoryMatch[1]));
    if (item) item.category = body.category;
    return { ok: true, category: body.category };
  }

  const messageMatch = pathname.match(/^\/mail\/messages\/([^/]+)$/);
  if (verb === 'GET' && messageMatch) return clone(messageById(decodeURIComponent(messageMatch[1])) || {});
  if (verb === 'DELETE' && messageMatch) {
    const id = decodeURIComponent(messageMatch[1]);
    const item = messageById(id);
    if (item?.folder === 'Trash' || item?.folder === 'Drafts') messages = messages.filter(candidate => candidate.id !== id);
    else if (item) moveToTrash(item);
    return { ok: true };
  }

  const threadMatch = pathname.match(/^\/mail\/thread\/([^/]+)$/);
  if (verb === 'GET' && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const accountId = url.searchParams.get('accountId');
    const result = visibleMessages()
      .filter(item => (item.thread_id === threadId || item.thread_key === threadId) && (!accountId || item.account_id === accountId))
      .sort((left, right) => new Date(left.date) - new Date(right.date));
    return { messages: clone(result) };
  }

  if (verb === 'GET' && pathname === '/mail/resolve-message') {
    const ref = url.searchParams.get('ref');
    const accountId = url.searchParams.get('accountId');
    const item = visibleMessages().find(candidate =>
      (candidate.id === ref || candidate.message_id === ref) && (!accountId || candidate.account_id === accountId));
    return clone(item || {});
  }

  if (verb === 'POST' && pathname === '/mail/messages/bulk-read') {
    const updated = [];
    for (const id of body.ids || []) {
      const item = messageById(id);
      if (item && item.is_read !== Boolean(body.read)) {
        item.is_read = Boolean(body.read);
        updated.push(id);
      }
    }
    return { ok: true, updated };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-star') {
    const updated = [];
    for (const id of body.ids || []) {
      const item = messageById(id);
      if (item && item.is_starred !== Boolean(body.starred)) {
        item.is_starred = Boolean(body.starred);
        updated.push(id);
      }
    }
    return { ok: true, updated };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-delete') {
    return { ok: true, deleted: deleteMessages(body.ids) };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-move') {
    return { ok: true, moved: moveMessages(body.ids, body.folder) };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-archive') {
    return { ok: true, archived: moveMessages(body.ids, 'Archive'), noArchiveFolder: [] };
  }
  if (verb === 'POST' && pathname === '/mail/mark-all-read') {
    const updated = visibleMessages()
      .filter(item => item.account_id === body.accountId && item.folder === (body.folder || 'INBOX'))
      .map(item => { item.is_read = true; return item.id; });
    return { ok: true, updated };
  }

  const snoozeMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/snooze$/);
  if (verb === 'POST' && snoozeMatch) {
    const item = messageById(decodeURIComponent(snoozeMatch[1]));
    if (!item) throw demoError('Message not found');
    item.folder = 'Snoozed';
    return { ok: true };
  }

  const unsubscribeMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/unsubscribe$/);
  if (verb === 'POST' && unsubscribeMatch) {
    const item = messageById(decodeURIComponent(unsubscribeMatch[1]));
    if (!item) throw demoError('Message not found');
    // Only the demo newsletter fixture (demo-003) carries a List-Unsubscribe header.
    if (item.category !== 'newsletter') throw demoError('This message has no unsubscribe link');
    item.unsubscribed_at = new Date().toISOString();
    return { ok: true, type: 'mailto', url: null, mailto: 'mailto:unsubscribe@aster.example' };
  }

  if (verb === 'GET' && pathname === '/mail/category-counts') {
    const accountId = url.searchParams.get('accountId');
    const counts = {};
    for (const item of visibleMessages()) {
      if (item.folder !== 'INBOX' || item.is_read || (accountId && item.account_id !== accountId)) continue;
      const category = item.category || 'primary';
      counts[category] = (counts[category] || 0) + 1;
    }
    return { counts };
  }

  if (verb === 'POST' && pathname === '/mail/draft') return createDraft(body);
  const draftMatch = pathname.match(/^\/mail\/draft\/([^/]+)$/);
  if (verb === 'DELETE' && draftMatch) {
    const uid = Number(decodeURIComponent(draftMatch[1]));
    const accountId = url.searchParams.get('accountId');
    messages = messages.filter(item => !(item.uid === uid && item.account_id === accountId && item.folder === 'Drafts'));
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/mail/send') return sendMessage(body);

  if (verb === 'GET' && pathname === '/contacts') return clone(listContacts(url));
  if (verb === 'POST' && pathname === '/contacts') {
    const id = `demo-contact-${contacts.length + 1}`;
    const contact = contactFromPayload(body, { id, uid: id });
    contacts.push(contact);
    return clone(contact);
  }
  const contactLettersMatch = pathname.match(/^\/contacts\/([^/]+)\/letters$/);
  if (verb === 'GET' && contactLettersMatch) {
    const result = demoContactLetters(decodeURIComponent(contactLettersMatch[1]), {
      limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'),
    });
    if (!result) throw demoError('Contact not found', 'not_found');
    return clone(result);
  }
  const contactMatch = pathname.match(/^\/contacts\/([^/]+)$/);
  if (verb === 'GET' && contactMatch) return clone(contacts.find(item => item.id === decodeURIComponent(contactMatch[1])) || {});
  if (verb === 'PATCH' && contactMatch) {
    const contact = contacts.find(item => item.id === decodeURIComponent(contactMatch[1]));
    if (contact) Object.assign(contact, contactFromPayload(body, contact));
    return clone(contact || {});
  }
  if (verb === 'DELETE' && contactMatch) {
    contacts = contacts.filter(item => item.id !== decodeURIComponent(contactMatch[1]));
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/search/contacts') {
    return clone({ contacts: listContacts(url).contacts });
  }

  if (verb === 'GET' && pathname === '/integrations') return clone(integrationsConfig);
  if (verb === 'GET' && pathname === '/integrations/status') {
    return { google: { configured: true, available: true }, microsoft: { configured: false }, domainMail: { configured: true } };
  }
  const integrationMatch = pathname.match(/^\/integrations\/([^/]+)$/);
  if (verb === 'POST' && integrationMatch) {
    const provider = decodeURIComponent(integrationMatch[1]);
    if (provider === 'google') {
      const redirectUri = String(body?.redirectUri ?? '').trim();
      if (redirectUri && !/^https?:\/\//i.test(redirectUri)) throw demoError('redirect_uri must be an absolute URL', 'redirect_uri_invalid');
      integrationsConfig = { ...integrationsConfig, google: { ...(redirectUri ? { redirectUri } : {}), updated_at: new Date().toISOString() } };
    } else {
      const cfg = { ...clone(body || {}) };
      if (cfg.clientSecret) cfg.clientSecret = '•'.repeat(8);
      integrationsConfig = { ...integrationsConfig, [provider]: { ...cfg, updated_at: new Date().toISOString() } };
    }
    return { ok: true };
  }
  if (verb === 'DELETE' && integrationMatch) {
    const provider = decodeURIComponent(integrationMatch[1]);
    integrationsConfig = Object.fromEntries(Object.entries(integrationsConfig).filter(([key]) => key !== provider));
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/admin/google-apps') return { apps: clone(demoGoogleApps) };
  if (verb === 'POST' && pathname === '/admin/google-apps') {
    // Mirrors backend/src/services/oauth/googleClientJson.js closely enough for the demo: same
    // shapes accepted/refused, same warning codes, so the admin screen behaves the same way here.
    const jsonText = typeof body?.clientJson === 'string' ? body.clientJson.trim() : '';
    let clientId = body?.clientId;
    let label = body?.label;
    let warnings = [];
    if (jsonText) {
      let data;
      try {
        data = JSON.parse(jsonText);
      } catch {
        throw demoError('The file is not valid JSON', 'client_json_invalid');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw demoError('The file is not valid JSON', 'client_json_invalid');
      if (data.type === 'service_account') throw demoError('This is a service account key, not an OAuth client', 'client_json_service_account');
      if (data.installed) throw demoError('This is a desktop (installed) OAuth client', 'client_json_not_web');
      const web = data.web;
      if (!web || typeof web !== 'object' || Array.isArray(web)) throw demoError('This is not a web OAuth client', 'client_json_not_web');
      const jsonClientId = typeof web.client_id === 'string' ? web.client_id.trim() : '';
      const jsonSecret = typeof web.client_secret === 'string' ? web.client_secret.trim() : '';
      if (!jsonClientId || !jsonSecret) throw demoError('The file is missing a client ID or client secret', 'client_json_incomplete');
      clientId = jsonClientId;
      if (!String(label ?? '').trim()) label = typeof web.project_id === 'string' ? web.project_id.trim() : '';
      const redirectUris = Array.isArray(web.redirect_uris) ? web.redirect_uris : [];
      const expected = integrationsConfig?.google?.redirectUri || null;
      if (!expected) warnings = [{ code: 'callback_not_configured' }];
      else if (!redirectUris.includes(expected)) warnings = [{ code: 'redirect_uri_missing', expected }];
    }
    const app = {
      id: `demo-google-app-${nextGoogleAppSequence++}`,
      label: String(label ?? '').trim() || 'Google app',
      clientId: String(clientId ?? '').trim(),
      projectNumber: null,
      userLimit: body?.userLimit ?? null,
      status: 'active',
      grantsCount: 0,
      reservedCount: 0,
      accountsCount: 0,
      full: false,
      createdAt: new Date().toISOString(),
    };
    demoGoogleApps = [...demoGoogleApps, app];
    return { app: clone(app), warnings };
  }
  const googleAppMatch = pathname.match(/^\/admin\/google-apps\/([^/]+)$/);
  if (verb === 'PATCH' && googleAppMatch) {
    const id = decodeURIComponent(googleAppMatch[1]);
    const app = demoGoogleApps.find(item => item.id === id);
    if (!app) throw demoError('Google app not found');
    if (body?.label !== undefined) app.label = String(body.label).trim();
    if (body?.userLimit !== undefined) app.userLimit = body.userLimit;
    if (body?.status !== undefined) app.status = body.status;
    return { app: clone(app) };
  }
  if (verb === 'DELETE' && googleAppMatch) {
    const id = decodeURIComponent(googleAppMatch[1]);
    demoGoogleApps = demoGoogleApps.filter(item => item.id !== id);
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/mail-node/config') {
    return { configured: true, mailHost: 'mail.demo.mailexpert.local', apiKey: '•'.repeat(8), quotaMb: 5120, diskPingUrl: '' };
  }
  if (verb === 'PUT' && pathname === '/mail-node/config') return { ok: true };
  if (verb === 'GET' && pathname === '/mail-node/domains') {
    // As on the server, an ordinary user sees only the domains a mailbox can be created on.
    if (demoRole() !== 'user') return clone({ domains: mailNodeDomains });
    return clone({
      domains: mailNodeDomains
        .filter(d => d.onNode && d.active && MAILBOX_READY_STATES.includes(d.state))
        .map(({ domain, active, state }) => ({ domain, active, state })),
    });
  }
  if (verb === 'POST' && pathname === '/mail-node/domains') {
    const domain = String(body?.domain || '').trim().toLowerCase();
    if (domain && !mailNodeDomains.some(d => d.domain === domain)) {
      const now = new Date().toISOString();
      mailNodeDomains = [...mailNodeDomains, demoDomain(
        { domain, active: true, maxMailboxes: Number(body?.mailboxes) || 500, mailboxes: 0 },
        { state: 'node_created', origin: 'created', addedAt: now, addedBy: DEMO_ADMIN_EMAIL, stateChangedAt: now },
      )].sort((a, b) => a.domain.localeCompare(b.domain));
    }
    return { ok: true, domain, state: 'node_created' };
  }
  const domainAction = pathname.match(/^\/mail-node\/domains\/([^/]+)\/(adopt|ready|restart|acknowledge|steps\/([^/]+))$/);
  if (verb === 'POST' && domainAction) {
    const action = domainAction[2].startsWith('steps/') ? 'step' : domainAction[2];
    const changed = changeMailNodeDomain(action, domainAction[1], domainAction[3] && decodeURIComponent(domainAction[3]));
    return { ok: true, domain: changed.domain, state: changed.state };
  }
  if (verb === 'GET' && pathname === '/mail-node/eop') return eopSettingsAnswer();
  if (verb === 'PUT' && pathname === '/mail-node/eop') {
    // The server's checks and normalization (utils/mailNode.js mirrors eopSettings.js).
    const { settings, error } = normalizeEopSettings(body);
    if (error) throw demoError('Invalid EOP setting', error);
    demoEopSettings = { ...demoEopSettings, ...settings };
    return eopSettingsAnswer();
  }
  if (verb === 'GET' && pathname === '/mail-node/mailboxes') {
    return clone({ disk: { usedPercent: 41, used: '16G', total: '40G', warn: false }, mailboxes: mailNodeMailboxes });
  }
  const quotaMatch = pathname.match(/^\/mail-node\/mailboxes\/([^/]+)\/quota$/);
  if (verb === 'PUT' && quotaMatch) {
    const id = decodeURIComponent(quotaMatch[1]);
    mailNodeMailboxes = mailNodeMailboxes.map(m => (m.accountId === id ? { ...m, quotaMb: Number(body?.quotaMb) } : m));
    return { ok: true, quotaMb: Number(body?.quotaMb) };
  }
  if (verb === 'GET' && pathname === '/update') return { updateAvailable: false };
  if (verb === 'GET' && pathname === '/version') return { version: '3.3.0-demo', sha: 'demo' };
  if ((verb === 'POST' && pathname === '/oauth/microsoft/device')
    || (verb === 'GET' && pathname === '/oauth/microsoft/device/poll')) {
    return { disabled: true, configured: false };
  }
  if (verb === 'GET' && pathname === '/ai/status') return { enabled: false, configured: false };
  if (verb === 'GET' && pathname === '/admin/audit') {
    const { searchParams } = url;
    const entries = AUDIT_FIXTURES.filter((entry) => (
      (!searchParams.get('account') || entry.accountId === searchParams.get('account'))
      && (!searchParams.get('user') || entry.actorUserId === searchParams.get('user'))
      && (!searchParams.get('action') || entry.action === searchParams.get('action'))
    ));
    return { entries: clone(entries), nextCursor: null };
  }
  if (verb === 'GET' && pathname === '/admin/access-sync') return clone(accessSync);
  if (verb === 'PUT' && pathname === '/admin/access-sync') {
    accessSync.config = {
      enabled: !!body.enabled,
      accountId: String(body.accountId ?? '').trim(),
      appId: String(body.appId ?? '').trim(),
      policyId: String(body.policyId ?? '').trim(),
      apiTokenSet: accessSync.config.apiTokenSet || !!String(body.apiToken ?? '').trim(),
    };
    return clone(accessSync);
  }
  if (verb === 'POST' && pathname === '/admin/access-sync/run') {
    if (!accessSync.config.enabled) return { result: { outcome: 'not_configured' }, ...clone(accessSync) };
    const now = new Date().toISOString();
    accessSync.lastRun = {
      trigger: 'manual', startedAt: now, finishedAt: now, outcome: 'unchanged',
      added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null,
    };
    return { result: clone(accessSync.lastRun), ...clone(accessSync) };
  }
  // GET /admin/ai answers { config }, not the unrelated { enabled, provider } shape (that one is
  // /ai/status above, a different route AdminPanel does not read this from).
  if (verb === 'GET' && pathname === '/admin/ai') return { config: clone(aiConfig) };
  if (verb === 'PATCH' && pathname === '/admin/ai') {
    const cfg = { ...clone(body || {}) };
    if (cfg.apiKey) cfg.apiKey = '•'.repeat(8);
    aiConfig = cfg;
    return { ok: true, config: clone(aiConfig) };
  }
  if (verb === 'DELETE' && pathname === '/admin/ai') { aiConfig = null; return { ok: true }; }
  // A real provider test/classify call cannot happen without a real AI provider behind it.
  if (verb === 'POST' && pathname === '/admin/ai/test') throw demoError('AI provider test is not available in demo mode');
  if (verb === 'POST' && pathname === '/admin/ai/codex/device') throw demoError('ChatGPT sign-in is not available in demo mode');
  if (verb === 'POST' && pathname === '/admin/ai/codex/device/poll') throw demoError('ChatGPT sign-in is not available in demo mode');
  if (verb === 'DELETE' && pathname === '/admin/ai/codex/device') return { ok: true };
  if (verb === 'DELETE' && pathname === '/admin/ai/codex') return { status: 'disconnected' };
  if (verb === 'GET' && pathname === '/todoist/status') return { connected: false };
  if (verb === 'GET' && pathname === '/todoist/projects') return { projects: [] };
  if (verb === 'GET' && pathname === '/todoist/labels') return { labels: [] };
  if (verb === 'POST' && pathname === '/todoist/connect') throw demoError('Todoist is not available in demo mode');
  if (verb === 'DELETE' && pathname === '/todoist/disconnect') return { ok: true };
  if (verb === 'POST' && pathname === '/todoist/tasks') throw demoError('Todoist is not available in demo mode');

  if (verb === 'GET' && pathname === '/rules') return clone(demoRules);
  if (verb === 'POST' && pathname === '/rules') {
    const rule = {
      id: `demo-rule-${nextRuleSequence++}`,
      created_by: 'demo-user',
      account_id: body?.accountId ?? null,
      name: String(body?.name ?? '').trim() || 'Untitled rule',
      enabled: body?.enabled !== false,
      stop_processing: !!body?.stopProcessing,
      priority: demoRules.length,
      condition_logic: body?.conditionLogic || 'all',
      conditions: body?.conditions || [],
      actions: body?.actions || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    demoRules = [...demoRules, rule];
    return clone(rule);
  }
  const ruleMatch = pathname.match(/^\/rules\/([^/]+)$/);
  if (verb === 'PUT' && ruleMatch) {
    const rule = demoRules.find(item => item.id === decodeURIComponent(ruleMatch[1]));
    if (!rule) throw demoError('Rule not found');
    Object.assign(rule, {
      name: body?.name ?? rule.name,
      enabled: body?.enabled ?? rule.enabled,
      stop_processing: body?.stopProcessing ?? rule.stop_processing,
      condition_logic: body?.conditionLogic ?? rule.condition_logic,
      conditions: body?.conditions ?? rule.conditions,
      actions: body?.actions ?? rule.actions,
      updated_at: new Date().toISOString(),
    });
    return clone(rule);
  }
  if (verb === 'DELETE' && ruleMatch) {
    demoRules = demoRules.filter(item => item.id !== decodeURIComponent(ruleMatch[1]));
    return { ok: true };
  }
  if (verb === 'PATCH' && pathname === '/rules/reorder') {
    const order = Array.isArray(body?.ids) ? body.ids : [];
    demoRules = order.map(id => demoRules.find(item => item.id === id)).filter(Boolean)
      .concat(demoRules.filter(item => !order.includes(item.id)))
      .map((rule, index) => ({ ...rule, priority: index }));
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/rules/run') {
    // The real server runs rules server-side and reports progress over the WebSocket the demo
    // doesn't have; fire the same completion event the UI listens for, once, shortly after.
    const accountId = body?.accountId;
    const processed = messages.filter(item => item.folder === 'INBOX' && (!accountId || item.account_id === accountId)).length;
    setTimeout(() => {
      try { window.dispatchEvent(new CustomEvent('mailexpert:rules-run-complete', { detail: { ok: true, processed, matched: 0 } })); } catch { /* no window (tests) */ }
    }, 300);
    return { ok: true, started: true };
  }

  if (verb === 'GET' && pathname === '/block-list') return clone(demoBlockList);
  if (verb === 'POST' && pathname === '/block-list') {
    const accountId = body?.accountId;
    const emailAddress = normalizeEmail(body?.emailAddress);
    const existing = demoBlockList.find(item => item.account_id === accountId && item.email_address === emailAddress);
    if (existing) return clone(existing);
    const entry = { id: `demo-block-${nextBlockListSequence++}`, account_id: accountId, email_address: emailAddress, created_at: new Date().toISOString() };
    demoBlockList = [...demoBlockList, entry];
    return clone(entry);
  }
  const blockListMatch = pathname.match(/^\/block-list\/([^/]+)$/);
  if (verb === 'DELETE' && blockListMatch) {
    demoBlockList = demoBlockList.filter(item => item.id !== decodeURIComponent(blockListMatch[1]));
    return { ok: true };
  }

  if (verb === 'GET' && pathname === '/categories/sources') return { sources: clone(categorySources), builtinSets: ['social_networks', 'developer_platforms'] };
  if (verb === 'POST' && pathname === '/categories/sources') {
    const source = {
      id: `demo-source-${nextCategorySourceSequence++}`,
      source_type: body?.sourceType,
      value: String(body?.value ?? '').trim().toLowerCase(),
      label: body?.label ?? null,
      enabled: true,
      last_fetched_at: null,
      fetch_ok: null,
      fetch_error: null,
      created_at: new Date().toISOString(),
    };
    categorySources = [...categorySources, source];
    return { source: clone(source) };
  }
  const categorySourceMatch = pathname.match(/^\/categories\/sources\/([^/]+)$/);
  if (verb === 'PATCH' && categorySourceMatch) {
    const source = categorySources.find(item => item.id === decodeURIComponent(categorySourceMatch[1]));
    if (!source) throw demoError('Source not found');
    if (body?.enabled !== undefined) source.enabled = !!body.enabled;
    return { source: clone(source) };
  }
  if (verb === 'DELETE' && categorySourceMatch) {
    categorySources = categorySources.filter(item => item.id !== decodeURIComponent(categorySourceMatch[1]));
    return { ok: true };
  }
  const categorySourceRefreshMatch = pathname.match(/^\/categories\/sources\/([^/]+)\/refresh$/);
  if (verb === 'POST' && categorySourceRefreshMatch) {
    const source = categorySources.find(item => item.id === decodeURIComponent(categorySourceRefreshMatch[1]));
    if (!source) throw demoError('Source not found');
    if (source.source_type !== 'url') return { ok: true, domainCount: 0, error: 'Only URL sources can be refreshed' };
    source.last_fetched_at = new Date().toISOString();
    source.fetch_ok = true;
    source.fetch_error = null;
    return { ok: true, domainCount: 12, error: null };
  }
  const recategorizeMatch = pathname.match(/^\/categories\/recategorize\/([^/]+)$/);
  if (verb === 'POST' && recategorizeMatch) return { ok: true };
  // A real classification call needs a real AI provider behind it.
  const aiClassifyMatch = pathname.match(/^\/categories\/ai-classify\/([^/]+)$/);
  if (verb === 'POST' && aiClassifyMatch) throw demoError('AI classification is not available in demo mode');

  if (verb === 'GET' && pathname === '/gtd/sections') return { sections: [] };
  if (verb === 'GET' && pathname === '/plugins') return clone(pluginsState);
  const pluginMatch = pathname.match(/^\/plugins\/([^/]+)$/);
  if (verb === 'PATCH' && pluginMatch) {
    const id = decodeURIComponent(pluginMatch[1]);
    const plugin = pluginsState.find(item => item.id === id);
    if (!plugin) throw demoError('Plugin not found');
    plugin.activated = !!body?.activated;
    return { id: plugin.id, activated: plugin.activated };
  }

  // ── Admin settings screens ────────────────────────────────────────────────
  if (verb === 'GET' && pathname === '/admin/settings') return { settings: clone(systemSettings) };
  if (verb === 'PATCH' && pathname === '/admin/settings') {
    for (const [key, value] of Object.entries(body || {})) {
      if (value === undefined) continue;
      systemSettings[key] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    }
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/admin/users') return { users: clone(adminUsers), total: adminUsers.length };
  if (verb === 'POST' && pathname === '/admin/users') {
    const email = normalizeEmail(body?.email);
    if (!email) throw demoError('A valid email address is required', 'email_invalid');
    if (adminUsers.some(u => normalizeEmail(u.email) === email)) throw demoError('A user with this email already exists', 'user_exists');
    const user = {
      id: `demo-added-user-${nextInviteSequence++}`, username: email, email,
      isAdmin: false, totpEnabled: false, disabledAt: null, created_at: new Date().toISOString(), isBootstrapAdmin: false,
    };
    adminUsers = [...adminUsers, user];
    return { user: clone(user) };
  }
  const adminUserMatch = pathname.match(/^\/admin\/users\/([^/]+)$/);
  if (verb === 'PATCH' && adminUserMatch) {
    const id = decodeURIComponent(adminUserMatch[1]);
    const user = adminUsers.find(item => item.id === id);
    if (!user) throw demoError('User not found');
    if (id === 'demo-user' && body?.isAdmin === false) throw demoError('Cannot remove your own admin status', 'self_change');
    if (id === 'demo-user' && body?.disabled === true) throw demoError('Cannot disable your own account', 'self_change');
    if (body?.isAdmin !== undefined) user.isAdmin = !!body.isAdmin;
    if (body?.disabled !== undefined) user.disabledAt = body.disabled ? new Date().toISOString() : null;
    if (body?.email !== undefined) user.email = normalizeEmail(body.email) || null;
    return { ok: true, user: clone(user) };
  }
  if (verb === 'DELETE' && adminUserMatch) {
    const id = decodeURIComponent(adminUserMatch[1]);
    if (id === 'demo-user') throw demoError('Cannot delete your own account');
    adminUsers = adminUsers.filter(item => item.id !== id);
    return { ok: true };
  }
  const totpDisableMatch = pathname.match(/^\/admin\/users\/([^/]+)\/totp\/disable$/);
  if (verb === 'POST' && totpDisableMatch) {
    const id = decodeURIComponent(totpDisableMatch[1]);
    if (id === 'demo-user') throw demoError('Use your account settings to manage your own 2FA.');
    const user = adminUsers.find(item => item.id === id);
    if (!user) throw demoError('User not found');
    user.totpEnabled = false;
    return { ok: true };
  }

  if (verb === 'GET' && pathname === '/admin/invites') return { invites: clone(demoInvites), total: demoInvites.length };
  if (verb === 'POST' && pathname === '/admin/invites') {
    const email = String(body?.email ?? '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw demoError('Valid email address required');
    const invite = {
      id: `demo-invite-${nextInviteSequence++}`, email: email.toLowerCase(),
      token: `demo-token-${nextInviteSequence}`, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), used_at: null, used_by_username: null,
    };
    demoInvites = [invite, ...demoInvites];
    return { ok: true, inviteUrl: `https://demo.mailexpert.local/register?invite=${invite.token}`, emailSent: false, emailError: null };
  }
  const inviteMatch = pathname.match(/^\/admin\/invites\/([^/]+)$/);
  if (verb === 'DELETE' && inviteMatch) {
    demoInvites = demoInvites.filter(item => item.id !== decodeURIComponent(inviteMatch[1]));
    return { ok: true };
  }

  if (verb === 'GET' && pathname === '/admin/auth-events') return { events: clone(AUTH_EVENT_FIXTURES), total: AUTH_EVENT_FIXTURES.length };

  if (verb === 'GET' && pathname === '/admin/system-email') {
    if (!systemEmailConfig) return { config: null };
    return { config: { ...clone(systemEmailConfig), pass: systemEmailConfig.pass ? '••••••••' : '' } };
  }
  if (verb === 'POST' && pathname === '/admin/system-email') {
    const { host, user } = body || {};
    if (!host || !user) throw demoError('SMTP host and username are required');
    systemEmailConfig = clone(body);
    return { ok: true };
  }
  // A real SMTP handshake cannot happen without a real mail server behind it.
  if (verb === 'POST' && pathname === '/admin/system-email/test') throw demoError('Sending a test email is not available in demo mode');
  if (verb === 'DELETE' && pathname === '/admin/system-email') { systemEmailConfig = null; return { ok: true }; }

  if (verb === 'GET' && pathname === '/admin/oidc') return { providers: clone(demoOidcProviders) };
  if (verb === 'POST' && pathname === '/admin/oidc') {
    const { name, slug, issuer_url, client_id, client_secret } = body || {};
    if (!name || !slug || !issuer_url || !client_id || !client_secret) throw demoError('name, slug, issuer_url, client_id and client_secret are required');
    if (demoOidcProviders.some(p => p.slug === slug)) throw demoError('A provider with this slug already exists', 'slug_taken');
    const provider = {
      id: `demo-oidc-${nextOidcSequence++}`, name, slug, issuer_url, client_id,
      scopes: body.scopes || 'openid email profile', provisioning_mode: body.provisioning_mode || 'login_existing_only',
      allowed_domains: body.allowed_domains ?? null, enabled: body.enabled !== false,
      require_email_verified: body.require_email_verified !== false, allow_insecure: !!body.allow_insecure,
      admin_group_claim: body.admin_group_claim ?? null, admin_group_value: body.admin_group_value ?? null,
      rp_initiated_logout: !!body.rp_initiated_logout, login_match_claim: body.login_match_claim || 'email',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    demoOidcProviders = [...demoOidcProviders, provider];
    return { provider: clone(provider) };
  }
  const oidcProviderMatch = pathname.match(/^\/admin\/oidc\/([^/]+)$/);
  if (verb === 'PATCH' && oidcProviderMatch) {
    const provider = demoOidcProviders.find(item => item.id === decodeURIComponent(oidcProviderMatch[1]));
    if (!provider) throw demoError('Provider not found');
    for (const [key, value] of Object.entries(body || {})) {
      if (key === 'client_secret' && (!value || value === '••••••••')) continue;
      provider[key] = value;
    }
    provider.updated_at = new Date().toISOString();
    return { provider: clone(provider) };
  }
  if (verb === 'DELETE' && oidcProviderMatch) {
    const id = decodeURIComponent(oidcProviderMatch[1]);
    const provider = demoOidcProviders.find(item => item.id === id);
    const remainingEnabled = demoOidcProviders.filter(item => item.id !== id && item.enabled).length;
    if (provider?.enabled && remainingEnabled === 0 && systemSettings.internal_auth_disabled === 'true') {
      throw demoError('Cannot remove the last SSO provider while password login is disabled');
    }
    demoOidcProviders = demoOidcProviders.filter(item => item.id !== id);
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/admin/ai/codex/status') return { connected: false, state: 'disconnected', reconnectRequired: false };

  // ── Account security / SSO screens ────────────────────────────────────────
  // No OIDC login ever really happens in the demo, so no identity is ever linked — an empty
  // list is the real shape for an account that never signed in through SSO, not a fallback.
  if (verb === 'GET' && pathname === '/auth/oidc/identities') return { identities: [] };
  const oidcIdentityMatch = pathname.match(/^\/auth\/oidc\/identities\/([^/]+)$/);
  if (verb === 'DELETE' && oidcIdentityMatch) throw demoError('Cannot unlink your only login method. Set a password first.');
  if (verb === 'GET' && pathname === '/auth/oidc/providers') {
    return { providers: demoOidcProviders.filter(p => p.enabled).map(p => ({ id: p.id, name: p.name, slug: p.slug })) };
  }
  if (verb === 'GET' && pathname === '/auth/profile/recovery-email') return { email: recoveryEmailValue };
  if (verb === 'PATCH' && pathname === '/auth/profile/recovery-email') {
    const email = body?.email;
    if (email === undefined) throw demoError('email required');
    const trimmed = email ? String(email).trim().toLowerCase() : null;
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw demoError('Invalid email address');
    recoveryEmailValue = trimmed || null;
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/auth/registration-status') {
    return { open: systemSettings.registration_open === 'true', internalAuthDisabled: systemSettings.internal_auth_disabled === 'true' };
  }
  // The real server answers 503 when no VAPID keys are configured; the demo never has any, and
  // usePushNotifications already reads that rejection as "push unavailable here" — so the
  // subscribe/unsubscribe toggle this gates is never reachable either.
  if (verb === 'GET' && pathname === '/auth/push/vapid-key') throw demoError('Push notifications are not configured on this server.');
  if (verb === 'POST' && pathname === '/auth/push/subscribe') throw demoError('Push notifications are not configured on this server.');
  if (verb === 'POST' && pathname === '/auth/push/unsubscribe') throw demoError('Push notifications are not configured on this server.');
  // Forced-enrollment 2FA setup/enable only exist mid-login (a pending, unauthenticated
  // session); the demo is always already signed in, so this matches the real server's own
  // refusal for both the GET that starts it and the POST that would complete it.
  if (verb === 'GET' && pathname === '/auth/2fa/enrollment/setup') throw demoError('No pending enrollment');
  if (verb === 'POST' && pathname === '/auth/2fa/enrollment/enable') throw demoError('No pending enrollment');
  if (verb === 'GET' && pathname === '/totp/setup') {
    if (demoTotpEnabled) throw demoError('Two-factor authentication is already enabled.');
    return { secret: DEMO_TOTP_SECRET, qrCode: DEMO_TOTP_QR_DATA_URL };
  }
  if (verb === 'POST' && pathname === '/totp/enable') {
    if (!body?.code) throw demoError('Code required');
    demoTotpEnabled = true;
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/totp/disable') { demoTotpEnabled = false; return { ok: true }; }
  if (verb === 'POST' && pathname === '/totp/cancel') return { ok: true };
  if (verb === 'POST' && pathname === '/auth/preferences/whitelist-add') return { ok: true };

  // ── Session / profile ──────────────────────────────────────────────────────
  if (verb === 'POST' && pathname === '/auth/logout') return { ok: true, endSessionUrl: null };
  if (verb === 'POST' && pathname === '/auth/lock') return { ok: true };
  // directApi.unlock() in utils/api.js returns this demo answer straight to the caller (it
  // bypasses the generic request() wrapper); frontend/src/utils/api.demo.test.js pins this shape.
  if (verb === 'POST' && pathname === '/auth/unlock') return { ok: true };
  if (verb === 'POST' && pathname === '/auth/lock-pin') return { ok: true };
  if (verb === 'DELETE' && pathname === '/auth/lock-pin') return { ok: true };
  if (verb === 'PATCH' && pathname === '/auth/profile') {
    if (body?.displayName !== undefined) profileOverrides.displayName = body.displayName || null;
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/auth/avatar') { profileOverrides.avatar = body?.avatar ?? null; return { ok: true }; }
  if (verb === 'DELETE' && pathname === '/auth/avatar') { profileOverrides.avatar = null; return { ok: true }; }

  // ── Mailbox cleanup ────────────────────────────────────────────────────────
  if (verb === 'GET' && pathname === '/mail/mailbox-usage') return clone(mailboxUsageFor(url.searchParams.get('accountId')));
  if (verb === 'GET' && pathname === '/mail/cleanup-preview') {
    return clone(cleanupPreviewFor(url.searchParams.get('accountId'), url.searchParams.get('fromEmail')));
  }

  // No pet was ever imported in the demo (GtdSettings' import flow has nothing to upload to),
  // so this matches the real 404 a slug with no stored pet gets; importing one is unavailable
  // for the same reason — there's nowhere in the demo to store it.
  const petMetaMatch = pathname.match(/^\/gtd\/pet\/([^/]+)\/meta$/);
  if (verb === 'GET' && petMetaMatch) throw demoError('Pet not found');
  if (verb === 'POST' && pathname === '/gtd/pet/import') throw demoError('Importing a pet is not available in demo mode');

  // ── GTD classify / done / folders ──────────────────────────────────────────
  const DEFAULT_GTD_FOLDERS = { next: 'GTD/Next', waiting: 'GTD/Waiting', someday: 'GTD/Someday' };
  if (verb === 'POST' && pathname === '/gtd/classify') {
    const { messageId, state } = body || {};
    const folder = DEFAULT_GTD_FOLDERS[state] || `GTD/${state}`;
    return { ok: true, folder, applied: true, undoToken: { messageId, state, folder, uid: 1 } };
  }
  if (verb === 'POST' && pathname === '/gtd/classify/undo') {
    return { ok: true, removed: true, folder: DEFAULT_GTD_FOLDERS[body?.state] || null };
  }
  if (verb === 'DELETE' && pathname === '/gtd/classify') {
    return { ok: true, removed: true, folder: DEFAULT_GTD_FOLDERS[body?.state] || null };
  }
  if (verb === 'POST' && pathname === '/gtd/done') {
    const item = messageById(body?.id);
    if (item) { item.folder = 'Archive'; item.is_read = true; }
    return { ok: true, removed: [], archived: true, noArchiveFolder: false, archiveFailed: false };
  }
  if (verb === 'POST' && pathname === '/gtd/folders/ensure') {
    const folders = Array.isArray(body?.folders) ? body.folders : [];
    return { results: folders.map(folder => ({ folder, path: folder, created: true })) };
  }

  // An unhandled request must fail like a real failed request the UI already knows how to
  // handle, never silently succeed with a shape the caller doesn't expect (see request() in
  // utils/api.js) — this covers both GET and every write with no answer above, including the
  // ones deliberately left unhandled because the demo has nothing real behind them (login,
  // register, forgot/reset password, the pre-login 2FA challenge/OTP steps, and anything else
  // routeCoverage.test.js lists in its REJECTED table).
  throw demoError('Not available in demo mode');
}
