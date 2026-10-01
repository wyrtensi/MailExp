// Render test for the safe view bar (R-41) with the real English and Russian resources: unlike the
// render tests that stub t() to answer the key, a key missing from en.json or ru.json fails here,
// because i18next then shows the key itself.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
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

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const ru = JSON.parse(readFileSync(new URL('../locales/ru.json', import.meta.url), 'utf8'));
const i18n = (await import('i18next')).default;
const { initReactI18next } = await import('react-i18next');
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const SafeViewNotice = (await import('./SafeViewNotice.jsx')).default;

before(async () => {
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng: 'en',
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
});

async function render(props) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(SafeViewNotice, props)); });
  const text = host.textContent;
  await React.act(async () => root.unmount());
  host.remove();
  return text;
}

const CATEGORIES = ['SPM', 'HSPM', 'BULK', 'OSPM', 'PHSH', 'HPHSH', 'HPHISH', 'INTOS', 'DIMP', 'UIMP', 'GIMP', 'BIMP', 'SPOOF', 'MALW', 'AMP', 'SAP', 'FTBP'];

describe('SafeViewNotice reads in English and Russian', () => {
  for (const lng of ['en', 'ru']) {
    const strings = (lng === 'en' ? en : ru).message.safeView;

    test(`${lng}: every reason, both kinds of bar and every category have their words`, async () => {
      await i18n.changeLanguage(lng);
      for (const reason of ['spam', 'phishing', 'malware', 'spoof']) {
        const locked = await render({ reason, eopCategory: null, onShowFull: () => {} });
        assert.ok(locked.includes(strings.title[reason]), `${reason} title`);
        assert.ok(locked.includes(strings.explain));
        assert.ok(locked.includes(strings.showFull));
        assert.doesNotMatch(locked, /message\.safeView/, `${reason}: no raw key`);
      }
      const warning = await render({ reason: 'spoof', eopCategory: 'SPOOF' });
      assert.ok(warning.includes(strings.explainWarn));
      assert.ok(!warning.includes(strings.showFull), 'a warning has nothing to show in full');
      for (const category of CATEGORIES) {
        const text = await render({ reason: 'phishing', eopCategory: category, onShowFull: () => {} });
        assert.doesNotMatch(text, /message\.safeView|\{\{/, `${category}: no raw key or placeholder`);
        assert.doesNotMatch(text, new RegExp(`\\b${category}\\b`), `${category} reads in words`);
      }
    });
  }
});
