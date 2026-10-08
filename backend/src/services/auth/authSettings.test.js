import { describe, it, expect } from 'vitest';
import { authSettingsError, cloudflareEnvState, getAuthSettings } from './authSettings.js';

describe('getAuthSettings', () => {
  it('defaults to local mode without sign-in providers', () => {
    expect(getAuthSettings({})).toEqual({
      mode: 'local', cloudflare: null, googleSignIn: null, bootstrapAdminEmails: new Set(),
    });
  });

  it('reads Cloudflare Access, Google sign-in and bootstrap admins', () => {
    const settings = getAuthSettings({
      AUTH_MODE: ' Google ',
      CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com/ ',
      CF_ACCESS_AUDIENCE: ' aud-tag ',
      AUTH_GOOGLE_CLIENT_ID: 'client-id',
      AUTH_GOOGLE_CLIENT_SECRET: 'client-secret',
      BOOTSTRAP_ADMIN_EMAILS: 'Admin@Example.com, , not-an-email, second@example.com',
    });
    expect(settings.mode).toBe('google');
    expect(settings.cloudflare).toEqual({ issuer: 'https://team.cloudflareaccess.com', audience: 'aud-tag' });
    expect(settings.googleSignIn).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' });
    expect([...settings.bootstrapAdminEmails]).toEqual(['admin@example.com', 'second@example.com']);
  });

  it('needs both halves of a sign-in provider', () => {
    const settings = getAuthSettings({
      CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      AUTH_GOOGLE_CLIENT_ID: 'client-id',
    });
    expect(settings.cloudflare).toBeNull();
    expect(settings.googleSignIn).toBeNull();
  });
});

describe('authSettingsError', () => {
  it('accepts local mode and google mode with at least one sign-in path', () => {
    expect(authSettingsError(getAuthSettings({}))).toBeNull();
    expect(authSettingsError(getAuthSettings({
      AUTH_MODE: 'google', CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', CF_ACCESS_AUDIENCE: 'aud',
    }))).toBeNull();
    expect(authSettingsError(getAuthSettings({
      AUTH_MODE: 'google', AUTH_GOOGLE_CLIENT_ID: 'id', AUTH_GOOGLE_CLIENT_SECRET: 'secret',
    }))).toBeNull();
  });

  it('rejects an unknown mode and google mode without a sign-in path', () => {
    expect(authSettingsError(getAuthSettings({ AUTH_MODE: 'ldap' }))).toMatch(/AUTH_MODE must be/);
    expect(authSettingsError(getAuthSettings({ AUTH_MODE: 'google' }))).toMatch(/AUTH_MODE=google needs/);
  });
});

describe('cloudflareEnvState', () => {
  it('answers each Access value on its own, the issuer without a trailing slash', () => {
    expect(cloudflareEnvState({})).toEqual({ issuer: null, audience: null });
    expect(cloudflareEnvState({ CF_ACCESS_ISSUER: ' https://team.cloudflareaccess.com/ ' }))
      .toEqual({ issuer: 'https://team.cloudflareaccess.com', audience: null });
    expect(cloudflareEnvState({ CF_ACCESS_AUDIENCE: 'f'.repeat(64) })).toEqual({ issuer: null, audience: 'f'.repeat(64) });
  });
});
