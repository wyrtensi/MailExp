import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {}, withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({
  decrypt: () => 'smtp-secret',
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(async () => ({ host: '203.0.113.10', servername: 'smtp.example.com' })),
}));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/smtpTransport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createSmtpTransport: vi.fn(),
}));
vi.mock('../services/authLimiter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ getGlobalCategorizationEnabled: vi.fn(async () => true) }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false, resetMs: 0 })),
  peek: vi.fn(),
  reset: vi.fn(),
}));

import express from 'express';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { createSmtpTransport } from '../services/smtpTransport.js';

// The password reset letter goes through the system SMTP and its saved encryption, like the rest
// of the system mail (see services/systemSmtp.test.js). The route always answers 200, so a letter
// it cannot send is logged for the operator.
let server;
let base;
let stored;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  stored = { port: 587, tls: 'STARTTLS' };
  query.mockImplementation(async (sql) => {
    if (sql.includes('system_email_config')) {
      return { rows: [{ value: JSON.stringify({ host: 'smtp.example.com', ...stored, user: 'system@example.com', pass: 'x' }) }] };
    }
    if (sql.includes('FROM users WHERE recovery_email')) return { rows: [{ id: 'u1', password_hash: 'hash' }] };
    return { rows: [] };
  });
  createSmtpTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}) });
});

const forgot = () => fetch(`${base}/api/auth/forgot-password`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com' }),
});

describe('POST /api/auth/forgot-password through the system SMTP', () => {
  it('requires STARTTLS on port 587', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    expect((await forgot()).status).toBe(200);
    expect(createSmtpTransport).toHaveBeenCalledOnce();
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('sends in plain text for tls none only when insecure TLS is allowed', async () => {
    stored = { port: 25, tls: 'none' };
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: true });
    expect((await forgot()).status).toBe(200);
    expect(createSmtpTransport.mock.calls[0][1]).toMatchObject({ secure: false, ignoreTLS: true });
  });

  it('logs why the letter was not sent when plain text is refused', async () => {
    stored = { port: 25, tls: 'none' };
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await forgot()).status).toBe(200);
      expect(createSmtpTransport).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith(
        'forgot-password: system SMTP unusable:', expect.stringMatching(/Plain-text SMTP is not allowed/),
      );
    } finally {
      errors.mockRestore();
    }
  });
});
