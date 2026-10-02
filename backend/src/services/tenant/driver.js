import { createExoRunner } from './exoRunner.js';
import { GRAPH_URL, LOGIN_URL, createGraphClient } from './graphClient.js';
import { createFakeExoRunner, createFakeGraphFetch } from './fakes.js';

// TenantDriver (R-22): how the panel works with the Microsoft tenant. Two transports behind one
// object: EXO PowerShell through the tenant worker (ExoRunner, services/tenant/exoRunner.js) and
// Microsoft Graph (GraphClient, services/tenant/graphClient.js), whose client assertion the worker
// signs. Tenant work runs only in jobs of the durable queue (services/tenant/tenantJobs.js), never
// on an HTTP request's path: connecting to EXO takes seconds to tens of seconds.
//
//   driver.kind                       'worker' or 'fake'
//   driver.certificate()              the worker's application certificate (no key)
//   driver.forTenant(tenant)          -> { tenant, exo: { run(op, args) }, graph: { getToken, request } }
//
// tenant: tenantOf(the EOP settings) = { tenantId, appId, organization, thumbprint }.
//
// Which driver (getTenantDriver):
// - TENANT_WORKER_URL and TENANT_WORKER_TOKEN: the worker on the internal network (compose profile
//   "tenant"); TENANT_GRAPH_URL and TENANT_LOGIN_URL change Graph's and the login endpoint's base
//   (tests, a stand), defaulting to Microsoft's;
// - TENANT_DRIVER=fake: the recorded answers of services/tenant/fixtures.json (tests, the stand,
//   a demo backend). With NODE_ENV=production it is refused unless TENANT_DRIVER_STAND=1 says this
//   is a test stand, like MAIL_NODE_TRACE_URL (services/mailNode/traceSource.js);
// - neither: null, the panel has no tenant driver and keeps the manual onboarding.

export function createTenantDriver({ kind, exo, signer = null, graphUrl = GRAPH_URL, loginUrl = LOGIN_URL, graphFetch = null }) {
  // One Graph client (one token cache) for the tenant the settings name now.
  let graphKey = null;
  let graph = null;
  return {
    kind,
    exoRunner: exo,
    certificate: () => exo.certificate(),
    forTenant(tenant) {
      const key = `${tenant.tenantId}|${tenant.appId}|${tenant.thumbprint}`;
      if (key !== graphKey) {
        graphKey = key;
        graph = createGraphClient({
          tenant, signer: signer ?? ((t) => exo.assertion(t)), graphUrl, loginUrl, fetchImpl: graphFetch,
        });
      }
      return { tenant, graph, exo: { run: (op, args) => exo.run(tenant, op, args) } };
    },
  };
}

// The fake driver: fake.exo and fake.graph let a test change the answers.
export function createFakeTenantDriver({ answers = {}, graph = {}, token } = {}) {
  const exo = createFakeExoRunner({ answers });
  const graphFake = createFakeGraphFetch({ graph, ...(token !== undefined ? { token } : {}) });
  const driver = createTenantDriver({ kind: 'fake', exo, graphFetch: graphFake.fetchImpl, loginUrl: 'https://login.fake.invalid', graphUrl: 'https://graph.fake.invalid/v1.0' });
  return Object.assign(driver, { fake: { exo, graph: graphFake } });
}

// The tenant of the EOP settings, or null until the four fields are set.
export function tenantOf(settings) {
  if (!settings?.tenantId || !settings?.appId || !settings?.tenantDomain || !settings?.certThumbprint) return null;
  return { tenantId: settings.tenantId, appId: settings.appId, organization: settings.tenantDomain, thumbprint: settings.certThumbprint };
}

let override;
let configured;
let warned = false;

// Tests set a driver of their own (null: none); undefined puts the configured one back.
export function setTenantDriver(driver) {
  override = driver;
}

export function getTenantDriver({ env = process.env, warn = (line) => console.warn(line) } = {}) {
  if (override !== undefined) return override;
  if (configured !== undefined) return configured;
  configured = driverFromEnv(env, warn);
  return configured;
}

// Tests: the next getTenantDriver reads the environment again.
export function resetTenantDriver() {
  override = undefined;
  configured = undefined;
  warned = false;
}

function driverFromEnv(env, warn) {
  if (String(env.TENANT_DRIVER ?? '').trim() === 'fake') {
    if (env.NODE_ENV === 'production' && env.TENANT_DRIVER_STAND !== '1') {
      if (!warned) warn('TENANT_DRIVER=fake is ignored: it is a test stand aid (set TENANT_DRIVER_STAND=1 on a stand)');
      warned = true;
      return null;
    }
    if (!warned) warn('Tenant driver: TENANT_DRIVER=fake, the tenant answers are recorded fixtures');
    warned = true;
    return createFakeTenantDriver();
  }
  const url = String(env.TENANT_WORKER_URL ?? '').trim();
  const token = String(env.TENANT_WORKER_TOKEN ?? '');
  if (!url) return null;
  if (token.length < 32) {
    if (!warned) warn('TENANT_WORKER_URL is set but TENANT_WORKER_TOKEN is missing or shorter than 32 characters: no tenant driver');
    warned = true;
    return null;
  }
  return createTenantDriver({
    kind: 'worker',
    exo: createExoRunner({ url, token }),
    graphUrl: String(env.TENANT_GRAPH_URL ?? '').trim() || GRAPH_URL,
    loginUrl: String(env.TENANT_LOGIN_URL ?? '').trim() || LOGIN_URL,
  });
}
