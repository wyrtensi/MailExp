#!/usr/bin/env node
// Admin CLI for Google OAuth apps (see services/oauth/googleApps.js and the "Google apps" admin
// screen). Runs inside the backend container, next to the panel it manages:
//
//   docker compose ... exec -T backend node src/cli/googleApp.js add [--label L] [--user-limit N] \
//     < client_secret_<id>.apps.googleusercontent.com.json
//   docker compose ... exec -T backend node src/cli/googleApp.js list [--json]
//
// The rest of the "Google apps" screen is here too: show, enable, close, disable, delete,
// set-limit, set-label and replace-secret (see usage()). Each calls the same service function as
// the matching /api/admin/google-apps route.
//
// `add` reads the client JSON on stdin, never as an argument: an argument would sit in shell
// history and the process list. `replace-secret` reads the new client secret on stdin the same way. See scripts/deploy/google-app.sh for the host-side wrapper that
// locates the compose project and pipes a local file in.
import '../loadEnv.js';
import { pathToFileURL } from 'node:url';
import { EXIT, UsageError, parseArgs } from './args.js';
import { fmtDate, keyValues } from './output.js';
import {
  GoogleAppError,
  createGoogleApp,
  deleteGoogleApp,
  getEffectiveGoogleRedirectUri,
  getGoogleAppSummary,
  listGoogleApps,
  setGoogleAppStatus,
  updateGoogleApp,
} from '../services/oauth/googleApps.js';
import { isUuid } from '../utils/uuid.js';
import { googleClientJsonWarnings, parseGoogleClientJson } from '../services/oauth/googleClientJson.js';
import { pool } from '../services/db.js';

function usage() {
  return [
    'Usage:',
    '  googleApp.js add [--label LABEL] [--user-limit N] < client_secret_<id>.apps.googleusercontent.com.json',
    '  googleApp.js list [--json]',
    '  googleApp.js show <id> [--json]',
    '  googleApp.js enable <id>         (status active: takes new addresses)',
    '  googleApp.js close <id>          (status closed: no new addresses, bound mailboxes keep working)',
    '  googleApp.js disable <id>        (flags the app mailboxes for reconnect through another app)',
    '  googleApp.js delete <id> --yes   (refused while mailboxes are bound to the app)',
    '  googleApp.js set-limit <id> <N>',
    '  googleApp.js set-label <id> <label>',
    '  googleApp.js replace-secret <id> < new-client-secret.txt',
    '',
    'add reads the OAuth client JSON downloaded from Google Cloud Console (Credentials -> OAuth',
    'client -> Download JSON) on stdin, so the client secret never appears in argv or shell',
    'history. --label defaults to the JSON project_id; --user-limit defaults to 100.',
    'replace-secret reads only the new secret (plain text) on stdin, never as an argument.',
    'Put -- before arguments that start with a dash (set-label <id> -- -label).',
    '<command> --help prints the usage of that command.',
    'Exit codes: 0 done, 1 refused, 2 invalid input, 3 failed (database down, unexpected error).',
  ].join('\n');
}

// `googleApp.js <command> --help`: the command's own line(s) of usage() and its notes. A command
// not listed here has no notes beyond its usage line.
const COMMANDS = new Set([
  'add', 'list', 'show', 'enable', 'close', 'disable', 'delete', 'set-limit', 'set-label', 'replace-secret',
]);
const COMMAND_NOTES = {
  add: [
    'Reads the OAuth client JSON downloaded from Google Cloud Console (Credentials -> OAuth client ->',
    'Download JSON) on stdin, so the client secret never appears in argv or shell history.',
    '--label defaults to the JSON project_id; --user-limit defaults to 100.',
  ],
  delete: ['Refused while mailboxes are bound to the app. Without --yes it changes nothing.'],
  'replace-secret': ['Reads only the new secret (plain text) on stdin, never as an argument.'],
  'set-label': ['Put -- before a label that starts with a dash: set-label <id> -- -label.'],
};

