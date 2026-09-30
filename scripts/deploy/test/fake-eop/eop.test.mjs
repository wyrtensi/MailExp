// node --test scripts/deploy/test/fake-eop/eop.test.mjs   (needs openssl on PATH)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  attribute, eopHeaders, fold, listMessages, loadMessage, modeReply, parseAddress, readState, smtpSend, writeState,
} from './lib.mjs';
import { createServer } from './server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-eop-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
const file = (name) => path.join(dir, name);

function issue(name, { ca = 'ca', usage = 'serverAuth', days = 30 } = {}) {
  fs.writeFileSync(file(`${name}.ext`), `subjectAltName=DNS:${name}\nextendedKeyUsage=${usage}\n`);
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `${name}.pem`, '-days', String(days), '-extfile', `${name}.ext`);
}
function authority(name) {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '30', '-subj', `/CN=${name}`);
}

authority('ca');
authority('other-ca');
issue('mail.test.local');
issue('eop.test.local');
issue('other.test.local');
issue('rogue.test.local', { ca: 'other-ca' });
const pem = (name) => fs.readFileSync(file(name));
const toDer = (name) => Buffer.from(pem(name).toString().replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');

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
  assert.match(attribute([toDer('mail.test.local.pem')], ca, 'mail.test.local', new Date(Date.now() + 90 * 86400e3)).reason, /out of date/);
});

test('attribute: a chain through an intermediate is accepted only when the intermediate is present', () => {
  issue('inter', { usage: 'serverAuth' });
  fs.writeFileSync(file('leaf.ext'), 'subjectAltName=DNS:leaf.test.local\n');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=leaf.test.local');
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '30', '-extfile', 'leaf.ext');
  const ca = pem('ca.pem');
  assert.equal(attribute([toDer('leaf.pem'), toDer('inter.pem')], ca, 'leaf.test.local').ok, true);
  assert.match(attribute([toDer('leaf.pem')], ca, 'leaf.test.local').reason, /incomplete or untrusted chain/);
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
  assert.match(eopHeaders({ verdict: 'clean', auth: 'fail', envelope }), /SFV:NSPM.*\r\n.*/);
  assert.match(eopHeaders({ verdict: 'clean', auth: 'fail', envelope }), /dmarc=fail action=quarantine/);
  assert.throws(() => eopHeaders({ verdict: 'weird', envelope }), /unknown verdict/);
  const folded = eopHeaders({ verdict: 'spam', folded: true, envelope });
  const block = /X-Forefront-Antispam-Report:.*(?:\r\n [^\r\n]*)+/.exec(folded)[0];
  assert.ok(block.split('\r\n').length >= 2);
  assert.ok(block.split('\r\n').every((l) => l.length <= 80));
  const flat = (text) => text.replace(/\s+/g, '');
  assert.equal(flat(block), flat(`X-Forefront-Antispam-Report: ${/Report: (.*)\r\n/.exec(eopHeaders({ verdict: 'spam', envelope }))[1]}`));
  assert.equal(fold('H', 'a;b;'), 'H: a; b;');
});

// An SMTP conversation helper for the server tests: sends a line, collects the reply.
function client(port) {
  let socket = net.connect(port, '127.0.0.1');
  let buffer = '';
  const waiters = [];
  const closed = new Promise((resolve) => { socket.on('close', resolve); });
  const attach = (s) => {
    s.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const match = /^(?:\d{3}-.*\r\n)*\d{3} .*\r\n/.exec(buffer);
      if (match && waiters.length > 0) {
        buffer = buffer.slice(match[0].length);
        waiters.shift()(match[0].trimEnd());
      }
    });
    s.on('error', () => {});
  };
  attach(socket);
  const read = () => new Promise((resolve) => {
    const match = /^(?:\d{3}-.*\r\n)*\d{3} .*\r\n/.exec(buffer);
    if (match) { buffer = buffer.slice(match[0].length); resolve(match[0].trimEnd()); } else waiters.push(resolve);
  });
  return {
    closed,
    read,
    async send(line) { socket.write(`${line}\r\n`); return read(); },
    starttls(options) {
      return new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, rejectUnauthorized: false, ...options }, () => resolve(secure));
        secure.on('error', reject);
        secure.on('session', (session) => { this.lastSession = session; });
        socket.removeAllListeners('data');
        socket = secure;
        attach(secure);
      });
    },
  };
}

async function deliver(port, options, rcpt = 'test@example.com') {
  const c = client(port);
  const greeting = await c.read();
  assert.match(greeting, /^220 eop\.test\.local/);
  const out = { greeting, steps: [] };
  const step = async (line) => { const r = await c.send(line); out.steps.push(r); return r; };
  await step('EHLO mail.test.local');
  if (options === null) { out.mail = await step('MAIL FROM:<a@stage.test>'); await step('QUIT'); return out; }
  out.starttls = await step('STARTTLS');
  await c.starttls(options);
  await step('EHLO mail.test.local');
  out.mail = await step('MAIL FROM:<a@stage.test>');
  out.rcpt = await step(`RCPT TO:<${rcpt}>`);
  if (out.rcpt.startsWith('250')) {
    out.data = await step('DATA');
    out.end = await c.send('Subject: t\r\n\r\nhello\r\n..dot\r\n.');
  }
  await step('QUIT');
  return out;
}

