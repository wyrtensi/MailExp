import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { mailNodeErrorKey } from '../utils/mailNode.js';
import {
  coverageKey, deliveryMark, deliveryStateKey, deliveryTone, explanationKey, reportStateKey, tlsLevelKey,
} from '../utils/delivery.js';

const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
};
const TONE_COLOR = { failed: 'var(--red)', delayed: 'var(--amber)', ok: 'var(--green, #22c55e)' };

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
        aria-controls={panelId}
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
          {state.status === 'done' && <DeliveryBody details={state.details} />}
        </div>
      )}
    </section>
  );
}

function DeliveryBody({ details }) {
  const { t } = useTranslation();
  if (!details.messageId) return <div data-delivery-note="no-message-id">{t('message.delivery.noMessageId')}</div>;
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
    </>
  );
}

function RecipientRow({ row }) {
  const { t } = useTranslation();
  const tone = deliveryTone(row.state);
  const stateKey = deliveryStateKey(row);
  const explain = explanationKey(row.explanation);
  const log = row.log;
  const report = row.report;
  return (
    <li data-delivery-recipient={row.recipient} data-delivery-state={row.state} style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500, wordBreak: 'break-all' }}>{row.recipient}</span>
        <span style={{ fontWeight: 600, color: TONE_COLOR[tone] }}>
          {stateKey ? t(stateKey) : row.state}
          {row.statusCode && tone !== 'ok' ? ` (${row.statusCode})` : ''}
        </span>
        {row.at && <span style={{ fontSize: 11 }}>{formatDateTime(row.at)}</span>}
      </div>
      {explain && <div data-delivery-explanation={row.explanation.key} style={{ color: 'var(--text-primary)' }}>{t(explain)}</div>}
      {log && (
        <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 8, rowGap: 2, fontSize: 11 }}>
          {log.relayHost && (
            <>
              <dt>{t('message.delivery.relay')}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }} data-delivery-relay>
                {log.relayHost}{log.relayIp ? ` [${log.relayIp}]` : ''}{log.relayPort ? `:${log.relayPort}` : ''}
              </dd>
            </>
          )}
          {log.relayKind !== 'local' && (
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
          {log.reply && log.state !== 'sent' && (
            <>
              <dt>{t('message.delivery.reply')}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-word' }}>{log.reply}</dd>
            </>
          )}
          {log.queueId && (
            <>
              <dt>{t('message.delivery.queueId')}</dt>
              <dd style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace' }}>{log.queueId}</dd>
            </>
          )}
        </dl>
      )}
      {report && (
        <div data-delivery-report={report.state} style={{ marginTop: 4, fontSize: 11 }}>
          {t(report.remoteMta ? 'message.delivery.report' : 'message.delivery.reportNoMta', {
            mta: report.remoteMta ?? '', state: reportStateKey(report.state) ? t(reportStateKey(report.state)) : report.state, diagnostic: report.diagnostic ?? report.statusCode ?? '',
          })}
        </div>
      )}
    </li>
  );
}
