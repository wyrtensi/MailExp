import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { composeJson } from './composeBody.js';

import { MAX_ATTACHMENT_BYTES } from '../utils/attachmentLimit.js';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.post('/send', composeJson(), (req, res) => res.json({ ok: true, size: req.body.attachments[0].content.length }));
  app.use((err, _req, res, next) => (err ? res.status(err.status || 500).json({ error: err.type }) : next()));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

describe('the composer JSON body limit', () => {
  it('takes a full 25 MiB of attachments as base64 with a large quoted body', async () => {
    const content = Buffer.alloc(MAX_ATTACHMENT_BYTES, 1).toString('base64');
    const quotedBodyHtml = `<blockquote>${'x'.repeat(4 * 1024 * 1024)}</blockquote>`;
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '<p>hi</p>', quotedBodyHtml, attachments: [{ filename: 'big.bin', content }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).size).toBe(content.length);
  });

  it('still refuses a body over the limit', async () => {
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [{ filename: 'huge.bin', content: 'A'.repeat(48 * 1024 * 1024) }] }),
    });
    expect(res.status).toBe(413);
  });
});
