import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { bodyErrorHandler, finalErrorHandler } from './errorHandlers.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.use(bodyErrorHandler);
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/boom', () => { throw new Error('relation "secret_table" does not exist'); });
  app.use(finalErrorHandler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const post = (body) => fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  .then(async (res) => ({ status: res.status, body: await res.json() }));

describe('body parser errors', () => {
  it('a malformed JSON body is a 400 invalid_json, not a 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await post('{"a":')).toEqual({ status: 400, body: { error: 'The request body is not valid JSON', code: 'invalid_json' } });
    spy.mockRestore();
  });

  it('an oversized body keeps its 413 and gains a code', async () => {
    const res = await post(JSON.stringify({ a: 'x'.repeat(4096) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('request_too_large');
    expect(res.body.error).toMatch(/Request too large/);
  });

  it('a valid body passes through', async () => {
    expect(await post('{"a":1}')).toEqual({ status: 200, body: { a: 1 } });
  });
});

describe('unhandled route errors', () => {
  it('answers a 500 with a code and no internals, and logs the request it came from', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${base}/boom?x=1`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'internal_error' });
    expect(spy.mock.calls[0][0]).toContain('GET /boom');
    spy.mockRestore();
  });
});
