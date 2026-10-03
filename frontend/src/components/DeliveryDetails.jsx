import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { mailNodeErrorKey } from '../utils/mailNode.js';
import {
  coverageKey, deliveryMark, deliveryStateKey, deliveryTone, eopStatusKey, eopStatusTone, eopTraceActive, eopTraceErrorKey,
  explanationKey, reportStateKey, tlsLevelKey,
} from '../utils/delivery.js';

const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
};
const TONE_COLOR = { failed: 'var(--red)', delayed: 'var(--amber)', ok: 'var(--green, #22c55e)', neutral: 'var(--text-secondary)' };
const quoteStyle = { fontStyle: 'normal', wordBreak: 'break-word', whiteSpace: 'pre-wrap' };
// While Microsoft's trace is being asked (R-30), the details are read again this often, this many times.
const TRACE_POLL_MS = 3000;
const TRACE_POLL_LIMIT = 60;

// "Delivery details" of a sent letter (R-17), under the letter in the message pane: an expander
// that asks the server on request (GET /api/mail/messages/:id/delivery) what became of the letter
// per recipient. For a mailbox on the mail node the server reads the node's log (relay, TLS, EOP's
// acceptance, the remote reply); for every mailbox, the delivery reports that came back. The
// header already says "not delivered" or "delayed" from the list row's mark, before anything loads.
// Every state is written out, never shown by colour alone.
export default function DeliveryDetails({ messageId, deliveryState = null, compact = false }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: 'idle' });
  const current = useRef(messageId);
  const panelId = useId();

  useEffect(() => {
    current.current = messageId;
    setOpen(false);
    setState({ status: 'idle' });
  }, [messageId]);

  const load = async () => {
    const asked = messageId;
    setState({ status: 'loading' });
    try {
      const details = await api.messageDelivery(asked);
      if (current.current === asked) setState({ status: 'done', details });
    } catch (err) {
      if (current.current === asked) setState({ status: 'error', key: mailNodeErrorKey(err?.code) });
    }
  };

  // Reads the details again without the loading line (the trace of R-30 moving on).
  const refresh = async () => {
    const asked = messageId;
    try {
      const details = await api.messageDelivery(asked);
      if (current.current !== asked) return null;
      setState({ status: 'done', details });
      return details;
    } catch {
      return null;
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state.status !== 'done' && state.status !== 'loading') load();
  };

  const mark = deliveryMark(deliveryState);
  const margin = compact ? 8 : 12;
  return (
    <section
      aria-label={t('message.delivery.title')}
      data-delivery-details
      style={{
        marginBottom: margin, padding: '8px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0,
          cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, textAlign: 'left',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span>{t('message.delivery.title')}</span>
        {mark && (
          <span data-delivery-summary={deliveryState} style={{ fontWeight: 500, fontSize: 12, color: mark.color }}>
            {t(mark.summaryKey)}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} style={{ marginTop: 6 }}>
          {state.status === 'loading' && <div>{t('message.delivery.loading')}</div>}
          {state.status === 'error' && (
            <div role="alert" style={{ color: 'var(--red)' }}>
              {t('message.delivery.failed', { message: t(state.key) })}{' '}
              <button type="button" onClick={load} style={linkButtonStyle}>{t('message.delivery.retry')}</button>
            </div>
          )}
          {state.status === 'done' && <DeliveryBody details={state.details} letterId={messageId} refresh={refresh} />}
        </div>
      )}
    </section>
  );
}

