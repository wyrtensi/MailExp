// A mailcow in memory for tests of services/mailNode/nodeApply.js and the panel CLI: answers the API calls the panel
// makes the way mailcow 2026-09 does (data/web/json_api.php and inc/functions.*.inc.php), through a
// stand-in for safeFetch. Keeps what it was asked to change so a test can read the node afterwards
// and run the panel again.

const STOCK_PREFILTER = '# global_sieve_before script\n# global_sieve_before -> user sieve_before (mailcow UI) -> user sieve_after (mailcow UI) -> global_sieve_after\n';

function answer(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
const success = (...msg) => ({ type: 'success', msg });
const danger = (...msg) => ({ type: 'danger', msg });

export function createFakeMailcow(initial = {}) {
  const node = {
    tls: [],
    relayhosts: [],
    domains: {},
    dkim: {},
    mailboxes: [],
    // Per-mailbox Sieve filters: { id, username, filter_type, script_desc, script_data, active }.
    filters: [],
    prefilter: STOCK_PREFILTER,
    fail2ban: {
      ban_time: 1800, max_ban_time: 10000, ban_time_increment: true, max_attempts: 10, retry_window: 600,
      netban_ipv4: 32, netban_ipv6: 128, banlist_id: 'b1', manage_external: 0, whitelist: '', blacklist: '',
    },
    // Forwarding hosts as Redis keeps them: { host, source, keepSpam } (WHITELISTED_FWD_HOST and
    // KEEP_SPAM, functions.fwdhost.inc.php).
    fwdhosts: [],
    restartFails: false,
    // add/global-filter answers "written" without writing (the file is missing in mailcow).
    prefilterLost: false,
    splitDkim: false,
    refuse: {},
    // Paths that time out once each (the request's AbortSignal fires).
    slow: [],
    ...initial,
  };
  let nextId = 1;
  const writes = [];

  const dkimTxt = (pub) => {
    const txt = `v=DKIM1;k=rsa;t=s;s=email;p=${pub}`;
    if (!node.splitDkim) return txt;
    const chunks = txt.match(/.{1,255}/g);
    return `"${chunks.join('" "')}"`;
  };

  function get(path) {
    if (path === 'get/tls-policy-map/all') return node.tls.length ? node.tls : {};
    if (path === 'get/relayhost/all') {
      return node.relayhosts.length
        ? node.relayhosts.map((r) => ({
          ...r,
          used_by_domains: Object.keys(node.domains).filter((d) => node.domains[d].relayhost === r.id).join(', '),
          used_by_mailboxes: '',
        }))
        : {};
    }
    if (path === 'get/mailbox/all' || path.startsWith('get/mailbox/all/')) {
      const domain = path.startsWith('get/mailbox/all/') ? decodeURIComponent(path.slice('get/mailbox/all/'.length)) : null;
      return node.mailboxes.filter((m) => !domain || m.username.endsWith(`@${domain}`)).map((m) => ({
        username: m.username, active: '1', active_int: 1, quota: 5368709120, quota_used: 0,
        rl: m.rl ?? false, rl_scope: m.rl ? 'mailbox' : 'domain',
      }));
    }
    // One mailbox (getMailbox): mailcow answers {} for an address it does not have.
    if (path.startsWith('get/mailbox/')) {
      const email = decodeURIComponent(path.slice('get/mailbox/'.length));
      const m = node.mailboxes.find((entry) => entry.username === email);
      return m ? {
        username: m.username, domain: email.split('@')[1], active: '1', active_int: m.active_int ?? 1,
        quota: 5368709120, quota_used: 0, authsource: 'mailcow', attributes: { imap_access: '1', force_pw_update: '0' },
      } : {};
    }
    if (path === 'get/status/vmail') return node.disk ?? { used_percent: '12%', used: '1.2G', total: '10G' };
    if (path === 'get/domain/all') {
      return Object.keys(node.domains).map((d) => ({
        domain_name: d, active: '1', relayhost: String(node.domains[d].relayhost),
        ...(node.domains[d].created ? { created: node.domains[d].created } : {}),
      }));
    }
    if (path.startsWith('get/domain/')) {
      const d = decodeURIComponent(path.slice('get/domain/'.length));
      return node.domains[d] ? { domain_name: d, relayhost: String(node.domains[d].relayhost) } : {};
    }
    if (path.startsWith('get/dkim/')) {
      const d = decodeURIComponent(path.slice('get/dkim/'.length));
      const key = node.dkim[d];
      return key ? { pubkey: key.pub, length: '2048', dkim_txt: dkimTxt(key.pub), dkim_selector: key.selector, privkey: '' } : {};
    }
    if (path.startsWith('get/filters/')) {
      // Per-mailbox Sieve filters (functions.mailbox.inc.php filters, filter_details): {} when none.
      const email = decodeURIComponent(path.slice('get/filters/'.length)).toLowerCase();
      const own = node.filters.filter((f) => email === 'all' || f.username === email);
      return own.length ? own.map((f) => ({ ...f })) : {};
    }
    if (path === 'get/global_filters/prefilter') return node.prefilter ? node.prefilter : {};
    if (path === 'get/fail2ban') return { ...node.fail2ban, regex: { 1: 'x' }, perm_bans: '', active_bans: '' };
    if (path === 'get/fwdhost/all') {
      return node.fwdhosts.length
        ? node.fwdhosts.map((h) => ({ host: h.host, source: h.source, keep_spam: h.keepSpam ? 'yes' : 'no' }))
        : {};
    }
    return null;
  }

  function post(path, body) {
    writes.push({ path, body });
    if (node.refuse[path]) return [danger(node.refuse[path])];
    switch (path) {
      case 'add/tls-policy-map':
        if (node.tls.some((t) => t.dest === body.dest)) return [danger('tls_policy_map_entry_exists', body.dest)];
        node.tls.push({ id: nextId++, dest: body.dest, policy: body.policy, parameters: body.parameters ?? '', active: String(Number(body.active ?? 0)) });
        return [success('tls_policy_map_entry_saved', body.dest)];
      case 'edit/tls-policy-map': {
        const entry = node.tls.find((t) => t.id === Number(body.items[0]));
        Object.assign(entry, { dest: body.attr.dest, policy: body.attr.policy, parameters: body.attr.parameters, active: String(body.attr.active) });
        return [success('tls_policy_map_entry_saved', entry.dest)];
      }
      case 'delete/tls-policy-map':
        node.tls = node.tls.filter((t) => !body.map(Number).includes(t.id));
        return [success('tls_policy_map_entry_deleted', String(body[0]))];
      case 'add/relayhost':
        node.relayhosts.push({ id: nextId++, hostname: body.hostname, username: body.username ?? '', password: body.password ?? '', active: '1' });
        return [success('relayhost_added', '')];
      case 'delete/relayhost':
        node.relayhosts = node.relayhosts.filter((r) => !body.map(Number).includes(r.id));
        for (const d of Object.values(node.domains)) if (body.map(Number).includes(d.relayhost)) d.relayhost = 0;
        return [success('relayhost_removed', String(body[0]))];
      case 'edit/relayhost': {
        const entry = node.relayhosts.find((r) => r.id === Number(body.items[0]));
        entry.active = String(body.attr.active);
        return [success('object_modified', '')];
      }
      case 'add/mailbox': {
        const email = `${body.local_part}@${body.domain}`;
        if (node.mailboxes.some((m) => m.username === email)) return [danger('object_exists', email)];
        node.mailboxes.push({ username: email, rl: body.rl_value ? { value: body.rl_value, frame: body.rl_frame } : null });
        return [success('mailbox_added', email)];
      }
      case 'add/domain':
        if (node.domains[body.domain]) return [danger('domain_exists', body.domain)];
        node.domains[body.domain] = { relayhost: 0, created: '2026-10-08 10:00:00' };
        if (body.key_size) node.dkim[body.domain] = { pub: `KEY${body.key_size}${'A'.repeat(380)}`, selector: body.dkim_selector };
        return [success('domain_added', body.domain)];
      case 'edit/domain':
        node.domains[body.items[0]].relayhost = Number(body.attr.relayhost);
        return [success('domain_modified', body.items[0])];
      case 'add/dkim':
        if (node.dkim[body.domains] || !node.domains[body.domains]) return [danger('dkim_domain_or_sel_invalid', body.domains)];
        node.dkim[body.domains] = { pub: `KEY${body.key_size}${'A'.repeat(380)}`, selector: body.dkim_selector };
        return [success('dkim_added', body.domains)];
      case 'delete/dkim':
        for (const d of body) delete node.dkim[d];
        return [success('dkim_removed', body[0])];
      case 'edit/rl-mbox':
        return body.items.map((email) => {
          const mailbox = node.mailboxes.find((m) => m.username === email);
          if (!mailbox || (node.rlRefuse ?? []).includes(email)) return danger('access_denied');
          mailbox.rl = Number(body.attr.rl_value) ? { value: String(body.attr.rl_value), frame: body.attr.rl_frame } : null;
          return success('rl_saved', email);
        });
      case 'add/filter': {
        // An active filter makes the mailbox's other filters of that type inactive.
        if (!body.script_data || !body.script_desc) return [danger('value_missing')];
        if (body.filter_type !== 'prefilter' && body.filter_type !== 'postfilter') return [danger('filter_type')];
        const username = String(body.username).toLowerCase();
        const active = Number(body.active) ? 1 : 0;
        if (active) for (const f of node.filters) if (f.username === username && f.filter_type === body.filter_type) f.active = 0;
        node.filters.push({
          id: nextId++, username, filter_type: body.filter_type, script_desc: body.script_desc, script_data: body.script_data, active,
        });
        return [success('add_filter', username)];
      }
      case 'edit/filter':
        return body.items.map((id) => {
          const filter = node.filters.find((f) => f.id === Number(id));
          if (!filter) return danger('access_denied');
          const active = body.attr.active === undefined ? filter.active : Number(body.attr.active) ? 1 : 0;
          if (active) for (const f of node.filters) if (f.username === filter.username && f.filter_type === filter.filter_type) f.active = 0;
          filter.active = active;
          return success('mailbox_modified', filter.username);
        });
      case 'delete/filter':
        node.filters = node.filters.filter((f) => !body.map(Number).includes(f.id));
        return body.map((id) => success('delete_filter', String(id)));
      case 'add/global-filter':
        if (!node.prefilterLost) node.prefilter = body.script_data;
        return node.restartFails
          ? [{ type: 'warning', msg: 'dovecot_restart_failed' }, success('global_filter_written')]
          : [success('dovecot_restart_success'), success('global_filter_written')];
      case 'edit/fail2ban': {
        if (body.attr.action !== 'whitelist') {
          // The plain edit: every field from the request, ban_time_increment and manage_external
          // reset when left out (functions.fail2ban.inc.php).
          const a = body.attr;
          node.fail2ban = {
            ...node.fail2ban,
            ban_time: Number(a.ban_time ?? node.fail2ban.ban_time), max_ban_time: Number(a.max_ban_time ?? node.fail2ban.max_ban_time),
            max_attempts: Number(a.max_attempts ?? node.fail2ban.max_attempts), retry_window: Number(a.retry_window ?? node.fail2ban.retry_window),
            netban_ipv4: Number(a.netban_ipv4 ?? node.fail2ban.netban_ipv4), netban_ipv6: Number(a.netban_ipv6 ?? node.fail2ban.netban_ipv6),
            ban_time_increment: String(a.ban_time_increment) === '1',
            manage_external: Number(a.manage_external ?? 0) > 0 ? 1 : 0,
            whitelist: a.whitelist ?? node.fail2ban.whitelist,
            blacklist: a.blacklist ?? node.fail2ban.blacklist,
          };
          return [success('f2b_modified')];
        }
        const listed = node.fail2ban.whitelist ? node.fail2ban.whitelist.split('\n') : [];
        for (const network of body.items) if (!listed.includes(network)) listed.push(network);
        node.fail2ban.whitelist = listed.sort().join('\n');
        return body.items.map((network) => success('object_modified', network));
      }
      case 'add/fwdhost': {
        // An address or network is kept as given; filter_spam other than 1 sets KEEP_SPAM, and adding
        // an existing host again with filter_spam: 1 clears it.
        const host = String(body.hostname ?? '').trim();
        if (!/^[0-9a-fA-F:./]+$/.test(host)) return [danger('invalid_host', host)];
        const keepSpam = Number(body.filter_spam) !== 1;
        node.fwdhosts = [...node.fwdhosts.filter((h) => h.host !== host), { host, source: String(body.hostname), keepSpam }];
        return [success('forwarding_host_added', host)];
      }
      case 'delete/fwdhost':
        node.fwdhosts = node.fwdhosts.filter((h) => !body.includes(h.host));
        return body.map((host) => success('forwarding_host_removed', host));
      default:
        return { type: 'error', msg: 'route not found' };
    }
  }

  // The stand-in for safeFetch(url, options).
  async function fetch(url, options) {
    if (node.down) throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    const path = url.replace(/^https:\/\/[^/]+\/api\/v1\//, '');
    const slow = node.slow.indexOf(path);
    if (slow >= 0) {
      node.slow.splice(slow, 1);
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    if (options.method === 'GET') {
      const body = get(path);
      return body === null ? answer({ type: 'error', msg: 'route not found' }, 404) : answer(body);
    }
    return answer(post(path, JSON.parse(options.body)));
  }

  return { node, writes, fetch, STOCK_PREFILTER };
}
