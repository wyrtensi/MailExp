import { useTranslation } from 'react-i18next';
import { deliveryMark } from '../utils/delivery.js';

// The list's mark of a sent letter that was not delivered to a recipient, or is delayed (R-17;
// the row's delivery_state, utils/delivery.js). In words next to the direction pill, never by
// colour alone; `compact` keeps the icon only and the words in aria-label and title, as
// DirectionBadge does. Nothing for any other state.
export default function DeliveryMarker({ state, compact = false }) {
  const { t } = useTranslation();
  const mark = deliveryMark(state);
  if (!mark) return null;
  const label = t(mark.labelKey);
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      data-delivery-marker={state}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
        fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap',
        padding: compact ? 2 : '2px 6px',
        borderRadius: 10, color: mark.color,
        background: `color-mix(in srgb, ${mark.color} 15%, transparent)`,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
        {state === 'failed'
          ? <><circle cx="12" cy="12" r="9" /><line x1="12" y1="7" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
          : <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>}
      </svg>
      {!compact && <span>{label}</span>}
    </span>
  );
}
