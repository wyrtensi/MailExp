import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// In-memory stand-in for the Redis commands the state store uses.
const store = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => {
      store.set(key, { value, opts });
      return 'OK';
    }),
    getDel: vi.fn(async (key) => {
      const entry = store.get(key);
      store.delete(key);
      return entry ? entry.value : null;
    }),
  },
}));

const { redisClient } = await import('../redis.js');
const { createOAuthState, consumeOAuthState, OAUTH_STATE_TTL_SECONDS } = await import('./oauthState.js');

const base64url = (buf) => buf.toString('base64url');

beforeEach(() => {
  store.clear();
  redisClient.set.mockClear();
  redisClient.getDel.mockClear();
});

describe('OAuth state + PKCE store', () => {
  it('creates a random state and an S256 challenge, keeping the verifier server-side with a 600 s TTL', async () => {
    const a = await createOAuthState({ provider: 'google', userId: 'u1', loginHint: 'x@gmail.com' });
    const b = await createOAuthState({ provider: 'google', userId: 'u1' });

    expect(OAUTH_STATE_TTL_SECONDS).toBe(600);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a.state).not.toBe(b.state);
    expect(Object.keys(a).sort()).toEqual(['codeChallenge', 'state']);

    const [key, raw, opts] = redisClient.set.mock.calls[0];
    // The raw state is not used as the Redis key.
    expect(key).not.toContain(a.state);
    expect(opts).toEqual({ NX: true, EX: 600 });
    const saved = JSON.parse(raw);
    expect(saved).toEqual({
      userId: 'u1', codeVerifier: expect.any(String), loginHint: 'x@gmail.com', appId: null,
      mode: null, email: null, accountId: null, senderName: null, senderNameAlt: null, reservation: null,
    });
    expect(saved.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(a.codeChallenge).toBe(base64url(createHash('sha256').update(saved.codeVerifier).digest()));
    expect(a.codeChallenge).not.toBe(saved.codeVerifier);
  });

  it('consumes a state exactly once', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    const first = await consumeOAuthState({ provider: 'google', state });
    expect(first).toEqual({
      userId: 'u1', codeVerifier: expect.any(String), loginHint: null, appId: null,
      mode: null, email: null, accountId: null, senderName: null, senderNameAlt: null, reservation: null,
    });
    expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
    expect(redisClient.getDel).toHaveBeenCalledTimes(2);
  });

  it('carries the chosen Google app through the flow', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1', appId: 'app-1' });
    expect(await consumeOAuthState({ provider: 'google', state })).toMatchObject({ appId: 'app-1' });
  });

  it('does not accept a state issued for another provider', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    expect(await consumeOAuthState({ provider: 'microsoft', state })).toBeNull();
  });

  it.each([undefined, '', 'short', 'x'.repeat(500), ['arr'], 'bad chars!!'.repeat(5)])(
    'rejects malformed state %j without touching Redis', async (state) => {
      expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
      expect(redisClient.getDel).not.toHaveBeenCalled();
    },
  );

  it('treats unparsable stored data as an unknown state', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    const [key] = redisClient.set.mock.calls[0];
    store.set(key, { value: 'not-json' });
    expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
  });

  it('keeps a sign-in state without a user only for an anonymous consumer', async () => {
    const first = await createOAuthState({ provider: 'auth-google' });
    expect(await consumeOAuthState({ provider: 'auth-google', state: first.state })).toBeNull();

    const second = await createOAuthState({ provider: 'auth-google' });
    expect(await consumeOAuthState({ provider: 'auth-google', state: second.state, anonymous: true }))
      .toEqual({
        userId: null, codeVerifier: expect.any(String), loginHint: null, appId: null,
        mode: null, email: null, accountId: null, senderName: null, senderNameAlt: null, reservation: null,
      });
  });

  it('carries the flow mode, the expected email and the reconnect target', async () => {
    const { state } = await createOAuthState({
      provider: 'google', userId: 'u1', appId: 'app-1', mode: 'reconnect', email: 'x@gmail.com', accountId: 'acc-1',
    });
    await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({
      mode: 'reconnect', email: 'x@gmail.com', accountId: 'acc-1', appId: 'app-1',
    });
  });

  it('carries the sender names of a mailbox added from the Gmail form', async () => {
    const { state } = await createOAuthState({
      provider: 'google', userId: 'u1', mode: 'add', email: 'x@gmail.com', senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov',
    });
    await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({
      senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov',
    });
  });

  it('carries the seat reservation of the flow', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1', mode: 'add', email: 'x@gmail.com', reservation: 'res-1' });
    await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({ reservation: 'res-1' });
  });

  it('reports no mode, email or target for a flow started without them', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    await expect(consumeOAuthState({ provider: 'google', state })).resolves.toMatchObject({
      mode: null, email: null, accountId: null, senderName: null, senderNameAlt: null, reservation: null,
    });
  });
});
