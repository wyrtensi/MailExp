// The Microsoft tenant of the demo (stage 7a; backend routes/mailNodeTenant.js and
// services/tenant/*): a fake tenant driver that is connected. The jobs finish at once; the
// answers are the backend fakes' recorded examples (services/tenant/fixtures.json): the Default
// anti-spam policy quarantines phishing, which the connection test only reads (one conflict) and
// the poll sets to MoveToJmf as the backend does (section 5.14), no connector is blocked, and the
// application certificate expires in 25 days, so the warning and its alert show. Stage 7b: the
// poll reads both connectors (the first read is the reference, nothing drifted), "Take as the
// reference" works, and a domain's "Run the tenant steps now" finishes at once without changing
// it: the demo's domains keep their manual onboarding.

const DAY_MS = 86400000;
const STARTED = Date.now();

export const DEMO_TENANT_SETTINGS = Object.freeze({
  tenantId: '11111111-2222-4333-8444-555555555555',
  tenantDomain: 'contoso.onmicrosoft.com',
  appId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  certThumbprint: '3F2A9C4D5E6B7A8C9D0E1F2A3B4C5D6E7F8A9B0C',
});

const CERTIFICATE = {
  thumbprint: DEMO_TENANT_SETTINGS.certThumbprint,
  subject: 'CN=mailexpert-tenant',
  notBefore: new Date(STARTED - 340 * DAY_MS).toISOString(),
  notAfter: new Date(STARTED + 25 * DAY_MS).toISOString(),
};

// The tenant's Default policy, changed by the demo's enforcement as the tenant would keep it.
const policy = {
  identity: 'Default', SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'MoveToJmf', BulkSpamAction: 'MoveToJmf',
  PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', BulkThreshold: 7, RedirectToRecipients: [], WhenChanged: null,
};
// What fits the spam filing of the node (backend services/tenant/antispam.js), and the fields the
// panel sets to MoveToJmf (section 5.14).
const EXPECTED = {
  SpamAction: ['MoveToJmf'], HighConfidenceSpamAction: ['MoveToJmf'], BulkSpamAction: ['MoveToJmf', 'AddXHeader'],
  PhishSpamAction: ['MoveToJmf'], HighConfidencePhishAction: ['Quarantine'],
};
const ENFORCED = ['SpamAction', 'HighConfidenceSpamAction', 'PhishSpamAction'];
function conflicts(policy) {
  return Object.entries(EXPECTED)
    .filter(([field, expected]) => policy[field] && !expected.includes(policy[field]))
    .map(([field, expected]) => ({
      field, action: policy[field], expected,
      code: policy[field] === 'Quarantine' ? 'quarantined' : 'unexpected', severity: 'warning',
    }));
}

const KINDS = {
  test: 'tenant_test_connection', poll: 'tenant_poll', antispam: 'tenant_antispam_read', domain: 'tenant_domain_sync', phish: 'tenant_quarantine_release',
};
// The connectors as the backend summarizes them (services/tenant/connectors.js).
const CONNECTORS = {
  inbound: [{
    name: 'From mail node',
    properties: {
      Enabled: true, ConnectorType: 'onpremises', RequireTls: true, RestrictDomainsToCertificate: false, RestrictDomainsToIPAddresses: false,
      TlsSenderCertificateName: 'mail.demo.mailexpert.local', SenderDomains: ['smtp:*;1'], SenderIPAddresses: [], TreatMessagesAsInternal: false,
      CloudServicesMailEnabled: false,
    },
  }],
  outbound: [{
    name: 'To mail node',
    properties: {
      Enabled: true, ConnectorType: 'onpremises', SmartHosts: ['mail.demo.mailexpert.local'], UseMXRecord: false, TlsSettings: 'domainvalidation',
      TlsDomain: 'mail.demo.mailexpert.local', AllAcceptedDomains: false, IsTransportRuleScoped: false, CloudServicesMailEnabled: false,
    },
    recipientDomains: ['demo.mailexpert.local'],
  }],
};
let nextJobId = 9001;
const jobs = new Map();
let state = {};

