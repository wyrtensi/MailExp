import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('API error propagation', () => {
  it('attaches the stable error code from the response body', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'This message is already being sent', code: 'send_in_progress' }),
    });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'This message is already being sent');
      assert.equal(err.code, 'send_in_progress');
      return true;
    });
  });

  it('attaches the reason and count from a 409 threading refusal', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'threading_switch_blocked', reason: 'ids_missing', count: 7 }),
    });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'threading_switch_blocked');
      assert.equal(err.reason, 'ids_missing');
      assert.equal(err.count, 7);
      return true;
    });
  });

  it('attaches host/port from a send failure so the composer can build its own message', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => ({
        error: "Could not connect to smtp.gmail.com:465 (timed out). The server's network may block outgoing mail ports.",
        code: 'smtp_connection_failed', reason: 'timeout', host: 'smtp.gmail.com', port: 465,
      }),
    });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.code, 'smtp_connection_failed');
      assert.equal(err.reason, 'timeout');
      assert.equal(err.host, 'smtp.gmail.com');
      assert.equal(err.port, 465);
      return true;
    });
  });

  it('leaves code unset when the response has none', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Boom' }) });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'Boom');
      assert.equal(Object.hasOwn(err, 'code'), false);
      return true;
    });
  });

  it('falls back to a generic message for a non-JSON body', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'Request failed');
      assert.equal(err.code, undefined);
      return true;
    });
  });
});
