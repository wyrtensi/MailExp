// Render tests for the delivery details of a sent letter and the list's mark (R-17): nothing loads
// until the reader opens the block, an accepted letter shows relay, TLS and EOP's acceptance, a
// refused one its code explained, a letter the node's log no longer covers says so (never
// "delivered"), and a delivery report's mark. The pure rules are covered by utils/delivery.test.js.
//
// The harness is the one of MailNodeQuarantine.render.test.js: sucrase for .jsx, react-i18next
// stubbed to return the raw key.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return {
        format: 'module', shortCircuit: true, source: [
          'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
          'export const initReactI18next = { type: "3rdParty", init: () => {} };',
          'export const Trans = ({ children }) => children ?? null;',
          'export const I18nextProvider = ({ children }) => children ?? null;',
          'export default { useTranslation, initReactI18next };',
        ].join('\n'),
      };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, DOMParser: dom.window.DOMParser,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const DeliveryDetails = (await import('./DeliveryDetails.jsx')).default;
const DeliveryMarker = (await import('./DeliveryMarker.jsx')).default;

const TLS = { level: 'untrusted', protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', bits: '256/256 bits', matchedBy: 'time' };
const LOG = {
  queueId: '0C3BF1A4B81', relayHost: 'eop.test.local', relayIp: '172.22.1.7', relayPort: 25, relayKind: 'eop', tls: TLS,
};
const ACCEPTED = {
  messageId: '<a@stage.test>', node: true, log: { coverage: 'found', error: null, oldestAt: '2026-10-02T09:00:00.000Z' },
  recipients: [{
    recipient: 'test@example.com', state: 'sent', source: 'log', at: '2026-10-02T09:35:38.000Z', statusCode: '2.6.0', diagnostic: null, explanation: null,
    log: { ...LOG, state: 'sent', reply: '250 2.6.0 ...', acceptance: { messageId: '<a@stage.test>', internalId: '1099511627777', hostname: 'EOPSTAGE01MB0001.stageprd01.prod.eop.test.local' } },
    report: null,
  }],
};
const REFUSED = {
  messageId: '<d@stage.test>', node: true, log: { coverage: 'found', error: null },
  recipients: [{
    recipient: 'test@example.com', state: 'bounced', source: 'log', at: '2026-10-02T09:29:18.000Z', statusCode: '5.4.1',
    diagnostic: '550 5.4.1 Recipient address rejected', explanation: { key: 'recipient_not_accepted', class: 'permanent', code: '5.4.1' },
    log: { ...LOG, state: 'bounced', reply: '550 5.4.1 Recipient address rejected', acceptance: null, tls: null }, report: null,
  }],
};

let calls;
let answers;
beforeEach(() => {
  calls = [];
  answers = {};
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    calls.push({ method, path });
    const value = answers[`${method} ${path}`];
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value ?? {} };
  };
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function mount(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => { createRoot(host).render(element); });
  await flush();
  return host;
}
async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}
const toggle = (host) => host.querySelector('[data-delivery-details] button[aria-expanded]');