const iso = (ms) => new Date(ms).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const configured = (settings) => !!(settings.tenantId && settings.tenantDomain && settings.appId && settings.certThumbprint);

function runTest(settings, now) {
  const at = iso(now);
  const steps = {};
  steps.certificate = settings.certThumbprint === CERTIFICATE.thumbprint
    ? { ok: true, notAfter: CERTIFICATE.notAfter }
    : { ok: false, code: 'certificate_mismatch', message: 'The worker holds another certificate than the thumbprint in the settings', workerThumbprint: CERTIFICATE.thumbprint };
  if (steps.certificate.ok) {
    steps.graph = settings.tenantDomain === DEMO_TENANT_SETTINGS.tenantDomain
      ? { ok: true, domains: 2, initialDomain: DEMO_TENANT_SETTINGS.tenantDomain }
      : { ok: false, code: 'tenant_domain_mismatch', message: 'The tenant\'s initial domain is not the one in the settings', initialDomain: DEMO_TENANT_SETTINGS.tenantDomain };
    steps.exo = { ok: true, organization: DEMO_TENANT_SETTINGS.tenantDomain, displayName: 'Contoso' };
  }
  const ok = ['certificate', 'graph', 'exo'].every((step) => steps[step]?.ok);
  state = {
    ...state,
    connection: { at, ok, steps, by: null },
    certificate: { at, ...CERTIFICATE },
    ...(steps.exo?.ok ? { antispam: readPolicy(now) } : {}),
  };
}

function readPolicy(now) {
  return { at: iso(now), ok: true, policy: { ...policy }, conflicts: conflicts(policy) };
}

// The backend's syncAntispam: what differs is set to MoveToJmf and read again.
function syncPolicy(now) {
  const changed = ENFORCED.filter((field) => policy[field] && policy[field] !== 'MoveToJmf')
    .map((field) => ({ field, from: policy[field], to: 'MoveToJmf' }));
  for (const { field } of changed) policy[field] = 'MoveToJmf';
  return { ...readPolicy(now), enforcement: { at: iso(now), ok: true, changed, failed: [] } };
}

function runPoll(now) {
  const at = iso(now);
  const connectors = { at, ok: true, ...clone(CONNECTORS) };
  state = {
    ...state, certificate: { at, ...CERTIFICATE }, blockedConnectors: { at, ok: true, items: [] }, connectors,
    ...(state.connectorReference ? {} : { connectorReference: { at, by: null, auto: true, inbound: connectors.inbound, outbound: connectors.outbound } }),
  };
  if (!state.antispam || !state.antispam.enforcement) state.antispam = syncPolicy(now);
}

function finish(kind, settings) {
  const now = Date.now();
  if (kind === KINDS.test) runTest(settings, now);
  if (kind === KINDS.poll) runPoll(now);
  if (kind === KINDS.antispam) state = { ...state, antispam: syncPolicy(now) };
  const job = { id: String(nextJobId++), kind, status: 'done', errorCode: null, error: null, createdAt: iso(now), updatedAt: iso(now) };
  jobs.set(job.id, job);
  return job;
}

const latest = (kind) => [...jobs.values()].filter((job) => job.kind === kind).at(-1) ?? null;

