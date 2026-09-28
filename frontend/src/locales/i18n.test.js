/**
 * i18n locale test — run with: node --test src/locales/i18n.test.js
 *
 * SUITE 1 — source coverage
 *   Every key in the locale files must be referenced at least once in the
 *   frontend source. Keys with no reference are dead and should be removed.
 *   Fix dead keys before fixing missing translations (Suite 2) — otherwise
 *   you'll add translations for keys that should be deleted.
 *
 *   Failure example:
 *     ✖ no unused keys
 *       Unused keys (remove from all locale files or add a source reference):
 *         - admin.rules.legacyTitle
 *
 *   Fix A — remove: delete the key from every locale file if it is genuinely dead.
 *
 *   Fix B — keep: if the key is referenced dynamically (e.g. via a variable passed
 *   to t()), add it to DYNAMIC_KEYS so the test does not flag it:
 *
 *     const DYNAMIC_KEYS = new Set([
 *       'admin.tabs.accounts',   // t(tab.labelKey) where labelKey is set at runtime
 *     ]);
 *
 *   The test scans for the key string anywhere in *.js / *.jsx files under src/,
 *   excluding the locale files themselves. A key counts as referenced if it
 *   appears literally in the source — even in a comment or property assignment.
 *
 * SUITE 2 — key coverage
 *   Every key present in any locale file must exist in all locale files.
 *
 *   Failure example:
 *     ✖ ru has no missing keys
 *       Missing keys:
 *         - admin.rules.title
 *
 *   Fix: open ru.json, navigate to admin → rules and add the missing key
 *   with a proper translation. Do NOT copy the English value — translate it.
 *   The dotted path admin.rules.title maps to { "admin": { "rules": { "title": "…" } } }.
 *   Create parent sections if they don't exist yet.
 *
 * SUITE 3 — value uniqueness
 *   For each key, every locale must have a distinct translated value.
 *   Two locales sharing the same string usually means one was never translated.
 *
 *   Failure example:
 *     ✖ admin.sso.allowInsecure
 *       Unexpected duplicate values:
 *         en = ru: "Allow local / self-signed connections"
 *
 *   Fix A — translate: open ru.json and replace the English string with
 *   the Russian translation.
 *
 *   Fix B — whitelist: if the strings are legitimately identical (see below),
 *   add an entry to SAME_VALUE_ALLOWED:
 *
 *     'some.key': 'any'              // brand name / placeholder, same everywhere
 *     'some.key': [['en', 'ru']]     // only this pair may share a value
 *
 * SUITE 4 — hardcoded user-facing strings
 *   JSX source must not contain user-visible string literals outside of t().
 *   Two patterns are flagged:
 *     A) Attribute values — title="…", placeholder="…", aria-label="…", alt="…"
 *        with a plain string instead of {t('…')}
 *     B) Text nodes — natural-language text between JSX tags not in { }
 *
 *   Failure example:
 *     ✖ no hardcoded user-facing strings
 *       Hardcoded strings found (wrap in t() and add a locale key):
 *         ComposeModal.jsx:1038  title="Minimize"
 *
 *   Fix:
 *     1. Replace the hardcoded value with a t() call:
 *          Before: title="Minimize"
 *          After:  title={t('compose.toolbar.minimize')}
 *     2. Add the key to en.json with the English string.
 *     3. Run the locale tests — Suite 2 will report that ru.json
 *        now needs the key. Translate it there.
 *
 *   If a string is intentionally hardcoded (technical term, placeholder, brand
 *   name) add it to HARDCODED_OK with a short comment explaining why.
 *
 * WHEN TO TRANSLATE vs WHITELIST
 *   Translate when the value is a regular word or sentence with a natural
 *   equivalent in the target language.
 *
 *   Whitelist when:
 *   - Brand names / proper nouns (Gmail, iCloud, Outlook)
 *   - Hostnames, URLs, UUID-format placeholders (imap.gmail.com, xxxxxxxx-…)
 *   - Technical abbreviations used internationally (SSO, Cc, Bcc, Port)
 *   - A term Russian uses as-is: "SSO", "Email"
 *
 *   When in doubt, translate. Whitelist only when a translation would produce
 *   the identical string anyway.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';

const dir = dirname(fileURLToPath(import.meta.url));

// Keys where identical values across some locales are intentional.
//
// 'any'          — all locales may share this value (brand names, universal placeholders)
// [['a','b',...]]— only these specific language groups may share a value
//
// Two locales sharing a value is only allowed if both appear in the same group.
// Any unlisted pair will still fail.
const SAME_VALUE_ALLOWED = {
  // ── Universal placeholders / brand names (all locales share) ───────────────
  'admin.ai.subscriptionProviderChatgpt':    'any', // ChatGPT Plus/Pro (Codex Subscription) — product name, same everywhere
  'admin.categories.gtdReveal':             'any', // "GTD" — brand-like acronym, same everywhere
  'admin.accounts.imapHostPh':              'any', // imap.gmail.com
  'admin.accounts.add.emailPh':              'any', // name@gmail.com
  'admin.accounts.add.gmailTitle':           'any', // Gmail — the tab of "Add account", a product name
  'admin.accounts.presetIcloud':            'any', // iCloud
  'admin.accounts.presetYahoo':             'any', // Yahoo Mail
  'admin.accounts.smtpHostPh':              'any', // smtp.gmail.com
  'admin.ai.baseUrlPh':                      'any', // http://localhost:11434/v1
  'admin.ai.chatgptModelPh':                 'any', // gpt-5.6-luna
  'admin.appearance.customCssPlaceholder':   'any', // CSS code snippet, same in all locales
  'admin.integrations.microsoft.clientIdPh':'any', // xxxxxxxx-xxxx-…
  'admin.integrations.microsoft.title':     'any', // Microsoft 365 / Outlook.com
  'admin.integrations.google.title':        'any', // Google / Gmail — brand names
  'admin.integrations.googleApps.clientIdPh': 'any', // 1234567890-abc123.apps.googleusercontent.com
  'admin.security.totpVerifyPh':            'any', // 000000
  'admin.sso.adminGroupClaimPh':            'any', // groups
  'admin.sso.adminGroupValuePh':            'any', // mailexpert-admins
  'admin.sso.issuerUrlPh':                  'any', // https://accounts.google.com
  'admin.sso.scopesPh':                     'any', // openid email profile
  'login.totp.placeholder':                 'any', // 000000
  'contacts.auto':                          'any', // "auto" — universal technical loanword
  'admin.categories.urlSubPh':              'any', // URL placeholder
  'gtd.title':                              'any', // "GTD" — acronym (Getting Things Done)
  'shortcuts.groups.gtd':                   'any', // "GTD" — acronym group heading
  'admin.integrations.todoist.title':       'any', // Todoist — brand name
  'message.threading.messageId':            'any', // RFC 5322 header name, same in all locales
  'message.threading.inReplyTo':            'any', // RFC 5322 header name, same in all locales
  'message.threading.references':           'any', // RFC 5322 header name, same in all locales

  // ── English and Russian share the value ───────────────────────────────────
  // "SSO" — acronym, same in en and ru
  'admin.tabs.sso': [['en', 'ru']],
  // "Email" — international term used as-is in en and ru
  'contacts.fields.email': [['en', 'ru']],
  // email and domain placeholders — example addresses look the same in en and ru
  'admin.accounts.emailPh': [['en', 'ru']],
  'admin.aliases.emailPh': [['en', 'ru']],
  'admin.privacy.addDomainPh': [['en', 'ru']],
  'admin.privacy.addSenderPh': [['en', 'ru']],
  'admin.security.recoveryEmailPh': [['en', 'ru']],
  'admin.sso.domainsPh': [['en', 'ru']],
  'admin.users.invitePh': [['en', 'ru']],
  'compose.bccPh': [['en', 'ru']],
  'compose.ccPh': [['en', 'ru']],
  'compose.toPh': [['en', 'ru']],
  'contacts.websitePh': [['en', 'ru']],
};

// Locale-specific plural forms are allowed per locale. A locale may add forms
// required by its Intl.PluralRules categories without forcing every other locale
// to carry unused keys. Existing locale files may also define their own forms.
const LOCALE_SPECIFIC_KEYS_BY_LOCALE = {
  ru: new Set([
    'message.attachment_few', 'message.attachment_many',
    'messageList.bulkDeleted.title_few', 'messageList.bulkDeleted.title_many',
    'messageList.bulkDeleted.failBody_few', 'messageList.bulkDeleted.failBody_many',
    'messageList.bulkMoved.title_few', 'messageList.bulkMoved.title_many',
    'messageList.bulkMoved.failBody_few', 'messageList.bulkMoved.failBody_many',
    'messageList.bulkArchived.title_few', 'messageList.bulkArchived.title_many',
    'messageList.bulkArchived.failBody_few', 'messageList.bulkArchived.failBody_many',
    'sidebar.hiddenFolders_few', 'sidebar.hiddenFolders_many',
    'admin.messageList.markReadDelaySeconds_few', 'admin.messageList.markReadDelaySeconds_many',
    'admin.categories.domainCount_few', 'admin.categories.domainCount_many',
    'admin.categories.fetchedOk_few', 'admin.categories.fetchedOk_many',
    'spam.failBodyBulk_few', 'spam.failBodyBulk_many',
    'contacts.count_few', 'contacts.count_many',
    'message.senderHistory.summary_few', 'message.senderHistory.summary_many',
    'message.senderHistory.more_few', 'message.senderHistory.more_many',
    'message.senderHistory.threadTitle_few', 'message.senderHistory.threadTitle_many',
    'message.threading.conversationCount_few', 'message.threading.conversationCount_many',
    'message.moveReverted.title_few', 'message.moveReverted.title_many',
    'message.moveReverted.body_few', 'message.moveReverted.body_many',
  ]),
};
const LOCALE_SPECIFIC_KEYS = new Set(
  Object.values(LOCALE_SPECIFIC_KEYS_BY_LOCALE).flatMap(keys => [...keys]),
);

// Keys referenced dynamically (via a variable passed to t()) that cannot be
// found by a plain text search of the source. Add here to suppress false
// "unused key" failures.
const DYNAMIC_KEYS = new Set([
  // t(tab.labelKey) — labelKey is a string property set in the TABS array
  'admin.tabs.accounts',
  'admin.tabs.rules',
  'admin.tabs.appearance',
  'admin.tabs.integrations',
  'admin.tabs.users',
  'admin.tabs.sso',
  'admin.tabs.security',
  'admin.tabs.notifications',
  'admin.tabs.shortcuts',
  'admin.tabs.about',
  'admin.tabs.categories',
  'admin.tabs.audit',
  // t(group.labelKey) — labelKey is a string property set in the TAB_GROUPS array
  'admin.tabs.groupAccountMail',
  'admin.tabs.groupDisplay',
  'admin.tabs.groupSecurityIntegrations',
  'admin.tabs.groupAdmin',
  // t(`messageList.categories.${cat}`) — category tab labels referenced via template literal
  'messageList.categories.primary',
  'messageList.categories.newsletter',
  'messageList.categories.promotion',
  'messageList.categories.automated',
  'messageList.categories.social',
  // t(`gtd.state.${state}`) — GTD state labels referenced via template literal for
  // the merged-Waiting kind chip and the classify submenu (watch/delegated never
  // appear as literals; the other three do via the tab pills).
  'gtd.state.watch',
  'gtd.state.delegated',
  // Attachment risk badges (MessagePane): t(`message.attachmentRisk.${risk.level}`),
  // where the level comes from classifyAttachmentRisk.
  'message.attachmentRisk.block', 'message.attachmentRisk.warn', 'message.attachmentRisk.notice',
  // t(`compose.smtpConnectionReasons.${err.reason}`) — reason comes from the send route's
  // smtp_connection_failed response (ComposeModal.jsx handleSend).
  'compose.smtpConnectionReasons.timeout', 'compose.smtpConnectionReasons.refused',
  'compose.smtpConnectionReasons.not_found', 'compose.smtpConnectionReasons.unreachable',
  'compose.smtpConnectionReasons.tls', 'compose.smtpConnectionReasons.unknown',
]);

// JSX attribute names whose values must never be plain strings — always t().
const I18N_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

// Plain strings that are intentionally NOT translated (technical terms,
// brand names, format placeholders). Add with a comment explaining why.
const HARDCODED_OK = new Set([
  // CSS/DOM placeholder for a variable-name input field — not a sentence
  'value',
  // Tooltip label for a rich-text editor colour input — purely visual affordance,
  // identical concept in all languages
  'Emoji',
  // "MailExpert" brand name split into two spans for typography styling
  'Mail', 'Expert',
  // Email header labels inside the handlePrint() HTML template literal —
  // translating them requires passing t() results into the template string
  'From:', 'Date:',
  // Standard email forwarding header used internationally (RFC convention)
  '---------- Forwarded message ----------',
  // Search-syntax example shown inside a <code> tag — demonstrating format, not UI text
  'from:amazon invoice',
  // Beta badge label — universally understood technical term, same in all languages
  'BETA',
]);

// Matches: someAttr="string value" (not someAttr={...})
const attrStringRe = new RegExp(
  String.raw`\b(${I18N_ATTRS.join('|')})="([^"]+)"`, 'g'
);

// Matches text directly between a closing > and an opening </ on the same line,
// (i.e. a JSX text node immediately before a closing tag). Using </ rather than <
// avoids false positives from JS arrow functions (=>) and comparison operators (<=).
const textNodeRe = />([^<>{}]+)<\//g;

function looksLikeUserText(str) {
  const s = str.trim();
  if (s.length < 4) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;         // URL
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return false;  // all-lowercase identifier
  if (/^\d/.test(s)) return false;                   // starts with digit
  if (/[()]/.test(s)) return false;                  // parenthesised (SMTP options, JS calls)
  if (/\|\||&&/.test(s)) return false;               // JS logical operators
  // flag if multiword OR starts with uppercase (sentence / proper label)
  return s.includes(' ') || /^[A-Z]/.test(s);
}

function scanHardcodedStrings() {
  const srcRoot = resolve(dir, '../..');
  const violations = [];

  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (full === dir) continue; // skip locales/
        walk(full);
      } else if (entry.name.endsWith('.jsx')) {
        const lines = readFileSync(full, 'utf8').split('\n');
        const rel = full.replace(srcRoot + '/', '');
        lines.forEach((line, i) => {
          const stripped = line.replace(/^\s*\/\/.*$/, ''); // skip full-line comments

          // A) JSX attribute values
          for (const m of stripped.matchAll(attrStringRe)) {
            const val = m[2];
            if (looksLikeUserText(val) && !HARDCODED_OK.has(val)) {
              violations.push(`  ${rel}:${i + 1}  ${m[1]}="${val}"`);
            }
          }

          // B) JSX text nodes
          for (const m of stripped.matchAll(textNodeRe)) {
            const val = m[1].trim();
            if (looksLikeUserText(val) && !HARDCODED_OK.has(val)) {
              violations.push(`  ${rel}:${i + 1}  text: "${val}"`);
            }
          }
        });
      }
    }
  }
  walk(srcRoot);
  return violations;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      Object.assign(out, flatten(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

function loadLocales() {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const locales = {};
  for (const file of files) {
    const lang = file.replace('.json', '');
    locales[lang] = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
  return locales;
}

// i18next resolves t('base', { count }) to base_one / base_other at runtime.
// Strip known plural suffixes before searching — if the base key is in the
// source the plural form is considered referenced.
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
function baseKey(key) {
  for (const s of PLURAL_SUFFIXES) {
    if (key.endsWith(s)) return key.slice(0, -s.length);
  }
  return key;
}

function loadSourceText() {
  const srcRoot = resolve(dir, '../..');
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (full === dir) continue; // skip locales/
        walk(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
        out.push(readFileSync(full, 'utf8'));
      }
    }
  }
  walk(srcRoot);
  return out.join('\n');
}

function loadLiteralSourceTranslationKeys(prefix) {
  const srcRoot = resolve(dir, '../..');
  const keys = new Set();
  const literalTranslationCall = /(?<![\w$.])t\(\s*['"]([^'"]+)['"]/g;

  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (full === dir) continue; // skip locales/
        walk(full);
      } else if (
        (entry.name.endsWith('.js') || entry.name.endsWith('.jsx'))
        && !entry.name.includes('.test.')
      ) {
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(literalTranslationCall)) {
          if (match[1].startsWith(prefix)) keys.add(match[1]);
        }
      }
    }
  }

  walk(srcRoot);
  return [...keys].sort();
}

function isAllowedPair(key, lang1, lang2) {
  const rule = SAME_VALUE_ALLOWED[key];
  if (!rule) return false;
  if (rule === 'any') return true;
  return rule.some(group => group.includes(lang1) && group.includes(lang2));
}

// ── tests ─────────────────────────────────────────────────────────────────────

const locales = loadLocales();
const langs = Object.keys(locales).sort();
const allKeys = [...new Set(langs.flatMap(l => Object.keys(locales[l])))].filter(k => !LOCALE_SPECIFIC_KEYS.has(k)).sort();

describe('i18n locale files', () => {

  it('places sender favicon setting copy under the admin message-list namespace', () => {
    const keys = [
      'senderFavicons',
      'senderFaviconsDesc',
      'senderFaviconsSaveError',
    ];
    for (const lang of langs) {
      for (const key of keys) {
        assert.equal(typeof locales[lang][`admin.messageList.${key}`], 'string',
          `${lang} is missing admin.messageList.${key}`);
        assert.equal(locales[lang][`messageList.${key}`], undefined,
          `${lang} has misplaced messageList.${key}`);
      }
    }
  });

  describe('source coverage — every key must be referenced in the source', () => {
    it('no unused keys', () => {
      const source = loadSourceText();
      const unused = allKeys.filter(k => !DYNAMIC_KEYS.has(k) && !source.includes(baseKey(k)));
      for (const [owner, keys] of Object.entries(LOCALE_SPECIFIC_KEYS_BY_LOCALE)) {
        for (const key of keys) {
          assert.equal(typeof locales[owner]?.[key], 'string', `${owner} is missing locale-specific key ${key}`);
          assert.notEqual(locales[owner][key], '', `${owner} locale-specific key ${key} is empty`);
          assert.equal(source.includes(baseKey(key)), true, `locale-specific key ${key} is not referenced via its base key`);
        }
      }
      assert.equal(unused.length, 0,
        `Unused keys (remove from all locale files or add to DYNAMIC_KEYS if referenced dynamically):\n${unused.map(k => `  - ${k}`).join('\n')}`);
    });

    it('every literal admin.ai source translation key exists in every locale', () => {
      const sourceKeys = loadLiteralSourceTranslationKeys('admin.ai.');
      const missing = [];
      for (const lang of langs) {
        const present = new Set(Object.keys(locales[lang]));
        for (const key of sourceKeys) {
          const hasKey = present.has(key)
            || PLURAL_SUFFIXES.some(suffix => present.has(`${key}${suffix}`));
          if (!hasKey) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0,
        `Literal source translation keys missing from locale files:\n${missing.join('\n')}`);
    });

    it('every OAuth result key mapped in utils/googleOAuth.js exists in every locale', () => {
      // parseOAuthResult returns keys that are later passed to t() through a variable,
      // so they are collected from the string literals of the mapping module.
      const source = readFileSync(resolve(dir, '../utils/googleOAuth.js'), 'utf8');
      const keys = [...new Set([...source.matchAll(/'(admin\.integrations\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 12, `expected the Google result/error keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `OAuth result keys missing from locale files:\n${missing.join('\n')}`);
    });

    it('every key used by the add-account dialog exists in every locale', () => {
      // Option, badge and error keys come from utils/addAccount.js and reach t() through a
      // variable, so every quoted literal of the dialog files is collected.
      const source = ['../components/AddAccountTabs.jsx', '../components/GmailAddForm.jsx', '../components/DomainMailboxAddForm.jsx', '../utils/addAccount.js']
        .map(file => readFileSync(resolve(dir, file), 'utf8')).join('\n');
      const keys = [...new Set([...source.matchAll(/'((?:admin\.accounts\.add|admin\.integrations\.google)\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 20, `expected the add-account keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Add-account keys missing from locale files:\n${missing.join('\n')}`);
    });

    it('every Google apps key used by the admin screen exists in every locale', () => {
      // State, action and error keys come from utils/googleApps.js and are translated through
      // a variable, so every quoted literal of both files is collected.
      const source = ['../components/GoogleAppsSection.jsx', '../utils/googleApps.js']
        .map(file => readFileSync(resolve(dir, file), 'utf8')).join('\n');
      const keys = [...new Set([...source.matchAll(/'(admin\.integrations\.googleApps\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 40, `expected the Google apps keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Google apps keys missing from locale files:\n${missing.join('\n')}`);
    });

    it('every sidebar mailbox filter key used in Sidebar.jsx exists in every locale', () => {
      // A t() call with a key absent from every locale is not caught by the unused-key
      // scan above, so the filter keys are checked against the source explicitly.
      const source = readFileSync(resolve(dir, '../components/Sidebar.jsx'), 'utf8');
      const keys = [...new Set([...source.matchAll(/'(sidebar\.accountFilter\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 3, `expected the mailbox filter keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Mailbox filter keys missing from locale files:\n${missing.join('\n')}`);
    });

    it('every account health key in utils/accountHealth.js and Sidebar.jsx exists in every locale', () => {
      // Health labels are looked up through HEALTH_LABEL_KEYS, so the literals of the
      // mapping module are collected together with the direct t() calls in the sidebar.
      const sources = ['../utils/accountHealth.js', '../components/Sidebar.jsx']
        .map(file => readFileSync(resolve(dir, file), 'utf8')).join('\n');
      const keys = [...new Set([...sources.matchAll(/'(sidebar\.health\.[\w.]+)'/g)].map(m => m[1]))];
      assert.ok(keys.length >= 7, `expected the account health keys, found ${keys.length}`);
      const missing = [];
      for (const lang of langs) {
        for (const key of keys) {
          if (typeof locales[lang][key] !== 'string' || !locales[lang][key]) missing.push(`  - ${lang}: ${key}`);
        }
      }
      assert.equal(missing.length, 0, `Account health keys missing from locale files:\n${missing.join('\n')}`);
    });
  });

  describe('key coverage — every key must appear in every locale', () => {
    for (const lang of langs) {
      it(`${lang} has no missing keys`, () => {
        const present = new Set(Object.keys(locales[lang]));
        const missing = allKeys.filter(k => !present.has(k));
        assert.equal(missing.length, 0,
          `Missing keys:\n${missing.map(k => `  - ${k}`).join('\n')}`);
      });
    }
  });

  describe('value uniqueness — no unlisted locale pair should share a value for the same key', () => {
    for (const key of allKeys) {
      it(key, () => {
        // group languages by value
        const valueToLangs = new Map();
        for (const lang of langs) {
          const val = locales[lang]?.[key];
          if (val === undefined) continue;
          if (!valueToLangs.has(val)) valueToLangs.set(val, []);
          valueToLangs.get(val).push(lang);
        }

        const violations = [];
        for (const [val, langsWithVal] of valueToLangs) {
          if (langsWithVal.length < 2) continue;
          for (let i = 0; i < langsWithVal.length; i++) {
            for (let j = i + 1; j < langsWithVal.length; j++) {
              const [l1, l2] = [langsWithVal[i], langsWithVal[j]];
              if (!isAllowedPair(key, l1, l2)) {
                violations.push(`  ${l1} = ${l2}: ${JSON.stringify(val)}`);
              }
            }
          }
        }

        assert.equal(violations.length, 0,
          `Unexpected duplicate values (add to SAME_VALUE_ALLOWED if intentional):\n${violations.join('\n')}`);
      });
    }
  });

  describe('hardcoded strings — user-visible text must go through t()', () => {
    it('no hardcoded user-facing strings', () => {
      const violations = scanHardcodedStrings();
      assert.equal(violations.length, 0,
        `Hardcoded strings found (wrap in t() and add a locale key, or add to HARDCODED_OK if intentional):\n${violations.join('\n')}`);
    });
  });

});

describe('Russian plural forms', () => {
  it('every English plural key has one/few/many/other forms in Russian', () => {
    const englishBases = [...new Set(Object.keys(locales.en)
      .filter(key => /_(one|other)$/.test(key))
      .map(baseKey))];
    const missing = [];
    for (const base of englishBases) {
      for (const form of ['one', 'few', 'many', 'other']) {
        if (typeof locales.ru[`${base}_${form}`] !== 'string') missing.push(`  - ${base}_${form}`);
      }
    }
    assert.equal(missing.length, 0, `Russian plural forms missing:\n${missing.join('\n')}`);
  });

  it('selects one/few/many forms for representative Russian counts', async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'ru',
      fallbackLng: false,
      resources: {
        ru: { translation: JSON.parse(readFileSync(join(dir, 'ru.json'), 'utf8')) },
      },
      interpolation: { escapeValue: false },
    });

    const expected = new Map([
      [0, '0 вложений'],
      [1, '1 вложение'],
      [2, '2 вложения'],
      [4, '4 вложения'],
      [5, '5 вложений'],
      [11, '11 вложений'],
      [21, '21 вложение'],
      [22, '22 вложения'],
      [25, '25 вложений'],
      [111, '111 вложений'],
    ]);

    for (const [count, value] of expected) {
      assert.equal(instance.t('message.attachment', { count }), value, `count=${count}`);
    }
  });
});
