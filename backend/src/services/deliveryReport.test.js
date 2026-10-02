import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ calls: [] }));
vi.mock('./deliveryStatus.js', async (importActual) => ({
  ...(await importActual()),
  recordOutcomes: vi.fn(async (accountId, messageId, source, outcomes) => {
    recorded.calls.push({ accountId, messageId, source, outcomes });
    return outcomes.length;
  }),
}));

import {
  NDR_HEADERS, NDR_STATUS, NDR_STRUCTURE, STAND_DSN_STATUS, STAND_DSN_STRUCTURE,
} from './deliveryReport.fixtures.js';
import {
  deliveryReportOf, messageIdIn, messageIdOfHeaders, parseDeliveryStatus, readDeliveryReports, recordDeliveryReport,
  reportOutcomes,
} from './deliveryReport.js';

const ACCOUNT = '50000000-0000-4000-8000-000000000001';

beforeEach(() => { recorded.calls = []; });

describe('deliveryReportOf', () => {
  it('reads the node\'s report from the structure the sync already has, original id included', () => {
    expect(deliveryReportOf(STAND_DSN_STRUCTURE)).toEqual({
      statusPart: '2', statusEncoding: '7bit', statusCharset: null, headersPart: null, headersEncoding: null,
      returnedMessageId: '<r17-denied-1790933353895@stage.test>',
    });
  });

  it('reads a report with returned headers only, whatever the case of the report type', () => {
    expect(deliveryReportOf(NDR_STRUCTURE)).toMatchObject({ statusPart: '2', statusEncoding: 'base64', headersPart: '3', returnedMessageId: null });
  });

  it('is null for anything that is no delivery report', () => {
    expect(deliveryReportOf(null)).toBeNull();
    expect(deliveryReportOf({ type: 'text/plain' })).toBeNull();
    expect(deliveryReportOf({ type: 'multipart/report', parameters: { 'report-type': 'disposition-notification' }, childNodes: [] })).toBeNull();
    expect(deliveryReportOf({ type: 'multipart/report', parameters: { 'report-type': 'delivery-status' }, childNodes: [{ part: '1', type: 'text/plain' }] })).toBeNull();
    // A forwarded report inside a letter is not a report about the letter's own mailbox.
    expect(deliveryReportOf({ type: 'multipart/mixed', childNodes: [STAND_DSN_STRUCTURE] })).toBeNull();
  });
});

describe('parseDeliveryStatus and reportOutcomes', () => {
  it('reads the node\'s report per recipient, folded diagnostic and vendor fields as they come', () => {
    const parsed = parseDeliveryStatus(STAND_DSN_STATUS);
    expect(parsed.message['reporting-mta']).toBe('dns; mail.test.local');
    expect(parsed.recipients).toEqual([
      { finalRecipient: 'test@example.com', originalRecipient: 'test@example.com', action: 'failed', status: '5.4.1', diagnosticCode: '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)', remoteMta: 'eop.test.local', lastAttemptDate: null },
      { finalRecipient: 'second@example.org', originalRecipient: 'second@example.org', action: 'failed', status: '5.4.1', diagnosticCode: '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)', remoteMta: 'eop.test.local', lastAttemptDate: null },
    ]);
    expect(reportOutcomes(parsed, { at: new Date('2026-10-02T09:29:18Z') })).toEqual([
      { recipient: 'test@example.com', state: 'failed', at: '2026-10-02T09:29:18.000Z', statusCode: '5.4.1', diagnostic: '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)', details: { action: 'failed', remoteMta: 'eop.test.local', reportingMta: 'mail.test.local' } },
      { recipient: 'second@example.org', state: 'failed', at: '2026-10-02T09:29:18.000Z', statusCode: '5.4.1', diagnostic: '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)', details: { action: 'failed', remoteMta: 'eop.test.local', reportingMta: 'mail.test.local' } },
    ]);
  });

  it('marks failed and delayed per recipient, never relayed, delivered or expanded', () => {
    const outcomes = reportOutcomes(parseDeliveryStatus(NDR_STATUS), { at: '2026-10-02T10:01:00Z' });
    expect(outcomes.map((o) => [o.recipient, o.state, o.statusCode, o.at])).toEqual([
      ['boss@partner.example', 'failed', '5.7.64', '2026-10-02T10:00:05.000Z'],
      ['slow@partner.example', 'delayed', '4.4.7', '2026-10-02T10:01:00.000Z'],
    ]);
    const delivered = 'Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822; a@b\nAction: delivered\nStatus: 2.0.0\n\nFinal-Recipient: rfc822; c@d\nAction: expanded\nStatus: 2.0.0\n';
    expect(reportOutcomes(parseDeliveryStatus(delivered))).toEqual([]);
  });

  it('cuts a long diagnostic and ignores blocks without a recipient', () => {
    const long = `Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822; a@b\nAction: failed\nStatus: 5.0.0\nDiagnostic-Code: smtp; ${'x'.repeat(1000)}\n\nX-Note: y\n`;
    const [outcome] = reportOutcomes(parseDeliveryStatus(long));
    expect(outcome.diagnostic.length).toBe(300);
    expect(parseDeliveryStatus(long).recipients).toHaveLength(1);
  });
});

