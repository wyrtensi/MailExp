// Mounts the real ContactsPage and store with the contacts endpoints served by a fetch stub whose
// response order each test controls. Every scenario is a response for an older action (a contact
// click, a sender lookup) arriving after a newer one, which must not replace what is on screen.
import { test, beforeEach, afterEach } from 'node:test';
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

const contact = (id, name, email) => ({
  id, display_name: name, first_name: name, last_name: '', primary_email: email,
  emails: [{ value: email, type: 'work' }], phones: [], urls: [], organization: '', notes: '',
});
const CONTACT_A = contact('contact-a', 'Contact A', 'a@example.com');
const CONTACT_B = contact('contact-b', 'Contact B', 'b@example.com');

// A response the test settles by hand.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Per-test routing. `list(q)` answers GET /api/contacts; `details[id]` answers GET /api/contacts/:id
// and may be a value or a deferred. Errors are thrown as a 500 with that message.
let list;
let details;
const response = (status, body) => ({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body),
});
const answer = async (value) => {
  try {
    return response(200, await (value?.promise ?? value));
  } catch (err) {
    return response(500, { error: err.message });
  }
};
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'https://mail.example.invalid');
  const path = parsed.pathname;
  if (path === '/api/contacts') return answer(list(parsed.searchParams.get('q') || ''));
  if (path.endsWith('/letters')) return response(200, { total: 0, items: [], received: 0, sent: 0 });
  const id = path.match(/^\/api\/contacts\/([^/]+)$/)?.[1];
  if (id && id in details) return answer(details[id]);
  return response(200, {});
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ContactsPage = (await import('./ContactsPage.jsx')).default;

let root;
beforeEach(async () => {
  list = () => ({ contacts: [CONTACT_A, CONTACT_B], total: 2 });
  details = { 'contact-a': CONTACT_A, 'contact-b': CONTACT_B };
  useStore.setState({ user: { id: 'user-1' }, accounts: [], contactsFocus: null, showContacts: true, notifications: [] });
  await React.act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(ContactsPage));
  });
});
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
});

const click = async (el) => {
  assert.ok(el, 'expected a clickable element');
  await React.act(async () => el.click());
};
const clickContact = name => click([...document.querySelectorAll('div')].find(el => el.textContent === name));
const button = label => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === label);
const emailInput = () => document.querySelector('input[type="email"]');
// The open contact's name.
const heading = () => [...document.querySelectorAll('h2')].map(el => el.textContent).find(text => text.startsWith('Contact '));
const startNewAndType = async (value) => {
  await click(button('+ contacts.new'));
  assert.ok(emailInput(), 'the new contact form is open');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(emailInput(), value);
    emailInput().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const assertFormKept = (value) => {
  assert.ok(emailInput(), 'the new contact form must stay open after the obsolete response');
  assert.equal(emailInput().value, value, 'the typed address must be kept');
};

test('a late detail response for a clicked contact does not close a newer unsaved new-contact form', async () => {
  // Clicking a contact and then "New contact" before its details arrive used to let the old
  // response win: it showed contact A, closed the form and discarded what was typed into it.
  details['contact-a'] = deferred();
  await clickContact('Contact A');
  await startNewAndType('new@example.com');
  await React.act(async () => details['contact-a'].resolve(CONTACT_A));
  assertFormKept('new@example.com');
});

test('a late detail response for an older click does not replace a newer click', async () => {
  const slowA = deferred();
  details['contact-a'] = slowA;
  await clickContact('Contact A');
  await clickContact('Contact B');
  assert.equal(heading(), 'Contact B');
  await React.act(async () => slowA.resolve(CONTACT_A));
  assert.equal(heading(), 'Contact B');
});

test('a failed detail request for an older click shows no error on the newer contact', async () => {
  const slowA = deferred();
  details['contact-a'] = slowA;
  await clickContact('Contact A');
  await clickContact('Contact B');
  await React.act(async () => slowA.reject(new Error('stale detail failed')));
  assert.equal(heading(), 'Contact B');
  assert.ok(!document.body.textContent.includes('stale detail failed'), 'the obsolete error must not be shown');
});

test('cancelling a new contact drops a contact click that is still loading', async () => {
  await click(button('+ contacts.new'));
  details['contact-a'] = deferred();
  await clickContact('Contact A');
  await click(button('common.cancel'));
  await React.act(async () => details['contact-a'].resolve(CONTACT_A));
  assert.equal(heading(), undefined, 'the user cancelled; the earlier click must not open contact A');
});

test('a late sender lookup that finds a contact does not close a newer new-contact form', async () => {
  // Opened from a message sender; the lookup resolves after the user started a new contact.
  const slowA = deferred();
  details['contact-a'] = slowA;
  list = q => ({ contacts: q ? [CONTACT_A] : [CONTACT_A, CONTACT_B], total: q ? 1 : 2 });
  await React.act(async () => useStore.getState().openContactFor({ email: 'a@example.com', name: 'Contact A' }));
  await startNewAndType('new@example.com');
  await React.act(async () => slowA.resolve(CONTACT_A));
  assertFormKept('new@example.com');
});

test('a late sender lookup with no contact does not overwrite a newer new-contact form', async () => {
  // No match prefills a new contact from the sender; arriving late it replaced what was typed.
  const slowList = deferred();
  list = q => (q ? slowList : { contacts: [CONTACT_A, CONTACT_B], total: 2 });
  await React.act(async () => useStore.getState().openContactFor({ email: 'sender@example.com', name: 'Sender' }));
  await startNewAndType('new@example.com');
  await React.act(async () => slowList.resolve({ contacts: [], total: 0 }));
  assertFormKept('new@example.com');
});

test('a late sender lookup does not replace a contact clicked after it', async () => {
  // The lookup's list (A and B) arrives at once; the details of the matching contact A do not.
  const slowA = deferred();
  details['contact-a'] = slowA;
  await React.act(async () => useStore.getState().openContactFor({ email: 'a@example.com', name: 'Contact A' }));
  await clickContact('Contact B');
  assert.equal(heading(), 'Contact B');
  await React.act(async () => slowA.resolve(CONTACT_A));
  assert.equal(heading(), 'Contact B');
});
