import { describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('./db.js', () => ({ query: queryMock }));

const { correspondentOf, senderHistory } = await import('./senderHistory.js');

const OWN = new Set(['sales@x.example', 'help@x.example']);

describe('correspondentOf', () => {
  it('is the sender of a received letter, lowercased', () => {
    expect(correspondentOf({ from_email: ' Maya@C.example ', to_addresses: [{ email: 'sales@x.example' }] }, OWN)).toBe('maya@c.example');
  });

  it('is the first outside recipient of a letter the mailbox sent, To before Cc', () => {
    expect(correspondentOf({
      from_email: 'HELP@x.example',
      to_addresses: [{ email: 'sales@x.example' }, { name: 'Boss', email: 'Boss@c.example' }],
      cc_addresses: [{ email: 'maya@c.example' }],
    }, OWN)).toBe('boss@c.example');
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: [], cc_addresses: [{ email: 'maya@c.example' }] }, OWN)).toBe('maya@c.example');
  });

  it('reads addresses stored as JSON text or as plain strings', () => {
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: '[{"email":"maya@c.example"}]' }, OWN)).toBe('maya@c.example');
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: ['maya@c.example'] }, OWN)).toBe('maya@c.example');
  });

  it('is null for a note to self or a letter without usable addresses', () => {
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: [{ email: 'help@x.example' }] }, OWN)).toBeNull();
    expect(correspondentOf({ from_email: null, to_addresses: 'not json' }, OWN)).toBeNull();
  });
});

describe('senderHistory folders', () => {
  it('leaves the mailbox trash, spam and drafts out, so an unsent draft never shows as sent', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({ rows: [{
        account_id: 'a1', from_email: 'maya@c.example', to_addresses: [{ email: 'sales@x.example' }], cc_addresses: [],
        date: new Date('2026-09-20T10:00:00Z'), email_address: 'sales@x.example', alias_emails: [],
        folder_mappings: { trash: 'Trash', spam: 'Junk', drafts: 'Drafts', sent: 'Sent' },
      }] }) // found
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // resolveAllSentPaths: mapped 'Sent' is selectable
      .mockResolvedValueOnce({ rows: [] }); // history
    await senderHistory(7);
    expect(queryMock.mock.calls[2][1][5]).toEqual(['Trash', 'Junk', 'Drafts']);
  });
});
