import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { apiErrorText } from '../utils/apiErrors.js';
import { SETTINGS_ERROR_KEYS } from '../utils/adminErrors.js';
import { FOLDER_SYNC_INTERVAL_CHOICES_SEC, SYNC_INTERVAL_CHOICES_SEC, readSyncIntervals } from '../utils/mailboxSync.js';

const SETTING_KEYS = { syncIntervalSec: 'sync_interval_sec', folderSyncIntervalSec: 'folder_sync_interval_sec' };
const SYNC_LABELS = { 15: '15s', 30: '30s', 60: '60s', 120: '2 min' };
const FOLDER_LABELS = { 900: '15 min', 1800: '30 min', 3600: '1 hour' };
// "Never" goes last, as in the personal settings these pickers came from.
const FOLDER_CHOICE_ORDER = [...FOLDER_SYNC_INTERVAL_CHOICES_SEC.filter((seconds) => seconds > 0), 0];

// Admin-only: how often the server syncs every mailbox. Mailboxes are serviced by the server, so
// this is one install-wide setting rather than a personal preference.
export default function MailboxSyncSettings() {
  const { t } = useTranslation();
  const [values, setValues] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.admin.getSettings()
      .then((data) => setValues(readSyncIntervals(data.settings)))
      .catch((err) => setError(err.message));
  }, []);

  const choose = async (field, seconds) => {
    if (!values || values[field] === seconds) return;
    const previous = values;
    setValues({ ...values, [field]: seconds });
    setError('');
    try {
      await api.admin.updateSettings({ [SETTING_KEYS[field]]: seconds });
      // This browser's refresh fallback follows the message interval right away.
      if (field === 'syncIntervalSec') useStore.setState({ syncInterval: seconds });
    } catch (err) {
      setValues(previous);
      setError(apiErrorText(err, t, { keys: SETTINGS_ERROR_KEYS }));
    }
  };

  const renderChoices = (field, title, desc, choices, labelFor) => (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 10 }}>{desc}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {choices.map((seconds) => {
          const active = values?.[field] === seconds;
          return (
            <button
              key={seconds}
              type="button"
              disabled={!values}
              onClick={() => choose(field, seconds)}
              style={{
                flex: 1, padding: '7px 4px', fontSize: 13, fontWeight: 500,
                background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 7, cursor: values ? 'pointer' : 'default', outline: 'none',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {labelFor(seconds)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '20px 24px', marginBottom: 20,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.security.mailboxSyncTitle')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {t('admin.security.mailboxSyncDesc')}
      </div>
      {renderChoices('syncIntervalSec', t('admin.messageList.syncFrequency'), t('admin.messageList.syncFrequencyDesc'),
        SYNC_INTERVAL_CHOICES_SEC, (seconds) => SYNC_LABELS[seconds])}
      {renderChoices('folderSyncIntervalSec', t('admin.messageList.folderSyncFrequency'), t('admin.messageList.folderSyncFrequencyDesc'),
        FOLDER_CHOICE_ORDER, (seconds) => (seconds === 0 ? t('common.never') : FOLDER_LABELS[seconds]))}
      {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
