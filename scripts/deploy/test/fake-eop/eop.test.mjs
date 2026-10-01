// node --test scripts/deploy/test/fake-eop/eop.test.mjs   (needs openssl on PATH)
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  attribute, dotStuff, eopHeaders, fold, listMessages, loadMessage, modeReply, newId, parseAddress, readState, saveMessage, smtpSend, writeState,
} from './lib.mjs';
import { createServer, MAX_LINE, MAX_SIZE } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = { timeout: 30000 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-eop-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
const file = (name) => path.join(dir, name);
const pem = (name) => fs.readFileSync(file(name));
const toDer = (name) => Buffer.from(pem(name).toString().replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
const DAY = 86400e3;

// A CA: self-signed, CA:TRUE.
function authority(name, { days = 30 } = {}) {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', String(days), '-subj', `/CN=${name}`,
    '-addext', 'basicConstraints=critical,CA:TRUE');
}

// A certificate named `name` (file name and CN) issued by `ca`. san: DNS name for the SAN, null for
// none. eku: extended key usage, null for none. isCa: basicConstraints CA:TRUE/FALSE, null for none.
function issue(name, {
  ca = 'ca', eku = 'serverAuth', days = 30, san = name, isCa = null,
} = {}) {
  const lines = [];
  if (san) lines.push(`subjectAltName=DNS:${san}`);
  if (eku) lines.push(`extendedKeyUsage=${eku}`);
  if (isCa !== null) lines.push(`basicConstraints=critical,CA:${isCa ? 'TRUE' : 'FALSE'}`);
  fs.writeFileSync(file(`${name}.ext`), `${lines.join('\n')}\n`);
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `${name}.pem`, '-days', String(days), '-extfile', `${name}.ext`);
}

authority('ca');
authority('other-ca');
authority('short-ca', { days: 1 });
issue('mail.test.local');
issue('eop.test.local');
issue('other.test.local');
issue('rogue.test.local', { ca: 'other-ca' });
issue('wild.test.local', { san: '*.test.local' });
issue('cnonly.test.local', { san: null });
issue('clientauth.test.local', { eku: 'clientAuth' });
issue('codesign.test.local', { eku: 'codeSigning' });
issue('noeku.test.local', { eku: null });
issue('late.test.local', { ca: 'short-ca' });
issue('inter', { eku: null, isCa: true });
issue('leaf.test.local', { ca: 'inter', eku: null });
issue('notca', { eku: null, isCa: false });
issue('leaf2.test.local', { ca: 'notca', eku: null });

test('modeReply answers with EOP wording, fills in the address and accepts in accept mode', () => {
  assert.equal(modeReply('accept', '1.2.3.4'), null);
  assert.deepEqual(modeReply('blocked-connector', '1.2.3.4'), { code: 550, text: '5.7.711 Access denied, bad inbound connector. AS(2204)' });
  assert.match(modeReply('tempfail', '1.2.3.4').text, /^4\.7\.500 .*\[1\.2\.3\.4\]/);
  assert.equal(modeReply('drop', 'x').drop, true);
  assert.match(modeReply('tenant-limit', 'x').text, /^5\.7\.233/);
  assert.match(modeReply('recipient-denied', 'x').text, /^5\.4\.1 Recipient address rejected: Access denied/);
});

test('state: defaults, env connector, validated writes, file wins over env', () => {
  const f = file('state.json');
  assert.deepEqual(readState(f, {}), { mode: 'accept', stage: 'rcpt', connector: 'mail.test.local' });
  assert.equal(readState(f, { EOP_CONNECTOR: 'a.test' }).connector, 'a.test');
  assert.equal(writeState(f, { mode: 'tempfail' }, {}).mode, 'tempfail');
  assert.equal(readState(f, { EOP_CONNECTOR: 'a.test' }).connector, 'a.test');
  writeState(f, { connector: 'b.test' }, {});
  assert.equal(readState(f, { EOP_CONNECTOR: 'a.test' }).connector, 'b.test');
  assert.throws(() => writeState(f, { mode: 'nope' }, {}), /unknown mode/);
  assert.throws(() => writeState(f, { stage: 'eod' }, {}), /unknown stage/);
  assert.throws(() => writeState(f, { connector: 'a b' }, {}), /host name/);
  assert.throws(() => writeState(f, { connector: '*.test.local' }, {}), /no wildcard/);
  assert.throws(() => writeState(f, { connector: '' }, {}), /host name/);
  assert.equal(readState(f, {}).connector, 'b.test');
});

