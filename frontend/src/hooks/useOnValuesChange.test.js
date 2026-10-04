import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useOnValuesChange } = await import('./useOnValuesChange.js');

// What ComposeModal does with it: an edit stamp that an untouched composer must not get.
function Probe({ subject, body, onChange }) {
  useOnValuesChange([subject, body], onChange);
  return null;
}

async function render(root, props, strict) {
  const probe = React.createElement(Probe, props);
  await React.act(async () => { root.render(strict ? React.createElement(React.StrictMode, null, probe) : probe); });
}

for (const strict of [false, true]) {
  test(`reports a change of the values only, not the mount${strict ? ' (StrictMode double effects)' : ''}`, async () => {
    const root = createRoot(document.createElement('div'));
    let changes = 0;
    const onChange = () => { changes += 1; };
    try {
      await render(root, { subject: 'Contract', body: 'Hi', onChange }, strict);
      assert.equal(changes, 0, 'an untouched composer is not "just edited"');
      await render(root, { subject: 'Contract', body: 'Hi', onChange }, strict);
      assert.equal(changes, 0, 'a render with the same values is not an edit');
      await render(root, { subject: 'Contract', body: 'Hi Bob', onChange }, strict);
      assert.equal(changes, 1, 'an edit is');
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
