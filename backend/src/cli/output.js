// Human output of the panel CLI: tables and "key: value" blocks. --json prints the actions'
// answers as they are (the same shapes the HTTP API answers) instead.

// A date or an ISO string as 'YYYY-MM-DD HH:MM' (UTC), '-' for none.
export function fmtDate(value) {
  if (value === null || value === undefined || value === '') return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export function fmtValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value instanceof Date) return fmtDate(value);
  if (Array.isArray(value)) return value.length ? value.map(fmtValue).join(', ') : '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Lines of a table: columns [{ header, value(row) }], each padded to its widest cell; the last
// column is not padded. An empty list answers the empty text instead.
export function table(rows, columns, { empty = '(none)' } = {}) {
  if (!rows.length) return [empty];
  const cells = rows.map((row) => columns.map((column) => fmtValue(column.value(row)).replace(/\s+/g, ' ')));
  const widths = columns.map((column, i) => Math.max(column.header.length, ...cells.map((line) => line[i].length)));
  const line = (values) => values.map((value, i) => (i === values.length - 1 ? value : value.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map((column) => column.header)), ...cells.map(line)];
}

// Lines of "key: value" pairs, the keys aligned; a pair whose value is undefined is left out.
export function keyValues(pairs) {
  const shown = pairs.filter(([, value]) => value !== undefined);
  const width = Math.max(0, ...shown.map(([key]) => key.length));
  return shown.map(([key, value]) => `${`${key}:`.padEnd(width + 1)} ${fmtValue(value)}`);
}
