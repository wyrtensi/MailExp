import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The jobs the panel CLI queues, in a process that never registered the tenant's job kinds (as the
// CLI's own process before main() registers them): each still gets its kind's attempts and carries
// the CLI in its payload for its own journal entries.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  pool: { end: async () => {} },
}));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { saveEopSettings } = await import('../services/mailNode/eopSettings.js');
const { createFakeTenantDriver, setTenantDriver } = await import('../services/tenant/driver.js');
const { TENANT_FIXTURES } = await import('../services/tenant/fakes.js');
const { jobKind } = await import('../services/jobQueue.js');
const { TENANT_JOB_KINDS, actorAudit, jobAudit } = await import('../services/tenant/tenantJobs.js');
const { DOMAIN_SYNC_KIND } = await import('../services/tenant/tenantDomains.js');
const { QUARANTINE_RELEASE_KIND } = await import('../services/tenant/quarantineRelease.js');
const { run } = await import('./mailexpert.js');

const ADMIN = '64000000-0000-4000-8000-000000000001';
let db;

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}
const cli = (argv) => run(argv, { stdout: sink(), stderr: sink(), interactive: false, ask: async () => '' });

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, password_hash, is_admin) VALUES ($1, 'admin', 'admin@example.com', 'x', true)", [ADMIN]);
  await db.query("INSERT INTO mail_node_domains (domain, state, origin) VALUES ('example.com', 'ready', 'created')");
  setTenantDriver(createFakeTenantDriver());
  await saveEopSettings({
    tenantId: '11111111-2222-4333-8444-555555555555', tenantDomain: 'contoso.onmicrosoft.com',
    appId: '66666666-7777-4888-9999-aaaaaaaaaaaa', certThumbprint: TENANT_FIXTURES.worker.certificate.thumbprint,
  });
}, 120000);
afterAll(async () => {
  setTenantDriver(undefined);
  await db?.close();
});
beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db.exec('DELETE FROM jobs');
});

describe('jobs queued without the kinds registered', () => {
  it('none of the tenant kinds is registered in this process', () => {
    for (const kind of [...Object.values(TENANT_JOB_KINDS), DOMAIN_SYNC_KIND, QUARANTINE_RELEASE_KIND]) expect(jobKind(kind)).toBeFalsy();
  });

  it.each([
    [['tenant', 'test'], TENANT_JOB_KINDS.test, 1],
    [['tenant', 'antispam'], TENANT_JOB_KINDS.antispam, 1],
    [['quarantine', 'release'], QUARANTINE_RELEASE_KIND, 4],
    [['domain', 'sync', 'example.com'], DOMAIN_SYNC_KIND, 6],
  ])('%j queues %s with its own attempts (%i) and the CLI in the payload', async (argv, kind, attempts) => {
    expect(await cli(argv)).toBe(0);
    const { rows: [job] } = await db.query('SELECT max_attempts, payload, created_by FROM jobs WHERE kind = $1', [kind]);
    expect(job).toMatchObject({ max_attempts: attempts, created_by: null, payload: expect.objectContaining({ via: 'cli' }) });
  });

  it('keeps the --as administrator as the job\'s author', async () => {
    expect(await cli(['tenant', 'test', '--as', 'admin@example.com'])).toBe(0);
    const { rows: [job] } = await db.query('SELECT created_by, payload FROM jobs');
    expect(job).toMatchObject({ created_by: ADMIN, payload: { via: 'cli' } });
  });
});

describe('the actor of a job\'s journal entries', () => {
  const entry = { action: 'tenant.connection_tested', details: { ok: true } };

  it('is the CLI for a job it queued, the user for a button, MailExpert for a scheduled one', () => {
    expect(jobAudit({ created_by: null, payload: { via: 'cli' } }, entry))
      .toEqual({ action: entry.action, actorUserId: null, actorEmail: 'cli', details: { ok: true, via: 'cli' } });
    expect(jobAudit({ created_by: ADMIN, payload: { via: 'cli' } }, entry))
      .toEqual({ action: entry.action, actorUserId: ADMIN, details: { ok: true, via: 'cli' } });
    expect(jobAudit({ created_by: ADMIN, payload: {} }, entry)).toEqual({ ...entry, actorUserId: ADMIN });
    expect(jobAudit({ created_by: null, payload: {} }, entry)).toEqual({ ...entry, actorEmail: 'MailExpert' });
    expect(actorAudit(null, null, entry)).toEqual({ ...entry, actorEmail: 'MailExpert' });
  });
});
