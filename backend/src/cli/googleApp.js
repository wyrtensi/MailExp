#!/usr/bin/env node
// Admin CLI for Google OAuth apps (see services/oauth/googleApps.js and the "Google apps" admin
// screen). Runs inside the backend container, next to the panel it manages:
//
//   docker compose ... exec -T backend node src/cli/googleApp.js add [--label L] [--user-limit N] \
//     < client_secret_<id>.apps.googleusercontent.com.json
//   docker compose ... exec -T backend node src/cli/googleApp.js list
//
// `add` reads the client JSON on stdin, never as an argument: an argument would sit in shell
// history and the process list. See scripts/deploy/google-app.sh for the host-side wrapper that
// locates the compose project and pipes a local file in.
import '../loadEnv.js';
import { pathToFileURL } from 'node:url';
import {
  GoogleAppError,
  createGoogleApp,
  getEffectiveGoogleRedirectUri,
  listGoogleApps,
} from '../services/oauth/googleApps.js';
import { googleClientJsonWarnings, parseGoogleClientJson } from '../services/oauth/googleClientJson.js';
import { pool } from '../services/db.js';

function usage() {
  return [
    'Usage:',
    '  googleApp.js add [--label LABEL] [--user-limit N] < client_secret_<id>.apps.googleusercontent.com.json',
    '  googleApp.js list',
    '',
    'add reads the OAuth client JSON downloaded from Google Cloud Console (Credentials -> OAuth',
    'client -> Download JSON) on stdin, so the client secret never appears in argv or shell',
    'history. --label defaults to the JSON project_id; --user-limit defaults to 100.',
  ].join('\n');
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

// --flag value pairs only; add takes no positional arguments.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--label' && arg !== '--user-limit') throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function parseUserLimit(raw) {
  if (raw === undefined) return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new GoogleAppError('user_limit_invalid');
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
  const flags = parseFlags(argv);
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

async function cmdList() {
  const apps = await listGoogleApps();
  if (!apps.length) {
    console.log('no Google apps configured');
    return 0;
  }
  for (const app of apps) {
    console.log(`${app.id}  ${app.status.padEnd(8)}  ${app.label}  ${app.client_id}  limit ${app.user_limit}`);
  }
  return 0;
}

const ERROR_MESSAGES = {
  client_json_invalid: 'the input is not valid JSON, or is not a Google OAuth client file',
  client_json_service_account: 'this is a service account key, not an OAuth client; download the OAuth client JSON from Credentials -> OAuth client instead',
  client_json_not_web: 'this is a desktop (installed) OAuth client; create a Web application client instead',
  client_json_incomplete: 'the file is missing a client ID or client secret',
  client_id_invalid: 'client ID is not a Google OAuth client ID',
  client_secret_required: 'client secret is required',
  user_limit_invalid: '--user-limit must be a positive whole number',
  app_exists: 'this client ID is already added',
  app_same_project: 'an app from this Google Cloud project is already added',
};

// run(argv, stdin): the exit code, given the CLI arguments after the command and a readable
// stream for `add`'s stdin. Exported so tests can drive it without spawning a process.
export async function run(argv, stdin = process.stdin) {
  const [command, ...rest] = argv;
  try {
    if (command === 'add') return await cmdAdd(rest, stdin);
    if (command === 'list') return await cmdList();
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
    if (err instanceof GoogleAppError) {
      console.error(`error: ${ERROR_MESSAGES[err.code] || err.code}`);
      return 1;
    }
    console.error(`error: ${err.message}`);
    return 1;
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
