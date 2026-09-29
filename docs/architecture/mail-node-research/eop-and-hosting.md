# EOP + собственный почтовый узел (Postfix/Dovecot) для 500 ящиков — research

Дата исследования: 2026-09-21. Актуальность: приоритет отдавался источникам 2025-2026 (в основном
learn.microsoft.com/techcommunity.microsoft.com с датой обновления в 2025-2026, плюс отраслевые обзоры
хостеров за 2026 год). Там, где данные могли устареть или не были найдены впрямую, стоит пометка
**[инференс]** — вывод сделан логически, без прямого источника, и его стоит перепроверить перед
принятием решения.

Схема, для которой собирался этот отчёт: MX → EOP → наш узел (TCP 25 + TLS) на вход; наш узел → EOP
как smarthost → интернет на выход. До 500 ящиков в нескольких доменах, продакшн. Веб-клиент MailExpert
(Node + PostgreSQL + Redis) ходит в каждый ящик по IMAP и SMTP submission.

---

## 1. Лицензирование EOP в 2026 году

### 1.1. Продукт переименован, но жив

Важная находка: страница Microsoft Learn, которая раньше называлась "standalone EOP", в декабре 2025
была переписана и продукт официально называется **"Built-in security add-on for on-premises mailboxes"**
("надстройка встроенной защиты для локальных почтовых ящиков"), хотя в прайс-листах, у реселлеров и в
разговорной речи по-прежнему фигурирует "Exchange Online Protection standalone" / "EOP standalone".
Страница обновлена 2025-12-19, то есть это самое свежее официальное описание на конец 2026 года.
https://learn.microsoft.com/en-us/exchange/standalone-eop/standalone-eop

Цитата с этой страницы: "The on-premises email organization can use Microsoft Exchange **or other SMTP
email products**." — то есть продукт явно предназначен не только для on-prem Exchange, но и для любого
SMTP-сервера, включая Postfix/Dovecot. Это прямой ответ на вопрос "можно ли использовать EOP для ящиков
на не-Exchange сервере" — да, можно.
https://learn.microsoft.com/en-us/exchange/standalone-eop/standalone-eop

Товар всё ещё продаётся в 2026 году через классические каналы (реселлеры/CSP): пример активного SKU
"Microsoft Exchange Online Protection - subscription license (1 month) - 1 user" у CDW.
https://www.cdw.com/product/microsoft-exchange-online-protection-subscription-license-1-month-1-u/3446647
Отдельный листинг есть и у немецкого лицензионного калькулятора arades.
https://licenses.arades.de/en/license-cost-calculator/microsoft/exchange-online-protection

**Важная оговорка**: у Microsoft нет публичной self-service страницы "купить EOP standalone" с open
прайсом (в отличие от Business Basic/Standard, которые продаются прямо на microsoft.com) — продукт идёт
через партнёров/CSP/Volume Licensing. Из-за этого точная актуальная цена не публикуется централизованно,
и цифры ниже — это цены реселлеров/агрегаторов, а не официальный прайс-лист Microsoft. **[инференс:
цена может отличаться в вашем регионе/у вашего CSP-партнёра]**.

### 1.2. Цена

Разные агрегаторы сходятся на цифре **≈ $2/пользователь/месяц при годовой оплате** для standalone EOP
("Built-in security add-on for on-premises mailboxes"):
https://www.spambrella.com/faq/how-much-does-exchange-online-protection-cost/

Тот же источник указывает, что если защита нужна для облачных ящиков в составе обычного плана — она уже
включена начиная с Business Basic (от $6/пользователь/месяц), а расширенная защита (Defender for Office
365, Safe Attachments/Safe Links) — это отдельная надбавка $2–5/пользователь/месяц поверх базового плана.
https://www.spambrella.com/faq/how-much-does-exchange-online-protection-cost/

Официальное подтверждение, что встроенная защита включена в облачные тарифы: страница "Built in security
for Cloud mailboxes" на microsoft.com.
https://www.microsoft.com/en-us/microsoft-365/exchange/exchange-email-security-spam-protection

Прямую попытку получить точную цену со страницы CDW сделать не удалось (таймаут при выгрузке страницы) —
берите цифру $2/мес как ориентир для сметы, а не как гарантированную цену для закупки 500 лицензий; для
проекта на 500 ящиков стоит запросить прайс у CSP-партнёра напрямую.

### 1.3. Лицензируется весь ящик или "защищаемый пользователь"

Модель лицензирования EOP — "1 лицензия на 1 получателя/ящик, который защищается сервисом", а не
абстрактный "защищённый пользователь". Официальная инструкция по настройке подтверждает это косвенно:
на шаге "Add recipients" в тенант заводится запись на каждого получателя (mail user), которого будет
защищать сервис, и лицензии затем привязываются к этим объектам.
https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service

> **Ревизия 2026-09-30.** Технически mail user лицензии не требует: «Mail users don't require licenses in
> Exchange Online» (https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-mail-users).
> Сколько лицензий add-on нужно на защищаемых получателей и считаются ли ими mail contacts — коммерческие
> условия, уточнять у партнёра.

Из этого следует **[инференс, логический вывод из механики]**: для 500 почтовых ящиков на вашем узле,
если ни один из этих 500 адресов не покрыт другой M365-лицензией с включённым EOP (E1/E3/E5/Business*),
потребуются 500 отдельных EOP-лицензий — то есть по сути "на все 500 ящиков", а не на какое-то
подмножество "защищаемых пользователей". Обсуждения на Microsoft Q&A в целом подтверждают эту логику
("нужна лицензия на каждый локальный ящик, который защищает EOP", если у пользователя ещё нет M365 E1/E3):
https://learn.microsoft.com/en-us/answers/questions/2112449/do-i-need-a-eop-license-for-an-on-premises-mailbox

Важный нюанс оттуда же: если у конкретного пользователя УЖЕ есть Microsoft 365 E1 или E3 (например,
куплен ради Teams/SharePoint, а почта работает у вас на Postfix), отдельная EOP-лицензия ему не нужна —
EOP включён в E1/E3. Для проекта на 500 внешних клиентов-арендаторов это малореалистичный сценарий
(это скорее относится к вашему собственному тенанту как оператору сервиса), но стоит иметь в виду.
https://learn.microsoft.com/en-us/answers/questions/2112449/do-i-need-a-eop-license-for-an-on-premises-mailbox

### 1.4. Минимальное количество лицензий

