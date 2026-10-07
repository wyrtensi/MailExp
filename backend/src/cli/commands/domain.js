import {
  CliError, WAIT_FLAGS, WAIT_HELP, confirm, jobLine, maybeWait, nodeAction, refusal, unwrap,
} from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, fmtValue, keyValues, table } from '../output.js';
import { parseHostName } from '../../services/mailNode/mailcow.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { MANUAL_STEPS } from '../../services/mailNode/domains.js';
import {
  acknowledgeDomainIdentity, addNodeDomain, adminDomainList, adoptNodeDomain, confirmDomainStep, markDomainReady,
  restartDomain, setDomainDnsExpected,
} from '../../services/mailNode/domainActions.js';
import {
  TENANT_ERRORS, approveAliasContactsRemoval, approveInternalRelay, heldAliasContactsOf, setDomainHold, syncDomainNow,
} from '../../services/tenant/tenantActions.js';

// mailexpert domain ...: the mail node's domains and their onboarding
// (services/mailNode/domainActions.js) and their tenant steps (services/tenant/tenantActions.js).

function domainArg(ctx) {
  const domain = parseHostName(ctx.args.domain);
  if (!domain) throw new UsageError('<domain> must be a domain name such as example.com');
  return domain;
}

async function domainList() {
  return unwrap(await nodeAction(() => adminDomainList()), MAIL_NODE_ERRORS);
}

// What an administrator should look at for one domain: the node's view, the DNS check, the last
// apply and the tenant's last run.
export function domainWarnings(d) {
  const warnings = [];
  if (d.onNode === false) warnings.push('the mail node does not list this domain');
  if (d.onNode === null) warnings.push('the mail node could not be read: the state is the panel\'s record');
  if (d.onNode && d.active === false) warnings.push('the domain is inactive on the node');
  if (d.recreated) warnings.push(`the node reports another creation time (${d.created}) than the panel is bound to (${d.nodeCreated})`);
  if (d.dns && d.dns.overall && d.dns.overall !== 'ok') {
    const failing = (d.dns.checks ?? []).filter((c) => c.status && c.status !== 'ok').map((c) => `${c.check}: ${c.status}${c.code ? ` ${c.code}` : ''}`);
    warnings.push(`DNS check ${d.dns.overall}${failing.length ? ` (${failing.join(', ')})` : ''}`);
  }
  if (d.dns?.lookupFailed) warnings.push('the latest DNS check could not ask DNS');
  for (const item of d.apply?.items ?? []) {
    if (item.status === 'failed') warnings.push(`node settings: ${item.item} failed${item.code ? ` (${item.code})` : ''}`);
  }
  const sync = d.tenantSync;
  if (sync) {
    for (const [part, value] of Object.entries(sync)) {
      if (value && typeof value === 'object' && value.ok === false) {
        warnings.push(`tenant ${part}: ${value.error?.code ?? value.code ?? 'failed'}${value.error?.message ? ` (${value.error.message})` : ''}`);
      }
    }
    if (sync.acceptedDomain?.code === 'authoritative_in_tenant' && !d.internalRelayApprovedAt) {
      warnings.push('the tenant has the domain as Authoritative: approve the move with "domain internal-relay"');
    }
    const held = sync.mirror?.heldAliasContacts ?? [];
    if (held.length) warnings.push(`alias contacts held for a decision (${held.join(', ')}): "domain approve-alias-removal"`);
    const aliases = sync.mirror?.nodeAliases ?? [];
    if (aliases.length) warnings.push(`mailcow aliases made by hand are not mirrored to the tenant: ${aliases.join(', ')}`);
    if (sync.throttled) warnings.push(`the tenant throttled the last run (${sync.throttled.code})`);
  }
  return warnings;
}

const list = {
  name: 'list',
  summary: 'list the domains with their onboarding state',
  usage: 'domain list',
  async run() {
    const result = await domainList();
    const lines = table(result.domains, [
      { header: 'DOMAIN', value: (d) => d.domain },
      { header: 'STATE', value: (d) => d.state },
      { header: 'ON NODE', value: (d) => (d.onNode === null ? '?' : d.onNode ? (d.active ? 'active' : 'inactive') : 'missing') },
      { header: 'MAILBOXES', value: (d) => (d.mailboxes == null ? null : `${d.mailboxes}/${d.maxMailboxes ?? '-'}`) },
      { header: 'NEXT STEP', value: (d) => d.nextStep },
      { header: 'HOLD IR', value: (d) => (d.state === 'unknown' ? null : d.holdInternalRelay) },
      { header: 'WARNINGS', value: (d) => domainWarnings(d).length || null },
    ], { empty: 'no domains' });
    if (result.node) lines.push('', `the mail node could not be read: ${result.node.code} (${result.node.error})`);
    lines.push('', `tenant driver runs the tenant steps: ${fmtValue(result.tenantDriverActive)}`);
    return { data: result, lines };
  },
};

