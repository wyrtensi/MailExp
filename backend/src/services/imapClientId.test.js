// The panel does not identify itself in IMAP ID (RFC 2971). imapflow sends ID on every login to a
// server that offers it and by default names itself ("imapflow", its version, "Postal Systems", a
// support URL). makeClientCfg blanks every field, so what goes on the wire is `ID NIL`.
//
// A makeClientCfg assertion alone would prove nothing about the wire, so this builds a REAL
// ImapFlow from our config (the constructor does not connect) and runs imapflow's own ID command
// against a connection that records what it would send.
import { describe, it, expect, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import idCommand from 'imapflow/lib/commands/id.js';
import compile from 'imapflow/lib/handler/imap-compiler.js';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn(), validateHost: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

const { makeClientCfg } = await import('./imapManager.js');

const resolved = { host: '127.0.0.1', servername: null };
const account = { imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };

// What imapflow's ID command would send on a connection that advertises ID.
async function idOnTheWire(clientInfo) {
  const exec = vi.fn(async () => ({ next: () => {} }));
  const connection = { capabilities: new Map([['ID', true]]), exec, log: { warn: () => {} } };
  await idCommand(connection, clientInfo);
  return exec.mock.calls[0];
}

describe('IMAP ID', () => {
  it('sends ID NIL: no client name, version, vendor or URL', async () => {
    for (const enableIdle of [true, false]) {
      const client = new ImapFlow(makeClientCfg(account, resolved, { enableIdle }));
      const [command, attributes] = await idOnTheWire(client.clientInfo);
      expect(command).toBe('ID');
      expect(attributes).toEqual([null]);
      // imapflow's own compiler turns that into the bytes it writes to the socket.
      const [line] = await compile({ tag: 'A1', command, attributes });
      expect(Buffer.from(line).toString()).toBe('A1 ID NIL');
    }
  });

  it('names nothing that identifies the panel or its library', async () => {
    const client = new ImapFlow(makeClientCfg(account, resolved));
    const sent = JSON.stringify(await idOnTheWire(client.clientInfo)).toLowerCase();
    for (const word of ['imapflow', 'postal', 'mailexpert', 'mailflow', 'github']) expect(sent).not.toContain(word);
  });

  it('without the blank clientInfo imapflow would name itself (the default this replaces)', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: 993 });
    const [, attributes] = await idOnTheWire(client.clientInfo);
    expect(attributes[0]).toEqual(expect.arrayContaining(['name', 'imapflow', 'vendor', 'Postal Systems']));
  });
});