// Stage 7c (R-42), widened in section 5.14: the release of quarantined spam and phishing, on as on
// a new install, with an earlier run of 8 minutes ago: high confidence phishing and spam released
// to demo mailboxes, a message kept because a recipient is not on the node (it raises the
// tenant_phish_held alert), one that left the quarantine.
const QID = (n) => [`c14401cf-aa9a-465b-cfd5-00000000000${n}`, `4c2ca98e-94ea-db3a-7eb8-00000000000${n}`].join('\\');
const heldRow = (row) => (row.state === 'skipped' && row.reason !== 'gone') || (row.state === 'failed' && row.reason === 'attempts_exhausted');
let phish = {
  enabled: true,
  changedAt: null,
  run: {
    at: iso(STARTED - 8 * 60000), ok: true, counts: { released: 2, skipped: 1, failed: 0, waiting: 0, gone: 0, busy: 0, ruleWaiting: 0 }, left: false,
    rule: { state: 'ok' },
  },
  rows: [
    {
      identity: QID(4), type: 'Spam', messageId: '<offer-12@deals.example.com>', sender: 'offers@deals.example.com', subject: 'Limited offer for your team',
      recipients: ['sales@demo.mailexpert.local'], receivedAt: iso(STARTED - 40 * 60000), expiresAt: iso(STARTED + 29 * DAY_MS),
      state: 'released', reason: null, error: null, attempts: 1, byPanel: true, releasedAt: iso(STARTED - 8 * 60000), updatedAt: iso(STARTED - 8 * 60000),
    },
    {
      identity: QID(1), type: 'HighConfPhish', messageId: '<invoice-7781@billing.example.net>', sender: 'billing@billing.example.net', subject: 'Your invoice is overdue',
      recipients: ['info@demo.mailexpert.local'], receivedAt: iso(STARTED - 50 * 60000), expiresAt: iso(STARTED + 29 * DAY_MS),
      state: 'released', reason: null, error: null, attempts: 1, byPanel: true, releasedAt: iso(STARTED - 8 * 60000), updatedAt: iso(STARTED - 8 * 60000),
    },
    {
      identity: QID(2), type: 'Phish', messageId: '<reset-55@login.example.org>', sender: 'security@login.example.org', subject: 'Password reset required',
      recipients: ['info@demo.mailexpert.local', 'partner@example.org'], receivedAt: iso(STARTED - 3 * 3600000), expiresAt: iso(STARTED + 29 * DAY_MS),
      state: 'skipped', reason: 'foreign_recipients', error: null, attempts: 0, byPanel: false, releasedAt: null, updatedAt: iso(STARTED - 3 * 3600000),
    },
    {
      identity: QID(3), type: 'HighConfPhish', messageId: '<old-1@example.net>', sender: 'noreply@example.net', subject: 'Account notice',
      recipients: ['sales@demo.mailexpert.local'], receivedAt: iso(STARTED - 31 * DAY_MS), expiresAt: iso(STARTED - DAY_MS),
      state: 'skipped', reason: 'gone', error: null, attempts: 0, byPanel: false, releasedAt: null, updatedAt: iso(STARTED - DAY_MS),
    },
  ],
};

// The demo's test of three hours ago and its latest poll (job 9001), as if the tenant had been
// connected for a while.
runTest(DEMO_TENANT_SETTINGS, STARTED - 3 * 3600000);
finish(KINDS.poll, DEMO_TENANT_SETTINGS);

// The alerts of the tenant for the demo's alert check (backend nodeAlerts.js tenantSignals).
export function demoTenantAlerts(settings, now = Date.now()) {
  if (!configured(settings)) return [];
  const alerts = [];
  const notAfter = Date.parse(CERTIFICATE.notAfter);
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (daysLeft < 30) {
    alerts.push({
      key: 'tenant_certificate', severity: daysLeft < 14 ? 'error' : 'warning',
      details: { code: notAfter <= now ? 'cert_expired' : 'cert_expiring', daysLeft, notAfter: CERTIFICATE.notAfter, thumbprint: CERTIFICATE.thumbprint },
    });
  }
  // R-42: phishing kept in the quarantine and still there.
  const held = phish.rows.filter((row) => heldRow(row) && Date.parse(row.expiresAt) > now);
  if (held.length) {
    alerts.push({ key: 'tenant_phish_held', severity: 'warning', details: { count: held.length, soonestExpiresAt: held.map((r) => r.expiresAt).sort()[0] } });
  }
  return alerts;
}

