// How many IMAP connections does one account open when the pool is stalled, and who gets a
// connection when one frees up?
//
// Upstream #474 (maathimself/mailflow@c9bcd738, @33363c11): body FETCHes time out, and afterwards
// every other IMAP operation starts failing with "Command failed", on Gmail as well as Yahoo.
//
// The mechanism was in acquirePooledClient. The pool holds poolSizeFor(account) connections, and
// a caller that found them all busy used to give up waiting after 10 seconds and open a temporary
// login of its own. Nothing bounded how many callers did that at once, so two stalled body
// fetches were enough to turn every queued operation into its own login.
//
// It now queues instead. These tests pin the ceiling (no amount of queued work may add a
// connection), the queue order (a freed slot goes to the head waiter, clicks ahead of background
// work), and the bound on a stalled pooled command. ImapFlow is mocked, so one constructor call
// is one socket.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import {
  ImapManager, acquirePooledClient, releasePooledClient, evictPool, poolSizeFor, backgroundPoolCap,
  POOL_SIZE, ACQUIRE_TIMEOUT_MS, BACKGROUND_ACQUIRE_TIMEOUT_MS, POOLED_OPERATION_TIMEOUT_MS, BODY_FETCH_POOL_TIMEOUT_MS,
  LONG_POOLED_OPERATION_TIMEOUT_MS, POOL_REFRESH_TIMEOUT_MS,
} from './imapManager.js';
import { getImapSnapshot, _resetImapMetrics } from './imapMetrics.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

// A generic host, so the pool size is the default rather than a provider override.
const ACCOUNT = {
  id: 'acct-474',
  imap_host: '127.0.0.1',
  imap_port: 1143,
  imap_tls: true,
  imap_skip_tls_verify: false,
  auth_user: 'user',
  auth_pass: 'enc',
};

let sockets;
beforeEach(() => {
  vi.clearAllMocks();
  evictPool(ACCOUNT.id);
  vi.useFakeTimers();
  sockets = [];
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.connect = vi.fn(() => Promise.resolve());
    client.logout = vi.fn(() => Promise.resolve());
    client.close = vi.fn();
    sockets.push(client);
    return client;
  });
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  vi.useRealTimers();
});

// Settle a promise into a value or its rejection, so an assertion can run while timers advance.
const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

async function fillPool() {
  const held = [];
  for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));
  expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
  return held;
}

// A `this` for calling fetchMessageBody off the prototype with no backoff armed.
const NO_BACKOFF = { _poolLoginOpts: () => ({ noNewLogin: false }) };

describe('pool size and waits', () => {
  it('defaults to 4 while Gmail and Yahoo keep their profile values', () => {
    expect(POOL_SIZE).toBe(4);
    expect(poolSizeFor(ACCOUNT)).toBe(POOL_SIZE);
    // Up to 100 Gmail accounts share one server IP: each extra pooled session is another sign-in.
    expect(poolSizeFor({ imap_host: 'imap.gmail.com' })).toBe(3);
    // Yahoo drops sessions past about three per account (#433).
    expect(poolSizeFor({ imap_host: 'imap.mail.yahoo.com' })).toBe(1);
  });

  it('keeps an interactive wait short and a background one shorter', () => {
    expect(ACQUIRE_TIMEOUT_MS).toBe(15000);
    expect(BACKGROUND_ACQUIRE_TIMEOUT_MS).toBeLessThan(ACQUIRE_TIMEOUT_MS);
  });
});