const show = {
  name: 'show',
  summary: 'show one domain: its steps, its tenant state and warnings',
  usage: 'domain show <domain>',
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    const result = await domainList();
    const d = result.domains.find((entry) => entry.domain === domain);
    if (!d) throw new CliError('domain_not_found', MAIL_NODE_ERRORS.domain_not_found[1], { status: 404 });
    const warnings = domainWarnings(d);
    const data = { ...d, warnings, tenantDriverActive: result.tenantDriverActive, ...(result.node ? { node: result.node } : {}) };
    const steps = Object.entries(d.steps ?? {}).map(([step, s]) => ({ step, ...s }));
    const lines = [
      ...keyValues([
        ['domain', d.domain],
        ['state', d.state],
        ['next step', d.nextStep],
        ['on node', d.onNode === null ? 'unknown' : d.onNode],
        ['active', d.active],
        ['mailboxes', d.mailboxes == null ? null : `${d.mailboxes} of ${d.maxMailboxes ?? '-'}`],
        ['added', d.addedAt ? `${fmtDate(d.addedAt)} by ${d.addedBy ?? '-'} (${d.origin ?? '-'})` : null],
        ['state changed', fmtDate(d.stateChangedAt)],
        ['hold on Internal Relay', d.holdInternalRelay],
        ['Internal Relay approved', d.internalRelayApprovedAt ? fmtDate(d.internalRelayApprovedAt) : null],
        ['DNS check', d.dns ? `${d.dns.overall ?? '-'} at ${fmtDate(d.dns.at)}` : null],
        ['node settings applied', d.apply ? fmtDate(d.apply.at) : null],
        ['tenant last run', d.tenantSync ? `${d.tenantSync.ok ? 'ok' : 'with problems'} at ${fmtDate(d.tenantSync.at)}` : null],
      ]),
      '',
      'steps:',
      ...table(steps, [
        { header: '  STEP', value: (s) => `  ${s.step}` },
        { header: 'AT', value: (s) => fmtDate(s.at) },
        { header: 'BY', value: (s) => (s.tenantDriver ? `${s.email ?? 'MailExpert'} (tenant driver)` : s.email) },
      ], { empty: '  (none confirmed)' }),
      '',
      'warnings:',
      ...(warnings.length ? warnings.map((w) => `  - ${w}`) : ['  (none)']),
    ];
    return { data, lines };
  },
};

const restart = {
  name: 'restart',
  journal: 'mail_node.domain_state_changed, and mail_node.applied when the node settings change',
  summary: 'restart the domain\'s onboarding from node_created',
  usage: 'domain restart <domain>',
  help: [
    'The domain goes back to node_created with no confirmed steps and nothing the node or the tenant',
    'held; its DKIM mode, send limit and mailboxes stay. Its node settings are applied again.',
  ],
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    await confirm(ctx, `Restart the onboarding of ${domain} from the first step?`);
    const result = unwrap(await restartDomain(domain, ctx.actor), MAIL_NODE_ERRORS);
    const failed = (result.apply?.items ?? []).filter((i) => i.status === 'failed');
    const lines = [`${domain}: onboarding restarted, state ${result.state}`];
    if (result.apply?.error) lines.push(`node settings were not applied: ${result.apply.error}`);
    for (const item of failed) lines.push(`node settings: ${item.item} failed${item.code ? ` (${item.code})` : ''}`);
    return { data: result, lines };
  },
};

const sync = {
  name: 'sync',
  journal: 'none for queuing; what the tenant run changes is journaled by MailExpert, as for the button',
  summary: 'run the domain\'s tenant steps now (queues the tenant job)',
  usage: 'domain sync <domain> [--wait] [--timeout SEC]',
  help: WAIT_HELP,
  flags: WAIT_FLAGS,
  positionals: ['domain'],
  async run(ctx) {
    const result = unwrap(await syncDomainNow(domainArg(ctx), ctx.actor), TENANT_ERRORS);
    const job = await maybeWait(ctx, result.job);
    return { data: { ...result, job }, lines: [jobLine(job, result.created)] };
  },
};

const hold = {
  name: 'hold',
  journal: 'tenant.domain_hold_changed, when the hold changes',
  summary: 'keep the domain on Internal Relay (the default)',
  usage: 'domain hold <domain>',
  positionals: ['domain'],
  async run(ctx) {
    const result = unwrap(await setDomainHold(domainArg(ctx), true, ctx.actor), TENANT_ERRORS);
    return { data: result, lines: [`${result.domain}: held on Internal Relay`] };
  },
};