test('parseAddress', () => {
  assert.equal(parseAddress('<a@b.c> SIZE=10'), 'a@b.c');
  assert.equal(parseAddress('<>'), '');
  assert.equal(parseAddress('a@b.c'), null);
});

test('attribute: matching name passes; wrong name, no certificate, foreign CA and expired fail', () => {
  const ca = pem('ca.pem');
  const ok = attribute([toDer('mail.test.local.pem')], ca, 'mail.test.local');
  assert.equal(ok.ok, true);
  assert.match(ok.subject, /CN=mail\.test\.local/);
  assert.match(attribute([toDer('other.test.local.pem')], ca, 'mail.test.local').reason, /does not match connector mail\.test\.local/);
  assert.match(attribute([], ca, 'mail.test.local').reason, /no client certificate/);
  assert.match(attribute([toDer('rogue.test.local.pem')], ca, 'rogue.test.local').reason, /untrusted chain/);
  assert.match(attribute([toDer('mail.test.local.pem')], ca, 'mail.test.local', new Date(Date.now() + 90 * DAY)).reason, /out of date/);
});

test('attribute: a wildcard in the certificate matches one label, and the CN counts when there is no SAN', () => {
  const ca = pem('ca.pem');
  assert.equal(attribute([toDer('wild.test.local.pem')], ca, 'mail.test.local').ok, true);
  assert.match(attribute([toDer('wild.test.local.pem')], ca, 'a.b.test.local').reason, /does not match/);
  assert.match(attribute([toDer('wild.test.local.pem')], ca, 'test.local').reason, /does not match/);
  assert.equal(attribute([toDer('cnonly.test.local.pem')], ca, 'cnonly.test.local').ok, true);
  assert.match(attribute([toDer('cnonly.test.local.pem')], ca, 'mail.test.local').reason, /does not match/);
});

test('attribute: key usage is lax (serverAuth, clientAuth, none) but a certificate for something else is refused', () => {
  const ca = pem('ca.pem');
  for (const name of ['mail.test.local', 'clientauth.test.local', 'noeku.test.local']) {
    assert.equal(attribute([toDer(`${name}.pem`)], ca, name).ok, true, name);
  }
  assert.match(attribute([toDer('codesign.test.local.pem')], ca, 'codesign.test.local').reason, /not usable for TLS/);
});

test('attribute: an expired CA fails even when the leaf is still in date', () => {
  const ca = pem('short-ca.pem');
  assert.equal(attribute([toDer('late.test.local.pem')], ca, 'late.test.local').ok, true);
  const later = new Date(Date.now() + 5 * DAY);
  assert.match(attribute([toDer('late.test.local.pem')], ca, 'late.test.local', later).reason, /trusted CA is out of date/);
});

test('attribute: a chain through an intermediate CA is accepted only when the intermediate is present', () => {
  const ca = pem('ca.pem');
  assert.equal(attribute([toDer('leaf.test.local.pem'), toDer('inter.pem')], ca, 'leaf.test.local').ok, true);
  assert.match(attribute([toDer('leaf.test.local.pem')], ca, 'leaf.test.local').reason, /incomplete or untrusted chain/);
});

test('attribute: an intermediate that is not a CA (CA:FALSE) is refused', () => {
  const ca = pem('ca.pem');
  assert.match(attribute([toDer('leaf2.test.local.pem'), toDer('notca.pem')], ca, 'leaf2.test.local').reason, /intermediate certificate is not a CA/);
});

test('ids sort in order of creation, also within one millisecond; latest is the last stored', () => {
  const now = new Date('2026-10-01T10:00:00.123Z');
  const ids = Array.from({ length: 30 }, () => newId(now));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, 30);
  const spool = file('spool-ids');
  const saved = Array.from({ length: 12 }, (_, i) => saveMessage(spool, { from: 'a@b', to: ['c@d'] }, Buffer.from(`m${i}`)));
  assert.deepEqual(listMessages(spool).map((m) => m.id), saved);
  assert.equal(loadMessage(spool, 'latest').raw.toString(), 'm11');
  assert.equal(loadMessage(spool, saved[3]).raw.toString(), 'm3');
  assert.deepEqual(fs.readdirSync(spool).filter((n) => n.endsWith('.tmp')), []);
});