describe('connection fan-out when the pool is stalled (#474)', () => {
  it('serves queued work from the pool instead of opening a connection each', async () => {
    const stalled = await fillPool();
    const queued = Array.from({ length: 8 }, () => acquirePooledClient(ACCOUNT));
    // Settled up front: these promises reject while timers advance, and a rejection with no
    // handler attached yet is reported as unhandled by the runner.
    const settled = Promise.allSettled(queued);

    // Past the old 10s overflow, where each of these used to open its own login.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // They are queued, not failed, and a released connection goes to the next one.
    releasePooledClient(ACCOUNT, stalled[0]);
    const served = await queued[0];
    expect(served).toBe(stalled[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    releasePooledClient(ACCOUNT, served);
    for (let i = 1; i < stalled.length; i++) releasePooledClient(ACCOUNT, stalled[i]);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    await settled;
  });

  it('holds the ceiling no matter how much work piles up, then fails as busy', async () => {
    const stalled = await fillPool();
    const queued = Array.from({ length: 25 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(queued);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;
    // Past the acquire timeout they fail rather than silently opening sockets.
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(results[0].reason.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('lets background work give up sooner, still without opening a connection', async () => {
    const stalled = await fillPool();
    const outcome = settle(acquirePooledClient(ACCOUNT, { background: true }));
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('keeps the ceiling under a concurrent burst', async () => {
    // A regression guard, not a test of this branch: pool.connecting (the reservation upstream
    // added as its pending counter) predates the port, so this also passes on main. Checked
    // before any acquire timeout, so it measures the grow path and nothing else.
    const asks = Array.from({ length: POOL_SIZE * 3 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(asks);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(POOL_SIZE);
    for (const r of results) if (r.status === 'fulfilled') releasePooledClient(ACCOUNT, r.value);
  });

  it('a failed connect does not leave a reservation that shrinks the pool forever', async () => {
    ImapFlow.mockImplementationOnce(function () {
      const c = new EventEmitter();
      c.connect = vi.fn(() => Promise.reject(new Error('refused')));
      c.logout = vi.fn(() => Promise.resolve());
      c.close = vi.fn();
      return c;
    });
    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow();
    const got = [];
    for (let i = 0; i < POOL_SIZE; i++) got.push(await acquirePooledClient(ACCOUNT));
    expect(got).toHaveLength(POOL_SIZE);
    for (const c of got) releasePooledClient(ACCOUNT, c);
  });

  it('releasing a stalled connection lets a waiter reuse it rather than open one', async () => {
    const held = await fillPool();
    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const reused = await queued;
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    expect(reused).toBe(held[0]);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
    releasePooledClient(ACCOUNT, reused);
  });
});

describe('who gets a freed slot', () => {
  it('a slot freed by a closed session goes to the head waiter, which opens a connection', async () => {
    // Before: drainWaiters only handed out idle clients, so after a session was evicted or
    // closed by the server the queued waiters sat out their full timeout with room in the pool.
    const held = await fillPool();
    const waiter = settle(acquirePooledClient(ACCOUNT));
    held[0].emit('close');                         // the server dropped one session
    await vi.advanceTimersByTimeAsync(100);
    const { ok, v } = await waiter;
    expect(ok).toBe(true);
    expect(v).not.toBe(held[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1); // one replacement, never more
    releasePooledClient(ACCOUNT, v);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });

  it('a new caller does not jump the queue when a slot frees', async () => {
    const held = await fillPool();
    const first = settle(acquirePooledClient(ACCOUNT));
    held[0].emit('close');
    // Arrives right after the slot freed: the queued waiter already owns it.
    let lateServed = false;
    const late = acquirePooledClient(ACCOUNT).then(c => { lateServed = true; return c; });
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).ok).toBe(true);
    expect(lateServed).toBe(false);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1);
    // It is served by the next release instead.
    releasePooledClient(ACCOUNT, held[1]);
    expect(await late).toBe(held[1]);
    releasePooledClient(ACCOUNT, (await first).v);
    releasePooledClient(ACCOUNT, held[1]);
    for (let i = 2; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });

  it('serves a click before background work that queued earlier', async () => {
    const held = await fillPool();
    const background = settle(acquirePooledClient(ACCOUNT, { background: true }));
    const click = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    expect(await click).toBe(held[0]);
    releasePooledClient(ACCOUNT, held[0]);
    expect((await background).v).toBe(held[0]);
    releasePooledClient(ACCOUNT, held[0]);
    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
  });
});

describe('a session kept for user actions', () => {
  // Background work (flag sync, delete reconcile, the GTD folder sync, the spam poll, body prefetch)
  // shares the pool with the reader's clicks. It may hold every session but one, so a click never
  // waits behind it for the 15 s acquire timeout and then answers "mailbox busy".
  const background = { background: true };
  const holdBackground = async (n, account = ACCOUNT) => {
    const held = [];
    for (let i = 0; i < n; i++) held.push(await acquirePooledClient(account, background));
    return held;
  };
  const releaseAll = (clients, account = ACCOUNT) => { for (const c of clients) releasePooledClient(account, c); };

  it('leaves one of the default four and one of Gmail\'s three; a pool of one stays open to background work', () => {
    expect(backgroundPoolCap(ACCOUNT)).toBe(POOL_SIZE - 1);
    expect(backgroundPoolCap({ imap_host: 'imap.gmail.com' })).toBe(2);
    expect(backgroundPoolCap({ imap_host: 'imap.mail.yahoo.com' })).toBe(1);
  });

  it('serves a user action at once while background work holds every other session', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);
    // More background work queues for its share instead of taking the last session.
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);

    const askedAt = Date.now();
    let servedAt = null;
    const click = acquirePooledClient(ACCOUNT).then(c => { servedAt = Date.now(); return c; });
    await vi.advanceTimersByTimeAsync(0);
    expect(servedAt).toBe(askedAt);                        // no wait at all, not a 15 s one
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);     // the pool grew into its last slot

    // The queued background caller never got it and gives up as usual, still without a socket.
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const { ok, e } = await queuedBackground;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    releasePooledClient(ACCOUNT, await click);
    releaseAll(held);
  });

  it('counts a session being opened for background work, so a burst cannot take the last one', async () => {
    const burst = Array.from({ length: POOL_SIZE }, () => settle(acquirePooledClient(ACCOUNT, background)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);
    const click = await acquirePooledClient(ACCOUNT);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const results = await Promise.all(burst);
    expect(results.filter(r => r.ok)).toHaveLength(POOL_SIZE - 1);
    releasePooledClient(ACCOUNT, click);
    releaseAll(results.filter(r => r.ok).map(r => r.v));
  });

  it('keeps an idle session for the next user action and hands background its own freed one', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    const spare = await acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, spare);                   // open and idle now
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    // The idle session is not background's to take.
    const click = await acquirePooledClient(ACCOUNT);
    expect(click).toBe(spare);
    // A background session coming back goes to the background waiter.
    releasePooledClient(ACCOUNT, held[0]);
    const { ok, v } = await queuedBackground;
    expect(ok).toBe(true);
    expect(v).toBe(held[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    // It counts as background's again: the session the click gives back stays for the next click.
    releasePooledClient(ACCOUNT, click);
    const lateBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(await acquirePooledClient(ACCOUNT)).toBe(spare);
    releasePooledClient(ACCOUNT, spare);
    releaseAll([v, ...held.slice(1)]);
    expect((await lateBackground).ok).toBe(true);
    releasePooledClient(ACCOUNT, (await lateBackground).v);
  });

  it('counts an idle session background work took as background\'s', async () => {
    const held = await holdBackground(POOL_SIZE - 2);
    const spare = await acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, spare);
    expect(await acquirePooledClient(ACCOUNT, background)).toBe(spare);
    const lateBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);
    const click = await acquirePooledClient(ACCOUNT);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    releasePooledClient(ACCOUNT, click);
    releaseAll([spare, ...held]);
    const late = await lateBackground;
    if (late.ok) releasePooledClient(ACCOUNT, late.v);
  });

  it('fails a held-back background caller at once rather than hand it the idle session kept for users', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    const spare = await acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, spare);
    await expect(acquirePooledClient(ACCOUNT, { background: true, noNewLogin: true }))
      .rejects.toMatchObject({ providerRefusing: true });
    expect(await acquirePooledClient(ACCOUNT)).toBe(spare);
    releasePooledClient(ACCOUNT, spare);
    releaseAll(held);
  });

  it('does not open the kept session for background work queued behind a held user action', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    // A click while a backoff holds new logins back waits for an open session to be released.
    const heldClick = settle(acquirePooledClient(ACCOUNT, { noNewLogin: true }));
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);
    // The next released session goes to the click, as before. The click now holds a session, so
    // background is below its share again and its waiter may open the last one.
    releasePooledClient(ACCOUNT, held[0]);
    expect((await heldClick).v).toBe(held[0]);
    await vi.advanceTimersByTimeAsync(0);
    const { ok, v } = await queuedBackground;
    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    releaseAll([v, ...held]);
  });

  it('counts a session opened for background work that queued behind a held user action', async () => {
    const held = await holdBackground(POOL_SIZE - 2);
    const userSession = await acquirePooledClient(ACCOUNT);
    const heldClick = settle(acquirePooledClient(ACCOUNT, { noNewLogin: true }));
    // Below its share, background may open the free slot past the held click.
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    const { ok, v } = await queuedBackground;
    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    // The user session goes to the held click, which gives it back: it stays for users.
    releasePooledClient(ACCOUNT, userSession);
    expect((await heldClick).v).toBe(userSession);
    releasePooledClient(ACCOUNT, userSession);
    const lateBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(await acquirePooledClient(ACCOUNT)).toBe(userSession);
    releasePooledClient(ACCOUNT, userSession);
    releaseAll([v, ...held]);
    const late = await lateBackground;
    if (late.ok) releasePooledClient(ACCOUNT, late.v);
  });

  it('frees the share of a background session the server closed', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    held[0].emit('close');
    await vi.advanceTimersByTimeAsync(0);
    const { ok, v } = await queuedBackground;
    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);     // one replacement for the closed session
    // The replacement counts as background's: the last slot is still there for a click.
    const lateBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    const click = await acquirePooledClient(ACCOUNT);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1);
    releasePooledClient(ACCOUNT, click);
    releaseAll([v, ...held.slice(1)]);
    releasePooledClient(ACCOUNT, held[0]);
    const late = await lateBackground;
    if (late.ok) releasePooledClient(ACCOUNT, late.v);
  });

  it('frees the share of a background operation that failed, for background work already queued', async () => {
    const held = await holdBackground(POOL_SIZE - 2);
    let failLock;
    ImapFlow.mockImplementationOnce(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.getMailboxLock = vi.fn(() => new Promise((_, reject) => { failLock = reject; }));
      sockets.push(client);
      return client;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = { syncingAccounts: new Set(), _pendingFlagSync: new Set(), _poolLoginOpts: () => ({ noNewLogin: false }) };
    // The flag range sync is background work on the pool: it takes the last of background's share.
    const flagSync = ImapManager.prototype._syncFlagsForRange.call(mgr, ACCOUNT);
    await vi.advanceTimersByTimeAsync(0);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE - 1);
    const queuedBackground = settle(acquirePooledClient(ACCOUNT, background));
    await vi.advanceTimersByTimeAsync(0);
    failLock(new Error('Connection not available'));
    await flagSync;
    await vi.advanceTimersByTimeAsync(0);
    // Served now, by a replacement for the evicted session, not after its 10 s timeout.
    const { ok, v } = await queuedBackground;
    expect(ok).toBe(true);
    expect(sockets[POOL_SIZE - 2].close).toHaveBeenCalled();
    releasePooledClient(ACCOUNT, v);
    releaseAll(held);
  });

  it('leaves the kept session to a click while a follow-up folder sync marked background waits', async () => {
    // After a send, a move or a GTD copy the panel pulls a folder nobody is waiting on.
    const held = await holdBackground(POOL_SIZE - 1);
    const mgr = { onDemandSyncing: new Set(), syncMessages: vi.fn(async () => {}), broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sync = ImapManager.prototype.syncFolderOnDemand.call(mgr, ACCOUNT, 'Sent', { background: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.syncMessages).not.toHaveBeenCalled();
    const click = await acquirePooledClient(ACCOUNT);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    // A background session coming back goes to the sync.
    releasePooledClient(ACCOUNT, held[0]);
    await sync;
    expect(mgr.syncMessages).toHaveBeenCalledTimes(1);
    releasePooledClient(ACCOUNT, click);
    releaseAll(held);
  });

  it('still lets a folder the reader opens take the last session', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    const mgr = { onDemandSyncing: new Set(), syncMessages: vi.fn(async () => {}), broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await ImapManager.prototype.syncFolderOnDemand.call(mgr, ACCOUNT, 'Archive');
    expect(mgr.syncMessages).toHaveBeenCalledTimes(1);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    releaseAll(held);
  });

  it('leaves the kept session to a click while a GTD strip marked background waits', async () => {
    const held = await holdBackground(POOL_SIZE - 1);
    query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [ACCOUNT] : [] }));
    const mgr = Object.create(ImapManager.prototype);
    const strip = settle(mgr.removeMessageCopy(ACCOUNT.id, 7, 'Todo', { background: true }));
    await vi.advanceTimersByTimeAsync(0);
    const click = await acquirePooledClient(ACCOUNT);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    // Nothing came back within the background wait: the strip gives up without a session.
    await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
    const { ok, e } = await strip;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    releasePooledClient(ACCOUNT, click);
    releaseAll(held);
  });

  it('keeps one of Gmail\'s three sessions for user actions', async () => {
    const gmail = { ...ACCOUNT, id: 'acct-gmail-reserve', imap_host: 'imap.gmail.com' };
    try {
      const held = await holdBackground(2, gmail);
      const queuedBackground = settle(acquirePooledClient(gmail, background));
      await vi.advanceTimersByTimeAsync(0);
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      const click = await acquirePooledClient(gmail);
      expect(ImapFlow).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS);
      expect((await queuedBackground).ok).toBe(false);
      releasePooledClient(gmail, click);
      releaseAll(held, gmail);
    } finally { evictPool(gmail.id); }
  });

  it('still lets background work use a pool of one (Yahoo), behind any user action', async () => {
    const yahoo = { ...ACCOUNT, id: 'acct-yahoo-reserve', imap_host: 'imap.mail.yahoo.com' };
    try {
      const [bg] = await holdBackground(1, yahoo);
      const queuedBackground = settle(acquirePooledClient(yahoo, background));
      const click = acquirePooledClient(yahoo);
      releasePooledClient(yahoo, bg);
      expect(await click).toBe(bg);                         // the click goes first
      releasePooledClient(yahoo, bg);
      expect((await queuedBackground).v).toBe(bg);
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      releasePooledClient(yahoo, bg);
    } finally { evictPool(yahoo.id); }
  });
});

