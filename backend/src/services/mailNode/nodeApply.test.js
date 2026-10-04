// Applying the panel's settings to a mail node: runApply against a mailcow in memory
// (testing/fakeMailcow.js) that answers as mailcow 2026-09 does. Every run reads first and writes
// only what differs, so a second run writes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const {
  PREFILTER_ALWAYS_CAT, PREFILTER_CAT, PREFILTER_SFV, buildPrefilter, defaultRateLimit, runApply, runPrefilterApply,
} = await import('./nodeApply.js');

const CFG = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120 };
const EOP = { eopHost: 'eop.example.net', tlsPolicy: 'secure', tlsPolicyParameters: null, dkimMode: 'mailcow', sendLimitPerHour: 50 };
const HOURLY = { value: 50, frame: 'h' };

let mc;
beforeEach(() => {
  mc = createFakeMailcow({
    domains: { 'a.example': { relayhost: 0 } },
    dkim: { 'a.example': { pub: 'PUBKEY', selector: 'dkim' } },
    mailboxes: [{ username: 'one@a.example' }, { username: 'two@a.example', rl: { value: '50', frame: 'h' } }],
  });
  fake.current = mc;
});

const domainInput = (extra = {}) => ({
  domain: 'a.example', dkimMode: 'mailcow', defaultLimit: HOURLY,
  accounts: [{ email: 'one@a.example', override: null }, { email: 'two@a.example', override: null }],
  ...extra,
});
const statuses = (items) => Object.fromEntries(items.map((i) => [i.item, i.status]));

