// Render tests for the pending deletion of a mail node mailbox where it shows: the settings list's
// notice (date, who asked, when, why, the job's last error, "Cancel deletion") and the one-line
// badge the sidebar shows. The pure rules are covered by utils/mailNode.test.js.
//
// The harness mirrors ConfirmOverlay.render.test.js: the loader hook transforms .jsx with sucrase,
// and react-i18next is stubbed to return the key followed by its values, so they can be checked.

import { test, describe } from 'node:test';
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
          'export const useTranslation = () => ({ t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
          'export const initReactI18next = { type: "3rdParty", init: () => {} };',
          'export default { useTranslation, initReactI18next };',
        ].join('\n'),
      };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MailboxDeletionNotice, PendingDeletionLine } = await import('./MailboxDeletionNotice.jsx');

async function mount(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => { createRoot(host).render(element); });
  return host;
}

const PENDING = {
  id: 'a1', email_address: 'info@example.com', mail_node: true,
  delete_after: '2026-10-06T10:00:00.000Z', deletion_requested_at: '2026-10-01T10:00:00.000Z',
  deletion_requested_by_email: 'anna@example.com', deletion_reason: '<b>Closed</b> & moved', deletion_last_error: null,
};

describe('MailboxDeletionNotice', () => {
  test('shows the date, who asked and why, as text, and cancels on click', async () => {
    const cancelled = [];
    const host = await mount(React.createElement(MailboxDeletionNotice, { account: PENDING, onCancel: (id) => cancelled.push(id) }));
    const notice = host.querySelector('[data-pending-deletion="a1"]');
    assert.ok(notice.textContent.includes('admin.accounts.deletion.pendingBadge'));
    const reason = notice.querySelector('[data-deletion-reason]');
    assert.ok(reason.textContent.includes('<b>Closed</b> & moved'), 'the reason shows as the requester wrote it');
    assert.equal(reason.querySelector('b'), null, 'and is never markup');
    assert.ok(reason.textContent.includes('anna@example.com'));
    assert.equal(notice.querySelector('[data-deletion-error]'), null);
    const button = [...notice.querySelectorAll('button')].find((b) => b.textContent === 'admin.accounts.deletion.cancel');
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(cancelled, ['a1']);
  });

  test('says why the deletion job could not delete it yet', async () => {
    const host = await mount(React.createElement(MailboxDeletionNotice, { account: { ...PENDING, deletion_last_error: 'mail_node_host_mismatch' } }));
    assert.ok(host.querySelector('[data-deletion-error]').textContent.includes('mail_node_host_mismatch'));
  });

  test('shows nothing for a mailbox with no deletion pending', async () => {
    const host = await mount(React.createElement(MailboxDeletionNotice, { account: { ...PENDING, delete_after: null } }));
    assert.equal(host.textContent, '');
    const line = await mount(React.createElement(PendingDeletionLine, { account: { ...PENDING, delete_after: null } }));
    assert.equal(line.textContent, '');
  });
});

describe('PendingDeletionLine', () => {
  test('tells where the mailbox is worked with that it goes on its date', async () => {
    const host = await mount(React.createElement(PendingDeletionLine, { account: PENDING }));
    const line = host.querySelector('[data-pending-deletion-line]');
    assert.ok(line.textContent.startsWith('sidebar.pendingDeletion'));
    assert.ok(line.textContent.includes('2026'));
  });
});
