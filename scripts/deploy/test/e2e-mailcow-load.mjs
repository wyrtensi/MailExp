// Load check of the panel against a real mailcow (scripts/deploy/test/e2e-mailcow.sh --scenario
// load). Runs in the backend image next to the panel, in phases the shell script sequences:
//
//   PHASE=setup      admin, mail node, one domain (marked ready, EOP seats entered), MAILBOXES
//                    mailboxes; time from the first creation until all connected
//   PHASE=delivery   one letter to every mailbox; time until each shows it in MailExpert
//   PHASE=restart    after the script restarted the backend: time until all connected again
//   PHASE=sessions   10 sessions of the shared user: a read flag set in one is seen by the rest
//
// The search scenario adds (letters are generated, not real mail; the same box and index always
// give the same letter, so the phases agree on what was seeded):
//
//   PHASE=users      ten employees, invited by the admin, each with their own login
//   PHASE=seed       writes SEED_COUNT letters per mailbox, from index SEED_FROM, as Maildir files
//                    under /seed/<box>/ for the script to import into mailcow
//   PHASE=bodies     fills body_text of the seeded rows, as if every letter had been opened
//   PHASE=search     the ten employees search, each every 2 seconds, for SEARCH_SECONDS or, with
//                    SEARCH_UNTIL_ROWS, until the panel has that many seeded rows
//
// The work scenario (seeded mail as above, then):
//
//   PHASE=work       the ten employees work in the shared mailboxes for WORK_SECONDS: list, open,
//                    mark read (one and in bulk), move to a folder and back, archive, delete to Trash,
//                    mark spam, search. Twenty mailboxes are hot, so employees meet on the same letters.
//                    Errors while the backend restarts count as 'down', not as failures of the action.
//   PHASE=drain      time until the move queue (message_moves) is empty
//   PHASE=verify     every seeded letter in the panel's database against /seed/server.tsv, the
//                    node's own list (user, mailbox, Message-ID): no letter lost, none twice, each in
//                    the folder the panel shows
//
// Each phase prints one `RESULT {json}` line. Env: PANEL, MAIL_HOST, API_KEY, MAILBOXES, DOMAIN;
// the search and work scenarios also PGHOST, PGUSER, PGPASSWORD, PGDATABASE for the panel's database.
//
// LOAD_KIND=gmail runs the same phases with the mailboxes added the way a Gmail mailbox is: IMAP
// imap.gmail.com:993 and SMTP smtp.gmail.com:587, names the script points at the mailcow node. The
// panel then applies its Gmail rules (provider profile: pool size, background connections per
// host, status on the pool, connect stagger, IMAP_MAX_PERSISTENT_PER_HOST when set). What it cannot
// show: Google's own limits and throttling, OAuth token refresh, X-GM-THRID threading.
import assert from 'node:assert/strict';

const { PANEL, MAIL_HOST, API_KEY, PHASE } = process.env;
const GMAIL = process.env.LOAD_KIND === 'gmail';
const GMAIL_IMAP = 'imap.gmail.com';
const GMAIL_SMTP = 'smtp.gmail.com';
const BOX_PASSWORD = 'e2e-Gmail-like-password-1';
const MAILBOXES = Number(process.env.MAILBOXES || 100);
// GMAIL_MAILBOXES adds Gmail-like mailboxes (gbox000...) next to the node's; the letter generator
// numbers them from GMAIL_BOX_BASE.
const GMAIL_EXTRA = Number(process.env.GMAIL_MAILBOXES || 0);
const ALL_MAILBOXES = MAILBOXES + GMAIL_EXTRA;
const GMAIL_BOX_BASE = 1000;
const DOMAIN = process.env.DOMAIN;
const USER = { username: 'admin', password: 'e2e-admin-password-1' };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const seconds = (ms) => Math.round(ms / 100) / 10;

class Session {
  constructor() { this.cookie = ''; }

  async call(method, path, body, { timeoutMs } = {}) {
    const res = await fetch(`${PANEL}/api${path}`, {
      method,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      headers: {
        'X-Requested-With': 'MailExpert',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  async login(user = USER) {
    const r = await this.call('POST', '/auth/login', user);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return this;
  }
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1] };
}

// The mailboxes under test: the mail node's, the Gmail-like ones, or both with GMAIL_MAILBOXES.
const nodeAccounts = async (s) => (await s.call('GET', '/accounts')).data
  .filter((a) => (GMAIL ? a.imap_host === GMAIL_IMAP : a.mail_node || (GMAIL_EXTRA > 0 && a.imap_host === GMAIL_IMAP)));

// A mailbox created straight in mailcow with a known password, for adding it as a Gmail account.
async function mailcowMailbox(localPart, domain) {
  const res = await fetch(`https://${MAIL_HOST}/api/v1/add/mailbox`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      local_part: localPart, domain, name: localPart, quota: 1024, active: '1',
      password: BOX_PASSWORD, password2: BOX_PASSWORD, force_pw_update: '0', tls_enforce_in: '0', tls_enforce_out: '0',
    }),
  });
  const body = await res.json().catch(() => null);
  const ok = res.ok && Array.isArray(body) && body.every((entry) => entry.type === 'success');
  assert.ok(ok, `mailcow add/mailbox ${localPart}@${domain}: ${res.status} ${JSON.stringify(body)}`);
}

