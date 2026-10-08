import { runAccessSync } from './runner.js';
import { createAccessSyncScheduler } from './scheduler.js';

// The process-wide Access sync. Requests before startAccessSync are ignored: only google mode
// starts it. A manual run works either way and reports why it did nothing.
let signOutUser = async () => {};
const scheduler = createAccessSyncScheduler({
  run: (trigger, { canRetry } = {}) => runAccessSync({ trigger, signOutUser, canRetry }),
});

// signOutUser ends the sessions and sockets of a user the sync disabled.
export function startAccessSync(options) {
  signOutUser = options.signOutUser;
  scheduler.start();
}

export const requestAccessSync = (trigger) => scheduler.request(trigger);
export const runAccessSyncNow = () => scheduler.runNow('manual');
export const withAccessSyncLock = (op) => scheduler.exclusive(op);
