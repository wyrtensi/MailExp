// The panel's side of the DNS checks, against PGlite with every real migration, a mailcow in memory
// and a resolver in memory: what a check reads (the domain's DKIM mode, the node's key, the values
// entered by hand, the node address), what it keeps (each domain's and the node's last result),
// what it journals (every administrator's check, otherwise only a changed status) and that it never
// moves a domain's onboarding.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealSchemaDb } from '../testing/realSchema.js';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const dbState = { db: null };
const fake = vi.hoisted(() => ({ current: null, zone: null, cert: null, failing: {} }));
vi.mock('../db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
}));
vi.mock('../safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));
vi.mock('./dnsCheck.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // The real resolver factory still checks the setting; lookups go to the zone in memory.
    createResolver: (...args) => {
      real.createResolver(...args);
      const answer = (type) => async (name) => {
        if (fake.failing[name]) throw Object.assign(new Error(fake.failing[name]), { code: fake.failing[name] });
        const records = fake.zone[type]?.[name];
        if (!records) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        return records;
      };
      return {
        resolveMx: answer('MX'), resolveTxt: answer('TXT'), resolveCname: answer('CNAME'),
        resolve4: answer('A'), resolve6: answer('AAAA'), reverse: answer('PTR'),
      };
    },
    checkSubmissionCertificate: async ({ names }) => fake.cert(names),
  };
});

const { checkAllNow, checkDomainNow, getNodeDnsCheck, startCheckAll } = await import('./dnsCheckJob.js');
const { saveMailNodeConfig } = await import('./mailcow.js');
const { saveEopSettings } = await import('./eopSettings.js');
const { listDomainRows, parseExpectedValues, restartOnboarding, setExpectedValues } = await import('./domains.js');

const ADMIN = '62000000-0000-4000-8000-000000000001';
const NODE_IP = '203.0.113.10';
const MX = 'a-example.mail.protection.outlook.com';
let db;
let mc;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
  await db.query("INSERT INTO users (id, username, email, is_admin) VALUES ($1, 'admin', 'admin@example.com', true)", [ADMIN]);
});
afterAll(async () => { await db?.close(); });

const certOk = (names) => [
  { check: 'cert_expiry', status: 'ok', code: null, found: [], expected: null, records: [], daysLeft: 80 },
  { check: 'cert_name', status: 'ok', code: null, found: [], expected: names, records: [] },
  { check: 'cert_chain', status: 'ok', code: null, found: [], expected: null, records: [] },
];

function zoneFor(pub) {
  return {
    MX: { 'a.example': [{ exchange: MX, priority: 0 }], 'b.example': [{ exchange: 'b-example.mx.microsoft', priority: 0 }] },
    TXT: {
      'a.example': [['v=spf1 include:spf.protection.outlook.com -all'], ['MS=ms11111111']],
      'dkim._domainkey.a.example': [[`v=DKIM1;k=rsa;t=s;s=email;p=${pub}`]],
      '_dmarc.a.example': [['v=DMARC1; p=none']],
      'b.example': [['v=spf1 include:spf.protection.outlook.com -all']],
      '_dmarc.b.example': [['v=DMARC1; p=none']],
    },
    CNAME: {},
    A: { 'mail.example.com': [NODE_IP] },
    PTR: { [NODE_IP]: ['mail.example.com'] },
  };
}

beforeEach(async () => {
  for (const table of ['mail_node_domains', 'mailbox_audit_log', 'integration_config']) await db.query(`DELETE FROM ${table}`);
  delete process.env.DNS_CHECK_RESOLVER;
  mc = createFakeMailcow({ domains: { 'a.example': { relayhost: 0 }, 'b.example': { relayhost: 0 } }, dkim: { 'a.example': { pub: 'PUBA', selector: 'dkim' } } });
  fake.current = mc;
  fake.zone = zoneFor('PUBA');
  fake.cert = certOk;
  fake.failing = {};
  await saveMailNodeConfig({ mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 });
  await saveEopSettings({ nodeIp: NODE_IP, certificateHost: 'relay.example.com' });
  await db.query("INSERT INTO mail_node_domains (domain, state, expected_mx) VALUES ('a.example', 'ready', $1), ('b.example', 'dns_ok', '[]')", [JSON.stringify([MX])]);
  await db.query("UPDATE mail_node_domains SET dkim_mode = 'eop' WHERE domain = 'b.example'");
  await setExpectedValues({ domain: 'a.example', values: { tenantTxt: 'MS=ms11111111' } });
});

