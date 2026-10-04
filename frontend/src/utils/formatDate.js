import { format, isToday, isYesterday, isThisYear } from 'date-fns';
import { ru } from 'date-fns/locale/ru';

// Dates in the interface language. i18n.js reports the language here (setDateLanguage) at start
// and on every change, so the helpers below follow it without each caller passing it; tests pass
// `lang` explicitly. Pure otherwise: no DOM, no store.
let currentLanguage = 'en';
export function setDateLanguage(lang) {
  currentLanguage = lang === 'ru' ? 'ru' : 'en';
}
export function dateLanguage() {
  return currentLanguage;
}

const LOCALES = { en: undefined, ru };
const TAGS = { en: 'en-US', ru: 'ru-RU' };
const YESTERDAY = { en: 'Yesterday', ru: 'Вчера' };
// Russian reads a 24-hour clock and the day before the month.
const PATTERNS = {
  en: {
    time: 'h:mm a', day: 'MMM d', dayYear: 'MMM d, yyyy', dateTime: 'MMM d, h:mm a', dateTimeYear: 'MMM d, yyyy h:mm a',
    dateTimeSeconds: 'MMM d, h:mm:ss a', dateTimeYearSeconds: 'MMM d, yyyy h:mm:ss a',
  },
  ru: {
    time: 'HH:mm', day: 'd MMM', dayYear: 'd MMM yyyy', dateTime: 'd MMM, HH:mm', dateTimeYear: 'd MMM yyyy, HH:mm',
    dateTimeSeconds: 'd MMM, HH:mm:ss', dateTimeYearSeconds: 'd MMM yyyy, HH:mm:ss',
  },
};

const valid = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
};
const fmt = (d, pattern, lang) => format(d, PATTERNS[lang][pattern], { locale: LOCALES[lang] });

// The BCP 47 tag for toLocaleString/toLocaleDateString, so those follow the interface too.
export function localeTag(lang = currentLanguage) {
  return TAGS[lang] || TAGS.en;
}

// Compact relative date label shared by MessageList and the GTD display surfaces. Guards an
// invalid date to '' so a malformed value can never throw from date-fns format().
export function formatDate(dateStr, lang = currentLanguage) {
  const d = valid(dateStr);
  if (!d) return '';
  const l = PATTERNS[lang] ? lang : 'en';
  if (isToday(d)) return fmt(d, 'time', l);
  if (isYesterday(d)) return YESTERDAY[l];
  if (isThisYear(d)) return fmt(d, 'day', l);
  return fmt(d, 'dayYear', l);
}

// A day with its year: "Sep 16, 2026" / "16 сент. 2026".
export function formatDay(dateStr, lang = currentLanguage) {
  const d = valid(dateStr);
  return d ? fmt(d, 'dayYear', PATTERNS[lang] ? lang : 'en') : '';
}

// Day and time, with or without the year: the open letter's date. `seconds` adds them where they
// tell events apart (the node's queue and alerts, a tenant job).
export function formatDateTime(dateStr, { withYear = true, seconds = false, lang = currentLanguage } = {}) {
  const d = valid(dateStr);
  if (!d) return '';
  const pattern = (withYear ? 'dateTimeYear' : 'dateTime') + (seconds ? 'Seconds' : '');
  return fmt(d, pattern, PATTERNS[lang] ? lang : 'en');
}