function commandUsage(command) {
  const lines = usage().split('\n').filter((line) => line.startsWith(`  googleApp.js ${command} `));
  return [
    'Usage:',
    ...lines,
    ...(COMMAND_NOTES[command] ? ['', ...COMMAND_NOTES[command]] : []),
    '',
    'Exit codes: 0 done, 1 refused, 2 invalid input, 3 failed (database down, unexpected error).',
  ].join('\n');
}

// True when --help or -h is among the arguments before a bare "--" (after it they are plain words).
function wantsHelp(args) {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).some((arg) => arg === '--help' || arg === '-h');
}

// Reads a stream to completion as utf8 text. Used for stdin, which docker compose exec -T pipes
// the client JSON file through.
function readStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function parseUserLimit(raw) {
  if (raw === undefined) return 100;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError('--user-limit must be a positive whole number');
  }
  return value;
}

function printWarnings(warnings) {
  for (const warning of warnings) {
    if (warning.code === 'callback_not_configured') {
      console.warn('warning: no Google callback URL is saved yet (Settings -> Integrations -> Google apps)');
    } else if (warning.code === 'redirect_uri_missing') {
      console.warn(`warning: the client JSON's redirect URIs do not include the panel's callback URL: ${warning.expected}`);
    } else {
      console.warn(`warning: ${warning.code}`);
    }
  }
}

async function cmdAdd(argv, stdin) {
  const { flags } = parseArgs(argv, { flags: { label: 'string', 'user-limit': 'string' } });
  const userLimit = parseUserLimit(flags['user-limit']);
  const text = await readStream(stdin);
  const parsed = parseGoogleClientJson(text);
  const label = flags.label && flags.label.trim() ? flags.label.trim() : parsed.projectId;

  const expected = await getEffectiveGoogleRedirectUri();
  const warnings = googleClientJsonWarnings(parsed.redirectUris, expected);

  const app = await createGoogleApp({
    label, clientId: parsed.clientId, clientSecret: parsed.clientSecret, userLimit,
  });
  console.log(`created app ${app.id}: "${app.label}" (${app.client_id}), user limit ${app.user_limit}`);
  printWarnings(warnings);
  return 0;
}

async function cmdList(argv = []) {
  const { flags } = parseArgs(argv, JSON_FLAG);
  const apps = await listGoogleApps();
  if (flags.json) {
    // reservedCount and full need Redis; list stays a database-only read (see show for those).
    const out = apps.map((row) => {
      const app = toApi(row, 0);
      delete app.reservedCount;
      delete app.full;
      return app;
    });
    console.log(JSON.stringify({ apps: out }, null, 2));
    return 0;
  }
  if (!apps.length) {
    console.log('no Google apps configured');
    return 0;
  }
  for (const app of apps) {
    console.log(`${app.id}  ${app.status.padEnd(8)}  ${app.label}  ${app.client_id}  limit ${app.user_limit}`);
  }
  return 0;
}

// The app as /api/admin/google-apps answers it, so --json output matches the HTTP API.
// reservedCount is null when Redis (where in-flight consent flows are held) cannot be read.
function toApi(row, reservedCount) {
  const grants = row.grants_count ?? 0;
  return {
    id: row.id,
    label: row.label,
    clientId: row.client_id,
    projectNumber: row.project_number,
    userLimit: row.user_limit,
    status: row.status,
    grantsCount: grants,
    reservedCount,
    accountsCount: row.accounts_count ?? 0,
    gmailApiDisabledAt: row.gmail_api_disabled_at ?? null,
    full: row.status === 'active' && reservedCount !== null && grants + reservedCount >= row.user_limit,
    createdAt: row.created_at,
  };
}

// In-flight consent flows hold seats in Redis. The CLI process has no open Redis connection, so
// `show` opens one and closes it again; a Redis outage must not break `show`.
// node-redis retries a refused connection forever, so the wait is capped and the client is
// disconnected on every path (which also stops those retries).
const REDIS_WAIT_MS = 3000;

