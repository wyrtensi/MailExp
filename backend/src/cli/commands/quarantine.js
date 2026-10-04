import { WAIT_FLAGS, WAIT_HELP, confirm, jobLine, maybeWait, unwrap } from '../common.js';
import { fmtDate, keyValues, table } from '../output.js';
import {
  TENANT_ERRORS, heldReleases, phishReleaseStatus, runPhishReleaseNow, setPhishRelease,
} from '../../services/tenant/tenantActions.js';

// mailexpert quarantine ...: the panel's release of EOP's quarantine (R-42, section 5.14;
// services/tenant/quarantineRelease.js), as the "Spam and phishing in EOP's quarantine" part of the
// tenant screen. The mail node's own (mailcow) quarantine stays in the panel.

const status = {
  name: 'status',
  summary: 'whether the automatic release runs, its last pass and the held messages',
  usage: 'quarantine status',
  async run() {
    const result = await phishReleaseStatus();
    const run = result.run;
    const lines = keyValues([
      ['automatic release', result.enabled ? 'on' : 'paused'],
      ['switched', result.changedAt ? fmtDate(result.changedAt) : null],
      ['last pass', run ? `${fmtDate(run.at)}${run.ok === false ? ` failed (${run.error?.code ?? run.throttled?.code ?? 'failed'})` : ''}` : 'none yet'],
      ['held messages', `${result.held.count}${result.held.soonestExpiresAt ? `, the first expires ${fmtDate(result.held.soonestExpiresAt)}` : ''}`],
      ['latest job', result.job ? jobLine(result.job) : null],
    ]);
    return { data: result, lines };
  },
};

const list = {
  name: 'list',
  summary: 'list the messages the panel keeps in EOP\'s quarantine (held by a check or out of attempts)',
  usage: 'quarantine list',
  async run() {
    const result = await heldReleases();
    const lines = table(result.messages, [
      { header: 'RECEIVED', value: (m) => fmtDate(m.receivedAt) },
      { header: 'EXPIRES', value: (m) => fmtDate(m.expiresAt) },
      { header: 'TYPE', value: (m) => m.type },
      { header: 'STATE', value: (m) => `${m.state}:${m.reason ?? m.errorCode ?? '-'}` },
      { header: 'SENDER', value: (m) => m.sender },
      { header: 'RECIPIENTS', value: (m) => m.recipients },
      { header: 'SUBJECT', value: (m) => m.subject },
    ], { empty: 'no held messages' });
    return { data: result, lines };
  },
};

const release = {
  name: 'release',
  summary: 'run a release pass now (the "Release now" button)',
  usage: 'quarantine release [--wait] [--timeout SEC]',
  help: [
    'The pass releases what the checks allow (section 5.14); malware and the other types are',
    'never released. Refused while the automatic release is paused.',
    ...WAIT_HELP,
  ],
  flags: WAIT_FLAGS,
  mutates: true,
  async run(ctx) {
    const result = unwrap(await runPhishReleaseNow(ctx.actor), TENANT_ERRORS);
    const job = await maybeWait(ctx, result.job);
    return { data: { ...result, job }, lines: [jobLine(job, result.created)] };
  },
};

function switchCommand(name, enabled) {
  return {
    name,
    summary: enabled ? 'resume the automatic release' : 'pause the automatic release (messages stay in the quarantine)',
    usage: `quarantine ${name}`,
    mutates: true,
    async run(ctx) {
      if (!enabled) await confirm(ctx, 'Pause the release? Spam and phishing then wait in EOP\'s quarantine instead of reaching Spam.');
      const result = unwrap(await setPhishRelease(enabled, ctx.actor), TENANT_ERRORS);
      return { data: result, lines: [`automatic release ${result.enabled ? 'on' : 'paused'}`] };
    },
  };
}

export default {
  name: 'quarantine',
  summary: 'the release of EOP\'s quarantine: status, held messages, release, pause, resume',
  commands: [status, list, release, switchCommand('pause', false), switchCommand('resume', true)],
};
