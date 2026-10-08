import { WAIT_FLAGS, WAIT_HELP, jobLine, maybeWait, unwrap } from '../common.js';
import { fmtDate, keyValues, table } from '../output.js';
import { MAIL_NODE_ERRORS } from '../../services/mailNode/errors.js';
import { checkSeatsNow, seatsView, setSeatHold } from '../../services/mailNode/seatActions.js';
import { requestSeats } from '../../services/mailNode/seatProvider.js';
import { jobAnswer } from '../../services/tenant/tenantActions.js';

// mailexpert seats ...: the EOP seats (services/mailNode/seatActions.js, seatProvider.js; EOP seats
// design, 2026-10-07): used, held and free, the hold period, reconciling with Microsoft and asking
// for more.

const status = {
  name: 'status',
  summary: 'used, held and free seats, the hold period and the open seat requests',
  usage: 'seats status',
  async run() {
    const view = await seatsView();
    const lines = [
      ...keyValues([
        ['used', view.used],
        ['held', view.held],
        ['free', view.known ? view.free : 'unknown: enter the licenses ("eop set --licenses N") or reconcile'],
        ['over', view.over || undefined],
        ['number from', `${view.source ?? '-'} (${view.mode})`],
        ['checked', view.mode === 'graph' ? fmtDate(view.checkedAt) : undefined],
        ['stale', view.mode === 'graph' ? view.stale : undefined],
        ['no EOP subscription', view.subscriptionMissing || undefined],
        ['read error', view.error ? view.error.code : undefined],
        ['hold days', view.holdDays],
      ]),
      '',
      'held seats:',
      ...table(view.heldSeats, [
        { header: '  SEAT', value: (s) => `  ${s.seat}` },
        { header: 'ADDRESS', value: (s) => s.email },
        { header: 'REASON', value: (s) => s.reason },
        { header: 'FREE FROM', value: (s) => fmtDate(s.freeFrom) },
      ], { empty: '  (none)' }),
      '',
      'open requests:',
      ...table(view.requests, [
        { header: '  ID', value: (r) => `  ${r.id}` },
        { header: 'SEATS', value: (r) => r.seats },
        { header: 'ASKED', value: (r) => fmtDate(r.requestedAt) },
        { header: 'BY', value: (r) => r.requestedBy },
      ], { empty: '  (none)' }),
    ];
    return { data: view, lines };
  },
};

const check = {
  name: 'check',
  summary: 'reconcile: read the purchased number from Microsoft now (queues the tenant job)',
  usage: 'seats check [--wait] [--timeout SEC]',
  journal: 'none for queuing; the run is journaled by MailExpert, as for the button',
  help: ['Refused (seats_manual) while the number is entered by hand ("eop set --licenses N").', ...WAIT_HELP],
  flags: WAIT_FLAGS,
  async run(ctx) {
    const { job: row } = unwrap(await checkSeatsNow(ctx.actor), MAIL_NODE_ERRORS);
    const job = await maybeWait(ctx, jobAnswer(row));
    return { data: { job }, lines: [jobLine(job)] };
  },
};

const setHold = {
  name: 'set-hold',
  summary: 'set how many days a released seat stays held for its mailbox (0 to 3650)',
  usage: 'seats set-hold <days>',
  journal: 'mail_node.seat_hold_changed with the old and new value, when it changes',
  help: ['The seats on hold now are re-dated with the new period.'],
  positionals: ['days'],
  async run(ctx) {
    const result = unwrap(await setSeatHold(ctx.args.days, ctx.actor), MAIL_NODE_ERRORS);
    return { data: result, lines: [`hold period: ${result.holdDays} days`] };
  },
};

const request = {
  name: 'request',
  summary: 'ask for more EOP seats (kept until the purchased number covers them)',
  usage: 'seats request <seats>',
  journal: 'mail_node.seats_requested',
  positionals: ['seats'],
  async run(ctx) {
    const result = unwrap(await requestSeats({ seats: ctx.args.seats }, ctx.actor), MAIL_NODE_ERRORS);
    return { data: result, lines: [`request ${result.request.id}: ${result.request.seats} seats asked for`] };
  },
};

export default {
  name: 'seats',
  summary: 'the EOP seats: status, reconcile, the hold period and requests',
  commands: [status, check, setHold, request],
};