// Answers a /mail-node/tenant request, or undefined when the path is not one. error(message,
// code) builds the demo's refusal.
export function demoTenantRequest(verb, pathname, settings, error, body = null) {
  if (verb === 'GET' && pathname === '/mail-node/tenant') {
    return clone({
      driver: 'fake', profileWithoutDriver: false, configured: configured(settings), state, connectorDrift: [],
      jobs: { test: latest(KINDS.test), antispam: latest(KINDS.antispam), poll: latest(KINDS.poll) },
    });
  }
  const button = /^\/mail-node\/tenant\/(test|poll|antispam)$/.exec(pathname);
  if (verb === 'POST' && button) {
    if (!configured(settings)) {
      throw error('Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first', 'tenant_not_configured');
    }
    return clone({ job: finish(KINDS[button[1]], settings), created: true });
  }
  const domainSync = /^\/mail-node\/tenant\/domains\/([^/]+)\/sync$/.exec(pathname);
  if (verb === 'POST' && domainSync) {
    if (!configured(settings)) {
      throw error('Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first', 'tenant_not_configured');
    }
    return clone({ job: finish(KINDS.domain, settings), created: true });
  }
  // The demo's domains keep their manual onboarding: the hold and the approval answer, change nothing.
  const hold = /^\/mail-node\/tenant\/domains\/([^/]+)\/hold$/.exec(pathname);
  if (verb === 'POST' && hold) return clone({ domain: decodeURIComponent(hold[1]), holdInternalRelay: true });
  // Section 5.14: the demo's domains hold no alias contacts.
  if (verb === 'POST' && /^\/mail-node\/tenant\/domains\/[^/]+\/alias-contacts\/remove$/.test(pathname)) {
    throw error('The domain holds no alias contacts for a decision', 'alias_contacts_not_held');
  }
  if (verb === 'POST' && /^\/mail-node\/tenant\/domains\/[^/]+\/internal-relay$/.test(pathname)) {
    throw error('The domain does not wait for this decision', 'internal_relay_not_needed');
  }
  if (verb === 'POST' && pathname === '/mail-node/tenant/connectors/reference') {
    if (!state.connectors?.ok) throw error('The connectors have not been read yet: check now first', 'connectors_not_read');
    const at = iso(Date.now());
    state = { ...state, connectorReference: { at, readAt: state.connectors.at, by: null, auto: false, inbound: state.connectors.inbound, outbound: state.connectors.outbound } };
    return clone({ reference: state.connectorReference });
  }
  // Stage 7c (R-42): the phishing released from EOP's quarantine.
  if (verb === 'GET' && pathname === '/mail-node/tenant/phish-release') {
    return clone({
      enabled: phish.enabled, changedAt: phish.changedAt, run: phish.run, held: { count: phish.rows.filter(heldRow).length, soonestExpiresAt: null },
      releases: phish.rows, job: latest(KINDS.phish),
    });
  }
  if (verb === 'PUT' && pathname === '/mail-node/tenant/phish-release') {
    phish = { ...phish, enabled: !!body?.enabled, changedAt: iso(Date.now()) };
    return clone({ enabled: phish.enabled, changedAt: phish.changedAt });
  }
  if (verb === 'POST' && pathname === '/mail-node/tenant/phish-release/run') {
    if (!configured(settings)) {
      throw error('Fill in the tenant ID, its onmicrosoft.com domain, the application ID and the certificate thumbprint first', 'tenant_not_configured');
    }
    if (!phish.enabled) throw error('The release of quarantined spam and phishing is paused', 'phish_release_paused');
    phish = { ...phish, run: { ...phish.run, at: iso(Date.now()), counts: { released: 0, skipped: 0, failed: 0, waiting: 0, gone: 0, busy: 0 }, left: false } };
    return clone({ job: finish(KINDS.phish, settings), created: true });
  }
  const job = /^\/mail-node\/tenant\/jobs\/([^/]+)$/.exec(pathname);
  if (verb === 'GET' && job) {
    const found = jobs.get(decodeURIComponent(job[1]));
    if (!found) throw error('No such tenant job', 'tenant_job_not_found');
    return clone({ job: found });
  }
  return undefined;
}
