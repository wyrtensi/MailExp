// Render tests for the node agent section (MailNodeAgentSection.jsx): the agent's state and last
// report, connecting it (the token shown once with the setup commands), revoking it after a
// confirmation, and "Back up mail now" followed until the job ends. The pure rules are covered by
// utils/nodeAgent.test.js.
//
// The harness is the one of MailNodeOps.render.test.js: sucrase for .jsx, react-i18next stubbed
// to return the raw key.

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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://panel.example.com/settings', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const MailNodeAgentSection = (await import('./MailNodeAgentSection.jsx')).default;

const STATUS = {
  scriptsCommit: '0123456789abcdef0123456789abcdef01234567',
  mailcowVersion: '2026-09',
  containers: { total: 18, running: 17, problems: ['clamd-mailcow: exited'] },
  backup: {
    configured: true, ok: false, problem: 'the last node backup is 30 hours old',
    last: { finishedAt: '2026-10-05T02:41:00.000Z', processedBytes: 5368709120 },
  },
};
const CONNECTED = { configured: true, connected: true, lastSeenAt: '2026-10-06T10:00:00.000Z', status: STATUS, statusAt: '2026-10-06T09:55:00.000Z', jobs: [] };
const NONE = { configured: false, connected: false, lastSeenAt: null, status: null, statusAt: null, jobs: [] };
const TOKEN = 'mxna_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

let calls;
let answers;
function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = opts.method || 'GET';
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(opts) : answer;
    if (value?.status >= 400) return { ok: false, status: value.status, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value ?? {} };
  };
}

