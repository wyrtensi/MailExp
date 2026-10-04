// The populated demo: 48 mailboxes on top of the two hand-made ones in index.js (50 in all) and
// their letters, built from fixed tables so every load reads the same. Half are Gmail mailboxes
// (conversations keyed by the Gmail thread number), half are mailboxes on the mail node's domains
// (conversations keyed by the reply headers, with every reason the server can record).

import { demoTime } from './clock.js';

export const FLEET_DOMAINS = Object.freeze(['example.com', 'example.org', 'acme.example']);
const NODE_HOST = 'mail.demo.mailexpert.local';
// Moved to today with the rest of the demo's fixtures (clock.js).
const BASE_TIME = Date.parse(demoTime('2026-09-16T06:00:00.000Z'));
const HOUR = 3600 * 1000;
const FOLDER_MAPPINGS = { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' };
const COLORS = ['#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#2563eb', '#ca8a04', '#0d9488', '#9333ea', '#dc2626', '#4f46e5', '#65a30d'];

// Mailboxes on the mail node: [local part, display name, second sender name for readers abroad].
const NODE_TEAMS = [
  ['sales', 'Отдел продаж', 'Sales Department'], ['support', 'Поддержка', 'Customer Support'],
  ['billing', 'Бухгалтерия', 'Accounting'], ['hr', 'Кадры'],
  ['marketing', 'Маркетинг'], ['legal', 'Юридический отдел'], ['partners', 'Партнёры'], ['press', 'Пресс-служба'],
  ['careers', 'Вакансии'], ['security', 'Безопасность'], ['purchasing', 'Закупки'], ['logistics', 'Логистика'],
  ['finance', 'Finance'], ['design', 'Design'], ['product', 'Product'], ['research', 'Research'],
  ['events', 'Events'], ['office', 'Office'], ['helpdesk', 'IT Helpdesk'], ['success', 'Customer Success'],
  ['training', 'Training'], ['quality', 'Quality'], ['compliance', 'Compliance'], ['investors', 'Investor Relations'],
];

// Gmail mailboxes: [address, display name].
const GMAIL_TEAMS = [
  ['acme.sales.eu', 'Sales EU'], ['acme.sales.us', 'Sales US'], ['acme.sales.asia', 'Sales Asia'],
  ['acme.support.eu', 'Support EU'], ['acme.support.us', 'Support US'], ['acme.orders', 'Заказы'],
  ['acme.returns', 'Возвраты'], ['acme.wholesale', 'Опт'], ['acme.dealers', 'Дилеры'], ['acme.tenders', 'Тендеры'],
  ['acme.service', 'Сервисный центр'], ['acme.warranty', 'Гарантия'], ['acme.shop', 'Интернет-магазин'],
  ['acme.feedback', 'Отзывы'], ['acme.media', 'Media'], ['acme.social', 'Social'], ['acme.affiliates', 'Affiliates'],
  ['acme.founders', 'Founders'], ['acme.recruiting', 'Recruiting'], ['acme.travel', 'Travel desk'],
  ['acme.facilities', 'Facilities'], ['acme.vendors', 'Vendors'], ['acme.accounts', 'Accounts payable'],
  ['acme.board', 'Board'],
].map(([local, name]) => [`${local}.demo@gmail.com`, name]);

// People outside the company who write to the mailboxes.
const PEOPLE = [
  ['Анна Смирнова', 'anna.smirnova@northwind.example'], ['Maya Lin', 'maya.lin@riverside.example'],
  ['Игорь Петров', 'i.petrov@stroymarket.example'], ['Priya Nair', 'priya.nair@lotus-supply.example'],
  ['Ольга Кузнецова', 'olga@logistika.example'], ['Lucas Moreau', 'lucas@bluefin.example'],
  ['Дмитрий Орлов', 'orlov@finansy.example'], ['Elena Conti', 'elena.conti@vela.example'],
  ['Сергей Волков', 'volkov@techsnab.example'], ['Noah Brooks', 'noah@harbor.example'],
  ['Мария Лебедева', 'm.lebedeva@agency.example'], ['Kenji Sato', 'kenji@sato-trading.example'],
  ['Алексей Новиков', 'novikov@buhuchet.example'], ['Sofia Garcia', 'sofia@garcia-legal.example'],
  ['Татьяна Морозова', 'morozova@pechat.example'], ['Omar Haddad', 'omar@desert-freight.example'],
];

const SENDERS = {
  newsletter: [['Aster Product News', 'newsletter@aster.example'], ['Деловой дайджест', 'digest@business-news.example']],
  automated: [['Мониторинг', 'alerts@status.example'], ['Billing robot', 'no-reply@invoices.example'], ['CI', 'builds@ci.example']],
  promotion: [['Офис-Маркет', 'sale@office-market.example'], ['Cloud Deals', 'deals@cloud-deals.example']],
  spam: [['Prize Desk', 'winner@suspicious.example'], ['Инвест Гуру', 'profit@get-rich.example']],
};

// Conversation kinds. `steps` is who writes each letter in order: 'in' (someone outside), 'out'
// (the mailbox itself), 'in2' (a second outside person, copied on the thread). Placeholders:
// {n} a number, {who} the first name of the outside person, {team} the mailbox's name.
const SCENARIOS = [
  {
    key: 'question', subject: 'Вопрос по счёту №{n}', unread: true, steps: ['in'],
    texts: ['Добрый день! В счёте №{n} сумма отличается от договора на 12 400 ₽. Подскажите, пожалуйста, откуда разница.'],
  },
  {
    key: 'reply', subject: 'Delivery schedule for order {n}', steps: ['in', 'out'],
    texts: [
      'Hi {team}, could you confirm the delivery window for order {n}? Our warehouse closes at 6 pm.',
      'Hi {who}, the truck is booked for Thursday between 10 am and 2 pm. Tracking follows once it leaves.',
    ],
  },
  {
    key: 'long', subject: 'Договор поставки на 2027 год', unread: true, attachAt: [2, 5], steps: ['in', 'out', 'in', 'out', 'in', 'out', 'in'],
    texts: [
      'Коллеги, направляем проект договора поставки на 2027 год. Посмотрите, пожалуйста, раздел об оплате.',
      '{who}, спасибо. По оплате предлагаем 30 дней вместо 14, остальное устраивает.',
      'Согласовали 30 дней. Прикладываем обновлённую редакцию, изменения выделены.',
      'Получили. Юристы просят уточнить пункт 7.2 об ответственности сторон.',
      'Пункт 7.2 переписали, неустойка теперь ограничена 5% от суммы поставки. Новая версия во вложении.',
      'Всё согласовано. Отправляем подписанный экземпляр со своей стороны.',
      'Спасибо! Оригинал отправим курьером в понедельник.',
    ],
  },
  { key: 'newsletter', subject: 'Дайджест недели №{n}', category: 'newsletter', sender: 'newsletter', steps: ['in'],
    texts: ['Главное за неделю: новые тарифы на доставку, обзор рынка упаковки и три кейса наших клиентов.'] },
  { key: 'automated', subject: 'Invoice INV-{n} is ready', category: 'automated', sender: 'automated', unread: true, steps: ['in'],
    texts: ['Your invoice INV-{n} for September is ready. The amount will be charged on the 1st.'] },
  { key: 'promotion', subject: 'Скидка 30% на бумагу до пятницы', category: 'promotion', sender: 'promotion', steps: ['in'],
    texts: ['Только до пятницы: скидка 30% на офисную бумагу и доставка бесплатно от 5 000 ₽.'] },
  { key: 'spam', subject: 'You have won {n} USD', folder: 'Spam', category: 'promotion', sender: 'spam', unread: true, steps: ['in'],
    texts: ['Congratulations! Claim your prize of {n} USD by following this link today.'] },
  {
    // A reply whose earlier letters never reached this mailbox: keyed by the root it names.
    key: 'provisional', subject: 'Re: Contract redlines', provisional: true, unread: true, steps: ['in'],
    texts: ['Following up on the thread with your legal team: the redlines on clauses 4 and 9 are fine by us.'],
  },
  {
    // The first letter answers a root that never arrived; the reply is keyed by that first letter.
    key: 'ancestor', subject: 'Re: Замена оборудования', provisional: true, steps: ['in', 'out', 'in'],
    texts: [
      'Продолжаем переписку с вашим сервисным инженером: замену назначили на среду.',
      '{who}, подтверждаем среду, инженер приедет к 11:00.',
      'Отлично, пропуск на въезд заказан.',
    ],
  },
  {
    key: 'forward', subject: 'Fwd: Счёт на оплату №{n}', attachAt: [0], steps: ['in', 'out'],
    texts: ['Пересылаю счёт от подрядчика, оплатите, пожалуйста, до конца недели.', 'Оплату поставили на четверг, платёжку пришлём.'],
  },
  {
    // The subject changes halfway; the reply headers still hold the conversation together.
    key: 'drift', subject: 'Offsite planning', drift: 'Re: Offsite planning (new dates)', steps: ['in', 'out', 'in', 'out'],
    texts: [
      'Hi {team}, we are planning the autumn offsite for 40 people. Any venue you would suggest?',
      'Hi {who}, the lake hotel has space on October 14-15. Shall we book it?',
      'Those dates clash with the board meeting. Could we move to October 21-22?',
      'Moved to October 21-22, the hotel confirmed.',
    ],
  },
  { key: 'draft', subject: 'Предложение о сотрудничестве', folder: 'Drafts', steps: ['out'],
    texts: ['{who}, добрый день! Хотели бы обсудить совместную акцию в ноябре. Удобно созвониться'] },
  { key: 'archived', subject: 'Q3 pipeline review notes', folder: 'Archive', steps: ['in', 'out'],
    texts: ['Notes and follow-ups from our Q3 pipeline review are below.', 'Thanks {who}, added the follow-ups to the tracker.'] },
  { key: 'starred', subject: 'Срочно: претензия по партии {n}', starred: true, unread: true, attachAt: [0], steps: ['in'],
    texts: ['Партия {n} пришла с повреждённой упаковкой, акт и фото во вложении. Ждём решения до завтра.'] },
  { key: 'trash', subject: 'Old conference invitation', folder: 'Trash', steps: ['in'],
    texts: ['Your invitation for the summer conference is enclosed.'] },
  {
    // A row synced before the reasons were recorded: no thread key, no reason.
    key: 'legacy', subject: 'Архив: сверка за 2024 год', legacy: true, folder: 'Archive', steps: ['in'],
    texts: ['Акт сверки за 2024 год во вложении, расхождений нет.'],
  },
  {
    key: 'group', subject: 'Launch checklist', folder: 'Projects/Launch', unread: true, steps: ['in', 'in2', 'out', 'in'],
    texts: [
      'Team, here is the launch checklist. Please tick your items by Friday.',
      'Marketing items are done, the press release is scheduled for Tuesday.',
      'Thanks both. Support scripts are ready, we will train the team on Monday.',
      'Great. The last open item is the pricing page, I will send it tomorrow.',
    ],
  },
];

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
const pad = (n, width = 2) => String(n).padStart(width, '0');

function fleetAccount(index, { email, name, gmail, domain, secondName }) {
  const id = `demo-fx-${pad(index)}`;
  return {
    id,
    name,
    sender_name: name,
    email_address: email,
    imap_host: gmail ? 'imap.gmail.com' : NODE_HOST, imap_port: 993,
    smtp_host: gmail ? 'smtp.gmail.com' : NODE_HOST, smtp_port: 587, smtp_tls: 'STARTTLS',
    color: COLORS[index % COLORS.length],
    protocol: 'imap',
    enabled: true,
    include_in_unified_inbox: true,
    sort_order: index + 2,
    folder_mappings: { ...FOLDER_MAPPINGS },
    signature: `<p>${name}</p>`,
    categorization_enabled: true,
    health: 'healthy',
    // A second sender name is an alias with the mailbox's own address (compose's From list).
    aliases: secondName ? [{ id: `${id}-alias-1`, account_id: id, name: secondName, email, reply_to: null, signature: null }] : [],
    thread_mode: gmail ? 'gmail' : 'rfc',
    ...(gmail ? { oauth_provider: 'google' } : { mail_node: true, mail_node_domain: domain }),
  };
}

// The 48 generated mailboxes: node and Gmail ones alternate so both kinds fill the sidebar.
export function fleetAccounts() {
  const accounts = [];
  for (let i = 0; i < NODE_TEAMS.length; i++) {
    const [local, nodeName, secondName] = NODE_TEAMS[i];
    const domain = FLEET_DOMAINS[i % FLEET_DOMAINS.length];
    accounts.push(fleetAccount(accounts.length, { email: `${local}@${domain}`, name: nodeName, gmail: false, domain, secondName }));
    const [gmailAddress, gmailName] = GMAIL_TEAMS[i];
    accounts.push(fleetAccount(accounts.length, { email: gmailAddress, name: gmailName, gmail: true }));
  }
  return accounts;
}

// A 19-digit Gmail thread number, fixed per mailbox and conversation.
const gmailNumber = (a, c, s = 0) => `18${pad(a, 3)}${pad(c, 3)}${pad(s, 2)}00000000000`.slice(0, 19);

// Letters for every generated mailbox, as plain specs index.js turns into message rows. Every
// mailbox gets seven of the conversation kinds, a different mix for each.
export function fleetLetters(accounts) {
  const letters = [];
  accounts.forEach((account, a) => {
    const gmail = account.thread_mode === 'gmail';
    const host = gmail ? 'mail.gmail.com' : account.email_address.split('@')[1];
    const picked = [];
    for (let k = 0; picked.length < 7; k++) {
      const index = (a * 3 + k * 5) % SCENARIOS.length;
      if (!picked.includes(index)) picked.push(index);
    }
    picked.forEach((scenarioIndex, c) => {
      const scenario = SCENARIOS[scenarioIndex];
      const person = PEOPLE[(a + c) % PEOPLE.length];
      const second = PEOPLE[(a + c + 5) % PEOPLE.length];
      const robot = scenario.sender ? SENDERS[scenario.sender][(a + c) % SENDERS[scenario.sender].length] : null;
      const n = 1000 + a * 37 + c * 11;
      const vars = { n, who: person[0].split(' ')[0], team: account.name };
      const start = BASE_TIME - (a * 5 + c * 23 + 1) * HOUR;
      const ids = [];
      const lostRoot = scenario.provisional ? `<lost-${pad(a)}-${pad(c)}@${person[1].split('@')[1]}>` : null;
      const threadNumber = gmailNumber(a, c);

      scenario.steps.forEach((who, s) => {
        const outgoing = who === 'out';
        const from = outgoing ? [account.sender_name, account.email_address] : (robot || (who === 'in2' ? second : person));
        const messageId = `<fx-${pad(a)}-${pad(c)}-${pad(s)}@${outgoing ? host : from[1].split('@')[1]}>`;
        const references = [...(lostRoot ? [lostRoot] : []), ...ids];
        const inReplyTo = references.length ? references[references.length - 1] : null;
        let threadId;
        let reason;
        if (scenario.legacy) {
          threadId = null; reason = null;
        } else if (gmail) {
          threadId = `gmail:${threadNumber}`; reason = 'gmail-thrid';
        } else if (!references.length) {
          threadId = messageId; reason = 'new-root';
        } else if (!lostRoot) {
          threadId = ids[0]; reason = 'rfc-root';
        } else {
          // The root is missing: the first letter keys itself by it, later ones find the first.
          threadId = lostRoot; reason = s === 0 ? 'rfc-provisional' : 'rfc-ancestor';
        }
        const last = s === scenario.steps.length - 1;
        const subjectBase = scenario.drift && s >= 2 ? scenario.drift : fill(scenario.subject, vars);
        const subject = s === 0 || subjectBase.startsWith('Re:') ? subjectBase : `Re: ${subjectBase}`;
        const text = fill(scenario.texts[s], vars);
        const cc = scenario.key === 'group' ? [second[1]] : [];
        letters.push({
          id: `demo-fx-${pad(a)}-${pad(c)}-${pad(s)}`,
          accountId: account.id,
          folder: scenario.folder === 'Drafts' ? 'Drafts' : outgoing ? 'Sent' : (scenario.folder || 'INBOX'),
          subject,
          fromName: from[0],
          fromEmail: from[1],
          toAddresses: outgoing ? [person[1]] : [account.email_address],
          ccAddresses: cc,
          date: new Date(start + s * 3 * HOUR + (s ? 17 : 0) * 60 * 1000).toISOString(),
          snippet: text.slice(0, 120),
          bodyText: text,
          read: outgoing || !(scenario.unread && last),
          starred: !!scenario.starred,
          attachments: (scenario.attachAt || []).includes(s),
          category: scenario.category || 'primary',
          messageId,
          inReplyTo,
          references,
          threadId,
          reason,
          providerThreadId: gmail ? threadNumber : null,
          providerMessageId: gmail ? gmailNumber(a, c, s + 1) : null,
        });
        ids.push(messageId);
      });
    });
  });
  return letters;
}

// Domains the mail node serves in the demo; the retired one stays out of the add form's list.
export function fleetDomains(accounts) {
  const count = (domain) => accounts.filter((a) => a.mail_node && a.email_address.endsWith(`@${domain}`)).length;
  return [
    ...FLEET_DOMAINS.map((domain) => ({ domain, active: true, maxMailboxes: 500, mailboxes: count(domain) })),
    { domain: 'old-brand.example', active: false, maxMailboxes: 50, mailboxes: 0 },
  ];
}
