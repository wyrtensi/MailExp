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


describe('GET /api/mail/messages/:id/body — numeric entity backfill', () => {
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

  it.each(['&#1114112;', '&#x110000;', '&#' + '9'.repeat(400) + ';'])(
    'opens a cached body containing %s and backfills its missing snippet', async (entity) => {
      const text = 'Readable ' + entity + ' ending';
      query.mockResolvedValueOnce({ rows: [messageRow({ body_text: text, snippet: '' })] })
        .mockResolvedValue({ rows: [] });
      const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
      expect(response.status).toBe(200);
      expect((await response.json()).text).toBe(text);
      expect(query).toHaveBeenCalledWith('UPDATE messages SET snippet = $1 WHERE id = $2',
        [text.slice(0, 200), MESSAGE_ID]);
      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    }
  );
});
