import { CliError, confirm, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { fmtDate, keyValues } from '../output.js';
import { queueEffects, readSecret } from '../effects.js';
import {
  MICROSOFT_INTEGRATION_ERRORS, REDACTED_SECRET, getMicrosoftIntegration, removeMicrosoftIntegration,
  saveMicrosoftIntegration,
} from '../../services/integrations/microsoft.js';

// mailexpert integration microsoft ...: the Microsoft OAuth client of the admin screen's
// "Integrations" (/api/integrations/microsoft, services/integrations/microsoft.js), which Outlook
// mailboxes connect through. The client secret is read from stdin only and shown as set or not,
// never its value. The backend reads the client again (a queued job, cli/effects.js); Google's
// apps have their own CLI (src/cli/googleApp.js).

const ACTIONS = Object.freeze(['show', 'set', 'remove']);
const TEXT_FLAGS = Object.freeze({ 'client-id': 'clientId', 'tenant-id': 'tenantId', 'redirect-uri': 'redirectUri' });

function configLines(config) {
  if (!config) return ['Microsoft client: not configured'];
  return keyValues([
    ['client id', config.clientId],
    ['tenant id', config.tenantId],
    ['redirect uri', config.redirectUri],
    ['client secret', config.clientSecret ? 'set (never shown)' : 'not set'],
    ['updated', fmtDate(config.updated_at)],
  ]);
}

async function show() {
  const config = await getMicrosoftIntegration();
  return { data: { config }, lines: configLines(config) };
}

// The given fields replace the stored ones, the rest stay; the stored secret stays unless --secret.
async function set(ctx) {
  const given = Object.fromEntries(Object.entries(TEXT_FLAGS)
    .filter(([flag]) => ctx.flags[flag] !== undefined)
    .map(([flag, field]) => [field, ctx.flags[flag]]));
  if (!Object.keys(given).length && !ctx.flags.secret) {
    throw new UsageError('nothing to change: give --client-id, --tenant-id, --redirect-uri or --secret');
  }
  const current = { ...(await getMicrosoftIntegration()) };
  delete current.updated_at;
  const config = { ...current, ...given };
  if (ctx.flags.secret) {
    config.clientSecret = await readSecret(ctx, 'client secret');
    if (!config.clientSecret) throw new CliError('secret_missing', 'No client secret on stdin');
  } else if (current.clientSecret) {
    config.clientSecret = REDACTED_SECRET;
  }
  unwrap(await saveMicrosoftIntegration(config), MICROSOFT_INTEGRATION_ERRORS);
  const queued = await queueEffects(ctx, { reload: ['microsoft'] });
  const saved = await getMicrosoftIntegration();
  return { data: { config: saved, job: queued.job }, lines: [...configLines(saved), ...queued.lines] };
}

async function remove(ctx) {
  await confirm(ctx, 'Remove the Microsoft client? Outlook mailboxes can no longer be connected or reconnected until it is set again.');
  await removeMicrosoftIntegration();
  const queued = await queueEffects(ctx, { reload: ['microsoft'] });
  return { data: { ok: true, job: queued.job }, lines: ['removed the Microsoft client', ...queued.lines] };
}

const microsoft = {
  name: 'microsoft',
  summary: 'the Microsoft OAuth client: show, set (the secret from stdin), remove',
  usage: 'integration microsoft show | set [--client-id ID] [--tenant-id ID] [--redirect-uri URL] [--secret] | remove',
  help: [
    'show                 the client, the secret only as set or not set',
    'set                  change the given fields; the others stay',
    '  --client-id ID       the application (client) ID',
    '  --tenant-id ID       the tenant, or common',
    '  --redirect-uri URL   the callback URL registered for the application',
    '  --secret             replace the client secret with the one read from stdin (a file or a',
    '                       pipe; in a terminal, paste it and press Ctrl-D); never an argument,',
    '                       never printed; without it the stored secret stays',
    'remove               delete the client (asks for confirmation; --yes answers it)',
    'The backend reads the client again after set and remove (a queued job). Not journaled, as the',
    'screen\'s changes are not.',
  ],
  positionals: ['action'],
  flags: { 'client-id': 'string', 'tenant-id': 'string', 'redirect-uri': 'string', secret: 'boolean' },
  async run(ctx) {
    const { action } = ctx.args;
    if (!ACTIONS.includes(action)) throw new UsageError(`unknown action: ${action} (show, set or remove)`);
    const changing = Object.keys(TEXT_FLAGS).some((flag) => ctx.flags[flag] !== undefined) || ctx.flags.secret;
    if (action !== 'set' && changing) throw new UsageError(`${action} takes no options`);
    if (action === 'show') return show();
    if (action === 'set') return set(ctx);
    return remove(ctx);
  },
};

export default {
  name: 'integration',
  summary: 'the OAuth clients mailboxes connect through (Microsoft)',
  commands: [microsoft],
};
