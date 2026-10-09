import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async (account) => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'redacted') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./threading/providerIdBackfill.js', () => ({ runProviderIdBackfill: vi.fn() }));
vi.mock('./threading/providerIdBackfillStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordProviderIdBackfillError: vi.fn(async () => {}),
}));

import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';
import { runProviderIdBackfill } from './threading/providerIdBackfill.js';
import { recordProviderIdBackfillError } from './threading/providerIdBackfillStore.js';
import { ImapManager } from './imapManager.js';

const TIMERS = ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer'];
function newManager() {
  const mgr = new ImapManager(null);
  for (const key of TIMERS) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const gmail = {
  id: 'g1', user_id: 'u1', enabled: true, protocol: 'imap', email_address: 'box@gmail.com',
  imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: true, oauth_reconnect_required: false,
};
const other = { ...gmail, id: 'o1', email_address: 'box@example.com', imap_host: 'imap.example.com' };

let backfillRows;
let gmailRow; // what email_accounts holds for the Gmail mailbox; tests change it mid-run
let imapClients; // every ImapFlow the manager created
let connectError; // when set, ImapFlow.connect rejects with it
beforeEach(() => {
  backfillRows = [];
  gmailRow = gmail;
  imapClients = [];
  connectError = null;
  query.mockReset();
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM provider_id_backfill/.test(sql)) return { rows: backfillRows };
    if (/FROM email_accounts WHERE id = \$1/.test(sql)) return { rows: [params[0] === gmail.id ? gmailRow : other] };
    return { rows: [] };
  });
  runProviderIdBackfill.mockReset();
  recordProviderIdBackfillError.mockClear();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  ImapFlow.mockReset();
  ImapFlow.mockImplementation(function () {
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => { if (connectError) throw connectError; }),
      close: vi.fn(),
      logout: vi.fn(async () => {}),
    });
    imapClients.push(client);
    return client;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const HOST = 'imap.gmail.com';

const broadcasts = (mgr) => mgr.broadcast.mock.calls.map(c => c[0]).filter(e => e.type === 'provider_ids_backfill');

