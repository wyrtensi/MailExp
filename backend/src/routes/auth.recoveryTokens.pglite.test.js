import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Sign-in codes and password reset links against real Postgres SQL, while the recovery email
// changes. Changing it deletes what was already sent to the old address, but a code or link whose
// issue read the old address before the change can be stored after that cleanup. Each one is
// bound to the address it was sent to and accepted only while that is still the recovery email.

const mocks = vi.hoisted(() => ({
  db: null,
  // While set, the statement starting with `sql` waits for `released` after it has run, and
  // `reached` resolves: the issue has read the old address and not yet stored its token.
  hold: null,
  sendMail: vi.fn(),
}));
async function run(sql, params) {
  const result = await mocks.db.query(sql, params);
  const hold = mocks.hold;
  if (hold && sql.startsWith(hold.sql)) {
    mocks.hold = null;
    hold.reach();
    await hold.released;
  }
  return result;
}
vi.mock('../services/db.js', () => ({
  query: run,
  pool: {},
  withTransaction: (fn) => mocks.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('../index.js', () => ({ imapManager: { wss: { clients: new Set() } } }));
vi.mock('../services/websocket.js', () => ({ closeUserSockets: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(async () => ({ host: '203.0.113.10', servername: 'smtp.example.com' })),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false, allowInsecureTls: false })),
}));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSmtpTransport: vi.fn(() => ({ sendMail: mocks.sendMail })),
}));
vi.mock('../services/authLimiter.js', async (importOriginal) => ({ ...(await importOriginal()), authLimiterConfig: { maxRequests: 100, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => true) }));
vi.mock('../services/redis.js', () => ({ redisClient: { scan: vi.fn(async () => ({ cursor: '0', keys: [] })) } }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false, resetMs: 0 })),
  peek: vi.fn(async () => ({ limited: false })),
  reset: vi.fn(async () => {}),
}));
// Password hashing is not under test, and bcrypt at cost 12 is slow enough to matter under load.
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'new-hash'), hashSync: () => 'dummy-hash', compare: vi.fn() } }));

const { createRealSchemaDb } = await import('../services/testing/realSchema.js');
const { default: express } = await import('express');
const { default: authRoutes } = await import('./auth.js');
const { sendSystemEmail } = await import('../services/mailer.js');

const USER = '71000000-0000-4000-8000-000000000001';
const OLD = 'old@example.com';
const NEW = 'new@example.com';

let server;
let base;
// The owner signed in (changes the recovery email), and a sign-in waiting for its emailed code.
let sessions;

beforeAll(async () => {
  mocks.db = await createRealSchemaDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = sessions[req.get('x-session')];
    next();
  });
  app.use('/api/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mocks.db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.hold = null;
  mocks.sendMail.mockResolvedValue({});
  const pending = {
    pendingUserId: USER,
    pendingTOTPExpiry: Date.now() + 10 * 60 * 1000,
    regenerate(cb) {
      for (const key of Object.keys(this)) if (typeof this[key] !== 'function') delete this[key];
      cb();
    },
  };
  sessions = { owner: { userId: USER }, pending, none: {} };
  await mocks.db.exec('DELETE FROM email_otp_tokens; DELETE FROM password_reset_tokens; DELETE FROM users;');
  await mocks.db.query(
    `INSERT INTO users (id, username, password_hash, recovery_email) VALUES ($1, 'recovery-user', 'old-hash', $2)`,
    [USER, OLD],
  );
  await mocks.db.query(
    `INSERT INTO system_settings (key, value) VALUES ('system_email_config', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ host: 'smtp.example.com', port: 587, tls: 'STARTTLS', user: 'system@example.com', pass: 'x' })],
  );
});

const call = (path, session, body, method = 'POST') => fetch(`${base}/api/auth${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-session': session }, body: JSON.stringify(body),
});
const changeAddress = async (email) => expect((await call('/profile/recovery-email', 'owner', { email }, 'PATCH')).status).toBe(200);

// Holds the statement starting with `sql` once it has run; resolves to a release function once
// a request has reached it.
function holdAfter(sql) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((reach) => { mocks.hold = { sql, released, reach }; });
  return reached.then(() => release);
}

const mailedCode = () => sendSystemEmail.mock.calls.at(-1)[0].text.match(/code is: (\d{6})/)[1];
const mailedToken = () => mocks.sendMail.mock.calls.at(-1)[0].text.match(/reset_token=([0-9a-f]+)/)[1];
const verifyCode = (code) => call('/2fa/verify-email-otp', 'pending', { code });
const resetPassword = (token) => call('/reset-password', 'none', { token, password: 'new-password-1' });

