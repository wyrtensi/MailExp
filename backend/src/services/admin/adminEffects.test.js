import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

const { applyAdminEffects, hasEffects, mergeEffects } = await import('./adminEffects.js');

describe('admin effects', () => {
  it('merges effects without repeats, the last Access sync trigger winning', () => {
    expect(mergeEffects(
      { signOut: ['a'], accessSync: 'user_added' },
      null,
      { signOut: ['a', 'b'], reload: ['auth_limits'], accessSync: 'user_changed' },
    )).toEqual({
      signOut: ['a', 'b'], userDeleted: [], accessSync: 'user_changed', reload: ['auth_limits'], reconnect: [], runRules: [], runRulesAll: false,
    });
  });

  it('tells whether there is anything to apply', () => {
    expect(hasEffects(null)).toBe(false);
    expect(hasEffects({ signOut: [], reload: [], accessSync: null })).toBe(false);
    expect(hasEffects({ reload: ['connection_policy'] })).toBe(true);
    expect(hasEffects({ reconnect: ['m'] })).toBe(true);
    expect(hasEffects({ runRules: ['m'] })).toBe(true);
  });

  it('signs out first, then reloads, cleans up and asks for the Access sync', async () => {
    const order = [];
    const hooks = {
      signOutUser: async (id) => { order.push(`signOut:${id}`); },
      onUserDelete: async (id) => { order.push(`deleted:${id}`); },
      requestAccessSync: (trigger) => { order.push(`sync:${trigger}`); },
      reload: { auth_limits: async () => { order.push('auth_limits'); } },
    };
    await applyAdminEffects({ signOut: ['u'], userDeleted: ['u'], reload: ['auth_limits', 'unknown'], accessSync: 'user_deleted' }, hooks);
    expect(order).toEqual(['signOut:u', 'auth_limits', 'deleted:u', 'sync:user_deleted']);
  });

  it('reconnects mailboxes and runs rules last, once per mailbox', async () => {
    const order = [];
    const hooks = {
      requestAccessSync: (trigger) => { order.push(`sync:${trigger}`); },
      reconnectAccount: async (id) => { order.push(`reconnect:${id}`); },
      runRules: async (ids, { allMailboxes, actor }) => { order.push(`rules:${ids.join(',')}:${allMailboxes}:${actor.via}`); },
    };
    const effects = mergeEffects({ reconnect: ['m1'], runRules: ['m1'] }, { reconnect: ['m1', 'm2'], runRules: ['m2'], runRulesAll: true, accessSync: 'x' });
    await applyAdminEffects(effects, hooks, { actor: { userId: null, via: 'cli' } });
    expect(order).toEqual(['sync:x', 'reconnect:m1', 'reconnect:m2', 'rules:m1,m2:true:cli']);
  });
});
