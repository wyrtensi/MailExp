import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';
import { formatDateTime } from '../utils/formatDate.js';
import { mailNodeErrorDetail, mailNodeErrorKey } from '../utils/mailNode.js';
import { EOP_CATEGORY_LABEL_KEYS, safeViewMarkup } from '../utils/safeView.js';
import {
  eopSendsToSpam, filterQuarantine, formatScore, releaseNoteKey, rspamdActionKey, sizeLabel,
} from '../utils/quarantine.js';

const fieldStyle = {
  padding: '7px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
};
const hintStyle = { display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 };
const buttonStyle = {
  padding: '6px 11px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const dangerButtonStyle = { ...buttonStyle, border: '1px solid var(--red)', color: 'var(--red)' };
const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 13, textAlign: 'left',
};
const subTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '14px 0 6px' };
const symbolStyle = (score) => ({
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '1px 7px', borderRadius: 20, color: 'var(--text-primary)',
  border: `1px solid ${score > 0 ? 'var(--red)' : 'var(--border)'}`,
});

function Symbols({ symbols, label }) {
  if (!symbols?.length) return null;
  return (
    <ul aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {symbols.map((s) => (
        <li key={s.name} data-symbol={s.name} title={[s.description, ...(s.options ?? [])].filter(Boolean).join('; ') || undefined} style={symbolStyle(s.score)}>
          {s.name} {s.score > 0 ? '+' : ''}{formatScore(s.score)}
        </li>
      ))}
    </ul>
  );
}

