import { refusal } from '../common.js';
import { UsageError } from '../args.js';
import { keyValues } from '../output.js';
import { queueEffects } from '../effects.js';
import {
  SYSTEM_SETTINGS_ERRORS, SYSTEM_SETTING_KEYS, SYSTEM_SETTING_TYPES, getSystemSettings, updateSystemSettings,
} from '../../services/admin/systemSettings.js';

// mailexpert settings ...: the install-wide settings of the admin screen (PATCH
// /api/admin/settings, services/admin/systemSettings.js): the same keys and checks. Only these
// keys are read or written here; other system settings (the SMTP, AI and Access sync settings,
// which hold secrets) have their own commands or screens. What the backend keeps in memory (the
// sign-in limits, the sync intervals, the caches) is read again by a queued job (cli/effects.js).

const KEY_LIST = SYSTEM_SETTING_KEYS.join(', ');
const BOOLEANS = Object.freeze({ true: true, false: false, on: true, off: false, yes: true, no: false, 1: true, 0: false });

function knownKey(key) {
  if (!SYSTEM_SETTING_KEYS.includes(key)) throw new UsageError(`unknown setting: ${key} (one of ${KEY_LIST})`);
  return key;
}

// The value as the API takes it: a boolean, a whole number or the text.
function parseValue(key, raw) {
  const type = SYSTEM_SETTING_TYPES[key];
  if (type === 'boolean') {
    const value = BOOLEANS[String(raw).toLowerCase()];
    if (value === undefined) throw new UsageError(`${key} takes true or false`);
    return value;
  }
  if (type === 'integer') {
    if (!/^\d{1,9}$/.test(raw)) throw new UsageError(`${key} takes a whole number`);
    return Number(raw);
  }
  return raw;
}

const shown = (key, value) => {
  if (value === undefined) return '(not set)';
  if (key === 'custom_css' && value.length > 60) return `(${value.length} characters: "mailexpert settings get custom_css")`;
  return value;
};

const get = {
  name: 'get',
  summary: 'the stored value of the admin screen\'s settings, or of one',
  usage: 'settings get [key]',
  help: [`Keys: ${KEY_LIST}.`, 'A key never set prints "(not set)": the panel uses its default.'],
  optional: ['key'],
  async run(ctx) {
    const settings = await getSystemSettings();
    if (ctx.args.key !== undefined) {
      const key = knownKey(ctx.args.key);
      return { data: { key, value: settings[key] ?? null }, lines: [settings[key] ?? '(not set)'] };
    }
    return { data: { settings }, lines: keyValues(SYSTEM_SETTING_KEYS.map((key) => [key, shown(key, settings[key])])) };
  },
};

const set = {
  name: 'set',
  summary: 'change one setting, with the admin screen\'s checks',
  usage: 'settings set <key> <value>',
  help: [
    `Keys: ${KEY_LIST}.`,
    'Booleans take true or false; auth_max_attempts 1-100, auth_window_minutes 1-1440,',
    'sync_interval_sec 15, 30, 60 or 120, folder_sync_interval_sec 0, 900, 1800 or 3600;',
    'mfa_enforcement off or required; mfa_device_trust never, 7d, 30d or permanent;',
    'custom_css the text ("-" reads it from stdin).',
    'internal_auth_disabled true (password login off) needs an enabled SSO provider and an SSO',
    'identity of the administrator doing it: give --as with an administrator who signs in through',
    'SSO. Setting it to false (password login back on) needs nothing.',
    'The backend reads what it keeps in memory again (a queued job).',
  ],
  positionals: ['key', 'value'],
  async run(ctx) {
    const key = knownKey(ctx.args.key);
    const raw = key === 'custom_css' && ctx.args.value === '-' ? await ctx.readStdin() : ctx.args.value;
    const result = await updateSystemSettings({ [key]: parseValue(key, raw) }, ctx.actor);
    // A refusal still has the backend reload what was written before it, as the route does.
    const queued = await queueEffects(ctx, result.effects);
    if (result.error) throw refusal(SYSTEM_SETTINGS_ERRORS, result.error, result.message ?? null);
    const value = (await getSystemSettings())[key];
    return { data: { key, value: value ?? null, job: queued.job }, lines: [`${key}: ${shown(key, value)}`, ...queued.lines] };
  },
};

export default {
  name: 'settings',
  summary: 'the admin screen\'s install-wide settings: sign-in, 2FA, limits, sync, network',
  commands: [get, set],
};