beforeEach(() => {
  calls = [];
  answers = {};
  mockFetch();
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function mount() {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(MailNodeAgentSection)); });
  await flush();
  return { host, unmount: () => React.act(() => root.unmount()) };
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
async function click(element) {
  await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('MailNodeAgentSection', () => {
  test('shows a connected agent, its report and the node backup that is too old', async () => {
    answers['GET /api/mail-node/agent'] = CONNECTED;
    const { host, unmount } = await mount();
    assert.equal(host.querySelector('[data-agent-state]').dataset.agentState, 'connected');
    assert.match(host.textContent, /0123456789ab/);
    assert.doesNotMatch(host.textContent, /0123456789abcdef0/);
    assert.match(host.textContent, /2026-09/);
    assert.match(host.textContent, /clamd-mailcow: exited/);
    assert.equal(host.querySelector('[data-backup-state]').dataset.backupState, 'old');
    assert.match(host.textContent, /the last node backup is 30 hours old/);
    assert.match(host.textContent, /5\.0 admin\.mailNode\.unitGb/);
    assert.ok(button(host, 'admin.nodeAgent.rotate'));
    assert.equal(button(host, 'admin.nodeAgent.connect'), undefined);
    await unmount();
  });

  test('connecting shows the token once with the setup commands for this panel', async () => {
    let state = NONE;
    answers['GET /api/mail-node/agent'] = () => state;
    answers['POST /api/mail-node/agent/token'] = () => {
      state = { ...NONE, configured: true };
      return { token: TOKEN, createdAt: '2026-10-06T10:00:00.000Z', rotated: false };
    };
    const { host, unmount } = await mount();
    assert.equal(host.querySelector('[data-agent-state]').dataset.agentState, 'not_set_up');
    assert.equal(button(host, 'admin.nodeAgent.backupNow').disabled, true);
    await click(button(host, 'admin.nodeAgent.connect'));
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/mail-node/agent/token'));
    assert.equal(host.querySelector('[data-agent-token-value]').textContent, TOKEN);
    const setup = host.querySelector('[data-agent-setup]').textContent;
    assert.match(setup, /--panel-url https:\/\/panel\.example\.com --agent-token-file \/root\/mailexpert-agent-token/);
    assert.doesNotMatch(setup, new RegExp(TOKEN));
    assert.equal(host.querySelector('[data-agent-state]').dataset.agentState, 'waiting');
    // Hidden once the administrator saved it; never kept anywhere else.
    await click(button(host, 'admin.nodeAgent.tokenSaved'));
    assert.equal(host.querySelector('[data-agent-token]'), null);
    assert.doesNotMatch(host.innerHTML, new RegExp(TOKEN));
    assert.equal(dom.window.localStorage.length, 0);
    await unmount();
  });

  test('revoking needs a confirmation', async () => {
    let state = CONNECTED;
    answers['GET /api/mail-node/agent'] = () => state;
    answers['DELETE /api/mail-node/agent/token'] = () => { state = { ...CONNECTED, configured: false, connected: false }; return { revoked: true }; };
    const { host, unmount } = await mount();
    await click(button(host, 'admin.nodeAgent.revoke'));
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
    await click(button(host, 'admin.nodeAgent.revokeConfirm'));
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
    assert.equal(host.querySelector('[data-agent-state]').dataset.agentState, 'not_set_up');
    await unmount();
  });

  test('"Back up mail now" queues a backup and shows its progress and a failure', async () => {
    let state = CONNECTED;
    const job = { id: '7', kind: 'backup', state: 'running', step: 'push', logTail: '[mailexpert] dump done', error: null, createdAt: '2026-10-06T10:01:00.000Z', startedAt: '2026-10-06T10:01:02.000Z', finishedAt: null };
    answers['GET /api/mail-node/agent'] = () => state;
    answers['POST /api/mail-node/agent/jobs'] = () => { state = { ...CONNECTED, jobs: [job] }; return { job: { ...job, state: 'queued' } }; };
    const { host, unmount } = await mount();
    await click(button(host, 'admin.nodeAgent.backupNow'));
    assert.deepEqual(calls.find((c) => c.method === 'POST').body, { kind: 'backup' });
    assert.equal(host.querySelector('[data-backup-job]').dataset.backupJob, 'running');
    assert.match(host.textContent, /push/);
    assert.equal(host.querySelector('[data-backup-log]').textContent, '[mailexpert] dump done');
    assert.equal(button(host, 'admin.nodeAgent.backupNow').disabled, true);
    await unmount();

    state = { ...CONNECTED, jobs: [{ ...job, state: 'failed', error: 'timed_out', finishedAt: '2026-10-06T16:01:00.000Z' }] };
    const again = await mount();
    assert.equal(again.host.querySelector('[data-backup-job]').dataset.backupJob, 'failed');
    assert.match(again.host.textContent, /admin\.nodeAgent\.errorTimedOut/);
    assert.equal(button(again.host, 'admin.nodeAgent.backupNow').disabled, false);
    await again.unmount();
  });
});

describe('MailNodeAgentSection: the node update', () => {
  const PANEL = 'feedfacefeedfacefeedfacefeedfacefeedface';

  test('"Update node now" queues an update; its failure shows; a backup and an update exclude each other', async () => {
    let state = { ...CONNECTED, panelCommit: PANEL };
    const job = { id: '8', kind: 'update', params: { sha: PANEL }, state: 'running', step: 'setup.sh at feedfacefeed', logTail: '== setup.sh', error: null, createdAt: '2026-10-07T10:00:00.000Z', startedAt: '2026-10-07T10:00:02.000Z', finishedAt: null };
    answers['GET /api/mail-node/agent'] = () => state;
    answers['POST /api/mail-node/agent/jobs'] = () => { state = { ...state, jobs: [job] }; return { job: { ...job, state: 'queued' } }; };
    const { host, unmount } = await mount();
    assert.equal(host.querySelector('[data-scripts-state]').dataset.scriptsState, 'behind');
    await click(button(host, 'admin.nodeAgent.updateNow'));
    assert.deepEqual(calls.find((c) => c.method === 'POST').body, { kind: 'update' });
    assert.equal(host.querySelector('[data-update-job]').dataset.updateJob, 'running');
    assert.equal(host.querySelector('[data-update-log]').textContent, '== setup.sh');
    assert.equal(button(host, 'admin.nodeAgent.updateNow').disabled, true);
    assert.equal(button(host, 'admin.nodeAgent.backupNow').disabled, true);
    await unmount();

    state = { ...state, jobs: [{ ...job, state: 'failed', error: 'rolled_back', finishedAt: '2026-10-07T10:05:00.000Z' }] };
    const again = await mount();
    assert.equal(again.host.querySelector('[data-update-job]').dataset.updateJob, 'failed');
    assert.match(again.host.textContent, /admin\.nodeAgent\.errorRolledBack/);
    assert.equal(button(again.host, 'admin.nodeAgent.updateNow').disabled, false);
    await again.unmount();
  });

  test('without the panel commit the node cannot be updated from here', async () => {
    answers['GET /api/mail-node/agent'] = { ...CONNECTED, panelCommit: null };
    const { host, unmount } = await mount();
    assert.equal(host.querySelector('[data-scripts-state]').dataset.scriptsState, 'unknown');
    assert.equal(button(host, 'admin.nodeAgent.updateNow').disabled, true);
    await unmount();
  });
});