async function withServer(fn) {
  const state = file(`state-${Math.random().toString(16).slice(2)}.json`);
  const spool = file(`spool-${Math.random().toString(16).slice(2)}`);
  const lines = [];
  const server = createServer({
    host: 'eop.test.local', key: pem('eop.test.local.key'), cert: pem('eop.test.local.pem'), caPem: pem('ca.pem'), stateFile: state, spoolDir: spool, log: (l) => lines.push(l),
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    await fn({ port: server.address().port, state, spool, lines });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}
const mailCert = () => ({ key: pem('mail.test.local.key'), cert: pem('mail.test.local.pem') });

test('server: no STARTTLS, no MAIL', () => withServer(async ({ port }) => {
  const r = await deliver(port, null);
  assert.match(r.mail, /^530 5\.7\.0 Must issue a STARTTLS/);
}));

test('server: the connector certificate is accepted, the message is stored unstuffed, the session is logged', () => withServer(async ({ port, spool, lines }) => {
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

test('server: a certificate for another name, none, or another CA gives 5.7.64', () => withServer(async ({ port, spool, lines }) => {
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

test('server: the connector name is read per session', () => withServer(async ({ port, state }) => {
  writeState(state, { connector: 'other.test.local' }, {});
  assert.match((await deliver(port, mailCert())).rcpt, /^550 5\.7\.64/);
  assert.match((await deliver(port, { key: pem('other.test.local.key'), cert: pem('other.test.local.pem') })).rcpt, /^250/);
}));

test('server: a client that resumes its TLS session is served, as Postfix does on its second connection', () => withServer(async ({ port, spool }) => {
  for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
    const first = client(port);
    await first.read();
    await first.send('EHLO x');
    await first.send('STARTTLS');
    await first.starttls({ ...mailCert(), maxVersion });
    await first.send('EHLO x');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    await first.send('QUIT');
    assert.ok(first.lastSession, `${maxVersion}: the server issued a session`);
    const second = client(port);
    await second.read();
    await second.send('EHLO x');
    await second.send('STARTTLS');
    const secure = await second.starttls({ ...mailCert(), maxVersion, session: first.lastSession });
    assert.equal(secure.isSessionReused(), true, `${maxVersion}: the session was resumed`);
    assert.match(await second.send('EHLO x'), /^250-eop\.test\.local/);
    assert.match(await second.send('MAIL FROM:<a@stage.test>'), /^250/);
    assert.match(await second.send('RCPT TO:<b@example.com>'), /^250/);
    await second.send('QUIT');
  }
  assert.equal(listMessages(spool).length, 0);
}));

test('server: modes answer with their codes, and drop cuts the connection', () => withServer(async ({ port, state, spool }) => {
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
  const c = client(port);
  await c.read();
  await c.send('EHLO x');
  await c.send('STARTTLS');
  await c.starttls(mailCert());
  await c.send('EHLO x');
  await c.send('MAIL FROM:<a@stage.test>');
  c.send('RCPT TO:<b@example.com>');
  await c.closed;
}));

test('smtpSend hands the message over with its envelope and dot-stuffing', async () => {
  const seen = [];
  const sink = net.createServer((socket) => {
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
  await new Promise((resolve) => { sink.listen(0, '127.0.0.1', resolve); });
  const result = await smtpSend({ host: '127.0.0.1', port: sink.address().port, from: 'a@stage.test', to: ['x@stage.test', 'y@stage.test'], raw: Buffer.from('Subject: s\n\n.leading dot\n') });
  sink.close();
  assert.equal(result.ok, true);
  assert.match(result.reply, /^250 2\.0\.0 queued as ABC/);
  assert.ok(seen.includes('MAIL FROM:<a@stage.test>') && seen.includes('RCPT TO:<y@stage.test>') && seen.includes('..leading dot'));
});

test('smtpSend reports a refusal with its code', async () => {
  const sink = net.createServer((socket) => {
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.startsWith('RCPT')) socket.write('550 5.1.1 no such user\r\n');
      else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  await new Promise((resolve) => { sink.listen(0, '127.0.0.1', resolve); });
  const result = await smtpSend({ host: '127.0.0.1', port: sink.address().port, from: 'a@stage.test', to: ['x@stage.test'], raw: Buffer.from('x') });
  sink.close();
  assert.equal(result.ok, false);
  assert.match(result.reply, /^550 5\.1\.1/);
});
