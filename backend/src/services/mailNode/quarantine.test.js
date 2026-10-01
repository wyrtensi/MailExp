import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./mailcow.js', async (importActual) => ({ ...(await importActual()), getRspamdHistory: vi.fn() }));

import { query } from '../db.js';
import { getRspamdHistory } from './mailcow.js';
import {
  HISTORY_ROWS,
  clearRspamdHistoryCache,
  decodeStoredLetter,
  findHistoryEntry,
  getQuarantineSettingsAppliedAt,
  getQuarantineUserView,
  historyForQuarantine,
  markQuarantineSettingsApplied,
  parseQuarantineLetter,
  readRspamdHistory,
  setQuarantineUserView,
  spamRowsFor,
  topSymbols,
  withDeadline,
} from './quarantine.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'k' };

beforeEach(() => {
  query.mockReset();
  getRspamdHistory.mockReset();
  clearRspamdHistoryCache();
});

describe('a quarantined letter', () => {
  it('undoes the HTML entities mailcow wrote for non-ASCII characters only', () => {
    expect(decodeStoredLetter('Subject: &#1055;&#1088;&#1080;&#1074;&#1077;&#1090; &#128512;\r\n\r\n&#60;b&#62; &#38;amp; &#55357;')).toBe(
      `Subject: Привет ${String.fromCodePoint(0x1F600)}\r\n\r\n&#60;b&#62; &#38;amp; &#55357;`,
    );
  });

  const MULTIPART = [
    'From: =?UTF-8?B?0J/QtdGC0Y8=?= <petya@sender.test>',
    'To: info@example.com',
    'Subject: =?UTF-8?Q?=D0=A1=D1=87=D1=91=D1=82?= ready',
    'Date: Wed, 01 Oct 2026 10:00:00 +0000',
    'Message-ID: <abc@sender.test>',
    'X-Forefront-Antispam-Report: CIP:198.51.100.7;CTRY:;LANG:en;SCL:5;SRV:;',
    ' IPV:NLI;SFV:SPM;CAT:PHSH;SFS:;DIR:INB;',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    'preamble',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82 click https://evil.test/login',
    '--inner',
    'Content-Type: text/html; charset=windows-1251',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from([0x3c, 0x70, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64'),
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename*=utf-8\'\'%D1%81%D1%87%D1%91%D1%82.pdf',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'Subject: inner',
    '',
    'hi',
    '--outer--',
    '',
  ].join('\r\n');

  it('reads headers, EOP verdict, the text parts and the attachments by name only', () => {
    const letter = parseQuarantineLetter(MULTIPART);
    expect(letter).toMatchObject({
      from: 'Петя <petya@sender.test>',
      to: 'info@example.com',
      subject: 'Счёт ready',
      date: 'Wed, 01 Oct 2026 10:00:00 +0000',
      messageId: '<abc@sender.test>',
      eop: { verdict: 'SPM', category: 'PHSH' },
      text: 'Привет click https://evil.test/login',
      html: '<p>Привет</p>',
      truncated: false,
    });
    expect(letter.attachments).toEqual([
      { filename: 'счёт.pdf', type: 'application/pdf', size: 9 },
      { filename: 'message.eml', type: 'message/rfc822', size: 20 },
    ]);
    expect(letter.headers[0]).toEqual({ name: 'From', value: 'Петя <petya@sender.test>' });
    expect(letter.headers.find((h) => h.name === 'X-Forefront-Antispam-Report').value).toContain('SFV:SPM');
  });

  it('reads a plain letter with LF line ends and 8-bit text as mailcow stored it', () => {
    const letter = parseQuarantineLetter('Subject: x\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\nXJS &#1044;&#1072;\n');
    expect(letter).toMatchObject({ subject: 'x', text: 'XJS Да\n', html: null, attachments: [], eop: null });
  });

  it('stays bounded on a deep or broken letter', () => {
    let nested = 'Content-Type: text/plain\r\n\r\ndeep';
    for (let i = 0; i < 20; i += 1) nested = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
    expect(parseQuarantineLetter(nested)).toMatchObject({ text: null, html: null, attachments: [] });
    expect(parseQuarantineLetter('')).toMatchObject({ headers: [], text: '', attachments: [] });
    expect(parseQuarantineLetter('no header at all')).toMatchObject({ headers: [], attachments: [] });
  });

  it('keeps the letter\'s own entities in quoted-printable and base64 parts', () => {
    const own = '&#8212; &#8364; &#169; &#1055;&#1088;&#1080;';
    const letter = parseQuarantineLetter([
      'Subject: =?UTF-8?Q?=D0=A1=D1=87=D1=91=D1=82?= &#8212; ok',
      'Content-Type: multipart/alternative; boundary="x"',
      '',
      '--x',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      `<p>${own} =C3=A9t=C3=A9 =E2=80=94</p>`,
      '--x',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`${own} plain`, 'utf8').toString('base64'),
      '--x--',
    ].join('\r\n'));
    expect(letter.html).toBe(`<p>${own} été —</p>`);
    expect(letter.text).toBe(`${own} plain`);
    // mailcow's conversion is undone in headers: they are text.
    expect(letter.subject).toBe('Счёт — ok');
  });

  it('bounds the headers: first Subject, capped values, at most 150 shown', () => {
    const lines = ['Subject: first', 'Subject: second', `To: ${'a'.repeat(9000)}@x.test`];
    for (let i = 0; i < 400; i += 1) lines.push(`X-Filler-${i}: ${i}`);
    const letter = parseQuarantineLetter(`${lines.join('\r\n')}\r\n\r\nbody`);
    expect(letter.subject).toBe('first');
    expect(letter.to).toHaveLength(4000);
    expect(letter.headers).toHaveLength(150);
    expect(letter.headersTruncated).toBe(true);
    expect(letter.headers[2].value).toHaveLength(4000);
    expect(letter.text).toBe('body');
    const huge = parseQuarantineLetter(`${'X-A: b\r\n'.repeat(100000)}\r\nbody`);
    expect(huge.headers).toHaveLength(150);
  });

  it('reads a boundary with a semicolon in quotes', () => {
    const letter = parseQuarantineLetter([
      'Content-Type: multipart/mixed; boundary="a;b"; charset=x',
      '',
      '--a;b',
      'Content-Type: text/plain',
      '',
      'inside',
      '--a;b--',
    ].join('\r\n'));
    expect(letter.text).toBe('inside');
  });
});

describe('the deadline and the settings record', () => {
  it('answers null when the history is late, and the value when it is not', async () => {
    expect(await withDeadline(new Promise(() => {}), 10)).toBeNull();
    expect(await withDeadline(Promise.resolve([1]), 1000)).toEqual([1]);
  });

  it('keeps when the panel wrote mailcow\'s quarantine settings', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: {} }] });
    expect(await getQuarantineSettingsAppliedAt()).toBeNull();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await markQuarantineSettingsApplied('2026-10-02T10:00:00.000Z')).toBe('2026-10-02T10:00:00.000Z');
    expect(query.mock.calls[1][1]).toEqual(['mail_node', { quarantineSettingsAppliedAt: '2026-10-02T10:00:00.000Z' }]);
    query.mockResolvedValueOnce({ rows: [{ config: { quarantineSettingsAppliedAt: '2026-10-02T10:00:00.000Z' } }] });
    expect(await getQuarantineSettingsAppliedAt()).toBe('2026-10-02T10:00:00.000Z');
  });
});

