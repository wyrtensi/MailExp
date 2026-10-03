// The Microsoft tenant of the demo (stage 7a; backend routes/mailNodeTenant.js and
// services/tenant/*): a fake tenant driver that is connected. The jobs finish at once; the
// answers are the backend fakes' recorded examples (services/tenant/fixtures.json): the Default
// anti-spam policy quarantines phishing (one conflict), no connector is blocked, and the
// application certificate expires in 25 days, so the warning and its alert show.

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

const POLICY = {
  identity: 'Default', SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'MoveToJmf', BulkSpamAction: 'MoveToJmf',
  PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', BulkThreshold: 7, RedirectToRecipients: [], WhenChanged: null,
};
// What fits the spam filing of the node (backend services/tenant/antispam.js).
const EXPECTED = {
  SpamAction: ['MoveToJmf', 'AddXHeader'], HighConfidenceSpamAction: ['MoveToJmf', 'AddXHeader'], BulkSpamAction: ['MoveToJmf', 'AddXHeader'],
  PhishSpamAction: ['MoveToJmf', 'AddXHeader'], HighConfidencePhishAction: ['Quarantine'],
};
function conflicts(policy) {
  return Object.entries(EXPECTED)
    .filter(([field, expected]) => policy[field] && !expected.includes(policy[field]))
    .map(([field, expected]) => ({
      field, action: policy[field], expected,
      code: policy[field] === 'Quarantine' ? 'quarantined' : 'unexpected', severity: 'warning',
    }));
}

const KINDS = { test: 'tenant_test_connection', poll: 'tenant_poll', antispam: 'tenant_antispam_read' };
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
  return { at: iso(now), ok: true, policy: { ...POLICY }, conflicts: conflicts(POLICY) };
}

function runPoll(now) {
  const at = iso(now);
  state = { ...state, certificate: { at, ...CERTIFICATE }, blockedConnectors: { at, ok: true, items: [] } };
  if (!state.antispam) state.antispam = readPolicy(now);
}

function finish(kind, settings) {
  const now = Date.now();
  if (kind === KINDS.test) runTest(settings, now);
  if (kind === KINDS.poll) runPoll(now);
  if (kind === KINDS.antispam) state = { ...state, antispam: readPolicy(now) };
  const job = { id: String(nextJobId++), kind, status: 'done', errorCode: null, error: null, createdAt: iso(now), updatedAt: iso(now) };
  jobs.set(job.id, job);
  return job;
}

const latest = (kind) => [...jobs.values()].filter((job) => job.kind === kind).at(-1) ?? null;

// The demo's test of three hours ago and its latest poll (job 9001), as if the tenant had been
// connected for a while.
runTest(DEMO_TENANT_SETTINGS, STARTED - 3 * 3600000);
finish(KINDS.poll, DEMO_TENANT_SETTINGS);

// The alerts of the tenant for the demo's alert check (backend nodeAlerts.js tenantSignals).
export function demoTenantAlerts(settings, now = Date.now()) {
  if (!configured(settings)) return [];
  const notAfter = Date.parse(CERTIFICATE.notAfter);
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (daysLeft >= 30) return [];
  return [{
    key: 'tenant_certificate', severity: daysLeft < 14 ? 'error' : 'warning',
    details: { code: notAfter <= now ? 'cert_expired' : 'cert_expiring', daysLeft, notAfter: CERTIFICATE.notAfter, thumbprint: CERTIFICATE.thumbprint },
  }];
}

// Answers a /mail-node/tenant request, or undefined when the path is not one. error(message,
// code) builds the demo's refusal.
export function demoTenantRequest(verb, pathname, settings, error) {
  if (verb === 'GET' && pathname === '/mail-node/tenant') {
    return clone({
      driver: 'fake', profileWithoutDriver: false, configured: configured(settings), state,
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
  const job = /^\/mail-node\/tenant\/jobs\/([^/]+)$/.exec(pathname);
  if (verb === 'GET' && job) {
    const found = jobs.get(decodeURIComponent(job[1]));
    if (!found) throw error('No such tenant job', 'tenant_job_not_found');
    return clone({ job: found });
  }
  return undefined;
}
