// Argument parsing of the panel CLI (src/cli/mailexpert.js): --flag value, --flag=value, boolean
// flags, short aliases (-y, -h) and positionals. No dependency: the backend image carries none for
// this.

// What the CLI's exit code says (docs/operations/deployment.md, "CLI панели").
export const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2, failed: 3 });

// A problem with the command line itself: exit 2 with the usage of the command.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'usage';
  }
}

// The flags every command takes.
export const GLOBAL_FLAGS = Object.freeze({ json: 'boolean', yes: 'boolean', help: 'boolean', as: 'string' });
const GLOBAL_ALIASES = Object.freeze({ y: 'yes', h: 'help' });

// argv: the words after the command's name. spec: { flags: { name: 'boolean' | 'string' },
// aliases: { name: canonical name }, positionals: [name, ...] (required, in order), optional:
// [name, ...] (after them) }. Answers { flags, args } with args by name; a flag not given is
// undefined. Throws UsageError.
export function parseArgs(argv, spec = {}) {
  const types = { ...GLOBAL_FLAGS, ...(spec.flags ?? {}) };
  const aliases = { ...GLOBAL_ALIASES, ...(spec.aliases ?? {}) };
  const flags = {};
  const words = [];
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      words.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const raw = arg.startsWith('--') ? arg.slice(2, eq > 0 ? eq : undefined) : arg.slice(1, eq > 0 ? eq : undefined);
    const name = aliases[raw] ?? raw;
    const type = types[name];
    if (!type || (!arg.startsWith('--') && !aliases[raw])) throw new UsageError(`unknown option: ${arg.slice(0, eq > 0 ? eq : undefined)}`);
    if (name in flags) throw new UsageError(`--${name} is given twice`);
    if (type === 'boolean') {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      i += 1;
    }
    flags[name] = value;
  }
  const required = spec.positionals ?? [];
  const optional = spec.optional ?? [];
  // --help answers whatever else the line says.
  if (flags.help) return { flags, args: {} };
  if (words.length < required.length) throw new UsageError(`missing ${required.slice(words.length).map((n) => `<${n}>`).join(' ')}`);
  if (words.length > required.length + optional.length) {
    throw new UsageError(`unexpected argument: ${words[required.length + optional.length]}`);
  }
  const args = {};
  [...required, ...optional].forEach((name, i) => {
    if (i < words.length) args[name] = words[i];
  });
  return { flags, args };
}

// A whole number from min to max given as a flag, or the fallback when it is missing.
export function parseCount(value, { name, min = 1, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}
