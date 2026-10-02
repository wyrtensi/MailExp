// fake-EOP for the local stand (scripts/deploy/test/stage.sh eop ...). `serve` runs the SMTP
// receiver; the other commands are run with `docker exec fake-eop node /app/eop.mjs ...` and share
// its state and spool through the data directory.
//
//   serve                          receive mail on :25 (STARTTLS, client certificate, see server.mjs)
//   status                         the control state and the spool size
//   mode <mode> [--stage mail|rcpt|data]
//                                  accept | tempfail | blocked-connector | tenant-limit | recipient-denied | drop
//   connector <name>               the host name the client certificate must carry (no wildcard)
//   list | show [id|latest] | clear
//   inject <id|latest> --to a@b[,c@d] [--verdict spam] [--auth pass|fail] [--folded]
//                       [--host postfix-mailcow] [--port 25]
//                                  hand a stored message to the node with EOP's headers added;
//                                  --to is required: stored messages are addressed to the outside,
//                                  and delivering them as they are would send them out again
//
// Inbound mail queued while the node is down (R-43, see inbound.mjs); serve delivers it:
//   inbound send --from a@b --to x@node[,y@node] [--subject S] [--expire-seconds N]
//                                  a letter from the internet to the node, queued in fake-EOP
//   inbound list | show [id|latest] | retry | clear
//                                  the queue; retry makes every pending letter due at once
//   inbound config [--retry-seconds N] [--expiry-seconds N]
//                                  EOP's 15 minutes and 24 hours, smaller for tests
//   ndr list | show [id|latest] | clear
//                                  the non-delivery reports EOP sent to external senders
//   trace [--start ISO] [--end ISO] the message trace of the inbound queue, as Graph answers it
//
// Env: EOP_DATA (/data: state.json, spool/, tls/eop.crt eop.key ca.pem, inbound/, ndr/,
// inbound-config.json), EOP_HOST (eop.test.local), EOP_CONNECTOR (initial connector name,
// mail.test.local), EOP_PORT (25), EOP_NODE_HOST (postfix-mailcow: where inbound mail goes),
// EOP_TRACE_PORT (8080: the Graph-shaped trace, GET /v1.0/admin/exchange/tracing/messageTraces),
// EOP_INBOUND_TICK (10: seconds between looks at the inbound queue).
// Exit status: 0 done, 1 failed (also: the node refused or dropped the message), 2 bad usage.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  MODES, VERDICTS, eopHeaders, listMessages, loadMessage, readState, smtpSend, validateState, writeState,
} from './lib.mjs';
import {
  clearInbound, composeLetter, listInbound, loadInbound, readInboundConfig, receiveInbound, retryInbound, runInboundPass, traceAnswer, writeInboundConfig,
} from './inbound.mjs';
import { createServer, loadTls } from './server.mjs';

const DATA = process.env.EOP_DATA || '/data';
const STATE = path.join(DATA, 'state.json');
const SPOOL = path.join(DATA, 'spool');
const INBOUND = path.join(DATA, 'inbound');
const NDR = path.join(DATA, 'ndr');
const INBOUND_CONFIG = path.join(DATA, 'inbound-config.json');
const NODE_HOST = process.env.EOP_NODE_HOST || 'postfix-mailcow';
const USAGE = `usage: eop.mjs serve | status | mode <${Object.keys(MODES).join('|')}> [--stage mail|rcpt|data] | connector <host name> | list | show [id|latest] | clear
       eop.mjs inject <id|latest> --to <a@b[,c@d]> [--verdict <${Object.keys(VERDICTS).join('|')}|SFV:..;CAT:..>] [--auth pass|fail] [--folded] [--host H] [--port P]
       eop.mjs inbound send --from <a@b> --to <x@node[,y@node]> [--subject S] [--expire-seconds N] | inbound list | inbound show [id|latest] | inbound retry | inbound clear
       eop.mjs inbound config [--retry-seconds N] [--expiry-seconds N] | ndr list | ndr show [id|latest] | ndr clear | trace [--start ISO] [--end ISO]`;
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;

class UsageError extends Error {}

// Hands an inbound letter to the node, as EOP does through the outbound connector: with EOP's
// headers (a clean verdict), to the recipients given.
function deliverInbound(item, raw, to = item.to) {
  const headers = eopHeaders({ verdict: 'clean', envelope: item, nodeHost: NODE_HOST });
  return smtpSend({
    host: NODE_HOST, port: 25, from: item.from, to, raw: Buffer.concat([Buffer.from(headers, 'latin1'), raw]), timeoutMs: 20000,
  });
}

