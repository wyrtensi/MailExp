// Run with: node --test src/utils/safeView.test.js
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { htmlToSafeText, safeTextMarkup, safeViewReason, safeViewText } from './safeView.js';

before(() => {
  // The browser's parser; node has none.
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
});

describe('safeViewReason', () => {
  it('is null for a letter outside Spam without a dangerous EOP category', () => {
    assert.equal(safeViewReason({}), null);
    assert.equal(safeViewReason({ inSpamFolder: false, eopCategory: null }), null);
    // Spam, bulk and the rest file a letter into Spam (R-11); outside it they are a normal letter.
    for (const category of ['SPM', 'HSPM', 'BULK', 'NONE']) {
      assert.equal(safeViewReason({ eopCategory: category }), null, category);
    }
  });

  it('is spam for every letter in the Spam folder', () => {
    assert.equal(safeViewReason({ inSpamFolder: true }), 'spam');
    assert.equal(safeViewReason({ inSpamFolder: true, eopCategory: 'BULK' }), 'spam');
  });

  it('names the danger from the EOP category in any folder', () => {
    for (const category of ['PHSH', 'HPHSH', 'HPHISH']) {
      assert.equal(safeViewReason({ eopCategory: category }), 'phishing', category);
    }
    assert.equal(safeViewReason({ eopCategory: 'MALW' }), 'malware');
    assert.equal(safeViewReason({ eopCategory: 'SPOOF' }), 'spoof');
    assert.equal(safeViewReason({ eopCategory: 'phsh' }), 'phishing');
  });

  it('prefers the category over the folder', () => {
    assert.equal(safeViewReason({ inSpamFolder: true, eopCategory: 'HPHISH' }), 'phishing');
  });
});

describe('htmlToSafeText', () => {
  it('writes each link target next to its words', () => {
    const text = htmlToSafeText('<p>Please <a href="https://evil.example/login">verify your bank account</a> today.</p>');
    assert.equal(text, 'Please verify your bank account <https://evil.example/login> today.');
  });

  it('does not repeat a link whose words are its target', () => {
    assert.equal(htmlToSafeText('<a href="https://a.example/">https://a.example/</a>'), 'https://a.example/');
    assert.equal(htmlToSafeText('<a href="mailto:x@y.example">x@y.example</a>'), 'x@y.example');
  });

  it('drops images, styles, scripts and the head', () => {
    const text = htmlToSafeText([
      '<html><head><title>T</title><style>p{color:red}</style></head><body>',
      '<img src="https://tracker.example/p.gif" alt="logo">',
      '<script>alert(1)</script><p>Body</p></body></html>',
    ].join(''));
    assert.equal(text, 'Body');
  });

  it('keeps blocks and line breaks on their own lines and collapses spacing', () => {
    const text = htmlToSafeText('<div>One   two</div><p>Three<br>Four</p><table><tr><td>A</td><td>B</td></tr></table>');
    assert.equal(text, 'One two\n\nThree\nFour\n\nA B');
  });

  it('is empty for nothing', () => {
    assert.equal(htmlToSafeText(''), '');
    assert.equal(htmlToSafeText(null), '');
  });
});

describe('safeViewText', () => {
  it('prefers the letter text part', () => {
    assert.equal(safeViewText({ text: 'Plain part', html: '<p>Html part</p>' }), 'Plain part');
  });

  it('derives the text from the HTML when the text part is blank', () => {
    assert.equal(safeViewText({ text: '  ', html: '<p>Html part</p>' }), 'Html part');
    assert.equal(safeViewText({ text: null, html: '<p>Html part</p>' }), 'Html part');
  });
});

describe('safeTextMarkup', () => {
  it('escapes the text and marks addresses without making them links', () => {
    const markup = safeTextMarkup('Go to https://evil.example/a?b=1&c="2" <now>');
    assert.equal(
      markup,
      'Go to <span class="safe-view-address">https://evil.example/a?b=1&amp;c=</span>&quot;2&quot; &lt;now&gt;',
    );
    assert.doesNotMatch(markup, /<a\b/);
  });

  it('writes markup inside the text as text', () => {
    assert.equal(safeTextMarkup('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  });
});
