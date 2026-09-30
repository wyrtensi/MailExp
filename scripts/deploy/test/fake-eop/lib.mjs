// Pure parts of fake-EOP: state, canned replies, client certificate check, spool, header injection
// and the small SMTP client that re-injects a stored message. No dependencies, Node 22.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

export const STAGES = ['mail', 'rcpt', 'data'];

// What a mode answers. `{ip}` is the client address. The wording follows what EOP returns.
export const MODES = {
  accept: null,
  tempfail: { code: 451, text: '4.7.500 Server busy. Please try again later from [{ip}]. (S77)' },
  'blocked-connector': { code: 550, text: '5.7.711 Access denied, bad inbound connector. AS(2204)' },
  'tenant-limit': {
    code: 550,
    text: "5.7.233 Your message can't be sent because your tenant exceeded its daily limit for sending email to external recipients",
  },
  'recipient-denied': { code: 550, text: '5.4.1 Recipient address rejected: Access denied. AS(201806281)' },
  drop: { drop: true },
};

export const DEFAULT_STATE = { mode: 'accept', stage: 'rcpt', connector: 'mail.test.local' };

export function readState(file, env = process.env) {
  const base = { ...DEFAULT_STATE };
  if (env.EOP_CONNECTOR) base.connector = env.EOP_CONNECTOR;
  try {
    return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return base;
  }
}

// Validates a change and writes it atomically; throws Error on a bad value. Only what was set is
// stored, so the connector name from the environment stays the default until one is set.
export function writeState(file, patch, env = process.env) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  const saved = { ...stored, ...patch };
  const next = { ...readState('', env), ...saved };
  if (!Object.hasOwn(MODES, next.mode)) throw new Error(`unknown mode "${next.mode}"; one of: ${Object.keys(MODES).join(', ')}`);
  if (!STAGES.includes(next.stage)) throw new Error(`unknown stage "${next.stage}"; one of: ${STAGES.join(', ')}`);
  if (!/^[A-Za-z0-9.*-]+$/.test(next.connector)) throw new Error('the connector name must be a host name');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

// The reply a mode gives, `{ code, text }`, `{ drop: true }`, or null to accept.
export function modeReply(mode, ip) {
  const entry = MODES[mode];
  if (!entry) return null;
  if (entry.drop) return entry;
  return { code: entry.code, text: entry.text.replace('{ip}', ip) };
}

function derOf(item) {
  return Buffer.isBuffer(item) ? item : Buffer.from(item);
}

// Decides whether a client certificate attributes the mail to the connector, the way EOP does for
// a tenant: the chain up to a trusted CA must be complete and in date, and the connector name must
// be in the subject alternative names (or the CN when there are none). `chain` is the leaf first,
// as DER; `caPem` the stand CA. Returns { ok, reason?, subject?, names? }.
export function attribute(chain, caPem, connector, now = new Date()) {
  if (!chain || chain.length === 0) return { ok: false, reason: 'no client certificate' };
  let certs;
  let ca;
  try {
    certs = chain.map((der) => new X509Certificate(derOf(der)));
    ca = new X509Certificate(caPem);
  } catch (error) {
    return { ok: false, reason: `unreadable certificate: ${error.message}` };
  }
  const leaf = certs[0];
  const subject = leaf.subject.replace(/\n/g, ',');
  const names = leaf.subjectAltName || subject;
  for (const cert of certs) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return { ok: false, reason: 'certificate out of date', subject };
  }
  let trusted = false;
  for (let i = 0; i < certs.length; i += 1) {
    if (certs[i].checkIssued(ca) && certs[i].verify(ca.publicKey)) {
      trusted = true;
      break;
    }
    const next = certs[i + 1];
    if (!next || !certs[i].checkIssued(next) || !certs[i].verify(next.publicKey)) break;
  }
  if (!trusted) return { ok: false, reason: 'incomplete or untrusted chain', subject, names };
  if (!leaf.checkHost(connector, { subject: 'default' })) {
    return { ok: false, reason: `certificate name does not match connector ${connector}`, subject, names };
  }
  return { ok: true, subject, names };
}

// "<a@b>" or "<a@b> SIZE=1" -> "a@b"; "<>" -> "". Null when the argument has no address.
export function parseAddress(arg) {
  const match = /^<([^<>]*)>/.exec(arg.trim());
  return match ? match[1] : null;
}

export function newId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(3).toString('hex')}`;
}

export function saveMessage(dir, envelope, raw) {
  fs.mkdirSync(dir, { recursive: true });
  const id = newId();
  fs.writeFileSync(path.join(dir, `${id}.eml`), raw);
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ id, ...envelope }, null, 2)}\n`);
  return id;
}