const row = (fields) => ({
  messageId: null, time: '2026-10-01T10:00:00.000Z', score: 1, requiredScore: 15, action: 'no action', skipped: false,
  symbols: [], ip: null, senderSmtp: '', senderMime: '', rcptSmtp: [], rcptMime: [], subject: '', ...fields,
});

describe('finding a letter in the history', () => {
  const rows = [
    row({ messageId: 'abc@sender.test', rcptSmtp: ['other@example.com'], time: '2026-10-01T10:00:05.000Z', score: 2 }),
    row({ messageId: 'abc@sender.test', rcptSmtp: ['info@example.com'], time: '2026-10-01T10:00:01.000Z', score: 9 }),
    row({ messageId: 'xyz@sender.test', rcptSmtp: ['info@example.com'], time: '2026-10-01T09:00:00.000Z', subject: 'Hello', score: 3 }),
  ];

  it('goes by Message-ID with or without brackets, the mailbox first', () => {
    expect(findHistoryEntry(rows, { messageId: '<ABC@sender.test>', recipients: ['info@example.com'] })).toEqual({ row: rows[1], matchedBy: 'message_id' });
    expect(findHistoryEntry(rows, { messageId: '<nope@sender.test>', recipients: ['info@example.com'], date: '2026-10-01T09:00:00Z', subject: 'Hello' })).toBeNull();
  });

  it('takes a row for another recipient only on a node domain, and says so', () => {
    // alias@example.com: example.com is the mailbox's own domain, so other@example.com counts.
    expect(findHistoryEntry(rows, { messageId: 'abc@sender.test', recipients: ['alias@example.com'], date: '2026-10-01T10:00:06Z' }))
      .toEqual({ row: rows[0], matchedBy: 'message_id_other_rcpt' });
    const outside = [row({ messageId: 'abc@sender.test', rcptSmtp: ['someone@elsewhere.test'] })];
    expect(findHistoryEntry(outside, { messageId: 'abc@sender.test', recipients: ['box@node.test'] })).toBeNull();
    expect(findHistoryEntry(outside, { messageId: 'abc@sender.test', recipients: ['box@node.test'], nodeDomains: ['elsewhere.test'] }))
      .toEqual({ row: outside[0], matchedBy: 'message_id_other_rcpt' });
  });

  it('without a Message-ID needs the mailbox, the subject and a close time', () => {
    const at = new Date('2026-10-01T09:10:00Z');
    expect(findHistoryEntry(rows, { messageId: null, recipients: ['info@example.com'], date: at, subject: 'Hello' }))
      .toEqual({ row: rows[2], matchedBy: 'recipient_time' });
    expect(findHistoryEntry(rows, { messageId: null, recipients: ['info@example.com'], date: at, subject: 'Other' })).toBeNull();
    expect(findHistoryEntry(rows, { messageId: null, recipients: ['info@example.com'], date: '2026-10-01T12:00:00Z', subject: 'Hello' })).toBeNull();
    expect(findHistoryEntry(rows, { messageId: null, recipients: [], date: at, subject: 'Hello' })).toBeNull();
  });

  it('without a Message-ID or a subject needs a tight time', () => {
    const blank = [row({ rcptSmtp: ['info@example.com'], time: '2026-10-01T10:00:00.000Z', subject: '' })];
    const ask = (date) => findHistoryEntry(blank, { messageId: null, recipients: ['info@example.com'], date, subject: '' });
    expect(ask('2026-10-01T10:01:30Z')).toEqual({ row: blank[0], matchedBy: 'recipient_time' });
    expect(ask('2026-10-01T10:10:00Z')).toBeNull();
    expect(findHistoryEntry(rows, { messageId: null, recipients: ['info@example.com'], date: '2026-10-01T09:00:30Z', subject: '' })).toBeNull();
  });

  it('counts the letters refused or marked as spam for the panel\'s mailboxes', () => {
    const history = [
      row({ action: 'reject', rcptSmtp: ['info@example.com'] }),
      row({ action: 'add header', rcptMime: ['info@example.com'] }),
      row({ action: 'no action', rcptSmtp: ['info@example.com'] }),
      row({ action: 'reject', rcptSmtp: ['manual@example.com'] }),
    ];
    expect(spamRowsFor(history, new Map([['info@example.com', 'a1']]))).toBe(2);
    expect(spamRowsFor([], new Map([['info@example.com', 'a1']]))).toBe(0);
  });

  it('matches a quarantine entry by recipient, score and time', () => {
    const item = { rcpt: 'info@example.com', score: 9, created: '2026-10-01T10:00:02.000Z', subject: '' };
    expect(historyForQuarantine(item, rows)).toBe(rows[1]);
    expect(historyForQuarantine({ ...item, score: 9.5 }, rows)).toBeNull();
    expect(historyForQuarantine({ ...item, created: '2026-10-01T10:05:00.000Z' }, rows)).toBeNull();
    expect(historyForQuarantine({ ...item, created: null }, rows)).toBeNull();
  });

  it('keeps the heaviest positive symbols', () => {
    const symbols = [{ name: 'A', score: 8 }, { name: 'B', score: 5 }, { name: 'C', score: 1 }, { name: 'D', score: 0.5 }, { name: 'E', score: -1 }];
    expect(topSymbols(symbols)).toEqual([{ name: 'A', score: 8 }, { name: 'B', score: 5 }, { name: 'C', score: 1 }]);
  });
});