test('eopHeaders: verdict presets, verbatim strings, none, folding', () => {
  const envelope = { from: 'someone@Stage.Test' };
  const now = new Date('2026-10-01T10:00:00Z');
  const spam = eopHeaders({ verdict: 'spam', envelope, now });
  assert.match(spam, /^Received: from eop\.test\.local .* 01 Oct 2026 10:00:00 \+0000\r\n/);
  assert.match(spam, /X-Forefront-Antispam-Report: CIP:[\d.]+;.*SFV:SPM;.*CAT:SPM;.*DIR:INB;\r\n/);
  assert.match(spam, /Authentication-Results: eop\.test\.local; spf=pass smtp\.mailfrom=stage\.test; dkim=pass .*dmarc=pass/);
  assert.match(eopHeaders({ verdict: 'high-confidence-phish', envelope }), /SFV:SPM;.*CAT:HPHSH/);
  assert.match(eopHeaders({ verdict: 'SFV:SKB;CAT:SPM', envelope }), /X-Forefront-Antispam-Report: CIP:[\d.]+;SFV:SKB;CAT:SPM;DIR:INB;/);
  assert.doesNotMatch(eopHeaders({ verdict: 'none', envelope }), /X-Forefront/);
  const clean = eopHeaders({ verdict: 'clean', auth: 'fail', envelope });
  assert.match(clean, /X-Forefront-Antispam-Report: .*SCL:1;.*SFV:NSPM;.*CAT:NONE;/);
  assert.match(clean, /dmarc=fail action=quarantine/);
  assert.throws(() => eopHeaders({ verdict: 'weird', envelope }), /unknown verdict/);
  const folded = eopHeaders({ verdict: 'spam', folded: true, envelope });
  const block = /X-Forefront-Antispam-Report:.*(?:\r\n [^\r\n]*)+/.exec(folded)[0];
  assert.ok(block.split('\r\n').length >= 2);
  assert.ok(block.split('\r\n').every((l) => l.length <= 80));
  const flat = (text) => text.replace(/\s+/g, '');
  assert.equal(flat(block), flat(`X-Forefront-Antispam-Report: ${/Report: (.*)\r\n/.exec(eopHeaders({ verdict: 'spam', envelope }))[1]}`));
  assert.equal(fold('H', 'a;b;'), 'H: a; b;');
});

test('dotStuff: CRLF-delimited lines only; a lone CR before a dot is not a line start', () => {
  assert.equal(dotStuff(Buffer.from('a\r.b\n.c\n')), 'a\r.b\r\n..c\r\n');
  assert.equal(dotStuff(Buffer.from('.first\r\nlast')), '..first\r\nlast\r\n');
  assert.equal(dotStuff(Buffer.from('')), '\r\n');
});

// --- an SMTP client for the server tests -------------------------------------------------------

const REPLY = /^(?:\d{3}-[^\n]*\r\n)*\d{3} [^\n]*\r\n/;

function client(port) {
  let socket = net.connect(port, '127.0.0.1');
  let buffer = '';
  const waiters = [];
  let closedFlag = false;
  const closed = new Promise((resolve) => { socket.on('close', () => { closedFlag = true; resolve(); }); });
  const drain = () => {
    for (;;) {
      const match = REPLY.exec(buffer);
      if (!match || waiters.length === 0) return;
      buffer = buffer.slice(match[0].length);
      waiters.shift().resolve(match[0].trimEnd());
    }
  };
  const attach = (s) => {
    s.on('data', (chunk) => { buffer += chunk.toString('latin1'); drain(); });
    s.on('error', () => {});
  };
  attach(socket);
  const self = {
    closed,
    isClosed: () => closedFlag,
    // The next reply; rejects after `ms`, so a server that hangs fails the test instead of the run.
    read(ms = 5000) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve: (r) => { clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`no reply within ${ms} ms (buffer: ${JSON.stringify(buffer)})`));
        }, ms);
        waiters.push(waiter);
        drain();
      });
    },
    write(text) { socket.write(text, 'latin1'); },
    send(line) { socket.write(`${line}\r\n`, 'latin1'); return self.read(); },
    async waitClosed(ms = 5000) {
      await Promise.race([closed, new Promise((_, reject) => { setTimeout(() => reject(new Error(`the connection stayed open for ${ms} ms`)), ms).unref(); })]);
    },
    session: null,
    starttls(options) {
      return new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, rejectUnauthorized: false, ...options }, () => resolve(secure));
        self.session = new Promise((got) => { secure.once('session', got); });
        secure.on('error', reject);
        socket.removeAllListeners('data');
        socket = secure;
        attach(secure);
      });
    },
  };
  return self;
}

