// The tenant worker (R-22, R-35, R-36, R-38): a small HTTP server on the panel's internal Docker
// network, in front of one long-lived pwsh process (runner.ps1) that holds the Exchange Online
// session. Node and pwsh in one container rather than pwsh alone: a cmdlet that hangs cannot be
// timed out inside its own runspace, so here the server kills the runner on a timeout and the next
// call starts a fresh one (and connects again), while /health keeps answering; the whitelist and
// its checks run in Node before anything reaches pwsh, and are tested without pwsh.
//
//   GET  /health        no auth: { ok }
//   GET  /certificate   the application certificate: thumbprint, subject, validity (no key)
//   POST /assertion     { tenant } -> a client assertion for Graph's token endpoint (RS256 JWT
//                       signed with the certificate's key; the claims are built here, never taken
//                       from the caller)
//   POST /ops/<op>      { tenant, args } -> { ok, result } for an operation of the whitelist
//
// Every route but /health needs "Authorization: Bearer <TENANT_WORKER_TOKEN>". tenant is
// { tenantId, appId, organization, thumbprint } as the panel's settings hold them; a thumbprint
// that is not this worker's certificate is refused (certificate_mismatch), so a panel pointed at
// the wrong certificate learns it on "Test connection".
//
// One operation at a time (R-38): calls queue behind each other, at most MAX_QUEUE waiting.
//
// Environment: TENANT_WORKER_TOKEN (required, 32+ characters), TENANT_PFX_PATH (/certs/app.pfx),
// TENANT_PFX_PASSWORD_FILE (/run/secrets/tenant_pfx_password), TENANT_WORKER_PORT (8080),
// TENANT_WORKER_OP_TIMEOUT_MS (120000), TENANT_WORKER_DRY_RUN=1 (print commands, never connect),
// and optionally TENANT_ID, TENANT_APP_ID, TENANT_ORGANIZATION: the only tenant it serves.
// Without the PFX or its password file the worker refuses to start (R-35).
import { spawn } from 'node:child_process';
import { X509Certificate, createHash, createPrivateKey, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpError, checkOp, checkTenant, parseGuid, parseOrganization } from './ops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MARKER = '@@TW@@';
export const MAX_BODY = 64 * 1024;
export const MAX_QUEUE = 20;
export const ASSERTION_TTL_S = 10 * 60;
const MAX_LOG_LINE = 300;

const STATUS = {
  unauthorized: 401, unknown_op: 404, invalid_args: 400, invalid_tenant: 400, invalid_json: 400, body_too_large: 413,
  exo_throttled: 429, exo_exists: 409, quarantine_not_allowed: 403,
  certificate_mismatch: 409, tenant_not_allowed: 403, exo_not_found: 422, busy: 503, exo_timeout: 504, exo_connect_failed: 502, exo_failed: 502,
  runner_failed: 502, runner_exited: 502, not_found: 404,
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// The certificate as the worker uses it: { der, x509, key, thumbprint, thumbprintSha256 }. Throws
// when the key is not the certificate's.
export function certificateFrom({ cert, key }) {
  const der = Buffer.from(cert, 'base64');
  const x509 = new X509Certificate(der);
  const privateKey = createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' });
  if (!x509.checkPrivateKey(privateKey)) throw new Error('The private key is not the certificate\'s');
  return {
    der, x509, key: privateKey,
    thumbprint: createHash('sha1').update(der).digest('hex').toUpperCase(),
    thumbprintSha256: createHash('sha256').update(der).digest('hex').toUpperCase(),
  };
}

export function certificateInfo(certificate) {
  const { x509 } = certificate;
  return {
    thumbprint: certificate.thumbprint,
    thumbprintSha256: certificate.thumbprintSha256,
    subject: x509.subject,
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: new Date(x509.validTo).toISOString(),
  };
}

// A client assertion for the Microsoft identity platform (certificate credentials): RS256, the
// certificate named by x5t (SHA-1) and x5t#S256, audience the tenant's v2.0 token endpoint, issuer
// and subject the application, valid ASSERTION_TTL_S.
export function signAssertion(certificate, { tenantId, appId }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = {
    alg: 'RS256', typ: 'JWT',
    x5t: b64url(Buffer.from(certificate.thumbprint, 'hex')),
    'x5t#S256': b64url(Buffer.from(certificate.thumbprintSha256, 'hex')),
  };
  const claims = {
    aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    iss: appId, sub: appId, jti: randomUUID(), nbf: iat, iat, exp: iat + ASSERTION_TTL_S,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), certificate.key);
  return { assertion: `${input}.${b64url(signature)}`, expiresAt: new Date((iat + ASSERTION_TTL_S) * 1000).toISOString() };
}

const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, MAX_LOG_LINE);