describe('a stale bulk move', () => {
  it('pulls the destination as background work', async () => {
    // Dovecot without a UIDPLUS map for a batch holding a stale UID: the move reports all failed
    // and pulls the destination folder, which nobody waits on.
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.status = vi.fn(async () => ({ uidNext: 10 }));
      client.getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));
      client.capabilities = new Map([['MOVE', true]]); // Dovecot has MOVE: moves go to messageMove
      client.messageMove = vi.fn(async () => ({}));
      sockets.push(client);
      return client;
    });
    const mgr = {
      _reconcileMoveBySearch: vi.fn(async () => ({ staleCount: 1, succeeded: [], failed: [1, 2] })),
      syncFolderOnDemand: vi.fn(async () => {}),
    };
    await ImapManager.prototype.bulkMoveMessages.call(mgr, ACCOUNT, [1, 2], 'INBOX', 'Archive');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'Archive', { background: true });
  });
});

describe('evicting a pool', () => {
  it('leaves a session in use running and closes it when it is released', async () => {
    const busy = await acquirePooledClient(ACCOUNT);
    const idle = await acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, idle);
    evictPool(ACCOUNT.id);
    expect(idle.close).toHaveBeenCalled();
    // Closing it now would abort another operation mid-command (a MOVE the server may apply).
    expect(busy.close).not.toHaveBeenCalled();
    releasePooledClient(ACCOUNT, busy);
    expect(busy.close).toHaveBeenCalled();
    expect(busy.logout).not.toHaveBeenCalled();
  });
});

