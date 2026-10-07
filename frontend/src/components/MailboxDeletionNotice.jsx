import { useTranslation } from 'react-i18next';
import MailNodeSeats from './MailNodeSeats.jsx';
import {
  isDeactivated, mailNodeErrorKey, pendingDeletion, seatsView, tenantPending,
} from '../utils/mailNode.js';
import { formatDateTime } from '../utils/formatDate.js';

// A mail node mailbox deactivated, or one pending deletion, is read-only (EOP seats design,
// 2026-10-07; deletion: owner decision 2026-10-01): its seat is on hold, incoming mail is refused,
// it cannot send; its letters stay readable. These say so wherever the mailbox shows, so nobody is
// surprised. Reasons are the person's own text, rendered as text only.

// One line for the sidebar and other places the mailbox is worked with: "Deactivated" or "Deleted on
// <date>", and "read-only".
export function ReadOnlyLine({ account, style }) {
  const { t } = useTranslation();
  const pending = pendingDeletion(account);
  const off = isDeactivated(account);
  if (!pending && !off) return null;
  return (
    <div data-pending-deletion-line={pending ? '' : undefined} data-read-only-line style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>
      {pending ? t('sidebar.pendingDeletion', { date: formatDateTime(pending.deleteAfter) }) : t('sidebar.deactivated')}
      {' · '}{t('sidebar.readOnly')}
    </div>
  );
}

// Kept under its old name for the places that import it.
export const PendingDeletionLine = ReadOnlyLine;

// R-32 with DBEB (stage 7b): the mailbox's domain is Authoritative and the tenant has no recipient
// for it yet, so mail to it is still rejected; the mirror makes the recipient within minutes.
export function TenantPendingLine({ account, style }) {
  const { t } = useTranslation();
  if (!tenantPending(account)) return null;
  return (
    <div data-tenant-pending-line style={{ fontSize: 11, color: '#b45309', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>
      {t('sidebar.tenantPending')}
    </div>
  );
}

// Whether the mailbox's own seat is still on hold (the address is among the held seats).
const holdsOwnSeat = (account, seats) => (seats?.heldSeats ?? []).some((s) => s.email === String(account.email_address).toLowerCase());

// Taking the mailbox back costs a seat unless its own is still on hold.
const seatBlocked = (account, seats) => {
  const view = seatsView(seats);
  if (!view) return false;
  return !holdsOwnSeat(account, seats) && !view.canTake;
};

// Taking the mailbox back costs a seat unless its own is still on hold: the line says which, and at
// 0 free offers "Request seats". takes(free): the line for a seat taken from the free ones.
function SeatLine({ account, seats, onSeatsChanged, takes }) {
  const { t } = useTranslation();
  const view = seatsView(seats);
  if (!view) return null;
  const heldOwn = holdsOwnSeat(account, seats);
  const blocked = !heldOwn && !view.canTake;
  return (
    <>
      <div data-cancel-seat style={{ color: blocked ? 'var(--red)' : 'var(--text-tertiary)' }}>
        {heldOwn && t('admin.mailNode.seats.ownSeatHeld')}
        {!heldOwn && (blocked ? t('admin.mailNode.seats.cancelNoFree') : takes(view.free))}
      </div>
      {blocked && <MailNodeSeats seats={seats} compact onChanged={onSeatsChanged} />}
    </>
  );
}

// The settings list: the date, who asked, when and why, why the deletion job could not delete it
// yet, that it is read-only, and "Cancel deletion" for anyone signed in (it takes the mailbox's seat
// back, so it waits for a free one when its own is gone; a deactivated mailbox stays deactivated).
export default function MailboxDeletionNotice({ account, onCancel, busy = false, seats = null, onSeatsChanged = () => {} }) {
  const { t } = useTranslation();
  const pending = pendingDeletion(account);
  if (!pending) return null;
  const takesSeat = !isDeactivated(account);
  const blocked = takesSeat && seatBlocked(account, seats);
  const off = busy || blocked;
  return (
    <div data-pending-deletion={account.id} style={{
      padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(248,113,113,0.08)',
      display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>
        <div style={{ fontWeight: 600 }}>{t('admin.accounts.deletion.pendingBadge', { date: formatDateTime(pending.deleteAfter) })}</div>
        <div data-deletion-reason style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {t('admin.accounts.deletion.why', {
            reason: pending.reason, by: pending.requestedBy || t('admin.mailNode.someone'), at: formatDateTime(pending.requestedAt),
          })}
        </div>
        <div data-read-only style={{ color: 'var(--text-secondary)' }}>{t('admin.mailNode.seats.readOnlyNotice')}</div>
        {takesSeat && (
          <SeatLine
            account={account}
            seats={seats}
            onSeatsChanged={onSeatsChanged}
            takes={(free) => t('admin.mailNode.seats.cancelTakesSeat', { free })}
          />
        )}
        {pending.lastError && (
          <div data-deletion-error data-code={pending.lastError} style={{ color: 'var(--red)' }}>
            {t('admin.accounts.deletion.lastError', { error: t(mailNodeErrorKey(pending.lastError)) })}
          </div>
        )}
      </div>
      <button type="button" onClick={() => onCancel?.(account.id)} disabled={off} aria-busy={busy} style={{
        padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
        color: 'var(--text-primary)', cursor: off ? 'default' : 'pointer', opacity: off ? 0.6 : 1,
        fontSize: 12, fontWeight: 500, flexShrink: 0,
      }}>
        {t('admin.accounts.deletion.cancel')}
      </button>
    </div>
  );
}

// A deactivated mailbox in the settings list: when, by whom and why; "Activate" for administrators
// (its own seat back while on hold, else a free one).
export function MailboxDeactivatedNotice({ account, seats = null, isAdmin = false, onActivate, busy = false, onSeatsChanged = () => {} }) {
  const { t } = useTranslation();
  if (!isDeactivated(account) || pendingDeletion(account)) return null;
  const blocked = seatBlocked(account, seats);
  return (
    <div data-deactivated={account.id} style={{
      padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(148,163,184,0.10)',
      display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>
        <div style={{ fontWeight: 600 }}>{t('admin.accounts.deactivation.badge')}</div>
        <div data-deactivation-reason style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {t('admin.accounts.deactivation.why', {
            reason: account.deactivation_reason ?? '', by: account.deactivated_by_email || t('admin.mailNode.someone'),
            at: formatDateTime(account.deactivated_at),
          })}
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>{t('admin.mailNode.seats.readOnlyNotice')}</div>
        {isAdmin && (
          <SeatLine
            account={account}
            seats={seats}
            onSeatsChanged={onSeatsChanged}
            takes={(free) => t('admin.mailNode.seats.activateTakesSeat', { free })}
          />
        )}
      </div>
      {isAdmin && (
        <button type="button" onClick={() => onActivate?.(account.id)} disabled={busy || blocked} aria-busy={busy} style={{
          padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text-primary)', cursor: busy || blocked ? 'default' : 'pointer', opacity: busy || blocked ? 0.6 : 1,
          fontSize: 12, fontWeight: 500, flexShrink: 0,
        }}>
          {t('admin.accounts.deactivation.activate')}
        </button>
      )}
    </div>
  );
}