describe('startProviderIdBackfill', () => {
  it('does nothing for a mailbox that is not on Gmail', async () => {
    await newManager().startProviderIdBackfill(other);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('leaves the start to a running full backfill', async () => {
    const mgr = newManager();
    mgr.backfillAllRunning.add(gmail.id);
    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('does not start while a background backoff holds the mailbox back', async () => {
    // The entry gate, ahead of the run's own shouldContinue: no plan query, no running state.
    const mgr = newManager();
    mgr._secondaryCooldown.set(gmail.id, { until: Date.now() + 60000, failures: 1 });
    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).not.toHaveBeenCalled();
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
  });

  it('marks the mailbox clean after a complete run and skips it next time', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 3, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    await mgr.startProviderIdBackfill(gmail);
    await new Promise(resolve => setImmediate(resolve)); // the final state broadcast is not awaited
    expect(runProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(runProviderIdBackfill.mock.calls[0][0]).toMatchObject({ query, accountId: gmail.id });
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(true);
    expect(broadcasts(mgr).at(-1)).toMatchObject({ accountId: gmail.id, state: { status: 'not_started' } });
  });

  it('keeps a stopped run eligible for the scheduler', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'stopped', processed: 0, total: 3 });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('does not mark the mailbox clean when a local write happened during the run', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async () => {
      mgr._scheduleProviderIdBackfill(gmail);
      return { outcome: 'done', processed: 1, total: 1 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('broadcasts progress while running', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async ({ onProgress }) => {
      onProgress({ processed: 1, total: 4 });
      await new Promise(resolve => setImmediate(resolve));
      return { outcome: 'done', processed: 4, total: 4 };
    });
    await mgr.startProviderIdBackfill(gmail);
    expect(broadcasts(mgr)).toContainEqual({
      type: 'provider_ids_backfill', accountId: gmail.id, state: { status: 'running', percent: 25, error: null },
    });
  });

  it('takes no background connection when the run never needs IMAP', async () => {
    const mgr = newManager();
    const acquire = vi.spyOn(mgr._bgConnSem, 'acquire');
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0 });
    await mgr.startProviderIdBackfill(gmail);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('records the failure and frees the mailbox', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockRejectedValue(new Error('Connection closed'));
    await mgr.startProviderIdBackfill(gmail);
    expect(recordProviderIdBackfillError).toHaveBeenCalledWith(query, gmail.id, expect.stringContaining('Connection closed'));
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('does not hand the runner a thread mode: the runner re-reads it per batch, so a rollback to rfc mid-run is seen', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0, failedFolders: [], skippedFolders: [] });
    await mgr.startProviderIdBackfill({ ...gmail, thread_mode: 'gmail' });
    expect(runProviderIdBackfill.mock.calls[0][0].threadMode).toBeUndefined();
  });
});

describe('startProviderIdBackfill connection handling', () => {
  it('frees the background slot, records the error and backs off when the connection fails', async () => {
    const mgr = newManager();
    connectError = new Error('Socket closed unexpectedly');
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });
    const before = Date.now();

    await mgr.startProviderIdBackfill(gmail);

    expect(imapClients).toHaveLength(1);
    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
    expect(recordProviderIdBackfillError).toHaveBeenCalledWith(query, gmail.id, expect.stringContaining('Socket closed unexpectedly'));
    const backoff = mgr.providerIdBackoff.get(gmail.id);
    expect(backoff.failures).toBe(1);
    expect(backoff.until).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
  });

  it('closes the client once and frees the slot when the run fails after connecting', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => {
      await getClient();
      expect(mgr._bgConnSem.activeCount(HOST)).toBe(1);
      throw new Error('Database went away');
    });

    await mgr.startProviderIdBackfill(gmail);

    expect(imapClients).toHaveLength(1);
    expect(imapClients[0].close).toHaveBeenCalledTimes(1);
    expect(imapClients[0].logout).not.toHaveBeenCalled();
    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
  });

  it('frees the slot without recording an error when the mailbox was disabled before connecting', async () => {
    const mgr = newManager();
    gmailRow = { ...gmail, enabled: false };
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });

    await mgr.startProviderIdBackfill(gmail);

    expect(imapClients).toHaveLength(0);
    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
    expect(recordProviderIdBackfillError).not.toHaveBeenCalled();
    expect(mgr.providerIdBackoff.has(gmail.id)).toBe(false);
  });

  it('arms the auth cooldown when the server rejects the credentials', async () => {
    const mgr = newManager();
    const noteAuth = vi.spyOn(mgr, '_noteAuthFailure');
    const noteRefusal = vi.spyOn(mgr, '_noteConnectionRefusal');
    connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });

    await mgr.startProviderIdBackfill(gmail);

    expect(noteAuth).toHaveBeenCalledWith(gmail);
    expect(noteRefusal).not.toHaveBeenCalled();
    expect(recordProviderIdBackfillError).toHaveBeenCalled();
  });

  it('arms the secondary backoff, not the live-sync cooldown, when the server refuses the connection', async () => {
    // A background login: its refusal must not pause the sync tick of the mailbox.
    const mgr = newManager();
    const noteAuth = vi.spyOn(mgr, '_noteAuthFailure');
    const noteSecondary = vi.spyOn(mgr, '_noteSecondaryRefusal');
    connectError = new Error('Too many simultaneous connections');
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });

    await mgr.startProviderIdBackfill(gmail);

    expect(noteSecondary).toHaveBeenCalledWith(gmail);
    expect(mgr._connectCooldown.has(gmail.id)).toBe(false);
    expect(noteAuth).not.toHaveBeenCalled();
  });

  it('keeps a rejected login off the account-wide ladder while the persistent connection is up', async () => {
    // One transient AUTHENTICATIONFAILED after a token refresh must not stop the sync tick.
    const mgr = newManager();
    mgr.connections.set(gmail.id, { close: vi.fn() });
    connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });

    await mgr.startProviderIdBackfill(gmail);

    expect(mgr._connectCooldown.has(gmail.id)).toBe(false);
    expect(mgr._secondaryAuthCooldown.has(gmail.id)).toBe(true);
  });

  // Row 11 of the login-path walk in imapManager.test.js ('every login path under a rejected
  // password'), which cannot mock the runner module.
  it('costs at most one rejected login per auth window', async () => {
    const mgr = newManager();
    mgr.connections.set(gmail.id, { close: vi.fn() });
    connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    runProviderIdBackfill.mockImplementation(async ({ getClient }) => { await getClient(); });
    await mgr.startProviderIdBackfill(gmail);
    expect(imapClients).toHaveLength(1);
    expect(mgr._authLoginBlocked(gmail.id)).toBeTruthy();
    mgr.providerIdBackoff.clear(); // only the auth window holds it back now
    await mgr.startProviderIdBackfill(gmail);
    expect(imapClients).toHaveLength(1);
    mgr._secondaryAuthCooldown.get(gmail.id).until = 0; // the window ran out
    mgr.providerIdBackoff.clear();
    await mgr.startProviderIdBackfill(gmail);
    expect(imapClients).toHaveLength(2);
    expect(mgr._authLoginBlocked(gmail.id)).toBeTruthy();
  });
});

