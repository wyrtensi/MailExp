import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchMessageBody: vi.fn(),
    noteUserActivity: vi.fn(),
    moveQueue: { serverLocation: async (m) => ({ folder: m.folder, uid: Number(m.uid) }) },
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

function messageRow(overrides) {
  return {
    id: MESSAGE_ID, account_id: 'acc-1', uid: 9, folder: 'INBOX', user_id: 'user-1', preferences: {},
    body_html: null, body_text: null, attachments: '[]', snippet: 'x',
    sender_email: null, sender_name: null, eop_category: null,
    ...overrides,
  };
}

// The reading pane decides on safe mode (R-41) from the body answer: the EOP category the sync
// stored rides along, so opening a letter costs no extra request and no header fetch.
describe('GET /api/mail/messages/:id/body — EOP category', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.fetchMessageBody.mockReset();
  });

  it('answers the stored category with a cached body', async () => {
    query.mockResolvedValue({ rows: [messageRow({ body_text: 'Verify your account', eop_category: 'PHSH' })] });
    const body = await (await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`)).json();
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(body.eopCategory).toBe('PHSH');
  });

  it('answers the stored category with a body fetched from the server', async () => {
    query
      .mockResolvedValueOnce({ rows: [messageRow({ eop_category: 'MALW' })] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValue({ rows: [] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: null, text: 'Open the attachment', attachments: [] });
    const body = await (await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`)).json();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(body.eopCategory).toBe('MALW');
  });

  it('answers null for a letter without a category', async () => {
    query.mockResolvedValue({ rows: [messageRow({ body_text: 'Hello', eop_category: undefined })] });
    const body = await (await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`)).json();
    expect(body.eopCategory).toBeNull();
  });
});
