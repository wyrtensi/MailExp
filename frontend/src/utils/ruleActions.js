const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isValidForwardAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !/[\r\n\0]/.test(normalized) && FORWARD_EMAIL_RE.test(normalized);
}

// The address a rule forwards incoming mail to, or null: the rules list shows it to everyone.
export function ruleForwardTarget(rule) {
  const actions = Array.isArray(rule?.actions) ? rule.actions : [];
  const forward = actions.find((action) => action?.type === 'forward' && typeof action.value === 'string' && action.value.trim());
  return forward ? forward.value.trim() : null;
}
