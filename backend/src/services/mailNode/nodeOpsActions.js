import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import {
  MailNodeError, QUEUE_ACTIONS, deleteQueued, flushQueue, getMailNodeConfig, getQueuedMessageText, listQueue, parseQueueId,
  queueAction,
} from './mailcow.js';
import { parsePostcat, postcatGone, summarizeQueue } from './mailQueue.js';
import {
  ALERT_DEFAULTS, getAlertSettings, getAlertState, parseAlertSettings, saveAlertSettings,
} from './nodeAlerts.js';

// The node's operations that routes/mailNode.js and the panel CLI (src/cli/mailexpert.js) share:
// the mail queue (R-16) and the alerts' view and settings (R-18, R-19). They answer a result or
// { error: code } (a key of MAIL_NODE_ERRORS, services/mailNode/errors.js); a failure of the node
// throws (MailNodeError). actor: services/actor.js.
//
// "Check now" of the alerts is not here: the run belongs to the backend's process (it joins the
// run going and starts the outage trace after it), so the route runs it there and the CLI queues
// it (services/mailNode/nodeChecks.js).

// --- the mail queue -----------------------------------------------------------------------------

// The node's mail queue: every message with its queue, age, size, sender and recipients (with the
// reason a deferred one waits), counts per queue and the oldest deferred message's age.
export async function nodeQueue() {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  return summarizeQueue(await listQueue(cfg));
}

// One queued message: its envelope and headers; the body only withBody (cut at 64 KB), and reading
// the body is journaled (the id and the envelope, never the body). Postcat's dump is read up to
// 2 MB. Gone from the queue -> queue_item_not_found; any other answer that is no dump throws.
export async function queuedMessage(rawId, { withBody = false } = {}, actor) {
  const queueId = parseQueueId(rawId);
  if (!queueId) return { error: 'queue_id_invalid' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const dump = await getQueuedMessageText(cfg, queueId);
  const message = parsePostcat(dump.text, { withBody, truncated: dump.truncated });
  if (!message) {
    if (postcatGone(dump.text)) return { error: 'queue_item_not_found' };
    throw new MailNodeError('mail_node_failed', 'The mail node did not show the queued message');
  }
  if (withBody) {
    recordAudit(auditOf(actor, {
      action: 'mail_node.queue_action',
      details: {
        action: 'view_body', queueId, queue: message.queue,
        sender: message.envelope.sender ?? '', recipients: message.envelope.recipients,
      },
    }));
  }
  return message;
}

// "Retry all now" (postqueue -f). Journaled.
export async function flushNodeQueue(actor) {
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  await flushQueue(cfg);
  recordAudit(auditOf(actor, { action: 'mail_node.queue_action', details: { action: 'flush' } }));
  return { ok: true, action: 'flush' };
}

// hold, unhold, deliver or delete one queued message. Delete needs confirm (the screen and the CLI
// ask first); the whole-queue delete of mailcow is never offered. The message must be in the queue
// now; the journal keeps its envelope (sender, recipients, size), so a deleted message stays
// traceable.
export async function queueItemAction(rawId, action, { confirm = false } = {}, actor) {
  const queueId = parseQueueId(rawId);
  if (!queueId) return { error: 'queue_id_invalid' };
  if (![...QUEUE_ACTIONS, 'delete'].includes(action)) return { error: 'queue_action_invalid' };
  if (action === 'delete' && confirm !== true) return { error: 'queue_delete_unconfirmed' };
  const cfg = await getMailNodeConfig();
  if (!cfg) return { error: 'mail_node_not_configured' };
  const item = (await listQueue(cfg)).find((entry) => entry.queueId === queueId);
  if (!item) return { error: 'queue_item_not_found' };
  // postqueue -i does not release a held message: it is released first, by "Release".
  if (action === 'deliver' && item.queue === 'hold') return { error: 'queue_item_held' };
  if (action === 'delete') await deleteQueued(cfg, [queueId]);
  else await queueAction(cfg, [queueId], action);
  recordAudit(auditOf(actor, {
    action: 'mail_node.queue_action',
    details: {
      action, queueId, queue: item.queue, sender: item.sender, size: item.size,
      recipients: item.recipients.map((r) => r.address),
    },
  }));
  return { ok: true, action, queueId };
}

// --- the alerts ---------------------------------------------------------------------------------

// The last run ({ at, alerts, errors, log, queue }, null before the first), the settings and their
// defaults.
export async function alertsView() {
  const [state, settings] = await Promise.all([getAlertState(), getAlertSettings()]);
  return { state, settings, defaults: ALERT_DEFAULTS };
}

// The ping URL of the alerts' own check and the queue thresholds; a field left out keeps its value.
// Journaled by the names of the fields that changed, never their values. Answers { settings }.
export async function saveAlertSettingsAction(body, actor) {
  const { settings, error } = parseAlertSettings(body);
  if (error) return { error };
  const current = await getAlertSettings();
  await saveAlertSettings(settings);
  const fields = Object.keys(settings).filter((field) => settings[field] !== current[field]);
  if (fields.length) recordAudit(auditOf(actor, { action: 'mail_node.config_changed', details: { settings: 'alerts', fields } }));
  return { settings: { ...current, ...settings } };
}