// The serve process's timer on the inbound queue and its Graph-shaped trace.
function serveInbound(stamp) {
  const tick = Math.max(1, Number(process.env.EOP_INBOUND_TICK || 10)) * 1000;
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      const { retrySeconds } = readInboundConfig(INBOUND_CONFIG);
      await runInboundPass({ dir: INBOUND, ndrDir: NDR, deliver: deliverInbound, host: NODE_HOST, retrySeconds, log: stamp });
    } catch (error) {
      stamp(`event=inbound-error error="${error.message}"`);
    } finally {
      busy = false;
    }
  };
  setInterval(pass, tick);
  const port = Number(process.env.EOP_TRACE_PORT || 8080);
  http.createServer((req, res) => {
    let answer;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'eop.test.local'}`);
      answer = req.method === 'GET' ? traceAnswer(INBOUND, url) : { status: 405, body: { error: { code: 'MethodNotAllowed' } } };
    } catch (error) {
      answer = { status: 400, body: { error: { code: 'BadRequest', message: error.message } } };
    }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  }).listen(port, () => stamp(`event=trace-listen port=${port}`));
}

function inboundCommand(sub, rest, flags) {
  switch (sub) {
    case 'send': {
      const to = (flags.to || '').split(',').map((a) => a.trim()).filter(Boolean);
      if (!flags.from || !ADDRESS_RE.test(flags.from) || to.length === 0 || !to.every((a) => ADDRESS_RE.test(a))) {
        throw new UsageError('inbound send needs --from <a@b> and --to <x@node[,y@node]>');
      }
      const config = readInboundConfig(INBOUND_CONFIG);
      const expirySeconds = flags['expire-seconds'] === undefined ? config.expirySeconds : Number(flags['expire-seconds']);
      if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 86400) throw new Error('--expire-seconds must be a whole number from 1 to 86400');
      const now = new Date();
      const subject = flags.subject || `inbound test ${now.toISOString().slice(11, 19)}`;
      const messageId = `<inbound-${now.getTime()}-${Math.random().toString(16).slice(2, 8)}@${flags.from.split('@')[1]}>`;
      const item = receiveInbound(INBOUND, {
        from: flags.from, to, subject, messageId, raw: composeLetter({ from: flags.from, to, subject, messageId, now }), now, expirySeconds,
      });
      console.log(`queued ${item.id} trace=${item.traceId} ${messageId} to=${to.join(',')} expires=${item.expiresAt}`);
      return;
    }
    case 'list':
      for (const item of listInbound(INBOUND)) {
        const last = item.events.at(-1);
        console.log(`${item.id}  ${item.status} attempts=${item.attempts} from=<${item.from}> to=${item.to.join(',')} received=${item.receivedAt} expires=${item.expiresAt} last="${last.event}: ${last.description}"`);
      }
      return;
    case 'show':
      console.log(JSON.stringify(loadInbound(INBOUND, rest[0] || 'latest').item, null, 2));
      return;
    case 'retry':
      console.log(`${retryInbound(INBOUND)} pending letters due now`);
      return;
    case 'clear':
      clearInbound(INBOUND);
      console.log('inbound queue cleared');
      return;
    case 'config': {
      const patch = {};
      if (flags['retry-seconds'] !== undefined) patch.retrySeconds = Number(flags['retry-seconds']);
      if (flags['expiry-seconds'] !== undefined) patch.expirySeconds = Number(flags['expiry-seconds']);
      const config = Object.keys(patch).length ? writeInboundConfig(INBOUND_CONFIG, patch) : readInboundConfig(INBOUND_CONFIG);
      console.log(`retrySeconds=${config.retrySeconds} expirySeconds=${config.expirySeconds}`);
      return;
    }
    default:
      throw new UsageError(`unknown inbound command "${sub ?? ''}"`);
  }
}

const reportNames = (ext) => {
  try {
    return fs.readdirSync(NDR).filter((name) => name.endsWith(ext)).sort();
  } catch {
    return [];
  }
};

function ndrCommand(sub, rest) {
  switch (sub) {
    case 'list':
      for (const name of reportNames('.json')) {
        const report = JSON.parse(fs.readFileSync(path.join(NDR, name), 'utf8'));
        console.log(`${report.id}  to=<${report.to}> at=${report.at} reply="${report.reply}"`);
      }
      return;
    case 'show': {
      const names = reportNames('.eml');
      const name = !rest[0] || rest[0] === 'latest' ? names.at(-1) : `${rest[0]}.eml`;
      if (!name || !names.includes(name)) throw new Error('no such report');
      process.stdout.write(fs.readFileSync(path.join(NDR, name)));
      return;
    }
    case 'clear':
      fs.rmSync(NDR, { recursive: true, force: true });
      console.log('reports cleared');
      return;
    default:
      throw new UsageError(`unknown ndr command "${sub ?? ''}"`);
  }
}

function options(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--folded') {
      flags.folded = true;
    } else if (args[i].startsWith('--')) {
      if (args[i + 1] === undefined) throw new UsageError(`${args[i]} needs a value`);
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { flags, rest } = options(args);
  switch (command) {
    case 'serve': {
      validateState(readState(STATE));
      const server = createServer({
        host: process.env.EOP_HOST || 'eop.test.local',
        ...loadTls(path.join(DATA, 'tls')),
        stateFile: STATE,
        spoolDir: SPOOL,
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      });
      const port = Number(process.env.EOP_PORT || 25);
      server.on('error', (error) => {
        console.error(`error: ${error.message}`);
        process.exit(1);
      });
      server.listen(port, () => {
        const s = readState(STATE);
        console.log(`${new Date().toISOString()} event=listen port=${port} connector=${s.connector} mode=${s.mode} stage=${s.stage}`);
      });
      serveInbound((line) => console.log(`${new Date().toISOString()} ${line}`));
      return;
    }
    case 'inbound':
      inboundCommand(rest[0], rest.slice(1), flags);
      return;
    case 'ndr':
      ndrCommand(rest[0], rest.slice(1));
      return;
    case 'trace': {
      const url = new URL('http://eop.test.local/v1.0/admin/exchange/tracing/messageTraces');
      const bounds = [];
      if (flags.start) bounds.push(`receivedDateTime ge ${flags.start}`);
      if (flags.end) bounds.push(`receivedDateTime le ${flags.end}`);
      if (bounds.length) url.searchParams.set('$filter', bounds.join(' and '));
      url.searchParams.set('$top', '5000');
      console.log(JSON.stringify(traceAnswer(INBOUND, url).body, null, 2));
      return;
    }
    case 'status': {
      const s = readState(STATE);
      const inbound = listInbound(INBOUND);
      const pending = inbound.filter((item) => item.status === 'pending').length;
      console.log(`mode=${s.mode} stage=${s.stage} connector=${s.connector} stored=${listMessages(SPOOL).length} inbound=${inbound.length} pending=${pending}`);
      return;
    }
    case 'mode': {
      if (!rest[0]) throw new UsageError('mode needs a value');
      const patch = { mode: rest[0] };
      if (flags.stage) patch.stage = flags.stage;
      const s = writeState(STATE, patch);
      console.log(`mode=${s.mode} stage=${s.stage} connector=${s.connector}`);
      return;
    }
    case 'connector': {
      if (!rest[0]) throw new UsageError('connector needs a host name');
      const s = writeState(STATE, { connector: rest[0] });
      console.log(`mode=${s.mode} stage=${s.stage} connector=${s.connector}`);
      return;
    }
    case 'list':
      for (const m of listMessages(SPOOL)) console.log(`${m.id}  from=<${m.from}> to=${m.to.join(',')} cert="${m.cert}" at=${m.receivedAt}`);
      return;
    case 'show': {
      const { envelope, raw } = loadMessage(SPOOL, rest[0] || 'latest');
      console.log(JSON.stringify(envelope));
      process.stdout.write(raw);
      return;
    }
    case 'clear':
      fs.rmSync(SPOOL, { recursive: true, force: true });
      console.log('spool cleared');
      return;
    case 'inject': {
      const to = (flags.to || '').split(',').map((a) => a.trim()).filter(Boolean);
      if (to.length === 0) {
        throw new UsageError('inject needs --to <mailbox of the stand>: a stored message is addressed to the outside and would be relayed out again');
      }
      const { envelope, raw } = loadMessage(SPOOL, rest[0] || 'latest');
      const headers = eopHeaders({
        verdict: flags.verdict || 'spam', auth: flags.auth || 'pass', folded: Boolean(flags.folded), envelope, nodeHost: flags.host || 'postfix-mailcow',
      });
      const result = await smtpSend({
        host: flags.host || 'postfix-mailcow', port: Number(flags.port || 25), from: envelope.from, to, raw: Buffer.concat([Buffer.from(headers, 'latin1'), raw]),
      });
      console.log(`${result.ok ? 'injected' : 'refused'} ${envelope.id} to ${to.join(',')} verdict=${flags.verdict || 'spam'}: ${result.reply}`);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    default:
      throw new UsageError(`unknown command "${command ?? ''}"`);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  if (error instanceof UsageError) console.error(USAGE);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
