// Mounts the real ContactsPage and store with the contacts endpoints served by a fetch stub whose
// response order the test controls.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (key) => key; export const useTranslation = () => ({ t, i18n: { language: "en" } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const env = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: env(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const source = readFileSync(new URL(url), 'utf8');
      if (source.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: env(source) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const CONTACT = {
  id: 'contact-a', display_name: 'Contact A', first_name: 'Contact', last_name: 'A',
  primary_email: 'a@example.com', emails: [{ value: 'a@example.com', type: 'work' }],
  phones: [], urls: [], organization: '', notes: '',
};
let releaseDetail;
const response = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url) => {
  const path = new URL(String(url), 'https://mail.example.invalid').pathname;
  if (path === '/api/contacts') return response({ contacts: [CONTACT], total: 1 });
  if (path === '/api/contacts/contact-a') {
    await new Promise(resolve => { releaseDetail = resolve; });
    return response(CONTACT);
  }
  if (path.endsWith('/letters')) return response({ total: 0, items: [], received: 0, sent: 0 });
  return response({});
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ContactsPage = (await import('./ContactsPage.jsx')).default;

let root;
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
});

const click = async (el) => {
  assert.ok(el, 'expected a clickable element');
  await React.act(async () => el.click());
};
const emailInput = () => document.querySelector('input[type="email"]');

test('a late detail response for a clicked contact does not close a newer unsaved new-contact form', async () => {
  // Clicking a contact and then "New contact" before its details arrive used to let the old
  // response win: it showed contact A, closed the form and discarded what was typed into it.
  useStore.setState({ user: { id: 'user-1' }, accounts: [], contactsFocus: null, showContacts: true, notifications: [] });
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(ContactsPage));
  });

  await click([...document.querySelectorAll('div')].find(el => el.textContent === 'Contact A'));
  assert.ok(releaseDetail, 'the detail request for contact A is pending');

  await click([...document.querySelectorAll('button')].find(el => el.textContent.trim() === '+ contacts.new'));
  assert.ok(emailInput(), 'the new contact form is open');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(emailInput(), 'new@example.com');
    emailInput().dispatchEvent(new window.Event('input', { bubbles: true }));
  });

  await React.act(async () => releaseDetail());

  assert.ok(emailInput(), 'the new contact form must stay open after the obsolete response');
  assert.equal(emailInput().value, 'new@example.com', 'the typed address must be kept');
});
