import { beforeEach, describe, expect, it, vi } from 'vitest';

// The quarantine and rspamd history calls of the mailcow client (R-20), with the answers shaped as
// mailcow 2026-09 sends them (json_api.php get/quarantine, edit/qitem, delete/qitem,
// get/logs/rspamd-history; functions.quarantine.inc.php).

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn() }));

import { safeFetch } from '../safeFetch.js';
import {
  deleteQuarantineItem,
  getQuarantineItem,
  getRspamdHistory,
  listQuarantine,
  normalizeSymbols,
  QUARANTINE_NODE_SETTINGS,
  learnSpamQuarantineItem,
  releaseQuarantineItem,
  writeQuarantineSettings,
} from './mailcow.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 5120 };
const answer = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const calls = () => safeFetch.mock.calls.map(([url, opts]) => ({
  url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined,
}));

beforeEach(() => { safeFetch.mockReset(); });

describe('normalizeSymbols', () => {
  it('reads the quarantine list (as JSON text) and the history map into one order', () => {
    const list = JSON.stringify([
      { name: 'MIME_GOOD', score: -0.1, options: ['text/plain'] },
      { name: 'GTUBE', score: 0, options: [] },
      { name: 'R_SPF_FAIL', score: 8, options: ['-all'] },
      { name: 'BAYES_SPAM', score: 5.1 },
    ]);
    expect(normalizeSymbols(list).map((s) => [s.name, s.score])).toEqual([
      ['R_SPF_FAIL', 8], ['BAYES_SPAM', 5.1], ['MIME_GOOD', -0.1], ['GTUBE', 0],
    ]);
    expect(normalizeSymbols(list)[0]).toEqual({ name: 'R_SPF_FAIL', score: 8, options: ['-all'], description: null });
    const map = {
      DMARC_POLICY_REJECT: { name: 'DMARC_POLICY_REJECT', score: 16, metric_score: 16, options: ['example.com : SPF not aligned'], description: 'DMARC reject policy' },
      ARC_NA: { score: 0, metric_score: 0 },
    };
    expect(normalizeSymbols(map)).toEqual([
      { name: 'DMARC_POLICY_REJECT', score: 16, options: ['example.com : SPF not aligned'], description: 'DMARC reject policy' },
      { name: 'ARC_NA', score: 0, options: [], description: null },
    ]);
  });

  it('gives an empty list for anything else', () => {
    for (const bad of [null, undefined, '', 'not json', 42, '[1, "x", null]']) expect(normalizeSymbols(bad)).toEqual([]);
  });
});

describe('quarantine', () => {
  it('lists the entries newest first with the time as ISO', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { id: 3, qid: '4Xyz1', subject: 'Win', virus_flag: 0, score: '15.20', rcpt: 'Info@Example.com', sender: 'spam@bad.test', action: 'reject', created: 1759312800, notified: 0 },
      { id: 7, qid: '4Xyz2', subject: 'Offer', virus_flag: 5, score: 9, rcpt: 'sales@example.com', sender: 'x@bad.test', action: 'add header', created: 1759316400, notified: 1 },
    ]));
    expect(await listQuarantine(CFG)).toEqual([
      { id: 7, qid: '4Xyz2', subject: 'Offer', score: 9, sender: 'x@bad.test', rcpt: 'sales@example.com', action: 'add header', created: '2025-10-01T11:00:00.000Z', notified: true, virus: true },
      { id: 3, qid: '4Xyz1', subject: 'Win', score: 15.2, sender: 'spam@bad.test', rcpt: 'info@example.com', action: 'reject', created: '2025-10-01T10:00:00.000Z', notified: false, virus: false },
    ]);
    expect(calls()[0]).toMatchObject({ url: 'https://mail.example.com/api/v1/get/quarantine/all', method: 'GET' });
    safeFetch.mockResolvedValueOnce(answer([]));
    expect(await listQuarantine(CFG)).toEqual([]);
  });

  it('reads one entry with its letter, or null', async () => {
    safeFetch.mockResolvedValueOnce(answer({
      id: 3, qid: '4Xyz1', subject: 'Win', score: 15.2, ip: '198.51.100.7', action: 'reject',
      symbols: '[{"name":"GTUBE","score":0}]', fuzzy_hashes: '[]', sender: 'spam@bad.test', rcpt: 'info@example.com',
      msg: 'Subject: Win\r\n\r\nbody', domain: null, notified: 0, created: '2026-10-01 12:00:00', user: 'unknown', qhash: 'abc',
    }));
    expect(await getQuarantineItem(CFG, 3)).toEqual({
      id: 3, qid: '4Xyz1', subject: 'Win', score: 15.2, ip: '198.51.100.7', action: 'reject',
      symbols: [{ name: 'GTUBE', score: 0, options: [], description: null }], sender: 'spam@bad.test', rcpt: 'info@example.com',
      user: null, created: '2026-10-01 12:00:00', msg: 'Subject: Win\r\n\r\nbody',
    });
    expect(calls()[0].url).toBe('https://mail.example.com/api/v1/get/quarantine/3');
    // mailcow answers [] for an id it has no row for.
    safeFetch.mockResolvedValueOnce(answer([]));
    expect(await getQuarantineItem(CFG, 4)).toBeNull();
  });

  it('releases: the letter going out is the success, a failed training only a warning', async () => {
    safeFetch.mockResolvedValueOnce(answer([
      { type: 'success', msg: ['item_released', '3'] },
      { type: 'success', msg: ['learned_ham', '3'] },
    ]));
    expect(await releaseQuarantineItem(CFG, 3)).toEqual({ learned: true, warnings: [] });
    expect(calls()[0]).toMatchObject({ url: 'https://mail.example.com/api/v1/edit/qitem', method: 'POST', body: { items: [3], attr: { action: 'release' } } });
    safeFetch.mockResolvedValueOnce(answer([
      { type: 'success', msg: ['item_released', '3'] },
      { type: 'danger', msg: ['ham_learn_error', 'Curl: timeout'] },
    ]));
    expect(await releaseQuarantineItem(CFG, 3)).toEqual({ learned: false, warnings: ['ham_learn_error Curl: timeout'] });
  });

  it('refuses a release that did not go out', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'warning', msg: 'Cannot connect to Postfix' }]));
    await expect(releaseQuarantineItem(CFG, 3)).rejects.toMatchObject({ code: 'mail_node_refused', message: 'The mail node refused: Cannot connect to Postfix' });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: 'access_denied' }]));
    await expect(releaseQuarantineItem(CFG, 3)).rejects.toMatchObject({ code: 'mail_node_refused' });
  });

  it('deletes an entry', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: ['item_deleted', '3'] }]));
    await deleteQuarantineItem(CFG, 3);
    expect(calls()[0]).toMatchObject({ url: 'https://mail.example.com/api/v1/delete/qitem', method: 'POST', body: [3] });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: 'access_denied' }]));
    await expect(deleteQuarantineItem(CFG, 3)).rejects.toMatchObject({ code: 'mail_node_refused' });
  });
});

