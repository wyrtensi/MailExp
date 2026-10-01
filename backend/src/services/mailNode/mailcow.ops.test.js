// The mailcow API calls of the node operations (mail queue, Postfix log, containers), with the
// answer shapes of mailcow 2026-09 (json_api.php, functions.mailq.inc.php, dockerapi).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn() }));

import { safeFetch } from '../safeFetch.js';
import {
  MAX_POSTCAT_BYTES, MailNodeError, deleteQueued, flushQueue, getContainers, getPostfixLog, getQueuedMessageText, listAliasDomains,
  listQueue, parseQueueId, queueAction,
} from './mailcow.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'api-key-1', quotaMb: 5120 };
const answer = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => body });
const sent = (call = 0) => ({ url: safeFetch.mock.calls[call][0], method: safeFetch.mock.calls[call][1].method, body: JSON.parse(safeFetch.mock.calls[call][1].body ?? 'null') });
const SUCCESS = [{ type: 'success', log: ['mailq', 'edit', {}], msg: 'queue_command_success' }];

beforeEach(() => safeFetch.mockReset());

describe('parseQueueId', () => {
  it('takes the hex ids mailcow passes on, in upper case', () => {
    expect(parseQueueId('53a99193f13')).toBe('53A99193F13');
    for (const bad of ['', 'ALL', '53A9-9193', '4Xyz9kHZz2xGx', '1234', null]) expect(parseQueueId(bad)).toBeNull();
  });
});

describe('listQueue', () => {
  it('reads postqueue -j as mailcow rewrites it', async () => {
    safeFetch.mockResolvedValue(answer([
      {
        queue_name: 'deferred', queue_id: '53A99193F13', arrival_time: 1790881379, message_size: 360, forced_expire: false,
        sender: 'Someone@stage.test',
        recipients: ['test@example.com (host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. (S77) (in reply to RCPT TO command))', 'other@example.com'],
      },
      { queue_name: 'hold', queue_id: '1A2B3C4D5E', arrival_time: 1790881000, message_size: 4436, sender: '', recipients: [{ address: 'x@example.com' }] },
      { queue_name: 'active', queue_id: 'not hex', recipients: [] },
    ]));
    const items = await listQueue(CFG);
    expect(sent().url).toBe('https://mail.example.com/api/v1/get/mailq/all');
    expect(items).toEqual([
      {
        queueId: '53A99193F13', queue: 'deferred', arrivedAt: '2026-10-01T19:02:59.000Z', size: 360, forcedExpire: false, sender: 'someone@stage.test',
        recipients: [
          { address: 'test@example.com', reason: 'host eop.test.local[172.22.1.13] said: 451 4.7.500 Server busy. (S77) (in reply to RCPT TO command)' },
          { address: 'other@example.com', reason: null },
        ],
      },
      { queueId: '1A2B3C4D5E', queue: 'hold', arrivedAt: '2026-10-01T18:56:40.000Z', size: 4436, forcedExpire: false, sender: '', recipients: [{ address: 'x@example.com', reason: null }] },
    ]);
  });

  it('is empty for an empty queue', async () => {
    safeFetch.mockResolvedValue(answer([]));
    expect(await listQueue(CFG)).toEqual([]);
  });
});

