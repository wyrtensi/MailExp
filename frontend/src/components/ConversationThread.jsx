import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { emailFontFor } from '../utils/emailFont.js';
import { createHeightController, forceEagerImages, measureContentHeight } from '../utils/emailFrameHeight.js';
import { conversationSrcDoc, htmlHasQuote, personLabel, recipientsLine, splitTextQuote } from '../utils/conversationView.js';
import DirectionBadge from './DirectionBadge.jsx';
import { useMobile } from '../hooks/useMobile.js';
import { safeViewMarkup, safeViewState } from '../utils/safeView.js';
import SafeViewNotice from './SafeViewNotice.jsx';
import SpamVerdict from './SpamVerdict.jsx';

// The whole conversation stacked under an open letter, the way Gmail shows it: every letter of
// the thread in this mailbox, oldest first. Each letter is a card: its header (sent or received,
// who, to whom, when) and, once expanded, its text with the quoted history hidden until asked
// for. The open letter itself is only marked in its place, since it is shown in full above.
// Shown only while the "Whole conversation" box above is ticked; the box resets on every open.
// A stacked letter in Spam (spamFolderPaths, the open letter's account) or one EOP marked as
// dangerous opens in safe view, like the open letter (utils/safeView.js). In a mail node mailbox
// (nodeMailbox) such a letter in Spam also offers rspamd's verdict (SpamVerdict, R-20).
export default function ConversationThread({ conversation, currentId, onOpen, spamFolderPaths = null, nodeMailbox = false }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const others = conversation.items.filter((item) => item.id !== currentId);
  const [expanded, setExpanded] = useState(() => new Set());
  const allExpanded = others.length > 0 && others.every((item) => expanded.has(item.id));

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section
      aria-label={t('message.senderHistory.threadTitle', { count: conversation.items.length })}
      style={{
        margin: isMobile ? '16px 0 0' : '20px 28px 24px',
        borderTop: '2px solid var(--accent)', paddingTop: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, padding: isMobile ? '0 12px' : 0 }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('message.senderHistory.threadTitle', { count: conversation.items.length })}
        </h3>
        {others.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(others.map((item) => item.id)))}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, fontWeight: 500, padding: 4 }}
          >
            {allExpanded ? t('message.senderHistory.threadCollapseAll') : t('message.senderHistory.threadExpandAll')}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {conversation.items.map((item) => (item.id === currentId ? (
          <div key={item.id} style={{
            padding: '8px 14px', borderRadius: 10, border: '1px dashed var(--border)',
            fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <DirectionBadge direction={item.direction} compact={isMobile} />
            <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(item.date, { withYear: !isMobile })}</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t('message.senderHistory.threadCurrent')}</span>
          </div>
        ) : (
          <ThreadLetter
            key={item.id}
            item={item}
            open={expanded.has(item.id)}
            onToggle={() => toggle(item.id)}
            onOpen={() => onOpen(item.id)}
            inSpamFolder={Boolean(spamFolderPaths?.has(item.folder))}
            nodeMailbox={nodeMailbox}
            isMobile={isMobile}
            t={t}
          />
        )))}
      </div>
    </section>
  );
}

function ThreadLetter({ item, open, onToggle, onOpen, inSpamFolder, nodeMailbox, isMobile, t }) {
  const to = recipientsLine(item.to_addresses, item.cc_addresses);
  return (
    <article className="reading-card" style={{
      border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-secondary)',
      borderLeft: `3px solid ${item.direction === 'out' ? 'var(--accent)' : item.direction === 'in' ? 'var(--green, #22c55e)' : 'var(--border)'}`,
    }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          padding: '10px 14px', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <DirectionBadge direction={item.direction} compact={isMobile} />
          <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {personLabel(item.from_name, item.from_email)}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', fontSize: 12 }}>
            {formatDateTime(item.date, { withYear: !isMobile })}
          </span>
        </div>
        {to && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('message.senderHistory.threadTo')} {to}
          </div>
        )}
        {!open && item.snippet && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.snippet}
          </div>
        )}
      </button>
      {open && <ThreadLetterBody id={item.id} onOpen={onOpen} inSpamFolder={inSpamFolder} nodeMailbox={nodeMailbox} t={t} />}
    </article>
  );
}