async function greeted(port) {
  const c = client(port);
  assert.match(await c.read(), /^220 eop\.test\.local/);
  return c;
}

async function secured(port, options, extra = {}) {
  const c = await greeted(port);
  await c.send('EHLO mail.test.local');
  assert.match(await c.send('STARTTLS'), /^220 2\.0\.0/);
  c.secure = await c.starttls({ ...options, ...extra });
  await c.send('EHLO mail.test.local');
  return c;
}

// One delivery: options null means no STARTTLS at all.
async function deliver(port, options, { from = 'a@stage.test', rcpt = 'test@example.com', body = 'Subject: t\r\n\r\nhello\r\n..dot\r\n.' } = {}) {
  const out = {};
  if (options === null) {
    const c = await greeted(port);
    await c.send('EHLO mail.test.local');
    out.mail = await c.send(`MAIL FROM:<${from}>`);
    await c.send('QUIT');
    return out;
  }
  const c = await secured(port, options);
  out.mail = await c.send(`MAIL FROM:<${from}>`);
  out.rcpt = await c.send(`RCPT TO:<${rcpt}>`);
  if (out.rcpt.startsWith('250')) {
    out.data = await c.send('DATA');
    out.end = await c.send(body);
  }
  await c.send('QUIT');
  return out;
}

