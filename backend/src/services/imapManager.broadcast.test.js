import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), pool: {} }));

const { ImapManager } = await import('./imapManager.js');

// Mailbox events without a userId go to every signed-in user (shared mailboxes), so the
// only thing between them and a socket is whether that socket has authenticated.
describe('broadcast', () => {
  function arrange() {
    const socket = (userId, readyState = 1) => ({ userId, readyState, send: vi.fn() });
    const sockets = {
      mine: socket('u1'),
      someoneElse: socket('u2'),
      // Still in its session lookup, or refused and not yet closed: no userId.
      authenticating: socket(undefined),
      closing: socket('u1', 3),
    };
    const ctx = { wss: { clients: new Set(Object.values(sockets)) }, scheduleCountRefresh: vi.fn() };
    return { sockets, ctx };
  }

  it('sends an event for everyone to authenticated open sockets only', () => {
    const { sockets, ctx } = arrange();
    ImapManager.prototype.broadcast.call(ctx, { type: 'sync_complete', accountId: 'a1' });
    expect(sockets.mine.send).toHaveBeenCalledOnce();
    expect(sockets.someoneElse.send).toHaveBeenCalledOnce();
    expect(sockets.authenticating.send).not.toHaveBeenCalled();
    expect(sockets.closing.send).not.toHaveBeenCalled();
  });

  it('sends a user event to that user only', () => {
    const { sockets, ctx } = arrange();
    ImapManager.prototype.broadcast.call(ctx, { type: 'sync_complete', accountId: 'a1' }, 'u1');
    expect(sockets.mine.send).toHaveBeenCalledOnce();
    expect(sockets.someoneElse.send).not.toHaveBeenCalled();
    expect(sockets.authenticating.send).not.toHaveBeenCalled();
  });
});