async function addGmailLikeAccount(s, email) {
  return s.call('POST', '/accounts', {
    name: email, email_address: email,
    imap_host: GMAIL_IMAP, imap_port: 993,
    smtp_host: GMAIL_SMTP, smtp_port: 587, smtp_tls: 'STARTTLS',
    auth_user: email, auth_pass: BOX_PASSWORD,
  });
}

// Connected: the row has a first sync and no error. Returns seconds from `since` for each mailbox.
async function waitConnected(s, since, timeoutMs) {
  const done = new Map();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const a of await nodeAccounts(s)) {
      if (!done.has(a.id) && a.last_sync && !a.sync_error && new Date(a.last_sync).getTime() >= since) {
        done.set(a.id, Date.now() - since);
      }
    }
    if (done.size >= ALL_MAILBOXES) break;
    await sleep(1000);
  }
  const errors = (await nodeAccounts(s)).filter((a) => a.sync_error).map((a) => `${a.email_address}: ${a.sync_error}`);
  return { connected: done.size, times: [...done.values()], errors };
}

const result = (data) => console.log(`RESULT ${JSON.stringify({ phase: PHASE, ...data })}`);

// Before anything logs in: the Gmail names must lead to the node, never to the real Gmail.
if (GMAIL || GMAIL_EXTRA) {
  const { resolve4 } = await import('node:dns/promises');
  for (const host of [GMAIL_IMAP, GMAIL_SMTP]) {
    const ips = await resolve4(host);
    assert.deepEqual(ips, [process.env.GMAIL_IP], `${host} resolves to ${ips.join(', ')}, not the node`);
  }
}

