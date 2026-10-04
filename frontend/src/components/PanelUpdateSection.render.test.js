// Render tests for Settings -> Panel update (admins only), with the real English and Russian
// resources: a key missing from en.json or ru.json shows up as the key itself and fails here. The
// pure rules are covered by utils/panelUpdate.test.js.
//
// The harness mirrors MailNodeOutages.render.test.js (sucrase for .jsx, import.meta.env shim), but
// react-i18next is the real one. The 3 second poll is driven by hand: setTimeout is wrapped so the
// test sees what was scheduled and runs it when it wants to.

import { test, describe, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  Image: dom.window.Image,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const ru = JSON.parse(readFileSync(new URL('../locales/ru.json', import.meta.url), 'utf8'));
const i18n = (await import('i18next')).default;
const { initReactI18next } = await import('react-i18next');
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const PanelUpdateSection = (await import('./PanelUpdateSection.jsx')).default;
const { TABS, TAB_GROUPS, makeSearchIndex } = await import('./AdminPanel.jsx');

before(async () => {
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng: 'en',
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
});

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const A = 'sha-aaaaaaaaaaaa';
const B = 'sha-bbbbbbbbbbbb';
const COMPARE = 'https://github.com/wyrtensi/MailExpert/compare/aaaaaaaaaaaa...bbbbbbbbbbbb';
const LINKS = {
  runbook: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/deployment.md#rollback',
  rollback: 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/README.md#10',
};
const state = (extra = {}) => ({
  current: { sha: 'a'.repeat(40), version: A },
  latest: { version: B, sha: 'b'.repeat(40), checkedAt: ago(60000) },
  compare: { status: 'ahead', aheadBy: 3, url: COMPARE },
  updateAvailable: true, disabled: false, checkError: null,
  updater: { spool: true, installed: true, version: A },
  busy: false, pending: null, check: null, run: null, links: LINKS,
  ...extra,
});
const READY = {
  id: 'c1', action: 'check', target: B, state: 'ready', terminal: true, message: 'ok', from: A,
  receivedAt: ago(5000), updatedAt: ago(4000), startedAt: ago(5000), finishedAt: ago(4000), exitCode: null,
  preflight: { ok: true, problems: [], warnings: ['Disk is 80 percent full'], next: [], info: [], pendingMigrations: [], migrationsApplied: 41 },
  autoRollback: true, next: [], log: [], logFile: '/opt/mailexpert/state/updater/c1.log', journal: 'journalctl -u mailexpert-updater.service',
};
const BLOCKED = {
  ...READY, id: 'c2', state: 'blocked', message: 'preflight found problems',
  preflight: { ok: false, problems: ['Free disk space is below 2 GB'], warnings: [], next: ['Free some disk space'], info: [], pendingMigrations: ['0042_add_index.sql'], migrationsApplied: 41 },
  autoRollback: false,
};
const RUN = {
  id: 'u1', action: 'update', target: B, state: 'updating', terminal: false, message: 'Replacing containers', from: A,
  receivedAt: ago(60000), updatedAt: ago(3000), startedAt: ago(50000), finishedAt: null, exitCode: null,
  preflight: READY.preflight, autoRollback: true, next: [],
  log: ['[1/6] backup', 'backup done: /opt/mailexpert/backups/x.tar.gz', '[2/6] pull images'],
  logFile: '/opt/mailexpert/state/updater/u1.log', journal: 'journalctl -u mailexpert-updater.service',
};

let calls;
let answers;
let timers;
let realSetTimeout;
function mockEnvironment() {
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    // ?refresh=1 asks the same endpoint to skip its cache: the same answer (calls keep the query).
    const answer = answers[`${method} ${path.replace(/\?refresh=1$/, '')}`];
    const value = typeof answer === 'function' ? answer(opts) : answer;
    if (value instanceof Error) throw value;
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body ?? {} };
    return { ok: true, status: value?.status ?? 200, json: async () => value ?? {} };
  };
  // Only the poll's 3 second timer is held back; everything else runs as usual.
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 3000) {
      const entry = { fn, cleared: false };
      timers.push(entry);
      return entry;
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cleared' in handle) handle.cleared = true;
    else realClear(handle);
  };
}

