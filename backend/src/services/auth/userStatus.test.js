import { describe, expect, it, vi } from 'vitest';
import { countsAsActiveAdmin, disableUsersByEmail } from './userStatus.js';

// Transaction client over an in-memory users table that records the SQL it sees.
function fakeClient(users) {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params = []) => {
      calls.push(sql);
      if (/pg_advisory_xact_lock\(hashtext\('users-admin-guard'\)\)/.test(sql)) return { rows: [] };
      if (/FROM users WHERE lower\(email\) = \$1 AND disabled_at IS NULL FOR UPDATE/.test(sql)) {
        return { rows: users.filter((u) => u.email === params[0] && !u.disabled_at) };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM users/.test(sql)) {
        const count = users.filter((u) => u.is_admin && !u.disabled_at && u.id !== params[0]
          && (!/email IS NOT NULL/.test(sql) || u.email)).length;
        return { rows: [{ count }] };
      }
      if (/UPDATE users SET disabled_at = NOW\(\), disabled_by = NULL, disabled_source = 'cloudflare_access' WHERE id = \$1/.test(sql)) {
        const user = users.find((u) => u.id === params[0]);
        user.disabled_at = new Date();
        return { rows: [{ id: user.id, email: user.email, is_admin: user.is_admin }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return client;
}

const user = (id, email, isAdmin = false) => ({ id, email, is_admin: isAdmin, disabled_at: null });
const options = (bootstrap = []) => ({ googleMode: true, bootstrapAdminEmails: new Set(bootstrap) });

describe('countsAsActiveAdmin', () => {
  it('needs an email only in google mode', () => {
    const noEmail = { is_admin: true, disabled_at: null, email: null };
    expect(countsAsActiveAdmin(noEmail, false)).toBe(true);
    expect(countsAsActiveAdmin(noEmail, true)).toBe(false);
    expect(countsAsActiveAdmin({ ...noEmail, email: 'a@example.com', disabled_at: new Date() }, true)).toBe(false);
  });
});

describe('disableUsersByEmail', () => {
  it('takes the admin guard lock first and disables active users', async () => {
    const users = [user('1', 'a@example.com'), user('2', 'b@example.com'), user('3', 'admin@example.com', true)];
    const client = fakeClient(users);
    const result = await disableUsersByEmail(client, ['a@example.com', 'b@example.com'], options());
    expect(client.calls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(result).toEqual({
      disabled: [{ id: '1', email: 'a@example.com', is_admin: false }, { id: '2', email: 'b@example.com', is_admin: false }],
      keptLastAdmin: [],
    });
    expect(users.map((u) => !!u.disabled_at)).toEqual([true, true, false]);
    // Disabling a user must never touch the mailboxes they added.
    expect(client.calls.every((sql) => !/email_accounts/.test(sql))).toBe(true);
  });

  it('never touches a bootstrap admin and skips unknown or already disabled users', async () => {
    const users = [user('1', 'boot@example.com', true), { ...user('2', 'off@example.com'), disabled_at: new Date() }];
    const client = fakeClient(users);
    const result = await disableUsersByEmail(client, ['boot@example.com', 'off@example.com', 'nobody@example.com'], options(['boot@example.com']));
    expect(result).toEqual({ disabled: [], keptLastAdmin: [] });
    expect(client.query.mock.calls.some(([, params]) => params?.[0] === 'boot@example.com')).toBe(false);
  });

  it('keeps the last active admin and disables an admin when another one remains', async () => {
    const lone = [user('1', 'admin@example.com', true)];
    expect(await disableUsersByEmail(fakeClient(lone), ['admin@example.com'], options()))
      .toEqual({ disabled: [], keptLastAdmin: ['admin@example.com'] });
    expect(lone[0].disabled_at).toBeNull();

    const pair = [user('1', 'one@example.com', true), user('2', 'two@example.com', true)];
    const result = await disableUsersByEmail(fakeClient(pair), ['one@example.com', 'two@example.com'], options());
    expect(result).toEqual({ disabled: [{ id: '1', email: 'one@example.com', is_admin: true }], keptLastAdmin: ['two@example.com'] });
  });
});
