// The SMTP side of fake-EOP: what Exchange Online Protection does to mail from a mail node that is
// an on-premises connector. STARTTLS is mandatory, the client certificate is checked against the
// connector name, and a control file picks the answer (see lib.mjs, MODES).
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import {
  attribute, modeReply, parseAddress, readState, saveMessage,
} from './lib.mjs';

const MAX_SIZE = 50 * 1024 * 1024;

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

  return net.createServer((raw) => {
    counter += 1;
    const conn = counter;
    const ip = (raw.remoteAddress || '').replace(/^::ffff:/, '');
    const session = {
      socket: raw, tls: false, version: '', cert: '-', attribution: null, helo: '', from: null, rcpts: [], data: null,
    };
    const say = (line) => { if (!session.socket.destroyed) session.socket.write(`${line}\r\n`); };
    const note = (event, extra = '') => log(`conn=${conn} ip=${ip} tls=${session.version || 'none'} cert="${session.cert}" ${event}${extra ? ` ${extra}` : ''}`);
    let closed = false;
    const closeNote = () => { if (!closed) { closed = true; note('event=close'); } };
    const reset = () => { session.from = null; session.rcpts = []; session.data = null; };
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
      if (reply.drop) { drop('mode=drop'); return true; }
      note(`event=reject reply="${reply.code} ${reply.text}"`, `verdict=${reply.verdict}`);
      say(`${reply.code} ${reply.text}`);
      return true;
    };

    const inTls = () => session.tls;
    const upgrade = () => {
      const plain = session.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('timeout');
      const secure = new tls.TLSSocket(plain, {
        isServer: true, secureContext, requestCert: true, rejectUnauthorized: false,
      });
      secure.setTimeout(60000, () => secure.destroy());
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
        session.attribution = attribute(chain, caPem, readState(stateFile).connector);
        session.cert = session.attribution.subject || '-';
        note('event=starttls', `attribution=${session.attribution.ok ? 'ok' : `failed reason="${session.attribution.reason}"`} connector=${readState(stateFile).connector}`);
      });
      secure.on('data', onData);
      secure.on('close', closeNote);
      session.socket = secure;
      buffer = Buffer.alloc(0);
    };

    let buffer = Buffer.alloc(0);

    const finishData = (message) => {
      const gateReply = gate('data');
      if (gateReply) { refuse(gateReply); reset(); return; }
      const id = saveMessage(spoolDir, {
        from: session.from, to: session.rcpts, peer: ip, tls: session.version, cert: session.cert, helo: session.helo, receivedAt: new Date().toISOString(),
      }, message);
      note(`event=accept id=${id} from="<${session.from}>" rcpt="${session.rcpts.join(',')}" bytes=${message.length}`, 'verdict=accepted');
      say(`250 2.6.0 <${id}@${host}> [InternalId=${counter}] Queued mail for delivery`);
      reset();
    };

    const command = (line) => {
      const [verbRaw, ...rest] = line.split(' ');
      const verb = verbRaw.toUpperCase();
      const arg = rest.join(' ');
      switch (verb) {
        case 'EHLO':
        case 'HELO':
          session.helo = arg;
          reset();
          if (verb === 'HELO') { say(`250 ${host} Hello [${ip}]`); return; }
          say(`250-${host} Hello [${ip}]`);
          say('250-SIZE 157286400');
          say('250-PIPELINING');
          say('250-8BITMIME');
          say('250-SMTPUTF8');
          if (!inTls()) say('250-STARTTLS');
          say('250 ENHANCEDSTATUSCODES');
          return;
        case 'STARTTLS':
          if (inTls()) { say('503 5.5.1 TLS already active'); return; }
          say('220 2.0.0 SMTP server ready');
          upgrade();
          return;
        case 'MAIL': {
          if (!inTls()) { say('530 5.7.0 Must issue a STARTTLS command first'); return; }
          const address = /^FROM:\s*(.*)$/i.exec(arg);
          const from = address ? parseAddress(address[1]) : null;
          if (from === null) { say('501 5.5.4 Syntax error in parameters or arguments'); return; }
          const reply = gate('mail');
          if (reply) { refuse(reply); return; }
          session.from = from;
          say('250 2.1.0 Sender OK');
          return;
        }
        case 'RCPT': {
          if (!inTls()) { say('530 5.7.0 Must issue a STARTTLS command first'); return; }
          if (session.from === null) { say('503 5.5.1 Need MAIL command first'); return; }
          const address = /^TO:\s*(.*)$/i.exec(arg);
          const rcpt = address ? parseAddress(address[1]) : null;
          if (!rcpt) { say('501 5.5.4 Syntax error in parameters or arguments'); return; }
          const reply = gate('rcpt');
          if (reply) { refuse(reply); return; }
          session.rcpts.push(rcpt);
          say('250 2.1.5 Recipient OK');
          return;
        }
        case 'DATA':
          if (!inTls()) { say('530 5.7.0 Must issue a STARTTLS command first'); return; }
          if (session.from === null || session.rcpts.length === 0) { say('503 5.5.1 Need MAIL and RCPT commands first'); return; }
          session.data = Buffer.from('\r\n');
          say('354 Start mail input; end with <CRLF>.<CRLF>');
          return;
        case 'RSET': reset(); say('250 2.0.0 Resetting'); return;
        case 'NOOP': say('250 2.0.0 OK'); return;
        case 'VRFY': say('252 2.5.2 Cannot VRFY user, but will take message for this user'); return;
        case 'QUIT': say('221 2.0.0 Service closing transmission channel'); session.socket.end(); return;
        default: say('500 5.5.2 Syntax error, command unrecognized');
      }
    };

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (session.data) {
          session.data = Buffer.concat([session.data, buffer]);
          buffer = Buffer.alloc(0);
          const end = session.data.indexOf('\r\n.\r\n');
          if (end < 0) {
            if (session.data.length > MAX_SIZE) { say('552 5.3.4 Message too big'); drop('too-big'); }
            return;
          }
          const tail = session.data.subarray(end + 5);
          // The message without the leading CRLF we put in, with dot-stuffing removed.
          const message = Buffer.from(session.data.subarray(2, end + 2).toString('latin1').replace(/^\.\./gm, '.'), 'latin1');
          session.data = null;
          buffer = Buffer.from(tail);
          finishData(message);
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) {
          if (buffer.length > 4096) drop('line-too-long');
          return;
        }
        const line = buffer.subarray(0, eol).toString('latin1');
        buffer = buffer.subarray(eol + 2);
        const wasStarttls = /^STARTTLS$/i.test(line.trim());
        command(line.trim());
        if (wasStarttls) return; // what follows belongs to the TLS layer
        if (session.socket.destroyed) return;
      }
    }

    note('event=connect');
    raw.setTimeout(60000, () => { say('421 4.4.2 Connection timed out'); raw.destroy(); });
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