before(() => { realSetTimeout = globalThis.setTimeout; });
beforeEach(async () => {
  calls = [];
  timers = [];
  answers = {};
  await i18n.changeLanguage('en');
  mockEnvironment();
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await React.act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
};
async function mount(element = React.createElement(PanelUpdateSection)) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await React.act(async () => { root.render(element); });
  await flush();
  return host;
}
const roots = [];
afterEach(async () => {
  // Unmounted before the next test changes the language, so no stale tree re-renders outside act.
  const mounted = roots.splice(0);
  await React.act(async () => { for (const root of mounted) root.unmount(); });
});
async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}
// Runs the poll timers that are waiting, as the 3 seconds passing.
async function pollNow() {
  const due = timers.filter((entry) => !entry.cleared);
  timers = [];
  await React.act(async () => { for (const entry of due) entry.fn(); });
  await flush();
}
const get = (root, selector) => root.querySelector(selector);
const text = (root, selector) => get(root, selector)?.textContent ?? null;
const posts = () => calls.filter((c) => c.method === 'POST');

describe('the panel update section', () => {
  test('says the update mechanism is not installed, disables the button and links to the guide', async () => {
    answers['GET /api/admin/update'] = state({ updater: { spool: false, installed: false, version: null }, updateAvailable: true });
    const root = await mount();
    assert.ok(get(root, '[data-updater-not-installed]'));
    assert.match(text(root, '[data-updater-not-installed]'), /update mechanism is not installed/);
    assert.match(text(root, '[data-updater-not-installed]'), /install\.sh/);
    assert.equal(get(root, '[data-docs-link]').getAttribute('href'), 'https://github.com/wyrtensi/MailExpert/blob/main/docs/operations/README.md');
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
    assert.equal(get(root, '[data-panel-update-check-button]').disabled, true);
    assert.equal(posts().length, 0, 'no automatic check without an updater');
  });

  test('opening the card asks for a fresh look at latest; the poll does not', async () => {
    answers['GET /api/admin/update'] = state({ updateAvailable: true, run: RUN, busy: true });
    await mount();
    const gets = () => calls.filter((c) => c.method === 'GET').map((c) => c.path);
    assert.deepEqual(gets(), ['/api/admin/update?refresh=1']);
    await pollNow();
    assert.deepEqual(gets(), ['/api/admin/update?refresh=1', '/api/admin/update']);
  });

  test('shows an up to date panel (ru) with no check and the button off', async () => {
    await i18n.changeLanguage('ru');
    answers['GET /api/admin/update'] = state({
      updateAvailable: false, latest: { version: A, sha: 'a'.repeat(40), checkedAt: ago(1000) },
      compare: { status: 'identical', aheadBy: 0, url: null },
    });
    const root = await mount();
    assert.equal(get(root, '[data-panel-update-status]').getAttribute('data-panel-update-status'), 'current');
    assert.match(text(root, '[data-panel-update-status]'), /Установлена актуальная версия/);
    assert.equal(text(root, '[data-current-version]'), A);
    assert.equal(get(root, '[data-panel-update-check]'), null);
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
    assert.equal(get(root, '[data-compare-link]'), null);
    assert.match(root.textContent, /Обновление панели/);
    assert.doesNotMatch(root.textContent, /admin\.panelUpdate/);
  });

  test('an available update with a ready check: versions, commits, compare link, migrations, rollback, enabled button', async () => {
    answers['GET /api/admin/update'] = state({ check: READY });
    const root = await mount();
    assert.equal(text(root, '[data-current-version]'), A);
    assert.equal(text(root, '[data-latest-version]'), B);
    assert.match(text(root, '[data-panel-update-status]'), /An update is available/);
    assert.match(text(root, '[data-panel-update-status]'), /Commits ahead: 3/);
    assert.equal(get(root, '[data-compare-link]').getAttribute('href'), COMPARE);
    assert.equal(text(root, '[data-check-state]'), 'Ready to update');
    assert.match(text(root, '[data-migrations]'), /No database migrations are pending/);
    assert.match(text(root, '[data-rollback]'), /brings the previous version back by itself/);
    assert.match(root.textContent, /Disk is 80 percent full/);
    assert.equal(get(root, '[data-panel-update-button]').disabled, false);
    assert.equal(posts().length, 0, 'a recorded check is not repeated');
  });

  test('asks for the check once by itself when there is none for the target', async () => {
    answers['GET /api/admin/update'] = state();
    answers['POST /api/admin/update/check'] = { status: 202, id: 'c9' };
    await mount();
    assert.deepEqual(posts().map((c) => [c.path, c.body]), [['/api/admin/update/check', { target: B }]]);
    await pollNow();
    assert.equal(posts().length, 1, 'still one request after another look');
  });

  test('"Check" asks for a check of the promoted version', async () => {
    answers['GET /api/admin/update'] = state({ check: READY });
    answers['POST /api/admin/update/check'] = { status: 202, id: 'c10' };
    const root = await mount();
    await click(get(root, '[data-panel-update-check-button]'));
    assert.deepEqual(posts().map((c) => [c.path, c.body]), [['/api/admin/update/check', { target: B }]]);
  });

  test('a blocked check lists problems, next steps and migrations, and the button stays off', async () => {
    await i18n.changeLanguage('ru');
    answers['GET /api/admin/update'] = state({ check: BLOCKED });
    const root = await mount();
    assert.equal(text(root, '[data-check-state]'), 'Заблокировано');
    assert.match(root.textContent, /Free disk space is below 2 GB/);
    assert.match(root.textContent, /Free some disk space/);
    assert.match(text(root, '[data-migrations]'), /Миграций базы данных в очереди: 1/);
    assert.match(root.textContent, /0042_add_index\.sql/);
    assert.match(text(root, '[data-rollback]'), /вручную/);
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
    assert.equal(get(root, '[data-update-block]').getAttribute('data-update-block'), 'blocked');
  });

  test('pendingMigrations null is shown as unknown, treated as present', async () => {
    answers['GET /api/admin/update'] = state({ check: { ...READY, preflight: { ...READY.preflight, pendingMigrations: null }, autoRollback: false } });
    const root = await mount();
    assert.equal(get(root, '[data-migrations]').getAttribute('data-migrations'), 'unknown');
    assert.match(text(root, '[data-migrations]'), /assumed to be pending/);
    assert.equal(get(root, '[data-rollback]').getAttribute('data-rollback'), 'manual');
  });

  test('"Update" confirms first, states the consequences, then sends target and confirm', async () => {
    answers['GET /api/admin/update'] = state({ check: READY });
    answers['POST /api/admin/update'] = { status: 202, id: 'u7' };
    const root = await mount();
    await click(get(root, '[data-panel-update-button]'));
    const dialog = dom.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(posts().length, 0, 'nothing is sent before the confirmation');
    assert.match(dialog.textContent, /Update the panel to sha-bbbbbbbbbbbb\?/);
    assert.match(dialog.textContent, /backup is taken first/i);
    assert.match(dialog.textContent, /unavailable for a few minutes/);
    assert.match(dialog.textContent, /rolled back automatically/);
    await click(dialog.querySelector('[data-confirm-button]'));
    assert.deepEqual(posts().map((c) => [c.path, c.body]), [['/api/admin/update', { target: B, confirm: B }]]);
  });

  test('the confirmation names the pending migrations and a manual rollback', async () => {
    answers['GET /api/admin/update'] = state({ check: { ...READY, preflight: { ...READY.preflight, pendingMigrations: ['0042_add_index.sql'] }, autoRollback: false } });
    const root = await mount();
    await click(get(root, '[data-panel-update-button]'));
    const dialog = dom.window.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /0042_add_index\.sql/);
    assert.match(dialog.textContent, /manual, by the runbook/);
    await click([...dialog.querySelectorAll('button')].find((b) => b.hasAttribute('data-confirm-button') === false));
  });

  test('a refusal of the server is shown in words', async () => {
    answers['GET /api/admin/update'] = state({ check: READY });
    answers['POST /api/admin/update'] = { status: 409, body: { error: 'busy' } };
    const root = await mount();
    await click(get(root, '[data-panel-update-button]'));
    await click(dom.window.document.querySelector('[data-confirm-button]'));
    assert.match(text(root, '[data-panel-update-error]'), /already in progress/);
  });

  test('a rolled back latest version shows a notice, disables both buttons and checks nothing (en)', async () => {
    answers['GET /api/admin/update'] = state({ updater: { spool: true, installed: true, version: A, rolledBack: B } });
    const root = await mount();
    assert.match(text(root, '[data-rolled-back]'), new RegExp(`Version ${B} was rolled back`));
    assert.match(text(root, '[data-rolled-back]'), /until the owner promotes a newer build/);
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
    assert.equal(get(root, '[data-panel-update-check-button]').disabled, true);
    assert.equal(posts().length, 0, 'no automatic check');
  });

  test('a rolled back latest version in Russian', async () => {
    await i18n.changeLanguage('ru');
    answers['GET /api/admin/update'] = state({ updater: { spool: true, installed: true, version: A, rolledBack: B } });
    const root = await mount();
    assert.match(text(root, '[data-rolled-back]'), new RegExp(`Версия ${B} была откачена`));
    assert.doesNotMatch(root.textContent, /admin\.panelUpdate/);
  });

  test('a rolled back version that is not the latest changes nothing', async () => {
    answers['GET /api/admin/update'] = state({ check: READY, updater: { spool: true, installed: true, version: A, rolledBack: 'sha-cccccccccccc' } });
    const root = await mount();
    assert.equal(get(root, '[data-rolled-back]'), null);
    assert.equal(get(root, '[data-panel-update-button]').disabled, false);
  });

  test('the rolled_back and spool_not_writable refusals are shown in words', async () => {
    answers['GET /api/admin/update'] = state({ check: READY });
    answers['POST /api/admin/update'] = { status: 409, body: { error: 'rolled_back' } };
    const root = await mount();
    await click(get(root, '[data-panel-update-button]'));
    await click(dom.window.document.querySelector('[data-confirm-button]'));
    assert.match(text(root, '[data-panel-update-error]'), /was rolled back/);

    answers['POST /api/admin/update'] = { status: 503, body: { error: 'spool_not_writable' } };
    await click(get(root, '[data-panel-update-button]'));
    await click(dom.window.document.querySelector('[data-confirm-button]'));
    assert.match(text(root, '[data-panel-update-error]'), /cannot write to the update request directory/);
    assert.match(text(root, '[data-panel-update-error]'), /install\.sh/);
  });

  test('an update in progress shows the state and the log tail, keeps polling and blocks the buttons', async () => {
    answers['GET /api/admin/update'] = state({ busy: true, check: READY, run: RUN });
    const root = await mount();
    assert.equal(text(root, '[data-run-state]'), 'Updating');
    assert.match(text(root, '[data-run-log]'), /\[2\/6\] pull images/);
    assert.match(text(root, '[data-run-message]'), /Replacing containers/);
    assert.equal(text(root, '[data-run-log-file]'), '/opt/mailexpert/state/updater/u1.log');
    assert.equal(text(root, '[data-run-journal]'), 'journalctl -u mailexpert-updater.service');
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
    assert.equal(get(root, '[data-panel-update-check-button]').disabled, true);
    assert.equal(timers.filter((t) => !t.cleared).length, 1, 'a poll is scheduled');
    const before = calls.filter((c) => c.method === 'GET').length;
    answers['GET /api/admin/update'] = state({ busy: true, check: READY, run: { ...RUN, log: [...RUN.log, '[3/6] restart'] } });
    await pollNow();
    assert.equal(calls.filter((c) => c.method === 'GET').length, before + 1);
    assert.match(text(root, '[data-run-log]'), /\[3\/6\] restart/);
    assert.equal(timers.filter((t) => !t.cleared).length, 1, 'and another one after it');
  });

  test('a gap while the backend restarts reads as a restart, not an error, and polling carries on', async () => {
    answers['GET /api/admin/update'] = state({ busy: true, check: READY, run: RUN });
    const root = await mount();
    answers['GET /api/admin/update'] = { status: 502, body: { error: 'Bad Gateway' } };
    await pollNow();
    assert.ok(get(root, '[data-panel-restarting]'));
    assert.match(text(root, '[data-panel-restarting]'), /restarting/);
    assert.equal(get(root, '[role="alert"]'), null);
    assert.equal(timers.filter((t) => !t.cleared).length, 1);
    answers['GET /api/admin/update'] = () => new TypeError('fetch failed');
    await pollNow();
    assert.ok(get(root, '[data-panel-restarting]'), 'a refused connection too');
    answers['GET /api/admin/update'] = state({ check: READY, run: { ...RUN, state: 'succeeded', terminal: true, finishedAt: ago(1000), exitCode: 0, message: 'Updated' } });
    await pollNow();
    assert.equal(get(root, '[data-panel-restarting]'), null);
    assert.equal(text(root, '[data-run-state]'), 'Updated');
    assert.equal(timers.filter((t) => !t.cleared).length, 0, 'polling stops when nothing runs');
  });

  test('a success shows the exit code and offers a reload (ru)', async () => {
    await i18n.changeLanguage('ru');
    answers['GET /api/admin/update'] = state({
      updateAvailable: false, current: { sha: 'b'.repeat(40), version: B }, compare: { status: 'identical', aheadBy: 0, url: null },
      run: { ...RUN, state: 'succeeded', terminal: true, finishedAt: ago(30000), exitCode: 0, message: 'Update finished', next: ['Open the panel and sign in'] },
    });
    const root = await mount();
    assert.equal(text(root, '[data-run-state]'), 'Обновлено');
    assert.match(text(root, '[data-run-exit]'), /Код выхода: 0/);
    assert.match(root.textContent, /Open the panel and sign in/);
    assert.ok(get(root, '[data-panel-update-reload]'));
    assert.match(text(root, '[data-panel-update-reload]'), /Перезагрузить страницу/);
    assert.equal(get(root, '[data-run-recovery]'), null);
  });

  test('an old success no longer asks for a reload', async () => {
    answers['GET /api/admin/update'] = state({
      updateAvailable: false, compare: { status: 'identical', aheadBy: 0, url: null },
      run: { ...RUN, state: 'succeeded', terminal: true, finishedAt: ago(5 * 3600000), exitCode: 0 },
    });
    const root = await mount();
    assert.equal(get(root, '[data-panel-update-reload]'), null);
  });

  test('a failed update names the logs, the runbook and the rollback command', async () => {
    answers['GET /api/admin/update'] = state({
      check: READY,
      run: {
        ...RUN, state: 'failed', terminal: true, finishedAt: ago(1000), exitCode: 2, message: 'docker compose up failed',
        next: ['Run rollback.sh'], log: ['[4/6] up', 'ERROR: unhealthy'],
      },
    });
    const root = await mount();
    assert.equal(text(root, '[data-run-state]'), 'Update failed');
    assert.match(text(root, '[data-run-exit]'), /Exit code: 2/);
    assert.match(text(root, '[data-run-message]'), /docker compose up failed/);
    assert.equal(text(root, '[data-run-rollback-command]'), 'sudo /opt/mailexpert/app/scripts/deploy/rollback.sh --to sha-aaaaaaaaaaaa');
    assert.equal(get(root, '[data-run-runbook]').getAttribute('href'), LINKS.runbook);
    assert.equal(text(root, '[data-run-log-file]'), '/opt/mailexpert/state/updater/u1.log');
    assert.equal(get(root, '[data-run-journal]').tagName, 'DIV');
    assert.equal(get(root, '[data-run-log-file] a'), null, 'the log path is text, not a link');
    assert.equal(get(root, '[data-panel-update-reload]'), null);
  });

  test('a failed rollback says to roll back now', async () => {
    answers['GET /api/admin/update'] = state({ run: { ...RUN, state: 'rollback_failed', terminal: true, finishedAt: ago(1000), exitCode: 3 } });
    const root = await mount();
    assert.equal(text(root, '[data-run-state]'), 'Update failed and the rollback failed too');
    assert.match(text(root, '[data-run-recovery]'), /Roll back by hand now/);
  });

  test('a rolled back update is an outcome without the runbook alarm', async () => {
    answers['GET /api/admin/update'] = state({ run: { ...RUN, state: 'rolled_back', terminal: true, finishedAt: ago(1000), exitCode: 1 } });
    const root = await mount();
    assert.equal(text(root, '[data-run-state]'), 'Update failed and was rolled back');
    assert.equal(get(root, '[data-run-recovery]'), null);
  });

  test('a rate limited check of GitHub is explained and nothing is asked of the host', async () => {
    answers['GET /api/admin/update'] = state({ checkError: 'rate_limited', latest: null, updateAvailable: false, compare: { status: null, aheadBy: null, url: null } });
    const root = await mount();
    assert.match(text(root, '[data-panel-update-status]'), /limiting requests/);
    assert.equal(posts().length, 0);
    assert.equal(get(root, '[data-panel-update-button]').disabled, true);
  });

  test('a disabled check for updates is stated', async () => {
    answers['GET /api/admin/update'] = state({ disabled: true, latest: null, updateAvailable: false, compare: { status: null, aheadBy: null, url: null } });
    const root = await mount();
    assert.match(text(root, '[data-panel-update-status]'), /switched off/);
  });

  test('a first load that fails is an error, not a restart', async () => {
    answers['GET /api/admin/update'] = { status: 403, body: { error: 'Admin access required' } };
    const root = await mount();
    assert.match(root.textContent, /Could not load the update state: Admin access required/);
    assert.equal(get(root, '[data-panel-restarting]'), null);
  });
});

describe('the panel update tab', () => {
  test('is an admin-only tab in the Administration group', () => {
    const tab = TABS.find((x) => x.id === 'panel-update');
    assert.ok(tab);
    assert.equal(tab.adminOnly, true);
    assert.equal(tab.labelKey, 'admin.tabs.panelUpdate');
    assert.equal(TAB_GROUPS.find((g) => g.tabIds.includes('panel-update'))?.id, 'admin');
    // The same filter AdminPanel applies: a non-admin never gets the tab.
    const visibleFor = (isAdmin) => TABS.filter((x) => !x.adminOnly || isAdmin).map((x) => x.id);
    assert.ok(visibleFor(true).includes('panel-update'));
    assert.ok(!visibleFor(false).includes('panel-update'));
    assert.equal(en.admin.tabs.panelUpdate, 'Panel update');
    assert.equal(ru.admin.tabs.panelUpdate, 'Обновление панели');
  });

  test('the settings search finds it for administrators only', () => {
    const entry = makeSearchIndex((key) => key).find((item) => item.tab === 'panel-update');
    assert.ok(entry);
    assert.equal(entry.adminOnly, true);
  });
});