describe('a stalled pooled command', () => {
  // imapflow 2.0.x has no command timeout, so a command that never answers kept its pool slot
  // until the 5-minute socket timeout, or forever if data trickled in.
  const hangOnLock = () => {
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.getMailboxLock = vi.fn(() => new Promise(() => {}));
      sockets.push(client);
      return client;
    });
  };

  it('times out, closes the session and frees the slot', async () => {
    hangOnLock();
    const move = settle(ImapManager.prototype.moveMessage.call({}, ACCOUNT, 7, 'INBOX', 'Trash'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(POOLED_OPERATION_TIMEOUT_MS + 100);
    const { ok, e } = await move;
    expect(ok).toBe(false);
    expect(e.message).toMatch(/Pooled IMAP operation timeout/);
    expect(sockets[0].close).toHaveBeenCalled();
    // The next operation gets a fresh session instead of queueing behind the stalled one.
    const next = await acquirePooledClient(ACCOUNT);
    expect(next).not.toBe(sockets[0]);
    releasePooledClient(ACCOUNT, next);
  });

  it.each([
    ['emptyFolder', mgr => mgr.emptyFolder(ACCOUNT, 'Trash')],
    ['markAllReadImap', mgr => mgr.markAllReadImap(ACCOUNT, 'INBOX')],
    ['appendToFolder', mgr => mgr.appendToFolder(ACCOUNT, 'Sent', Buffer.from('x'))],
  ])('gives %s the long bound, not the default one', async (_name, run) => {
    // Whole-folder writes and a large Sent upload legitimately take longer than the default;
    // cutting them off at 120 s would leave a folder half emptied or lose the Sent copy.
    hangOnLock();
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.getMailboxLock = vi.fn(() => new Promise(() => {}));
      client.append = vi.fn(() => new Promise(() => {}));
      sockets.push(client);
      return client;
    });
    const mgr = Object.create(ImapManager.prototype);
    const outcome = settle(run(mgr));
    await vi.advanceTimersByTimeAsync(POOLED_OPERATION_TIMEOUT_MS + 1000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LONG_POOLED_OPERATION_TIMEOUT_MS - POOLED_OPERATION_TIMEOUT_MS);
    const { ok } = await outcome;
    expect(ok).toBe(false);
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('bounds a body fetch inside the route budget', async () => {
    hangOnLock();
    const fetch = settle(ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, ACCOUNT, 9, 'INBOX'));
    await vi.advanceTimersByTimeAsync(BODY_FETCH_POOL_TIMEOUT_MS + 100);
    const { ok } = await fetch;
    expect(ok).toBe(false);
    expect(BODY_FETCH_POOL_TIMEOUT_MS).toBeLessThan(40000);
    expect(sockets[0].close).toHaveBeenCalled();
  });
});