Однозначного официального указания "минимум N лицензий" для EOP standalone найти не удалось — ни на
learn.microsoft.com, ни в текущих прайс-страницах Microsoft. Историческая информация (по каналу Open
Value) о минимуме в 5 лицензий не подтвердилась свежими источниками 2025-2026 и, вероятно, устарела с
переходом на CSP-модель. **[инференс: минимум лицензий, если он есть, скорее всего задаётся политикой
конкретного CSP-партнёра/реселлера, а не самим продуктом — уточняйте у поставщика лицензий]**.

### 1.5. "Гибрид" vs "чистый on-premises" у Microsoft

Microsoft чётко разграничивает два сценария в документации:

- **Hybrid deployment** — часть ящиков в облаке, часть на локальном **Exchange Server**, настройка через
  Hybrid Configuration Wizard, синхронизация каталога (Entra Connect) и т.д. Это не наш случай — у нас
  нет локального Exchange и нет облачных ящиков.
  https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service
- **On-premises email organization без Exchange** (наш случай) — "Built-in security add-on for
  on-premises mailboxes" прямо годится для не-Exchange SMTP-серверов, настройка проще: добавить и
  подтвердить домен → завести получателей → настроить 2 коннектора → открыть входящий TCP 25 → включить
  доставку спама в Junk → переключить MX на Microsoft 365.
  https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service

### 1.6. Требования к тенанту

Нужен обычный Microsoft 365 / Exchange Online тенант (даже без единой облачной почтовой лицензии),
в котором:
- домены добавлены и верифицированы через DNS (Microsoft 365 admin center или Graph `POST /domains` +
  `verify`; `New-AcceptedDomain` в облаке нет, он только для on-prem Exchange — ревизия 2026-09-30);
- заведены получатели (mail users или mail contacts, см. [eop-panel-requirements.md](eop-panel-requirements.md),
  раздел 2.8) — вручную/через PowerShell, поскольку каталог-синхронизации из AD у
  вас, вероятно, не будет (нет локального Active Directory/Exchange — ящики живут в Postfix/Dovecot);
- настроены 2 коннектора (в терминах Microsoft: Outbound connector EOP → узел и Inbound connector
  узел → EOP, см. раздел 2);
- при необходимости включён DBEB (см. раздел 3).
https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service

---

## 2. Коннекторы (inbound/outbound), TLS, high-risk delivery pool, лимиты

### 2.1. Два коннектора, оба настраиваются вручную мастером в EAC

Официальная инструкция по маршрутизации почты между Microsoft 365 и собственным сервером описывает ровно
вашу схему: коннектор "Office 365 → ваш сервер" (для входящей почты, MX указывает на Microsoft 365) и
коннектор "ваш сервер → Office 365" (для исходящей, ваш сервер использует M365 как smarthost).
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

> **Ревизия 2026-09-30: названия.** Заголовки 2.2 и 2.3 ниже изначально называли «inbound» коннектор
> EOP → сервер, а «outbound» — сервер → EOP. В командлетах Microsoft наоборот: направление считается
> относительно тенанта. EOP → наш сервер — **Outbound connector** (`New-OutboundConnector`, `SmartHosts`,
> `TlsSettings`, `TlsDomain`), наш сервер → EOP — **Inbound connector** (`New-InboundConnector`,
> `TlsSenderCertificateName`). Заголовки исправлены; подробнее —
> [eop-panel-requirements.md](eop-panel-requirements.md), раздел 2.2.

### 2.2. Outbound connector в терминах Microsoft (EOP → наш сервер): сертификат vs IP

