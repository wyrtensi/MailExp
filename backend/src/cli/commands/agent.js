import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
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
      ...table(view.jobs, jobColumns, { empty: 'no jobs' }),
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
    return { data: { jobs: list }, lines: table(list, jobColumns, { empty: 'no jobs' }) };
  },
};

// Creates the token's file, only the owner reads it, before the token is issued: a file that exists
// already or cannot be made is refused while the agent's token is still the one it has. Answers the
// open file descriptor.
function openTokenFile(file) {
  try {
    return openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new CliError('out_file_exists', `${file} exists already: give a new file`, { exit: EXIT.refused });
    throw new CliError('out_file_failed', `${file} could not be created (${err?.code ?? 'error'})`, { exit: EXIT.refused });
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

// The same into the file: it is made first, so nothing is issued when it cannot be, and a refused
// or failed issue leaves no empty file behind.
async function issueIntoFile(ctx, file) {
  const fd = openTokenFile(file);
  let issued;
  try {
    issued = await confirmAndIssue(ctx);
    writeSync(fd, `${issued.token}\n`);
  } catch (err) {
    closeSync(fd);
    if (!issued) rmSync(file, { force: true });
    throw err;
  }
  closeSync(fd);
  return issued;
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
