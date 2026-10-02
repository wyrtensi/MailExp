// Small line icons for the interface, in place of emoji and symbol characters (which render in a
// different font on every system). They take the text colour (currentColor) and a size in px.
const base = (size) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  style: { display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0 },
});

export function CheckIcon({ size = 14 }) {
  return <svg {...base(size)}><polyline points="20 6 9 17 4 12" /></svg>;
}

export function CloseIcon({ size = 14 }) {
  return <svg {...base(size)}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}

export function PlusIcon({ size = 14 }) {
  return <svg {...base(size)}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}

// A map pin standing on its needle; `crossed` strikes it through (the "Unpin" action).
export function PinIcon({ size = 14, crossed = false }) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
      {crossed && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

export function WarningIcon({ size = 14 }) {
  return (
    <svg {...base(size)}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function SmileIcon({ size = 15 }) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}