export function listMessages(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

// `latest` picks the newest stored message.
export function loadMessage(dir, id) {
  const all = listMessages(dir);
  const envelope = id === 'latest' ? all[all.length - 1] : all.find((m) => m.id === id);
  if (!envelope) throw new Error(id === 'latest' ? 'no stored messages' : `no stored message ${id}`);
  return { envelope, raw: fs.readFileSync(path.join(dir, `${envelope.id}.eml`)) };
}

// X-Forefront-Antispam-Report presets: SFV verdict, CAT category, SCL. Anything with a colon in it
// is taken as the verbatim middle of the header, e.g. "SFV:SKB;CAT:SPM".
export const VERDICTS = {
  clean: { SCL: '1', SFV: 'NSPM', CAT: 'NONE' },
  spam: { SCL: '5', SFV: 'SPM', CAT: 'SPM' },
  'high-confidence-spam': { SCL: '9', SFV: 'SPM', CAT: 'HSPM' },
  bulk: { SCL: '6', SFV: 'SPM', CAT: 'BULK' },
  phish: { SCL: '5', SFV: 'SPM', CAT: 'PHSH' },
  'high-confidence-phish': { SCL: '9', SFV: 'SPM', CAT: 'HPHSH' },
  spoof: { SCL: '5', SFV: 'SPM', CAT: 'SPOOF' },
  'blocked-sender': { SCL: '9', SFV: 'SKB', CAT: 'SPM' },
  'rule-spam': { SCL: '9', SFV: 'SKS', CAT: 'SPM' },
  none: null,
};

// RFC 5322 folding at ';' boundaries: the header as EOP sometimes delivers it, on several lines.
export function fold(name, value, width = 76) {
  const lines = [];
  let line = `${name}:`;
  let parts = 0;
  for (const part of value.split(/(?<=;)/)) {
    if (parts > 0 && line.length + 1 + part.length > width) {
      lines.push(line);
      line = '';
      parts = 0;
    }
    line += ` ${part}`;
    parts += 1;
  }
  lines.push(line);
  return lines.join('\r\n');
}

// Headers to put on top of a stored message: Received, Authentication-Results and, unless the
// verdict is `none`, X-Forefront-Antispam-Report. Returns the header block, CRLF-terminated.
export function eopHeaders({ verdict = 'spam', auth = 'pass', folded = false, envelope, nodeHost = 'postfix-mailcow', now = new Date() }) {
  const fromDomain = (envelope.from.split('@')[1] || 'unknown.invalid').toLowerCase();
  const out = [
    `Received: from eop.test.local (eop.test.local) by ${nodeHost} with ESMTP; ${now.toUTCString().replace('GMT', '+0000')}`,
    `Authentication-Results: eop.test.local; spf=${auth} smtp.mailfrom=${fromDomain}; dkim=${auth} header.d=${fromDomain}; dmarc=${auth === 'pass' ? 'pass action=none' : 'fail action=quarantine'} header.from=${fromDomain}; compauth=${auth === 'pass' ? 'pass reason=100' : 'fail reason=000'}`,
  ];
  let report = null;
  if (verdict.includes(':')) {
    report = `CIP:203.0.113.10;${verdict};DIR:INB;`;
  } else if (Object.hasOwn(VERDICTS, verdict)) {
    const preset = VERDICTS[verdict];
    if (preset) {
      report = `CIP:203.0.113.10;CTRY:;LANG:en;SCL:${preset.SCL};SRV:;IPV:NLI;SFV:${preset.SFV};H:eop.test.local;PTR:;CAT:${preset.CAT};SFS:;DIR:INB;`;
    }
  } else {
    throw new Error(`unknown verdict "${verdict}"; one of: ${Object.keys(VERDICTS).join(', ')}, or a SFV:..;CAT:.. string`);
  }
  if (report) {
    out.push(folded ? fold('X-Forefront-Antispam-Report', report) : `X-Forefront-Antispam-Report: ${report}`);
    out.push(`X-MS-Exchange-Organization-SCL: ${/SCL:(\d+)/.exec(report)?.[1] ?? '-1'}`);
  }
  return `${out.join('\r\n')}\r\n`;
}

// A minimal SMTP client: one plain connection, one transaction. Resolves with the final reply.
export function smtpSend({ host, port = 25, from, to, raw, helo = 'eop.test.local', timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    let buffer = '';
    let step = 0;
    const replies = [];
    const body = `${raw.toString('latin1').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}`;
    const steps = [
      () => `EHLO ${helo}`,
      () => `MAIL FROM:<${from}>`,
      ...to.map((rcpt) => () => `RCPT TO:<${rcpt}>`),
      () => 'DATA',
      () => `${body}${body.endsWith('\r\n') ? '' : '\r\n'}.`,
      () => 'QUIT',
    ];
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        const match = /^(?:\d{3}-.*\r?\n)*\d{3}[ ].*\r?\n/.exec(buffer);
        if (!match) return;
        const reply = match[0].trimEnd();
        buffer = buffer.slice(match[0].length);
        replies.push(reply);
        const code = Number(reply.slice(0, 3));
        // 354 is followed by the body; the greeting and every 2xx/3xx lets the next command go.
        if (code >= 400) {
          socket.end('QUIT\r\n');
          resolve({ ok: false, reply, replies });
          return;
        }
        if (step >= steps.length) {
          socket.end();
          resolve({ ok: true, reply: replies[replies.length - 2], replies });
          return;
        }
        const line = steps[step]();
        step += 1;
        socket.write(`${line}\r\n`);
      }
    });
  });
}
