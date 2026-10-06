// node --test deploy/tenant-worker/worker.test.mjs
//
// The whitelist and its checks (R-36), the HTTP handler with a fake runner, and the client assertion:
// these need openssl (a test certificate) and nothing else. When pwsh is on PATH (the worker image,
// a developer machine), the dry-mode tests also start the real worker: the start checks of R-35,
// and the commands runner.ps1 prints for each operation.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_NAMES, OPS, checkOp, checkTenant, parseAddress, parseDomain, parseGuid, parsePage, parseQuarantineId,
} from './ops.mjs';
import { MARKER, certificateFrom, certificateInfo, createHandler, createRunner, runnerEnv, signAssertion, startProblem } from './server.mjs';
import * as worker from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-worker-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name) => path.join(dir, name);
const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

const TOKEN = 't'.repeat(40);
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const APP_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ORG = 'contoso.onmicrosoft.com';

// A self-signed application certificate, as the runbook makes it.
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'app.key', '-out', 'app.crt', '-days', '30', '-subj', '/CN=mailexpert-tenant');
openssl('pkcs8', '-topk8', '-nocrypt', '-in', 'app.key', '-outform', 'DER', '-out', 'app.key.der');
openssl('x509', '-in', 'app.crt', '-outform', 'DER', '-out', 'app.crt.der');
const certificate = certificateFrom({
  cert: fs.readFileSync(file('app.crt.der')).toString('base64'),
  key: fs.readFileSync(file('app.key.der')).toString('base64'),
});
const tenant = { tenantId: TENANT_ID, appId: APP_ID, organization: ORG, thumbprint: certificate.thumbprint };

// A quarantined message's Identity as Learn shows it: GUID1\GUID2.
const QID_PARTS = ['c14401cf-aa9a-465b-cfd5-08d0f0ca37c5', '4c2ca98e-94ea-db3a-7eb8-3b63657d4db7'];
const QID = QID_PARTS.join('\\');

// Values that must never reach pwsh.
const HOSTILE = [
  'example.com;Remove-MailContact x', 'example.com; whoami', '$(Get-Process).example.com', 'exam$(1)ple.com',
  "example.com' -Confirm:$false '", 'example.com"', '`whoami`.example.com', 'example.com\nGet-Mailbox',
  ' example.com', 'example .com', 'example.com|out-file', '@{a=1}', '', null, 42, ['example.com'], { domain: 'x' },
];

