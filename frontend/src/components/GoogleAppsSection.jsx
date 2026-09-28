import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { buildGoogleRedirectUri } from '../utils/googleOAuth.js';
import {
  GOOGLE_APP_SCOPES,
  canDeleteGoogleApp,
  googleAppErrorKey,
  googleAppForm,
  googleAppFormError,
  googleAppPayload,
  googleAppSeatsText,
  googleAppStateKey,
  googleAppStatusActions,
  googleAppWarningKey,
  googleCallbackAltUri,
  googleCallbackFormError,
  parseGoogleClientJsonPreview,
  shortClientId,
} from '../utils/googleApps.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';

const fieldStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const monoFieldStyle = { ...fieldStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4 };
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const buttonStyle = {
  padding: '7px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const noteBoxStyle = {
  padding: '12px 14px', borderRadius: 8, marginBottom: 16, background: 'rgba(124,106,247,0.06)',
  border: '1px solid rgba(124,106,247,0.15)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7,
};
const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', fontSize: 13, textAlign: 'left' };
const headCellStyle = { ...cellStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' };

// Settings -> Integrations -> "Google apps" (admins only). Each app is one Google Cloud project
// with its own 100-user cap; MailExpert picks the app per mailbox. Secrets are only ever sent.
export default function GoogleAppsSection() {
  const { t } = useTranslation();
  const [apps, setApps] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [callback, setCallback] = useState('');
  const [storedCallback, setStoredCallback] = useState('');
  const [editing, setEditing] = useState(null); // null | { app: App|null, form }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const fileInputRef = useRef(null);
  // The setup instructions default open only while there's no app yet to skip past them for;
  // once that first load resolves, later app list changes (adding/removing an app) don't
  // fight a manual expand/collapse the admin made in the meantime.
  const [setupOpen, setSetupOpen] = useState(false);
  const setupOpenInitialized = useRef(false);

  const suggestedCallback = buildGoogleRedirectUri(window.location);

  const messageFor = (err) => {
    const key = googleAppErrorKey(err?.code);
    return key ? t(key) : (err?.message || t('admin.integrations.googleApps.errorGeneric'));
  };

  const reload = () => api.admin.googleApps.list()
    .then((data) => { setApps(data.apps); setLoadError(''); })
    .catch((err) => setLoadError(err.message));

  useEffect(() => {
    reload();
    api.getIntegrations()
      .then((data) => {
        const stored = data?.google?.redirectUri || '';
        setStoredCallback(stored);
        setCallback(stored || suggestedCallback);
      })
      .catch(() => setCallback(suggestedCallback));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once; reload/suggestedCallback are stable for the page

  useEffect(() => {
    if (apps === null || setupOpenInitialized.current) return;
    setupOpenInitialized.current = true;
    setSetupOpen(apps.length === 0);
  }, [apps]);

  const act = async (action) => {
    setBusy(true);
    setError('');
    setNotice('');
    setWarnings([]);
    try {
      await action();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const callbackErrorKey = googleCallbackFormError(callback);
  const saveCallback = () => act(async () => {
    const redirectUri = callback.trim();
    await api.saveIntegration('google', { redirectUri });
    setStoredCallback(redirectUri);
    setCallback(redirectUri);
    setNotice(t('admin.integrations.googleApps.callbackSaved'));
  });

  const copyCallback = () => act(async () => {
    await copyToClipboard(callback.trim());
    setNotice(t('admin.integrations.googleApps.callbackCopied'));
  });

  const replaceApp = (next) => setApps((list) => list.map((a) => (a.id === next.id ? next : a)));

  const formErrorKey = editing ? googleAppFormError(editing.form, { editing: !!editing.app }) : null;
  const updateForm = (field, value) => setEditing((cur) => ({ ...cur, form: { ...cur.form, [field]: value } }));

  // Reads a dropped or picked client JSON file, fills clientId and (when still empty) label from
  // it for immediate feedback, and leaves the raw text in form.clientJson for googleAppPayload to
  // send. A file that does not parse is still kept: formErrorKey then explains what is wrong.
  const applyImportedFile = (text) => {
    setError('');
    const preview = parseGoogleClientJsonPreview(text);
    setEditing((cur) => {
      if (!cur || cur.app) return cur;
      return {
        ...cur,
        form: {
          ...cur.form,
          clientJson: text,
          clientId: preview.ok ? preview.clientId : cur.form.clientId,
          label: preview.ok && !cur.form.label.trim() ? preview.projectId : cur.form.label,
        },
      };
    });
  };

  const clearImport = () => setEditing((cur) => (
    cur ? { ...cur, form: { ...cur.form, clientJson: '', clientId: '', clientSecret: '' } } : cur
  ));

  const pickImportFile = () => fileInputRef.current?.click();
  const onImportFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) applyImportedFile(await file.text());
  };
  const onFormDrop = async (e) => {
    if (!editing || editing.app) return;
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) applyImportedFile(await file.text());
  };

  const saveApp = () => act(async () => {
    const isEdit = !!editing.app;
    const body = googleAppPayload(editing.form, { editing: isEdit });
    let createdWarnings = [];
    if (isEdit) {
      replaceApp((await api.admin.googleApps.update(editing.app.id, body)).app);
    } else {
      const { app, warnings: created } = await api.admin.googleApps.create(body);
      setApps((list) => [...list, app]);
      createdWarnings = created || [];
    }
    setEditing(null);
    setWarnings(createdWarnings);
    setNotice(t('admin.integrations.googleApps.saved'));
  });

  const setStatus = (app, status) => api.admin.googleApps.update(app.id, { status })
    .then(({ app: next }) => replaceApp(next));

  const changeStatus = (app, action) => {
    if (!action.confirm) {
      act(() => setStatus(app, action.status));
      return;
    }
    setConfirmDialog({
      title: t('admin.integrations.googleApps.disableConfirmTitle', { label: app.label }),
      message: t('admin.integrations.googleApps.disableConfirm', { count: app.accountsCount }),
      confirmLabel: t('admin.integrations.googleApps.disable'),
      onConfirm: async () => {
        try {
          await setStatus(app, action.status);
        } catch (err) {
          throw new Error(messageFor(err), { cause: err });
        }
      },
    });
  };

  const removeApp = (app) => setConfirmDialog({
    title: t('admin.integrations.googleApps.deleteConfirmTitle', { label: app.label }),
    message: t('admin.integrations.googleApps.deleteConfirm'),
    confirmLabel: t('common.delete'),
    onConfirm: async () => {
      try {
        await api.admin.googleApps.remove(app.id);
      } catch (err) {
        throw new Error(messageFor(err), { cause: err });
      }
      setApps((list) => list.filter((a) => a.id !== app.id));
    },
  });

  const altCallback = googleCallbackAltUri(storedCallback, window.location.origin);

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
        {t('admin.integrations.googleApps.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 16 }}>
        {t('admin.integrations.googleApps.description')}
      </div>

      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />

      <label style={{ display: 'block', marginBottom: 16 }}>
        <span style={labelStyle}>{t('admin.integrations.googleApps.callbackLabel')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={callback} onChange={(e) => setCallback(e.target.value)} spellCheck={false} style={monoFieldStyle} />
          <button type="button" onClick={copyCallback} disabled={busy || !!callbackErrorKey} style={buttonStyle}>
            {t('common.copy')}
          </button>
          <button type="button" onClick={saveCallback} disabled={busy || !!callbackErrorKey || callback.trim() === storedCallback} style={primaryButtonStyle}>
            {t('common.save')}
          </button>
        </div>
        <span style={hintStyle}>
          {storedCallback ? t('admin.integrations.googleApps.callbackNote') : t('admin.integrations.googleApps.callbackNotSaved')}
        </span>
        {altCallback && (
          <span style={hintStyle}>{t('admin.integrations.googleApps.callbackOtherHost', { uri: altCallback })}</span>
        )}
      </label>

      <details style={noteBoxStyle} open={setupOpen} onToggle={(e) => setSetupOpen(e.currentTarget.open)}>
        <summary style={{ fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>
          {t('admin.integrations.googleApps.setupTitle')}
        </summary>
        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>{t('admin.integrations.googleApps.step1')}</li>
          <li>{t('admin.integrations.googleApps.step2')}</li>
          <li>{t('admin.integrations.googleApps.step3', { scopes: GOOGLE_APP_SCOPES })}</li>
          <li>{t('admin.integrations.googleApps.step4')}</li>
          <li>{t('admin.integrations.googleApps.step5')}</li>
        </ol>
      </details>

      {!apps && (
        <div style={{ color: loadError ? 'var(--red)' : 'var(--text-tertiary)', fontSize: 13 }}>
          {loadError ? t('admin.integrations.googleApps.loadFailed', { message: loadError }) : t('common.loading')}
        </div>
      )}

      {apps && apps.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
          {t('admin.integrations.googleApps.empty')}
        </div>
      )}

      {apps && apps.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnLabel')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.clientId')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnSeats')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnAccounts')}</th>
                <th style={headCellStyle}>{t('admin.integrations.googleApps.columnState')}</th>
                <th style={headCellStyle} />
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const stateKey = googleAppStateKey(app);
                return (
                  <tr key={app.id}>
                    <td style={cellStyle}>{app.label}</td>
                    <td style={{ ...cellStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} title={app.clientId}>
                      {shortClientId(app.clientId)}
                    </td>
                    <td style={cellStyle}>{googleAppSeatsText(app)}</td>
                    <td style={cellStyle}>{app.accountsCount}</td>
                    <td style={cellStyle}>{stateKey ? t(stateKey) : app.status}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button type="button" disabled={busy} style={buttonStyle}
                          onClick={() => { setError(''); setEditing({ app, form: googleAppForm(app) }); }}>
                          {t('common.edit')}
                        </button>
                        {googleAppStatusActions(app).map((action) => (
                          <button key={action.status} type="button" disabled={busy} style={buttonStyle}
                            onClick={() => changeStatus(app, action)}>
                            {t(action.labelKey)}
                          </button>
                        ))}
                        <button type="button" disabled={busy || !canDeleteGoogleApp(app)} style={buttonStyle}
                          title={canDeleteGoogleApp(app) ? undefined : t('admin.integrations.googleApps.deleteInUse')}
                          onClick={() => removeApp(app)}>
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (!formErrorKey && !busy) saveApp(); }}
          onDragOver={(e) => { if (!editing.app) e.preventDefault(); }}
          onDrop={onFormDrop}
          style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520, marginTop: 8 }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {editing.app ? t('admin.integrations.googleApps.formTitleEdit') : t('admin.integrations.googleApps.formTitleAdd')}
          </div>
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.columnLabel')}</span>
            <input value={editing.form.label} onChange={(e) => updateForm('label', e.target.value)} style={fieldStyle} />
          </label>
          {!editing.app && (
            <div>
              <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImportFileChange} />
              <button type="button" disabled={busy} style={buttonStyle} onClick={pickImportFile}>
                {t('admin.integrations.googleApps.importButton')}
              </button>
              <span style={{ ...hintStyle, marginTop: 6 }}>{t('admin.integrations.googleApps.importDropHint')}</span>
            </div>
          )}
          {!editing.app && editing.form.clientJson ? (
            <div style={{ ...noteBoxStyle, marginBottom: 0 }}>
              <div>{t('admin.integrations.googleApps.clientId')}: <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{editing.form.clientId || '—'}</span></div>
              <button type="button" disabled={busy} style={{ ...buttonStyle, marginTop: 8 }} onClick={clearImport}>
                {t('admin.integrations.googleApps.importClear')}
              </button>
            </div>
          ) : (
            <>
              <label>
                <span style={labelStyle}>{t('admin.integrations.googleApps.clientId')}</span>
                <input value={editing.form.clientId} onChange={(e) => updateForm('clientId', e.target.value)}
                  disabled={!!editing.app} spellCheck={false} autoComplete="off"
                  placeholder={t('admin.integrations.googleApps.clientIdPh')} style={monoFieldStyle} />
                {editing.app && <span style={hintStyle}>{t('admin.integrations.googleApps.clientIdFixed')}</span>}
              </label>
              <label>
                <span style={labelStyle}>{t('admin.integrations.googleApps.clientSecret')}</span>
                <input type="password" autoComplete="new-password" value={editing.form.clientSecret}
                  onChange={(e) => updateForm('clientSecret', e.target.value)} style={fieldStyle} />
                {editing.app && <span style={hintStyle}>{t('admin.integrations.googleApps.clientSecretKeep')}</span>}
              </label>
            </>
          )}
          <label>
            <span style={labelStyle}>{t('admin.integrations.googleApps.userLimit')}</span>
            <input inputMode="numeric" value={editing.form.userLimit} onChange={(e) => updateForm('userLimit', e.target.value)} style={fieldStyle} />
            <span style={hintStyle}>{t('admin.integrations.googleApps.userLimitHint')}</span>
          </label>
          {formErrorKey && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(formErrorKey)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !!formErrorKey} style={primaryButtonStyle}>{t('common.save')}</button>
            <button type="button" disabled={busy} style={buttonStyle} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          </div>
        </form>
      ) : (
        <button type="button" disabled={busy || !apps} style={primaryButtonStyle}
          onClick={() => { setError(''); setNotice(''); setWarnings([]); setEditing({ app: null, form: googleAppForm(null) }); }}>
          {t('admin.integrations.googleApps.add')}
        </button>
      )}

      {error && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--red)' }}>{error}</div>}
      {notice && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{notice}</div>}
      {warnings.map((warning, i) => {
        const key = googleAppWarningKey(warning.code);
        if (!key) return null;
        return (
          <div key={i} style={{ marginTop: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t(key, { uri: warning.expected })}
          </div>
        );
      })}
    </div>
  );
}
