// A mailcow in memory for tests of services/mailNode/nodeApply.js: answers the API calls the panel
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
    prefilter: STOCK_PREFILTER,
    fail2ban: {
      ban_time: 1800, max_ban_time: 10000, ban_time_increment: true, max_attempts: 10, retry_window: 600,
      netban_ipv4: 32, netban_ipv6: 128, banlist_id: 'b1', manage_external: 0, whitelist: '', blacklist: '',
    },
    restartFails: false,
    splitDkim: false,
    refuse: {},
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
    if (path === 'get/relayhost/all') return node.relayhosts.length ? node.relayhosts : {};
    if (path === 'get/mailbox/all') {
      return node.mailboxes.map((m) => ({
        username: m.username, active: '1', active_int: 1, quota: 5368709120, quota_used: 0,
        rl: m.rl ?? false, rl_scope: m.rl ? 'mailbox' : 'domain',
      }));
    }
    if (path === 'get/domain/all') return Object.keys(node.domains).map((d) => ({ domain_name: d, active: '1', relayhost: String(node.domains[d].relayhost) }));
    if (path.startsWith('get/domain/')) {
      const d = decodeURIComponent(path.slice('get/domain/'.length));
      return node.domains[d] ? { domain_name: d, relayhost: String(node.domains[d].relayhost) } : {};
    }
    if (path.startsWith('get/dkim/')) {
      const d = decodeURIComponent(path.slice('get/dkim/'.length));
      const key = node.dkim[d];
      return key ? { pubkey: key.pub, length: '2048', dkim_txt: dkimTxt(key.pub), dkim_selector: key.selector, privkey: '' } : {};
    }
    if (path === 'get/global_filters/prefilter') return node.prefilter ? node.prefilter : {};
    if (path === 'get/fail2ban') return { ...node.fail2ban, regex: { 1: 'x' }, perm_bans: '', active_bans: '' };
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
      case 'edit/relayhost': {
        const entry = node.relayhosts.find((r) => r.id === Number(body.items[0]));
        entry.active = String(body.attr.active);
        return [success('object_modified', '')];
      }
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
      case 'add/global-filter':
        node.prefilter = body.script_data;
        return node.restartFails
          ? [{ type: 'warning', msg: 'dovecot_restart_failed' }, success('global_filter_written')]
          : [success('dovecot_restart_success'), success('global_filter_written')];
      case 'edit/fail2ban': {
        const listed = node.fail2ban.whitelist ? node.fail2ban.whitelist.split('\n') : [];
        for (const network of body.items) if (!listed.includes(network)) listed.push(network);
        node.fail2ban.whitelist = listed.sort().join('\n');
        return body.items.map((network) => success('object_modified', network));
      }
      default:
        return { type: 'error', msg: 'route not found' };
    }
  }

  // The stand-in for safeFetch(url, options).
  async function fetch(url, options) {
    if (node.down) throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    const path = url.replace(/^https:\/\/[^/]+\/api\/v1\//, '');
    if (options.method === 'GET') {
      const body = get(path);
      return body === null ? answer({ type: 'error', msg: 'route not found' }, 404) : answer(body);
    }
    return answer(post(path, JSON.parse(options.body)));
  }

  return { node, writes, fetch, STOCK_PREFILTER };
}