const allowAuthoritative = {
  name: 'allow-authoritative',
  journal: 'tenant.domain_hold_changed, when the hold changes',
  summary: 'let a complete recipient mirror make the domain Authoritative',
  usage: 'domain allow-authoritative <domain>',
  help: [
    'Once Authoritative, EOP rejects mail to addresses of the domain the tenant has no recipient',
    'for, mailcow aliases made by hand included (D-16).',
  ],
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    await confirm(ctx, `Let ${domain} become Authoritative once its recipient mirror is complete?`);
    const result = unwrap(await setDomainHold(domain, false, ctx.actor), TENANT_ERRORS);
    return { data: result, lines: [`${result.domain}: may become Authoritative; a tenant run is queued when the driver is active`] };
  },
};

const internalRelay = {
  name: 'internal-relay',
  journal: 'tenant.internal_relay_approved',
  summary: 'approve moving a domain the tenant has as Authoritative to Internal Relay',
  usage: 'domain internal-relay <domain> [--wait] [--timeout SEC]',
  help: WAIT_HELP,
  flags: WAIT_FLAGS,
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    await confirm(ctx, `Move ${domain} to Internal Relay in the tenant?`);
    const result = unwrap(await approveInternalRelay(domain, ctx.actor), TENANT_ERRORS);
    const job = await maybeWait(ctx, result.job);
    return { data: { ...result, job }, lines: [`${domain}: move to Internal Relay approved`, jobLine(job)] };
  },
};

const approveAliasRemoval = {
  name: 'approve-alias-removal',
  journal: 'tenant.alias_contacts_removal_approved with the addresses',
  summary: 'allow the mirror to remove the contacts of mailcow aliases on an Authoritative domain',
  usage: 'domain approve-alias-removal <domain> [--wait] [--timeout SEC]',
  help: [
    'Section 5.14: mail to those aliases is rejected by EOP from the next run on. The addresses',
    'the last run held are shown before the confirmation and kept in the journal.',
    ...WAIT_HELP,
  ],
  flags: WAIT_FLAGS,
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    const { addresses } = unwrap(await heldAliasContactsOf(domain), TENANT_ERRORS);
    // Nothing held: nothing to approve, and nothing is approved.
    if (!addresses.length) throw refusal(TENANT_ERRORS, 'alias_contacts_not_held');
    ctx.note(`Contacts held on ${domain}: ${addresses.join(', ')}`);
    await confirm(ctx, 'Remove them? Mail to these addresses will be rejected.');
    // Only the addresses shown: if a run changed them meanwhile, nothing is approved.
    const result = unwrap(await approveAliasContactsRemoval(domain, ctx.actor, { expected: addresses }), TENANT_ERRORS);
    const job = await maybeWait(ctx, result.job);
    return { data: { ...result, job }, lines: [`${domain}: removal of ${result.addresses.length} alias contacts approved`, jobLine(job)] };
  },
};

function applyResultLines(apply) {
  if (!apply) return ['node settings were not applied: run "mailexpert node apply --domain" to see why'];
  return (apply.items ?? []).filter((i) => i.status === 'failed').map((i) => `node settings: ${i.item} failed${i.code ? ` (${i.code})` : ''}`);
}

