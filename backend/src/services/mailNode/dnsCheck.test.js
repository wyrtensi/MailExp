// The DNS and certificate checks of a mail node domain and of the node itself (R-14, R-15), against
// a resolver in memory: each check reads what DNS publishes and compares it with what the domain
// must publish, and says ok, warning or error with the record to publish.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CERT_WARN_DAYS,
  checkDomainDns,
  checkNodeDns,
  checkSubmissionCertificate,
  createResolver,
  dkimPublicKey,
  judgeCertificate,
  overallStatus,
  reverseName,
} from './dnsCheck.js';

const DOMAIN = 'stage.test';
const NODE_IP = '203.0.113.10';
const MAIL_HOST = 'mail.test.local';
const MX = 'stage-test.mail.protection.outlook.com';
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx'.repeat(6);
const DKIM_TXT = `v=DKIM1;k=rsa;t=s;s=email;p=${KEY}`;
const SPF = 'v=spf1 include:spf.protection.outlook.com -all';

// A resolver in memory: records by type and name; a name it has no records for answers ENOTFOUND,
// one listed in `failing` answers that error code.
function fakeResolver(zone, failing = {}) {
  const answer = (type) => async (name) => {
    if (failing[name]) throw Object.assign(new Error(failing[name]), { code: failing[name] });
    const records = zone[type]?.[name];
    if (!records) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return records;
  };
  return {
    resolveMx: answer('MX'), resolveTxt: answer('TXT'), resolveCname: answer('CNAME'),
    resolve4: answer('A'), resolve6: answer('AAAA'), reverse: answer('PTR'),
  };
}

