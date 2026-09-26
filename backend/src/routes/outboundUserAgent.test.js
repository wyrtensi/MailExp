// The panel does not name itself to third parties. One-click List-Unsubscribe POSTs go to the
// server of whoever sent the letter, the Gravatar fetch to Gravatar, and category domain lists to
// whatever URL an admin subscribed to; all of them used to say `User-Agent: MailExpert/1.0`.
// They now send no User-Agent of their own, so undici's default ("undici") goes out, which names
// the HTTP library, not the product.
//
// A guard over the source rather than one route test per call site: any outbound request that
// sets a User-Agent naming the product fails here, including one added later.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Requests where the product name is part of the protocol, not a courtesy:
//   updateCheck.js    — our own GitHub releases; the GitHub API refuses requests without a UA.
//   openaiCodexAuth.js — the ChatGPT/Codex login identifies the client app it was registered as.
const ALLOWED = new Set(['services/updateCheck.js', 'services/openaiCodexAuth.js']);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.js') && !name.endsWith('.test.js') ? [path] : [];
  });
}

describe('outbound User-Agent', () => {
  it('no request to a third party names the product', () => {
    const offenders = [];
    for (const path of sourceFiles(srcDir)) {
      const file = relative(srcDir, path).split('\\').join('/');
      if (ALLOWED.has(file)) continue;
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (/['"]?user-agent['"]?\s*:\s*['"`][^'"`]*(mailexpert|mailflow)/i.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself catches the old header', () => {
    const line = "headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MailExpert/1.0' },";
    expect(/['"]?user-agent['"]?\s*:\s*['"`][^'"`]*(mailexpert|mailflow)/i.test(line)).toBe(true);
  });
});