При создании исходящего от Microsoft 365 коннектора ("Connection from: Office 365, Connection to: Your
organization's email server") нужно указать smart host (домен/IP вашего сервера) и опционально включить
"Always use TLS", а также критерий валидации сертификата принимающей стороны (CA-подписанный, с
доменом в CN/SAN, совпадающим с указанным). Пошагово это шаги 8–14 мастера.
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

### 2.3. Inbound connector в терминах Microsoft (наш сервер → EOP): сертификат vs IP — это выбор именно здесь

Для коннектора "ваш сервер → Microsoft 365" мастер прямо предлагает два взаимоисключающих способа
аутентификации отправителя:
1. **По сертификату** — "By verifying that the subject name on the certificate that the sending server
   uses to authenticate with Office 365 matches the domain entered in the text box below (**recommended**)".
2. **По IP** — "By verifying that the IP address of the sending server matches one of the following IP
   addresses, which belong exclusively to your organization".

Microsoft явно рекомендует первый вариант (по сертификату), а не привязку к IP.
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

### 2.4. Условие, при котором EOP вообще согласится релеить исходящую почту от вас в интернет

Отдельно, в разделе про настройку среды перед коннекторами, сказано: чтобы Microsoft 365 релеил почту от
вашего локального сервера в интернет, нужно **одно из двух**:
- сертификат с subject name, совпадающим с accepted domain тенанта; **или**
- **все домены и поддомены-отправители организации заведены как accepted domains в тенанте**.
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

Это прямой ответ на вопрос из задания: да, домен(ы) отправителя обязаны быть accepted domain в тенанте —
иначе релей просто не будет работать штатным образом.

Пример PowerShell-команды для локального Exchange (создание Send-коннектора со smarthost на
`<домен>-com.mail.protection.outlook.com`, `CloudServicesMailEnabled $true`, `TlsAuthLevel
CertificateValidation`) дан в этой же статье — но для Postfix эквивалент придётся собирать вручную
(relayhost + smtp_tls на mail.protection.outlook.com этого домена + клиентский сертификат, который EOP
проверит по subject name).
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

### 2.5. High-risk delivery pool (HRDP) и отдельно — relay pool

Официальная страница Defender for Office 365 (обновлена 2026-06-25, то есть свежая) описывает механику:

- HRDP — отдельный IP-пул для исходящей почты, которую антиспам счёл подозрительной ("low quality").
  Используется, чтобы не портить репутацию основного пула IP Microsoft. Доставка из HRDP **не
  гарантирована**, многие получатели вообще не принимают почту из HRDP.
  https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about
- Отдельное и важное правило: **"Messages where the source email domain has no A record and no MX record
  defined in public DNS are always routed through the high-risk delivery pool"** — у вас домены имеют MX
  (указывает на EOP), так что это правило вас не касается.
  https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about
- Отдельно существует **relay pool** — не то же самое, что HRDP. Он используется, когда Microsoft 365
  пересылает/релеит чужое письмо и не хочет, чтобы получатель считал Microsoft 365 "настоящим
  отправителем". Чтобы **не** попасть в relay pool, письмо на входе в Microsoft 365 должно удовлетворять
  одному из условий: **"The outbound sender is in an accepted domain of the organization"** ИЛИ SPF
  проходит для домена отправителя на момент прихода в Microsoft 365.
  https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about

Поскольку в вашей схеме все домены-отправители — accepted domains тенанта (это обязательное условие из
п. 2.4), исходящая почта из вашего Postfix через коннектор **не должна** попадать в непубликуемый relay
pool — она будет уходить через обычный "хороший" исходящий пул наравне с почтой из облачных ящиков.
Это ключевой вывод для доставляемости.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about

**Про "изменения 2023–2025"**: прямого указания на изменение правил HRDP/relay pool именно в 2023-2025
не найдено; единственная смежная рекомендация — про **Enhanced Filtering for Connectors**, но она
относится к обратному сценарию: когда ваш MX указывает НЕ на Microsoft, а на сторонний сервис/собственный
сервер, который затем пересылает почту в Microsoft 365 (тогда 365 видит IP пересыльщика, а не реального
отправителя, и нужен Enhanced Filtering, чтобы SPF отрабатывал верно). У вас MX указывает прямо на EOP,
это стандартный "MX → EOP" сценарий, и Enhanced Filtering для этой цели не требуется.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about

### 2.6. Исходящие лимиты и throttling — что применимо именно к вам

Страница "Troubleshoot outbound sending limits" (обновлена 2026-05-26) даёт таблицу лимитов:

| Лимит | Значение | Примечание |
|---|---|---|
| Recipient rate limit (на ящик) | 10 000 получателей/сутки | Скользящее окно 24ч, жёсткий лимит уровня сервиса |
| Message rate limit (на ящик) | 30 писем/минуту | Превышение — троттлинг, не блокировка |
| Recipient limit per message | 500 по умолчанию (1–1000 настраиваемо) | EAC/PowerShell |
| TERRL (на тенант) | формула ниже | см. 2.7 |
| SMTP relay (connector-based) | 10 000 получателей/сутки **на ящик, используемый для релея** | требует настроенного outbound-коннектора |

https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot

**[инференс]** Формулировка "10 000 получателей/сутки на ящик, используемый для релея" относится к
конкретному сценарию "SMTP relay через коннектор для устройства/приложения" (когда МФУ или приложение
шлёт письма через один конкретный почтовый ящик-релей) — см. страницу про настройку релея с
multifunction device:
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365
Ваша схема (weight — гибридный коннектор с `CloudServicesMailEnabled`/сертификатной аутентификацией,
не привязанный к одному конкретному ящику) архитектурно ближе к "hybrid mail flow", и официальной
документации, прямо говорящей "вот лимит именно для этой комбинации: standalone EOP + коннектор без
привязки к ящику", найти не удалось. Практический вывод **[инференс]**: скорее всего для трафика,
идущего через ваш гибридный коннектор, основным применимым тенант-уровневым ограничителем будет TERRL
(см. 2.7) и общие "outbound spam policy limits" (External/Internal/Daily message limit, каждый
настраивается 0–10 000/час или /сутки на уровне организации) — а не персональный лимит "на ящик",
поскольку у ваших писем формально нет единого исходящего EXO-ящика-отправителя. Это стоит уточнить
напрямую в поддержке Microsoft/у CSP-партнёра перед продакшном на 500 ящиков, так как от этого зависит
пиковая пропускная способность.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot

> **Ревизия 2026-09-30: вопрос закрыт.** Страница лимитов EOP прямо говорит: «recipient rate and message
> rate limits for Exchange Online don't apply to add-ons for on-premises mailbox users». Лимиты на ящик
> (10 000 получателей в сутки, 30 писем в минуту) к нашей схеме не применяются; действуют TERRL (2.7) и
> лимиты политики исходящего спама. Лимит на ящик держит сам mailcow (`rl_value`).
> https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-protection-service-description/exchange-online-protection-limits

### 2.7. Tenant Outbound Email Limit / TERRL — детально

Это как раз тот "Tenant Outbound Email Limit / external recipient rate limit", введённый в 2025 году, о
котором спрашивалось в задании.

**Что это.** TERRL = максимум уникальных внешних получателей, которым тенант может отправить почту за
скользящие 24 часа. "Внешний" = домен получателя не входит в accepted domains тенанта.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot

**Формула.** `TERRL = 500 × (число небесплатных email-лицензий)^0.7 + 9500`. Для тестовых (trial)
тенантов — фиксированный лимит 5000/сутки.
https://practical365.com/tenant-wide-external-recipient-rate-limit/

Пример из источника: у тенанта с 100 000 лицензиями порог — 1 560 639 получателей/сутки.
https://practical365.com/tenant-wide-external-recipient-rate-limit/

**[инференс, расчёт для вашего масштаба]**: если считать, что все 500 EOP-лицензий входят в "email
licenses" для этой формулы (прямого подтверждения, что EOP-лицензии в частности учитываются в этой
формуле, найти не удалось — формула была анонсирована в контексте Exchange Online/M365-лицензий, но по
смыслу продукта логично, что лицензии, дающие почтовый ящик/адрес в тенанте, тоже считаются):
`500 × 500^0.7 + 9500 ≈ 500 × 77.5 + 9500 ≈ 48 248` внешних получателей в сутки на весь тенант (исправлено
2026-09-30: в первой версии было 74.15 и ≈ 46 575 — арифметическая ошибка). Много
для 500 ящиков среднего SMB, но при рассылках/маркетинге может стать узким местом — стоит мониторить.

> **Ревизия 2026-09-30 (вторичный источник, на Learn пока нет).** С 2026-09-14 тенант младше 31 дня
> получает 10% расчётного лимита (~4 825 для 500 лицензий), 31-60 дней — 25% (~12 062); пробный тенант —
> 500 в сутки вместо 5 000 (`5.7.232`). Для свежего тенанта первого узла это важно.
> https://lazyadmin.nl/office-365/exchange-online-tightens-outbound-limits-for-new-trial-and-edu-tenants/

**Применимость к вашей схеме (ключевой вопрос из задания).** Несколько независимых источников (включая
резюме официальной техкоммьюнити-статьи Microsoft) сходятся на формулировке: **"All messages sent
outbound to external recipients from your tenant qualify for counting against your tenant's quota,
regardless of whether they originate from on-premises, from Exchange Online mailboxes, or from the
Internet"** — то есть TERRL считает **весь** исходящий трафик тенанта во внешний мир, включая почту,
релеенную с локального сервера через коннектор.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot
https://practical365.com/tenant-wide-external-recipient-rate-limit/

