import { describe, it, expect, vi } from 'vitest';

// Pure-function tests only, but importing send.js pulls in its module graph (including
// ../index.js, the whole app entry point) — mock every side-effecting dependency the same way
// the other send tests do so this stays a lightweight unit test.
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { smtpConnectionFailure, smtpFailureIsDefinite } from './send.js';

const ACCOUNT = { smtp_host: 'smtp.gmail.com', smtp_port: 465 };

describe('smtpConnectionFailure', () => {
  it('maps a connection timeout to a host:port message naming the reason', () => {
    const err = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)).toEqual({
      code: 'smtp_connection_failed',
      reason: 'timeout',
      host: 'smtp.gmail.com',
      port: 465,
      error: "Could not connect to smtp.gmail.com:465 (timed out). The server's network may block outgoing mail ports.",
    });
  });

  it('maps a greeting timeout to the same timeout reason', () => {
    const err = Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)?.reason).toBe('timeout');
  });

  it('maps ECONNREFUSED (code ESOCKET, OS code in the message) to refused', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET', command: 'CONN' });
    const result = smtpConnectionFailure(err, ACCOUNT);
    expect(result.reason).toBe('refused');
    expect(result.error).toContain('connection refused');
  });

  it('maps ENOTFOUND (code EDNS) to not_found', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.gmail.com'), { code: 'EDNS', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)?.reason).toBe('not_found');
  });

  it('maps EHOSTUNREACH to unreachable', () => {
    const err = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.1:465'), { code: 'ESOCKET', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)?.reason).toBe('unreachable');
  });

  it('maps a TLS handshake failure (code ETLS) to tls', () => {
    const err = Object.assign(new Error('Error initiating TLS - self signed certificate'), { code: 'ETLS', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)?.reason).toBe('tls');
  });

  it('classifies an unrecognized ECONNECTION (not a mid-session close) as a generic connection failure', () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNECTION', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)?.reason).toBe('unknown');
  });

  it('returns null for an SMTP AUTH rejection — that keeps its own handling', () => {
    const err = Object.assign(new Error('Invalid login: 535 5.7.8 authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' });
    expect(smtpConnectionFailure(err, ACCOUNT)).toBeNull();
  });

  it('returns null for a server rejection of the message (definite, but not a connection failure)', () => {
    const err = Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' });
    expect(smtpConnectionFailure(err, ACCOUNT)).toBeNull();
  });

  it('returns null for a mid-session close even though nodemailer tags it ECONNECTION/CONN', () => {
    // Same code+command as a pre-AUTH connect failure, but this can only happen once the
    // session was already under way — the message may have been delivered.
    const err = Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' });
    expect(smtpConnectionFailure(err, ACCOUNT)).toBeNull();
  });

  it('returns null when the server terminates the connection during EHLO', () => {
    const err = Object.assign(new Error('Server terminates connection. response=421 too busy'), { code: 'ECONNECTION', command: 'EHLO' });
    expect(smtpConnectionFailure(err, ACCOUNT)).toBeNull();
  });

  it('falls back to a generic host name and omits the port when the account has none configured', () => {
    const err = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
    const result = smtpConnectionFailure(err, {});
    expect(result.host).toBeNull();
    expect(result.port).toBeNull();
    expect(result.error).toBe("Could not connect to the mail server (timed out). The server's network may block outgoing mail ports.");
  });
});

describe('smtpFailureIsDefinite for connection-level failures', () => {
  it('treats a TLS handshake failure as definite (nothing was ever sent)', () => {
    const err = Object.assign(new Error('Error initiating TLS - self signed certificate'), { code: 'ETLS', command: 'CONN' });
    expect(smtpFailureIsDefinite(err)).toBe(true);
  });

  it('treats a DNS failure as definite', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.gmail.com'), { code: 'EDNS', command: 'CONN' });
    expect(smtpFailureIsDefinite(err)).toBe(true);
  });

  it('treats a connection timeout as definite', () => {
    const err = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
    expect(smtpFailureIsDefinite(err)).toBe(true);
  });
});