// The zone stage.test as the stand's DNS fixture publishes it in its variant "ok"
// (scripts/deploy/test/stand-dns/zone.sh): the DKIM value in two strings.
function okZone() {
  return {
    MX: { [DOMAIN]: [{ exchange: MX, priority: 0 }] },
    TXT: {
      [DOMAIN]: [[SPF], ['MS=ms12345678']],
      [`dkim._domainkey.${DOMAIN}`]: [[DKIM_TXT.slice(0, 250), DKIM_TXT.slice(250)]],
      [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=quarantine; rua=mailto:dmarc@stage.test']],
    },
    A: { [MAIL_HOST]: [NODE_IP] },
    PTR: { [NODE_IP]: [MAIL_HOST] },
  };
}

const DKIM = { name: `dkim._domainkey.${DOMAIN}`, txt: DKIM_TXT };
const domainInput = (resolver, extra = {}) => ({
  domain: DOMAIN, expectedMx: [MX], dkimMode: 'mailcow', dkimKey: DKIM, dkimCnames: null, tenantTxt: 'MS=ms12345678',
  nodeIp: NODE_IP, resolver, ...extra,
});
const byCheck = (result) => Object.fromEntries(result.checks.map((c) => [c.check, c]));
const statuses = (result) => Object.fromEntries(result.checks.map((c) => [c.check, `${c.status}${c.code ? `:${c.code}` : ''}`]));

describe('checkDomainDns', () => {
  it('passes the zone a tenant behind EOP publishes', async () => {
    const result = await checkDomainDns(domainInput(fakeResolver(okZone())));
    expect(statuses(result)).toEqual({
      mx: 'ok', spf: 'ok', dkim_txt: 'ok', dmarc: 'ok', tenant_txt: 'ok', mta_sts: 'ok',
    });
    expect(result.overall).toBe('ok');
  });

  it('gives each check the record to publish', async () => {
    const result = byCheck(await checkDomainDns(domainInput(fakeResolver(okZone()))));
    expect(result.mx.records).toEqual([{ type: 'MX', name: DOMAIN, value: `0 ${MX}` }]);
    expect(result.spf.records).toEqual([{ type: 'TXT', name: DOMAIN, value: SPF }]);
    expect(result.dkim_txt.records).toEqual([{ type: 'TXT', name: `dkim._domainkey.${DOMAIN}`, value: DKIM_TXT }]);
    expect(result.dmarc.records).toEqual([{ type: 'TXT', name: `_dmarc.${DOMAIN}`, value: 'v=DMARC1; p=none' }]);
    expect(result.tenant_txt.records).toEqual([{ type: 'TXT', name: DOMAIN, value: 'MS=ms12345678' }]);
  });

  describe('MX', () => {
    it('is an error when another MX stands in for the expected one', async () => {
      const zone = okZone();
      zone.MX[DOMAIN] = [{ exchange: 'mail.other.test', priority: 0 }];
      const { mx } = byCheck(await checkDomainDns(domainInput(fakeResolver(zone))));
      expect(mx).toMatchObject({ status: 'error', code: 'mx_mismatch', found: ['mail.other.test'], expected: [MX] });
    });

    it('is an error when an extra MX stands next to the expected one', async () => {
      const zone = okZone();
      zone.MX[DOMAIN].push({ exchange: 'mail.other.test.', priority: 10 });
      const { mx } = byCheck(await checkDomainDns(domainInput(fakeResolver(zone))));
      expect(mx).toMatchObject({ status: 'error', code: 'mx_extra', found: [MX, 'mail.other.test'] });
    });

    it('takes the new form under mx.microsoft as it is, and compares it like any other', async () => {
      const zone = okZone();
      zone.MX[DOMAIN] = [{ exchange: 'stage-test.mx.microsoft', priority: 0 }];
      const legacy = byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).mx;
      expect(legacy).toMatchObject({ status: 'error', code: 'mx_mismatch' });
      const fresh = byCheck(await checkDomainDns(domainInput(fakeResolver(zone), { expectedMx: ['Stage-Test.MX.Microsoft.'] }))).mx;
      expect(fresh).toMatchObject({ status: 'ok', expected: ['stage-test.mx.microsoft'] });
    });

    it('is an error when the domain publishes no MX', async () => {
      const zone = okZone();
      delete zone.MX[DOMAIN];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).mx).toMatchObject({ status: 'error', code: 'mx_missing', found: [] });
    });

    it('warns, showing what DNS has, while nobody entered the expected MX', async () => {
      const { mx } = byCheck(await checkDomainDns(domainInput(fakeResolver(okZone()), { expectedMx: [] })));
      expect(mx).toMatchObject({ status: 'warning', code: 'mx_expected_missing', found: [MX], records: [] });
    });
  });

  describe('SPF', () => {
    const withSpf = (...records) => {
      const zone = okZone();
      zone.TXT[DOMAIN] = [...records.map((r) => [r]), ['MS=ms12345678']];
      return fakeResolver(zone);
    };

    it('is an error when there is none', async () => {
      expect(byCheck(await checkDomainDns(domainInput(withSpf()))).spf).toMatchObject({ status: 'error', code: 'spf_missing' });
    });

    it('is an error when there are two (receivers then ignore both)', async () => {
      const { spf } = byCheck(await checkDomainDns(domainInput(withSpf(SPF, 'v=spf1 mx -all'))));
      expect(spf).toMatchObject({ status: 'error', code: 'spf_multiple', found: [SPF, 'v=spf1 mx -all'] });
    });

    it('is an error without the Microsoft include', async () => {
      expect(byCheck(await checkDomainDns(domainInput(withSpf('v=spf1 mx -all')))).spf).toMatchObject({ status: 'error', code: 'spf_no_include' });
    });

    it('warns when it lets the node send by itself', async () => {
      const { spf } = byCheck(await checkDomainDns(domainInput(withSpf(`v=spf1 ip4:${NODE_IP} include:spf.protection.outlook.com -all`))));
      expect(spf).toMatchObject({ status: 'warning', code: 'spf_node_ip' });
      const net32 = byCheck(await checkDomainDns(domainInput(withSpf(`v=spf1 +ip4:${NODE_IP}/32 +include:spf.protection.outlook.com ~all`)))).spf;
      expect(net32).toMatchObject({ status: 'warning', code: 'spf_node_ip' });
    });

    it('reads a record split in strings and ignores the case of the version', async () => {
      const zone = okZone();
      zone.TXT[DOMAIN] = [['V=SPF1 include:spf.protection', '.outlook.com -all']];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone), { tenantTxt: null }))).spf).toMatchObject({ status: 'ok' });
    });
  });

  describe('DKIM', () => {
    it('is an error when the TXT carries another key', async () => {
      const zone = okZone();
      zone.TXT[`dkim._domainkey.${DOMAIN}`] = [[`v=DKIM1;k=rsa;t=s;s=email;p=${KEY.slice(1)}Z`]];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).dkim_txt).toMatchObject({ status: 'error', code: 'dkim_mismatch' });
    });

    it('is an error when the TXT is not published', async () => {
      const zone = okZone();
      delete zone.TXT[`dkim._domainkey.${DOMAIN}`];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).dkim_txt).toMatchObject({ status: 'error', code: 'dkim_missing' });
    });

    it('compares the key alone: tag order, spaces and mailcow quoting do not matter', async () => {
      const zone = okZone();
      zone.TXT[`dkim._domainkey.${DOMAIN}`] = [[`v=DKIM1; p=${KEY.slice(0, 100)} ${KEY.slice(100)}; k=rsa`]];
      const quoted = `"${DKIM_TXT.slice(0, 255)}" "${DKIM_TXT.slice(255)}"`;
      const { dkim_txt: dkim } = byCheck(await checkDomainDns(domainInput(fakeResolver(zone), { dkimKey: { ...DKIM, txt: quoted } })));
      expect(dkim).toMatchObject({ status: 'ok' });
      expect(dkim.records[0].value).toBe(DKIM_TXT);
    });

    it('warns when the node has no key to compare with', async () => {
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(okZone()), { dkimKey: null }))).dkim_txt)
        .toMatchObject({ status: 'warning', code: 'dkim_key_unknown' });
    });

    it('says when the key compared is the one the last apply saw', async () => {
      const { dkim_txt: dkim } = byCheck(await checkDomainDns(domainInput(fakeResolver(okZone()), { dkimKey: { ...DKIM, fromLastApply: true } })));
      expect(dkim).toMatchObject({ status: 'ok', keyFromLastApply: true });
    });

    describe('EOP mode: the selector CNAMEs', () => {
      const cnameZone = () => {
        const zone = okZone();
        delete zone.TXT[`dkim._domainkey.${DOMAIN}`];
        zone.CNAME = {
          [`selector1._domainkey.${DOMAIN}`]: ['selector1-stage-test._domainkey.tenant.onmicrosoft.test'],
          [`selector2._domainkey.${DOMAIN}`]: ['selector2-stage-test._domainkey.tenant.onmicrosoft.test'],
        };
        return zone;
      };
      const CNAMES = {
        selector1: 'selector1-stage-test._domainkey.tenant.onmicrosoft.test',
        selector2: 'Selector2-stage-test._domainkey.tenant.onmicrosoft.test.',
      };

      it('checks the two CNAMEs instead of the TXT', async () => {
        const result = await checkDomainDns(domainInput(fakeResolver(cnameZone()), { dkimMode: 'eop', dkimKey: null, dkimCnames: CNAMES }));
        const checks = byCheck(result);
        expect(checks.dkim_txt).toBeUndefined();
        expect(checks.dkim_cname).toMatchObject({ status: 'ok' });
        expect(checks.dkim_cname.records).toEqual([
          { type: 'CNAME', name: `selector1._domainkey.${DOMAIN}`, value: 'selector1-stage-test._domainkey.tenant.onmicrosoft.test' },
          { type: 'CNAME', name: `selector2._domainkey.${DOMAIN}`, value: 'selector2-stage-test._domainkey.tenant.onmicrosoft.test' },
        ]);
      });

      it('is an error when one is missing or points elsewhere', async () => {
        const zone = cnameZone();
        delete zone.CNAME[`selector2._domainkey.${DOMAIN}`];
        const missing = byCheck(await checkDomainDns(domainInput(fakeResolver(zone), { dkimMode: 'eop', dkimCnames: CNAMES })));
        expect(missing.dkim_cname).toMatchObject({ status: 'error', code: 'dkim_cname_missing' });
        const other = { ...CNAMES, selector1: 'selector1-other._domainkey.tenant.onmicrosoft.test' };
        const wrong = byCheck(await checkDomainDns(domainInput(fakeResolver(cnameZone()), { dkimMode: 'eop', dkimCnames: other })));
        expect(wrong.dkim_cname).toMatchObject({ status: 'error', code: 'dkim_cname_mismatch' });
      });

      it('warns while the values are not entered, showing what DNS has', async () => {
        const { dkim_cname: cname } = byCheck(await checkDomainDns(domainInput(fakeResolver(cnameZone()), { dkimMode: 'eop', dkimCnames: null })));
        expect(cname).toMatchObject({
          status: 'warning', code: 'dkim_cname_expected_missing',
          found: ['selector1-stage-test._domainkey.tenant.onmicrosoft.test', 'selector2-stage-test._domainkey.tenant.onmicrosoft.test'],
        });
      });

      it('checks them in mailcow mode too once they are entered (both sign)', async () => {
        const zone = cnameZone();
        zone.TXT[`dkim._domainkey.${DOMAIN}`] = okZone().TXT[`dkim._domainkey.${DOMAIN}`];
        expect(statuses(await checkDomainDns(domainInput(fakeResolver(zone), { dkimCnames: CNAMES })))).toMatchObject({ dkim_txt: 'ok', dkim_cname: 'ok' });
      });
    });
  });

  describe('DMARC', () => {
    it('is an error when there is none or it does not start with v=DMARC1', async () => {
      const zone = okZone();
      delete zone.TXT[`_dmarc.${DOMAIN}`];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).dmarc).toMatchObject({ status: 'error', code: 'dmarc_missing' });
      zone.TXT[`_dmarc.${DOMAIN}`] = [['p=none']];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).dmarc).toMatchObject({ status: 'error', code: 'dmarc_invalid', found: ['p=none'] });
    });

    it('is an error when there are two', async () => {
      const zone = okZone();
      zone.TXT[`_dmarc.${DOMAIN}`] = [['v=DMARC1; p=none'], ['v=DMARC1; p=reject']];
      expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone)))).dmarc).toMatchObject({ status: 'error', code: 'dmarc_multiple' });
    });
  });

  describe('tenant verification', () => {
    it('is an error when the expected TXT is not there', async () => {
      const zone = okZone();
      zone.TXT[DOMAIN] = [[SPF], ['MS=ms00000000']];
      const { tenant_txt: txt } = byCheck(await checkDomainDns(domainInput(fakeResolver(zone))));
      expect(txt).toMatchObject({ status: 'error', code: 'tenant_txt_missing', found: ['MS=ms00000000'] });
    });

    it('warns while nobody entered it', async () => {
      const { tenant_txt: txt } = byCheck(await checkDomainDns(domainInput(fakeResolver(okZone()), { tenantTxt: null })));
      expect(txt).toMatchObject({ status: 'warning', code: 'tenant_txt_expected_missing', found: ['MS=ms12345678'] });
    });
  });

  it('warns about an MTA-STS policy: its mx lines must name EOP, not the node', async () => {
    const zone = okZone();
    zone.TXT[`_mta-sts.${DOMAIN}`] = [['v=STSv1; id=20261001000000']];
    const { mta_sts: sts } = byCheck(await checkDomainDns(domainInput(fakeResolver(zone))));
    expect(sts).toMatchObject({ status: 'warning', code: 'mta_sts_published', found: ['v=STSv1; id=20261001000000'] });
  });

  it('is an error, with the resolver code, when a lookup fails instead of finding nothing', async () => {
    const result = await checkDomainDns(domainInput(fakeResolver(okZone(), { [`_dmarc.${DOMAIN}`]: 'ETIMEOUT' })));
    expect(byCheck(result).dmarc).toMatchObject({ status: 'error', code: 'dns_lookup_failed', detail: 'ETIMEOUT' });
    expect(byCheck(result).mx.status).toBe('ok');
    expect(result.overall).toBe('error');
  });

  it('runs without the node address: SPF is then not checked for it', async () => {
    const zone = okZone();
    zone.TXT[DOMAIN] = [[`v=spf1 ip4:${NODE_IP} include:spf.protection.outlook.com -all`]];
    expect(byCheck(await checkDomainDns(domainInput(fakeResolver(zone), { nodeIp: null, tenantTxt: null }))).spf.status).toBe('ok');
  });
});

