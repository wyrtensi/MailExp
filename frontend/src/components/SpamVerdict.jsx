import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { mailNodeErrorDetail, mailNodeErrorKey } from '../utils/mailNode.js';
import { EOP_CATEGORY_LABEL_KEYS } from '../utils/safeView.js';
import { formatScore, matchNoteKey, rspamdActionKey, spamReasons } from '../utils/quarantine.js';

const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
};

// "Why is this letter in Spam" under the safe view bar of a letter in the Spam folder of a mail
// node mailbox (R-20), in the message pane and for each letter of a conversation: on request it
// asks the server for rspamd's verdict on the letter (score, action and the symbols that weighed,
// from the node's recent history) and shows it with the EOP category the sync stored. Read-only;
// nothing loads until the reader asks, and an answer for a letter no longer shown is dropped.
export default function SpamVerdict({ messageId, eopCategory = null, compact = false }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'idle' });
  const current = useRef(messageId);

  useEffect(() => {
    current.current = messageId;
    setState({ status: 'idle' });
  }, [messageId]);

  const load = async () => {
    const asked = messageId;
    setState({ status: 'loading' });
    try {
      const verdict = await api.mailNode.spamVerdict(asked);
      if (current.current === asked) setState({ status: 'done', verdict });
    } catch (err) {
      if (current.current === asked) setState({ status: 'error', key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
    }
  };

  const margin = compact ? 8 : 12;
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div style={{ marginBottom: margin }}>
        <button type="button" onClick={load} disabled={state.status === 'loading'} style={linkButtonStyle}>
          {state.status === 'loading' ? t('message.spamVerdict.loading') : t('message.spamVerdict.ask')}
        </button>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" style={{ marginBottom: margin, fontSize: 12, color: 'var(--red)' }}>
        {t('message.spamVerdict.failed', { message: `${t(state.key)}${state.detail ? ` (${state.detail})` : ''}` })}{' '}
        <button type="button" onClick={load} style={linkButtonStyle}>{t('message.spamVerdict.retry')}</button>
      </div>
    );
  }

  const { verdict } = state;
  const rspamd = verdict.rspamd;
  const category = String(verdict.eopCategory || eopCategory || '').toUpperCase() || null;
  const reasons = spamReasons({ rspamd, eopCategory: category });
  const actionKey = rspamd ? rspamdActionKey(rspamd.action) : null;
  const matchKey = rspamd ? matchNoteKey(rspamd.matchedBy) : null;
  const categoryLabel = category ? (EOP_CATEGORY_LABEL_KEYS[category] ? t(EOP_CATEGORY_LABEL_KEYS[category]) : category) : '';
  return (
    <section
      aria-label={t('message.spamVerdict.title')}
      data-spam-verdict
      style={{
        marginBottom: margin, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('message.spamVerdict.title')}</div>
      {reasons.length > 0 && (
        <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
          {reasons.map((key) => <li key={key} data-reason={key}>{t(key, { category: categoryLabel })}</li>)}
        </ul>
      )}
      {rspamd ? (
        <>
          <div data-rspamd-score>
            {t('message.spamVerdict.score', {
              score: formatScore(rspamd.score),
              spam: formatScore(rspamd.spamScore),
              reject: formatScore(rspamd.rejectScore),
              action: actionKey ? t(actionKey) : rspamd.action,
            })}
          </div>
          {rspamd.time && <div>{t('message.spamVerdict.checkedAt', { time: formatDateTime(rspamd.time) })}</div>}
          {matchKey && <div data-match-note={rspamd.matchedBy}>{t(matchKey)}</div>}
          {rspamd.symbols.length > 0 && (
            <ul aria-label={t('message.spamVerdict.symbols')} style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 3 }}>
              {rspamd.symbols.map((s) => (
                <li key={s.name} data-symbol={s.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '1px 7px', borderRadius: 20,
                      border: `1px solid ${s.score > 0 ? 'var(--red)' : 'var(--border)'}`, color: 'var(--text-primary)',
                    }}
                  >
                    {s.name} {s.score > 0 ? '+' : ''}{formatScore(s.score)}
                  </span>
                  {s.description && <span style={{ fontSize: 11 }}>{s.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div data-rspamd-missing>{t('message.spamVerdict.notFound', { depth: verdict.historyRows ?? 0 })}</div>
      )}
      {category && (
        <div style={{ marginTop: 4 }} title={`CAT:${category}`}>
          {t('message.spamVerdict.eop', { category: categoryLabel })}
        </div>
      )}
    </section>
  );
}
