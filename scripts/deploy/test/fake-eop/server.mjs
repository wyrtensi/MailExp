// The SMTP side of fake-EOP: what Exchange Online Protection does to mail from a mail node that is
// an on-premises connector. STARTTLS is mandatory, the client certificate is checked against the
// connector name, and a control file picks the answer (see lib.mjs, MODES).
//
// Line discipline is strict, like Postfix's smtpd_forbid_bare_newline: commands and message lines
// end in CRLF, and a bare LF is answered with 500 5.5.2 and a closed connection at once.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import {
  acceptReply, attribute, headerMessageId, modeReply, parseAddress, readState, saveMessage,
} from './lib.mjs';

export const MAX_SIZE = 25 * 1024 * 1024;
export const MAX_LINE = 2048;
// The accept reply's InternalId (Exchange's are 13-14 digit numbers) and Hostname (the EOP server
// that took the letter, a made-up name in Exchange's form).
const INTERNAL_ID_BASE = 1099511627776;
const EOP_SERVER = 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local';
const IDLE_MS = 60000;

// options: { host, key, cert, caPem, stateFile, spoolDir, log(line) }
export function createServer(options) {
  const {
    host = 'eop.test.local', key, cert, caPem, stateFile, spoolDir, log = () => {},
  } = options;
  // sessionIdContext: a client that resumes a TLS session (Postfix does on its second connection)
  // needs it when client certificates are requested, and a bare TLSSocket has none of its own.
  const secureContext = tls.createSecureContext({
    key, cert, ca: caPem, sessionIdContext: 'fake-eop',
  });
  let counter = 0;
  let accepted = 0;

  return net.createServer((raw) => {
    counter += 1;
    const conn = counter;
    const ip = (raw.remoteAddress || '').replace(/^::ffff:/, '');
    const session = {
      socket: raw, tls: false, version: '', cert: '-', attribution: null, helo: '', from: null, rcpts: [],
    };
    let inbuf = ''; // received text, latin1: what is not yet a complete command, or the message so far
    let inData = false; // inbuf holds a message that began with a virtual CRLF
    let scanFrom = 0;
    let closed = false;

    const say = (line) => { if (!session.socket.destroyed) session.socket.write(`${line}\r\n`); };
    const note = (event, extra = '') => log(`conn=${conn} ip=${ip} tls=${session.version || 'none'} cert="${session.cert}" ${event}${extra ? ` ${extra}` : ''}`);
    const closeNote = () => { if (!closed) { closed = true; note('event=close'); } };
    const reset = () => { session.from = null; session.rcpts = []; };
    const drop = (why) => { note('event=drop', `why=${why}`); session.socket.destroy(); };

    // The answer owed at `stage` (null: go on). Attribution comes before the mode, as at EOP.
    const gate = (stage) => {
      const state = readState(stateFile);
      if (state.stage !== stage) return null;
      if (!session.attribution?.ok) {
        const why = session.attribution?.reason || 'no client certificate';
        return { code: 550, text: `5.7.64 TenantAttribution; Relay Access Denied [fake-eop: ${why}]`, verdict: `attribution-failed (${why}; connector ${state.connector})` };
      }
      const reply = modeReply(state.mode, ip);
      return reply ? { ...reply, verdict: `mode=${state.mode}` } : null;
    };
    const refuse = (reply) => {
      if (reply.drop) { drop('mode=drop'); return; }
      note(`event=reject reply="${reply.code} ${reply.text}"`, `verdict=${reply.verdict}`);
      say(`${reply.code} ${reply.text}`);
    };

    // Switches the connection to TLS. Whatever the client sent after STARTTLS in the clear is
    // dropped with the rest of inbuf (RFC 3207: no plaintext command injection into the TLS state).
    const upgrade = () => {
      const plain = session.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('timeout');
      const secure = new tls.TLSSocket(plain, {
        isServer: true, secureContext, requestCert: true, rejectUnauthorized: false,
      });
      secure.setTimeout(IDLE_MS, () => secure.destroy());
      secure.on('error', (error) => note('event=tls-error', `error="${error.message}"`));
      secure.on('secure', () => {
        session.socket = secure;
        session.tls = true;
        session.version = secure.getProtocol() || '';
        const chain = [];
        const seen = new Set();
        for (let c = secure.getPeerCertificate(true); c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
          seen.add(c.fingerprint256);
          chain.push(c.raw);
        }
        const { connector } = readState(stateFile);
        session.attribution = attribute(chain, caPem, connector);
        session.cert = session.attribution.subject || '-';
        note('event=starttls', `attribution=${session.attribution.ok ? 'ok' : `failed reason="${session.attribution.reason}"`} connector=${connector}`);
      });
      secure.on('data', onData);
      secure.on('close', closeNote);
      session.socket = secure;
      session.helo = '';
      reset();
      inbuf = '';
    };

    const finishData = (message) => {
      const gateReply = gate('data');
      if (gateReply) { refuse(gateReply); reset(); return; }
      let id;
      try {
        id = saveMessage(spoolDir, {
          from: session.from, to: session.rcpts, peer: ip, tls: session.version, cert: session.cert, helo: session.helo, receivedAt: new Date().toISOString(),
        }, message);
      } catch (error) {
        note('event=spool-error', `error="${error.message}"`);
        say('451 4.3.0 Mail system error: the fake-EOP spool is not writable');
        reset();
        return;
      }
      note(`event=accept id=${id} from="<${session.from}>" rcpt="${session.rcpts.join(',')}" bytes=${message.length}`, 'verdict=accepted');
      say(acceptReply({
        messageId: headerMessageId(message),
        fallbackId: `<${id}@${host}>`,
        internalId: INTERNAL_ID_BASE + (accepted += 1),
        hostname: EOP_SERVER,
        bytes: message.length,
        seconds: (Date.now() - session.dataAt) / 1000,
      }));
      reset();
    };

    // Runs one command; returns 'tls' when the connection was just switched to TLS.
    const command = (line) => {
      const [verbRaw, ...rest] = line.split(' ');
      const verb = verbRaw.toUpperCase();
      const arg = rest.join(' ');
      switch (verb) {
        case 'EHLO':
        case 'HELO':
          session.helo = arg;
          reset();
          if (verb === 'HELO') { say(`250 ${host} Hello [${ip}]`); return null; }
          say(`250-${host} Hello [${ip}]`);
          say(`250-SIZE ${MAX_SIZE}`);
          say('250-PIPELINING');
          say('250-8BITMIME');
          say('250-SMTPUTF8');
          if (!session.tls) say('250-STARTTLS');
          say('250 ENHANCEDSTATUSCODES');
          return null;
        case 'STARTTLS':
          if (session.tls) { say('503 5.5.1 TLS already active'); return null; }
          say('220 2.0.0 SMTP server ready');
          upgrade();
          return 'tls';
        case 'MAIL': {
          if (!session.tls) { say('530 5.7.0 Must issue a STARTTLS command first'); return null; }
          const address = /^FROM:\s*(.*)$/i.exec(arg);
          const from = address ? parseAddress(address[1]) : null;
          if (from === null) { say('501 5.5.4 Syntax error in parameters or arguments'); return null; }
          const declared = /\sSIZE=(\d+)/i.exec(address[1]);
          if (declared && Number(declared[1]) > MAX_SIZE) { say('552 5.3.4 Message size exceeds fixed limit'); return null; }
          const reply = gate('mail');
          if (reply) { refuse(reply); return null; }
          session.from = from;
          say('250 2.1.0 Sender OK');
          return null;
        }
        case 'RCPT': {
          if (!session.tls) { say('530 5.7.0 Must issue a STARTTLS command first'); return null; }
          if (session.from === null) { say('503 5.5.1 Need MAIL command first'); return null; }
          const address = /^TO:\s*(.*)$/i.exec(arg);
          const rcpt = address ? parseAddress(address[1]) : null;
          if (!rcpt) { say('501 5.5.4 Syntax error in parameters or arguments'); return null; }
          const reply = gate('rcpt');
          if (reply) { refuse(reply); return null; }
          session.rcpts.push(rcpt);
          say('250 2.1.5 Recipient OK');
          return null;
        }
        case 'DATA':
          if (!session.tls) { say('530 5.7.0 Must issue a STARTTLS command first'); return null; }
          if (session.from === null || session.rcpts.length === 0) { say('503 5.5.1 Need MAIL and RCPT commands first'); return null; }
          // A virtual CRLF in front lets ".\r\n" as the first line and "\r\n.." stuffing be handled alike.
          inbuf = `\r\n${inbuf}`;
          inData = true;
          session.dataAt = Date.now();
          scanFrom = 0;
          say('354 Start mail input; end with <CRLF>.<CRLF>');
          return null;
        case 'RSET': reset(); say('250 2.0.0 Resetting'); return null;
        case 'NOOP': say('250 2.0.0 OK'); return null;
        case 'VRFY': say('252 2.5.2 Cannot VRFY user, but will take message for this user'); return null;
        case 'QUIT': say('221 2.0.0 Service closing transmission channel'); session.socket.end(); return null;
        default: say('500 5.5.2 Syntax error, command unrecognized'); return null;
      }
    };

    // Takes commands and message text out of inbuf for as long as complete ones are there.
    const pump = () => {
      for (;;) {
        if (session.socket.destroyed) return;
        if (inData) {
          const end = inbuf.indexOf('\r\n.\r\n', scanFrom);
          if (end < 0) {
            if (inbuf.length > MAX_SIZE) { say('552 5.3.4 Message size exceeds fixed limit'); drop('too-big'); return; }
            scanFrom = Math.max(0, inbuf.length - 4);
            return;
          }
          // Unstuffing only after a CRLF; the virtual CRLF in front is cut off again.
          const message = Buffer.from(inbuf.slice(0, end + 2).replace(/\r\n\.\./g, '\r\n.').slice(2), 'latin1');
          inbuf = inbuf.slice(end + 5);
          inData = false;
          finishData(message);
          continue;
        }
        const eol = inbuf.indexOf('\r\n');
        if (eol < 0) {
          if (inbuf.length > MAX_LINE) { say('500 5.5.2 Line too long'); drop('line-too-long'); }
          return;
        }
        const line = inbuf.slice(0, eol);
        inbuf = inbuf.slice(eol + 2);
        if (line.length > MAX_LINE) { say('500 5.5.2 Line too long'); continue; }
        if (command(line.trim()) === 'tls') return; // what follows belongs to the TLS layer
      }
    };

    function onData(chunk) {
      try {
        // A bare LF (one not preceded by CR) is refused at once, not waited out until a timeout.
        const from = Math.max(0, inbuf.length - 1);
        inbuf += chunk.toString('latin1');
        const bare = /(?<!\r)\n/g;
        bare.lastIndex = from;
        if (bare.test(inbuf)) {
          say('500 5.5.2 Error: bare <LF> received');
          drop('bare-lf');
          return;
        }
        pump();
      } catch (error) {
        note('event=internal-error', `error="${error.message}"`);
        session.socket.destroy();
      }
    }

    note('event=connect');
    raw.setTimeout(IDLE_MS, () => { say('421 4.4.2 Connection timed out'); raw.destroy(); });
    raw.on('error', (error) => note('event=socket-error', `error="${error.message}"`));
    raw.on('close', closeNote);
    raw.on('data', onData);
    say(`220 ${host} Microsoft ESMTP MAIL Service ready`);
  });
}

// Reads the TLS files written by `stage.sh eop up`.
export function loadTls(dir) {
  return {
    key: fs.readFileSync(`${dir}/eop.key`),
    cert: fs.readFileSync(`${dir}/eop.crt`),
    caPem: fs.readFileSync(`${dir}/ca.pem`),
  };
}