describe('checkNodeDns', () => {
  const node = (zone, extra = {}) => checkNodeDns({ mailHost: MAIL_HOST, nodeIp: NODE_IP, resolver: fakeResolver(zone), ...extra });

  it('passes A, PTR and no AAAA', async () => {
    const result = await node(okZone());
    expect(statuses(result)).toEqual({ node_a: 'ok', node_ptr: 'ok', node_aaaa: 'ok' });
    expect(byCheck(result).node_ptr.records).toEqual([{ type: 'PTR', name: '10.113.0.203.in-addr.arpa', value: MAIL_HOST }]);
    expect(byCheck(result).node_a.records).toEqual([{ type: 'A', name: MAIL_HOST, value: NODE_IP }]);
  });

  it('is an error when the name points elsewhere or the address has no PTR', async () => {
    const zone = okZone();
    zone.A[MAIL_HOST] = ['198.51.100.7'];
    delete zone.PTR[NODE_IP];
    expect(statuses(await node(zone))).toMatchObject({ node_a: 'error:a_mismatch', node_ptr: 'error:ptr_missing' });
    zone.PTR[NODE_IP] = ['host.provider.test'];
    expect(byCheck(await node(zone)).node_ptr).toMatchObject({ status: 'error', code: 'ptr_mismatch', found: ['host.provider.test'] });
    delete zone.A[MAIL_HOST];
    expect(byCheck(await node(zone)).node_a).toMatchObject({ status: 'error', code: 'a_missing' });
  });

  it('warns about an AAAA: the node does not listen on IPv6', async () => {
    const zone = okZone();
    zone.AAAA = { [MAIL_HOST]: ['2001:db8::10'] };
    expect(byCheck(await node(zone)).node_aaaa).toMatchObject({ status: 'warning', code: 'aaaa_present', found: ['2001:db8::10'] });
  });

  it('warns, showing the A records, while the node address is not set', async () => {
    const result = await node(okZone(), { nodeIp: null });
    expect(statuses(result)).toEqual({ node_a: 'warning:node_ip_missing', node_ptr: 'warning:node_ip_missing', node_aaaa: 'ok' });
    expect(byCheck(result).node_a.found).toEqual([NODE_IP]);
  });
});