describe('sign-in codes sent to the recovery email', () => {
  it('a code sent to the address it still is signs in', async () => {
    expect((await call('/2fa/send-email-otp', 'pending', {})).status).toBe(200);
    expect(sendSystemEmail.mock.calls[0][0].to).toBe(OLD);
    const res = await verifyCode(mailedCode());
    expect(res.status).toBe(200);
    expect(sessions.pending.userId).toBe(USER);
    // Used up: the same code does not sign in twice.
    sessions.pending.pendingUserId = USER;
    sessions.pending.pendingTOTPExpiry = Date.now() + 60000;
    expect((await verifyCode(mailedCode())).status).toBe(401);
  });

  it('a code sent to the old address after the change does not sign in', async () => {
    // The code is issued for the address read before the change, and stored after the change
    // has already deleted what the old address had.
    const reached = holdAfter('SELECT recovery_email FROM users');
    const sending = call('/2fa/send-email-otp', 'pending', {});
    const release = await reached;
    await changeAddress(NEW);
    release();
    expect((await sending).status).toBe(200);
    expect(sendSystemEmail.mock.calls[0][0].to).toBe(OLD);

    const res = await verifyCode(mailedCode());
    expect(res.status).toBe(401);
    expect(sessions.pending.userId).toBeUndefined();

    // A code sent to the new address works.
    expect((await call('/2fa/send-email-otp', 'pending', {})).status).toBe(200);
    expect(sendSystemEmail.mock.calls.at(-1)[0].to).toBe(NEW);
    expect((await verifyCode(mailedCode())).status).toBe(200);
  });

  it('a code stored before codes were bound to an address does not sign in', async () => {
    await call('/2fa/send-email-otp', 'pending', {});
    await mocks.db.query('UPDATE email_otp_tokens SET sent_to = NULL');
    expect((await verifyCode(mailedCode())).status).toBe(401);
  });
});

describe('password reset links sent to the recovery email', () => {
  const forgot = (email = OLD) => call('/forgot-password', 'none', { email });

  it('a link sent to the address it still is resets the password, once', async () => {
    // The token is stored before the letter goes out, so a change of address meanwhile deletes it.
    mocks.sendMail.mockImplementation(async () => {
      const { rows } = await mocks.db.query('SELECT sent_to FROM password_reset_tokens WHERE user_id = $1', [USER]);
      expect(rows).toEqual([{ sent_to: OLD }]);
      return {};
    });
    expect((await forgot()).status).toBe(200);
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    const token = mailedToken();
    expect((await resetPassword(token)).status).toBe(200);
    const { rows } = await mocks.db.query('SELECT password_hash FROM users WHERE id = $1', [USER]);
    expect(rows[0].password_hash).toBe('new-hash');
    expect((await resetPassword(token)).status).toBe(400);
  });

  it('a link sent to the old address after the change does not reset the password', async () => {
    const reached = holdAfter('SELECT id, password_hash FROM users WHERE recovery_email');
    const sending = forgot();
    const release = await reached;
    await changeAddress(NEW);
    release();
    expect((await sending).status).toBe(200);
    expect(mocks.sendMail.mock.calls[0][0].to).toBe(OLD);

    expect((await resetPassword(mailedToken())).status).toBe(400);
    const { rows } = await mocks.db.query('SELECT password_hash FROM users WHERE id = $1', [USER]);
    expect(rows[0].password_hash).toBe('old-hash');
  });

  it('a change of address while the letter is going out deletes its link', async () => {
    mocks.sendMail.mockImplementation(async () => { await changeAddress(NEW); return {}; });
    expect((await forgot()).status).toBe(200);
    expect((await resetPassword(mailedToken())).status).toBe(400);
  });

  it('a letter that fails to send leaves no link, and keeps the one sent before', async () => {
    expect((await forgot()).status).toBe(200);
    const earlier = mailedToken();
    mocks.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await forgot()).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
    expect((await resetPassword(mailedToken())).status).toBe(400);
    expect((await resetPassword(earlier)).status).toBe(200);
  });

  const tokenOfLetter = (i) => mocks.sendMail.mock.calls[i][0].text.match(/reset_token=([0-9a-f]+)/)[1];

  it('of two requests at once, the later link stays', async () => {
    // A stores its link and is held; B stores, sends and cleans up; then A sends and cleans up.
    // Each removing every link but its own would leave none.
    const reached = holdAfter('INSERT INTO password_reset_tokens');
    const first = forgot();
    const release = await reached;
    expect((await forgot()).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    const [later, earlier] = [tokenOfLetter(0), tokenOfLetter(1)];
    expect((await resetPassword(earlier)).status).toBe(400);
    expect((await resetPassword(later)).status).toBe(200);
  });

  it('a late request to the old address does not cancel a link sent to the new one', async () => {
    const reached = holdAfter('SELECT id, password_hash FROM users WHERE recovery_email');
    const late = forgot(OLD);
    const release = await reached;
    await changeAddress(NEW);
    expect((await forgot(NEW)).status).toBe(200);
    const fresh = tokenOfLetter(0);
    release();
    expect((await late).status).toBe(200);
    expect(mocks.sendMail.mock.calls[1][0].to).toBe(OLD);
    expect((await resetPassword(tokenOfLetter(1))).status).toBe(400);
    expect((await resetPassword(fresh)).status).toBe(200);
  });

  it('a new link replaces the one sent before', async () => {
    expect((await forgot()).status).toBe(200);
    const earlier = mailedToken();
    expect((await forgot()).status).toBe(200);
    expect((await resetPassword(earlier)).status).toBe(400);
    expect((await resetPassword(mailedToken())).status).toBe(200);
  });

  it('a link stored before links were bound to an address does not reset the password', async () => {
    await forgot();
    await mocks.db.query('UPDATE password_reset_tokens SET sent_to = NULL');
    expect((await resetPassword(mailedToken())).status).toBe(400);
  });
});
