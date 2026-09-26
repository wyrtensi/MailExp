import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRequest } from '../demo/index.js';
import { createDirectApi } from './api.js';

test('demo direct API helpers resolve locally without calling fetch', async () => {
  let fetchCalls = 0;
  const direct = createDirectApi({
    demoMode: true,
    demoRequestImpl: demoRequest,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('demo helper attempted a network request');
    },
  });

  // A real AI chat call needs a real provider behind it — same as the admin AI test/classify
  // endpoints, this now rejects instead of the old silent-empty-string fallback (part 2 of the
  // demo-settings fix: no write pretends to succeed with nothing behind it either).
  await assert.rejects(() => direct.streamAiChat([{ role: 'user', content: 'Hello' }]), /demo mode/);
  assert.deepEqual(await direct.unlock('1234'), { ok: true });
  assert.deepEqual(await direct.savePreferencesOnExit({ theme: 'dark' }), { ok: true });
  assert.deepEqual(await direct.startMsDeviceFlow(), { disabled: true, configured: false });
  assert.deepEqual(await direct.pollMsDeviceFlow(), { disabled: true, configured: false });
  assert.deepEqual(await direct.deleteMessagesOnExit(['demo-004']), { ok: true, deleted: ['demo-004'] });

  const attachment = await direct.downloadAttachment('demo-001', '1');
  assert.equal(attachment.type, 'text/plain');
  assert.equal(await attachment.text(), 'Demo attachment: renewal order form preview.\n');
  assert.match(direct.attachmentArchiveUrl('demo-001'), /^data:application\/zip;base64,/);
  assert.match(direct.rawEmlUrl('demo-001'), /^data:message\/rfc822;base64,/);
  assert.match(direct.gtdPetSheetUrl('demo-pet'), /^data:image\/gif;base64,/);
  assert.equal(fetchCalls, 0);
});

test('demo shell metadata routes return safe local shapes', async () => {
  assert.deepEqual(await demoRequest('GET', '/update'), { updateAvailable: false });
  assert.deepEqual(await demoRequest('GET', '/version'), { version: '3.3.0-demo', sha: 'demo' });
});

test('production direct API helpers retain their existing network contracts', async () => {
  const calls = [];
  const direct = createDirectApi({
    demoMode: false,
    fetchImpl: async (url, init = {}) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({ ok: true }),
        blob: async () => new Blob(['production attachment'], { type: 'text/plain' }),
      };
    },
  });

  await direct.unlock('1234');
  await direct.savePreferencesOnExit({ theme: 'dark' });
  await direct.startMsDeviceFlow();
  await direct.pollMsDeviceFlow();
  await direct.deleteMessagesOnExit(['one', 'two']);
  await direct.deleteMessagesOnExit(['one']);
  assert.equal((await direct.downloadAttachment('message', '1')).type, 'text/plain');

  assert.deepEqual(calls.map(([url, init]) => [url, init.method || 'GET', Boolean(init.keepalive)]), [
    ['/api/auth/unlock', 'POST', false],
    ['/api/auth/preferences', 'PATCH', true],
    ['/oauth/microsoft/device', 'POST', false],
    ['/oauth/microsoft/device/poll', 'GET', false],
    ['/api/mail/messages/bulk-delete', 'POST', true],
    ['/api/mail/messages/one', 'DELETE', true],
    ['/api/mail/messages/message/attachments/1', 'GET', false],
  ]);
  assert.equal(direct.attachmentArchiveUrl('message'), '/api/mail/messages/message/attachments.zip');
  assert.equal(direct.rawEmlUrl('message'), '/api/mail/messages/message/raw.eml');
  assert.equal(direct.gtdPetSheetUrl('pet slug'), '/api/gtd/pet/pet%20slug/sheet');
});

test('a busy mailbox keeps its code on a failed attachment download', async () => {
  const failing = (status, body) => createDirectApi({
    demoMode: false,
    fetchImpl: async () => ({ ok: false, status, json: async () => body }),
  });
  await assert.rejects(failing(503, { error: 'busy', code: 'mailbox_busy' }).downloadAttachment('message', '1'), { code: 'mailbox_busy' });
  const other = await failing(500, { error: 'Failed to fetch attachment' }).downloadAttachment('message', '1').catch(e => e);
  assert.equal(other.message, 'Download failed');
  assert.equal(other.code, undefined);
});
