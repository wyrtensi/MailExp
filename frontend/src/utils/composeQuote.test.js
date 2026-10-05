import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmptyQuoteHtml, quotePayload } from './composeQuote.js';

const QUOTE_TEXT = '\n\nOn Mon, X wrote:\n> old';
const QUOTE_HTML = '<div data-mailexpert-quote-header="en">On Mon, X wrote:</div><blockquote>old</blockquote>';

test('a rich quote the writer kept travels as it is, with its text form', () => {
  assert.deepEqual(
    quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: QUOTE_HTML }),
    { quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML },
  );
});

test('a rich quote the writer edited travels as edited', () => {
  const edited = '<blockquote>kept part</blockquote>';
  assert.deepEqual(
    quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: edited }),
    { quotedBody: QUOTE_TEXT, quotedBodyHtml: edited },
  );
});

test('a rich quote the writer deleted is sent empty, without the plain-text quote to fall back on', () => {
  for (const left of ['', '<br>', '<div><br></div>', ' &nbsp; ', '<p>\u200b</p>', '<blockquote><!-- x --></blockquote>']) {
    assert.deepEqual(
      quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: left }),
      { quotedBodyHtml: '' },
      `left behind: ${JSON.stringify(left)}`,
    );
  }
});

test('a rich quote holding only an image is not empty', () => {
  const img = '<p><img src="cid:a"></p>';
  assert.equal(isEmptyQuoteHtml(img), false);
  assert.deepEqual(
    quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: img }),
    { quotedBody: QUOTE_TEXT, quotedBodyHtml: img },
  );
});

test('before the rich quote is mounted, the original rich quote is used', () => {
  assert.deepEqual(
    quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: null }),
    { quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML },
  );
});

test('plain-text compose sends only the plain quote, as the writer left it', () => {
  assert.deepEqual(
    quotePayload({ plaintextEmail: true, quotedBody: QUOTE_TEXT, quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: null }),
    { quotedBody: QUOTE_TEXT },
  );
  assert.deepEqual(
    quotePayload({ plaintextEmail: true, quotedBody: '', quotedBodyHtml: QUOTE_HTML, liveQuoteHtml: null }),
    {},
  );
});

test('a rich compose without a rich quote keeps the plain quote', () => {
  assert.deepEqual(
    quotePayload({ plaintextEmail: false, quotedBody: QUOTE_TEXT, quotedBodyHtml: null, liveQuoteHtml: null }),
    { quotedBody: QUOTE_TEXT },
  );
  assert.deepEqual(quotePayload({ plaintextEmail: false, quotedBody: '', quotedBodyHtml: null, liveQuoteHtml: null }), {});
});
