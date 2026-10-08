// Run with: node --test src/utils/confirmedSwitch.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { saveConfirmedSwitch } from './confirmedSwitch.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('saveConfirmedSwitch', () => {
  it('shows the new value at once and keeps it once the server saved it', async () => {
    const confirmed = { k: false };
    const shown = [];
    await saveConfirmedSwitch({ key: 'k', value: true, confirmed, apply: (v) => shown.push(v), save: async () => {} });
    assert.deepEqual(shown, [true]);
    assert.equal(confirmed.k, true);
  });

  it('a refused change goes back to the value the server has, and rethrows', async () => {
    const confirmed = { k: false };
    const shown = [];
    await assert.rejects(saveConfirmedSwitch({
      key: 'k', value: true, confirmed, apply: (v) => shown.push(v), save: async () => { throw new Error('no'); },
    }), /no/);
    assert.deepEqual(shown, [true, false]);
  });

  it('a double click with two refusals ends on the server value, whatever order they fail in', async () => {
    const confirmed = { k: false };
    let shown;
    const apply = (v) => { shown = v; };
    const first = deferred();
    const second = deferred();
    const a = saveConfirmedSwitch({ key: 'k', value: true, confirmed, apply, save: () => first.promise });
    const b = saveConfirmedSwitch({ key: 'k', value: false, confirmed, apply, save: () => second.promise });
    second.reject(new Error('no'));
    await assert.rejects(b);
    first.reject(new Error('no'));
    await assert.rejects(a);
    assert.equal(shown, false);

    // The same with the first click being a change away from a true server value.
    confirmed.k = true;
    const c = deferred();
    const d = deferred();
    const pc = saveConfirmedSwitch({ key: 'k', value: false, confirmed, apply, save: () => c.promise });
    const pd = saveConfirmedSwitch({ key: 'k', value: true, confirmed, apply, save: () => d.promise });
    c.reject(new Error('no'));
    await assert.rejects(pc);
    d.reject(new Error('no'));
    await assert.rejects(pd);
    assert.equal(shown, true);
  });

  it('a refusal after another click was saved goes back to that saved value', async () => {
    const confirmed = { k: false };
    let shown;
    const first = deferred();
    const a = saveConfirmedSwitch({ key: 'k', value: true, confirmed, apply: (v) => { shown = v; }, save: () => first.promise });
    await saveConfirmedSwitch({ key: 'k', value: false, confirmed, apply: (v) => { shown = v; }, save: async () => {} });
    first.reject(new Error('no'));
    await assert.rejects(a);
    assert.equal(shown, false);
    assert.equal(confirmed.k, false);
  });
});
