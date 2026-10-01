// Run with: node --test src/utils/safeView.test.js
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  describeTarget, safeQuoteSource, safeViewMarkup, safeViewPlainText, safeViewSegments, safeViewState, spamFolderPaths,
} from './safeView.js';

before(() => {
  // The browser's parser; node has none.
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
});

const cp = (code) => String.fromCodePoint(code);
const RLO = cp(0x202E);
const ZWSP = cp(0x200B);
const CYRILLIC_ER = cp(0x440); // looks like a Latin "p"

describe('safeViewState', () => {
  it('is null for a letter outside Spam without a dangerous EOP category', () => {
    assert.equal(safeViewState({}), null);
    // Spam, bulk and the rest file a letter into Spam (R-11); outside it they are a normal letter.
    for (const category of ['SPM', 'HSPM', 'BULK', 'NONE', 'OSPM']) {
      assert.equal(safeViewState({ eopCategory: category }), null, category);
    }
  });

  it('locks every letter in the Spam folder', () => {
    assert.deepEqual(safeViewState({ inSpamFolder: true }), { reason: 'spam', locked: true });
    assert.deepEqual(safeViewState({ inSpamFolder: true, eopCategory: 'BULK' }), { reason: 'spam', locked: true });
  });

  it('locks phishing, impersonation and malware in any folder', () => {
    for (const category of ['PHSH', 'HPHSH', 'HPHISH', 'INTOS', 'DIMP', 'UIMP', 'GIMP', 'BIMP', 'phsh']) {
      assert.deepEqual(safeViewState({ eopCategory: category }), { reason: 'phishing', locked: true }, category);
    }
    for (const category of ['MALW', 'AMP', 'SAP', 'FTBP']) {
      assert.deepEqual(safeViewState({ eopCategory: category }), { reason: 'malware', locked: true }, category);
    }
    assert.deepEqual(safeViewState({ inSpamFolder: true, eopCategory: 'HPHISH' }), { reason: 'phishing', locked: true });
  });

  it('locks a spoofed sender in Spam and only warns about it elsewhere', () => {
    assert.deepEqual(safeViewState({ inSpamFolder: true, eopCategory: 'SPOOF' }), { reason: 'spoof', locked: true });
    assert.deepEqual(safeViewState({ inSpamFolder: false, eopCategory: 'SPOOF' }), { reason: 'spoof', locked: false });
  });
});

describe('spamFolderPaths', () => {
  it('takes the mapped folder, else \\Junk and Spam-looking names', () => {
    const folders = [
      { path: 'INBOX', name: 'Inbox' },
      { path: '[Gmail]/Spam', name: 'Spam', special_use: '\\Junk' },
      { path: 'Courrier indésirable', name: 'Courrier indésirable' },
    ];
    assert.deepEqual([...spamFolderPaths({}, folders)], ['[Gmail]/Spam', 'Courrier indésirable']);
    assert.deepEqual([...spamFolderPaths({ folder_mappings: { spam: 'Junk' } }, folders)], ['Junk']);
    assert.deepEqual([...spamFolderPaths(null, null)], []);
  });
});

describe('describeTarget', () => {
  it('keeps user info in sight and names the real host', () => {
    assert.deepEqual(describeTarget('https://paypal.com@evil.example/login'), {
      shown: 'https://paypal.com@evil.example/login', full: 'https://paypal.com@evil.example/login', host: 'evil.example',
    });
  });

  it('writes a look-alike host in punycode', () => {
    const { shown, host } = describeTarget(`https://${CYRILLIC_ER}aypal.com/`);
    assert.equal(host, 'xn--aypal-uye.com');
    assert.equal(shown, 'https://xn--aypal-uye.com/');
  });

  it('shows the host a browser would go to when a zero-width character hides in it', () => {
    const { shown, host } = describeTarget(`https://pay${ZWSP}pal.com/`);
    assert.equal(host, 'paypal.com');
    assert.doesNotMatch(shown, new RegExp(ZWSP));
  });

  it('percent-encodes a bidi override and an address glued to another', () => {
    assert.equal(describeTarget(`https://a.example/${RLO}gpj.exe`).shown, 'https://a.example/%E2%80%AEgpj.exe');
    const glued = describeTarget('https://evil.example/a> <https://good.example/');
    assert.equal(glued.host, 'evil.example');
    assert.equal(glued.shown, 'https://evil.example/a%3E%20%3Chttps://good.example/');
  });

  it('spells out an address the parser refuses, invisible characters and all', () => {
    const { shown, host } = describeTarget(`/login${RLO} <x>`);
    assert.equal(host, null);
    assert.equal(shown, '/login[U+202E]%20%3Cx%3E');
  });

  it('names the domain of a mail address and reads protocol-relative links as https', () => {
    assert.equal(describeTarget(`mailto:x@${CYRILLIC_ER}.example`).host, 'xn--p1a.example');
    assert.equal(describeTarget('//evil.example/x').host, 'evil.example');
  });

  it('cuts a very long address and keeps it whole in full', () => {
    const long = `https://evil.example/${'a'.repeat(400)}`;
    const { shown, full } = describeTarget(long);
    assert.equal(full, long);
    assert.equal(shown.length, 201);
    assert.ok(shown.endsWith('…'));
  });
});

