// The mail node domain onboarding and the EOP settings in demo mode: every settings screen has
// demo data. With VITE_DEMO_MODE the api client answers from demo/index.js instead of the network,
// so this mounts the real sections with no fetch at all and checks they show the demo domains in
// each onboarding state and that "Done" moves one on in the demo's memory.
//
// Same harness as MailNodeOnboarding.render.test.js.

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
  localStorage: dom.window.localStorage,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// Demo mode is decided when demo/mode.js loads: set before any component is imported.
globalThis.__VITE_ENV__ = { MODE: 'demo', DEV: false, PROD: true, VITE_DEMO_MODE: 'true' };

globalThis.fetch = async (url) => { throw new Error(`demo mode must not fetch ${url}`); };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const MailNodeSection = (await import('./MailNodeSection.jsx')).default;
const EopSection = (await import('./EopSection.jsx')).default;
const { demoRequest } = await import('../demo/index.js');

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

const buttons = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('mail node onboarding in demo mode', () => {
  test('the mail node section shows the demo domains in every kind of state', async () => {
    const host = await mount(React.createElement(MailNodeSection));
    const states = new Map([...host.querySelectorAll('tr')]
      .map((tr) => [tr.querySelector('td')?.textContent, tr.querySelector('[data-domain-state]')?.getAttribute('data-domain-state')])
      .filter(([domain, state]) => domain && state));
    assert.equal(states.get('demo.mailexpert.local'), 'ready');
    assert.equal(states.get('pilot.demo.mailexpert.local'), 'dns_ok');
    assert.equal(states.get('legacy.demo.mailexpert.local'), 'unknown');
    // A ready domain whose node creation time differs keeps its state and only warns.
    assert.equal(states.get('branch.demo.mailexpert.local'), 'ready');
    assert.equal(host.querySelectorAll('[data-recreated-badge]').length, 1);
  });

  test('the EOP section shows the demo settings and its checklist, and Done moves a domain on', async () => {
    const host = await mount(React.createElement(EopSection));
    const values = [...host.querySelectorAll('input')].map((input) => input.value);
    assert.ok(values.includes('demo-mailexpert-local.mail.protection.outlook.com'));
    assert.ok(values.includes('50'));
    const pilot = host.querySelector('[data-domain-onboarding="pilot.demo.mailexpert.local"]');
    assert.ok(pilot, 'the pilot domain is on the checklist');
    assert.ok(host.querySelector('[data-domain-onboarding="legacy.demo.mailexpert.local"]'), 'the unknown domain is on the checklist');
    await React.act(async () => {
      buttons(pilot, 'admin.mailNode.stepDone')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const { domains } = await demoRequest('GET', '/mail-node/domains');
    assert.equal(domains.find((d) => d.domain === 'pilot.demo.mailexpert.local').state, 'tenant_verified');
    const step = host.querySelector('[data-domain-onboarding="pilot.demo.mailexpert.local"] [data-step="tenant_verified"]');
    assert.equal(step.getAttribute('data-status'), 'confirmed');
  });
});