const audit = async () => (await db.query('SELECT actor_user_id, actor_email, action, details FROM mailbox_audit_log ORDER BY id')).rows;
const raw = async (domain) => (await db.query('SELECT state, dns_check, dns_checked_at FROM mail_node_domains WHERE domain = $1', [domain])).rows[0];
const statuses = (checks) => Object.fromEntries(checks.map((c) => [c.check, c.status]));

describe('checkDomainNow', () => {
  it('checks a domain against the node key and the values entered, keeps the result and journals it', async () => {
    const result = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    expect(result.overall).toBe('ok');
    expect(statuses(result.checks)).toEqual({ mx: 'ok', spf: 'ok', dkim_txt: 'ok', dmarc: 'ok', tenant_txt: 'ok', mta_sts: 'ok' });
    const row = await raw('a.example');
    expect(row.dns_check).toMatchObject({ overall: 'ok', trigger: 'manual' });
    expect(row.dns_checked_at).not.toBeNull();
    const [entry] = await audit();
    expect(entry).toMatchObject({
      actor_user_id: ADMIN, action: 'mail_node.dns_checked',
      details: { scope: 'domain', domain: 'a.example', trigger: 'manual', overall: 'ok', from: null, errors: [], warnings: [] },
    });
  });

  it('never moves the onboarding: a ready domain with errors stays ready', async () => {
    fake.zone.MX['a.example'] = [{ exchange: 'mail.other.test', priority: 0 }];
    delete fake.zone.TXT['_dmarc.a.example'];
    const result = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    expect(result.overall).toBe('error');
    expect((await raw('a.example')).state).toBe('ready');
    const [listed] = (await listDomainRows()).filter((d) => d.domain === 'a.example');
    expect(listed.dns).toMatchObject({ overall: 'error' });
    expect(listed.dns.checks.find((c) => c.check === 'mx')).toMatchObject({ code: 'mx_mismatch' });
    expect((await audit())[0].details.errors).toEqual(['mx', 'dmarc']);
  });

  it('takes the key from the last apply when the node does not answer, and says so', async () => {
    await db.query("UPDATE mail_node_domains SET apply_result = $1 WHERE domain = 'a.example'", [{
      items: [], dkim: { selector: 'dkim', name: 'dkim._domainkey.a.example', txt: 'v=DKIM1;k=rsa;t=s;s=email;p=PUBA' },
    }]);
    mc.node.down = true;
    const result = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    expect(result.checks.find((c) => c.check === 'dkim_txt')).toMatchObject({ status: 'ok', keyFromLastApply: true });
  });

  it('checks the selector CNAMEs of a domain the tenant signs for, with what DNS has when they are not entered', async () => {
    const result = await checkDomainNow({ domain: 'b.example', userId: ADMIN });
    const checks = statuses(result.checks);
    expect(checks.dkim_txt).toBeUndefined();
    expect(checks).toMatchObject({ dkim_cname: 'warning', mx: 'warning', tenant_txt: 'warning' });
    expect(result.overall).toBe('warning');
  });

  it('refuses a domain the panel does not know, and a node that is not set up', async () => {
    await expect(checkDomainNow({ domain: 'gone.example', userId: ADMIN })).rejects.toMatchObject({ code: 'domain_not_found' });
    await db.query('DELETE FROM integration_config');
    await expect(checkDomainNow({ domain: 'a.example', userId: ADMIN })).rejects.toMatchObject({ code: 'mail_node_not_configured' });
  });

  it('reports a resolver setting that is not an address instead of asking anyone', async () => {
    process.env.DNS_CHECK_RESOLVER = 'dns.example.com';
    const result = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    expect(result).toMatchObject({ overall: null, checks: [], lookupFailed: { code: 'dns_resolver_invalid', trigger: 'manual' } });
  });
});

