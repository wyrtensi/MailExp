import { describe, expect, it } from 'vitest';
import { appVersionOf, isRelease } from './appVersion.js';

describe('app version', () => {
  it('APP_VERSION wins, then build-meta.json, then package.json, without a leading v', () => {
    const files = { buildMeta: { version: 'v1.0.2' }, packageMeta: { version: '1.0.1' } };
    expect(appVersionOf({ env: { APP_VERSION: 'v.1.0.3' }, ...files })).toBe('1.0.3');
    expect(appVersionOf({ env: {}, ...files })).toBe('1.0.2');
    expect(appVersionOf({ env: {}, packageMeta: { version: '1.0.1' } })).toBe('1.0.1');
    expect(appVersionOf({ env: {} })).toBe('0.0.0');
  });

  it('isRelease takes x.y.z only', () => {
    for (const v of ['1.0.0', '1.10.99', '0.0.1']) expect(isRelease(v)).toBe(true);
    for (const v of ['v1.0.0', '1.0', '01.0.0', '1.0.0-rc.1', '', null, 100]) expect(isRelease(v)).toBe(false);
  });
});