Отдельно уточняется обратное направление: почта, которая идёт **из** Microsoft 365 **на** ваши локальные
ящики (входящая для вас), в TERRL не считается, если адреса локальных ящиков — accepted domain тенанта.
https://practical365.com/tenant-wide-external-recipient-rate-limit/

**Что при превышении.** Отправителю возвращается NDR `550 5.7.233 Your message can't be sent because
your tenant exceeded its daily limit for sending email to external recipients (tenant external recipient
rate limit)`.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot

**Таймлайн раскатки (2025, для контекста).** 3 марта 2025 — тенанты ≤25 лицензий; 17 марта 2025 — ≤500
лицензий; 1 мая 2025 — все тенанты (общая раскатка была сдвинута на месяц от исходного плана).
https://practical365.com/tenant-wide-external-recipient-rate-limit/
На 2026-08-13 Microsoft объявила об обновлении методики расчёта TERRL для части тенантов, раскатка
изменений — с 14 сентября 2026, то есть буквально сейчас идёт донастройка формулы — стоит перепроверять
актуальные цифры в EAC (Reports → Mail flow → Tenant Outbound External Recipients) на момент внедрения,
а не полагаться только на формулу из блога.
https://practical365.com/tenant-wide-external-recipient-rate-limit/

**Мониторинг.** В EAC есть отчёт "Tenant Outbound External Recipients", показывающий текущее
использование/лимит; рекомендуется настроить алерт на 80% от TERRL.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot

---

## 3. Accepted domain: Internal Relay vs Authoritative, DBEB

### 3.1. Определения

- **Authoritative** — Microsoft 365/EOP считает себя единственным источником истины о валидных
  получателях домена; письма на несуществующие адреса отклоняются сразу на периметре (это и есть DBEB).
- **Internal Relay** — Microsoft 365/EOP принимает письма для домена и для известных, и для неизвестных
  ему адресов, "неизвестные" релеит дальше на смарт-хост (у вас — Postfix), не проверяя их валидность
  сам; отклонить несуществующий адрес может только ваш собственный Postfix/Dovecot на этапе RCPT TO.
https://blog.expta.com/2019/07/authoritative-vs-internal-relay-domains.html
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/manage-accepted-domains/manage-accepted-domains

### 3.2. DBEB и что ему нужно

Официальная статья по DBEB (обновлена 2026-08-03, содержание актуально):

- DBEB отклоняет сообщения для невалидных адресов ещё до антиспам/антималварь-фильтрации — на границе
  сервиса, NDR `550 5.4.1 Recipient address rejected: Access denied`.
  https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking
- **Если все получатели домена в Exchange Online, DBEB уже работает "из коробки"** — специально включать
  ничего не нужно. Это не ваш случай (получатели не в EXO, а в вашем Postfix/Dovecot), поэтому DBEB для
  вас — не автоматика, а то, что нужно настраивать через объекты-получатели в тенанте.
  https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking
- Рекомендованная последовательность включения: сначала домен = **Internal Relay** (пока не все адреса
  заведены — иначе будете терять письма на ещё не созданные ящики), затем завести всех получателей
  (**directory sync из локального AD, либо вручную/через PowerShell/EAC** — то есть создать mail user на
  каждый из 500 адресов), и только потом переключить домен в **Authoritative**, после чего включается
  DBEB.
  https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking
- Явное предупреждение: MX домена должен указывать на Microsoft 365, иначе (в т.ч. в гибридных
  окружениях) DBEB не сработает — у вас MX и так на EOP, это условие выполняется автоматически.
  https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking

**[инференс, важное архитектурное следствие для MailExpert]**: поскольку у вас нет локального AD/Exchange
для directory sync, а ящики создаются/удаляются напрямую в Postfix/Dovecot через MailExpert, "зеркало"
каждого ящика как mail user в M365-тенанте придётся поддерживать программно самим MailExpert (Graph API
или Exchange Online PowerShell) при каждом создании/удалении ящика. Если этого не делать и держать домен
в Internal Relay — DBEB просто не будет работать, и невалидные адреса будет отбраковывать только ваш
Postfix (что тоже рабочий, просто менее выгодный по нагрузке на EOP-фильтры вариант — письма на "мусорные"
адреса пройдут через весь стек антиспама EOP прежде чем будут отвергнуты вами).

> **Ревизия 2026-09-28:** «просто менее выгодный по нагрузке» здесь стоит читать строже — EOP уже
> отвечает `250 OK` исходному отправителю до отказа на узле, поэтому отклонение Postfix'ом даёт
> NDR-бэкскаттер от EOP, а не просто лишнюю нагрузку на антиспам. Подробности и порядок перехода —
> [eop-review.md](eop-review.md), находки 8 и 9.
>
> **Ревизия 2026-09-30.** Graph получателей для DBEB не создаёт — только EXO PowerShell. Вместо mail user
> (учётная запись входа с паролем) достаточно, по выводу из статьи DBEB, mail contact (`New-MailContact`);
> каждый алиас узла тоже должен быть адресом получателя; `ExternalEmailAddress` в том же домене рискует
> петлёй `5.4.14`. Подробно — [eop-panel-requirements.md](eop-panel-requirements.md), раздел 2.8 и R-29.

### 3.3. Ограничения по числу accepted domains

До 5000 accepted domains на тенант (с поддоменами) — для нескольких доменов проекта это не проблема.
https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits

---

## 4. DNS: MX, SPF, DKIM, DMARC, PTR, MTA-STS

### 4.1. MX

MX домена указывает на `<domain-через-дефисы>.mail.protection.outlook.com` (пример из
официальной документации: `contoso-com.mail.protection.outlook.com` для домена `contoso.com`).
https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail

> **Ревизия 2026-09-30.** Имя MX — токен на домен (`<MX token>.mail.protection.outlook.com`, токен из
> центра администрирования), а не имя тенанта, и выводить его из имени домена нельзя: для доменов,
> добавленных после 2026-07-01, MX создаётся под `mx.microsoft`, и единственный источник значения —
> Graph `serviceConfigurationRecords` (Message Center MC1048624, вторичный источник). Существующие домены
> не затронуты.
> https://learn.microsoft.com/en-us/microsoft-365/enterprise/external-domain-name-system-records ,
> https://mc.merill.net/message/MC1048624
Отдельно подтверждается в инструкции по настройке standalone EOP — "Be sure to point your MX record
directly to Microsoft 365 instead of a non-Microsoft service."
https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service