async function withServer(fn, { spoolDir } = {}) {
  const state = file(`state-${Math.random().toString(16).slice(2)}.json`);
  const spool = spoolDir ?? file(`spool-${Math.random().toString(16).slice(2)}`);
  const lines = [];
  const server = createServer({
    host: 'eop.test.local', key: pem('eop.test.local.key'), cert: pem('eop.test.local.pem'), caPem: pem('ca.pem'), stateFile: state, spoolDir: spool, log: (l) => lines.push(l),
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    await fn({ port: server.address().port, state, spool, lines });
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  }
}
const mailCert = () => ({ key: pem('mail.test.local.key'), cert: pem('mail.test.local.pem') });

// --- the server --------------------------------------------------------------------------------

test('server: no STARTTLS, no MAIL', T, () => withServer(async ({ port }) => {
  const r = await deliver(port, null);
  assert.match(r.mail, /^530 5\.7\.0 Must issue a STARTTLS/);
}));

test('server: the connector certificate is accepted, the message is stored unstuffed, the session is logged', T, () => withServer(async ({ port, spool, lines }) => {
  const r = await deliver(port, mailCert());
  assert.match(r.rcpt, /^250 2\.1\.5/);
  assert.match(r.end, /^250 2\.6\.0 <.*@eop\.test\.local>/);
  const [envelope] = listMessages(spool);
  assert.equal(envelope.from, 'a@stage.test');
  assert.deepEqual(envelope.to, ['test@example.com']);
  assert.match(envelope.cert, /CN=mail\.test\.local/);
  assert.match(envelope.tls, /^TLSv1\.[23]$/);
  assert.equal(loadMessage(spool, 'latest').raw.toString(), 'Subject: t\r\n\r\nhello\r\n.dot\r\n');
  assert.ok(lines.some((l) => /event=starttls attribution=ok/.test(l) && /tls=TLSv1\.[23]/.test(l) && /cert="CN=mail\.test\.local"/.test(l)));
  assert.ok(lines.some((l) => /event=accept .*verdict=accepted/.test(l)));
}));

test('server: dot-unstuffing counts CRLF-delimited lines only', T, () => withServer(async ({ port, spool }) => {
  await deliver(port, mailCert(), { body: 'Subject: t\r\n\r\nx\r..y\r\n..dot\r\n...\r\n.' });
  assert.equal(loadMessage(spool, 'latest').raw.toString(), 'Subject: t\r\n\r\nx\r..y\r\n.dot\r\n..\r\n');
  await deliver(port, mailCert(), { body: '..first line\r\nz\r\n.' });
  assert.equal(loadMessage(spool, 'latest').raw.toString(), '.first line\r\nz\r\n');
}));

test('server: an empty sender <> is accepted with the right certificate and refused without it', T, () => withServer(async ({ port, spool }) => {
  const ok = await deliver(port, mailCert(), { from: '' });
  assert.match(ok.mail, /^250 2\.1\.0/);
  assert.match(ok.end, /^250 2\.6\.0/);
  assert.equal(loadMessage(spool, 'latest').envelope.from, '');
  const refused = await deliver(port, {}, { from: '' });
  assert.match(refused.rcpt, /^550 5\.7\.64/);
  assert.equal(listMessages(spool).length, 1);
}));

test('server: a certificate for another name, none, or another CA gives 5.7.64', T, () => withServer(async ({ port, spool, lines }) => {
  for (const options of [
    { key: pem('other.test.local.key'), cert: pem('other.test.local.pem') },
    {},
    { key: pem('rogue.test.local.key'), cert: pem('rogue.test.local.pem') },
  ]) {
    const r = await deliver(port, options);
    assert.match(r.rcpt, /^550 5\.7\.64 TenantAttribution; Relay Access Denied/);
  }
  assert.equal(listMessages(spool).length, 0);
  assert.ok(lines.some((l) => /verdict=attribution-failed/.test(l)));
}));

test('server: a wildcard certificate attributes to the connector name', T, () => withServer(async ({ port }) => {
  const wild = { key: pem('wild.test.local.key'), cert: pem('wild.test.local.pem') };
  assert.match((await deliver(port, wild)).rcpt, /^250/);
}));

test('server: the connector name is read per session', T, () => withServer(async ({ port, state }) => {
  writeState(state, { connector: 'other.test.local' }, {});
  assert.match((await deliver(port, mailCert())).rcpt, /^550 5\.7\.64/);
  assert.match((await deliver(port, { key: pem('other.test.local.key'), cert: pem('other.test.local.pem') })).rcpt, /^250/);
}));

test('server: a client that resumes its TLS session is served, as Postfix does on its second connection', T, () => withServer(async ({ port, spool }) => {
  for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
    const first = await secured(port, mailCert(), { maxVersion });
    const session = await Promise.race([first.session, new Promise((_, reject) => { setTimeout(() => reject(new Error(`${maxVersion}: no session issued`)), 5000).unref(); })]);
    await first.send('QUIT');
    const second = await secured(port, mailCert(), { maxVersion, session });
    assert.equal(second.secure.isSessionReused(), true, `${maxVersion}: the session was resumed`);
    assert.match(await second.send('MAIL FROM:<a@stage.test>'), /^250/);
    assert.match(await second.send('RCPT TO:<b@example.com>'), /^250/);
    await second.send('QUIT');
  }
  assert.equal(listMessages(spool).length, 0);
}));

test('server: modes answer with their codes, at the stage chosen, and drop cuts the connection', T, () => withServer(async ({ port, state, spool }) => {
  const expected = { tempfail: /^451 4\.7\.500/, 'blocked-connector': /^550 5\.7\.711 .*AS\(2204\)/, 'tenant-limit': /^550 5\.7\.233/, 'recipient-denied': /^550 5\.4\.1 Recipient address rejected: Access denied/ };
  for (const [mode, re] of Object.entries(expected)) {
    writeState(state, { mode }, {});
    assert.match((await deliver(port, mailCert())).rcpt, re, mode);
  }
  writeState(state, { mode: 'blocked-connector', stage: 'data' }, {});
  const late = await deliver(port, mailCert());
  assert.match(late.rcpt, /^250/);
  assert.match(late.end, /^550 5\.7\.711/);
  writeState(state, { mode: 'tempfail', stage: 'mail' }, {});
  assert.match((await deliver(port, mailCert())).mail, /^451 4\.7\.500/);
  assert.equal(listMessages(spool).length, 0);
  writeState(state, { mode: 'drop', stage: 'rcpt' }, {});
  const c = await secured(port, mailCert());
  await c.send('MAIL FROM:<a@stage.test>');
  c.write('RCPT TO:<b@example.com>\r\n');
  await c.waitClosed();
}));