test('the whitelist: every op loads only its own cmdlets', () => {
  assert.deepEqual(Object.keys(OPS).sort(), [
    'add_outbound_connector_domain', 'enable_dkim_signing_config', 'get_accepted_domain', 'get_blocked_connector',
    'get_content_filter_policy', 'get_dkim_signing_config', 'get_inbound_connectors', 'get_outbound_connectors',
    'get_quarantine_message', 'get_quarantine_messages', 'get_recipients',
    'hide_mail_contact', 'new_dkim_signing_config', 'new_mail_contact', 'release_quarantine_message', 'remove_mail_contact',
    'set_accepted_domain_authoritative', 'set_accepted_domain_internal_relay', 'set_bulk_spam_action_junk', 'set_high_confidence_spam_action_junk',
    'set_mail_contact_external', 'set_phish_spam_action_junk', 'set_spam_action_junk', 'whoami',
  ]);
  assert.deepEqual(COMMAND_NAMES, [
    'Get-AcceptedDomain', 'Get-BlockedConnector', 'Get-DkimSigningConfig', 'Get-HostedContentFilterPolicy', 'Get-InboundConnector',
    'Get-OrganizationConfig', 'Get-OutboundConnector', 'Get-QuarantineMessage', 'Get-Recipient', 'New-DkimSigningConfig', 'New-MailContact',
    'Release-QuarantineMessage', 'Remove-MailContact', 'Set-AcceptedDomain', 'Set-DkimSigningConfig', 'Set-HostedContentFilterPolicy',
    'Set-MailContact', 'Set-OutboundConnector',
  ]);
  const runner = fs.readFileSync(path.join(HERE, 'runner.lib.ps1'), 'utf8');
  for (const [op, spec] of Object.entries(OPS)) {
    assert.match(runner, new RegExp(`\\b${op} = @\\{\\s*Cmdlet = '${spec.cmdlets[0]}'`), `${op} in runner.ps1`);
    // The runner takes the same arguments: each one is named in the op's Args table.
    const start = runner.indexOf(`  ${op} = @{`);
    const block = runner.slice(start, runner.indexOf('\n  }', start));
    const argsLine = /Args = @\{([^\n]*)\}/.exec(block)?.[1] ?? '';
    const named = [...argsLine.matchAll(/\b(\w+) = @\(/g)].map((m) => m[1]).sort();
    assert.deepEqual(named, Object.keys(spec.params).sort(), `${op} arguments in runner.ps1`);
  }
});

test('R-36: unknown operations and hostile values are refused before pwsh', () => {
  assert.throws(() => checkOp('Invoke-Expression', {}), { code: 'unknown_op' });
  assert.throws(() => checkOp('whoami;Get-Mailbox', {}), { code: 'unknown_op' });
  assert.throws(() => checkOp('__proto__', {}), { code: 'unknown_op' });
  assert.throws(() => checkOp('whoami', { extra: 1 }), { code: 'invalid_args' });
  assert.throws(() => checkOp('whoami', ['x']), { code: 'invalid_args' });
  assert.throws(() => checkOp('get_accepted_domain', {}), { code: 'invalid_args' });
  for (const value of HOSTILE) {
    assert.throws(() => checkOp('get_accepted_domain', { domain: value }), { code: 'invalid_args' }, JSON.stringify(value));
    assert.equal(parseDomain(value), null, JSON.stringify(value));
    if (typeof value === 'string') assert.equal(parseAddress(`a@${value}`), null, value);
  }
  for (const value of ['a;b@example.com', '$(x)@example.com', "o'brien@example.com", '"a"@example.com', 'a..b@example.com']) {
    assert.equal(parseAddress(value), null, value);
  }
  // The connector is named by its Guid: an EAC name may hold any character.
  for (const value of [...HOSTILE, 'To mail node', '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a;whoami', '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a\n']) {
    assert.throws(() => checkOp('add_outbound_connector_domain', { connector: value, domain: 'example.com' }), { code: 'invalid_args' }, JSON.stringify(value));
    assert.equal(parseGuid(value), null, JSON.stringify(value));
  }
  assert.deepEqual(checkOp('add_outbound_connector_domain', { connector: '9F8E7D6C-5B4A-4392-8170-6F5E4D3C2B1A', domain: 'Example.com' }), { connector: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', domain: 'example.com' });
  assert.throws(() => checkOp('set_mail_contact_external', { address: 'a@example.com', external: 'a@relay.example.net;x' }), { code: 'invalid_args' });
  assert.throws(() => checkOp('new_mail_contact', { address: 'a@example.com' }), { code: 'invalid_args' });
  assert.throws(() => checkOp('new_mail_contact', { address: 'a@example.com', external: "x'@example.com" }), { code: 'invalid_args' });
  assert.deepEqual(checkOp('new_mail_contact', { address: 'A@example.com', external: 'a@relay.example.net' }), { address: 'a@example.com', external: 'a@relay.example.net' });
  assert.deepEqual(checkOp('get_accepted_domain', { domain: 'Example.COM' }), { domain: 'example.com' });
  assert.deepEqual(checkOp('whoami', undefined), {});
  assert.equal(parseAddress('Info.Desk@Example.com'), 'info.desk@example.com');
  // Stage 7c: a quarantined message's Identity (GUID1\GUID2) and a page number as digits.
  assert.deepEqual(checkOp('release_quarantine_message', { identity: QID.toUpperCase() }), { identity: QID });
  const [G1, G2] = QID_PARTS;
  for (const value of [...HOSTILE, G1, `${QID};whoami`, `${QID}\n`, ` ${QID}`, `${G1}/${G2}`, `${QID}\\${G2}`, `${G1}\\\\${G2}`]) {
    assert.throws(() => checkOp('release_quarantine_message', { identity: value }), { code: 'invalid_args' }, JSON.stringify(value));
    assert.equal(parseQuarantineId(value), null, JSON.stringify(value));
  }
  assert.deepEqual(checkOp('get_quarantine_messages', { page: '1' }), { page: '1' });
  for (const value of ['0', '1001', '01', '1;x', ' 1', 1, '', null, '1e3']) {
    assert.equal(parsePage(value), null, JSON.stringify(value));
  }
  assert.throws(() => checkOp('get_quarantine_messages', {}), { code: 'invalid_args' });
});

test('the tenant is checked field by field', () => {
  assert.deepEqual(checkTenant(tenant), tenant);
  assert.throws(() => checkTenant({ ...tenant, organization: 'contoso.com' }), { code: 'invalid_tenant' });
  assert.throws(() => checkTenant({ ...tenant, appId: 'app' }), { code: 'invalid_tenant' });
  assert.throws(() => checkTenant({ ...tenant, thumbprint: 'AB' }), { code: 'invalid_tenant' });
  assert.throws(() => checkTenant(null), { code: 'invalid_tenant' });
});

test('the certificate is described without its key', () => {
  const info = certificateInfo(certificate);
  assert.match(info.thumbprint, /^[0-9A-F]{40}$/);
  assert.equal(info.subject, 'CN=mailexpert-tenant');
  assert.ok(Date.parse(info.notAfter) > Date.now());
  assert.ok(!JSON.stringify(info).includes('PRIVATE'));
  const fingerprint = openssl('x509', '-in', 'app.crt', '-noout', '-fingerprint', '-sha1').toString();
  assert.equal(fingerprint.split('=')[1].trim().replace(/:/g, ''), info.thumbprint);
});

test('a key that is not the certificate\'s is refused', () => {
  openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-outform', 'DER', '-out', 'other.der');
  assert.throws(() => certificateFrom({
    cert: fs.readFileSync(file('app.crt.der')).toString('base64'),
    key: fs.readFileSync(file('other.der')).toString('base64'),
  }));
});

test('the client assertion follows the certificate credentials format', () => {
  const now = Date.UTC(2026, 9, 3, 12);
  const { assertion, expiresAt } = signAssertion(certificate, tenant, now);
  const [h, c, s] = assertion.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(header.alg, 'RS256');
  assert.equal(Buffer.from(header.x5t, 'base64url').toString('hex').toUpperCase(), certificate.thumbprint);
  assert.equal(Buffer.from(header['x5t#S256'], 'base64url').toString('hex').toUpperCase(), certificate.thumbprintSha256);
  assert.equal(claims.aud, `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
  assert.equal(claims.iss, APP_ID);
  assert.equal(claims.sub, APP_ID);
  assert.equal(claims.exp - claims.nbf, 600);
  assert.equal(expiresAt, new Date(now + 600000).toISOString());
  const publicKey = createPublicKey(fs.readFileSync(file('app.crt')));
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
});

// A runner that answers like runner.ps1 -DryRun, or as told.
function fakeRunnerProcess({ answer = null, hang = false, silent = false, delayMs = 0 } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.requests = [];
  c.killed = false;
  c.stdin = new PassThrough();
  c.stdin.setEncoding('utf8');
  c.stdin.on('data', (text) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const request = JSON.parse(line);
      c.requests.push(request);
      if (hang) continue;
      const reply = answer ? answer(request) : { ok: true, result: { op: request.op, args: request.args } };
      const send = () => c.stdout.write(`some module warning\n${MARKER}${JSON.stringify({ ...reply, id: request.id })}\n`);
      if (delayMs) setTimeout(send, delayMs);
      else send();
    }
  });
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); };
  if (!silent) setImmediate(() => c.stdout.write(`${MARKER}{"id":0,"ok":true}\n`));
  return c;
}

async function serve(handler) {
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (base, route, body, token = TOKEN) => fetch(`${base}${route}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

for (const [code, status, returnedCode = code] of [
  ['exo_throttled', 429],
  ['exo_exists', 409],
  ['quarantine_not_allowed', 403],
  ['exo_not_found', 422],
  ['unknown_provider_error', 502, 'exo_failed'],
]) {
  test(`the handler: runner error ${code} returns ${returnedCode} with HTTP ${status}`, async () => {
    const runner = createRunner({ spawnRunner: () => fakeRunnerProcess({
      answer: () => ({ ok: false, error: { code, message: 'The operation failed' } }),
    }) });
    const { base, close } = await serve(createHandler({ token: TOKEN, certificate, runner }));
    try {
      const res = await post(base, '/ops/whoami', { tenant });
      const body = await res.json();
      assert.equal(body.error.code, returnedCode);
      assert.equal(res.status, status);
      assert.equal(body.ok, false);
    } finally {
      runner.stop();
      await close();
    }
  });
}

test('the handler: auth, whitelist, thumbprint, one op at a time', async () => {
  const spawned = [];
  const runner = createRunner({ spawnRunner: () => { const c = fakeRunnerProcess(); spawned.push(c); return c; } });
  const lines = [];
  const { base, close } = await serve(createHandler({ token: TOKEN, certificate, runner, log: (l) => lines.push(l) }));
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/certificate`)).status, 401);
    assert.equal((await fetch(`${base}/certificate`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const cert = await (await fetch(`${base}/certificate`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(cert.result.thumbprint, certificate.thumbprint);

    assert.equal((await post(base, '/ops/whoami', { tenant }, 'x'.repeat(40))).status, 401);
    let res = await post(base, '/ops/Invoke-Expression', { tenant });
    assert.equal(res.status, 404);
    res = await post(base, '/ops/remove_everything', { tenant });
    assert.equal((await res.json()).error.code, 'unknown_op');
    for (const domain of HOSTILE) {
      res = await post(base, '/ops/get_accepted_domain', { tenant, args: { domain } });
      assert.equal(res.status, 400, JSON.stringify(domain));
    }
    res = await post(base, '/ops/whoami', { tenant: { ...tenant, thumbprint: 'A'.repeat(40) } });
    assert.equal((await res.json()).error.code, 'certificate_mismatch');
    // Nothing above reached the runner: it was never even started.
    assert.equal(spawned.length, 0);

    const answers = await Promise.all([
      post(base, '/ops/whoami', { tenant }).then((r) => r.json()),
      post(base, '/ops/get_accepted_domain', { tenant, args: { domain: 'Example.com' } }).then((r) => r.json()),
    ]);
    assert.deepEqual(answers.map((a) => a.result.op), ['whoami', 'get_accepted_domain']);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].requests.map((r) => [r.op, r.args, r.tenant]), [
      ['whoami', {}, { appId: APP_ID, organization: ORG }],
      ['get_accepted_domain', { domain: 'example.com' }, { appId: APP_ID, organization: ORG }],
    ]);
    // The token and the thumbprint never reach the runner or the log.
    assert.ok(!JSON.stringify(spawned[0].requests).includes(TOKEN));
    assert.ok(!lines.join('\n').includes(TOKEN));

    res = await post(base, '/assertion', { tenant });
    const { result } = await res.json();
    assert.equal(JSON.parse(Buffer.from(result.assertion.split('.')[1], 'base64url')).aud.includes(TENANT_ID), true);
    res = await fetch(`${base}/ops/whoami`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'x'.repeat(70000) });
    assert.equal(res.status, 413);
    res = await fetch(`${base}/ops/whoami`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '[1]' });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('the runner: a timeout kills it and the next call starts a fresh one', async () => {
  const spawned = [];
  let hang = true;
  const runner = createRunner({
    timeoutMs: 200,
    spawnRunner: () => { const c = fakeRunnerProcess({ hang }); spawned.push(c); return c; },
  });
  await assert.rejects(runner.call({ op: 'whoami', tenant: {}, args: {} }), { code: 'exo_timeout' });
  assert.equal(spawned[0].killed, true);
  hang = false;
  const answer = await runner.call({ op: 'whoami', tenant: {}, args: {} });
  assert.equal(answer.ok, true);
  assert.equal(spawned.length, 2);
});

test('the runner: an error answer and a runner that exits', async () => {
  const runner = createRunner({
    spawnRunner: () => fakeRunnerProcess({ answer: () => ({ ok: false, error: { code: 'exo_failed', message: 'boom' } }) }),
  });
  const answer = await runner.call({ op: 'whoami', tenant: {}, args: {} });
  assert.deepEqual(answer.error, { code: 'exo_failed', message: 'boom' });
  const dying = createRunner({
    spawnRunner: () => { const c = fakeRunnerProcess({ silent: true }); setImmediate(() => c.emit('exit', 1)); return c; },
  });
  await assert.rejects(dying.call({ op: 'whoami', tenant: {}, args: {} }), { code: 'runner_exited' });
});

test('the queue is bounded', async () => {
  const runner = createRunner({ maxQueue: 2, timeoutMs: 1000, spawnRunner: () => fakeRunnerProcess({ hang: true }) });
  const a = runner.call({ op: 'whoami' }).catch((e) => e.code);
  const b = runner.call({ op: 'whoami' }).catch((e) => e.code);
  await assert.rejects(runner.call({ op: 'whoami' }), { code: 'busy' });
  runner.stop();
  await Promise.all([a, b]);
});

test('R-35: the start checks name what is missing', () => {
  fs.writeFileSync(file('pw'), 'secret\n');
  assert.match(startProblem({ token: 'short', pfxPath: file('app.pfx'), passwordFile: file('pw') }), /TENANT_WORKER_TOKEN/);
  assert.match(startProblem({ token: TOKEN, pfxPath: file('none.pfx'), passwordFile: file('pw') }), /no readable certificate/);
  assert.match(startProblem({ token: TOKEN, pfxPath: dir, passwordFile: file('pw') }), /not a file/);
  fs.writeFileSync(file('app.pfx'), 'x');
  assert.match(startProblem({ token: TOKEN, pfxPath: file('app.pfx'), passwordFile: file('none') }), /certificate password/);
  assert.equal(startProblem({ token: TOKEN, pfxPath: file('app.pfx'), passwordFile: file('pw') }), null);
});

// ── With pwsh: the real worker in dry mode ─────────────────────────────────────────────────────
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;

function startWorker(env) {
  const c = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env, TENANT_WORKER_TOKEN: TOKEN, TENANT_WORKER_DRY_RUN: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => c.on('exit', (code) => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (out.includes('listening on')) { clearInterval(timer); resolve(); } }, 50);
    exited.then(() => { clearInterval(timer); reject(new Error(`exited: ${out}`)); });
  });
  listening.catch(() => {});
  return { c, exited, listening, output: () => out };
}

test('dry mode with pwsh: R-35 start, printed commands, R-36', { skip: !hasPwsh && 'pwsh is not on PATH', timeout: 120000 }, async () => {
  const password = 'Pfx-Pass-1!';
  fs.writeFileSync(file('pfx.password'), `${password}\n`);
  openssl('pkcs12', '-export', '-inkey', 'app.key', '-in', 'app.crt', '-out', 'real.pfx', '-passout', `pass:${password}`);

  const missing = startWorker({ TENANT_PFX_PATH: file('absent.pfx'), TENANT_PFX_PASSWORD_FILE: file('pfx.password'), TENANT_WORKER_PORT: '0' });
  assert.equal(await missing.exited, 1);
  assert.match(missing.output(), /refusing to start: no readable certificate/);

  fs.writeFileSync(file('wrong.password'), 'not-it\n');
  const wrong = startWorker({ TENANT_PFX_PATH: file('real.pfx'), TENANT_PFX_PASSWORD_FILE: file('wrong.password'), TENANT_WORKER_PORT: '0' });
  assert.equal(await wrong.exited, 1);
  assert.match(wrong.output(), /could not be read/);
  assert.ok(!wrong.output().includes('not-it'));

  const port = 18000 + Math.floor(Math.random() * 1000);
  const worker = startWorker({ TENANT_PFX_PATH: file('real.pfx'), TENANT_PFX_PASSWORD_FILE: file('pfx.password'), TENANT_WORKER_PORT: String(port) });
  try {
    await worker.listening;
    const base = `http://127.0.0.1:${port}`;
    const cert = await (await fetch(`${base}/certificate`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(cert.result.thumbprint, certificate.thumbprint);

    let res = await post(base, '/ops/whoami', { tenant });
    let body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const [connect, whoami] = body.result.commands;
    assert.equal(connect.cmdlet, 'Connect-ExchangeOnline');
    assert.equal(connect.parameters.AppId, APP_ID);
    assert.equal(connect.parameters.Organization, ORG);
    assert.equal(connect.parameters.CertificatePassword, '<redacted>');
    assert.equal(connect.parameters.SkipLoadingFormatData, true);
    assert.deepEqual(connect.parameters.CommandName, COMMAND_NAMES);
    assert.deepEqual(whoami, { cmdlet: 'Get-OrganizationConfig', parameters: {} });

    // The session is kept: the next call prints no connect.
    body = await (await post(base, '/ops/get_content_filter_policy', { tenant })).json();
    assert.deepEqual(body.result.commands, [{ cmdlet: 'Get-HostedContentFilterPolicy', parameters: { Identity: 'Default' } }]);
    body = await (await post(base, '/ops/get_blocked_connector', { tenant })).json();
    assert.deepEqual(body.result.commands, [{ cmdlet: 'Get-BlockedConnector', parameters: {} }]);
    body = await (await post(base, '/ops/get_accepted_domain', { tenant, args: { domain: 'Example.com' } })).json();
    assert.deepEqual(body.result.commands, [{ cmdlet: 'Get-AcceptedDomain', parameters: { Identity: 'example.com' } }]);

    // Stage 7b: what each operation prints, fixed parameters and shapes included.
    const printed = async (op, args) => {
      const answer = await (await post(base, `/ops/${op}`, { tenant, args })).json();
      assert.equal(answer.ok, true, JSON.stringify(answer));
      return answer.result.commands;
    };
    assert.deepEqual(await printed('set_accepted_domain_internal_relay', { domain: 'example.com' }),
      [{ cmdlet: 'Set-AcceptedDomain', parameters: { DomainType: 'InternalRelay', Identity: 'example.com' } }]);
    assert.deepEqual(await printed('set_accepted_domain_authoritative', { domain: 'example.com' }),
      [{ cmdlet: 'Set-AcceptedDomain', parameters: { DomainType: 'Authoritative', Identity: 'example.com' } }]);
    assert.deepEqual(await printed('get_outbound_connectors', {}), [{ cmdlet: 'Get-OutboundConnector', parameters: {} }]);
    assert.deepEqual(await printed('get_inbound_connectors', {}), [{ cmdlet: 'Get-InboundConnector', parameters: {} }]);
    assert.deepEqual(await printed('add_outbound_connector_domain', { connector: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', domain: 'example.com' }),
      [{ cmdlet: 'Set-OutboundConnector', parameters: { Identity: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', RecipientDomains: { Add: 'example.com' } } }]);
    assert.deepEqual(await printed('set_mail_contact_external', { address: 'info@example.com', external: 'info@relay.example.net' }),
      [{ cmdlet: 'Set-MailContact', parameters: { Identity: 'info@example.com', ExternalEmailAddress: 'info@relay.example.net' } }]);
    assert.deepEqual(await printed('new_dkim_signing_config', { domain: 'example.com' }),
      [{ cmdlet: 'New-DkimSigningConfig', parameters: { Enabled: false, KeySize: 2048, DomainName: 'example.com' } }]);
    assert.deepEqual(await printed('get_dkim_signing_config', { domain: 'example.com' }),
      [{ cmdlet: 'Get-DkimSigningConfig', parameters: { Identity: 'example.com' } }]);
    assert.deepEqual(await printed('enable_dkim_signing_config', { domain: 'example.com' }),
      [{ cmdlet: 'Set-DkimSigningConfig', parameters: { Enabled: true, Identity: 'example.com' } }]);
    assert.deepEqual(await printed('get_recipients', {}), [{ cmdlet: 'Get-Recipient', parameters: { ResultSize: 'Unlimited' } }]);
    const [contact] = await printed('new_mail_contact', { address: 'info@example.com', external: 'info@example.com' });
    assert.equal(contact.cmdlet, 'New-MailContact');
    assert.deepEqual(contact.parameters, { Name: 'info@example.com', PrimarySmtpAddress: 'info@example.com', ExternalEmailAddress: 'info@example.com' });
    assert.deepEqual(await printed('hide_mail_contact', { address: 'info@example.com' }),
      [{ cmdlet: 'Set-MailContact', parameters: { HiddenFromAddressListsEnabled: true, Identity: 'info@example.com' } }]);
    assert.deepEqual(await printed('remove_mail_contact', { address: 'info@example.com' }),
      [{ cmdlet: 'Remove-MailContact', parameters: { Confirm: false, Identity: 'info@example.com' } }]);
    // Section 5.14: one action of the Default policy to MoveToJmf, fixed by the op; no arguments taken.
    assert.deepEqual(await printed('set_spam_action_junk', {}),
      [{ cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: 'Default', SpamAction: 'MoveToJmf' } }]);
    assert.deepEqual(await printed('set_high_confidence_spam_action_junk', {}),
      [{ cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: 'Default', HighConfidenceSpamAction: 'MoveToJmf' } }]);
    assert.deepEqual(await printed('set_phish_spam_action_junk', {}),
      [{ cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: 'Default', PhishSpamAction: 'MoveToJmf' } }]);
    assert.deepEqual(await printed('set_bulk_spam_action_junk', {}),
      [{ cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: 'Default', BulkSpamAction: 'MoveToJmf' } }]);
    res = await post(base, '/ops/set_phish_spam_action_junk', { tenant, args: { field: 'HighConfidencePhishAction' } });
    assert.equal(res.status, 400);
    // Stage 7c (R-42) and section 5.14: the quarantine list is pinned to inbound high confidence
    // phishing, phishing and spam not yet released.
    assert.deepEqual(await printed('get_quarantine_messages', { page: '2' }), [{
      cmdlet: 'Get-QuarantineMessage',
      parameters: { QuarantineTypes: ['HighConfPhish', 'Phish', 'Spam', 'Bulk'], Direction: 'Inbound', ReleaseStatus: 'NotReleased', PageSize: 100, Page: '2' },
    }]);
    assert.deepEqual(await printed('get_quarantine_message', { identity: QID }), [{ cmdlet: 'Get-QuarantineMessage', parameters: { Identity: QID } }]);
    // The release reads the message first (the guard: inbound spam and phishing only).
    assert.deepEqual(await printed('release_quarantine_message', { identity: QID }), [
      { cmdlet: 'Get-QuarantineMessage', parameters: { Identity: QID } },
      { cmdlet: 'Release-QuarantineMessage', parameters: { ReleaseToAll: true, Confirm: false, Identity: QID } },
    ]);
    res = await post(base, '/ops/release_quarantine_message', { tenant, args: { identity: `${QID};whoami` } });
    assert.equal(res.status, 400);
    res = await post(base, '/ops/add_outbound_connector_domain', { tenant, args: { connector: "x' -Confirm", domain: 'example.com' } });
    assert.equal(res.status, 400);
    res = await post(base, '/ops/add_outbound_connector_domain', { tenant, args: { connector: 'To mail node', domain: 'example.com' } });
    assert.equal(res.status, 400);

    for (const domain of HOSTILE) {
      res = await post(base, '/ops/get_accepted_domain', { tenant, args: { domain } });
      assert.equal(res.status, 400, JSON.stringify(domain));
    }
    assert.equal((await post(base, '/ops/invoke_expression', { tenant })).status, 404);
    assert.ok(!worker.output().includes(password));
    assert.ok(!worker.output().includes(TOKEN));
  } finally {
    worker.c.kill();
    await worker.exited;
  }
});

const hasModule = hasPwsh && spawnSync('pwsh', ['-NoProfile', '-Command', 'if (Get-Module -ListAvailable ExchangeOnlineManagement) { exit 0 } else { exit 1 }'], { stdio: 'ignore' }).status === 0;

test('the image: ExchangeOnlineManagement imports as the worker user', { skip: !hasModule && 'the module is not installed here', timeout: 120000 }, () => {
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Import-Module ExchangeOnlineManagement -ErrorAction Stop; (Get-Command Connect-ExchangeOnline).Source'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ExchangeOnlineManagement/);
});

test('runner.ps1 checks again what reaches it', { skip: !hasPwsh && 'pwsh is not on PATH', timeout: 60000 }, () => {
  // Written straight to the runner, past the Node checks: it must refuse on its own.
  const lines = [
    { id: 1, op: 'Invoke-Expression', tenant: { appId: APP_ID, organization: ORG }, args: {} },
    { id: 2, op: 'get_accepted_domain', tenant: { appId: APP_ID, organization: ORG }, args: { domain: 'example.com;whoami' } },
    { id: 3, op: 'get_accepted_domain', tenant: { appId: APP_ID, organization: ORG }, args: { domain: 'example.com', extra: 'x' } },
    { id: 4, op: 'whoami', tenant: { appId: 'not-a-guid', organization: ORG }, args: {} },
    { id: 5, op: 'get_accepted_domain', tenant: { appId: APP_ID, organization: ORG }, args: { domain: 'example.com' } },
    { id: 7, op: 'add_outbound_connector_domain', tenant: { appId: APP_ID, organization: ORG }, args: { connector: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a;whoami', domain: 'example.com' } },
    { id: 8, op: 'new_mail_contact', tenant: { appId: APP_ID, organization: ORG }, args: { address: 'a..b@example.com', external: 'a@example.com' } },
    { id: 9, op: 'remove_mail_contact', tenant: { appId: APP_ID, organization: ORG }, args: { address: 'Info@example.com' } },
    { id: 10, op: 'release_quarantine_message', tenant: { appId: APP_ID, organization: ORG }, args: { identity: 'c14401cf-aa9a-465b-cfd5-08d0f0ca37c5;whoami' } },
    { id: 11, op: 'get_quarantine_messages', tenant: { appId: APP_ID, organization: ORG }, args: { page: 2 } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'runner.ps1'), '-DryRun'], {
    input: `${lines}\n`, encoding: 'utf8',
  });
  const answers = run.stdout.split('\n').filter((l) => l.startsWith(MARKER)).map((l) => JSON.parse(l.slice(MARKER.length)));
  const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.equal(byId[1].error.code, 'unknown_op');
  assert.equal(byId[2].error.code, 'invalid_args');
  assert.equal(byId[3].error.code, 'invalid_args');
  assert.equal(byId[4].error.code, 'invalid_tenant');
  assert.equal(byId[5].ok, true);
  assert.equal(byId[5].result.commands.at(-1).parameters.Identity, 'example.com');
  assert.equal(byId[7].error.code, 'invalid_args');
  assert.equal(byId[8].error.code, 'invalid_args');
  // The server lower-cases addresses before they reach the runner; one that is not is refused here.
  assert.equal(byId[9].error.code, 'invalid_args');
  assert.equal(byId[10].error.code, 'invalid_args');
  // A page reaches the runner as digits only; a JSON number is refused here.
  assert.equal(byId[11].error.code, 'invalid_args');
  // \z, not $: a value with a trailing line break is refused too.
  const trailing = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'runner.ps1'), '-DryRun'], {
    input: `${JSON.stringify({ id: 6, op: 'get_accepted_domain', tenant: { appId: APP_ID, organization: ORG }, args: { domain: 'example.com\n' } })}\n`, encoding: 'utf8',
  });
  const [answer6] = trailing.stdout.split('\n').filter((l) => l.startsWith(MARKER) && !l.includes('"id":0')).map((l) => JSON.parse(l.slice(MARKER.length)));
  assert.equal(answer6.error.code, 'invalid_args');
});

// The live path of runner.lib.ps1 with the EXO cmdlets stubbed (no module needed): a cmdlet's
// answer is a JSON array for 0, 1 and 2 items, a multi-valued property stays an array, and only a
// session error connects again.
test('runner.lib.ps1: arrays for 0, 1 and 2 items, and reconnects only on session errors', { skip: !hasPwsh && 'pwsh is not on PATH', timeout: 60000 }, () => {
  fs.writeFileSync(file('lib.password'), 'Pw-1\n');
  const lib = path.join(HERE, 'runner.lib.ps1').replace(/'/g, "''");
  const script = `
$script:DryRun = $false
. '${lib}'
$env:TENANT_PFX_PASSWORD_FILE = '${file('lib.password').replace(/'/g, "''")}'
$global:Connects = 0
$global:Fail = $null
function Connect-ExchangeOnline { $global:Connects++ }
function Disconnect-ExchangeOnline { }
function Make($n) { for ($i = 1; $i -le $n; $i++) { [pscustomobject]@{ ConnectorId = "id$i"; ConnectorName = "c$i"; Reason = 'r'; CreatedTime = [datetime]::new(2026, 10, 3, 8, 0, 0, [DateTimeKind]::Utc) } } }
function Get-BlockedConnector { if ($global:Fail) { throw $global:Fail }; Make $global:N }
function Get-OrganizationConfig { [pscustomobject]@{ Name = 'contoso.onmicrosoft.com'; DisplayName = 'Contoso' } }
function Get-HostedContentFilterPolicy { [pscustomobject]@{ Identity = 'Default'; SpamAction = 'MoveToJmf'; RedirectToRecipients = $global:Redirect } }
$tenant = [pscustomobject]@{ appId = '${APP_ID}'; organization = '${ORG}' }
function Ask($id, $op) { $a = Invoke-Op ([pscustomobject]@{ op = $op; tenant = $tenant; args = $null }); $a.id = $id; $a.connects = $global:Connects; Write-Answer $a }
foreach ($n in 0, 1, 2) { $global:N = $n; Ask "bc$n" 'get_blocked_connector' }
Ask 'who' 'whoami'
$global:Redirect = [System.Collections.Generic.List[string]]::new(); Ask 'r0' 'get_content_filter_policy'
$global:Redirect.Add('spam@example.com'); Ask 'r1' 'get_content_filter_policy'
$global:Fail = 'Get-BlockedConnector failed for connector From mail node'; Ask 'fail' 'get_blocked_connector'
$global:Fail = 'The session has expired'; Ask 'expired' 'get_blocked_connector'
function New-MailContact { param($Name, $PrimarySmtpAddress, $ExternalEmailAddress) throw $global:ContactFail }
function AskArgs($id, $op, $a) { $r = Invoke-Op ([pscustomobject]@{ op = $op; tenant = $tenant; args = $a }); $r.id = $id; Write-Answer $r }
$contact = [pscustomobject]@{ address = 'info@example.com'; external = 'info@example.com' }
$global:ContactFail = 'The proxy address "SMTP:info@example.com" is already being used by the proxy addresses or LegacyExchangeDN.'; AskArgs 'exists' 'new_mail_contact' $contact
$global:ContactFail = 'Micro delay applied. Actual delay: 30000 msecs. Throttling policy...'; AskArgs 'throttled' 'new_mail_contact' $contact
function Remove-MailContact { param($Identity, $Confirm) throw "The operation couldn't be performed because object 'info@example.com' couldn't be found." }
AskArgs 'gone' 'remove_mail_contact' ([pscustomobject]@{ address = 'info@example.com' })
function Set-OutboundConnector { param($Identity, $RecipientDomains) $global:Seen = $RecipientDomains }
AskArgs 'add' 'add_outbound_connector_domain' ([pscustomobject]@{ connector = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'; domain = 'example.com' })
Write-Answer @{ id = 'seen'; ok = $true; result = @{ add = $global:Seen.Add; type = $global:Seen.GetType().Name } }
# Stage 7c: the quarantine. An -Identity that does not exist answers every message (Learn).
$global:Q = @(
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\${QID_PARTS[1]}'; QuarantineTypes = 'HighConfPhish'; Type = 'High Confidence Phish'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\aaaaaaaa-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Phish'; Type = 'Phish'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\bbbbbbbb-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'HighConfPhish'; Type = 'High Confidence Phish'; Direction = 'Outbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\dddddddd-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Spam'; Type = 'High Confidence Spam'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\eeeeeeee-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Malware'; Type = 'Malware'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\ffffffff-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Bulk'; Type = 'Bulk'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\11111111-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = @('Phish', 'Malware'); Type = 'Phish'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\22222222-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'TransportRule'; Type = 'Transport Rule'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\33333333-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = $null; Type = $null; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\44444444-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Spam'; Type = 'Phish, Malware'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\55555555-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'HighConfPhish'; Type = 'High Confidence Phishing'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\66666666-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = $null; Type = 'Phishing'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\77777777-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'SPOMalware'; Type = 'Phish'; Direction = 'Inbound' },
  [pscustomobject]@{ Identity = '${QID_PARTS[0]}\\88888888-94ea-db3a-7eb8-3b63657d4db7'; QuarantineTypes = 'Something New'; Type = 'Phish'; Direction = 'Inbound' }
)
function Get-QuarantineMessage { param($Identity) $m = @($global:Q | Where-Object { $_.Identity -eq $Identity }); if ($m.Count) { $m } else { $global:Q } }
$global:Released = [System.Collections.Generic.List[string]]::new()
function Release-QuarantineMessage { param($Identity, $ReleaseToAll, $Confirm) $global:Released.Add($Identity) }
AskArgs 'qread' 'get_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\${QID_PARTS[1]}' })
AskArgs 'qmissing' 'get_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\cccccccc-94ea-db3a-7eb8-3b63657d4db7' })
AskArgs 'qok' 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\${QID_PARTS[1]}' })
AskArgs 'qphish' 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\aaaaaaaa-94ea-db3a-7eb8-3b63657d4db7' })
AskArgs 'qout' 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\bbbbbbbb-94ea-db3a-7eb8-3b63657d4db7' })
AskArgs 'qnone' 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\cccccccc-94ea-db3a-7eb8-3b63657d4db7' })
AskArgs 'qhcs' 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\dddddddd-94ea-db3a-7eb8-3b63657d4db7' })
# Not $q: PowerShell names are case-insensitive, and $q is $global:Q, the quarantine above.
foreach ($part in @('eeeeeeee', 'ffffffff', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888')) {
  AskArgs "q$part" 'release_quarantine_message' ([pscustomobject]@{ identity = '${QID_PARTS[0]}\\' + $part + '-94ea-db3a-7eb8-3b63657d4db7' })
}
Write-Answer @{ id = 'released'; ok = $true; result = @($global:Released) }
`;
  fs.writeFileSync(file('lib.test.ps1'), script);
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file('lib.test.ps1')], { encoding: 'utf8' });
  const answers = Object.fromEntries(run.stdout.split('\n').filter((l) => l.startsWith(MARKER)).map((l) => JSON.parse(l.slice(MARKER.length))).map((a) => [a.id, a]));
  assert.deepEqual(answers.bc0.result, [], run.stderr);
  assert.deepEqual(answers.bc1.result, [{ ConnectorId: 'id1', ConnectorName: 'c1', Reason: 'r', CreatedTime: '2026-10-03T08:00:00.0000000Z' }]);
  assert.deepEqual(answers.bc2.result.map((r) => r.ConnectorId), ['id1', 'id2']);
  assert.deepEqual(answers.who.result, [{ Name: 'contoso.onmicrosoft.com', DisplayName: 'Contoso' }]);
  assert.deepEqual(answers.r0.result[0].RedirectToRecipients, []);
  assert.deepEqual(answers.r1.result[0].RedirectToRecipients, ['spam@example.com']);
  // One connect for the session; an error naming the connector is no session error.
  assert.equal(answers.fail.connects, 1);
  assert.equal(answers.fail.error.code, 'exo_failed');
  assert.equal(answers.expired.connects, 2);
  assert.equal(answers.expired.error.code, 'exo_failed');
  // Stage 7b: a write that finds its object made, throttling and an object already gone.
  assert.equal(answers.exists.error.code, 'exo_exists');
  assert.equal(answers.throttled.error.code, 'exo_throttled');
  assert.equal(answers.gone.error.code, 'exo_not_found');
  assert.deepEqual(answers.add.result, []);
  assert.deepEqual(answers.seen.result, { add: 'example.com', type: 'Hashtable' });
  // Stage 7c and section 5.14: a read by Identity answers that message only, an unknown one nothing.
  // QuarantineTypes decides (Type only when it is empty): high confidence phishing, phishing, spam,
  // high confidence spam and bulk are released whatever Type spells; a forbidden word anywhere
  // (malware, a mail flow rule), an unknown QuarantineTypes value, no type at all and an outbound
  // message are refused.
  assert.deepEqual(answers.qread.result.map((r) => r.Identity), [QID]);
  assert.deepEqual(answers.qmissing.result, []);
  const released = ['qok', 'qphish', 'qhcs', 'qffffffff', 'q55555555', 'q66666666'];
  for (const id of released) assert.equal(answers[id].ok, true, `${id} ${JSON.stringify(answers[id])}`);
  for (const id of ['qout', 'qnone', 'qeeeeeeee', 'q11111111', 'q22222222', 'q33333333', 'q44444444', 'q77777777', 'q88888888']) {
    assert.equal(answers[id].error.code, 'quarantine_not_allowed', id);
  }
  const at = (part) => `${QID_PARTS[0]}\\${part}-94ea-db3a-7eb8-3b63657d4db7`;
  assert.deepEqual(answers.released.result, [QID, at('aaaaaaaa'), at('dddddddd'), at('ffffffff'), at('55555555'), at('66666666')]);
});

test('the runner gets no token, and a pinned tenant is the only one served', async () => {
  assert.equal(runnerEnv({ TENANT_WORKER_TOKEN: TOKEN, PATH: '/bin' }, { X: '1' }).TENANT_WORKER_TOKEN, undefined);
  assert.deepEqual(runnerEnv({ TENANT_WORKER_TOKEN: TOKEN, PATH: '/bin' }, { X: '1' }), { PATH: '/bin', X: '1' });
  const runner = createRunner({ spawnRunner: () => fakeRunnerProcess() });
  const { base, close } = await serve(createHandler({ token: TOKEN, certificate, runner, pinned: { tenantId: TENANT_ID, appId: APP_ID } }));
  try {
    let res = await post(base, '/assertion', { tenant: { ...tenant, appId: '77777777-7777-4888-9999-aaaaaaaaaaaa' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'tenant_not_allowed');
    res = await post(base, '/ops/whoami', { tenant: { ...tenant, tenantId: '22222222-2222-4333-8444-555555555555' } });
    assert.equal(res.status, 403);
    assert.equal((await post(base, '/assertion', { tenant })).status, 200);
  } finally {
    await close();
  }
});

test('a dead runner: EPIPE on its stdin does not crash, a replaced one does not fail its successor', async () => {
  const lines = [];
  const runner = createRunner({
    timeoutMs: 1000, log: (l) => lines.push(l),
    spawnRunner: () => {
      const c = fakeRunnerProcess({ silent: true });
      c.stdin.write = () => { setImmediate(() => { c.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); c.emit('exit', 1); }); return false; };
      setImmediate(() => c.stdout.write(`${MARKER}{"id":0,"ok":true}\n`));
      return c;
    },
  });
  await assert.rejects(runner.call({ op: 'whoami', tenant: {}, args: {} }), { code: 'runner_exited' });
  assert.ok(lines.some((l) => l.includes('EPIPE')));

  const spawned = [];
  const replaced = createRunner({
    timeoutMs: 400,
    spawnRunner: () => {
      // The first hangs and exits 50 ms after it was killed, while the second is still answering.
      const c = fakeRunnerProcess({ hang: spawned.length === 0, delayMs: spawned.length === 0 ? 0 : 150 });
      if (spawned.length === 0) c.kill = () => { c.killed = true; setTimeout(() => c.emit('exit', null), 50); };
      spawned.push(c);
      return c;
    },
  });
  await assert.rejects(replaced.call({ op: 'whoami', tenant: {}, args: {} }), { code: 'exo_timeout' });
  const answer = await replaced.call({ op: 'whoami', tenant: {}, args: {} });
  assert.equal(answer.ok, true);
});

// One raw request (a request target fetch would not send), answered with its status code.
function rawRequest(base, line) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    socket.on('connect', () => socket.write(`${line}\r\nHost: worker\r\nConnection: close\r\n\r\n`));
  });
}

test('a request target the URL parser refuses gets 400, and the worker keeps serving', async () => {
  const { base, close } = await serve(createHandler({ token: TOKEN, certificate, runner: {} }));
  try {
    assert.equal(await rawRequest(base, 'GET //[ HTTP/1.1'), 400);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/certificate`)).status, 401);
  } finally {
    await close();
  }
});

test('the server callback answers 500 when the handler rejects, and keeps serving', async () => {
  assert.equal(typeof worker.requestListener, 'function', 'server.mjs exports requestListener');
  const lines = [];
  let calls = 0;
  const listener = worker.requestListener(async (req, res) => {
    calls += 1;
    if (calls === 1) throw new Error('handler bug');
    res.end('ok');
  }, (l) => lines.push(l));
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/x`);
    assert.equal(first.status, 500);
    assert.equal((await first.json()).error.code, 'internal_error');
    assert.equal(await (await fetch(`${base}/x`)).text(), 'ok');
    assert.ok(lines.some((l) => l.includes('handler bug')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
