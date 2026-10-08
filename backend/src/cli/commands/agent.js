import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, openSync, rmSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CliError, confirm, refusal } from '../common.js';
import { EXIT, UsageError, parseCount } from '../args.js';
import { fmtDate, keyValues, table } from '../output.js';
import { AGENT_JOB_KINDS, NodeAgentError, getAgentState, listJobs } from '../../services/mailNode/nodeAgent.js';
import {
  NODE_AGENT_ERRORS, agentView, issueAgentToken, requestAgentJob, revokeAgentToken,
} from '../../services/mailNode/agentActions.js';

// mailexpert agent ...: the mail node's agent (services/mailNode/agentActions.js, nodeAgent.js; the
// "Node agent" part of the Mail node screen): its state, its jobs, its token and the jobs an
// administrator queues for it. The token is the one secret the CLI prints: it is what `token issue`
// is for (fed to the node's setup.sh --agent-token-file), and it is shown once.

// A refusal of the agent's actions (NodeAgentError) as the routes answer it.
async function agentAction(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NodeAgentError) throw refusal(NODE_AGENT_ERRORS, err.code);
    throw err;
  }
}

const jobColumns = [
  { header: 'ID', value: (j) => j.id },
  { header: 'KIND', value: (j) => j.kind },
  { header: 'STATE', value: (j) => j.state },
  { header: 'CREATED', value: (j) => fmtDate(j.createdAt) },
  { header: 'FINISHED', value: (j) => fmtDate(j.finishedAt) },
  { header: 'ERROR', value: (j) => j.error },
];

// The codes the panel sets when it fails an agent job itself (services/mailNode/nodeAgent.js), with
// the next step; the panel's screen translates the same codes. The update job's own codes come with
// the node's step text and show as they are.
export const AGENT_JOB_ERRORS = Object.freeze({
  not_picked_up: 'the agent did not pick the job up within 30 minutes: check that it runs on the node ("agent status"), then run the job again',
  timed_out: 'no word from the agent within the time bound of the job: check the node, then run the job again',
  agent_revoked: 'the token was revoked while the job waited or ran: "mailexpert agent token issue", set it up on the node, run the job again',
  agent_token_rotated: 'a new token was issued while the job waited or ran: run the job again once the node has the new token',
  agent_restarted: 'the agent restarted while the job ran: run the job again',
  agent_stopped: 'the agent was stopped while the job ran: start it on the node, then run the job again',
  update_silent: 'no word from the node for 5 minutes: the update was lost; check the node before running it again',
});

// The table of jobs, then one line per known error code in it saying what it means.
function jobLines(list) {
  const codes = [...new Set(list.map((j) => j.error).filter((code) => AGENT_JOB_ERRORS[code]))];
  return [
    ...table(list, jobColumns, { empty: 'no jobs' }),
    ...(codes.length ? ['', ...codes.map((code) => `${code}: ${AGENT_JOB_ERRORS[code]}`)] : []),
  ];
}

const status = {
  name: 'status',
  summary: 'whether the agent is connected, its last status report and its recent jobs',
  usage: 'agent status',
  async run() {
    const view = await agentAction(() => agentView());
    const lines = [
      ...keyValues([
        ['token', view.configured ? `issued ${fmtDate(view.tokenCreatedAt)}` : 'none: "mailexpert agent token issue"'],
        ['connected', view.connected],
        ['last seen', fmtDate(view.lastSeenAt)],
        ['status report', view.statusAt ? fmtDate(view.statusAt) : null],
        ['panel commit', view.panelCommit],
        ['pinned mailcow', view.pinnedMailcow],
      ]),
      '',
      ...jobLines(view.jobs),
    ];
    return { data: view, lines };
  },
};

const jobs = {
  name: 'jobs',
  summary: 'the agent\'s recent jobs, newest first',
  usage: 'agent jobs [--limit N]',
  help: ['--limit N   how many (default 20, at most 50)'],
  flags: { limit: 'string' },
  async run(ctx) {
    const limit = parseCount(ctx.flags.limit, { name: 'limit', min: 1, max: 50, fallback: 20 });
    const list = await agentAction(() => listJobs(limit));
    return { data: { jobs: list }, lines: jobLines(list) };
  },
};

// Before the token is issued: the target must not exist, and a temporary file next to it, only the
// owner reads it, must be possible; otherwise nothing is issued and the agent keeps its token.
// Answers { tmp, fd }.
function openTokenTemp(file) {
  if (existsSync(file)) throw new CliError('out_file_exists', `${file} exists already: give a new file`, { exit: EXIT.refused });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    return { tmp, fd: openSync(tmp, 'wx', 0o600) };
  } catch (err) {
    throw new CliError('out_file_failed', `${file} could not be created (${err?.code ?? 'error'})`, { exit: EXIT.refused });
  }
}