### 4.2. SPF

Минимум: `v=spf1 include:spf.protection.outlook.com -all`. Для GCC High/DoD —
`include:spf.protection.office365.us`, для 21Vianet (Китай) — `include:spf.protection.partner.outlook.cn`.
Официальная страница настройки SPF для M365:
https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure

**[инференс]** Поскольку в вашей архитектуре **весь** исходящий трафик идёт через коннектор-смартхост в
EOP (а не напрямую с IP вашего Postfix в интернет), включать IP вашего узла в SPF отдельной записью
`ip4:` не требуется — получатель увидит письмо, пришедшее с IP из диапазонов Microsoft, которые уже
покрыты `include:spf.protection.outlook.com`. IP вашего сервера стоит добавлять в SPF только если
предусмотрен запасной путь прямой отправки в обход EOP (например, аварийный fallback) — тогда это
отдельный архитектурный риск, который нужно явно проговорить.

### 4.3. DKIM — кто подписывает

Официальная страница "Set up DKIM to sign mail from your cloud domain" описывает механизм подписи в
Microsoft 365 для accepted domain.
https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure

По сути механики (см. также раздел 2.5 про relay pool, где Microsoft прямо пишет "To improve
authentication of forwarded mail, make sure DKIM is enabled for the sending domain" применительно к
домену, определённому как accepted domain): если у вас accepted domain и включён DKIM для него в EOP,
письма, проходящие через EOP по вашему коннектору узел → EOP (Inbound connector в терминах Microsoft), будут подписаны EOP автоматически — отдельный
DKIM-signing agent на Postfix не обязателен.
https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-high-risk-delivery-pool-about

Это соответствует и практике администраторов гибридных окружений — маршрутизация исходящей почты через
EOP с включённым на стороне EOP DKIM для домена как способ не разворачивать подпись на локальном сервере
(вторичный источник, не Microsoft, но много раз воспроизведённая практика):
https://mailflowauthority.com/email-infrastructure/exchange-server-settings

**Рекомендация [инференс]**: технически ничто не мешает Postfix параллельно подписывать письма своим
собственным DKIM-ключом (DKIM допускает несколько подписей) — но чтобы не размножать секреты и точки
отказа, разумнее доверить подпись одному слою (EOP), раз весь исходящий трафик и так идёт через него.

> **Ревизия 2026-09-28:** mailcow создаёт DKIM-ключ на каждый домен автоматически при его создании и
> сразу начинает подписывать — «доверить подпись одному слою» требует явного отключения на стороне
> mailcow (`key_size: 0` или `delete/dkim`), иначе получаются две подписи независимо от решения. А
> подписывает ли EOP письма именно с коннекторного relay — это не подтверждено ни одним найденным
> источником, только выведено из соседней страницы про relay pool. Подробности —
> [eop-review.md](eop-review.md), находка 3.

### 4.4. DMARC

Общие рекомендации по настройке DMARC для M365-доменов (постепенный переход `p=none` → `quarantine` →
`reject`, мониторинг агрегированных отчётов) — стандартная практика, не специфичная для вашей схемы;
источники общего характера, не Microsoft:
https://dmarcly.com/blog/how-to-set-up-dmarc-dkim-and-office-365-o365-the-complete-implementation-guide
https://easydmarc.com/blog/microsoft-365-spf-and-dkim-configuration-step-by-step/
Официальная страница настройки DMARC в Defender for Office 365 (общий процесс, не читалась целиком в
этом прогоне, ссылка для дальнейшей проверки):
https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dmarc-configure

### 4.5. PTR — нужен ли, если весь outbound идёт через EOP

Прямого официального заявления Microsoft "PTR вашего сервера не нужен, если исходящая почта идёт через
EOP" не найдено. Логика по вторичным источникам о PTR/rDNS: репутационные проверки на стороне получателя
применяются к **подключающемуся** SMTP-серверу — то есть к тому IP, который реально устанавливает TCP-
соединение с получателем. Если весь ваш outbound идёт через smarthost EOP, соединение с получателем
устанавливает Microsoft, а не ваш узел, и значение имеет PTR/репутация IP Microsoft, а не вашего сервера.
https://smtpedia.com/ptr-rdns-records/

**Тем не менее PTR на вашем узле стоит настроить в любом случае** — по нескольким независимым от
Microsoft причинам:
1. Большинство хостеров (см. раздел 5) требуют работающий PTR как предварительное условие для разблокировки
   исходящего TCP 25 (даже если вы почти не будете слать напрямую).
2. Ваш узел всё равно **принимает** входящую почту от EOP напрямую на TCP 25 — корректный forward/reverse
   DNS считается общей гигиеной почтового сервера и ожидается многими security-сканерами/аудитами,
   которые проверяют весь почтовый контур, а не только исходящий путь.
   https://webhosting.de/en/reverse-dns-ptr-records-mail-hosting-authentication-mailbox/
3. Он нужен на случай аварийного/отладочного прямого исходящего SMTP (NDR из вашего Postfix, тестовые
   письма в обход коннектора и т.п.).

Вывод **[инференс]**: формально для доставляемости "обычной" исходящей почты через EOP-smarthost PTR
вашего узла не критичен, но отключать/игнорировать его не стоит — оставьте как обязательный пункт
хостинг-чеклиста.

### 4.6. MTA-STS

Exchange Online поддерживает MTA-STS на своей стороне: с конца февраля 2026 (GA, раскатка до конца марта
2026) администраторы M365 смогут управлять режимом валидации MTA-STS/SMTP DANE на **исходящих**
коннекторах (Opportunistic по умолчанию, None, Mandatory).
https://techcommunity.microsoft.com/blog/exchange/announcing-smtp-dane--mta-sts-connector-modes-in-exchange-online/4501005
https://mc.merill.net/message/MC1220759

Ранее (объявление про MTA-STS в целом) — Exchange Online поддерживает MTA-STS "из коробки" для всей
исходящей почты, без действий администратора для базового включения.
https://techcommunity.microsoft.com/blog/exchange/introducing-mta-sts-for-exchange-online/3106386

Для ваших собственных доменов (принимающих почту через EOP) публикация **собственной** MTA-STS-записи —
опциональное усиление: раз MX и так указывает на `mail.protection.outlook.com`, который поддерживает TLS
широко, MTA-STS-политика прежде всего сигнализирует другим отправителям "всегда шифруйте до нас". Прямого
требования от Microsoft публиковать MTA-STS для accepted domain не найдено — это осознанный выбор
безопасности, а не обязательное условие работы схемы. Соответствует формулировке задания
"MTA-STS optional".

