import { CliError, confirm, unwrap } from '../common.js';
import { UsageError } from '../args.js';
import { keyValues, table } from '../output.js';
import { readSecret } from '../effects.js';
import { UUID_RE } from '../../utils/uuid.js';
import {
  OIDC_PROVIDER_ERRORS, createOidcProvider, deleteOidcProvider, listOidcProviders, updateOidcProvider,
} from '../../services/auth/oidcProviders.js';

// mailexpert sso ...: the SSO (OIDC) providers of the admin screen (/api/admin/oidc,
// services/auth/oidcProviders.js): the same checks, including that the last enabled provider stays
// while password login is off. The client secret is read from stdin only and never printed. A
// provider is named by its id or its slug. Not journaled, as the screen's changes are not.

// Text flags -> the API's fields.
const TEXT_FIELDS = Object.freeze({
  name: 'name',
  slug: 'slug',
  issuer: 'issuer_url',
  'client-id': 'client_id',
  scopes: 'scopes',
  provisioning: 'provisioning_mode',
  'allowed-domains': 'allowed_domains',
  'admin-group-claim': 'admin_group_claim',
  'admin-group-value': 'admin_group_value',
  'login-match-claim': 'login_match_claim',
});
// Switches: flag (true) and no-flag (false) -> the API's boolean field.
const SWITCHES = Object.freeze({
  enable: 'enabled',
  'require-email-verified': 'require_email_verified',
  'allow-insecure': 'allow_insecure',
  'rp-logout': 'rp_initiated_logout',
});

const FLAGS = Object.freeze({
  ...Object.fromEntries(Object.keys(TEXT_FIELDS).map((flag) => [flag, 'string'])),
  ...Object.fromEntries(Object.keys(SWITCHES).flatMap((flag) => [[flag, 'boolean'], [`no-${flag}`, 'boolean']])),
  disable: 'boolean',
});

const FIELD_HELP = [
  '--name TEXT                  the name on the sign-in button',
  '--slug SLUG                  lowercase letters, digits and hyphens; part of the callback URL',
  '--issuer URL                 the issuer URL (HTTPS unless --allow-insecure)',
  '--client-id ID               the OAuth client ID',
  '--scopes "S1 S2"             default "openid email profile"',
  '--provisioning MODE          default login_existing_only',
  '--allowed-domains LIST       email domains allowed to sign in; "" clears',
  '--admin-group-claim CLAIM    with --admin-group-value: the claim that makes an administrator',
  '--admin-group-value VALUE',
  '--login-match-claim CLAIM    the claim matched against usernames (default email)',
  '--enable, --disable          on or off',
  '--[no-]require-email-verified, --[no-]allow-insecure, --[no-]rp-logout',
];

// The flags given, as the API's body.
function bodyOf(flags) {
  if (flags.enable && flags.disable) throw new UsageError('--enable and --disable exclude each other');
  if (flags.disable) flags['no-enable'] = true;
  const body = {};
  for (const [flag, field] of Object.entries(TEXT_FIELDS)) if (flags[flag] !== undefined) body[field] = flags[flag];
  for (const [flag, field] of Object.entries(SWITCHES)) {
    if (flags[flag] && flags[`no-${flag}`]) throw new UsageError(`--${flag} and --no-${flag} exclude each other`);
    if (flags[flag]) body[field] = true;
    if (flags[`no-${flag}`]) body[field] = false;
  }
  return body;
}

function providerLines(p) {
  return keyValues([
    ['id', p.id],
    ['name', p.name],
    ['slug', p.slug],
    ['enabled', p.enabled],
    ['issuer', p.issuer_url],
    ['client id', p.client_id],
    ['client secret', 'set (never shown)'],
    ['scopes', p.scopes],
    ['provisioning', p.provisioning_mode],
    ['allowed domains', p.allowed_domains],
    ['require verified email', p.require_email_verified],
    ['allow insecure', p.allow_insecure],
    ['admin group', p.admin_group_claim ? `${p.admin_group_claim} = ${p.admin_group_value ?? ''}` : null],
    ['rp-initiated logout', p.rp_initiated_logout],
    ['login match claim', p.login_match_claim],
  ]);
}