describe('delete and train as spam', () => {
  it('counts the entry as gone once mailcow deleted it, a failed training being a warning', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: ['qlearn_spam', '3'] }]));
    expect(await learnSpamQuarantineItem(CFG, 3)).toEqual({ learned: true, warnings: [] });
    expect(calls()[0]).toMatchObject({ url: 'https://mail.example.com/api/v1/edit/qitem', body: { items: [3], attr: { action: 'learnspam' } } });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: ['spam_learn_error', 'Curl: timeout'] }]));
    expect(await learnSpamQuarantineItem(CFG, 3)).toEqual({ learned: false, warnings: ['spam_learn_error Curl: timeout'] });
    safeFetch.mockResolvedValueOnce(answer([
      { type: 'warning', msg: ['fuzzy_learn_error', 'x'] }, { type: 'success', msg: ['qlearn_spam', '3'] },
    ]));
    expect(await learnSpamQuarantineItem(CFG, 3)).toEqual({ learned: true, warnings: ['fuzzy_learn_error x'] });
  });

  it('refuses when mailcow did not touch the entry', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: 'access_denied' }]));
    await expect(learnSpamQuarantineItem(CFG, 3)).rejects.toMatchObject({ code: 'mail_node_refused', message: 'The mail node refused: access_denied' });
    safeFetch.mockResolvedValueOnce(answer({ type: 'success', msg: 'Task completed' }));
    await expect(learnSpamQuarantineItem(CFG, 3)).rejects.toMatchObject({ code: 'mail_node_refused' });
  });
});

describe('quarantine settings', () => {
  it('writes every field, release as the original letter, and needs mailcow to say it saved them', async () => {
    safeFetch.mockResolvedValueOnce(answer([{ type: 'success', msg: 'saved_settings' }]));
    await writeQuarantineSettings(CFG);
    expect(calls()[0]).toMatchObject({ url: 'https://mail.example.com/api/v1/edit/quarantine', method: 'POST' });
    expect(calls()[0].body).toEqual({
      items: ['none'],
      attr: {
        action: 'settings', max_size: 10, retention_size: 20, max_age: 365, max_score: '', exclude_domains: [], release_format: 'raw',
        sender: '', subject: '', bcc: '', redirect: '', html_tmpl: '',
      },
    });
    expect(Object.isFrozen(QUARANTINE_NODE_SETTINGS)).toBe(true);
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: 'access_denied' }]));
    await expect(writeQuarantineSettings(CFG)).rejects.toMatchObject({ code: 'mail_node_refused' });
    safeFetch.mockResolvedValueOnce(answer([{ type: 'danger', msg: ['redis_error', 'x'] }]));
    await expect(writeQuarantineSettings(CFG)).rejects.toMatchObject({ code: 'mail_node_refused' });
  });
});

describe('rspamd history', () => {
  it('reads the rows without sizes, the time as ISO', async () => {
    safeFetch.mockResolvedValueOnce(answer([{
      'message-id': 'abc@sender.test', unix_time: 1759312800, score: 9.5, required_score: 15, action: 'add header', is_skipped: false,
      symbols: { R_SPF_FAIL: { name: 'R_SPF_FAIL', score: 8, options: ['-all'] } }, ip: '198.51.100.7',
      sender_smtp: 'A@Sender.test', sender_mime: 'a@sender.test', rcpt_smtp: ['Info@Example.com'], rcpt_mime: ['info@example.com'],
      subject: 'Hello', size: 1234, time_real: 0.2, thresholds: { 'add header': 8, reject: 15, greylist: 7 }, user: '',
    }]));
    expect(await getRspamdHistory(CFG, 1000)).toEqual([{
      messageId: 'abc@sender.test', time: '2025-10-01T10:00:00.000Z', score: 9.5, requiredScore: 15, spamScore: 8, rejectScore: 15, action: 'add header', skipped: false,
      symbols: [{ name: 'R_SPF_FAIL', score: 8, description: null }], ip: '198.51.100.7',
      senderSmtp: 'a@sender.test', senderMime: 'a@sender.test', rcptSmtp: ['info@example.com'], rcptMime: ['info@example.com'], subject: 'Hello',
    }]);
    expect(calls()[0].url).toBe('https://mail.example.com/api/v1/get/logs/rspamd-history/1000');
    // mailcow answers {} when the history is empty or rspamd did not answer.
    safeFetch.mockResolvedValueOnce(answer({}));
    expect(await getRspamdHistory(CFG, 1000)).toEqual([]);
  });
});
