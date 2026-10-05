import { describe, expect, it } from 'vitest';
import { DISCARDED, EXPIRED, STAND_DELIVERY, STAND_LOG, STAND_SENT_VIA_EOP } from './mailNode/postfixLog.fixtures.js';
import { parsePostfixLog } from './mailNode/postfixLog.js';
import {
  DELAY_STALE_MS, acceptanceOf, indexLog, leftQueueOutcomes, letterOutcomes, logCoverage, mergeOutcome, ownEntries,
  presentOutcome, tlsForDelivery, trimDiagnostic,
} from './deliveryStatus.js';

const LOGIN = 'r17-delivery@stage.test';
const ACCEPTED = '<r17-accepted-1790933733899@stage.test>';
const DENIED = '<r17-denied-1790933353895@stage.test>';
const index = (entries) => indexLog(parsePostfixLog(entries).lines);
const standIndex = () => index(STAND_DELIVERY);
const entry = (time, message, program = 'postfix/smtp') => ({ time, program, priority: 'info', message });

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
    const outcomes = letterOutcomes(standIndex(), ACCEPTED, LOGIN, { eopHost: 'eop.test.local' });
    expect(outcomes.map((o) => o.recipient)).toEqual(['test@example.com', 'second@example.org']);
    expect(outcomes[0]).toEqual({
      recipient: 'test@example.com', state: 'sent', at: '2026-10-02T09:35:38.000Z', statusCode: '2.6.0', diagnostic: null,
      details: {
        queueId: '0C3BF1A4B81', sender: LOGIN, finalRecipient: null, relayHost: 'eop.test.local', relayIp: '172.22.1.7', relayPort: 25, relayKind: 'eop',
        reply: expect.stringMatching(/^250 2\.6\.0 <r17-accepted/),
        tls: { level: 'untrusted', protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', bits: '256/256 bits', matchedBy: 'time' },
        acceptance: { messageId: ACCEPTED, internalId: '1099511627777', hostname: 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' },
      },
    });
  });

  it('gives each refused recipient the code and the remote reply, without the bounce notice', () => {
    const outcomes = letterOutcomes(standIndex(), DENIED, LOGIN, { eopHost: 'eop.test.local' });
    expect(outcomes.map((o) => [o.recipient, o.state, o.statusCode, o.diagnostic])).toEqual([
      ['test@example.com', 'bounced', '5.4.1', '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)'],
      ['second@example.org', 'bounced', '5.4.1', '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)'],
    ]);
    expect(outcomes[0].details.acceptance).toBeNull();
    expect(outcomes[0].details.tls).toMatchObject({ level: 'untrusted', matchedBy: 'time' });
  });

  it('takes nothing for another login, even one that is the envelope sender through an alias', () => {
    expect(letterOutcomes(standIndex(), ACCEPTED, 'someone@stage.test')).toEqual([]);
    expect(letterOutcomes(standIndex(), '<unknown@x>', LOGIN)).toEqual([]);
  });

  it('trusts the submission login over the envelope sender, and leaves out a redirected copy', () => {
    const own = { queueId: 'A', saslUsername: LOGIN, from: 'alias@stage.test' };
    const redirect = { queueId: 'B', saslUsername: null, from: LOGIN };
    const foreign = { queueId: 'C', saslUsername: 'boss@stage.test', from: LOGIN };
    expect(ownEntries([own, redirect, foreign], LOGIN).map((e) => e.queueId)).toEqual(['A']);
    // No login in the log at all: the envelope sender must be the login address, never an alias.
    expect(ownEntries([redirect, foreign, { queueId: 'D', saslUsername: null, from: 'alias@stage.test' }], LOGIN).map((e) => e.queueId)).toEqual(['B']);
  });

  it('keeps the last attempt per recipient, and turns what stayed deferred into expired', () => {
    // STAND_LOG: 53A99193F13 was deferred (451), then bounced (5.7.711); no login logged (pickup).
    const [outcome] = letterOutcomes(index(STAND_LOG), '<20261001190259.53A99193F13@mail.test.local>', 'someone@stage.test');
    expect(outcome).toMatchObject({ recipient: 'test@example.com', state: 'bounced', statusCode: '5.7.711' });
    const deferredThenExpired = [
      { ...EXPIRED, message: '9C3D4E5F6A7: from=<someone@stage.test>, status=expired, returned to sender' },
      entry('1790881500', '9C3D4E5F6A7: to=<a@example.org>, relay=eop.test.local[172.22.1.13]:25, delay=1, delays=0/0/0.5/0.5, dsn=4.7.500, status=deferred (host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy (in reply to RCPT TO command))'),
      entry('1790881400', '9C3D4E5F6A7: from=<someone@stage.test>, size=360, nrcpt=1 (queue active)', 'postfix/qmgr'),
      entry('1790881400', '9C3D4E5F6A7: message-id=<old@stage.test>', 'postfix/cleanup'),
    ];
    const [expired] = letterOutcomes(index(deferredThenExpired), '<old@stage.test>', 'someone@stage.test');
    expect(expired).toMatchObject({ recipient: 'a@example.org', state: 'expired', at: '2026-10-01T19:06:40.000Z', statusCode: '4.7.500' });
  });

  it('names the recipient as the sender wrote it, and a discarded letter as discarded', () => {
    const lines = [
      entry('1790881410', 'AB12CD34EF5: to=<list-member@example.org>, orig_to=<list@stage.test>, relay=eop.test.local[172.22.1.7]:25, delay=1, delays=0/0/0.5/0.5, dsn=2.6.0, status=sent (250 2.6.0 ok)'),
      entry('1790881400', 'AB12CD34EF5: from=<r17-delivery@stage.test>, size=360, nrcpt=1 (queue active)', 'postfix/qmgr'),
      entry('1790881400', 'AB12CD34EF5: message-id=<o@stage.test>', 'postfix/cleanup'),
      { ...DISCARDED, message: 'AE4F5A6B7C8: to=<nobody@example.org>, relay=none, delay=0.1, delays=0.1/0/0/0, dsn=2.0.0, status=sent (discarded by header check)' },
      entry('1790881503', 'AE4F5A6B7C8: from=<r17-delivery@stage.test>, size=360, nrcpt=1 (queue active)', 'postfix/qmgr'),
      entry('1790881503', 'AE4F5A6B7C8: message-id=<d@stage.test>', 'postfix/cleanup'),
    ];
    const [orig] = letterOutcomes(index(lines), '<o@stage.test>', LOGIN);
    expect(orig).toMatchObject({ recipient: 'list@stage.test', details: { finalRecipient: 'list-member@example.org' } });
    expect(letterOutcomes(index(lines), '<d@stage.test>', LOGIN)[0].details.relayKind).toBe('discard');
  });
});