// The provider an id or a slug names.
async function named(idOrSlug) {
  const { providers } = await listOidcProviders();
  const wanted = String(idOrSlug).toLowerCase();
  const provider = providers.find((p) => (UUID_RE.test(wanted) ? p.id === wanted : p.slug === wanted));
  if (!provider) throw new CliError('not_found', OIDC_PROVIDER_ERRORS.not_found[1]);
  return provider;
}

const list = {
  name: 'list',
  summary: 'the SSO providers (never their secrets)',
  usage: 'sso list',
  async run() {
    const data = await listOidcProviders();
    return {
      data,
      lines: table(data.providers, [
        { header: 'SLUG', value: (p) => p.slug },
        { header: 'NAME', value: (p) => p.name },
        { header: 'ENABLED', value: (p) => p.enabled },
        { header: 'ISSUER', value: (p) => p.issuer_url },
        { header: 'CLIENT ID', value: (p) => p.client_id },
        { header: 'ID', value: (p) => p.id },
      ], { empty: '(no SSO providers)' }),
    };
  },
};

const add = {
  name: 'add',
  summary: 'add an SSO provider; the client secret is read from stdin',
  usage: 'sso add --name TEXT --slug SLUG --issuer URL --client-id ID [options] < file-with-the-secret',
  help: [
    'The client secret is read from stdin only (a file or a pipe; in a terminal, paste it and press',
    'Ctrl-D), never from an argument, and never printed.',
    ...FIELD_HELP,
  ],
  flags: FLAGS,
  async run(ctx) {
    const body = bodyOf({ ...ctx.flags });
    body.client_secret = await readSecret(ctx, 'client secret');
    const { provider } = unwrap(await createOidcProvider(body), OIDC_PROVIDER_ERRORS);
    return { data: { provider }, lines: [`added ${provider.slug}`, ...providerLines(provider)] };
  },
};

const set = {
  name: 'set',
  summary: 'change an SSO provider; --secret reads a new client secret from stdin',
  usage: 'sso set <id|slug> [options] [--secret < file-with-the-secret]',
  help: [
    '--secret   replace the client secret with the one read from stdin (never printed);',
    '           without it the stored secret stays',
    ...FIELD_HELP,
    'Options not given keep their value. Disabling the last enabled provider while password login',
    'is off is refused (last_provider).',
  ],
  positionals: ['provider'],
  flags: { ...FLAGS, secret: 'boolean' },
  async run(ctx) {
    const body = bodyOf({ ...ctx.flags });
    if (ctx.flags.secret) {
      body.client_secret = await readSecret(ctx, 'client secret');
      if (!body.client_secret) throw new CliError('secret_missing', 'No client secret on stdin');
    }
    if (!Object.keys(body).length) throw new UsageError('nothing to change: give an option or --secret');
    const current = await named(ctx.args.provider);
    const { provider } = unwrap(await updateOidcProvider(current.id, body), OIDC_PROVIDER_ERRORS);
    return { data: { provider }, lines: providerLines(provider) };
  },
};

const remove = {
  name: 'remove',
  summary: 'delete an SSO provider and the identities linked through it',
  usage: 'sso remove <id|slug>',
  help: [
    'Asks for confirmation (--yes answers it). Refused for the last enabled provider while',
    'password login is off (last_provider): turn password login on first',
    '("mailexpert settings set internal_auth_disabled false").',
  ],
  positionals: ['provider'],
  async run(ctx) {
    const provider = await named(ctx.args.provider);
    await confirm(ctx, `Delete the SSO provider ${provider.slug}? Users linked through it sign in another way afterwards.`);
    unwrap(await deleteOidcProvider(provider.id), OIDC_PROVIDER_ERRORS);
    return { data: { ok: true }, lines: [`removed ${provider.slug}`] };
  },
};

export default {
  name: 'sso',
  summary: 'the SSO (OIDC) providers people sign in with',
  commands: [list, add, set, remove],
};