describe('startProviderIdBackfill shouldContinue', () => {
  async function continueAnswers(mgr, during = () => {}) {
    let answer;
    runProviderIdBackfill.mockImplementation(async ({ shouldContinue }) => {
      during();
      answer = await shouldContinue();
      return { outcome: 'stopped', processed: 0, total: 1, failedFolders: [], skippedFolders: [] };
    });
    await mgr.startProviderIdBackfill(gmail);
    return answer;
  }

  it('continues for an enabled mailbox', async () => {
    expect(await continueAnswers(newManager())).toBe(true);
  });

  it('stops for a disabled mailbox', async () => {
    expect(await continueAnswers(newManager(), () => { gmailRow = { ...gmail, enabled: false }; })).toBe(false);
  });

  it('stops for a mailbox that needs an OAuth reconnect', async () => {
    expect(await continueAnswers(newManager(), () => { gmailRow = { ...gmail, oauth_reconnect_required: true }; })).toBe(false);
  });

  it('stops while a full backfill of the mailbox runs', async () => {
    const mgr = newManager();
    expect(await continueAnswers(mgr, () => { mgr.backfillAllRunning.add(gmail.id); })).toBe(false);
  });
});

describe('startProviderIdBackfill backoff and outcomes', () => {
  it('does not start again until the backoff ends, and a complete run clears it', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockRejectedValueOnce(new Error('Database went away'));
    await mgr.startProviderIdBackfill(gmail);
    const { until } = mgr.providerIdBackoff.get(gmail.id);

    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(until + 1);
    runProviderIdBackfill.mockResolvedValueOnce({ outcome: 'done', processed: 1, total: 1, failedFolders: [], skippedFolders: [] });
    await mgr.startProviderIdBackfill(gmail);
    expect(runProviderIdBackfill).toHaveBeenCalledTimes(2);
    expect(mgr.providerIdBackoff.has(gmail.id)).toBe(false);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(true);
  });

  it('doubles the delay on each failure up to two hours', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockRejectedValue(new Error('Database went away'));
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const delays = [];
    for (let i = 0; i < 6; i++) {
      await mgr.startProviderIdBackfill(gmail);
      const { until } = mgr.providerIdBackoff.get(gmail.id);
      delays.push((until - now) / 60000);
      now = until + 1;
    }
    expect(delays).toEqual([10, 20, 40, 80, 120, 120]);
  });

  it('records the failed folders of an incomplete run and backs off without marking the mailbox clean', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({
      outcome: 'incomplete', processed: 1, total: 3,
      failedFolders: [{ path: 'INBOX', error: 'Mailbox does not exist' }, { path: 'Label', error: 'Command failed' }],
      skippedFolders: [],
    });

    await mgr.startProviderIdBackfill(gmail);

    expect(recordProviderIdBackfillError).toHaveBeenCalledWith(query, gmail.id, 'INBOX: Mailbox does not exist; Label: Command failed');
    expect(mgr.providerIdBackoff.get(gmail.id).failures).toBe(1);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('records no error when an incomplete run only skipped renumbered folders', async () => {
    const mgr = newManager();
    runProviderIdBackfill.mockResolvedValue({ outcome: 'incomplete', processed: 0, total: 1, failedFolders: [], skippedFolders: ['INBOX'] });

    await mgr.startProviderIdBackfill(gmail);

    expect(recordProviderIdBackfillError).not.toHaveBeenCalled();
    expect(mgr.providerIdBackoff.get(gmail.id).failures).toBe(1);
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
  });

  it('the scheduler leaves a mailbox in backoff alone', async () => {
    const mgr = newManager();
    mgr.connections.set(gmail.id, {});
    mgr.providerIdBackoff.set(gmail.id, { failures: 1, until: Date.now() + 60 * 1000 });
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr._nudgeProviderIdBackfills();
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
  });
});

