// Run with: node --test src/utils/composeFromMessage.safeView.test.js
//
// A letter that opens in safe view (R-41, utils/safeView.js) is quoted as its safe text when it is
// replied to or forwarded from the list or the GTD sidebar. There is no "Show in full" there, so a
// letter in Spam, or one EOP marked as phishing, is quoted as text with its link targets written
// out, never as its HTML (its images would load in the composer).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openReplyFromMessage, openForwardFromMessage, safeQuoteOptions } from './composeFromMessage.js';

before(() => {
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
});

function harness(body) {
  let payload = null;
  return {
    openCompose: (p) => { payload = p; },
    getMessageBody: () => Promise.resolve(body),
    payload: () => payload,
  };
}

const body = {
  html: '<p>Please <a href="https://evil.example/login">verify</a></p><img src="https://tracker.example/p.gif">',
  text: 'A harmless text part',
  attachments: [],
};
const folders = [{ path: 'INBOX', name: 'Inbox' }, { path: 'Junk', name: 'Junk', special_use: '\\Junk' }];
const options = (h) => ({
  accounts: [{ id: 'a' }], openCompose: h.openCompose, getMessageBody: h.getMessageBody,
  ...safeQuoteOptions((key) => ({ 'message.safeView.linkTo': 'link to', 'message.safeView.formTo': 'form sends to' })[key], folders),
});
const SAFE_PRE = '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">Please verify [link to evil.example: https://evil.example/login]</pre>';

describe('reply and forward from the list quote the safe text of a letter in safe view', () => {
  it('replies to a letter in Spam with the safe text', async () => {
    const h = harness(body);
    await openReplyFromMessage({ id: 'm', account_id: 'a', folder: 'Junk', from_email: 'x@evil.example', subject: 'Win' }, options(h));
    assert.ok(h.payload().quotedBodyHtml.includes(SAFE_PRE));
    assert.doesNotMatch(h.payload().quotedBodyHtml, /<a |<img /);
    assert.match(h.payload().quotedBody, /> Please verify \[link to evil\.example: https:\/\/evil\.example\/login\]/);
  });

  it('forwards a letter EOP marked as phishing with the safe text, wherever it lies', async () => {
    const h = harness(body);
    await openForwardFromMessage(
      { id: 'm', account_id: 'a', folder: 'INBOX', eop_category: 'PHSH', from_email: 'x@evil.example', subject: 'Verify' },
      options(h),
    );
    assert.ok(h.payload().quotedBodyHtml.includes(SAFE_PRE));
    assert.doesNotMatch(h.payload().quotedBodyHtml, /<a |<img /);
  });

  it('reads the category from the body when the row has none', async () => {
    const h = harness({ ...body, eopCategory: 'MALW' });
    await openForwardFromMessage({ id: 'm', account_id: 'a', folder: 'INBOX', subject: 'Invoice' }, options(h));
    assert.ok(h.payload().quotedBodyHtml.includes(SAFE_PRE));
  });

  it('quotes a normal letter as it is', async () => {
    const h = harness(body);
    await openReplyFromMessage({ id: 'm', account_id: 'a', folder: 'INBOX', from_email: 'x@example.com', subject: 'Hi' }, options(h));
    assert.match(h.payload().quotedBodyHtml, /<a href="https:\/\/evil\.example\/login">verify<\/a>/);
    assert.match(h.payload().quotedBody, /> A harmless text part/);
  });
});
