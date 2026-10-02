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
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES, OPS, checkOp, checkTenant, parseAddress, parseDomain } from './ops.mjs';
import { MARKER, certificateFrom, certificateInfo, createHandler, createRunner, signAssertion, startProblem } from './server.mjs';

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

// Values that must never reach pwsh.
const HOSTILE = [
  'example.com;Remove-MailContact x', 'example.com; whoami', '$(Get-Process).example.com', 'exam$(1)ple.com',
  "example.com' -Confirm:$false '", 'example.com"', '`whoami`.example.com', 'example.com\nGet-Mailbox',
  ' example.com', 'example .com', 'example.com|out-file', '@{a=1}', '', null, 42, ['example.com'], { domain: 'x' },
];

test('the whitelist: every op loads only its own cmdlets', () => {
  assert.deepEqual(Object.keys(OPS).sort(), ['get_accepted_domain', 'get_blocked_connector', 'get_content_filter_policy', 'whoami']);
  assert.deepEqual(COMMAND_NAMES, ['Get-AcceptedDomain', 'Get-BlockedConnector', 'Get-HostedContentFilterPolicy', 'Get-OrganizationConfig']);
  const runner = fs.readFileSync(path.join(HERE, 'runner.ps1'), 'utf8');
  for (const [op, spec] of Object.entries(OPS)) {
    assert.match(runner, new RegExp(`\\b${op} = @\\{\\s*Cmdlet = '${spec.cmdlets[0]}'`), `${op} in runner.ps1`);
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
  assert.deepEqual(checkOp('get_accepted_domain', { domain: 'Example.COM' }), { domain: 'example.com' });
  assert.deepEqual(checkOp('whoami', undefined), {});
  assert.equal(parseAddress('Info.Desk@Example.com'), 'info.desk@example.com');
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
function fakeRunnerProcess({ answer = null, hang = false, silent = false } = {}) {
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
      c.stdout.write(`some module warning\n${MARKER}${JSON.stringify({ ...reply, id: request.id })}\n`);
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
});
