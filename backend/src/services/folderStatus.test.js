import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getImapSnapshot, _resetImapMetrics } from './imapMetrics.js';
import { validFolderStatus, observeFolder, folderNeedsSync, folderVerifyMs, publicFolderCounts, FolderStatusMonitor, folderStaleMs, STATUS_FOLDER_BATCH, STATUS_STALE_MS, FOLDER_VERIFY_MS, FOLDER_VERIFY_CONDSTORE_MS } from './folderStatus.js';
const good = { messages: 10, unseen: 3, uidNext: 42, uidValidity: 8n, highestModseq: 9007199254740993n };
beforeEach(() => { query.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('independent server observations', () => {
  it.each([false, null, {}, { ...good, unseen: undefined }, { ...good, unseen: 11 }, { ...good, messages: -1 }])('rejects unavailable/incomplete STATUS: %s', response => {
    expect(validFolderStatus(response)).toBe(false);
  });
  it('accepts a verified empty folder', () => {
    expect(validFolderStatus({ ...good, messages: 0, unseen: 0 })).toBe(true);
  });
  it('saves independent counts, a pre-request revision, and exact modseq precision', async () => {
    query.mockResolvedValueOnce({ rows: [{ revision: '13', started_at: new Date(0) }] }).mockResolvedValueOnce({ rows: [{ id: 'f' }] });
    const client = { status: vi.fn().mockResolvedValue(good) };
    expect(await observeFolder(client, 'a', 'Sent')).toBe(good);
    expect(client.status).toHaveBeenCalledWith('Sent', expect.objectContaining({ messages: true, unseen: true }));
    expect(query.mock.calls[1][0]).toContain('status_attempt_revision < $9');
    expect(query.mock.calls[1][1]).toEqual(['a', 'Sent', 10, 3, 42, '8', '9007199254740993', new Date(0), '13']);
    expect(query.mock.calls[1][0]).not.toContain('status_synced_at');
  });
  it('does not return a superseded observation for scheduling', async () => {
    query.mockResolvedValueOnce({ rows: [{ revision: '1', started_at: new Date(0) }] }).mockResolvedValueOnce({ rows: [] });
    expect(await observeFolder({ status: async () => good }, 'a', 'INBOX')).toBeNull();
  });
  it('a false STATUS records failure without writing zero counts or erasing the last good sample', async () => {
    query.mockResolvedValueOnce({ rows: [{ revision: '2' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(observeFolder({ status: async () => false }, 'a', 'INBOX')).rejects.toThrow('Incomplete');
    expect(query.mock.calls[1][0]).toContain('status_error');
    expect(query.mock.calls[1][0]).not.toContain('server_unread_count');
  });
  it('destroys a hung status transport and records failure', async () => {
    vi.useFakeTimers();
    query.mockResolvedValueOnce({ rows: [{ revision: '2' }] }).mockResolvedValueOnce({ rows: [] });
    const client = { status: () => new Promise(() => {}), close: vi.fn() };
    const checked = expect(observeFolder(client, 'a', 'INBOX')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await checked;
    expect(client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe('completed sync checkpoints', () => {
  const row = { account_id: 'a', path: 'INBOX', status_synced_at: new Date(0), status_synced_uid_validity: '8', status_synced_uid_next: '42', status_synced_modseq: '9007199254740993', cached_total: '10', cached_unread: '3' };
  it('skips a recently verified unchanged folder', () => expect(folderNeedsSync(row, good, 1)).toBe(false));
  it.each([
    { ...good, uidNext: 43 }, { ...good, uidValidity: 9n }, { ...good, unseen: 2 },
    { ...good, messages: 9 }, { ...good, highestModseq: 9007199254740994n },
  ])('notices arrivals, rebuilds, flags, expunges, and exact modseq changes', status => expect(folderNeedsSync(row, status, 1)).toBe(true));
  it('periodically verifies equal-count membership and retries uncompleted ingestion', () => {
    expect(folderNeedsSync(row, good, 8*3600000)).toBe(true);
    expect(folderNeedsSync({ ...row, status_synced_at: null }, good, 1)).toBe(true);
  });
  it('verifies an unchanged CONDSTORE folder about every six hours instead of every 15 minutes', () => {
    expect(folderNeedsSync(row, good, 15*60000)).toBe(false);
    expect(folderNeedsSync(row, good, 4*3600000)).toBe(false);
    expect(folderNeedsSync(row, good, 8*3600000)).toBe(true);
  });
  it('keeps the 15-minute verification on servers without CONDSTORE', () => {
    const plain = { ...good, highestModseq: undefined };
    const plainRow = { ...row, status_synced_modseq: null };
    expect(folderNeedsSync(plainRow, plain, 10*60000)).toBe(false);
    expect(folderNeedsSync(plainRow, plain, 20*60000)).toBe(true);
  });
  it('spreads folders checkpointed together across the verification interval', () => {
    // Same folder, same interval every cycle; otherwise the earliest draw would always win.
    expect(folderVerifyMs(row, FOLDER_VERIFY_CONDSTORE_MS)).toBe(folderVerifyMs({ ...row }, FOLDER_VERIFY_CONDSTORE_MS));
    expect(folderVerifyMs(row, FOLDER_VERIFY_CONDSTORE_MS)).not.toBe(folderVerifyMs({ ...row, path: 'Sent' }, FOLDER_VERIFY_CONDSTORE_MS));
    const spread = Array.from({ length: 200 }, (_, i) => folderVerifyMs({ account_id: `acc-${i % 20}`, path: `Folder ${i}` }, FOLDER_VERIFY_MS));
    expect(Math.min(...spread)).toBeGreaterThanOrEqual(0.75 * FOLDER_VERIFY_MS);
    expect(Math.max(...spread)).toBeLessThanOrEqual(1.25 * FOLDER_VERIFY_MS);
    expect(Math.min(...spread)).toBeLessThan(0.8 * FOLDER_VERIFY_MS);
    expect(Math.max(...spread)).toBeGreaterThan(1.2 * FOLDER_VERIFY_MS);
  });
  it('does not present cache counts as verified server counts', () => {
    expect(publicFolderCounts({ total_count: 10, unread_count: 4 }, 0)).toMatchObject({ total_count: null, unread_count: null, cached_total_count: 10, counts_known: false, counts_stale: true });
    expect(publicFolderCounts({ server_counts_at: new Date(0), server_total_count: '0', server_unread_count: '0', status_error: 'offline' }, 1)).toMatchObject({ unread_count: 0, counts_known: true, counts_stale: true });
  });
});
describe('bounded background monitor', () => {
  it('coalesces overlapping cycles and queues sync only after releasing the status connection', async () => {
    const events = [];
    query.mockImplementation(async sql => sql.includes('SELECT f.*') ? { rows: [{ path: 'INBOX' }] }
      : sql.includes('nextval') ? { rows: [{ revision: '1', started_at: new Date(0) }] } : { rows: [{ id: 'f' }] });
    const monitor = new FolderStatusMonitor({
      withClient: async (_a, fn) => { events.push('open'); await fn({ status: async () => good }); events.push('close'); },
      enqueueSync: () => { events.push('sync'); return true; }, broadcast: vi.fn(),
    });
    const a = { id: 'a', user_id: 'u' };
    const first = monitor.refresh(a);
    expect(monitor.refresh(a)).toBe(first);
    await first;
    await monitor.refresh(a);
    expect(events).toEqual(['open', 'close', 'sync']);
    expect(query.mock.calls[0][0]).toContain('NOT f.no_select');
    expect(query.mock.calls[0][0]).toContain('LIMIT $2');
    expect(query.mock.calls[0][1]).toEqual(['a', STATUS_FOLDER_BATCH]);
  });
  it('does not let repeated Inbox ingestion failures starve unattempted folders', async () => {
    query.mockImplementation(async sql => sql.includes('SELECT f.*')
      ? { rows: [{ path: 'INBOX', status_sync_attempted_at: new Date(1000) }, { path: 'Sent' }] }
      : sql.includes('nextval') ? { rows: [{ revision: '1', started_at: new Date(0) }] } : { rows: [{ id: 'f' }] });
    const enqueueSync = vi.fn().mockReturnValue(true);
    const monitor = new FolderStatusMonitor({ withClient: async (_a, fn) => fn({ status: async () => good }), enqueueSync, broadcast: vi.fn() });
    await monitor.refresh({ id: 'a' });
    expect(enqueueSync.mock.calls[0][1]).toBe('Sent');
  });

  it('stops the folder walk when the client dies mid-cycle, bounding it to one close', async () => {
    // A timed-out STATUS destroys the transport. On Yahoo (secondaryOverPool) that transport is
    // the account's one pooled session, so the walk must not go on to fail the remaining folders
    // against a dead client: the break bounds the cost to one close, and one later grow, per
    // cycle (upstream #474 round 5 review).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    query.mockImplementation(async sql => sql.includes('SELECT f.*')
      ? { rows: [{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Trash' }] }
      : sql.includes('nextval') ? { rows: [{ revision: '1', started_at: new Date(0) }] } : { rows: [] });
    const client = {
      usable: true,
      status: vi.fn(() => { client.usable = false; return Promise.reject(new Error('Folder STATUS timed out')); }),
    };
    const monitor = new FolderStatusMonitor({ withClient: async (_a, fn) => fn(client), enqueueSync: vi.fn(), broadcast: vi.fn() });
    await monitor.refresh({ id: 'a' });
    expect(client.status).toHaveBeenCalledTimes(1); // Sent and Trash wait for the next cycle
  });

  it('prioritizes a measured cache gap over the first verification of an unchanged folder', async () => {
    query.mockImplementation(async sql => sql.includes('SELECT f.*')
      ? { rows: [{ path: 'Sent', cached_total: '10', cached_unread: '3' }, { path: 'INBOX', cached_total: '9', cached_unread: '3', status_sync_attempted_at: new Date(1000) }] }
      : sql.includes('nextval') ? { rows: [{ revision: '1', started_at: new Date(0) }] } : { rows: [{ id: 'f' }] });
    const enqueueSync = vi.fn().mockReturnValue(true);
    const monitor = new FolderStatusMonitor({ withClient: async (_a, fn) => fn({ status: async () => good }), enqueueSync, broadcast: vi.fn() });
    await monitor.refresh({ id: 'a' });
    expect(enqueueSync.mock.calls[0][1]).toBe('INBOX');
  });

  describe('one LIST-STATUS instead of a STATUS per folder', () => {
    const sqlFor = rows => async sql => sql.includes('SELECT f.*') ? { rows }
      : sql.includes('nextval') ? { rows: [{ revision: '1', started_at: new Date(0) }] } : { rows: [{ id: 'f' }] };
    const monitorWith = (client, enqueueSync = vi.fn().mockReturnValue(true)) =>
      new FolderStatusMonitor({ withClient: async (_a, fn) => fn(client), enqueueSync, broadcast: vi.fn() });
    const listing = (entries, extra = {}) => ({ capabilities: new Set(['LIST-STATUS']), usable: true,
      list: vi.fn(async () => entries), status: vi.fn(async () => good), ...extra });
    const updatesFor = path => query.mock.calls.filter(([sql, params]) => sql.includes('server_total_count=$3') && params[1] === path);
    const errorsFor = path => query.mock.calls.filter(([sql, params]) => sql.includes('status_error=$4') && params[1] === path);

    it('observes every folder in one command and asks STATUS only for folders the listing omitted', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      query.mockImplementation(sqlFor(['INBOX', 'INBOX.Sent', 'INBOX.Archive', 'INBOX.Junk', 'INBOX.Gone'].map(path => ({ path }))));
      const client = listing([
        { path: 'INBOX', status: good },
        // The personal-namespace path must match the folders row exactly, or the folder silently loses its counts.
        { path: 'INBOX.Sent', status: { ...good, messages: 4, unseen: 0 } },
        // A server may leave out the mailbox this pooled session has selected.
        { path: 'INBOX.Archive' },
        { path: 'INBOX.Junk', status: { error: new Error('NO [SERVERBUG] status failed') } },
      ]);
      const monitor = monitorWith(client);
      await monitor._refresh({ id: 'a' });

      expect(client.list).toHaveBeenCalledOnce();
      expect(client.list.mock.calls[0][0]).toEqual({ statusQuery: expect.objectContaining({ messages: true, unseen: true, uidNext: true }) });
      expect(client.status.mock.calls.map(([path]) => path)).toEqual(['INBOX.Archive', 'INBOX.Gone']);
      expect(updatesFor('INBOX.Sent')[0][1].slice(2, 4)).toEqual([4, 0]);
      expect(updatesFor('INBOX')).toHaveLength(1);
      expect(errorsFor('INBOX.Junk')[0][1][3]).toContain('SERVERBUG');
      expect(updatesFor('INBOX.Junk')).toHaveLength(0);

      // Once the server is known to support it, the monitor reads every folder, not a rotation.
      await monitor._refresh({ id: 'a' });
      const selects = query.mock.calls.filter(([sql]) => sql.includes('SELECT f.*'));
      expect(selects.map(([, params]) => params)).toEqual([['a', STATUS_FOLDER_BATCH], ['a', null]]);
    });

    it('records each cycle with its mode and the time of the folder query', async () => {
      _resetImapMetrics();
      query.mockImplementation(sqlFor([{ path: 'INBOX' }]));
      await monitorWith(listing([{ path: 'INBOX', status: good }]))._refresh({ id: 'a', imap_host: 'imap.gmail.com' });
      await monitorWith({ usable: true, status: vi.fn(async () => good) })._refresh({ id: 'b', imap_host: 'imap.gmail.com' });
      const cycles = getImapSnapshot(host => host).statusCycles;
      expect(cycles.map(c => [c.provider, c.mode, c.count, c.failures])).toEqual([
        ['imap.gmail.com', 'list-status', 1, 0], ['imap.gmail.com', 'rotation', 1, 0],
      ]);
      expect(cycles.every(c => Number.isInteger(c.meanQueryMs))).toBe(true);
    });

    it('bounds per-folder STATUS fallbacks to the rotation width', async () => {
      const rows = Array.from({ length: STATUS_FOLDER_BATCH + 3 }, (_, i) => ({ path: `F${i}` }));
      query.mockImplementation(sqlFor(rows));
      const client = listing([]);
      await monitorWith(client)._refresh({ id: 'a' });
      expect(client.status).toHaveBeenCalledTimes(STATUS_FOLDER_BATCH);
    });

    it('records a failed listing on every folder without asking STATUS', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      query.mockImplementation(sqlFor([{ path: 'INBOX' }, { path: 'Sent' }]));
      const client = listing([], { list: vi.fn().mockRejectedValue(new Error('BAD listing')) });
      const enqueueSync = vi.fn();
      const monitor = monitorWith(client, enqueueSync);
      await monitor._refresh({ id: 'a' });
      expect(client.status).not.toHaveBeenCalled();
      expect(errorsFor('INBOX')).toHaveLength(1);
      expect(errorsFor('Sent')).toHaveLength(1);
      expect(enqueueSync).not.toHaveBeenCalled();
      expect(monitor.failures.get('a')).toBe(1);
    });

    it('keeps the six-folder STATUS rotation when the server has no LIST-STATUS', async () => {
      query.mockImplementation(sqlFor(Array.from({ length: STATUS_FOLDER_BATCH + 2 }, (_, i) => ({ path: `F${i}` }))));
      const client = { usable: true, capabilities: new Set(['IMAP4rev1']), list: vi.fn(), status: vi.fn(async () => good) };
      const monitor = monitorWith(client);
      await monitor._refresh({ id: 'a' });
      await monitor._refresh({ id: 'a' });
      expect(client.list).not.toHaveBeenCalled();
      expect(client.status).toHaveBeenCalledTimes(STATUS_FOLDER_BATCH * 2);
      const selects = query.mock.calls.filter(([sql]) => sql.includes('SELECT f.*'));
      expect(selects.map(([, params]) => params[1])).toEqual([STATUS_FOLDER_BATCH, STATUS_FOLDER_BATCH]);
    });
  });

  it('backs off login failures and does not enqueue work', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    query.mockResolvedValue({ rows: [{ path: 'INBOX' }] });
    const withClient = vi.fn().mockRejectedValue(new Error('offline'));
    const enqueueSync = vi.fn();
    const monitor = new FolderStatusMonitor({ withClient, enqueueSync, broadcast: vi.fn() });
    const a = { id: 'a' };
    await monitor.refresh(a);
    await monitor.refresh(a);
    await vi.advanceTimersByTimeAsync(60000);
    await monitor.refresh(a);
    await vi.advanceTimersByTimeAsync(60000);
    await monitor.refresh(a);
    expect(withClient).toHaveBeenCalledTimes(2);
    expect(enqueueSync).not.toHaveBeenCalled();
  });
});

describe('freshness allowance tracks the rotation the monitor actually performs', () => {
  it('never marks a folder stale before its own rotation could have reached it', () => {
    // The regression this exists to prevent: a fixed 180s allowance against a 16-folder
    // account whose worst-case observation age is 178-181s, which flagged healthy folders as
    // stale and (before the badge fix) rendered a ghost unread badge each time it crossed.
    for (const n of [1, 6, 12, 16, 17, 40, 88]) {
      const rotationMs = Math.max(1, Math.ceil(Math.max(0, n - 1) / (STATUS_FOLDER_BATCH - 1))) * 60000;
      expect(folderStaleMs(n)).toBeGreaterThan(rotationMs);
    }
  });
  it('holds the floor for small accounts and grows past it for large ones', () => {
    expect(folderStaleMs(6)).toBe(STATUS_STALE_MS);
    expect(folderStaleMs(16)).toBe(270000);
    expect(folderStaleMs(17)).toBe(360000);
  });
  it('survives degenerate folder counts rather than producing NaN', () => {
    for (const bad of [undefined, null, 0, -5, NaN, 'many', {}]) {
      expect(folderStaleMs(bad)).toBe(STATUS_STALE_MS);
    }
  });
  it('keeps INBOX on the every-cycle allowance regardless of how many folders exist', () => {
    const row = { path: 'INBOX', server_counts_at: new Date(0), server_total_count: '1', server_unread_count: '0' };
    expect(publicFolderCounts(row, STATUS_STALE_MS + 1, { selectableFolders: 88 }).counts_stale).toBe(true);
    expect(publicFolderCounts(row, STATUS_STALE_MS - 1, { selectableFolders: 88 }).counts_stale).toBe(false);
  });
  it('gives a rotating folder the longer allowance', () => {
    const row = { path: 'Sent', server_counts_at: new Date(0), server_total_count: '1', server_unread_count: '0' };
    expect(publicFolderCounts(row, 200000, { selectableFolders: 16 }).counts_stale).toBe(false);
    expect(publicFolderCounts(row, 200000, { selectableFolders: 6 }).counts_stale).toBe(true);
  });
});