async function countReservations(appId) {
  let timer;
  let redisClient = null;
  try {
    ({ redisClient } = await import('../services/redis.js'));
    const { countGoogleReservations } = await import('../services/oauth/googleAppSelection.js');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_WAIT_MS);
    });
    const work = (async () => {
      if (!redisClient.isOpen) await redisClient.connect();
      return countGoogleReservations(appId);
    })();
    work.catch(() => {}); // a late failure after the deadline must not surface as unhandled
    return await Promise.race([work, deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await Promise.resolve(redisClient?.disconnect()).catch(() => {});
  }
}

function parseId(args) {
  if (!isUuid(args.id)) throw new UsageError('<id> must be an app id (see `list`)');
  return args.id;
}

async function summaryOrThrow(id) {
  const row = await getGoogleAppSummary(id);
  if (!row) throw new GoogleAppError('app_not_found');
  return row;
}

const JSON_FLAG = { flags: { json: 'boolean' } };

async function cmdShow(argv) {
  const { flags, args } = parseArgs(argv, { ...JSON_FLAG, positionals: ['id'] });
  const row = await summaryOrThrow(parseId(args));
  const app = toApi(row, await countReservations(row.id));
  if (flags.json) {
    console.log(JSON.stringify({ app }, null, 2));
    return 0;
  }
  const free = app.reservedCount === null ? 'unknown' : Math.max(0, app.userLimit - app.grantsCount - app.reservedCount);
  const lines = keyValues([
    ['id', app.id],
    ['label', app.label],
    ['client id', app.clientId],
    ['project number', app.projectNumber],
    ['status', app.full ? `${app.status} (full)` : app.status],
    ['user limit', app.userLimit],
    ['used seats', app.grantsCount],
    ['in-flight reservations', app.reservedCount === null ? 'unavailable (Redis not reachable)' : app.reservedCount],
    ['free seats', free],
    ['mailboxes', app.accountsCount],
    ['Gmail API disabled since', app.gmailApiDisabledAt ? fmtDate(app.gmailApiDisabledAt) : undefined],
    ['created', fmtDate(app.createdAt)],
  ]);
  for (const line of lines) console.log(line);
  return 0;
}

// enable / close / disable: the same setGoogleAppStatus the panel calls. Disabling returns the
// mailboxes it flagged; the panel route also drops their live IMAP connections at once through its in-memory
// connection manager, which a separate CLI process cannot reach: the panel's health check does it later.
async function cmdStatus(status, argv) {
  const { args } = parseArgs(argv, { positionals: ['id'] });
  const id = parseId(args);
  const flagged = await setGoogleAppStatus(id, status);
  console.log(`app ${id} is now ${status}`);
  if (status === 'disabled') {
    console.log(`${flagged.length} mailbox(es) flagged for reconnect through another app`);
    if (flagged.length) console.log('the running panel drops their open connections within about 90 seconds (its health check)');
  }
  return 0;
}

async function cmdDelete(argv) {
  const { flags, args } = parseArgs(argv, { positionals: ['id'] });
  const id = parseId(args);
  if (!flags.yes) throw new UsageError('delete removes the app for good; pass --yes to confirm');
  await deleteGoogleApp(id);
  console.log(`deleted app ${id}`);
  return 0;
}

async function cmdSetLimit(argv) {
  const { args } = parseArgs(argv, { positionals: ['id', 'limit'] });
  const id = parseId(args);
  // Anything but a plain whole number becomes NaN, which the service refuses as user_limit_invalid.
  const limit = /^\d+$/.test(args.limit) ? Number(args.limit) : Number.NaN;
  const row = await updateGoogleApp(id, { userLimit: limit });
  console.log(`app ${row.id}: user limit ${row.user_limit}`);
  return 0;
}