// Bodies of stacked letters: at most BODY_LOADS_AT_ONCE requests in flight (an uncached body is
// an IMAP fetch, and "Expand all" on a long thread must not empty the mailbox's connection pool),
// and a loaded body is kept while the page lives, so collapsing and expanding again costs nothing.
const BODY_LOADS_AT_ONCE = 3;
const bodyCache = new Map();
const bodyQueue = [];
let bodyLoadsRunning = 0;

function pumpBodyQueue() {
  while (bodyLoadsRunning < BODY_LOADS_AT_ONCE && bodyQueue.length) {
    const { id, resolve, reject } = bodyQueue.shift();
    bodyLoadsRunning++;
    api.getMessageBody(id)
      .then(resolve, reject)
      .finally(() => { bodyLoadsRunning--; pumpBodyQueue(); });
  }
}

function loadBody(id) {
  if (!bodyCache.has(id)) {
    const promise = new Promise((resolve, reject) => {
      bodyQueue.push({ id, resolve, reject });
      pumpBodyQueue();
    });
    promise.catch(() => bodyCache.delete(id)); // a failed load is tried again next time
    bodyCache.set(id, promise);
  }
  return bodyCache.get(id);
}

function ThreadLetterBody({ id, onOpen, inSpamFolder, nodeMailbox, t }) {
  const [body, setBody] = useState(null);
  const [failed, setFailed] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  // "Show in full" of a letter in safe view; collapsing the letter forgets it.
  const [full, setFull] = useState(false);

  useEffect(() => {
    let live = true;
    setBody(null);
    setFailed(false);
    setFull(false);
    loadBody(id)
      .then((data) => { if (live) setBody(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);

  // Safe view (utils/safeView.js), decided once the body brings the EOP category.
  const safeState = body ? safeViewState({ inSpamFolder, eopCategory: body.eopCategory }) : null;
  const locked = Boolean(safeState?.locked) && !full;
  const safeLabels = useMemo(() => ({ link: t('message.safeView.linkTo'), form: t('message.safeView.formTo') }), [t]);
  const safeMarkup = useMemo(() => (locked ? safeViewMarkup(body, safeLabels) : ''), [locked, body, safeLabels]);
  // "Show in full" moves focus to the letter it reveals.
  const contentRef = useRef(null);
  const focusContentRef = useRef(false);
  useEffect(() => {
    if (!focusContentRef.current || locked || !contentRef.current) return;
    focusContentRef.current = false;
    contentRef.current.focus({ preventScroll: true });
  }, [locked]);
  const showInFull = () => {
    focusContentRef.current = true;
    setFull(true);
  };

  const footer = (hasQuote) => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '8px 14px 12px', fontSize: 13 }}>
      {hasQuote && (
        <button type="button" onClick={() => setShowQuote((v) => !v)} style={linkButton}>
          {showQuote ? t('message.senderHistory.threadHideQuote') : t('message.senderHistory.threadShowQuote')}
        </button>
      )}
      <button type="button" onClick={onOpen} style={linkButton}>{t('message.senderHistory.threadOpen')}</button>
    </div>
  );

  if (failed) {
    return <div style={{ padding: '0 14px 12px', fontSize: 13, color: 'var(--red, #e53e3e)' }}>{t('message.senderHistory.threadBodyFailed')}</div>;
  }
  if (!body) {
    return <div style={{ padding: '0 14px 12px', fontSize: 13, color: 'var(--text-tertiary)' }}>{t('message.senderHistory.threadLoading')}</div>;
  }
  // rspamd's verdict on request, for a letter in Spam of a node mailbox.
  const verdict = inSpamFolder && nodeMailbox && (
    <div style={{ padding: '0 14px' }}>
      <SpamVerdict messageId={id} eopCategory={body.eopCategory} compact />
    </div>
  );
  if (locked) {
    // A letter with attachments only still shows why it is held back.
    return (
      <>
        <div style={{ padding: '0 14px' }}>
          <SafeViewNotice reason={safeState.reason} eopCategory={body.eopCategory} onShowFull={showInFull} compact />
        </div>
        {verdict}
        {(body.html || body.text) && (
          <div
            data-safe-view-body=""
            style={{
              padding: '0 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.6,
              color: '#1a1a1a', background: 'white', fontFamily: 'var(--font-sans, sans-serif)',
            }}
            // One innerHTML write, opted back into translation, as in the open letter's safe view.
            translate="yes"
            dangerouslySetInnerHTML={{ __html: safeMarkup }}
          />
        )}
        {footer(false)}
      </>
    );
  }
  // A spoofed sender outside Spam: a warning over the letter shown as usual.
  const warning = safeState && !safeState.locked && (
    <div style={{ padding: '0 14px' }}>
      <SafeViewNotice reason={safeState.reason} eopCategory={body.eopCategory} compact />
    </div>
  );
  if (body.html) {
    return (
      <>
        {warning}
        {verdict}
        <div ref={contentRef} tabIndex={-1} style={{ padding: '0 14px', background: 'white' }}>
          <LetterFrame html={body.html} showQuote={showQuote} title={t('message.emailFrameTitle')} />
        </div>
        {footer(htmlHasQuote(body.html))}
      </>
    );
  }
  const { main, quote } = splitTextQuote(body.text || '');
  return (
    <>
      {warning}
      {verdict}
      <div ref={contentRef} tabIndex={-1} style={{
        padding: '0 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.6,
        color: '#1a1a1a', background: 'white', fontFamily: 'var(--font-sans, sans-serif)',
      }}>
        <LinkifiedText text={showQuote && quote ? `${main}\n\n${quote}` : main} />
      </div>
      {footer(Boolean(quote))}
    </>
  );
}

// Plain text with its web addresses as links, like the open letter's plain-text body.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
function LinkifiedText({ text }) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{match[0]}</a>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// An HTML letter in a sandboxed frame sized to its content, measured the way the open letter's
// frame is (utils/emailFrameHeight.js): from the content wrapper, never from documentElement,
// whose height is floored by the frame itself, so hiding the quote again shrinks the frame.
// Links open in a real browser tab, as in the open letter; relative ones go nowhere.
function LetterFrame({ html, showQuote, title }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(80);
  const font = useMemo(() => emailFontFor(), []);
  const srcDoc = useMemo(() => conversationSrcDoc(html, { font, showQuote }), [html, font, showQuote]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    const heights = createHeightController();
    let observer = null;
    let clickDoc = null;
    const onClick = (ev) => {
      const anchor = ev.target.closest?.('a[href]');
      if (!anchor) return;
      ev.preventDefault();
      let raw = anchor.getAttribute('href') || '';
      if (raw.startsWith('//')) raw = `https:${raw}`;
      if (/^(?:https?:\/\/|mailto:)/i.test(raw)) window.open(raw, '_blank', 'noopener,noreferrer');
    };
    // A fixed-width newsletter wider than the card (a phone) is scaled down to fit, like the open
    // letter, instead of being cut off on the right.
    const fitWidth = (doc, wrapper) => {
      if (!wrapper) return 1;
      wrapper.style.transform = '';
      wrapper.style.width = '';
      const available = frame.clientWidth;
      const content = Math.max(wrapper.scrollWidth, doc.documentElement.scrollWidth);
      if (!available || content <= available + 1) return 1;
      const scale = available / content;
      wrapper.style.width = `${content}px`;
      wrapper.style.transformOrigin = '0 0';
      wrapper.style.transform = `scale(${scale})`;
      return scale;
    };
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      const wrapper = doc.getElementById('mf-scale-wrapper');
      const scale = fitWidth(doc, wrapper);
      const next = heights.next(measureContentHeight({
        wrapperOffsetHeight: wrapper ? wrapper.offsetHeight : 0,
        wrapperOffsetTop: wrapper ? wrapper.offsetTop : 0,
        bodyScrollHeight: scale === 1 ? doc.body.scrollHeight : 0,
        bodyOffsetHeight: scale === 1 ? doc.body.offsetHeight : 0,
      }), scale);
      if (next !== null) setHeight(Math.max(24, next));
    };
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      heights.reset();
      forceEagerImages(doc);
      clickDoc?.removeEventListener('click', onClick);
      clickDoc = doc;
      doc.addEventListener('click', onClick);
      observer?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(doc.getElementById('mf-scale-wrapper') || doc.body);
      }
      measure();
    };
    frame.addEventListener('load', onLoad);
    // The document may have finished loading before this effect subscribed.
    if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.getElementById('mf-scale-wrapper')) onLoad();
    return () => {
      frame.removeEventListener('load', onLoad);
      clickDoc?.removeEventListener('click', onClick);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      srcDoc={srcDoc}
      scrolling="no"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={title}
      style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height }}
    />
  );
}

const linkButton = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
};