---

## 5. Хостинг узла: требования и сравнение провайдеров

### 5.1. Общие требования (из документации Microsoft)

- Статический публичный IPv4 с корректным PTR.
- Входящий TCP 25 должен быть открыт **со стороны вашего firewall** для диапазонов Microsoft 365 (список
  адресов — отдельная страница "Microsoft 365 URLs and IP address ranges"); Microsoft прямо просит
  ограничить входящий 25 только этими диапазонами.
  https://learn.microsoft.com/en-us/exchange/standalone-eop/set-up-your-eop-service
- CA-подписанный TLS-сертификат на приёмной стороне (для коннектора EOP → вы, Outbound connector в терминах Microsoft) — самоподписанный
  не годится, Microsoft явно рекомендует сертификат от публичного CA с CN/SAN, совпадающим с основным
  почтовым доменом.
  https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail
- Исходящий TCP 25 нужен вашему серверу **только если** предусмотрен прямой путь в интернет в обход EOP
  (тестовая отправка, аварийный fallback) — при штатной схеме "весь outbound через EOP-smarthost"
  исходящий 25 наружу в интернет вашему серверу не требуется, достаточно исходящего TLS-соединения к EOP
  (порт 25 или 587 до `*.mail.protection.outlook.com`, что тоже физически TCP 25 в терминологии SMTP
  relay через смарт-хост, но не к произвольным получателям в интернете) — **[инференс, вывод из
  архитектуры, не отдельная цитата Microsoft]**.

### 5.2. Провайдеры и политика порта 25 — сводная таблица

Собрано из документации провайдеров и независимого агрегатора для self-host почты
(`forwardemail/awesome-mail-server-providers`, активно поддерживаемый список, использован как основной
свод):
https://github.com/forwardemail/awesome-mail-server-providers

| Провайдер | Порт 25 по умолчанию | Как разблокировать | PTR | Индикативная цена, 8 ГБ RAM | Индикативная цена, 16 ГБ RAM | Доп. IPv4 |
|---|---|---|---|---|---|---|
| **Hetzner** (Cloud) | Заблокирован для новых аккаунтов | Заявка в панели после ~1 мес. истории аккаунта и первого инвойса, решение вручную, по конкретному use-case | Настраивается через панель | CX33: 4 vCPU/8 ГБ — €6.49–6.99/мес | CX43: 8 vCPU/16 ГБ — €11.99–12.49/мес | €0.50/мес |
| **Hetzner** (Robot, выделенные) | По независимым источникам тоже под ограничением до подтверждения use-case | Через тикет в Robot | Настраивается | — (Cloud обычно выгоднее для этих объёмов) | — | — |
| **OVH** | Противоречивые данные: собственная документация OVH говорит "port 25 blocked by default… request unblock", независимый агрегатор относит OVH к "open by default" — вероятно, различается по линейке/дата-центру | Заявка в Manager, "обычно одобряется с первого раза" | Поддерживается | Точная цена 8 ГБ не найдена в этом прогоне | Точная цена 16 ГБ не найдена в этом прогоне | По запросу |
| **Netcup** | Не блокируется массово (не входит в список "blocked by default" у независимого агрегатора; сам Netcup не публикует явного блока) | Обычно не требуется отдельная заявка, но стоит проверить после заказа | Настраивается в панели | VPS ~8 ГБ (DDR5 ECC, NVMe) ≈ €10.36/мес | VPS 2000 G12 (8 vCore/16 ГБ) — точная цена не зафиксирована; для сравнения дедик RS 2000 G12 (16 ГБ, выделенные ядра) — €16.89/мес | €0.50/мес |
| **Contabo** | Открыт по умолчанию (несколько источников) | Не требуется; есть упоминания softlimit ~25 писем/мин на новых аккаунтах (не проверено официально) | Настраивается в панели | Cloud VPS S, 4 vCPU/8 ГБ — $6.99/мес | VPS M, ~6 vCPU/16 ГБ — $13.99/мес | Обычно включён 1 IPv4, доп. — по запросу, цена не зафиксирована в этом прогоне |
| **Scaleway** | Заблокирован по умолчанию, но снимается **самостоятельно** через security group в консоли (без обращения в поддержку) | Self-service (редкий случай среди перечисленных) | Настраивается | Цена не собрана в этом прогоне | Цена не собрана в этом прогоне | — |
| **DigitalOcean** | Заблокирован для всех droplets (25/465/587), включая трафик через Reserved IP | Можно запросить у поддержки, но "in most cases it's not guaranteed"; официальная рекомендация — не пытаться, использовать внешний ESP | Настраивается | Не актуально как основной вариант для почтового узла | Не актуально | — |

Источники по строкам:
- Hetzner: https://docs.hetzner.com (общая политика, по цитате из независимого свода) и
  https://blog.hqcodeshop.fi/archives/553-Hetzner-outgoing-mail-SMTP-blocked-on-TCP25.html ,
  цены CX-линейки — https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/ и
  https://sparecores.com/server/hcloud/cx23 / https://sparecores.com/server/hcloud/cx33 ,
  доп. IPv4 — общий свод по прайсу Hetzner (€0.50/мес), см. также
  https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/
- OVH: https://support.us.ovhcloud.com/hc/en-us/articles/48817968371091-OVHcloud-VPS-FAQ ,
  https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/mail-sending-optimization ,
  противоречащая оценка — https://github.com/forwardemail/awesome-mail-server-providers
- Netcup: https://www.netcup.com/en/server/vps-8000-g12-iv-12m (порядок цен),
  https://netcupvoucher.com/rs-2000-g12 (16 ГБ дедик, €16.89), доп. IPv4 — общий прайс Netcup €0.50/мес.
- Contabo: https://contabo.com/blog/how-to-setup-your-own-mailserver-with-mailcow/ ,
  цены — https://bestusavps.com/reviews/contabo/ и агрегатор
  https://cybernews.com/best-web-hosting/contabo-review/pricing/ (VPS M $13.99/мес).
- Scaleway: https://www.scaleway.com/en/docs/instances/how-to/send-emails-from-your-instance/ ,
  https://community.scaleway.com/t/solved-port-25-blocked/6610
- DigitalOcean: https://docs.digitalocean.com/support/why-is-smtp-blocked/ ,
  https://www.digitalocean.com/community/questions/why-is-digitalocean-blocking-outbound-port-25-on-my-droplet
