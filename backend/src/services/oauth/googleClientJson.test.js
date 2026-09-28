import { describe, it, expect } from 'vitest';
import { parseGoogleClientJson, googleClientJsonWarnings } from './googleClientJson.js';
import { GoogleAppError } from './googleApps.js';

const WEB_CLIENT = {
  web: {
    client_id: '123456789012-abc123def456.apps.googleusercontent.com',
    project_id: 'my-project-123',
    client_secret: 'GOCSPX-secret-value',
    redirect_uris: ['https://mail.example.com/oauth/google/callback'],
    javascript_origins: ['https://mail.example.com'],
  },
};

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(GoogleAppError);
    return err.code;
  }
}

describe('parseGoogleClientJson', () => {
  it('reads client id, secret, project id and redirect uris from a web client', () => {
    const parsed = parseGoogleClientJson(JSON.stringify(WEB_CLIENT));
    expect(parsed).toEqual({
      clientId: '123456789012-abc123def456.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret-value',
      projectId: 'my-project-123',
      redirectUris: ['https://mail.example.com/oauth/google/callback'],
    });
  });

  it('trims the client id and each redirect uri, and drops non-string entries', () => {
    const parsed = parseGoogleClientJson(JSON.stringify({
      web: {
        client_id: `  ${WEB_CLIENT.web.client_id}  `,
        client_secret: 'secret',
        redirect_uris: [' https://a.example.com/cb ', 42, null],
      },
    }));
    expect(parsed.clientId).toBe(WEB_CLIENT.web.client_id);
    expect(parsed.redirectUris).toEqual(['https://a.example.com/cb']);
  });

  it('defaults redirectUris and projectId when absent', () => {
    const parsed = parseGoogleClientJson(JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));
    expect(parsed.redirectUris).toEqual([]);
    expect(parsed.projectId).toBe('');
  });

  it('rejects malformed JSON', () => {
    expect(codeOf(() => parseGoogleClientJson('{not json'))).toBe('client_json_invalid');
    expect(codeOf(() => parseGoogleClientJson(''))).toBe('client_json_invalid');
    expect(codeOf(() => parseGoogleClientJson('   '))).toBe('client_json_invalid');
    expect(codeOf(() => parseGoogleClientJson(null))).toBe('client_json_invalid');
    expect(codeOf(() => parseGoogleClientJson('[]'))).toBe('client_json_invalid');
    expect(codeOf(() => parseGoogleClientJson('42'))).toBe('client_json_invalid');
  });

  it('rejects a service account key', () => {
    const json = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'x', client_email: 'a@p.iam.gserviceaccount.com' });
    expect(codeOf(() => parseGoogleClientJson(json))).toBe('client_json_service_account');
  });

  it('rejects a desktop (installed) client', () => {
    const json = JSON.stringify({ installed: { client_id: 'x', client_secret: 'y', redirect_uris: ['http://localhost'] } });
    expect(codeOf(() => parseGoogleClientJson(json))).toBe('client_json_not_web');
  });

  it('rejects JSON with neither a web nor an installed client', () => {
    expect(codeOf(() => parseGoogleClientJson('{}'))).toBe('client_json_not_web');
    expect(codeOf(() => parseGoogleClientJson(JSON.stringify({ web: 'nope' })))).toBe('client_json_not_web');
  });

  it('rejects a web client missing the id or the secret', () => {
    expect(codeOf(() => parseGoogleClientJson(JSON.stringify({ web: { client_secret: 'y' } })))).toBe('client_json_incomplete');
    expect(codeOf(() => parseGoogleClientJson(JSON.stringify({ web: { client_id: 'x' } })))).toBe('client_json_incomplete');
    expect(codeOf(() => parseGoogleClientJson(JSON.stringify({ web: { client_id: '  ', client_secret: 'y' } })))).toBe('client_json_incomplete');
  });
});

describe('googleClientJsonWarnings', () => {
  const expected = 'https://mail.example.com/oauth/google/callback';

  it('is empty when the expected callback is listed', () => {
    expect(googleClientJsonWarnings([expected], expected)).toEqual([]);
    expect(googleClientJsonWarnings(['https://other.example.com/cb', expected], expected)).toEqual([]);
  });

  it('warns when the expected callback is missing from the file', () => {
    expect(googleClientJsonWarnings([], expected)).toEqual([{ code: 'redirect_uri_missing', expected }]);
    expect(googleClientJsonWarnings(['https://other.example.com/cb'], expected)).toEqual([{ code: 'redirect_uri_missing', expected }]);
  });

  it('does not normalize: a trailing slash or different case still misses', () => {
    expect(googleClientJsonWarnings([`${expected}/`], expected)).toEqual([{ code: 'redirect_uri_missing', expected }]);
  });

  it('warns that no callback is configured yet when there is nothing to compare against', () => {
    expect(googleClientJsonWarnings([expected], null)).toEqual([{ code: 'callback_not_configured' }]);
    expect(googleClientJsonWarnings([expected], '')).toEqual([{ code: 'callback_not_configured' }]);
  });
});
