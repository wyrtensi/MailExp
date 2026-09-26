// DB-first moves. A user's move, archive, delete to Trash or spam/not-spam changes the panel's
// database at once and answers the request; the MOVE on the mail server runs later, from a
// durable queue (migration 0075, table message_moves), in the background. The panel database is
// the source of truth for the people using it, so a busy mailbox no longer turns a move into a
// "mailbox busy, try again" error. Flag changes work the same way (the flag-push queue).
//
// Life of a moved row (UIDPLUS server, the normal case):
//   1. The route enqueues: one message_moves row (id n) holding where the letter is on the server
//      (src_folder, src_uid) and where it goes (dest_folder). In the same statement the message
//      row moves to dest_folder with the placeholder uid -n. The row keeps its id, so the client
//      and every later action address the same row. Placeholders are negative, so they never
//      collide with a server UID in UNIQUE(account_id, uid, folder).
//   2. While the move is pending, (account, src_folder, src_uid) and (account, dest_folder, -n)
//      are guarded (ImapManager._guardMoveUid): reconcileDeletes and the integrity pass do not
//      delete either, and sync and backfill do not insert the letter at the source again.
//   3. The worker claims the account's queued moves, groups them by (source, destination) and
//      sends one MOVE per group, after any flag store already called on those letters
//      (ImapManager.flagStoresSettled). The server names the new uid U (COPYUID), and the row
//      takes it (settle). A destination sync that sees the letter first attaches it to the row
//      instead of inserting a second one (claimArrival), and the settle then has nothing to do.
//   4. A read or star change made while the move is pending is stored on the queue row
//      (deferFlags) and written at (dest_folder, U) after the MOVE.
// A server that names no new uid leaves the move awaiting_uid: the destination sync attaches the
// letter by its Message-ID, or the worker looks it up. A letter moved again while its move is in
// flight gets a second move whose source uid is filled in when the first one settles.
//
// Failures: one that may pass (the server did not move a letter it still has, a dropped
// connection) is retried with backoff; a busy pool or a login held back by the account's
// backoffs (#98, #99, #102) is not counted as an attempt. A permanent one (the letter is gone
// from the source, the destination folder is gone) or MOVE_MAX_ATTEMPTS failures return the row
// to its source folder and uid and tell every client (move_reverted).
import { query, withTransaction } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { recordAudit } from './auditLog.js';
import { isMailboxBusyError, createKeyedSemaphore } from './imapManager.js';

export const MOVE_MAX_ATTEMPTS = 8;
export const MOVE_RETRY_BASE_MS = 15 * 1000;
export const MOVE_RETRY_MAX_MS = 10 * 60 * 1000;
export const MOVE_QUEUE_TICK_MS = 5 * 1000;
export const MOVE_CLAIM_LIMIT = 500;
// Mailbox runs at once, across all mailboxes. After a restart or an outage every mailbox with due
// moves is kicked together; each run is a STATUS, a MOVE and maybe searches on the pool, and ~600
// mailboxes contending with the initial syncs for the host connect slots would crowd them out.
export const MOVE_RUN_CONCURRENCY = 8;
// A FETCH that started before the MOVE and is processed after it would insert the letter at its
// source again, so the source guard outlives a settled move by this much.
export const MOVE_SOURCE_GUARD_LINGER_MS = 10 * 1000;
// How often a move awaiting its new uid is looked up again, and for how long.
export const MOVE_AWAITING_RETRY_MS = 15 * 1000;
export const MOVE_AWAITING_UID_MAX_MS = 10 * 60 * 1000;
// The lease of a claimed move: a run renews it right before each MOVE. A 'moving' move whose lease
// ran out, or whose mailbox has no run in progress, was left behind by a run that failed (a
// database error mid-run) and is swept back by the tick. Longer than the longest bounded MOVE
// (STATUS, MOVE and the reconciling searches, each under the pooled-operation timeout).
export const MOVE_LEASE_MS = 15 * 60 * 1000;

