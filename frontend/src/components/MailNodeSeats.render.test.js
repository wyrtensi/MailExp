// Render tests for the EOP seats counter (EOP seats design): used, temporarily unavailable with the held
// seats on hover, free, the hold period for administrators, requests, and the compact line. The harness
// is the one of MailboxDeletionNotice.render.test.js: the loader hook transforms .jsx with sucrase, and
// react-i18next is stubbed to return the key followed by its values, so they can be checked.

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
const { default: MailNodeSeats } = await import('./MailNodeSeats.jsx');

async function mount(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => { createRoot(host).render(element); });
  return host;
}

const SEATS = {
  used: 3, held: 1, free: 2, known: true, mode: 'graph', source: 'graph', checkedAt: '2026-10-07T08:00:00.000Z',
  stale: false, notReconciled: false, over: false, error: null, holdDays: 90,
  heldSeats: [{ seat: 4, email: 'b@example.com', reason: 'deactivated', freeFrom: '2027-01-05T00:00:00.000Z' }], requests: [],
};

describe('MailNodeSeats', () => {
  test('shows used, temporarily unavailable with the held seats on hover, and free; "Reconcile" for administrators', async () => {
    const host = await mount(React.createElement(MailNodeSeats, { seats: SEATS, isAdmin: true }));
    const block = host.querySelector('[data-eop-seats]');
    assert.ok(block.textContent.includes('admin.mailNode.seats.used {"used":3}'));
    assert.ok(block.textContent.includes('admin.mailNode.seats.free {"free":2}'));
    const held = block.querySelector('[data-seats-held]');
    assert.ok(held.textContent.includes('admin.mailNode.seats.held {"held":1}'));
    assert.ok(held.getAttribute('title').includes('b@example.com'));
    assert.ok([...block.querySelectorAll('button')].some((b) => b.textContent === 'admin.mailNode.seats.check'));
    assert.ok(block.querySelector('[data-seat-hold]'), 'administrators set the hold period');
    assert.ok(!block.textContent.includes('purchased'));
  });

  test('warns when stale or over, lists open requests', async () => {
    const host = await mount(React.createElement(MailNodeSeats, {
      seats: { ...SEATS, stale: true, over: true, requests: [{ id: 1, seats: 2, requestedBy: 'anna@example.com', requestedAt: '2026-10-06T10:00:00.000Z' }] },
    }));
    assert.ok(host.textContent.includes('admin.mailNode.seats.stale'));
    assert.ok(host.textContent.includes('admin.mailNode.seats.over'));
    assert.ok(host.querySelector('[data-seat-requests]').textContent.includes('anna@example.com'));
    assert.equal(host.querySelector('[data-seat-hold]'), null, 'not for ordinary users');
  });

  test('compact: one line, "Request seats" only when none is free', async () => {
    const free = await mount(React.createElement(MailNodeSeats, { seats: SEATS, compact: true }));
    assert.equal([...free.querySelectorAll('button')].length, 0);
    const none = await mount(React.createElement(MailNodeSeats, { seats: { ...SEATS, free: 0 }, compact: true }));
    assert.equal(none.querySelector('[data-eop-seats]').dataset.seatsFree, '0');
    assert.ok([...none.querySelectorAll('button')].some((b) => b.textContent === 'admin.mailNode.seats.request'));
  });

  test('says the number is unknown, and what to do: Licenses by hand, Reconcile with the tenant', async () => {
    const manual = await mount(React.createElement(MailNodeSeats, { seats: { ...SEATS, mode: 'manual', source: 'manual', free: null, known: false }, compact: true }));
    assert.ok(manual.textContent.includes('admin.mailNode.seats.unknown'));
    assert.ok(!manual.textContent.includes('admin.mailNode.seats.unknownGraph'));
    const graph = await mount(React.createElement(MailNodeSeats, {
      seats: { ...SEATS, mode: 'graph', source: 'manual', notReconciled: true, free: null, known: false }, compact: true,
    }));
    assert.ok(graph.textContent.includes('admin.mailNode.seats.unknownGraph'));
  });

  test('says when the tenant has no EOP subscription, in the compact line too', async () => {
    for (const compact of [false, true]) {
      const host = await mount(React.createElement(MailNodeSeats, { seats: { ...SEATS, free: 0, subscriptionMissing: true }, compact }));
      assert.ok(host.querySelector('[data-seats-no-subscription]'), `compact ${compact}`);
    }
    const fine = await mount(React.createElement(MailNodeSeats, { seats: SEATS }));
    assert.equal(fine.querySelector('[data-seats-no-subscription]'), null);
  });
});