const add = {
  name: 'add',
  journal: 'mail_node.domain_added, and mail_node.applied for its node settings',
  summary: 'create a domain on the node; its onboarding starts at node_created',
  usage: 'domain add <domain> [--mailboxes N]',
  help: [
    '--mailboxes N   how many mailboxes the domain may hold on the node (default 500)',
    'The DKIM key is made on the node only when mailcow signs (eop show: dkim mode). The domain\'s',
    'node settings are applied at once; with the tenant driver, the domain goes into the tenant.',
  ],
  flags: { mailboxes: 'string' },
  positionals: ['domain'],
  async run(ctx) {
    const result = unwrap(await nodeAction(() => addNodeDomain({ domain: domainArg(ctx), mailboxes: ctx.flags.mailboxes }, ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: [`${result.domain}: created on the node, state ${result.state}`, ...applyResultLines(result.apply)] };
  },
};

const adopt = {
  name: 'adopt',
  journal: 'mail_node.domain_adopted, and mail_node.applied for its node settings',
  summary: 'take in a domain made on the node by hand; its onboarding starts at node_created',
  usage: 'domain adopt <domain>',
  positionals: ['domain'],
  async run(ctx) {
    const result = unwrap(await nodeAction(() => adoptNodeDomain(domainArg(ctx), ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: [`${result.domain}: adopted, state ${result.state}`, ...applyResultLines(result.apply)] };
  },
};

const step = {
  name: 'step',
  journal: 'mail_node.domain_state_changed (step_confirmed)',
  summary: 'confirm the domain\'s next onboarding step ("Done")',
  usage: 'domain step <domain> <step>',
  help: [
    `Steps, in order: ${MANUAL_STEPS.join(', ')}. Only the step after the current state is`,
    'taken ("domain show" names it). With the tenant driver its steps are its own, not a person\'s.',
  ],
  positionals: ['domain', 'step'],
  async run(ctx) {
    const result = unwrap(await nodeAction(() => confirmDomainStep(domainArg(ctx), ctx.args.step, ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: [`${result.domain}: ${ctx.args.step} confirmed, state ${result.state}`] };
  },
};

const ready = {
  name: 'ready',
  journal: 'mail_node.domain_state_changed (marked_ready)',
  summary: 'mark a domain ready without the other steps (a pilot or a stand without a tenant)',
  usage: 'domain ready <domain>',
  help: ['The skipped steps stay unconfirmed. Refused with the tenant driver.'],
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    await confirm(ctx, `Mark ${domain} ready, skipping the steps not confirmed?`);
    const result = unwrap(await nodeAction(() => markDomainReady(domain, ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: [`${result.domain}: state ${result.state}`] };
  },
};

const ack = {
  name: 'ack',
  journal: 'mail_node.domain_identity_acknowledged with the old and new creation time',
  summary: 'accept the creation time the node reports now for a domain (the "recreated" warning)',
  usage: 'domain ack <domain> [--created TIME]',
  help: [
    'The node\'s time and the panel\'s are shown before the confirmation; if the node reports',
    'another time by then, nothing is accepted. --created TIME names the time expected (for',
    'scripts; it replaces the confirmation). The onboarding state stays as it is.',
  ],
  flags: { created: 'string' },
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    let seen = ctx.flags.created;
    if (seen === undefined) {
      const d = (await domainList()).domains.find((entry) => entry.domain === domain);
      if (!d) throw new CliError('domain_not_found', MAIL_NODE_ERRORS.domain_not_found[1], { status: 404 });
      if (!d.created) throw refusal(MAIL_NODE_ERRORS, 'domain_not_recreated');
      ctx.note(`${domain}: the node reports ${d.created}; the panel is bound to ${d.nodeCreated ?? '-'}`);
      await confirm(ctx, 'Accept the node\'s time?');
      seen = d.created;
    }
    const result = unwrap(await nodeAction(() => acknowledgeDomainIdentity(domain, seen, ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: [`${domain}: the node's creation time ${seen} accepted`] };
  },
};

const DNS_FLAGS = Object.freeze({ mx: 'expectedMx', 'tenant-txt': 'tenantTxt', 'dkim-cname1': 'dkimSelector1Cname', 'dkim-cname2': 'dkimSelector2Cname' });

const dnsExpected = {
  name: 'dns-expected',
  journal: 'mail_node.config_changed (domain_dns) with the changed fields',
  summary: 'set the DNS values a domain must publish that the panel cannot read yet',
  usage: 'domain dns-expected <domain> [--mx HOSTS] [--tenant-txt TEXT] [--dkim-cname1 HOST] [--dkim-cname2 HOST]',
  help: [
    '--mx HOSTS          the expected MX hosts, separated by commas or spaces',
    '--tenant-txt TEXT   the tenant\'s verification TXT, such as MS=ms12345678',
    '--dkim-cname1 HOST  the target of the EOP DKIM selector1 CNAME',
    '--dkim-cname2 HOST  the target of the EOP DKIM selector2 CNAME',
    'Each option given replaces the stored value ("" clears it); the others stay. The domain\'s DNS',
    'is checked again right away.',
  ],
  flags: Object.fromEntries(Object.keys(DNS_FLAGS).map((flag) => [flag, 'string'])),
  positionals: ['domain'],
  async run(ctx) {
    const domain = domainArg(ctx);
    const body = Object.fromEntries(Object.entries(DNS_FLAGS)
      .filter(([flag]) => ctx.flags[flag] !== undefined)
      .map(([flag, field]) => [field, ctx.flags[flag]]));
    if (!Object.keys(body).length) throw new UsageError('nothing to change: give --mx, --tenant-txt, --dkim-cname1 or --dkim-cname2');
    const result = unwrap(await setDomainDnsExpected(domain, body, ctx.actor), MAIL_NODE_ERRORS);
    const lines = [`${domain}: ${result.fields.length ? `saved ${result.fields.join(', ')}` : 'nothing changed'}`];
    if (result.dns) lines.push(`DNS check: ${result.dns.overall ?? '-'}`);
    return { data: result, lines };
  },
};

export default {
  name: 'domain',
  summary: 'the mail node\'s domains: onboarding and the tenant steps',
  commands: [list, show, add, adopt, step, ready, ack, dnsExpected, restart, sync, hold, allowAuthoritative, internalRelay, approveAliasRemoval],
};