describe('DeliveryDetails', () => {
  test('asks nothing until opened, then shows relay, TLS and EOP\'s acceptance', async () => {
    answers['GET /api/mail/messages/m-1/delivery'] = ACCEPTED;
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-1' }));
    assert.equal(calls.length, 0);
    assert.equal(toggle(host).getAttribute('aria-expanded'), 'false');
    // The panel exists only while open, so aria-controls names it only then.
    assert.equal(toggle(host).getAttribute('aria-controls'), null);
    await click(toggle(host));
    assert.deepEqual(calls.map((c) => c.path), ['/api/mail/messages/m-1/delivery']);
    assert.equal(toggle(host).getAttribute('aria-expanded'), 'true');
    assert.ok(dom.window.document.getElementById(toggle(host).getAttribute('aria-controls')));
    const row = host.querySelector('[data-delivery-recipient="test@example.com"]');
    assert.ok(row.textContent.includes('message.delivery.state.sentEop'));
    assert.equal(row.querySelector('[data-delivery-relay]').textContent, 'eop.test.local [172.22.1.7]:25');
    assert.equal(row.querySelector('[data-delivery-tls]').getAttribute('data-delivery-tls'), 'untrusted');
    assert.ok(row.querySelector('[data-delivery-tls]').textContent.includes('message.delivery.tlsByTime'));
    assert.ok(row.querySelector('[data-delivery-acceptance]').textContent.includes('InternalId=1099511627777'));
    assert.equal(row.querySelector('[data-delivery-explanation]'), null);
    // Closing and opening again does not ask twice.
    await click(toggle(host));
    await click(toggle(host));
    assert.equal(calls.length, 1);
  });

  test('R-30: asks Microsoft\'s trace on request and shows each recipient with EOP\'s words', async () => {
    answers['GET /api/mail/messages/m-9/delivery'] = { ...ACCEPTED, eopTrace: { available: true, reason: null, trace: null } };
    answers['POST /api/mail/messages/m-9/eop-trace'] = { queued: true, trace: { state: 'queued', recipients: [] } };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-9' }));
    await click(toggle(host));
    assert.equal(host.querySelector('[data-eop-trace]').getAttribute('data-eop-trace'), 'none');
    // The answer after the job: one delivered, one refused by the remote server.
    answers['GET /api/mail/messages/m-9/delivery'] = {
      ...ACCEPTED,
      eopTrace: {
        available: true, reason: null,
        trace: {
          state: 'done', checkedAt: '2026-10-02T09:40:00.000Z', error: null,
          recipients: [
            { recipient: 'test@example.com', status: 'delivered', receivedAt: '2026-10-02T09:35:40.000Z', deliveredAt: '2026-10-02T09:35:42.000Z', statusCode: null, detail: null },
            { recipient: 'gone@example.net', status: 'failed', receivedAt: '2026-10-02T09:35:40.000Z', statusCode: '5.1.1', detail: '550 5.1.1 RESOLVER.ADR.RecipNotFound' },
          ],
        },
      },
    };
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'message.delivery.eop.ask'));
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail/messages/m-9/eop-trace'));
    assert.equal(host.querySelector('[data-eop-trace]').getAttribute('data-eop-trace'), 'done');
    const failed = host.querySelector('[data-eop-recipient="gone@example.net"]');
    assert.ok(failed.textContent.includes('message.delivery.eop.status.failed (5.1.1)'));
    assert.equal(failed.querySelector('[data-delivery-remote-words]').textContent, '550 5.1.1 RESOLVER.ADR.RecipNotFound');
    assert.ok(host.querySelector('[data-eop-recipient="test@example.com"]').textContent.includes('message.delivery.eop.status.delivered'));
    assert.ok([...host.querySelectorAll('button')].some((b) => b.textContent === 'message.delivery.eop.askAgain'));
  });

  test('R-30: says nothing without a connected trace, and why an old letter cannot be asked', async () => {
    answers['GET /api/mail/messages/m-10/delivery'] = { ...ACCEPTED, eopTrace: { available: false, reason: 'trace_not_connected', trace: null } };
    let host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-10' }));
    await click(toggle(host));
    assert.equal(host.querySelector('[data-eop-trace]'), null);
    answers['GET /api/mail/messages/m-11/delivery'] = { ...ACCEPTED, eopTrace: { available: false, reason: 'trace_too_old', trace: null } };
    host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-11' }));
    await click(toggle(host));
    assert.equal(host.querySelector('[data-eop-trace-unavailable]').textContent, 'message.delivery.eop.tooOld');
    assert.ok(![...host.querySelectorAll('button')].some((b) => b.textContent === 'message.delivery.eop.ask'));
  });

  test('says a refused recipient in words with the code explained, and TLS not in the log', async () => {
    answers['GET /api/mail/messages/m-2/delivery'] = REFUSED;
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-2', deliveryState: 'failed' }));
    assert.equal(host.querySelector('[data-delivery-summary]').textContent, 'message.delivery.summary.failed');
    await click(toggle(host));
    const row = host.querySelector('[data-delivery-recipient="test@example.com"]');
    assert.ok(row.textContent.includes('message.delivery.state.bounced (5.4.1)'));
    assert.equal(row.querySelector('[data-delivery-explanation]').getAttribute('data-delivery-explanation'), 'recipient_not_accepted');
    assert.ok(row.textContent.includes('message.delivery.code.recipient_not_accepted'));
    assert.equal(row.querySelector('[data-delivery-tls]').getAttribute('data-delivery-tls'), 'missing');
  });

  test('never shows a letter the log no longer covers as delivered', async () => {
    answers['GET /api/mail/messages/m-3/delivery'] = { messageId: '<o@x>', node: true, log: { coverage: 'gone', error: null }, recipients: [] };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-3' }));
    await click(toggle(host));
    assert.equal(host.querySelector('[data-delivery-coverage]').textContent, 'message.delivery.coverage.gone');
    assert.equal(host.querySelectorAll('[data-delivery-recipient]').length, 0);
    assert.ok(!host.textContent.includes('message.delivery.state.sent'));
  });

  test('shows a delivery report\'s mark for a mailbox off the node, and says when there is none', async () => {
    answers['GET /api/mail/messages/m-4/delivery'] = {
      messageId: '<r@x>', node: false, log: null,
      recipients: [{
        recipient: 'boss@partner.example', state: 'failed', source: 'dsn', at: '2026-10-02T10:00:05.000Z', statusCode: '5.7.64', diagnostic: 'smtp; 550 5.7.64',
        explanation: { key: 'tenant_attribution', class: 'permanent', code: '5.7.64' }, log: null,
        report: { state: 'failed', at: '2026-10-02T10:00:05.000Z', statusCode: '5.7.64', diagnostic: '550 5.7.64 TenantAttribution', remoteMta: 'eop.example', action: 'failed' },
      }],
    };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-4' }));
    await click(toggle(host));
    const report = host.querySelector('[data-delivery-report]');
    assert.ok(report.textContent.startsWith('message.delivery.report'));
    // The remote server's words: quoted plain text, never a link.
    const words = report.querySelector('q[data-delivery-remote-words]');
    assert.equal(words.textContent, '550 5.7.64 TenantAttribution');
    assert.equal(report.querySelector('a'), null);
    assert.equal(host.querySelector('[data-delivery-coverage]'), null);

    answers['GET /api/mail/messages/m-5/delivery'] = { messageId: '<n@x>', node: false, log: null, recipients: [] };
    const empty = await mount(React.createElement(DeliveryDetails, { messageId: 'm-5' }));
    await click(toggle(empty));
    assert.equal(empty.querySelector('[data-delivery-note]').getAttribute('data-delivery-note'), 'none');
  });

  // The mailbox's own outgoing server refused one recipient at RCPT and took the letter for the
  // rest (backend services/sendDelivery.js, source 'submission').
  test('says a recipient refused at sending as such, with the outgoing server words', async () => {
    answers['GET /api/mail/messages/m-8/delivery'] = {
      messageId: '<s@x>', node: false, log: null,
      recipients: [{
        recipient: 'gone@partner.example', state: 'failed', source: 'submission', at: '2026-10-02T10:00:05.000Z', statusCode: '5.1.1',
        diagnostic: '550 5.1.1 User unknown', explanation: { key: 'permanent', class: 'permanent', code: '5.1.1' }, log: null, report: null,
        submission: { state: 'failed', at: '2026-10-02T10:00:05.000Z', statusCode: '5.1.1', diagnostic: '550 5.1.1 User unknown', reply: '550 5.1.1 User unknown', responseCode: 550 },
      }],
    };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-8', deliveryState: 'failed' }));
    await click(toggle(host));
    const row = host.querySelector('[data-delivery-recipient="gone@partner.example"]');
    assert.ok(row.textContent.includes('message.delivery.state.refusedAtSubmission (5.1.1)'));
    assert.ok(row.textContent.includes('message.delivery.code.permanent'));
    const words = row.querySelector('[data-delivery-submission] q[data-delivery-remote-words]');
    assert.equal(words.textContent, '550 5.1.1 User unknown');
    assert.ok(row.querySelector('[data-delivery-submission]').textContent.startsWith('message.delivery.submissionReply'));
    assert.equal(row.querySelector('[data-delivery-report]'), null);
  });

  test('says a letter the mailbox did not send has no details', async () => {
    answers['GET /api/mail/messages/m-7/delivery'] = { messageId: '<in@x>', owned: false, node: false, log: null, recipients: [] };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-7' }));
    await click(toggle(host));
    assert.equal(host.querySelector('[data-delivery-note]').getAttribute('data-delivery-note'), 'not-sent');
  });

  test('says an unknown outcome in words with a neutral tone, never as delivered', async () => {
    answers['GET /api/mail/messages/m-8/delivery'] = {
      messageId: '<u@x>', owned: true, node: true, log: { coverage: 'stored', error: null },
      recipients: [
        { recipient: 'a@example.org', state: 'unknown', stale: null, source: 'log', at: '2026-10-02T09:00:00.000Z', statusCode: '4.7.500', diagnostic: '451 busy', explanation: null, log: { ...LOG, state: 'unknown', reply: '451 busy', leftQueue: true, tls: null }, report: null },
        { recipient: 'b@example.org', state: 'unknown', stale: 'deferred', source: 'log', at: '2026-09-20T09:00:00.000Z', statusCode: '4.7.500', diagnostic: '451 busy', explanation: null, log: { ...LOG, state: 'deferred', reply: '451 busy', tls: null }, report: null },
        { recipient: 'c@example.org', state: 'sent', source: 'log', at: '2026-10-02T09:00:00.000Z', statusCode: '2.0.0', diagnostic: null, explanation: null, log: { relayHost: 'none', relayKind: 'discard', state: 'sent' }, report: null },
      ],
    };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-8' }));
    await click(toggle(host));
    const row = (address) => host.querySelector(`[data-delivery-recipient="${address}"]`);
    assert.ok(row('a@example.org').textContent.includes('message.delivery.state.leftQueue'));
    assert.equal(row('a@example.org').querySelector('[data-delivery-tone]').getAttribute('data-delivery-tone'), 'neutral');
    assert.ok(row('b@example.org').textContent.includes('message.delivery.state.stale'));
    assert.ok(row('c@example.org').textContent.includes('message.delivery.state.sentDiscard'));
    assert.equal(row('c@example.org').querySelector('[data-delivery-tone]').getAttribute('data-delivery-tone'), 'failed');
    assert.equal(row('c@example.org').querySelector('[data-delivery-tls]'), null);
    // The node's reply is quoted too.
    assert.equal(row('a@example.org').querySelector('q[data-delivery-remote-words]').textContent, '451 busy');
  });

  test('says when the details could not be read, with a retry', async () => {
    answers['GET /api/mail/messages/m-6/delivery'] = { status: 404, body: { error: 'Message not found', code: 'message_not_found' } };
    const host = await mount(React.createElement(DeliveryDetails, { messageId: 'm-6' }));
    await click(toggle(host));
    assert.ok(host.querySelector('[role="alert"]').textContent.includes('message.delivery.failed'));
    answers['GET /api/mail/messages/m-6/delivery'] = REFUSED;
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'message.delivery.retry'));
    assert.ok(host.querySelector('[data-delivery-recipient]'));
  });
});

describe('DeliveryMarker', () => {
  test('marks not delivered and delayed in words, the icon alone keeping its label', async () => {
    const failed = await mount(React.createElement(DeliveryMarker, { state: 'failed' }));
    const mark = failed.querySelector('[data-delivery-marker="failed"]');
    assert.equal(mark.getAttribute('aria-label'), 'message.delivery.marker.failed');
    assert.ok(mark.textContent.includes('message.delivery.marker.failed'));
    const compact = await mount(React.createElement(DeliveryMarker, { state: 'delayed', compact: true }));
    const small = compact.querySelector('[data-delivery-marker="delayed"]');
    assert.equal(small.textContent, '');
    assert.equal(small.getAttribute('title'), 'message.delivery.marker.delayed');
    const none = await mount(React.createElement(DeliveryMarker, { state: null }));
    assert.equal(none.innerHTML, '');
  });
});
