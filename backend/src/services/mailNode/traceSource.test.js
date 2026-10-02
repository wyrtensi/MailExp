import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn() }));

const {
  TRACE_MAX_BYTES, TraceSourceError, createFixtureTraceSource, createGraphTraceSource, getTraceSource, graphTime, keepRows,
  normalizeTraceRow, readJsonCapped, resetTraceSourceWarning, setTraceSource, traceRanges,
} = await import('./traceSource.js');
const { TRACE_DETAILS, TRACE_ROWS } = await import('./traceSource.fixtures.js');

const BASE = 'http://eop.test.local:8080/v1.0';
const NOW = Date.parse('2026-10-02T12:00:00Z');
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('normalizeTraceRow and keepRows', () => {
  it('lowers addresses, keeps the time as ISO and drops rows without what the correlation needs', () => {
    expect(normalizeTraceRow(TRACE_ROWS[1])).toMatchObject({ recipientAddress: 'anna@stage.test', receivedDateTime: '2026-10-01T11:00:00.000Z', status: 'failed' });
    expect(normalizeTraceRow({ id: 'x', recipientAddress: 'a@b', receivedDateTime: 'nope' })).toBeNull();
    expect(normalizeTraceRow({ recipientAddress: 'a@b', receivedDateTime: '2026-10-01T00:00:00Z' })).toBeNull();
  });

  it('keeps the rows of the recipient domains and statuses asked', () => {
    const rows = TRACE_ROWS.map(normalizeTraceRow);
    expect(keepRows(rows, { recipientDomains: ['Stage.test'] }).every((r) => r.recipientAddress.endsWith('@stage.test'))).toBe(true);
    expect(keepRows(rows, { recipientDomains: ['stage.test'], statuses: ['pending'] }).map((r) => r.recipientAddress)).toEqual(['boris@stage.test']);
  });
});

describe('traceRanges and graphTime', () => {
  it('cuts to 10-day parts, not before 90 days, not after now; seconds without fractions', () => {
    const day = 24 * 3600000;
    expect(traceRanges(NOW - 25 * day, NOW + day, NOW).map(([a, b]) => (b - a) / day)).toEqual([10, 10, 5]);
    expect(traceRanges(NOW - 200 * day, NOW - 85 * day, NOW)[0][0]).toBeGreaterThan(NOW - 90 * day);
    expect(traceRanges(NOW, NOW, NOW)).toEqual([]);
    expect(graphTime(Date.parse('2026-10-01T10:00:00.789Z'))).toBe('2026-10-01T10:00:00Z');
  });
});

