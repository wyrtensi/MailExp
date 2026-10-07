import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAILCOW_VERSION_FILES, parseMailcowVersion, pinnedMailcow } from './nodeAgent.js';

describe('the pinned mailcow version (deploy/mailcow-version)', () => {
  it('reads the tag and the full commit, comments and other keys aside', () => {
    expect(parseMailcowVersion('# a comment\nMAILCOW_TAG=2026-09a\r\nOTHER=x\nMAILCOW_COMMIT=81f6f7b002f2681b732aed74ae53179377def5e0\n'))
      .toEqual({ tag: '2026-09a', commit: '81f6f7b002f2681b732aed74ae53179377def5e0' });
  });

  it('refuses a short commit, a tag with other characters, or a missing key', () => {
    expect(parseMailcowVersion('MAILCOW_TAG=2026-09a\nMAILCOW_COMMIT=81f6f7b0\n')).toBeNull();
    expect(parseMailcowVersion('MAILCOW_TAG=2026 09a\nMAILCOW_COMMIT=81f6f7b002f2681b732aed74ae53179377def5e0\n')).toBeNull();
    expect(parseMailcowVersion('MAILCOW_COMMIT=81f6f7b002f2681b732aed74ae53179377def5e0\n')).toBeNull();
    expect(parseMailcowVersion(undefined)).toBeNull();
  });

  it('takes the first readable file: the image copy, then the repository file', () => {
    const files = {
      '/app/mailcow-version': null,
      '/repo/deploy/mailcow-version': 'MAILCOW_TAG=2026-09\nMAILCOW_COMMIT=ca07d8d3331849ae294179aedce95c8126d3050f\n',
    };
    const read = (file) => {
      if (files[file] == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[file];
    };
    expect(pinnedMailcow({ files: Object.keys(files), read }))
      .toEqual({ tag: '2026-09', commit: 'ca07d8d3331849ae294179aedce95c8126d3050f' });
    expect(pinnedMailcow({ files: ['/nowhere'], read })).toBeNull();
  });

  it('the repository pins a release', () => {
    const repoFile = MAILCOW_VERSION_FILES[MAILCOW_VERSION_FILES.length - 1];
    expect(pinnedMailcow()).not.toBeNull();
    expect(parseMailcowVersion(readFileSync(repoFile, 'utf8'))).toEqual(pinnedMailcow());
  });
});
