import { beforeEach, describe, expect, it, vi } from 'vitest';

const node = vi.hoisted(() => ({ entries: [], calls: [] }));
vi.mock('./mailcow.js', () => ({
  getPostfixLog: vi.fn(async (_cfg, lines) => {
    node.calls.push(lines);
    if (node.entries instanceof Error) throw node.entries;
    return node.entries;
  }),
}));

import {
  BYPASS_SENT, EXPIRED, SENT_TO_EOP_ADDRESS, STAND_LOG, STAND_SENT_LOCAL, STAND_SENT_VIA_EOP,
} from './postfixLog.fixtures.js';
import {
  MAX_LOG_LINES, correlateByQueueId, parsePostfixEntry, parsePostfixLog, parseRelay, readPostfixLog, relayKind,
} from './postfixLog.js';

beforeEach(() => {
  node.entries = [];
  node.calls = [];
});

describe('parsePostfixEntry', () => {
  it('reads a deferred delivery with its relay, DSN and the remote reply', () => {
    const line = parsePostfixEntry(STAND_LOG.at(-4));
    expect(line).toMatchObject({
      at: '2026-10-01T19:02:59.000Z', program: 'postfix/smtp', service: 'smtp', queueId: '53A99193F13',
      event: 'deferred', status: 'deferred', to: 'test@example.com', relay: 'eop.test.local[172.22.1.13]:25',
      relayHost: 'eop.test.local', relayIp: '172.22.1.13', relayPort: 25, dsn: '4.7.500', delay: 0.26,
    });
    // The reply quotes parentheses of its own: the whole of it is kept.
    expect(line.statusText).toBe('host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. Please try again later from [172.22.1.253]. (S77) (in reply to RCPT TO command)');
  });

  it('reads a bounce by EOP and the notice it caused', () => {
    const bounced = parsePostfixEntry(STAND_LOG[16]);
    expect(bounced).toMatchObject({ event: 'bounced', dsn: '5.7.711', queueId: '53A99193F13' });
    expect(bounced.statusText).toContain('AS(2204)');
    expect(parsePostfixEntry(STAND_LOG[14])).toMatchObject({ event: 'notification', queueId: '53A99193F13', notificationQueueId: '5302E195CA8' });
  });

  it('reads the queue bookkeeping lines', () => {
    expect(parsePostfixEntry(STAND_LOG.at(-2))).toMatchObject({ event: 'message_id', messageId: '<20261001190259.53A99193F13@mail.test.local>' });
    expect(parsePostfixEntry(STAND_LOG.at(-3))).toMatchObject({ event: 'queued', from: 'someone@stage.test', size: 360, nrcpt: 1 });
    expect(parsePostfixEntry(STAND_LOG[3])).toMatchObject({ event: 'queued', from: '' });
    expect(parsePostfixEntry(STAND_LOG.at(-1))).toMatchObject({ event: 'received', from: 'someone@stage.test' });
    expect(parsePostfixEntry(STAND_LOG[0])).toMatchObject({ event: 'removed', queueId: 'C9244193F13' });
    expect(parsePostfixEntry(EXPIRED)).toMatchObject({ event: 'expired', status: 'expired', from: 'someone@stage.test' });
  });

  it('reads local delivery and an IPv6 relay', () => {
    expect(parsePostfixEntry(STAND_SENT_LOCAL)).toMatchObject({ event: 'sent', service: 'lmtp', relayHost: 'dovecot', relayPort: 24 });
    expect(parsePostfixEntry(SENT_TO_EOP_ADDRESS)).toMatchObject({ relayIp: '2a01:111:f403:c800::1', relayPort: 25 });
  });

  it('keeps lines without a queue id as other, and NOQUEUE refusals as rejected', () => {
    expect(parsePostfixEntry({ time: '1790879679', program: 'postfix/submission/smtpd', message: 'disconnect from unknown[172.22.1.1] ehlo=1 starttls=1 quit=1 commands=3' }))
      .toMatchObject({ queueId: null, event: 'other', service: 'smtpd' });
    expect(parsePostfixEntry({ time: '1790879679', program: 'postfix/smtpd', message: 'NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 554 5.7.1 <x@stage.test>: Relay access denied; from=<a@b.c> to=<x@stage.test> proto=ESMTP helo=<x>' }))
      .toMatchObject({ queueId: null, event: 'rejected', to: 'x@stage.test' });
    // A word followed by a colon is no queue id.
    expect(parsePostfixEntry({ time: '1', program: 'postfix/smtp', message: 'warning: TLS library problem: error' })).toMatchObject({ queueId: null, event: 'other' });
  });

  it('folds a message logged over several lines and keeps a line cut off before its reply ends', () => {
    const line = parsePostfixEntry({
      time: '1790881379', program: 'postfix/smtp',
      message: 'ABCDEF12345: to=<a@example.com>, relay=eop.test.local[172.22.1.13]:25, dsn=4.4.2, status=deferred (lost connection\n   with eop.test.local[172.22.1.13] while',
    });
    expect(line).toMatchObject({ event: 'deferred', dsn: '4.4.2' });
    expect(line.statusText).toBe('lost connection with eop.test.local[172.22.1.13] while');
  });

  it('accepts an entry still JSON-encoded and drops what is no log line', () => {
    expect(parsePostfixEntry(JSON.stringify(STAND_SENT_VIA_EOP))).toMatchObject({ event: 'sent', dsn: '2.6.0' });
    for (const bad of [null, 42, 'not json', {}, { message: 7 }, { time: '1', message: '   ' }]) {
      expect(parsePostfixEntry(bad)).toBeNull();
    }
    expect(parsePostfixEntry({ time: 'soon', program: 'postfix/qmgr', message: 'C9244193F13: removed' })).toMatchObject({ at: null, epoch: null, event: 'removed' });
  });
});

