import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import {
  adviceKey, lettersFor, noticeSummary, outcomeKey, timeLeft,
} from '../utils/mailNodeOutage.js';

// "Letters to you delayed or lost while the mail node was down" (R-43): a notice above the letter
// list of a mailbox (every mailbox in the unified inbox) when the message trace found letters to it
// that EOP held while the node could not take mail: still waiting in EOP's queue (with the time EOP
// gives up), lost (the sender got a non-delivery report: ask them to resend) or delayed. Collapsed
// to one line; the list opens on demand. "Got it" hides the notice until another letter shows up
// (remembered in this browser only). Every signed-in user may open every mailbox, so the server
// answers the letters of all the panel's mailboxes and the screen keeps those of the one shown.

const CACHE_MS = 2 * 60 * 1000;
// While a mailbox stays open the notice looks again now and then (the trace changes every 15 min).
const POLL_MS = 5 * 60 * 1000;
const SEEN_KEY = 'mailexpert.outageNotice.seen';
let cache = null; // { at, promise }

// One read for every mailbox the user switches between, at most every two minutes.
export function loadOutageLetters({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.promise;
  // A failed read shows no notice: it is information, never in the way of the mailbox.
  const promise = Promise.resolve().then(() => api.mailNode.outageLetters()).catch(() => ({ letters: [] }));
  cache = { at: Date.now(), promise };
  return promise;
}

export function forgetOutageLetters() {
  cache = null;
}

// The server's key names the letter whatever window it shows under; with the outcome, a letter
// that went from waiting to lost shows again after 'Got it'.
const letterKey = (letter) => `${letter.key ?? `${letter.recipient}|${letter.receivedAt}|${letter.sender ?? ''}`}|${letter.outcome}`;

function readSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function writeSeen(keys) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-500)));
  } catch {
    // Storage blocked or full: the notice comes back next time, nothing worse.
  }
}

export default function MailNodeOutageNotice({ accountId = null, showRecipient = false }) {
  const { t } = useTranslation();
  const [letters, setLetters] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [seen, setSeen] = useState(() => readSeen());
  const listId = useId();

  useEffect(() => {
    let alive = true;
    const load = () => loadOutageLetters().then((data) => { if (alive) setLetters(Array.isArray(data?.letters) ? data.letters : []); });
    load();
    const timer = setInterval(load, POLL_MS);
    // Under Node (render tests) a timer object can be told not to hold the process; browsers have none.
    timer?.unref?.();
    return () => { alive = false; clearInterval(timer); };
  }, [accountId]);

  const mine = lettersFor(letters, accountId);
  if (!mine.length || mine.every((letter) => seen.has(letterKey(letter)))) return null;

  const summary = noticeSummary(mine);
  const tone = mine.some((l) => l.outcome === 'waiting' || l.outcome === 'lost') ? 'rgba(245,158,11,0.10)' : 'var(--bg-secondary)';
  const dismiss = () => {
    const next = new Set([...seen, ...mine.map(letterKey)]);
    writeSeen(next);
    setSeen(next);
  };

  return (
    <section
      data-outage-notice
      aria-label={t('messageList.outage.title')}
      style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', background: tone, fontSize: 12, lineHeight: 1.5 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0, color: 'var(--text-primary)' }}>
          <div style={{ fontWeight: 600 }}>{t('messageList.outage.title')}</div>
          <div role="status" style={{ color: 'var(--text-secondary)' }}>{t(summary.key, summary.values)}</div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={listId}
          style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}
        >
          {t(expanded ? 'messageList.outage.hide' : 'messageList.outage.show')}
        </button>
        <button
          type="button"
          onClick={dismiss}
          style={{ padding: '4px 10px', background: 'transparent', border: '1px solid transparent', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}
        >
          {t('messageList.outage.dismiss')}
        </button>
      </div>
      {expanded && (
        // The list scrolls on its own, so a long one never pushes the mailbox's letters away.
        <ul id={listId} tabIndex={0} aria-label={t('messageList.outage.title')} style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 8, maxHeight: '40vh', overflowY: 'auto' }}>
          {mine.map((letter) => {
            const left = letter.outcome === 'waiting' ? timeLeft(letter.expiresAt) : null;
            const advice = adviceKey(letter);
            return (
              <li key={letterKey(letter)} data-letter-outcome={letter.outcome} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 600, color: letter.outcome === 'lost' ? 'var(--red)' : 'var(--text-primary)' }}>{t(outcomeKey(letter))}</div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('messageList.outage.columnFrom')}: </span>{letter.sender || '—'}
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('messageList.outage.columnSubject')}: </span>{letter.subject || t('messageList.outage.noSubject')}
                </div>
                {showRecipient && (
                  <div><span style={{ color: 'var(--text-secondary)' }}>{t('messageList.outage.columnTo')}: </span>{letter.recipient}</div>
                )}
                <div style={{ color: 'var(--text-secondary)' }}>{t('messageList.outage.receivedAt', { at: formatDateTime(letter.receivedAt) })}</div>
                {left && !left.past && <div>{t('messageList.outage.timeLeft', { hours: left.hours, minutes: left.minutes })}</div>}
                {left?.past && <div>{t('messageList.outage.timePassed')}</div>}
                {advice && <div style={{ color: 'var(--text-secondary)' }}>{t(advice)}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