async function cmdSetLabel(argv) {
  const { args } = parseArgs(argv, { positionals: ['id', 'label'] });
  const id = parseId(args);
  const row = await updateGoogleApp(id, { label: args.label });
  console.log(`app ${row.id}: label "${row.label}"`);
  return 0;
}

async function cmdReplaceSecret(argv, stdin) {
  const { args } = parseArgs(argv, { positionals: ['id'] });
  const id = parseId(args);
  const secret = (await readStream(stdin)).trim();
  // updateGoogleApp treats an empty secret as "keep the stored one", which would make an empty
  // stdin look like a successful rotation.
  if (!secret) throw new GoogleAppError('client_secret_required');
  if (secret.includes('•')) throw new GoogleAppError('client_secret_redacted');
  if (secret.startsWith('{')) throw new GoogleAppError('client_secret_looks_like_json');
  await summaryOrThrow(id);
  await updateGoogleApp(id, { clientSecret: secret });
  console.log(`replaced the client secret of app ${id}`);
  return 0;
}

const ERROR_MESSAGES = {
  client_json_invalid: 'the input is not valid JSON, or is not a Google OAuth client file',
  client_json_service_account: 'this is a service account key, not an OAuth client; download the OAuth client JSON from Credentials -> OAuth client instead',
  client_json_not_web: 'this is a desktop (installed) OAuth client; create a Web application client instead',
  client_json_incomplete: 'the file is missing a client ID or client secret',
  client_id_invalid: 'client ID is not a Google OAuth client ID',
  client_secret_required: 'client secret is required',
  user_limit_invalid: 'the user limit must be a positive whole number',
  app_exists: 'this client ID is already added',
  app_same_project: 'an app from this Google Cloud project is already added',
  app_status_invalid: 'unknown app status',
  app_in_use: 'the app still has connected mailboxes; remove them or move them to another app first',
  app_not_found: 'app not found (see `list` for ids)',
  label_invalid: 'the label must be 1 to 100 characters',
  client_secret_redacted: 'the secret contains the redaction placeholder; pass the full secret',
  client_secret_looks_like_json: 'stdin looks like a client JSON file; pass only the client secret text',
};

// run(argv, stdin): the exit code, given the CLI arguments after the command and a readable
// stream for `add`'s stdin. Exported so tests can drive it without spawning a process.
export async function run(argv, stdin = process.stdin) {
  const [command, ...rest] = argv;
  try {
    if (COMMANDS.has(command) && wantsHelp(rest)) {
      console.log(commandUsage(command));
      return 0;
    }
    if (command === 'add') return await cmdAdd(rest, stdin);
    if (command === 'list') return await cmdList(rest);
    if (command === 'show') return await cmdShow(rest);
    if (command === 'enable') return await cmdStatus('active', rest);
    if (command === 'close') return await cmdStatus('closed', rest);
    if (command === 'disable') return await cmdStatus('disabled', rest);
    if (command === 'delete') return await cmdDelete(rest);
    if (command === 'set-limit') return await cmdSetLimit(rest);
    if (command === 'set-label') return await cmdSetLabel(rest);
    if (command === 'replace-secret') return await cmdReplaceSecret(rest, stdin);
    if (command === undefined) {
      console.error(usage());
      return 2;
    }
    if (command === '-h' || command === '--help') {
      console.log(usage());
      return 0;
    }
    console.error(`unknown command: ${command}`);
    console.error(usage());
    return 2;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}`);
      return EXIT.usage;
    }
    if (err instanceof GoogleAppError) {
      console.error(`error: ${ERROR_MESSAGES[err.code] || err.code}`);
      return EXIT.refused;
    }
    // Anything else (database down, unexpected failure) is the panel's own problem, not a refusal.
    console.error(`error: ${err.message}`);
    return EXIT.failed;
  }
}

async function main() {
  const code = await run(process.argv.slice(2));
  await pool.end().catch(() => {});
  process.exit(code);
}

// Only run when invoked directly (`node src/cli/googleApp.js ...`), not when imported by tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