describe('createGraphTraceSource', () => {
  it('asks one ranged list with both bounds, follows nextLink and keeps the node domains', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ value: TRACE_ROWS.slice(0, 4), '@odata.nextLink': `${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=2` }))
      .mockResolvedValueOnce(json({ value: TRACE_ROWS.slice(4) }));
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const result = await source.list({ start: Date.parse('2026-10-01T09:00:00Z'), end: Date.parse('2026-10-01T15:00:00Z'), recipientDomains: ['stage.test'] });
    expect(result).toMatchObject({ requests: 2, complete: true });
    expect(result.rows).toHaveLength(7);
    const first = decodeURIComponent(fetchImpl.mock.calls[0][0]);
    expect(first).toBe(`${BASE}/admin/exchange/tracing/messageTraces?$filter=receivedDateTime ge 2026-10-01T09:00:00Z and receivedDateTime le 2026-10-01T15:00:00Z&$top=5000`);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('sends the token stage 7 provides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ value: [] }));
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl, getToken: async () => 'tok', now: () => NOW });
    await source.list({ start: NOW - 3600000, end: NOW });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('stops at maxRequests and says the list is incomplete', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ value: TRACE_ROWS.slice(0, 1), '@odata.nextLink': `${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=n` }));
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const result = await source.list({ start: NOW - 3600000, end: NOW, maxRequests: 3 });
    expect(result).toMatchObject({ requests: 3, complete: false, cursor: { range: 0, next: `${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=n` } });
  });

  it('goes on from the cursor of an unfinished listing, in the same part of the range', async () => {
    const day = 24 * 3600000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ value: TRACE_ROWS.slice(0, 1), '@odata.nextLink': `${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=p2` }))
      .mockResolvedValueOnce(json({ value: TRACE_ROWS.slice(1, 2) }))
      .mockResolvedValueOnce(json({ value: TRACE_ROWS.slice(2, 3) }));
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const range = { start: NOW - 15 * day, end: NOW };
    const first = await source.list({ ...range, maxRequests: 1 });
    expect(first.cursor).toEqual({ range: 0, next: `${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=p2` });
    const rest = await source.list({ ...range, maxRequests: 5, cursor: first.cursor });
    expect(rest).toMatchObject({ requests: 2, complete: true, cursor: null });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/admin/exchange/tracing/messageTraces?$skiptoken=p2`);
    expect(decodeURIComponent(fetchImpl.mock.calls[2][0])).toContain(`receivedDateTime ge ${graphTime(NOW - 5 * day)}`);
    expect(rest.rows).toHaveLength(2);
  });

  it('refuses an answer larger than the cap', async () => {
    const big = { ok: true, status: 200, headers: { get: () => String(TRACE_MAX_BYTES + 1) }, json: async () => ({ value: [] }) };
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl: vi.fn().mockResolvedValue(big), now: () => NOW });
    await expect(source.list({ start: NOW - 3600000, end: NOW })).rejects.toMatchObject({ code: 'trace_failed' });
    const stream = new Response('x'.repeat(64));
    await expect(readJsonCapped(stream, 10)).rejects.toMatchObject({ code: 'trace_failed' });
    expect(await readJsonCapped(new Response('{"value":[]}'), 100)).toEqual({ value: [] });
  });

  it('refuses a next page on another host and maps HTTP failures to codes', async () => {
    const other = createGraphTraceSource({
      baseUrl: BASE, now: () => NOW,
      fetchImpl: vi.fn().mockResolvedValue(json({ value: [], '@odata.nextLink': 'https://evil.example/next' })),
    });
    await expect(other.list({ start: NOW - 3600000, end: NOW })).rejects.toMatchObject({ code: 'trace_failed' });
    for (const [status, code] of [[429, 'trace_throttled'], [401, 'trace_auth'], [500, 'trace_failed']]) {
      const source = createGraphTraceSource({ baseUrl: BASE, now: () => NOW, fetchImpl: vi.fn().mockResolvedValue(json({}, status)) });
      await expect(source.list({ start: NOW - 3600000, end: NOW })).rejects.toBeInstanceOf(TraceSourceError);
      await expect(source.list({ start: NOW - 3600000, end: NOW })).rejects.toMatchObject({ code });
    }
    const down = createGraphTraceSource({ baseUrl: BASE, now: () => NOW, fetchImpl: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) });
    await expect(down.list({ start: NOW - 3600000, end: NOW })).rejects.toMatchObject({ code: 'trace_unreachable' });
  });

  it('asks the details of one recipient with the address quoted in the function call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ value: TRACE_DETAILS['b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f|anna@stage.test'] }));
    const source = createGraphTraceSource({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const got = await source.details({ id: 'b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f', recipientAddress: "o'neil@stage.test" });
    expect(got.requests).toBe(1);
    expect(got.events.map((e) => e.event)).toEqual(['Receive', 'Defer', 'Fail']);
    expect(decodeURIComponent(fetchImpl.mock.calls[0][0]))
      .toBe(`${BASE}/admin/exchange/tracing/messageTraces/b7c1f4d2-9a6e-4c3b-8f2d-1e0a6c5b4d3f/getDetailsByRecipient(recipientAddress='o''neil@stage.test')`);
  });
});

describe('createFixtureTraceSource and getTraceSource', () => {
  it('serves the rows of the range and the details by id and recipient', async () => {
    const source = createFixtureTraceSource({ rows: TRACE_ROWS, details: TRACE_DETAILS });
    const { rows } = await source.list({ start: Date.parse('2026-10-01T11:00:00Z'), end: Date.parse('2026-10-01T12:00:00Z'), recipientDomains: ['stage.test'] });
    expect(rows.map((r) => r.status)).toEqual(['failed', 'quarantined']);
    expect((await source.details(rows[0])).events).toHaveLength(3);
  });

  it('is null without a trace, the Graph shape for MAIL_NODE_TRACE_URL, the override first', () => {
    expect(getTraceSource({ env: {} })).toBeNull();
    expect(getTraceSource({ env: { MAIL_NODE_TRACE_URL: 'ftp://x' } })).toBeNull();
    const warn = vi.fn();
    resetTraceSourceWarning();
    expect(getTraceSource({ env: { MAIL_NODE_TRACE_URL: BASE }, warn }).kind).toBe('graph');
    expect(getTraceSource({ env: { MAIL_NODE_TRACE_URL: BASE }, warn }).kind).toBe('graph');
    expect(warn).toHaveBeenCalledTimes(1);
    // In production only with the stand's flag.
    resetTraceSourceWarning();
    expect(getTraceSource({ env: { MAIL_NODE_TRACE_URL: BASE, NODE_ENV: 'production' }, warn })).toBeNull();
    expect(warn.mock.calls.at(-1)[0]).toMatch(/ignored/);
    expect(getTraceSource({ env: { MAIL_NODE_TRACE_URL: BASE, NODE_ENV: 'production', MAIL_NODE_TRACE_STAND: '1' }, warn }).kind).toBe('graph');
    const fixture = createFixtureTraceSource();
    setTraceSource(fixture);
    expect(getTraceSource({ env: {} })).toBe(fixture);
    setTraceSource(null);
  });
});
