import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../utils/clipboard.js';
import { api } from '../utils/api.js';
import { mailboxBusyOr } from '../utils/mailboxBusy.js';
import { useMobile } from '../hooks/useMobile.js';
import {
  conversationFolders,
  conversationTotal,
  hasGmailThreadNumber,
  hasReferences,
  modeKey,
  reasonKey,
} from '../utils/threadingDiagnostics.js';

export default function MessageHeaderModal({ messageId, subject, onClose, onSubjectResolved }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [headers, setHeaders] = useState(null);
  // Why the headers could not be read (an Error with the server's code), said in the UI language.
  const [headersError, setHeadersError] = useState(null);
  const [resolvedSubject, setResolvedSubject] = useState(subject);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [threading, setThreading] = useState(null);
  const [threadingLoading, setThreadingLoading] = useState(true);
  const [threadingFailed, setThreadingFailed] = useState(false);
  const onSubjectResolvedRef = useRef(onSubjectResolved);
  onSubjectResolvedRef.current = onSubjectResolved;

  useEffect(() => {
    api.getMessageHeaders(messageId)
      .then(data => {
        setHeaders(data.headers);
        if (data.subject && data.subject !== '(no subject)') {
          setResolvedSubject(data.subject);
          onSubjectResolvedRef.current?.(data.subject);
        }
      })
      .catch(err => setHeadersError(err))
      .finally(() => setLoading(false));
  }, [messageId]);

  // Fetched independently of the raw headers above: one failing must not take down the other.
  useEffect(() => {
    let live = true;
    setThreading(null);
    setThreadingFailed(false);
    setThreadingLoading(true);
    api.getMessageThreading(messageId)
      .then(data => { if (live) setThreading(data); })
      .catch(() => { if (live) setThreadingFailed(true); })
      .finally(() => { if (live) setThreadingLoading(false); });
    return () => { live = false; };
  }, [messageId]);

  const handleCopy = async () => {
    const { ok } = await copyToClipboard(headers || '');
    if (!ok) return; // leave the button unchanged rather than claiming a copy that failed
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const parsedHeaders = [];
  if (headers) {
    const lines = headers.split('\n');
    let current = null;
    for (const line of lines) {
      if (/^\s/.test(line) && current) {
        current.value += ' ' + line.trim();
      } else {
        const colon = line.indexOf(':');
        if (colon > 0) {
          current = { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
          parsedHeaders.push(current);
        }
      }
    }
  }

  const important = new Set(['from','to','cc','bcc','subject','date','message-id','reply-to',
    'return-path','received','x-mailer','mime-version','content-type','dkim-signature',
    'authentication-results','x-spam-status','x-spam-score']);

  const displaySubject = (resolvedSubject && resolvedSubject !== '(no subject)')
    ? resolvedSubject
    : (parsedHeaders.find(h => h.key.toLowerCase() === 'subject')?.value || t('common.noSubject'));

  const threadingLabelStyle = {
    fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)',
    fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase',
    letterSpacing: '0.04em', marginBottom: 2,
  };
  const threadingValueStyle = {
    fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.5,
  };

  // "Conversation": why this letter landed where it did, above the raw headers below.
  // Independent of the headers fetch — its own loading/failure never blocks the other.
  function renderThreadingSection() {
    if (threadingLoading) {
      return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('message.threading.loading')}</div>;
    }
    if (threadingFailed || !threading) {
      return threadingFailed
        ? <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('message.threading.loadFailed')}</div>
        : null;
    }
    const folders = conversationFolders(threading);
    return (
      <div style={{
        marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 8,
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          {t('message.threading.title')}
        </div>
        <div>
          <div style={threadingLabelStyle}>{t('message.threading.messageId')}</div>
          <div style={threadingValueStyle}>{threading.messageId || t('message.threading.none')}</div>
        </div>
        <div>
          <div style={threadingLabelStyle}>{t('message.threading.inReplyTo')}</div>
          <div style={threadingValueStyle}>{threading.inReplyTo || t('message.threading.none')}</div>
        </div>
        <div>
          <div style={threadingLabelStyle}>{t('message.threading.references')}</div>
          {hasReferences(threading)
            ? threading.references.map((ref, i) => (
              <div key={i} style={threadingValueStyle}>{ref}</div>
            ))
            : <div style={threadingValueStyle}>{t('message.threading.none')}</div>}
        </div>
        {hasGmailThreadNumber(threading) && (
          <div>
            <div style={threadingLabelStyle}>{t('message.threading.gmailThreadNumber')}</div>
            <div style={threadingValueStyle}>{threading.providerThreadId}</div>
          </div>
        )}
        <div>
          <div style={threadingLabelStyle}>{t('message.threading.reasonLabel')}</div>
          <div style={threadingValueStyle}>{t(reasonKey(threading.reason))}</div>
        </div>
        <div>
          <div style={threadingLabelStyle}>{t('message.threading.modeLabel')}</div>
          <div style={threadingValueStyle}>{t(modeKey(threading.mode))}</div>
        </div>
        <div>
          <div style={threadingValueStyle}>
            {t('message.threading.conversationCount', { count: conversationTotal(threading) })}
          </div>
          {folders.length > 0 && (
            <div style={{ ...threadingValueStyle, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {folders.map(f => `${f.folder} (${f.count})`).join(', ')}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 5000,
        background: 'var(--bg-secondary)',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'var(--sat)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contextMenu.headers.title')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displaySubject}
            </div>
          </div>
          <button
            onClick={handleCopy}
            style={{
              flexShrink: 0, padding: '6px 12px',
              background: copied ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
              border: `1px solid ${copied ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 7, color: copied ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 12,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {copied ? t('contextMenu.headers.copied') : t('contextMenu.headers.copyRaw')}
          </button>
          <button
            onClick={onClose}
            style={{
              flexShrink: 0, background: 'none', border: 'none', padding: 6,
              color: 'var(--text-tertiary)', cursor: 'pointer', borderRadius: 6,
              display: 'flex', alignItems: 'center',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '12px 16px 0' }}>{renderThreadingSection()}</div>
          {loading && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '12px 16px' }}>
              {t('contextMenu.headers.loading')}
            </div>
          )}
          {!loading && parsedHeaders.length > 0 && parsedHeaders.map((h, i) => {
            const isImportant = important.has(h.key.toLowerCase());
            return (
              <div key={i} style={{
                borderBottom: '1px solid var(--border-subtle)',
                background: isImportant ? 'rgba(124,106,247,0.04)' : 'transparent',
                padding: '8px 16px',
              }}>
                <div style={{
                  fontSize: 10, fontWeight: isImportant ? 600 : 400,
                  color: isImportant ? 'var(--accent)' : 'var(--text-tertiary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  marginBottom: 2,
                }}>
                  {h.key}
                </div>
                <div style={{
                  fontSize: 12, color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  wordBreak: 'break-all', lineHeight: 1.5,
                }}>
                  {h.value}
                </div>
              </div>
            );
          })}
          {!loading && parsedHeaders.length === 0 && (
            <pre style={{
              color: 'var(--text-primary)', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              lineHeight: 1.6, margin: 0, padding: '12px 16px',
            }}>
              {headers || (headersError
                ? t('contextMenu.headers.loadFailed', { message: mailboxBusyOr(headersError, t, headersError.message) })
                : t('contextMenu.headers.noHeaders'))}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay-scrim)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 5000, padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 14, width: '100%', maxWidth: 720,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-modal)',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contextMenu.headers.title')}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2,
              maxWidth: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {displaySubject}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCopy}
              style={{
                padding: '6px 12px', background: copied ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                border: `1px solid ${copied ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 7, color: copied ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              {copied ? t('contextMenu.headers.copied') : t('contextMenu.headers.copyRaw')}
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', padding: 6,
                color: 'var(--text-tertiary)', cursor: 'pointer', borderRadius: 6,
                display: 'flex', alignItems: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {renderThreadingSection()}
          {loading && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('contextMenu.headers.loading')}</div>
          )}

          {!loading && parsedHeaders.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {parsedHeaders.map((h, i) => {
                  const isImportant = important.has(h.key.toLowerCase());
                  return (
                    <tr key={i} style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: isImportant ? 'rgba(124,106,247,0.04)' : 'transparent',
                    }}>
                      <td style={{
                        padding: '6px 12px 6px 0', verticalAlign: 'top',
                        color: isImportant ? 'var(--accent)' : 'var(--text-tertiary)',
                        fontWeight: isImportant ? 600 : 400,
                        whiteSpace: 'nowrap', width: 200, fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11,
                      }}>
                        {h.key}
                      </td>
                      <td style={{
                        padding: '6px 0', color: 'var(--text-primary)',
                        wordBreak: 'break-all', fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11, lineHeight: 1.6,
                      }}>
                        {h.value}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {!loading && parsedHeaders.length === 0 && (
            <pre style={{
              color: 'var(--text-primary)', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap',
              lineHeight: 1.6, margin: 0,
            }}>
              {headers || (headersError
                ? t('contextMenu.headers.loadFailed', { message: mailboxBusyOr(headersError, t, headersError.message) })
                : t('contextMenu.headers.noHeaders'))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}