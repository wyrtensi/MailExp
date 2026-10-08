import { describe, expect, it, vi } from 'vitest';

// `user create --admin` is two actions: the approval, then the admin flag. What the approval asks of
// the backend (the Access sync) is queued even when the second step is refused.

vi.mock('../../services/admin/users.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createUser: vi.fn(async () => ({
    user: { id: 'u1', email: 'new@example.com', isAdmin: false }, created: true, effects: { accessSync: 'user_added' },
  })),
  updateUser: vi.fn(async () => ({ error: 'bootstrap_admin' })),
}));
vi.mock('../../services/admin/adminEffects.js', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueAdminEffects: vi.fn(async () => ({ id: '7', kind: 'admin_effects', status: 'queued' })),
}));

const { enqueueAdminEffects } = await import('../../services/admin/adminEffects.js');
const { default: user } = await import('./user.js');

const create = user.commands.find((c) => c.name === 'create');

describe('user create --admin', () => {
  it('queues the approval\'s effects when making the user an admin is refused', async () => {
    const ctx = { args: { email: 'new@example.com' }, flags: { admin: true }, actor: { userId: null, via: 'cli' } };
    await expect(create.run(ctx)).rejects.toMatchObject({ code: 'bootstrap_admin' });
    expect(enqueueAdminEffects).toHaveBeenCalledWith({ accessSync: 'user_added' }, ctx.actor);
  });
});
