// Tailwind's preflight sets list-style: none on every list, so AI output rendered as markdown
// (.ai-markdown) showed its bullet and numbered lists without markers. The stylesheet must give
// them back.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

describe('.ai-markdown list markers', () => {
  it('shows bullets on unordered lists and circles on nested ones', () => {
    assert.match(declarations('.ai-markdown ul'), /list-style-type:\s*disc/);
    assert.match(declarations('.ai-markdown ul ul'), /list-style-type:\s*circle/);
  });

  it('shows numbers on ordered lists', () => {
    assert.match(declarations('.ai-markdown ol'), /list-style-type:\s*decimal/);
  });
});
