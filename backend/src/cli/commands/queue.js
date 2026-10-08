import { confirm, nodeAction, unwrap } from '../common.js';
import { keyValues, table } from '../output.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { flushNodeQueue, nodeQueue, queueItemAction, queuedMessage } from '../../services/mailNode/nodeOpsActions.js';

// mailexpert queue ...: the mail node's Postfix queue (R-16; services/mailNode/nodeOpsActions.js,
// the "Mail queue" part of the "Mail node" screen). A message is named by its Postfix queue ID.
// mailcow's delete of the whole queue is never offered.

function age(seconds) {
  if (seconds == null) return null;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const list = {
  name: 'list',
  summary: 'list the queued messages, the oldest first, with counts per queue',
  usage: 'queue list',
  async run() {
    const result = unwrap(await nodeAction(() => nodeQueue()), MAIL_NODE_ERRORS);
    const lines = table(result.items, [
      { header: 'QUEUE ID', value: (m) => m.queueId },
      { header: 'QUEUE', value: (m) => m.queue },
      { header: 'AGE', value: (m) => age(m.ageSeconds) },
      { header: 'SIZE', value: (m) => m.size },
      { header: 'SENDER', value: (m) => m.sender || '<>' },
      { header: 'RECIPIENTS', value: (m) => m.recipients.map((r) => (r.reason ? `${r.address} (${r.reason})` : r.address)) },
    ], { empty: 'the queue is empty' });
    const counts = Object.entries(result.counts).filter(([, n]) => n).map(([queue, n]) => `${queue} ${n}`);
    lines.push('', `total ${result.total}${counts.length ? `: ${counts.join(', ')}` : ''}${result.oldestDeferredSeconds != null ? `; oldest deferred ${age(result.oldestDeferredSeconds)}` : ''}`);
    return { data: result, lines };
  },
};

const show = {
  name: 'show',
  journal: 'mail_node.queue_action (view_body) with --body: the ID and the envelope, never the body',
  summary: 'show one queued message: envelope and headers, the body only with --body',
  usage: 'queue show <queue-id> [--body]',
  help: ['--body   print the body too (cut at 64 KB); reading it is journaled'],
  flags: { body: 'boolean' },
  positionals: ['id'],
  async run(ctx) {
    const message = unwrap(await nodeAction(() => queuedMessage(ctx.args.id, { withBody: !!ctx.flags.body }, ctx.actor)), MAIL_NODE_ERRORS);
    const lines = keyValues([
      ['queue id', message.queueId],
      ['queue', message.queue],
      ['sender', message.envelope.sender || '<>'],
      ['recipients', message.envelope.recipients],
      ['delivered to', message.envelope.doneRecipients.length ? message.envelope.doneRecipients : undefined],
      ['arrival', message.envelope.arrival],
      ['body bytes', message.bodyBytes],
    ]);
    lines.push('', ...message.headers.map((h) => `${h.name}: ${h.value}`));
    if (ctx.flags.body) lines.push('', message.body ?? '', ...(message.bodyTruncated ? ['[body cut at 64 KB]'] : []));
    return { data: message, lines };
  },
};

const flush = {
  name: 'flush',
  journal: 'mail_node.queue_action (flush)',
  summary: 'try every deferred message again now (postqueue -f, the "Retry all now" button)',
  usage: 'queue flush',
  async run(ctx) {
    await confirm(ctx, 'Try every deferred message in the node\'s queue again now?');
    const result = unwrap(await nodeAction(() => flushNodeQueue(ctx.actor)), MAIL_NODE_ERRORS);
    return { data: result, lines: ['queue flushed: the node tries every deferred message again'] };
  },
};

const DONE = Object.freeze({ hold: 'held', unhold: 'released', deliver: 'delivery tried', delete: 'deleted' });

function itemCommand(name, action, summary, question = null) {
  return {
    name,
    journal: `mail_node.queue_action (${action}) with the message's envelope`,
    summary,
    usage: `queue ${name} <queue-id>`,
    positionals: ['id'],
    async run(ctx) {
      if (question) await confirm(ctx, question(ctx.args.id));
      const result = unwrap(await nodeAction(() => queueItemAction(ctx.args.id, action, { confirm: action === 'delete' }, ctx.actor)), MAIL_NODE_ERRORS);
      return { data: result, lines: [`${result.queueId}: ${DONE[action]}`] };
    },
  };
}

export default {
  name: 'queue',
  summary: 'the mail node\'s mail queue: list, show, flush, hold, release, deliver, delete',
  commands: [
    list, show, flush,
    itemCommand('hold', 'hold', 'put a queued message on hold: it waits until released'),
    itemCommand('release', 'unhold', 'release a held message back to the queue'),
    itemCommand('deliver', 'deliver', 'try to deliver one deferred message now (a held one must be released first)'),
    itemCommand('delete', 'delete', 'delete one queued message: it is never delivered',
      (id) => `Delete the queued message ${id}? It is never delivered.`),
  ],
};