describe('judgeCertificate', () => {
  const NOW = Date.parse('2026-10-01T00:00:00Z');
  const cert = (extra = {}) => ({
    authorized: true, authorizationError: null, validTo: 'Dec 30 00:00:00 2026 GMT', subject: 'CN=mail.test.local',
    issuer: 'CN=Stage CA', subjectAltName: 'DNS:mail.test.local', matches: () => true, ...extra,
  });
  const judge = (c, names = [MAIL_HOST]) => Object.fromEntries(judgeCertificate(c, { names, now: NOW }).map((i) => [i.check, i]));

  it('passes a trusted chain with the name and months to go', () => {
    const items = judge(cert());
    expect(items.cert_expiry).toMatchObject({ status: 'ok', daysLeft: 90 });
    expect(items.cert_name).toMatchObject({ status: 'ok' });
    expect(items.cert_chain).toMatchObject({ status: 'ok' });
  });

  it('is an error when the server sent the leaf without its intermediate (EOP answers 5.7.64)', () => {
    expect(judge(cert({ authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).cert_chain)
      .toMatchObject({ status: 'error', code: 'cert_chain_incomplete' });
  });

  it('is an error when the chain ends at an untrusted root', () => {
    for (const reason of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      expect(judge(cert({ authorized: false, authorizationError: reason })).cert_chain)
        .toMatchObject({ status: 'error', code: 'cert_untrusted', detail: reason });
    }
  });

  it('warns two weeks before the end, and is an error after it', () => {
    expect(judge(cert({ validTo: 'Oct 10 00:00:00 2026 GMT' })).cert_expiry).toMatchObject({ status: 'warning', code: 'cert_expiring', daysLeft: 9 });
    expect(CERT_WARN_DAYS).toBe(14);
    const expired = judge(cert({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED', validTo: 'Sep 30 00:00:00 2026 GMT' }));
    expect(expired.cert_expiry).toMatchObject({ status: 'error', code: 'cert_expired' });
    // The chain itself is judged apart from its dates.
    expect(expired.cert_chain).toMatchObject({ status: 'ok' });
  });

  it('is an error when a name is not on the certificate', () => {
    const items = judge(cert({ matches: (name) => name === MAIL_HOST }), [MAIL_HOST, 'relay.example.com']);
    expect(items.cert_name).toMatchObject({ status: 'error', code: 'cert_name_mismatch', expected: [MAIL_HOST, 'relay.example.com'], missing: ['relay.example.com'] });
  });
});

describe('checkSubmissionCertificate', () => {
  let server;
  afterEach(() => server?.close());

  // An SMTP server that greets, answers EHLO with the given capabilities and refuses the rest.
  async function smtp(capabilities) {
    server = net.createServer((socket) => {
      socket.write('220 mail.test.local ESMTP\r\n');
      socket.on('data', (data) => {
        const line = data.toString();
        if (/^EHLO /i.test(line)) socket.write(['250-mail.test.local', ...capabilities.map((c) => `250-${c}`), '250 8BITMIME', ''].join('\r\n'));
        else if (/^STARTTLS/i.test(line)) socket.write('454 4.7.0 TLS not available\r\n');
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }

  it('is an error when the server offers no STARTTLS', async () => {
    const port = await smtp(['PIPELINING']);
    const items = await checkSubmissionCertificate({ host: '127.0.0.1', names: [MAIL_HOST], port, timeoutMs: 3000 });
    expect(items).toEqual([expect.objectContaining({ check: 'cert_connect', status: 'error', code: 'starttls_unavailable' })]);
  });

  it('is an error when STARTTLS is refused', async () => {
    const port = await smtp(['STARTTLS']);
    const items = await checkSubmissionCertificate({ host: '127.0.0.1', names: [MAIL_HOST], port, timeoutMs: 3000 });
    expect(items).toEqual([expect.objectContaining({ check: 'cert_connect', status: 'error', code: 'starttls_refused', detail: '454 4.7.0 TLS not available' })]);
  });

  it('is an error when nothing listens', async () => {
    const port = await smtp([]);
    await new Promise((resolve) => server.close(resolve));
    server = null;
    const items = await checkSubmissionCertificate({ host: '127.0.0.1', names: [MAIL_HOST], port, timeoutMs: 3000 });
    expect(items).toEqual([expect.objectContaining({ check: 'cert_connect', status: 'error', code: 'cert_unreachable', detail: 'ECONNREFUSED' })]);
  });

  it('gives up after the timeout when the server never greets', async () => {
    server = net.createServer(() => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const items = await checkSubmissionCertificate({ host: '127.0.0.1', names: [MAIL_HOST], port: server.address().port, timeoutMs: 300 });
    expect(items).toEqual([expect.objectContaining({ check: 'cert_connect', status: 'error', code: 'cert_unreachable', detail: 'ETIMEDOUT' })]);
  });
});

describe('helpers', () => {
  it('reads the p= value of a DKIM record, joined and without spaces', () => {
    expect(dkimPublicKey('"v=DKIM1;k=rsa;" "p=AB CD"')).toBe('ABCD');
    expect(dkimPublicKey('v=DKIM1; k=rsa; p=')).toBe('');
    expect(dkimPublicKey('v=spf1 -all')).toBeNull();
  });

  it('names the PTR of an IPv4 address', () => {
    expect(reverseName('203.0.113.10')).toBe('10.113.0.203.in-addr.arpa');
  });

  it('takes the worst status', () => {
    expect(overallStatus([{ status: 'ok' }, { status: 'warning' }])).toBe('warning');
    expect(overallStatus([{ status: 'warning' }, { status: 'error' }, { status: 'ok' }])).toBe('error');
    expect(overallStatus([])).toBe('ok');
  });

  it('asks only the configured server, and refuses one that is not an address', () => {
    expect(createResolver('172.19.0.7').getServers()).toEqual(['172.19.0.7']);
    expect(createResolver('172.19.0.7:5353').getServers()).toEqual(['172.19.0.7:5353']);
    expect(() => createResolver('dns.example.com')).toThrow(expect.objectContaining({ code: 'dns_resolver_invalid' }));
    expect(createResolver('').getServers().length).toBeGreaterThan(0);
  });
});
