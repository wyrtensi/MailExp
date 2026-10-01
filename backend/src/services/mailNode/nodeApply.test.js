// Applying the panel's settings to a mail node: runApply against a mailcow in memory
// (testing/fakeMailcow.js) that answers as mailcow 2026-09 does. Every run reads first and writes
// only what differs, so a second run writes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMailcow } from '../testing/fakeMailcow.js';

const fake = vi.hoisted(() => ({ current: null }));
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../safeFetch.js', () => ({ safeFetch: (url, options) => fake.current.fetch(url, options) }));

const { PREFILTER_CAT, PREFILTER_SFV, buildPrefilter, defaultRateLimit, runApply, runPrefilterApply } = await import('./nodeApply.js');

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
    expect(statuses(first.node)).toEqual({ tls_policy: 'changed', relayhost: 'changed', fail2ban: 'changed', prefilter: 'pending' });
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
    expect(statuses(again.node)).toEqual({ tls_policy: 'ok', relayhost: 'ok', fail2ban: 'ok', prefilter: 'pending' });
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
    ]);
    expect(result.domains[0].items[0]).toEqual({ item: 'domain_relayhost', target: 'a.example', status: 'skipped', code: 'eop_host_missing' });
    expect(mc.node.relayhosts).toEqual([]);
  });

  it('adds only the missing panel addresses to the fail2ban whitelist and changes nothing else', async () => {
    mc.node.fail2ban.whitelist = '198.51.100.7\n203.0.113.10';
    const result = await runApply(CFG, { eop: EOP, panelIps: ['203.0.113.10', '2001:db8::/64'] });
    expect(result.node.find((i) => i.item === 'fail2ban')).toEqual({ item: 'fail2ban', target: '203.0.113.10, 2001:db8::/64', status: 'changed', to: '2001:db8::/64' });
    expect(mc.writes.find((w) => w.path === 'edit/fail2ban').body).toEqual({ items: ['2001:db8::/64'], attr: { action: 'whitelist' } });
    expect(mc.node.fail2ban).toMatchObject({ whitelist: '198.51.100.7\n2001:db8::/64\n203.0.113.10', ban_time_increment: true, max_attempts: 10 });
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
  it('files spam, rule spam, blocked senders, spam, bulk and phishing categories into Junk, never a quarantine release', () => {
    expect(PREFILTER_SFV).toEqual(['SPM', 'SKS', 'SKB']);
    expect(PREFILTER_CAT).toEqual(['SPM', 'HSPM', 'PHSH', 'HPHSH', 'HPHISH', 'BULK']);
    const script = buildPrefilter('');
    expect(script).toContain('require ["fileinto", "regex"];');
    expect(script).toContain('header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*SFV:(SPM|SKS|SKB)[[:space:]]*(;|$)"');
    expect(script).toContain('header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*CAT:(SPM|HSPM|PHSH|HPHSH|HPHISH|BULK)[[:space:]]*(;|$)"');
    expect(script).toContain('not header :regex "X-Forefront-Antispam-Report" "(^|;)[[:space:]]*SFV:SKQ[[:space:]]*(;|$)"');
    expect(script).toContain('  fileinto "Junk";\n  stop;\n');
  });

  // The rule's regular expressions as POSIX ERE the way Pigeonhole runs them (case-insensitive):
  // JavaScript reads [[:space:]] as \s here.
  const matches = (header, name, values) => new RegExp(`(^|;)\\s*${name}:(${values.join('|')})\\s*(;|$)`, 'i').test(header);
  const toJunk = (header) => (matches(header, 'SFV', PREFILTER_SFV) || matches(header, 'CAT', PREFILTER_CAT)) && !matches(header, 'SFV', ['SKQ']);

  it('matches whole fields only, also in a folded header', () => {
    expect(toJunk('CIP:198.51.100.1;CTRY:;LANG:en;SCL:5;SRV:;IPV:NLI;SFV:SPM;H:x;PTR:;CAT:SPM;SFS:(13230040);DIR:INB;')).toBe(true);
    expect(toJunk('CIP:198.51.100.1;SFV:NSPM;H:x;CAT:NONE;')).toBe(false);
    expect(toJunk('CIP:198.51.100.1;SFV:NSPM;CAT:BULK;')).toBe(true);
    expect(toJunk('SFV:SKQ;CAT:SPM;')).toBe(false);
    expect(toJunk('CIP:198.51.100.1;SFV:SPMX;CAT:SPMTEST;XSFV:SPM;')).toBe(false);
    // Unfolded, a folded header keeps a blank after the ";" where it was broken.
    expect(toJunk('CIP:198.51.100.1;CTRY:;LANG:en; SFV:SKS;H:x;')).toBe(true);
    expect(toJunk('SFV:NSPM;CAT:HPHSH')).toBe(true);
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

  it('counts a rule written while Dovecot did not restart as changed, with the reason', async () => {
    mc.node.restartFails = true;
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'changed', code: 'dovecot_restart_failed' });
    mc.node.prefilter = 'garbage';
    mc.node.refuse['add/global-filter'] = 'sieve_error';
    expect(await runPrefilterApply(CFG)).toEqual({ item: 'prefilter', target: null, status: 'failed', code: 'mail_node_refused', detail: 'sieve_error' });
  });
});
