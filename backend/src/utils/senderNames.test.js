import { describe, expect, it, vi } from 'vitest';
import { SENDER_NAME_MAX, addSecondSenderName, isForeignNodeAliasAddress, parseSenderNames } from './senderNames.js';

describe('parseSenderNames', () => {
  it('trims both names and treats empty ones as none', () => {
    expect(parseSenderNames({ senderName: '  Иван Петров ', senderNameAlt: ' Ivan Petrov ' }))
      .toEqual({ senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });
    expect(parseSenderNames({ senderName: '   ', senderNameAlt: '' })).toEqual({ senderName: null, senderNameAlt: null });
    expect(parseSenderNames(undefined)).toEqual({ senderName: null, senderNameAlt: null });
  });

  it('drops a second name that repeats the first, and caps the length', () => {
    expect(parseSenderNames({ senderName: 'Sales', senderNameAlt: 'sales' })).toEqual({ senderName: 'Sales', senderNameAlt: null });
    expect(parseSenderNames({ senderName: 'x'.repeat(300) }).senderName).toHaveLength(SENDER_NAME_MAX);
  });

  it('refuses a name that would add a header', () => {
    expect(parseSenderNames({ senderName: 'Sales\r\nBcc: a@b.example' }).error).toBeTruthy();
    expect(parseSenderNames({ senderName: 'Sales', senderNameAlt: 'x\ny' }).error).toBeTruthy();
  });
});

describe('addSecondSenderName', () => {
  it('adds the second name as an alias with the mailbox address, or nothing without one', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'al-1', name: 'Ivan Petrov', email: 'sales@example.com' }] })) };
    expect(await addSecondSenderName(client, { accountId: 'acc-1', email: 'sales@example.com', senderNameAlt: 'Ivan Petrov' }))
      .toEqual({ id: 'al-1', name: 'Ivan Petrov', email: 'sales@example.com' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO account_aliases'), ['acc-1', 'Ivan Petrov', 'sales@example.com']);
    client.query.mockClear();
    expect(await addSecondSenderName(client, { accountId: 'acc-1', email: 'sales@example.com', senderNameAlt: null })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('isForeignNodeAliasAddress', () => {
  const node = { email_address: 'Sales@Example.com', mail_node: true };

  it('is false for the mailbox address in any case and spacing', () => {
    expect(isForeignNodeAliasAddress(node, ' sales@example.COM ')).toBe(false);
  });

  it('is true for another address of a mail node mailbox', () => {
    expect(isForeignNodeAliasAddress(node, 'sales1@example.com')).toBe(true);
    expect(isForeignNodeAliasAddress(node, '')).toBe(true);
  });

  it('is false for a mailbox that is not on the mail node', () => {
    expect(isForeignNodeAliasAddress({ ...node, mail_node: false }, 'other@example.org')).toBe(false);
    expect(isForeignNodeAliasAddress({ ...node, mail_node: null }, 'other@example.org')).toBe(false);
    expect(isForeignNodeAliasAddress(null, 'other@example.org')).toBe(false);
  });
});
