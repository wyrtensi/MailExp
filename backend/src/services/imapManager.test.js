import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
// IMAP refreshes through the token manager (single entry point). Keep its real OAuthTokenError and
// pass accounts through unchanged unless a test scripts a refresh.
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./deliveryReport.js', async (importOriginal) => ({ ...(await importOriginal()), readDeliveryReports: vi.fn(async () => 0) }));

import { ImapManager, MIN_SYNC_INTERVAL_MS, AUTO_IDLE_DELAY_MS, countMissingInboxCopies, fetchBackfillBatch, providerProfile, makeClientCfg, relocateExemptGuard, insertCopiedSibling, deleteMessageCopyRow, emitSectionsChanged, ensureMailbox, createKeyedSemaphore, isConnectionRefusal, extractImapError, isImapAuthFailure, AUTH_FAILURE_COOLDOWN_MS, AUTH_FAILURE_COOLDOWN_MAX_MS, authCooldownMs, connectCooldownMs, effectiveSyncIntervalMs, folderSyncDue, planModseqSync, connectStaggerFor, walkStructure, planBodyParts, extractBodyFromMsg, bodyFallbackApplies, poolSizeFor, backgroundPoolCap, rerootThreadChildren, parsePersistentCap, resolvePersistentCap, persistentEligible, shouldRetryIPv4, classifyMoveBySearch, PERSISTENT_FLAG_STORE_TIMEOUT_MS, PERSISTENT_FLAG_LATE_STORE_WAIT_MS, PERSISTENT_FLAG_LOCK_WAIT_MS, FLAG_STORE_UID_CHUNK, FLAG_PUSH_MAX_ATTEMPTS, wrapImapError, acquirePooledClient, releasePooledClient, evictPool, ACQUIRE_TIMEOUT_MS, BACKGROUND_ACQUIRE_TIMEOUT_MS, PREFETCH_MAX_CONSECUTIVE_ERRORS, PREFETCH_STOP_PAUSE_MS, PREFETCH_MAX_BUSY_WAITS, newBodyPrefetchCount, newBodyQueueMax, NODE_NEW_BODY_PREFETCH_MAX, NODE_PREFETCH_PER_HOST } from './imapManager.js';
import { pluginRegistry } from '../plugins/registry.js';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { ensureFreshOAuthAccount } from './oauth/tokenManager.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { invalidateGtdConfigCache } from '../plugins/gtd/gtdConfig.js';
import { parseMessage } from './messageParser.js';
import { sendPushToActiveUsers } from './pushNotifications.js';
import { getImapSnapshot, _resetImapMetrics } from './imapMetrics.js';
import { GMAIL_KEY_PREFIX } from './threading/threadId.js';
import { readDeliveryReports } from './deliveryReport.js';
import { STAND_DSN_STRUCTURE } from './deliveryReport.fixtures.js';

const account = (imap_host, oauth_provider = null) => ({ imap_host, oauth_provider });

const resolved = { host: '127.0.0.1', servername: null };

// A `this` for calling fetchMessageBody off the prototype with no backoff armed.
const NO_BACKOFF = { _poolLoginOpts: () => ({ noNewLogin: false }) };

// The account backoffs a hand-built manager needs to run a background login path for real: the
// real gates over empty maps, and spies for the two ways a background login arms them.
// Only for paths with their own connectImapClient: the pool and withFreshLogin arm and consult the
// most recently constructed ImapManager (helperManager), never this object, so a pool-driven test
// on it would see another test's ladder state. Use ladderManager() for those.
// syncMessages and backfillMessages first ask whether a fetched letter is in motion (moveQueue.js):
// guarded at its source, or expected by a pending move in its destination. No moves here.
const noMoves = () => ({
  _pendingMoveUids: new Map(),
  _isMoveUidGuarded: ImapManager.prototype._isMoveUidGuarded,
  moveQueue: { claimArrival: vi.fn(async () => false) },
});
const backoffState = () => ({
  ...noMoves(),
  connections: new Map(),
  _connectCooldown: new Map(),
  _secondaryCooldown: new Map(),
  _secondaryAuthCooldown: new Map(),
  _secondaryConnectBlocked: ImapManager.prototype._secondaryConnectBlocked,
  _secondaryAuthBlocked: ImapManager.prototype._secondaryAuthBlocked,
  _secondaryLoginBlocked: ImapManager.prototype._secondaryLoginBlocked,
  _noteSecondaryRefusal: vi.fn(),
  _noteSecondaryAuthFailure: vi.fn(),
});
const baseAccount = { imap_host: '127.0.0.1', imap_port: 1143, imap_tls: true, imap_skip_tls_verify: false, auth_user: 'user', auth_pass: 'enc' };

// ── providerProfile — host detection ─────────────────────────────────────────

describe('providerProfile — host detection', () => {
  it.each([
    ['imap.gmail.com'],
    ['imap.googlemail.com'],
    ['smtp.gmail.com'],
  ])('detects google for %s', host => {
    expect(providerProfile(account(host)).pushesFlags).toBe(false);
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).snippetIndex).toBe(false);
  });

  it.each([
    ['imap.mail.yahoo.com'],
    ['imap.ymail.com'],
    ['smtp.mail.yahoo.com'],
  ])('detects yahoo for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
    expect(providerProfile(account(host)).snippetIndex).toBe(true);
  });

  it('keeps a Yahoo account within its ~3 simultaneous sessions (#433)', () => {
    const p = providerProfile(account('imap.mail.yahoo.com'));
    // IDLE + one pooled connection + one background connection.
    expect(p.poolSize).toBe(1);
    expect(p.maxBackgroundConnections).toBe(1);
    expect(p.idleKeepaliveMs).toBe(4 * 60 * 1000);
    expect(p.batchesPerConn).toBe(50);
  });

  it.each([
    ['imap.mail.me.com'],
    ['imap.icloud.com'],
    ['imap.apple.com'],
  ])('detects apple for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).batchSize).toBe(200);
  });

  it.each([
    ['outlook.office365.com'],
    ['imap.hotmail.com'],
    ['imap.live.com'],
  ])('detects microsoft for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
  });

  it.each([
    ['imap.purelymail.com'],
    ['mail.purelymail.com'],
  ])('detects purelymail (IDLE-based profile) for %s', host => {
    const p = providerProfile(account(host));
    // IDLE-first with an aggressive keepalive: one long-lived IDLE connection pushes new
    // mail, re-issued every 4 min so it never goes deaf; the periodic tick is a light
    // backstop. Body work stays conservative (no snippet indexing / speculative fetch,
    // user body fetches bypass the pool) — see PROVIDERS.purelymail.
    expect(p.snippetIndex).toBe(false);
    expect(p.speculativeFetch).toBe(false);
    expect(p.preferFreshBodyFetch).toBe(true);
    expect(p.freshInboxSync).toBe(false);
    expect(p.autoBackfillExistingOnConnect).toBe(false);
    expect(p.usesIdle).toBe(true);
    expect(p.idleKeepaliveMs).toBe(4 * 60 * 1000);
    expect(p.pushesFlags).toBe(false);
    expect(p.maxSyncIntervalMs).toBe(120000);
    expect(p.flagPollEveryTicks).toBe(6);
    expect(p.prefetchNewBodies).toBe(true);
    expect(p.prefetchNewBodiesLimit).toBe(1);
  });

  it.each([
    ['imap.fastmail.com'],
    ['imap.protonmail.com'],
  ])('falls back to generic for unknown host %s', host => {
    const p = providerProfile(account(host));
    expect(p.speculativeFetch).toBe(true);
    expect(p.pushesFlags).toBe(true);
    expect(p.snippetIndex).toBe(true);
  });

  it.each([
    ['acme.com'],
    ['olive.com'],
    ['snapple.com'],
    ['webgmail.ru'],
  ])('does not false-positive on %s', host => {
    expect(providerProfile(account(host))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — oauth_provider detection ────────────────────────────────

describe('providerProfile — oauth_provider fallback', () => {
  it('detects microsoft via oauth_provider (only supported OAuth flow)', () => {
    expect(providerProfile(account('', 'microsoft')).pushesFlags).toBe(true);
  });

  it('does not detect google via oauth_provider alone — host-based only', () => {
    expect(providerProfile(account('', 'google'))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — skipFolderPatterns ─────────────────────────────────────

describe('providerProfile — skipFolderPatterns', () => {
  it('google skips All Mail, Starred, Important', () => {
    const { skipFolderPatterns } = providerProfile(account('imap.gmail.com'));
    expect(skipFolderPatterns.some(p => '[Gmail]/All Mail'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Starred'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Important'.toLowerCase().includes(p))).toBe(true);
  });

  it('yahoo has no skip patterns', () => {
    expect(providerProfile(account('imap.mail.yahoo.com')).skipFolderPatterns).toHaveLength(0);
  });

  it('generic has no skip patterns', () => {
    // Use a genuinely-unknown host — purelymail.com now routes to its own profile.
    expect(providerProfile(account('imap.fastmail.com')).skipFolderPatterns).toHaveLength(0);
  });
});

// ── providerProfile — robustness ──────────────────────────────────────────────

describe('providerProfile — robustness', () => {
  it('handles null imap_host gracefully', () => {
    expect(() => providerProfile({ imap_host: null, oauth_provider: null })).not.toThrow();
  });

  it('handles missing fields gracefully', () => {
    expect(() => providerProfile({})).not.toThrow();
  });

  it('is case-insensitive for host matching', () => {
    expect(providerProfile(account('IMAP.GMAIL.COM')).pushesFlags).toBe(false);
  });
});

// ── relocateExemptGuard — move-detector exemption ────────────────────────────

describe('relocateExemptGuard — label folder relocate exemption', () => {
  it('is a no-op when no label plugin contributes folders', () => {
    const guard = relocateExemptGuard([], 5);
    expect(guard.clause).toBe('');
    expect(guard.params).toEqual([]);
  });

  it('binds the exempt folders as a single array param', () => {
    const guard = relocateExemptGuard(['Todo', 'Watch'], 5);
    expect(guard.params).toEqual([['Todo', 'Watch']]);
  });

  it('exempts both the target folder ($1) and the row current folder', () => {
    const { clause } = relocateExemptGuard(['Todo'], 5);
    // Target folder being synced ($1) must not be relocated INTO an exempt label folder…
    expect(clause).toContain('$1 <> ALL($5::text[])');
    // …and a row already living in an exempt label folder must not be relocated OUT of it.
    expect(clause).toContain('folder <> ALL($5::text[])');
  });

  it('uses the supplied positional bind index', () => {
    const { clause } = relocateExemptGuard(['Todo'], 7);
    expect(clause).toContain('$7::text[]');
    expect(clause).not.toContain('$5');
  });
});

// ── makeClientCfg — auto-IDLE arming ─────────────────────────────────────────
//
// Regression cover for the bug where IDLE never started on ANY account. ImapFlow arms IDLE
// only after autoIdleDelay of quiet; its default is 15000ms, which is exactly the fastest sync
// interval the settings UI offers. A 15s tick left the connection quiet for ~14.9s and cleared
// the arming timer ~100ms before it fired, so every provider silently degraded to polling.
// The first test is the one that matters: it fails if those two values are ever equal again.

describe('makeClientCfg — broken-IMAP4rev2 opt-out (upstream #472)', () => {
  // Strato ENABLEs IMAP4rev2 without advertising it, then answers UID SEARCH ALL with an
  // empty ESEARCH, which poisons reconcile, the integrity pass and backfill's server count.
  it('disables the IMAP4rev2 ENABLE for Strato on every connection kind', () => {
    const strato = { ...baseAccount, imap_host: 'imap.strato.de' };
    expect(providerProfile(strato).disableIMAP4rev2).toBe(true);
    expect(makeClientCfg(strato, resolved, { enableIdle: true }).disableIMAP4rev2).toBe(true);
    expect(makeClientCfg(strato, resolved, { enableIdle: false }).disableIMAP4rev2).toBe(true);
  });

  it('leaves every other provider on full IMAP4rev2', () => {
    for (const host of ['imap.example.com', 'imap.gmail.com', 'imap.purelymail.com']) {
      const acct = { ...baseAccount, imap_host: host };
      expect(makeClientCfg(acct, resolved, { enableIdle: false }).disableIMAP4rev2).toBeUndefined();
    }
  });
});

describe('makeClientCfg — auto-IDLE arming', () => {
  it('arms IDLE strictly faster than the fastest possible sync tick', () => {
    // The invariant. If this fails, IDLE cannot start before the next tick interrupts it.
    expect(AUTO_IDLE_DELAY_MS).toBeLessThan(MIN_SYNC_INTERVAL_MS);
  });

  it('leaves enough delay not to inject IDLE between one sync\'s own commands', () => {
    // The opposite failure: too small a value means every command is followed by an IDLE the
    // next command must break, costing two extra round trips each time.
    expect(AUTO_IDLE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });

  it('sets autoIdleDelay whenever IDLE is enabled', () => {
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: true });
    expect(cfg.autoIdleDelay).toBe(AUTO_IDLE_DELAY_MS);
  });

  it('does not set autoIdleDelay on non-IDLE connections (pool/backfill clients)', () => {
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: false });
    expect(cfg.autoIdleDelay).toBeUndefined();
  });

  it('sets autoIdleDelay independently of idleKeepaliveMs', () => {
    // maxIdleTime governs how long an IDLE lasts; autoIdleDelay governs whether it starts.
    // Conflating the two is what let this bug survive the PurelyMail IDLE work.
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: true, idleKeepaliveMs: 4 * 60 * 1000 });
    expect(cfg.maxIdleTime).toBe(4 * 60 * 1000);
    expect(cfg.autoIdleDelay).toBe(AUTO_IDLE_DELAY_MS);
  });
});

// ── makeClientCfg — COMPRESS ─────────────────────────────────────────────────

describe('makeClientCfg — COMPRESS', () => {
  it('turns compression off for a mailbox on the mail node, so Dovecot can hibernate its IDLE', () => {
    const cfg = makeClientCfg({ ...baseAccount, mail_node: true }, resolved, { enableIdle: true });
    expect(cfg.disableCompression).toBe(true);
  });

  it('leaves compression to ImapFlow for any other mailbox', () => {
    expect(makeClientCfg({ ...baseAccount, mail_node: false }, resolved).disableCompression).toBeUndefined();
    expect(makeClientCfg(baseAccount, resolved).disableCompression).toBeUndefined();
  });
});

// ── makeClientCfg — TLS enforcement ──────────────────────────────────────────

describe('makeClientCfg — TLS enforcement', () => {
  it('throws for plain-text IMAP when allowInsecureTls is false', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: false } })
    ).toThrow(/plain-text IMAP/i);
  });

  it('throws for plain-text IMAP when policy is empty (default)', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved)
    ).toThrow(/plain-text IMAP/i);
  });

  it('does not throw for plain-text IMAP when allowInsecureTls is true', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });

  it('does not throw for TLS IMAP regardless of allowInsecureTls', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: false } })
    ).not.toThrow();
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });
});

// ── makeClientCfg — rejectUnauthorized ───────────────────────────────────────

describe('makeClientCfg — rejectUnauthorized', () => {
  it('sets rejectUnauthorized true by default (no policy)', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is false even if skip_tls_verify is set', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: false } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized false when allowInsecureTls is true and imap_skip_tls_verify is true', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(false);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is true but imap_skip_tls_verify is false', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: false },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets servername from resolved when present', () => {
    const cfg = makeClientCfg(baseAccount, { host: '142.250.80.46', servername: 'imap.gmail.com' });
    expect(cfg.tls.servername).toBe('imap.gmail.com');
  });

  it('does not set servername when resolved.servername is null', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.servername).toBeUndefined();
  });

  it('uses the original hostname with a pinned multi-address lookup', () => {
    const lookup = vi.fn();
    const cfg = makeClientCfg(baseAccount, {
      host: '203.0.113.1',
      servername: 'imap.example.com',
      addresses: ['203.0.113.1', '203.0.113.2'],
      lookup,
    });
    expect(cfg.host).toBe('imap.example.com');
    expect(cfg.tls.lookup).toBe(lookup);
    expect(cfg.tls.autoSelectFamily).toBe(true);
    expect(cfg.tls.autoSelectFamilyAttemptTimeout).toBe(1000);
  });
});

// ── copyMessage DB side — insertCopiedSibling ────────────────────────────────
// The IMAP COPY itself runs through withFreshClient (not unit-testable without a
// live pool), so the destination-sibling INSERT is extracted here and tested with
// the UID a UIDPLUS copyuid map would yield — same seam as gtdRelocateGuard in 1a.

const findCall = (frag) => query.mock.calls.find(([sql]) => sql.includes(frag));
const countAdjusts = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE folders'));

describe('insertCopiedSibling', () => {
  beforeEach(() => query.mockReset());

  it('inserts the destination sibling from the source row with the copied UID', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);

    const ins = findCall('INSERT INTO messages');
    expect(ins).toBeTruthy();
    // Content columns come from the source row; only uid ($4) and folder ($5) change.
    expect(ins[0]).toContain('FROM messages');
    expect(ins[0]).toContain('WHERE account_id = $1 AND folder = $2 AND uid = $3');
    // Idempotent against the next destination-folder sync.
    expect(ins[0]).toContain('ON CONFLICT (account_id, uid, folder) DO NOTHING');
    expect(ins[1]).toEqual(['acct-1', 'INBOX', 100, 5001, 'Todo']);
    // delivery_addresses is copied verbatim from the source row, same as list_unsubscribe.
    expect(ins[0]).toContain('delivery_addresses');
  });

  it('copies the provider ids and draft Bcc recipients with the row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    const ins = findCall('INSERT INTO messages');
    const [insertList, selectList] = ins[0].split('SELECT');
    for (const col of ['provider_thread_id', 'provider_message_id', 'bcc_addresses', 'threading_reason']) {
      expect(insertList).toContain(col);
      expect(selectList).toContain(col);
    }
  });

  it('increments destination unread only when the copied message is unread', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    // total +1, unread +1 for an unread copy.
    expect(countAdjusts()[0][1]).toEqual([1, 1, 'acct-1', 'Todo']);
  });

  it('counts total but not unread for a read copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    expect(countAdjusts()[0][1]).toEqual([1, 0, 'acct-1', 'Todo']);
  });

  it('adjusts no counts when a prior sync already inserted the sibling (ON CONFLICT hit)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // DO NOTHING → no RETURNING row
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    expect(countAdjusts()).toHaveLength(0);
  });
});

// ── removeMessageCopy DB side — deleteMessageCopyRow ─────────────────────────

describe('deleteMessageCopyRow', () => {
  beforeEach(() => query.mockReset());

  it('deletes exactly one folder copy, scoped by (account_id, uid, folder)', async () => {
    query.mockResolvedValueOnce({ rows: [{ is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await deleteMessageCopyRow('acct-1', 100, 'Todo');

    const del = findCall('DELETE FROM messages');
    expect(del[0]).toContain('WHERE account_id = $1 AND uid = $2 AND folder = $3');
    // Never keyed on message_id — sibling rows in other folders are left intact.
    expect(del[0]).not.toContain('message_id');
    expect(del[1]).toEqual(['acct-1', 100, 'Todo']);
  });

  it('decrements the folder count, dropping unread only if the removed copy was unread', async () => {
    query.mockResolvedValueOnce({ rows: [{ is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()[0][1]).toEqual([-1, -1, 'acct-1', 'Todo']);
  });

  it('adjusts no counts when the row was already gone', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()).toHaveLength(0);
  });
});

// ── permanentDeleteMessage — expectMessageId (upstream e8eb7583) ─────────────
// A uid names a place in a folder, not a message. draft.js passes the Message-ID of the copy it
// means to delete, so a uid read from a stale local row, or looked up in the wrong mailbox after
// a From switch, deletes nothing rather than expunge whatever now sits at that uid on the server.
// Driven through the real pool so the check is what actually guards the EXPUNGE.
describe('permanentDeleteMessage — expectMessageId', () => {
  let seq = 0;
  function arrange(serverCopies) {
    const account = { id: `acct-pdm-${++seq}`, user_id: 'u1', imap_host: 'imap.example.com', email_address: 'me@example.test', auth_user: 'me', auth_pass: 'enc' };
    const client = Object.assign(new EventEmitter(), {
      usable: true,
      connect: vi.fn(() => Promise.resolve()),
      logout: vi.fn(() => Promise.resolve()),
      close: vi.fn(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      fetch: vi.fn(async function* (range) {
        for (const uid of String(range).split(',').map(Number)) {
          if (serverCopies.has(uid)) yield { uid, envelope: { messageId: serverCopies.get(uid) } };
        }
      }),
      messageDelete: vi.fn().mockResolvedValue(true),
    });
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockResolvedValue({ rows: [account] });
    return { account, client };
  }
  afterEach(() => evictPool(`acct-pdm-${seq}`));

  it('deletes the uid when the server copy carries the expected Message-ID', async () => {
    const { account, client } = arrange(new Map([[7, '<old@example.test>']]));
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts', { expectMessageId: '<old@example.test>' })).toBe(true);
    expect(client.getMailboxLock).toHaveBeenCalledWith('Drafts');
    expect(client.messageDelete).toHaveBeenCalledWith('7', { uid: true });
  });

  it('compares Message-IDs without their angle brackets', async () => {
    const { account, client } = arrange(new Map([[7, '<old@example.test>']]));
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts', { expectMessageId: 'old@example.test' })).toBe(true);
    expect(client.messageDelete).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when another message now holds the uid', async () => {
    const { account, client } = arrange(new Map([[7, '<someone-elses@example.test>']]));
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts', { expectMessageId: '<old@example.test>' })).toBe(false);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it('deletes nothing when the uid is no longer on the server', async () => {
    const { account, client } = arrange(new Map());
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts', { expectMessageId: '<old@example.test>' })).toBe(false);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it.each([[null], ['']])('deletes nothing when the expected Message-ID is %j', async (expectMessageId) => {
    const { account, client } = arrange(new Map([[7, null]]));
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts', { expectMessageId })).toBe(false);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it('without an expected Message-ID deletes as before, with no extra FETCH', async () => {
    const { account, client } = arrange(new Map([[7, '<old@example.test>']]));
    expect(await ImapManager.prototype.permanentDeleteMessage.call({}, account, 7, 'Drafts')).toBe(true);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(client.messageDelete).toHaveBeenCalledWith('7', { uid: true });
  });
});

// ── ensureMailbox — provider-correct folder creation ─────────────────────────
// The namespace matrix (no-prefix + '/', 'INBOX.' + '.') is resolved INSIDE imapflow's
// normalizePath, which runs on mailboxCreate. So the unit here mocks mailboxCreate and
// asserts (a) we hand imapflow an ARRAY split on '/' — letting it join with the server
// delimiter and prepend the namespace prefix rather than us hand-joining — and (b) we
// surface imapflow's reported real path + created flag, treating already-exists (both the
// { created:false } return and a thrown "already exists") as success-not-created.

describe('ensureMailbox — namespace + already-exists matrix', () => {
  const clientReturning = (result) => ({ mailboxCreate: vi.fn().mockResolvedValue(result) });
  const clientThrowing = (err) => ({ mailboxCreate: vi.fn().mockRejectedValue(err) });

  it('flat server (no prefix, "/" delimiter): passes ["Todo"], surfaces the flat path as created', async () => {
    const client = clientReturning({ path: 'Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'Todo', created: true });
  });

  it('prefixed server ("INBOX." + "."): imapflow prefixes the array, we surface the real INBOX.Todo path', async () => {
    // imapflow's normalizePath turns ['Todo'] into 'INBOX.Todo' on a prefixed namespace
    // and returns it — we must report that, not the bare requested name.
    const client = clientReturning({ path: 'INBOX.Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'INBOX.Todo', created: true });
  });

  it('splits a nested name on "/" so imapflow joins with the server delimiter', async () => {
    const client = clientReturning({ path: 'INBOX.Work.Todo', created: true });
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('already-exists via imapflow ALREADYEXISTS return: created=false with the real path', async () => {
    // imapflow catches ALREADYEXISTS and returns { created:false } + the normalized path
    // (covers a case-insensitive server reporting an existing "todo" for a requested "Todo").
    const client = clientReturning({ path: 'INBOX.todo', created: false });
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'INBOX.todo', created: false });
  });

  it('already-exists via a thrown NO with serverResponseCode ALREADYEXISTS: treated as created=false', async () => {
    // Real imapflow shape (lib/tools.js enhanceCommandError + lib/imap-flow.js NO/BAD
    // handling): err.message is always the generic 'Command failed'; the server's text
    // lands in err.responseText and the RFC 5530 code in err.serverResponseCode.
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Mailbox already exists',
        serverResponseCode: 'ALREADYEXISTS',
      })
    );
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
  });

  it('already-exists via a thrown NO with only responseText (non-RFC5530 server): treated as created=false', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
    );
    const res = await ensureMailbox(client, 'Watch');
    expect(res).toEqual({ path: 'Watch', created: false });
  });

  it('re-throws an unrelated failure with a realistic responseText/serverResponseCode shape', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Quota exceeded',
        serverResponseCode: 'OVERQUOTA',
      })
    );
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Command failed');
  });

  it('re-throws an unrelated failure (e.g. over quota) rather than swallowing it', async () => {
    const client = clientThrowing(new Error('Over quota'));
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Over quota');
  });

  it('falls back to the requested name when imapflow returns no path', async () => {
    const client = clientReturning(undefined);
    const res = await ensureMailbox(client, 'Reference');
    expect(res).toEqual({ path: 'Reference', created: false });
  });
});

// ── ensureMailbox — case-insensitive casing resolution ────────────────────────
// On a case-insensitive server an existing "TODO" satisfies a "Todo" CREATE, but imapflow's
// already-exists result echoes the REQUESTED casing. Persisting that (planGtdFolderPersist)
// never case-matches the synced rows' folder value. With resolvePath set (only /folders/ensure,
// which persists), the already-exists branches resolve the real casing from the folder LIST;
// classify/snooze leave it off so they skip the extra round-trip.
describe('ensureMailbox — case-insensitive casing resolution', () => {
  it('ALREADYEXISTS return + resolvePath: resolves the server casing from LIST', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('plain-NO throw + resolvePath: resolves the casing from the bare requested name', async () => {
    const client = {
      mailboxCreate: vi.fn().mockRejectedValue(
        Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
      ),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
  });

  it('does NOT list without resolvePath — the hot classify path skips the round-trip', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
    expect(client.list).not.toHaveBeenCalled();
  });

  it('falls back to the known path when the LIST has no case-insensitive match', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'Inbox' }, { path: 'Sent' }]),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('never throws when the LIST itself fails — falls back to the input path', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockRejectedValue(new Error('LIST failed')),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('a freshly-created folder never triggers a lookup, even with resolvePath', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Todo', created: true }),
      list: vi.fn(),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'INBOX.Todo', created: true });
    expect(client.list).not.toHaveBeenCalled();
  });
});

// ── ensureMailbox — flat-namespace hierarchy guard ────────────────────────────
// A server whose personal-namespace delimiter is null cannot represent nesting: imapflow would
// join ['Projects','Todo'] with '' into "ProjectsTodo". Guard nested paths loudly, but only when
// the namespace is KNOWN to be flat (an unfetched namespace is left to imapflow).
describe('ensureMailbox — flat-namespace hierarchy guard', () => {
  it('throws a clear error for a nested path when the namespace delimiter is null', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn() };
    await expect(ensureMailbox(client, 'Projects/Todo')).rejects.toThrow(/hierarchy/i);
    expect(client.mailboxCreate).not.toHaveBeenCalled();
  });

  it('allows a single-segment name on a flat-namespace server', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: true }) };
    expect(await ensureMailbox(client, 'Todo')).toEqual({ path: 'Todo', created: true });
  });

  it('allows a nested path when the server advertises a hierarchy delimiter', async () => {
    const client = { namespace: { prefix: 'INBOX.', delimiter: '.' }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('does not guard a nested path when the namespace is unknown (bare client)', async () => {
    const client = { mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    expect(await ensureMailbox(client, 'Work/Todo')).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });
});

// ── emitSectionsChanged — generic label-feed refresh dispatch ─────────────────
// Core's generic notify: an ordinary mail mutation (delete/purge/backfill/flag flip) changed
// the messages table outside a label plugin's tick, so core dispatches the `sectionsChanged`
// hook and each active plugin decides whether to broadcast its own refresh. The wrapper's only
// job is the cheap changedCount gate + the dispatch; the GTD-specific enabled-gate + broadcast
// live in the plugin handler (see plugins/gtd/hooks.test.js). Here we assert the dispatch
// contract by spying on the registry.
describe('emitSectionsChanged', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dispatches the sectionsChanged hook with the mutation context when rows changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-sc-on', user_id: 'user-1' };
    await emitSectionsChanged(mgr, account, 4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('sectionsChanged', { mgr, account, changedCount: 4 });
  });

  it('never dispatches — no plugin work at all — when nothing changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    await emitSectionsChanged({ broadcast: vi.fn() }, { id: 'acct-sc-zero', user_id: 'user-1' }, 0);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── _startPluginSyncTimers / _stopPluginSyncTimers — plugin background ticks ──
// The GTD label-folder tick is now a plugin-declared background task; core just arms/tears down
// a jittered timer per active plugin, keyed `${accountId}::${pluginId}`. These assert the generic
// scheduler: it honors sync.isActive, fires the tick, and tears down per-account independently.

describe('_startPluginSyncTimers / _stopPluginSyncTimers', () => {
  const makeMgr = () => { const m = Object.create(ImapManager.prototype); m.pluginSyncIntervals = new Map(); m.pluginFacade = { __facade: true }; return m; };
  let listSpy;

  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { listSpy?.mockRestore(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('arms a jittered first fire then a steady interval for an active plugin tick', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    const account = { id: 'a1', user_id: 'u1', email_address: 'e@x' };
    await mgr._startPluginSyncTimers(account); // isActive is awaited before arming
    expect(tick).not.toHaveBeenCalled();     // still waiting on the (zeroed) jitter delay
    vi.advanceTimersByTime(1);               // jitter fires
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith({ mgr: mgr.pluginFacade, account }); // facade, not the raw engine
    vi.advanceTimersByTime(1000);            // one steady interval later
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('arms nothing for a plugin whose sync.isActive rejects the account', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'gated', sync: { intervalMs: 1000, isActive: (ctx) => ctx.account.on === true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a2', on: false });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('ignores a plugin with no sync descriptor', async () => {
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([{ id: 'routeronly' }]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a3' });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
  });

  it('tears down only the given account\'s timers', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a1', user_id: 'u1' });
    await mgr._startPluginSyncTimers({ id: 'a2', user_id: 'u1' });
    expect(mgr.pluginSyncIntervals.size).toBe(2);
    mgr._stopPluginSyncTimers('a1');
    expect(mgr.pluginSyncIntervals.has('a1::fake')).toBe(false);
    expect(mgr.pluginSyncIntervals.has('a2::fake')).toBe(true);
    expect(mgr.pluginSyncIntervals.size).toBe(1);
  });
});

// ── createKeyedSemaphore — per-host backfill concurrency cap ───────────────────

describe('createKeyedSemaphore', () => {
  it('runs up to `limit` holders per key concurrently', async () => {
    const sem = createKeyedSemaphore(2);
    await sem.acquire('h');
    await sem.acquire('h');
    expect(sem.activeCount('h')).toBe(2);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('queues acquirers beyond the limit until a release', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    let entered = false;
    const p = sem.acquire('h').then(() => { entered = true; });
    await Promise.resolve();
    expect(sem.waitingCount('h')).toBe(1);
    expect(entered).toBe(false);
    sem.release('h');
    await p;
    expect(entered).toBe(true);
    expect(sem.waitingCount('h')).toBe(0);
    expect(sem.activeCount('h')).toBe(1);
  });

  it('hands slots to waiters in FIFO order', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    const order = [];
    const a = sem.acquire('h').then(() => order.push('a'));
    const b = sem.acquire('h').then(() => order.push('b'));
    await Promise.resolve();
    sem.release('h');
    await a;
    sem.release('h');
    await b;
    expect(order).toEqual(['a', 'b']);
  });

  it('treats different keys independently', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h1');
    await sem.acquire('h2'); // different host — not blocked by h1 being full
    expect(sem.activeCount('h1')).toBe(1);
    expect(sem.activeCount('h2')).toBe(1);
  });

  it('cleans up the entry once fully released', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    sem.release('h');
    expect(sem.activeCount('h')).toBe(0);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('release is a safe no-op for an unknown key', () => {
    const sem = createKeyedSemaphore(1);
    expect(() => sem.release('never-acquired')).not.toThrow();
  });

  it('resolves the limit per key when given a function', async () => {
    const sem = createKeyedSemaphore(key => (key === 'tight' ? 1 : 2));
    await sem.acquire('tight');
    let entered = false;
    const waiting = sem.acquire('tight').then(() => { entered = true; });
    await sem.acquire('wide');
    await sem.acquire('wide');
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(sem.activeCount('wide')).toBe(2);
    sem.release('tight');
    await waiting;
    expect(entered).toBe(true);
  });

  it('tryAcquire takes a free slot and refuses a full key without queueing', async () => {
    const sem = createKeyedSemaphore(1);
    expect(sem.tryAcquire('h')).toBe(true);
    expect(sem.tryAcquire('h')).toBe(false);
    expect(sem.waitingCount('h')).toBe(0);
    sem.release('h');
    expect(sem.activeCount('h')).toBe(0);
  });
});

// ── connection-refusal cooldown ───────────────────────────────────────────────

describe('isConnectionRefusal', () => {
  it.each([
    'Connection not available',
    'Too many simultaneous connections',
    'Maximum number of connections exceeded',
    'Please try again later',
    'Account temporarily locked',
    'THROTTLED: too many requests',
    'rate limit exceeded',
    'Fresh sync connect timeout (30000ms)',
    // RFC 5530 codes that refuse for load or availability, whatever text the server adds (#433).
    '[LIMIT] LOGIN error',
    '[UNAVAILABLE] LOGIN failure. Server error',
    '[INUSE] Mailbox is locked',
  ])('flags a refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(true);
  });

  it.each([
    ['Invalid credentials'],
    ['[AUTHENTICATIONFAILED] Invalid credentials (Failure)'],
    ['[NONEXISTENT] Unknown Mailbox: Archive'],
    ['Mailbox does not exist'],
    ['ECONNRESET'],
    // Mid-operation timeouts are NOT connection-limit signals — must stay retry-normal.
    ['Socket timeout'],
    ['Fresh sync wall-clock timeout (55000ms)'],
    [''],
    [null],
    [undefined],
  ])('does not flag a non-refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(false);
  });
});

describe('parsePersistentCap', () => {
  it('parses a positive integer as the cap', () => {
    expect(parsePersistentCap('5')).toBe(5);
    expect(parsePersistentCap('1')).toBe(1);
  });
  it.each(['0', '-3', '', 'abc', null, undefined, ' '])('treats %s as unlimited', (raw) => {
    expect(parsePersistentCap(raw)).toBe(Infinity);
  });
});

describe('resolvePersistentCap', () => {
  it('is unlimited when neither env nor profile caps', () => {
    expect(resolvePersistentCap(Infinity, undefined)).toBe(Infinity);
  });
  it('uses whichever cap is set', () => {
    expect(resolvePersistentCap(Infinity, 4)).toBe(4);
    expect(resolvePersistentCap(6, undefined)).toBe(6);
  });
  it('takes the tighter of the two', () => {
    expect(resolvePersistentCap(10, 3)).toBe(3);
    expect(resolvePersistentCap(2, 8)).toBe(2);
  });
  it('ignores non-positive caps', () => {
    expect(resolvePersistentCap(0, 0)).toBe(Infinity);
  });
});

describe('persistentEligible', () => {
  const host = ['a', 'b', 'c', 'd']; // stable order (created_at, then id)
  it('is always eligible when the cap is unlimited or non-positive', () => {
    expect(persistentEligible(host, 'd', Infinity)).toBe(true);
    expect(persistentEligible(host, 'd', 0)).toBe(true);
  });
  it('keeps the first `cap` accounts persistent and demotes the rest', () => {
    expect(persistentEligible(host, 'a', 2)).toBe(true);
    expect(persistentEligible(host, 'b', 2)).toBe(true);
    expect(persistentEligible(host, 'c', 2)).toBe(false); // surplus → poll-only
    expect(persistentEligible(host, 'd', 2)).toBe(false);
  });
  it('fails safe to eligible for an account not in the host list', () => {
    expect(persistentEligible(host, 'zz', 2)).toBe(true);
  });
});

describe('shouldRetryIPv4', () => {
  const dual = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  it('retries IPv4-only on a timeout for a dual-stack host', () => {
    expect(shouldRetryIPv4('IMAP connect timeout (30000ms)', dual)).toBe(true);
    expect(shouldRetryIPv4('Reconnect timeout (40000ms)', dual)).toBe(true);
  });
  it('does not retry when the failure was not a timeout (auth/refusal/cert)', () => {
    expect(shouldRetryIPv4('Invalid credentials', dual)).toBe(false);
    expect(shouldRetryIPv4('Too many simultaneous connections', dual)).toBe(false);
    expect(shouldRetryIPv4('self signed certificate', dual)).toBe(false);
  });
  it('does not retry when the host is single-family (nothing to fall back to)', () => {
    expect(shouldRetryIPv4('connect timeout', ['93.184.216.34'])).toBe(false);            // v4-only
    expect(shouldRetryIPv4('connect timeout', ['2606:2800:220:1::1'])).toBe(false);       // v6-only
    expect(shouldRetryIPv4('connect timeout', [])).toBe(false);
    expect(shouldRetryIPv4('connect timeout', undefined)).toBe(false);
  });
  it('handles empty/nullish error messages', () => {
    expect(shouldRetryIPv4('', dual)).toBe(false);
    expect(shouldRetryIPv4(null, dual)).toBe(false);
  });
  it('does not retry when a provider refusal was seen during the attempt (#384)', () => {
    // A timeout on a dual-stack host would normally retry, but a refusal means back off instead.
    expect(shouldRetryIPv4('connect timeout', dual, true)).toBe(false);
    expect(shouldRetryIPv4('connect timeout', dual, false)).toBe(true);
  });
});

describe('connectCooldownMs', () => {
  it('grows exponentially from 30s and caps at 15 min', () => {
    expect(connectCooldownMs(1)).toBe(30_000);
    expect(connectCooldownMs(2)).toBe(60_000);
    expect(connectCooldownMs(3)).toBe(120_000);
    expect(connectCooldownMs(4)).toBe(240_000);
    expect(connectCooldownMs(5)).toBe(480_000);
    expect(connectCooldownMs(6)).toBe(900_000); // 960k clamped to the 15-min cap
    expect(connectCooldownMs(20)).toBe(900_000);
  });

  it('treats 0 / negative failures as at least one', () => {
    expect(connectCooldownMs(0)).toBe(30_000);
    expect(connectCooldownMs(-3)).toBe(30_000);
  });
});

// ── effectiveSyncIntervalMs — provider interval clamp ─────────────────────────

describe('effectiveSyncIntervalMs', () => {
  it('clamps to the provider cap when the requested interval is longer', () => {
    // PurelyMail uses IDLE for instant push; the periodic tick is only a ~2-min backstop cap.
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 300000)).toBe(120000);
  });

  it('leaves a faster-than-cap request untouched', () => {
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 5000)).toBe(5000);
  });

  it('passes the requested interval through for providers without a cap', () => {
    expect(effectiveSyncIntervalMs(account('imap.fastmail.com'), 60000)).toBe(60000);
    expect(effectiveSyncIntervalMs(account('imap.gmail.com'), 120000)).toBe(120000);
  });
});

// ── folderSyncDue — periodic folder-structure sync gate ──────────────────────

describe('folderSyncDue', () => {
  it('is due immediately when the account has never folder-synced', () => {
    expect(folderSyncDue(1800000, undefined, 5000000)).toBe(true);
  });

  it('is not due again within the interval', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1799999)).toBe(false);
  });

  it('is due once the interval has elapsed', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1800000)).toBe(true);
  });

  it('never fires when disabled (0 = never)', () => {
    expect(folderSyncDue(0, undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// ── connectStaggerFor — initial connect pacing (#218) ─────────────────────────

describe('connectStaggerFor', () => {
  it('spaces a connection-sensitive provider (PurelyMail) wider than a lenient one (Gmail)', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(pm, 1)).toBeGreaterThan(connectStaggerFor(gmail, 1));
  });

  it('widens the gap as account count grows, capped at 2x the base', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 100)).toBeGreaterThan(connectStaggerFor(pm, 1));
    expect(connectStaggerFor(pm, 100)).toBe(2400); // 1200 base x capped factor 2
  });

  it('defaults to a 200ms base for providers without an explicit stagger (Gmail)', () => {
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(gmail, 1)).toBe(208); // 200 x (1 + 1/25)
  });

  it('never drops below the base for an empty account list', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 0)).toBe(1200);
  });
});

// ── planModseqSync — CONDSTORE delta-sync strategy decision ────────────────────

describe('planModseqSync', () => {
  it('forces a full sync when the local cache is empty but a nonempty server has an equal modseq', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('forces a full sync when the local cache is empty and the server modseq advanced', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '101',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('leaves an empty local cache and empty server unchanged when the modseqs match', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 0,
    })).toBe('unchanged');
  });

  it('retains the existing CONDSTORE plans when the local cache has a UID watermark', () => {
    const localState = { maxKnownUid: 50, serverExists: 50 };
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '101', uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: null, serverModseq: '100', uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

  it('falls back to full sync when there is no stored baseline (first sync / seed)', () => {
    expect(planModseqSync({ storedModseq: null, serverModseq: '42', uidValidityChanged: false })).toBe('full');
  });

  it('falls back to full sync when the server has no modseq (no CONDSTORE)', () => {
    expect(planModseqSync({ storedModseq: '42', serverModseq: null, uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ storedModseq: null, serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

  it('forces full sync on a UIDVALIDITY change even when the modseqs happen to match', () => {
    // modseq is only comparable within a UIDVALIDITY epoch — a matching value across a
    // reset must NOT be treated as "nothing changed".
    expect(planModseqSync({ storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ storedModseq: '100', serverModseq: '200', uidValidityChanged: true })).toBe('full');
  });

  it('returns "unchanged" when the stored watermark equals the server modseq', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '500', uidValidityChanged: false })).toBe('unchanged');
  });

  it('returns "delta" when the server modseq has advanced', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '501', uidValidityChanged: false })).toBe('delta');
  });

  it('accepts BigInt and string interchangeably (ImapFlow yields BigInt, pg yields string)', () => {
    expect(planModseqSync({ storedModseq: '77', serverModseq: 77n, uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ storedModseq: 77n, serverModseq: '78', uidValidityChanged: false })).toBe('delta');
  });

  it('compares in BigInt so values above 2^53 stay exact (a JS Number would collapse them)', () => {
    // 9007199254740993 and ...992 are indistinguishable as JS Numbers (both round to 2^53).
    const a = '9007199254740992';
    const b = '9007199254740993';
    expect(Number(a) === Number(b)).toBe(true);            // the trap we must avoid
    expect(planModseqSync({ storedModseq: a, serverModseq: b, uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ storedModseq: b, serverModseq: b, uidValidityChanged: false })).toBe('unchanged');
  });
});

// ── syncMessages — empty-cache/modseq wiring ─────────────────────────────────

describe('syncMessages — empty local cache vs nonempty server (wiring)', () => {
  beforeEach(() => {
    query.mockReset();
    parseMessage.mockReset();
    ['acct-sync-empty-cache', 'acct-sync-watermark'].forEach(invalidateGtdConfigCache);
  });

  it('empty cache forces the full metadata scan', async () => {
    const account = {
      id: 'acct-sync-empty-cache',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () { yield { uid: 501 }; }),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes("key = 'categorization_enabled'")) return Promise.resolve({ rows: [{ value: 'false' }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'msg-1', is_new: true }] });
      if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockResolvedValue({
      uid: 501,
      messageId: null,
      subject: 'Watch first message',
      fromName: 'External',
      fromEmail: 'them@example.com',
      to: [],
      cc: [],
      replyTo: [],
      inReplyTo: null,
      references: null,
      date: new Date('2026-07-17T10:00:00Z'),
      snippet: 'hi',
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      flags: ['\\Seen'],
      isBulk: false,
      parsedHeaders: {},
    });

    const result = await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'Watch', 50, false, true);

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0][0]).toBe('1:*');
    expect(client.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      envelope: true,
      bodyStructure: true,
      flags: true,
      uid: true,
    }));
    expect(client.fetch.mock.calls[0][2]).toBeUndefined();
    const insertIndex = query.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO messages'));
    const modseqUpdateIndex = query.mock.calls.findIndex(([sql]) => sql.includes('UPDATE folders SET highest_modseq'));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(modseqUpdateIndex).toBeGreaterThan(insertIndex);
    expect(result).toEqual(expect.objectContaining({ insertedCount: 1 }));
  });

  it('populated cache keeps the old UID-watermark behavior', async () => {
    const account = {
      id: 'acct-sync-watermark',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 50, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 50 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'Watch', 50, false, true);

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch).toHaveBeenCalledWith(
      '51:*',
      expect.objectContaining({ envelope: true, bodyStructure: true }),
      { uid: true }
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
    // A moved row waiting for its MOVE holds a negative placeholder uid (moveQueue.js). In a
    // folder holding only such rows the watermark would go negative and the new-mail phase would
    // be skipped, so they stay out of it.
    const watermark = query.mock.calls.find(([sql]) => sql.includes('COALESCE(MAX(uid), 0)'))[0];
    expect(watermark).toMatch(/AND uid > 0/);
  });

  it('hands a newly-inserted INBOX row to the inboxIngest hook when a plugin is active', async () => {
    // wire: an active inbox-ingest plugin makes syncMessages collect the new row's id and
    // dispatch runHook('inboxIngest', …). We spy the registry rather than register a real
    // plugin so the singleton stays clean for other suites.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockImplementation(async (name) => name === 'inboxIngest');
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: true, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
          return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        }
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
          return Promise.resolve({ rows: [{ gtd_enabled: true, gtd_folders: {} }] });
        }
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'ingest-1', is_new: true }] });
        if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });
      // Arrived already \Seen, so it never enters the unread notification list — it must still
      // reach inboxIngest via the read-inclusive candidate set.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in1@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      const mgr = { ...noMoves(), pluginFacade: { __facade: true } };
      await ImapManager.prototype.syncMessages.call(mgr, account, client, 'INBOX', 50, false, true);

      expect(hasActive).toHaveBeenCalledWith('inboxIngest', { account });
      // The hook receives the bounded facade, never the raw engine (`this`).
      expect(runHook).toHaveBeenCalledWith('inboxIngest', {
        mgr: mgr.pluginFacade, account, newInboxIds: ['ingest-1'], deletedIds: new Set(),
      });
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });

  it('does not dispatch inboxIngest when no ingest plugin is active', async () => {
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-no-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'x', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in2@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'INBOX', 50, false, true);
      expect(runHook).not.toHaveBeenCalledWith('inboxIngest', expect.anything());
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('syncMessages — EOP category (R-41)', () => {
  // The reading pane shows a phishing letter in safe mode wherever it lies, from the CAT field of
  // X-Forefront-Antispam-Report. The sync already fetches every header, so it stores the category.
  async function syncOne(parsedHeaders) {
    const account = {
      id: 'acct-eop', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () { yield { uid: 501 }; }),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'x', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockResolvedValue({
      uid: 501, messageId: '<eop@x>', subject: 'Verify your account', fromName: 'Bank', fromEmail: 'bank@example.net',
      to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-10-01T10:00:00Z'),
      snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders,
    });
    await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'INBOX', 50, false, true);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO messages'));
    // The category is the last parameter, bound to the eop_category column.
    expect(sql).toMatch(/threading_reason,\s*eop_category\s*\) VALUES \([^)]*\$32,\$34\)/);
    expect(sql).toContain('eop_category = COALESCE(EXCLUDED.eop_category, messages.eop_category)');
    return params[33];
  }

  it('stores the CAT of the report', async () => {
    expect(await syncOne({ 'x-forefront-antispam-report': 'CIP:203.0.113.5;SFV:SPM;CAT:PHSH;DIR:INB;' })).toBe('PHSH');
  });

  it('stores nothing for a letter without the report', async () => {
    expect(await syncOne({})).toBeNull();
  });
});

describe('syncMessages — the mailbox\'s last received mail (email_accounts.last_received_at)', () => {
  // The sidebar orders mailboxes by the newest ARRIVAL into the INBOX: a letter stored for the first
  // time, read or unread, whatever becomes of it afterwards.
  async function syncOne({ folder = 'INBOX', isNew = true, isRead = true, date = new Date('2026-10-01T10:00:00Z') } = {}) {
    const account = {
      id: 'acct-lr', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () { yield { uid: 501 }; }),
    };
    query.mockReset();
    sendPushToActiveUsers.mockResolvedValue();
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'x', is_new: isNew }] });
      if (sql.includes('UPDATE email_accounts') && sql.includes('last_received_at')) {
        return Promise.resolve({ rows: [{ last_received_at: date.toISOString() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockReset();
    parseMessage.mockResolvedValue({
      uid: 501, messageId: '<lr@x>', subject: 'Hello', fromName: 'Pat', fromEmail: 'pat@example.net',
      to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date,
      snippet: 'hi', isRead, isStarred: false, hasAttachments: false, flags: isRead ? ['\\Seen'] : [], isBulk: false, parsedHeaders: {},
    });
    const mgr = {
      ...noMoves(), broadcast: vi.fn(), scheduleCountRefresh: vi.fn(),
      // What an unread arrival sets going afterwards: not under test here.
      prefetchNewMessageBodies: vi.fn(() => Promise.resolve()), upsertAutoContacts: vi.fn(() => Promise.resolve()),
    };
    await ImapManager.prototype.syncMessages.call(mgr, account, client, folder, 50, false, true);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE email_accounts') && sql.includes('last_received_at'));
    return { update, events: mgr.broadcast.mock.calls.map(([event]) => event) };
  }

  it('records a letter that arrived already read, and tells the clients (new_messages would not)', async () => {
    const { update, events } = await syncOne({ isRead: true });
    expect(update[1]).toEqual(['acct-lr', '2026-10-01T10:00:00.000Z']);
    expect(events.find(e => e.type === 'account_received')).toEqual({
      type: 'account_received', accountId: 'acct-lr', lastReceivedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(events.some(e => e.type === 'new_messages')).toBe(false);
  });

  it('records an unread arrival too', async () => {
    const { update, events } = await syncOne({ isRead: false });
    expect(update).toBeTruthy();
    expect(events.some(e => e.type === 'account_received')).toBe(true);
  });

  it('records nothing for a letter the mailbox already had', async () => {
    const { update, events } = await syncOne({ isNew: false });
    expect(update).toBeUndefined();
    expect(events.some(e => e.type === 'account_received')).toBe(false);
  });

  it('records nothing for mail stored in another folder: only the inbox receives', async () => {
    const { update } = await syncOne({ folder: 'Archive' });
    expect(update).toBeUndefined();
  });
});

describe('syncMessages — unread_count recompute ordering (folder badge fix)', () => {
  it('recomputes folders.unread_count from rows AFTER inserting new messages', async () => {
    // The provisional unread_count written before the fetch left on-demand folders (e.g. Junk)
    // showing a stale badge until their next sync. syncMessages must recompute from actual rows
    // AFTER the INSERT so the cached count reflects the just-synced messages.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-junk', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockReset();
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'new-1', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockReset();
      // Already-\Seen so the message doesn't enter the new-mail notification path (which needs a
      // broadcast stub); it is still INSERTed, which is all the ordering assertion needs.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<n1@x>', subject: 'Spam', fromName: 'Sketchy', fromEmail: 's@x.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-08-20T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call({ ...noMoves(), pluginFacade: {} }, account, client, 'Junk', 100, false, true);

      const calls = query.mock.calls.map(c => c[0]);
      const insertIdx = calls.findIndex(sql => sql.includes('INSERT INTO messages'));
      const recomputeIdx = calls.findIndex(sql =>
        sql.includes('UPDATE folders') && sql.includes('unread_count = (SELECT COUNT(*) FILTER (WHERE m.is_read = false)'));
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeIdx).toBeGreaterThan(insertIdx);            // recompute strictly after insert
      expect(query.mock.calls[recomputeIdx][1]).toEqual(['acct-junk', 'Junk']); // scoped to this folder
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('_syncSpamFolder — periodic spam poll guards', () => {
  const account = { id: 'a1', user_id: 'u1', folder_mappings: null, imap_host: 'imap.example.com' };

  it('no-ops when the account has no resolvable spam folder', async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] }); // resolveSpamFolder finds nothing
    const ctx = { onDemandSyncing: new Set(), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('skips when an on-demand sync of that spam folder is already running (no collision)', async () => {
    query.mockReset();
    // resolveSpamFolder's special-use lookup (identified by its name-regex clause) yields "Junk".
    query.mockImplementation((sql) =>
      sql.includes('lower(name) ~') ? Promise.resolve({ rows: [{ path: 'Junk' }] }) : Promise.resolve({ rows: [] }));
    const ctx = { onDemandSyncing: new Set(['a1:Junk']), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ctx.onDemandSyncing.has('a1:Junk')).toBe(true); // guard left intact for the running sync
  });
});

describe('walkStructure attachment classification', () => {
  const walk = (node) => {
    const results = { textParts: [], attachments: [] };
    walkStructure(node, results);
    return results;
  };

  it('strips each bidi control character from an attachment name, not only the whole sequence', () => {
    // RLO turns "invoice<RLO>fdp.exe" into "invoiceexe.pdf" on screen. Each control
    // character must be removed on its own wherever it appears.
    const named = (filename) => walk({
      part: '2', type: 'application/octet-stream', encoding: 'base64',
      disposition: 'attachment', dispositionParameters: { filename }, size: 10,
    }).attachments[0].filename;
    expect(named('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(named('⁧report⁩.pdf‏')).toBe('report.pdf');
    expect(named('؜‪‫‬‭⁦⁨')).toBe('attachment');
  });

  it('treats an attached HTML file as an attachment, not body text', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
        {
          part: '2', type: 'text/html', encoding: 'base64',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.html' },
          size: 2048,
        },
      ],
    });
    expect(results.textParts).toHaveLength(1);
    expect(results.textParts[0].type).toBe('text/plain');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({
      part: '2', filename: 'report.html', type: 'text/html', encoding: 'base64',
    });
  });

  it('treats an attached text file as an attachment', () => {
    const results = walk({
      part: '2', type: 'text/plain', encoding: 'base64',
      disposition: 'attachment',
      dispositionParameters: { filename: 'server.log' },
    });
    expect(results.textParts).toHaveLength(0);
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('server.log');
  });

  it('still treats undisposed HTML parts as the message body', () => {
    const results = walk({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/html', encoding: 'quoted-printable' },
      ],
    });
    expect(results.textParts.map(p => p.type)).toEqual(['text/plain', 'text/html']);
    expect(results.attachments).toHaveLength(0);
  });

  it('attachment-disposed images are attachments; cid images stay inline', () => {
    const results = walk({
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', encoding: '7bit' },
        { part: '2', type: 'image/png', encoding: 'base64', id: '<logo@x>' },
        {
          part: '3', type: 'image/jpeg', encoding: 'base64',
          disposition: 'attachment', dispositionParameters: { filename: 'photo.jpg' },
        },
      ],
    });
    expect(results.inlineImages).toHaveLength(1);
    expect(results.inlineImages[0].cid).toBe('logo@x');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('photo.jpg');
  });

  it('named non-text parts without a disposition are still attachments', () => {
    const results = walk({
      part: '2', type: 'application/pdf', encoding: 'base64',
      parameters: { name: 'invoice.pdf' },
    });
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('invoice.pdf');
  });

  it('treats an inline-disposed named HTML file alongside a body as an attachment', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html', encoding: 'quoted-printable' },
        {
          part: '2', type: 'text/html', encoding: 'base64', size: 4096,
          disposition: 'inline', dispositionParameters: { filename: 'report.html' },
        },
      ],
    });
    expect(results.textParts.map(p => p.part)).toEqual(['1']);
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({
      part: '2', filename: 'report.html', type: 'text/html', encoding: 'base64', size: 4096,
    });
  });

  it('treats an undisposed text part named via Content-Type as an attachment', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/plain', encoding: '7bit', parameters: { name: 'server.log' } },
      ],
    });
    expect(results.textParts.map(p => p.part)).toEqual(['1']);
    expect(results.attachments.map(a => a.filename)).toEqual(['server.log']);
    expect(results.attachments[0].encoding).toBe('7bit');
  });

  it('keeps named text parts as body when no unnamed body part exists', () => {
    const results = walk({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', parameters: { name: 'body.txt' } },
        { part: '2', type: 'text/html', encoding: '7bit', parameters: { name: 'body.html' } },
      ],
    });
    expect(results.textParts.map(p => p.type)).toEqual(['text/plain', 'text/html']);
    expect(results.attachments).toHaveLength(0);
  });

  it('records an unnamed single-part text/calendar root as a calendar part, not body text (#423)', () => {
    const results = walk({ type: 'text/calendar', encoding: '7bit', parameters: { method: 'REQUEST', charset: 'utf-8' } });
    expect(results.textParts).toHaveLength(0);
    expect(results.attachments).toHaveLength(0);
    expect(results.calendarParts).toEqual([{ part: '1', encoding: '7bit', charset: 'utf-8' }]);
  });

  it('keeps a named text/calendar part as an attachment and also records it as a calendar part (#423)', () => {
    const results = walk({
      type: 'text/calendar', encoding: 'base64', parameters: { method: 'REQUEST', name: 'meeting.ics' },
    });
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({ part: '1', filename: 'meeting.ics', type: 'text/calendar', encoding: 'base64' });
    expect(results.calendarParts.map(p => p.part)).toEqual(['1']);
  });

  it('does not treat an attachment-disposed text/calendar part as a calendar body candidate (#423)', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/calendar', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'invite.ics' } },
      ],
    });
    expect(results.calendarParts).toBeUndefined();
    expect(results.attachments.map(a => a.filename)).toEqual(['invite.ics']);
  });
});

describe('planBodyParts — body part selection (#423)', () => {
  it('uses html/plain parts and ignores the calendar part for a Google Calendar invite', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1', type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'UTF-8' } },
            { part: '1.2', type: 'text/html', encoding: 'quoted-printable', parameters: { charset: 'UTF-8' } },
            { part: '1.3', type: 'text/calendar', encoding: '7bit', parameters: { charset: 'UTF-8', method: 'REQUEST' } },
          ],
        },
        { part: '2', type: 'application/ics', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'invite.ics' } },
      ],
    });
    expect(plan.textParts.map(p => [p.part, p.type])).toEqual([['1.1', 'text/plain'], ['1.2', 'text/html']]);
    expect(plan.attachments.map(a => a.filename)).toEqual(['invite.ics']);
  });

  it('plans the calendar part with its own encoding when there is no text body', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/calendar', encoding: 'base64', parameters: { charset: 'utf-8', method: 'REQUEST' } },
        { part: '2', type: 'application/ics', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'invite.ics' } },
      ],
    });
    expect(plan.textParts).toEqual([{ part: '1', type: 'text/calendar', encoding: 'base64', charset: 'utf-8' }]);
  });

  it('serves a multipart root without text or calendar parts using the first leaf encoding, not the root', () => {
    const plan = planBodyParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'application/octet-stream', encoding: 'base64', parameters: { charset: 'windows-1252' } },
        { part: '2', type: 'application/pgp-signature', encoding: '7bit' },
      ],
    });
    expect(plan.textParts).toEqual([{ part: '1', type: 'text/plain', encoding: 'base64', charset: 'windows-1252' }]);
  });

  it('plans no body when every part was filed as an attachment', () => {
    const plan = planBodyParts({ type: 'text/html', encoding: 'quoted-printable', disposition: 'attachment', parameters: { charset: 'iso-8859-1' } });
    expect(plan.textParts).toEqual([]);
    expect(plan.attachments.map(a => [a.part, a.type])).toEqual([['1', 'text/html']]);
  });
});

describe('extractBodyFromMsg — calendar-only invites (#423)', () => {
  const OUTLOOK_FORWARD_ICS = [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'ORGANIZER;CN=Jane Roe:mailto:jane@example.com',
    'SUMMARY:Design review',
    'DTSTART;TZID=W. Europe Standard Time:20260915T100000',
    'DTEND;TZID=W. Europe Standard Time:20260915T110000',
    'LOCATION:Microsoft Teams Meeting',
    'DESCRIPTION:Join the meeting:\\nhttps://teams.microsoft.com/l/meetup-join/19%3ameeting',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  it('renders a base64 calendar-only message as an invite card instead of raw VCALENDAR', () => {
    const body = extractBodyFromMsg({
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/calendar', encoding: 'base64', parameters: { charset: 'utf-8', method: 'REQUEST' } },
          { part: '2', type: 'application/ics', encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'invite.ics' } },
        ],
      },
      bodyParts: new Map([['1', Buffer.from(Buffer.from(OUTLOOK_FORWARD_ICS).toString('base64').replace(/.{76}/g, '$&\r\n'))]]),
    });
    expect(body.html).toContain('Design review');
    expect(body.html).toContain('https://teams.microsoft.com/l/meetup-join/19%3ameeting');
    expect(body.html).not.toContain('BEGIN:VEVENT');
    expect(body.text).toContain('Design review');
    expect(body.text).not.toContain('BEGIN:VCALENDAR');
    expect(body.attachments.map(a => a.filename)).toEqual(['invite.ics']);
  });

  it('falls back to the raw calendar text when the part has no VEVENT', () => {
    const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:Todo\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
    const body = extractBodyFromMsg({
      bodyStructure: { type: 'text/calendar', encoding: '7bit', parameters: { charset: 'utf-8' } },
      bodyParts: new Map([['1', Buffer.from(raw)]]),
    });
    expect(body.html).toBeNull();
    expect(body.text).toBe(raw);
  });

  it('falls back to the raw calendar text when rendering throws', async () => {
    const icsInvite = await import('./icsInvite.js');
    const spy = vi.spyOn(icsInvite, 'renderInviteHtml').mockImplementation(() => { throw new RangeError('Invalid time value'); });
    const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    try {
      const body = extractBodyFromMsg({
        bodyStructure: { type: 'text/calendar', encoding: '7bit', parameters: { charset: 'utf-8' } },
        bodyParts: new Map([['1', Buffer.from(raw)]]),
      });
      expect(body.html).toBeNull();
      expect(body.text).toBe(raw);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the body empty when the calendar part was not prefetched so on-demand fetch runs', () => {
    const body = extractBodyFromMsg({
      bodyStructure: { type: 'text/calendar', encoding: '7bit' },
      bodyParts: new Map(),
    });
    expect(body).toEqual({ html: null, text: null, attachments: [] });
  });
});

describe('attachment-only messages have no body', () => {
  const zipRoot = {
    part: '1', type: 'application/zip', encoding: 'base64', size: 1024,
    disposition: 'attachment',
    dispositionParameters: { filename: 'google.com!example.com!1.zip' },
  };

  it('does not serve a single-part attachment root as the message text', () => {
    // A DMARC aggregate report: the whole message is one application/zip part.
    const msg = { bodyStructure: zipRoot, bodyParts: new Map([['1', Buffer.from('UEsDBBQ=')]]) };
    const body = extractBodyFromMsg(msg);
    expect(body.html).toBeNull();
    expect(body.text).toBeNull();
    expect(body.attachments.map(a => a.filename)).toEqual(['google.com!example.com!1.zip']);
  });

  it('does not fall back to the first part of a multipart holding only a file', () => {
    const results = { textParts: [], attachments: [] };
    walkStructure({ type: 'multipart/mixed', childNodes: [zipRoot] }, results);
    expect(results.textParts).toHaveLength(0);
    expect(bodyFallbackApplies(results)).toBe(false);
  });

  it('still promotes a bare unrecognized single part to text', () => {
    const msg = {
      bodyStructure: { part: '1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'utf-8' } },
      bodyParts: new Map([['1', Buffer.from('hello')]]),
    };
    expect(extractBodyFromMsg(msg).text).toBe('hello');
    expect(bodyFallbackApplies({ textParts: [], attachments: [] })).toBe(true);
  });
});

// ── _shouldAutoBackfillOnConnect — auto-backfill gate (#354) ──────────────────
// The gate itself was always correct; #354 was the connect flow evaluating it
// AFTER the initial INBOX sync inserted rows. These lock the gate contract:
// providers without the flag always backfill; PurelyMail backfills only when the
// account is genuinely empty (which connectAccount now captures pre-sync).

describe('_shouldAutoBackfillOnConnect (#354)', () => {
  const gate = acct => ImapManager.prototype._shouldAutoBackfillOnConnect.call({}, acct);
  beforeEach(() => vi.clearAllMocks());

  it('always backfills a provider without autoBackfillExistingOnConnect:false, without a DB check', async () => {
    await expect(gate({ imap_host: 'mail.example.com', id: 'a1' })).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('backfills a fresh PurelyMail account with no cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(true);
  });

  it('skips backfill for a PurelyMail account that already has cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(false);
  });
});

// ── #360: 'error' listener attached before connect() ─────────────────────────
// An ImapFlow 'error' emitted during the connection handshake (e.g. a socket timeout,
// raised from a detached timer callback) with no listener is an unhandled EventEmitter
// error — Node throws and the whole process dies, taking every account down, not just the
// one connecting. connectAccount must therefore register its 'error' handler BEFORE it
// awaits connect(). This test locks in that ordering: it inspects listenerCount('error')
// at the exact moment connect() is invoked and confirms a handshake-time emission is
// absorbed rather than thrown.
describe("connectAccount attaches 'error' before connect (#360)", () => {
  beforeEach(() => vi.clearAllMocks());

  it('has an error listener at connect() time and absorbs a handshake error', async () => {
    let errorListenersAtConnect = -1;
    let emitThrew = false;

    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => {
        errorListenersAtConnect = client.listenerCount('error');
        // Simulate a transport 'error' during the handshake. With the listener already
        // attached this is a logged no-op; without it, emit() throws synchronously —
        // which is exactly the process-killing #360 crash.
        try { client.emit('error', new Error('Socket timeout')); } catch { emitThrew = true; }
        return Promise.resolve();
      });
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      return client;
    });

    // PurelyMail host: preferFreshBodyFetch skips the pool pre-warm and its private
    // acquirePooledClient (which would build a second mock client), keeping this test to
    // the single connectAccount code path under test.
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const mgr = new ImapManager(null);
    clearInterval(mgr._healthCheckTimer);
    clearInterval(mgr._snippetSchedulerTimer);
    clearInterval(mgr._providerIdSchedulerTimer);
    // Stub the post-connect fan-out — this test asserts only the listener-ordering
    // invariant, not folder/message sync behavior.
    mgr.disconnectAccount = vi.fn(() => Promise.resolve());
    mgr._attachIdleListeners = vi.fn();
    mgr.syncFolders = vi.fn(() => Promise.resolve());
    mgr.syncMessages = vi.fn(() => Promise.resolve());
    mgr._shouldAutoBackfillOnConnect = vi.fn(() => Promise.resolve(false));
    mgr.backfillAllFolders = vi.fn(() => Promise.resolve());
    mgr._startSyncInterval = vi.fn();
    mgr.broadcast = vi.fn();

    const acct = { id: 1, user_id: 1, imap_host: 'imap.purelymail.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const ok = await mgr.connectAccount(acct);

    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(errorListenersAtConnect).toBeGreaterThanOrEqual(1);
    expect(emitThrew).toBe(false);
  });
});

describe('account error reporting: transient failures must not paint the account red', () => {
  const account = { id: 'acct-1', user_id: 'u1', email_address: 'a@example.com' };
  const ctx = () => ({ _syncErrorState: new Map(), _accountErrorStreak: new Map(), broadcast: vi.fn() });

  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it('says nothing on a single connection refusal', async () => {
    // The defect: a provider that refuses every few minutes and reconnects 45s later left the
    // account showing a connection error 10-15% of the time, permanently, for something the
    // user could do nothing about and that always healed itself.
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(query).not.toHaveBeenCalled();
    expect(self.broadcast).not.toHaveBeenCalled();
  });

  it('reports once a refusal repeats, because that is a real outage', async () => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(query).toHaveBeenCalledTimes(1);
    expect(self.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account_error', accountId: 'acct-1' }));
  });

  it('a success between refusals resets the run, so routine pushback never accumulates', async () => {
    // Without this an account that refuses once an hour would surface an error on the second
    // hour, having been perfectly healthy in between.
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    await ImapManager.prototype._clearAccountError.call(self, account);
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(self.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account_error' }));
  });

  it('clearing resets the run even when nothing was ever surfaced', async () => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(self._accountErrorStreak.get('acct-1')).toBe(1);
    await ImapManager.prototype._clearAccountError.call(self, account);
    expect(self._accountErrorStreak.has('acct-1')).toBe(false);
  });

  it.each([
    'Invalid credentials',
    'AUTHENTICATIONFAILED',
    'getaddrinfo ENOTFOUND imap.example.com',
    'certificate has expired',
  ])('reports %s immediately, because it will never heal on its own', async detail => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, detail);
    expect(self.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account_error', error: detail }));
  });

  it('still de-duplicates once an error has been surfaced', async () => {
    const self = ctx();
    for (let i = 0; i < 4; i++) {
      await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    }
    expect(query).toHaveBeenCalledTimes(1);
    expect(self.broadcast).toHaveBeenCalledTimes(1);
  });

  it('a persistent outage surfaces within one retry, not never', async () => {
    // The deferral must not be able to swallow a genuine failure: every retry re-enters here.
    const self = ctx();
    let surfaced = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
      surfaced = self.broadcast.mock.calls.length;
      if (attempt === 1) expect(surfaced).toBe(0);
    }
    expect(surfaced).toBe(1);
  });
});

describe('reconcileDeletes folder source', () => {
  it('considers only folders the server still advertises', async () => {
    // Second line of defence for the same loop: a stranded message row must not be able to
    // resurrect a deleted mailbox as something to open.
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    await ImapManager.prototype.reconcileDeletes.call({}, { id: 'acct-1', email_address: 'a@example.com' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM folders f');
    expect(sql).toContain('f.path = m.folder');
    expect(params).toEqual(['acct-1']);
  });
});

describe('syncFolders pruning', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  const account = { id: 'acct-1', email_address: 'a@example.com' };

  it('deletes DB rows for folders missing from LIST (ghosts after external rename)', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
        { path: 'Projects-Renamed', name: 'Projects-Renamed', delimiter: '/' },
        { path: 'Projects-Renamed/Sub', name: 'Sub', delimiter: '/' },
      ]),
    };
    await ImapManager.prototype.syncFolders.call({}, account, client);

    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM folders'));
    expect(del).toBeTruthy();
    expect(del[0]).toContain("path != 'INBOX'");
    expect(del[1]).toEqual(['acct-1', ['INBOX', 'Projects-Renamed', 'Projects-Renamed/Sub']]);
  });

  it('never prunes on an empty LIST response', async () => {
    const client = { list: vi.fn().mockResolvedValue([]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM folders'))).toBe(false);
  });

  it('drops the cached messages of a folder the server no longer has', async () => {
    // The self-sustaining loop this closes: pruning the folder row but stranding its message
    // rows left reconcileDeletes (which derives its folder list from messages) opening a
    // mailbox the server had deleted. That open failed every cycle, and because it failed it
    // could never learn the messages were gone, so the rows kept the error alive forever.
    query.mockImplementation(async sql => sql.includes('DELETE FROM folders')
      ? { rows: [{ path: 'Newsletter' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', delimiter: '/' }]) };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await ImapManager.prototype.syncFolders.call({}, account, client);

    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    expect(del).toBeTruthy();
    expect(del[1]).toEqual(['acct-1', ['Newsletter']]);
  });

  it('touches no message rows when no folder was pruned', async () => {
    query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', delimiter: '/' }]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('never deletes messages on an empty LIST, because nothing was pruned', async () => {
    const client = { list: vi.fn().mockResolvedValue([]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('still upserts every listed folder before pruning', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
      ]),
    };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO folders'));
    // The listed folder + the implicit INBOX row.
    expect(inserts.length).toBe(2);
    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM folders'));
    expect(del[1][1]).toEqual(['Archive']);
  });
});

// ── _deleteAllInFolder — chunked, throttle-tolerant empty ─────────────────────
describe('_deleteAllInFolder — chunked delete', () => {
  const run = (client, opts) =>
    ImapManager.prototype._deleteAllInFolder.call(ImapManager.prototype, client, 'Trash', { retryBackoffMs: 0, ...opts });

  it('deletes in UID-addressed chunks of chunkSize and returns the total', async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1);
    const client = {
      search: vi.fn().mockResolvedValue(uids),
      messageDelete: vi.fn().mockResolvedValue(true),
    };
    const deleted = await run(client, { chunkSize: 500 });

    expect(deleted).toBe(1200);
    expect(client.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(client.messageDelete).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    // Every call is UID-addressed, and the chunks together cover exactly all UIDs, in order.
    const seen = [];
    for (const [range, options] of client.messageDelete.mock.calls) {
      expect(options).toEqual({ uid: true });
      seen.push(...range.split(',').map(Number));
    }
    expect(seen).toEqual(uids);
  });

  it('is a no-op when the folder is already empty', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([]),
      messageDelete: vi.fn(),
    };
    const deleted = await run(client);
    expect(deleted).toBe(0);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it('retries a chunk once after the server declines it, then succeeds', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    const deleted = await run(client);
    expect(deleted).toBe(3);
    expect(client.messageDelete).toHaveBeenCalledTimes(2); // one decline, one retry
  });

  it('throws with progress when a chunk keeps failing after the retry', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn().mockResolvedValue(false),
    };
    await expect(run(client)).rejects.toThrow(/messageDelete could not be confirmed/);
    expect(client.messageDelete).toHaveBeenCalledTimes(2); // initial attempt + one retry
  });

  it('surfaces the underlying error if the retry attempt throws', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('Socket timeout')),
    };
    await expect(run(client)).rejects.toThrow(/Socket timeout/);
    expect(client.messageDelete).toHaveBeenCalledTimes(2);
  });
});

// ── _markSeenInFolder — chunked mark-all-read ────────────────────────────────
describe('_markSeenInFolder — chunked mark-all-read', () => {
  const run = (client, opts) =>
    ImapManager.prototype._markSeenInFolder.call(ImapManager.prototype, client, 'INBOX', { retryBackoffMs: 0, ...opts });

  it('adds \\Seen to UNSEEN messages in UID-addressed chunks', async () => {
    const uids = Array.from({ length: 1100 }, (_, i) => i + 1);
    const client = {
      search: vi.fn().mockResolvedValue(uids),
      messageFlagsAdd: vi.fn().mockResolvedValue(true),
    };
    const flagged = await run(client, { chunkSize: 500 });

    expect(flagged).toBe(1100);
    // Only unread messages are targeted, and the return is UID-addressed.
    expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(3); // 500 + 500 + 100
    for (const [range, flags, options] of client.messageFlagsAdd.mock.calls) {
      expect(flags).toEqual(['\\Seen']);
      expect(options).toEqual({ uid: true });
      expect(range.split(',').length).toBeLessThanOrEqual(500);
    }
  });

  it('is a no-op when nothing is unread', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([]),
      messageFlagsAdd: vi.fn(),
    };
    expect(await run(client)).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('retries a chunk once, then throws with progress if it keeps failing', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageFlagsAdd: vi.fn().mockResolvedValue(false),
    };
    await expect(run(client)).rejects.toThrow(/messageFlagsAdd could not be confirmed/);
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(2);
  });
});

describe('classifyMoveBySearch (#407 empty-uidMap reconciliation)', () => {
  it('treats a non-array search result as "nothing confirmed", never as an empty source', () => {
    // imapflow's search() resolves undefined (no mailbox selected) or false (SEARCH failed)
    // rather than throwing. Reading either as an empty source would mean "every uid left the
    // folder", i.e. the whole batch moved successfully, which is the dangerous conclusion.
    for (const bad of [false, undefined, null]) {
      const r = classifyMoveBySearch([4, 5, 6], bad, 3);
      expect(r.succeeded).toEqual([]);
      expect(r.failed).toEqual([4, 5, 6]);
      expect(r.staleCount).toBeNull();
      expect(r.mappable).toBe(false);
    }
  });

  it('clean move: all left source, all arrived -> succeeded + mappable', () => {
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [], /*destArrived*/ 3);
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect(r.failed).toEqual([]);
    expect(r.staleCount).toBe(0);
    expect(r.mappable).toBe(true);
  });

  it('stale UID in batch: fewer arrived than left -> ALL failed, no wrong-deletion', () => {
    // 2,3 were stale (moved away earlier), 4,5,6 really moved. All 5 are gone from source,
    // but only 3 arrived in the destination -> conservatively report all failed.
    const r = classifyMoveBySearch([2, 3, 4, 5, 6], /*remaining*/ [], /*destArrived*/ 3);
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([2, 3, 4, 5, 6]);
    expect(r.staleCount).toBe(2);
    expect(r.mappable).toBe(false);
  });

  it('partial move failure: some still in source -> those are failed, the rest succeeded', () => {
    // 5,6 still in source (not moved), 4 moved and arrived.
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [5, 6], /*destArrived*/ 1);
    expect(r.succeeded).toEqual([4]);
    expect(r.failed).toEqual([5, 6]);
    expect(r.staleCount).toBe(0);
    expect(r.mappable).toBe(true);
  });

  it('nothing left the source -> all failed (move did not happen)', () => {
    const r = classifyMoveBySearch([7, 8], /*remaining*/ [7, 8], /*destArrived*/ 0);
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([7, 8]);
    expect(r.staleCount).toBe(0);
  });

  it('destination not verifiable (null) -> trust source-absence, not mappable, stale unknown', () => {
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [], /*destArrived*/ null);
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect(r.failed).toEqual([]);
    expect(r.staleCount).toBeNull();
    expect(r.mappable).toBe(false);
  });
});

// ── sync_error recording — every path that gives up records, every success clears ──────────

describe('_recordAccountError / _clearAccountError', () => {
  const acct = { id: 'a1', user_id: 'u1', email_address: 'x@example.com' };

  const mgr = () => {
    const m = new ImapManager(null);
    clearInterval(m._healthCheckTimer);
    clearInterval(m._snippetSchedulerTimer);
    clearInterval(m._providerIdSchedulerTimer);
    m.broadcast = vi.fn();
    return m;
  };

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('persists the error and broadcasts it once a recoverable failure repeats', async () => {
    const m = mgr();
    // A connect timeout is recoverable, so the first is deliberately held back: providers that
    // refuse and accept again moments later must not paint the account red. The second, after a
    // backoff has elapsed without success, is a real outage and has to reach the UI.
    await m._recordAccountError(acct, 'IMAP connect timeout (30000ms)');
    expect(query).not.toHaveBeenCalled();
    expect(m.broadcast).not.toHaveBeenCalled();
    await m._recordAccountError(acct, 'IMAP connect timeout (30000ms)');
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/^UPDATE email_accounts SET sync_error = \$1\s+WHERE id = \$2 AND \(oauth_reconnect_required = false OR \$1 = 'oauth_reconnect_required'\)$/),
      ['IMAP connect timeout (30000ms)', 'a1'],
    );
    expect(m.broadcast).toHaveBeenCalledWith(
      { type: 'account_error', accountId: 'a1', error: 'IMAP connect timeout (30000ms)' },
    );
  });

  it('does not rewrite an unchanged error — a host down for hours writes once', async () => {
    const m = mgr();
    for (let i = 0; i < 5; i++) await m._recordAccountError(acct, 'read ETIMEDOUT');
    expect(query).toHaveBeenCalledTimes(1);
    expect(m.broadcast).toHaveBeenCalledTimes(1);
  });

  it('writes again when the error text changes', async () => {
    const m = mgr();
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    await m._recordAccountError(acct, 'Reconnect timeout (30000ms)');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clears a recorded error and tells the client', async () => {
    const m = mgr();
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    m.broadcast.mockClear();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenLastCalledWith(
      'UPDATE email_accounts SET sync_error = NULL WHERE id = $1 AND oauth_reconnect_required = false', ['a1'],
    );
    expect(m.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: 'a1' });
  });

  it('writes through on the first clear after a restart, when the DB may hold a stale error', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenCalledTimes(1);
    // ...and announces it: the frontend may be showing that stale error, read from the DB.
    expect(m.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
  });

  it('skips the redundant UPDATE once known-clear — the sync tick must not write every 10s', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    query.mockClear();
    for (let i = 0; i < 10; i++) await m._clearAccountError(acct);
    expect(query).not.toHaveBeenCalled();
  });

  it('never throws when the DB write fails, and retries the write next time', async () => {
    const m = mgr();
    query.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(m._recordAccountError(acct, 'read ETIMEDOUT')).resolves.toBeUndefined();
    expect(m.broadcast).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('forgets cached state on disconnect so a re-added account writes through', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    await m.disconnectAccount('a1');
    query.mockClear();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

// ── last_sync is stamped on an empty mailbox too ────────────────────────────────────────────

describe('syncMessages — empty mailbox still stamps last_sync', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  const account = { id: 'acct-empty', user_id: 'user-1', email_address: 'new@example.com', imap_host: 'imap.example.com' };

  it('stamps last_sync when the server reports an empty mailbox', async () => {
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0 },
    };
    const result = await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'INBOX', 50, false, true);
    expect(result).toEqual({ insertedCount: 0, broadcastedNewMessages: false });
    const stamps = query.mock.calls.filter(c => /UPDATE email_accounts SET last_sync/.test(c[0]));
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual(['acct-empty']);
  });

  it('invalidates a previous UID epoch even when the rebuilt mailbox is empty', async () => {
    query.mockImplementation(async sql => ({ rows: sql.includes('SELECT uid_validity') ? [{ uid_validity: '7' }] : [], rowCount: 0 }));
    const mgr = { _bgConnSem: createKeyedSemaphore(2), backfillMessages: vi.fn().mockResolvedValue() };
    const client = { getMailboxLock: async () => ({ release() {} }), mailbox: { exists: 0, uidValidity: 8n } };
    await ImapManager.prototype.syncMessages.call(mgr, account, client, 'INBOX', 50, false, true);
    await new Promise(resolve => setImmediate(resolve));
    const purge = query.mock.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM messages'));
    const stamp = query.mock.calls.findIndex(([sql]) => sql.includes('uid_validity=COALESCE'));
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(purge);
    expect(query.mock.calls[stamp][1]).toEqual([account.id, 'INBOX', 8]);
  });

  it('still releases the mailbox lock on the empty path', async () => {
    const release = vi.fn();
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release }), mailbox: { exists: 0 } };
    await ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'INBOX', 50, false, true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does NOT stamp when the mailbox object is missing — unknown state, not a confirmed sync', async () => {
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }), mailbox: null };
    await expect(
      ImapManager.prototype.syncMessages.call(noMoves(), account, client, 'INBOX', 50, false, true)
    ).resolves.toEqual({ insertedCount: 0, broadcastedNewMessages: false });
    expect(query.mock.calls.filter(c => /UPDATE email_accounts SET last_sync/.test(c[0]))).toHaveLength(0);
  });
});

describe('hung IMAP transport recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const acct = { id: 'recovery', user_id: 'u1', imap_host: 'imap.example.com' };
  function setup() {
    const mgr = new ImapManager(null);
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    const client = { close: vi.fn(), logout: vi.fn(() => new Promise(() => {})) };
    mgr.connections.set(acct.id, client);
    return { mgr, client };
  }
  it('force-closes a timed-out sync and releases its guard', async () => {
    const { mgr, client } = setup();
    mgr.syncMessages = vi.fn(() => new Promise(() => {}));
    const tick = mgr._syncTick(acct);
    await vi.advanceTimersByTimeAsync(55000);
    await tick;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    expect(mgr.connections.has(acct.id)).toBe(false);
    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
  });
  it('does not close a replacement connection when an older sync times out', async () => {
    const { mgr, client } = setup();
    mgr.syncMessages = vi.fn(() => new Promise(() => {}));
    const tick = mgr._syncTick(acct);
    const successor = { close: vi.fn() };
    mgr.connections.set(acct.id, successor);
    await vi.advanceTimersByTimeAsync(55000);
    await tick;
    expect(successor.close).not.toHaveBeenCalled();
    expect(mgr.connections.get(acct.id)).toBe(successor);
    expect(client.logout).not.toHaveBeenCalled();
  });
  it('disconnect completes even when graceful logout would never settle', async () => {
    const { mgr, client } = setup();
    await mgr.disconnectAccount(acct.id);
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    expect(mgr.connections.has(acct.id)).toBe(false);
  });
});

describe('staleness probe connection recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '::1', addresses: ['::1', '127.0.0.1'] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('retries a stalled dual-stack login over IPv4 and closes both probe transports', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const probeCycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    vi.clearAllTimers();
    const acct = { id: 'probe-recovery', user_id: 'u1', imap_host: 'imap.example.com', imap_tls: true };
    const persistent = { close: vi.fn() };
    mgr.connections.set(acct.id, persistent);
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [acct] }));
    const clients = [];
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn(() => clients.length === 1 ? new Promise(() => {}) : Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([]),
      });
      clients.push(client);
      return client;
    });
    const cycle = probeCycle();
    await vi.advanceTimersByTimeAsync(25000);
    await cycle;
    expect(clients).toHaveLength(2);
    expect(ImapFlow.mock.calls.at(-1)[0].host).toBe('127.0.0.1');
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(clients[1].search).toHaveBeenCalledWith({ uid: '101:*' }, { uid: true });
    expect(clients[1].close).toHaveBeenCalledOnce();
    expect(persistent.close).not.toHaveBeenCalled();
    expect(mgr._stalenessCheckRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Column lists in these inserts change whenever a migration adds a column; read the value by
// column name so a shifted position fails loudly instead of silently asserting the wrong field.
function insertedValue(sql, params, column) {
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(c => c.trim());
  const index = columns.indexOf(column);
  if (index === -1) throw new Error(`column ${column} is not in the insert`);
  return params[index];
}

describe('Gmail label memberships (#418)', () => {
  let rows, acct, serverUids, inserts;
  const sent = '[Gmail]/Sent Mail';
  const parsed = uid => ({ uid, messageId: '<self@example.com>', subject: 'Self mail',
    fromEmail: 'me@example.com', to: [], cc: [], replyTo: [], date: new Date('2026-09-01'),
    isRead: true, flags: ['\\Seen'], parsedHeaders: {} });
  function clientFor(folder) {
    return Object.assign(new EventEmitter(), {
      mailbox: { exists: serverUids.length, uidValidity: 1 },
      connect: vi.fn().mockResolvedValue(), close: vi.fn(), logout: vi.fn().mockResolvedValue(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn(async () => serverUids),
      fetch: vi.fn(async function* (range) {
        const uids = range.includes(':') ? serverUids : range.split(',').map(Number);
        // flags ride along like a real server's FETCH: a re-sync of cached rows reads msg.flags
        // on its cheap uid+flags pass (upstream #495).
        for (const uid of uids) yield { uid, folder, threadId: `9000${uid}`, emailId: `8000${uid}`, flags: new Set(['\\Seen']) };
      }),
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    rows = []; serverUids = [1]; inserts = [];
    acct = { id: 'gmail-418', user_id: 'u418', enabled: true, imap_host: 'imap.gmail.com', imap_tls: true };
    parseMessage.mockImplementation(async m => parsed(m.uid));
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    query.mockImplementation(async (sql, params = []) => {
      const local = rows.filter(r => r.folder === params[1]);
      if (sql.includes('SELECT * FROM email_accounts') || sql.includes('SELECT id, enabled FROM email_accounts')) return { rows: [acct] };
      if (sql.includes('SELECT uid_validity, total_count')) return { rows: [{ uid_validity: 1, total_count: local.length }] };
      if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1 }] };
      if (sql.includes('COUNT(*) as count')) return { rows: [{ count: local.length, max_uid: Math.max(0, ...local.map(r => r.uid)) }] };
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: Math.max(0, ...local.map(r => r.uid)) }] };
      if (sql.trim().startsWith('SELECT') && sql.includes('COUNT(*)')) return { rows: [{ n: local.length }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: local.map(r => ({ uid: r.uid })) };
      if (sql.includes('AND 1 = (SELECT COUNT')) {
        // Model the existing single-row relocation: whichever folder syncs last wins.
        const same = rows.filter(r => r.messageId === params[3]);
        if (same.length === 1 && (same[0].folder !== params[0] || same[0].uid !== params[1])) {
          Object.assign(same[0], { folder: params[0], uid: params[1] });
          return { rows: [{ id: 'relocated' }] };
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO messages')) {
        inserts.push({ sql, params });
        const exists = rows.some(r => r.folder === params[2] && r.uid === params[1]);
        if (!exists) rows.push({ folder: params[2], uid: params[1], messageId: params[3] });
        return { rows: [{ id: `row-${rows.length}`, is_new: !exists }] };
      }
      return { rows: [] };
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  // A re-sync of cached rows sends their flags through the bulk path instead of re-upserting
  // each row (upstream #495), so the bare-object manager needs the real method.
  const manager = () => ({ ...backoffState(), backfillRunning: new Set(), broadcast: vi.fn(), pluginFacade: {},
    _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates });
  async function sync(mgr, folder) {
    await ImapManager.prototype.syncMessages.call(mgr, acct, clientFor(folder), folder, 20, false, true);
  }
  async function backfill(mgr, folder) {
    ImapFlow.mockImplementation(function () { return clientFor(folder); });
    const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, folder);
    await vi.runAllTimersAsync();
    await pending;
  }
  // DB-first moves (moveQueue.js): a letter whose move is pending lives in its moved row.
  for (const mode of ['sync', 'backfill']) {
    it(`${mode} does not insert a letter again at the source of its pending move`, async () => {
      const mgr = manager();
      ImapManager.prototype._guardMoveUid.call(mgr, acct.id, 'INBOX', 1);
      await (mode === 'sync' ? sync : backfill)(mgr, 'INBOX');
      expect(inserts).toEqual([]);
      expect(rows).toEqual([]);
    });

    it(`${mode} hands a moved letter arriving in its destination to the moved row`, async () => {
      const mgr = manager();
      mgr.moveQueue.claimArrival.mockResolvedValue(true);
      await (mode === 'sync' ? sync : backfill)(mgr, 'Projects');
      expect(mgr.moveQueue.claimArrival).toHaveBeenCalledWith(acct.id, 'Projects', '<self@example.com>', 1);
      expect(inserts).toEqual([]);
    });

    it(`${mode} inserts a letter no move is waiting for`, async () => {
      const mgr = manager();
      await (mode === 'sync' ? sync : backfill)(mgr, 'Projects');
      expect(mgr.moveQueue.claimArrival).toHaveBeenCalledWith(acct.id, 'Projects', '<self@example.com>', 1);
      expect(rows).toEqual([expect.objectContaining({ folder: 'Projects', uid: 1 })]);
    });
  }
  for (const mode of ['sync', 'backfill']) {
    for (const order of [['INBOX', sent], [sent, 'INBOX'], ['INBOX', 'Projects']]) {
      it(`${mode} preserves both memberships in order ${order.join(' -> ')}`, async () => {
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        for (const folder of order) await run(mgr, folder);
        expect(rows.map(r => r.folder).sort()).toEqual([...order].sort());
        for (const folder of order) await run(mgr, folder);
        expect(rows).toHaveLength(2);
      });
    }
  }
  it('repairs an older INBOX hole even when cached counts and maximum UID look complete', async () => {
    serverUids = [1, 2];
    rows = [{ folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 },
      { folder: sent, uid: 10, messageId: '<self@example.com>' }];
    await backfill(manager(), 'INBOX');
    expect(rows).toContainEqual(expect.objectContaining({ folder: 'INBOX', uid: 1 }));
    expect(rows).toContainEqual(expect.objectContaining({ folder: sent, uid: 10 }));
  });
  for (const host of ['imap.example.com', 'imap.purelymail.com', 'imap.mail.me.com']) {
    for (const mode of ['sync', 'backfill']) {
      it(`${mode} preserves shared Message-IDs across folders on ${host}`, async () => {
        acct.imap_host = host;
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        await run(mgr, 'INBOX');
        await run(mgr, 'Sent');
        expect(rows.map(r => r.folder).sort()).toEqual(['INBOX','Sent']);
        await run(mgr,'INBOX');
        expect(rows).toHaveLength(2);
      });
      it(`${mode} preserves two live UIDs with the same Message-ID inside one folder on ${host}`, async () => {
        acct.imap_host = host;
        serverUids = [1,2];
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        await run(mgr, 'INBOX');
        expect(rows.map(r => r.uid).sort()).toEqual([1,2]);
        await run(mgr, 'INBOX');
        expect(rows).toHaveLength(2);
      });
    }
  }
  for (const mode of ['sync', 'backfill']) {
    it(`${mode} asks Gmail for thread ids and stores both ids`, async () => {
      const mgr = manager();
      const client = clientFor('INBOX');
      if (mode === 'sync') {
        await ImapManager.prototype.syncMessages.call(mgr, acct, client, 'INBOX', 20, false, true);
      } else {
        ImapFlow.mockImplementation(function () { return client; });
        const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, 'INBOX');
        await vi.runAllTimersAsync();
        await pending;
      }
      expect(client.fetch.mock.calls.some(([, q]) => q?.threadId === true)).toBe(true);
      const insert = inserts.find(i => i.params[1] === 1);
      expect(insert.sql).toMatch(/provider_thread_id, provider_message_id/);
      expect(insertedValue(insert.sql, insert.params, 'provider_thread_id')).toBe('90001');
      expect(insertedValue(insert.sql, insert.params, 'provider_message_id')).toBe('80001');
      expect(insert.sql).toMatch(/provider_thread_id = COALESCE\(EXCLUDED\.provider_thread_id, messages\.provider_thread_id\)/);
    });

    it(`${mode} stores no provider ids for a server that is not Gmail`, async () => {
      acct.imap_host = 'imap.example.com';
      const mgr = manager();
      const client = clientFor('INBOX');
      if (mode === 'sync') {
        await ImapManager.prototype.syncMessages.call(mgr, acct, client, 'INBOX', 20, false, true);
      } else {
        ImapFlow.mockImplementation(function () { return client; });
        const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, 'INBOX');
        await vi.runAllTimersAsync();
        await pending;
      }
      expect(client.fetch.mock.calls.every(([, q]) => q?.threadId !== true)).toBe(true);
      const insert = inserts.find(i => i.params[1] === 1);
      expect(insertedValue(insert.sql, insert.params, 'provider_thread_id')).toBeNull();
      expect(insertedValue(insert.sql, insert.params, 'provider_message_id')).toBeNull();
    });
  }

  describe('gmail thread mode (PR C1)', () => {
    it('sync keys a new message by the Gmail thread number in gmail mode', async () => {
      acct.thread_mode = 'gmail';
      await sync(manager(), 'INBOX');
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'thread_id')).toBe(`${GMAIL_KEY_PREFIX}90001`);
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'threading_reason')).toBe('gmail-thrid');
    });

    it('backfill keys a new message by the Gmail thread number in gmail mode', async () => {
      acct.thread_mode = 'gmail';
      await backfill(manager(), 'INBOX');
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'thread_id')).toBe(`${GMAIL_KEY_PREFIX}90001`);
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'threading_reason')).toBe('gmail-thrid');
    });

    it.each([['rfc'], [undefined]])('sync roots a new message under its own Message-ID in rfc mode (thread_mode=%s)', async (mode) => {
      acct.thread_mode = mode;
      await sync(manager(), 'INBOX');
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'thread_id')).toBe('<self@example.com>');
      expect(insertedValue(inserts[0].sql, inserts[0].params, 'threading_reason')).toBe('new-root');
    });

    it('skips the reroot update in gmail mode but issues it in rfc mode', async () => {
      // A provisional ancestor makes the resolved thread_id differ from the message's own
      // Message-ID, so a real (unguarded) sync would always call the reroot update here.
      parseMessage.mockImplementation(async m => ({ ...parsed(m.uid), inReplyTo: '<root@x>', references: '<root@x>' }));

      acct.thread_mode = 'gmail';
      await sync(manager(), 'INBOX');
      expect(query.mock.calls.some(([sql]) => /UPDATE messages SET thread_id/.test(sql))).toBe(false);

      rows = []; inserts = []; serverUids = [1];
      acct.thread_mode = 'rfc';
      await sync(manager(), 'INBOX');
      expect(query.mock.calls.some(([sql]) => /UPDATE messages SET thread_id/.test(sql))).toBe(true);
    });

    // LIKE reads `%` and `_` in its pattern as wildcards, so a prefix parameter has to be
    // escaped to be matched literally. starts_with takes the parameter as plain text.
    it('keys the conflict branch on a parameter holding the Gmail key prefix', async () => {
      await sync(manager(), 'INBOX');
      const sql = inserts[0].sql;
      expect(sql).toMatch(/thread_id = CASE[\s\S]*WHEN starts_with\(EXCLUDED\.thread_id, \$\d+\)/);
      expect(sql).toMatch(/threading_reason = CASE[\s\S]*WHEN starts_with\(EXCLUDED\.thread_id, \$\d+\)/);
      expect(sql).toMatch(/NOT starts_with\(messages\.thread_id, \$\d+\)/);
      expect(sql).not.toMatch(/LIKE \$\d+ \|\| '%'/);
      expect(inserts[0].params).toContain(GMAIL_KEY_PREFIX);
    });

    // The mock query implementation cannot evaluate SQL, so the CASE semantics are checked
    // against a real database in Task 5. Here we only confirm the thread_id and
    // threading_reason branches decide alike — the same WHEN conditions and an ELSE that keeps
    // the stored reason on exactly the rows whose stored key is kept. A mismatch either way
    // silently stores a reason that explains a key the row never took: a row written before
    // migration 0063 has a key and a NULL reason.
    it('mirrors the thread_id and threading_reason CASE branches, ELSE included', async () => {
      await sync(manager(), 'INBOX');
      const sql = inserts[0].sql;
      const keyCase = sql.slice(sql.indexOf('thread_id = CASE'), sql.indexOf('threading_reason = CASE'));
      const reasonCase = sql.slice(sql.indexOf('threading_reason = CASE'), sql.indexOf('is_bulk = COALESCE'));
      const whens = section => section.slice(0, section.indexOf('ELSE')).match(/WHEN[\s\S]*?(?=\s*THEN)/g);
      expect(whens(keyCase)).toHaveLength(2);
      expect(whens(reasonCase)).toEqual(whens(keyCase));
      expect(keyCase).toContain('ELSE COALESCE(messages.thread_id, EXCLUDED.thread_id)');
      expect(reasonCase).toContain('ELSE CASE WHEN messages.thread_id IS NULL THEN EXCLUDED.threading_reason ELSE messages.threading_reason END');
      expect(reasonCase).not.toContain('COALESCE(messages.threading_reason');
    });

    // The Sent-copy upsert has the same key/reason pair and the same pre-0063 rows, without the
    // Gmail branch: it never sees a provider thread number.
    it('keeps the stored reason with the stored key in the Sent-copy upsert', async () => {
      const mgr = { ...manager(), _scheduleProviderIdBackfill: vi.fn() };
      await ImapManager.prototype.upsertSentMessageRecord.call(mgr, acct, sent, 7, { messageId: '<sent@example.com>' });
      const sql = inserts.at(-1).sql;
      expect(sql).toContain('ELSE COALESCE(messages.thread_id, EXCLUDED.thread_id)');
      expect(sql).toContain('ELSE CASE WHEN messages.thread_id IS NULL THEN EXCLUDED.threading_reason ELSE messages.threading_reason END');
      expect(sql).not.toContain('COALESCE(messages.threading_reason');
    });
  });
});

describe('Gmail staleness membership check (#418)', () => {
  beforeEach(() => query.mockReset());
  it('does not let a Sent copy mask a missing INBOX UID', async () => {
    query.mockResolvedValue({ rows: [] });
    const account = { id: 'a418', imap_host: 'imap.gmail.com' };
    expect(await countMissingInboxCopies(account, [{ uid: 7, messageId: 'self@example.com' }])).toBe(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("folder = 'INBOX'"), ['a418', [7]]);
  });
  it('compares exact INBOX UIDs and handles pg bigint strings', async () => {
    query.mockResolvedValue({ rows: [{ uid: '7' }] });
    expect(await countMissingInboxCopies({ id: 'a418', imap_host: 'imap.gmail.com' }, [
      { uid: 7, messageId: 'same' }, { uid: 8, messageId: 'same' },
    ])).toBe(1);
  });
  it('uses exact UID membership on non-Gmail providers too', async () => {
    query.mockResolvedValue({ rows: [{ uid: '7' }] });
    expect(await countMissingInboxCopies({ id: 'a418', imap_host: 'imap.example.com' }, [
      { uid: 7, messageId: 'same' }, { uid: 8, messageId: null },
    ])).toBe(1);
  });
  it('does not count phantom search results that FETCH did not return', async () => {
    expect(await countMissingInboxCopies({ imap_host: 'imap.gmail.com' }, [])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('folder integrity reconciliation safety', () => {
  const acct = { id: 'count-test', user_id: 'u', imap_host: 'imap.example.com' };
  const observed = { uidValidity: 8n, uidNext: 20, highestModseq: 22n };
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 0 }); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  function setup(uids, exists = uids.length) {
    const lock = { release: vi.fn() };
    const client = { mailbox: { exists, uidValidity: 8n }, getMailboxLock: async () => lock, search: async () => uids,
      fetch: async function* () { for (const uid of uids) yield { uid, flags: new Set() }; } };
    const mgr = Object.assign(Object.create(ImapManager.prototype), {
      _withCountClient: async (_a, fn) => fn(client), syncMessages: vi.fn().mockResolvedValue({}),
      _applyFlagUpdates: vi.fn().mockResolvedValue(0), _isMoveUidGuarded: () => false,
      broadcast: vi.fn(), backfillMessages: vi.fn(), _bgConnSem: createKeyedSemaphore(2),
    });
    return { mgr, client, lock };
  }
  it('never deletes or checkpoints after a truncated flag fetch', async () => {
    const { mgr, lock } = setup([1], 2);
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow('Incomplete');
    expect(query.mock.calls.some(([sql]) => /DELETE|status_synced_at/.test(sql))).toBe(false);
    expect(lock.release).toHaveBeenCalledOnce();
  });
  it('rejects failed FETCH instead of treating the collected prefix as complete', async () => {
    const { mgr, client } = setup([1], 2);
    client.fetch = async function* () { yield { uid: 1, flags: new Set() }; throw new Error('Disconnected'); };
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow('Disconnected');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([false, [2]])('does not delete on unavailable or equal-count changed membership (%s)', async response => {
    const { mgr, client } = setup([1]);
    client.search = async () => response;
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('a missing old UID schedules backfill without claiming a completed sync', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr } = setup([1, 2]);
    query.mockResolvedValue({ rows: [{ uid: '2' }] });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    expect(mgr.backfillMessages).toHaveBeenCalledWith(acct, 'Sent');
    expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(false);
    expect(mgr._bgConnSem.activeCount(acct.imap_host)).toBe(0);
  });
  it('checkpoints only after fully verified membership', async () => {
    const { mgr } = setup([1, 2]);
    query.mockResolvedValue({ rows: [{ uid: '1' }, { uid: '2' }] });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    const checkpoint = query.mock.calls.find(([sql]) => sql.includes('status_synced_at'));
    expect(checkpoint[1]).toEqual([acct.id, 'Sent', 20, '8', '22']);
    expect(checkpoint[0]).toContain('uid_validity=$4');
  });
  it('does not count a UID the server keeps refusing as a gap, so the backfill loop ends', async () => {
    // Upstream observed the check and the backfill looping 35 times in five hours over the same
    // five UIDs. A written-off UID in the current epoch settles the folder instead.
    const { mgr } = setup([1, 2]);
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM unfetchable_uids')) return { rows: [{ uid: '2' }] };
      return { rows: [{ uid: '1' }], rowCount: 0 };
    });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    expect(mgr.backfillMessages).not.toHaveBeenCalled();
    const lookup = query.mock.calls.find(([sql]) => sql.includes('FROM unfetchable_uids'));
    expect(lookup[1][4]).toBe('8'); // scoped to the epoch this pass verified
    expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(true);
  });
  it('a rebuilt mailbox cannot use the previous epoch observation as a checkpoint', async () => {
    const { mgr, client } = setup([1]);
    client.mailbox.uidValidity = 9n;
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    expect(query).not.toHaveBeenCalled();
  });
  it('only removes old unguarded cached rows from a verified empty folder and checks the UID epoch in SQL', async () => {
    const { mgr } = setup([]);
    mgr._isMoveUidGuarded = (_a, _f, uid) => uid === 2;
    query.mockResolvedValue({ rows: [{ uid: '1', synced_at: new Date(0) }, { uid: '2', synced_at: new Date(0) }, { uid: '3', synced_at: new Date(Date.now() + 60000) }], rowCount: 1 });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    const deletion = query.mock.calls.find(([sql]) => sql.startsWith('DELETE'));
    expect(deletion[1][2]).toEqual([1]);
    expect(deletion[0]).toContain('uid_validity=$5');
  });
  it('backs off unresolved membership without blocking other folders or advancing a checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { mgr } = setup([]);
    Object.assign(mgr, { _statusSyncBackoff: new Map(), _statusSyncRunning: new Set(), backfillRunning: new Set(), onDemandSyncing: new Set(),
      _refreshObservedFolder: vi.fn().mockResolvedValue(false) });
    expect(mgr._queueObservedFolder(acct, 'INBOX', observed)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(mgr._queueObservedFolder(acct, 'INBOX', observed)).toBe(false);
    expect(mgr._queueObservedFolder(acct, 'Sent', observed)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(false);
    const key = `${acct.id}:INBOX`;
    for (let i = 0; i < 10; i++) mgr._noteIntegrityRetry(key);
    expect(mgr._statusSyncBackoff.get(key).until-Date.now()).toBe(15*60000);
  });

  it('connection admission timeout removes its waiter without consuming a later released slot', async () => {
    vi.useFakeTimers();
    const sem = createKeyedSemaphore(1);
    await sem.acquire('host');
    const failed = expect(sem.acquire('host', { timeoutMs: 10 })).rejects.toThrow('admission timed out');
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    expect(sem.waitingCount('host')).toBe(0);
    sem.release('host');
    expect(sem.activeCount('host')).toBe(0);
    await sem.acquire('host');
    expect(sem.activeCount('host')).toBe(1);
    sem.release('host');
  });
});


describe('backfill optional metadata fallback', () => {
  const query = { uid: true, flags: true, envelope: true, bodyStructure: true, headers: true };
  const collect = async iterator => { const out=[]; for await (const item of iterator) out.push(item.uid); return out; };
  it('retries only omitted UIDs after the full metadata fetch is drained', async () => {
    let drained=false;
    const client = { fetch: vi.fn((range) => (async function* () {
      if (range==='1,2,3') { yield {uid:1}; drained=true; }
      else { expect(drained).toBe(true); yield {uid:2}; yield {uid:3}; }
    })()) };
    expect(await collect(fetchBackfillBatch(client,[1,2,3],query))).toEqual([1,2,3]);
    expect(client.fetch.mock.calls[1]).toEqual(['2,3',{uid:true,flags:true,envelope:true},{uid:true}]);
  });
  it('does not add another request for a complete metadata response', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; }) };
    expect(await collect(fetchBackfillBatch(client,[1],query))).toEqual([1]);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
  it('never invents rows for unfetchable UIDs or accepts unrequested/duplicate responses', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; yield {uid:1}; yield {uid:99}; }) };
    expect(await collect(fetchBackfillBatch(client,[1,2],query))).toEqual([1]);
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates transport failure rather than declaring a partial batch complete', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; throw new Error('Disconnected'); }) };
    await expect(collect(fetchBackfillBatch(client,[1,2],query))).rejects.toThrow('Disconnected');
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps threadId on the retry fetch when the original query requested it', async () => {
    const gmailQuery = { ...query, threadId: true };
    let drained=false;
    const client = { fetch: vi.fn((range) => (async function* () {
      if (range==='1,2,3') { yield {uid:1}; drained=true; }
      else { expect(drained).toBe(true); yield {uid:2}; yield {uid:3}; }
    })()) };
    expect(await collect(fetchBackfillBatch(client,[1,2,3],gmailQuery))).toEqual([1,2,3]);
    expect(client.fetch.mock.calls[1]).toEqual(['2,3',{uid:true,flags:true,envelope:true,threadId:true},{uid:true}]);
  });
  it('omits threadId on the retry fetch when the original query did not request it', async () => {
    let drained=false;
    const client = { fetch: vi.fn((range) => (async function* () {
      if (range==='1,2,3') { yield {uid:1}; drained=true; }
      else { expect(drained).toBe(true); yield {uid:2}; yield {uid:3}; }
    })()) };
    expect(await collect(fetchBackfillBatch(client,[1,2,3],query))).toEqual([1,2,3]);
    expect(client.fetch.mock.calls[1]).toEqual(['2,3',{uid:true,flags:true,envelope:true},{uid:true}]);
  });
});

// ── IMAP authentication error reporting (upstream #433 / #429) ──────────────────────────────
// Error shapes below were captured from ImapFlow 2.0.2 against a fake server (see
// imapManager.authErrors.test.js, which drives the real library end to end). LOGIN and
// AUTHENTICATE failures replace the parsed `response` object with its compiled string, so the
// old extractor fell through to the generic 'Command failed' for every one of them.
const imapErr = (props) => Object.assign(new Error(props.message || 'Command failed'), props);
const gmailXoauthFailure = () => imapErr({
  response: '1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
  responseStatus: 'NO',
  executedCommand: '1 AUTHENTICATE XOAUTH2 "(* value hidden *)"',
  responseText: 'Invalid credentials (Failure)',
  serverResponseCode: 'AUTHENTICATIONFAILED',
  authenticationFailed: true,
  oauthError: { status: '400', schemes: 'Bearer', scope: 'https://mail.google.com/' },
});
const outlookXoauthFailure = () => imapErr({
  response: 'A1 NO AUTHENTICATE failed.',
  responseStatus: 'NO',
  responseText: 'AUTHENTICATE failed.',
  authenticationFailed: true,
});
const loginLimitRefusal = () => imapErr({
  response: '1 NO [LIMIT] Too many simultaneous connections',
  responseStatus: 'NO',
  executedCommand: '1 AUTHENTICATE PLAIN',
  responseText: 'Too many simultaneous connections',
  serverResponseCode: 'LIMIT',
  authenticationFailed: true,
});

describe('extractImapError', () => {
  it('keeps the TEXT attribute of a structured response (regression guard)', () => {
    const err = imapErr({ response: { command: 'NO', attributes: [{ type: 'TEXT', value: 'foo' }] } });
    expect(extractImapError(err)).toBe('foo');
  });

  it('keeps "<status>: <message>" for a structured response without text', () => {
    const err = imapErr({ response: { command: 'NO', attributes: [] } });
    expect(extractImapError(err)).toBe('NO: Command failed');
  });

  it('reports the Gmail XOAUTH2 rejection with its response code and a whitelisted OAuth status', () => {
    const detail = extractImapError(gmailXoauthFailure());
    expect(detail).toBe('[AUTHENTICATIONFAILED] Invalid credentials (Failure) (oauth status 400)');
    expect(detail).not.toMatch(/scope|mail\.google\.com|Bearer|value hidden/i);
  });

  it('reports the Outlook AUTHENTICATE rejection instead of "Command failed"', () => {
    expect(extractImapError(outlookXoauthFailure())).toBe('AUTHENTICATE failed.');
  });

  it('reports a login-stage connection limit with its response code', () => {
    expect(extractImapError(loginLimitRefusal())).toBe('[LIMIT] Too many simultaneous connections');
  });

  it('strips the tag and status from a string response without duplicating the code', () => {
    const err = imapErr({ response: 'A7 NO [UNAVAILABLE] Server busy', serverResponseCode: 'UNAVAILABLE', authenticationFailed: true });
    expect(extractImapError(err)).toBe('[UNAVAILABLE] Server busy');
  });

  it('falls back to the message when a string response carries no text', () => {
    expect(extractImapError(imapErr({ response: 'A1 NO', responseStatus: 'NO' }))).toBe('Command failed');
  });

  it('says "Authentication failed" rather than the generic text for a textless auth failure', () => {
    expect(extractImapError(imapErr({ response: false, authenticationFailed: true }))).toBe('Authentication failed');
    expect(extractImapError(imapErr({ message: 'No password configured', authenticationFailed: true }))).toBe('No password configured');
  });

  it('leaves a locally thrown "Command failed" untouched so body-fetch retry comparisons hold', () => {
    // fetchMessageBody throws this itself for an empty UID FETCH and compares the extracted
    // detail against the literal both before its retry and after it.
    expect(extractImapError(new Error('Command failed'))).toBe('Command failed');
    expect(extractImapError(imapErr({ response: { tag: '5', command: 'NO', attributes: [] }, responseStatus: 'NO' }))).toBe('NO: Command failed');
  });

  it('keeps fetchMessageBody retrying an empty UID FETCH and then returning an empty body', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clients = [];
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // The message is gone: UID FETCH completes with no untagged FETCH at all.
        fetch: vi.fn(async function* () {}),
      });
      clients.push(client);
      return client;
    });
    const gmail = { id: 'body-fetch-missing', user_id: 'u1', imap_host: 'imap.gmail.com', imap_tls: true };
    // No backoff armed: the fresh-login retry is allowed.
    const body = await ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, gmail, 42, 'INBOX');
    expect(body).toEqual({ html: null, text: null, attachments: [] });
    expect(clients).toHaveLength(2); // pooled attempt, then the fresh-login retry
    vi.restoreAllMocks();
  });

  it('never opens more pooled connections than the pool size under a burst of requests', async () => {
    // Every caller used to pass the size check before the first connect finished, so a burst
    // opened one login per request instead of queueing for the pool.
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    let created = 0;
    ImapFlow.mockImplementation(function () {
      created++;
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => new Promise(resolve => setTimeout(resolve, 5))),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        fetch: vi.fn(async function* (_uid, q) {
          if (q.bodyStructure) {
            yield { uid: 9, bodyStructure: { part: '1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'utf-8' } } };
            return;
          }
          yield { uid: 9, bodyParts: new Map(q.bodyParts.map(part => [part, Buffer.from('hello')])) };
        }),
      });
    });
    const account = { id: 'pool-burst', user_id: 'u1', imap_host: 'imap.example.com', imap_tls: true };
    const bodies = await Promise.all(Array.from({ length: 5 }, () =>
      ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, account, 9, 'INBOX')));
    expect(bodies).toHaveLength(5);
    expect(created).toBe(poolSizeFor(account));
  });

  it('fetchMessageBody renders a calendar-only message as an invite card (#423)', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    const ics = 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nSUMMARY:Standup\r\nDTSTART:20260915T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const requested = [];
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        fetch: vi.fn(async function* (_uid, q) {
          if (q.bodyStructure) {
            yield { uid: 7, bodyStructure: { type: 'text/calendar', encoding: 'quoted-printable', parameters: { charset: 'utf-8', method: 'CANCEL', name: 'invite.ics' } } };
            return;
          }
          requested.push(...q.bodyParts);
          yield { uid: 7, bodyParts: new Map(q.bodyParts.map(p => [p, Buffer.from(ics)])) };
        }),
      });
    });
    const gmail = { id: 'body-fetch-ics', user_id: 'u1', imap_host: 'imap.gmail.com', imap_tls: true };
    const body = await ImapManager.prototype.fetchMessageBody.call(NO_BACKOFF, gmail, 7, 'INBOX');
    expect(requested).toContain('1');
    expect(body.html).toMatch(/<s>Standup<\/s>/);
    expect(body.html).toContain('2026-09-15 08:00 (UTC)');
    expect(body.text).toBe('❌ Standup\n🗓 2026-09-15 08:00 (UTC)');
    expect(body.attachments.map(a => a.filename)).toEqual(['invite.ics']);
  });

  it('returns plain transport errors as-is', () => {
    expect(extractImapError(new Error('ETIMEDOUT'))).toBe('ETIMEDOUT');
    expect(extractImapError(new Error('ECONNRESET'))).toBe('ECONNRESET');
    expect(extractImapError('boom')).toBe('boom');
  });

  it('ignores an OAuth status that is not on the whitelist', () => {
    const err = gmailXoauthFailure();
    err.oauthError = { status: 'ya29.leaked-token', scope: 'https://mail.google.com/' };
    expect(extractImapError(err)).toBe('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
  });

  it('never lets a bearer token or base64 SASL payload through, even if a server echoes it', () => {
    const token = 'ya29.a0AfH6SMBx-SECRET_access_token_value';
    const sasl = Buffer.from(`user=u@example.com\x01auth=Bearer ${token}\x01\x01`).toString('base64');
    const err = imapErr({
      response: `1 NO [AUTHENTICATIONFAILED] bad payload ${sasl}`,
      responseText: `bad payload ${sasl} auth=Bearer ${token}`,
      executedCommand: `1 AUTHENTICATE XOAUTH2 ${sasl}`,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
    });
    const detail = extractImapError(err);
    expect(detail).not.toContain(sasl);
    expect(detail).not.toContain(token);
    expect(detail).not.toContain('ya29');
    expect(detail).toMatch(/^\[AUTHENTICATIONFAILED\] bad payload/);
  });
});

describe('isImapAuthFailure', () => {
  it.each([
    ['Gmail XOAUTH2 invalid credentials', gmailXoauthFailure()],
    ['Outlook AUTHENTICATE failed', outlookXoauthFailure()],
    ['password LOGIN rejection', imapErr({ response: '1 NO [AUTHENTICATIONFAILED] Authentication failed.', responseText: 'Authentication failed.', serverResponseCode: 'AUTHENTICATIONFAILED', authenticationFailed: true })],
    ['client-side AuthenticationFailure', imapErr({ message: 'No password configured', authenticationFailed: true })],
    ['AUTHORIZATIONFAILED code', imapErr({ responseText: 'Not allowed', serverResponseCode: 'AUTHORIZATIONFAILED' })],
    ['EXPIRED code', imapErr({ responseText: 'Password expired', serverResponseCode: 'EXPIRED' })],
    ['OAuth 401 without a response code', imapErr({ responseText: 'Failure', authenticationFailed: true, oauthError: { status: '401' } })],
  ])('is true for %s', (_label, err) => {
    expect(isImapAuthFailure(err)).toBe(true);
  });

  it.each([
    // ImapFlow flags EVERY tagged NO to LOGIN/AUTHENTICATE as authenticationFailed, including a
    // provider refusing another session. Those must stay on the short refusal backoff.
    ['login-stage connection limit', loginLimitRefusal()],
    ['Gmail simultaneous-connection alert', imapErr({ response: '1 NO [ALERT] Too many simultaneous connections. (Failure)', responseText: 'Too many simultaneous connections. (Failure)', serverResponseCode: 'ALERT', authenticationFailed: true })],
    ['UNAVAILABLE at login', imapErr({ responseText: 'Service temporarily unavailable', serverResponseCode: 'UNAVAILABLE', authenticationFailed: true })],
    // Dovecot's auth backend failing (its database down): it could not check the password.
    ['Dovecot temporary auth failure with UNAVAILABLE', imapErr({ response: '1 NO [UNAVAILABLE] Temporary authentication failure.', responseText: 'Temporary authentication failure.', serverResponseCode: 'UNAVAILABLE', authenticationFailed: true })],
    ['Dovecot temporary auth failure without a code', imapErr({ response: '1 NO Temporary authentication failure.', responseStatus: 'NO', responseText: 'Temporary authentication failure.', authenticationFailed: true })],
    ['Microsoft throttling', imapErr({ responseText: 'Request is throttled. Suggested Backoff Time: 92415 milliseconds', responseStatus: 'BAD', code: 'ETHROTTLE' })],
    ['connection dropped mid-SASL', imapErr({ message: 'Connection not available', code: 'NoConnection', authenticationFailed: true })],
    ['socket closed after connect', imapErr({ message: 'Unexpected close', code: 'ClosedAfterConnectText' })],
    ['session already closed by the server', imapErr({ message: 'Already logged out', authenticationFailed: true })],
    ['connect timeout', new Error('IMAP connect timeout (30000ms)')],
    ['null', null],
  ])('is false for %s', (_label, err) => {
    expect(isImapAuthFailure(err)).toBe(false);
  });

  it('agrees with refusal detection on the extracted text', () => {
    expect(isConnectionRefusal(extractImapError(loginLimitRefusal()))).toBe(true);
    expect(isConnectionRefusal(extractImapError(gmailXoauthFailure()))).toBe(false);
  });
});

describe('authCooldownMs', () => {
  it('starts at the 30-minute floor, far above the refusal ladder', () => {
    expect(authCooldownMs(1)).toBe(30 * 60 * 1000);
    expect(authCooldownMs(1)).toBeGreaterThan(connectCooldownMs(1));
  });

  it('doubles, and caps at 6 hours', () => {
    expect(authCooldownMs(2)).toBe(60 * 60 * 1000);
    expect(authCooldownMs(3)).toBe(2 * 60 * 60 * 1000);
    expect(authCooldownMs(4)).toBe(4 * 60 * 60 * 1000);
    expect(authCooldownMs(5)).toBe(6 * 60 * 60 * 1000);
    expect(authCooldownMs(50)).toBe(AUTH_FAILURE_COOLDOWN_MAX_MS);
  });

  it('turns 16 hours of a wrong password into a handful of attempts', () => {
    // Upstream observed 627 failed logins in 16 hours at a fixed short interval.
    let elapsed = 0, attempts = 0;
    while (elapsed < 16 * 60 * 60 * 1000) {
      attempts += 1;
      elapsed += authCooldownMs(attempts);
    }
    expect(attempts).toBeLessThan(10);
  });

  it('is never zero, negative or NaN for a degenerate count', () => {
    // `Date.now() < NaN` is false, so a NaN cooldown would silently never apply.
    for (const n of [0, -1, NaN, undefined]) expect(authCooldownMs(n)).toBe(AUTH_FAILURE_COOLDOWN_MS);
  });
});

describe('connect paths back off on IMAP authentication failure', () => {
  const acct = { id: 'auth-acct', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
  let connectError;
  let intervalSpy;

  function newManager() {
    const mgr = new ImapManager(null);
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    mgr.broadcast = vi.fn();
    return mgr;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    intervalSpy = vi.spyOn(globalThis, 'setInterval');
    connectError = gmailXoauthFailure;
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn(() => Promise.reject(connectError())),
        close: vi.fn(),
        logout: vi.fn(() => Promise.resolve()),
      });
      return client;
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const syncErrorWrites = () => query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1'));

  it('records the real server text at once and arms a long, bounded cooldown', async () => {
    const mgr = newManager();
    const before = Date.now();
    expect(await mgr.connectAccount(acct)).toBe(false);

    expect(syncErrorWrites()).toHaveLength(1);
    expect(syncErrorWrites()[0][1]).toEqual(['[AUTHENTICATIONFAILED] Invalid credentials (Failure) (oauth status 400)', acct.id]);
    expect(AUTH_FAILURE_COOLDOWN_MS).toBe(30 * 60 * 1000);
    const cd = mgr._connectCooldown.get(acct.id);
    expect(cd.until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(cd.until).toBeLessThanOrEqual(Date.now() + AUTH_FAILURE_COOLDOWN_MS);
  });

  it('climbs the auth ladder and keeps it bounded when auth keeps failing after it expires', async () => {
    const mgr = newManager();
    const waits = [];
    for (let i = 0; i < 8; i++) {
      const before = Date.now();
      await mgr.connectAccount(acct);
      waits.push(mgr._connectCooldown.get(acct.id).until - before);
      mgr._connectCooldown.get(acct.id).until = 0; // let the next attempt through
    }
    // 30 min, 1 h, 2 h, 4 h, then the 6 h cap (a few ms of slack for the clock between reads).
    expect(waits[0]).toBeGreaterThanOrEqual(AUTH_FAILURE_COOLDOWN_MS);
    expect(waits[1]).toBeGreaterThanOrEqual(2 * AUTH_FAILURE_COOLDOWN_MS);
    expect(waits[3]).toBeGreaterThanOrEqual(8 * AUTH_FAILURE_COOLDOWN_MS);
    for (const w of waits) expect(w).toBeLessThanOrEqual(AUTH_FAILURE_COOLDOWN_MAX_MS + 1000);
    expect(waits[7]).toBeGreaterThanOrEqual(AUTH_FAILURE_COOLDOWN_MAX_MS);
  });

  it('does not let earlier refusals push the first auth wait past the floor, nor reset the ladder', async () => {
    const mgr = newManager();
    for (let i = 0; i < 4; i++) mgr._noteConnectionRefusal(acct);
    let before = Date.now();
    mgr._noteAuthFailure(acct);
    expect(mgr._connectCooldown.get(acct.id).until - before).toBeLessThanOrEqual(AUTH_FAILURE_COOLDOWN_MS + 1000);
    // A refusal in between keeps the ladder's position: the next rejected login waits an hour.
    mgr._noteConnectionRefusal(acct);
    before = Date.now();
    mgr._noteAuthFailure(acct);
    expect(mgr._connectCooldown.get(acct.id).until - before).toBeGreaterThanOrEqual(2 * AUTH_FAILURE_COOLDOWN_MS);
  });

  it('takes the auth ladder for AUTHENTICATIONFAILED even when the text reads like a refusal', async () => {
    connectError = () => imapErr({
      response: '1 NO [AUTHENTICATIONFAILED] Invalid credentials, try again later',
      responseStatus: 'NO',
      responseText: 'Invalid credentials, try again later',
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
    });
    const mgr = newManager();
    const before = Date.now();
    await mgr.connectAccount(acct);
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(mgr._connectCooldown.get(acct.id).authFailures).toBe(1);
  });

  it('keeps the health check from reconnecting the account during the cooldown', async () => {
    const mgr = newManager();
    const healthCheck = intervalSpy.mock.calls.find(([, ms]) => ms === 90000)[0];
    await mgr.connectAccount(acct);
    ImapFlow.mockClear();
    const connectSpy = vi.spyOn(mgr, 'connectAccount');
    query.mockImplementation(async (sql) => ({ rows: sql.includes('SELECT id, email_address') ? [{ id: acct.id, email_address: 'u@example.com' }] : [acct] }));
    await healthCheck();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('leaves a login-stage connection limit on the short refusal backoff without painting the account red', async () => {
    connectError = loginLimitRefusal;
    const mgr = newManager();
    const before = Date.now();
    await mgr.connectAccount(acct);
    const cd = mgr._connectCooldown.get(acct.id);
    expect(cd.until).toBeLessThan(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(cd.until).toBeGreaterThanOrEqual(before + connectCooldownMs(1));
    expect(syncErrorWrites()).toHaveLength(0);
  });

  it('gives an OAuth account the same cooldown once its forced token refresh and single retry were rejected', async () => {
    const mgr = newManager();
    const oauthAcct = { ...acct, id: 'oauth-acct', oauth_provider: 'google', oauth_access_token: 'enc' };
    const before = Date.now();
    await mgr.connectAccount(oauthAcct);
    expect(ensureFreshOAuthAccount.mock.calls.filter(([, opts]) => opts?.force)).toHaveLength(1);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    expect(mgr._connectCooldown.get(oauthAcct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
  });

  it('lets an explicit reconnect through once the cooldown is cleared', async () => {
    const mgr = newManager();
    await mgr.connectAccount(acct);
    ImapFlow.mockClear();
    expect(await mgr.connectAccount(acct)).toBe(false);
    expect(ImapFlow).not.toHaveBeenCalled();

    mgr.clearConnectCooldown(acct.id);
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    await mgr.connectAccount(acct);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });

  it('arms the same cooldown when the interval reconnect hits an auth failure', async () => {
    const mgr = newManager();
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [] }));
    const before = Date.now();
    await mgr._syncTick(acct);
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(syncErrorWrites()).toHaveLength(1);
  });

  it('arms the auth cooldown and surfaces the error when the sync tick itself is rejected', async () => {
    // A persistent client is already connected, so the reconnect branch is not taken: the
    // rejection comes from the sync (on a fresh-login provider, its own login).
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn(), logout: vi.fn(() => Promise.resolve()) }));
    mgr.syncFolders = vi.fn().mockResolvedValue({});
    mgr.syncMessages = vi.fn().mockRejectedValue(gmailXoauthFailure());
    const before = Date.now();
    await mgr._syncTick(acct);
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(syncErrorWrites()).toHaveLength(1);
  });

  it('arms the auth cooldown, not the refusal one, when the folder status client is rejected', async () => {
    const mgr = newManager();
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [] }));
    const before = Date.now();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(mgr._bgConnSem.activeCount('imap.example.com')).toBe(0);
  });

  it('does not arm the auth cooldown from the folder status client while the persistent connection is up', async () => {
    // Gmail runs folder status on the pool. One rejected pool grow (e.g. a transient
    // AUTHENTICATIONFAILED right after a token refresh) must not stop the sync tick and new-mail
    // handling of an account whose persistent connection is working, for 30 min to 6 h.
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [] }));
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(mgr._bgConnSem.activeCount('imap.example.com')).toBe(0);
  });

  it('puts the status client alone on the auth ladder, records the error and keeps it through healthy syncs', async () => {
    // A stale password while IDLE stays up: the status monitor must not retry the rejected login
    // every few minutes forever (fail2ban on mailcow bans the server IP for that), and someone
    // has to be told.
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
    const before = Date.now();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    const cd = mgr._secondaryAuthCooldown.get(acct.id);
    expect(cd.until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(syncErrorWrites()).toHaveLength(1);
    expect(syncErrorWrites()[0][1][0]).toMatch(/AUTHENTICATIONFAILED/);

    // Within the cooldown no login is attempted at all.
    ImapFlow.mockClear();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow('Folder status login cooldown active');
    expect(ImapFlow).not.toHaveBeenCalled();

    // A healthy sync tick does not wipe the recorded error while the status login stays rejected.
    await mgr._clearAccountError(acct);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = NULL'))).toBe(false);

    // The next rejection after expiry climbs the ladder: one hour.
    cd.until = 0;
    const again = Date.now();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    expect(mgr._secondaryAuthCooldown.get(acct.id).until).toBeGreaterThanOrEqual(again + 2 * AUTH_FAILURE_COOLDOWN_MS);
    // The account-wide ladder, which would stop the sync tick, is still untouched.
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
  });

  it('lifts the secondary auth window and the error once the status login works again', async () => {
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    mgr._secondaryAuthCooldown.get(acct.id).until = 0;
    connectError = null;
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), { connect: vi.fn().mockResolvedValue(), close: vi.fn(), logout: vi.fn() });
    });
    await mgr._withCountClient(acct, async () => {});
    expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = NULL'))).toBe(true);
  });

  it('lets an explicit reconnect or settings save lift the secondary auth window too', async () => {
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    mgr.clearConnectCooldown(acct.id);
    expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
  });

  it('arms the same cooldown and surfaces the error when a poll-only tick hits an auth failure', async () => {
    const mgr = newManager();
    const before = Date.now();
    await mgr._pollOnlyTick(acct);
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(syncErrorWrites()).toHaveLength(1);
    expect(mgr._bgConnSem.activeCount('imap.example.com')).toBe(0);
  });
});

describe('backfill stops on a provider refusal (#433)', () => {
  const acct = { id: 'bf-acct', user_id: 'u1', enabled: true, imap_host: 'imap.mail.yahoo.com', imap_tls: true };

  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function backfillManager() {
    return {
      backfillRunning: new Set(),
      ...backoffState(),
      broadcast: vi.fn(),
      pluginFacade: {},
      _noteConnectionRefusal: vi.fn(),
      // Real first step of every backfill failure catch; it returns false for non-OAuth errors.
      _handleOAuthRefreshFailure: ImapManager.prototype._handleOAuthRefreshFailure,
    };
  }
  function rejectConnectWith(makeErr) {
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), { connect: vi.fn(() => Promise.reject(makeErr())), close: vi.fn(), logout: vi.fn() });
    });
  }

  it('notes the refusal once, logs the server text and reports a refused outcome', async () => {
    rejectConnectWith(loginLimitRefusal);
    const mgr = backfillManager();
    const outcome = await ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
    expect(outcome).toEqual({ aborted: 'refused' });
    // A background login: the secondary backoff, never the cooldown that gates live sync.
    expect(mgr._noteSecondaryRefusal).toHaveBeenCalledTimes(1);
    expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
    const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).toContain('[LIMIT] Too many simultaneous connections');
    expect(mgr.backfillRunning.size).toBe(0);
  });

  it('treats a code-only availability refusal as a refusal, not as a folder to skip', async () => {
    // Without matching text the refusal used to fall through, and backfillAllFolders logged in to
    // the next folder straight away.
    rejectConnectWith(() => imapErr({
      response: '1 NO [UNAVAILABLE] LOGIN failure. Server error',
      responseStatus: 'NO',
      responseText: 'LOGIN failure. Server error',
      serverResponseCode: 'UNAVAILABLE',
      authenticationFailed: true,
    }));
    const mgr = backfillManager();
    const outcome = await ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
    expect(outcome).toEqual({ aborted: 'refused' });
    // A background login: the secondary backoff, never the cooldown that gates live sync.
    expect(mgr._noteSecondaryRefusal).toHaveBeenCalledTimes(1);
    expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
  });

  it('reports an auth outcome and puts the rejection on the secondary auth handling', async () => {
    rejectConnectWith(gmailXoauthFailure);
    const mgr = backfillManager();
    const outcome = await ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
    expect(outcome).toEqual({ aborted: 'auth' });
    expect(mgr._noteSecondaryAuthFailure).toHaveBeenCalledTimes(1);
    expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
    expect(mgr._noteSecondaryRefusal).not.toHaveBeenCalled();
  });

  // Mid-folder reconnect: the first login succeeds and the first batch fails, which forces the
  // periodic openBfClient() reconnect after errorDelay. Later logins use `reconnect`.
  describe('mid-folder reconnect', () => {
    const { errorDelay } = providerProfile(acct);

    beforeEach(() => {
      vi.useFakeTimers();
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT id, enabled FROM email_accounts')) return { rows: [{ id: acct.id, enabled: true }] };
        if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '0', max_uid: '0' }] };
        return { rows: [] };
      });
    });
    afterEach(() => { vi.useRealTimers(); });

    function connectOnceThen(reconnect) {
      let logins = 0;
      ImapFlow.mockImplementation(function () {
        logins++;
        if (logins > 1) {
          return Object.assign(new EventEmitter(), { connect: vi.fn(() => reconnect()), close: vi.fn(), logout: vi.fn() });
        }
        let locks = 0;
        return Object.assign(new EventEmitter(), {
          connect: vi.fn().mockResolvedValue(),
          close: vi.fn(),
          logout: vi.fn().mockResolvedValue(),
          mailbox: { exists: 3 },
          getMailboxLock: vi.fn(async () => {
            if (++locks > 1) throw new Error('Connection closed');
            return { release: vi.fn() };
          }),
          search: vi.fn().mockResolvedValue([1, 2, 3]),
        });
      });
    }

    it('stops after one refused reconnect instead of retrying every errorDelay', async () => {
      connectOnceThen(() => Promise.reject(loginLimitRefusal()));
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      expect(await p).toEqual({ aborted: 'refused' });
      expect(mgr._noteSecondaryRefusal).toHaveBeenCalledTimes(1);
      expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
      const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('[LIMIT] Too many simultaneous connections');
      expect(logged).not.toContain('Command failed');
      expect(mgr.backfillRunning.size).toBe(0);
    });

    it('reports an auth outcome when the reconnect login is rejected', async () => {
      connectOnceThen(() => Promise.reject(gmailXoauthFailure()));
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      expect(await p).toEqual({ aborted: 'auth' });
      expect(mgr._noteSecondaryAuthFailure).toHaveBeenCalledTimes(1);
      expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
      const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
    });

    it('does not log in again while a connect cooldown is active', async () => {
      const reconnect = vi.fn(() => Promise.reject(loginLimitRefusal()));
      connectOnceThen(reconnect);
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      // Armed elsewhere (e.g. connectAccount) while this folder is mid-backfill.
      mgr._connectCooldown.set(acct.id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 });
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(await p).toEqual({ aborted: 'cooldown' });
      expect(reconnect).not.toHaveBeenCalled();
      expect(mgr.backfillRunning.size).toBe(0);
    });

    it('does not log in again once another background login armed the secondary backoff', async () => {
      const reconnect = vi.fn(() => Promise.reject(loginLimitRefusal()));
      connectOnceThen(reconnect);
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      // The folder status client was refused while this folder is mid-backfill.
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      expect(await p).toEqual({ aborted: 'cooldown' });
      expect(reconnect).not.toHaveBeenCalled();
    });

    it('still retries a transient reconnect failure after errorDelay', async () => {
      let attempts = 0;
      connectOnceThen(() => (++attempts === 1 ? Promise.reject(new Error('Socket timeout')) : Promise.reject(loginLimitRefusal())));
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      await vi.advanceTimersByTimeAsync(errorDelay);
      expect(await p).toEqual({ aborted: 'refused' });
      expect(ImapFlow).toHaveBeenCalledTimes(3);
    });

    // Disabled while a folder is mid-backfill: the loop must end instead of retrying forever
    // behind the per-host background slot.
    function disableAfterFirstLogin({ loopTopSeesDisabled }) {
      let rowReads = 0;
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) {
          return { rows: [{ ...acct, enabled: ++rowReads === 1 }] };
        }
        if (/^SELECT id\b.* FROM email_accounts/.test(sql)) {
          return { rows: [{ id: acct.id, enabled: !loopTopSeesDisabled }] };
        }
        if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '0', max_uid: '0' }] };
        return { rows: [] };
      });
    }
    async function settleWithin(p, steps) {
      let settled = false;
      let value;
      p.then(v => { settled = true; value = v; });
      for (let n = 0; n < steps && !settled; n++) await vi.advanceTimersByTimeAsync(errorDelay * 6);
      return { settled, value };
    }

    it('stops with a disabled outcome when the loop-top check sees the account disabled', async () => {
      disableAfterFirstLogin({ loopTopSeesDisabled: true });
      connectOnceThen(() => Promise.resolve());
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      const { settled, value } = await settleWithin(p, 5);
      expect(settled).toBe(true);
      expect(value).toEqual({ aborted: 'disabled' });
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr.backfillRunning.size).toBe(0);
    });

    it('stops with a disabled outcome when the mid-folder reconnect finds the account disabled', async () => {
      disableAfterFirstLogin({ loopTopSeesDisabled: false });
      connectOnceThen(() => Promise.resolve());
      const mgr = backfillManager();
      const p = ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent');
      const { settled, value } = await settleWithin(p, 5);
      expect(settled).toBe(true);
      expect(value).toEqual({ aborted: 'disabled' });
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr._noteConnectionRefusal).not.toHaveBeenCalled();
      expect(mgr.backfillRunning.size).toBe(0);
    });

    it('releases the per-host slot and running flags when an account is disabled mid-backfill', async () => {
      disableAfterFirstLogin({ loopTopSeesDisabled: false });
      connectOnceThen(() => Promise.resolve());
      const mgr = {
        ...backfillManager(),
        backfillAllRunning: new Set(),
        _bgConnSem: createKeyedSemaphore(2),
        refreshBulkFlags: vi.fn().mockResolvedValue(),
        startSnippetIndexer: vi.fn().mockResolvedValue(),
        startProviderIdBackfill: vi.fn().mockResolvedValue(),
      };
      mgr.backfillMessages = vi.fn(ImapManager.prototype.backfillMessages);
      const p = ImapManager.prototype.backfillAllFolders.call(mgr, acct);
      const { settled } = await settleWithin(p, 5);
      expect(settled).toBe(true);
      expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX']);
      expect(mgr._bgConnSem.activeCount('imap.mail.yahoo.com')).toBe(0);
      expect(mgr.backfillRunning.size).toBe(0);
      expect(mgr.backfillAllRunning.has(acct.id)).toBe(false);
      expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'backfill_all_complete', accountId: acct.id });
    });
  });

  it('opens no login at all while a background backoff is armed', async () => {
    // The integrity-gap and UIDVALIDITY callers reach backfillMessages directly, without the
    // folder walk's own check.
    ImapFlow.mockImplementation(function () { throw new Error('no login expected'); });
    for (const arm of [
      m => m._secondaryCooldown.set(acct.id, { until: Date.now() + 30000, failures: 1 }),
      m => m._secondaryAuthCooldown.set(acct.id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 }),
    ]) {
      const mgr = backfillManager();
      arm(mgr);
      expect(await ImapManager.prototype.backfillMessages.call(mgr, acct, 'Sent')).toEqual({ aborted: 'cooldown' });
      expect(mgr.backfillRunning.size).toBe(0);
    }
  });

  it('skips the whole folder walk while the secondary backoff is armed', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }] }));
    const mgr = allFoldersManager(async () => undefined);
    mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 30000, failures: 1 });
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages).not.toHaveBeenCalled();
  });

  it('stops the folder loop on a cooldown outcome', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }, { path: 'B' }] }));
    const mgr = allFoldersManager(async (_m, folder) => (folder === 'A' ? { aborted: 'cooldown' } : undefined));
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX', 'A']);
  });

  function allFoldersManager(backfillImpl) {
    const mgr = {
      backfillAllRunning: new Set(),
      _bgConnSem: createKeyedSemaphore(2),
      ...backoffState(),
      broadcast: vi.fn(),
      refreshBulkFlags: vi.fn().mockResolvedValue(),
      startSnippetIndexer: vi.fn().mockResolvedValue(),
      startProviderIdBackfill: vi.fn().mockResolvedValue(),
    };
    mgr.backfillMessages = vi.fn((account, folder) => backfillImpl(mgr, folder));
    return mgr;
  }

  it('does not open logins for the remaining folders once one is refused', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }, { path: 'B' }, { path: 'C' }] }));
    const mgr = allFoldersManager(async (m, folder) => {
      if (folder !== 'A') return undefined;
      m._connectCooldown.set(acct.id, { until: Date.now() + 30000, failures: 1 });
      return { aborted: 'refused' };
    });
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX', 'A']);
    expect(mgr._bgConnSem.activeCount('imap.mail.yahoo.com')).toBe(0);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'backfill_all_complete', accountId: acct.id });
    expect(mgr.backfillAllRunning.has(acct.id)).toBe(false);
  });

  it('stops on an aborted outcome even when no cooldown was armed', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }, { path: 'B' }] }));
    const mgr = allFoldersManager(async (_m, folder) => (folder === 'INBOX' ? { aborted: 'auth' } : undefined));
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX']);
    expect(mgr._bgConnSem.activeCount('imap.mail.yahoo.com')).toBe(0);
  });

  it('skips the whole run while the account is cooling down', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }] }));
    const mgr = allFoldersManager(async () => undefined);
    mgr._connectCooldown.set(acct.id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 });
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages).not.toHaveBeenCalled();
    expect(mgr._bgConnSem.activeCount('imap.mail.yahoo.com')).toBe(0);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'backfill_all_complete', accountId: acct.id });
  });

  it('still backfills every folder when nothing is refused', async () => {
    query.mockImplementation(async () => ({ rows: [{ path: 'A' }, { path: 'B' }] }));
    const mgr = allFoldersManager(async () => undefined);
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX', 'A', 'B']);
  });
});

describe('Yahoo connection budget (#433)', () => {
  // Yahoo accepts about three simultaneous sessions per account; a fourth login is refused with
  // "[LIMIT] Rate limit hit" and existing sessions are dropped.
  const yahoo = { id: 'yahoo-budget', user_id: 'u1', enabled: true, imap_host: 'imap.mail.yahoo.com', imap_tls: true };
  const yahooHost = 'imap.mail.yahoo.com';

  function newManager() {
    const mgr = new ImapManager(null);
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    mgr.broadcast = vi.fn();
    return mgr;
  }
  function trackedClients() {
    const clients = [];
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([]),
        fetch: vi.fn(async function* () {}),
      });
      clients.push(client);
      return client;
    });
    return clients;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('gives a Yahoo host one background connection and leaves other hosts at two', () => {
    const mgr = newManager();
    expect(mgr._bgConnSem.tryAcquire(yahooHost)).toBe(true);
    expect(mgr._bgConnSem.tryAcquire(yahooHost)).toBe(false);
    expect(mgr._bgConnSem.tryAcquire('imap.example.com')).toBe(true);
    expect(mgr._bgConnSem.tryAcquire('imap.example.com')).toBe(true);
    expect(mgr._bgConnSem.tryAcquire('imap.example.com')).toBe(false);
  });

  it('sizes the body-fetch pool from the provider profile', () => {
    expect(poolSizeFor(yahoo)).toBe(1);
    expect(poolSizeFor({ imap_host: 'imap.example.com' })).toBe(4);
  });

  it('probes a Yahoo account on its pooled session, taking no background connection', async () => {
    // The probe used to be one more Yahoo login every 3 minutes, and took the host's one
    // background connection for it. It now rides the account's pooled session (secondaryOverPool),
    // so a backfill holding that background connection does not stop it, and it opens no login.
    const acct = { ...yahoo, id: 'yahoo-budget-probe' };
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const probeCycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    mgr.connections.set(acct.id, { close: vi.fn() });
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [acct] }));
    const clients = trackedClients();
    releasePooledClient(acct, await acquirePooledClient(acct)); // the one pooled session
    expect(clients).toHaveLength(1);

    await mgr._bgConnSem.acquire(yahooHost); // e.g. a backfill holds it
    await probeCycle();
    expect(clients).toHaveLength(1);
    expect(clients[0].search).toHaveBeenCalledWith({ uid: '101:*' }, { uid: true });
    expect(clients[0].close).not.toHaveBeenCalled();
    expect(mgr._bgConnSem.activeCount(yahooHost)).toBe(1);
    mgr._bgConnSem.release(yahooHost);
    evictPool(acct.id);
  });

  it('still probes an account on a host without a background budget', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const probeCycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    const generic = { ...yahoo, id: 'generic-probe', imap_host: 'imap.example.com' };
    mgr.connections.set(generic.id, { close: vi.fn() });
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [generic] }));
    const clients = trackedClients();

    await mgr._bgConnSem.acquire('imap.example.com');
    await mgr._bgConnSem.acquire('imap.example.com');
    await probeCycle();
    expect(clients).toHaveLength(1);
    expect(mgr._bgConnSem.activeCount('imap.example.com')).toBe(2);
  });

  it('waits for a background connection before refreshing bulk flags', async () => {
    const mgr = newManager();
    query.mockImplementation(async sql => {
      if (sql.includes('is_bulk IS NULL')) return { rows: [{ id: 'm1', uid: '7', folder: 'INBOX' }] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [yahoo] };
      return { rows: [] };
    });
    const clients = trackedClients();

    await mgr._bgConnSem.acquire(yahooHost);
    const refresh = mgr.refreshBulkFlags(yahoo);
    await new Promise(r => setTimeout(r, 0));
    expect(clients).toHaveLength(0);

    mgr._bgConnSem.release(yahooHost);
    await refresh;
    expect(clients).toHaveLength(1);
    expect(mgr._bgConnSem.activeCount(yahooHost)).toBe(0);
  });
});

describe('backfillAllFolders reuses one connection across folders', () => {
  const acct = { id: 'bf-shared', user_id: 'u1', enabled: true, imap_host: 'imap.example.com', imap_tls: true };
  // INBOX is complete (its only UID is cached) and A/B are empty: both early exits of backfillMessages.
  const exists = { INBOX: 1, A: 0, B: 0 };
  let clients;
  let lockFailure;

  function trackClients({ dropAfterInbox = false } = {}) {
    clients = [];
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        usable: true,
        mailbox: null,
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(function () { this.usable = false; }),
        logout: vi.fn(async function () { this.usable = false; }),
        getMailboxLock: vi.fn(async function (path) {
          if (lockFailure?.(path)) throw new Error('Command failed');
          this.mailbox = { path, exists: exists[path], uidValidity: 1 };
          return { release: vi.fn(() => { if (dropAfterInbox && path === 'INBOX') this.usable = false; }) };
        }),
        search: vi.fn().mockResolvedValue([1]),
      });
      clients.push(client);
      return client;
    });
  }

  function manager() {
    const mgr = {
      backfillRunning: new Set(),
      backfillAllRunning: new Set(),
      _bgConnSem: createKeyedSemaphore(2),
      ...backoffState(),
      broadcast: vi.fn(),
      pluginFacade: {},
      _noteConnectionRefusal: vi.fn(),
      _handleOAuthRefreshFailure: ImapManager.prototype._handleOAuthRefreshFailure,
      refreshBulkFlags: vi.fn().mockResolvedValue(),
      startSnippetIndexer: vi.fn().mockResolvedValue(),
      startProviderIdBackfill: vi.fn().mockResolvedValue(),
    };
    mgr.backfillMessages = vi.fn(ImapManager.prototype.backfillMessages);
    return mgr;
  }
  const lockedPaths = client => client.getMailboxLock.mock.calls.map(c => c[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    lockFailure = null;
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.startsWith('SELECT path FROM folders')) return { rows: [{ path: 'A' }, { path: 'B' }] };
      if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '1', max_uid: '1' }] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: '1' }] };
      return { rows: [] };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('logs in once for every folder and closes once at the end', async () => {
    trackClients();
    const mgr = manager();
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX', 'A', 'B']);
    expect(clients).toHaveLength(1);
    expect(lockedPaths(clients[0])).toEqual(['INBOX', 'A', 'B']);
    // close(), not an awaited LOGOUT: the host slot is released only after the teardown.
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[0].logout).not.toHaveBeenCalled();
    expect(mgr._bgConnSem.activeCount('imap.example.com')).toBe(0);
  });

  it('drops the connection after a failed folder and continues on a new login', async () => {
    trackClients();
    lockFailure = path => path === 'A';
    const mgr = manager();
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(mgr.backfillMessages.mock.calls.map(c => c[1])).toEqual(['INBOX', 'A', 'B']);
    expect(clients).toHaveLength(2);
    expect(lockedPaths(clients[0])).toEqual(['INBOX', 'A']);
    expect(clients[0].close).toHaveBeenCalled();
    expect(lockedPaths(clients[1])).toEqual(['B']);
    expect(clients[1].close).toHaveBeenCalledTimes(1);
    expect(clients[1].logout).not.toHaveBeenCalled();
  });

  it('logs in again instead of skipping a folder when the server closed the connection in between', async () => {
    trackClients({ dropAfterInbox: true });
    const mgr = manager();
    await ImapManager.prototype.backfillAllFolders.call(mgr, acct);
    expect(clients).toHaveLength(2);
    expect(lockedPaths(clients[0])).toEqual(['INBOX']);
    expect(lockedPaths(clients[1])).toEqual(['A', 'B']);
  });

  it('still owns and closes its connection when a single folder is backfilled on its own', async () => {
    trackClients();
    const mgr = manager();
    await ImapManager.prototype.backfillMessages.call(mgr, acct, 'A');
    expect(clients).toHaveLength(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[0].logout).not.toHaveBeenCalled();
  });
});

describe('backfill and UIDs the server will not hand over', () => {
  const acct = { id: 'bf-ghost', user_id: 'u1', enabled: true, imap_host: 'imap.example.com', imap_tls: true };
  let fetchedRanges;
  let suppressedRows;
  let uidValidity;

  function install({ serverUids, returns }) {
    fetchedRanges = [];
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        usable: true,
        mailbox: null,
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn(async function (path) {
          this.mailbox = { path, exists: serverUids.length, uidValidity };
          return { release: vi.fn() };
        }),
        search: vi.fn().mockResolvedValue(serverUids),
        fetch: vi.fn(async function* (range) {
          fetchedRanges.push(range);
          for (const uid of String(range).split(',').map(Number)) if (returns.has(uid)) yield { uid };
        }),
      });
    });
  }

  function manager() {
    return {
      backfillRunning: new Set(),
      ...backoffState(),
      broadcast: vi.fn(),
      pluginFacade: {},
      _noteConnectionRefusal: vi.fn(),
      _handleOAuthRefreshFailure: ImapManager.prototype._handleOAuthRefreshFailure,
    };
  }

  const unfetchableCalls = () => query.mock.calls.filter(([sql]) => /unfetchable_uids/.test(sql));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    suppressedRows = [];
    uidValidity = 7;
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.startsWith('SELECT id, enabled FROM email_accounts')) return { rows: [{ id: acct.id, enabled: true }] };
      if (sql.startsWith('SELECT uid_validity FROM folders')) return { rows: [{ uid_validity: uidValidity == null ? null : String(uidValidity) }] };
      if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '1', max_uid: '1' }] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: '1' }] };
      if (/FROM unfetchable_uids/.test(sql)) return { rows: suppressedRows };
      return { rows: [], rowCount: 0 };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function backfill() {
    const run = ImapManager.prototype.backfillMessages.call(manager(), acct, 'INBOX');
    await vi.advanceTimersByTimeAsync(60000);
    return run;
  }

  it('records a withheld UID against the epoch and clears one that arrived', async () => {
    install({ serverUids: [1, 2, 3], returns: new Set([3]) });
    await backfill();
    const insert = unfetchableCalls().find(([sql]) => /^INSERT INTO unfetchable_uids/.test(sql.trim()));
    expect(insert[1]).toEqual([acct.id, 'INBOX', ['2'], '7']);
    const clear = unfetchableCalls().find(([sql]) => /^DELETE FROM unfetchable_uids/.test(sql.trim()));
    expect(clear[1]).toEqual([acct.id, 'INBOX', ['3']]);
  });

  it('does not ask again for a UID the server has refused often enough', async () => {
    suppressedRows = [{ uid: '2' }];
    install({ serverUids: [1, 2, 3], returns: new Set([3]) });
    await backfill();
    expect(fetchedRanges).toEqual(['3']);
    expect(unfetchableCalls().some(([sql]) => /^INSERT/.test(sql.trim()))).toBe(false);
  });

  it('neither suppresses nor records anything when the server reports no UIDVALIDITY', async () => {
    uidValidity = undefined;
    suppressedRows = [{ uid: '2' }];
    install({ serverUids: [1, 2, 3], returns: new Set([3]) });
    await backfill();
    // UID 2 is still requested: without an epoch a suppression could hide a real message.
    expect(fetchedRanges[0]).toBe('3,2');
    expect(unfetchableCalls()).toHaveLength(0);
  });
});
describe('rerootThreadChildren', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 0 }); });

  it('moves provisional children, deleted ones included, to the resolved root', async () => {
    await rerootThreadChildren('acct-1', '<root@x>', '<child@x>');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages SET thread_id = \$1/);
    // The row no longer hangs on a provisional root but on the resolved one, so the reason it
    // still carries ('rfc-provisional', or NULL from before migration 0063) stops being true.
    expect(sql).toMatch(/UPDATE messages SET thread_id = \$1, threading_reason = 'rfc-root'/);
    expect(sql).toMatch(/account_id = \$2 AND thread_id = \$3 AND message_id != \$3/);
    // Soft-deleted rows feed the ancestor lookup too, so they must follow the root; the full
    // idx_messages_account_thread (migration 0076) serves the statement without the predicate.
    // services/threading/threadIndex.pglite.test.js checks both against a real engine.
    expect(sql).not.toMatch(/is_deleted/);
    expect(params).toEqual(['<root@x>', 'acct-1', '<child@x>']);
  });
});
describe('Gmail profile for many accounts on one server', () => {
  const gmail = { id: 'gmail-scale', user_id: 'u1', enabled: true, imap_host: 'imap.gmail.com', imap_tls: true };
  const stopTimers = mgr => { for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]); };

  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('turns off the staleness probe and the reconnect backfill, and widens the background budget', () => {
    const p = providerProfile(gmail);
    expect(p.stalenessProbe).toBe(false);
    expect(p.autoBackfillExistingOnConnect).toBe(false);
    expect(p.maxBackgroundConnections).toBe(6);
  });

  it('gives imap.gmail.com six background connections', () => {
    const mgr = new ImapManager(null);
    stopTimers(mgr);
    for (let i = 0; i < 6; i++) expect(mgr._bgConnSem.tryAcquire('imap.gmail.com')).toBe(true);
    expect(mgr._bgConnSem.tryAcquire('imap.gmail.com')).toBe(false);
  });

  it('backfills an empty Gmail account on connect but not one that already has mail', async () => {
    const gate = acct => ImapManager.prototype._shouldAutoBackfillOnConnect.call({}, acct);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await gate(gmail)).toBe(true);
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await gate(gmail)).toBe(false);
  });

  it('does not open a staleness-probe login for a Gmail account', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const probeCycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    stopTimers(mgr);
    mgr.connections.set(gmail.id, { close: vi.fn() });
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [gmail] }));
    await probeCycle();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('MAX(uid)'))).toBe(false);
  });

  describe('folder status and integrity sync on a pooled session', () => {
    let clients;
    beforeEach(() => {
      clients = [];
      ImapFlow.mockImplementation(function () {
        const client = Object.assign(new EventEmitter(), {
          usable: true,
          connect: vi.fn().mockResolvedValue(),
          logout: vi.fn().mockResolvedValue(),
        });
        client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
        clients.push(client);
        return client;
      });
    });
    const managerFor = acct => {
      const mgr = new ImapManager(null);
      stopTimers(mgr);
      vi.spyOn(mgr._bgConnSem, 'acquire');
      query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [acct] : [] }));
      return mgr;
    };

    it('uses the pool for Gmail and a larger pool to leave room for user actions', () => {
      expect(providerProfile(gmail).statusOnPool).toBe(true);
      expect(poolSizeFor(gmail)).toBe(3);
      expect(providerProfile({ imap_host: 'imap.mail.yahoo.com' }).statusOnPool).toBeUndefined();
    });

    it('opens one Gmail login for many status cycles and takes no background slot', async () => {
      const acct = { ...gmail, id: 'gmail-status-pool' };
      const mgr = managerFor(acct);
      _resetImapMetrics();
      const seen = [];
      for (let i = 0; i < 3; i++) await mgr._withCountClient(acct, async client => { seen.push(client); });
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      // The diagnostics counters see the same single login.
      expect(getImapSnapshot(host => host).logins).toEqual([
        expect.objectContaining({ provider: 'imap.gmail.com', purpose: 'IMAP pool connect', total: 1, failures: 0 }),
      ]);
      expect(new Set(seen).size).toBe(1);
      expect(mgr._bgConnSem.acquire).not.toHaveBeenCalled();
      expect(clients[0].close).not.toHaveBeenCalled();
    });

    it('closes the pooled session when an integrity flag scan is deferred, and issues no SEARCH behind it', async () => {
      // A deferred scan leaves its FETCH running on the session. On Gmail the session is pooled,
      // so returning normally would hand that busy session to the next user action.
      vi.useFakeTimers();
      try {
        const acct = { ...gmail, id: 'gmail-integrity-deferred' };
        const mgr = managerFor(acct);
        mgr.syncMessages = vi.fn().mockResolvedValue({});
        query.mockImplementation(async sql => {
          if (sql.includes('FROM email_accounts')) return { rows: [acct] };
          if (sql.includes('status_synced_modseq FROM folders')) return { rows: [{ status_synced_modseq: '5' }] };
          return { rows: [] };
        });
        const search = vi.fn(async () => [1, 2, 3]);
        ImapFlow.mockImplementation(function () {
          const client = Object.assign(new EventEmitter(), {
            usable: true,
            connect: vi.fn().mockResolvedValue(),
            logout: vi.fn().mockResolvedValue(),
            mailbox: { exists: 3, uidValidity: 8n, highestModseq: 9n, uidNext: 10 },
            capabilities: new Map([['CONDSTORE', true]]),
            getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
            search,
            // Hangs forever; the unreachable yield only satisfies require-yield.
            fetch: async function* () { await new Promise(() => {}); yield null; },
          });
          client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
          clients.push(client);
          return client;
        });
        const pass = expect(mgr._refreshObservedFolder(acct, 'INBOX', { uidValidity: 8n, uidNext: 10, highestModseq: 9n }))
          .rejects.toThrow(/deferred/);
        await vi.advanceTimersByTimeAsync(25000);
        await pass;
        expect(clients).toHaveLength(1);
        expect(clients[0].close).toHaveBeenCalled();
        expect(search).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(false);
      } finally { vi.useRealTimers(); }
    });

    it('closes a pooled session whose job failed, so a timed-out FETCH is never handed on', async () => {
      const acct = { ...gmail, id: 'gmail-status-pool-failure' };
      const mgr = managerFor(acct);
      await expect(mgr._withCountClient(acct, async () => { throw new Error('Folder integrity sync timed out'); }))
        .rejects.toThrow('timed out');
      expect(clients[0].close).toHaveBeenCalledOnce();
      await mgr._withCountClient(acct, async () => {});
      expect(ImapFlow).toHaveBeenCalledTimes(2);
    });

    it('skips the cycle instead of opening a temporary login when the pool stays busy', async () => {
      vi.useFakeTimers();
      try {
        const acct = { ...gmail, id: 'gmail-status-pool-busy' };
        const mgr = managerFor(acct);
        let finish;
        const hold = new Promise(resolve => { finish = resolve; });
        // Background work fills its share of the pool; the last session stays for user actions.
        const holders = Array.from({ length: backgroundPoolCap(acct) }, () => mgr._withCountClient(acct, () => hold));
        await vi.advanceTimersByTimeAsync(0);
        expect(ImapFlow).toHaveBeenCalledTimes(backgroundPoolCap(acct));
        _resetImapMetrics();
        const busy = expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow('IMAP pool busy');
        await vi.advanceTimersByTimeAsync(10000);
        await busy;
        expect(ImapFlow).toHaveBeenCalledTimes(backgroundPoolCap(acct));
        expect(getImapSnapshot(host => host).events).toEqual([expect.objectContaining({ event: 'pool_busy', total: 1 })]);
        finish();
        await Promise.all(holders);
      } finally { vi.useRealTimers(); }
    });

    it('bounds concurrent Gmail integrity syncs across accounts to the host budget', async () => {
      const mgr = managerFor(gmail);
      let finish;
      const running = new Promise(resolve => { finish = resolve; });
      mgr._refreshObservedFolder = vi.fn(() => running);
      const status = { messages: 1, unseen: 0, uidNext: 2, uidValidity: 1n };
      const accounts = Array.from({ length: 7 }, (_, i) => ({ ...gmail, id: `gmail-integrity-${i}` }));
      const queued = accounts.map(acct => mgr._queueObservedFolder(acct, 'INBOX', status));
      expect(queued).toEqual([true, true, true, true, true, true, false]);
      finish(true);
      await vi.waitFor(() => expect(mgr._statusSyncRunning.size).toBe(0));
      expect(mgr._queueObservedFolder(accounts[6], 'INBOX', status)).toBe(true);
    });

    it('keeps a fresh login and a background slot per cycle for other providers', async () => {
      const acct = { id: 'generic-status-fresh', user_id: 'u1', enabled: true, imap_host: 'imap.example.com', imap_tls: true };
      const mgr = managerFor(acct);
      for (let i = 0; i < 2; i++) await mgr._withCountClient(acct, async () => {});
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      expect(mgr._bgConnSem.acquire).toHaveBeenCalledTimes(2);
      expect(clients.every(c => c.close.mock.calls.length === 1)).toBe(true);
    });
  });
});
describe('health check asserts that IDLE is running', () => {
  const row = { id: 'idle-invariant', email_address: 'a@example.com', imap_host: 'imap.example.com', oauth_provider: null };
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    query.mockResolvedValue({ rows: [row] });
    _resetImapMetrics();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const healthCycleOf = () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const cycle = interval.mock.calls.find(([, ms]) => ms === 90000)[0];
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    return { mgr, cycle };
  };

  it('warns once, and records it for the diagnostics report, after three checks without IDLE', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr, cycle } = healthCycleOf();
    mgr.connections.set(row.id, { idling: false });
    for (let i = 0; i < 4; i++) await cycle();
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('has not been idling'))).toHaveLength(1);
    expect(getImapSnapshot(host => host).events).toEqual([expect.objectContaining({ event: 'idle_not_running', total: 1 })]);
  });

  it('resets the streak when the connection is seen idling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr, cycle } = healthCycleOf();
    const client = { idling: false };
    mgr.connections.set(row.id, client);
    await cycle(); await cycle();
    client.idling = true;
    await cycle();
    client.idling = false;
    await cycle(); await cycle();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('has not been idling'))).toBe(false);
  });
});

// ── reconcileDeletes must not trust a SEARCH result the server contradicts (upstream #472) ──
//
// On a Dovecot account upstream, deleting one letter of 15 logged "removing 15 server-deleted
// message(s)": UID SEARCH ALL came back empty for a folder SELECT had just reported non-empty.
// The Array.isArray guard let the empty array through. Drives the real reconcileDeletes
// through the real pool with a fake ImapFlow; each test uses its own account id because the
// pool is module-level and would otherwise hand back a previous test's client.
describe('reconcileDeletes — SEARCH result vs mailbox.exists (upstream #472)', () => {
  let seq = 0;
  function arrange({ exists, searchResult, dbUids }) {
    const account = { id: `acct-472-${++seq}`, user_id: 'u1', imap_host: 'imap.example.test', email_address: 'x@example.test' };
    const mgr = new ImapManager(null);
    clearInterval(mgr._healthCheckTimer);
    clearInterval(mgr._snippetSchedulerTimer);
    clearInterval(mgr._providerIdSchedulerTimer);
    vi.spyOn(mgr, '_isMoveUidGuarded').mockReturnValue(false);
    mgr.broadcast = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.usable = true;
      client.connect = vi.fn(() => Promise.resolve());
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      client.noop = vi.fn(() => Promise.resolve());
      client.getMailboxLock = vi.fn(async (path) => {
        client.mailbox = { path, exists };
        return { release: vi.fn() };
      });
      client.search = vi.fn(async () => searchResult);
      return client;
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT DISTINCT m.folder')) return { rows: [{ folder: 'INBOX' }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: dbUids.map(uid => ({ uid })) };
      return { rows: [], rowCount: 0 };
    });
    return { mgr, account };
  }
  const deletes = () => query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM messages'));
  afterEach(() => { vi.restoreAllMocks(); ImapFlow.mockReset(); });

  it('does not purge a folder when SEARCH returns nothing but the server says it is non-empty', async () => {
    const { mgr, account } = arrange({ exists: 14, searchResult: [], dbUids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
    await mgr.reconcileDeletes(account);
    expect(deletes()).toHaveLength(0);
  });

  it('does not purge when SEARCH returns fewer UIDs than the server reports', async () => {
    const { mgr, account } = arrange({ exists: 14, searchResult: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], dbUids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
    await mgr.reconcileDeletes(account);
    expect(deletes()).toHaveLength(0);
  });

  it('still removes the genuine orphan when SEARCH and the server agree', async () => {
    const { mgr, account } = arrange({ exists: 14, searchResult: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], dbUids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
    await mgr.reconcileDeletes(account);
    const del = deletes();
    expect(del).toHaveLength(1);
    expect(del[0][1][2]).toEqual([15]);
  });

  it('still empties a folder the server itself reports as empty', async () => {
    const { mgr, account } = arrange({ exists: 0, searchResult: [], dbUids: [7, 8, 9] });
    await mgr.reconcileDeletes(account);
    const del = deletes();
    expect(del).toHaveLength(1);
    expect(del[0][1][2]).toEqual([7, 8, 9]);
  });
});

// ── setFlag over the persistent IDLE session (upstream 3c1baf5e) ─────────────────────────────
//
// Every mark-read or star used to open a pooled session or a fresh login. For INBOX, setFlag now
// stores the flag on the account's persistent IDLE session, the way Thunderbird does, and uses
// the pool only when that session cannot serve it.
describe('setFlag routing over the persistent session', () => {
  let seq = 0;
  let poolClients;
  function arrange({ persistent } = {}) {
    const account = { id: `acct-sf-${++seq}`, user_id: 'u1', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, email_address: 'a@example.test', auth_user: 'a', auth_pass: 'enc' };
    const mgr = new ImapManager(null);
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
    mgr.broadcast = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockResolvedValue({ rows: [account] });
    poolClients = [];
    ImapFlow.mockImplementation(function () {
      const c = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn(() => Promise.resolve()),
        logout: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async () => true),
        messageFlagsRemove: vi.fn(async () => true),
      });
      poolClients.push(c);
      return c;
    });
    ImapFlow.mockClear();
    if (persistent) mgr.connections.set(account.id, persistent);
    return { mgr, account };
  }
  // The persistent session's mailbox lock, modelled on ImapFlow's: one holder at a time, FIFO
  // waiters, and acquireTimeout splices a waiter out of the queue and rejects it. `release`
  // counts every release; `lockQueue` exposes the waiters.
  const fakePersistent = (over = {}) => {
    const release = vi.fn();
    const lockQueue = [];
    let held = false;
    const grantNext = () => {
      if (held || lockQueue.length === 0) return;
      const next = lockQueue.shift();
      clearTimeout(next.timer);
      held = true;
      let done = false;
      next.resolve({ release: () => {
        if (done) return;
        done = true;
        held = false;
        release();
        grantNext();
      } });
    };
    return Object.assign({
      usable: true,
      release,
      lockQueue,
      close: vi.fn(),
      getMailboxLock: vi.fn((path, opts = {}) => new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        lockQueue.push(entry);
        if (Number(opts.acquireTimeout) > 0) {
          entry.timer = setTimeout(() => {
            const i = lockQueue.indexOf(entry);
            if (i === -1) return;
            lockQueue.splice(i, 1);
            const err = new Error('Timed out waiting for mailbox lock');
            err.code = 'LockTimeout';
            reject(err);
          }, Number(opts.acquireTimeout));
        }
        grantNext();
      })),
      messageFlagsAdd: vi.fn(async () => true),
      messageFlagsRemove: vi.fn(async () => true),
    }, over);
  };
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stores an INBOX flag on the persistent session and opens no other connection', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);

    expect(persistent.getMailboxLock).toHaveBeenCalledWith('INBOX', { acquireTimeout: PERSISTENT_FLAG_LOCK_WAIT_MS });
    // .SILENT: our own store must not come back as a 'flags' event and a pooled range sync.
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith('42', ['\\Seen'], { uid: true, silent: true });
    expect(persistent.release).toHaveBeenCalledOnce();   // the lock never leaks
    expect(ImapFlow).not.toHaveBeenCalled();             // no login at all
  });

  it('removes a flag the same way', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'INBOX', '\\Flagged', false);

    expect(persistent.messageFlagsRemove).toHaveBeenCalledWith('42', ['\\Flagged'], { uid: true, silent: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('uses the pool for a folder other than INBOX', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'Archive', '\\Seen', false);

    expect(persistent.getMailboxLock).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledOnce();
    expect(poolClients[0].getMailboxLock).toHaveBeenCalledWith('Archive');
    expect(poolClients[0].messageFlagsRemove).toHaveBeenCalledWith('42', ['\\Seen'], { uid: true });
  });

  it('uses the pool when the account has no persistent session (poll-only, disconnected)', async () => {
    const { mgr, account } = arrange();

    await mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);

    expect(ImapFlow).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledWith('42', ['\\Seen'], { uid: true });
  });

  it('skips a persistent session whose transport is already dead (usable === false)', async () => {
    const persistent = fakePersistent({ usable: false });
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);

    expect(persistent.getMailboxLock).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledOnce();
  });

  it.each([
    ['syncing', 'syncingAccounts'],
    ['connecting (initial sync)', 'connectingAccounts'],
  ])('uses the pool at once while the account is %s', async (_label, set) => {
    // syncMessages holds the persistent session's INBOX lock for the whole sync and runs inbox
    // rules inside it; a rule's setFlag must not queue behind its own caller's lock.
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });
    mgr[set].add(account.id);

    await mgr.setFlag(account, 42, 'INBOX', '\\Deleted', true);

    expect(persistent.getMailboxLock).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledOnce();
  });

  it('falls back to the pool when the persistent store reports not-applied', async () => {
    const persistent = fakePersistent({ messageFlagsAdd: vi.fn(async () => false) });
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);

    expect(persistent.release).toHaveBeenCalledOnce();
    expect(ImapFlow).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();
  });

  it('falls back to the pool on a persistent STORE error and leaves the session to the health check', async () => {
    const persistent = fakePersistent({ messageFlagsAdd: vi.fn(async () => { throw new Error('BAD'); }) });
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);

    expect(persistent.release).toHaveBeenCalledOnce();
    expect(persistent.close).not.toHaveBeenCalled();
    expect(mgr.connections.get(account.id)).toBe(persistent);
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();
  });

  it('reports the failure when both the persistent session and the pool fail', async () => {
    const persistent = fakePersistent({ messageFlagsAdd: vi.fn(async () => false) });
    const { mgr, account } = arrange({ persistent });
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async () => false),
      });
    });

    await expect(mgr.setFlag(account, 42, 'INBOX', '\\Seen', true)).rejects.toThrow(/did not apply/);
    expect(ImapFlow).toHaveBeenCalledTimes(2);           // the pool ladder still retries once
  });

  it('gives up on a hung lock, uses the pool, and releases the late lock without storing', async () => {
    vi.useFakeTimers();
    let grantLock;
    const release = vi.fn();
    const persistent = fakePersistent({
      release,
      getMailboxLock: vi.fn(() => new Promise(res => { grantLock = () => res({ release }); })),
    });
    const { mgr, account } = arrange({ persistent });

    const call = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await call;                                          // the pool finished the job
    expect(ImapFlow).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();

    grantLock();                                         // the session finally frees INBOX
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledOnce();              // late lock released
    expect(persistent.messageFlagsAdd).not.toHaveBeenCalled(); // and nothing stored twice
  });

  // ── ordering (upstream 24215bef, serialize flag stores) ──

  it('applies two rapid opposite stores on one message in order', async () => {
    // A (\Seen=true) is slow on the persistent session, B (\Seen=false) is issued right after.
    // Unordered, B could land first and A would re-read a message the user just unread. On one
    // session the FIFO lock orders them too; the persistent-then-pool case is the next test.
    const order = [];
    let finishA;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { finishA = () => { order.push('A'); res(true); }; })),
      messageFlagsRemove: vi.fn(async () => { order.push('B'); return true; }),
    });
    const { mgr, account } = arrange({ persistent });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    const b = mgr.setFlag(account, 42, 'INBOX', '\\Seen', false);
    await new Promise(r => setTimeout(r, 50));
    expect(persistent.messageFlagsRemove).not.toHaveBeenCalled(); // B waits for A
    finishA();
    await a; await b;
    expect(order).toEqual(['A', 'B']);                   // the newest value lands last
    await new Promise(r => setTimeout(r, 0));            // the chain entry is dropped once its tail settles
    expect(mgr._flagStoreChains.size).toBe(0);           // nothing left behind
  });

  it('holds the next store until a persistent STORE the previous call gave up on has settled', async () => {
    // A's STORE is sent on the persistent session and then hangs past the deadline; A falls
    // back to the pool and returns. B must not overtake A's STORE, which may still land.
    vi.useFakeTimers();
    const order = [];
    let landA;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { landA = () => { order.push('A-late'); res(true); }; })),
      messageFlagsRemove: vi.fn(async () => { order.push('B'); return true; }),
    });
    const { mgr, account } = arrange({ persistent });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await a;                                             // A done through the pool
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();

    const b = mgr.setFlag(account, 42, 'INBOX', '\\Seen', false);
    await vi.advanceTimersByTimeAsync(100);
    expect(persistent.messageFlagsRemove).not.toHaveBeenCalled(); // A's STORE is still out

    landA();
    await vi.advanceTimersByTimeAsync(1);
    await b;
    expect(order).toEqual(['A-late', 'B']);
  });

  it('sends INBOX flags straight to the pool while an abandoned STORE is still out on the session', async () => {
    // Half-open socket: usable stays true, DONE goes out, the STORE is never answered, and the
    // attempt keeps the INBOX lock. Clicks on other messages must not queue behind it.
    vi.useFakeTimers();
    let landA;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn((uid) => (uid === '42'
        ? new Promise(res => { landA = () => res(true); })
        : Promise.resolve(true))),
    });
    const { mgr, account } = arrange({ persistent });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await a;                                             // A done through the pool

    const done = vi.fn();
    const b = mgr.setFlag(account, 43, 'INBOX', '\\Seen', true).then(done);
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toHaveBeenCalled();                     // no 5s wait
    await b;
    expect(persistent.getMailboxLock).toHaveBeenCalledOnce(); // nothing new queued on the session
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledWith('43', ['\\Seen'], { uid: true });

    landA();                                             // the session answers after all
    await vi.advanceTimersByTimeAsync(1);
    await mgr.setFlag(account, 44, 'INBOX', '\\Seen', true);
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith('44', ['\\Seen'], { uid: true, silent: true });
  });

  it('takes its waiter out of the lock queue when the lock is not granted in time', async () => {
    // Upstream 24215bef finding 1: a timed-out attempt must not leave a waiter queued on the
    // session for as long as the lock stays taken.
    vi.useFakeTimers();
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });
    const other = await persistent.getMailboxLock('INBOX'); // some other holder keeps INBOX

    const call = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 10);
    expect(PERSISTENT_FLAG_LOCK_WAIT_MS).toBeLessThan(PERSISTENT_FLAG_STORE_TIMEOUT_MS);
    expect(persistent.lockQueue).toHaveLength(0);        // the waiter left the queue by the deadline
    await call;
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();

    other.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(persistent.messageFlagsAdd).not.toHaveBeenCalled();
    await mgr.setFlag(account, 43, 'INBOX', '\\Seen', true); // not marked stuck: a lock wait is not a lost STORE
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith('43', ['\\Seen'], { uid: true, silent: true });
  });

  it('uses the pool at once while a sync that outlived its caller still holds the INBOX lock', async () => {
    // connectAccount's initial sync gives up after 40s but syncMessages keeps running, holding
    // the persistent session's INBOX lock, after connectingAccounts has been cleared.
    vi.useFakeTimers();
    const persistent = fakePersistent({ mailbox: { path: 'INBOX', uidValidity: 7, exists: 1 } });
    const { mgr, account } = arrange({ persistent });
    let failSync;
    query.mockImplementation(async (sql) => (String(sql).includes('uid_validity')
      ? new Promise((_, rej) => { failSync = () => rej(new Error('db gone')); })
      : { rows: [account] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sync = mgr.syncMessages(account, persistent, 'INBOX', 20, false, true).catch(() => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(persistent.getMailboxLock).toHaveBeenCalledOnce(); // the sync holds INBOX

    const done = vi.fn();
    const click = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true).then(done);
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toHaveBeenCalled();                     // no wait on the sync's lock
    await click;
    expect(persistent.getMailboxLock).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalled();

    failSync();                                          // the sync ends and lets go of INBOX
    await sync;
    await mgr.setFlag(account, 43, 'INBOX', '\\Seen', true);
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith('43', ['\\Seen'], { uid: true, silent: true });
  });

  it('uses a reconnected session at once even while the old one still has a STORE out', async () => {
    vi.useFakeTimers();
    const stuck = fakePersistent({ messageFlagsAdd: vi.fn(() => new Promise(() => {})) });
    const { mgr, account } = arrange({ persistent: stuck });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await a;

    const fresh = fakePersistent();
    mgr.connections.set(account.id, fresh);             // the sync tick reconnected
    await mgr.setFlag(account, 43, 'INBOX', '\\Seen', true);
    expect(fresh.messageFlagsAdd).toHaveBeenCalledWith('43', ['\\Seen'], { uid: true, silent: true });
  });

  it('bounds how long the next store on a message waits for an abandoned STORE', async () => {
    vi.useFakeTimers();
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(() => {})), // never answered
    });
    const { mgr, account } = arrange({ persistent });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await a;

    const done = vi.fn();
    const b = mgr.setFlag(account, 42, 'INBOX', '\\Seen', false).then(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();                 // still ordered behind A's STORE
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_LATE_STORE_WAIT_MS);
    expect(done).toHaveBeenCalled();                     // but not forever
    await b;
    expect(poolClients[0].messageFlagsRemove).toHaveBeenCalledWith('42', ['\\Seen'], { uid: true });
  });

  it('the chain does not hold stores on different messages behind each other', async () => {
    // The session's mailbox lock still serializes the two STOREs on the wire; what this pins is
    // that the chain lets uid 43 reach that lock while uid 42 is in flight, instead of queueing
    // it behind 42 as an account-wide chain would.
    const order = [];
    let finishA;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn((uid) => (uid === '42'
        ? new Promise(res => { finishA = () => { order.push('42'); res(true); }; })
        : (order.push(uid), Promise.resolve(true)))),
    });
    const { mgr, account } = arrange({ persistent });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    const b = mgr.setFlag(account, 43, 'INBOX', '\\Seen', true);
    await new Promise(r => setTimeout(r, 20));
    expect(persistent.getMailboxLock).toHaveBeenCalledTimes(2); // 43 is waiting on the lock
    expect(persistent.lockQueue).toHaveLength(1);                // not on the chain
    finishA();
    await a; await b;
    expect(order).toEqual(['42', '43']);                 // the lock, not the chain, ordered them
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('runs the next store on a message after the previous one failed', async () => {
    const persistent = fakePersistent({ messageFlagsAdd: vi.fn(async () => false) });
    const { mgr, account } = arrange({ persistent });
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async () => false),
      });
    });

    const a = mgr.setFlag(account, 42, 'INBOX', '\\Seen', true);
    const b = mgr.setFlag(account, 42, 'INBOX', '\\Seen', false);
    await expect(a).rejects.toThrow(/did not apply/);
    await expect(b).resolves.toBeUndefined();            // removal succeeded on the persistent session
    expect(persistent.messageFlagsRemove).toHaveBeenCalledOnce();
  });

  // ── setFlags: many letters of one folder in one STORE ──

  it('stores many INBOX letters in one STORE on the persistent session', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });

    await mgr.setFlags(account, 'INBOX', [45, 3, 7, 3, 12], '\\Seen', true);

    expect(persistent.messageFlagsAdd).toHaveBeenCalledOnce();
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith('3,7,12,45', ['\\Seen'], { uid: true, silent: true });
    expect(persistent.release).toHaveBeenCalledOnce();
    expect(ImapFlow).not.toHaveBeenCalled();             // no login at all
    await new Promise(r => setTimeout(r, 0));
    expect(mgr._flagStoreChains.size).toBe(0);           // every letter's chain entry is dropped
  });

  it('stores 50 letters in two folders with two STOREs', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });
    const inbox = Array.from({ length: 25 }, (_, i) => i + 1);
    const archive = Array.from({ length: 25 }, (_, i) => i + 101);

    await Promise.all([
      mgr.setFlags(account, 'INBOX', inbox, '\\Seen', true),
      mgr.setFlags(account, 'Archive', archive, '\\Seen', true),
    ]);

    expect(persistent.messageFlagsAdd).toHaveBeenCalledOnce();
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith(inbox.join(','), ['\\Seen'], { uid: true, silent: true });
    expect(ImapFlow).toHaveBeenCalledOnce();             // one pooled login for the other folder
    expect(poolClients[0].getMailboxLock).toHaveBeenCalledWith('Archive');
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledWith(archive.join(','), ['\\Seen'], { uid: true });
  });

  it('splits a very long UID set into chunks of FLAG_STORE_UID_CHUNK', async () => {
    const { mgr, account } = arrange();
    const uids = Array.from({ length: FLAG_STORE_UID_CHUNK + 1 }, (_, i) => i + 1);

    await mgr.setFlags(account, 'Archive', uids, '\\Seen', false);

    expect(poolClients[0].messageFlagsRemove).toHaveBeenCalledTimes(2);
    expect(poolClients[0].messageFlagsRemove.mock.calls[0][0]).toBe(uids.slice(0, FLAG_STORE_UID_CHUNK).join(','));
    expect(poolClients[0].messageFlagsRemove.mock.calls[1][0]).toBe(String(FLAG_STORE_UID_CHUNK + 1));
  });

  it('a click on a letter waits only for the chunk that holds it, not for the chunks after it', async () => {
    const { mgr, account } = arrange();
    let landChunk2;
    ImapFlow.mockImplementation(function () {
      const c = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn(() => Promise.resolve()),
        logout: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn((uids) => (uids === String(FLAG_STORE_UID_CHUNK + 1)
          ? new Promise(res => { landChunk2 = () => res(true); })
          : Promise.resolve(true))),
        messageFlagsRemove: vi.fn(async () => true),
      });
      poolClients.push(c);
      return c;
    });
    const uids = Array.from({ length: FLAG_STORE_UID_CHUNK + 1 }, (_, i) => i + 1);

    const bulk = mgr.setFlags(account, 'Archive', uids, '\\Seen', true);
    await vi.waitFor(() => expect(landChunk2).toBeTypeOf('function')); // chunk 2 is on the wire
    const inChunk1 = vi.fn();
    const inChunk2 = vi.fn();
    const click1 = mgr.setFlag(account, 1, 'Archive', '\\Seen', false).then(inChunk1);
    const click2 = mgr.setFlag(account, FLAG_STORE_UID_CHUNK + 1, 'Archive', '\\Seen', false).then(inChunk2);
    await vi.waitFor(() => expect(inChunk1).toHaveBeenCalled());
    expect(inChunk2).not.toHaveBeenCalled();             // its letter's chunk is still out

    landChunk2();
    await bulk; await click1; await click2;
    expect(inChunk2).toHaveBeenCalled();
  });

  // ── setFlagsGroups: the folders of one mailbox in one call ──

  it('stores two folders with two STOREs and reports each group', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });
    const inbox = Array.from({ length: 25 }, (_, i) => i + 1);
    const archive = Array.from({ length: 25 }, (_, i) => i + 101);

    const results = await mgr.setFlagsGroups(account, [{ folder: 'INBOX', uids: inbox }, { folder: 'Archive', uids: archive }], '\\Seen', true);

    expect(results).toEqual([{ stored: true }, { stored: true }]);
    expect(persistent.messageFlagsAdd).toHaveBeenCalledOnce();
    expect(persistent.messageFlagsAdd).toHaveBeenCalledWith(inbox.join(','), ['\\Seen'], { uid: true, silent: true });
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledOnce();
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledWith(archive.join(','), ['\\Seen'], { uid: true });
  });

  it('still tries the next group after a failure that is not about the login', async () => {
    const { mgr, account } = arrange();
    ImapFlow.mockImplementation(function () {
      const c = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn(() => Promise.resolve()),
        logout: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async (uids) => uids !== '1,2'), // the server does not apply group 1
      });
      poolClients.push(c);
      return c;
    });

    const results = await mgr.setFlagsGroups(account, [{ folder: 'Archive', uids: [1, 2] }, { folder: 'Sent', uids: [3] }], '\\Seen', true);

    expect(results[0]).toMatchObject({ stored: false, error: expect.any(Error) });
    expect(results[1]).toEqual({ stored: true });
  });

  it.each([
    ['a pool that stayed full', () => Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true })],
    ['a login held back', () => Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true })],
  ])('tries no other group after %s', async (_what, busy) => {
    const { mgr, account } = arrange();
    const tried = vi.spyOn(mgr, '_setFlagInner').mockRejectedValueOnce(busy()).mockResolvedValue();

    const results = await mgr.setFlagsGroups(account, [{ folder: 'Archive', uids: [1] }, { folder: 'Sent', uids: [2] }], '\\Seen', true);

    expect(tried).toHaveBeenCalledOnce();              // Sent does not wait out the same queue
    expect(results).toEqual([{ stored: false, error: expect.any(Error) }, { stored: false, skipped: true }]);
  });

  it('reserves every group at call time: a newer click on a later group is not overtaken', async () => {
    // Group 1 (INBOX) is slow on the persistent session. The user marks an Archive letter of
    // group 2 unread meanwhile: the older bulk value must land before the click, not after it.
    const order = [];
    let finishInbox;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { finishInbox = () => { order.push('INBOX'); res(true); }; })),
    });
    const { mgr, account } = arrange({ persistent });
    ImapFlow.mockImplementation(function () {
      const c = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn(() => Promise.resolve()),
        logout: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async (uids) => { order.push(`Archive ${uids} +Seen`); return true; }),
        messageFlagsRemove: vi.fn(async (uids) => { order.push(`Archive ${uids} -Seen`); return true; }),
      });
      poolClients.push(c);
      return c;
    });

    const bulk = mgr.setFlagsGroups(account, [{ folder: 'INBOX', uids: [42] }, { folder: 'Archive', uids: [7, 8, 9] }], '\\Seen', true);
    await new Promise(r => setTimeout(r, 20));          // group 1 is storing
    const click = mgr.setFlag(account, 8, 'Archive', '\\Seen', false);
    await new Promise(r => setTimeout(r, 20));
    expect(order).toEqual([]);                           // the click waits for the bulk's group 2
    finishInbox();
    await bulk; await click;
    expect(order).toEqual(['INBOX', 'Archive 7,8,9 +Seen', 'Archive 8 -Seen']);
  });

  it('logs a bulk store as its count and first/last UID, not the whole set', async () => {
    const { mgr, account } = arrange();
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageFlagsAdd: vi.fn(async () => false),
      });
    });
    const uids = Array.from({ length: 500 }, (_, i) => i + 1);

    await expect(mgr.setFlags(account, 'Archive', uids, '\\Seen', true)).rejects.toThrow(/for uids=500 \(1\.\.500\)/);

    const lines = [...console.log.mock.calls, ...console.error.mock.calls].map(args => args.join(' '));
    expect(lines.some(l => l.includes('setFlag: uids=500 (1..500) folder=Archive'))).toBe(true);
    expect(lines.filter(l => l.includes('1,2,3'))).toEqual([]);
  });

  it('does nothing for an empty UID list', async () => {
    const persistent = fakePersistent();
    const { mgr, account } = arrange({ persistent });
    await mgr.setFlags(account, 'INBOX', [], '\\Seen', true);
    expect(persistent.getMailboxLock).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  // The single store is on the MIDDLE letter of the set: a chain joined on the first or the
  // last letter only would pass with a single store on that end.
  it('a single store on a letter waits for a bulk store that holds it, other letters do not', async () => {
    const order = [];
    let finishBulk;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { finishBulk = () => { order.push('42,43,44'); res(true); }; })),
      messageFlagsRemove: vi.fn(async (uid) => { order.push(uid); return true; }),
    });
    const { mgr, account } = arrange({ persistent });

    const bulk = mgr.setFlags(account, 'INBOX', [42, 43, 44], '\\Seen', true);
    const single = mgr.setFlag(account, 43, 'INBOX', '\\Seen', false);
    const other = mgr.setFlag(account, 45, 'INBOX', '\\Seen', false);
    await new Promise(r => setTimeout(r, 50));
    expect(persistent.getMailboxLock).toHaveBeenCalledTimes(2); // the bulk and 45 reached the lock
    expect(persistent.messageFlagsRemove).not.toHaveBeenCalled(); // 43 waits on its chain
    finishBulk();
    await bulk; await single; await other;
    expect(order).toEqual(['42,43,44', '45', '43']);     // the newest value on 43 lands last
    await new Promise(r => setTimeout(r, 0));
    expect(mgr._flagStoreChains.size).toBe(0);
  });

  it('a bulk store waits for a single store already pending on one of its letters', async () => {
    const order = [];
    let finishSingle;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { finishSingle = () => { order.push('43'); res(true); }; })),
      messageFlagsRemove: vi.fn(async (uid) => { order.push(uid); return true; }),
    });
    const { mgr, account } = arrange({ persistent });

    const single = mgr.setFlag(account, 43, 'INBOX', '\\Seen', true);
    const bulk = mgr.setFlags(account, 'INBOX', [42, 43, 44], '\\Seen', false);
    await new Promise(r => setTimeout(r, 50));
    expect(persistent.getMailboxLock).toHaveBeenCalledOnce(); // the bulk has not even asked for the lock
    finishSingle();
    await single; await bulk;
    expect(order).toEqual(['43', '42,43,44']);
  });

  it('holds the next store on a letter until a bulk STORE the bulk call gave up on has settled', async () => {
    // The bulk STORE goes out on the persistent session and hangs past the deadline; the pool
    // stores the set instead. A later store on one of its letters must not overtake the late one.
    vi.useFakeTimers();
    const order = [];
    let landBulk;
    const persistent = fakePersistent({
      messageFlagsAdd: vi.fn(() => new Promise(res => { landBulk = () => { order.push('bulk-late'); res(true); }; })),
      messageFlagsRemove: vi.fn(async (uid) => { order.push(uid); return true; }),
    });
    const { mgr, account } = arrange({ persistent });

    const bulk = mgr.setFlags(account, 'INBOX', [42, 43], '\\Seen', true);
    await vi.advanceTimersByTimeAsync(PERSISTENT_FLAG_STORE_TIMEOUT_MS + 100);
    await bulk;                                          // done through the pool
    expect(poolClients[0].messageFlagsAdd).toHaveBeenCalledWith('42,43', ['\\Seen'], { uid: true });

    const done = vi.fn();
    const single = mgr.setFlag(account, 43, 'INBOX', '\\Seen', false).then(done);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();                 // the bulk STORE is still out

    landBulk();
    await vi.advanceTimersByTimeAsync(1);
    await single;
    expect(order[0]).toBe('bulk-late');
    expect(done).toHaveBeenCalled();
  });
});

// ── Backoff ladders (upstream #474 round) ──────────────────────────────────────

const ladderManager = () => {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
};

// The prefetch loop reads each letter's live row before it fetches the body (the query selects
// "AS cached"). Tests register the letters their mailbox holds; an unregistered id reads as gone.
const liveLetters = new Map(); // id -> { uid, folder, cached }
const holdLetters = rows => { for (const r of rows) liveLetters.set(r.id, { uid: r.uid, folder: r.folder || 'INBOX', cached: false }); };
const liveLetterAnswer = params => {
  const row = liveLetters.get(params[0]);
  return { rows: row ? [{ ...row }] : [] };
};

describe('prefetchFolderBodies stops instead of hammering a refusing server', () => {
  // A generic host: the mail node's profile, where snippetIndex (and so folder prefetch) is on.
  const acct = { id: 'prefetch-acct', user_id: 'u1', enabled: true, imap_host: 'mail.example.com', imap_port: 993, imap_tls: true };
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

  beforeEach(() => {
    vi.clearAllMocks();
    liveLetters.clear();
    holdLetters(ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })));
    query.mockReset();
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.includes('body_html IS NULL AND body_text IS NULL')) return { rows: ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })) };
      if (sql.includes('AS cached')) return liveLetterAnswer(params);
      return { rows: [] };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stops at the first refusal and leaves the live-sync cooldown alone', async () => {
    const mgr = ladderManager();
    // Dovecot's per-user+IP limit, as fetchMessageBody rethrows it (message text only).
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded (mail_max_userip_connections=20)'));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(mgr.fetchMessageBody).toHaveBeenCalledWith(acct, 1, 'INBOX', { background: true });
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
  });

  it('arms the secondary backoff on a refusal, and the next folder view opens nothing', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded (mail_max_userip_connections=20)'));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('arms nothing for failures that are about the messages', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Unexpected server response'));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
  });

  it('skips the run while the live-sync cooldown is armed', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn();
    mgr._connectCooldown.set(acct.id, { until: Date.now() + 30000, failures: 1 });
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('stops after three consecutive failures of any kind', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Unexpected server response'));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(3);
  });

  it('resets the count on a success, so scattered bad messages do not stop the folder', async () => {
    const mgr = ladderManager();
    const bad = new Error('Unexpected server response');
    mgr.fetchMessageBody = vi.fn()
      .mockRejectedValueOnce(bad).mockRejectedValueOnce(bad)
      .mockResolvedValueOnce({ html: null, text: 'ok', attachments: [] })
      .mockRejectedValueOnce(bad).mockRejectedValueOnce(bad)
      .mockResolvedValueOnce({ html: null, text: 'ok', attachments: [] });
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(6);
  });
});

describe('body prefetch and a rejected password', () => {
  // The mail node after a password change on mailcow that MailExpert was not told about: Dovecot
  // keeps the already-authenticated IDLE session, so live sync looks fine, while every new login
  // is rejected. Each rejected login counts toward fail2ban, whose ban cuts off the whole node.
  const acct = { id: 'prefetch-auth', user_id: 'u1', enabled: true, imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const dovecotAuthFailure = () => imapErr({
    response: '1 NO [AUTHENTICATIONFAILED] Authentication failed.',
    responseStatus: 'NO',
    responseText: 'Authentication failed.',
    serverResponseCode: 'AUTHENTICATIONFAILED',
    authenticationFailed: true,
  });
  let logins;

  beforeEach(() => {
    vi.clearAllMocks();
    logins = 0;
    ImapFlow.mockImplementation(function () {
      logins++;
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => Promise.reject(dovecotAuthFailure())),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
      });
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    liveLetters.clear();
    holdLetters(ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })));
    holdLetters([1, 2, 3, 9].map(uid => ({ id: `n${uid}`, uid, folder: 'INBOX' }))); // new mail of a sync
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.includes('body_html IS NULL AND body_text IS NULL')) return { rows: ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })) };
      if (sql.includes('AS cached')) return liveLetterAnswer(params);
      return { rows: [], rowCount: 1 };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const liveManager = () => {
    const mgr = ladderManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() })); // IDLE still up
    return mgr;
  };
  const syncErrorWrites = () => query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1'));

  it('stops at the first rejected login through the real fetch path and holds the next view back', async () => {
    const mgr = liveManager();
    const before = Date.now();
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(logins).toBe(1);
    // The secondary auth ladder, not the account-wide one: the IDLE session keeps syncing.
    expect(mgr._secondaryAuthCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(syncErrorWrites()).toHaveLength(1);
    // The next folder view opens nothing.
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(logins).toBe(1);
  });

  it('opens nothing while a rejected status login holds background logins back', async () => {
    const mgr = liveManager();
    mgr.fetchMessageBody = vi.fn();
    mgr._secondaryAuthCooldown.set(acct.id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 });
    await mgr.prefetchFolderBodies(acct.id, ids);
    await mgr.prefetchNewMessageBodies(acct, [{ id: 'n1', uid: 9, folder: 'INBOX' }]);
    expect(mgr.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('puts the account on the account-wide auth ladder when no persistent connection vouches for it', async () => {
    const mgr = ladderManager();
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(logins).toBe(1);
    expect(mgr._connectCooldown.get(acct.id).authFailures).toBe(1);
  });

  it('stops a run in progress when a backoff is armed meanwhile', async () => {
    const mgr = liveManager();
    mgr.fetchMessageBody = vi.fn(async () => {
      // The folder status client is refused while this run is between messages.
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 30000, failures: 1 });
      return { html: null, text: 'ok', attachments: [] };
    });
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('gives the new-mail prefetch after a sync the same stops', async () => {
    const mgr = liveManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded'));
    const fresh = [1, 2, 3].map(uid => ({ id: `n${uid}`, uid, folder: 'INBOX' }));
    await mgr.prefetchNewMessageBodies(acct, fresh);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
    await mgr.prefetchNewMessageBodies(acct, fresh);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
  });
});

describe('body prefetch runs one at a time and pauses after a stop', () => {
  const acct = { id: 'prefetch-flight', user_id: 'u1', enabled: true, imap_host: 'mail.example.com', imap_port: 993, imap_tls: true };
  const ids = ['f1', 'f2', 'f3', 'f4'];

  beforeEach(() => {
    vi.clearAllMocks();
    liveLetters.clear();
    holdLetters(ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })));
    query.mockReset();
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.includes('body_html IS NULL AND body_text IS NULL')) return { rows: ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })) };
      if (sql.includes('AS cached')) return liveLetterAnswer(params);
      return { rows: [] };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not start a second run for an account while one is in progress', async () => {
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mgr.fetchMessageBody = vi.fn(async () => { await gate; return { html: null, text: 'ok', attachments: [] }; });
    const first = mgr.prefetchFolderBodies(acct.id, ids);
    await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
    await mgr.prefetchFolderBodies(acct.id, ids); // a quick switch to another folder and back
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(ids.length);
  });

  it('pauses the account after a run stopped on failures, and resumes after the pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Pooled IMAP operation timeout (30000ms)'));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
    vi.setSystemTime(Date.now() + PREFETCH_STOP_PAUSE_MS + 1);
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(2 * PREFETCH_MAX_CONSECUTIVE_ERRORS);
  });

  // The pool's own "busy" (the background share stayed taken for the whole acquire wait; no login
  // was tried) is not a failure of the server or of the letter.
  const busy = () => Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true });
  const ok = { html: null, text: 'ok', attachments: [] };

  it.each([
    ['the folder view', (mgr) => mgr.prefetchFolderBodies(acct.id, ids)],
    ['new mail', (mgr) => mgr.prefetchNewMessageBodies(acct, ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' })).reverse())],
  ])('waits out a busy pool instead of stopping (%s)', async (_lane, run) => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn();
    for (let i = 0; i < PREFETCH_MAX_CONSECUTIVE_ERRORS + 1; i++) mgr.fetchMessageBody.mockRejectedValueOnce(busy());
    mgr.fetchMessageBody.mockResolvedValue(ok);
    await run(mgr);
    const uids = mgr.fetchMessageBody.mock.calls.map(c => c[1]);
    // The first letter is tried again until the pool has room, then the rest follow.
    expect(uids).toEqual([...Array(PREFETCH_MAX_CONSECUTIVE_ERRORS + 2).fill(uids[0]), ...uids.slice(PREFETCH_MAX_CONSECUTIVE_ERRORS + 2)]);
    expect(new Set(uids).size).toBe(ids.length);
    expect(mgr._prefetchPausedUntil.has(acct.id)).toBe(false);
  });

  it('counts busy answers over the whole run, not per letter', async () => {
    // Every letter waiting out almost the whole allowance would otherwise hold the run (and the
    // folder-view one-run guard) for hours.
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn();
    for (let n = 0; n < ids.length; n++) {
      for (let i = 0; i < PREFETCH_MAX_BUSY_WAITS - 1; i++) mgr.fetchMessageBody.mockRejectedValueOnce(busy());
      mgr.fetchMessageBody.mockResolvedValueOnce(ok);
    }
    await mgr.prefetchFolderBodies(acct.id, ids);
    // The first letter after 29 busy answers, then the 30th busy answer ends the run.
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_BUSY_WAITS + 1);
    expect(mgr._prefetchPausedUntil.has(acct.id)).toBe(false);
  });

  it('counts busy answers over every batch of a new-mail run', async () => {
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const rows = ids.map((id, i) => ({ id, uid: i + 1, folder: 'INBOX' }));
    let calls = 0;
    mgr.fetchMessageBody = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate;
      if (calls <= PREFETCH_MAX_BUSY_WAITS - 1) throw busy();
      if (calls === PREFETCH_MAX_BUSY_WAITS) return ok;
      throw busy();
    });
    const first = mgr.prefetchNewMessageBodies(acct, rows.slice(0, 1));
    await vi.waitFor(() => expect(calls).toBe(1));
    await mgr.prefetchNewMessageBodies(acct, rows.slice(1, 2)); // the next sync's batch
    release();
    await first;
    // 29 busy answers and a success in the first batch; the next batch's first busy answer ends it.
    expect(calls).toBe(PREFETCH_MAX_BUSY_WAITS + 1);
  });

  it('ends the run without the pause when the pool stays busy as long as any pooled operation may run', async () => {
    const mgr = ladderManager();
    // Each answer after a macrotask, as the real acquire wait is: an unbounded wait then fails on
    // the test timeout instead of spinning forever on microtasks.
    mgr.fetchMessageBody = vi.fn(() => new Promise((_, reject) => setImmediate(() => reject(busy()))));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_BUSY_WAITS);
    expect(mgr._prefetchPausedUntil.has(acct.id)).toBe(false);
    // The next folder view tries again.
    mgr.fetchMessageBody.mockResolvedValue(ok);
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_BUSY_WAITS + ids.length);
  });

  it('still stops on a held-back pool answer (providerRefusing), as before', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true }));
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
    expect(mgr._prefetchPausedUntil.has(acct.id)).toBe(true);
  });

  it('does not pause after a run that went through', async () => {
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockResolvedValue({ html: null, text: 'ok', attachments: [] });
    await mgr.prefetchFolderBodies(acct.id, ids);
    await mgr.prefetchFolderBodies(acct.id, ids);
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(2 * ids.length);
  });
});

describe('newBodyPrefetchCount', () => {
  const node = { imap_host: 'mail.example.com', mail_node: true };
  const generic = { imap_host: 'mail.example.com' };

  it('fetches every new letter of a node mailbox, up to the per-sync bound', () => {
    expect(newBodyPrefetchCount(node, 0, 'INBOX')).toBe(0);
    expect(newBodyPrefetchCount(node, 1, 'INBOX')).toBe(1);
    expect(newBodyPrefetchCount(node, 12, 'INBOX')).toBe(12);
    expect(newBodyPrefetchCount(node, NODE_NEW_BODY_PREFETCH_MAX, 'INBOX')).toBe(NODE_NEW_BODY_PREFETCH_MAX);
    expect(newBodyPrefetchCount(node, 500, 'INBOX')).toBe(NODE_NEW_BODY_PREFETCH_MAX);
    expect(NODE_NEW_BODY_PREFETCH_MAX).toBe(50);
  });

  it('lets as many letters wait for the lane as one sync of the mailbox may fetch', () => {
    expect(newBodyQueueMax(node)).toBe(NODE_NEW_BODY_PREFETCH_MAX);
    expect(newBodyQueueMax(generic)).toBe(5);
    expect(newBodyQueueMax({ imap_host: 'imap.gmail.com', oauth_provider: 'google' })).toBe(5);
    expect(newBodyQueueMax({ imap_host: 'imap.purelymail.com' })).toBe(1);
  });

  it('gives the node budget to the INBOX only; Junk and label folders keep the small-batch rule', () => {
    expect(newBodyPrefetchCount(node, 12, 'Junk')).toBe(0);
    expect(newBodyPrefetchCount(node, 12, 'Todo')).toBe(0);
    expect(newBodyPrefetchCount(node, 3, 'Junk')).toBe(3);
  });

  it('keeps the small-batch rule everywhere else', () => {
    expect(newBodyPrefetchCount(generic, 5, 'INBOX')).toBe(5);
    expect(newBodyPrefetchCount(generic, 6, 'INBOX')).toBe(0);
    // Gmail: up to 5, every one of them.
    expect(newBodyPrefetchCount({ imap_host: 'imap.gmail.com', oauth_provider: 'google' }, 3, 'INBOX')).toBe(3);
    expect(newBodyPrefetchCount({ imap_host: 'imap.gmail.com', oauth_provider: 'google' }, 6, 'INBOX')).toBe(0);
    // PurelyMail warms only the newest arrival.
    expect(newBodyPrefetchCount({ imap_host: 'imap.purelymail.com' }, 3, 'INBOX')).toBe(1);
  });
});

describe('a sync stores the bodies of a node mailbox\'s new letters', () => {
  // The panel's own mail node is close and cheap: every letter a sync brings in is fetched right
  // away on a background pooled session, so opening it reads the database, not the server.
  const mailbox = (id, extra = {}) => ({
    id, user_id: 'u1', enabled: true, email_address: 'team@example.com', gtd_enabled: false,
    categorization_enabled: false, imap_host: 'mail.example.com', imap_port: 993, imap_tls: true,
    auth_user: 'team@example.com', auth_pass: 'enc', mail_node: true, ...extra,
  });
  const WATERMARK = 100;
  let bodies, bodyFetchOrder, pooledLogins, goneUids, rowFolder;

  beforeEach(() => {
    vi.clearAllMocks();
    rowFolder = new Map();
    goneUids = new Set(); // letters the server no longer has where the sync saw them
    bodies = new Map();
    bodyFetchOrder = [];
    pooledLogins = 0;
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    sendPushToActiveUsers.mockResolvedValue();
    // Pooled sessions: a single text/plain part per letter.
    ImapFlow.mockImplementation(function () {
      pooledLogins++;
      return Object.assign(new EventEmitter(), {
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        fetch: vi.fn(async function* (uidStr, fetchQuery) {
          if (fetchQuery.bodyStructure) bodyFetchOrder.push(Number(uidStr));
          if (goneUids.has(Number(uidStr))) return; // UID FETCH answers nothing
          yield {
            uid: Number(uidStr),
            bodyStructure: { part: '1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'utf-8' } },
            bodyParts: new Map([['1', Buffer.from(`Body of ${uidStr}`)]]),
          };
        }),
      });
    });
    // The messages table, as far as sync and prefetch touch it: one row per UID, and its body.
    query.mockReset();
    query.mockImplementation(async (sql, params = []) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return { rows: [{ uid_validity: 100, highest_modseq: '500' }] };
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: WATERMARK }] };
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return { rows: [{ n: 0 }] };
      if (sql.includes('INSERT INTO messages')) { rowFolder.set(`row-${params[1]}`, params[2]); return { rows: [{ id: `row-${params[1]}`, is_new: true }] }; }
      // Every row-<uid> is a live letter, in the folder the sync stored it in (INBOX by default).
      if (sql.includes('AS cached')) return { rows: [{ uid: Number(String(params[0]).slice(4)), folder: rowFolder.get(params[0]) || 'INBOX', cached: bodies.has(params[0]) }] };
      if (sql.includes('SET body_html = $1, body_text = $2')) { bodies.set(params[3], params[1]); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<letter-${msg.uid}@example.org>`, subject: `Letter ${msg.uid}`,
      fromName: 'Client', fromEmail: 'client@example.org', to: [], cc: [], replyTo: [], inReplyTo: null,
      references: null, date: new Date('2026-09-26T10:00:00Z'), snippet: '', isRead: false, isStarred: false,
      hasAttachments: false, flags: [], isBulk: false, parsedHeaders: {},
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // The persistent session: `count` letters above the watermark.
  const syncClient = count => ({
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    mailbox: { exists: WATERMARK + count, uidValidity: 100, highestModseq: 500n },
    fetch: vi.fn(async function* (range) {
      if (range !== `${WATERMARK + 1}:*`) return;
      for (let uid = WATERMARK + 1; uid <= WATERMARK + count; uid++) yield { uid };
    }),
  });
  const settleBackground = () => new Promise(resolve => setImmediate(resolve));

  it('has every one of N new letters\' bodies in the database after the sync', async () => {
    const acct = mailbox('node-bodies-12');
    const mgr = ladderManager();
    try {
      await mgr.syncMessages(acct, syncClient(12), 'INBOX', 20, false, true);
      await vi.waitFor(() => expect(bodies.size).toBe(12));
      for (let uid = WATERMARK + 1; uid <= WATERMARK + 12; uid++) expect(bodies.get(`row-${uid}`)).toBe(`Body of ${uid}`);
      // Newest first: the letter most likely to be opened is warm first.
      expect(bodyFetchOrder).toEqual(Array.from({ length: 12 }, (_, i) => WATERMARK + 12 - i));
      // One pooled session did it all, as background work.
      expect(pooledLogins).toBe(1);
    } finally { evictPool(acct.id); }
  });

  it('reads the delivery reports among the new letters on a background session after the sync (R-17)', async () => {
    const acct = mailbox('node-dsn');
    const mgr = ladderManager();
    // A report of today (an older one is no longer read, deliveryReport.js reportsToRead).
    const today = new Date(Math.floor(Date.now() / 1000) * 1000);
    const parsed = parseMessage.getMockImplementation();
    parseMessage.mockImplementation(async (msg) => ({ ...(await parsed(msg)), date: today }));
    const client = {
      ...syncClient(2),
      fetch: vi.fn(async function* (range) {
        if (range !== `${WATERMARK + 1}:*`) return;
        yield { uid: WATERMARK + 1, bodyStructure: { type: 'text/plain' } };
        yield { uid: WATERMARK + 2, bodyStructure: STAND_DSN_STRUCTURE };
      }),
    };
    try {
      await mgr.syncMessages(acct, client, 'INBOX', 20, false, true);
      await vi.waitFor(() => expect(readDeliveryReports).toHaveBeenCalledTimes(1));
      const [session, accountId, reports] = readDeliveryReports.mock.calls[0];
      expect(session).not.toBe(client);
      expect(accountId).toBe(acct.id);
      expect(reports).toEqual([{
        uid: WATERMARK + 2,
        report: expect.objectContaining({ statusPart: '2', returnedMessageId: '<r17-denied-1790933353895@stage.test>' }),
        inReplyTo: null, references: null, date: today,
      }]);
    } finally { evictPool(acct.id); }
  });

  it('fetches them while a folder-view prefetch of the same mailbox is running', async () => {
    const acct = mailbox('node-bodies-folder-run');
    const mgr = ladderManager();
    // A folder-view run pauses between letters while the reader clicks, so it can last long.
    mgr._prefetchRunning.add(acct.id);
    try {
      await mgr.syncMessages(acct, syncClient(3), 'INBOX', 20, false, true);
      await vi.waitFor(() => expect(bodies.size).toBe(3));
    } finally { evictPool(acct.id); }
  });

  const newRows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `row-${from + i}`, uid: from + i, folder: 'INBOX' }));

  it('queues the letters of a sync that arrive while the previous ones are being fetched', async () => {
    const acct = mailbox('node-bodies-queue');
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mgr.fetchMessageBody = vi.fn(async (_a, uid) => {
      if (uid === 103) await gate;
      return { html: null, text: `Body of ${uid}`, attachments: [] };
    });
    const first = mgr.prefetchNewMessageBodies(acct, newRows(101, 103));
    await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
    await mgr.prefetchNewMessageBodies(acct, newRows(104, 105)); // the next sync, mid-run
    release();
    await first;
    expect(mgr.fetchMessageBody.mock.calls.map(c => c[1])).toEqual([103, 102, 101, 105, 104]);
    expect([...bodies.keys()].sort()).toEqual(['row-101', 'row-102', 'row-103', 'row-104', 'row-105']);
    // The lane is free again for the sync after that.
    await mgr.prefetchNewMessageBodies(acct, newRows(106, 106));
    expect(bodies.has('row-106')).toBe(true);
  });

  it('drops the letters queued behind a run that stopped; they are fetched on open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const acct = mailbox('node-bodies-stop-queue');
      const mgr = ladderManager();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      mgr.fetchMessageBody = vi.fn(async (_a, uid) => {
        if (uid === 103) await gate;
        if (uid <= 103) throw new Error('Pooled IMAP operation timeout (30000ms)');
        return { html: null, text: `Body of ${uid}`, attachments: [] };
      });
      const first = mgr.prefetchNewMessageBodies(acct, newRows(101, 103));
      await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
      await mgr.prefetchNewMessageBodies(acct, newRows(104, 104));
      release();
      await first;
      expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
      vi.setSystemTime(Date.now() + PREFETCH_STOP_PAUSE_MS + 1);
      await mgr.prefetchNewMessageBodies(acct, newRows(105, 105));
      expect(mgr.fetchMessageBody.mock.calls.slice(PREFETCH_MAX_CONSECUTIVE_ERRORS).map(c => c[1])).toEqual([105]);
    } finally { vi.useRealTimers(); }
  });

  it('spends no fresh login on letters the server no longer has, and stops after three', async () => {
    // Moved or expunged by another client before the database knew: UID FETCH answers nothing.
    const acct = mailbox('node-bodies-gone');
    const mgr = ladderManager();
    for (let uid = 101; uid <= 105; uid++) goneUids.add(uid);
    try {
      await mgr.prefetchNewMessageBodies(acct, newRows(101, 105));
      // One pooled login per letter (each empty answer evicts its session), no fresh-login retry,
      // and the three in a row stop the run.
      expect(pooledLogins).toBe(PREFETCH_MAX_CONSECUTIVE_ERRORS);
      expect(bodyFetchOrder).toEqual([105, 104, 103]);
      expect(bodies.size).toBe(0);
      expect(mgr._prefetchPausedUntil.has(acct.id)).toBe(true);
    } finally { evictPool(acct.id); }
  });

  it('reports an empty answer to background work as the letter being gone', async () => {
    const acct = mailbox('node-bodies-gone-flag');
    const mgr = ladderManager();
    goneUids.add(101);
    try {
      await expect(mgr.fetchMessageBody(acct, 101, 'INBOX', { background: true }))
        .rejects.toMatchObject({ messageGone: true });
      expect(pooledLogins).toBe(1);
    } finally { evictPool(acct.id); }
  });

  it('still retries a user\'s empty fetch through a fresh login', async () => {
    const acct = mailbox('node-bodies-gone-user');
    const mgr = ladderManager();
    goneUids.add(101);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(mgr.fetchMessageBody(acct, 101, 'INBOX')).resolves.toMatchObject({ html: null, text: null });
      expect(pooledLogins).toBe(2);
    } finally { evictPool(acct.id); }
  });

  it('ends a new-mail run and drops its queue when the mailbox is disconnected', async () => {
    // DELETE /accounts/:id, a disable or a settings change: the next letter must not open a login.
    const acct = mailbox('node-bodies-disconnect');
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mgr.fetchMessageBody = vi.fn(async (_a, uid) => {
      if (uid === 103) await gate;
      return { html: null, text: `Body of ${uid}`, attachments: [] };
    });
    const first = mgr.prefetchNewMessageBodies(acct, newRows(101, 103));
    await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
    await mgr.prefetchNewMessageBodies(acct, newRows(104, 105)); // queued behind the run
    await mgr.disconnectAccount(acct.id);
    release();
    await first;
    expect(mgr.fetchMessageBody.mock.calls.map(c => c[1])).toEqual([103]);
    // A reconnected mailbox prefetches again.
    await mgr.prefetchNewMessageBodies(acct, newRows(106, 106));
    expect(mgr.fetchMessageBody.mock.calls.map(c => c[1])).toEqual([103, 106]);
  });

  it('ends a folder-view run when the mailbox is disconnected', async () => {
    const acct = mailbox('node-bodies-disconnect-folder');
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mgr.fetchMessageBody = vi.fn(async (_a, uid) => {
      if (uid === 101) await gate;
      return { html: null, text: `Body of ${uid}`, attachments: [] };
    });
    const running = mgr._prefetchBodyRun(acct, newRows(101, 103), { waitForQuiet: false });
    await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
    await mgr.disconnectAccount(acct.id);
    release();
    await running;
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest letters waiting, up to the per-sync bound', async () => {
    const acct = mailbox('node-bodies-queue-bound');
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn(async (_a, uid) => ({ html: null, text: `Body of ${uid}`, attachments: [] }));
    await mgr.prefetchNewMessageBodies(acct, newRows(101, 100 + NODE_NEW_BODY_PREFETCH_MAX + 10));
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(NODE_NEW_BODY_PREFETCH_MAX);
    expect(bodies.has(`row-${100 + NODE_NEW_BODY_PREFETCH_MAX + 10}`)).toBe(true);
    expect(bodies.has('row-110')).toBe(false);
  });

  it.each([
    ['Gmail: five', { mail_node: false, imap_host: 'imap.gmail.com', oauth_provider: 'google' }, 5],
    ['PurelyMail: one', { mail_node: false, imap_host: 'imap.purelymail.com' }, 1],
  ])('keeps no more waiting than one sync\'s budget of the mailbox (%s)', async (_name, extra, budget) => {
    // Ticks keep bringing letters while the lane waits on its first one: they must not add up.
    const acct = mailbox(`queue-budget-${budget}`, extra);
    const mgr = ladderManager();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mgr.fetchMessageBody = vi.fn(async (_a, uid) => {
      if (uid === 100 + budget) await gate;
      return { html: null, text: `Body of ${uid}`, attachments: [] };
    });
    const first = mgr.prefetchNewMessageBodies(acct, newRows(101, 100 + budget));
    await vi.waitFor(() => expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1));
    for (let tick = 1; tick <= 3; tick++) {
      const from = 100 + tick * budget + 1;
      await mgr.prefetchNewMessageBodies(acct, newRows(from, from + budget - 1));
    }
    release();
    await first;
    // The first sync's letters, then only the newest budget of the three later ones.
    const uids = mgr.fetchMessageBody.mock.calls.map(c => c[1]);
    expect(uids).toHaveLength(2 * budget);
    expect(Math.min(...uids.slice(budget))).toBe(100 + 3 * budget + 1);
  });

  // A mailing to many node mailboxes: every mailbox's lane runs at once, all on one node host.
  const lanesOnOneHost = async (extra, fetchImpl) => {
    const mgr = ladderManager();
    let inFlight = 0, peak = 0;
    const gates = [];
    mgr.fetchMessageBody = vi.fn(async (a, uid) => {
      inFlight++; peak = Math.max(peak, inFlight);
      try { return await fetchImpl(uid, gates); } finally { inFlight--; }
    });
    const lanes = Array.from({ length: 12 }, (_, n) =>
      mgr.prefetchNewMessageBodies(mailbox(`host-lane-${n}`, extra), newRows(100 + 2 * n + 1, 100 + 2 * n + 2)));
    return { mgr, lanes, gates, peak: () => peak, inFlight: () => inFlight };
  };

  it('holds the node mailboxes of one host to NODE_PREFETCH_PER_HOST letters in flight', async () => {
    const run = await lanesOnOneHost({}, (uid, gates) => new Promise(resolve => gates.push(() => resolve({ html: null, text: `Body of ${uid}`, attachments: [] }))));
    await vi.waitFor(() => expect(run.inFlight()).toBe(NODE_PREFETCH_PER_HOST));
    await settleBackground();
    expect(run.inFlight()).toBe(NODE_PREFETCH_PER_HOST);
    // Each finished letter lets the next one in, until all 24 are stored.
    while (bodies.size < 24) {
      while (run.gates.length) run.gates.shift()();
      await settleBackground();
    }
    await Promise.all(run.lanes);
    expect(run.peak()).toBe(NODE_PREFETCH_PER_HOST);
    expect(bodies.size).toBe(24);
  });

  it('gives the slot back when a letter fails', async () => {
    const run = await lanesOnOneHost({}, async () => { throw new Error('Unexpected server response'); });
    await Promise.all(run.lanes);
    expect(run.mgr.fetchMessageBody).toHaveBeenCalledTimes(24);
  });

  it('does not hold mailboxes off the node to the node host limit', async () => {
    const run = await lanesOnOneHost({ mail_node: false }, (uid, gates) => new Promise(resolve => gates.push(() => resolve({ html: null, text: `Body of ${uid}`, attachments: [] }))));
    await vi.waitFor(() => expect(run.inFlight()).toBe(12));
    while (run.gates.length || run.inFlight()) {
      while (run.gates.length) run.gates.shift()();
      await settleBackground();
    }
    await Promise.all(run.lanes);
  });

  it('pauses the new-mail lane after a run stopped on failures', async () => {
    const acct = mailbox('node-bodies-pause');
    const mgr = ladderManager();
    mgr.fetchMessageBody = vi.fn().mockRejectedValue(new Error('Pooled IMAP operation timeout (30000ms)'));
    await mgr.prefetchNewMessageBodies(acct, newRows(101, 105));
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
    await mgr.prefetchNewMessageBodies(acct, newRows(106, 106));
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(PREFETCH_MAX_CONSECUTIVE_ERRORS);
  });

  it('leaves a spam wave in Junk alone: the node budget is for the INBOX', async () => {
    const acct = mailbox('node-bodies-junk');
    const mgr = ladderManager();
    try {
      await mgr.syncMessages(acct, syncClient(12), 'Junk', 50, false, true);
      await settleBackground();
      await settleBackground();
      expect(bodyFetchOrder).toEqual([]);
      expect(pooledLogins).toBe(0);
    } finally { evictPool(acct.id); }
  });

  it('fetches only the newest letters of a flood, up to the per-sync bound', async () => {
    const acct = mailbox('node-bodies-flood');
    const mgr = ladderManager();
    const count = NODE_NEW_BODY_PREFETCH_MAX + 10;
    try {
      await mgr.syncMessages(acct, syncClient(count), 'INBOX', 20, false, true);
      await vi.waitFor(() => expect(bodies.size).toBe(NODE_NEW_BODY_PREFETCH_MAX));
      await settleBackground();
      expect(bodies.size).toBe(NODE_NEW_BODY_PREFETCH_MAX);
      expect(bodies.has(`row-${WATERMARK + count}`)).toBe(true);
      expect(bodies.has(`row-${WATERMARK + 10}`)).toBe(false);
    } finally { evictPool(acct.id); }
  });

  it('still warms only the newest arrival of a PurelyMail mailbox', async () => {
    const acct = mailbox('purelymail-bodies-3', { mail_node: false, imap_host: 'imap.purelymail.com' });
    const mgr = ladderManager();
    try {
      await mgr.syncMessages(acct, syncClient(3), 'INBOX', 20, false, true);
      await vi.waitFor(() => expect(bodies.size).toBe(1));
      await settleBackground();
      expect([...bodies.keys()]).toEqual([`row-${WATERMARK + 3}`]);
    } finally { evictPool(acct.id); }
  });

  it('leaves a batch of more than five alone on a mailbox off the node, as before', async () => {
    const acct = mailbox('generic-bodies-12', { mail_node: false });
    const mgr = ladderManager();
    try {
      await mgr.syncMessages(acct, syncClient(12), 'INBOX', 20, false, true);
      await settleBackground();
      await settleBackground();
      expect(bodyFetchOrder).toEqual([]);
      expect(pooledLogins).toBe(0);
    } finally { evictPool(acct.id); }
  });
});

describe('wrapImapError', () => {
  it('keeps what isImapAuthFailure needs, and a refusal stays a refusal', () => {
    const auth = imapErr({ response: '1 NO [AUTHENTICATIONFAILED] Authentication failed.', responseStatus: 'NO', responseText: 'Authentication failed.', serverResponseCode: 'AUTHENTICATIONFAILED', authenticationFailed: true });
    expect(isImapAuthFailure(wrapImapError(auth, extractImapError(auth)))).toBe(true);
    const limit = loginLimitRefusal();
    const wrappedLimit = wrapImapError(limit, extractImapError(limit));
    expect(isImapAuthFailure(wrappedLimit)).toBe(false);
    expect(isConnectionRefusal(extractImapError(wrappedLimit))).toBe(true);
    expect(wrapImapError(new Error('ECONNRESET'), 'ECONNRESET').imapError).toBe(true);
  });
});

describe('secondary-connection refusals escalate their own backoff', () => {
  // The folder status client on a generic host (the mail node): a fresh login per cycle.
  const acct = { id: 'secondary-acct', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
  let connectError;

  beforeEach(() => {
    vi.clearAllMocks();
    connectError = loginLimitRefusal;
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn(() => (connectError ? Promise.reject(connectError()) : Promise.resolve())),
        close: vi.fn(),
        logout: vi.fn(() => Promise.resolve()),
      });
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('climbs past the first rung even though successful syncs keep clearing the live-sync cooldown', async () => {
    // The reported loop: status login refused, a sync succeeds and clears the account's
    // cooldown, the next refusal is refusal #1 again, forever at 30s.
    const mgr = ladderManager();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);

    mgr._connectCooldown.delete(acct.id); // what a successful sync tick does
    mgr._secondaryCooldown.get(acct.id).until = 0; // the first wait has run out
    const before = Date.now();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    const cd = mgr._secondaryCooldown.get(acct.id);
    expect(cd.failures).toBe(2);
    expect(cd.until - before).toBeGreaterThanOrEqual(connectCooldownMs(2));
    // Live sync was never held back by a background connection.
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(mgr._bgConnSem.activeCount('mail.example.com')).toBe(0);
  });

  it('opens no login while the secondary backoff is armed, and does not escalate on its own gate', async () => {
    const mgr = ladderManager();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    ImapFlow.mockClear();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow('Provider connection cooldown active');
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
  });

  it('clears on a login the server accepted, even when the work after it fails', async () => {
    const mgr = ladderManager();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    mgr._secondaryCooldown.get(acct.id).until = 0;
    connectError = null;
    await expect(mgr._withCountClient(acct, async () => { throw new Error('Folder integrity sync timed out'); })).rejects.toThrow('timed out');
    expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
  });

  it('clears on a successful pooled status call (Gmail)', async () => {
    const gmailAcct = { ...acct, id: 'secondary-gmail', imap_host: 'imap.gmail.com' };
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [gmailAcct] : [], rowCount: 1 }));
    connectError = null;
    const mgr = ladderManager();
    mgr._secondaryCooldown.set(gmailAcct.id, { until: 0, failures: 3 });
    await mgr._withCountClient(gmailAcct, async () => {});
    expect(mgr._secondaryCooldown.has(gmailAcct.id)).toBe(false);
  });

  it('keeps a rejected password off the secondary ladder when no persistent connection vouches for it', async () => {
    connectError = gmailXoauthFailure;
    const mgr = ladderManager();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    expect(mgr._connectCooldown.get(acct.id).authFailures).toBe(1);
    expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
  });

  it('is lifted by an explicit reconnect or settings save', async () => {
    const mgr = ladderManager();
    await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
    mgr.clearConnectCooldown(acct.id);
    expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
  });
});

describe('fetchMessageBody opens no fresh login while a backoff is armed', () => {
  // Drives the real pool. The pooled attempt fails with ECONNRESET, which IS in the transient
  // list, so the tests reach the retry decision rather than failing before it.
  let created;
  let lockError;
  beforeEach(() => {
    vi.clearAllMocks();
    created = 0;
    lockError = new Error('ECONNRESET');
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    ImapFlow.mockImplementation(function () {
      created++;
      const client = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn().mockResolvedValue(),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn(() => Promise.reject(lockError)),
      });
      client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
      return client;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const account = id => ({ id, user_id: 'u1', imap_host: 'mail.example.com', imap_tls: true });
  // One pooled session already open and idle, as after an earlier click.
  const primeIdleSession = async (acct) => { releasePooledClient(acct, await acquirePooledClient(acct)); };
  const arms = {
    'the secondary backoff': (mgr, id) => mgr._secondaryCooldown.set(id, { until: Date.now() + 60000, failures: 2 }),
    'the live-sync cooldown': (mgr, id) => mgr._connectCooldown.set(id, { until: Date.now() + 60000, failures: 1 }),
    'a rejected secondary login': (mgr, id) => mgr._secondaryAuthCooldown.set(id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 }),
  };

  for (const [what, arm] of Object.entries(arms)) {
    it(`fails fast, typed and without a login, while ${what} is armed and no session is open`, async () => {
      const mgr = ladderManager();
      const acct = account(`body-gate-${what}`);
      arm(mgr, acct.id);
      await expect(mgr.fetchMessageBody(acct, 9, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
      expect(created).toBe(0);
    });
  }

  it('uses an idle pooled session while a backoff is armed, and rethrows typed instead of retrying', async () => {
    const mgr = ladderManager();
    const acct = account('body-gate-idle');
    await primeIdleSession(acct);
    expect(created).toBe(1);
    arms['the secondary backoff'](mgr, acct.id);
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX')).rejects.toMatchObject({ message: 'ECONNRESET', providerRefusing: true });
    expect(created).toBe(1); // the idle session only: no pool grow, no fresh-login retry
    evictPool(acct.id);
  });

  it('waits for a busy open session while a backoff is armed, instead of failing at once', async () => {
    const mgr = ladderManager();
    const acct = account('body-gate-busy');
    const busy = await acquirePooledClient(acct); // another click holds the only session
    arms['the secondary backoff'](mgr, acct.id);
    const click = mgr.fetchMessageBody(acct, 9, 'INBOX').catch(e => e);
    releasePooledClient(acct, busy);
    // It got the session (the fetch on it failed with ECONNRESET), and opened no login.
    expect(await click).toMatchObject({ message: 'ECONNRESET', providerRefusing: true });
    expect(created).toBe(1);
    evictPool(acct.id);
  });

  it('does not open a fresh first login for a preferFreshBodyFetch provider while a backoff is armed', async () => {
    const mgr = ladderManager();
    const acct = { ...account('body-gate-purelymail'), imap_host: 'imap.purelymail.com' };
    arms['the live-sync cooldown'](mgr, acct.id);
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(created).toBe(0);
  });

  it('does not retry when a backoff is armed while the first attempt runs', async () => {
    const mgr = ladderManager();
    const acct = account('body-gate-meanwhile');
    lockError = null;
    ImapFlow.mockImplementation(function () {
      created++;
      const client = Object.assign(new EventEmitter(), { usable: true, connect: vi.fn().mockResolvedValue(), logout: vi.fn().mockResolvedValue() });
      client.getMailboxLock = vi.fn(async () => {
        arms['the secondary backoff'](mgr, acct.id); // the status client was refused meanwhile
        throw new Error('ECONNRESET');
      });
      client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
      return client;
    });
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(created).toBe(1);
  });

  it('lets a rule forward (allowLogin) log in while the server only refuses extra connections', async () => {
    // A forward runs once per new message and nobody can retry it by clicking again.
    const mgr = ladderManager();
    const acct = account('body-forward-refusal');
    arms['the secondary backoff'](mgr, acct.id);
    const err = await mgr.fetchMessageBody(acct, 9, 'INBOX', { allowLogin: true }).catch(e => e);
    expect(err.message).toBe('ECONNRESET');
    expect(err.providerRefusing).toBeUndefined();
    expect(created).toBe(2); // the pool grow, then the fresh-login retry
  });

  it('still opens no login for a rule forward while the password is rejected', async () => {
    const mgr = ladderManager();
    const acct = account('body-forward-auth');
    arms['a rejected secondary login'](mgr, acct.id);
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX', { allowLogin: true })).rejects.toMatchObject({ providerRefusing: true });
    expect(created).toBe(0);
  });

  it('opens no fresh login for a rule forward on a fresh-login provider while the password is rejected', async () => {
    const mgr = ladderManager();
    const acct = { ...account('body-forward-auth-fresh'), imap_host: 'imap.purelymail.com' };
    arms['a rejected secondary login'](mgr, acct.id);
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX', { allowLogin: true })).rejects.toMatchObject({ providerRefusing: true });
    expect(created).toBe(0);
  });

  it('a rule forward uses an idle session while the password is rejected, and its retry fails typed', async () => {
    const mgr = ladderManager();
    const acct = account('body-forward-auth-idle');
    await primeIdleSession(acct);
    arms['a rejected secondary login'](mgr, acct.id);
    await expect(mgr.fetchMessageBody(acct, 9, 'INBOX', { allowLogin: true })).rejects.toMatchObject({ providerRefusing: true });
    expect(created).toBe(1); // the idle session only: the fresh-login retry is held back
    evictPool(acct.id);
  });

  it('still retries over a fresh login when nothing is armed', async () => {
    const mgr = ladderManager();
    const acct = account('body-retry-free');
    const err = await mgr.fetchMessageBody(acct, 9, 'INBOX').catch(e => e);
    expect(err.message).toBe('ECONNRESET');
    expect(err.providerRefusing).toBeUndefined();
    expect(created).toBe(2);
  });
});

describe('the live-sync ladder is cleared by a successful sync, not by a login', () => {
  // A standing count whose window has run out: the next connect is admitted, and the question
  // is whether a login alone wipes the count (upstream #474: "refusal #1" forever).
  const standing = () => ({ until: 0, failures: 3 });

  beforeEach(() => {
    vi.clearAllMocks();
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        connect: vi.fn().mockResolvedValue(),
        close: vi.fn(),
        logout: vi.fn().mockResolvedValue(),
      });
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('connectAccount', () => {
    // PurelyMail host: preferFreshBodyFetch skips the pool pre-warm, so no second client is
    // built behind the test's back. The path under test is the same for every provider.
    const acct = { id: 'ladder-connect', user_id: 'u1', enabled: true, imap_host: 'imap.purelymail.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const connectManager = () => {
      const mgr = ladderManager();
      query.mockResolvedValue({ rows: [], rowCount: 1 });
      mgr.folderStatusMonitor = null;
      mgr._shouldAutoBackfillOnConnect = vi.fn().mockResolvedValue(false);
      mgr.startProviderIdBackfill = vi.fn().mockResolvedValue();
      mgr._resumeThreadRecompute = vi.fn().mockResolvedValue();
      mgr._startSyncInterval = vi.fn();
      mgr._startPluginSyncTimers = vi.fn().mockResolvedValue();
      mgr.syncFolders = vi.fn().mockResolvedValue();
      return mgr;
    };

    it('keeps the count through a login whose initial sync fails', async () => {
      const mgr = connectManager();
      mgr._connectCooldown.set(acct.id, standing());
      mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Connection not available'));
      expect(await mgr.connectAccount(acct)).toBe(true);
      expect(mgr._connectCooldown.get(acct.id)?.failures).toBe(3);
    });

    it('clears the count once the initial sync succeeds', async () => {
      const mgr = connectManager();
      mgr._connectCooldown.set(acct.id, standing());
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      expect(await mgr.connectAccount(acct)).toBe(true);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    });
  });

  describe('the sync-tick reconnect', () => {
    const acct = { id: 'ladder-reconnect', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const tickManager = () => {
      const mgr = ladderManager();
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      mgr.syncFolders = vi.fn().mockResolvedValue();
      mgr._syncSpamFolder = vi.fn().mockResolvedValue();
      return mgr;
    };

    it('keeps the count through a reconnect whose sync fails', async () => {
      const mgr = tickManager();
      mgr._connectCooldown.set(acct.id, standing());
      // A failure that arms nothing, so any change in the count comes from the reconnect.
      mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Unexpected server response'));
      await mgr._syncTick(acct);
      expect(ImapFlow).toHaveBeenCalledTimes(1); // the reconnect did log in
      expect(mgr._connectCooldown.get(acct.id)?.failures).toBe(3);
    });

    it('clears the count once the sync after the reconnect succeeds', async () => {
      const mgr = tickManager();
      mgr._connectCooldown.set(acct.id, standing());
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      await mgr._syncTick(acct);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    });
  });

  it('clears the count on a successful poll-only tick, the only clear a poll-only account gets', async () => {
    const acct = { id: 'ladder-poll-only', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const mgr = ladderManager();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    mgr.syncFolders = vi.fn().mockResolvedValue();
    mgr._connectCooldown.set(acct.id, standing());
    mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Unexpected server response'));
    await mgr._pollOnlyTick(acct);
    expect(mgr._connectCooldown.get(acct.id)?.failures).toBe(3);
    mgr.syncMessages = vi.fn().mockResolvedValue({});
    await mgr._pollOnlyTick(acct);
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
  });

  describe('the account error follows the sync too', () => {
    const acct = { id: 'ladder-error', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const clears = () => query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = NULL'));
    const errorBroadcasts = (mgr) => mgr.broadcast.mock.calls.filter(([m]) => m.type === 'account_error');

    it('surfaces a login-ok, sync-refused loop on its second round', async () => {
      const mgr = ladderManager();
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded'));
      for (let i = 0; i < 2; i++) {
        await mgr._syncTick(acct);
        mgr._connectCooldown.get(acct.id).until = 0; // let the next reconnect through
      }
      expect(ImapFlow).toHaveBeenCalledTimes(2); // both reconnects logged in
      expect(errorBroadcasts(mgr)).toHaveLength(1);
    });

    describe('connectAccount', () => {
      const connectManager = () => {
        const mgr = ladderManager();
        query.mockResolvedValue({ rows: [], rowCount: 1 });
        mgr.folderStatusMonitor = null;
        mgr._shouldAutoBackfillOnConnect = vi.fn().mockResolvedValue(false);
        mgr.startProviderIdBackfill = vi.fn().mockResolvedValue();
        mgr._resumeThreadRecompute = vi.fn().mockResolvedValue();
        mgr._startSyncInterval = vi.fn();
        mgr._startPluginSyncTimers = vi.fn().mockResolvedValue();
        mgr.syncFolders = vi.fn().mockResolvedValue();
        return mgr;
      };
      const pmAcct = { ...acct, imap_host: 'imap.purelymail.com' }; // no pool pre-warm
      // The mailbox fails the real way: two refused sync ticks surface the error in the sidebar.
      const failUntilRed = async (mgr) => {
        query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [pmAcct] : [], rowCount: 1 }));
        mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded'));
        for (let i = 0; i < 2; i++) {
          await mgr._syncTick(pmAcct);
          mgr._connectCooldown.get(pmAcct.id).until = 0;
        }
        expect(errorBroadcasts(mgr)).toHaveLength(1);
        query.mockClear();
        mgr.broadcast.mockClear();
      };

      it('keeps a recorded error red through a login whose initial sync fails', async () => {
        const mgr = connectManager();
        await failUntilRed(mgr);
        mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Connection not available'));
        expect(await mgr.connectAccount(pmAcct)).toBe(true);
        expect(clears()).toHaveLength(0);
        expect(mgr.broadcast).not.toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
      });

      it('clears it once the initial sync succeeds', async () => {
        const mgr = connectManager();
        await failUntilRed(mgr);
        mgr.syncMessages = vi.fn().mockResolvedValue({});
        expect(await mgr.connectAccount(pmAcct)).toBe(true);
        expect(clears()).toHaveLength(1);
        expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
      });

      it('turns the sidebar green on the first good tick after a reconnect whose initial sync overran', async () => {
        // Health check or Reconnect: the login works, the initial sync misses its 40 s budget.
        // connectAccount drops the cached error state, so the tick that finally syncs must still
        // tell the frontend, which is showing the error it got earlier.
        const mgr = connectManager();
        await failUntilRed(mgr);
        mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Initial message sync timeout (40000ms)'));
        expect(await mgr.connectAccount(pmAcct)).toBe(true);
        expect(mgr.broadcast).not.toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
        mgr.syncMessages = vi.fn().mockResolvedValue({});
        await mgr._syncTick(pmAcct);
        expect(clears()).toHaveLength(1);
        expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
      });
    });
  });

  it('escalates across logins that succeed and syncs that do not', async () => {
    // The loop itself: each reconnect logs in, each sync is refused. The count must climb.
    const acct = { id: 'ladder-escalate', user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const mgr = ladderManager();
    query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
    mgr.syncMessages = vi.fn().mockRejectedValue(new Error('Maximum number of connections from user+IP exceeded'));
    for (let i = 0; i < 3; i++) {
      await mgr._syncTick(acct);
      mgr._connectCooldown.get(acct.id).until = 0; // let the next reconnect through
    }
    expect(mgr._connectCooldown.get(acct.id).failures).toBe(3);
  });
});

describe('every background login waits out a rejected password', () => {
  // Same setup as the prefetch case: the password changed on mailcow, the IDLE session survives,
  // and every new login is rejected. Each background path must stop at one rejected login and
  // then open nothing while the secondary auth window runs.
  let n = 0;
  const account = () => ({ id: `bg-auth-${++n}`, user_id: 'u1', enabled: true, protocol: 'imap', imap_host: 'mail.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' });
  const dovecotAuthFailure = () => imapErr({
    response: '1 NO [AUTHENTICATIONFAILED] Authentication failed.',
    responseStatus: 'NO',
    responseText: 'Authentication failed.',
    serverResponseCode: 'AUTHENTICATIONFAILED',
    authenticationFailed: true,
  });
  let connectError;
  let clients;

  beforeEach(() => {
    vi.clearAllMocks();
    clients = [];
    connectError = dovecotAuthFailure;
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        usable: true,
        connect: vi.fn(() => (connectError ? Promise.reject(connectError()) : Promise.resolve())),
        logout: vi.fn().mockResolvedValue(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([]),
        fetch: vi.fn(async function* () {}),
      });
      client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
      clients.push(client);
      return client;
    });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const liveManager = (acct) => {
    const mgr = ladderManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    return mgr;
  };
  const rejectedPassword = (mgr, acct) => mgr._secondaryAuthCooldown.set(acct.id, { until: Date.now() + AUTH_FAILURE_COOLDOWN_MS, failures: 1 });

  describe('staleness probe', () => {
    const probeCycleOf = (acct) => {
      const interval = vi.spyOn(globalThis, 'setInterval');
      const mgr = liveManager(acct);
      const cycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
      query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [acct], rowCount: 1 }));
      return { mgr, cycle };
    };

    it('does not log in while a rejected password holds background logins back', async () => {
      const acct = account();
      const { mgr, cycle } = probeCycleOf(acct);
      rejectedPassword(mgr, acct);
      await cycle();
      expect(clients).toHaveLength(0);
    });

    it('puts a rejected probe login on the secondary auth ladder, not the account-wide one', async () => {
      const acct = account();
      const { mgr, cycle } = probeCycleOf(acct);
      await cycle();
      expect(clients).toHaveLength(1);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(true);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
      await cycle();
      expect(clients).toHaveLength(1);
    });

    it('puts a refused probe login on the secondary backoff', async () => {
      const acct = account();
      connectError = loginLimitRefusal;
      const { mgr, cycle } = probeCycleOf(acct);
      await cycle();
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    });
  });

  describe('snippet indexer', () => {
    const indexerManager = (acct) => {
      const mgr = liveManager(acct);
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '5' }] };
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        return { rows: [], rowCount: 1 };
      });
      return mgr;
    };

    it('does not log in while a rejected password holds background logins back', async () => {
      const acct = account();
      const mgr = indexerManager(acct);
      rejectedPassword(mgr, acct);
      await mgr.startSnippetIndexer(acct);
      expect(clients).toHaveLength(0);
    });

    it('puts a rejected login on the account, not on the host shared with every other mailbox', async () => {
      const acct = account();
      const mgr = indexerManager(acct);
      await mgr.startSnippetIndexer(acct);
      expect(clients).toHaveLength(1);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(true);
      expect(mgr.snippetBackoff.has('mail.example.com')).toBe(false);
      expect(mgr._bgConnSem.activeCount('mail.example.com')).toBe(0);

    });

    it('neither arms nor clears the host backoff another mailbox left behind', async () => {
      // An expired host backoff still carries its failure count, which the next refusal on the host
      // climbs from. One mailbox's wrong password must not reset it for the whole node.
      const acct = account();
      const mgr = indexerManager(acct);
      mgr.snippetBackoff.set('mail.example.com', { until: Date.now() - 1, failures: 3 });
      await mgr.startSnippetIndexer(acct);
      expect(clients).toHaveLength(1);
      expect(mgr.snippetBackoff.get('mail.example.com')?.failures).toBe(3);
    });
  });

  it('bulk flag refresh stops at the first rejected folder login', async () => {
    const acct = account();
    const mgr = liveManager(acct);
    query.mockImplementation(async (sql) => {
      if (sql.includes('is_bulk IS NULL')) return { rows: [{ id: 'x1', uid: 1, folder: 'INBOX' }, { id: 'x2', uid: 2, folder: 'Sent' }, { id: 'x3', uid: 3, folder: 'Archive' }] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      return { rows: [], rowCount: 1 };
    });
    await mgr.refreshBulkFlags(acct);
    expect(clients).toHaveLength(1);
    expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(true);
    expect(mgr._bgConnSem.activeCount('mail.example.com')).toBe(0);
  });

  describe('an OAuth mailbox', () => {
    // Gmail over OAuth: connectImapClient already refreshed the token and retried once. A
    // leftover rejection is routine there, and fail2ban does not guard Gmail.
    const oauthAccount = () => ({ ...account(), imap_host: 'imap.gmail.com', oauth_provider: 'google', oauth_access_token: 'enc' });

    it('puts a rejected background login on the short secondary ladder, not the 30 min one', async () => {
      const acct = oauthAccount();
      const mgr = liveManager(acct);
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      const before = Date.now();
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
      expect(ensureFreshOAuthAccount.mock.calls.some(([, opts]) => opts?.force)).toBe(true);
      const cd = mgr._secondaryCooldown.get(acct.id);
      expect(cd.failures).toBe(1);
      expect(cd.until - before).toBeLessThan(AUTH_FAILURE_COOLDOWN_MS);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
      // Transient: not painted red.
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1'))).toBe(false);
    });

    it('a rejected flag store is not tried a second time', async () => {
      // Its short ladder holds no user login back, so only setFlag's own stop prevents a second
      // rejected login for the same store.
      const acct = oauthAccount();
      const mgr = liveManager(acct);
      await expect(mgr.setFlag(acct, 7, 'Sent', '\\Seen', true)).rejects.toBeTruthy();
      expect(ensureFreshOAuthAccount.mock.calls.filter(([, opts]) => opts?.force)).toHaveLength(1);
      expect(clients).toHaveLength(2); // the login and connectImapClient's one retry after a forced refresh
    });

    it('a rejected bulk store tries neither a second time nor its next chunk', async () => {
      // The pool holds no user login of an OAuth mailbox back, so a second chunk would be a
      // second rejected login.
      const acct = oauthAccount();
      const mgr = liveManager(acct);
      const uids = Array.from({ length: FLAG_STORE_UID_CHUNK + 1 }, (_, i) => i + 1);
      await expect(mgr.setFlags(acct, 'Sent', uids, '\\Seen', true)).rejects.toBeTruthy();
      expect(clients).toHaveLength(2); // one login, as for a single store
    });

    it('a rejected login on the first group of a bulk read tries no other group', async () => {
      const acct = oauthAccount();
      const mgr = liveManager(acct);
      const results = await mgr.setFlagsGroups(acct, [
        { folder: 'Sent', uids: [1, 2, 3] },
        { folder: 'Archive', uids: [4, 5] },
        { folder: 'Projects', uids: [6] },
      ], '\\Seen', true);
      expect(clients).toHaveLength(2); // one login, as for a single store
      expect(results[0]).toMatchObject({ stored: false, error: expect.anything() });
      expect(results.slice(1)).toEqual([{ stored: false, skipped: true }, { stored: false, skipped: true }]);
    });

    it('does the same when no persistent connection is up', async () => {
      const acct = oauthAccount();
      const mgr = ladderManager();
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    });
  });

  describe('flag stores on the pool', () => {
    // A store the persistent session cannot take (any folder but INBOX) goes to the pool.
    const withStore = () => {
      ImapFlow.mockImplementation(function () {
        const client = Object.assign(new EventEmitter(), {
          usable: true,
          connect: vi.fn(() => (connectError ? Promise.reject(connectError()) : Promise.resolve())),
          logout: vi.fn().mockResolvedValue(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          messageFlagsAdd: vi.fn().mockResolvedValue(true),
        });
        client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
        clients.push(client);
        return client;
      });
    };

    it('does not log in while a rejected password holds logins back, and fails typed', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      withStore();
      rejectedPassword(mgr, acct);
      await expect(mgr.setFlag(acct, 7, 'Sent', '\\Seen', true)).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(0);
    });

    it('a bulk read held back by a rejected password on its first group tries no other group', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      withStore();
      rejectedPassword(mgr, acct);
      const tried = vi.spyOn(mgr, '_setFlagInner');
      const results = await mgr.setFlagsGroups(acct, [{ folder: 'Sent', uids: [7] }, { folder: 'Archive', uids: [8] }], '\\Seen', true);
      expect(results[0]).toMatchObject({ stored: false, error: { providerRefusing: true, authRejected: true } });
      expect(results[1]).toEqual({ stored: false, skipped: true });
      expect(tried).toHaveBeenCalledOnce();
      expect(clients).toHaveLength(0);
    });

    it('does not log in while the account-wide auth ladder is armed either', async () => {
      const acct = account();
      const mgr = ladderManager();
      withStore();
      mgr._noteAuthFailure(acct);
      mgr._connectCooldown.get(acct.id).until = Date.now() + 60000;
      await expect(mgr.setFlag(acct, 7, 'Sent', '\\Seen', true)).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(0);
    });

    it('still stores over a pooled session that is already open', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      withStore();
      releasePooledClient(acct, await acquirePooledClient(acct));
      rejectedPassword(mgr, acct);
      await mgr.setFlag(acct, 7, 'Sent', '\\Seen', true);
      expect(clients).toHaveLength(1);
      expect(clients[0].messageFlagsAdd).toHaveBeenCalledOnce();
      evictPool(acct.id);
    });

    it('still logs in for a user store while the server only refuses extra connections', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      withStore();
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
      await mgr.setFlag(acct, 7, 'Sent', '\\Seen', true);
      expect(clients).toHaveLength(1);
      evictPool(acct.id);
    });

    it('the flag-push reconciler skips the account without spending an attempt', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: 7, folder: 'Sent' }] };
        return { rows: [], rowCount: 1 };
      });
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      rejectedPassword(mgr, acct);
      const setFlag = vi.spyOn(mgr, 'setFlag').mockResolvedValue();
      await mgr._reconcileFlagPushes();
      expect(setFlag).not.toHaveBeenCalled();
      expect(mgr._pendingFlagPush.get(acct.id).get('m-1:\\Seen').attempts).toBe(0);
      // Once the password works again (Reconnect, settings save), the queued store goes out.
      mgr.clearConnectCooldown(acct.id);
      await mgr._reconcileFlagPushes();
      expect(setFlag).toHaveBeenCalledWith(acct, 7, 'Sent', '\\Seen', true, { background: true });
      expect(mgr._pendingFlagPush.has(acct.id)).toBe(false);
    });

    it('the flag-push reconciler drains a poll-only account, which has no persistent connection', async () => {
      const acct = account();
      const mgr = ladderManager();
      mgr._pollOnlyAccounts.add(acct.id);
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: 7, folder: 'Sent' }] };
        return { rows: [], rowCount: 1 };
      });
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      const setFlag = vi.spyOn(mgr, 'setFlag').mockResolvedValue();
      await mgr._reconcileFlagPushes();
      expect(setFlag).toHaveBeenCalledWith(acct, 7, 'Sent', '\\Seen', true, { background: true });
      expect(mgr._pendingFlagPush.has(acct.id)).toBe(false);
    });

    // A letter whose DB-first move has not reached the server holds a placeholder uid: storing
    // there is impossible, and storing at its old uid would land after the MOVE. The queued value
    // goes onto the move (moveQueue.deferFlags), which stores it at the new uid after the MOVE.
    it('the flag-push reconciler hands a store for a letter being moved to its move', async () => {
      const acct = account();
      const mgr = ladderManager();
      mgr._pollOnlyAccounts.add(acct.id);
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: '-4', folder: 'Archive' }] };
        return { rows: [], rowCount: 1 };
      });
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      const setFlag = vi.spyOn(mgr, 'setFlag').mockResolvedValue();
      const defer = vi.spyOn(mgr.moveQueue, 'deferFlags').mockResolvedValue({ deferred: new Set(['m-1']), located: new Map() });
      await mgr._reconcileFlagPushes();
      expect(defer).toHaveBeenCalledWith([{ id: 'm-1', uid: '-4' }], '\\Seen', true);
      expect(setFlag).not.toHaveBeenCalled();
      expect(mgr._pendingFlagPush.has(acct.id)).toBe(false);
    });

    // The window above runs out while the password is still wrong. Nothing re-armed it, so the
    // reconciler's next cycle sent up to 30 queued stores to the pool, two rejected logins each:
    // one cycle is enough for fail2ban to ban the panel's IP.
    it('arms the auth ladder on a rejected pool login and does not try a second login', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      withStore();
      await expect(mgr.setFlag(acct, 7, 'Sent', '\\Seen', true)).rejects.toBeTruthy();
      expect(clients).toHaveLength(1);
      expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
    });

    it('the reconciler stops within a cycle once a store re-arms the auth ladder', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      withStore();
      query.mockImplementation(async (sql) => {
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: 7, folder: 'Sent' }] };
        return { rows: [], rowCount: 1 };
      });
      for (let i = 1; i <= 5; i++) mgr._enqueueFlagPush(acct.id, `m-${i}`, '\\Seen', true);
      await mgr._reconcileFlagPushes();
      expect(clients).toHaveLength(1);
      await mgr._reconcileFlagPushes();
      expect(clients).toHaveLength(1);
      // Nothing is dropped: every store stays queued for when the password works again, and the
      // stores that never reached the server spend no attempt toward the give-up budget.
      const queued = [...mgr._pendingFlagPush.get(acct.id).values()];
      expect(queued).toHaveLength(5);
      expect(queued.filter(op => op.attempts > 0)).toHaveLength(1);
    });
  });

  describe('the flag-push reconciler and a newer change queued mid-cycle', () => {
    // An older op (mark read) is being replayed when the user marks the letter unread and that
    // store fails: _enqueueFlagPush puts a NEW op under the same key. The replay must neither
    // write its stale value, nor clear the newer change's marker, nor delete the newer op, or
    // the next pull reverts the letter to read and the user's change is lost.
    const arrangeReplay = (acct, hooks = {}) => {
      const sqls = [];
      query.mockImplementation(async (sql, params) => {
        sqls.push([sql, params]);
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) { await hooks.onReread?.(); return { rows: [{ uid: 7, folder: 'Sent' }] }; }
        if (sql.includes('read_changed_at = NULL')) await hooks.onClear?.();
        return { rows: [], rowCount: 1 };
      });
      return sqls;
    };
    const markUnread = (mgr, acct) => mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', false);
    const queuedValue = (mgr, acct) => mgr._pendingFlagPush.get(acct.id)?.get('m-1:\\Seen')?.value;
    const clears = (sqls) => sqls.filter(([sql]) => sql.includes('read_changed_at = NULL'));

    it('queued during the re-read: nothing stale is written or pushed', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      const sqls = arrangeReplay(acct, { onReread: () => markUnread(mgr, acct) });
      const setFlag = vi.spyOn(mgr, 'setFlag').mockResolvedValue();

      await mgr._reconcileFlagPushes();

      expect(setFlag).not.toHaveBeenCalled();
      expect(sqls.some(([sql, params]) => sql.startsWith('UPDATE messages SET is_read') && params[0] === true)).toBe(false);
      expect(clears(sqls)).toHaveLength(0);
      expect(queuedValue(mgr, acct)).toBe(false);
    });

    it('queued while the replay stores: its marker and op stay', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      const sqls = arrangeReplay(acct);
      vi.spyOn(mgr, 'setFlag').mockImplementation(async () => { markUnread(mgr, acct); });

      await mgr._reconcileFlagPushes();

      expect(clears(sqls)).toHaveLength(0);
      expect(queuedValue(mgr, acct)).toBe(false);
    });

    it('queued while the replay clears its marker: the op stays', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      arrangeReplay(acct, { onClear: () => markUnread(mgr, acct) });
      vi.spyOn(mgr, 'setFlag').mockResolvedValue();

      await mgr._reconcileFlagPushes();

      expect(queuedValue(mgr, acct)).toBe(false);
    });

    it('queued while the last attempt fails: the replay does not give the newer op up', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      mgr._pendingFlagPush.get(acct.id).get('m-1:\\Seen').attempts = FLAG_PUSH_MAX_ATTEMPTS - 1;
      const sqls = arrangeReplay(acct);
      vi.spyOn(mgr, 'setFlag').mockImplementation(async () => { markUnread(mgr, acct); throw new Error('NO'); });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await mgr._reconcileFlagPushes();

      expect(clears(sqls)).toHaveLength(0);
      expect(queuedValue(mgr, acct)).toBe(false);
    });

    it('clears only the marker its own re-assert wrote', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      const sqls = [];
      query.mockImplementation(async (sql, params) => {
        sqls.push([sql, params]);
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: 7, folder: 'Sent' }] };
        if (sql.includes('RETURNING read_changed_at::text')) return { rows: [{ marker: '2026-09-26 10:00:00.123456+00' }] };
        return { rows: [], rowCount: 1 };
      });
      vi.spyOn(mgr, 'setFlag').mockResolvedValue();

      await mgr._reconcileFlagPushes();

      expect(clears(sqls)).toEqual([[expect.stringContaining('AND read_changed_at = $2::timestamptz'), ['m-1', '2026-09-26 10:00:00.123456+00']]]);
      expect(mgr._pendingFlagPush.has(acct.id)).toBe(false);
    });

    it('queued while the give-up clears its marker: the op stays', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr._enqueueFlagPush(acct.id, 'm-1', '\\Seen', true);
      mgr._pendingFlagPush.get(acct.id).get('m-1:\\Seen').attempts = FLAG_PUSH_MAX_ATTEMPTS - 1;
      arrangeReplay(acct, { onClear: () => markUnread(mgr, acct) });
      vi.spyOn(mgr, 'setFlag').mockRejectedValue(new Error('NO'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await mgr._reconcileFlagPushes();

      expect(queuedValue(mgr, acct)).toBe(false);
    });
  });

  describe('background work on the pool', () => {
    it('does not grow the pool while a rejected password holds background logins back', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      rejectedPassword(mgr, acct);
      await expect(mgr.syncFolderViaPool(acct, 'Todo')).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(0);
      expect(mgr.syncMessages).not.toHaveBeenCalled();
    });

    it('still uses a session that is already open and idle', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      connectError = null;
      await mgr.syncFolderViaPool(acct, 'Todo'); // opens one pooled session and returns it
      expect(clients).toHaveLength(1);
      rejectedPassword(mgr, acct);
      await mgr.syncFolderViaPool(acct, 'Todo');
      expect(clients).toHaveLength(1);
      expect(mgr.syncMessages).toHaveBeenCalledTimes(2);
      mgr.disconnectAccount(acct.id);
    });

    it('grows the pool as before when nothing is armed', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      connectError = null;
      await mgr.syncFolderViaPool(acct, 'Todo');
      expect(clients).toHaveLength(1);
      mgr.disconnectAccount(acct.id);
    });
  });

  describe('a ladder climbs one step per window', () => {
    // Logins that started before the window was armed are rejected after it: they must not push
    // the ladder further. Three concurrent stores used to land it on its third step (2 h).
    it('three concurrent rejected flag stores arm the secondary auth ladder once', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      const before = Date.now();
      const stores = [7, 8, 9].map(uid => mgr.setFlag(acct, uid, 'Sent', '\\Seen', true).catch(e => e));
      await Promise.all(stores);
      const cd = mgr._secondaryAuthCooldown.get(acct.id);
      expect(cd.failures).toBe(1);
      expect(cd.until - before).toBeLessThan(2 * AUTH_FAILURE_COOLDOWN_MS);
    });

    it('the account-wide auth ladder counts one step per open window', () => {
      const acct = account();
      const mgr = ladderManager();
      mgr._noteAuthFailure(acct);
      mgr._noteAuthFailure(acct);
      expect(mgr._connectCooldown.get(acct.id).authFailures).toBe(1);
      mgr._connectCooldown.get(acct.id).until = 0; // the window ran out
      mgr._noteAuthFailure(acct);
      expect(mgr._connectCooldown.get(acct.id).authFailures).toBe(2);
    });

    it('a rejected password still promotes an open refusal window to the auth ladder', () => {
      const acct = account();
      const mgr = ladderManager();
      mgr._noteConnectionRefusal(acct);
      mgr._noteAuthFailure(acct);
      const cd = mgr._connectCooldown.get(acct.id);
      expect(cd.authArmed).toBe(true);
      expect(cd.authFailures).toBe(1);
    });

    it('the secondary refusal ladder counts one step per open window', () => {
      const acct = account();
      const mgr = ladderManager();
      mgr._noteSecondaryRefusal(acct);
      mgr._noteSecondaryRefusal(acct);
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
    });
  });

  describe('snooze wakeup', () => {
    // A letter snoozed until 9:00 in a node mailbox whose password changed on mailcow: the wakeup
    // ran every minute and logged in for it every time, windows or not.
    const snoozeManager = (acct) => {
      const mgr = liveManager(acct);
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT sm.id AS snooze_id')) {
          return { rows: [{ snooze_id: 's1', account_id: acct.id, message_id_header: '<s1@example.com>', original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: 5, is_read: true }] };
        }
        if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
        return { rows: [], rowCount: 1 };
      });
      return mgr;
    };
    const snoozeRowDeleted = () => query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM snoozed_messages WHERE id'));

    const holds = {
      'a rejected password': rejectedPassword,
      // The pool's own gate covers rejected passwords only; a background job also waits out refusals.
      'the secondary refusal backoff': (mgr, acct) => mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 }),
    };
    for (const [what, hold] of Object.entries(holds)) {
      it(`does not log in while ${what} holds background logins back, and keeps the letter`, async () => {
        const acct = account();
        const mgr = snoozeManager(acct);
        connectError = null; // whatever the server would answer, no login is tried
        hold(mgr, acct);
        await mgr._runSnoozeWakeup();
        expect(clients).toHaveLength(0);
        expect(snoozeRowDeleted()).toBe(false);
      });
    }

    it('arms the ladder on its rejected login, so the next minute opens nothing', async () => {
      const acct = account();
      const mgr = snoozeManager(acct);
      await mgr._runSnoozeWakeup();
      expect(clients).toHaveLength(1);
      await mgr._runSnoozeWakeup();
      expect(clients).toHaveLength(1);
      expect(snoozeRowDeleted()).toBe(false);
    });

    it('wakes no letter whose move is pending: it has no uid in the snoozed folder yet', async () => {
      const acct = account();
      const mgr = snoozeManager(acct);
      rejectedPassword(mgr, acct);
      await mgr._runSnoozeWakeup();
      const due = query.mock.calls.find(([sql]) => sql.includes('SELECT sm.id AS snooze_id'))[0];
      expect(due).toMatch(/AND m\.uid > 0/);
    });

    it('leaves a disabled mailbox alone', async () => {
      const acct = { ...account(), enabled: false };
      const mgr = snoozeManager(acct);
      await mgr._runSnoozeWakeup();
      expect(clients).toHaveLength(0);
    });

    it('wakes the letter once the password works again', async () => {
      const acct = account();
      const mgr = snoozeManager(acct);
      await mgr._runSnoozeWakeup();
      mgr.clearConnectCooldown(acct.id); // Reconnect or a settings save with the new password
      connectError = null;
      ImapFlow.mockImplementation(function () {
        const client = Object.assign(new EventEmitter(), {
          usable: true,
          connect: vi.fn().mockResolvedValue(),
          logout: vi.fn().mockResolvedValue(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          capabilities: new Map([['MOVE', true]]), // a server with MOVE: moves go to messageMove
          messageMove: vi.fn().mockResolvedValue({ uidMap: new Map([[5, 50]]) }),
          messageFlagsRemove: vi.fn().mockResolvedValue(true),
        });
        client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
        clients.push(client);
        return client;
      });
      const move = vi.spyOn(mgr, 'moveMessageGetNewUid');
      const store = vi.spyOn(mgr, 'setFlag');
      await mgr._runSnoozeWakeup();
      expect(clients[1].messageMove).toHaveBeenCalledOnce();
      expect(snoozeRowDeleted()).toBe(true);
      // Background work: held back later, it must fail at once rather than queue.
      expect(move).toHaveBeenCalledWith(acct, 5, 'Snoozed', 'INBOX', { background: true });
      expect(store).toHaveBeenCalledWith(acct, 50, 'INBOX', '\\Seen', false, { background: true });
      evictPool(acct.id);
    });
  });

  describe('every login path under a rejected password', () => {
    // The login-path table of the final review of #98, walked end to end: every path that can open
    // a new IMAP login, run twice per window against Dovecot rejecting the password. Each costs at
    // most one rejected login per window and none while the window is open.
    // Not walked here: row 2 (the pool pre-warm runs only after connectAccount's login was
    // accepted; row 1 counts every login connectAccount opens), row 4 (_syncInboxWithFreshLogin
    // runs only for a freshInboxSync profile, and no shipped profile sets it), row 11 (provider id
    // backfill: imapManager.providerIds.test.js, 'costs at most one rejected login per auth window').
    const snoozeRow = (acct) => ({ snooze_id: 's1', account_id: acct.id, message_id_header: '<s1@example.com>', original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: 5, is_read: true });
    const walkQuery = (acct) => async (sql, params) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct], rowCount: 1 };
      if (sql.includes('AS cached')) return { rows: [{ uid: params[0] === 'p1' ? 1 : 2, folder: 'INBOX', cached: false }] };
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '5' }] };
      if (sql.includes('is_bulk IS NULL')) return { rows: [{ id: 'x1', uid: 1, folder: 'INBOX' }, { id: 'x2', uid: 2, folder: 'Sent' }] };
      if (sql.includes('body_html IS NULL AND body_text IS NULL')) return { rows: [{ id: 'p1', uid: 1, folder: 'INBOX' }, { id: 'p2', uid: 2, folder: 'INBOX' }] };
      if (sql.startsWith('SELECT uid, folder FROM messages')) return { rows: [{ uid: 7, folder: 'Sent' }] };
      if (sql.includes('SELECT sm.id AS snooze_id')) return { rows: [snoozeRow(acct)] };
      if (sql.includes('SELECT DISTINCT m.folder')) return { rows: [{ folder: 'INBOX' }] };
      if (sql.includes('lower(name) ~')) return { rows: [{ path: 'Junk' }] };
      return { rows: [], rowCount: 1 };
    };
    const live = (acct) => liveManager(acct);
    const idle = () => ladderManager(); // no persistent connection
    const paths = [
      // [row, path, make(acct) -> mgr, run(mgr, acct)]
      ['1', 'connectAccount', idle, (mgr, a) => mgr.connectAccount(a)],
      ['3', 'sync tick reconnect', idle, (mgr, a) => mgr._syncTick(a)],
      ['5', 'poll-only tick', idle, (mgr, a) => mgr._pollOnlyTick(a)],
      ['6', 'staleness probe', (a) => {
        const interval = vi.spyOn(globalThis, 'setInterval');
        const mgr = live(a);
        mgr._walkProbe = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
        query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [a], rowCount: 1 }));
        return mgr;
      }, (mgr) => mgr._walkProbe()],
      ['7', 'folder status client', live, (mgr, a) => mgr._withCountClient(a, async () => {})],
      ['8', 'backfill', live, (mgr, a) => mgr.backfillMessages(a, 'Sent')],
      ['9', 'bulk flag refresh', live, (mgr, a) => mgr.refreshBulkFlags(a)],
      ['10', 'snippet indexer', live, (mgr, a) => mgr.startSnippetIndexer(a)],
      ['12', 'body prefetch', live, (mgr, a) => mgr.prefetchFolderBodies(a.id, ['p1', 'p2'])],
      ['13', 'flag store on the pool', live, (mgr, a) => mgr.setFlag(a, 7, 'Sent', '\\Seen', true)],
      ['14', 'flag-push reconciler', live, (mgr, a) => { mgr._enqueueFlagPush(a.id, 'm-1', '\\Seen', true); return mgr._reconcileFlagPushes(); }],
      ['15', 'IDLE flag sync', live, (mgr, a) => mgr._syncFlagsForRange(a)],
      ['16', 'IDLE expunge reconcile', live, (mgr, a) => mgr.reconcileDeletes(a)],
      ['17', 'spam poll', live, (mgr, a) => mgr._syncSpamFolder(a)],
      ['18', 'GTD folder sync', live, (mgr, a) => mgr.syncFolderViaPool(a, 'Todo')],
      ['19', 'rule move', live, (mgr, a) => mgr.bulkMoveMessages(a, [5], 'INBOX', 'Archive')],
      ['20', 'rule forward', live, (mgr, a) => mgr.fetchMessageBody(a, 5, 'INBOX', { allowLogin: true })],
      ['21', 'snooze wakeup', live, (mgr) => mgr._runSnoozeWakeup()],
      ['22', 'message click', live, (mgr, a) => mgr.fetchMessageBody(a, 5, 'INBOX')],
      ['23', 'headers', live, (mgr, a) => mgr.fetchHeaders(a, 5, 'INBOX')],
      ['23', 'raw message (.eml download, #381)', live, (mgr, a) => mgr.fetchRawMessage(a, 5, 'INBOX')],
      ['23', 'raw message size (.eml size cap)', live, (mgr, a) => mgr.fetchMessageSize(a, 5, 'INBOX')],
      ['23', 'attachment', live, (mgr, a) => mgr.fetchAttachment(a, 5, 'INBOX', '2')],
      ['23', 'attachments as ZIP', live, (mgr, a) => mgr.fetchMultipleAttachments(a, 5, 'INBOX', [{ part: '2' }])],
      ['23', 'move', live, (mgr, a) => mgr.moveMessage(a, 5, 'INBOX', 'Archive')],
      ['23', 'delete from Trash', live, (mgr, a) => mgr.permanentDeleteMessage(a, 5, 'Trash')],
      ['23', 'bulk permanent delete', live, (mgr, a) => mgr.bulkPermanentDelete(a, [5], 'Trash')],
      ['23', 'empty folder', live, (mgr, a) => mgr.emptyFolder(a, 'Trash')],
      ['23', 'mark all read', live, (mgr, a) => mgr.markAllReadImap(a, 'INBOX')],
      ['23', 'create folder', live, (mgr, a) => mgr.ensureFolder(a, 'Projects')],
      ['23', 'rename folder', live, (mgr, a) => mgr.renameFolder(a, 'Projects', 'Archive2')],
      ['23', 'delete folder', live, (mgr, a) => mgr.deleteFolder(a, 'Projects')],
      ['23', 'append (draft, Sent copy)', live, (mgr, a) => mgr.appendToFolder(a, 'Drafts', 'raw')],
      ['23', 'find the Sent copy', live, (mgr, a) => mgr.findUidByMessageId(a, 'Sent', '<m@example.com>')],
      ['23', 'label copy', live, (mgr, a) => mgr.copyMessage(a.id, 5, 'INBOX', 'Label')],
      ['23', 'open a folder', live, (mgr, a) => mgr.syncFolderOnDemand(a, 'Archive')],
    ];
    const expire = (mgr, acct) => {
      for (const map of [mgr._connectCooldown, mgr._secondaryAuthCooldown, mgr._secondaryCooldown]) {
        const cd = map.get(acct.id);
        if (cd) cd.until = 0;
      }
      mgr._prefetchPausedUntil.clear(); // a 60 s pause, long gone once a 30 min window has run out
    };

    for (const [row, what, make, run] of paths) {
      it(`row ${row}, ${what}: one rejected login per window, none while it is open`, async () => {
        const acct = account();
        query.mockImplementation(walkQuery(acct));
        const mgr = make(acct);
        const attempt = () => Promise.resolve().then(() => run(mgr, acct)).catch(() => {});

        await attempt();
        expect(clients).toHaveLength(1);
        expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
        await attempt();
        expect(clients).toHaveLength(1);

        expire(mgr, acct);
        await attempt();
        expect(clients).toHaveLength(2);
        expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
        await attempt();
        expect(clients).toHaveLength(2);

        await mgr.disconnectAccount(acct.id);
        evictPool(acct.id);
      });
    }
  });

  describe('a persistent login the server accepts lifts the window', () => {
    // The password was fixed on the server and nobody pressed Reconnect: the persistent session
    // logs in again with the same credentials. That proves the password, so background logins and
    // uncached clicks must not stay held back (and the mailbox red) until the window runs out.
    const acceptingManager = (acct) => {
      const mgr = ladderManager();
      connectError = null;
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      mgr.syncFolders = vi.fn().mockResolvedValue();
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      mgr._shouldAutoBackfillOnConnect = vi.fn().mockResolvedValue(false);
      mgr.startProviderIdBackfill = vi.fn().mockResolvedValue();
      mgr._resumeThreadRecompute = vi.fn().mockResolvedValue();
      mgr._startSyncInterval = vi.fn();
      mgr._startPluginSyncTimers = vi.fn().mockResolvedValue();
      mgr.folderStatusMonitor = { refresh: vi.fn().mockResolvedValue() };
      return mgr;
    };
    const errorCleared = () => query.mock.calls.some(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = NULL'));

    it('on connectAccount', async () => {
      const acct = account();
      const mgr = acceptingManager(acct);
      rejectedPassword(mgr, acct);
      expect(await mgr.connectAccount(acct)).toBe(true);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      expect(mgr._authLoginBlocked(acct.id)).toBeNull();
      expect(errorCleared()).toBe(true);
      await mgr.disconnectAccount(acct.id);
      evictPool(acct.id);
    });

    it('on the sync tick reconnect', async () => {
      const acct = account();
      const mgr = acceptingManager(acct);
      rejectedPassword(mgr, acct);
      await mgr._syncTick(acct);
      expect(mgr.connections.has(acct.id)).toBe(true);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      expect(errorCleared()).toBe(true);
      await mgr.disconnectAccount(acct.id);
    });
  });

  describe('the pool arms the auth ladder and holds logins back', () => {
    // Every pooled or fresh login goes through growPool or withFreshLogin, so that is where a
    // rejected password is noted, and where a noted one stops the next login.
    const expireWindows = (mgr, acct) => {
      for (const map of [mgr._connectCooldown, mgr._secondaryAuthCooldown, mgr._secondaryCooldown]) {
        const cd = map.get(acct.id);
        if (cd) cd.until = 0;
      }
    };

    it('a background job arms the ladder on its rejected login, and the next job opens nothing', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      await mgr._syncFlagsForRange(acct);
      expect(clients).toHaveLength(1);
      expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
      await mgr._syncFlagsForRange(acct);
      await mgr.reconcileDeletes(acct).catch(() => {});
      await mgr.syncFolderViaPool(acct, 'Todo').catch(() => {});
      expect(clients).toHaveLength(1);
    });

    it('after the window runs out, one rejected login arms it again', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      await mgr._syncFlagsForRange(acct);
      expireWindows(mgr, acct);
      await mgr._syncFlagsForRange(acct);
      expect(clients).toHaveLength(2);
      expect(mgr._secondaryAuthCooldown.get(acct.id).failures).toBe(2);
      await mgr._syncFlagsForRange(acct);
      expect(clients).toHaveLength(2);
    });

    it('a rule move costs one rejected login and then fails typed, without reconciling', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      await expect(mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive')).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(1);
      const statusWarnings = () => console.warn.mock.calls.filter(([msg]) => String(msg).includes('reconciliation skipped')).length;
      const warned = statusWarnings();
      await expect(mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive')).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(1);
      // Held back at the STATUS step already: no move is attempted after it.
      expect(statusWarnings()).toBe(warned);
    });

    describe('a held-back error says whether a rejected password is the reason', () => {
      // Routes answer mailbox_auth_rejected for those (retrying will not help) and mailbox_busy
      // for everything else.
      it('a user action with no open session', async () => {
        const acct = account();
        rejectedPassword(liveManager(acct), acct);
        await expect(acquirePooledClient(acct)).rejects.toMatchObject({ providerRefusing: true, authRejected: true });
      });

      it('a background caller', async () => {
        const acct = account();
        rejectedPassword(liveManager(acct), acct);
        await expect(acquirePooledClient(acct, { background: true })).rejects.toMatchObject({ providerRefusing: true, authRejected: true });
      });

      it('a fresh login (a rule forward on PurelyMail)', async () => {
        const acct = { ...account(), imap_host: 'imap.purelymail.com' };
        const mgr = liveManager(acct);
        rejectedPassword(mgr, acct);
        await expect(mgr.fetchMessageBody(acct, 5, 'INBOX', { allowLogin: true })).rejects.toMatchObject({ providerRefusing: true, authRejected: true });
      });

      it('a message click whose fresh-login retry the window holds back', async () => {
        const acct = account();
        const mgr = liveManager(acct);
        connectError = null;
        ImapFlow.mockImplementation(function () {
          const client = Object.assign(new EventEmitter(), {
            usable: true,
            connect: vi.fn().mockResolvedValue(),
            logout: vi.fn().mockResolvedValue(),
            getMailboxLock: vi.fn(() => Promise.reject(new Error('ECONNRESET'))),
          });
          client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
          clients.push(client);
          return client;
        });
        releasePooledClient(acct, await acquirePooledClient(acct)); // one idle session
        rejectedPassword(mgr, acct);
        await expect(mgr.fetchMessageBody(acct, 5, 'INBOX')).rejects.toMatchObject({ message: 'ECONNRESET', providerRefusing: true, authRejected: true });
        evictPool(acct.id);
      });

      it('not a hold by the secondary refusal backoff', async () => {
        const acct = account();
        const mgr = liveManager(acct);
        mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
        const err = await mgr.fetchMessageBody(acct, 5, 'INBOX').catch(e => e);
        expect(err.providerRefusing).toBe(true);
        expect(err.authRejected).toBeUndefined();
      });
    });

    it('a user action before anything was armed costs one login, and the next fails fast', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      await expect(mgr.fetchMessageBody(acct, 5, 'INBOX')).rejects.toBeTruthy();
      expect(clients).toHaveLength(1);
      await expect(mgr.fetchMessageBody(acct, 5, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
      await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).rejects.toMatchObject({ providerRefusing: true });
      await expect(mgr.fetchAttachment(acct, 5, 'INBOX', '2')).rejects.toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(1);
    });

    it('a server refusal on a pool login does not hold the next user action back', async () => {
      // Dovecot's per-user+IP limit: not a rejected password, so no auth window and no hold.
      const acct = account();
      const mgr = liveManager(acct);
      connectError = loginLimitRefusal;
      const first = await mgr.moveMessage(acct, 5, 'INBOX', 'Archive').catch(e => e);
      expect(first.providerRefusing).toBeUndefined();
      expect(mgr._authLoginBlocked(acct.id)).toBeNull();
      const second = await mgr.moveMessage(acct, 5, 'INBOX', 'Archive').catch(e => e);
      expect(second.providerRefusing).toBeUndefined();
      expect(clients).toHaveLength(2);
    });

    it('the Gmail folder status client through the pool: one rejected login per short window', async () => {
      // Gmail runs folder status on the pool (statusOnPool), as a background caller.
      const acct = { ...account(), imap_host: 'imap.gmail.com', oauth_provider: 'google', oauth_access_token: 'enc' };
      const mgr = liveManager(acct);
      query.mockImplementation(async (sql) => ({ rows: sql.startsWith('SELECT * FROM email_accounts') ? [acct] : [], rowCount: 1 }));
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
      const perAttempt = clients.length; // the login and connectImapClient's retry after a forced refresh
      expect(perAttempt).toBeGreaterThan(0);
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow('Provider connection cooldown active');
      expect(clients).toHaveLength(perAttempt);
      mgr._secondaryCooldown.get(acct.id).until = 0; // the short window ran out
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toThrow();
      expect(clients).toHaveLength(2 * perAttempt);
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(2);
    });

    it('without a persistent session, a rejected pool login arms the account-wide ladder and paints the mailbox red', async () => {
      // Nothing else would record it: reconnect, health check and status client wait the window out.
      const acct = account();
      const mgr = ladderManager();
      query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
      await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).rejects.toBeTruthy();
      expect(mgr._connectCooldown.get(acct.id).authArmed).toBe(true);
      const writes = query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1'));
      expect(writes).toHaveLength(1);
      expect(writes[0][1][0]).toMatch(/AUTHENTICATIONFAILED/);
      expect(mgr.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'account_error', accountId: acct.id }));
    });

    it('a rejected fresh login arms the ladder too', async () => {
      // PurelyMail fetches bodies over a brand-new login (preferFreshBodyFetch), not the pool.
      const acct = { ...account(), imap_host: 'imap.purelymail.com' };
      const mgr = liveManager(acct);
      await expect(mgr.fetchMessageBody(acct, 5, 'INBOX', { allowLogin: true })).rejects.toBeTruthy();
      expect(clients).toHaveLength(1);
      expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
    });

    it('still serves a user action over a pooled session that is already open', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      releasePooledClient(acct, await acquirePooledClient(acct));
      clients[0].capabilities = new Map([['MOVE', true]]); // a server with MOVE: moves go to messageMove
      clients[0].messageMove = vi.fn().mockResolvedValue({ uidMap: new Map([[5, 50]]) });
      rejectedPassword(mgr, acct);
      await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
      expect(clients[0].messageMove).toHaveBeenCalledOnce();
      expect(clients).toHaveLength(1);
      evictPool(acct.id);
    });

    it('a waiter queued before the window opened does not log in when a slot frees, and gets the next released session', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const held = [];
      for (let i = 0; i < poolSizeFor(acct); i++) held.push(await acquirePooledClient(acct));
      let settled = null;
      const waiter = acquirePooledClient(acct).then(c => { settled = c; return c; }, e => { settled = e; return e; });
      rejectedPassword(mgr, acct);
      connectError = dovecotAuthFailure;
      held[0].close(); // the server closed one pooled session: its slot is not grown into
      await Promise.resolve();
      expect(settled).toBeNull();
      expect(clients).toHaveLength(poolSizeFor(acct));
      releasePooledClient(acct, held[1]);
      expect(await waiter).toBe(held[1]);
      expect(clients).toHaveLength(poolSizeFor(acct));
      for (const c of [held[1], ...held.slice(2)]) releasePooledClient(acct, c);
      evictPool(acct.id);
    });

    it('a background job does not queue behind a busy session while logins are held back', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      mgr.syncMessages = vi.fn().mockResolvedValue({});
      query.mockImplementation(async (sql) => ({ rows: sql.includes('lower(name) ~') ? [{ path: 'Junk' }] : [], rowCount: 1 }));
      const busy = await acquirePooledClient(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
      const poll = mgr._syncSpamFolder(acct);
      await new Promise(r => setImmediate(r));
      releasePooledClient(acct, busy);
      await poll;
      expect(mgr.syncMessages).not.toHaveBeenCalled();
      evictPool(acct.id);
    });

    describe('rule work held back does not wait for a busy session', () => {
      // Rules, the block list and a rule forward run inside the sync tick, bounded at 55 s;
      // a tick that overruns closes the live IDLE session. Two letters whose rule moves and marks
      // read each waited out the pool queue (15 s a move, 31 s a store) were enough.
      const settlesAtOnce = (p) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise(r => setTimeout(() => r('waited'), 200))]);
      const busyAndHeld = async () => {
        const acct = account();
        const mgr = liveManager(acct);
        connectError = null;
        const busy = await acquirePooledClient(acct); // an employee's action holds the only session
        rejectedPassword(mgr, acct);
        return { acct, mgr, busy };
      };

      it('a rule move fails at once, typed, without a login', async () => {
        const { acct, mgr, busy } = await busyAndHeld();
        const move = mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive', { failFastWhenHeld: true });
        expect(await settlesAtOnce(move)).toBe('settled');
        await expect(move).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(1);
        releasePooledClient(acct, busy);
        evictPool(acct.id);
      });

      it('a rule flag store fails at once, typed, without a login', async () => {
        const { acct, mgr, busy } = await busyAndHeld();
        const store = mgr.setFlag(acct, 7, 'Sent', '\\Seen', true, { failFastWhenHeld: true });
        expect(await settlesAtOnce(store)).toBe('settled');
        await expect(store).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(1);
        releasePooledClient(acct, busy);
        evictPool(acct.id);
      });

      it('a rule forward fails at once, typed, without a login', async () => {
        const { acct, mgr, busy } = await busyAndHeld();
        const fetch = mgr.fetchMessageBody(acct, 5, 'INBOX', { allowLogin: true, failFastWhenHeld: true });
        expect(await settlesAtOnce(fetch)).toBe('settled');
        await expect(fetch).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(1);
        releasePooledClient(acct, busy);
        evictPool(acct.id);
      });

      it('on a healthy mailbox a rule move waits for a busy pool as a user action does, past the 10 s background wait', async () => {
        // Nothing holds the account back: the rule keeps the interactive queue and its 15 s wait.
        // A rule move that gives up is skipped for good, so it must not lose that wait.
        const acct = account();
        const mgr = liveManager(acct);
        connectError = null;
        ImapFlow.mockImplementation(function () {
          const client = Object.assign(new EventEmitter(), {
            usable: true,
            connect: vi.fn().mockResolvedValue(),
            logout: vi.fn().mockResolvedValue(),
            getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
            status: vi.fn().mockResolvedValue({ uidNext: 51 }),
            capabilities: new Map([['MOVE', true]]), // a server with MOVE: moves go to messageMove
            messageMove: vi.fn().mockResolvedValue({ uidMap: new Map([[5, 50]]) }),
          });
          client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
          clients.push(client);
          return client;
        });
        const held = [];
        for (let i = 0; i < poolSizeFor(acct); i++) held.push(await acquirePooledClient(acct)); // all busy
        vi.useFakeTimers();
        let settled = false;
        let move;
        try {
          move = mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive', { failFastWhenHeld: true }).finally(() => { settled = true; });
          await vi.advanceTimersByTimeAsync(BACKGROUND_ACQUIRE_TIMEOUT_MS + 1000);
          expect(settled).toBe(false); // still queued, where a background caller would have given up
        } finally { vi.useRealTimers(); }
        releasePooledClient(acct, held[0]);
        expect(await move).toMatchObject({ succeeded: [5], failed: [] });
        expect(clients).toHaveLength(poolSizeFor(acct)); // no login: it used the released session
        for (const c of held) releasePooledClient(acct, c);
        evictPool(acct.id);
      });
    });

    it('a user flag store that waited out the queue does not wait a second time', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct);
      rejectedPassword(mgr, acct);
      vi.useFakeTimers();
      try {
        let settled = false;
        const store = mgr.setFlag(acct, 7, 'Sent', '\\Seen', true).finally(() => { settled = true; }).catch(e => e);
        await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
        expect(settled).toBe(true);
        expect(await store).toMatchObject({ poolExhausted: true });
      } finally { vi.useRealTimers(); }
      expect(clients).toHaveLength(1);
      releasePooledClient(acct, busy);
      evictPool(acct.id);
    });

    it('a user action waits for a busy open session while the password is rejected, without a login', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct); // another employee's action holds it
      rejectedPassword(mgr, acct);
      const waiting = acquirePooledClient(acct);
      releasePooledClient(acct, busy);
      expect(await waiting).toBe(busy);
      expect(clients).toHaveLength(1);
      releasePooledClient(acct, busy);
      evictPool(acct.id);
    });

    it('a waiter that may log in does not wait behind a held-back one for a free slot', async () => {
      // A refusal window (not a rejected password): a message click waits for a busy session with
      // noNewLogin, while a move behind it may log in, and the pool has room.
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
      const click = acquirePooledClient(acct, { noNewLogin: true });
      let secondSettled = false;
      const secondClick = acquirePooledClient(acct, { noNewLogin: true }).finally(() => { secondSettled = true; });
      const move = await acquirePooledClient(acct);
      expect(move).not.toBe(busy);
      expect(clients).toHaveLength(2); // one login, for the move only
      await new Promise(r => setImmediate(r));
      expect(secondSettled).toBe(false); // the other held-back click did not log in either
      releasePooledClient(acct, busy);
      expect(await click).toBe(busy); // the released session still goes to the head
      releasePooledClient(acct, move);
      expect(await secondClick).toBe(move);
      releasePooledClient(acct, busy);
      releasePooledClient(acct, move);
      evictPool(acct.id);
    });

    it('a held-back waiter keeps waiting while a session for the waiter behind it is still being opened', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 }); // a refusal window
      let finishConnect;
      ImapFlow.mockImplementation(function () {
        const client = Object.assign(new EventEmitter(), {
          usable: true,
          connect: vi.fn(() => new Promise(r => { finishConnect = r; })), // this login is slow
          logout: vi.fn().mockResolvedValue(),
        });
        client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
        clients.push(client);
        return client;
      });
      let clickErr = null;
      const click = acquirePooledClient(acct, { noNewLogin: true }).catch(e => { clickErr = e; return e; });
      const move = acquirePooledClient(acct); // grows the pool: its login is under way
      await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'));
      busy.close(); // the only open session goes away while that login runs
      await new Promise(r => setImmediate(r));
      expect(clickErr).toBeNull(); // not "busy" while a session is on its way
      finishConnect();
      const opened = await move;
      releasePooledClient(acct, opened);
      expect(await click).toBe(opened);
      releasePooledClient(acct, opened);
      evictPool(acct.id);
    });

    it('a waiting user action fails typed when the last open session closes', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct);
      rejectedPassword(mgr, acct);
      const waiting = acquirePooledClient(acct).catch(e => e);
      busy.close();
      expect(await waiting).toMatchObject({ providerRefusing: true });
      expect(clients).toHaveLength(1);
      evictPool(acct.id);
    });

    it('a user action that waits out the queue gets the usual busy answer', async () => {
      const acct = account();
      const mgr = liveManager(acct);
      connectError = null;
      const busy = await acquirePooledClient(acct);
      rejectedPassword(mgr, acct);
      vi.useFakeTimers();
      try {
        const waiting = acquirePooledClient(acct).catch(e => e);
        vi.advanceTimersByTime(ACQUIRE_TIMEOUT_MS);
        expect(await waiting).toMatchObject({ poolExhausted: true });
      } finally { vi.useRealTimers(); }
      expect(clients).toHaveLength(1);
      releasePooledClient(acct, busy);
      evictPool(acct.id);
    });

    it('an OAuth mailbox keeps the short ladder, and its user actions are not held back', async () => {
      // Gmail: fail2ban does not guard it, and a leftover rejection after a token refresh is routine.
      const acct = { ...account(), imap_host: 'imap.gmail.com', oauth_provider: 'google', oauth_access_token: 'enc' };
      const mgr = liveManager(acct);
      const first = await mgr.moveMessage(acct, 5, 'INBOX', 'Archive').catch(e => e);
      expect(first.providerRefusing).toBeUndefined();
      const perAttempt = clients.length; // connectImapClient retried once after a forced refresh
      expect(perAttempt).toBeGreaterThan(0);
      expect(mgr._secondaryCooldown.get(acct.id).failures).toBe(1);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);
      const second = await mgr.moveMessage(acct, 5, 'INBOX', 'Archive').catch(e => e);
      expect(second.providerRefusing).toBeUndefined();
      expect(clients).toHaveLength(2 * perAttempt);
    });

    describe('an OAuth mailbox while its account-wide auth ladder is armed', () => {
      // Its own login was rejected after a forced refresh. fail2ban does not guard Gmail, so the
      // pool holds back only background callers; a user's action still tries its login.
      const armedOAuth = () => {
        const acct = { ...account(), imap_host: 'imap.gmail.com', oauth_provider: 'google', oauth_access_token: 'enc' };
        const mgr = ladderManager();
        mgr._noteAuthFailure(acct);
        return { acct, mgr };
      };

      it('lets a user action log in', async () => {
        const { acct } = armedOAuth();
        const err = await acquirePooledClient(acct).catch(e => e);
        expect(err.providerRefusing).toBeUndefined();
        expect(clients.length).toBeGreaterThan(0);
      });

      it('holds a background caller back', async () => {
        const { acct } = armedOAuth();
        await expect(acquirePooledClient(acct, { background: true })).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(0);
      });

      it('a background caller queued before the ladder armed does not grow the pool when a slot frees', async () => {
        const acct = { ...account(), imap_host: 'imap.gmail.com', oauth_provider: 'google', oauth_access_token: 'enc' };
        const mgr = ladderManager();
        connectError = null;
        const held = [];
        for (let i = 0; i < poolSizeFor(acct); i++) held.push(await acquirePooledClient(acct)); // all busy
        const opened = clients.length;
        connectError = dovecotAuthFailure;
        let settled = false;
        const waiting = acquirePooledClient(acct, { background: true }).finally(() => { settled = true; }).catch(e => e);
        mgr._noteAuthFailure(acct); // the account's own login is rejected while it waits
        held[0].close(); // a slot frees while the other sessions stay open and busy
        await new Promise(r => setImmediate(r));
        expect(settled).toBe(false);
        expect(clients).toHaveLength(opened);
        const last = held[held.length - 1];
        releasePooledClient(acct, last);
        expect(await waiting).toBe(last);
        for (const c of held.slice(1)) releasePooledClient(acct, c);
        evictPool(acct.id);
      });

      it('a background caller fails at once while held back, even with an open busy session', async () => {
        const { acct } = armedOAuth();
        connectError = null;
        const busy = await acquirePooledClient(acct); // a user action on OAuth is not held back
        const opened = clients.length;
        await expect(acquirePooledClient(acct, { background: true })).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(opened);
        releasePooledClient(acct, busy);
        evictPool(acct.id);
      });

      it('holds a password mailbox back for a user action too', async () => {
        const acct = account();
        ladderManager()._noteAuthFailure(acct);
        await expect(acquirePooledClient(acct)).rejects.toMatchObject({ providerRefusing: true });
        expect(clients).toHaveLength(0);
      });
    });
  });
});

// A moved row waiting for its MOVE holds a negative placeholder uid (moveQueue.js). A background
// FETCH or STORE by that uid would be a BAD command that counts as a failure (and stops the body
// prefetch), so the background jobs that pick rows by uid leave such rows alone.
describe('background jobs skip rows whose move is pending', () => {
  beforeEach(() => { query.mockReset(); });
  const acct = { id: 'acct-bg', imap_host: 'imap.example.com', email_address: 'me@example.com' };

  it('folder body prefetch', async () => {
    query.mockImplementation(async (sql) => (sql.includes('FROM email_accounts') ? { rows: [acct] } : { rows: [] }));
    await ImapManager.prototype.prefetchFolderBodies.call({ _prefetchBodyRun: vi.fn() }, acct.id, ['m-1']);
    const pick = query.mock.calls.find(([sql]) => sql.includes('body_html IS NULL'))[0];
    expect(pick).toMatch(/AND uid > 0/);
  });

  it('bulk flag refresh', async () => {
    query.mockResolvedValue({ rows: [] });
    await ImapManager.prototype.refreshBulkFlags.call({}, acct);
    expect(query.mock.calls[0][0]).toMatch(/is_bulk IS NULL[\s\S]*AND uid > 0/);
  });
});

// ── CONDSTORE-less full sync splits cached UIDs from new ones (upstream #495) ─────────────
//
// A server without CONDSTORE never seeds a modseq baseline, so planModseqSync returns 'full' on
// EVERY tick. The full branch used to fetch full metadata and upsert the newest `limit` messages
// each time, rewriting unchanged rows forever (upstream measured ~3 row rewrites and 5.4 WAL
// fsyncs a second on an idle 12-account instance) and re-downloading the same metadata every
// tick. Now a cheap uid+flags pass splits the window: cached rows go through _applyFlagUpdates
// (writes only real flag changes, like the delta branch), and only unknown UIDs pay the full
// fetch and upsert.
//
// These drive the REAL syncMessages against a scripted client and a SQL-shape query dispatcher,
// so what is under test is the branch's wiring, not a helper.
describe('CONDSTORE-less full sync (upstream #495)', () => {
  const account = { id: 'acct-495', user_id: 'u1', imap_host: 'imap.example.com', email_address: 'a@example.com', name: 'A' };

  // serverMsgs: [{uid, seen}] visible in the mailbox. cachedUids: what the DB already has.
  // uidPhaseYields: what the `${maxKnownUid + 1}:*` fetch returns; per RFC 3501 a server echoes
  // its highest message even when n exceeds it.
  function arrange({ serverMsgs, cachedUids, maxKnownUid, storedValidity = '7', uidPhaseYields = [] }) {
    const calls = { upserts: [], fullFetches: [], cheapFetches: [], uidPhase: [], cachedSelects: [] };
    query.mockReset();
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT uid_validity, highest_modseq')) {
        return { rows: [{ uid_validity: storedValidity, highest_modseq: null }] };
      }
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: maxKnownUid }] };
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ n: 0 }] };
      if (sql.includes('AND uid = ANY')) {
        calls.cachedSelects.push(params[2]);
        return { rows: cachedUids.filter(u => params[2].includes(u)).map(u => ({ uid: u })) };
      }
      if (sql.includes('unnest($1::bigint[])')) return { rows: [], rowCount: 0 };
      if (sql.includes('ON CONFLICT (account_id, uid, folder)')) {
        calls.upserts.push(params[1]); // $2 = uid
        return { rows: [{ id: `row-${params[1]}`, is_new: true }] };
      }
      return { rows: [], rowCount: 0 };
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<m${msg.uid}@x>`, subject: 's', fromEmail: 'f@x', fromName: 'F',
      to: [], cc: [], replyTo: [], date: new Date('2026-09-01'), isRead: true, isStarred: false,
      flags: [], parsedHeaders: {},
    }));
    const flagsFor = seen => new Set(seen ? ['\\Seen'] : []);
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: serverMsgs.length, uidValidity: 7n, highestModseq: null },
      fetch: vi.fn(function (range, q, opts) {
        return (async function* () {
          if (opts?.uid && typeof range === 'string' && range.endsWith(':*')) {
            calls.uidPhase.push(range);
            for (const m of uidPhaseYields) yield { uid: m.uid, flags: flagsFor(m.seen) };
            return;
          }
          if (q?.envelope) {
            calls.fullFetches.push({ range, uid: !!opts?.uid });
            const wanted = opts?.uid
              ? String(range).split(',').map(Number)
              : serverMsgs.map(m => m.uid); // sequence range: the whole scripted window
            for (const m of serverMsgs.filter(m => wanted.includes(m.uid))) {
              yield { uid: m.uid, flags: flagsFor(m.seen) };
            }
            return;
          }
          calls.cheapFetches.push(range);
          for (const m of serverMsgs) yield { uid: m.uid, flags: flagsFor(m.seen) };
        })();
      }),
    };
    const mgr = new ImapManager({ clients: new Set() });
    mgr.backfillMessages = vi.fn().mockResolvedValue(); // post-UIDVALIDITY reindex is not under test
    vi.spyOn(mgr, 'broadcast').mockImplementation(() => {});
    const applied = vi.spyOn(mgr, '_applyFlagUpdates');
    return { mgr, client, calls, applied };
  }
  afterEach(() => { vi.restoreAllMocks(); });

  it('steady state: all UIDs cached — no metadata fetch, no upsert, flags via the bulk path', async () => {
    const serverMsgs = [{ uid: 10, seen: true }, { uid: 20, seen: true }, { uid: 30, seen: false }];
    const { mgr, client, calls, applied } = arrange({ serverMsgs, cachedUids: [10, 20, 30], maxKnownUid: 30 });

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(calls.cheapFetches).toEqual(['1:*']);          // one uid+flags pass over the window
    expect(calls.fullFetches).toEqual([]);                // not a full-metadata download per tick
    expect(calls.upserts).toEqual([]);                    // and no row rewrites
    expect(applied).toHaveBeenCalledTimes(1);             // flags ride the delta branch's bulk path,
    expect(applied.mock.calls[0][2].map(f => f.uid)).toEqual([10, 20, 30]); // which writes only changes
    expect(applied.mock.calls[0][2].find(f => f.uid === 30).isRead).toBe(false);
  });

  it('a hole in the window: only the unknown UID pays the full fetch and upsert', async () => {
    const serverMsgs = [{ uid: 10, seen: true }, { uid: 20, seen: true }, { uid: 30, seen: true }];
    const { mgr, client, calls, applied } = arrange({ serverMsgs, cachedUids: [10, 30], maxKnownUid: 30 });

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(calls.fullFetches).toEqual([{ range: '20', uid: true }]); // fetched BY UID, alone
    expect(calls.upserts).toEqual([20]);
    expect(applied.mock.calls[0][2].map(f => f.uid)).toEqual([10, 30]); // cached rows stay on flags
  });

  it('UIDVALIDITY change: every cached identity is void, so everything reprocesses in full', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const serverMsgs = [{ uid: 10, seen: true }, { uid: 20, seen: true }];
    const { mgr, client, calls } = arrange({
      serverMsgs, cachedUids: [10, 20], maxKnownUid: 20, storedValidity: '5', // server says 7
    });

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(calls.cachedSelects).toEqual([]);            // the split trusts (folder, uid) identity — unusable here
    expect(calls.fullFetches).toEqual([{ range: '1:*', uid: false }]);
    expect(calls.upserts).toEqual([10, 20]);
  });

  it('a cached flag change nudges readers, since the row rewrite that used to carry it is gone', async () => {
    const serverMsgs = [{ uid: 10, seen: false }];
    const { mgr, client, applied } = arrange({ serverMsgs, cachedUids: [10], maxKnownUid: 10 });
    applied.mockResolvedValue(1); // one row's flags genuinely changed

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'flags_synced', accountId: account.id });
  });

  it('a letter arriving in a move destination is not cached there, so the moved row still claims it', async () => {
    // DB-first moves: the moved row holds a negative placeholder uid until its MOVE settles, so
    // the letter's real uid is unknown to the cache and takes the full path to claimArrival.
    const serverMsgs = [{ uid: 10, seen: true }, { uid: 11, seen: true }];
    const { mgr, client, calls } = arrange({ serverMsgs, cachedUids: [10], maxKnownUid: 11 });
    const claim = vi.spyOn(mgr.moveQueue, 'claimArrival').mockResolvedValue(true);

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(claim).toHaveBeenCalledWith(account.id, 'Work', '<m11@x>', 11);
    expect(calls.upserts).toEqual([]);
  });

  it('the n:* echo of the newest message is skipped, not re-upserted every tick', async () => {
    // RFC 3501: `${maxKnownUid + 1}:*` still returns the highest message when nothing is above
    // the watermark. Upstream measured this echo as the whole residue after the split above:
    // one row rewrite per folder per tick, on every provider.
    const serverMsgs = [{ uid: 30, seen: true }];
    const { mgr, client, calls } = arrange({
      serverMsgs, cachedUids: [30], maxKnownUid: 30, uidPhaseYields: [{ uid: 30, seen: true }],
    });

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(calls.uidPhase).toEqual(['31:*']); // the phase ran and the server echoed uid 30
    expect(calls.upserts).toEqual([]);        // and the echo was filtered, not rewritten
  });

  it('genuinely new mail above the watermark still comes through the UID phase', async () => {
    // The companion boundary: a filter that also swallowed uid > maxKnownUid would silently
    // stop new mail on every account.
    const serverMsgs = [{ uid: 30, seen: true }, { uid: 31, seen: true }];
    const { mgr, client, calls } = arrange({
      serverMsgs, cachedUids: [30, 31], maxKnownUid: 30, uidPhaseYields: [{ uid: 31, seen: true }],
    });

    await mgr.syncMessages(account, client, 'Work', 20, false);

    expect(calls.upserts).toEqual([31]);
  });
});

// ── Secondary work over the pool (upstream #474 round 5) ────────────────────────────────
//
// Yahoo rate-limits the AUTHENTICATE command itself ("[LIMIT] AUTHENTICATE Rate limit hit.").
// Upstream measured refusals that never converged with the tab closed: the staleness probe (a
// fresh login every 3 minutes), the folder status monitor (a fresh login every minute, retried at
// the ladder cap) and pool grows. Pacing fresh logins cannot converge; not opening them can. On a
// secondaryOverPool provider the periodic work rides the account's one pooled session, and the
// pool grow, the one login left on that road, arms and clears the secondary backoff. Each test
// uses its own account id because the pool is module-level.
describe('secondary work over the pool on a provider that limits logins (upstream #474 round 5)', () => {
  let seq = 0;
  const yahooAcct = () => ({ id: `r5-yahoo-${++seq}`, user_id: 'u1', enabled: true, imap_host: 'imap.mail.yahoo.com', imap_tls: true, email_address: 'y@example.test', auth_user: 'y', auth_pass: 'enc' });
  const nodeAcct = () => ({ id: `r5-node-${++seq}`, user_id: 'u1', enabled: true, imap_host: 'mx.node.example', imap_tls: true, mail_node: true, email_address: 'n@example.test', auth_user: 'n', auth_pass: 'enc' });
  // Yahoo's refusal of the login itself, as imapflow reports it.
  const limitRefusal = () => Object.assign(new Error('Command failed'), {
    responseText: 'AUTHENTICATE Rate limit hit.', serverResponseCode: 'LIMIT', authenticationFailed: true,
  });
  const used = [];
  let clients;
  function arrange(acct, { connect } = {}) {
    used.push(acct.id);
    clients = [];
    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.usable = true;
      client.connect = vi.fn(connect || (() => Promise.resolve()));
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
      client.status = vi.fn(async () => ({ messages: 5, unseen: 0, uidNext: 10, uidValidity: 1 }));
      client.getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
      client.search = vi.fn().mockResolvedValue([]);
      client.fetch = vi.fn(async function* () {});
      clients.push(client);
      return client;
    });
    ImapFlow.mockClear();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockReset();
    query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [acct] : [] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return ladderManager();
  }
  // The staleness probe cycle of a fresh manager (its interval callback), with the other timers stopped.
  function arrangeProbe(acct, opts) {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = arrange(acct, opts);
    const cycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    interval.mockRestore();
    mgr.connections.set(acct.id, { close: vi.fn() });
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : sql.includes('FROM email_accounts') ? [acct] : [] }));
    return { mgr, cycle };
  }
  const seedPool = async acct => releasePooledClient(acct, await acquirePooledClient(acct));
  const armed = (mgr, acct, failures = 1) => mgr._secondaryCooldown.set(acct.id, { until: Date.now() + 60000, failures });
  afterEach(() => {
    for (const id of used.splice(0)) evictPool(id);
    vi.restoreAllMocks();
  });

  it('marks Yahoo alone as a provider whose periodic work rides the pool', () => {
    expect(providerProfile({ imap_host: 'imap.mail.yahoo.com' }).secondaryOverPool).toBe(true);
    for (const host of ['imap.gmail.com', 'mx.node.example', 'imap.purelymail.com', 'imap.mail.me.com', 'outlook.office365.com']) {
      expect(providerProfile({ imap_host: host }).secondaryOverPool).toBeUndefined();
    }
  });

  describe('folder status and integrity sync', () => {
    it('reuse ONE pooled session across cycles instead of a login per cycle, with no background connection', async () => {
      const acct = yahooAcct();
      const mgr = arrange(acct);
      vi.spyOn(mgr._bgConnSem, 'acquire');
      const seen = [];
      for (let i = 0; i < 3; i++) await mgr._withCountClient(acct, async c => { seen.push(c); });
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(new Set(seen).size).toBe(1);
      expect(seen[0].close).not.toHaveBeenCalled(); // still pooled, not torn down per cycle
      expect(mgr._bgConnSem.acquire).not.toHaveBeenCalled();
    });

    it('a reused session clears neither the secondary backoff nor a secondary auth window', async () => {
      // Only an ACCEPTED LOGIN says logins are welcome, or that the password works.
      const acct = yahooAcct();
      const mgr = arrange(acct);
      await seedPool(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() - 1, failures: 3 });
      mgr._secondaryAuthCooldown.set(acct.id, { until: Date.now() + 60000, failures: 1 });
      mgr._syncErrorState.set(acct.id, 'Authentication failed');
      await mgr._withCountClient(acct, async () => {});
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr._secondaryCooldown.get(acct.id)?.failures).toBe(3);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(true);
      expect(query.mock.calls.some(([sql]) => sql.includes('sync_error = NULL'))).toBe(false);
    });

    it('while a backoff holds logins back and no session is open, fail at once without a login', async () => {
      const acct = yahooAcct();
      const mgr = arrange(acct);
      armed(mgr, acct);
      await expect(mgr._withCountClient(acct, async () => 'counted')).rejects.toMatchObject({ providerRefusing: true });
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('while a backoff holds logins back, still run over an idle open session, and keep the backoff', async () => {
      // An established session is the one thing such a provider keeps serving, and using it is how
      // counts stay fresh through a backoff (and how the session stays warm).
      const acct = yahooAcct();
      const mgr = arrange(acct);
      await seedPool(acct);
      armed(mgr, acct);
      expect(await mgr._withCountClient(acct, async () => 'counted')).toBe('counted');
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr._secondaryCooldown.get(acct.id)?.failures).toBe(1);
    });

    it('queue as background work: a click waiting for the one session goes first', async () => {
      // Yahoo's pool is one session with no reserve for user actions (#103), so the status pass
      // must at least queue behind the reader's clicks rather than ahead of them.
      const acct = yahooAcct();
      const mgr = arrange(acct);
      const holder = await acquirePooledClient(acct, { background: true });
      const order = [];
      const cycle = mgr._withCountClient(acct, async () => { order.push('status'); });
      await new Promise(r => setImmediate(r));
      const click = acquirePooledClient(acct).then(c => { order.push('click'); releasePooledClient(acct, c); });
      await new Promise(r => setImmediate(r));
      releasePooledClient(acct, holder);
      await Promise.all([cycle, click]);
      expect(order).toEqual(['click', 'status']);
      expect(ImapFlow).toHaveBeenCalledTimes(1);
    });

    it('bound integrity syncs of all Yahoo accounts to the host budget, as the fresh login did', async () => {
      const acct = yahooAcct();
      const other = yahooAcct();
      const mgr = arrange(acct);
      vi.spyOn(mgr._bgConnSem, 'acquire');
      let finish;
      mgr._refreshObservedFolder = vi.fn(() => new Promise(resolve => { finish = resolve; }));
      const status = { messages: 1, unseen: 0, uidNext: 2, uidValidity: 1 };
      expect(mgr._queueObservedFolder(acct, 'INBOX', status)).toBe(true);
      expect(mgr._queueObservedFolder(other, 'INBOX', status)).toBe(false);
      await vi.waitFor(() => expect(mgr._refreshObservedFolder).toHaveBeenCalledOnce());
      finish(true);
      await vi.waitFor(() => expect(mgr._statusSyncRunning.size).toBe(0));
      expect(mgr._queueObservedFolder(other, 'INBOX', status)).toBe(true);
      expect(mgr._bgConnSem.acquire).not.toHaveBeenCalled();
    });
  });

  describe('the pool grow owns the secondary backoff', () => {
    it('a refused grow arms the secondary backoff, and the next periodic cycle opens no login', async () => {
      const acct = yahooAcct();
      const mgr = arrange(acct, { connect: () => Promise.reject(limitRefusal()) });
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toBeTruthy();
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr._secondaryCooldown.get(acct.id)?.failures).toBe(1);
      expect(mgr._connectCooldown.has(acct.id)).toBe(false);       // never the live-sync ladder
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false); // a refusal is no rejected password
      await expect(mgr._withCountClient(acct, async () => {})).rejects.toMatchObject({ providerRefusing: true });
      expect(ImapFlow).toHaveBeenCalledTimes(1);
    });

    it('an accepted grow clears the secondary backoff', async () => {
      const acct = yahooAcct();
      const mgr = arrange(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() - 1, failures: 4 });
      await seedPool(acct);
      expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
    });

    it('a session the server drops while the accepted grow clears the backoffs is never handed out again', async () => {
      // The clears end in a database UPDATE (the account error). The new client gets its close
      // handler and its pool slot before that write, not after: a socket the server dropped in
      // the meantime would otherwise be pooled dead and served to the next caller.
      const acct = yahooAcct();
      const mgr = arrange(acct);
      mgr.connections.set(acct.id, { close: vi.fn() });
      mgr._secondaryAuthCooldown.set(acct.id, { until: Date.now() - 1, failures: 1 });
      mgr._syncErrorState.set(acct.id, 'Authentication failed');
      let reached;
      const atUpdate = new Promise(resolve => { reached = resolve; });
      let finishUpdate;
      const update = new Promise(resolve => { finishUpdate = resolve; });
      query.mockImplementation(async sql => {
        if (sql.includes('sync_error = NULL')) { reached(); await update; return { rows: [], rowCount: 1 }; }
        return { rows: sql.includes('FROM email_accounts') ? [acct] : [] };
      });

      const grow = acquirePooledClient(acct, { background: true });
      await atUpdate;       // accepted login; the error UPDATE is in flight
      clients[0].close();   // the server drops the new session right then
      finishUpdate();
      const first = await grow;
      releasePooledClient(acct, first);

      const next = await acquirePooledClient(acct);
      expect(next).not.toBe(first);
      expect(next.usable).toBe(true);
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      releasePooledClient(acct, next);
    });

    it('an accepted grow ends a lapsed secondary auth window and the error it recorded', async () => {
      // The status monitor's fresh login used to be what cleared these. On the pool it no longer
      // logs in, so without the grow a mailbox rejected once would stay red until a reconnect.
      const acct = yahooAcct();
      const mgr = arrange(acct);
      mgr.connections.set(acct.id, { close: vi.fn() });
      mgr._secondaryAuthCooldown.set(acct.id, { until: Date.now() - 1, failures: 2 });
      mgr._syncErrorState.set(acct.id, 'Authentication failed');
      await mgr._withCountClient(acct, async () => {});
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('sync_error = NULL'))).toBe(true);
      expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id });
    });

    it('leaves a mail node mailbox as it was: its grows neither arm nor clear the secondary backoff', async () => {
      const acct = nodeAcct();
      const mgr = arrange(acct);
      mgr._secondaryCooldown.set(acct.id, { until: Date.now() - 1, failures: 3 });
      await seedPool(acct);
      expect(mgr._secondaryCooldown.get(acct.id)?.failures).toBe(3);

      const refused = nodeAcct();
      const mgr2 = arrange(refused, { connect: () => Promise.reject(limitRefusal()) });
      await expect(acquirePooledClient(refused)).rejects.toBeTruthy();
      expect(mgr2._secondaryCooldown.has(refused.id)).toBe(false);
    });

    it('keeps a mail node mailbox on its fresh status login and background connection', async () => {
      const acct = nodeAcct();
      const mgr = arrange(acct);
      vi.spyOn(mgr._bgConnSem, 'acquire');
      for (let i = 0; i < 2; i++) await mgr._withCountClient(acct, async () => {});
      expect(ImapFlow).toHaveBeenCalledTimes(2);
      expect(mgr._bgConnSem.acquire).toHaveBeenCalledTimes(2);
    });
  });

  describe('the staleness probe', () => {
    it('probes over the pooled session: no fresh login', async () => {
      const acct = yahooAcct();
      const { cycle } = arrangeProbe(acct);
      await seedPool(acct);
      await cycle();
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(clients[0].search).toHaveBeenCalledWith({ uid: '101:*' }, { uid: true });
      expect(clients[0].close).not.toHaveBeenCalled(); // and left the session pooled
    });

    it('skips the cycle quietly while a backoff holds logins back and no session is open', async () => {
      const acct = yahooAcct();
      const { mgr, cycle } = arrangeProbe(acct);
      armed(mgr, acct);
      await cycle();
      expect(ImapFlow).not.toHaveBeenCalled();
      expect(console.warn.mock.calls.some(([m]) => String(m).includes('Staleness check error'))).toBe(false);
    });

    it('skips quietly while held back when the one session is busy or dead', async () => {
      // Only an idle, usable session can serve a job held back from logging in: a busy one would
      // only answer providerRefusing, and a dead one would fail its first command.
      const acct = yahooAcct();
      const { mgr, cycle } = arrangeProbe(acct);
      const held = await acquirePooledClient(acct);
      armed(mgr, acct);
      await cycle();
      expect(held.search).not.toHaveBeenCalled();
      releasePooledClient(acct, held);
      held.usable = false; // the socket died without a close event
      await cycle();
      expect(held.search).not.toHaveBeenCalled();
      expect(console.warn.mock.calls.some(([m]) => String(m).includes('Staleness check error'))).toBe(false);
      expect(ImapFlow).toHaveBeenCalledTimes(1);
    });

    it('still probes over an idle open session while a backoff holds logins back', async () => {
      const acct = yahooAcct();
      const { mgr, cycle } = arrangeProbe(acct);
      await seedPool(acct);
      armed(mgr, acct, 2);
      await cycle();
      expect(ImapFlow).toHaveBeenCalledTimes(1);
      expect(clients[0].search).toHaveBeenCalled();
      expect(mgr._secondaryCooldown.get(acct.id)?.failures).toBe(2);
    });

    it('an error on a reused session arms nothing: the grow owns the backoff', async () => {
      // "Connection not available" is imapflow's word for a socket the server dropped. On a fresh
      // login it reads like a refusal; on a session reused from the pool it says nothing about logins.
      const acct = yahooAcct();
      const { mgr, cycle } = arrangeProbe(acct);
      await seedPool(acct);
      clients[0].getMailboxLock.mockRejectedValue(new Error('Connection not available'));
      await cycle();
      expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
      expect(clients[0].close).toHaveBeenCalled(); // the failed session left the pool
    });
  });

  describe('the one shared session is never handed on with a command still running', () => {
    // Upstream's review of round 5: on Yahoo the pooled session is the account's only one, so a
    // periodic job that abandons a command (a timeout does not cancel it) must close the session
    // rather than return it idle; otherwise a click or the next job queues behind a command nobody
    // waits on. Here the pool's own invariant does it (withFreshClient evicts and closes a session
    // whose job failed or timed out), and the deferred integrity scan throws instead of returning.
    it('a timed-out pooled probe closes the session, and the pool opens a new one next time', async () => {
      vi.useFakeTimers();
      try {
        const acct = yahooAcct();
        const { cycle } = arrangeProbe(acct);
        await seedPool(acct);
        const pooled = clients[0];
        pooled.getMailboxLock = vi.fn(() => new Promise(() => {})); // SELECT hangs for good
        const run = cycle();
        await vi.advanceTimersByTimeAsync(25000); // the probe's deadline
        await run;
        expect(pooled.close).toHaveBeenCalled();
        const next = await acquirePooledClient(acct);
        expect(next).not.toBe(pooled);
        expect(ImapFlow).toHaveBeenCalledTimes(2);
        releasePooledClient(acct, next);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('a deferred integrity flag scan closes the pooled session and issues no SEARCH behind it', async () => {
      vi.useFakeTimers();
      try {
        const acct = yahooAcct();
        const mgr = arrange(acct);
        mgr.syncMessages = vi.fn().mockResolvedValue({});
        query.mockImplementation(async sql => {
          if (sql.includes('FROM email_accounts')) return { rows: [acct] };
          if (sql.includes('status_synced_modseq FROM folders')) return { rows: [{ status_synced_modseq: '5' }] };
          return { rows: [] };
        });
        const search = vi.fn(async () => [1, 2, 3]);
        ImapFlow.mockImplementation(function () {
          const client = Object.assign(new EventEmitter(), {
            usable: true,
            connect: vi.fn().mockResolvedValue(),
            logout: vi.fn().mockResolvedValue(),
            mailbox: { exists: 3, uidValidity: 8n, highestModseq: 9n, uidNext: 10 },
            capabilities: new Map([['CONDSTORE', true]]),
            getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
            search,
            // Hangs forever; the unreachable yield only satisfies require-yield.
            fetch: async function* () { await new Promise(() => {}); yield null; },
          });
          client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
          clients.push(client);
          return client;
        });
        const pass = expect(mgr._refreshObservedFolder(acct, 'INBOX', { uidValidity: 8n, uidNext: 10, highestModseq: 9n }))
          .rejects.toThrow(/deferred/);
        await vi.advanceTimersByTimeAsync(25000);
        await pass;
        expect(clients).toHaveLength(1);
        expect(clients[0].close).toHaveBeenCalled();
        expect(search).not.toHaveBeenCalled();
        const next = await acquirePooledClient(acct);
        expect(next).not.toBe(clients[0]); // the pool healed with a new session
        releasePooledClient(acct, next);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it('reconcile skips the cycle quietly while held back with no open session; a node mailbox runs as before', async () => {
    const acct = yahooAcct();
    const mgr = arrange(acct);
    armed(mgr, acct);
    query.mockClear();
    await mgr.reconcileDeletes(acct);
    expect(query).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();

    // With an idle open session it reconciles over it, still without a login.
    mgr._secondaryCooldown.delete(acct.id);
    await seedPool(acct);
    armed(mgr, acct);
    query.mockImplementation(async sql => ({ rows: sql.includes('SELECT DISTINCT m.folder') ? [{ folder: 'INBOX' }] : [] }));
    await mgr.reconcileDeletes(acct);
    expect(clients[0].search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(ImapFlow).toHaveBeenCalledTimes(1);

    const node = nodeAcct();
    const nodeMgr = arrange(node);
    armed(nodeMgr, node);
    query.mockClear();
    await nodeMgr.reconcileDeletes(node);
    expect(query).toHaveBeenCalled(); // reads its folders and gets providerRefusing from the pool
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('the spam poll skips the cycle quietly while held back with no open session; a node mailbox runs as before', async () => {
    // Upstream's reporter counted this one line as a Yahoo refusal: the pool's typed fail-fast
    // costs no login, but it was logged as a failed spam sync every cycle.
    const acct = yahooAcct();
    const mgr = arrange(acct);
    mgr.syncMessages = vi.fn(async () => ({}));
    armed(mgr, acct);
    query.mockClear();
    await mgr._syncSpamFolder(acct);
    expect(query).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(console.warn.mock.calls.some(([m]) => String(m).includes('Periodic spam sync failed'))).toBe(false);

    // With an idle open session it polls over it, still without a login.
    mgr._secondaryCooldown.delete(acct.id);
    await seedPool(acct);
    armed(mgr, acct);
    query.mockImplementation(async sql => ({ rows: sql.includes('lower(name) ~') ? [{ path: 'Junk' }] : [] }));
    await mgr._syncSpamFolder(acct);
    expect(mgr.syncMessages).toHaveBeenCalledWith(acct, clients[0], 'Junk', 50, false, true);
    expect(ImapFlow).toHaveBeenCalledTimes(1);

    const node = nodeAcct();
    const nodeMgr = arrange(node);
    nodeMgr.syncMessages = vi.fn(async () => ({}));
    armed(nodeMgr, node);
    query.mockImplementation(async sql => ({ rows: sql.includes('lower(name) ~') ? [{ path: 'Junk' }] : [] }));
    await nodeMgr._syncSpamFolder(node);
    expect(ImapFlow).not.toHaveBeenCalled();
    // As before: it asks the pool and logs the refusal it gets.
    expect(console.warn.mock.calls.some(([m]) => String(m).includes('Periodic spam sync failed'))).toBe(true);
  });

  it('refusals converge: after one accepted login the periodic work opens none', async () => {
    // Two simulated hours of every periodic job on a Yahoo mailbox: the folder status monitor every
    // minute, the staleness probe every 3, delete reconcile every 10, the spam poll every 30. The
    // server refuses every login for the first 20 minutes, then refuses a login only when 3 landed
    // in the last 10 minutes (a login-rate limit). Refusals are paid once per backoff window, then
    // one login is accepted, and from there on the work reuses that session: no login at all.
    vi.useFakeTimers();
    try {
      const acct = yahooAcct();
      const start = Date.now();
      const attempts = []; // { at, ok }
      const connect = () => {
        const now = Date.now();
        const recent = attempts.filter(a => now - a.at < 10 * 60000).length;
        const ok = now - start >= 20 * 60000 && recent < 3;
        attempts.push({ at: now, ok });
        return ok ? Promise.resolve() : Promise.reject(limitRefusal());
      };
      const { mgr, cycle } = arrangeProbe(acct, { connect });
      mgr.folderStatusMonitor.enqueueSync = () => false; // counts only, no integrity pass
      mgr.syncMessages = vi.fn(async () => ({}));
      let revision = 0;
      query.mockImplementation(async sql => {
        if (sql.includes('FROM email_accounts')) return { rows: [acct] };
        if (sql.includes('MAX(uid)')) return { rows: [{ maxuid: 100 }] };
        if (sql.includes('SELECT f.*')) return { rows: [{ path: 'INBOX' }] };
        if (sql.includes('nextval')) return { rows: [{ revision: String(++revision), started_at: new Date() }] };
        if (sql.includes('RETURNING id')) return { rows: [{ id: 1 }] };
        if (sql.includes('SELECT DISTINCT m.folder')) return { rows: [{ folder: 'INBOX' }] };
        if (sql.includes('lower(name) ~')) return { rows: [{ path: 'Junk' }] };
        return { rows: [] };
      });

      for (let minute = 1; minute <= 120; minute++) {
        await vi.advanceTimersByTimeAsync(60000);
        await mgr.folderStatusMonitor.refresh(acct);
        if (minute % 3 === 0) await cycle();
        if (minute % 10 === 0) await mgr.reconcileDeletes(acct);
        if (minute % 30 === 0) await mgr._syncSpamFolder(acct);
      }

      const refused = attempts.filter(a => !a.ok);
      const accepted = attempts.filter(a => a.ok);      // One refusal per backoff window during the refusing stretch (30 s doubling to 15 min),
      // not one per job per cycle, and a single accepted login after it.
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.length).toBeLessThanOrEqual(8);
      expect(accepted).toHaveLength(1);
      // The second hour: no login at all, so nothing for the provider to refuse.
      expect(attempts.filter(a => a.at - start >= 60 * 60000)).toHaveLength(0);
      expect(ImapFlow).toHaveBeenCalledTimes(attempts.length);
      // And the work still ran: counts were read and the probe asked the server every cycle.
      expect(clients.at(-1).status.mock.calls.length).toBeGreaterThan(60);
      expect(clients.at(-1).search.mock.calls.length).toBeGreaterThan(20);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