// The environment pwsh gets: the worker's own, without the panel's shared secret (pwsh never needs
// it, and a cmdlet or module could read it).
export function runnerEnv(env = process.env, extra = {}) {
  const rest = { ...env };
  delete rest.TENANT_WORKER_TOKEN;
  return { ...rest, ...extra };
}

function defaultSpawnRunner({ dryRun }) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'runner.ps1')];
  if (dryRun) args.push('-DryRun');
  return spawn('pwsh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: runnerEnv() });
}

// The pwsh runner: started on the first call, one request at a time, killed on a timeout (the
// next call starts it again). spawnRunner() returns a child process with stdin, stdout and stderr.
export function createRunner({ spawnRunner = defaultSpawnRunner, dryRun = false, timeoutMs = 120000, maxQueue = MAX_QUEUE, log = () => {} } = {}) {
  let child = null;
  let ready = null;
  let current = null; // { id, resolve, reject }
  let nextId = 1;
  let chain = Promise.resolve();
  let waiting = 0;

  function stop() {
    if (!child) return;
    const c = child;
    child = null;
    ready = null;
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }

  function start() {
    const c = spawnRunner({ dryRun });
    child = c;
    let buffer = '';
    let markReady;
    let failReady;
    ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    ready.catch(() => {});
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith(MARKER)) {
          if (line.trim()) log(`runner: ${clip(line)}`);
          continue;
        }
        let answer;
        try {
          answer = JSON.parse(line.slice(MARKER.length));
        } catch {
          log('runner: an answer that is not JSON');
          continue;
        }
        if (answer.id === 0) markReady();
        else if (current && answer.id === current.id) current.resolve(answer);
      }
    });
    c.stderr?.setEncoding?.('utf8');
    c.stderr?.on('data', (chunk) => log(`runner stderr: ${clip(chunk)}`));
    // A runner already replaced (stopped after a timeout) must not fail the call of its successor.
    const gone = () => {
      const mine = child === c;
      if (mine) { child = null; ready = null; }
      failReady(new OpError('runner_exited', 'The pwsh runner exited', 502));
      if (current && mine) current.reject(new OpError('runner_exited', 'The pwsh runner exited', 502));
    };
    // Writing to a runner that just died fails with EPIPE: its exit answers the call, the error must
    // not crash the worker.
    c.stdin.on('error', (err) => log(`runner stdin: ${clip(err?.code || err?.message)}`));
    c.on('exit', gone);
    c.on('error', gone);
  }

  async function exec(request) {
    if (!child) start();
    let timer;
    const deadline = new Promise((_, reject) => {
      // Not unref'd: a caller waiting for the answer keeps the process up until it comes or times out.
      timer = setTimeout(() => reject(new OpError('exo_timeout', 'The operation timed out', 504)), timeoutMs);
    });
    try {
      await Promise.race([ready, deadline]);
      const id = nextId++;
      const answer = new Promise((resolve, reject) => { current = { id, resolve, reject }; });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
      return await Promise.race([answer, deadline]);
    } catch (err) {
      // A runner that timed out may be stuck in a cmdlet: it is replaced, not reused.
      if (err?.code === 'exo_timeout') stop();
      throw err;
    } finally {
      clearTimeout(timer);
      current = null;
    }
  }

  return {
    call(request) {
      if (waiting >= maxQueue) return Promise.reject(new OpError('busy', 'Too many operations are waiting', 503));
      waiting += 1;
      const run = chain.then(() => exec(request));
      chain = run.catch(() => {});
      return run.finally(() => { waiting -= 1; });
    },
    get waiting() { return waiting; },
    stop,
  };
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function fail(res, code, message) {
  send(res, STATUS[code] ?? 500, { ok: false, error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // A body over the limit is read to its end and dropped (not kept), so the refusal can be sent.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new OpError('body_too_large', 'The request is too large', 413));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new OpError('invalid_json', 'The request is not a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

// The request handler. certificate: certificateFrom(...); runner: createRunner(...).
// pinned: { tenantId, appId, organization } from the worker's own environment (TENANT_ID,
// TENANT_APP_ID, TENANT_ORGANIZATION), each optional; a request for another tenant or application
// is refused (tenant_not_allowed), so the worker signs assertions and runs operations only for the
// tenant it was set up for, whatever the panel sends.
export function createHandler({ token, certificate, runner, pinned = {}, dryRun = false, log = () => {}, now = () => Date.now() }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('TENANT_WORKER_TOKEN must be at least 32 characters');
  const expected = digest(`Bearer ${token}`);
  const authorized = (req) => timingSafeEqual(digest(req.headers.authorization ?? ''), expected);
  const tenantOf = (body) => {
    const tenant = checkTenant(body.tenant);
    for (const field of ['tenantId', 'appId', 'organization']) {
      if (pinned[field] && pinned[field] !== tenant[field]) {
        throw new OpError('tenant_not_allowed', `The worker is set up for another ${field}`, 403);
      }
    }
    if (tenant.thumbprint !== certificate.thumbprint) {
      throw new OpError('certificate_mismatch', 'The thumbprint in the panel is not the worker certificate\'s', 409);
    }
    return tenant;
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://worker');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, dryRun });
      if (!authorized(req)) return fail(res, 'unauthorized', 'Missing or wrong token');
      if (req.method === 'GET' && url.pathname === '/certificate') return send(res, 200, { ok: true, result: certificateInfo(certificate) });
      if (req.method === 'POST' && url.pathname === '/assertion') {
        const tenant = tenantOf(await readBody(req));
        return send(res, 200, { ok: true, result: signAssertion(certificate, tenant, now()) });
      }
      const match = /^\/ops\/([a-z_]{1,64})$/.exec(url.pathname);
      if (req.method === 'POST' && match) {
        const op = match[1];
        const body = await readBody(req);
        const args = checkOp(op, body.args);
        const tenant = tenantOf(body);
        const started = now();
        const answer = await runner.call({ op, tenant: { appId: tenant.appId, organization: tenant.organization }, args });
        log(`op ${op}: ${answer.ok ? 'ok' : answer.error?.code ?? 'failed'} in ${now() - started} ms`);
        if (!answer.ok) return fail(res, STATUS[answer.error?.code] ? answer.error.code : 'exo_failed', clip(answer.error?.message));
        return send(res, 200, { ok: true, result: answer.result ?? null });
      }
      return fail(res, 'not_found', 'No such route');
    } catch (err) {
      if (err instanceof OpError) {
        log(`refused ${req.method} ${url.pathname.slice(0, 80)}: ${err.code}`);
        return fail(res, err.code, err.message);
      }
      log(`failed ${req.method} ${url.pathname.slice(0, 80)}: ${clip(err?.message)}`);
      return fail(res, 'runner_failed', 'The worker failed');
    }
  };
}

function loadCertificateWithPwsh({ pfxPath, passwordFile }) {
  return new Promise((resolve, reject) => {
    const c = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'cert.ps1')], {
      env: runnerEnv(process.env, { TENANT_PFX_PATH: pfxPath, TENANT_PFX_PASSWORD_FILE: passwordFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('exit', (code) => {
      if (code !== 0) return reject(new Error(clip(err) || `cert.ps1 exited with ${code}`));
      try {
        resolve(certificateFrom(JSON.parse(out.trim().split('\n').pop())));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// The start checks of R-35: the PFX and its password file must exist and be readable files.
export function startProblem({ token, pfxPath, passwordFile }) {
  if (typeof token !== 'string' || token.length < 32) return 'TENANT_WORKER_TOKEN must be set to at least 32 characters';
  for (const [name, file] of [['certificate', pfxPath], ['certificate password', passwordFile]]) {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      if (!fs.statSync(file).isFile()) return `the ${name} at ${file} is not a file`;
    } catch {
      return `no readable ${name} at ${file}`;
    }
  }
  return null;
}

export async function main(env = process.env) {
  const log = (line) => console.log(`[tenant-worker] ${line}`);
  const config = {
    token: env.TENANT_WORKER_TOKEN,
    pfxPath: env.TENANT_PFX_PATH || '/certs/app.pfx',
    passwordFile: env.TENANT_PFX_PASSWORD_FILE || '/run/secrets/tenant_pfx_password',
    dryRun: env.TENANT_WORKER_DRY_RUN === '1',
    port: Number(env.TENANT_WORKER_PORT) || 8080,
    timeoutMs: Number(env.TENANT_WORKER_OP_TIMEOUT_MS) || 120000,
    pinned: {
      tenantId: parseGuid(env.TENANT_ID ?? ''),
      appId: parseGuid(env.TENANT_APP_ID ?? ''),
      organization: parseOrganization(env.TENANT_ORGANIZATION ?? ''),
    },
  };
  const problem = startProblem(config);
  if (problem) {
    console.error(`[tenant-worker] refusing to start: ${problem}`);
    process.exit(1);
  }
  let certificate;
  try {
    certificate = await loadCertificateWithPwsh(config);
  } catch (err) {
    console.error(`[tenant-worker] refusing to start: the certificate could not be read (${clip(err?.message)})`);
    process.exit(1);
  }
  const info = certificateInfo(certificate);
  log(`certificate ${info.thumbprint}, valid until ${info.notAfter}${config.dryRun ? '; dry run: commands are printed, nothing connects' : ''}`);
  const runner = createRunner({ dryRun: config.dryRun, timeoutMs: config.timeoutMs, log });
  const handle = createHandler({ token: config.token, certificate, runner, pinned: config.pinned, dryRun: config.dryRun, log });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = config.timeoutMs + 30000;
  server.listen(config.port, () => log(`listening on ${config.port}`));
  const shutdown = () => {
    runner.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