if (PHASE === 'setup') {
  const s = new Session();
  let r = await s.call('POST', '/auth/register', USER);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('PATCH', '/admin/settings', { allow_private_hosts: true });
  assert.equal(r.status, 200);
  r = await s.call('PUT', '/mail-node/config', { mailHost: MAIL_HOST, apiKey: API_KEY, quotaMb: 5120 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('POST', '/mail-node/domains', { domain: DOMAIN, mailboxes: ALL_MAILBOXES + 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Onboarding, before the clock starts: the stand has no tenant, so the domain is marked ready the
  // way the panel offers for a pilot or a test stand, and the purchased EOP seats (one per node
  // mailbox) are entered as the Licenses field of the EOP settings.
  r = await s.call('POST', `/mail-node/domains/${DOMAIN}/ready`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('PUT', '/mail-node/eop', { licenses: MAILBOXES + 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('GET', '/mail-node/seats');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.mode === 'manual' && r.data.free >= MAILBOXES, `EOP seats: ${JSON.stringify(r.data)}`);

  const since = Date.now();
  const createMs = [];
  for (let i = 0; i < MAILBOXES; i++) {
    const localPart = `box${String(i).padStart(3, '0')}`;
    if (GMAIL) await mailcowMailbox(localPart, DOMAIN);
    const t0 = Date.now();
    r = GMAIL
      ? await addGmailLikeAccount(s, `${localPart}@${DOMAIN}`)
      : await s.call('POST', '/accounts', { kind: 'domain', localPart, domain: DOMAIN });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    createMs.push(Date.now() - t0);
  }
  for (let i = 0; i < GMAIL_EXTRA; i++) {
    const localPart = `gbox${String(i).padStart(3, '0')}`;
    await mailcowMailbox(localPart, DOMAIN);
    r = await addGmailLikeAccount(s, `${localPart}@${DOMAIN}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const created = Date.now() - since;
  const c = await waitConnected(s, since, 600000);
  result({
    kind: GMAIL ? 'gmail' : 'node',
    mailboxes: MAILBOXES,
    ...(GMAIL_EXTRA ? { gmailMailboxes: GMAIL_EXTRA } : {}),
    createSeconds: seconds(created),
    createPerMailboxMs: percentiles(createMs),
    connected: c.connected,
    connectSeconds: c.times.length ? percentiles(c.times.map(seconds)) : null,
    errors: c.errors.slice(0, 5),
  });
  assert.equal(c.connected, ALL_MAILBOXES, `only ${c.connected} of ${ALL_MAILBOXES} connected`);
}

if (PHASE === 'delivery') {
  const s = await new Session().login();
  const accounts = await nodeAccounts(s);
  const sender = accounts[0];
  const subject = `load ${Date.now()}`;
  const recipients = accounts.map((a) => a.email_address);
  const since = Date.now();
  const r = await s.call('POST', '/mail/send', { accountId: sender.id, to: [sender.email_address], bcc: recipients.slice(1), subject, body: 'Load check.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const seen = new Map();
  const end = Date.now() + 600000;
  while (seen.size < accounts.length && Date.now() < end) {
    await Promise.all(accounts.filter((a) => !seen.has(a.id)).map(async (a) => {
      const { data } = await s.call('GET', `/mail/messages?accountId=${a.id}&folder=INBOX&limit=5`);
      if (data?.messages?.some((m) => m.subject === subject)) seen.set(a.id, Date.now() - since);
    }));
    await sleep(1000);
  }
  const listMs = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    await s.call('GET', '/accounts');
    await s.call('GET', '/mail/unread-counts');
    listMs.push(Date.now() - t0);
  }
  result({
    delivered: seen.size,
    of: accounts.length,
    seenAfterSeconds: seen.size ? percentiles([...seen.values()].map(seconds)) : null,
    accountsAndUnreadMs: percentiles(listMs),
  });
  assert.equal(seen.size, accounts.length, `only ${seen.size} of ${accounts.length} showed the letter`);
}

if (PHASE === 'restart') {
  const since = Number(process.env.RESTARTED_AT);
  const s = await new Session().login();
  const c = await waitConnected(s, since, 1200000);
  result({
    connected: c.connected,
    reconnectSeconds: c.times.length ? percentiles(c.times.map(seconds)) : null,
    errors: c.errors.slice(0, 5),
  });
  assert.equal(c.connected, ALL_MAILBOXES, `only ${c.connected} of ${ALL_MAILBOXES} reconnected`);
}

if (PHASE === 'sessions') {
  const sessions = await Promise.all(Array.from({ length: 10 }, () => new Session().login()));
  const [first] = sessions;
  const accounts = await nodeAccounts(first);
  // Each session works in its own mailbox at the same time, like ten managers.
  const perSession = await Promise.all(sessions.map(async (s, i) => {
    const account = accounts[i % accounts.length];
    const { data } = await s.call('GET', `/mail/messages?accountId=${account.id}&folder=INBOX&limit=50`);
    return { account, message: data.messages[0] };
  }));
  // Session 0 marks its letter read; every other session must see it read.
  const target = perSession[0];
  const r = await first.call('POST', '/mail/messages/bulk-read', { ids: [target.message.id], read: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const views = await Promise.all(sessions.slice(1).map(async (s) => {
    const { data } = await s.call('GET', `/mail/messages?accountId=${target.account.id}&folder=INBOX&limit=50`);
    return data.messages.find((m) => m.id === target.message.id)?.is_read;
  }));
  result({ sessions: sessions.length, othersSeeRead: views.filter(Boolean).length });
  assert.equal(views.every(Boolean), true, 'a session did not see the read flag');
}

// ── Search scenario ─────────────────────────────────────────────────────────

const EMPLOYEES = 10;
const EMPLOYEE_PASSWORD = 'e2e-employee-password-1';
const employee = (i) => ({ username: `emp${String(i + 1).padStart(2, '0')}`, password: EMPLOYEE_PASSWORD });
const SEED_ID_DOMAIN = 'seed.invalid';

// Deterministic letters: mostly Russian business mail with some English, senders from a fixed
// pool of people and companies, 1-6 KB of text, dates over the last two years.
const FIRST = ['Иван', 'Пётр', 'Анна', 'Мария', 'Сергей', 'Ольга', 'Дмитрий', 'Елена', 'Алексей', 'Наталья',
  'Андрей', 'Татьяна', 'Михаил', 'Ирина', 'Николай', 'Светлана', 'Павел', 'Юлия', 'Олег', 'Екатерина'];
const LAST = {
  Петров: 'petrov', Иванов: 'ivanov', Смирнов: 'smirnov', Кузнецов: 'kuznetsov', Попов: 'popov',
  Соколов: 'sokolov', Лебедев: 'lebedev', Козлов: 'kozlov', Новиков: 'novikov', Морозов: 'morozov',
  Волков: 'volkov', Соловьёв: 'soloviev', Васильев: 'vasiliev', Зайцев: 'zaitsev', Павлов: 'pavlov',
  Семёнов: 'semenov', Голубев: 'golubev', Виноградов: 'vinogradov', Богданов: 'bogdanov', Воробьёв: 'vorobiev',
  Фёдоров: 'fedorov', Михайлов: 'mikhailov', Беляев: 'belyaev', Тарасов: 'tarasov', Белов: 'belov',
  Комаров: 'komarov', Орлов: 'orlov', Киселёв: 'kiselev', Макаров: 'makarov', Андреев: 'andreev',
};
const SURNAMES = Object.keys(LAST);
const COMPANIES = Array.from({ length: 60 }, (_, i) => `company${i + 1}.example`);
// The words follow a Zipf law over about 6000 words, as in real text: a few very frequent ones and
// a long tail of rare ones. The words the employees search for stay out of it and go into a fixed
// share of letters instead (see letter()), so a search matches about as much as it would in real mail.
const COMMON = 'и в не на что с по это как к для от о из у за мы вы но а то все так уже бы до'.split(' ');
const BUSINESS = ('поставка договор счёт оплата отгрузка заказ акт сверка склад доставка согласование приложение '
  + 'сроки график встреча звонок проект смета спецификация цена скидка условия контракт партия товар '
  + 'сертификат качество таможня декларация маршрут перевозчик водитель клиент менеджер бухгалтерия директор '
  + 'отдел запрос ответ уточнение подтверждение изменение ошибка срочно важно пожалуйста спасибо уважаемый '
  + 'коллеги прошу направляю высылаю получили оплатили order shipment delivery contract payment quote '
  + 'meeting report schedule agreement').split(' ');
const SYLLABLES = 'ба ве ги до ку ла ме ни по ра се ти фу ха це чи ша бор вел гон дар жук зим кол лот мир нос пар рок сол'.split(' ');
const TAIL = Array.from({ length: 6000 }, (_, i) => SYLLABLES[i % 30] + SYLLABLES[Math.floor(i / 30) % 30]
  + SYLLABLES[Math.floor(i / 900)] + 'н');
const VOCABULARY = [...COMMON, ...BUSINESS, ...TAIL];
const ZIPF = (() => {
  let total = 0;
  const cumulative = VOCABULARY.map((_, rank) => { total += 1 / (rank + 1); return total; });
  return cumulative.map((c) => c / total);
})();
function zipfWord(r) {
  const x = r();
  let lo = 0;
  let hi = ZIPF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ZIPF[mid] < x) lo = mid + 1; else hi = mid;
  }
  return VOCABULARY[lo];
}
const SUBJECTS = [
  (n) => `Счёт №${n} на оплату`, (n) => `Договор поставки ${n}`, (n, w) => `Заказ ${n}: ${w}`,
  (n, w) => `Re: ${w} по заказу ${n}`, (n) => `Акт сверки ${n}`, (n) => `Order ${n}`,
  (n, w) => `Встреча: ${w}`, (n, w) => `Fwd: ${w} ${n}`, (n) => `Отгрузка партии ${n}`, (n, w) => `Вопрос: ${w}`];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function letter(box, index) {
  const r = rng(box * 1000003 + index * 7919 + 17);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const last = pick(SURNAMES);
  const first = pick(FIRST);
  const company = pick(COMPANIES);
  const number = 10000 + Math.floor(r() * 90000);
  const sentences = Array.from({ length: 15 + Math.floor(r() * 50) }, () => {
    const words = Array.from({ length: 6 + Math.floor(r() * 10) }, () => zipfWord(r));
    if (r() < 0.2) words.push(String(10000 + Math.floor(r() * 90000)));
    return words;
  });
  // The searched words: «накладная» in 5% of letters, «претензия» in 4% (half of them with
  // «возврат», which is in 8% in all), «invoice» in 3%.
  const mention = (word) => { const s = pick(sentences); s.splice(Math.floor(r() * s.length), 0, word); };
  let subject = pick(SUBJECTS)(number, pick(BUSINESS));
  if (r() < 0.05) { mention('накладная'); if (r() < 0.3) subject = `Накладная ${number}`; }
  const claim = r() < 0.04;
  if (claim) { mention('претензия'); if (r() < 0.5) subject = `Претензия по заказу ${number}`; }
  if ((claim && r() < 0.5) || r() < 0.06) mention('возврат');
  if (r() < 0.03) { mention('invoice'); if (r() < 0.5) subject = `Invoice ${number}`; }
  const greeting = pick(['Добрый день', 'Здравствуйте', 'Уважаемые коллеги']);
  return {
    messageId: `seed-${box}-${index}@${SEED_ID_DOMAIN}`,
    fromName: `${first} ${last}`,
    fromEmail: `${LAST[last]}@${company}`,
    subject,
    date: new Date(Date.UTC(2026, 8, 20) - Math.floor(r() * 730 * 86400000)),
    seen: r() < 0.7,
    body: `${greeting}!\n\n${sentences.map((s) => `${s.join(' ')}.`).join(' ')}\n\n--\n${first} ${last}\n${company}\n`,
  };
}

const boxName = (box) => (box >= GMAIL_BOX_BASE
  ? `gbox${String(box - GMAIL_BOX_BASE).padStart(3, '0')}` : `box${String(box).padStart(3, '0')}`);
const seededBoxes = () => [
  ...Array.from({ length: MAILBOXES }, (_, i) => i),
  ...Array.from({ length: GMAIL_EXTRA }, (_, i) => GMAIL_BOX_BASE + i),
];
const encodedWord = (text) => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;

function rfc822(l, box) {
  const body = Buffer.from(l.body).toString('base64').match(/.{1,76}/g).join('\r\n');
  return [
    `From: ${encodedWord(l.fromName)} <${l.fromEmail}>`, `To: ${boxName(box)}@${DOMAIN}`,
    `Subject: ${encodedWord(l.subject)}`, `Date: ${l.date.toUTCString()}`, `Message-ID: <${l.messageId}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    '', body, '',
  ].join('\r\n');
}

async function panelDb() {
  const { default: pg } = await import('pg');
  const client = new pg.Client();
  await client.connect();
  return client;
}

// Seeded rows the panel holds, and how many of them still wait for a snippet.
async function seededRows(client) {
  const { rows: [row] } = await client.query(`SELECT count(*)::int AS rows,
      count(*) FILTER (WHERE snippet IS NULL AND snippet_attempted_at IS NULL)::int AS pending
    FROM messages WHERE message_id LIKE $1`, [`%@${SEED_ID_DOMAIN}%`]);
  return row;
}

async function dbSize(client) {
  const { rows: [row] } = await client.query(`SELECT pg_database_size(current_database())::bigint AS db,
      pg_total_relation_size('messages')::bigint AS messages`);
  return { dbMb: Math.round(Number(row.db) / 1048576), messagesTableMb: Math.round(Number(row.messages) / 1048576) };
}

if (PHASE === 'users') {
  const admin = await new Session().login();
  // Every employee here signs in from the driver's one address; the per-address limit on sign-ins
  // (10 in 15 minutes by default) is meant for guessing passwords, not for a whole office.
  const limits = await admin.call('PATCH', '/admin/settings', { auth_max_attempts: 100, auth_window_minutes: 1 });
  assert.equal(limits.status, 200, JSON.stringify(limits.data));
  for (let i = 0; i < EMPLOYEES; i++) {
    const { username } = employee(i);
    let r = await admin.call('POST', '/admin/invites', { email: `${username}@staff.invalid` });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const inviteToken = new URL(r.data.inviteUrl).searchParams.get('invite');
    r = await new Session().call('POST', '/auth/register', { ...employee(i), inviteToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  await Promise.all(Array.from({ length: EMPLOYEES }, (_, i) => new Session().login(employee(i))));
  result({ employees: EMPLOYEES });
}

if (PHASE === 'seed') {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const from = Number(process.env.SEED_FROM);
  const count = Number(process.env.SEED_COUNT);
  let bytes = 0;
  for (const box of seededBoxes()) {
    const dir = `/seed/${boxName(box)}`;
    await Promise.all(['cur', 'new', 'tmp'].map((d) => mkdir(`${dir}/${d}`, { recursive: true })));
    for (let index = from; index < from + count; index++) {
      const l = letter(box, index);
      const text = rfc822(l, box);
      bytes += text.length;
      const time = Math.floor(l.date.getTime() / 1000);
      await writeFile(`${dir}/cur/${time}.M${index}P${box}.seed:2,${l.seen ? 'S' : ''}`, text);
    }
  }
  result({ letters: ALL_MAILBOXES * count, perMailbox: count, averageBytes: Math.round(bytes / (ALL_MAILBOXES * count)) });
}

if (PHASE === 'bodies') {
  const client = await panelDb();
  const started = Date.now();
  const { rows } = await client.query(
    'SELECT id, message_id FROM messages WHERE message_id LIKE $1 AND body_text IS NULL', [`%@${SEED_ID_DOMAIN}%`]);
  for (let i = 0; i < rows.length; i += 2000) {
    const batch = rows.slice(i, i + 2000).map((row) => {
      const [, box, index] = /seed-(\d+)-(\d+)@/.exec(row.message_id);
      return [row.id, letter(Number(box), Number(index)).body];
    });
    await client.query(`UPDATE messages m SET body_text = v.body
      FROM unnest($1::uuid[], $2::text[]) AS v(id, body) WHERE m.id = v.id`,
    [batch.map((b) => b[0]), batch.map((b) => b[1])]);
  }
  await client.query('VACUUM ANALYZE messages');
  result({ filled: rows.length, seconds: seconds(Date.now() - started), ...(await dbSize(client)) });
  await client.end();
}

if (PHASE === 'search') {
  const label = process.env.SEARCH_LABEL;
  const untilRows = Number(process.env.SEARCH_UNTIL_ROWS || 0);
  const client = await panelDb();
  const employees = await Promise.all(Array.from({ length: EMPLOYEES }, (_, i) => new Session().login(employee(i))));
  const [one] = await nodeAccounts(employees[0]);
  // What an employee types, over all mailboxes and folders: a common word, a sender's surname, two
  // words, an order number, a word no letter has (the whole table is read), and a word in one mailbox.
  const QUERIES = [
    { kind: 'word', q: 'накладная' },
    { kind: 'surname', q: 'Воробьёв' },
    { kind: 'two words', q: 'претензия возврат' },
    { kind: 'number', q: '48213' },
    { kind: 'no match', q: 'кракозябра' },
    { kind: 'one mailbox', q: 'invoice', accountId: one.id },
  ];
  const latency = new Map(QUERIES.map((x) => [x.kind, []]));
  const failures = {};
  let stop = false;
  const started = Date.now();
  let syncedAt = null;
  const stopper = (async () => {
    if (untilRows) {
      const end = Date.now() + 3600000;
      while (Date.now() < end) {
        const s = await seededRows(client);
        if (s.rows >= untilRows && !syncedAt) syncedAt = Date.now();
        // Snippets are part of the sync: search reads them. Give them up to 10 minutes more.
        if (syncedAt && (s.pending === 0 || Date.now() - syncedAt > 600000)) break;
        await sleep(5000);
      }
    } else {
      await sleep(Number(process.env.SEARCH_SECONDS) * 1000);
    }
    stop = true;
  })();
  await Promise.all(employees.map(async (s, i) => {
    for (let n = i; !stop; n++) {
      const query = QUERIES[n % QUERIES.length];
      const path = `/search?q=${encodeURIComponent(query.q)}&limit=50${query.accountId ? `&accountId=${query.accountId}` : ''}`;
      const t0 = Date.now();
      // A search still running after a minute counts as failed ('timeout'), not as a latency.
      const r = await s.call('GET', path, null, { timeoutMs: 60000 })
        .catch((err) => ({ status: err.name === 'TimeoutError' ? 'timeout' : 0 }));
      if (r.status === 200) latency.get(query.kind).push(Date.now() - t0);
      else failures[r.status] = (failures[r.status] || 0) + 1;
      await sleep(2000);
    }
  }));
  await stopper;
  const seeded = await seededRows(client);
  const ms = Object.fromEntries([...latency].map(([kind, list]) => [kind, list.length ? { n: list.length, ...percentiles(list) } : null]));
  result({
    label,
    seconds: seconds(Date.now() - started),
    ...(untilRows ? {
      syncSeconds: syncedAt ? seconds(syncedAt - started) : null, rows: seeded.rows, of: untilRows, snippetsPending: seeded.pending,
    } : {}),
    searches: [...latency.values()].reduce((sum, list) => sum + list.length, 0),
    failures,
    ms,
    ...(await dbSize(client)),
  });
  await client.end();
  if (untilRows) assert.ok(seeded.rows >= untilRows, `the panel holds ${seeded.rows} of ${untilRows} seeded letters`);
}

// ── Work scenario ───────────────────────────────────────────────────────────

const WORK_FOLDER = 'Work';
const HOT_MAILBOXES = 20;
const bareId = (id) => String(id || '').replace(/^<|>$/g, '');

if (PHASE === 'work') {
  const employees = await Promise.all(Array.from({ length: EMPLOYEES }, (_, i) => new Session().login(employee(i))));
  const accounts = await nodeAccounts(employees[0]);
  // A folder of its own in every mailbox for the moves; the path is the server's (a prefix or another
  // delimiter would show here).
  const workPath = new Map();
  for (const a of accounts) {
    const r = await employees[0].call('POST', '/mail/folders', { accountId: a.id, name: WORK_FOLDER });
    assert.equal(r.status, 200, `folder in ${a.email_address}: ${JSON.stringify(r.data)}`);
    workPath.set(a.id, r.data.path);
  }
  const hot = accounts.slice(0, HOT_MAILBOXES);
  const stats = new Map();
  const note = (kind, status, ms) => {
    if (!stats.has(kind)) stats.set(kind, { ms: [], status: {} });
    const s = stats.get(kind);
    if (status >= 200 && status < 300) s.ms.push(ms);
    else s.status[status] = (s.status[status] || 0) + 1;
  };
  // What each seeded letter went through: its mailbox, how many actions touched it, and where the
  // last one sent it (a folder, or the kind of destination the driver cannot name: trash, archive, spam).
  const touched = new Map();
  const touch = (m, accountId, expect) => {
    const t = touched.get(m.message_id) || { accountId, actions: 0, expect: null };
    t.actions += 1;
    t.expect = expect;
    touched.set(m.message_id, t);
  };
  const act = async (s, kind, method, path, body) => {
    const t0 = Date.now();
    const r = await s.call(method, path, body, { timeoutMs: 60000 }).catch((err) => ({
      status: err.name === 'TimeoutError' ? 'timeout' : 'down', data: null,
    }));
    note(kind, r.status, Date.now() - t0);
    return r;
  };
  const listOf = async (s, account, folder, limit) => {
    const r = await act(s, folder === 'INBOX' ? 'list' : 'list work', 'GET',
      `/mail/messages?accountId=${account.id}&folder=${encodeURIComponent(folder)}&limit=${limit}`);
    return (r.data?.messages || []).filter((m) => m.message_id && m.message_id.includes(SEED_ID_DOMAIN));
  };
  let stop = false;
  const started = Date.now();
  const stopper = sleep(Number(process.env.WORK_SECONDS) * 1000).then(() => { stop = true; });
  await Promise.all(employees.map(async (s, i) => {
    const r = rng(9001 + i);
    const pick = (list) => list[Math.floor(r() * list.length)];
    // Up to n letters from the current list, taken out of it so this employee does not act on them twice.
    const take = (cur, n) => cur.messages.splice(0, Math.max(1, Math.min(n, cur.messages.length)));
    let cur = null;
    while (!stop) {
      const x = r();
      if (!cur || !cur.messages.length || x < 0.28) {
        const account = r() < 0.7 ? pick(hot) : pick(accounts);
        cur = { account, messages: await listOf(s, account, 'INBOX', 50) };
        cur.messages.sort(() => r() - 0.5);
      } else if (x < 0.50) {
        await act(s, 'open', 'GET', `/mail/messages/${cur.messages[0].id}/body`);
        cur.messages.push(cur.messages.shift());
      } else if (x < 0.62) {
        const m = cur.messages[0];
        await act(s, 'read', 'PATCH', `/mail/messages/${m.id}/read`, { read: !m.is_read });
        m.is_read = !m.is_read;
        cur.messages.push(cur.messages.shift());
      } else if (x < 0.66) {
        const ids = cur.messages.slice(0, 20).map((m) => m.id);
        await act(s, 'bulk read', 'POST', '/mail/messages/bulk-read', { ids, read: r() < 0.7 });
      } else if (x < 0.76) {
        const ms = take(cur, 1 + Math.floor(r() * 5));
        const folder = workPath.get(cur.account.id);
        const res = await act(s, 'move', 'POST', '/mail/messages/bulk-move', { ids: ms.map((m) => m.id), folder });
        if (res.status === 200) ms.forEach((m) => touch(m, cur.account.id, folder));
      } else if (x < 0.80) {
        const back = (await listOf(s, cur.account, workPath.get(cur.account.id), 20)).slice(0, 1 + Math.floor(r() * 3));
        if (back.length) {
          const res = await act(s, 'move back', 'POST', '/mail/messages/bulk-move', { ids: back.map((m) => m.id), folder: 'INBOX' });
          if (res.status === 200) back.forEach((m) => touch(m, cur.account.id, 'INBOX'));
        }
      } else if (x < 0.85) {
        const ms = take(cur, 1 + Math.floor(r() * 3));
        const res = await act(s, 'archive', 'POST', '/mail/messages/bulk-archive', { ids: ms.map((m) => m.id) });
        if (res.status === 200) ms.forEach((m) => touch(m, cur.account.id, 'archive'));
      } else if (x < 0.90) {
        const ms = take(cur, 1 + Math.floor(r() * 3));
        const res = await act(s, 'delete', 'POST', '/mail/messages/bulk-delete', { ids: ms.map((m) => m.id) });
        if (res.status === 200) ms.forEach((m) => touch(m, cur.account.id, 'trash'));
      } else if (x < 0.92) {
        const [m] = take(cur, 1);
        const res = await act(s, 'spam', 'POST', `/mail/messages/${m.id}/spam`);
        if (res.status === 200) touch(m, cur.account.id, 'spam');
      } else {
        await act(s, 'search', 'GET', `/search?q=${encodeURIComponent(pick(['накладная', 'претензия возврат', 'Воробьёв', 'invoice']))}&limit=50`);
      }
      await sleep(1000 + Math.floor(r() * 2000));
    }
  }));
  await stopper;
  const { writeFile } = await import('node:fs/promises');
  await writeFile('/seed/touched.json', JSON.stringify([...touched]));
  const byKind = Object.fromEntries([...stats].map(([kind, s]) => [kind, {
    ok: s.ms.length, ...(s.ms.length ? percentiles(s.ms) : {}), ...(Object.keys(s.status).length ? { other: s.status } : {}),
  }]));
  result({
    seconds: seconds(Date.now() - started),
    actions: [...stats.values()].reduce((n, s) => n + s.ms.length + Object.values(s.status).reduce((a, b) => a + b, 0), 0),
    lettersTouched: touched.size,
    byKind,
  });
}

if (PHASE === 'drain') {
  const client = await panelDb();
  const started = Date.now();
  const pending = async () => (await client.query('SELECT state, count(*)::int AS n FROM message_moves GROUP BY state')).rows;
  const atStart = await pending();
  let left = atStart;
  while (left.length && Date.now() - started < 1200000) {
    await sleep(2000);
    left = await pending();
  }
  const { rows: [audit] } = await client.query(
    `SELECT count(*) FILTER (WHERE action = 'message.move_reverted')::int AS reverted FROM mailbox_audit_log`);
  result({
    seconds: seconds(Date.now() - started),
    atStart: Object.fromEntries(atStart.map((x) => [x.state, x.n])),
    left: Object.fromEntries(left.map((x) => [x.state, x.n])),
    reverted: audit.reverted,
  });
  await client.end();
  assert.equal(left.length, 0, `moves still queued after 20 minutes: ${JSON.stringify(left)}`);
}

if (PHASE === 'verify') {
  const { readFile } = await import('node:fs/promises');
  const client = await panelDb();
  // user -> Message-ID -> folders, on the server and in the panel.
  const index = () => new Map();
  const add = (map, user, mid, value) => {
    if (!map.has(user)) map.set(user, new Map());
    const byMid = map.get(user);
    if (!byMid.has(mid)) byMid.set(mid, []);
    byMid.get(mid).push(value);
  };
  // doveadm -A puts the user first, as a column of its own ("Username"); the rest follow the header.
  const server = index();
  const [header, ...lines] = (await readFile('/seed/server.tsv', 'utf8')).split('\n');
  const col = (name) => header.split('\t').indexOf(name);
  const [cMailbox, cMid] = [col('mailbox'), col('hdr.message-id')];
  assert.ok(cMailbox > 0 && cMid > 0, `unexpected doveadm header: ${header}`);
  for (const line of lines) {
    const cells = line.split('\t');
    const mid = cells[cMid];
    if (mid && mid.includes(SEED_ID_DOMAIN)) add(server, cells[0], bareId(mid.trim()), cells[cMailbox]);
  }
  const panel = index();
  const { rows } = await client.query(`SELECT a.email_address, m.folder, m.message_id, m.uid::bigint AS uid
    FROM messages m JOIN email_accounts a ON a.id = m.account_id
    WHERE m.message_id LIKE $1 AND m.is_deleted = false`, [`%@${SEED_ID_DOMAIN}%`]);
  let placeholders = 0;
  for (const row of rows) {
    if (Number(row.uid) < 0) placeholders += 1;
    add(panel, row.email_address, bareId(row.message_id), row.folder);
  }
  const counts = { serverLetters: 0, panelLetters: rows.length, lost: 0, phantom: 0, twiceOnServer: 0, twiceInPanel: 0, otherFolder: 0 };
  const samples = [];
  const sample = (what, user, mid, s, p) => { if (samples.length < 10) samples.push({ what, user, mid, server: s, panel: p }); };
  for (const [user, byMid] of server) {
    for (const [mid, folders] of byMid) {
      counts.serverLetters += folders.length;
      const inPanel = panel.get(user)?.get(mid) || [];
      if (folders.length > 1) { counts.twiceOnServer += 1; sample('twice on server', user, mid, folders, inPanel); }
      if (!inPanel.length) { counts.lost += 1; sample('not in panel', user, mid, folders, inPanel); continue; }
      if (inPanel.length > 1) { counts.twiceInPanel += 1; sample('twice in panel', user, mid, folders, inPanel); }
      if (!inPanel.every((f) => folders.includes(f))) { counts.otherFolder += 1; sample('other folder', user, mid, folders, inPanel); }
    }
  }
  for (const [user, byMid] of panel) {
    for (const [mid, folders] of byMid) {
      if (!server.get(user)?.has(mid)) { counts.phantom += 1; sample('not on server', user, mid, [], folders); }
    }
  }
  // Letters one action touched: the panel must have them where that action sent them.
  const touched = JSON.parse(await readFile('/seed/touched.json', 'utf8'));
  const { rows: emails } = await client.query('SELECT id, email_address FROM email_accounts');
  const emailOf = new Map(emails.map((e) => [e.id, e.email_address]));
  let checked = 0;
  let misplaced = 0;
  for (const [mid, t] of touched) {
    const folders = panel.get(emailOf.get(t.accountId))?.get(bareId(mid)) || [];
    if (t.actions !== 1 || folders.length !== 1) continue;
    checked += 1;
    const [f] = folders;
    const ok = ['archive', 'trash', 'spam'].includes(t.expect) ? f !== 'INBOX' : f === t.expect;
    if (!ok) { misplaced += 1; sample(`expected ${t.expect}`, emailOf.get(t.accountId), mid, server.get(emailOf.get(t.accountId))?.get(bareId(mid)), folders); }
  }
  result({ ...counts, placeholders, touchedOnce: checked, misplaced, samples });
  await client.end();
  for (const key of ['lost', 'phantom', 'twiceOnServer', 'twiceInPanel', 'otherFolder']) assert.equal(counts[key], 0, `${key}: ${counts[key]}`);
  assert.equal(placeholders, 0, `${placeholders} rows still carry a placeholder uid`);
  assert.equal(misplaced, 0, `${misplaced} letters are not where their one action sent them`);
}
