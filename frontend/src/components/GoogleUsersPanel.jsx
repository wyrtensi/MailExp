import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';
import { localeTag } from '../utils/formatDate.js';
import { adminUserErrorText } from '../utils/adminUsers.js';

const PAGE_SIZE = 200;

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
  background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
};
const badgeStyle = {
  fontSize: 10, padding: '2px 6px', borderRadius: 20, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase',
};
const actionStyle = {
  padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
};

// Users screen for AUTH_MODE=google: approving an email is what lets a person sign in, and every
// signed-in user works with all mailboxes.
export default function GoogleUsersPanel() {
  const { t } = useTranslation();
  const { user: currentUser } = useStore();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  // The last failed request (an Error with the server's code), explained at render.
  const [error, setError] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    api.admin.getUsers({ limit: PAGE_SIZE, offset: 0 })
      .then((data) => { setUsers(data.users); setTotal(data.total); })
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }, []);

  const upsert = (next) => setUsers((list) => (list.some((u) => u.id === next.id)
    ? list.map((u) => (u.id === next.id ? next : u))
    : [...list, next]));

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // The last admin, a bootstrap admin, a taken email: explained rather than the server's text.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const approve = () => run(async () => {
    const data = await api.admin.createUser(email.trim());
    if (!users.some((u) => u.id === data.user.id)) setTotal((count) => count + 1);
    upsert(data.user);
    setEmail('');
  });

  const toggleAdmin = (u) => run(async () => {
    upsert((await api.admin.updateUser(u.id, { isAdmin: !u.isAdmin })).user);
  });

  const toggleDisabled = (u) => run(async () => {
    upsert((await api.admin.updateUser(u.id, { disabled: !u.disabledAt })).user);
  });

  const loadMore = () => run(async () => {
    const data = await api.admin.getUsers({ limit: PAGE_SIZE, offset: users.length });
    setUsers((list) => [...list, ...data.users]);
    setTotal(data.total);
  });

  const remove = (u) => setConfirmDialog({
    title: t('admin.users.deleteConfirmTitle', { username: u.email || u.username }),
    message: t('admin.users.deleteConfirmBody'),
    confirmLabel: t('admin.users.deleteConfirmLabel'),
    onConfirm: async () => {
      await api.admin.deleteUser(u.id).catch((err) => { throw new Error(adminUserErrorText(err, t), { cause: err }); });
      setUsers((list) => list.filter((x) => x.id !== u.id));
      setTotal((count) => count - 1);
    },
  });

  if (loading) {
    return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;
  }

  const canApprove = email.includes('@') && !busy;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.users.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.users.googleDesc')}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (canApprove) approve(); }}
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('admin.users.addPh')}
          style={{
            flex: 1, padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={!canApprove}
          style={{
            padding: '9px 16px', background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500, flexShrink: 0,
            cursor: canApprove ? 'pointer' : 'not-allowed', opacity: canApprove ? 1 : 0.6,
          }}
        >
          {t('admin.users.add')}
        </button>
      </form>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
          background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--red)',
        }}>{adminUserErrorText(error, t)}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {users.map((u) => {
          const self = u.id === currentUser?.id;
          return (
            <div key={u.id} style={{ ...rowStyle, opacity: u.disabledAt ? 0.6 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {u.email || u.username}
                  </span>
                  {u.isAdmin && (
                    <span style={{ ...badgeStyle, background: 'rgba(124,106,247,0.15)', color: 'var(--accent)' }}>
                      {t('admin.users.adminBadge')}
                    </span>
                  )}
                  {u.disabledAt && (
                    <span style={{ ...badgeStyle, background: 'rgba(248,113,113,0.12)', color: 'var(--red)' }}>
                      {t('admin.users.disabledBadge')}
                    </span>
                  )}
                  {self && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t('admin.users.you')}</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {!u.email
                    ? t('admin.users.noEmail')
                    : u.isBootstrapAdmin
                      ? t('admin.users.bootstrapBadge')
                      : t('admin.users.joined', { date: new Date(u.created_at).toLocaleDateString(localeTag()) })}
                </div>
              </div>
              {!self && !u.isBootstrapAdmin && (
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  <button type="button" disabled={busy} onClick={() => toggleAdmin(u)} style={actionStyle}>
                    {u.isAdmin ? t('admin.users.removeAdmin') : t('admin.users.makeAdmin')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => toggleDisabled(u)} style={actionStyle}>
                    {u.disabledAt ? t('admin.users.enable') : t('admin.users.disable')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => remove(u)} style={{ ...actionStyle, color: 'var(--red)' }}>
                    {t('admin.users.deleteUser')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {users.length < total && (
        <button type="button" disabled={busy} onClick={loadMore} style={{ ...actionStyle, marginTop: 10 }}>
          {t('common.loadMore')}
        </button>
      )}
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
  );
}