describe('a check that could not ask DNS', () => {
  it('keeps the result before, says when and why, and journals only an administrator\'s check', async () => {
    const first = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    const { dns_checked_at: checkedAt } = await raw('a.example');
    fake.failing['_dmarc.a.example'] = 'ETIMEOUT';
    const failed = await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    expect(failed).toMatchObject({ overall: 'ok', checks: first.checks, lookupFailed: { code: 'dns_lookup_failed', detail: 'ETIMEOUT' } });
    expect(failed.lookupFailed.checks).toEqual([{ check: 'dmarc', name: '_dmarc.a.example', detail: 'ETIMEOUT' }]);
    const row = await raw('a.example');
    expect(row.dns_checked_at).toEqual(checkedAt);
    const [listed] = (await listDomainRows()).filter((d) => d.domain === 'a.example');
    expect(listed.dns).toMatchObject({ overall: 'ok', lookupFailed: { code: 'dns_lookup_failed' } });
    const entries = await audit();
    expect(entries.at(-1).details).toEqual({
      scope: 'domain', domain: 'a.example', trigger: 'manual', lookupFailed: true, code: 'dns_lookup_failed', detail: 'ETIMEOUT',
    });
    // The schedule journals no failure, and the next result counts against the last real one.
    await checkAllNow({ trigger: 'schedule' });
    expect(await audit()).toHaveLength(entries.length);
    delete fake.failing['_dmarc.a.example'];
    await checkAllNow({ trigger: 'schedule' });
    expect(await audit()).toHaveLength(entries.length);
    expect((await raw('a.example')).dns_check.lookupFailed).toBeUndefined();
  });

  it('ends a run at once when the resolver does not answer, keeping every result', async () => {
    await checkAllNow({ trigger: 'schedule' });
    const before = await raw('b.example');
    const node = await getNodeDnsCheck();
    fake.failing['mail.example.com'] = 'ECONNREFUSED';
    fake.cert = () => { throw new Error('the certificate must not be read during an outage'); };
    const result = await checkAllNow({ userId: ADMIN });
    expect(result.node).toMatchObject({ overall: node.overall, checks: node.checks, lookupFailed: { code: 'dns_lookup_failed', detail: 'ECONNREFUSED' } });
    expect(result.domains.map((d) => [d.domain, d.overall, d.lookupFailed?.code])).toEqual([
      ['a.example', 'ok', 'dns_lookup_failed'], ['b.example', 'warning', 'dns_lookup_failed'],
    ]);
    expect((await raw('b.example')).dns_checked_at).toEqual(before.dns_checked_at);
    const [entry] = (await audit()).slice(-1);
    expect(entry.details).toMatchObject({
      scope: 'all', lookupFailed: true, code: 'dns_lookup_failed', counts: { ok: 0, warning: 0, error: 0, lookupFailed: 2 },
    });
  });

  it('keeps one domain\'s failure to itself', async () => {
    fake.zone.MX['a.example'] = [null];
    const result = await checkAllNow({ trigger: 'schedule' });
    const byDomain = Object.fromEntries(result.domains.map((d) => [d.domain, d]));
    expect(byDomain['a.example']).toMatchObject({ overall: null, lookupFailed: { code: 'check_failed' } });
    expect(byDomain['b.example']).toMatchObject({ overall: 'warning' });
  });
});

describe('a run of everything', () => {
  it('is one at a time: a second request joins the running one', async () => {
    const first = startCheckAll({ userId: ADMIN });
    const second = startCheckAll({ userId: ADMIN });
    expect([first.started, second.started]).toEqual([true, false]);
    expect(second.promise).toBe(first.promise);
    await first.promise;
    expect(startCheckAll({ trigger: 'schedule' }).started).toBe(true);
  });

  it('checks no domain past its deadline', async () => {
    const result = await checkAllNow({ trigger: 'schedule', deadlineMs: -1 });
    expect(result.domains).toEqual([]);
    expect(result.skipped).toEqual(['a.example', 'b.example']);
    expect((await raw('a.example')).dns_check).toBeNull();
  });
});

describe('checkAllNow', () => {
  it('checks the node (A, PTR, AAAA and the certificate for both names) and every domain; journals an administrator once', async () => {
    const seen = [];
    fake.cert = (names) => {
      seen.push(names);
      return certOk(names);
    };
    const result = await checkAllNow({ userId: ADMIN });
    expect(statuses(result.node.checks)).toEqual({
      node_a: 'ok', node_ptr: 'ok', node_aaaa: 'ok', cert_expiry: 'ok', cert_name: 'ok', cert_chain: 'ok',
    });
    expect(seen).toEqual([['mail.example.com', 'relay.example.com']]);
    expect(result.domains.map((d) => [d.domain, d.overall])).toEqual([['a.example', 'ok'], ['b.example', 'warning']]);
    expect(await getNodeDnsCheck()).toMatchObject({ overall: 'ok', trigger: 'manual' });
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0].details).toEqual({
      scope: 'all', trigger: 'manual', overall: 'ok', from: null, counts: { ok: 1, warning: 1, error: 0, lookupFailed: 0 }, errorDomains: [],
    });
  });

  it('journals a scheduled run only where the status changed since the run before', async () => {
    await checkAllNow({ trigger: 'schedule' });
    expect(await audit()).toEqual([]);
    await checkAllNow({ trigger: 'schedule' });
    expect(await audit()).toEqual([]);
    fake.zone.MX['a.example'].push({ exchange: 'mail.other.test', priority: 10 });
    await checkAllNow({ trigger: 'schedule' });
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor_user_id: null, actor_email: 'MailExpert', action: 'mail_node.dns_checked',
      details: { scope: 'domain', domain: 'a.example', trigger: 'schedule', overall: 'error', from: 'ok', errors: ['mx'] },
    });
    expect((await raw('a.example')).state).toBe('ready');
  });
});

