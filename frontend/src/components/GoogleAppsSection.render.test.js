// Render test for GoogleAppsSection's Gmail-API-disabled warning (feat/gmail-api-send).
//
// GoogleAppsSection loads its apps from GET /api/admin/google-apps and renders a warning row
// under any app whose gmailApiDisabledAt is set (googleAppGmailApiWarningKey, utils/googleApps.js).
// That mapping itself is covered by utils/googleApps.test.js; this only confirms the component
// actually renders the warning for a flagged app and stays silent for a clean one, which needs
// the real component mounted against a fetched apps list.
//
// The harness mirrors RowHoverActions.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the raw key (so a
// rendered key string doubles as a readable, stable assertion target).

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
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const GoogleAppsSection = (await import('./GoogleAppsSection.jsx')).default;

const CLEAN_APP = {
  id: 'app-1', label: 'Google 1', clientId: '111-abc.apps.googleusercontent.com', projectNumber: '111',
  userLimit: 100, status: 'active', accountsCount: 1, grantsCount: 1, reservedCount: 0, full: false,
  gmailApiDisabledAt: null, createdAt: '2026-09-01T00:00:00.000Z',
};
const FLAGGED_APP = {
  ...CLEAN_APP, id: 'app-2', label: 'Google 2', clientId: '222-def.apps.googleusercontent.com', projectNumber: '222',
  gmailApiDisabledAt: '2026-09-27T00:00:00.000Z',
};

function mockFetch(apps) {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/admin/google-apps') return { ok: true, status: 200, json: async () => ({ apps }) };
    if (path === '/api/integrations') return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

async function mount(apps) {
  mockFetch(apps);
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => {
    createRoot(host).render(React.createElement(GoogleAppsSection));
  });
  // Flush the microtasks the mounted effect's fetch().then() chain needs to settle and re-render.
  await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const WARNING_KEY = 'admin.integrations.googleApps.gmailApiDisabledWarning';

describe('GoogleAppsSection — Gmail API disabled warning', () => {
  test('shows the warning under an app whose Gmail API turned out to be disabled', async () => {
    const host = await mount([CLEAN_APP, FLAGGED_APP]);
    assert.equal(host.textContent.includes(WARNING_KEY), true);
    // The row exists once, and it is the flagged app's row, not the clean one's.
    const rows = [...host.querySelectorAll('tr')];
    const warningRow = rows.find((r) => r.textContent.includes(WARNING_KEY));
    assert.ok(warningRow, 'expected a warning row to render');
  });

  test('renders no warning when no app has the flag set', async () => {
    const host = await mount([CLEAN_APP]);
    assert.equal(host.textContent.includes(WARNING_KEY), false);
  });
});
