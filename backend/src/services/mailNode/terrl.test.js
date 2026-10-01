import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { parsePostfixLog } from './postfixLog.js';
import {
  BYPASS_SENT, SENT_TO_EOP_ADDRESS, SENT_TO_RECIPIENT_M365_MX, STAND_SENT_LOCAL, STAND_SENT_VIA_EOP,
} from './postfixLog.fixtures.js';
import {
  eopRecipientsInLog, externalRecipients, rampPercent, recipientAddress, tenantAgeDays, terrlBudget, terrlFromLicenses, terrlLimit,
} from './terrl.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('terrlFromLicenses', () => {
  it.each([
    [1, 10000], [100, 22059], [500, 48248], [1000, 72446],
  ])('%i licenses -> %i recipients', (licenses, limit) => {
    expect(terrlFromLicenses(licenses)).toBe(limit);
  });

  it('is null without a whole number of licenses', () => {
    for (const value of [0, -1, 1.5, null, '100']) expect(terrlFromLicenses(value)).toBeNull();
  });
});

describe('the young tenant ramp', () => {
  it.each([
    ['2026-10-01', 0, 10], ['2026-09-01', 30, 10], ['2026-08-31', 31, 25], ['2026-08-02', 60, 25], ['2026-08-01', 61, 100],
  ])('a tenant created %s is %i days old and gets %i percent', (createdOn, age, percent) => {
    expect(tenantAgeDays(createdOn, NOW)).toBe(age);
    expect(rampPercent(tenantAgeDays(createdOn, NOW))).toBe(percent);
  });

  it('gives the full limit without a creation date', () => {
    expect(tenantAgeDays(null, NOW)).toBeNull();
    expect(tenantAgeDays('01.09.2026', NOW)).toBeNull();
    expect(rampPercent(null)).toBe(100);
  });

  it('applies the ramp to the limit: 500 licenses -> 4 825 and 12 062', () => {
    expect(terrlLimit({ licenses: 500, tenantCreatedOn: '2026-09-20' }, NOW)).toEqual({
      fullLimit: 48248, limitFrom: 'licenses', ageDays: 11, rampPercent: 10, limit: 4825,
    });
    expect(terrlLimit({ licenses: 500, tenantCreatedOn: '2026-08-15' }, NOW)).toMatchObject({ rampPercent: 25, limit: 12062 });
  });

  it('prefers the TERRL an administrator entered over the formula', () => {
    expect(terrlLimit({ terrl: 30000, licenses: 500 }, NOW)).toMatchObject({ fullLimit: 30000, limitFrom: 'terrl', limit: 30000 });
    expect(terrlLimit({}, NOW)).toMatchObject({ fullLimit: null, limitFrom: null, limit: null });
  });
});

describe('externalRecipients', () => {
  it('counts unique addresses, any case and form, without the node domains', () => {
    const found = externalRecipients({
      journal: [
        { to: ['Partner <Partner@Example.org>', 'colleague@stage.test'], cc: ['partner@example.org'], bcc: ['audit@example.net'] },
        { to: ['"Odd, Name" <odd@example.com>'], cc: [], bcc: null },
        {},
      ],
      addresses: ['bounce-target@example.com', 'AUDIT@example.net', 'local@Stage.Test'],
      ownDomains: ['stage.test'],
    });
    expect([...found].sort()).toEqual(['audit@example.net', 'bounce-target@example.com', 'odd@example.com', 'partner@example.org']);
  });

  it('reads an address out of what a recipient may look like', () => {
    expect(recipientAddress(' A <a@b.c> ')).toBe('a@b.c');
    expect(recipientAddress('no-at-sign')).toBeNull();
    expect(recipientAddress('x@')).toBeNull();
  });
});

describe('eopRecipientsInLog', () => {
  it('takes the recipients handed to EOP within the window, not local or bypassed mail', () => {
    const { lines } = parsePostfixLog([BYPASS_SENT, STAND_SENT_LOCAL, STAND_SENT_VIA_EOP]);
    expect(eopRecipientsInLog(lines, { since: 0, eopHost: 'eop.test.local' })).toEqual(['test@example.com']);
    expect(eopRecipientsInLog(lines, { since: Date.parse('2026-10-02T00:00:00Z'), eopHost: 'eop.test.local' })).toEqual([]);
  });

  it('does not count mail to a recipient\'s Microsoft 365 MX, nor anything without <EOP_HOST>', () => {
    const { lines } = parsePostfixLog([SENT_TO_RECIPIENT_M365_MX, SENT_TO_EOP_ADDRESS, STAND_SENT_VIA_EOP]);
    expect(eopRecipientsInLog(lines, { since: 0, eopHost: 'eop.test.local' })).toEqual(['test@example.com']);
    expect(eopRecipientsInLog(lines, { since: 0, eopHost: null })).toEqual([]);
  });
});

describe('terrlBudget', () => {
  it('warns at 80 percent of the limit', () => {
    const settings = { terrl: 1000 };
    expect(terrlBudget({ settings, used: 799, now: NOW })).toMatchObject({ limit: 1000, percent: 79, warn: false, exceeded: false });
    expect(terrlBudget({ settings, used: 800, now: NOW })).toMatchObject({ percent: 80, warn: true, exceeded: false });
    expect(terrlBudget({ settings, used: 1000, now: NOW })).toMatchObject({ percent: 100, warn: true, exceeded: true });
  });

  it('counts but never warns without a limit', () => {
    expect(terrlBudget({ settings: {}, used: 5000, now: NOW })).toMatchObject({ limit: null, used: 5000, percent: null, warn: false });
  });

  it('warns a young tenant at 80 percent of its ramped limit', () => {
    const young = { licenses: 100, tenantCreatedOn: new Date(NOW - 5 * DAY).toISOString().slice(0, 10) };
    expect(terrlBudget({ settings: young, used: 1765, now: NOW })).toMatchObject({ limit: 2206, warn: true });
  });
});