describe('safeViewSegments', () => {
  it('takes the HTML whenever there is some, the text part only without it', () => {
    assert.deepEqual(safeViewSegments({ text: 'Harmless text part', html: '<p>What it shows</p>' }), ['What it shows']);
    assert.deepEqual(safeViewSegments({ text: 'Only text', html: '' }), ['Only text']);
  });

  it('makes a link its words and target, and prints the address once when they agree', () => {
    assert.deepEqual(
      safeViewSegments({ html: '<p>Please <a href="https://evil.example/login">verify</a> today.</p>' }),
      ['Please ', { href: 'https://evil.example/login', words: 'verify', form: false }, ' today.'],
    );
    assert.deepEqual(
      safeViewSegments({ html: '<a href="https://a.example/">https://a.example</a>' }),
      [{ href: 'https://a.example/', words: '', form: false }],
    );
  });

  it('shows where a form sends what is typed into it', () => {
    assert.deepEqual(
      safeViewSegments({ html: '<form action="https://evil.example/collect"><p>Password</p><input name="p"></form>' }),
      ['Password\n', { href: 'https://evil.example/collect', words: '', form: true }],
    );
  });

  it('drops images, styles, scripts and the head, and keeps blocks on their own lines', () => {
    assert.deepEqual(safeViewSegments({
      html: '<html><head><style>p{}</style></head><body><img src="https://t.example/p.gif"><script>x()</script>'
        + '<div>One   two</div><p>Three<br>Four</p><table><tr><td>A</td><td>B</td></tr></table></body></html>',
    }), ['One two\n\nThree\nFour\n\nA B']);
  });

  it('shows bidi overrides and drops zero-width characters in the text, text part included', () => {
    assert.deepEqual(safeViewSegments({ html: `<p>invoice${RLO}fdp.exe pay${ZWSP}ment</p>` }), ['invoice[U+202E]fdp.exe payment']);
    assert.deepEqual(safeViewSegments({ text: `invoice${RLO}fdp.exe` }), ['invoice[U+202E]fdp.exe']);
  });

  it('turns the addresses of a text part into targets and keeps its layout', () => {
    assert.deepEqual(safeViewSegments({ text: 'Go:\n  https://evil.example/x\nnow' }), [
      'Go:\n  ', { href: 'https://evil.example/x', words: '', form: false }, '\nnow',
    ]);
  });
});

describe('safeViewMarkup', () => {
  const labels = { link: 'link to', form: 'form sends to' };

  it('labels the target, bolds its host and makes nothing a link', () => {
    const markup = safeViewMarkup({ html: '<a href="https://paypal.com@evil.example/login">PayPal</a>' }, labels);
    assert.equal(markup,
      '<span class="safe-view-words">PayPal</span> '
      + '<span class="safe-view-target" title="https://paypal.com@evil.example/login">'
      + '<span class="safe-view-target-label">link to</span> '
      + '<strong class="safe-view-host" dir="ltr">evil.example</strong> '
      + '<span class="safe-view-address" dir="ltr">https://paypal.com@evil.example/login</span></span>');
    assert.doesNotMatch(markup, /<a\b/);
  });

  it('escapes what the letter says', () => {
    assert.equal(safeViewMarkup({ text: '<img src=x onerror=alert(1)>' }, labels), '&lt;img src=x onerror=alert(1)&gt;');
    const words = safeViewMarkup({ html: '<a href="https://e.example/">&lt;b&gt;"hi"</a>' }, labels);
    assert.match(words, /<span class="safe-view-words">&lt;b&gt;&quot;hi&quot;<\/span>/);
  });
});

describe('safeViewPlainText and safeQuoteSource', () => {
  it('write the target out in brackets', () => {
    const body = { html: '<p>Please <a href="https://evil.example/login">verify</a></p>', text: 'ignored' };
    assert.equal(safeViewPlainText(body), 'Please verify [link to evil.example: https://evil.example/login]');
    const quote = safeQuoteSource(body, { link: 'ссылка на', form: 'форма отправляет на' });
    assert.equal(quote.text, 'Please verify [ссылка на evil.example: https://evil.example/login]');
    assert.equal(quote.html, '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">Please verify [ссылка на evil.example: https://evil.example/login]</pre>');
  });

  it('escape the HTML quote', () => {
    assert.match(safeQuoteSource({ text: '<script>x</script>' }).html, /&lt;script&gt;x&lt;\/script&gt;/);
  });
});