// One entry opened: who it came from and to, rspamd's score, action and symbols, EOP's verdict,
// the letter in the safe text view (utils/safeView.js: no images, no clickable links, every link's
// real target shown) with its attachments by name only, the headers on request, and for an
// administrator "Release" and "Delete", each confirmed first.
function QuarantineEntry({ entry, admin, onReleased, onDeleted, onClose }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const safeLabels = useMemo(() => ({ link: t('message.safeView.linkTo'), form: t('message.safeView.formTo') }), [t]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api.mailNode.getQuarantineItem(entry.id)
      .then((d) => { if (live) setDetail(d); })
      .catch((err) => { if (live) setError({ key: err?.code === 'quarantine_item_not_found' ? 'admin.quarantine.gone' : mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) }); });
    return () => { live = false; };
  }, [entry.id]);

  const markup = useMemo(() => (detail?.letter ? safeViewMarkup(detail.letter, safeLabels) : ''), [detail, safeLabels]);
  const letter = detail?.letter;
  const actionKey = rspamdActionKey(entry.action);
  const category = letter?.eop?.category;

  const askRelease = () => setDialog({
    title: t('admin.quarantine.releaseTitle'),
    message: t(releaseNoteKey(entry.action)),
    note: eopSendsToSpam(letter?.eop) ? t('admin.quarantine.releaseEopNote') : null,
    confirmLabel: t('admin.quarantine.release'),
    onConfirm: async () => {
      const result = await api.mailNode.releaseQuarantineItem(entry.id);
      onReleased(entry, result);
    },
  });
  const askDelete = () => setDialog({
    title: t('admin.quarantine.deleteTitle'),
    message: t('admin.quarantine.deleteMessage', { sender: entry.sender, rcpt: entry.rcpt }),
    confirmLabel: t('common.delete'),
    onConfirm: async () => {
      await api.mailNode.deleteQuarantineItem(entry.id);
      onDeleted(entry);
    },
  });

  return (
    <section
      aria-label={t('admin.quarantine.entryLabel', { subject: entry.subject || t('message.noSubject') })}
      data-quarantine-entry={entry.id}
      style={{ marginTop: 10, padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0, wordBreak: 'break-word' }}>
          {letter?.subject || entry.subject || t('message.noSubject')}
        </div>
        <button type="button" onClick={onClose} style={buttonStyle}>{t('admin.quarantine.close')}</button>
      </div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{t(error.key)}{error.detail ? ` (${error.detail})` : ''}</div>}
      {!detail && !error && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}
      {detail && (
        <>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 12px', margin: '8px 0 0', fontSize: 12 }}>
            <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.headerFrom')}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{letter.from || '—'}</dd>
            <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.envelopeSender')}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{detail.sender || '—'}</dd>
            <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.mailbox')}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{detail.rcpt}{detail.accountId ? '' : ` ${t('admin.quarantine.notInPanel')}`}</dd>
            {letter.date && <><dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.date')}</dt><dd style={{ margin: 0 }}>{letter.date}</dd></>}
            <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.sourceIp')}</dt>
            <dd style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace' }}>{detail.ip || '—'}</dd>
            <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.verdict')}</dt>
            <dd style={{ margin: 0 }} data-quarantine-verdict>
              {t('admin.quarantine.scoreAction', { score: formatScore(detail.score), action: actionKey ? t(actionKey) : entry.action })}
            </dd>
            {letter.eop && (
              <>
                <dt style={{ color: 'var(--text-tertiary)' }}>{t('admin.quarantine.eop')}</dt>
                <dd style={{ margin: 0 }} title={[letter.eop.verdict && `SFV:${letter.eop.verdict}`, category && `CAT:${category}`].filter(Boolean).join(';')}>
                  {category ? (EOP_CATEGORY_LABEL_KEYS[category] ? t(EOP_CATEGORY_LABEL_KEYS[category]) : category) : letter.eop.verdict}
                </dd>
              </>
            )}
          </dl>
          <div style={subTitleStyle}>{t('admin.quarantine.symbols')}</div>
          <Symbols symbols={detail.symbols} label={t('admin.quarantine.symbols')} />
          <div style={subTitleStyle}>{t('admin.quarantine.letter')}</div>
          <span style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>{t('admin.quarantine.safeNote')}</span>
          <div
            data-safe-view-body=""
            translate="yes"
            style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.6, padding: '10px 12px',
              borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', color: 'var(--text-primary)',
              maxHeight: 360, overflow: 'auto',
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
          {letter.truncated && <span style={hintStyle}>{t('admin.quarantine.truncated')}</span>}
          {letter.attachments.length > 0 && (
            <>
              <div style={subTitleStyle}>{t('message.attachment', { count: letter.attachments.length })}</div>
              <ul data-quarantine-attachments style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {letter.attachments.map((a, i) => {
                  const size = sizeLabel(a.size);
                  return (
                    <li key={i}>
                      {a.filename || t('admin.quarantine.unnamed')} ({a.type}, {t(size.key, { value: size.value })})
                    </li>
                  );
                })}
              </ul>
              <span style={hintStyle}>{t('admin.quarantine.attachmentsLocked')}</span>
            </>
          )}
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>{t('admin.quarantine.headers', { number: letter.headers.length })}</summary>
            <pre data-quarantine-headers style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 0', maxHeight: 260, overflow: 'auto' }}>
              {letter.headers.map((h) => `${h.name}: ${h.value}`).join('\n')}
            </pre>
          </details>
          {admin && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" onClick={askRelease} style={buttonStyle}>{t('admin.quarantine.release')}</button>
              <button type="button" onClick={askDelete} style={dangerButtonStyle}>{t('common.delete')}</button>
            </div>
          )}
        </>
      )}
      <ConfirmOverlay dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}