function DeliveryBody({ details, letterId, refresh }) {
  const { t } = useTranslation();
  if (!details.messageId) return <div data-delivery-note="no-message-id">{t('message.delivery.noMessageId')}</div>;
  if (details.owned === false) return <div data-delivery-note="not-sent">{t('message.delivery.notSent')}</div>;
  const note = coverageKey(details.log);
  const rows = details.recipients ?? [];
  return (
    <>
      {note && (
        <div data-delivery-coverage={details.log.coverage} style={{ marginBottom: 6 }}>
          {t(note, { error: details.log.error ? t(mailNodeErrorKey(details.log.error)) : '' })}
        </div>
      )}
      {rows.length === 0 && !note && (
        <div data-delivery-note="none">{t(details.node ? 'message.delivery.noneNode' : 'message.delivery.none')}</div>
      )}
      {rows.length > 0 && (
        <ul aria-label={t('message.delivery.recipients')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {rows.map((row) => <RecipientRow key={row.recipient} row={row} />)}
        </ul>
      )}
      {details.eopTrace && <EopTrace eop={details.eopTrace} letterId={letterId} refresh={refresh} />}
    </>
  );
}

// R-30: what Microsoft's message trace says about the letter after the node handed it to EOP,
// asked on request (a job on the server; the details are read again until it is done). Shown for
// letters of node mailboxes; without a connected trace it says nothing at all.
function EopTrace({ eop, letterId, refresh }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const trace = eop.trace;
  const active = eopTraceActive(trace);

  // Reads the details again until the trace is no longer being asked.
  const follow = async () => {
    for (let i = 0; i < TRACE_POLL_LIMIT && alive.current; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, TRACE_POLL_MS); });
      if (!alive.current) return;
      const next = await refresh();
      if (!eopTraceActive(next?.eopTrace?.trace)) return;
    }
  };
  useEffect(() => {
    alive.current = true;
    // The details opened with a trace already being asked (by anyone): follow it.
    if (active) follow();
    return () => { alive.current = false; };
    // Once, when the section appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!eop.available && eop.reason === 'trace_not_connected' && !trace) return null;

  const ask = async () => {
    setAsking(true);
    setError(null);
    try {
      await api.messageEopTrace(letterId);
      const next = await refresh();
      if (eopTraceActive(next?.eopTrace?.trace)) await follow();
    } catch (err) {
      if (alive.current) setError(mailNodeErrorKey(err?.code));
    } finally {
      if (alive.current) setAsking(false);
    }
  };

  const rows = trace?.recipients ?? [];
  return (
    <div data-eop-trace={trace?.state ?? 'none'} style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('message.delivery.eop.title')}</div>
      <div style={{ fontSize: 11 }}>{t('message.delivery.eop.note')}</div>
      {!eop.available && eop.reason && <div data-eop-trace-unavailable={eop.reason}>{t(eopTraceErrorKey(eop.reason))}</div>}
      {trace && (
        <div role="status" aria-live="polite" style={{ marginTop: 4 }}>
          {active && t('message.delivery.eop.asking')}
          {active && trace.error && ` ${t(eopTraceErrorKey(trace.error))}`}
          {trace.state === 'done' && t('message.delivery.eop.checkedAt', { at: formatDateTime(trace.checkedAt) })}
          {trace.state === 'failed' && (
            <span style={{ color: 'var(--red)' }}>{t('message.delivery.eop.failed', { reason: t(eopTraceErrorKey(trace.error)) })}</span>
          )}
        </div>
      )}
      {trace?.state === 'done' && rows.length === 0 && <div data-eop-trace-none>{t('message.delivery.eop.none')}</div>}
      {rows.length > 0 && (
        <ul aria-label={t('message.delivery.eop.recipients')} style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 6 }}>
          {rows.map((row) => {
            const tone = eopStatusTone(row.status);
            const at = row.deliveredAt || row.eventAt || row.receivedAt;
            return (
              <li key={`${row.recipient}|${row.receivedAt}`} data-eop-recipient={row.recipient} data-eop-status={row.status}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500, wordBreak: 'break-all' }}>{row.recipient}</span>
                  <span style={{ fontWeight: 600, color: TONE_COLOR[tone] }}>
                    {t(eopStatusKey(row.status))}{row.statusCode && tone !== 'ok' ? ` (${row.statusCode})` : ''}
                  </span>
                  {at && <span style={{ fontSize: 11 }}>{formatDateTime(at)}</span>}
                </div>
                {row.detail && tone !== 'ok' && (
                  <dl style={dlStyle}><RemoteWords text={row.detail} label={t('message.delivery.eop.words')} /></dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {eop.available && (
        <div style={{ marginTop: 6 }}>
          <button type="button" onClick={ask} disabled={asking || active} style={linkButtonStyle}>
            {trace ? t('message.delivery.eop.askAgain') : t('message.delivery.eop.ask')}
          </button>
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--red)' }}>{t(error)}</div>}
    </div>
  );
}

// A remote server's own words (a reply in the node's log, a report's diagnostic): quoted plain
// text, never a link, and said to be the remote server's, not MailExpert's.
function RemoteWords({ text, label }) {
  return (
    <>
      <dt>{label}</dt>
      <dd style={{ margin: 0 }}>
        <q data-delivery-remote-words style={quoteStyle}>{text}</q>
      </dd>
    </>
  );
}

const dlStyle = { margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 8, rowGap: 2, fontSize: 11 };

function RecipientRow({ row }) {
  const { t } = useTranslation();
  const tone = deliveryTone(row);
  const explain = explanationKey(row.explanation);
  const log = row.log;
  const report = row.report;
  const finalRecipient = log?.finalRecipient || report?.finalRecipient || null;
  const reportState = report ? reportStateKey(report.state) : null;
  return (
    <li data-delivery-recipient={row.recipient} data-delivery-state={row.state} style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500, wordBreak: 'break-all' }}>{row.recipient}</span>
        <span data-delivery-tone={tone} style={{ fontWeight: 600, color: TONE_COLOR[tone] }}>
          {t(deliveryStateKey(row), { state: row.state })}
          {row.statusCode && (tone === 'failed' || tone === 'delayed') ? ` (${row.statusCode})` : ''}
        </span>
        {row.at && <span style={{ fontSize: 11 }}>{formatDateTime(row.at)}</span>}
      </div>
      {explain && <div data-delivery-explanation={row.explanation.key} style={{ color: 'var(--text-primary)' }}>{t(explain)}</div>}
      {finalRecipient && (
        <div data-delivery-final style={{ fontSize: 11 }}>{t('message.delivery.finalRecipient', { address: finalRecipient })}</div>
      )}
      {log && (
        <dl style={dlStyle}>
          {log.relayHost && log.relayKind !== 'discard' && (
            <>
              <dt>{t('message.delivery.relay')}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }} data-delivery-relay>
                {log.relayHost}{log.relayIp ? ` [${log.relayIp}]` : ''}{log.relayPort ? `:${log.relayPort}` : ''}
              </dd>
            </>
          )}
          {log.relayKind !== 'local' && log.relayKind !== 'discard' && (
            <>
              <dt>{t('message.delivery.tls')}</dt>
              <dd style={{ margin: 0 }} data-delivery-tls={log.tls ? log.tls.level : 'missing'}>
                {log.tls ? (
                  <>
                    {tlsLevelKey(log.tls.level) ? t(tlsLevelKey(log.tls.level)) : log.tls.level}
                    {`, ${log.tls.protocol}, ${log.tls.cipher}`}
                    {log.tls.matchedBy === 'time' && <span> ({t('message.delivery.tlsByTime')})</span>}
                  </>
                ) : t('message.delivery.tlsMissing')}
              </dd>
            </>
          )}
          {log.acceptance && (
            <>
              <dt>{t('message.delivery.acceptance')}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }} data-delivery-acceptance>
                {`InternalId=${log.acceptance.internalId}`}{log.acceptance.hostname ? `, ${log.acceptance.hostname}` : ''}
              </dd>
            </>
          )}
          {log.reply && log.state !== 'sent' && <RemoteWords text={log.reply} label={t('message.delivery.reply')} />}
          {log.queueId && (
            <>
              <dt>{t('message.delivery.queueId')}</dt>
              <dd style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace' }}>{log.queueId}</dd>
            </>
          )}
        </dl>
      )}
      {report && (
        <dl data-delivery-report={report.state} style={dlStyle}>
          <dt>{t('message.delivery.report')}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>
            {reportState ? t(reportState) : report.state}
            {report.statusCode ? ` (${report.statusCode})` : ''}
            {report.remoteMta ? `, ${t('message.delivery.reportFrom', { mta: report.remoteMta })}` : ''}
          </dd>
          {report.diagnostic && <RemoteWords text={report.diagnostic} label={t('message.delivery.reportWords')} />}
        </dl>
      )}
    </li>
  );
}

