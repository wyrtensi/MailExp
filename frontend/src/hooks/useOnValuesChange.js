import { useEffect, useRef } from 'react';

// Calls onChange after a commit in which any of `values` differs (Object.is) from the values of
// the previous commit. Never for the first commit, and never for React.StrictMode's second run of
// the same commit's effects: a mount flag ("skip the first run") is set by the first run and so
// counts the second one as a change, while comparing the values does not.
export function useOnValuesChange(values, onChange) {
  const last = useRef(null);
  useEffect(() => {
    const prev = last.current;
    last.current = values;
    if (!prev) return;
    if (prev.length === values.length && prev.every((value, i) => Object.is(value, values[i]))) return;
    onChange();
  });
}