- Общий свод (открыт по умолчанию у большинства): Linode, RackNerd, DataPacket, DartNode, UltaHost,
  Hostinger, RareCloud указаны как "open by default" в том же своде:
  https://github.com/forwardemail/awesome-mail-server-providers

**Оговорка по ценам**: часть цифр в таблице — вводные/промо-тарифы, у некоторых провайдеров (особенно
Contabo) отдельно подчёркивается отсутствие удорожания при продлении
(https://cybernews.com/best-web-hosting/contabo-review/pricing/), у других (Hetzner, после апреля 2026)
была задокументирована индексация цен
(https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ и
https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/). Часть ячеек ("цена не собрана/не найдена")
осталась не закрыта в рамках этого прогона — при выборе провайдера стоит зайти на актуальный
прайс-калькулятор каждого (OVH, Netcup 16 ГБ VPS, Contabo доп. IP, Scaleway) — цены меняются часто
(апрель 2026 у Hetzner, май 2026 у Netcup, "постоянные" изменения у OVH согласно их же блогу).

### 5.3. Практический вывод по провайдерам [инференс]

Для продакшна на 500 ящиков лучше исходить не только из "открыт ли порт 25 по умолчанию", а из
предсказуемости процесса разблокировки и репутации IP-диапазона:
- **Contabo** и **Netcup** — по собранным данным чаще всего не требуют отдельной процедуры разблокировки
  25-го порта, что снижает время выхода в прод.
- **Scaleway** выделяется тем, что разблокировка полностью самостоятельная (security group), без
  обращения в поддержку и ожидания решения человека — это ценно, если сроки поджимают.
- **Hetzner** и **OVH** требуют явного запроса/времени на рассмотрение (у Hetzner — не раньше месяца
  жизни аккаунта), это стоит закладывать в план запуска заранее, а не в последний момент.
- **DigitalOcean** и аналогичные крупные "джентральные" облака (по духу того же класса — AWS/GCP/Azure
  VM без спецсогласований) для прод-почтового релея на 500 ящиков не рекомендуются как основной вариант:
  блокировка массовая и снятие "не гарантировано" по их же документации.
  https://docs.digitalocean.com/support/why-is-smtp-blocked/

---

## 6. Планирование объёма хранения и нагрузки на 500 ящиков

### 6.1. Рост ящика и объём почты (отраслевые данные, не Microsoft-специфичные)

- Средний размер почтового ящика (inbox) в 2025 — **≈ 8.7 ГБ**, с прогнозом роста до **≈ 14.3 ГБ к 2030
  году**; отдельно указывается рост потребности в объёме хранения почты более чем на **64% к 2030** из-за
  вложений и автоматических писем.
  https://clean.email/blog/insights/email-industry-report-2026
- Среднее количество писем на пользователя в бизнес-переписке — в диапазоне **82–126 писем/день**
  (разные источники дают разные цифры; консервативно можно закладывать нижнюю границу диапазона для
  типового SMB-сотрудника, верхнюю — для активных ролей вроде продаж/поддержки).
  https://blog.cloudhq.net/workplace-email-statistics/
- Общий рост объёма email-трафика — около **4% в год**, при этом машинно-генерируемая почта (транзакции,
  уведомления, рассылки) растёт быстрее, на **9%+ в год**, и именно она опережающими темпами давит на
  объём хранения.
  https://clean.email/blog/insights/email-industry-report-2026

**[инференс, расчёт для 500 ящиков]**: если взять консервативную оценку среднего размера почтового ящика
для бизнес-SMB в 2-3 ГБ на старте (типичное значение для организаций без агрессивных вложений/видео в
письмах, ниже общерыночного "inbox" 8.7 ГБ, который включает personal/consumer inbox с большим количеством
накопленного спама/маркетинга) и годовой прирост около 20-30% в год (что примерно согласуется с "64% за
~5 лет" из отчёта выше), получаем ориентир: **500 ящиков × 2-5 ГБ = 1-2.5 ТБ полезных данных в первый
год**, с необходимостью закладывать рост хранилища на 25-30%/год вперёд при планировании ёмкости.
Это оценка, а не отраслевой норматив — стоит уточнить по факту миграции реальных почтовых ящиков клиентов.

### 6.2. Sizing для Dovecot/Postfix — IOPS, диск, RAM

Официальная документация Dovecot по производительности подчёркивает: **"Heavily loaded IMAP and POP3
servers don't use much CPU, but they use all the disk I/O they can get"** — то есть узкое место почти
всегда диск, не процессор.
https://doc.dovecot.org/2.3/configuration_manual/performance_tuning/

Рекомендации по формату хранения: собственный формат Dovecot **dbox** обычно даёт заметно лучшую
производительность, чем Maildir/mbox; в одном задокументированном сравнении **mdbox показал на 40% меньше
IOPS в рабочие часы**, чем Maildir, при соответствующих настройках (`mdbox_rotate_interval`,
`mdbox_rotate_size`, сжатие).
https://doc.dovecot.org/2.3/configuration_manual/performance_tuning/

SSD обязателен как класс накопителя — сканирование больших Maildir-директорий медленное даже на быстром
SSD, что дополнительно аргументирует переход на dbox/mdbox при таких объёмах:
https://doc.dovecot.org/2.3/configuration_manual/performance_tuning/

Отдельный практический survey по mailcow (тот же класс задачи — Postfix+Dovecot в контейнерах) даёт
референсные минимумы: **минимум 6 ГиБ RAM + 1 ГиБ swap** для сервиса как такового (без учёта пользовательских
данных), рекомендуется 4+ ядра CPU на продакшне, **20 ГБ SSD/NVMe под систему и контейнеры** плюс отдельно
объём под сами письма, с явной рекомендацией **exclusively SSD**, так как HDD даёт неприемлемую
производительность IMAP.
https://docs.mailcow.email/getstarted/prerequisite-system/
https://contabo.com/blog/how-to-setup-your-own-mailserver-with-mailcow/

Там же — важное предупреждение по масштабу: **"High volume (500+ users) goes beyond single Mailcow scope
and requires multi-instance architecture or commercial alternatives"** — то есть для 500 ящиков одна
инстанция классического докеризованного mailcow-стека уже на грани документированного дизайна проекта;
это не значит, что Postfix/Dovecot как таковые не тянут 500 ящиков (тянут, это классическая нагрузка для
enterprise-инсталляций), но именно контейнерный bundle mailcow "из коробки" не спроектирован на такой
масштаб без доп. усилий по разнесению компонентов.
https://oneuptime.com/blog/post/2026-01-15-install-mailcow-dockerized-ubuntu/view

**[инференс, сведение в конкретные ориентиры под 500 ящиков]**: для 500 активных ящиков с почтовым
клиентом (MailExpert), постоянно опрашивающим IMAP/делающим IDLE, разумный стартовый ориентир —
**16 ГБ RAM** (page cache для индексов и горячих Maildir/dbox-файлов — Dovecot активно выигрывает от
файлового кэша ОС, это стандартная рекомендация "больше RAM = меньше диска" для IMAP-серверов, отдельного
прямого источника с точной формулой RAM/ящик под этот кейс не найдено, значение экстраполировано из общих
рекомендаций Dovecot/mailcow выше), **NVMe/SSD с гарантированным количеством IOPS** (а не "просто SSD" —
на виртуалках у бюджетных провайдеров shared-IOPS ограничения могут стать узким местом раньше, чем RAM
или CPU, согласно приведённой выше цитате Dovecot про диск как основное узкое место), и **раздельные тома**
под ОС/контейнеры и под почтовые данные, чтобы рост данных не грозил забить системный диск.

### 6.3. Backup sizing

Общая формула для расчёта объёма БД/хранилища почты, встречающаяся в отраслевых материалах:
`Database Size = (Max Quota + Retention) × Число ящиков × 1.10 (оверхед) × 0.60 (коэффициент сжатия)`.
https://dohost.us/index.php/2026/03/21/handling-100gb-mailboxes-strategies-for-large-scale-syncing/

Рекомендация по бэкапам — классическое правило **3-2-1** (3 копии данных, 2 типа носителей, 1 копия
вне основной инфраструктуры/облака), адаптированное для почты: продакшн-ящик = копия 1, локальный бэкап
(снапшот/дамп) = копия 2, air-gapped/offsite копия вне основного облачного провайдера = копия 3.
https://inboxdone.com/best-practices-for-email-backup-and-recovery/

Комплаенс-ориентированные сроки хранения (если применимо к юрисдикции/отрасли клиентов) — например,
HIPAA 6 лет, IRS (США) 7 лет — заметно длиннее "коробочных" ретеншенов облачных провайдеров (14-30 дней),
это стоит учитывать отдельно, если у кого-то из 500 клиентов есть регуляторные требования к хранению
переписки.
https://www.hornetsecurity.com/en/blog/retention-archiving-email-security/

**[инференс, ориентир для бэкапа]**: при оценке "живого" объёма писем 1-2.5 ТБ (см. 6.1) и стандартной
практике хранить минимум 2-4 полных снапшота с ретеншеном плюс инкременты, разумно закладывать под бэкапы
**в 2.5-4 раза больше объёма "живых" данных** на отдельном хранилище (в идеале — у другого провайдера/в
другом ДЦ), то есть порядка 3-8 ТБ бэкап-ёмкости в первый год эксплуатации с ростом пропорционально росту
основного хранилища (см. 6.1 про +20-30%/год).

---

## Сводка ключевых находок и открытых вопросов

1. Продукт официально переименован в "Built-in security add-on for on-premises mailboxes", но по сути
   и по цене — это тот же "EOP standalone"; работает с любым SMTP-сервером, не только Exchange.
   https://learn.microsoft.com/en-us/exchange/standalone-eop/standalone-eop
2. Официального публичного прайса и минимума лицензий на 2026 год не нашлось — нужен прямой запрос к
   CSP/реселлеру для 500 лицензий; ориентир по рынку ≈ $2/ящик/мес при годовой оплате.
3. Обязательное условие для релея исходящей почты через EOP — ваши домены-отправители должны быть
   accepted domains тенанта (или сертификат с matching subject name); при этом типе относится ли трафик
   к relay pool или к обычному пулу репутации — принципиально важно для доставляемости, и у вас условие
   выполняется по построению схемы.
4. **TERRL применяется и к вашему сценарию** — весь исходящий на внешние адреса трафик тенанта считается
   в лимит, независимо от происхождения (облачный ящик или локальный сервер через коннектор). Для 500
   лицензий ориентировочный лимит ≈ 48 248 внешних получателей/сутки на тенант (исправлено 2026-09-30,
   было ≈ 46 500; первые 60 дней тенанта — 10-25% от этого, 2.7) **[инференс]** — стоит
   подтвердить у Microsoft/CSP, что именно EOP standalone-лицензии считаются в формуле.
5. ~~Открытый вопрос: применяется ли лимит "10 000 получателей/сутки на ящик" к гибридному
   сертификат/IP-based коннектору без привязки к конкретному EXO-ящику.~~ Закрыт 2026-09-30: к add-on
   для локальных ящиков лимиты на ящик не применяются (2.6).
6. Для DBEB и корректного отклонения писем на несуществующие адреса вам придётся программно зеркалить
   каждый созданный в Postfix/Dovecot ящик как mail user в M365-тенанте (нет AD/Entra Connect для
   автосинхронизации) — это отдельная интеграционная задача для MailExpert. (Ревизия 2026-09-28:
   без этого Internal Relay даёт постоянный NDR-бэкскаттер, а не просто менее эффективную фильтрацию —
   [eop-review.md](eop-review.md), находки 8-9.)
7. DKIM для исходящей почты логично доверить EOP (подпись accepted domain на стороне EOP), а не
   разворачивать отдельный signing agent на Postfix. (Ревизия 2026-09-28: mailcow подписывает
   автоматически при создании домена, если это не выключено явно — двойной подписи без действия не
   избежать; подписывает ли EOP коннекторный relay, не подтверждено — [eop-review.md](eop-review.md),
   находка 3.)
8. PTR вашего узла формально не критичен для исходящей доставляемости (raз весь outbound через EOP), но
   практически обязателен из-за требований хостеров к разблокировке порта 25 и общей гигиены сервера.
9. Провайдеры входного TCP 25/PTR: Contabo и Netcup — минимум трения; Scaleway — уникально self-service
   разблокировка; Hetzner/OVH — предсказуемо, но с задержкой на рассмотрение заявки; DigitalOcean — не
   рекомендуется как основной вариант для почтового релея.
10. 500 ящиков — на грани "коробочного" масштаба готовых бандлов вроде mailcow; чистый Postfix/Dovecot
    (не обязательно через mailcow-контейнеризацию) на выделенном узле с 16 ГБ RAM и NVMe с гарантированными
    IOPS — более реалистичная стартовая точка, с диском как основным риском по производительности.