describe('parseRelay', () => {
  it('splits host, address and port, and keeps none and local as names', () => {
    expect(parseRelay('mx.example.org[198.51.100.25]:25')).toEqual({ relayHost: 'mx.example.org', relayIp: '198.51.100.25', relayPort: 25 });
    expect(parseRelay('none')).toEqual({ relayHost: 'none', relayIp: null, relayPort: null });
    expect(parseRelay(null)).toEqual({ relayHost: null, relayIp: null, relayPort: null });
  });
});

describe('parsePostfixLog and correlateByQueueId', () => {
  it('orders the lines oldest first, keeping the order within a second, and counts the malformed', () => {
    const { lines, malformed } = parsePostfixLog([...STAND_LOG, null, 'x']);
    expect(malformed).toBe(2);
    expect(lines[0]).toMatchObject({ event: 'received', queueId: '53A99193F13' });
    expect(lines.at(-1)).toMatchObject({ event: 'removed', queueId: 'C9244193F13' });
    const second = lines.filter((l) => l.queueId === '98DB419F6B8').map((l) => l.event);
    expect(second).toEqual(['received', 'message_id', 'queued', 'bounced', 'notification', 'removed']);
  });

  it('ties every line of a message together', () => {
    const messages = correlateByQueueId(parsePostfixLog(STAND_LOG).lines);
    const first = messages.get('53A99193F13');
    expect(first).toMatchObject({
      messageId: '<20261001190259.53A99193F13@mail.test.local>', from: 'someone@stage.test', size: 360, nrcpt: 1,
      notifications: ['5302E195CA8'], removed: true, firstAt: '2026-10-01T19:02:59.000Z', lastAt: '2026-10-01T19:03:10.000Z',
    });
    expect(first.deliveries.map((d) => [d.status, d.dsn])).toEqual([['deferred', '4.7.500'], ['bounced', '5.7.711']]);
    expect(messages.get('5302E195CA8')).toMatchObject({ from: '', size: 4436 });
    expect(messages.size).toBe(4);
  });
});

describe('relayKind', () => {
  const parse = (entry) => parsePostfixEntry(entry);

  it('counts the relay named <EOP_HOST>, in any case, as EOP', () => {
    expect(relayKind(parse(STAND_SENT_VIA_EOP), { eopHost: 'EOP.test.local' })).toBe('eop');
    expect(relayKind(parse(STAND_SENT_VIA_EOP), { eopHost: 'other.example.com' })).toBe('other');
  });

  it('counts an address inside the EOP ranges as EOP whatever its name', () => {
    expect(relayKind(parse(SENT_TO_EOP_ADDRESS), { eopHost: 'stage-test.mail.protection.outlook.com' })).toBe('eop');
  });

  it('counts LMTP to Dovecot as local and a direct MX delivery as other', () => {
    expect(relayKind(parse(STAND_SENT_LOCAL), { eopHost: 'eop.test.local' })).toBe('local');
    expect(relayKind(parse(BYPASS_SENT), { eopHost: 'eop.test.local' })).toBe('other');
    expect(relayKind(parse(BYPASS_SENT), {})).toBe('other');
  });
});

describe('readPostfixLog', () => {
  const CFG = { mailHost: 'mail.example.com', apiKey: 'k' };

  it('asks for an explicit count, all the node keeps by default, at most 10000', async () => {
    await readPostfixLog(CFG);
    await readPostfixLog(CFG, { lines: 500 });
    await readPostfixLog(CFG, { lines: 999999 });
    expect(node.calls).toEqual([MAX_LOG_LINES, 500, MAX_LOG_LINES]);
  });

  it('says whether the lines reach back to the time asked for', async () => {
    node.entries = STAND_LOG;
    const read = await readPostfixLog(CFG, { since: 1790881379 * 1000 });
    expect(read).toMatchObject({ fetched: STAND_LOG.length, malformed: 0, oldestAt: '2026-10-01T19:02:59.000Z', newestAt: '2026-10-01T19:03:11.000Z', covered: true });
    expect((await readPostfixLog(CFG, { since: 1790881378 * 1000 })).covered).toBe(false);
    expect((await readPostfixLog(CFG)).covered).toBeNull();
    node.entries = [];
    expect(await readPostfixLog(CFG, { since: 0 })).toMatchObject({ lines: [], oldestAt: null, covered: false });
  });

  it('passes a node failure on', async () => {
    node.entries = new Error('unreachable');
    await expect(readPostfixLog(CFG)).rejects.toThrow('unreachable');
  });
});
