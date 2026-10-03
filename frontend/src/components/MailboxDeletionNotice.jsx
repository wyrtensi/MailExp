import { useTranslation } from 'react-i18next';
import { mailNodeErrorKey, pendingDeletion, tenantPending } from '../utils/mailNode.js';
import { formatDateTime } from '../utils/formatDate.js';

// A mail node mailbox someone asked to delete keeps working until its date (owner decision
// 2026-10-01). These say so wherever the mailbox shows, so nobody is surprised. The reason is the
// requester's own text and is rendered as text only.

// One line for the sidebar and other places the mailbox is worked with: "Deleted on <date>".
export function PendingDeletionLine({ account, style }) {
  const { t } = useTranslation();
  const pending = pendingDeletion(account);
  if (!pending) return null;
  return (
    <div data-pending-deletion-line style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>
      {t('sidebar.pendingDeletion', { date: formatDateTime(pending.deleteAfter) })}
    </div>
  );
}

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

// The settings list: the date, who asked, when and why, why the deletion job could not delete it
// yet, and "Cancel deletion" for anyone signed in.
export default function MailboxDeletionNotice({ account, onCancel, busy = false }) {
  const { t } = useTranslation();
  const pending = pendingDeletion(account);
  if (!pending) return null;
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
        {pending.lastError && (
          <div data-deletion-error data-code={pending.lastError} style={{ color: 'var(--red)' }}>
            {t('admin.accounts.deletion.lastError', { error: t(mailNodeErrorKey(pending.lastError)) })}
          </div>
        )}
      </div>
      <button type="button" onClick={() => onCancel?.(account.id)} disabled={busy} aria-busy={busy} style={{
        padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
        color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        fontSize: 12, fontWeight: 500, flexShrink: 0,
      }}>
        {t('admin.accounts.deletion.cancel')}
      </button>
    </div>
  );
}