describe('queue actions', () => {
  it('reads one message as text', async () => {
    safeFetch.mockResolvedValue(answer('*** ENVELOPE RECORDS deferred/5/53A99193F13 ***\n'));
    expect(await getQueuedMessageText(CFG, '53A99193F13')).toEqual({ text: '*** ENVELOPE RECORDS deferred/5/53A99193F13 ***\n', truncated: false });
    expect(sent().url).toBe('https://mail.example.com/api/v1/get/postcat/53A99193F13');
  });

  it('stops reading a dump at 2 MB and says so', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(0x61);
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 20) controller.close();
        else controller.enqueue(chunk);
      },
    });
    safeFetch.mockResolvedValue({ status: 200, ok: true, body, json: async () => { throw new Error('not json'); } });
    const dump = await getQueuedMessageText(CFG, '53A99193F13');
    expect(dump.truncated).toBe(true);
    expect(dump.text).toHaveLength(MAX_POSTCAT_BYTES);
    expect(pulled).toBeLessThan(10);
  });

  it('holds, releases and delivers by id, flushes all, deletes by id', async () => {
    safeFetch.mockResolvedValue(answer(SUCCESS));
    await queueAction(CFG, ['53A99193F13'], 'hold');
    await queueAction(CFG, ['53A99193F13'], 'deliver');
    await flushQueue(CFG);
    await deleteQueued(CFG, ['53A99193F13']);
    expect([0, 1, 2, 3].map((i) => [sent(i).url.split('/api/v1/')[1], sent(i).body])).toEqual([
      ['edit/mailq', { items: ['53A99193F13'], attr: { action: 'hold' } }],
      ['edit/mailq', { items: ['53A99193F13'], attr: { action: 'deliver' } }],
      ['edit/mailq', { items: [], attr: { action: 'flush' } }],
      ['delete/mailq', ['53A99193F13']],
    ]);
  });

  it('never sends an action outside hold, unhold and deliver', async () => {
    await expect(queueAction(CFG, ['53A99193F13'], 'super_delete')).rejects.toMatchObject({ code: 'queue_action_invalid' });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('turns a refusal of postsuper into an error', async () => {
    safeFetch.mockResolvedValue(answer([{ type: 'danger', msg: 'Error: command failed: postsuper: fatal' }]));
    await expect(deleteQueued(CFG, ['53A99193F13'])).rejects.toBeInstanceOf(MailNodeError);
  });
});

describe('getPostfixLog', () => {
  it('asks for an explicit number of lines', async () => {
    safeFetch.mockResolvedValue(answer([{ time: '1790881379', program: 'postfix/qmgr', priority: 'info', message: '53A99193F13: removed' }]));
    expect(await getPostfixLog(CFG, 2000)).toHaveLength(1);
    expect(sent().url).toBe('https://mail.example.com/api/v1/get/logs/postfix/2000');
  });

  it('is a failure, not a quiet node, when mailcow answers {}, an empty list or no list', async () => {
    for (const body of [{}, [], 'nothing', null]) {
      safeFetch.mockResolvedValue(answer(body));
      await expect(getPostfixLog(CFG, 10), JSON.stringify(body)).rejects.toMatchObject({ code: 'mail_node_failed' });
    }
  });
});

describe('listAliasDomains', () => {
  it('reads the alias domains in lower case', async () => {
    safeFetch.mockResolvedValue(answer([{ alias_domain: 'Stage-Alias.test', target_domain: 'stage.test', active: 1 }]));
    expect(await listAliasDomains(CFG)).toEqual(['stage-alias.test']);
    expect(sent().url).toBe('https://mail.example.com/api/v1/get/alias-domain/all');
    safeFetch.mockResolvedValue(answer({}));
    expect(await listAliasDomains(CFG)).toEqual([]);
  });
});

describe('getContainers', () => {
  it('reads the object keyed by container name', async () => {
    safeFetch.mockResolvedValue(answer({
      'postfix-mailcow': { type: 'info', container: 'postfix-mailcow', state: 'running', started_at: '2026-10-01T05:00:00Z', image: 'ghcr.io/mailcow/postfix:3.10.12-1' },
      'acme-mailcow': { type: 'info', container: 'acme-mailcow', state: 'Exited', started_at: '2026-10-01T05:00:00Z', image: 'ghcr.io/mailcow/acme:1.98' },
    }));
    expect(await getContainers(CFG)).toEqual([
      { name: 'acme-mailcow', state: 'exited', health: null, startedAt: '2026-10-01T05:00:00Z', image: 'ghcr.io/mailcow/acme:1.98' },
      { name: 'postfix-mailcow', state: 'running', health: null, startedAt: '2026-10-01T05:00:00Z', image: 'ghcr.io/mailcow/postfix:3.10.12-1' },
    ]);
  });

  it('reads the health when the answer carries it', async () => {
    safeFetch.mockResolvedValue(answer({
      'dovecot-mailcow': { container: 'dovecot-mailcow', state: 'running', health: 'Unhealthy' },
      'rspamd-mailcow': { container: 'rspamd-mailcow', state: 'running', State: { Health: { Status: 'healthy' } } },
    }));
    expect((await getContainers(CFG)).map((c) => [c.name, c.health])).toEqual([['dovecot-mailcow', 'unhealthy'], ['rspamd-mailcow', 'healthy']]);
  });

  it('refuses an answer that is no such object', async () => {
    safeFetch.mockResolvedValue(answer([]));
    await expect(getContainers(CFG)).rejects.toMatchObject({ code: 'mail_node_failed' });
  });
});
