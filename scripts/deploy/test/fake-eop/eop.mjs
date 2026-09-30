// fake-EOP for the local stand (scripts/deploy/test/stage.sh eop ...). `serve` runs the SMTP
// receiver; the other commands are run with `docker exec fake-eop node /app/eop.mjs ...` and share
// its state and spool through the data directory.
//
//   serve                          receive mail on :25 (STARTTLS, client certificate, see server.mjs)
//   status                         the control state and the spool size
//   mode <mode> [--stage mail|rcpt|data]
//                                  accept | tempfail | blocked-connector | tenant-limit | recipient-denied | drop
//   connector <name>               the name the client certificate must carry
//   list | show <id|latest> | clear
//   inject <id|latest> [--verdict spam] [--to a@b,c@d] [--auth pass|fail] [--folded]
//                       [--host postfix-mailcow] [--port 25]
//                                  hand a stored message to the node with EOP's headers added
//
// Env: EOP_DATA (/data: state.json, spool/, tls/eop.crt eop.key ca.pem), EOP_HOST (eop.test.local),
// EOP_CONNECTOR (initial connector name, mail.test.local), EOP_PORT (25).
import fs from 'node:fs';
import path from 'node:path';
import {
  MODES, eopHeaders, listMessages, loadMessage, readState, smtpSend, writeState,
} from './lib.mjs';
import { createServer, loadTls } from './server.mjs';

const DATA = process.env.EOP_DATA || '/data';
const STATE = path.join(DATA, 'state.json');
const SPOOL = path.join(DATA, 'spool');

function options(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--folded') flags.folded = true;
    else if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i += 1; } else rest.push(args[i]);
  }
  return { flags, rest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { flags, rest } = options(args);
  switch (command) {
    case 'serve': {
      const server = createServer({
        host: process.env.EOP_HOST || 'eop.test.local',
        ...loadTls(path.join(DATA, 'tls')),
        stateFile: STATE,
        spoolDir: SPOOL,
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      });
      const port = Number(process.env.EOP_PORT || 25);
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
      const patch = { mode: rest[0] };
      if (flags.stage) patch.stage = flags.stage;
      const s = writeState(STATE, patch);
      console.log(`mode=${s.mode} stage=${s.stage} connector=${s.connector}`);
      return;
    }
    case 'connector': {
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
      const { envelope, raw } = loadMessage(SPOOL, rest[0] || 'latest');
      const to = flags.to ? flags.to.split(',').map((a) => a.trim()).filter(Boolean) : envelope.to;
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
      console.error(`usage: eop.mjs serve|status|mode <${Object.keys(MODES).join('|')}>|connector <name>|list|show <id>|clear|inject <id> [--verdict v] [--to a,b]`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
