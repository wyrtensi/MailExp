import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from '../utils/auditLog.js';
import { localeTag } from '../utils/formatDate.js';

const EMPTY_FILTERS = { account: '', user: '', action: '', fromDate: '', toDate: '' };

const controlStyle = {
  padding: '7px 10px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 7, outline: 'none', minWidth: 0,
};
const headCellStyle = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textAlign: 'left',
  textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const cellStyle = {
  padding: '8px 10px', fontSize: 13, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)',
  verticalAlign: 'top', wordBreak: 'break-word',
};
const buttonStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500, background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer',
};

// Admin-only: what users did with the shared mailboxes, messages and users, newest first.
export default function AuditLogTab() {
  const { t } = useTranslation();
  const accounts = useStore((state) => state.accounts);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [users, setUsers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Only the newest request may fill the list: a slow page for old filters must not land late.
  const requestSeq = useRef(0);

  useEffect(() => {
    api.admin.getUsers({ limit: 200, offset: 0 })
      .then((data) => setUsers(Array.isArray(data?.users) ? data.users : []))
      .catch(() => setUsers([]));
  }, []);

  const describeError = useCallback((err) => (
    err?.code === 'invalid_filter' ? t('admin.audit.invalidFilter') : t('admin.audit.loadFailed', { message: err?.message ?? '' })
  ), [t]);

  // A filter change starts over from the newest entry.
  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await api.admin.getAuditLog(auditQuery(filters));
      if (seq !== requestSeq.current) return;
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setEntries([]);
      setNextCursor(null);
      setError(describeError(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filters, describeError]);

  useEffect(() => { reload(); }, [reload]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError('');
    try {
      const data = await api.admin.getAuditLog(auditQuery({ ...filters, before: nextCursor }));
      if (seq !== requestSeq.current) return;
      setEntries((previous) => [...previous, ...(Array.isArray(data?.entries) ? data.entries : [])]);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      if (seq === requestSeq.current) setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const setFilter = (name) => (event) => {
    const { value } = event.target;
    setFilters((previous) => ({ ...previous, [name]: value }));
  };

  const detailText = (entry) => {
    const detail = auditDetail(entry);
    if (!detail) return '';
    if (!detail.key) return detail.text;
    const translated = Object.fromEntries(Object.entries(detail.valueKeys ?? {}).map(([name, key]) => (
      [name, Array.isArray(key) ? key.map((k) => t(k)).join(', ') : t(key)]
    )));
    return t(detail.key, { ...detail.values, ...translated });
  };

  const actionText = (action) => {
    const key = auditActionLabelKey(action);
    return key ? t(key) : action;
  };

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '20px 24px', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('admin.tabs.audit')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.audit.description')}</div>
        </div>
        <button type="button" onClick={reload} disabled={loading} style={buttonStyle}>
          {t('admin.security.activityRefresh')}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
        <select aria-label={t('admin.audit.mailbox')} value={filters.account} onChange={setFilter('account')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allMailboxes')}</option>
          {(accounts || []).map((account) => (
            <option key={account.id} value={account.id}>{account.name || account.email_address}</option>
          ))}
        </select>
        <select aria-label={t('admin.security.activityColUser')} value={filters.user} onChange={setFilter('user')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allUsers')}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.email || user.username}</option>
          ))}
        </select>
        <select aria-label={t('admin.audit.action')} value={filters.action} onChange={setFilter('action')} style={{ ...controlStyle, flex: '1 1 180px' }}>
          <option value="">{t('admin.audit.allActions')}</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>{actionText(action)}</option>
          ))}
        </select>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 1 150px', minWidth: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
          {t('admin.audit.fromDate')}
          <input type="date" value={filters.fromDate} onChange={setFilter('fromDate')} style={controlStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 1 150px', minWidth: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
          {t('admin.audit.toDate')}
          <input type="date" value={filters.toDate} onChange={setFilter('toDate')} style={controlStyle} />
        </label>
      </div>

      {error && <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.security.activityLoading')}</div>
      ) : entries.length === 0 ? (
        !error && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.audit.empty')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('admin.security.activityColTime')}</th>
                <th style={headCellStyle}>{t('admin.security.activityColUser')}</th>
                <th style={headCellStyle}>{t('admin.audit.mailbox')}</th>
                <th style={headCellStyle}>{t('admin.audit.action')}</th>
                <th style={headCellStyle}>{t('admin.audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{new Date(entry.occurredAt).toLocaleString(localeTag())}</td>
                  <td style={cellStyle}>{entry.actorEmail || t('admin.audit.unknownUser')}</td>
                  <td style={cellStyle}>{entry.accountEmail || ''}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-primary)' }}>{actionText(entry.action)}</td>
                  <td style={cellStyle}>{detailText(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && nextCursor && (
        <button type="button" onClick={loadMore} disabled={loadingMore} style={{ ...buttonStyle, marginTop: 12 }}>
          {loadingMore ? t('admin.security.activityLoading') : t('common.loadMore')}
        </button>
      )}
    </div>
  );
}
