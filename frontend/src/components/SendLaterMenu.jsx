import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/formatDate.js';
import {
  SEND_AT_PROBLEM_KEYS, SEND_LATER_PRESET_LABEL_KEYS, fromLocalInputValue, sendAtProblem, sendLaterPresets, toLocalInputValue,
} from '../utils/sendLater.js';

// "Send later" in the composer: preset times (later today, tomorrow morning, Monday morning) and a
// date and time of the writer's choosing, in their local time. onPick(date) schedules the letter;
// it is also used to move a scheduled letter to another time (ScheduledLetters), where `title`
// names the action. A popover above the button on desktop, a sheet on a phone. Escape closes it.
export default function SendLaterMenu({ anchorRect = null, isMobile = false, onPick, onClose, title = null, initial = null }) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const presets = useMemo(() => sendLaterPresets(new Date()), []);
  const [custom, setCustom] = useState(() => !!initial);
  const [value, setValue] = useState(() => toLocalInputValue(initial || presets.find(p => p.key === 'tomorrowMorning')?.at || new Date(Date.now() + 3600e3)));
  const [problem, setProblem] = useState(null);
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pickCustom = () => {
    const at = fromLocalInputValue(value);
    const why = sendAtProblem(at);
    if (why) {
      setProblem(why);
      return;
    }
    onPick(at);
  };

  const itemStyle = {
    width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
    padding: isMobile ? '14px 20px' : '8px 12px', background: 'none', border: 'none', borderRadius: isMobile ? 0 : 6,
    color: 'var(--text-primary)', fontSize: isMobile ? 15 : 13, cursor: 'pointer', textAlign: 'left',
  };
  const position = isMobile
    ? { left: 0, right: 0, bottom: 0, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(var(--sab) + 8px)' }
    : {
      left: Math.max(8, Math.min(anchorRect?.left ?? 24, window.innerWidth - 328)),
      bottom: anchorRect ? Math.max(8, window.innerHeight - anchorRect.top + 6) : 80,
      width: 320, borderRadius: 10, padding: 6,
    };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2200, background: isMobile ? 'rgba(0,0,0,0.4)' : 'transparent' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-send-later
        style={{
          position: 'fixed', zIndex: 2201, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-popover)', ...position,
        }}
      >
        <div id={titleId} style={{ padding: isMobile ? '16px 20px 8px' : '6px 12px 4px', fontSize: isMobile ? 15 : 12, fontWeight: 600, color: isMobile ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
          {title || t('scheduled.sendLater')}
        </div>
        {presets.map((preset, index) => (
          <button
            key={preset.key}
            ref={index === 0 ? firstRef : undefined}
            type="button"
            data-preset={preset.key}
            onClick={() => onPick(preset.at)}
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <span>{t(SEND_LATER_PRESET_LABEL_KEYS[preset.key])}</span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{formatDateTime(preset.at, { withYear: false })}</span>
          </button>
        ))}
        {!custom ? (
          <button
            type="button"
            data-preset="custom"
            onClick={() => setCustom(true)}
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <span>{t('scheduled.presets.custom')}</span>
          </button>
        ) : (
          <div style={{ padding: isMobile ? '10px 20px' : '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor={inputId} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('scheduled.pickTime')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id={inputId}
                type="datetime-local"
                value={value}
                min={toLocalInputValue(new Date())}
                onChange={e => { setValue(e.target.value); setProblem(null); }}
                onKeyDown={e => { if (e.key === 'Enter') pickCustom(); }}
                aria-invalid={problem ? 'true' : undefined}
                aria-describedby={problem ? `${inputId}-problem` : undefined}
                style={{
                  flex: 1, minWidth: 0, padding: '6px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, colorScheme: 'light dark',
                }}
              />
              <button
                type="button"
                onClick={pickCustom}
                style={{
                  padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6,
                  color: 'var(--accent-text)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t('scheduled.schedule')}
              </button>
            </div>
            {problem && (
              <div id={`${inputId}-problem`} role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>
                {t(SEND_AT_PROBLEM_KEYS[problem])}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
