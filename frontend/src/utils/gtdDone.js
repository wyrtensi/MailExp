import {
  clearGtdRemovalGuard,
  setCompletedGtdRemoval,
  setPendingGtdRemoval,
} from './pendingGtdRemovals.js';
import { gtdRefusalText } from './gtd.js';

export async function doneGtdRow(thread, states, {
  gtdDone,
  removeGtdThread,
  restoreGtdThread,
  addNotification,
  scheduleGtdSectionsFetch,
  t,
}) {
  const identity = thread.message_id || thread.id;
  setPendingGtdRemoval(identity, states);
  const snapshot = removeGtdThread(identity, states);

  try {
    const result = await gtdDone(thread.id, states);
    setCompletedGtdRemoval(identity, states);
    if (result?.archiveFailed) {
      // keptOnlyCopy: the server kept the message's only copy in its GTD folder, not the Inbox.
      const title = result.keptOnlyCopy ? 'gtd.doneArchiveFailedKept' : 'gtd.doneArchiveFailed';
      addNotification({ title: t(title), body: thread.subject || t('common.noSubject') });
    }
    scheduleGtdSectionsFetch();
    return result;
  } catch (err) {
    clearGtdRemovalGuard(identity, states);
    restoreGtdThread(snapshot);
    console.error('GTD done failed:', err.message);
    addNotification({ title: t('gtd.doneFailed'), body: gtdRefusalText(err, t, thread.subject || t('common.noSubject')) });
    scheduleGtdSectionsFetch();
    return null;
  }
}
