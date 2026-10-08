import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  accessSyncForm, accessSyncFormError, accessSyncIdleKey, accessSyncPayload, accessSyncRunNotes, accessSyncRunSummary,
  accessSyncSaveErrorKey, tombstoneReasonKey,
} from '../utils/accessSync.js';
import { adminUserErrorText } from '../utils/adminUsers.js';
import { localeTag } from '../utils/formatDate.js';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const buttonStyle = {
  padding: '9px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };

const ID_FIELDS = [
  { field: 'accountId', labelKey: 'admin.accessSync.accountId' },
  { field: 'appId', labelKey: 'admin.accessSync.appId' },
  { field: 'policyId', labelKey: 'admin.accessSync.policyId' },
];

// Cloudflare Access sync settings, the last run and the deleted users the sync does not import
// again (AUTH_MODE=google). The API token is only ever sent to the server; the form learns just
// whether one is stored.
export default function AccessSyncPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [tombstones, setTombstones] = useState(null);
  const [tombstonesError, setTombstonesError] = useState('');
  const [form, setForm] = useState(() => accessSyncForm(null));
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (next) => {
    setData(next);
    setForm(accessSyncForm(next.config));
  };

  const loadTombstones = () => api.admin.getAccessSyncTombstones()
    .then((next) => { setTombstones(next.tombstones); setTombstonesError(''); })
    .catch((err) => setTombstonesError(err.message));

  useEffect(() => {
    api.admin.getAccessSync()
      .then(apply)
      .catch((err) => setLoadError(err.message));
    loadTombstones();
  }, []);

  if (!data) {
    return (
      <div style={{ color: loadError ? 'var(--red)' : 'var(--text-tertiary)', fontSize: 13 }}>
        {loadError ? t('admin.accessSync.loadFailed', { message: loadError }) : t('common.loading')}
      </div>
    );
  }

  const update = (field, value) => {
    setNotice('');
    setForm((current) => ({ ...current, [field]: value }));
  };

  const act = async (action) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      const key = accessSyncSaveErrorKey(err.code);
      setError(key ? t(key) : err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => act(async () => {
    apply(await api.admin.saveAccessSync(accessSyncPayload(form)));
    setNotice(t('admin.accessSync.saved'));
  });

  // A manual run refreshes the status but keeps unsaved edits in the form.
  const runNow = () => act(async () => {
    const next = await api.admin.runAccessSync();
    setData(next);
    const idleKey = accessSyncIdleKey(next.result);
    if (idleKey) setNotice(t(idleKey));
    await loadTombstones();
  });

  // Clears the tombstone and approves the email; the sync writes it to the policy.
  const allowAgain = (email) => act(async () => {
    try {
      await api.admin.allowUser(email);
    } catch (err) {
      throw new Error(adminUserErrorText(err, t), { cause: err });
    }
    setNotice(t('admin.accessSync.allowed', { email }));
    setTombstones((list) => (list ?? []).filter((entry) => entry.email !== email));
    setData(await api.admin.getAccessSync());
  });

  const formatTime = (iso) => new Date(iso).toLocaleString(localeTag());

  const formErrorKey = accessSyncFormError(form, data.config.apiTokenSet);
  const summary = accessSyncRunSummary(data.lastRun, data.maxDisables);
  const notes = accessSyncRunNotes(data.lastRun, formatTime);
  const troubled = data.lastRun?.outcome === 'failed' || data.lastRun?.outcome === 'aborted';

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.accessSync.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.accessSync.description')}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (!formErrorKey && !busy) save(); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => update('enabled', e.target.checked)} />
          {t('admin.accessSync.enabled')}
        </label>
        {ID_FIELDS.map(({ field, labelKey }) => (
          <label key={field}>
            <span style={labelStyle}>{t(labelKey)}</span>
            <input
              type="text"
              value={form[field]}
              onChange={(e) => update(field, e.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={fieldStyle}
            />
          </label>
        ))}
        <label>
          <span style={labelStyle}>{t('admin.accessSync.apiToken')}</span>
          <input
            type="password"
            value={form.apiToken}
            onChange={(e) => update('apiToken', e.target.value)}
            autoComplete="new-password"
            placeholder={data.config.apiTokenSet ? t('admin.accessSync.apiTokenStored') : undefined}
            style={fieldStyle}
          />
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {t('admin.accessSync.apiTokenHint')}
          </span>
        </label>
        {formErrorKey && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(formErrorKey)}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" disabled={busy || !!formErrorKey} style={primaryButtonStyle}>
            {t('admin.accessSync.save')}
          </button>
          <button type="button" onClick={runNow} disabled={busy} style={buttonStyle}>
            {busy ? t('admin.accessSync.running') : t('admin.accessSync.runNow')}
          </button>
        </div>
      </form>

      <div
        style={{
          marginTop: 20, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-subtle)', fontSize: 13, maxWidth: 520, boxSizing: 'border-box',
        }}
      >
        <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
          {data.lastRun
            ? t('admin.accessSync.lastRun', { time: new Date(data.lastRun.finishedAt).toLocaleString(localeTag()) })
            : t('admin.accessSync.neverRun')}
        </div>
        {summary && (
          <div style={{ color: troubled ? 'var(--red)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {t(summary.key, { ...summary.values, error: summary.errorKey ? t(summary.errorKey) : summary.values.error })}
          </div>
        )}
        {notes.map((note) => (
          <div key={note.key} style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>{t(note.key, note.values)}</div>
        ))}
        <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 6 }}>
          {t('admin.accessSync.limit', { max: data.maxDisables, maxImports: data.maxImports })}
        </div>
      </div>

      <div style={{ marginTop: 24, maxWidth: 520 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.accessSync.tombstonesTitle')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
          {t('admin.accessSync.tombstonesDesc')}
        </div>
        {tombstonesError && (
          <div style={{ fontSize: 13, color: 'var(--red)' }}>{t('admin.accessSync.tombstonesLoadFailed', { message: tombstonesError })}</div>
        )}
        {!tombstonesError && tombstones?.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.accessSync.tombstonesEmpty')}</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(tombstones ?? []).map((entry) => {
            const date = new Date(entry.createdAt).toLocaleDateString(localeTag());
            return (
              <div
                key={entry.email}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{entry.email}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {t(tombstoneReasonKey(entry.reason))}
                    {' · '}
                    {entry.createdBy
                      ? t('admin.accessSync.tombstoneMeta', { date, by: entry.createdBy })
                      : date}
                    {entry.inPolicy && ` · ${t('admin.accessSync.tombstoneInPolicy')}`}
                  </div>
                </div>
                <button type="button" disabled={busy} onClick={() => allowAgain(entry.email)} style={{ ...buttonStyle, padding: '5px 10px', fontSize: 12 }}>
                  {t('admin.accessSync.allowAgain')}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {!data.googleMode && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.accessSync.notGoogleMode')}</div>
      )}
      {error && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--red)' }}>{error}</div>}
      {notice && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{notice}</div>}
    </div>
  );
}
