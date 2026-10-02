import { describe, expect, it } from 'vitest';
import { EXPIRED, STAND_DELIVERY, STAND_LOG, STAND_SENT_VIA_EOP } from './mailNode/postfixLog.fixtures.js';
import { parsePostfixLog } from './mailNode/postfixLog.js';
import {
  acceptanceOf, indexLog, letterOutcomes, logCoverage, mergeOutcome, presentOutcome, tlsForDelivery, trimDiagnostic,
} from './deliveryStatus.js';

const BOX = new Set(['r17-delivery@stage.test']);
const ACCEPTED = '<r17-accepted-1790933733899@stage.test>';
const DENIED = '<r17-denied-1790933353895@stage.test>';
const standIndex = () => indexLog(parsePostfixLog(STAND_DELIVERY).lines);

describe('acceptanceOf', () => {
  it('reads EOP\'s 250 in the real shape', () => {
    expect(acceptanceOf('250 2.6.0 <r17-accepted-1790933733899@stage.test> [InternalId=1099511627777, Hostname=EOPSTAGE01MB0001.stageprd01.prod.eop.test.local] 1091 bytes in 0.049, 21.743 KB/sec Queued mail for delivery'))
      .toEqual({ messageId: ACCEPTED, internalId: '1099511627777', hostname: 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' });
    expect(acceptanceOf('250 2.6.0 <CAB1x@mail.example> [InternalId=21233419887456, Hostname=DM6PR11MB4459.namprd11.prod.outlook.com] 12345 bytes in 0.215, 56.103 KB/sec Queued mail for delivery -> 250 2.1.5'))
      .toEqual({ messageId: '<CAB1x@mail.example>', internalId: '21233419887456', hostname: 'DM6PR11MB4459.namprd11.prod.outlook.com' });
  });

  it('reads the older stand shape without Hostname, and nothing else', () => {
    expect(acceptanceOf(parsePostfixLog([STAND_SENT_VIA_EOP]).lines[0].statusText)).toEqual({ messageId: '<20261001T095137363-0030-5f27@eop.test.local>', internalId: '30', hostname: null });
    expect(acceptanceOf('250 2.0.0 <a@b> Saved')).toBeNull();
    expect(acceptanceOf(null)).toBeNull();
  });
});

describe('the log of one letter', () => {
  it('gives each recipient of an accepted letter its relay, TLS and acceptance', () => {
    const outcomes = letterOutcomes(standIndex(), ACCEPTED, BOX, { eopHost: 'eop.test.local' });
    expect(outcomes.map((o) => o.recipient)).toEqual(['test@example.com', 'second@example.org']);
    expect(outcomes[0]).toEqual({
      recipient: 'test@example.com', state: 'sent', at: '2026-10-02T09:35:38.000Z', statusCode: '2.6.0', diagnostic: null,
      details: {
        queueId: '0C3BF1A4B81', relayHost: 'eop.test.local', relayIp: '172.22.1.7', relayPort: 25, relayKind: 'eop',
        reply: expect.stringMatching(/^250 2\.6\.0 <r17-accepted/),
        tls: { level: 'untrusted', protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', bits: '256/256 bits', matchedBy: 'time' },
        acceptance: { messageId: ACCEPTED, internalId: '1099511627777', hostname: 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' },
      },
    });
  });

  it('gives each refused recipient the code and the remote reply, without the bounce notice', () => {
    const outcomes = letterOutcomes(standIndex(), DENIED, BOX, { eopHost: 'eop.test.local' });
    expect(outcomes.map((o) => [o.recipient, o.state, o.statusCode, o.diagnostic])).toEqual([
      ['test@example.com', 'bounced', '5.4.1', '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)'],
      ['second@example.org', 'bounced', '5.4.1', '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)'],
    ]);
    expect(outcomes[0].details.acceptance).toBeNull();
    expect(outcomes[0].details.tls).toMatchObject({ level: 'untrusted', matchedBy: 'time' });
  });

  it('takes nothing from a queue entry another sender queued, even with the same Message-ID', () => {
    expect(letterOutcomes(standIndex(), ACCEPTED, new Set(['someone@stage.test']))).toEqual([]);
    expect(letterOutcomes(standIndex(), '<unknown@x>', BOX)).toEqual([]);
  });

  it('keeps the last attempt per recipient, and turns what stayed deferred into expired', () => {
    // STAND_LOG: 53A99193F13 was deferred (451), then bounced (5.7.711).
    const index = indexLog(parsePostfixLog(STAND_LOG).lines);
    const [outcome] = letterOutcomes(index, '<20261001190259.53A99193F13@mail.test.local>', new Set(['someone@stage.test']));
    expect(outcome).toMatchObject({ recipient: 'test@example.com', state: 'bounced', statusCode: '5.7.711' });
    const deferredThenExpired = [
      { ...EXPIRED, message: '9C3D4E5F6A7: from=<someone@stage.test>, status=expired, returned to sender' },
      { time: '1790881500', program: 'postfix/smtp', message: '9C3D4E5F6A7: to=<a@example.org>, relay=eop.test.local[172.22.1.13]:25, delay=1, delays=0/0/0.5/0.5, dsn=4.7.500, status=deferred (host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy (in reply to RCPT TO command))' },
      { time: '1790881400', program: 'postfix/qmgr', message: '9C3D4E5F6A7: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)' },
      { time: '1790881400', program: 'postfix/cleanup', message: '9C3D4E5F6A7: message-id=<old@stage.test>' },
    ];
    const [expired] = letterOutcomes(indexLog(parsePostfixLog(deferredThenExpired).lines), '<old@stage.test>', new Set(['someone@stage.test']));
    expect(expired).toMatchObject({ recipient: 'a@example.org', state: 'expired', at: '2026-10-01T19:06:40.000Z', statusCode: '4.7.500' });
  });
});

describe('tlsForDelivery', () => {
  const tlsLine = (time, host = 'eop.test.local[172.22.1.7]:25') => ({ time, program: 'postfix/smtp', message: `Untrusted TLS connection established to ${host}: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits)` });
  const delivery = (time, extra = {}) => ({ time, program: 'postfix/smtp', message: 'AB12CD34EF5: to=<a@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.3, delays=0.1/0/0.1/0.1, dsn=2.6.0, status=sent (250 ok)', ...extra });
  const tlsOf = (entries) => {
    const { lines } = parsePostfixLog(entries);
    return tlsForDelivery(lines, lines.findIndex((l) => l.queueId));
  };

  it('takes the TLS line to the same host within the connection time only', () => {
    expect(tlsOf([delivery('1000'), tlsLine('999')])).toMatchObject({ matchedBy: 'time' });
    // Older than delays c + d (0.2 s, rounded up) plus a second: a reused connection, not in the log.
    expect(tlsOf([delivery('1000'), tlsLine('997')])).toBeNull();
    expect(tlsOf([delivery('1000'), tlsLine('1000', 'other.example[172.22.1.8]:25')])).toBeNull();
  });

  it('matches by process id when the log carries one', () => {
    const entries = [
      delivery('1100', { program: 'postfix/smtp[7]' }),
      { ...tlsLine('1099'), program: 'postfix/smtp[8]' },
      { ...tlsLine('1000'), program: 'postfix/smtp[7]', message: tlsLine('1000').message.replace('Untrusted', 'Verified') },
    ];
    expect(tlsOf(entries)).toMatchObject({ level: 'verified', matchedBy: 'pid' });
  });
});

describe('mergeOutcome', () => {
  const log = (state, at, extra = {}) => ({ source: 'log', state, at, statusCode: state === 'sent' ? '2.6.0' : '4.7.500', diagnostic: null, details: { relayHost: 'eop.test.local', ...extra } });
  const dsn = (state, at) => ({ source: 'dsn', state, at, statusCode: '5.7.64', diagnostic: 'TenantAttribution', details: { action: state } });

  it('lets a later report win over the log\'s sent, keeping both sources\' details', () => {
    const first = mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z')).row;
    const { row, changed } = mergeOutcome(first, dsn('failed', '2026-10-02T10:05:00.000Z'));
    expect(changed).toBe(true);
    expect(row).toMatchObject({ state: 'failed', source: 'dsn', statusCode: '5.7.64', eventAt: '2026-10-02T10:05:00.000Z' });
    expect(row.log).toMatchObject({ state: 'sent', relayHost: 'eop.test.local' });
    // The alert job reading the same sent line again changes nothing and never clobbers the report.
    expect(mergeOutcome(row, log('sent', '2026-10-02T10:00:00.000Z'))).toEqual({ row, changed: false });
  });

  it('moves deferred to sent, ignores an older line, and lets a failure win a tie', () => {
    const deferred = mergeOutcome(null, log('deferred', '2026-10-02T10:00:00.000Z')).row;
    const sent = mergeOutcome(deferred, log('sent', '2026-10-02T10:10:00.000Z')).row;
    expect(sent.state).toBe('sent');
    expect(mergeOutcome(sent, log('deferred', '2026-10-02T10:00:00.000Z')).changed).toBe(false);
    const tie = mergeOutcome(sent, dsn('failed', '2026-10-02T10:10:00.000Z')).row;
    expect(tie).toMatchObject({ state: 'failed', source: 'dsn' });
  });

  it('compares a stored outcome whatever the order of its keys', () => {
    const { row } = mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z', { tls: { cipher: 'x', level: 'untrusted' } }));
    const reordered = { ...row, log: Object.fromEntries(Object.entries(row.log).reverse()) };
    expect(mergeOutcome(reordered, log('sent', '2026-10-02T10:00:00.000Z', { tls: { level: 'untrusted', cipher: 'x' } })).changed).toBe(false);
  });
});

describe('presenting and coverage', () => {
  it('explains a failure and not a success', () => {
    expect(presentOutcome({ recipient: 'a@b', state: 'bounced', source: 'log', statusCode: '5.4.1', diagnostic: '550 5.4.1 rejected', eventAt: 't', log: {}, report: null }).explanation)
      .toEqual({ key: 'recipient_not_accepted', class: 'permanent', code: '5.4.1' });
    expect(presentOutcome({ recipient: 'a@b', state: 'sent', source: 'log', statusCode: '2.6.0', diagnostic: null, eventAt: 't', log: {}, report: null }).explanation).toBeNull();
  });

  it('tells found, stored, gone and not found apart', () => {
    expect(logCoverage({ found: true, stored: true, sentAt: null, oldestAt: null })).toBe('found');
    expect(logCoverage({ found: false, stored: true, sentAt: '2026-10-01T00:00:00Z', oldestAt: '2026-10-02T00:00:00Z' })).toBe('stored');
    expect(logCoverage({ found: false, stored: false, sentAt: '2026-10-01T00:00:00Z', oldestAt: '2026-10-02T00:00:00Z' })).toBe('gone');
    expect(logCoverage({ found: false, stored: false, sentAt: '2026-10-03T00:00:00Z', oldestAt: '2026-10-02T00:00:00Z' })).toBe('not_found');
  });

  it('folds and cuts a diagnostic', () => {
    expect(trimDiagnostic('  a \n  b ')).toBe('a b');
    expect(trimDiagnostic('')).toBeNull();
    expect(trimDiagnostic('x'.repeat(400))).toHaveLength(300);
  });
});