test('server: STARTTLS pipelined with a plaintext command drops the command; STARTTLS inside TLS gets 503 and the rest is processed', T, () => withServer(async ({ port }) => {
  const c = await greeted(port);
  await c.send('EHLO mail.test.local');
  c.write('STARTTLS\r\nNOOP\r\n');
  assert.match(await c.read(), /^220 2\.0\.0/);
  c.secure = await c.starttls(mailCert());
  assert.match(await c.send('EHLO mail.test.local'), /^250-eop\.test\.local/);
  c.write('STARTTLS\r\nNOOP\r\n');
  assert.match(await c.read(), /^503 5\.5\.1 TLS already active/);
  assert.match(await c.read(), /^250 2\.0\.0 OK/);
  await c.send('QUIT');
}));

test('server: a bare LF is refused at once with 500, in commands and in the message', T, () => withServer(async ({ port }) => {
  const plain = await greeted(port);
  plain.write('EHLO x\n');
  assert.match(await plain.read(), /^500 5\.5\.2 Error: bare <LF> received/);
  await plain.waitClosed();
  const c = await secured(port, mailCert());
  await c.send('MAIL FROM:<a@stage.test>');
  await c.send('RCPT TO:<b@example.com>');
  await c.send('DATA');
  c.write('Subject: t\n\nbody\n.\n');
  assert.match(await c.read(), /^500 5\.5\.2 Error: bare <LF> received/);
  await c.waitClosed();
}));

test('server: SIZE is advertised as the limit that is enforced; long command lines are refused', T, () => withServer(async ({ port }) => {
  const c = await greeted(port);
  c.write('EHLO x\r\n');
  assert.match(await c.read(), new RegExp(`250-SIZE ${MAX_SIZE}\\b`));
  assert.match(await c.send('STARTTLS'), /^220/);
  c.secure = await c.starttls(mailCert());
  await c.send('EHLO x');
  assert.match(await c.send(`MAIL FROM:<a@stage.test> SIZE=${MAX_SIZE + 1}`), /^552 5\.3\.4/);
  assert.match(await c.send(`MAIL FROM:<a@stage.test> SIZE=${MAX_SIZE}`), /^250/);
  assert.match(await c.send(`NOOP ${'a'.repeat(MAX_LINE + 10)}`), /^500 5\.5\.2 Line too long/);
  assert.match(await c.send('NOOP'), /^250 2\.0\.0 OK/);
  c.write('x'.repeat(MAX_LINE * 2));
  assert.match(await c.read(), /^500 5\.5\.2 Line too long/);
  await c.waitClosed();
}));

test('server: a spool that cannot be written gives 451 and the server stays up', T, async () => {
  const blocker = file('not-a-directory');
  fs.writeFileSync(blocker, 'x');
  await withServer(async ({ port, lines }) => {
    const r = await deliver(port, mailCert());
    assert.match(r.end, /^451 4\.3\.0 Mail system error/);
    assert.ok(lines.some((l) => /event=spool-error/.test(l)));
    assert.match((await deliver(port, mailCert())).end, /^451/);
  }, { spoolDir: blocker });
});

// --- the SMTP client and the command line ------------------------------------------------------

function sink(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); });
}

