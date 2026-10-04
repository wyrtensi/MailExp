#!/usr/bin/env node
// The panel CLI: the panel's administrator actions from the command line, for when the screens are
// inconvenient. It runs inside the backend container, next to the panel, and calls the same
// services as the HTTP routes (services/mailNode/mailboxActions.js, domainActions.js,
// services/tenant/tenantActions.js): the same checks, the same refusal codes, the same journal.
// Whoever reaches the container is an administrator; the journal names the actor "cli", or the
// administrator given with --as. Work for the tenant is queued for the backend's job worker; the
// CLI never runs it itself.
//
//   docker compose ... exec backend node src/cli/mailexpert.js <group> <command> [options]
//
// scripts/deploy/mailexpert-cli.sh finds the installed panel and runs it there.
// docs/operations/deployment.md, "CLI панели"; docs/architecture/panel-cli.md.
import '../loadEnv.js';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT, UsageError, parseArgs } from './args.js';
import { CliError } from './common.js';
import { resolveCliActor } from '../services/actor.js';
import { pool } from '../services/db.js';
import mailbox from './commands/mailbox.js';
import domain from './commands/domain.js';
import tenant from './commands/tenant.js';
import quarantine from './commands/quarantine.js';
import jobs from './commands/jobs.js';

export const GROUPS = Object.freeze([mailbox, domain, tenant, quarantine, jobs]);

const GLOBAL_HELP = [
  'Global options:',
  '  --json         print the answer as JSON, in the shapes the panel\'s API answers',
  '  --yes, -y      answer yes to the confirmation of an action that cannot be taken back',
  '  --as EMAIL     journal the action as this administrator (default: the actor "cli")',
  '  --help, -h     help for the group or the command',
  '',
  'Exit codes: 0 done; 1 refused (the API\'s error code is printed); 2 a usage error or a',
  'confirmation the CLI could not ask; 3 the mail node, the tenant or a job failed.',
];

function topUsage() {
  const width = Math.max(...GROUPS.map((g) => g.name.length));
  return [
    'Usage: mailexpert <group> <command> [options]',
    '',
    'The MailExpert panel from the command line: the same actions as its screens.',
    '',
    'Groups:',
    ...GROUPS.map((g) => `  ${g.name.padEnd(width)}  ${g.summary}`),
    '',
    ...GLOBAL_HELP,
    '',
    'Run "mailexpert <group> --help" for its commands.',
  ];
}

const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;

function groupUsage(group) {
  const width = Math.max(...group.commands.map((c) => c.name.length));
  return [
    `Usage: mailexpert ${group.name} <command> [options]`,
    '',
    `${sentence(group.summary)}.`,
    '',
    'Commands:',
    ...group.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    `Run "mailexpert ${group.name} <command> --help" for its options.`,
  ];
}

function commandUsage(command) {
  return [
    `Usage: mailexpert ${command.usage}`,
    '',
    `${sentence(command.summary)}.`,
    ...(command.help?.length ? ['', ...command.help] : []),
    ...(command.mutates ? ['', 'Journaled as the panel journals it, with the actor "cli" (or --as).'] : []),
    '',
    ...GLOBAL_HELP,
  ];
}

const ACTOR_ERRORS = Object.freeze({
  admin_not_found: 'No enabled administrator has this address (--as)',
});

function defaultIo() {
  const interactive = !!(process.stdin.isTTY && process.stderr.isTTY);
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    interactive,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    pollMs: 1000,
  };
}

const writeLines = (stream, lines) => stream.write(`${lines.join('\n')}\n`);

// run(argv, io): the exit code, given the words after "mailexpert". io overrides the process's
// streams, the terminal check and the prompt (tests). Exported so tests drive it without a process.
export async function run(argv, overrides = {}) {
  const io = { ...defaultIo(), ...overrides };
  const json = argv.includes('--json');
  const fail = (code, message, exit, extra = {}) => {
    if (json) writeLines(io.stdout, [JSON.stringify({ error: message, code, ...extra }, null, 2)]);
    else writeLines(io.stderr, [`error: ${message} (${code})`]);
    return exit;
  };

  const [groupName, commandName, ...rest] = argv;
  if (groupName === undefined) {
    writeLines(io.stderr, topUsage());
    return EXIT.usage;
  }
  if (groupName === '--help' || groupName === '-h' || groupName === 'help') {
    writeLines(io.stdout, topUsage());
    return EXIT.ok;
  }
  const group = GROUPS.find((g) => g.name === groupName);
  if (!group) {
    writeLines(io.stderr, [`error: unknown group: ${groupName}`, '', ...topUsage()]);
    return EXIT.usage;
  }
  if (commandName === undefined || commandName === '--help' || commandName === '-h') {
    writeLines(commandName === undefined ? io.stderr : io.stdout, groupUsage(group));
    return commandName === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = group.commands.find((c) => c.name === commandName);
  if (!command) {
    writeLines(io.stderr, [`error: unknown command: ${group.name} ${commandName}`, '', ...groupUsage(group)]);
    return EXIT.usage;
  }

  let parsed;
  try {
    parsed = parseArgs(rest, command);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    writeLines(io.stderr, [`error: ${err.message}`, `usage: mailexpert ${command.usage}`, `(see mailexpert ${group.name} ${command.name} --help)`]);
    return EXIT.usage;
  }
  if (parsed.flags.help) {
    writeLines(io.stdout, commandUsage(command));
    return EXIT.ok;
  }

  try {
    const who = await resolveCliActor(parsed.flags.as);
    if (who.error) return fail(who.error, ACTOR_ERRORS[who.error], EXIT.refused);
    const ctx = {
      flags: parsed.flags,
      args: parsed.args,
      json,
      actor: who.actor,
      // A prompt needs a terminal; --json is for scripts, which never get one.
      interactive: io.interactive && !json,
      ask: io.ask,
      note: (line) => writeLines(io.stderr, [line]),
      sleep: io.sleep,
      now: io.now,
      pollMs: io.pollMs,
    };
    const result = await command.run(ctx);
    if (json) writeLines(io.stdout, [JSON.stringify(result.data, null, 2)]);
    else writeLines(io.stdout, result.lines);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof UsageError) {
      writeLines(io.stderr, [`error: ${err.message}`, `usage: mailexpert ${command.usage}`]);
      return EXIT.usage;
    }
    if (err instanceof CliError) return fail(err.code, err.message, err.exit, err.details ?? {});
    // Anything else is the panel's own failure: its name and code only, never a value it carried.
    console.error(`mailexpert ${group.name} ${command.name} failed:`, err?.code || err?.name || 'Error', err?.message ?? '');
    return fail('internal_error', 'The command failed; the line above says why', EXIT.failed);
  }
}

async function main() {
  const code = await run(process.argv.slice(2));
  await pool.end().catch(() => {});
  process.exit(code);
}

// Only run when invoked directly (`node src/cli/mailexpert.js ...`, or the package's bin, a link to
// this file), not when imported by tests.
function invokedPath() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
}
const invokedDirectly = process.argv[1] && import.meta.url === invokedPath();
if (invokedDirectly) {
  main();
}
