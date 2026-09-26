// Search now covers every folder of the selected mailbox(es) by default; narrowing to the
// current folder is the opt-out. The default lives in the store's module-scope initializer
// (reads localStorage once at import time), so this needs a fresh process/module registry
// per scenario — same harness as useWebSocket.counts.test.js: node --test gives each test
// FILE its own process, so a plain localStorage read here reflects a truly fresh install.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.json')
      ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
      : nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

const { useStore } = await import('./index.js');

describe('searchAllFolders defaults to on (every folder of the selected mailbox)', () => {
  test('a fresh install/device with no stored preference searches every folder', () => {
    // Nothing has ever called setSearchAllFolders in this process, so the module-scope
    // initializer ran against an empty localStorage — exactly a fresh install.
    assert.equal(localStorage.getItem('mailexpert_search_all_folders'), null);
    assert.equal(useStore.getState().searchAllFolders, true);
  });

  test('narrowing to the current folder persists as the explicit opt-out', () => {
    useStore.getState().setSearchAllFolders(false);
    assert.equal(useStore.getState().searchAllFolders, false);
    assert.equal(localStorage.getItem('mailexpert_search_all_folders'), '0');
  });

  test('turning it back on clears the stored opt-out rather than writing a new value', () => {
    useStore.getState().setSearchAllFolders(false);
    useStore.getState().setSearchAllFolders(true);
    assert.equal(useStore.getState().searchAllFolders, true);
    assert.equal(localStorage.getItem('mailexpert_search_all_folders'), null);
  });
});