export function moveRetryDelayMs(attempts) {
  return Math.min(MOVE_RETRY_MAX_MS, MOVE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export const placeholderUid = (moveId) => -Number(moveId);
export const isPendingUid = (uid) => Number(uid) < 0;

// special_use of Gmail's virtual folders: they list letters that live in other folders, so a
// letter found there proves nothing about where it went.
const VIRTUAL_FOLDER_USES = ['\\All', '\\Flagged', '\\Important'];

const FLAG_COLUMNS = { '\\Seen': 'set_seen', '\\Flagged': 'set_flagged' };

export class MoveQueue {
  constructor(mgr) {
    this.mgr = mgr;
    this._guards = new Map();   // moveId -> { accountId, list: [{ folder, uid }] }
    this._arrivals = new Map(); // `${accountId}\n${folder}` -> Map<message id header, Set<moveId>>
    this._running = new Set();  // accountId with a worker run in progress
    this._again = new Set();    // accountId kicked while its run was in progress
    this._runSlots = createKeyedSemaphore(MOVE_RUN_CONCURRENCY);
    this._holds = new Map();    // accountId -> Set<{ path, prefix, kind }>: folders being emptied, renamed or deleted
    this._timer = null;
  }

  // ── Guards and expected arrivals (in memory, rebuilt from the table by resume) ──────────

  _guard(op) {
    this._unguard(op.id);
    const list = [{ folder: op.dest_folder, uid: placeholderUid(op.id) }];
    if (op.src_uid != null) list.push({ folder: op.src_folder, uid: Number(op.src_uid) });
    for (const g of list) this.mgr._guardMoveUid(op.account_id, g.folder, g.uid);
    this._guards.set(String(op.id), { accountId: op.account_id, list });
  }

  // lingerSource: the letter left the source; keep that guard a little longer (see above).
  _unguard(moveId, { lingerSource = false } = {}) {
    const entry = this._guards.get(String(moveId));
    if (!entry) return;
    this._guards.delete(String(moveId));
    for (const g of entry.list) {
      const release = () => this.mgr._unguardMoveUid(entry.accountId, g.folder, g.uid);
      if (lingerSource && g.uid > 0) {
        const timer = setTimeout(release, MOVE_SOURCE_GUARD_LINGER_MS);
        timer.unref?.();
      } else {
        release();
      }
    }
  }

  // Only a move whose MOVE is on its way or done expects its letter in the destination. Before
  // that, a letter with the same Message-ID arriving there is a separate copy and is inserted.
  _expect(op) {
    if (!op.message_id_header) return;
    const key = `${op.account_id}\n${op.dest_folder}`;
    if (!this._arrivals.has(key)) this._arrivals.set(key, new Map());
    const byMid = this._arrivals.get(key);
    if (!byMid.has(op.message_id_header)) byMid.set(op.message_id_header, new Set());
    byMid.get(op.message_id_header).add(String(op.id));
  }

  _unexpect(op) {
    if (!op.message_id_header) return;
    const key = `${op.account_id}\n${op.dest_folder}`;
    const byMid = this._arrivals.get(key);
    const ids = byMid?.get(op.message_id_header);
    if (!ids) return;
    ids.delete(String(op.id));
    if (!ids.size) byMid.delete(op.message_id_header);
    if (!byMid.size) this._arrivals.delete(key);
  }

  expectsArrival(accountId, folder, messageId) {
    if (!messageId) return false;
    return !!this._arrivals.get(`${accountId}\n${folder}`)?.get(messageId)?.size;
  }

  // Sync and backfill call this before inserting a letter they found at (folder, uid). When a
  // move in flight expects that letter there, the moved row takes the uid (or the move that
  // follows it takes it as its source) and true is returned: the caller inserts nothing, so the
  // letter neither shows twice nor counts as new mail (no notification, no inbox rules on a
  // letter the user just moved to INBOX).
  async claimArrival(accountId, folder, messageId, uid) {
    if (!this.expectsArrival(accountId, folder, messageId)) return false;
    // A uid that already has a row is a letter we know, not an arrival: a full scan or a backfill
    // re-reading an older copy with the same Message-ID must not hand it to the moved row.
    const { rows: known } = await query(
      'SELECT 1 FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3',
      [accountId, folder, Number(uid)]
    );
    if (known.length) return false;
    const { rows: [op] } = await query(
      `SELECT * FROM message_moves
        WHERE account_id = $1 AND dest_folder = $2 AND message_id_header = $3 AND state IN ('moving', 'awaiting_uid')
        ORDER BY id LIMIT 1`,
      [accountId, folder, messageId]
    );
    if (!op) return false;
    const settled = await this._settle(op, Number(uid));
    // No row took the letter (its row is gone): the caller inserts it as it would any letter.
    if (!settled || (!settled.row && !settled.next)) return false;
    if (settled.row) {
      const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      if (account) {
        this._storeSettledFlags(account, [settled])
          .catch(err => console.warn(`Move queue: flag store after arrival failed: ${err.message}`));
        if (settled.needsProviderIds) this.mgr._scheduleProviderIdBackfill(account);
      }
    }
    return true;
  }

  // ── Folder holds ─────────────────────────────────────────────────────────────────────────

  // A folder being emptied, renamed or deleted on the server. While the hold lasts, the worker
  // sends no MOVE into or out of it (the moves wait, without an attempt), and no letter is moved
  // out of it. kind 'empty' still lets letters be moved in: their rows keep their placeholder,
  // which the empty leaves alone, and their MOVE runs once the empty is done. Any other kind
  // (a rename or delete, with `delimiter` for the subtree) refuses moves in as well. Returns the
  // release function.
  holdFolder(accountId, path, { kind = 'change', delimiter = null } = {}) {
    const hold = { path, prefix: delimiter ? path + delimiter : null, kind };
    if (!this._holds.has(accountId)) this._holds.set(accountId, new Set());
    this._holds.get(accountId).add(hold);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const holds = this._holds.get(accountId);
      holds?.delete(hold);
      if (holds && !holds.size) this._holds.delete(accountId);
      this.kick(accountId);
    };
  }

  _heldBy(accountId, folder) {
    for (const hold of this._holds.get(accountId) || []) {
      if (folder === hold.path || (hold.prefix && folder.startsWith(hold.prefix))) return hold;
    }
    return null;
  }

  _opHeld(op) {
    return !!(this._heldBy(op.account_id, op.src_folder) || this._heldBy(op.account_id, op.dest_folder));
  }

  // After a folder rename rewrote the paths of the account's moves: guards and expected arrivals
  // are keyed by path, so they are rebuilt from the table.
  async reguardAccount(accountId) {
    for (const [id, entry] of [...this._guards]) if (entry.accountId === accountId) this._unguard(id);
    for (const key of [...this._arrivals.keys()]) if (key.startsWith(`${accountId}\n`)) this._arrivals.delete(key);
    const { rows } = await query('SELECT * FROM message_moves WHERE account_id = $1 ORDER BY id', [accountId]);
    for (const op of rows) {
      this._guard(op);
      if (op.state !== 'queued') this._expect(op);
    }
  }

  // ── Routes ───────────────────────────────────────────────────────────────────────────────

  // Locking: every statement that locks several rows locks them in id order (messages here, moves
  // in deferFlags and the claim), so overlapping bulk requests queue instead of deadlocking.
  //
  // Move `rows` (message rows of one account, as the route read them) to `dest` in the database
  // and queue the server MOVE. dropRow: the destination is not synced (Gmail All Mail), so the
  // row is deleted once the server has moved the letter. Returns one { id, from, isRead } per row
  // now in `dest` as far as the panel is concerned: `from` and `isRead` are the row's folder and
  // read state as the statement that moved it saw them under its lock, for the folder counts
  // (from === dest: it was there already, nothing to count). A route's own read of the row may be
  // stale: another request can have moved it in between.
  async enqueue(accountId, rows, dest, { dropRow = false, movedBy = null } = {}) {
    // The route's read of a row may be stale, so even a row it saw in `dest` goes through the
    // locked statements below; they tell a row that is really there already from one that is not.
    const moved = new Map();
    // Nothing moves out of a held folder, nor into one being renamed or deleted (holdFolder).
    const destHold = this._heldBy(accountId, dest);
    if (destHold && destHold.kind !== 'empty') return [];
    rows = rows.filter(r => !this._heldBy(accountId, r.folder));
    const fresh = rows.filter(r => !isPendingUid(r.uid));
    let retry = rows.filter(r => isPendingUid(r.uid)).map(r => r.id);
    const created = [];

    if (fresh.length) {
      const { rows: ops } = await query(
        `WITH src AS (
           SELECT id, account_id, folder, uid, message_id, is_read FROM messages
            WHERE id = ANY($1::uuid[]) AND account_id = $2 AND uid > 0 AND folder <> $3
            ORDER BY id
            FOR UPDATE
         ), ins AS (
           INSERT INTO message_moves (account_id, message_row_id, message_id_header, src_folder, src_uid, dest_folder, drop_row, moved_by)
           SELECT account_id, id, message_id, folder, uid, $3, $4, $5 FROM src
           RETURNING *
         )
         UPDATE messages m SET folder = $3, uid = -ins.id
           FROM ins JOIN src ON src.id = ins.message_row_id
          WHERE m.id = ins.message_row_id
         RETURNING ins.*, src.is_read AS from_is_read`,
        [fresh.map(r => r.id), accountId, dest, dropRow, movedBy]
      );
      for (const op of ops) {
        created.push(op);
        moved.set(op.message_row_id, { id: op.message_row_id, from: op.src_folder, isRead: !!op.from_is_read });
      }
      // A row another request moved in the meantime is pending now: take the path below.
      retry = retry.concat(fresh.filter(r => !moved.has(r.id)).map(r => r.id));
    }

    for (const rowId of retry) {
      const outcome = await this._enqueuePending(accountId, rowId, dest, dropRow, movedBy);
      if (outcome?.moved) moved.set(rowId, outcome.moved);
      if (outcome?.op) created.push(outcome.op);
    }

    for (const op of created) this._guard(op);
    if (created.length) {
      await this._absorbFlagPushes(accountId, [...moved.keys()]);
      this.kick(accountId);
    }
    return [...moved.values()];
  }

  // A row whose move is still pending is moved again. Returns { moved, op } for a move queued or
  // changed, { moved, cancelled } when the letter goes back to where the server has it, null when
  // the row did not move (gone, or moved by another request this very moment). `moved` is the
  // { id, from, isRead } of enqueue. Each statement locks the message row first, as the worker's
  // settle does, so a settle and this never interleave.
  async _enqueuePending(accountId, rowId, dest, dropRow, movedBy) {
    // The latest move is still queued and its source is the new destination: drop it, and the row
    // goes back to the letter's server location (or to its predecessor's placeholder). A read/star
    // change deferred onto the dropped move is kept: it goes to the predecessor, which stores it
    // after its own MOVE (the newer value wins), in the same statement so that move cannot settle
    // in between; or, when the letter is back where the server has it, to the flag-push queue.
    const cancelled = await query(
      `WITH m AS (SELECT id, uid, folder, is_read FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 FOR UPDATE),
       op AS (
         DELETE FROM message_moves mv USING m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state = 'queued' AND mv.src_folder = $3
         RETURNING mv.*
       ), pred AS (
         UPDATE message_moves p SET set_seen = COALESCE(op.set_seen, p.set_seen),
                set_flagged = COALESCE(op.set_flagged, p.set_flagged)
           FROM op WHERE p.id = op.predecessor_id
         RETURNING p.id
       )
       UPDATE messages x SET folder = op.src_folder, uid = COALESCE(op.src_uid, -op.predecessor_id)
         FROM op, m WHERE x.id = op.message_row_id
       RETURNING op.*, m.folder AS from_folder, m.is_read AS from_is_read`,
      [rowId, accountId, dest]
    );
    const gone = cancelled.rows[0];
    if (gone) {
      this._unguard(gone.id);
      if (gone.src_uid != null) {
        if (gone.set_seen != null) this.mgr._enqueueFlagPush(accountId, rowId, '\\Seen', gone.set_seen);
        if (gone.set_flagged != null) this.mgr._enqueueFlagPush(accountId, rowId, '\\Flagged', gone.set_flagged);
      }
      return { cancelled: gone, moved: { id: rowId, from: gone.from_folder, isRead: !!gone.from_is_read } };
    }
    // Still queued: it takes the new destination.
    const changed = await query(
      `WITH m AS (SELECT id, uid, folder, is_read FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 AND folder <> $3 FOR UPDATE),
       op AS (
         UPDATE message_moves mv SET dest_folder = $3, drop_row = $4, moved_by = $5, updated_at = now() FROM m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state = 'queued'
         RETURNING mv.*
       )
       UPDATE messages x SET folder = $3 FROM op, m WHERE x.id = op.message_row_id
       RETURNING op.*, m.folder AS from_folder, m.is_read AS from_is_read`,
      [rowId, accountId, dest, dropRow, movedBy]
    );
    const retargeted = changed.rows[0];
    if (retargeted) return { op: retargeted, moved: { id: rowId, from: retargeted.from_folder, isRead: !!retargeted.from_is_read } };
    // In flight: a second move follows it; its source uid comes when the first one settles.
    const next = await query(
      `WITH m AS (SELECT id, uid, folder, is_read FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 AND folder <> $3 FOR UPDATE),
       prev AS (
         SELECT mv.* FROM message_moves mv, m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state <> 'queued'
       ), ins AS (
         INSERT INTO message_moves (account_id, message_row_id, message_id_header, src_folder, src_uid, dest_folder, drop_row, predecessor_id, moved_by)
         SELECT account_id, message_row_id, message_id_header, dest_folder, NULL, $3, $4, id, $5 FROM prev
         RETURNING *
       )
       UPDATE messages x SET folder = $3, uid = -ins.id FROM ins, m WHERE x.id = ins.message_row_id
       RETURNING ins.*, m.folder AS from_folder, m.is_read AS from_is_read`,
      [rowId, accountId, dest, dropRow, movedBy]
    );
    const following = next.rows[0];
    if (following) return { op: following, moved: { id: rowId, from: following.from_folder, isRead: !!following.from_is_read } };
    // The move settled in between (the row has a server uid again) or the row is gone.
    const { rows: [row] } = await query('SELECT id, uid, folder, is_read FROM messages WHERE id = $1 AND account_id = $2', [rowId, accountId]);
    if (!row) return null;
    if (row.folder === dest) return { moved: { id: rowId, from: dest, isRead: !!row.is_read } };
    if (isPendingUid(row.uid)) return null; // moved by another request at this very moment
    const [again] = await this.enqueue(accountId, [row], dest, { dropRow, movedBy });
    return again ? { moved: again } : null;
  }

  // A read/star push that failed before the move was queued now belongs to the move: stored at the
  // destination after the MOVE, and durable (the flag-push queue lives in memory only).
  async _absorbFlagPushes(accountId, rowIds) {
    const ops = this.mgr._pendingFlagPush?.get(accountId);
    if (!ops?.size) return;
    for (const flag of Object.keys(FLAG_COLUMNS)) {
      for (const value of [true, false]) {
        const ids = rowIds.filter(id => ops.get(`${id}:${flag}`)?.value === value);
        if (!ids.length) continue;
        const { deferred } = await this.deferFlags(ids.map(id => ({ id, uid: -1 })), flag, value);
        for (const id of deferred) this.mgr._resolveFlagPush(accountId, id, flag);
      }
    }
  }

  // A read or star change on rows whose move has not reached the server: there is no server uid
  // to store at yet, so the value goes onto the move and is stored at the destination after it.
  // Returns { deferred: Set<id>, located: Map<id, { uid, folder }> }: located holds the rows whose
  // move settled in the meantime, with their server location to store at now.
  async deferFlags(rows, flag, value) {
    const pending = rows.filter(r => isPendingUid(r.uid)).map(r => r.id);
    const deferred = new Set();
    const located = new Map();
    if (!pending.length) return { deferred, located };
    const col = FLAG_COLUMNS[flag];
    if (!col) throw new Error(`deferFlags: unknown flag ${flag}`);
    // col is one of two fixed literals above, never input.
    // The move rows are locked in id order, like every multi-row lock here: two requests over
    // overlapping letters then wait for each other instead of deadlocking.
    const { rows: done } = await query(
      `WITH target AS (
         SELECT mv.id FROM message_moves mv JOIN messages m ON mv.id = -m.uid AND mv.message_row_id = m.id
          WHERE m.id = ANY($1::uuid[])
          ORDER BY mv.id
          FOR UPDATE OF mv
       )
       UPDATE message_moves mv SET ${col} = $2
         FROM target WHERE mv.id = target.id
        RETURNING mv.message_row_id AS id`,
      [pending, value]
    );
    for (const r of done) deferred.add(r.id);
    const rest = pending.filter(id => !deferred.has(id));
    if (rest.length) {
      const { rows: fresh } = await query('SELECT id, uid, folder FROM messages WHERE id = ANY($1::uuid[])', [rest]);
      for (const r of fresh) if (!isPendingUid(r.uid)) located.set(r.id, { uid: Number(r.uid), folder: r.folder });
    }
    return { deferred, located };
  }

  // Where the letter of `row` is on the server right now, for a route that reads it (body,
  // headers, attachments): its own folder and uid, or the source of its move while the MOVE has
  // not gone out (queued, or claimed but not sent). Once the MOVE may have gone out (sent, or
  // awaiting its uid) and `account` is given, the server is asked, as the worker would: the
  // source first, then the destination by Message-ID. The route is interactive, so these lookups
  // use the pool as a user action does. null when the letter cannot be placed (no account, a
  // move that follows one still in flight, or found nowhere): the route answers move_pending.
  async serverLocation(row, account = null) {
    if (!isPendingUid(row.uid)) return { folder: row.folder, uid: Number(row.uid) };
    const { rows: [op] } = await query(
      'SELECT * FROM message_moves WHERE id = $1 AND message_row_id = $2',
      [-Number(row.uid), row.id]
    );
    if (!op) {
      // Settled in the meantime: the row has its server uid again.
      const { rows: [fresh] } = await query('SELECT uid, folder FROM messages WHERE id = $1', [row.id]);
      return fresh && !isPendingUid(fresh.uid) ? { folder: fresh.folder, uid: Number(fresh.uid) } : null;
    }
    if (op.src_uid == null) return null;
    const source = { folder: op.src_folder, uid: Number(op.src_uid) };
    if (op.state === 'queued' || (op.state === 'moving' && !op.sent_at)) return source;
    if (!account) return null;
    const present = await this.mgr.searchUids(account, op.src_folder, [Number(op.src_uid)]);
    if (present.length) return source;
    if (!op.message_id_header) return null;
    const [found] = await this.mgr.findMessageIdInFolders(account, [op.dest_folder], op.message_id_header);
    return found?.uids?.length ? { folder: op.dest_folder, uid: Math.max(...found.uids) } : null;
  }

  // ── Worker ───────────────────────────────────────────────────────────────────────────────

  // Startup: moves that were in flight when the process stopped may or may not have reached the
  // server, so they are looked up like a move whose new uid is unknown (awaiting_uid): found in
  // the destination, the row takes it; still at the source, the move is queued again. Guards and
  // expected arrivals are rebuilt before any sync runs (index.js calls this right after the
  // migrations, before the mailboxes connect).
  async resume() {
    await query(
      `UPDATE message_moves SET state = CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'awaiting_uid' END,
              awaiting_since = CASE WHEN sent_at IS NULL THEN NULL ELSE now() END,
              next_attempt_at = now(), updated_at = now()
        WHERE state = 'moving'`
    );
    const { rows } = await query('SELECT * FROM message_moves ORDER BY id');
    for (const op of rows) {
      this._guard(op);
      if (op.state === 'awaiting_uid') this._expect(op);
    }
    this.start();
    for (const accountId of new Set(rows.map(r => r.account_id))) this.kick(accountId);
    return rows.length;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(err => console.error('Move queue tick failed:', err.message));
    }, MOVE_QUEUE_TICK_MS);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    await this.sweep();
    const { rows } = await query(
      `SELECT DISTINCT account_id FROM message_moves
        WHERE next_attempt_at <= now()
          AND ((state = 'queued' AND src_uid IS NOT NULL) OR state = 'awaiting_uid')`
    );
    for (const { account_id: accountId } of rows) this.kick(accountId);
  }

  // Moves left 'moving' by a run that failed go back: to 'queued' when their MOVE never went out,
  // else to 'awaiting_uid', which checks the source before anything else. A mailbox with a run in
  // progress keeps its claims until their lease runs out.
  async sweep() {
    const { rows } = await query(
      `UPDATE message_moves SET state = CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'awaiting_uid' END,
              awaiting_since = CASE WHEN sent_at IS NULL THEN NULL ELSE now() END,
              next_attempt_at = now(), updated_at = now()
        WHERE state = 'moving'
          AND (claimed_at IS NULL OR claimed_at < now() - ($1::int * interval '1 millisecond')
               OR NOT (account_id = ANY($2::uuid[])))
       RETURNING *`,
      [MOVE_LEASE_MS, [...this._running]]
    );
    for (const op of rows) {
      if (op.state === 'queued') this._unexpect(op);
      else this._expect(op);
    }
    return rows.length;
  }

  kick(accountId) {
    this.runAccount(accountId).catch(err => console.error(`Move queue run failed for account ${accountId}:`, err.message));
  }

  // One run at a time per mailbox; a kick during a run makes it go once more.
  async runAccount(accountId) {
    if (this._running.has(accountId)) { this._again.add(accountId); return; }
    this._running.add(accountId);
    try {
      await this._runSlots.acquire('runs');
      try {
        do {
          this._again.delete(accountId);
          await this._runAccountOnce(accountId);
        } while (this._again.has(accountId));
      } finally {
        this._runSlots.release('runs');
      }
    } finally {
      this._running.delete(accountId);
    }
  }

  // The same gates as the flag-push reconciler: only while the mailbox is connected (a live
  // persistent session, or poll-only by design), and never while its backoffs hold background
  // logins back (a rejected password must not become one more login toward fail2ban). A move
  // that waits here is not counted as an attempt.
  _gateOpen(accountId) {
    const mgr = this.mgr;
    if (!mgr.connections.has(accountId) && !mgr._pollOnlyAccounts.has(accountId)) return false;
    return !mgr._secondaryLoginBlocked(accountId);
  }

  _poolOpts(accountId) {
    return { background: true, ...this.mgr._poolLoginOpts(accountId) };
  }

  async _runAccountOnce(accountId) {
    if (!this._gateOpen(accountId)) return;
    const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    if (!account) return;
    const reverted = [];
    try {
      // A database error while looking up awaiting moves leaves them awaiting (nothing is claimed
      // there) and must not keep the queued moves from running.
      let busy = false;
      try {
        busy = await this._resolveAwaiting(account, reverted);
      } catch (err) {
        console.error(`Move queue: looking up moved letters failed: ${err.message}`);
      }
      if (busy) return;
      let { rows: claimed } = await query(
        `UPDATE message_moves SET state = 'moving', claimed_at = now(), sent_at = NULL, updated_at = now()
          WHERE id IN (
            SELECT id FROM message_moves
             WHERE account_id = $1 AND state = 'queued' AND src_uid IS NOT NULL AND next_attempt_at <= now()
             ORDER BY id LIMIT $2
             FOR UPDATE SKIP LOCKED)
            AND state = 'queued'
         RETURNING *`,
        [accountId, MOVE_CLAIM_LIMIT]
      );
      // Moves into or out of a folder being emptied, renamed or deleted wait for it.
      const held = claimed.filter(op => this._opHeld(op));
      if (held.length) await this._release(held);
      claimed = claimed.filter(op => !this._opHeld(op));
      if (!claimed.length) return;
      claimed.sort((a, b) => Number(a.id) - Number(b.id));
      for (const op of claimed) this._expect(op);
      const groups = new Map();
      for (const op of claimed) {
        const key = `${op.src_folder}\n${op.dest_folder}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(op);
      }
      let stopped = false;
      for (const ops of groups.values()) {
        if (stopped || !this._gateOpen(accountId)) { await this._release(ops); stopped = true; continue; }
        try {
          stopped = await this._runGroup(account, ops, reverted);
        } catch (err) {
          // A database error mid-group (a dropped connection, a timeout, a deadlock) must not leave
          // the group's moves claimed for good, nor stop the other groups. What is still 'moving'
          // goes back; the sweep in tick() catches it if the database is down for this too.
          console.error(`Move queue: group ${ops[0].src_folder} -> ${ops[0].dest_folder} failed: ${err.message}`);
          await this._recover(ops).catch(e => console.error(`Move queue: recovering claimed moves failed: ${e.message}`));
        }
      }
    } finally {
      this._notifyReverted(accountId, reverted);
    }
  }

  // One MOVE for a (source, destination) group. Returns true when the mailbox gave no session
  // (busy pool, login held back): its other groups wait for the next run.
  async _runGroup(account, ops, reverted) {
    const mgr = this.mgr;
    const src = ops[0].src_folder;
    const dest = ops[0].dest_folder;
    const uids = ops.map(o => Number(o.src_uid));
    const byUid = new Map(ops.map(o => [Number(o.src_uid), o]));
    // Flag stores already called on these letters reach the server first, at their source uid.
    await mgr.flagStoresSettled(account.id, src, uids);
    // The MOVE goes out now: renew the lease and mark it sent, so a run that fails from here on
    // leaves moves that are looked up before anything is sent again.
    await query(
      `UPDATE message_moves SET claimed_at = now(), sent_at = now() WHERE id = ANY($1::bigint[]) AND state = 'moving'`,
      [ops.map(o => o.id)]
    );

    let outcome;
    try {
      outcome = await mgr.bulkMoveMessages(account, uids, src, dest, this._poolOpts(account.id));
    } catch (err) {
      if (isMailboxBusyError(err)) { await this._release(ops); return true; }
      // Nobody knows whether the MOVE went out: the moves are looked up (source first) before
      // anything is sent again.
      for (const op of ops) await this._retryLater(op, err.message, reverted, { unclear: true });
      return false;
    }

    const settled = [];
    let awaiting = false;
    // Copied, but the server kept them at the source too (a server without MOVE that refused the
    // delete, see moveUids). The lookup of an awaiting move checks the source first and would
    // send the COPY again, so one without a uid is dropped for the syncs, which show the letter
    // in both folders, where the server has it.
    const retained = new Set((outcome.sourceRetained || []).map(Number));
    for (const uid of outcome.succeeded) {
      const op = byUid.get(Number(uid));
      if (!op) continue;
      const newUid = outcome.uidMap?.get(Number(uid));
      if (newUid) {
        const s = await this._settle(op, Number(newUid));
        if (s?.row) settled.push(s);
      } else if (!op.message_id_header || retained.has(Number(uid))) {
        // Moved, and nothing can find it by Message-ID: the placeholder goes now rather than
        // showing next to the copy the destination sync is about to insert.
        await this._drop(op);
        awaiting = true;
      } else {
        await this._markAwaiting(op);
        awaiting = true;
      }
    }

    let busy = false;
    if (outcome.failed.length) {
      // The server did not move these. Still at the source: it may pass, retry. Gone from the
      // source: looked for by Message-ID in the destination and the other folders (a MOVE whose
      // answer was lost, another client that moved it); found, the row takes that place. Only a
      // letter that is nowhere (deleted elsewhere, Gmail's web UI included) is reverted.
      let present = null;
      try {
        present = new Set((await mgr.searchUids(account, src, outcome.failed.map(Number), this._poolOpts(account.id))).map(Number));
      } catch (err) {
        if (isMailboxBusyError(err)) {
          await this._release(outcome.failed.map(u => byUid.get(Number(u))).filter(Boolean));
          return true;
        }
        console.warn(`Move queue: source check ${src} failed: ${err.message}`);
      }
      const { rows: destRows } = await query('SELECT 1 FROM folders WHERE account_id = $1 AND path = $2', [account.id, dest]);
      for (const uid of outcome.failed) {
        const op = byUid.get(Number(uid));
        if (!op) continue;
        if (busy) { await this._release([op]); continue; }
        if (present === null) await this._retryLater(op, 'source check failed', reverted, { unclear: true });
        else if (!present.has(Number(uid))) {
          try {
            const s = await this._goneFromSource(account, op, reverted);
            if (s?.row) settled.push(s);
          } catch (err) {
            if (isMailboxBusyError(err)) { busy = true; await this._release([op]); continue; }
            await this._retryLater(op, `looking for the letter failed: ${err.message}`, reverted, { unclear: true });
          }
        } else if (!destRows.length) await this._revertInto(reverted, op, 'destination_gone');
        else await this._retryLater(op, 'the server did not move the letter', reverted);
      }
    }

    await this._storeSettledFlags(account, settled);
    if (settled.some(s => s.needsProviderIds)) mgr._scheduleProviderIdBackfill(account);
    if (awaiting) {
      mgr.syncFolderOnDemand(account, dest, { background: true })
        .catch(err => console.warn(`Move queue: destination sync of ${dest} failed: ${err.message}`));
    }
    if (retained.size) {
      mgr.syncFolderOnDemand(account, src, { background: true })
        .catch(err => console.warn(`Move queue: source sync of ${src} failed: ${err.message}`));
    }
    return busy;
  }

  // Where the letter of a move went, once it is gone from its source: { folder, uid }, or null.
  // Looked for by Message-ID in the destination first, then in the account's other folders
  // (Gmail's All Mail, Starred and Important list letters that live elsewhere, so they prove
  // nothing and are skipped). A uid is taken when no row holds it, or when the row holding it was
  // inserted after the move was queued (a sync that saw the letter arrive before we did). An older
  // row is another copy of the letter and is left alone. Throws on an IMAP failure.
  async _locate(account, op) {
    if (!op.message_id_header) return null;
    const opts = this._poolOpts(account.id);
    // The destination first, alone: where a MOVE whose answer was lost put the letter. Only when
    // it is not there are the other folders searched, one SEARCH per folder (50 to 100 on a Gmail
    // mailbox with labels), which only the rare "moved elsewhere or deleted" case pays for.
    const inDest = await this.mgr.findMessageIdInFolders(account, [op.dest_folder], op.message_id_header, opts);
    const atDest = await this._pickLocated(account, op, inDest, [op.dest_folder]);
    if (atDest) return atDest;
    const { rows: others } = await query(
      `SELECT path FROM folders
        WHERE account_id = $1 AND path <> ALL($2::text[])
          AND COALESCE(special_use, '') <> ALL($3::text[])
        ORDER BY path`,
      [account.id, [op.src_folder, op.dest_folder], VIRTUAL_FOLDER_USES]
    );
    if (!others.length) return null;
    const folders = others.map(r => r.path);
    const found = await this.mgr.findMessageIdInFolders(account, folders, op.message_id_header, opts);
    return this._pickLocated(account, op, found, folders);
  }

  // From SEARCH results ({ folder, uids }), in `folders` order: a uid no row holds, or one whose
  // row was inserted after the move was queued; null when there is none.
  async _pickLocated(account, op, found, folders) {
    const byFolder = new Map(found.map(f => [f.folder, f.uids]));
    for (const folder of folders) {
      const uids = byFolder.get(folder);
      if (!uids?.length) continue;
      const { rows } = await query(
        'SELECT id, uid, synced_at FROM messages WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[])',
        [account.id, folder, uids]
      );
      const held = new Map(rows.map(r => [Number(r.uid), r]));
      const free = uids.filter(u => !held.has(Number(u)));
      if (free.length) return { folder, uid: Math.max(...free) };
      const created = new Date(op.created_at).getTime();
      const newer = rows.filter(r => r.id !== op.message_row_id && r.synced_at && new Date(r.synced_at).getTime() >= created);
      if (newer.length) return { folder, uid: Math.max(...newer.map(r => Number(r.uid))) };
    }
    return null;
  }

  // The letter of a move is gone from its source. Found somewhere, the row takes that place
  // (settle); not found, a move into a folder we do not keep (Gmail All Mail) or of a letter
  // without a Message-ID drops its row for the syncs, and any other move is reverted as gone.
  async _goneFromSource(account, op, reverted) {
    const place = await this._locate(account, op);
    if (place) return this._settle(op, place.uid, place.folder);
    if (op.drop_row || !op.message_id_header) {
      await this._drop(op);
      this.mgr.syncFolderOnDemand(account, op.dest_folder, { background: true })
        .catch(err => console.warn(`Move queue: destination sync of ${op.dest_folder} failed: ${err.message}`));
      return null;
    }
    await this._revertInto(reverted, op, 'gone');
    return null;
  }

  // Moves whose MOVE may have gone out but whose new uid is unknown: no COPYUID, a restart or a
  // failed run cut the answer off. The SOURCE is checked first: a letter still there was never
  // moved, and the move is queued again. Only a letter gone from the source is looked for in the
  // destination by its Message-ID. Looking in the destination first would "find" a letter that is
  // there anyway: on Gmail every letter is in All Mail, and on any server the destination may hold
  // another copy with the same Message-ID. Returns true when the mailbox gave no session.
  async _resolveAwaiting(account, reverted = []) {
    const mgr = this.mgr;
    const { rows } = await query(
      `SELECT * FROM message_moves
        WHERE account_id = $1 AND state = 'awaiting_uid' AND next_attempt_at <= now()
        ORDER BY id LIMIT $2`,
      [account.id, MOVE_CLAIM_LIMIT]
    );
    const settled = [];
    const opts = this._poolOpts(account.id);
    try {
      for (const op of rows) {
        if (this._opHeld(op)) continue; // looked up once the folder change is done
        this._expect(op);
        try {
          const present = await mgr.searchUids(account, op.src_folder, [Number(op.src_uid)], opts);
          if (present.length && Number(op.attempts) >= MOVE_MAX_ATTEMPTS) {
            // Still at the source after every attempt (the last ones ended without an answer).
            await this._revertInto(reverted, op, 'gave_up');
            continue;
          }
          if (present.length) {
            // The MOVE never happened: queue it again (not an attempt: nothing failed here).
            await query(
              `UPDATE message_moves SET state = 'queued', sent_at = NULL, updated_at = now(),
                      next_attempt_at = now() + ($2::int * interval '1 millisecond')
                WHERE id = $1 AND state = 'awaiting_uid'`,
              [op.id, Number(op.attempts) > 0 ? moveRetryDelayMs(Number(op.attempts)) : 0]
            );
            this._unexpect(op);
            continue;
          }
          const s = await this._goneFromSource(account, op, reverted);
          if (s?.row) settled.push(s);
        } catch (err) {
          if (isMailboxBusyError(err)) return true;
          console.warn(`Move queue: looking up moved letter failed: ${err.message}`);
          // A lookup that keeps failing (a folder gone, say) ends like one that finds nothing.
          if (Date.now() - new Date(op.awaiting_since ?? op.updated_at).getTime() > MOVE_AWAITING_UID_MAX_MS) await this._drop(op);
          else await this._lookAgainLater(op);
        }
      }
    } finally {
      await this._storeSettledFlags(account, settled);
      if (settled.some(s => s.needsProviderIds)) mgr._scheduleProviderIdBackfill(account);
    }
    return false;
  }

  async _lookAgainLater(op) {
    await query(`UPDATE message_moves SET next_attempt_at = now() + ($2::int * interval '1 millisecond') WHERE id = $1`, [op.id, MOVE_AWAITING_RETRY_MS]);
  }

  async _markAwaiting(op) {
    await query(
      `UPDATE message_moves SET state = 'awaiting_uid', awaiting_since = now(),
              next_attempt_at = now() + ($2::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND state = 'moving'`,
      [op.id, MOVE_AWAITING_RETRY_MS]
    );
  }

  // A group whose run failed: its moves still 'moving' go back as the sweep would send them.
  async _recover(ops) {
    const { rows } = await query(
      `UPDATE message_moves SET state = CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'awaiting_uid' END,
              awaiting_since = CASE WHEN sent_at IS NULL THEN NULL ELSE now() END,
              next_attempt_at = now() + ($2::int * interval '1 millisecond'), updated_at = now()
        WHERE id = ANY($1::bigint[]) AND state = 'moving'
       RETURNING *`,
      [ops.map(o => o.id), MOVE_AWAITING_RETRY_MS]
    );
    for (const op of rows) if (op.state === 'queued') this._unexpect(op);
  }

  // Back to the queue without an attempt: the mailbox was busy or its logins are held back.
  async _release(ops) {
    if (!ops.length) return;
    await query(
      `UPDATE message_moves SET state = 'queued', updated_at = now() WHERE id = ANY($1::bigint[]) AND state = 'moving'`,
      [ops.map(o => o.id)]
    );
    for (const op of ops) this._unexpect(op);
  }

  // unclear: nobody knows whether the MOVE went out (it threw, or the source could not be checked).
  // The move then waits as awaiting_uid, which checks the source before anything is sent again,
  // and is never reverted from here: the letter may well have moved.
  async _retryLater(op, error, reverted, { unclear = false } = {}) {
    const attempts = Number(op.attempts) + 1;
    if (!unclear && attempts >= MOVE_MAX_ATTEMPTS) {
      console.warn(`Move queue: giving up on move ${op.id} after ${attempts} attempts: ${error}`);
      await this._revertInto(reverted, op, 'gave_up');
      return;
    }
    await query(
      `UPDATE message_moves SET state = $5, attempts = $2, last_error = $3,
              awaiting_since = CASE WHEN $5 = 'awaiting_uid' THEN now() ELSE NULL END,
              next_attempt_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND state = 'moving'`,
      [op.id, attempts, String(error).slice(0, 500), moveRetryDelayMs(attempts), unclear ? 'awaiting_uid' : 'queued']
    );
    if (!unclear) this._unexpect(op);
  }

  // The server moved the letter and named its new uid. The row takes it (or the move that
  // follows it takes it as its source uid). `folder` is where the letter is: the destination, or
  // another folder the letter was found in (_locate: another client moved it there); the row then
  // follows it there, keeping its id, and the counts follow. Returns null when the move was already
  // settled or reverted, else { op, row, uid, folder, needsProviderIds } (row null when no row
  // takes the uid).
  async _settle(op, newUid, folder = null) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query(
        'SELECT id, uid, folder, is_read, provider_message_id FROM messages WHERE id = $1 FOR UPDATE',
        [op.message_row_id]
      );
      const { rows: [cur] } = await tx.query('SELECT * FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      const at = folder ?? cur.dest_folder;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [cur.id]);
      const { rows: [next] } = await tx.query(
        `UPDATE message_moves SET src_folder = $5, src_uid = $2, predecessor_id = NULL,
                set_seen = COALESCE(set_seen, $3), set_flagged = COALESCE(set_flagged, $4), updated_at = now()
          WHERE predecessor_id = $1
         RETURNING *`,
        [cur.id, newUid, cur.set_seen, cur.set_flagged, at]
      );
      if (next) return { op: cur, next, row: null, uid: newUid, folder: at };
      if (!row || Number(row.uid) !== placeholderUid(cur.id)) return { op: cur, row: null, uid: newUid, folder: at };
      if (cur.drop_row && at === cur.dest_folder) {
        await tx.query('DELETE FROM messages WHERE id = $1', [row.id]);
        return { op: cur, row: null, uid: newUid, folder: at };
      }
      // The server may name a uid that already has a row: on Gmail, MOVE into a label the letter
      // already carries answers with that label copy's uid; a sync may have inserted the letter
      // before we heard back. The moved row keeps its id (clients hold it) and the other row goes.
      await tx.query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3 AND id <> $4',
        [cur.account_id, at, newUid, row.id]
      );
      // synced_at keeps a reconcile that took its server snapshot before now from judging the new
      // uid. A flag set while the move was pending gets a fresh local-wins window: the letter
      // arrived with its old flags, and they are stored right after this.
      await tx.query(
        `UPDATE messages SET uid = $2, folder = $5, synced_at = NOW(),
                read_changed_at = CASE WHEN $3::boolean IS NULL THEN read_changed_at ELSE NOW() END,
                star_changed_at = CASE WHEN $4::boolean IS NULL THEN star_changed_at ELSE NOW() END
          WHERE id = $1`,
        [row.id, newUid, cur.set_seen, cur.set_flagged, at]
      );
      return { op: cur, row, uid: newUid, folder: at, needsProviderIds: !row.provider_message_id };
    });
    if (!out) return null;
    this._unguard(out.op.id, { lingerSource: true });
    this._unexpect(out.op);
    if (out.next) {
      this._guard(out.next);
      this.kick(out.next.account_id);
    }
    if (out.row && out.folder !== out.op.dest_folder) {
      // Found elsewhere: the counts and every client follow the letter, quietly (it moved).
      const { op: cur, row, folder: at } = out;
      const unread = row.is_read ? 0 : 1;
      if (!cur.drop_row) adjustFolderCounts(cur.account_id, cur.dest_folder, -1, -unread);
      adjustFolderCounts(cur.account_id, at, 1, unread);
      for (const f of [cur.dest_folder, at]) this.mgr.broadcast({ type: 'folder_updated', folder: f, accountId: cur.account_id });
    }
    return out;
  }

  // The move cannot be done. The row goes back to the letter's server location, or, when a move
  // follows this one, that move starts from there instead. Returns { op, row } for the notice
  // (row null when nothing went back), or null when the move was already settled.
  async _revert(op, reason) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query(
        'SELECT id, uid, folder, is_read FROM messages WHERE id = $1 FOR UPDATE',
        [op.message_row_id]
      );
      const { rows: [cur] } = await tx.query('SELECT * FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [cur.id]);
      const { rows: [next] } = await tx.query(
        `UPDATE message_moves SET src_folder = $2, src_uid = $3, predecessor_id = $4, updated_at = now()
          WHERE predecessor_id = $1
         RETURNING *`,
        [cur.id, cur.src_folder, cur.src_uid, cur.predecessor_id]
      );
      if (next) return { op: cur, next, row: null };
      if (!row || Number(row.uid) !== placeholderUid(cur.id)) return { op: cur, row: null };
      const backUid = cur.src_uid ?? placeholderUid(cur.predecessor_id);
      await tx.query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3 AND id <> $4',
        [cur.account_id, cur.src_folder, backUid, row.id]
      );
      await tx.query('UPDATE messages SET folder = $2, uid = $3, synced_at = NOW() WHERE id = $1', [row.id, cur.src_folder, backUid]);
      return { op: cur, row };
    });
    if (!out) return null;
    this._unguard(out.op.id);
    this._unexpect(out.op);
    if (out.next) {
      this._guard(out.next);
      this.kick(out.next.account_id);
      return out;
    }
    if (out.row) {
      const { op: cur, row } = out;
      const unread = row.is_read ? 0 : 1;
      if (!cur.drop_row) adjustFolderCounts(cur.account_id, cur.dest_folder, -1, -unread);
      adjustFolderCounts(cur.account_id, cur.src_folder, 1, unread);
      // A read/star change made while the move was pending is kept and pushed at the source.
      if (cur.set_seen != null) this.mgr._enqueueFlagPush(cur.account_id, row.id, '\\Seen', cur.set_seen);
      if (cur.set_flagged != null) this.mgr._enqueueFlagPush(cur.account_id, row.id, '\\Flagged', cur.set_flagged);
      console.warn(`Move queue: move ${cur.id} ${cur.src_folder} -> ${cur.dest_folder} reverted (${reason})`);
      // The journal said the user moved (or deleted) the letter; it says it came back too.
      recordAudit({
        actorUserId: cur.moved_by,
        accountId: cur.account_id,
        action: 'message.move_reverted',
        details: { messageId: cur.message_id_header ?? null, from: cur.dest_folder, to: cur.src_folder, reason },
      });
    }
    return out;
  }

  async _revertInto(reverted, op, reason) {
    const out = await this._revert(op, reason);
    if (out?.row) reverted.push({ ...out, reason });
  }

  // Neither place has the letter where we can find it: the move and its row go, and the syncs
  // insert the letter wherever the server has it. A move that follows this one (the letter was
  // moved again meanwhile) waits for a source uid that will never come, so it goes too, with the
  // row when the row is at its placeholder.
  async _drop(op) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query('SELECT id, uid FROM messages WHERE id = $1 FOR UPDATE', [op.message_row_id]);
      const { rows: [cur] } = await tx.query('SELECT id FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [op.id]);
      const { rows: next } = await tx.query('DELETE FROM message_moves WHERE predecessor_id = $1 RETURNING *', [op.id]);
      const ids = [op.id, ...next.map(n => n.id)];
      if (row && ids.some(id => Number(row.uid) === placeholderUid(id))) await tx.query('DELETE FROM messages WHERE id = $1', [row.id]);
      return { next };
    });
    if (!out) return;
    console.warn(`Move queue: move ${op.id} to ${op.dest_folder}: new uid not found, row dropped for the next sync`);
    this._unguard(op.id);
    this._unexpect(op);
    for (const n of out.next) this._unguard(n.id);
  }

  // Read/star changes made while the moves were pending, now stored at the destination. A store
  // that fails goes to the flag-push queue like any other.
  async _storeSettledFlags(account, settled) {
    for (const [flag, col] of Object.entries(FLAG_COLUMNS)) {
      for (const value of [true, false]) {
        const items = settled.filter(s => s.row && s.op[col] === value);
        const byFolder = new Map();
        for (const s of items) {
          const at = s.folder ?? s.op.dest_folder;
          if (!byFolder.has(at)) byFolder.set(at, []);
          byFolder.get(at).push(s);
        }
        for (const [folder, list] of byFolder) {
          try {
            await this.mgr.setFlags(account, folder, list.map(s => s.uid), flag, value, { background: true });
            for (const s of list) this.mgr._resolveFlagPush(account.id, s.row.id, flag);
          } catch (err) {
            console.warn(`Move queue: storing ${flag}=${value} after a move failed: ${err.message}`);
            for (const s of list) this.mgr._enqueueFlagPush(account.id, s.row.id, flag, value);
          }
        }
      }
    }
  }

  // Tell the user whose move it was which rows went back, per source folder (a move from before
  // moved_by existed, or of a deleted user, tells everyone), and refresh every client's lists.
  _notifyReverted(accountId, reverted) {
    if (!reverted.length) return;
    const notices = new Map();
    const folders = new Set();
    for (const { op, row, reason } of reverted) {
      const key = `${op.moved_by ?? ''}\n${op.src_folder}\n${reason}`;
      if (!notices.has(key)) notices.set(key, { userId: op.moved_by ?? null, notice: { folder: op.src_folder, reason, ids: [] } });
      notices.get(key).notice.ids.push(row.id);
      folders.add(op.src_folder);
      folders.add(op.dest_folder);
    }
    for (const { userId, notice } of notices.values()) {
      if (userId) this.mgr.broadcast({ type: 'move_reverted', accountId, ...notice }, userId);
      else this.mgr.broadcast({ type: 'move_reverted', accountId, ...notice });
    }
    for (const folder of folders) this.mgr.broadcast({ type: 'folder_updated', folder, accountId });
  }
}