test('smtpSend hands the message over with its envelope and dot-stuffing', T, async () => {
  const seen = [];
  const { server, port } = await sink((socket) => {
    let body = false;
    let buffer = '';
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        seen.push(line);
        if (body) {
          if (line === '.') { body = false; socket.write('250 2.0.0 queued as ABC\r\n'); }
        } else if (line === 'DATA') { body = true; socket.write('354 go\r\n'); } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  const result = await smtpSend({ host: '127.0.0.1', port, from: 'a@stage.test', to: ['x@stage.test', 'y@stage.test'], raw: Buffer.from('Subject: s\n\n.leading dot\nx\r.y\n') });
  server.close();
  assert.equal(result.ok, true);
  assert.match(result.reply, /^250 2\.0\.0 queued as ABC/);
  assert.ok(seen.includes('MAIL FROM:<a@stage.test>') && seen.includes('RCPT TO:<y@stage.test>'));
  assert.ok(seen.includes('..leading dot'));
  assert.ok(seen.includes('x\r.y'), 'a lone CR before a dot is not a line start');
});

test('smtpSend reports a refusal with its code', T, async () => {
  const { server, port } = await sink((socket) => {
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.startsWith('RCPT')) socket.write('550 5.1.1 no such user\r\n');
      else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  const result = await smtpSend({ host: '127.0.0.1', port, from: 'a@stage.test', to: ['x@stage.test'], raw: Buffer.from('x') });
  server.close();
  assert.equal(result.ok, false);
  assert.match(result.reply, /^550 5\.1\.1/);
});

test('smtpSend rejects when the peer closes before the final reply, and when it goes silent', T, async () => {
  const closing = await sink((socket) => { socket.write('220 sink\r\n'); socket.on('data', () => socket.destroy()); });
  await assert.rejects(smtpSend({ host: '127.0.0.1', port: closing.port, from: 'a@b', to: ['c@d'], raw: Buffer.from('x') }), /closed before the final reply/);
  closing.server.close();
  const silent = await sink((socket) => { socket.write('220 sink\r\n'); });
  await assert.rejects(smtpSend({ host: '127.0.0.1', port: silent.port, from: 'a@b', to: ['c@d'], raw: Buffer.from('x'), timeoutMs: 300 }), /timeout/);
  silent.server.close();
  await assert.rejects(smtpSend({ host: '127.0.0.1', port: 1, from: 'a@b', to: ['c@d'], raw: Buffer.from('x') }), /ECONNREFUSED|connect/);
});

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, 'eop.mjs'), ...args], { env: { ...process.env, ...env }, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('eop.mjs: inject needs --to, exits 1 when the node drops or refuses, 0 when it accepts', T, async () => {
  const data = file('cli-data');
  saveMessage(path.join(data, 'spool'), { from: 'a@stage.test', to: ['test@example.com'] }, Buffer.from('Subject: s\r\n\r\nbody\r\n'));
  const env = { EOP_DATA: data };
  const noTo = await cli(['inject', 'latest'], env);
  assert.equal(noTo.code, 2);
  assert.match(noTo.stderr, /inject needs --to/);
  const dropped = await sink((socket) => { socket.write('220 sink\r\n'); socket.on('data', () => socket.destroy()); });
  const failed = await cli(['inject', 'latest', '--to', 'x@stage.test', '--host', '127.0.0.1', '--port', String(dropped.port)], env);
  dropped.server.close();
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /closed before the final reply/);
  const refusing = await sink((socket) => {
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      if (chunk.toString().startsWith('RCPT')) socket.write('550 5.1.1 no such user\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  const refused = await cli(['inject', 'latest', '--to', 'x@stage.test', '--host', '127.0.0.1', '--port', String(refusing.port)], env);
  refusing.server.close();
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /refused .* 550 5\.1\.1/);
  const accepting = await sink((socket) => {
    let body = false;
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (body) { if (text.endsWith('\r\n.\r\n')) { body = false; socket.write('250 2.0.0 queued\r\n'); } } else if (text.startsWith('DATA')) { body = true; socket.write('354 go\r\n'); } else if (text.startsWith('QUIT')) socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  const done = await cli(['inject', 'latest', '--to', 'x@stage.test', '--host', '127.0.0.1', '--port', String(accepting.port)], env);
  accepting.server.close();
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /^injected .* verdict=spam: 250 2\.0\.0 queued/);
});

test('eop.mjs: bad usage exits 2, a bad value exits 1, a wildcard connector is refused', T, async () => {
  const env = { EOP_DATA: file('cli-data-2') };
  assert.equal((await cli(['frob'], env)).code, 2);
  assert.equal((await cli(['mode'], env)).code, 2);
  const bad = await cli(['mode', 'nope'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown mode/);
  const wildcard = await cli(['connector', '*.test.local'], env);
  assert.equal(wildcard.code, 1);
  assert.match(wildcard.stderr, /no wildcard/);
  const ok = await cli(['mode', 'tempfail', '--stage', 'data'], env);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /mode=tempfail stage=data/);
});