describe('runApply', () => {
  it('puts every setting on a fresh node, then finds it all in place', async () => {
    const first = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10'], domains: [domainInput()] });
    expect(statuses(first.node)).toEqual({
      tls_policy: 'changed', relayhost: 'changed', fail2ban: 'changed', prefilter: 'pending', forwarding_hosts: 'skipped',
    });
    expect(first.node.find((i) => i.item === 'prefilter')).toMatchObject({ code: 'prefilter_differs' });
    const [domain] = first.domains;
    expect(statuses(domain.items)).toEqual({ domain_relayhost: 'changed', dkim: 'ok', mailbox_limits: 'changed' });
    expect(domain.items.find((i) => i.item === 'mailbox_limits').counts).toEqual({ mailboxes: 2, matching: 1, changed: 1, failed: 0, missing: 0 });
    expect(domain.dkim).toEqual({ selector: 'dkim', name: 'dkim._domainkey.a.example', txt: 'v=DKIM1;k=rsa;t=s;s=email;p=PUBKEY', length: '2048' });

    // The TLS entry is the bare next hop, active, with the stored policy; the relayhost has no login.
    expect(mc.node.tls).toEqual([{ id: 1, dest: 'eop.example.net', policy: 'secure', parameters: '', active: '1' }]);
    expect(mc.node.relayhosts).toEqual([{ id: 2, hostname: 'eop.example.net', username: '', password: '', active: '1' }]);
    expect(mc.node.domains['a.example'].relayhost).toBe(2);
    expect(mc.node.fail2ban).toMatchObject({ whitelist: '203.0.113.10', ban_time_increment: true, manage_external: 0, blacklist: '' });
    // The general apply never writes the spam filing rule.
    expect(mc.writes.map((w) => w.path)).not.toContain('add/global-filter');

    mc.writes.length = 0;
    const again = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10'], domains: [domainInput()] });
    expect(statuses(again.node)).toEqual({ tls_policy: 'ok', relayhost: 'ok', fail2ban: 'ok', prefilter: 'pending', forwarding_hosts: 'skipped' });
    expect(statuses(again.domains[0].items)).toEqual({ domain_relayhost: 'ok', dkim: 'ok', mailbox_limits: 'ok' });
    expect(mc.writes).toEqual([]);
  });

  it('changes the TLS entry to the stored policy, turns on a disabled one and removes it for "default"', async () => {
    mc.node.tls.push({ id: 7, dest: 'eop.example.net', policy: 'encrypt', parameters: '', active: '0' });
    let result = await runApply(CFG, { eop: { ...EOP, tlsPolicy: 'fingerprint', tlsPolicyParameters: 'match=AB:CD' } });
    expect(result.node[0]).toEqual({ item: 'tls_policy', target: 'eop.example.net', status: 'changed', from: 'encrypt (inactive)', to: 'fingerprint match=AB:CD' });
    expect(mc.node.tls).toEqual([{ id: 7, dest: 'eop.example.net', policy: 'fingerprint', parameters: 'match=AB:CD', active: '1' }]);
    result = await runApply(CFG, { eop: { ...EOP, tlsPolicy: 'default' } });
    expect(result.node[0]).toMatchObject({ status: 'changed', from: 'fingerprint match=AB:CD', to: 'default' });
    expect(mc.node.tls).toEqual([]);
    result = await runApply(CFG, { eop: { ...EOP, tlsPolicy: 'default' } });
    expect(result.node[0]).toMatchObject({ status: 'ok' });
  });

  it('uses only a relayhost without a login, and turns its own one back on', async () => {
    mc.node.relayhosts.push(
      { id: 3, hostname: 'eop.example.net', username: 'someone', password: 'secret-pass', active: '1' },
      { id: 4, hostname: 'EOP.example.net', username: '', password: '', active: '0' },
    );
    const result = await runApply(CFG, { eop: EOP, domains: [domainInput()] });
    expect(result.node.find((i) => i.item === 'relayhost')).toEqual({
      item: 'relayhost', target: 'eop.example.net', status: 'changed', from: 'inactive', to: 'active',
    });
    expect(mc.node.domains['a.example'].relayhost).toBe(4);
    expect(mc.node.relayhosts).toHaveLength(2);
    // The password mailcow lists in clear text goes nowhere.
    expect(JSON.stringify(result)).not.toContain('secret-pass');
  });

  it('skips what has no setting yet', async () => {
    const result = await runApply(CFG, { eop: { ...EOP, eopHost: null }, panelIps: [], domains: [domainInput()] });
    expect(result.node.filter((i) => i.status === 'skipped')).toEqual([
      { item: 'tls_policy', target: null, status: 'skipped', code: 'eop_host_missing' },
      { item: 'relayhost', target: null, status: 'skipped', code: 'eop_host_missing' },
      { item: 'fail2ban', target: null, status: 'skipped', code: 'panel_ips_missing' },
      expect.objectContaining({ item: 'forwarding_hosts', status: 'skipped', code: 'prefilter_not_applied' }),
    ]);
    expect(result.domains[0].items[0]).toEqual({ item: 'domain_relayhost', target: 'a.example', status: 'skipped', code: 'eop_host_missing', current: 'none' });
    expect(mc.node.relayhosts).toEqual([]);
  });

  it('with the EOP host cleared shows what the panel set before and unbinds nothing', async () => {
    const first = await runApply(CFG, { eop: EOP, domains: [domainInput()] });
    mc.writes.length = 0;
    const result = await runApply(CFG, { eop: { ...EOP, eopHost: null }, domains: [domainInput()], owned: first.owned });
    expect(result.node.slice(0, 2)).toEqual([
      { item: 'tls_policy', target: null, status: 'skipped', code: 'eop_host_missing', current: 'eop.example.net: secure' },
      { item: 'relayhost', target: null, status: 'skipped', code: 'eop_host_missing', current: 'eop.example.net (2)' },
    ]);
    expect(result.domains[0].items[0]).toMatchObject({ status: 'skipped', code: 'eop_host_missing', current: 'eop.example.net (2)' });
    expect(mc.node.domains['a.example'].relayhost).toBe(2);
    expect(mc.writes).toEqual([]);
  });

  it('removes what it made for the previous EOP host: the TLS entry, and the relayhost once nothing uses it', async () => {
    mc.node.domains['hand.example'] = { relayhost: 0 };
    const first = await runApply(CFG, { eop: EOP, domains: [domainInput()] });
    expect(first.owned).toEqual({ tls: [{ id: 1, dest: 'eop.example.net' }], relayhosts: [{ id: 2, hostname: 'eop.example.net' }], fail2ban: [], fwdhosts: [] });
    // A domain the panel does not know sends through the panel's relayhost too.
    mc.node.domains['hand.example'].relayhost = 2;
    const moved = await runApply(CFG, { eop: { ...EOP, eopHost: 'new.example.net' }, domains: [domainInput()], owned: first.owned });
    expect(moved.node.slice(-2)).toEqual([
      { item: 'previous_tls_policy', target: 'eop.example.net', status: 'changed', from: 'secure', to: null },
      { item: 'previous_relayhost', target: 'eop.example.net', status: 'skipped', code: 'relayhost_in_use', current: 'hand.example' },
    ]);
    expect(mc.node.tls.map((t) => t.dest)).toEqual(['new.example.net']);
    expect(mc.node.domains['a.example'].relayhost).toBe(4);
    expect(mc.node.domains['hand.example'].relayhost).toBe(2);
    expect(moved.owned.relayhosts).toEqual([{ id: 2, hostname: 'eop.example.net' }, { id: 4, hostname: 'new.example.net' }]);
    // Once nothing sends through it any more, the next run deletes it.
    mc.node.domains['hand.example'].relayhost = 0;
    const later = await runApply(CFG, { eop: { ...EOP, eopHost: 'new.example.net' }, domains: [domainInput()], owned: moved.owned });
    expect(later.node.at(-1)).toEqual({ item: 'previous_relayhost', target: 'eop.example.net', status: 'changed', from: 'eop.example.net (2)', to: null });
    expect(mc.node.relayhosts.map((r) => r.hostname)).toEqual(['new.example.net']);
    expect(later.owned).toEqual({ tls: [{ id: 3, dest: 'new.example.net' }], relayhosts: [{ id: 4, hostname: 'new.example.net' }], fail2ban: [], fwdhosts: [] });
  });

  it('never removes a TLS entry or relayhost it did not make', async () => {
    mc.node.tls.push({ id: 7, dest: 'old.example.net', policy: 'secure', parameters: '', active: '1' });
    mc.node.relayhosts.push({ id: 8, hostname: 'old.example.net', username: '', password: '', active: '1' });
    const result = await runApply(CFG, { eop: EOP, domains: [domainInput()] });
    expect(result.node.map((i) => i.item)).not.toContain('previous_tls_policy');
    expect(mc.node.tls.map((t) => t.id)).toContain(7);
    expect(mc.node.relayhosts.map((r) => r.id)).toContain(8);
  });

  it('adds only the missing panel addresses to the fail2ban whitelist and changes nothing else', async () => {
    mc.node.fail2ban.whitelist = '198.51.100.7\n203.0.113.10';
    const result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10', '2001:db8::/64'] });
    expect(result.node.find((i) => i.item === 'fail2ban')).toEqual({ item: 'fail2ban', target: '203.0.113.10, 2001:db8::/64', status: 'changed', to: '2001:db8::/64' });
    expect(mc.writes.find((w) => w.path === 'edit/fail2ban').body).toEqual({ items: ['2001:db8::/64'], attr: { action: 'whitelist' } });
    expect(mc.node.fail2ban).toMatchObject({ whitelist: '198.51.100.7\n2001:db8::/64\n203.0.113.10', ban_time_increment: true, max_attempts: 10 });
  });

  it('takes out of the fail2ban whitelist only an address the panel added itself', async () => {
    mc.node.fail2ban.whitelist = '198.51.100.7';
    const first = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10', '198.51.100.7'] });
    expect(first.owned.fail2ban).toEqual(['203.0.113.10']);
    const result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.20'], owned: first.owned });
    expect(result.node.find((i) => i.item === 'fail2ban')).toEqual({
      item: 'fail2ban', target: '203.0.113.20', status: 'changed', from: '203.0.113.10', to: '203.0.113.20',
    });
    // The administrator's address stays; every other field of fail2ban too.
    expect(mc.node.fail2ban).toMatchObject({
      whitelist: '198.51.100.7\n203.0.113.20', ban_time_increment: true, manage_external: 0, max_attempts: 10, ban_time: 1800, blacklist: '',
    });
    expect(result.owned.fail2ban).toEqual(['203.0.113.20']);
    const plain = mc.writes.find((w) => w.path === 'edit/fail2ban' && w.body.attr.action === undefined);
    expect(plain.body.attr).toMatchObject({ ban_time_increment: '1', manage_external: 0, whitelist: '198.51.100.7\n203.0.113.20' });
    // The setting cleared: the panel's own address goes as well.
    const cleared = await runApply(CFG, { eop: EOP, panelIps: [], owned: result.owned });
    expect(cleared.node.find((i) => i.item === 'fail2ban')).toMatchObject({ status: 'changed', from: '203.0.113.20' });
    expect(mc.node.fail2ban.whitelist).toBe('198.51.100.7');
  });

  describe('DKIM', () => {
    it('makes a key for a domain mailcow signs and shows the record as one string', async () => {
      delete mc.node.dkim['a.example'];
      mc.node.splitDkim = true;
      const [domain] = (await runApply(CFG, { eop: EOP, node: false, domains: [domainInput()] })).domains;
      expect(domain.items.find((i) => i.item === 'dkim')).toEqual({ item: 'dkim', target: 'a.example', status: 'changed', from: null, to: 'dkim' });
      expect(mc.writes.find((w) => w.path === 'add/dkim').body).toEqual({ domains: 'a.example', dkim_selector: 'dkim', key_size: 2048 });
      expect(domain.dkim.txt).toBe(`v=DKIM1;k=rsa;t=s;s=email;p=KEY2048${'A'.repeat(380)}`);
      expect(domain.dkim.txt).not.toContain('"');
    });

    it('deletes the key of a domain the tenant signs only when the administrator confirmed it', async () => {
      const input = domainInput({ dkimMode: 'eop' });
      let [domain] = (await runApply(CFG, { eop: EOP, node: false, domains: [input] })).domains;
      expect(domain.items.find((i) => i.item === 'dkim')).toEqual({ item: 'dkim', target: 'a.example', status: 'skipped', code: 'dkim_delete_unconfirmed' });
      expect(domain.dkim).toMatchObject({ selector: 'dkim' });
      expect(mc.node.dkim['a.example']).toBeDefined();
      [domain] = (await runApply(CFG, { eop: EOP, node: false, domains: [input], confirmDkimDelete: true })).domains;
      expect(domain.items.find((i) => i.item === 'dkim')).toMatchObject({ status: 'changed', from: 'dkim', to: null });
      expect(mc.node.dkim['a.example']).toBeUndefined();
      [domain] = (await runApply(CFG, { eop: EOP, node: false, domains: [input], confirmDkimDelete: true })).domains;
      expect(domain.items.find((i) => i.item === 'dkim')).toMatchObject({ status: 'ok' });
      expect(domain.dkim).toBeNull();
    });
  });

  describe('send limits', () => {
    it('keeps an administrator\'s limit, sets the default on the rest and names the mailboxes the node refused', async () => {
      mc.node.mailboxes.push({ username: 'three@a.example' }, { username: 'four@a.example' });
      mc.node.rlRefuse = ['three@a.example'];
      const input = domainInput({
        accounts: [
          { email: 'one@a.example', override: { value: 500, frame: 'd' } },
          { email: 'two@a.example', override: null },
          { email: 'three@a.example', override: null },
          { email: 'four@a.example', override: null },
          { email: 'gone@a.example', override: null },
        ],
      });
      const [domain] = (await runApply(CFG, { eop: EOP, node: false, domains: [input] })).domains;
      expect(domain.items.find((i) => i.item === 'mailbox_limits')).toEqual({
        item: 'mailbox_limits', target: 'a.example', status: 'failed', code: 'mail_node_refused', detail: 'access_denied',
        counts: { mailboxes: 4, matching: 1, changed: 2, failed: 1, missing: 1 }, mailboxes: ['three@a.example'],
      });
      expect(mc.node.mailboxes.map((m) => [m.username, m.rl])).toEqual([
        ['one@a.example', { value: '500', frame: 'd' }],
        ['two@a.example', { value: '50', frame: 'h' }],
        ['three@a.example', undefined],
        ['four@a.example', { value: '50', frame: 'h' }],
      ]);
      // One call per limit, each mailbox of a limit in it.
      expect(mc.writes.filter((w) => w.path === 'edit/rl-mbox').map((w) => w.body)).toEqual([
        { items: ['one@a.example'], attr: { rl_value: '500', rl_frame: 'd' } },
        { items: ['three@a.example', 'four@a.example'], attr: { rl_value: '50', rl_frame: 'h' } },
      ]);
    });

    it('reads only the domain\'s mailboxes, and none for a domain without panel mailboxes', async () => {
      await runApply(CFG, { eop: EOP, node: false, domains: [domainInput(), { ...domainInput(), domain: 'b.example', accounts: [] }] });
      const lists = mc.writes.length;
      expect(lists).toBeGreaterThan(0);
      const calls = [];
      const fetch = mc.fetch;
      mc.fetch = (url, options) => { calls.push(url.replace(/^https:\/\/[^/]+\/api\/v1\//, '')); return fetch(url, options); };
      await runApply(CFG, { eop: EOP, node: false, domains: [domainInput(), { ...domainInput(), domain: 'b.example', accounts: [] }] });
      expect(calls.filter((c) => c.startsWith('get/mailbox/'))).toEqual(['get/mailbox/all/a.example']);
    });

    it('goes on with the run when one read times out, and stops at the second timeout', async () => {
      mc.node.domains['b.example'] = { relayhost: 0 };
      mc.node.slow = ['get/mailbox/all/a.example'];
      let result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10'], domains: [domainInput(), { ...domainInput(), domain: 'b.example', accounts: [] }] });
      expect(result.domains[0].items.find((i) => i.item === 'mailbox_limits')).toEqual({
        item: 'mailbox_limits', target: 'a.example', status: 'failed', code: 'mail_node_unreachable', detail: 'timeout',
      });
      expect(result.domains[1].items.every((i) => i.status !== 'failed')).toBe(true);
      mc.node.slow = ['get/tls-policy-map/all', 'get/relayhost/all'];
      result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10'], domains: [domainInput()] });
      expect(result.node.map((i) => [i.item, i.status, i.detail ?? null])).toEqual([
        ['tls_policy', 'failed', 'timeout'], ['relayhost', 'failed', 'timeout'],
        ['fail2ban', 'failed', null], ['prefilter', 'failed', null], ['forwarding_hosts', 'failed', null],
      ]);
    });

    it('takes the domain\'s limit over the EOP settings\' one, per hour', () => {
      expect(defaultRateLimit({ sendLimitPerHour: 50 }, null)).toEqual({ value: 50, frame: 'h' });
      expect(defaultRateLimit({ sendLimitPerHour: 50 }, 20)).toEqual({ value: 20, frame: 'h' });
    });
  });

  it('stops asking a node that does not answer: every item after fails with the same code', async () => {
    mc.node.down = true;
    const calls = vi.spyOn(mc, 'fetch');
    const result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10'], domains: [domainInput()] });
    expect([...result.node, ...result.domains[0].items].map((i) => [i.item, i.status, i.code])).toEqual([
      ['tls_policy', 'failed', 'mail_node_unreachable'],
      ['relayhost', 'failed', 'mail_node_unreachable'],
      ['fail2ban', 'failed', 'mail_node_unreachable'],
      ['prefilter', 'failed', 'mail_node_unreachable'],
      ['forwarding_hosts', 'failed', 'mail_node_unreachable'],
      ['domain_relayhost', 'failed', 'mail_node_unreachable'],
      ['dkim', 'failed', 'mail_node_unreachable'],
      ['mailbox_limits', 'failed', 'mail_node_unreachable'],
    ]);
    calls.mockRestore();
  });

  it('reports a refusal with the node\'s own words and goes on with the other items', async () => {
    mc.node.refuse['add/tls-policy-map'] = 'tls_policy_map_parameter_invalid';
    const result = await runApply(CFG, { eop: EOP, domains: [domainInput()] });
    expect(result.node[0]).toEqual({
      item: 'tls_policy', target: 'eop.example.net', status: 'failed', code: 'mail_node_refused', detail: 'tls_policy_map_parameter_invalid',
    });
    expect(statuses(result.domains[0].items)).toEqual({ domain_relayhost: 'changed', dkim: 'ok', mailbox_limits: 'changed' });
  });
});

describe('the spam filing rule', () => {
  const RULE = [
    '# BEGIN MailExpert: EOP verdicts to Junk (managed by MailExpert, do not edit)',
    'if anyof (',
    '  header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*CAT:(PHSH|HPHSH|HPHISH|MALW|SPM|HSPM|SPOOF)[[:space:]]*(;|$)",',
    '  allof (',
    '    not header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*SFV:SKQ[[:space:]]*(;|$)",',
    '    anyof (',
    '      header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*SFV:(SPM|SKS|SKB)[[:space:]]*(;|$)",',
    '      header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*CAT:BULK[[:space:]]*(;|$)"',
    '    )',
    '  )',
    ') {',
    '  fileinto "Junk";',
    '  stop;',
    '}',
    '# END MailExpert: EOP verdicts',
  ].join('\n');

  it('files phishing, malware, spam and spoofing always, and bulk unless released from quarantine (D-2, D-11, section 5.14)', () => {
    expect(PREFILTER_ALWAYS_CAT).toEqual(['PHSH', 'HPHSH', 'HPHISH', 'MALW', 'SPM', 'HSPM', 'SPOOF']);
    expect(PREFILTER_SFV).toEqual(['SPM', 'SKS', 'SKB']);
    expect(PREFILTER_CAT).toEqual(['BULK']);
    const script = buildPrefilter('');
    expect(script).toContain('require ["fileinto", "regex"];');
    expect(script.endsWith(`${RULE}\n`)).toBe(true);
  });

  // The rule as Pigeonhole runs it, from the generated script itself: its four regular expressions in
  // order (phishing and malware; released from quarantine; the spam verdicts; the spam categories),
  // as POSIX ERE matched case-insensitively (the default comparator i;ascii-casemap), combined the way
  // the script's anyof / allof / not combine them. [[:space:]] reads as \s in JavaScript.
  const regexes = [...buildPrefilter('').matchAll(/header :regex "X-Forefront-Antispam-Report" "([^"]*)"/g)]
    .map((m) => new RegExp(m[1].replaceAll('[[:space:]]', '\\s'), 'i'));
  const toJunk = (header) => {
    const [always, released, verdict, category] = regexes.map((re) => re.test(header));
    return always || (!released && (verdict || category));
  };

  it('has the four tests the rule combines', () => {
    expect(regexes).toHaveLength(4);
  });

  it('decides by whole fields, also in a folded header', () => {
    const cases = [
      ['CIP:198.51.100.1;CTRY:;LANG:en;SCL:5;SRV:;IPV:NLI;SFV:SPM;H:x;PTR:;CAT:SPM;SFS:(13230040);DIR:INB;', true],
      ['CIP:198.51.100.1;SFV:NSPM;H:x;CAT:NONE;', false],
      ['CIP:198.51.100.1;SFV:NSPM;CAT:BULK;', true],
      ['SFV:NSPM;CAT:SPOOF;', true],
      ['SFV:NSPM;CAT:MALW;', true],
      ['SFV:NSPM;CAT:HPHSH', true],
      // Released from quarantine (the panel releases spam and phishing, section 5.14): phishing,
      // malware, spam and spoofing still go to Junk; only bulk does not.
      ['SFV:SKQ;CAT:PHSH;', true],
      ['SFV:SKQ;CAT:HPHISH;', true],
      ['SFV:SKQ;CAT:MALW;', true],
      ['SFV:SKQ;CAT:SPM;', true],
      ['SFV:SKQ;CAT:HSPM;', true],
      ['SFV:SKQ;CAT:SPOOF;', true],
      ['SFV:SKQ;CAT:BULK;', false],
      ['SFV:SKQ;CAT:NONE;', false],
      // What MoveToJmf delivers for each verdict the panel sets (section 5.14).
      ['SFV:SPM;CAT:HSPM;SCL:9;', true],
      ['SFV:SPM;CAT:PHSH;SCL:9;', true],
      ['CIP:198.51.100.1;SFV:SPMX;CAT:SPMTEST;XSFV:SPM;XCAT:PHSH;CAT:PHSHX', false],
      // Unfolded, a folded header keeps a blank after the ";" where it was broken.
      ['CIP:198.51.100.1;CTRY:;LANG:en; SFV:SKS;H:x;', true],
      ['CIP:198.51.100.1; CAT:PHSH ;SFV:SKQ', true],
      ['sfv:spm', true],
    ];
    for (const [header, junk] of cases) expect(toJunk(header), header).toBe(junk);
  });

  it('keeps whatever else the prefilter holds and is built the same from its own output', () => {
    const own = 'require ["fileinto"];\r\nif header :contains "X-Custom" "1" {\r\n  fileinto "Custom";\r\n}\r\n';
    const script = buildPrefilter(own);
    const lines = script.split('\n');
    expect(lines[0]).toMatch(/^# BEGIN MailExpert: extensions/);
    expect(script).toContain('require ["fileinto"];\nif header :contains "X-Custom" "1" {\n  fileinto "Custom";\n}');
    expect(script.indexOf('X-Custom')).toBeLessThan(script.indexOf('X-Forefront-Antispam-Report'));
    expect(script.endsWith('# END MailExpert: EOP verdicts\n')).toBe(true);
    expect(buildPrefilter(script)).toBe(script);
    expect(buildPrefilter(buildPrefilter(''))).toBe(buildPrefilter(''));
    expect(buildPrefilter(mc.STOCK_PREFILTER).startsWith(buildPrefilter('').split('\n\n')[0])).toBe(true);
  });

  it('is written only by its own action, and only when it differs', async () => {
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'changed' });
    expect(mc.node.prefilter).toBe(buildPrefilter(mc.STOCK_PREFILTER));
    expect(mc.node.prefilter).toContain('# global_sieve_before script');
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'ok' });
    expect(mc.writes.filter((w) => w.path === 'add/global-filter')).toHaveLength(1);
    expect(mc.writes[0].body).toEqual({ filter_type: 'prefilter', script_data: mc.node.prefilter });
    expect(statuses((await runApply(CFG, { eop: EOP })).node).prefilter).toBe('ok');
  });

  it('takes a block written twice out in one pass, and refuses markers that do not pair up', () => {
    const once = buildPrefilter('keep;');
    const twice = `${once}\n${buildPrefilter('')}`;
    expect(buildPrefilter(twice)).toBe(once);
    const noEnd = once.replace('# END MailExpert: EOP verdicts\n', '');
    expect(() => buildPrefilter(noEnd)).toThrow(expect.objectContaining({ code: 'prefilter_markers_broken' }));
    const noBegin = once.replace('# BEGIN MailExpert: extensions of the EOP verdict rule (managed by MailExpert, do not edit)\n', '');
    expect(() => buildPrefilter(noBegin)).toThrow(expect.objectContaining({ code: 'prefilter_markers_broken' }));
  });

  it('writes nothing to a prefilter with broken markers and reports it', async () => {
    mc.node.prefilter = buildPrefilter('keep;').replace('# END MailExpert: extensions\n', '');
    expect(await runPrefilterApply(CFG)).toMatchObject({ item: 'prefilter', status: 'failed', code: 'prefilter_markers_broken' });
    expect(statuses((await runApply(CFG, { eop: EOP })).node).prefilter).toBe('failed');
    expect(mc.writes.filter((w) => w.path === 'add/global-filter')).toEqual([]);
  });

  it('reads the rule back after writing it: mailcow may answer written without writing', async () => {
    mc.node.prefilterLost = true;
    expect(await runPrefilterApply(CFG)).toMatchObject({ item: 'prefilter', status: 'failed', code: 'prefilter_not_written' });
  });

  it('counts a rule written while Dovecot did not restart as changed, with the reason', async () => {
    mc.node.restartFails = true;
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'changed', code: 'dovecot_restart_failed' });
    mc.node.prefilter = 'garbage';
    mc.node.refuse['add/global-filter'] = 'sieve_error';
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'failed', code: 'mail_node_refused', detail: 'sieve_error' });
  });
});