describe('the values entered by hand', () => {
  it('are checked as they come in', () => {
    expect(parseExpectedValues({ expectedMx: 'A-Example.mail.protection.outlook.com., b.mx.microsoft\nb.mx.microsoft' }))
      .toEqual({ values: { mx: ['a-example.mail.protection.outlook.com', 'b.mx.microsoft'] } });
    expect(parseExpectedValues({ expectedMx: ['not a host'] })).toEqual({ error: 'expected_mx_invalid' });
    expect(parseExpectedValues({ tenantTxt: ' MS=ms123 ', dkimSelector1Cname: '', dkimSelector2Cname: 'x.example.' }))
      .toEqual({ values: { tenantTxt: 'MS=ms123', dkimSelector1Cname: null, dkimSelector2Cname: 'x.example' } });
    expect(parseExpectedValues({ tenantTxt: 'a"b' })).toEqual({ error: 'tenant_txt_invalid' });
    expect(parseExpectedValues({ dkimSelector1Cname: 'no host' })).toEqual({ error: 'dkim_cname_invalid' });
    // Real EOP selector targets hold "_" in their labels.
    expect(parseExpectedValues({
      dkimSelector1Cname: 'Selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft.',
      dkimSelector2Cname: 'selector2-contoso-com._domainkey.contoso.onmicrosoft.com',
    })).toEqual({
      values: {
        dkimSelector1Cname: 'selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft',
        dkimSelector2Cname: 'selector2-contoso-com._domainkey.contoso.onmicrosoft.com',
      },
    });
    expect(parseExpectedValues({ dkimSelector1Cname: 'selector1-stage-test._domainkey.tenant.onmicrosoft.test' }))
      .toEqual({ values: { dkimSelector1Cname: 'selector1-stage-test._domainkey.tenant.onmicrosoft.test' } });
    expect(parseExpectedValues({ dkimSelector1Cname: 'selector1._domainkey.contoso.dkim_mail' })).toEqual({ error: 'dkim_cname_invalid' });
    expect(parseExpectedValues({ expectedMx: 'mx_1.example.com' })).toEqual({ error: 'expected_mx_invalid' });
  });

  it('are kept with the domain, report what changed, and stay through "Restart onboarding"', async () => {
    expect(await setExpectedValues({ domain: 'a.example', values: { mx: [MX], tenantTxt: 'MS=ms11111111' } })).toEqual({ fields: [] });
    expect(await setExpectedValues({ domain: 'a.example', values: { dkimSelector1Cname: 's1.example', dkimSelector2Cname: 's2.example' } }))
      .toEqual({ fields: ['dkimSelector1Cname', 'dkimSelector2Cname'] });
    const [row] = (await listDomainRows()).filter((d) => d.domain === 'a.example');
    expect(row.expected).toEqual({ source: 'manual', mx: [MX], tenantTxt: 'MS=ms11111111', dkimSelector1Cname: 's1.example', dkimSelector2Cname: 's2.example' });
    expect((await db.query("SELECT tenant FROM mail_node_domains WHERE domain = 'a.example'")).rows[0].tenant).toMatchObject({ source: 'manual' });
    expect(await setExpectedValues({ domain: 'gone.example', values: { mx: [] } })).toEqual({ error: 'domain_not_found' });
    await checkDomainNow({ domain: 'a.example', userId: ADMIN });
    await restartOnboarding({ domain: 'a.example', userId: ADMIN });
    const [after] = (await listDomainRows()).filter((d) => d.domain === 'a.example');
    expect(after.expected).toEqual({ source: 'manual', mx: [MX], tenantTxt: 'MS=ms11111111', dkimSelector1Cname: 's1.example', dkimSelector2Cname: 's2.example' });
    expect(after.dns).toBeNull();
  });
});
