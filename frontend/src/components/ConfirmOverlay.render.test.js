// Render tests for the shared confirm overlay: an ordinary confirmation, and the one that asks for
// a mail node mailbox's address typed out in full before it deletes the mailbox with its mail
// (owner decision D-14, like deleting a repository on GitHub). The pure match rule is covered by
// utils/mailNode.test.js (deleteConfirmationMatches); this mounts the real component.
//
// The harness mirrors MailNodeOnboarding.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the raw key.

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
          'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
const ConfirmOverlay = (await import('./ConfirmOverlay.jsx')).default;

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(dialog) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const closed = { count: 0 };
  await React.act(async () => {
    createRoot(host).render(React.createElement(ConfirmOverlay, { dialog, onClose: () => { closed.count += 1; } }));
  });
  await flush();
  return { host, closed };
}

async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

describe('ConfirmOverlay', () => {
  test('an ordinary confirmation has no field and confirms at once', async () => {
    let confirmed = 0;
    const { host, closed } = await mount({ title: 'Remove?', message: 'Gone for every user.', confirmLabel: 'Remove', onConfirm: async () => { confirmed += 1; } });
    assert.equal(host.querySelector('[data-confirm-typed]'), null);
    const dialog = host.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dom.window.document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Remove?');
    const button = host.querySelector('[data-confirm-button]');
    assert.equal(button.disabled, false);
    await click(button);
    assert.equal(confirmed, 1);
    assert.equal(closed.count, 1);
  });

  test('a mail node mailbox is deleted only once its full address is typed, in any case', async () => {
    let confirmed = 0;
    const { host, closed } = await mount({
      title: 'Remove?', message: 'The mailbox and all its mail are deleted.', confirmLabel: 'Delete mailbox and mail',
      requireTyped: 'info@example.com', typedLabel: 'Type info@example.com to confirm.',
      onConfirm: async () => { confirmed += 1; },
    });
    assert.ok(host.textContent.includes('Type info@example.com to confirm.'));
    const input = host.querySelector('[data-confirm-typed]');
    assert.equal(dom.window.document.activeElement, input, 'the address field takes the focus');
    const button = host.querySelector('[data-confirm-button]');
    assert.equal(button.disabled, true, 'disabled before anything is typed');
    await click(button);
    assert.equal(confirmed, 0);
    for (const partial of ['info', 'info@example', 'info@example.co', 'other@example.com']) {
      await type(input, partial);
      assert.equal(host.querySelector('[data-confirm-button]').disabled, true, partial);
    }
    await type(input, '  INFO@Example.com ');
    assert.equal(host.querySelector('[data-confirm-button]').disabled, false);
    await click(host.querySelector('[data-confirm-button]'));
    assert.equal(confirmed, 1);
    assert.equal(closed.count, 1);
  });

  test('a node mailbox deletion waits for the address and a reason, and hands the reason over trimmed', async () => {
    const got = [];
    const { host } = await mount({
      title: 'Remove?', message: 'Keeps working until Oct 6, 2026.', requireTyped: 'info@example.com', typedLabel: 'Type it.',
      requireReason: true, reasonLabel: 'Why?', confirmLabel: 'Schedule deletion',
      onConfirm: async (args) => { got.push(args); },
    });
    assert.ok(host.textContent.includes('Why?'));
    const reason = host.querySelector('[data-confirm-reason]');
    assert.equal(reason.getAttribute('maxlength'), '500');
    await type(host.querySelector('[data-confirm-typed]'), 'info@example.com');
    assert.equal(host.querySelector('[data-confirm-button]').disabled, true, 'no reason yet');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    const typeReason = async (value) => React.act(async () => {
      setter.call(reason, value);
      reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await typeReason('   ');
    assert.equal(host.querySelector('[data-confirm-button]').disabled, true, 'blank is no reason');
    await typeReason('  Left the company  ');
    assert.equal(host.querySelector('[data-confirm-button]').disabled, false);
    await type(host.querySelector('[data-confirm-typed]'), 'info@example');
    assert.equal(host.querySelector('[data-confirm-button]').disabled, true, 'and the address must still match');
    await type(host.querySelector('[data-confirm-typed]'), 'info@example.com');
    await click(host.querySelector('[data-confirm-button]'));
    assert.deepEqual(got, [{ reason: 'Left the company' }]);
  });

  test('shows the note about the aliases, and Escape closes the dialog', async () => {
    const { host, closed } = await mount({
      title: 'Remove?', message: 'm', note: 'Aliases deleted with it: orders@example.com.', requireTyped: 'info@example.com', typedLabel: 'l',
      onConfirm: async () => {},
    });
    assert.equal(host.querySelector('[data-confirm-note]').textContent, 'Aliases deleted with it: orders@example.com.');
    await React.act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(closed.count, 1);
  });

  test('keeps the dialog open with the error when the delete fails', async () => {
    const { host, closed } = await mount({
      title: 'Remove?', message: 'm', requireTyped: 'info@example.com', typedLabel: 'l',
      onConfirm: async () => { throw new Error('The mail node is unreachable'); },
    });
    await type(host.querySelector('[data-confirm-typed]'), 'info@example.com');
    await click(host.querySelector('[data-confirm-button]'));
    assert.equal(closed.count, 0);
    assert.ok(host.textContent.includes('common.error'));
  });
});