describe('a body fetch on a busy account', () => {
  it('fails as busy and does not fall back to a fresh login', async () => {
    const held = await fillPool();
    const outcome = settle(ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, ACCOUNT, 9, 'INBOX'));
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    // The flag survives to the route, which answers 503 mailbox_busy.
    expect(e.poolExhausted).toBe(true);
    // The fresh-login retry is for broken connections, not for a full pool: no new socket.
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    for (const c of held) releasePooledClient(ACCOUNT, c);
  });
});

describe('bulk operations on a busy account', () => {
  it('fail as busy at once, without a reconcile that would wait out the pool again', async () => {
    const held = await fillPool();
    const outcome = settle(ImapManager.prototype.bulkMoveMessages.call({}, ACCOUNT, [1, 2], 'INBOX', 'Archive'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One acquire wait (the STATUS), not three.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 100);
    const { ok, e } = await outcome;
    expect(ok).toBe(false);
    expect(e.poolExhausted).toBe(true);
    for (const c of held) releasePooledClient(ACCOUNT, c);
  });
});

// A reused session keeps the view of its selected mailbox it had when it was released, and Yahoo
// does not catch that view up until the client sends a command that lets it: STATUS of the
// selected mailbox returned SELECT-time counts (a frozen unread badge), and a UID STORE naming
// mail delivered since answered OK and changed nothing (a mark-read that never reached the
// server). The pool NOOPs a reused session before handing it out, and a session that cannot
// answer is closed instead of being handed out or pooled again. (Upstream dbe04838.)
describe('refreshing a reused pooled session', () => {
  // Makes an acquired client look like a real ImapFlow session with INBOX selected. The NOOP goes
  // through run('NOOP'), which resolves true on OK and false on a NO, BAD or broken connection:
  // imapflow's own noop() discards that result and resolves undefined either way.
  const selectInbox = (client, run = vi.fn(async () => true)) => {
    client.mailbox = { path: 'INBOX', exists: 17 };
    client.run = run;
    client.noop = vi.fn(async () => {});
    return client;
  };
  let warn;
  beforeEach(() => { _resetImapMetrics(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });
  const refreshFailures = () => getImapSnapshot(() => 'generic').events
    .filter(e => e.event === 'pool_refresh_failed').reduce((n, e) => n + e.total, 0);

  it('answers within a short budget, well inside the interactive acquire wait', () => {
    expect(POOL_REFRESH_TIMEOUT_MS).toBeLessThan(ACQUIRE_TIMEOUT_MS);
    expect(POOL_REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('NOOPs a reused session with a mailbox selected before handing it out', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT));
    releasePooledClient(ACCOUNT, first);

    const again = await acquirePooledClient(ACCOUNT);

    expect(again).toBe(first);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(first.run).toHaveBeenCalledWith('NOOP');
    expect(ImapFlow).toHaveBeenCalledTimes(1);   // reuse, not a new login
    releasePooledClient(ACCOUNT, again);
  });

  it('sends nothing for a reused session with no mailbox selected', async () => {
    const first = await acquirePooledClient(ACCOUNT);
    first.mailbox = false;
    first.run = vi.fn(async () => true);
    releasePooledClient(ACCOUNT, first);

    releasePooledClient(ACCOUNT, await acquirePooledClient(ACCOUNT));

    expect(first.run).not.toHaveBeenCalled();
  });

  it('closes a session whose NOOP fails instead of handing it out, and the next caller gets a new one', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT), vi.fn(async () => false));
    releasePooledClient(ACCOUNT, first);

    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow(/NOOP/);
    expect(first.close).toHaveBeenCalled();
    expect(refreshFailures()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a***@example.com'));

    const next = await acquirePooledClient(ACCOUNT);
    expect(next).not.toBe(first);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    releasePooledClient(ACCOUNT, next);
  });

  it('closes a session whose NOOP throws', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT), vi.fn(async () => { throw new Error('Connection not available'); }));
    releasePooledClient(ACCOUNT, first);

    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow(/NOOP/);
    expect(first.close).toHaveBeenCalled();
  });

  it('closes a session whose NOOP hangs, since that command is still in flight', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT), vi.fn(() => new Promise(() => {})));
    releasePooledClient(ACCOUNT, first);

    const attempt = settle(acquirePooledClient(ACCOUNT));
    await vi.advanceTimersByTimeAsync(POOL_REFRESH_TIMEOUT_MS + 10);
    const { ok, e } = await attempt;
    expect(ok).toBe(false);
    expect(e.message).toMatch(/refresh/i);
    expect(first.close).toHaveBeenCalled();
    expect(refreshFailures()).toBe(1);
  });

  it('also refreshes a session handed to a queued caller', async () => {
    const held = await fillPool();
    selectInbox(held[0]);

    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const got = await queued;

    expect(got).toBe(held[0]);
    expect(held[0].run).toHaveBeenCalledTimes(1);
    for (const c of [got, ...held.slice(1)]) releasePooledClient(ACCOUNT, c);
  });

  it('a queued caller whose session fails the refresh is rejected, and the freed slot goes on', async () => {
    const held = await fillPool();
    selectInbox(held[0], vi.fn(async () => false));

    const queuedFirst = settle(acquirePooledClient(ACCOUNT));
    const queuedSecond = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);

    const { ok } = await queuedFirst;
    expect(ok).toBe(false);
    expect(held[0].close).toHaveBeenCalled();
    // The dead session left the pool, so the next waiter opens a new one in its slot.
    const second = await queuedSecond;
    expect(second).not.toBe(held[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE + 1);
    for (const c of [second, ...held.slice(1)]) releasePooledClient(ACCOUNT, c);
  });

  it('refreshes an idle session handed to background work while logins are held back', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT));
    releasePooledClient(ACCOUNT, first);

    const again = await acquirePooledClient(ACCOUNT, { background: true, noNewLogin: true });

    expect(again).toBe(first);
    expect(first.run).toHaveBeenCalledTimes(1);
    releasePooledClient(ACCOUNT, again);
  });
});