describe('a letter that stays deferred', () => {
  // The letter was deferred while its cleanup and submission lines were in the log; the rows keep
  // its queue id. Later reads hold only the later lines.
  const stored = (state = 'deferred', extra = {}) => new Map([['a@example.org', {
    recipient: 'a@example.org', state, source: 'log', statusCode: '4.7.500', diagnostic: '451 busy', eventAt: '2026-10-01T19:00:00.000Z',
    log: { state, at: '2026-10-01T19:00:00.000Z', statusCode: '4.7.500', diagnostic: '451 busy', queueId: '9C3D4E5F6A7', sender: LOGIN, relayHost: 'eop.test.local', ...extra },
    report: null,
  }]]);
  const laterLines = (final) => [
    entry('1790885000', `9C3D4E5F6A7: to=<a@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=9000, delays=8999/0/0.5/0.5, ${final}`),
    entry('1790885000', `9C3D4E5F6A7: from=<${LOGIN}>, size=360, nrcpt=1 (queue active)`, 'postfix/qmgr'),
  ];

  it('is followed by its queue id once the cleanup line has left the log', () => {
    const [outcome] = letterOutcomes(index(laterLines('dsn=2.6.0, status=sent (250 2.6.0 ok)')), '<old@stage.test>', LOGIN, { stored: stored() });
    expect(outcome).toMatchObject({ recipient: 'a@example.org', state: 'sent', at: '2026-10-01T20:03:20.000Z' });
  });

  it('is not followed into a queue id Postfix gave to another letter or another sender', () => {
    const reused = [...laterLines('dsn=2.6.0, status=sent (250 2.6.0 ok)'), entry('1790884990', '9C3D4E5F6A7: message-id=<other@x>', 'postfix/cleanup')];
    expect(letterOutcomes(index(reused), '<old@stage.test>', LOGIN, { stored: stored() })).toEqual([]);
    const other = laterLines('dsn=2.6.0, status=sent (250 2.6.0 ok)').map((e) => ({ ...e, message: e.message.replace(LOGIN, 'boss@stage.test') }));
    expect(letterOutcomes(index(other), '<old@stage.test>', LOGIN, { stored: stored() })).toEqual([]);
  });

  it('turns expired when qmgr gives up, and unknown when an administrator deletes it', () => {
    const expiredLines = [entry('1790885100', `9C3D4E5F6A7: from=<${LOGIN}>, status=expired, returned to sender`, 'postfix/qmgr'), laterLines('dsn=4.7.500, status=deferred (host x said: 451 busy)')[1]];
    expect(letterOutcomes(index(expiredLines), '<old@stage.test>', LOGIN, { stored: stored() })[0]).toMatchObject({ state: 'expired', at: '2026-10-01T20:05:00.000Z' });
    const deleted = [entry('1790885100', '9C3D4E5F6A7: removed', 'postfix/postsuper'), laterLines('x')[1]];
    expect(letterOutcomes(index(deleted), '<old@stage.test>', LOGIN, { stored: stored() })[0])
      .toMatchObject({ state: 'unknown', at: '2026-10-01T19:00:00.000Z', details: { leftQueue: true, queueId: '9C3D4E5F6A7' } });
  });

  it('reads unknown when its queue entry left the queue without a final line', () => {
    expect(leftQueueOutcomes(stored(), new Set(['9C3D4E5F6A7']), new Set())).toEqual([]);
    expect(leftQueueOutcomes(stored(), new Set(), new Set(['a@example.org']))).toEqual([]);
    expect(leftQueueOutcomes(stored(), new Set(), new Set())).toEqual([{
      recipient: 'a@example.org', state: 'unknown', at: '2026-10-01T19:00:00.000Z', statusCode: '4.7.500', diagnostic: '451 busy',
      details: { queueId: '9C3D4E5F6A7', sender: LOGIN, relayHost: 'eop.test.local', leftQueue: true },
    }]);
    // A final line found later still wins: unknown keeps the time of the deferral.
    const { row } = mergeOutcome(stored().get('a@example.org'), { source: 'log', ...leftQueueOutcomes(stored(), new Set(), new Set())[0] });
    expect(mergeOutcome(row, { source: 'log', state: 'sent', at: '2026-10-01T20:00:00.000Z', details: {} }).row.state).toBe('sent');
  });

  it('stops reading as delayed after the queue lifetime with no news', () => {
    const row = { recipient: 'a@b', state: 'deferred', source: 'log', statusCode: '4.7.500', diagnostic: 'x', eventAt: '2026-09-01T00:00:00.000Z', log: {}, report: null };
    expect(presentOutcome(row, { now: Date.parse('2026-09-01T00:00:00Z') + DELAY_STALE_MS + 1 })).toMatchObject({ state: 'unknown', stale: 'deferred', explanation: null });
    expect(presentOutcome(row, { now: Date.parse('2026-09-02T00:00:00Z') })).toMatchObject({ state: 'deferred', stale: null, explanation: { key: 'temporary' } });
  });
});