describe('reading the history', () => {
  it('reads once a minute per node and shares a read in flight', async () => {
    let resolve;
    getRspamdHistory.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const a = readRspamdHistory(CFG);
    const b = readRspamdHistory(CFG);
    resolve([row({})]);
    expect(await a).toHaveLength(1);
    expect(await b).toHaveLength(1);
    expect(getRspamdHistory).toHaveBeenCalledTimes(1);
    expect(getRspamdHistory).toHaveBeenCalledWith(CFG, HISTORY_ROWS);
    await readRspamdHistory(CFG);
    expect(getRspamdHistory).toHaveBeenCalledTimes(1);
    getRspamdHistory.mockResolvedValue([]);
    await readRspamdHistory(CFG, { now: Date.now() + 61 * 1000 });
    expect(getRspamdHistory).toHaveBeenCalledTimes(2);
    await readRspamdHistory({ ...CFG, mailHost: 'mail2.example.com' });
    expect(getRspamdHistory).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed read', async () => {
    getRspamdHistory.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'mail_node_unreachable' }));
    await expect(readRspamdHistory(CFG)).rejects.toMatchObject({ code: 'mail_node_unreachable' });
    getRspamdHistory.mockResolvedValueOnce([]);
    expect(await readRspamdHistory(CFG)).toEqual([]);
  });
});

describe('the users setting', () => {
  it('is off unless saved on, and merges into the node settings', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getQuarantineUserView()).toBe(false);
    query.mockResolvedValueOnce({ rows: [{ config: { mailHost: 'm', quarantineUserView: true } }] });
    expect(await getQuarantineUserView()).toBe(true);
    query.mockResolvedValueOnce({ rows: [] });
    await setQuarantineUserView(true);
    expect(query.mock.calls[2][0]).toContain('integration_config.config || EXCLUDED.config');
    expect(query.mock.calls[2][1]).toEqual(['mail_node', { quarantineUserView: true }]);
  });
});
