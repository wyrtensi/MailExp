import { describe, expect, it, vi } from 'vitest';

// readSeats (EOP seats, review finding 4): only a well-formed GET /subscribedSkus answer is a read.
vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
const { readSeats } = await import('./tenantJobs.js');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const PREVIOUS = { at: '2026-10-07T12:00:00.000Z', ok: true, found: true, purchased: 12, warning: 0, skus: [] };
const sessionAnswering = (answer) => ({ graph: { request: vi.fn(async () => answer) } });

describe('readSeats', () => {
  it.each([
    ['null', null],
    ['an object without value', { '@odata.context': 'x' }],
    ['a value that is not an array', { value: { skuPartNumber: 'EOP_ENTERPRISE' } }],
  ])('keeps the last good count and records a failed read for %s', async (_label, answer) => {
    const read = await readSeats(sessionAnswering(answer), PREVIOUS, NOW);
    expect(read).toMatchObject({
      ok: false, at: PREVIOUS.at, purchased: 12, found: true, errorAt: new Date(NOW).toISOString(),
      error: { code: 'graph_failed', message: expect.stringMatching(/subscribedSkus/) },
    });
  });

  it('marks a malformed first answer as never read, so the alert counts from it', async () => {
    const read = await readSeats(sessionAnswering(null), null, NOW);
    expect(read).toMatchObject({ ok: false, firstErrorAt: new Date(NOW).toISOString() });
    expect(read.purchased).toBeUndefined();
  });

  it('takes a valid empty value array as the subscription being absent', async () => {
    const read = await readSeats(sessionAnswering({ value: [] }), PREVIOUS, NOW);
    expect(read).toEqual({ at: new Date(NOW).toISOString(), ok: true, found: false, purchased: 0, warning: 0, skus: [] });
  });
});
