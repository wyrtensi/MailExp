// Follows the letters this tab sent until the server reports how they ended, and gives a letter back
// to the composer (undo, edit). A sent letter waits five seconds on the server (backend
// services/sendQueue.js) and then goes out from a job: the tab learns the outcome from the socket
// (send_done / send_failed) or, without one (the demo, a dropped socket), by asking a few times
// after the letter was due. Whichever comes first settles it; the other finds nothing to do.
import i18n from '../i18n.js';
import { useStore } from '../store/index.js';
import { api } from './api.js';
import { DELIVERED_UNRECORDED, composeDataFromScheduled, sendFailureKey, sendOutcome } from './scheduledSend.js';

// When to ask after the letter was due.
const POLL_AFTER_DUE_MS = [1500, 4000, 10000, 30000, 90000];
const tracked = new Map(); // jobId -> { subject, accountId, onSent, timers }

const t = (key, options) => i18n.t(key, options);

export function sendFailureText(code, error) {
  const key = sendFailureKey(code);
  return key ? t(key) : (error || t('scheduled.failure.generic'));
}

function untrack(jobId) {
  const entry = tracked.get(jobId);
  if (!entry) return null;
  entry.timers.forEach(clearTimeout);
  tracked.delete(jobId);
  return entry;
}

async function poll(jobId) {
  if (!tracked.has(jobId)) return;
  try {
    const { letter } = await api.scheduled.get(jobId);
    settleSend(jobId, letter);
  } catch (err) {
    if (err?.status === 404) untrack(jobId);
  }
}

// Starts following a letter the server took (POST /mail/send's answer). dueAt: when it is due by
// this tab's clock (the answer's dueInMs counted from its arrival). onSent runs once it is sent (a
// reply refreshes its thread).
export function trackSend({ jobId, dueAt, subject, accountId, onSent = null }) {
  untrack(jobId);
  const due = Math.max(0, dueAt - Date.now());
  const entry = { subject, accountId, onSent, timers: [] };
  entry.timers = POLL_AFTER_DUE_MS.map(delay => setTimeout(() => poll(jobId), due + delay));
  tracked.set(jobId, entry);
}

export function isTracked(jobId) {
  return tracked.has(String(jobId));
}

export function notifySendFailed({ subject, code, error }) {
  const { addNotification, setShowScheduled } = useStore.getState();
  // A letter the server accepted but that could not be recorded as sent: it went out, say so.
  const delivered = code === DELIVERED_UNRECORDED;
  addNotification({
    ...(delivered ? {} : { type: 'error' }),
    title: t(delivered ? 'scheduled.deliveredUnrecordedTitle' : 'scheduled.failedTitle'),
    body: `${subject || t('common.noSubject')}: ${sendFailureText(code, error)}`,
    allowWrap: true,
    persistent: true,
    onAction: () => setShowScheduled(true),
    actionLabel: t('scheduled.view'),
  });
}

// Settles a followed letter from a status (a polled letter, or a socket event). Returns whether
// this tab was following it.
export function settleSend(jobId, { status, errorCode = null, error = null, sentFolder = null, sentCopySaved = null } = {}) {
  const id = String(jobId);
  if (!tracked.has(id)) return false;
  const outcome = sendOutcome(status);
  if (outcome === 'waiting') return true;
  const entry = untrack(id);
  if (outcome === 'sent') {
    const { addNotification, setSelectedAccount, accounts } = useStore.getState();
    const folder = sentFolder || accounts.find(a => a.id === entry.accountId)?.folder_mappings?.sent || 'Sent';
    const noCopy = sentCopySaved === false;
    addNotification({
      title: noCopy ? t('compose.sent.noCopy') : t('compose.sent.title'),
      body: entry.subject || t('common.noSubject'),
      ...(noCopy ? {} : { onAction: () => setSelectedAccount(entry.accountId, folder), actionLabel: t('compose.sent.action') }),
    });
    entry.onSent?.();
  } else if (outcome === 'failed') {
    notifySendFailed({ subject: entry.subject, code: errorCode, error });
  }
  return true;
}

// Opens the composer with a letter the server gave back. Another composer may be open: then the
// letter waits and opens once that one closes (ScheduledLetters), so nothing is lost.
export function restoreCompose(compose, { sendAt = null } = {}) {
  const { composing, openCompose, setQueuedCompose, addNotification } = useStore.getState();
  const data = composeDataFromScheduled(compose, { sendAt });
  if (!composing) {
    openCompose(data);
    return;
  }
  setQueuedCompose(data);
  addNotification({ title: t('scheduled.restoreQueuedTitle'), body: t('scheduled.restoreQueuedBody') });
}

// Undo: cancels the letter while it still waits and reopens it in the composer. Resolves true when
// it was stopped; false (with a notice) when the server had already started sending it.
export async function undoSend(jobId) {
  const id = String(jobId);
  try {
    const { compose } = await api.scheduled.cancel(id, 'undo');
    untrack(id);
    window.dispatchEvent(new CustomEvent('mailexpert:scheduled_changed'));
    if (compose) restoreCompose(compose);
    return true;
  } catch (err) {
    const { addNotification } = useStore.getState();
    addNotification({
      type: 'error',
      title: t('scheduled.undoFailedTitle'),
      body: err?.code === 'send_started' || err?.code === 'already_sent' ? t('scheduled.undoTooLate') : (err?.message || t('scheduled.failure.generic')),
    });
    return false;
  }
}

// The sidebar's count: letters waiting in every mailbox, and this user's that were not sent.
export async function refreshScheduledSummary() {
  const { setScheduledSummary, user } = useStore.getState();
  try {
    const { letters } = await api.scheduled.list();
    const failed = letters.filter(l => (l.status === 'failed' || l.status === 'needs_attention') && l.errorCode !== DELIVERED_UNRECORDED
      && l.author?.id && l.author.id === user?.id).length;
    setScheduledSummary({ count: letters.length, failed });
    return { letters, failed };
  } catch {
    return null;
  }
}