describe('forwarding hosts (R-12)', () => {
  const RANGES = { version: '2026081400', ipv4: ['40.92.0.0/15', '40.107.0.0/16'], ipv6: ['2a01:111:f400::/48'] };
  const WANTED = ['40.92.0.0/15', '40.107.0.0/16', '2a01:111:f400::/48'];
  const fwdItem = (result) => result.node.find((i) => i.item === 'forwarding_hosts');
  const fwdWrites = () => mc.writes.filter((w) => w.path.endsWith('/fwdhost'));
  const hosts = () => mc.node.fwdhosts.map((h) => `${h.host}${h.keepSpam ? ' keep' : ''}`).sort();
  const withRule = () => { mc.node.prefilter = buildPrefilter(mc.STOCK_PREFILTER); };

  it('waits for the spam filing rule: without it nothing is added', async () => {
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toEqual({
      item: 'forwarding_hosts', target: '2026081400', status: 'skipped', code: 'prefilter_not_applied',
      fwdhosts: { version: '2026081400', wanted: 3, missing: WANTED, foreign: [], keepSpam: [] },
    });
    expect(fwdWrites()).toEqual([]);
    expect(result.owned.fwdhosts).toEqual([]);
  });

  it('adds every range with filter_spam 1 once the rule is in place, then finds them in place', async () => {
    withRule();
    const first = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(first)).toEqual({
      item: 'forwarding_hosts', target: '2026081400', status: 'changed', from: null, to: WANTED.join(', '),
      fwdhosts: { version: '2026081400', wanted: 3, missing: [], foreign: [], keepSpam: [] },
    });
    expect(fwdWrites().map((w) => w.body)).toEqual(WANTED.map((hostname) => ({ hostname, filter_spam: 1 })));
    expect(hosts()).toEqual([...WANTED].sort());
    expect(first.owned.fwdhosts).toEqual(WANTED);

    mc.writes.length = 0;
    const again = await runApply(CFG, { eop: EOP, ranges: RANGES, owned: first.owned });
    expect(fwdItem(again)).toMatchObject({ status: 'ok', fwdhosts: { missing: [], foreign: [] } });
    expect(mc.writes).toEqual([]);
  });

  it('runs without <EOP_HOST>: the forwarding hosts do not depend on it', async () => {
    withRule();
    const result = await runApply(CFG, { eop: { ...EOP, eopHost: null }, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({ status: 'changed' });
  });

  it('leaves entries it did not add alone, and counts a foreign entry of a range as in place', async () => {
    withRule();
    mc.node.fwdhosts.push(
      { host: '198.51.100.7', source: 'relay.example.org', keepSpam: false },
      { host: '40.107.0.0/16', source: '40.107.0.0/16', keepSpam: false },
    );
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({
      status: 'changed', from: null, to: '40.92.0.0/15, 2a01:111:f400::/48',
      fwdhosts: { missing: [], foreign: ['198.51.100.7', '40.107.0.0/16'], keepSpam: [] },
    });
    expect(result.owned.fwdhosts).toEqual(['40.92.0.0/15', '2a01:111:f400::/48']);
    // The range leaves the list: only what the panel added goes; the foreign entries stay.
    const later = await runApply(CFG, { eop: EOP, ranges: { ...RANGES, ipv4: ['40.107.0.0/16'] }, owned: result.owned });
    expect(fwdItem(later)).toMatchObject({ status: 'changed', from: '40.92.0.0/15', fwdhosts: { missing: [] } });
    expect(fwdItem(later).to).toBeUndefined();
    expect(fwdWrites().filter((w) => w.path === 'delete/fwdhost').map((w) => w.body)).toEqual([['40.92.0.0/15']]);
    expect(hosts()).toEqual(['198.51.100.7', '2a01:111:f400::/48', '40.107.0.0/16']);
    expect(later.owned.fwdhosts).toEqual(['2a01:111:f400::/48']);
  });

  it('turns the spam filter on for a foreign entry of a range, and leaves it foreign', async () => {
    withRule();
    mc.node.fwdhosts.push({ host: '40.92.0.0/15', source: '40.92.0.0/15', keepSpam: true });
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({
      status: 'changed', code: 'fwdhost_filter_turned_on', from: null, to: '40.107.0.0/16, 2a01:111:f400::/48, 40.92.0.0/15',
      fwdhosts: { missing: [], foreign: ['40.92.0.0/15'], keepSpam: [], filterTurnedOn: ['40.92.0.0/15'] },
    });
    expect(fwdWrites().map((w) => w.body)).toContainEqual({ hostname: '40.92.0.0/15', filter_spam: 1 });
    expect(hosts()).toEqual([...WANTED].sort());
    // Not the panel's: a range that leaves the list does not take it away.
    expect(result.owned.fwdhosts).toEqual(['40.107.0.0/16', '2a01:111:f400::/48']);
    await runApply(CFG, { eop: EOP, ranges: { ...RANGES, ipv4: ['40.107.0.0/16'] }, owned: result.owned });
    expect(hosts()).toContain('40.92.0.0/15');
  });

  it('reports any entry rspamd does not check that overlaps a range, wider or narrower', async () => {
    withRule();
    mc.node.fwdhosts.push(
      { host: '40.0.0.0/8', source: 'partner.example.org', keepSpam: true },
      { host: '2a01:111:f400::25', source: '2a01:111:f400::25', keepSpam: true },
      { host: '198.51.100.0/24', source: '198.51.100.0/24', keepSpam: true },
    );
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({
      status: 'failed', code: 'fwdhost_keep_spam', to: WANTED.join(', '),
      fwdhosts: { missing: [], keepSpam: ['40.0.0.0/8', '2a01:111:f400::25'] },
    });
    // Neither is touched: they are somebody else's networks, not the ranges.
    expect(hosts()).toContain('40.0.0.0/8 keep');
    expect(hosts()).toContain('2a01:111:f400::25 keep');
    expect(fwdWrites().filter((w) => w.path === 'delete/fwdhost')).toEqual([]);
  });

  it('adds its own entry again when someone turned the spam check off on it', async () => {
    withRule();
    const first = await runApply(CFG, { eop: EOP, ranges: RANGES });
    mc.node.fwdhosts.find((h) => h.host === '40.107.0.0/16').keepSpam = true;
    mc.writes.length = 0;
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES, owned: first.owned });
    expect(fwdItem(result)).toMatchObject({ status: 'changed', from: null, to: '40.107.0.0/16' });
    expect(fwdWrites().map((w) => w.body)).toEqual([{ hostname: '40.107.0.0/16', filter_spam: 1 }]);
    expect(hosts()).toEqual([...WANTED].sort());
  });

  it('never applies a malformed or empty list, and keeps what it added', async () => {
    withRule();
    const first = await runApply(CFG, { eop: EOP, ranges: RANGES });
    mc.writes.length = 0;
    for (const ranges of [{ ...RANGES, ipv4: [] }, { ...RANGES, ipv4: ['40.92.0.0/15', 'nonsense'] }, null]) {
      const result = await runApply(CFG, { eop: EOP, ranges, owned: first.owned });
      expect(fwdItem(result)).toEqual({ item: 'forwarding_hosts', target: null, status: 'skipped', code: 'eop_ranges_invalid' });
      expect(result.owned.fwdhosts).toEqual(WANTED);
    }
    expect(mc.writes).toEqual([]);
    expect(hosts()).toEqual([...WANTED].sort());
  });

  it('keeps its entries when the spam filing rule stops matching, and shows them', async () => {
    withRule();
    const first = await runApply(CFG, { eop: EOP, ranges: RANGES });
    mc.node.prefilter = mc.STOCK_PREFILTER;
    mc.writes.length = 0;
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES, owned: first.owned });
    expect(fwdItem(result)).toEqual({
      item: 'forwarding_hosts', target: '2026081400', status: 'skipped', code: 'prefilter_not_applied',
      current: WANTED.join(', '),
      fwdhosts: { version: '2026081400', wanted: 3, missing: [], foreign: [], keepSpam: [] },
    });
    expect(mc.writes).toEqual([]);
    expect(result.owned.fwdhosts).toEqual(WANTED);
  });

  it('fails the item when the node refuses an add, saying what was added before', async () => {
    withRule();
    mc.node.refuse['add/fwdhost'] = 'redis_error';
    let result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({ status: 'failed', code: 'mail_node_refused', detail: 'redis_error' });
    expect(fwdItem(result).to).toBeUndefined();
    expect(result.owned.fwdhosts).toEqual([]);
    // The second add refused: the first one is the panel's and in the result.
    delete mc.node.refuse['add/fwdhost'];
    const fetch = mc.fetch;
    let adds = 0;
    fake.current = {
      ...mc,
      fetch: (url, options) => (url.endsWith('add/fwdhost') && ++adds === 2
        ? Promise.resolve({ status: 200, ok: true, json: async () => [{ type: 'danger', msg: 'redis_error' }] })
        : fetch(url, options)),
    };
    result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(fwdItem(result)).toMatchObject({ status: 'failed', code: 'mail_node_refused', from: null, to: '40.92.0.0/15' });
    expect(result.owned.fwdhosts).toEqual(['40.92.0.0/15']);
  });

  it('fails the item when the node does not list what it added or still lists what it deleted', async () => {
    withRule();
    const first = await runApply(CFG, { eop: EOP, ranges: RANGES });
    // A node that answers "deleted" and keeps the entry.
    const fetch = mc.fetch;
    fake.current = {
      ...mc,
      fetch: (url, options) => (url.endsWith('delete/fwdhost')
        ? Promise.resolve({ status: 200, ok: true, json: async () => [{ type: 'success', msg: 'forwarding_host_removed' }] })
        : fetch(url, options)),
    };
    const result = await runApply(CFG, { eop: EOP, ranges: { ...RANGES, ipv4: ['40.107.0.0/16'] }, owned: first.owned });
    expect(fwdItem(result)).toMatchObject({ status: 'failed', code: 'fwdhost_not_deleted' });
    // Still the panel's, to delete on the next run.
    expect(result.owned.fwdhosts).toEqual(['40.92.0.0/15', '40.107.0.0/16', '2a01:111:f400::/48']);
  });

  it('tells a spam filing rule that could not be read from one that is missing', async () => {
    withRule();
    mc.node.slow = ['get/global_filters/prefilter'];
    const result = await runApply(CFG, { eop: EOP, ranges: RANGES });
    expect(statuses(result.node).prefilter).toBe('failed');
    expect(fwdItem(result)).toMatchObject({ status: 'skipped', code: 'prefilter_check_failed' });
    expect(fwdWrites()).toEqual([]);
  });

  it('uses the static EOP ranges by default', async () => {
    withRule();
    const result = await runApply(CFG, { eop: EOP });
    expect(fwdItem(result)).toMatchObject({ status: 'changed', fwdhosts: { wanted: 6, missing: [] } });
    expect(fwdWrites().every((w) => w.body.filter_spam === 1)).toBe(true);
  });
});