// The issued token into the temporary file, then linked to the target in one step (never over a
// file that appeared meanwhile): the target is whole or absent, never partial.
function publishToken({ tmp, fd }, file, token) {
  let open = true;
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
    open = false;
    closeSync(fd);
    linkSync(tmp, file);
  } catch (err) {
    if (open) closeSync(fd);
    throw new CliError('out_file_failed', `The token was issued (the old token no longer works) but ${file} could not be written `
      + `(${err?.code ?? 'error'}): issue it again with another --out or with --out -`, { exit: EXIT.failed });
  }
}

// Asks before a rotation, then issues the token. A token already issued is rotated: the running
// agent stops until it gets the new one.
async function confirmAndIssue(ctx) {
  if ((await getAgentState()).configured) {
    await confirm(ctx, 'A token is issued already. Rotate it? The running agent stops until it gets the new one.');
  }
  return agentAction(() => issueAgentToken(ctx.actor));
}

// The same into the file. The temporary file is gone afterwards whatever happened.
async function issueIntoFile(ctx, file) {
  const temp = openTokenTemp(file);
  try {
    let issued;
    try {
      issued = await confirmAndIssue(ctx);
    } catch (err) {
      closeSync(temp.fd);
      throw err;
    }
    publishToken(temp, file, issued.token);
    return issued;
  } finally {
    rmSync(temp.tmp, { force: true });
  }
}

const token = {
  name: 'token',
  summary: 'issue (or rotate) the agent\'s token, shown once, or revoke it',
  usage: 'agent token issue [--out FILE | --out -] | agent token revoke',
  journal: 'mail_node.agent_token_issued (rotated or not) or mail_node.agent_token_revoked; never the token',
  help: [
    'issue          a new token; the panel keeps only its hash. Printed once for setup.sh',
    '               --agent-token-file on the node. A token already issued is rotated: the running',
    '               agent is refused from its next request and its jobs fail, so it asks first.',
    '  --out FILE   write the token to FILE (created 0600, never over an existing file) instead of',
    '               printing it. Through mailexpert-cli.sh the file is on the host.',
    '  --out -      print the token alone on stdout, for a pipe (no --json)',
    'revoke         the agent is refused from its next request; its waiting and running jobs fail.',
  ],
  flags: { out: 'string' },
  positionals: ['action'],
  async run(ctx) {
    const { action } = ctx.args;
    const { out } = ctx.flags;
    if (action === 'revoke') {
      if (out !== undefined) throw new UsageError('agent token revoke takes no --out');
      await confirm(ctx, 'Revoke the node agent\'s token? The agent stops until a new token is issued.');
      const result = await agentAction(() => revokeAgentToken(ctx.actor));
      return { data: result, lines: [result.revoked ? 'token revoked' : 'no token was issued'] };
    }
    if (action !== 'issue') throw new UsageError('<action> must be issue or revoke');
    if (out === '') throw new UsageError('--out needs a file, or - for stdout');
    if (out === '-' && ctx.json) throw new UsageError('--out - prints the token alone: it takes no --json');
    const toFile = out !== undefined && out !== '-';
    const issued = toFile ? await issueIntoFile(ctx, out) : await confirmAndIssue(ctx);
    if (out === '-') return { data: issued, lines: [issued.token] };
    const about = `${issued.rotated ? 'rotated' : 'issued'} ${fmtDate(issued.createdAt)}`;
    if (toFile) {
      return {
        data: { createdAt: issued.createdAt, rotated: issued.rotated, file: out },
        lines: [`token ${about}, written to ${out} (0600): give it to setup.sh --agent-token-file on the node`],
      };
    }
    return {
      data: issued,
      lines: [issued.token, '', `token ${about}. It is shown this once: give it to setup.sh --agent-token-file on the node.`],
    };
  },
};

const runJob = {
  name: 'run',
  summary: `queue a job for the agent: ${AGENT_JOB_KINDS.join(', ')}`,
  usage: `agent run <${AGENT_JOB_KINDS.join('|')}>`,
  journal: 'mail_node.agent_job_requested with the kind (and the commit of an update)',
  help: [
    'status   the agent sends its status report now',
    'backup   back up the node\'s mail now',
    'update   bring the node\'s scripts to the panel\'s own commit',
    'The agent picks the job up at its next poll; follow it with "mailexpert agent jobs".',
  ],
  positionals: ['kind'],
  async run(ctx) {
    const { kind } = ctx.args;
    if (!AGENT_JOB_KINDS.includes(kind)) throw new UsageError(`<kind> must be ${AGENT_JOB_KINDS.join(', ')}`);
    const result = await agentAction(() => requestAgentJob(kind, ctx.actor));
    return { data: result, lines: [`job ${result.job.id} (${result.job.kind}) queued: follow it with "mailexpert agent jobs"`] };
  },
};

export default {
  name: 'agent',
  summary: 'the mail node\'s agent: status, jobs, its token',
  commands: [status, jobs, token, runJob],
};