describe('Gmail id backfill pending mark', () => {
  it('a finished mailbox without a pending write is marked clean without planning', async () => {
    const mgr = newManager();
    backfillRows = [{ account_id: gmail.id, cursors: {}, finished_at: new Date(), error: null, pending_since: null }];

    await mgr.startProviderIdBackfill(gmail);

    expect(runProviderIdBackfill).not.toHaveBeenCalled();
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(true);
    expect(mgr.providerIdBackfillRunning.has(gmail.id)).toBe(false);
  });

  it.each([
    ['a pending write', { finished_at: new Date(), error: null, pending_since: new Date() }],
    ['an error', { finished_at: new Date(), error: 'Command failed', pending_since: null }],
    ['no finished run', { finished_at: null, error: null, pending_since: null }],
  ])('a mailbox with %s is planned', async (_label, row) => {
    const mgr = newManager();
    backfillRows = [{ account_id: gmail.id, cursors: {}, ...row }];
    runProviderIdBackfill.mockResolvedValue({ outcome: 'done', processed: 0, total: 0, failedFolders: [], skippedFolders: [] });

    await mgr.startProviderIdBackfill(gmail);

    expect(runProviderIdBackfill).toHaveBeenCalledTimes(1);
  });

  it('a local write stores the pending mark', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr._scheduleProviderIdBackfill(gmail);
    const pending = query.mock.calls.filter(([sql]) => /SET pending_since = EXCLUDED\.pending_since/.test(sql));
    expect(pending).toHaveLength(1);
    expect(pending[0][1]).toEqual([gmail.id]);
  });

  it('a local write on another provider stores nothing', async () => {
    vi.useFakeTimers();
    newManager()._scheduleProviderIdBackfill(other);
    expect(query).not.toHaveBeenCalled();
  });

  it('a label copy on a UIDPLUS server schedules the id backfill for the new row', async () => {
    const mgr = newManager();
    const copied = { ...gmail, id: 'g-copy' }; // own id: the IMAP pool is module state
    query.mockImplementation(async (sql) => {
      if (/FROM email_accounts WHERE id = \$1/.test(sql)) return { rows: [copied] };
      if (/INSERT INTO messages/.test(sql)) return { rows: [{ id: 'm2', is_read: true }] };
      return { rows: [] };
    });
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn(async () => {}),
        close: vi.fn(),
        logout: vi.fn(async () => {}),
        usable: true,
        getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
        messageCopy: vi.fn(async () => ({ uidMap: new Map([[5, 901]]) })),
      });
      imapClients.push(client);
      return client;
    });
    const schedule = vi.spyOn(mgr, '_scheduleProviderIdBackfill').mockImplementation(() => {});

    expect(await mgr.copyMessage(copied.id, 5, 'INBOX', 'Label')).toBe(901);

    expect(schedule).toHaveBeenCalledWith(copied);
  });
});

describe('providerIdBackfillStates', () => {
  it('returns a state for Gmail mailboxes only', async () => {
    const mgr = newManager();
    backfillRows = [{ account_id: gmail.id, cursors: {}, finished_at: '2026-09-17T10:00:00Z', error: null }];
    const states = await mgr.providerIdBackfillStates([gmail, other]);
    expect([...states.entries()]).toEqual([[gmail.id, { status: 'done', percent: 100, error: null }]]);
  });

  it('does not query the database when no mailbox is on Gmail', async () => {
    const mgr = newManager();
    expect((await mgr.providerIdBackfillStates([other])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Gmail id backfill triggers', () => {
  it('a local Sent copy starts a run a minute later', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.providerIdBackfillClean.add(gmail.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertSentMessageRecord(gmail, '[Gmail]/Sent Mail', 12, { subject: 'Hello' });
    expect(mgr.providerIdBackfillClean.has(gmail.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('persists reply draft headers in the existing message columns', async () => {
    const mgr = newManager();
    await mgr.upsertDraftMessageRecord(other, 'Drafts', 5, {
      inReplyTo: '<parent@example.com>', references: '<root@example.com> <parent@example.com>',
    });
    const [sql, params] = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO messages'));
    expect(sql).toContain('thread_references');
    expect(params).toContain('<parent@example.com>');
    expect(params).toContain('<root@example.com> <parent@example.com>');
  });

  it('a local draft on another provider starts nothing', async () => {
    vi.useFakeTimers();
    const mgr = newManager();
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.upsertDraftMessageRecord(other, 'Drafts', 5, { subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
  });

  it('the scheduler starts connected mailboxes that are not clean', async () => {
    const mgr = newManager();
    mgr.connections.set(gmail.id, {});
    mgr.connections.set(other.id, {});
    mgr.providerIdBackfillClean.add(other.id);
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr._nudgeProviderIdBackfills();
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledTimes(1);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a finished full backfill starts the id backfill', async () => {
    const mgr = newManager();
    mgr.backfillMessages = vi.fn(async () => undefined);
    mgr.refreshBulkFlags = vi.fn(async () => {});
    mgr.startSnippetIndexer = vi.fn(async () => {});
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.backfillAllFolders(gmail);
    expect(mgr.startProviderIdBackfill).toHaveBeenCalledWith(gmail);
  });

  it('a full backfill stopped by a refusal does not start the id backfill', async () => {
    const mgr = newManager();
    mgr._connectCooldown.set(gmail.id, { until: Date.now() + 60 * 1000 });
    mgr.refreshBulkFlags = vi.fn(async () => {});
    mgr.startSnippetIndexer = vi.fn(async () => {});
    mgr.startProviderIdBackfill = vi.fn(async () => {});
    await mgr.backfillAllFolders(gmail);
    expect(mgr.startProviderIdBackfill).not.toHaveBeenCalled();
  });
});