// The mail node's quarantine (R-20): the letters rspamd on the node refused or marked as spam, kept
// by mailcow. Administrators see every entry (Settings -> Integrations, next to the mail node) and
// may release or delete one, and choose whether users see it too; a user sees, read-only, the
// entries addressed to the panel's node mailboxes (Settings -> Mailboxes) once an administrator
// allowed it, and nothing otherwise: the section hides itself when the server says no.
export default function MailNodeQuarantine({ admin = false }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const [userView, setUserView] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.mailNode.listQuarantine());
      setError(null);
    } catch (err) {
      // No node, or a user the quarantine is not shown to: nothing to show here.
      if (err?.code === 'mail_node_not_configured' || (!admin && err?.code === 'quarantine_admin_only')) setHidden(true);
      else setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    } finally {
      setBusy(false);
    }
  }, [admin]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!admin) return;
    api.mailNode.getQuarantineSettings().then((s) => setUserView(!!s.userView)).catch(() => setUserView(null));
  }, [admin]);

  const saveUserView = async (value) => {
    const before = userView;
    setUserView(value);
    try {
      await api.mailNode.saveQuarantineSettings({ userView: value });
    } catch (err) {
      setUserView(before);
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    }
  };

  const drop = (entry) => {
    setData((d) => (d ? { ...d, total: d.total - 1, items: d.items.filter((i) => i.id !== entry.id) } : d));
    setOpen(null);
  };
  const onReleased = (entry, result) => {
    drop(entry);
    setNotice(result?.warnings?.length
      ? t('admin.quarantine.releasedWarnings', { warnings: result.warnings.join('; ') })
      : t('admin.quarantine.released'));
  };
  const onDeleted = (entry) => {
    drop(entry);
    setNotice(t('admin.quarantine.deleted'));
  };

  if (hidden) return null;
  const items = data ? filterQuarantine(data.items, filter) : [];

  return (
    <div data-mail-node-quarantine style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.quarantine.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 10, lineHeight: 1.5 }}>
        {admin ? t('admin.quarantine.description') : t('admin.quarantine.descriptionUser')}
      </div>
      {admin && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-primary)', marginBottom: 4 }}>
            <input type="checkbox" checked={!!userView} disabled={userView === null} onChange={(e) => saveUserView(e.target.checked)} />
            <span>{t('admin.quarantine.userView')}</span>
          </label>
          <span style={{ ...hintStyle, marginBottom: 6 }}>{t('admin.quarantine.userViewNote')}</span>
          <span style={{ ...hintStyle, marginBottom: 10 }}>{t('admin.quarantine.settingsNote')}</span>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('admin.quarantine.filterPh')}
          aria-label={t('admin.quarantine.filterPh')}
          style={{ ...fieldStyle, flex: '1 1 220px' }}
        />
        <button type="button" onClick={load} disabled={busy} style={buttonStyle}>{t('admin.quarantine.refresh')}</button>
      </div>
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{t(error.key)}{error.detail ? ` (${error.detail})` : ''}</div>}
      {notice && <div role="status" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</div>}
      {!data && !error && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>}
      {data && (
        <>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }} data-quarantine-count={data.total}>
            {data.truncated ? t('admin.quarantine.countTruncated', { number: data.total, shown: data.items.length }) : t('admin.quarantine.count', { number: data.total })}
            {!data.historyRead && ` ${t('admin.quarantine.historyUnread')}`}
          </div>
          {data.total === 0 && <span style={hintStyle}>{t('admin.quarantine.emptyNote')}</span>}
          {items.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
              {items.map((item) => {
                const actionKey = rspamdActionKey(item.action);
                return (
                  <li key={item.id} data-quarantine-row={item.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => setOpen(open === item.id ? null : item.id)}
                        aria-expanded={open === item.id}
                        style={{ ...linkButtonStyle, flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}
                      >
                        {item.subject || t('message.noSubject')}
                      </button>
                      <span style={{ whiteSpace: 'nowrap', color: item.action === 'reject' ? 'var(--red)' : 'var(--text-secondary)' }}>
                        {formatScore(item.score)} · {actionKey ? t(actionKey) : item.action}
                        {item.virus && ` · ${t('admin.quarantine.virus')}`}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-tertiary)', marginTop: 2, overflowWrap: 'anywhere' }}>
                      {item.created ? `${formatDateTime(item.created)} · ` : ''}{t('admin.quarantine.fromTo', { sender: item.sender, rcpt: item.rcpt })}
                    </div>
                    {item.topSymbols && (
                      <div style={{ marginTop: 4 }}>
                        <Symbols symbols={item.topSymbols} label={t('admin.quarantine.columnSymbols')} />
                      </div>
                    )}
                    {open === item.id && (
                      <QuarantineEntry
                        entry={item}
                        admin={admin && data.admin}
                        onReleased={onReleased}
                        onDeleted={onDeleted}
                        onClose={() => setOpen(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {data.total > 0 && items.length === 0 && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.quarantine.noMatch')}</div>}
        </>
      )}
    </div>
  );
}
