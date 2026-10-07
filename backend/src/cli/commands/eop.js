import { unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues } from '../output.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { eopBudgetNow, eopSettingsView, saveEopConfig } from '../../services/mailNode/settingsActions.js';
import { applyLines } from './node.js';

// mailexpert eop ...: the EOP settings (the next hop, its TLS, DKIM, the send limit, the tenant and
// the licenses) and the tenant's external recipient budget (services/mailNode/settingsActions.js;
// the "EOP" screen).

// flag -> the field of the EOP settings (services/mailNode/eopSettings.js EOP_FIELDS).
const FIELDS = Object.freeze({
  'eop-host': 'eopHost',
  'tls-policy': 'tlsPolicy',
  'tls-parameters': 'tlsPolicyParameters',
  'certificate-host': 'certificateHost',
  'dkim-mode': 'dkimMode',
  'send-limit': 'sendLimitPerHour',
  terrl: 'terrl',
  licenses: 'licenses',
  'tenant-created-on': 'tenantCreatedOn',
  'tenant-id': 'tenantId',
  'tenant-domain': 'tenantDomain',
  'app-id': 'appId',
  'cert-thumbprint': 'certThumbprint',
  'node-ip': 'nodeIp',
  'outbound-connector': 'outboundConnector',
  'dbeb-external-domain': 'dbebExternalDomain',
});

function settingsLines(view) {
  return keyValues([
    ...Object.entries(FIELDS).map(([flag, field]) => [flag.replace(/-/g, ' '), view[field]]),
    ['tenant configured', view.tenantConfigured],
    ['tenant driver', view.tenantDriver ?? 'none'],
    ['tenant driver runs the steps', view.tenantDriverActive],
  ]);
}

const show = {
  name: 'show',
  summary: 'show the EOP settings',
  usage: 'eop show',
  async run() {
    const view = await eopSettingsView();
    return { data: view, lines: settingsLines(view) };
  },
};

const set = {
  name: 'set',
  summary: 'change EOP settings: the options given, the others are kept',
  usage: `eop set ${Object.keys(FIELDS).map((flag) => `[--${flag} VALUE]`).join(' ')}`,
  journal: 'mail_node.config_changed with the changed fields; mail_node.applied when the node settings change',
  help: [
    '--eop-host HOST             the next hop, <TENANT-DOMAIN>.mail.protection.outlook.com',
    '--tls-policy POLICY         secure, dane, dane-only, verify, fingerprint, encrypt or default',
    '--tls-parameters TEXT       the policy\'s parameters, such as match=nexthop:dot-nexthop',
    '--certificate-host HOST     the host name the node\'s certificate is for',
    '--dkim-mode MODE            mailcow or eop: who signs',
    '--send-limit N              messages per hour a mailbox may send by default',
    '--terrl N                   the tenant\'s external recipient limit, when not from the licenses',
    '--licenses N                the purchased EOP licenses (the seats, while the tenant does not give them)',
    '--tenant-created-on DATE    the tenant\'s creation date, YYYY-MM-DD (the young tenant\'s ramp)',
    '--tenant-id GUID            the tenant ID',
    '--tenant-domain DOMAIN      the tenant\'s initial domain, <TENANT>.onmicrosoft.com',
    '--app-id GUID               the application ID the tenant driver signs in with',
    '--cert-thumbprint HEX       the thumbprint of the driver\'s certificate',
    '--node-ip IP                the node\'s public IPv4 address',
    '--outbound-connector NAME   the Outbound connector new domains are added to',
    '--dbeb-external-domain DOM  the external domain of the DBEB contacts (variant B)',
    'An optional value given as "" is cleared. A change of the next hop, its TLS, the DKIM mode or',
    'the send limit applies the node settings; the command waits for it and prints what changed.',
  ],
  flags: Object.fromEntries(Object.keys(FIELDS).map((flag) => [flag, 'string'])),
  async run(ctx) {
    const body = Object.fromEntries(Object.entries(FIELDS)
      .filter(([flag]) => ctx.flags[flag] !== undefined)
      .map(([flag, field]) => [field, ctx.flags[flag]]));
    if (!Object.keys(body).length) throw new UsageError('nothing to change: give an option such as --licenses');
    const result = unwrap(await saveEopConfig(body, ctx.actor, { background: false }), MAIL_NODE_ERRORS);
    const lines = ['saved', ...settingsLines(result)];
    if (result.applying && result.apply) lines.push('node settings applied', ...applyLines([...result.apply.node, ...result.apply.domains.flatMap((d) => d.items)], '  '));
    else if (result.applying) lines.push('node settings were not applied: run "mailexpert node apply" to see why');
    return { data: result, lines };
  },
};

const budget = {
  name: 'budget',
  summary: 'the tenant\'s external recipient budget (TERRL) of the last 24 hours',
  usage: 'eop budget',
  async run() {
    const result = await eopBudgetNow();
    const lines = keyValues([
      ['limit', result.limit == null ? 'unknown: enter --licenses or --terrl with "eop set"' : result.limit],
      ['limit from', result.limitFrom],
      ['full limit', result.fullLimit],
      ['ramp percent', result.rampPercent],
      ['used', result.used],
      ['percent', result.percent],
      ['warning', result.warn],
      ['exceeded', result.exceeded],
      ['since', fmtDate(result.windowStart)],
      ['node log read', result.log.read ? (result.log.covered ? 'yes, the whole window' : 'yes, part of the window') : 'no: the journal alone counts'],
    ]);
    return { data: result, lines };
  },
};

export default {
  name: 'eop',
  summary: 'the EOP settings and the tenant\'s external recipient budget',
  commands: [show, set, budget],
};
