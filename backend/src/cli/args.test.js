import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs, parseCount } from './args.js';

const SPEC = { flags: { reason: 'string', wait: 'boolean' }, aliases: { r: 'reason' }, positionals: ['mailbox'], optional: ['extra'] };

describe('parseArgs', () => {
  it('reads positionals by name, string and boolean flags in any order', () => {
    expect(parseArgs(['--wait', 'a@example.com', '--reason', 'left'], SPEC)).toEqual({
      flags: { wait: true, reason: 'left' }, args: { mailbox: 'a@example.com' },
    });
  });

  it('takes --flag=value, short aliases and the global flags', () => {
    expect(parseArgs(['a@example.com', '--reason=a=b', '-y', '--json', '--as', 'admin@example.com'], SPEC).flags)
      .toEqual({ reason: 'a=b', yes: true, json: true, as: 'admin@example.com' });
    expect(parseArgs(['a@example.com', '-r', 'x'], SPEC).flags).toEqual({ reason: 'x' });
  });

  it('keeps an empty value and words after -- as positionals', () => {
    expect(parseArgs(['--reason', '', '--', '--not-a-flag'], SPEC)).toEqual({ flags: { reason: '' }, args: { mailbox: '--not-a-flag' } });
  });

  it('fills optional positionals only when given', () => {
    expect(parseArgs(['a', 'b'], SPEC).args).toEqual({ mailbox: 'a', extra: 'b' });
  });

  it('answers --help whatever else is missing', () => {
    expect(parseArgs(['--help'], SPEC)).toEqual({ flags: { help: true }, args: {} });
    expect(parseArgs(['-h'], SPEC).flags.help).toBe(true);
  });

  it.each([
    [['a', '--bogus'], /unknown option: --bogus/],
    [['a', '-x'], /unknown option: -x/],
    [['a', '--reason'], /--reason needs a value/],
    [['a', '--wait=1'], /--wait takes no value/],
    [['a', '--reason', 'x', '--reason', 'y'], /given twice/],
    [[], /missing <mailbox>/],
    [['a', 'b', 'c'], /unexpected argument: c/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv, SPEC)).toThrow(UsageError);
    expect(() => parseArgs(argv, SPEC)).toThrow(message);
  });
});

describe('parseCount', () => {
  it('answers the fallback when the flag is missing and the number otherwise', () => {
    expect(parseCount(undefined, { name: 'limit', max: 10, fallback: 3 })).toBe(3);
    expect(parseCount('7', { name: 'limit', max: 10, fallback: 3 })).toBe(7);
  });

  it.each(['0', '11', '-1', '1.5', 'abc', ''])('refuses %j', (value) => {
    expect(() => parseCount(value, { name: 'limit', max: 10, fallback: 3 })).toThrow(/--limit must be a whole number from 1 to 10/);
  });
});