describe('the original letter', () => {
  it('reads ids from In-Reply-To, References and returned headers', () => {
    expect(messageIdIn('<a@b> <c@d>')).toBe('<a@b>');
    expect(messageIdIn('<a@b> <c@d>', { last: true })).toBe('<c@d>');
    expect(messageIdIn('no id')).toBeNull();
    expect(messageIdOfHeaders(NDR_HEADERS)).toBe('<orig-from-headers@stage.test>');
    expect(messageIdOfHeaders('Subject: x\r\n\r\nMessage-ID: <body@x>')).toBeNull();
  });

  it('marks the original named by the returned letter, before In-Reply-To', async () => {
    const report = deliveryReportOf(STAND_DSN_STRUCTURE);
    const result = await recordDeliveryReport({ accountId: ACCOUNT, report, statusText: STAND_DSN_STATUS, inReplyTo: '<other@x>', date: new Date('2026-10-02T09:29:18Z') });
    expect(result).toEqual({ original: '<r17-denied-1790933353895@stage.test>', changed: 2 });
    expect(recorded.calls[0]).toMatchObject({ accountId: ACCOUNT, messageId: '<r17-denied-1790933353895@stage.test>', source: 'dsn' });
  });

  it('falls back to In-Reply-To, then References, then the returned headers', async () => {
    const report = deliveryReportOf(NDR_STRUCTURE);
    expect((await recordDeliveryReport({ accountId: ACCOUNT, report, statusText: NDR_STATUS, inReplyTo: '<irt@stage.test>' })).original).toBe('<irt@stage.test>');
    expect((await recordDeliveryReport({ accountId: ACCOUNT, report, statusText: NDR_STATUS, references: '<a@x> <ref@stage.test>' })).original).toBe('<ref@stage.test>');
    expect((await recordDeliveryReport({ accountId: ACCOUNT, report, statusText: NDR_STATUS, headersText: NDR_HEADERS })).original).toBe('<orig-from-headers@stage.test>');
    expect(await recordDeliveryReport({ accountId: ACCOUNT, report, statusText: NDR_STATUS })).toEqual({ original: null, changed: 0 });
  });
});

describe('readDeliveryReports', () => {
  const client = (parts) => ({
    fetchOne: vi.fn(async (uid, query) => ({ uid: Number(uid), bodyParts: new Map(query.bodyParts.map((p) => [p, parts[p]])) })),
  });

  it('fetches the status part only when the structure names the original', async () => {
    const imap = client({ 2: Buffer.from(STAND_DSN_STATUS) });
    const marked = await readDeliveryReports(imap, ACCOUNT, [{ uid: 7, report: deliveryReportOf(STAND_DSN_STRUCTURE), inReplyTo: null, references: null, date: new Date('2026-10-02T09:29:18Z') }]);
    expect(marked).toBe(1);
    expect(imap.fetchOne).toHaveBeenCalledWith('7', { uid: true, bodyParts: ['2'] }, { uid: true });
    expect(recorded.calls[0].outcomes.map((o) => o.recipient)).toEqual(['test@example.com', 'second@example.org']);
  });

  it('fetches the returned headers when nothing else names the original, and decodes base64', async () => {
    const imap = client({ 2: Buffer.from(Buffer.from(NDR_STATUS).toString('base64')), 3: Buffer.from(NDR_HEADERS) });
    await readDeliveryReports(imap, ACCOUNT, [{ uid: 9, report: deliveryReportOf(NDR_STRUCTURE), inReplyTo: null, references: null, date: null }]);
    expect(imap.fetchOne).toHaveBeenCalledWith('9', { uid: true, bodyParts: ['2', '3'] }, { uid: true });
    expect(recorded.calls[0]).toMatchObject({ messageId: '<orig-from-headers@stage.test>' });
  });

  it('skips a report it cannot read and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const imap = { fetchOne: vi.fn().mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NoConnection' })).mockResolvedValueOnce({ bodyParts: new Map([['2', Buffer.from(STAND_DSN_STATUS)]]) }) };
    const report = deliveryReportOf(STAND_DSN_STRUCTURE);
    expect(await readDeliveryReports(imap, ACCOUNT, [{ uid: 1, report }, { uid: 2, report }])).toBe(1);
    expect(warn).toHaveBeenCalledWith('Delivery report 1 could not be read: NoConnection');
    warn.mockRestore();
  });
});