describe('tlsForDelivery', () => {
  const tlsLine = (time, host = 'eop.test.local[172.22.1.7]:25') => entry(time, `Untrusted TLS connection established to ${host}: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits)`);
  const delivery = (time, extra = {}) => ({ ...entry(time, 'AB12CD34EF5: to=<a@example.org>, relay=eop.test.local[172.22.1.7]:25, delay=0.3, delays=0.1/0/0.1/0.1, dsn=2.6.0, status=sent (250 ok)'), ...extra });
  const tlsOf = (entries) => {
    const { lines } = parsePostfixLog(entries);
    return tlsForDelivery(lines, lines.findIndex((l) => l.queueId));
  };

  it('takes the one TLS line to the same host within the connection time', () => {
    expect(tlsOf([delivery('1000'), tlsLine('999')])).toMatchObject({ matchedBy: 'time' });
    // Older than delays c + d (0.2 s, rounded up) plus a second: a reused connection, not in the log.
    expect(tlsOf([delivery('1000'), tlsLine('997')])).toBeNull();
    expect(tlsOf([delivery('1000'), tlsLine('1000', 'other.example[172.22.1.8]:25')])).toBeNull();
  });

  it('attributes nothing when two connections to that host fall in the window', () => {
    expect(tlsOf([delivery('1000'), tlsLine('1000'), tlsLine('999')])).toBeNull();
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
  const dsn = (state, at, code = '5.7.64') => ({ source: 'dsn', state, at, statusCode: code, diagnostic: 'TenantAttribution', details: { action: state } });

  it('lets a report of failure win over the log\'s sent, whatever the clocks say, keeping both', () => {
    const first = mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z')).row;
    const { row, changed } = mergeOutcome(first, dsn('failed', '2026-10-02T09:55:00.000Z'));
    expect(changed).toBe(true);
    expect(row).toMatchObject({ state: 'failed', source: 'dsn', statusCode: '5.7.64', eventAt: '2026-10-02T09:55:00.000Z' });
    expect(row.log).toMatchObject({ state: 'sent', relayHost: 'eop.test.local' });
    // The alert job reading the same sent line again changes nothing and never clobbers the report.
    expect(mergeOutcome(row, log('sent', '2026-10-02T10:00:00.000Z'))).toEqual({ row, changed: false });
    // Without a time, a report still wins over sent.
    expect(mergeOutcome(first, dsn('failed', null)).row.state).toBe('failed');
  });

  // The outgoing server refused the recipient at RCPT while it took the letter for the others
  // (sendDelivery.js): the letter never left for them, so that refusal is the row's outcome
  // whatever else arrives, and every source keeps its own details.
  it('keeps a refusal at submission as the outcome, beside the other sources', () => {
    const submission = {
      source: 'submission', state: 'failed', at: '2026-10-02T10:00:00.000Z', statusCode: '5.1.1',
      diagnostic: '550 5.1.1 User unknown', details: { reply: '550 5.1.1 User unknown', responseCode: 550 },
    };
    const first = mergeOutcome(null, submission).row;
    expect(first).toMatchObject({ state: 'failed', source: 'submission', statusCode: '5.1.1', diagnostic: '550 5.1.1 User unknown' });
    expect(first.submission).toMatchObject({ reply: '550 5.1.1 User unknown', responseCode: 550 });
    expect(mergeOutcome(first, submission)).toEqual({ row: first, changed: false });
    const withLog = mergeOutcome(first, log('sent', '2026-10-02T10:10:00.000Z')).row;
    expect(withLog).toMatchObject({ state: 'failed', source: 'submission' });
    expect(withLog.log).toMatchObject({ state: 'sent' });
    const withReport = mergeOutcome(withLog, dsn('delayed', '2026-10-02T11:00:00.000Z')).row;
    expect(withReport).toMatchObject({ state: 'failed', source: 'submission' });
    expect(withReport.report).toMatchObject({ state: 'delayed' });
    // A row of only the other sources carries no submission field at all.
    expect(mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z')).row).not.toHaveProperty('submission');
  });

  it('moves deferred to sent, ignores an older line, and keeps the node\'s bounce over a report\'s delay', () => {
    const deferred = mergeOutcome(null, log('deferred', '2026-10-02T10:00:00.000Z')).row;
    const sent = mergeOutcome(deferred, log('sent', '2026-10-02T10:10:00.000Z')).row;
    expect(sent.state).toBe('sent');
    expect(mergeOutcome(sent, log('deferred', '2026-10-02T10:00:00.000Z')).changed).toBe(false);
    const bounced = mergeOutcome(null, log('bounced', '2026-10-02T10:00:00.000Z')).row;
    expect(mergeOutcome(bounced, dsn('delayed', '2026-10-02T11:00:00.000Z', '4.4.7')).row).toMatchObject({ state: 'bounced', source: 'log' });
  });

  it('takes a later report over an earlier one and one without a time over any, but not a clearly older delay over sent', () => {
    const first = mergeOutcome(null, dsn('delayed', '2026-10-02T10:00:00.000Z', '4.4.7')).row;
    expect(mergeOutcome(first, dsn('delayed', '2026-10-02T09:00:00.000Z', '4.4.1')).changed).toBe(false);
    expect(mergeOutcome(first, dsn('failed', null)).row.state).toBe('failed');
    const sent = mergeOutcome(first, log('sent', '2026-10-02T11:00:00.000Z')).row;
    expect(sent).toMatchObject({ state: 'sent', source: 'log' });
    // A delay reported within the clock skew of the log line is the later word.
    const skew = mergeOutcome(mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z')).row, dsn('delayed', '2026-10-02T09:59:00.000Z', '4.4.7')).row;
    expect(skew).toMatchObject({ state: 'delayed', source: 'dsn' });
  });

  it('keeps the TLS and acceptance of a line read again without them', () => {
    const tls = { level: 'untrusted', protocol: 'TLSv1.3', cipher: 'x', matchedBy: 'time' };
    const { row } = mergeOutcome(null, log('sent', '2026-10-02T10:00:00.000Z', { tls, acceptance: { internalId: '1' } }));
    expect(mergeOutcome(row, log('sent', '2026-10-02T10:00:00.000Z', { tls: null, acceptance: null })).changed).toBe(false);
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
