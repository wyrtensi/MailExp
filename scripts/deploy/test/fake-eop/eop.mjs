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
// Env: EOP_DATA (/data: state.json, spool/, tls/eop.crt eop.key ca.pem), EOP_HOST (eop.test.local),
// EOP_CONNECTOR (initial connector name, mail.test.local), EOP_PORT (25).
// Exit status: 0 done, 1 failed (also: the node refused or dropped the message), 2 bad usage.
import fs from 'node:fs';
import path from 'node:path';
import {
  MODES, VERDICTS, eopHeaders, listMessages, loadMessage, readState, smtpSend, validateState, writeState,
} from './lib.mjs';
import { createServer, loadTls } from './server.mjs';

const DATA = process.env.EOP_DATA || '/data';
const STATE = path.join(DATA, 'state.json');
const SPOOL = path.join(DATA, 'spool');
const USAGE = `usage: eop.mjs serve | status | mode <${Object.keys(MODES).join('|')}> [--stage mail|rcpt|data] | connector <host name> | list | show [id|latest] | clear
       eop.mjs inject <id|latest> --to <a@b[,c@d]> [--verdict <${Object.keys(VERDICTS).join('|')}|SFV:..;CAT:..>] [--auth pass|fail] [--folded] [--host H] [--port P]`;

class UsageError extends Error {}

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
      return;
    }
    case 'status': {
      const s = readState(STATE);
      console.log(`mode=${s.mode} stage=${s.stage} connector=${s.connector} stored=${listMessages(SPOOL).length}`);
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
