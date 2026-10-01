# Панель и EOP: требования к работе через EOP + mailcow

> Статус: требования от 2026-09-30. Собраны из трёх исследований того же дня: код MailExpert (`main`,
> `62529906`), документация Microsoft Learn (даты страниц в «Источниках») и исходники mailcow-dockerized
> (коммит `ca07d8d3`, тег `2026-09`). Сами исследования в репозиторий не входят; факты с источниками
> перенесены сюда и в [ревизию EOP](eop-review.md). Решения по разделу 7 — за владельцем.

Обозначения: без пометки — проверено по источнику (код, Learn, исходники mailcow, документация Postfix);
**Inferred** — вывод без прямого источника, требует проверки; **V-2** — подтверждено только вторичным
источником (блог, зеркало Message Center).

Плейсхолдеры: `<MAIL_HOST>` — имя узла, `<NODE_IP>` — его IPv4, `<PANEL_IP>` — IPv4 панели, `<DOMAIN>` —
почтовый домен, `<tenant>` — префикс `<tenant>.onmicrosoft.com`, `<EOP_HOST>` — значение MX одного из
доменов в тенанте (читается из Graph `serviceConfigurationRecords`: `<token>.mail.protection.outlook.com`
у доменов, добавленных до июля 2026, или имя под `mx.microsoft` у новых), `<EOP_RANGE>` — диапазон адресов
EOP из веб-сервиса Microsoft.

## 1. Зачем и границы

Сегодня панель умеет три шага из примерно 35 ручных шагов [runbook узла](../../operations/mail-node.md):
настройки узла, домен на узле и ящик. Остальное — DNS, коннекторы, relayhost, TLS, DKIM, лимиты, спам,
файрвол — делается руками, и панель не знает, сделано ли это. Документ фиксирует, что панель должна делать
сама, что остаётся за хостом узла и тенантом Microsoft, и что можно построить и проверить на локальном
стенде без тенанта EOP. Архитектурные находки и их доказательства — в [eop-review.md](eop-review.md),
лицензии, лимиты и хостинг — в [eop-and-hosting.md](eop-and-hosting.md), общий итог — в [README.md](README.md).

## 2. Как работает схема

### 2.1. Пути почты

**Вход.** Интернет → MX домена (`<EOP_HOST>` этого домена) → фильтрация EOP (заголовки, карантин) →
коннектор EOP → узел (порт 25 узла открыт только диапазонам EOP) → postscreen → rspamd → Dovecot LMTP →
Sieve (глобальный `before` → пользовательский → глобальный `after`) → INBOX или Junk → панель по IMAP.

**Выход.** Панель по SMTP 587 с логином ящика → Postfix: проверка отправителя (sender ACL), лимит rspamd,
DKIM-подпись mailcow → next-hop `<EOP_HOST>:25` (relayhost домена или общий relayhost), TLS по TLS Policy
Map, клиентский сертификат `<MAIL_HOST>` → коннектор узел → EOP, атрибуция тенанта по сертификату →
исходящая фильтрация EOP и лимит тенанта (TERRL) → интернет.

### 2.2. Коннекторы в терминах Microsoft

Microsoft считает направление относительно тенанта, а не узла. **Прежние версии документов узла
(mail-node.md, eop-and-hosting.md, README.md) называли их наоборот**: «входящий» у них — EOP → узел.
Исправлено 2026-09-30; в коде и автоматизации — только названия командлетов:

| Объект Microsoft | Направление | Ключевые параметры |
|---|---|---|
| Inbound connector (`New-/Set-/Get-InboundConnector`) | узел → EOP | `ConnectorType OnPremises`, `SenderDomains`, `TlsSenderCertificateName <MAIL_HOST>`; IP-вариант `SenderIPAddresses` — только IPv4 |
| Outbound connector (`New-/Set-/Get-OutboundConnector`) | EOP → узел | `ConnectorType OnPremises`, `UseMXRecord $false`, `SmartHosts <MAIL_HOST>`, `TlsSettings DomainValidation`, `TlsDomain <MAIL_HOST>`, `RecipientDomains` или `AllAcceptedDomains` |

- Все эти командлеты, а также `Validate-OutboundConnector`, `Set-AcceptedDomain`, `New-MailUser`,
  `New-MailContact`, `*-DkimSigningConfig`, `Set-HostedContentFilterPolicy`, `Get/Remove-BlockedConnector`,
  `Get-MessageTraceV2`, `*-TenantAllowBlockListItems`, `Release-QuarantineMessage` доступны в add-on
  («Applicable: … Built-in security add-on for on-premises mailboxes»). `New-AcceptedDomain` — только
  on-prem Exchange: в облаке домен добавляется через Graph или центр администрирования.
- У Outbound connector параметра клиентского сертификата нет. У Inbound connector `RequireTls` и
  `RestrictDomainsToCertificate` описаны как «только для Partner»: для `OnPremises` атрибуция держится на
  `TlsSenderCertificateName` и том, что пишет мастер EAC. Точный набор свойств, который мастер ставит в
  коннектор по сертификату, не документирован (**Inferred**: `SenderDomains {smtp:*;1}`,
  `TlsSenderCertificateName <MAIL_HOST>`, `RequireTls $true`). Поэтому коннекторы создаёт владелец мастером
  EAC один раз, а `Get-InboundConnector | Format-List` снимается как эталон (R-25).
- Релей наружу EOP разрешает, если имя сертификата совпадает с accepted domain тенанта **или** все домены
  отправителей — accepted domains. Цепочка сертификата без промежуточного CA даёт
  `550 5.7.64 TenantAttribution; Relay Access Denied`.
- В тенантах Microsoft 365 E5 developer создавать Inbound connector нельзя: для экспериментов нужен
  платный или пробный тенант с add-on.

### 2.3. MX и smart host

- MX — значение на домен, а не одно имя на тенант. У доменов, добавленных после 2026-07-01, MX лежит под
  `mx.microsoft`; единственный источник значения — Graph `GET /domains/{id}/serviceConfigurationRecords`
  (V-2: Message Center MC1048624; веб-сервис IP-адресов уже публикует `*.mx.microsoft` в записи SMTP).
  Выводить MX из имени домена нельзя.
- Next-hop узла (`<EOP_HOST>`) — один на узел: MX одного из доменов тенанта. Какой именно домен,
  не важно, если тенант атрибутирует письмо по сертификату, а не по имени хоста (**Inferred**, проверка —
  раздел 6). Панель хранит ожидаемые MX каждого домена отдельно от `<EOP_HOST>`: первые нужны проверке DNS,
  второе — relayhost и TLS Policy Map.
- TLS к `<EOP_HOST>` зависит от формы имени. У `*.mail.protection.outlook.com` TLSA нет, и уровень `dane`
  mailcow откатывается к непроверенному TLS — нужна запись TLS Policy Map. Для новых хостов под
  `mx.microsoft` Microsoft объявила зоны с DNSSEC и TLSA (входящий SMTP DANE с DNSSEC в GA, блоги Exchange
  Team «Announcing general availability of inbound SMTP DANE with DNSSEC» и «Modernizing DNS Security for
  Exchange Online Mail Flow»): для такого `<EOP_HOST>` штатный `dane` может уже проверять сертификат, а
  `secure` с правилом `nexthop, dot-nexthop` — упасть на несовпадении имени. Что ставить в TLS Policy Map
  (`secure`, `dane` или ничего) для каждой формы, решает эксперимент 4 (раздел 6).

### 2.4. Next-hop в Postfix mailcow

В mailcow три разных механизма, и названия в интерфейсе путаются:

| Механизм | API | Ключ выбора |
|---|---|---|
| Relayhost (в UI — «Sender-dependent transports») | `add/relayhost`, `edit/domain {relayhost:<id>}` | домен или ящик **отправителя** (`sender_dependent_default_transport_maps`, `postfix.sh:108-153`) |
| Transport maps | `add/transport` | адрес или домен **получателя** (`transport_maps`, `postfix.sh:155-164`) |
| Общий `relayhost` | нет, только `data/conf/postfix/extra.cf` + перезапуск `postfix-mailcow` | всё, что не поймали первые два (`main.cf:18`, дописывание `extra.cf` — `postfix.sh:479-491`) |

- **Отбивки и DSN** (`MAIL FROM:<>`) не попадают под relayhost домена: пустой отправитель Postfix ищет
  по ключу `<>` (`empty_address_default_transport_maps_lookup_key`, `postconf(5)`), а запрос mailcow
  содержит `%d`, и по `mysql_table(5)` для ключа без домена запрос не выполняется — результата нет. Тогда
  Postfix берёт `default_transport`, а next-hop — из общего `relayhost` (**Inferred** по документации
  Postfix; проверяется на стенде). Поэтому общий relayhost в `extra.cf` обязателен, API его не заменяет.
- **`add/transport destination="*"` небезопасен** (рекомендация прежней версии eop-review, находка 2,
  отозвана): `transport_maps` старше `virtual_transport` (`transport(5)`), штатный приём «сначала свои
  домены с пустым результатом, потом `*`» в mailcow невыразим — `add/transport` требует непустой
  `nexthop` (`functions.transports.inc.php:204-211`). Транспорт `*` уведёт в EOP и почту на собственные
  домены узла, петля EOP → узел → EOP (**Inferred**, один тест на стенде). Кроме того, пока таблица
  транспортов пуста, `destination` не валидируется вовсе (`functions.transports.inc.php:213-261`).
- **Ключ TLS Policy Map — дословный next-hop** со скобками и портом, если они есть (Postfix TLS_README).
  Одна строка — голое имя `<EOP_HOST>` без скобок и порта — должна стоять в `hostname` relayhost, в
  `relayhost` файла `extra.cf` и в `dest` TLS Policy Map. Голое имя Postfix сначала ищет по MX, потом по
  A (`transport(5)`); у хостов EOP MX обычно нет, так что работает и так (**Inferred** для самих хостов
  EOP). Как `add/tls-policy-map` обработает `dest` со скобками (`idn_to_ascii`), не выяснено — ещё один
  довод за голое имя.
- TLS по умолчанию: `smtp_tls_security_level = dane` (`main.cf:84`); в `smtp_tls_policy_maps` первой идёт
  карта mailcow из БД, второй — `postfix-tlspol` (DANE и MTA-STS, `main.cf:153`). Запись в TLS Policy Map
  выигрывает у tlspol. `add/tls-policy-map` без `active: 1` создаёт выключенную запись
  (`functions.tls_policy_maps.inc.php:33`).

### 2.5. rspamd видит только EOP

Вся входящая почта приходит с адресов EOP, и rspamd оценивает SPF по адресу EOP, а не настоящего
отправителя. Веса: `R_SPF_FAIL = 8`, `R_DKIM_REJECT = 8`, `DMARC_POLICY_QUARANTINE = 8`,
`DMARC_POLICY_REJECT = 16` (`local.d/policies_group.conf:5-20`) при пороге `add_header = 8` и
`reject = 15` (`local.d/actions.conf`). Письмо от домена со строгим SPF может уйти в Junk и карантин, а
при DMARC `p=reject` — получить отказ на SMTP, который EOP превратит в NDR исходному отправителю
(**Inferred**: поведение rspamd; конфигурация проверена).

Диапазоны EOP как «forwarding hosts» mailcow (`add/fwdhost`) это закрывают, и это больше, чем думала
прежняя версия eop-review (находка 13):
- postscreen пропускает такие адреса без DNSBL (`whitelist_forwardinghosts.sh` → `forwardinghosts.php`);
- greylisting не применяется (`local.d/greylist.conf:1`, `local.d/force_actions.conf:7-11`);
- `reject` понижается до `add header`, то есть письмо уходит в Junk, а не отклоняется
  (`local.d/force_actions.conf:2-6`) — это и есть «per-IP force action» из находки 14;
- с символов групп `rbl`, `policies`, `hfilter` снимаются положительные веса, группа `neural`
  отключается целиком (`local.d/composites.conf:50-52`); `SPOOFED_UNAUTH` и `FREEMAIL_POLICY_FAILURE` такие
  адреса не трогают.

Цена этого решения:
- `UPSTREAM_CHECKS_EXCLUDE_FWD_HOST` (`local.d/composites.conf:54-56`) гасит для forwarding hosts символ
  rspamd `MICROSOFT_SPAM`, который читает `X-Forefront-Antispam-Report`, — rspamd перестаёт учитывать
  вердикт EOP;
- `SPOOFED_UNAUTH` (вес 50, `local.d/composites.conf:29-32`) не срабатывает для forwarding hosts, то есть
  пропадает защита от чужого письма с `From` на собственный домен узла;
- значит, после R-12 вердикт EOP доходит до Junk **только** через Sieve-правило R-11: R-12 без R-11 не
  включать.

Ловушка: `filter_spam` по умолчанию 0, и тогда rspamd ставит адресу pre-result `accept` и не проверяет
письмо вовсе (`functions.fwdhost.inc.php:20,41-46`, `rspamd.local.lua:340-341`). Для EOP всегда
`filter_spam: 1`. Имя хоста в `add/fwdhost` раскрывается в IP один раз, в момент вызова, поэтому
диапазоны нужно синхронизировать (R-12). Антивирус узла выключен (`SKIP_CLAMD=y`), так что понижение
`reject` для вирусов здесь ничего не меняет. Тумблера greylisting в UI и API mailcow 2026-09 нет — только
файл `local.d/greylist.conf`.

### 2.6. Спам-заголовки EOP и Junk

- Для получателей вне облака EOP письмо в Junk не кладёт: при `MoveToJmf` (действие по умолчанию для
  спама) он ставит заголовки, раскладка — задача узла.
- `X-Forefront-Antispam-Report`: поля `ИМЯ:значение` через `;`. `SFV`: `SPM` (спам), `SKS` (спам до
  фильтра, правило потока), `SKB` (блок-лист политики), `BLK`, `NSPM` (не спам), `SFE/SKA/SKI/SKN` (обход),
  `SKQ` (выпущено из карантина). `CAT`: `SPM`, `HSPM`, `PHSH`, `HPHSH`/`HPHISH`, `BULK`, `SPOOF`, `MALW`
  и др. Решать по `SFV` и `CAT`, не по SCL: в облаке SCL не определяет действие. Заголовок бывает свёрнут
  на несколько строк.
- `HighConfidencePhishAction` принимает только `Redirect` и `Quarantine` (`Set-HostedContentFilterPolicy`).
  Вариант «переключить явный фишинг в MoveToJmf» из прежней находки 6 невозможен; остаются карантин
  администратора или `Redirect` на отдельный адрес (допустим ли адрес на узле — **Inferred**).
- Правило раскладки — глобальный `prefilter` mailcow (`add/global-filter`). Штатный `global_sieve_after`
  содержит три правила: `X-Spam-Flag: YES` → Junk, `X-Moo-Tag` с плюс-адресацией → `INBOX/<tag>`,
  `duplicate` → `discard`. Каждый вызов `add/global-filter` перезаписывает файл целиком и перезапускает
  `dovecot-mailcow` (`functions.mailbox.inc.php:124,131,159,166`) — рвутся IMAP-сессии панели.

### 2.7. DKIM

- mailcow: `add/domain` берёт `key_size` и `dkim_selector` из шаблона `Default` (2048, `dkim`) и сразу
  создаёт ключ (`functions.mailbox.inc.php:664-672`, `init_db.inc.php:1443-1444`); `key_size: 0` ключ не
  создаёт. rspamd подписывает по домену envelope-from, ключ из Redis подхватывается без перезапуска.
  `get/dkim/<DOMAIN>` отдаёт готовое значение TXT `dkim_txt` (с `t=s;s=email`) и селектор. Ротации нет:
  один ключ и один селектор на домен, смена — `delete/dkim` + `add/dkim`.
- EOP: `New-DkimSigningConfig -Enabled $false` → `Get-DkimSigningConfig` отдаёт `Selector1CNAME` и
  `Selector2CNAME` → две CNAME в DNS → `Set-DkimSigningConfig -Enabled $true`. Формат CNAME сменился в мае
  2025 (новые домены — под `dkim.mail.microsoft`), синтезировать значения нельзя, только читать.
- Подписывает ли EOP почту, релеемую с узла через коннектор, документация не говорит; две её фразы
  противоречат друг другу. Несколько подписей на письме допустимы. Открытый вопрос — раздел 6.

### 2.8. Accepted domains и DBEB

- Домен в тенант: Graph `POST /domains` → `verificationDnsRecords` (TXT) → `verify` →
  `PATCH supportedServices` → `serviceConfigurationRecords`. Тип: `Set-AcceptedDomain -DomainType
  InternalRelay|Authoritative`. Когда домен появляется в `Get-AcceptedDomain` после `verify`, не
  документировано; умолчание для нового домена — Authoritative (**Inferred**), поэтому `InternalRelay`
  ставить сразу, до смены MX.
- Internal Relay: неизвестный адрес отклоняет узел уже после `250 OK` EOP, и EOP шлёт NDR на (часто
  поддельный) адрес отправителя — бэкскаттер ([eop-review](eop-review.md), находка 8). Удаление ящика в
  панели — это `delete/mailbox` на узле (до 2026-10-01 было `active: 0`), то есть каждый удалённый адрес
  становится таким источником.
- DBEB (Authoritative) отклоняет неизвестный адрес на границе, `550 5.4.1 Recipient address rejected:
  Access denied`. Для этого каждый адрес узла — ящик **и каждый алиас** — должен быть получателем в
  тенанте. Объект — mail contact (`New-MailContact`, без учётных данных) или mail user (`New-MailUser`,
  создаёт учётную запись входа, `RemotePowerShellEnabled` по умолчанию `$true`). Что DBEB принимает
  контакты, следует из самой статьи DBEB (**Inferred**). `New-EOPMailUser` в текущей документации нет.
  Лицензия Exchange Online на mail user технически не нужна; коммерческие условия add-on («на защищаемого
  получателя») определяет партнёр.
- Catch-all mailcow зеркалировать нельзя: домен с catch-all остаётся Internal Relay (**Inferred**).
- `ExternalEmailAddress`, указывающий в тот же домен, рискует петлёй `554 5.4.14 Hop count exceeded`;
  Microsoft требует для такой схемы Authoritative-домен и Outbound connector `OnPremises` со смарт-хостом.
  Работает ли это для не-Exchange узла — первый эксперимент DBEB (раздел 6).

### 2.9. Лимиты

- Лимиты Exchange Online на ящик (10 000 получателей в сутки, 30 писем в минуту) к add-on для локальных
  ящиков **не применяются** (страница лимитов EOP). Действуют лимит тенанта TERRL и лимиты политики
  исходящего спама (0-10 000 в час и в сутки).
- TERRL — уникальные **внешние получатели** тенанта за скользящие 24 часа: `500 × лицензии^0.7 + 9500`.
  Для 500 лицензий это 48 248 (в прежних документах 46 500-46 575 — арифметическая ошибка). Считается и
  почта, релеенная с узла. Превышение — `550 5.7.233`. V-2: с 2026-09-14 тенант младше 31 дня получает 10%
  расчётного лимита (~4 825 для 500 лицензий), 31-60 дней — 25% (~12 062), пробный тенант — 500 в сутки
  (`5.7.232`); Learn этого пока не отражает. Учитываются ли лицензии add-on в формуле, прямо не подтверждено.
- Отправка с адресов `@<tenant>.onmicrosoft.com` — не больше 100 внешних получателей в сутки.
- Лимит mailcow (`rl_value`) считает **сообщения** на SASL-логин и только для аутентифицированных отправок
  (`rspamd.local.lua:697-736`). Прямого пересчёта в получателей нет — это разные единицы.
- При признаках компрометации EOP блокирует коннектор целиком: `550 5.7.711 Access denied, bad inbound
  connector. AS(2204)`; снятие — `Remove-BlockedConnector`, до часа.

### 2.10. Диапазоны EOP

Веб-сервис `endpoints.office.com`: `version` раз в час, `endpoints` только при смене версии, `changes` для
дельты. `ClientRequestId` (GUID, один на установку) обязателен: без него сервис отвечает 400. Частые
запросы `endpoints` — 429. Фильтр — `serviceArea == "Exchange"` и `tcpPorts` содержит `25`, не по `id`. На
2026-09-30 в этой записи 4 диапазона IPv4 и 2 IPv6, имена `*.mail.protection.outlook.com` и
`*.mx.microsoft`. В ответе `version` есть поле `serviceArea`, которого нет в документации: парсер должен
пропускать незнакомые поля.

## 3. Кто что делает

| Что | Где живёт | Как меняется | Частота |
|---|---|---|---|
| `SKIP_CLAMD/OLEFY/FTS`, `ENABLE_IPV6`, привязка портов | `mailcow.conf` на хосте | файл + `docker compose down && up -d` | узел |
| Общий `relayhost = <EOP_HOST>` | `data/conf/postfix/extra.cf` | файл + перезапуск `postfix-mailcow` | узел |
| Настройки Dovecot (`dovecot-extra.conf`) | `data/conf/dovecot/extra.conf` | файл + перезапуск | узел |
| Пороги и greylisting rspamd | `data/conf/rspamd/local.d/{actions,greylist}.conf` | файл + перезапуск `rspamd-mailcow` | узел, по решению |
| Файрвол `DOCKER-USER`, таймер диапазонов EOP | хост | скрипт, таймер | узел |
| Ключ API mailcow и его `allow_from` | админка mailcow | руками (бутстрап) | узел |
| TLS Policy Map, relayhost, домен, DKIM mailcow, лимиты, глобальный prefilter, forwarding hosts, псевдонимы, sender ACL, очередь, логи, карантин | БД mailcow | API mailcow из панели | узел, домен, ящик |
| Whitelist fail2ban для `<PANEL_IP>` | админка mailcow | руками или API `get/fail2ban` + `edit/fail2ban {action: "whitelist"}` (R-13) | узел |
| Домен в тенанте, TXT-верификация, ожидаемый MX, трассировка, алерты | тенант | Graph (app-only) | домен |
| Тип accepted domain, коннекторы (сверка, список доменов), DKIM EOP, антиспам-политика, блокировки коннектора, зеркало DBEB, карантин EOP | тенант | EXO PowerShell V3 (app-only) | тенант, домен, ящик |
| Создание коннекторов | тенант | владелец мастером EAC, один раз | тенант |
| MX, SPF, DKIM (TXT или CNAME), DMARC, TXT верификации, A и PTR узла | DNS | владелец домена; панель показывает и проверяет | домен, узел |

## 4. Требования к панели

Формат: **что** и **зачем** (ссылка на находку или раздел 2), **как** (точный вызов), размер (S — до дня,
M — 2-4 дня, L — неделя и больше), **без EOP** — можно ли построить и проверить без тенанта и как.

Общее для вызовов mailcow: каждое «применить» идемпотентно — сначала `get/*`, потом `add/*` или `edit/*`
только при расхождении; в `add/*` явно передавать `active: 1` (пропущенные булевы становятся 0:
`functions.tls_policy_maps.inc.php:33`, `functions.mailbox.inc.php:704-707`,
`functions.transports.inc.php:194-195`); ответ 200 с `type != success` панель уже считает отказом
(`mailcow.js:90-96`); `edit/*` имеет форму `{items:[...], attr:{...}}`, `delete/*` — массив.

### Фундамент

**R-01. Настройки узла без перезаписи.** S.
- Что: сохранение настроек узла сливает поля, а не заменяет JSON; новые поля (R-06) переживают
  «Проверить и сохранить».
- Зачем: `saveMailNodeConfig` пишет `config = EXCLUDED.config` ровно с четырьмя полями
  (`backend/src/services/mailNode/mailcow.js:79-86`), `PUT /api/mail-node/config` вызывает его на каждое
  сохранение (`backend/src/routes/mailNode.js:69-95`).
- Как: `config = integration_config.config || EXCLUDED.config` или отдельная строка
  `provider='eop_tenant'`; секреты — тем же `encrypt`.
- Без EOP: да — pglite-тест: сохранить узел, дописать поле, пересохранить, поле на месте.

**R-02. Таблица доменов и состояние онбординга.** M.
- Что: `mail_node_domains` (домен, кто и когда добавил, лимит ящиков, режим DKIM, id relayhost, лимит
  отправки, ожидаемые MX, результат проверки DNS и время, состояние тенанта, тип accepted domain, общее
  состояние). Состояния: `node_created → node_configured → dns_ok → tenant_verified → internal_relay →
  connector_ready → ready → authoritative` (последнее — при DBEB). Шаг, который делает человек и который
  нечем проверить, подтверждается кнопкой «Сделано» с автором и датой.
- Зачем: у панели нет учёта доменов, всё читается из `get/domain/all` (`mailcow.js:137-144`); домен,
  заведённый в mailcow руками без EOP, неотличим от настроенного.
- Как: миграция; `routes/mailNode.js:97-121` читает БД и узел вместе; домен на узле без строки
  показывается как «неизвестный» с действием «Принять».
- Решение владельца (2026-10-01): домен не пропадает и не теряет состояние сам по себе из-за ошибки.
  Недоступный узел, ошибка mailcow, пустой или неполный список доменов, отсутствие `created` не меняют
  и не удаляют строки и не переводят состояния; администратор видит записи панели с пометкой «узел не
  отвечает», а не пустой список. Другое время создания домена на узле (`created` не совпадает с
  `node_created`) — только предупреждение администратору: состояние и создание ящиков не меняются,
  администратор принимает новое время (`mail_node.domain_identity_acknowledged`) или начинает
  подключение заново. «Начать подключение заново» сбрасывает состояние в `node_created`, шаги и поля
  узла и тенанта, оставляет режим DKIM и лимит отправки, пишет `mail_node.domain_state_changed` с
  `how: 'restarted'` и не трогает ящики домена. Строки `mail_node_domains` панель сама не удаляет
  никогда.
- Без EOP: да — против mailcow стенда; шаги тенанта — подтверждение руками или фейковый `TenantDriver`.

**R-03. Ящик — только на домене `ready`.** S.
- Зачем: сейчас годится любой активный домен узла (`backend/src/routes/accounts.js:185-188`,
  `frontend/src/utils/mailNode.js:83`), список доменов открыт всем (`routes/mailNode.js:97-105`).
- Как: фильтр по состоянию в `GET /domains` и в `createDomainMailboxNow`; администратор может явно
  перевести домен в `ready` без тенанта (стенд, пилот).
- Без EOP: да — домен в `node_created` не виден в форме, API отвечает 400.

**R-04. Права на создание и удаление ящиков узла.** S.
- Что: сейчас создание ящика узла (`kind: 'domain'`) обходит `requireAdmin` (`accounts.js:229-231`),
  удаление доступно любому вошедшему (`accounts.js:463`, замысел — `accounts.shared.test.js:32`). С DBEB
  каждое действие меняет каталог тенанта и, возможно, число оплачиваемых получателей.
- Как: решение D-8 (раздел 7.1): создание остаётся за любым вошедшим пользователем без лимита — панель
  закрытая, доступ только по одобрению в Cloudflare. Удаление — с подтверждением вводом адреса ящика (R-33).
- Без EOP: да — route-тесты.

**R-05. Журнал действий узла и тенанта.** S.
- Что: `mail_node.config_changed`, `mail_node.domain_added`, `mail_node.applied` (что изменено на узле),
  `mailbox.quota_changed`, `mailbox.rate_limit_changed`, признак `mailNode` в `mailbox.deleted`,
  `tenant.domain_state_changed`, `tenant.job_failed`, `tenant.connector_unblocked`.
- Зачем: `routes/mailNode.js:69-172` не пишет в журнал; список действий — `backend/src/services/auditLog.js:6-11`;
  записи без ящика допустимы (`backend/migrations/0057_mailbox_audit_log.sql:10`).
- Без EOP: да.

**R-06. Настройки EOP.** S.
- Что: экран рядом с «Почтовым узлом»: `<EOP_HOST>`, домен сертификата `<MAIL_HOST>`, режим DKIM,
  лимиты по умолчанию, фактический TERRL (вводится руками из отчёта EAC), параметры подключения к тенанту
  (id тенанта, id приложения, отпечаток сертификата — R-35). До тенанта это журнал ручных шагов с
  проверками того, что проверяемо. Демо-данные для экрана (обещание демо для всех экранов настроек).
- Зачем: `<EOP_HOST>`, режим DKIM и лимиты нужны R-07..R-10 и R-19, а в настройках узла сейчас только
  host, ключ, квота и ping URL (`mailcow.js:56-66`); ручные шаги тенанта панель никак не отмечает.
- Без EOP: да.

### Настройка узла через API mailcow

**R-07. TLS Policy Map на `<EOP_HOST>`.** S.
- Зачем: без записи TLS к EOP не проверяется (раздел 2.4; [eop-review](eop-review.md), находка 1).
- Как: `get/tls-policy-map/all`; если нет `dest = <EOP_HOST>` — `add/tls-policy-map {dest:"<EOP_HOST>",
  policy:"secure", parameters:"", active:1}`, при расхождении — `edit/tls-policy-map`. `policy` PHP не
  проверяет (в БД ENUM, `init_db.inc.php:318`) — панель валидирует сама. Политика зависит от формы
  `<EOP_HOST>` (раздел 2.3): для `*.mail.protection.outlook.com` — `secure`; для имени под `mx.microsoft`
  с объявленными DNSSEC и TLSA — `secure`, `dane` или без записи, по итогам эксперимента 4. Панель хранит
  выбранную политику в настройках (R-06), а не зашивает `secure`.
- Без EOP: частично. На стенде с fake-EOP (раздел 5): `policy=encrypt` → в `get/logs/postfix`
  «Untrusted TLS connection established to <fake>»; `policy=fingerprint`, `parameters=match=<sha256>` →
  «Verified»; `dest` со скобками или портом → строки нет. `secure` против настоящего сертификата EOP —
  только тенант: CA стенда нет в `smtp_tls_CAfile` Postfix (`main.cf:79`).

**R-08. Relayhost домена на `<EOP_HOST>`.** S.
- Зачем: relayhost домена виден через API (панель может сверить его), `extra.cf` — нет.
- Как: `get/relayhost/all`; если нет `hostname = <EOP_HOST>` — `add/relayhost {hostname:"<EOP_HOST>"}`
  без `username`/`password` (иначе включится SASL, `postfix.sh:176-211`). После `add/domain` —
  `edit/domain {items:["<DOMAIN>"], attr:{relayhost:<id>}}`: `add/domain` relayhost не принимает
  (`functions.mailbox.inc.php:610-611`), существование id `edit/domain` не проверяет. Ответ
  `get/relayhost/all` содержит пароли открытым текстом (`functions.transports.inc.php:148-176`) — не
  логировать. `add/transport destination="*"` не использовать никогда (раздел 2.4).
- Без EOP: да — письмо ящика на внешний адрес приходит в fake-EOP, `get/logs/postfix` показывает
  `relay=<fake>`.

**R-09. DKIM mailcow по решению владельца.** S.
- Зачем: сейчас `addDomain` не передаёт DKIM-параметры (`mailcow.js:149-162`), и подпись идёт до
  публикации ключа ([eop-review](eop-review.md), находка 3).
- Как: `add/domain` с `key_size: 2048, dkim_selector: "dkim"` или `key_size: 0`. С ключом — сразу
  `get/dkim/<DOMAIN>` и показ записи `dkim._domainkey.<DOMAIN>` TXT = `dkim_txt`; домен не переходит в
  `dns_ok`, пока TXT не совпал по `p=`. При `SPLIT_DKIM_255` mailcow отдаёт `dkim_txt` кусками по 255
  символов в кавычках через пробел (`functions.dkim.inc.php:255-257`): перед показом и сравнением
  нормализовать (снять кавычки, склеить; то же для TXT из DNS, R-14). Для уже созданных доменов без записи — публикация или
  `delete/dkim ["<DOMAIN>"]`. Новый ключ — `delete/dkim` + `add/dkim {domains, dkim_selector, key_size}`.
- Без EOP: да — письмо через submission стенда приходит в fake-EOP с `DKIM-Signature: d=<DOMAIN>`;
  с `key_size: 0` подписи нет.

**R-10. Лимиты отправки.** S.
- Зачем: один ящик может заблокировать общий коннектор всем ([eop-review](eop-review.md), находка 7);
  mailcow лимитов по умолчанию не ставит (`init_db.inc.php:1436-1437,1456-1457`).
- Как: `rl_value`/`rl_frame` сразу в `add/domain` и `add/mailbox` (`functions.mailbox.inc.php:655-658`,
  `:1402-1408`), правка — `edit/rl-domain`, `edit/rl-mbox {items, attr:{rl_value, rl_frame}}`,
  `rl_frame ∈ s|m|h|d`, пусто или 0 снимает лимит (`functions.ratelimit.inc.php:6-138`). Правка лимита
  ящика — в таблице ящиков рядом с квотой (`routes/mailNode.js:157-172` как образец). Мягкий отказ панель
  уже переводит в «rate limiting» (`backend/src/routes/send.js:41-43`).
- Учесть: лимит — сообщения на логин, TERRL — внешние получатели на тенант (раздел 2.9). Значение по
  умолчанию — 50 писем в час на ящик (решение D-10): сервис для точечной переписки, лимит страхует от
  взломанного ящика; администратор меняет его для отдельного ящика. Сверка с бюджетом
  `0.8 × TERRL / число ящиков` получателей в сутки — при подключении тенанта (**Inferred**). Панель сама шлёт от ящика пересылкой правил
  (`backend/src/services/ruleForwarder.js`) — это тоже расходует лимит.
- Без EOP: да — лимит `2 / 1m`, третье письмо получает отказ, событие видно в `get/logs/ratelimited`.

**R-11. Раскладка спама EOP в Junk.** S.
- Зачем: раздел 2.6; [eop-review](eop-review.md), находка 5.
- Как: `get/global_filters/prefilter` → сравнить с эталоном панели → только при расхождении
  `add/global-filter {filter_type:"prefilter", script_data}`. `postfilter` не трогать. Вызов
  перезапускает Dovecot — по отдельной кнопке с предупреждением, не внутри общего «Применить». Правило
  (решения D-2 и D-11, R-42): фишинг и вредоносное (`CAT` из `PHSH|HPHSH|HPHISH|MALW`) — в Junk всегда, в
  том числе после выпуска из карантина (`SFV:SKQ`): явный фишинг панель выпускает сама и показывает в
  «Спаме» в безопасном режиме; спам, массовая рассылка и подделка (`SFV` из `SPM|SKS|SKB` или `CAT` из
  `SPM|HSPM|BULK|SPOOF`) — в Junk, кроме `SFV:SKQ`. Что выпущенное письмо сохраняет `CAT`, проверяет
  эксперимент 17. Сравнение по границе токена `;`, потому что заголовок бывает свёрнут. `:regex` — если
  расширение `regex` есть в Pigeonhole mailcow (**Inferred**), иначе `:contains` с разделителем. mailcow
  проверяет скрипт PHP-парсером, а не `sievec` (`functions.mailbox.inc.php:105-119`), — эталон в тестах
  компилировать `sievec`. `fileinto` без `stop` не прерывает пользовательские скрипты (**Inferred**:
  возможна вторая копия) — проверить на стенде.
- Без EOP: да — письмо с `X-Forefront-Antispam-Report` через порт 25 внутри сети стенда: `SFV:SPM` и
  `SFV:SKQ;CAT:PHSH` → Junk, `SFV:SKQ;CAT:SPM` и `SFV:NSPM` → INBOX; Junk панель видит опросом
  (`backend/src/services/imapManager.js:6647-6650`).

**R-12. Диапазоны EOP как forwarding hosts.** S-M. По решению D-3. Требует R-11.
- Зачем: раздел 2.5. Цена там же: rspamd перестаёт учитывать `MICROSOFT_SPAM` и `SPOOFED_UNAUTH` для этих
  адресов, поэтому включать только вместе с R-11 или после него — иначе вердикт EOP до Junk не дойдёт.
- Как: `get/fwdhost/all` → сравнить с актуальными CIDR (запись Exchange/25 веб-сервиса, раздел 2.10) →
  `add/fwdhost {hostname:"<EOP_RANGE>", filter_spam:1}` и `delete/fwdhost ["<EOP_RANGE>"]`. Без
  `filter_spam: 1` не отправлять никогда. Источник списка — тот же разбор, что у таймера файрвола (R-40):
  панель читает веб-сервис сама или берёт результат таймера.
- Без EOP: да — `docker exec rspamd-mailcow rspamc -i <адрес из диапазона EOP> -f a@<домен с -all в SPF>
  -r b@<DOMAIN> < msg` до и после `add/fwdhost`: до — `R_SPF_FAIL`, после — без понижения до reject.

**R-13. Whitelist fail2ban для панели.** S.
- Что: `<PANEL_IP>` в whitelist fail2ban (runbook, раздел 3, шаг 7), чтение для проверки раздела 9.
- Зачем: панель ходит ко всем ящикам с одного адреса; бан за неудачные входы одного ящика отрезал бы все.
- Как (решение владельца 2026-10-01): `get/fail2ban` (`json_api.php:1277`), затем
  `edit/fail2ban {items:["<PANEL_IP>"], attr:{action:"whitelist"}}` (`json_api.php:2022-2029`, ветка
  `whitelist` в `functions.fail2ban.inc.php`) только для недостающих адресов: добавляет адрес в whitelist и
  снимает бан с него, больше ничего не трогает. Обычная правка (`functions.fail2ban.inc.php:239-250`)
  заменяет `whitelist` целиком, а пропущенные `ban_time_increment` и `manage_external` сбрасывает в 0, —
  её панель применяет только чтобы убрать адрес, который сама добавила и который убрали из настройки:
  читает все поля `get/fail2ban` и отправляет их обратно без этого адреса (другого способа убрать адрес в
  API нет). Адрес панели — IP или сеть не шире `/24` (IPv4) и `/48` (IPv6).
- Без EOP: да — стенд: после правки `get/fail2ban` показывает прежние `ban_time_increment`,
  `manage_external` и `blacklist` и дополненный `whitelist`.

### Проверка DNS и сертификата

**R-14. Проверка DNS домена.** M.
- Что: MX — ровно ожидаемые значения (из Graph или введённые руками до тенанта), других MX нет; SPF — одна
  запись `v=spf1` с `include:spf.protection.outlook.com`, без `ip4:<NODE_IP>`; DKIM по режиму — TXT
  `dkim._domainkey` совпадает с `get/dkim` по `p=` после нормализации кусков по 255 символов (R-09; формула
  как в mailcow `dns_diagnostics.php:402-410`)
  и/или CNAME `selector1/selector2._domainkey` равны `Selector1CNAME/Selector2CNAME`; DMARC `_dmarc`
  начинается с `v=DMARC1`; TXT верификации тенанта равен `text` из `verificationDnsRecords`; `_mta-sts`
  — предупреждение, если политика mailcow публикует MX узла (приём сломается). Autodiscover не нужен.
- Зачем: раздел 6 runbook; сейчас панель не знает, опубликовано ли что-то.
- Как: `node:dns` `Resolver` с настраиваемым сервером (например `DNS_CHECK_RESOLVER`), без кэша, с
  таймаутами; результат — в `mail_node_domains`. Страница `dns_diagnostics.php` mailcow не годится: она
  отдаёт HTML и ожидает MX на узел (`dns_diagnostics.php:108-112`).
- Без EOP: да — юнит-тесты с подменой резолвера, обе формы MX; на стенде dnsmasq или CoreDNS с зоной
  `stage.test`.

**R-15. Проверка узла: A, PTR, AAAA и сертификат.** S.
- Что: A `<MAIL_HOST>` = `<NODE_IP>`, PTR `<NODE_IP>` = `<MAIL_HOST>`, AAAA нет, если IPv6 выключен;
  сертификат на 587 (STARTTLS, порт открыт панели): срок, SAN = `<MAIL_HOST>`, полная цепочка.
- Зачем: цепочка без промежуточного CA даёт `550 5.7.64` ([eop-review](eop-review.md), находка 1). Postfix
  предъявляет EOP `/etc/ssl/mail/cert.pem` (`main.cf:80-81`) — тот же сертификат `MAILCOW_HOSTNAME`,
  который acme кладёт для smtpd, поэтому цепочка на 587 — разумная замена прямой проверки (**Inferred**).
- Без EOP: да — CA стенда; «leaf без промежуточного» — фикстура.

### Эксплуатация

**R-16. Очередь узла.** M.
- Зачем: при `4xx` от EOP или блокировке коннектора письма копятся в deferred, а панель этого не видит;
  сейчас очередь смотрят только в админке mailcow или `postqueue` на хосте.
- Как: `get/mailq/all` (`postqueue -j`, до 10 000 записей; состав полей задаёт Postfix — проверить на
  стенде), `get/postcat/<qid>`, `edit/mailq {items:[qid], attr:{action:"hold"|"unhold"|"deliver"}}`,
  `edit/mailq {attr:{action:"flush"}}`, `delete/mailq [qid]`. `super_delete` в панели не давать. Только
  администратор.
- Без EOP: да — fake-EOP отвечает 451, письмо видно как deferred, `deliver` после снятия отказа.

**R-17. Статус доставки и отбивки.** M-L.
- Зачем: сотрудник видит «отправлено», хотя EOP потом отказал: `send.js:33-51` знает только ответ узла на 587.
- Как: (1) `get/logs/postfix` — строки `status=sent|deferred|bounced`, `relay=`, `dsn=` по queue id
  (фильтр на стороне панели; глубина — `LOG_LINES`); (2) DSN `multipart/report` в ящике — пометить
  исходное письмо «не доставлено» по `Original-Message-ID`/`Message-ID`. Словарь кодов: `5.7.64`
  (атрибуция, сертификат), `5.7.711 AS(2204)` (коннектор заблокирован), `5.7.233` и `5.7.232` (TERRL,
  пробный тенант), `5.4.1` (DBEB), `5.4.14` (петля маршрутизации).
- Без EOP: да — fake-EOP отвечает этими кодами. Настоящие тексты и ATTR-коды — только тенант.

**R-18. Оповещения.** S-M.
- Сигналы: `5.7.711`/`AS(2204)`, `5.7.64`, `5.7.233` в логах; deferred больше N писем или старше T;
  сертификат `<MAIL_HOST>` истекает меньше чем через 14 дней; контейнеры (`get/status/containers`); обход
  EOP (R-19); с тенантом — `Get-BlockedConnector` (R-27). Диск уже есть.
- Зачем: сейчас панель следит только за диском узла (`diskWatch.js`), а блокировку коннектора или
  истёкший сертификат клиенты заметят раньше владельца.
- Как: отдельная проверка Healthchecks тем же механизмом ping URL, что у диска (`diskWatch.js:14-37`).
- Без EOP: да.

**R-19. Контроль обхода EOP.** S.
- Что: любая строка `status=sent` в `get/logs/postfix`, у которой `relay=` не указывает на EOP и не на
  локальную доставку в Dovecot, — тревога: почта ушла мимо EOP (нет общего relayhost, неверный relayhost
  домена). Postfix пишет `relay=` как разрешённое имя и адрес (`relay=<имя>[<IP>]:25`), и имя не обязано
  совпасть с `<EOP_HOST>` буквально: считать «через EOP», если совпало имя **или** IP входит в диапазоны
  EOP (раздел 2.10, тот же список, что у R-12 и R-40).
- Зачем: `extra.cf` через API не прочитать, а отбивки без него уходят напрямую (раздел 2.4).
- Без EOP: да — фикстуры строк лога; на стенде прогон с `extra.cf` и без него.

**R-20. Карантин mailcow и история rspamd.** M.
- Зачем: письма, которые rspamd узла счёл спамом (в том числе из-за SPF по адресу EOP, раздел 2.5), лежат в
  карантине mailcow, куда сотрудники панели не ходят; ложные срабатывания некому выпустить.
- Как: `get/quarantine/all`, `get/quarantine/<id>` (сырое письмо, символы, IP), `edit/qitem {items:[id],
  attr:{action:"release"|"learnham"}}`, `delete/qitem`, настройки `edit/quarantine`;
  `get/logs/rspamd-history` — «почему письмо в Junk». Копия попадает в карантин и при `add header`
  (`metadata_exporter.conf:2-7,45-56`), то есть и то, что уже лежит в Junk (проверено на стенде
  2026-10-02).
- Без EOP: да.
- Сделано (2026-10-02): раздел 5.5; настройки `edit/quarantine` панель не пишет (там же, «Отличия»).

**R-21. Бюджет TERRL.** S.
- Что: уникальные внешние получатели за скользящие 24 часа (журнал `message.sent` панели и/или
  `get/logs/postfix`), порог 80% (совет Microsoft), фактический лимит из R-06, рампа молодого тенанта.
  Получатели на accepted domains не считаются.
- Зачем: превышение TERRL останавливает внешнюю почту всего тенанта (`550 5.7.233`), а лимиты mailcow
  считают сообщения, не получателей (раздел 2.9).
- Без EOP: да — чистая функция, таблица значений: 100 лицензий → 22 059, 500 → 48 248; 10% и 25%.

### Тенант

**R-22. `TenantDriver` и `tenant-worker`.** L.
- Что: интерфейс `TenantDriver` с двумя реализациями: `GraphClient` (Node, client credentials по
  сертификату) и `ExoRunner` (отдельный контейнер `tenant-worker`: pwsh + модуль ExchangeOnlineManagement,
  только типизированные операции, JSON на входе и выходе). Задания — таблица PostgreSQL (`tenant_jobs`:
  операция, аргументы, состояние, попытки, последняя ошибка, время следующей попытки) и один исполнитель с
  блокировкой в БД: backend рассчитан на один процесс (`backend/src/services/mailNode/currentPassword.js:10-13`).
  Вне пути HTTP-запроса: подключение EXO занимает секунды и десятки секунд.
- Зачем: коннекторы, типы доменов, DKIM EOP, антиспам, карантин и получатели DBEB доступны только через EXO
  PowerShell (публичного REST нет), домены и трассировка — через Graph; без общего драйвера R-23..R-31 не
  построить и не протестировать без тенанта.
- Как: `Connect-ExchangeOnline -AppId <id> -Organization <tenant>.onmicrosoft.com -Certificate <X509>`
  (или `-CertificateFilePath` + `-CertificatePassword`; `-CertificateThumbprint` только в Windows)
  `-CommandName <белый список> -SkipLoadingFormatData`, один долгоживущий сеанс (частые connect/disconnect
  текут памятью). Модуль 3.10.x требует PowerShell 7.6+, иначе закрепить 3.9.2 на 7.4+. Образ
  `mcr.microsoft.com/powershell` — 90-150 МБ сжатым, в образ backend не класть. Права: `Exchange.ManageAsApp`
  + роль Entra Exchange Administrator; Graph — `Domain.ReadWrite.All`, `ExchangeMessageTrace.Read.All`,
  `SecurityAlert.Read.All` (application). Exchange Online Admin API v2.0 (Preview) не замена: шесть
  эндпоинтов без коннекторов, получателей, DKIM и антиспама. Недокументированный `adminapi/beta/InvokeCommand`
  — не основа.
- Без EOP: да — фейковый `ExoRunner` отдаёт записанный JSON, Graph — HTTP-мок по формам ответов Learn;
  контрактный тест против живого тенанта — вручную, как проверка OAuth.

**R-23. Домен в тенанте через Graph.** M.
- Зачем: без домена в тенанте нет ни релея, ни MX; MX нового домена можно узнать только из Graph (раздел
  2.3), а TXT верификации — показать владельцу домена.
- Как: `POST /domains {"id":"<DOMAIN>"}` → `GET /domains/<DOMAIN>/verificationDnsRecords` (показать
  `label`, `recordType`, `text`, `ttl`) → проверка DNS (R-14) → `POST /domains/<DOMAIN>/verify` →
  `PATCH /domains/<DOMAIN> {supportedServices:["Email"]}` → `GET /domains/<DOMAIN>/serviceConfigurationRecords`
  → ожидаемый MX в `mail_node_domains`. Затем опрос `Get-AcceptedDomain` с повторами: задержка не
  документирована.
- Без EOP: да — мок, обе формы MX. Реальные задержки и формат TXT — тенант.

**R-24. Тип accepted domain.** S.
- Зачем: новый домен, вероятно, Authoritative по умолчанию (раздел 2.8): до зеркала получателей EOP
  отклонял бы почту на все адреса узла.
- Как: как только домен виден в `Get-AcceptedDomain`, до смены MX — `Set-AcceptedDomain -Identity <DOMAIN>
  -DomainType InternalRelay`. `Authoritative` — только из R-29, после полного зеркала.
- Без EOP: логика — да; поведение — тенант.

**R-25. Коннекторы: эталон, сверка, список доменов.** M.
- Что: владелец создаёт оба коннектора мастером EAC один раз; панель снимает `Get-InboundConnector` и
  `Get-OutboundConnector` как эталон, затем сверяет ключевые свойства (`ConnectorType OnPremises`,
  `TlsSenderCertificateName`, `SmartHosts`, `TlsSettings`, `TlsDomain`, список доменов) и показывает
  расхождения.
- Зачем: домен, не добавленный в Outbound connector, не доходит до узла; чужая правка коннектора (TLS,
  smart host) ломает приём или атрибуцию молча — сейчас это видно только в EAC.
- Как: новый домен — `Set-OutboundConnector -Identity <имя> -RecipientDomains @{Add="<DOMAIN>"}` (решение
  D-9); проверка — `Validate-OutboundConnector -Identity <имя> -Recipients <адрес>@<DOMAIN>`, затем
  `Set-OutboundConnector -IsValidated $true -LastValidationTimestamp <UTC>` (сам `Validate-*` статус не
  ставит). Для Inbound connector команды проверки нет: реальная отправка и трассировка.
- Без EOP: мок; настоящее — тенант.

**R-26. DKIM в EOP.** S-M. Если по решению D-1 подписывает EOP.
- Зачем: значения CNAME нельзя вычислить (формат сменился в мае 2025), их надо прочитать и показать
  владельцу домена, а включение возможно только после публикации.
- Как: `New-DkimSigningConfig -DomainName <DOMAIN> -Enabled $false -KeySize 2048` →
  `Get-DkimSigningConfig -Identity <DOMAIN>` (`Status`, `Selector1CNAME`, `Selector2CNAME`) → показать
  CNAME `selector1._domainkey` и `selector2._domainkey` → опрос `Set-DkimSigningConfig -Identity <DOMAIN>
  -Enabled $true` до успеха (пока CNAME не видны, команда падает с ошибкой). Ротация —
  `Rotate-DkimSigningConfig`, вступает через 96 часов.
- Без EOP: мок; подпись релейной почты — тенант.

**R-27. Блокировка коннектора.** S.
- Зачем: блокировка Inbound connector останавливает исходящую почту всех ящиков узла
  ([eop-review](eop-review.md), находка 7); алерт Microsoft уходит администраторам тенанта, а не в панель.
- Как: опрос `Get-BlockedConnector` раз в 5-10 минут (пусто — норма); `Remove-BlockedConnector
  -ConnectorId <GUID>` только по кнопке администратора с подтверждением и ссылкой на процедуру Microsoft
  «Respond to a compromised connector»; снятие действует до часа. Роли: снятие — Organization Management
  или Security Administrator, чтение — Global Reader, Security Reader. Попадает ли встроенный алерт
  «Suspicious connector activity» в Graph `security/alerts_v2` — **Inferred**.
- Без EOP: мок; быстрый сигнал по логам (R-18) работает без тенанта.

**R-28. Антиспам-политика — только чтение.** S.
- Зачем: раскладка R-11 работает, только если EOP доставляет спам на узел с заголовками; действие
  `Quarantine` в политике молча уводит письма туда, где сотрудники их не видят (находка 6).
- Как: `Get-HostedContentFilterPolicy -Identity Default` → показать `SpamAction`, `HighConfidenceSpamAction`,
  `PhishSpamAction`, `HighConfidencePhishAction`; предупреждать, если действие расходится с раскладкой
  R-11 (например `Quarantine` для обычного спама — сотрудники его не увидят). `Set-HostedContentFilterPolicy`
  — только по решению владельца (D-2), не кнопкой по умолчанию.
- Без EOP: мок.

**R-29. DBEB: зеркало получателей.** L. По решениям D-4..D-7.
- Что: желаемое множество — адреса ящиков и алиасов (без catch-all) доменов, идущих в DBEB; фактическое —
  `Get-Recipient -ResultSize unlimited` (или `Get-MailContact`) по домену; создать недостающих, удалить
  лишних; пачками по 20-50 с экспоненциальными повторами («you might encounter throttling», числа нет).
- Зачем: без зеркала домен остаётся Internal Relay, и каждый неизвестный или удалённый адрес даёт
  бэкскаттер от EOP ([eop-review](eop-review.md), находки 8-9); синхронизации из не-AD каталога у Microsoft нет.
- Как: контакт — `New-MailContact -Name -ExternalEmailAddress` + `-HiddenFromAddressListsEnabled $true`;
  mail user — `New-MailUser -Name -ExternalEmailAddress -MicrosoftOnlineServicesID -Password` +
  `RemotePowerShellEnabled $false`. Алиасы — proxy-адреса (`Set-MailContact -EmailAddresses
  @{Add="smtp:<alias>@<DOMAIN>"}`, синтаксис **Inferred**), до 400 на получателя. Удаление —
  `Remove-MailContact`/`Remove-MailUser`. Переход в `Authoritative`: 100% адресов видны в `Get-*`, пробное
  письмо на несуществующий адрес получает `550 5.4.1`, на существующий доходит. Отчёт о расхождениях
  «узел / панель / тенант» (ручные ящики mailcow, ящики, перехваченные `provisionMailbox`).
- Без EOP: да для логики — фейковые `ExoRunner` и API mailcow, тесты порядка операций, повторов и
  идемпотентности; поведение DBEB — только тенант (раздел 6, эксперимент 8).

**R-30. Трассировка по запросу.** M.
- Зачем: логи узла (R-17) заканчиваются на передаче в EOP; что EOP сделал с письмом дальше (доставил,
  отфильтровал, задержал), видно только в трассировке тенанта.
- Как: кнопка «статус доставки» у письма: Graph `GET /admin/exchange/tracing/messageTraces` с `$filter` по
  `messageId` (v1.0; нужен сервис-принципал `8bd644d1-64a1-4d4b-ae52-2e0cbf64e373` в тенанте, провижининг
  до нескольких часов) или `Get-MessageTraceV2 -MessageId` (для add-on подтверждён, Graph для add-on —
  **Inferred**). Окно запроса до 10 суток, история 90; 100 запросов за 5 минут на тенант — кэш и очередь,
  не непрерывный опрос.
- Без EOP: мок.

**R-31. Карантин EOP и Tenant Allow/Block List.** L. Только если по D-2 явный фишинг остаётся в карантине.
- Зачем: у сотрудников панели нет учётных записей Microsoft, самообслуживание карантина им недоступно, и
  ложное срабатывание «high confidence phish» иначе выпускается только из портала Defender.
- Как: `Get-QuarantineMessage`, `Release-QuarantineMessage -Identity <id> (-ReleaseToAll | -User <адрес>)
  [-AllowSender] [-ReportFalsePositive]`; TABL — `New/Get/Remove-TenantAllowBlockListItems` (без Defender
  500 allow + 500 block на подтип, без срока — 30 дней). Graph-эквивалента нет. Риск: выпущенное письмо на
  локального получателя может снова попасть в карантин.
- Без EOP: только интерфейс против мока.

### Жизненный цикл ящика и псевдонимов

**R-32. Создание ящика.** S без DBEB, M с DBEB.
- Зачем: сейчас `provisionMailbox` не ставит лимит отправки (`mailcow.js:205-218`), не смотрит на
  состояние домена и ничего не делает в тенанте, а с DBEB порядок «узел → тенант» обязателен (находка 9).
- Как: домен `ready` (R-03) → `add/mailbox` с `rl_value`/`rl_frame` (R-10) → строка панели → задание
  «создать получателя» (R-29). В `authoritative`-домене письма на новый адрес получают `550 5.4.1`, пока
  получатель не создан, — ящик показывается «ожидает тенант». Удалённый в панели ящик удалён и на узле,
  поэтому повторное создание адреса делает новый пустой ящик; отключённый ящик на узле не
  перехватывается (`mailbox_disabled_on_node`), активный ящик, заведённый руками, перехватывается
  (`provisionMailbox`) и тоже ставит задание.
- Без EOP: да.

**R-33. Удаление и отключение.** S-M.
- Зачем: удаление — `delete/mailbox` на узле вместе с почтой (с 2026-10-01; до этого было
  `active: 0`, и письма оставались на диске), на Internal Relay удалённый адрес — источник бэкскаттера,
  а с DBEB неверный порядок оставляет окно, где EOP принимает почту на уже удалённый адрес (находка 9).
- Как (решение владельца 2026-10-01): удаление ящика узла отложенное. Запросить его может любой вошедший
  (`POST /api/accounts/:id/deletion` с адресом и обязательной причиной), ящик продолжает работать N дней
  (настройка узла, по умолчанию 5, от 1 до 90; изменение не сдвигает уже назначенные даты) с пометкой
  «будет удалён <дата и время>» в боковой панели и в списке ящиков в настройках; отменить может любой
  (`DELETE /api/accounts/:id/deletion`).
  Узел при запросе и отмене не трогается. Затем фоновое задание (`services/mailNode/mailboxDeletion.js`,
  строки — источник истины, строка берётся в работу пометкой `deletion_started_at`, после которой отмена отклоняется; повторы с растущей паузой) выполняет: с DBEB — сначала убрать получателя в
  тенанте (хук `BEFORE_NODE_DELETE`, заполняется вместе с драйвером тенанта, R-29), затем
  `delete/mailbox`, затем строку (при ошибке узла строка остаётся ожидающей, ящик, которого на узле уже
  нет, строку не держит); журнал `mailbox.deletion_requested` / `_cancelled` / `mailbox.deleted` с
  `pending: true`, автором запроса, датой и причиной. После удаления в тенанте EOP (домен в `authoritative`) отклоняет
  адрес на границе синхронно, без бэкскаттера. Без DBEB удалённый адрес — источник NDR от EOP: runbook
  должен это говорить. mailcow переносит каталог ящика в `/var/vmail/_garbage` и стирает его через
  `MAILDIR_GC_TIME` минут; если перенести не удалось, ящик всё равно удалён, предупреждение узла
  попадает в журнал (`nodeWarnings` в `mailbox.deleted`). «Отключить» у ящиков узла нет: `PUT` с
  `enabled: false` отвечает `mail_node_disable_unsupported`. «Только приём» (`active: 2`) — отдельное
  действие администратора, если понадобится. Аудит с признаком узла.
- Решение D-14 (раздел 7.1): у ящиков узла действия «Отключить» нет (у подключённых Gmail остаётся — там это
  пауза синхронизации). Запрос на удаление ящика узла подтверждается вводом его адреса целиком, как
  удаление репозитория на GitHub, и причиной; текст подтверждения говорит, что ящик работает до даты
  удаления, затем уходит безвозвратно со всей почтой из панели и с узла (позже и из EOP), что вместе с ним
  на узле удаляются псевдонимы, доставляющие только в него (они перечислены), что почта на адрес потом
  отклоняется и что до даты удаление может отменить любой. Удаление получателя в тенанте — более поздний
  этап (R-29): оно добавится в то же задание. У подключённого Gmail удаление сразу отключает ящик от
  панели — обычное подтверждение.
- Без EOP: да.

**R-34. Псевдонимы ящика узла.** S-M.
- Зачем: сейчас принимается любая строка (`accounts.js:566-607`), а отправка ставит адрес псевдонима в From
  (`send.js:209-218`, `:316`) и, по умолчанию nodemailer, в envelope (**Inferred**). mailcow проверяет
  **envelope** отправителя: `reject_authenticated_sender_login_mismatch` по `smtpd_sender_login_maps`
  (`main.cf:102-107`, `postfix.sh:318-373`), заголовок From не проверяет. Псевдоним без записи на узле
  получает отказ на SMTP.
- Как: домен псевдонима — только домен узла в `ready`; внешние домены для ящика узла запрещены (не
  `extended_sender_acl`). Адрес, отличный от адреса ящика, — `add/alias {address, goto:<ящик>, active:1,
  sender_allowed:1}` (по умолчанию оба 0, `functions.mailbox.inc.php:704-707`) или `edit/mailbox
  {attr:{sender_acl:[...]}}` (полная замена — сначала `get/mailbox`). Учесть `aliases: 400` на домен
  (`mailcow.js:155`). С DBEB — proxy-адрес в тенанте (R-29). Удаление — `delete/alias` и proxy-адрес.
- Без EOP: да — отправка на 587 стенда: свой адрес, чужой адрес домена, алиас с `sender_allowed` и без,
  внешний домен.

### Спам и фишинг в панели

**R-41. Безопасный показ писем из «Спама».** M.
- Что: письмо в папке Junk (и письмо с пометкой фишинга или вредоносного содержимого в любой папке)
  открывается как текст: без картинок и внешних ресурсов, ссылки не кликаются, у каждой ссылки виден
  настоящий адрес и отдельно — её хост; вложения не открываются и не скачиваются одним нажатием. Сверху —
  предупреждение с причиной из заголовка EOP (`CAT`, R-11, словами) и кнопка «Показать полностью».
  Отправитель, тема, дата и получатели видны как обычно. Ответ, пересылка и печать такого письма берут
  этот же текст, а не HTML.
- Зачем: решение D-2 (раздел 7.1) — явный фишинг не остаётся в карантине, а доходит до «Спама»; человек
  должен видеть, от кого письмо, но не открыть опасное содержимое случайно.
- Как: признак письма из папки Junk (`special_use \Junk` или сопоставление папок) и из `X-Forefront-Antispam-Report`:
  в любой папке закрыты `CAT` фишинга и подделки (`PHSH`, `HPHSH`, `HPHISH`, `INTOS`, `DIMP`, `UIMP`, `GIMP`,
  `BIMP`) и вредоносного (`MALW`, `AMP`, `SAP`, `FTBP`) — коды по странице Microsoft «Anti-spam message
  headers»; `SPOOF` закрывает письмо только в «Спаме», в других папках письмо показывается как обычно под
  предупреждением «отправитель может быть подделан». Текст берётся из HTML, когда он есть (его письмо и
  показывает), текстовая часть — только у письма без HTML. «Показать полностью» — на одно письмо, не
  запоминается.
- Сделано (2026-10-01): синхронизация хранит `CAT` в `messages.eop_category` (миграция 0083), строки
  списка и ответ `/body` отдают его. Письма, синхронизированные до миграции, получают категорию, только
  если синхронизация прочитает их снова (полная пересинхронизация папки); до того безопасный режим у них
  только по папке. Адреса ссылок — в
  виде WHATWG URL (хост в punycode, управляющие символы закодированы, `user@` перед хостом виден),
  невидимые и bidi-символы показаны как `[U+202E]`.
- Без EOP: да — фикстуры писем с заголовками EOP на стенде и в render-тестах.

**R-42. Автовыпуск явного фишинга из карантина EOP.** M.
- Что: исполнитель тенанта (R-22) регулярно читает карантин EOP (`Get-QuarantineMessage -QuarantineTypes
  HighConfPhish`) и выпускает письма получателям на узле (`Release-QuarantineMessage -ReleaseToAll`); на узле
  правило R-11 кладёт их в Junk, панель показывает по R-41. Каждый выпуск — в журнал (R-05).
- Зачем: решение D-2 — `HighConfidencePhishAction` допускает только `Quarantine` и `Redirect`, а владелец
  хочет видеть такие письма в «Спаме», а не у администратора.
- Как: задание `tenant_jobs` по таймеру; идемпотентность по идентификатору письма в карантине.
- Без EOP: частично — логика на фейковом `ExoRunner`; что выпущенное письмо доходит и не возвращается в
  карантин, какие у него заголовки — эксперимент 17 на тенанте.

### Безопасность и аудит

**R-35. Секреты.** S.
- Ключ mailcow уже хранится зашифрованным. Сертификат приложения Entra — PFX только в read-only томе
  `tenant-worker`, пароль — секрет контейнера (Microsoft: для локального сертификата «no automated and secure
  way»); в БД панели — только id тенанта, id приложения, отпечаток. Не логировать ответы `get/relayhost/all`.
  mailcow сам пишет тела API-запросов в `API_LOG`, маскируя только поля с `pass` в имени (`json_api.php:11-35`).
- Без EOP: да — тест, что логи панели и ответы API не содержат пароля relayhost и пароля PFX; на стенде
  `tenant-worker` стартует с PFX из тома и отказывается стартовать без него.

**R-36. Никакого произвольного PowerShell.** S.
- `tenant-worker` исполняет только операции из белого списка; параметры — провалидированные домены и
  адреса (`parseHostName`, `parseLocalPart`), передаются как аргументы, не склейкой строк; `-CommandName`
  ограничивает загружаемые командлеты.
- Без EOP: да — тесты воркера в режиме печати команд: неизвестная операция и адрес с `;`, `$(...)`,
  кавычками отклоняются до запуска pwsh.

**R-37. Минимальные права.** S.
- Ключ mailcow — rw только с `<PANEL_IP>`; Graph — три application-права из R-22; EXO — сначала Exchange
  Administrator, затем кастомная группа ролей (`New-ServicePrincipal` + `Add-RoleGroupMember`) после проверки
  на тенанте; только чтение (`Get-BlockedConnector`, трассировка) — ролям чтения.
- Без EOP: частично — `allow_from` ключа mailcow проверяется на стенде (запрос не с адреса панели получает
  отказ); набор ролей EXO — только тенант (эксперимент 16).

**R-38. Одновременность и нагрузка на API.** S.
- Массовые операции (лимиты на 500 ящиков, сверка, зеркало) — с ограничением одновременных вызовов по
  образцу `NODE_RESTORE_CONCURRENCY` (`imapManager.js:1588-1590`); `add/global-filter` — никогда в цикле.
- Без EOP: да — на стенде применить лимиты к 500 ящикам (сценарий `load` `e2e-mailcow.sh`), следить за
  числом одновременных запросов к API и за ошибками.

### Хост узла (скрипты, не панель)

**R-39. Скрипт настройки узла.** M.
- Что: `scripts/deploy/mail-node/` — `mailcow.conf` (`SKIP_CLAMD/OLEFY/FTS=y`; `ENABLE_IPV6=false` явно:
  генератор сам ставит `true`, если у хоста работает IPv6, `ipv6_controller.sh:196-236`; альтернатива —
  привязка `SMTP_PORT=<NODE_IP>:25` и других портов, `generate_config.sh:218-226`), `extra.cf` с
  `relayhost = <EOP_HOST>` и перезапуск `postfix-mailcow`, `dovecot-extra.conf`, правила `DOCKER-USER`.
  Идемпотентно, с bats-тестами (инфраструктура есть в `scripts/deploy/test/*.bats`).
- Зачем: это файлы хоста без API (раздел 3); сейчас из них в репозитории есть только `dovecot-extra.conf`,
  остальное владелец делает руками по runbook.
- Без EOP: да.

**R-40. Таймер диапазонов EOP.** S-M.
- Зачем: порт 25 открыт только диапазонам EOP, а список меняется; сейчас сверка ручная и раз в месяц
  ([eop-review](eop-review.md), находка 11).
- Как: раздел 2.10; не применять пустой список; замена правил атомарно (ipset или временная цепочка с
  переключением); IPv4 и, если IPv6 включён, IPv6; пинг Healthchecks. Результат — источник для R-12.
- Без EOP: да — bats и записанный ответ веб-сервиса, случаи 400 без GUID, 429, новое поле в `version`.

## 5. Что можно сделать без EOP

### 5.1. Что добавить в стенд

Стенд — [`scripts/deploy/test/stage.sh`](../../../scripts/deploy/test/stage.sh) и
[`e2e-mailcow.sh`](../../../scripts/deploy/test/e2e-mailcow.sh), описание — [local-stand.md](../../operations/local-stand.md).

- **fake-EOP** — контейнер во внутреннем Docker стенда, в сети compose mailcow, с именем, которое
  резолвится из `postfix-mailcow` (например `eop.test.local`). SMTP-приёмник (Node `smtp-server` или Postfix
  `smtp-sink`) с обязательным STARTTLS на сертификате от CA стенда:
  - запрашивает клиентский сертификат и сверяет CN/SAN с настраиваемым «именем коннектора»; нет
    сертификата или неполная цепочка — `550 5.7.64 TenantAttribution; Relay Access Denied`;
  - пустой отправитель принимает только при совпавшем сертификате (гипотеза про EOP, не факт);
  - тумблеры ответов: `451` (очередь), `550 5.7.711 ... AS(2204)`, `550 5.7.233`, `550 5.4.1`, обрыв связи;
  - складывает принятые письма в каталог и по команде возвращает их на порт 25 узла с добавленными
    `X-Forefront-Antispam-Report` и `Authentication-Results` (имитация пути EOP → узел).
- **TLS к fake-EOP.** CA стенда нет в `smtp_tls_CAfile` Postfix, поэтому на стенде TLS Policy Map
  проверяется политиками `encrypt` («Untrusted») и `fingerprint` («Verified»); `secure` — только на тенанте
  или с пересборкой образа Postfix, чего не делаем.
- **DNS-фикстуры** — dnsmasq или CoreDNS с зоной `stage.test` (MX, SPF, DKIM, DMARC, TXT `MS=...`) и
  переключаемыми «ошибочными» вариантами; резолвер проверки DNS панели смотрит на него.
- **`extra.cf`** стенда: `relayhost = eop.test.local` и перезапуск `postfix-mailcow`; **`ENABLE_IPV6=false`**
  в `mailcow.conf` стенда, как в runbook (сейчас не выставляется, `stage.sh:79-82`).
- **rspamd** проверяется `rspamc -i <ip>` внутри `rspamd-mailcow`: отправитель из docker-сети попадает в
  `mynetworks` (`main.cf:19`) и обходит проверки (**Inferred**), поэтому SMTP-тесты через порт 25 годятся для
  Sieve (он работает в Dovecot в любом случае), но не для оценок rspamd.
- **Тенант** — фейковые `ExoRunner` и Graph в юнит-тестах; `tenant-worker` на стенде собирается и
  запускается в режиме, который печатает команды вместо вызова тенанта.

### 5.2. Порядок работ

| Этап | Требования | Как проверяется |
|---|---|---|
| 0. Стенд | fake-EOP, DNS-фикстуры, `extra.cf`, `ENABLE_IPV6` | `stage.sh up`; письмо ящика наружу приходит в fake-EOP |
| 1. Фундамент | R-01, R-02, R-03, R-05, R-06, демо | pglite и route-тесты; e2e: домен не `ready` не виден в форме |
| 2. Узел через API | R-07, R-08, R-09, R-10, R-11, R-13 | новые проверки `e2e-mailcow-driver.mjs`: `relay=` и TLS-строка в логе, `DKIM-Signature` в fake-EOP, отказ лимита, Junk по заголовку; тест петли `add/transport "*"` и пути DSN через `extra.cf` |
| 3. DNS и сертификат | R-14, R-15 | юнит с подменой резолвера; стенд с зоной `stage.test` |
| 4. Эксплуатация | R-16 … R-21, R-41 | fake-EOP с 4xx/5xx: очередь, DSN, тревоги, обход EOP |
| 5. Хост и rspamd | R-39, R-40, R-12 | bats; `rspamc -i` до и после `add/fwdhost` |
| 6. Жизненный цикл | R-04, R-32, R-33, R-34 (без тенанта) | route-тесты; отправка с алиаса на 587 стенда |
| 7. Тенант на моках | R-22 … R-31, R-42 | фейковые `ExoRunner`/Graph: порядок операций, повторы, идемпотентность, формы ответов |
| 8. Живой тенант | раздел 6 | ручные эксперименты; ответы `Get-*` сохраняются как фикстуры этапа 7 |

Этапы 1-7 не требуют тенанта. Этапы 2-5 можно вести параллельно после 1 (R-01 и R-02 нужны всем).

### 5.3. Этап 2: что сделано (2026-10-01)

Код — `backend/src/services/mailNode/nodeApply.js` (сервис «применить»), клиент API —
`services/mailNode/mailcow.js`, маршруты — `routes/mailNode.js`, миграция `0082_mail_node_apply.sql`, экраны —
`EopSection`, `MailNodeDomainOnboarding`, `MailNodeSection`, `MailNodeApplyResult`, демо — `frontend/src/demo/index.js`.
Порядок и пункты для администратора — [runbook, раздел 6, «Что делает панель»](../../operations/mail-node.md).

Общее: каждый пункт сначала читается (`get/*`), пишется только при расхождении, в `add/*` — явный
`active: 1`; ответ 200 с `type != success` — ошибка пункта, а не всего прогона. Итог по пунктам: `ok`,
`changed` (с `from`/`to`), `failed` (код и слова mailcow), `skipped` (не задана настройка или ждёт
подтверждения; с текущим состоянием узла в `current`, где оно есть), `pending` (правило спама). Прогоны
идут строго по одному (иначе два одновременных добавили бы два relayhost), после первого «узел
недоступен» или «ключ отклонён» остальные пункты помечаются тем же кодом без новых запросов; один таймаут
(например, долгий список ящиков большого домена) — ошибка только своего пункта, второй таймаут за прогон
останавливает остальные. Ящики читаются по домену (`get/mailbox/all/<DOMAIN>`, таймаут 60 с) и только
для доменов, где у панели есть ящики. Что панель сама создала на узле (записи TLS и relayhost, адреса в
whitelist fail2ban), хранится рядом с итогом узла; после смены `<EOP_HOST>` следующий прогон узла удаляет
созданную панелью запись TLS прежнего хоста, а её relayhost — только когда `get/relayhost/all` не
показывает ни доменов, ни ящиков, которые через него отправляют (домены, неизвестные панели, панель не
перепривязывает). Без `<EOP_HOST>` ничего не ставится и не убирается: пункты показывают, что сейчас на
узле. Итог узла — `integration_config` (`mail_node_apply`), итог
домена — `mail_node_domains.apply_result`/`applied_at` (сбрасываются «Начать подключение заново»), журнал —
`mail_node.applied` со списком изменённых и неудавшихся пунктов, только если что-то изменилось или не
удалось.

Когда запускается: кнопка «Применить настройки» (узел и все известные панели домены, которые узел
показывает, или один домен) и сам — после сохранения настроек EOP, если изменились `eopHost`,
`tlsPolicy`, `tlsPolicyParameters`, `dkimMode` или `sendLimitPerHour`; после сохранения настроек узла,
если изменились имя, ключ или адреса панели; после добавления, принятия и перезапуска онбординга
домена. Прогон после сохранения настроек идёт уже после ответа (сохранение не ждёт недоступный узел),
результат виден при следующей загрузке экрана. Автоматический прогон никогда не удаляет ключ DKIM и не
пишет правило спама, а его ошибка не отменяет сохранение, которое его запустило. Состояние онбординга
прогон не меняет: шаг `node_configured` подтверждает человек (решение владельца 2026-10-01).

| Требование | Сделано | Отличия от раздела 4 |
|---|---|---|
| R-07 | запись TLS Policy Map для `<EOP_HOST>`, политика в настройках EOP: `secure` (по умолчанию), `dane`, `dane-only`, `verify`, `fingerprint`, `encrypt` или `default` (записи нет, решает mailcow: MTA-STS или DANE, иначе TLS по возможности, возможен открытый текст; `dane` без TLSA откатывается так же); `none` и `may` не принимаются. Параметры — до 255 символов (VARCHAR mailcow) и по политике: `secure`/`verify` — `match=` только `hostname`, `nexthop`, `dot-nexthop` или имена хостов; `fingerprint` — обязательный `match=` с отпечатками (пары hex); у остальных `match=` не принимается; смена политики в интерфейсе очищает параметры | значение «без записи» — явное `default`, а не пустое поле: пустое поле означает «по умолчанию `secure`» |
| R-08 | relayhost `<EOP_HOST>` без логина (выключенный включается, запись с логином не используется) и `edit/domain {relayhost}` для каждого домена; `relayhost_id` в строке домена | общий relayhost в `extra.cf` панель не ставит и не видит (D-12) |
| R-09 | `add/domain` с `key_size` 2048 или 0 по режиму; режим `mailcow` — ключ создаётся, если его нет, запись TXT (куски `SPLIT_DKIM_255` склеены) показывается с копированием; режим `eop` — `delete/dkim` только по подтверждению в интерфейсе | сравнение записи с DNS (`dns_ok`) — этап 3 (R-14) |
| R-10 | лимит на каждый ящик панели: свой лимит администратора (`email_accounts.node_rl_value`/`node_rl_frame`, `s/m/h/d`) или по умолчанию (`mail_node_domains.mailbox_send_limit`, иначе `sendLimitPerHour` в час); новый ящик — `rl_value`/`rl_frame` в `add/mailbox`, ящик, забранный у mailcow, — `edit/rl-mbox`; `mailbox.rate_limit_changed` | `edit/rl-domain` не используется: в mailcow лимит домена — один общий счётчик на домен (`DYN_RL` по ключу `env_from_domain`, `rspamd.local.lua:685-750`); ящики, которых нет в панели, не трогаются |
| R-11 | правило в `prefilter` между метками панели, `require` в начале, правило в конце, прежнее содержимое сохраняется; запись только отдельной кнопкой с предупреждением и только при расхождении; повторные блоки панели убираются за один проход, блок без конечной метки — отказ `prefilter_markers_broken` без записи; после записи правило читается снова (`prefilter_not_written`, если mailcow ответил «записано», не записав) | после `fileinto "Junk"` стоит `stop`; `PHSH`, `HPHSH`, `HPHISH`, `MALW` — в Junk и при `SFV:SKQ` (D-2/R-42), `SPOOF` добавлен к спаму; сравнение `:regex` (расширение `regex` в Pigeonhole mailcow есть, проверено `sievec`) |
| R-13 | недостающие адреса панели (настройка узла, IP или сеть не шире `/24` и `/48`) — в whitelist fail2ban; адрес, который добавила панель и который убрали из настройки, убирается | `edit/fail2ban {action: "whitelist"}` вместо чтения и записи всех полей (решение владельца 2026-10-01); чтение и запись всех полей — только для удаления адреса панели |

Проверено на стенде (2026-10-01, код ветки в одноразовом контейнере на сети стенда, mailcow `2026-09`):
- R-07: `postmap -q eop.test.local` по карте mailcow отдаёт политику; `encrypt` — «Untrusted TLS connection
  established to eop.test.local», `fingerprint` с `match=<SHA-256 сертификата fake-EOP>` — «Verified TLS
  connection established to eop.test.local»; второй прогон — все пункты `ok`, записей нет.
- R-08: `relay=eop.test.local[...]:25, status=sent`; у `stage.test` relayhost = id записи панели.
- R-09: письмо в fake-EOP подписано `d=stage.test; s=dkim`; временный домен создан с `key_size: 0` без
  ключа, режим `mailcow` создал ключ (`changed`), режим `eop` без подтверждения — `skipped`
  (`dkim_delete_unconfirmed`), с подтверждением — ключ удалён. `SPLIT_DKIM_255` на стенде выключен: склейка
  кусков проверена юнит-тестом по формату `functions.dkim.inc.php:255-257`.
- R-10: новый ящик получил 50 в час, лимит администратора 2 в минуту — третье письмо через submission
  получило `451 4.7.1 Ratelimit "mailcow" exceeded`.
- R-11 (правило по D-2/R-42, проверено повторно): `sievec` компилирует записанный prefilter; второй прогон —
  `ok`, записи нет. `eop inject` (каждый раз новое письмо): `SFV:SKQ;CAT:PHSH`, `SFV:SKQ;CAT:HPHSH`,
  `SFV:SKQ;CAT:MALW`, `SFV:NSPM;CAT:MALW`, `SFV:NSPM;CAT:SPOOF`, свёрнутый `spam` — в Junk;
  `SFV:SKQ;CAT:SPM`, `SFV:SKQ;CAT:SPOOF`, `SFV:SKQ;CAT:BULK`, `clean` — в INBOX. В первом прогоне (прежнее
  правило) — `spam`, `bulk`, `phish`, `high-confidence-phish`, `rule-spam`, `blocked-sender`,
  `high-confidence-spam`, `spoof`, `SFV:NSPM;CAT:BULK`, `SFV:NSPM;CAT:PHSH`, `SFV:NSPM;CAT:HPHISH` — в Junk;
  `none`, `SFV:NSPM;CAT:NONE`, `SFV:SPMX;CAT:SPMTEST` — в INBOX. `postfilter` не изменился (тот же хеш).
  Повторная доставка письма с тем же `Message-ID` вне Junk отбрасывается штатным правилом `duplicate` из
  `postfilter`; письма в Junk до него не доходят из-за `stop`. Письма, пришедшие в секунды перезапуска
  Dovecot, Postfix откладывает (`connect to dovecot:24: Connection refused`) и доставляет потом —
  проверено `postqueue -f`, раскладка та же.
- R-13: в whitelist добавлен адрес, с которого стенд видит панель (`172.22.1.1`), остальные поля
  (`ban_time_increment: true`, `manage_external`, `blacklist`, `max_attempts` и др.) прежние. Добавленный
  панелью второй адрес после удаления из настройки убран чтением и записью всех полей; все поля fail2ban
  (и `regex`) после этого совпали с исходными.
- Смена `<EOP_HOST>` туда и обратно: прогон с новым хостом создал его запись TLS и relayhost, перепривязал
  `stage.test`, удалил запись TLS прежнего хоста и его relayhost (через него больше никто не отправлял);
  обратный прогон сделал то же в другую сторону; письмо после этого ушло `relay=eop.test.local`, `sent`.

Не сделано в этом этапе: проверки в `e2e-mailcow-driver.mjs` (сценарий e2e берёт опубликованные образы,
проверки появятся после слияния), тест петли `add/transport "*"` и пути DSN через `extra.cf` (строка этапа 2
в таблице 5.2).

### 5.4. Этап 3: что сделано (2026-10-01)

Код — `backend/src/services/mailNode/dnsCheck.js` (сами проверки, без БД и mailcow) и `dnsCheckJob.js`
(входные данные, хранение, журнал, расписание), маршруты — `routes/mailNode.js`, экраны —
`MailNodeDnsResult`, `MailNodeDomainOnboarding`, `MailNodeSection`, `EopSection`, демо —
`frontend/src/demo/index.js`. Что проверяется и как читать итог — [runbook, раздел 6, «Проверка
DNS»](../../operations/mail-node.md). Миграции не понадобилось: итог домена — `mail_node_domains.dns_check`
/ `dns_checked_at`, итог узла — `integration_config` (`mail_node_dns_check`), ожидаемые MX —
`mail_node_domains.expected_mx`, введённые руками TXT подтверждения и CNAME селекторов — в
`mail_node_domains.tenant` с `source: 'manual'` (драйвер тенанта потом пишет туда же). «Начать подключение
заново» сбрасывает итог DNS, но не введённые руками значения (ожидаемые MX и `tenant` с `source:
'manual'`): это ввод владельца (решение 2026-10-01). `<NODE_IP>` — одно значение `nodeIp` в настройках
EOP (только IPv4, к узлу по нему никто не подключается); редактируется в настройках «Почтового узла» рядом
с хостом (`GET/PUT /api/mail-node/config` читают и пишут то же значение), настройки EOP показывают его
только для чтения — чтобы при переезде узла имя и адрес менялись в одном месте.

Правило уровней: **ошибка** — запись, которую требует runbook (разделы 3 и 6), отсутствует или не
совпадает так, что почта через EOP ломается или не проходит проверку; **предупреждение** — запись есть и
почта идёт, но в ней лишнее (`ip4:<NODE_IP>`, `?all` в SPF, политика MTA-STS, AAAA узла), PTR узла
отсутствует или не тот (решение владельца 2026-10-01: исходящая почта уходит через EOP), или сравнивать
не с чем (ожидаемое значение не введено). DMARC отсутствует — ошибка (решение владельца), поддомен покрыт
записью родителя. Результаты только предупреждают, состояние онбординга сами не меняют; шаг `dns_ok`
остаётся подтверждением человека, рядом с «Сделано» — итог последней проверки.

Проверка, которая не смогла опросить DNS (неудачная выдача — таймаут, `SERVFAIL`, отказ; неверный
`DNS_CHECK_RESOLVER`; резолвер не ответил на пробный запрос; исключение внутри проверки домена), — не итог:
прежний итог остаётся, рядом записывается `lookupFailed {at, code, detail, checks}`. Она не считается
изменением итога для журнала, не даёт пометки «Ошибки DNS» и сводки; в журнал попадает только запущенная
администратором.

| Требование | Сделано | Отличия от раздела 4 |
|---|---|---|
| R-14 | MX — ровно ожидаемые (любая форма имени, `*.mail.protection.outlook.com` и под `mx.microsoft`, сравнение без регистра и точки в конце); SPF — одна `v=spf1`, `include:spf.protection.outlook.com` с `+` или без квалификатора до `all` (или `redirect=spf.protection.outlook.com` без `all`), `+all` — ошибка, `?all` — предупреждение, разрешающий `ip4:` с сетью, содержащей `<NODE_IP>`, — предупреждение; вложенные include не раскрываются; DKIM — TXT ключа узла сравнивается по `p=` (куски по 255 склеиваются и в ответе mailcow, и в DNS; теги разбираются по одному, пробелы внутри `p=` убираются), CNAME `selector1/2` — в режиме «EOP» и в режиме «mailcow», если значения введены (цель CNAME допускает `_` во всех метках, кроме последней, как у `selector1-contoso-com._domainkey.contoso.n-v1.dkim.mail.microsoft`); DMARC — одна запись, начинается ровно с `v=DMARC1` (значение с учётом регистра, RFC 7489 6.4), поддомен без своей записи — по записи родителя; TXT подтверждения — введённое значение среди TXT домена; `_mta-sts` с `v=STSv1` — предупреждение. Резолвер `node:dns` `Resolver`, новый на каждый прогон (кэш c-ares не переживает прогон), таймаут 3 с, 2 попытки, сервер — `DNS_CHECK_RESOLVER` (IPv4 с портом или без, IPv6 без скобок или в скобках с портом, порт 1-65535 проверяется до c-ares: порт 0 обрушил бы процесс; всё прочее — `dns_resolver_invalid` без запросов) | ожидаемые MX, TXT подтверждения и CNAME селекторов вводит администратор до драйвера тенанта (Graph `serviceConfigurationRecords`/`verificationDnsRecords`, `Get-DkimSigningConfig`); MTA-STS — предупреждение всегда, когда политика опубликована: API mailcow `get` для `mta-sts` не даёт, а саму политику панель не скачивает; ключ DKIM читается с узла (`get/dkim`), при недоступном узле — из последнего применения с пометкой; родители DMARC опрашиваются до двух последних меток без списка публичных суффиксов (дерево, как в DMARCbis, а не «организационный домен» RFC 7489) |
| R-15 | A `<MAIL_HOST>` — ровно `<NODE_IP>` (ошибка); PTR `<NODE_IP>` — `<MAIL_HOST>` и AAAA — предупреждения; сертификат на 587 после STARTTLS (без доверия на время рукопожатия): срок (меньше 14 дней — предупреждение, истёк — ошибка), имена `<MAIL_HOST>` и имени из настроек EOP (`checkHost`, для IP — `checkIP`), цепочка — отдельно от срока и имён | OpenSSL сообщает последнюю встреченную ошибку, а сроки проверяются после цепочки: истёкший лист без промежуточного даёт только `CERT_HAS_EXPIRED` (проверено тестовой цепочкой). Поэтому после ошибки срока цепочка оценивается сама: доходит ли цепочка, которую Node строит из присланного сервером и доверенных корней, до самоподписанного корня. «Нет пути до доверенного корня» — `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (лист без промежуточного, проверено), `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (полная цепочка к недоверенному корню, проверено) и `UNABLE_TO_GET_ISSUER_CERT` (по документации OpenSSL) — все `cert_chain_incomplete`; самоподписанные (`SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`) — `cert_untrusted`. Ответ SMTP длиннее 64 КБ обрывает проверку. Без `<NODE_IP>` A и PTR — предупреждения с тем, что есть в DNS |

Когда запускается: раз в шесть часов (первый прогон через две минуты после старта, запуск панели его не
ждёт) и «Проверить DNS сейчас: узел и все домены» — в фоне, ответ сразу (`202 {started}`), итоги видны
при следующей загрузке; одновременно идёт не больше одного такого прогона, второй запрос к нему
присоединяется. Прогон начинается с пробного запроса A `<MAIL_HOST>` к резолверу: нет ответа — прогон
кончается как «не удалось опросить DNS» для узла и всех доменов (сертификат при этом не читается); домены
проверяются по восемь сразу, не дольше 10 минут на прогон (не начатые к сроку остаются с прежним итогом,
их число попадает в журнал), каждый домен — отдельно от остальных. «Проверить сейчас» у домена и
сохранение «Значений для публикации» проверяют один домен сразу и не ждут прогона всего. Журнал
`mail_node.dns_checked`: каждая проверка администратора (проверка всего — одной записью с итогом узла и
числом доменов по итогам, в том числе не проверенных), плановая — только когда итог узла или домена
изменился (первый итог и неудачный опрос DNS — не изменение). Готовый домен (`ready`, `authoritative`) с
ошибками помечается в списке доменов, у заголовка «Почтового узла» — сводка (число таких доменов и ошибки
узла).

Проверено на стенде (2026-10-01, код ветки в одноразовом контейнере на сети `stage_mailexpert`,
`DNS_CHECK_RESOLVER` = `stage-dns`, ожидаемый MX `stage-test.mail.protection.outlook.com`, TXT
`MS=ms12345678`, `<NODE_IP>` `203.0.113.10`, ключ DKIM — ключ зоны `/opt/stage-dns/dkim.pub`, не ключ
mailcow). Код ветки вызывался напрямую (`checkDomainDns`, `checkNodeDns`, `checkSubmissionCertificate`): на
стенде работают опубликованные образы, поэтому маршруты, форма и хранение на стенде не проверялись — их
покрывают тесты.
- `ok` — всё в порядке, узел (A, PTR, AAAA) в порядке; сертификат `mail.test.local:587` с CA стенда — срок,
  имя и цепочка в порядке; без CA стенда — `cert_chain_incomplete` (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`);
- `no-spf` — `spf_missing`; `spf-ip4` — предупреждение `spf_node_ip`; `spf-double` — `spf_multiple`;
- `no-dkim` — `dkim_missing`; `dkim-mismatch` — `dkim_mismatch`; `dkim-cname` — в режиме «mailcow»
  `dkim_missing`, в режиме «EOP» — в порядке. CNAME селекторов (`selector1-stage-test._domainkey.tenant.onmicrosoft.test`
  и `selector2-...`) передавались в проверку напрямую, не через форму: до исправления разбор введённых
  значений отклонял `_` в цели CNAME. Теперь эти же значения принимает `parseExpectedValues` (тест
  `dnsCheckJob.pglite.test.js`), а `PUT /dns-expected` и форма — значения вида `n-v1.dkim.mail.microsoft`
  (тесты маршрута и экрана);
- `no-dmarc` — `dmarc_missing`; `dmarc-bad` — `dmarc_invalid`;
- `wrong-mx` — `mx_mismatch`; `extra-mx` — `mx_extra`; `mx-new-form` — `mx_mismatch` против прежней формы и в
  порядке против `stage-test.mx.microsoft`;
- `no-ms-txt`, `ms-txt-wrong` — `tenant_txt_missing`; `mta-sts` — предупреждение `mta_sts_published`;
- `no-ptr` — предупреждение `ptr_missing` (после исправления фикстуры: `host-record` dnsmasq сам публиковал
  PTR); `aaaa` — предупреждение `aaaa_present`;
- `DNS_CHECK_RESOLVER=172.19.0.7:0` и `[::1]:0` в Node 22 — `dns_resolver_invalid`, процесс жив.
Лист без промежуточного сертификата за STARTTLS — `cert_chain_incomplete`, полная цепочка с wildcard-именем —
в порядке: автоматический тест с сертификатами, которые выпускает `openssl` во время теста
(`dnsCheck.test.js`); истёкший лист без промежуточного — проверено тестовой цепочкой вручную (`openssl x509
-not_before/-not_after`, OpenSSL 3.5), в автотесте — через `judgeCertificate`.

Не сделано в этом этапе: оповещение Healthchecks по истекающему сертификату (R-18, этап 4); чтение
ожидаемых значений из тенанта (этап 7).

### 5.5. Этап 4: карантин и история rspamd, R-20 (2026-10-02)

Код — клиент API `services/mailNode/mailcow.js` (блок «Quarantine and rspamd history»), разбор письма,
история и настройка видимости — `services/mailNode/quarantine.js`, маршруты — `routes/mailNodeQuarantine.js`
(смонтированы на `/api/mail-node` рядом с `routes/mailNode.js`), экраны — `MailNodeQuarantine`
(«Интеграции» администратора, «Ящики» пользователя) и `SpamVerdict` (в `MessagePane`), демо —
`frontend/src/demo/index.js`. Что видит администратор и что делает каждая кнопка — [runbook, раздел
6б](../../operations/mail-node.md). Миграции не понадобилось: настройка видимости — поле
`quarantineUserView` строки `mail_node` в `integration_config` (слияние, как у остальных настроек узла).

| Что | Сделано | Отличия от R-20 |
|---|---|---|
| Список | `get/quarantine/all` (без писем): время, тема, отправитель, ящик, оценка, действие, признак вируса; главные символы — из истории rspamd, сопоставлены по ящику, оценке и времени (±2 мин), потому что `get/quarantine/all` символов не отдаёт, а у строки истории нет queue id; история не прочиталась — список без символов. До 2000 новых записей с общим числом | символы в списке — только для писем из последних 1000 в истории |
| Запись | `get/quarantine/<id>`: заголовки по порядку (развёрнуты, encoded words раскрыты), From, отправитель конверта, ящик, дата, IP источника, `SFV`/`CAT` EOP, все символы с весами; письмо разбирается на сервере (multipart до 8 уровней и 100 частей, HTML до 1 МБ, текст до 512 КБ, вложения — имя, тип, размер) и показывается только через безопасный вид R-41 (`safeViewMarkup`). mailcow хранит письмо после `mb_convert_encoding(…, 'HTML-ENTITIES', 'UTF-8')` (`meta_exporter/pipe.php`): сущности с кодом от 0x80 обращаются обратно, 8-битная часть не в UTF-8 испорчена ещё в mailcow | вложения не скачиваются вовсе, исходное письмо (`.eml`) панель не отдаёт |
| Выпуск | `edit/qitem {action: "release"}`; успех — `item_released`, ошибка обучения rspamd после выпуска — предупреждение; журнал `mail_node.quarantine_released` | `learnham` в mailcow `2026-09` — тот же код, что `release` (`functions.quarantine.inc.php`, ветка `release || learnham`): одна кнопка «Выпустить», которая и учит. Выпуск `add header` отбрасывается правилом `duplicate`, выпуск письма с `SFV:SPM` возвращается в Junk по R-11 — диалог это говорит |
| Удаление | `delete/qitem [id]`; журнал `mail_node.quarantine_deleted` | — |
| Кто видит | администратор — всё; настройка «пользователи видят» (по умолчанию выключена) — все вошедшие видят записи ящиков узла, которые есть в панели, только просмотр; записи ящиков вне панели — только администратор (пользователю 404) | ящики в панели общие (`services/mailAccess.js`), поэтому «свои ящики» пользователя — все ящики узла панели |
| Настройки карантина | не делаются: панель только объясняет, где они в mailcow | **отличие**: `edit/quarantine` сбрасывает непереданные поля (`retention_size`, `max_size` → 0, `exclude_domains` → `[]`, отправитель, BCC, тема, шаблон → пусто), а чтения этих настроек в API нет (`quarantine('settings')` вызывают только `quarantine.php` и `admin/system.php`), так что «прочитать, изменить, записать» невозможно |
| «Почему в Junk» | `GET /api/mail-node/messages/:id/spam-verdict` для письма ящика узла (любой вошедший): `get/logs/rspamd-history/1000`, кэш 60 с на узел, одновременные запросы делят одно чтение; поиск по `Message-ID` (без `<>`), строки для адресов ящика и его псевдонимов первыми, ближайшая по времени; без `Message-ID` — адрес, тема и ±30 мин от даты письма. Ответ — оценка, пороги `add header`/`reject` (`thresholds` строки), действие, до 15 символов с ненулевым весом, категория EOP из `messages.eop_category`. Кнопка — только у письма в папке «Спам» ящика узла, запрос — по нажатию | вердикт EOP — только сохранённая категория (`CAT`), `SFV` синхронизация не хранит |

Проверено на стенде (2026-10-02, код ветки в одноразовом контейнере образа backend `sha-30e65cf3a2e8` на
сети `stage_mailexpert` с `--env-file` панели стенда; маршруты — настоящий роутер ветки с сессией
администратора стенда, БД и mailcow стенда; тестовый ящик `r20-quarantine@stage.test` заведён и удалён):
- письма из сети mailcow на `postfix-mailcow:25`: `.exe` + ссылка — `add header` 12.1 (Junk и копия в
  карантине), то же с заголовком EOP `SFV:SPM;CAT:SPM` — `reject` 16.1 (только карантин), GTUBE — `554 5.7.1
  Gtube pattern` без записи в карантине ([local-stand.md](../../operations/local-stand.md), «Карантин и
  rspamd на стенде»); карантин стенда для проверки включался на время (`Q_MAX_SIZE`, `Q_RETENTION_SIZE`,
  `Q_EXCLUDE_DOMAINS`) и возвращён как был;
- `GET /quarantine`: обе записи, у каждой главные символы из истории (`MIME_BAD_EXTENSION` 10.1,
  `MICROSOFT_SPAM` 4, `URL_NO_TLD` 2); `GET /quarantine/2`: 8 заголовков, From и тема с кириллицей
  раскрыты, текст 8-битной части с кириллицей прочитан (сущности mailcow обращены), HTML 170 символов,
  вложение `invoice.exe` по имени, `eop {SPM, SPM}`;
- выпуск `reject` — `{ok, learned: true}`, запись ушла из списка, письмо доставлено (`postfix/quarantine`,
  `status=sent`) и правилом R-11 положено в Junk; выпуск `add header` — доставлено и отброшено `duplicate`
  (`discard action` в логе Dovecot); удаление — `{ok}`, повторное удаление и чтение — 404;
- `PUT /quarantine/settings {userView: true}` — поле добавилось к настройкам узла, остальные ключи
  (`apiKey`, `diskPingUrl`, `mailHost`, `quotaMb`) на месте; после проверки убрано;
- «почему в Junk»: письмо `add header` найдено по `Message-ID` (12.1, `add header`, символы), письмо
  `reject` с EOP — по `Message-ID` (16.1, `reject`), без `Message-ID` — по ящику, теме и времени
  (`recipient_time`), чужой `Message-ID` — не найдено; история — 94 строки.
- Не проверено на стенде: экран и маршрут «почему в Junk» через синхронизированное письмо (в панели стенда
  нет ящиков узла; поиск проверен вызовом сервиса, маршрут — тестами), показ пользователю без прав
  администратора (на стенде один пользователь; покрыто тестами). Записи журнала и обучение rspamd двумя
  выпущенными письмами остались бы на стенде: записи журнала удалены, обучение (bayes, fuzzy) не отменить.

## 6. Что требует живого тенанта

Нужен платный или пробный тенант с add-on (в E5 developer Inbound connector не создать) и пробный домен
второго уровня. Каждый ответ `Get-*` сохранять как фикстуру для моков.

| # | Эксперимент | Как проверить |
|---|---|---|
| 1 | Inbound connector по сертификату: набор свойств после мастера EAC | `Get-InboundConnector \| Format-List` → эталон R-25 |
| 2 | Релей обычной почты и пустого отправителя (DSN) через сертификат; домен `<MAIL_HOST>` как accepted domain нужен ли | письмо наружу и отбивка (письмо на несуществующий адрес с внешнего ящика) — `status=sent relay=<EOP_HOST>` в логе, NDR дошёл, нет `5.7.64 ATTR36` |
| 3 | Цепочка сертификата | временно leaf без промежуточного на тестовом узле → ожидаем `5.7.64` |
| 4 | TLS к EOP для обеих форм `<EOP_HOST>`: голое имя без MX; есть ли TLSA и DNSSEC (для `*.mx.microsoft` объявлены — блоги Exchange Team «Modernizing DNS Security for Exchange Online Mail Flow» и о GA входящего SMTP DANE с DNSSEC, см. «Источники»); проходит ли `secure` по имени или хватает штатного `dane` | `dig +dnssec TLSA _25._tcp.<EOP_HOST>`; лог «Verified TLS connection established to <EOP_HOST>» при `dane` без записи TLS Policy Map и при `secure`; по итогу — политика в R-07 |
| 5 | Форма MX нового домена; годится ли MX одного домена как relayhost для всех | `serviceConfigurationRecords`; отправка с второго домена через `<EOP_HOST>` первого |
| 6 | Домен: тип по умолчанию после Graph, задержка до `Get-AcceptedDomain`, формат TXT | R-23 шаг за шагом с отметками времени |
| 7 | Outbound connector: `DomainValidation` против `CertificateValidation`, `Validate-OutboundConnector`, `RecipientDomains` против `AllAcceptedDomains` | валидация, письмо снаружи доходит, `Received` через EOP |
| 8 | DBEB: контакт или mail user; `ExternalEmailAddress` вариант А (тот же адрес) или Б (технический домен); алиасы как proxy-адреса; время репликации; catch-all | несуществующий адрес → `550 5.4.1`, существующий и алиас доходят, нет `5.4.14` |
| 9 | Подписывает ли EOP релейную почту и каким `d=`; время обнаружения CNAME; две подписи | `DKIM-Signature` у внешнего получателя с DKIM EOP выключенным и включённым |
| 10 | Заголовки на письмах, доставленных на узел, при `MoveToJmf`, `AddXHeader`, `Redirect`; `X-MS-Exchange-Organization-SCL`; `CAT` при нескольких категориях | письмо с GTUBE из внешней системы; сохранить заголовки как фикстуры R-11 |
| 11 | Действующая антиспам-политика; допустим ли адрес на узле в `RedirectToRecipients` | `Get-HostedContentFilterPolicy`; тестовая политика с `Redirect` |
| 12 | rspamd на настоящем трафике EOP: SPF по адресу EOP, эффект forwarding hosts | символы `X-Rspamd`/история rspamd на письмах от домена с `-all` до и после R-12 |
| 13 | Лимиты: фактический TERRL, рампа молодого тенанта, лицензии add-on в формуле | отчёт EAC «Tenant Outbound External Recipients», `Get-LimitsEnforcementStatus` |
| 14 | Блокировка коннектора | намеренно не провоцировать; проверить только `Get-BlockedConnector` (пусто), включённый алерт и его появление в `alerts_v2` |
| 15 | Трассировка релейной почты | задержка появления, статусы, `getDetailsByRecipient`; провижининг сервис-принципала |
| 16 | Минимальные роли EXO для кастомной группы ролей | `Get-ManagementRoleAssignment`, прогон операций R-22..R-29 под суженной ролью |
| 17 | Выпуск из карантина на локального получателя (если D-2 — карантин) | `Release-QuarantineMessage`, письмо доходит и не возвращается в карантин |
| 18 | Лицензирование: минимум, считаются ли контакты или mail users получателями, цена | вопрос партнёру (CSP) |

## 7. Решения владельца

Ответы владельца — в разделе 7.1; таблица ниже сохраняет варианты и исходные рекомендации.

Закрыто исследованием: вариант «явный фишинг в MoveToJmf» невозможен (только `Redirect` и `Quarantine`);
вопрос о лимите 10 000 получателей на ящик для релея закрыт (к add-on не применяется); `Get-BlockedConnector`
существует; `add/transport "*"` как замена `extra.cf` отклонён.

| # | Решение | Варианты | Рекомендация |
|---|---|---|---|
| D-1 | Кто подписывает DKIM | mailcow; EOP; оба | mailcow сразу (ключ публикуется при создании домена, проверяемо на стенде); DKIM EOP включать дополнительно после эксперимента 9. Две подписи допустимы |
| D-2 | Явный фишинг | карантин администратора; `Redirect` на отдельный ящик узла, видимый администраторам в панели | начать с карантина (рекомендация Microsoft) и ручной проверки в портале; `Redirect` — если ложных срабатываний станет много и эксперимент 11 пройдёт |
| D-3 | Диапазоны EOP как forwarding hosts (`filter_spam: 1`) | да, с синхронизацией; нет | да, после проверки `rspamc -i` на стенде (R-12) и только вместе с Sieve-правилом R-11: forwarding hosts гасят `MICROSOFT_SPAM` (вердикт EOP в rspamd) и `SPOOFED_UNAUTH` (подделка своего домена в From), раздел 2.5. Отменяет прежнюю рекомендацию находки 13 |
| D-4 | Когда DBEB | сразу; после первого узла | пилотный домен на Internal Relay; R-29 строится и проверяется на моках параллельно; первый рабочий домен — в Authoritative, как только пройдёт эксперимент 8, до масштабирования на сотни ящиков |
| D-5 | Объект зеркала | mail contact; mail user | mail contact (нет пароля и входа); mail user — запасной вариант с `RemotePowerShellEnabled $false` и паролем, который нигде не хранится |
| D-6 | Catch-all на доменах узла | разрешить; запретить | запретить на доменах, идущих в DBEB; панель не создаёт catch-all |
| D-7 | `ExternalEmailAddress` | А — тот же адрес; Б — технический домен | сначала А (проще), Б — если А даёт `5.4.14` |
| D-8 | Кто создаёт и удаляет ящики узла | как сейчас (любой вошедший); лимит на пользователя; одобрение администратора | создание — как сейчас, в пределах лимита домена и с журналом; удаление в доменах `authoritative` — только администратор |
| D-9 | Список доменов Outbound connector | `RecipientDomains` по домену; `AllAcceptedDomains` | `RecipientDomains`: accepted domain сертификата может быть доменом, почта которого живёт не на узле (**Inferred**) |
| D-10 | Лимиты по умолчанию | на ящик в час; на домен; оба | на ящик в час (ловит всплеск), значение от бюджета TERRL, строже первые 60 дней тенанта; домену — только если несколько клиентов делят узел |
| D-11 | `CAT:BULK` в Junk | да; нет | да, как у облачных ящиков |
| D-12 | Relayhost | только `extra.cf`; `extra.cf` и relayhost домена через API | оба, одной строкой `<EOP_HOST>`: `extra.cf` нужен отбивкам, relayhost домена виден и сверяется из панели |
| D-13 | IPv6 узла | `ENABLE_IPV6=false`; привязка портов к IPv4; `ip6tables` | `ENABLE_IPV6=false` явно |
| D-14 | Отключение ящика в панели | пауза только в панели; `active: 2` на узле | пауза в панели, как сейчас, но с явным текстом в интерфейсе |

### 7.1. Принятые решения (2026-10-01)

| # | Решение владельца |
|---|---|
| D-1 | Цель — подпись только EOP. Пока эксперимент 9 не подтвердил, что EOP подписывает релейную почту, подписывает mailcow; после подтверждения ключ mailcow снимается. |
| D-2 | Явный фишинг: карантин EOP с автоматическим выпуском панелью (R-42), письмо попадает в «Спам» и показывается в безопасном режиме (R-41). Безопасный режим — для всех писем в «Спаме». |
| D-3 | Да: антивирус и вердикт о спаме — от EOP (ClamAV на узле выключен, `SKIP_CLAMD=y`), диапазоны EOP — forwarding hosts вместе с правилом R-11. Письма между ящиками узла идут мимо EOP и им не проверяются — для внутренней переписки принято. |
| D-4 | DBEB с самого начала: домен проходит Internal Relay только на время первой синхронизации, панель сама переводит его в Authoritative (R-29). |
| D-5 | Mail contact. |
| D-6 | Catch-all запрещён. |
| D-7 | Решается экспериментом 8; код поддерживает оба варианта, начинаем с А (тот же адрес). |
| D-8 | Создавать ящики узла может любой вошедший пользователь без лимита: панель закрытая, доступ по одобрению в Cloudflare. |
| D-9 | `RecipientDomains`: домены перечисляются явно, панель добавляет каждый новый домен. |
| D-10 | Лимит на ящик: по умолчанию 50 писем в час, администратор меняет для отдельного ящика. Сервис — точечная переписка сотрудников, не рассылки: лимит страхует от взлома ящика. |
| D-11 | `CAT:BULK` — в «Спам». |
| D-12 | И `extra.cf`, и relayhost домена, одной строкой `<EOP_HOST>`. |
| D-13 | `ENABLE_IPV6=false`. |
| D-14 | У ящиков узла нет «Отключить». Удаление (2026-10-01): запросить может любой вошедший — ввод адреса ящика и обязательная причина; ящик продолжает работать N дней (по умолчанию 5, администратор задаёт от 1 до 90), отменить может любой; затем задание удаляет его безвозвратно с узла (`delete/mailbox`) и из панели, журнал хранит причину (R-33). Удаление в тенанте добавится в то же задание вместе с драйвером тенанта (R-29). |

Модули: логика EOP живёт в backend панели (состояние доменов и ящиков, очередь заданий `tenant_jobs`,
повторы, журнал, вызовы Graph); отдельный контейнер `tenant-worker` только выполняет типизированные
операции EXO PowerShell и держит сертификат приложения (R-22, R-35, R-36). Создание, удаление ящика и
псевдонима в панели само ставит задания для mailcow и тенанта — руками в тенанте делается только
первоначальное подключение (приложение, сертификат, коннекторы мастером EAC).

## 8. Поправки к существующим документам

Внесены 2026-09-30 вместе с этим документом:

- [eop-review.md](eop-review.md): находка 1 — `<EOP_HOST>` вместо одного имени тенанта, TLSA есть у хостов
  под `mx.microsoft`, второе звено `postfix-tlspol`, `active: 1`, ENUM `policy`, скобки в `dest`; находка 2 — голое имя вместо
  `[...]:25` (противоречило находке 1), путь пустого отправителя через `<>` и `default_transport`,
  `add/transport "*"` отозван, relayhost = «Sender-dependent
  transports»; находка 3 — ротации нет, формат CNAME EOP; находка 4 — автоопределение `ENABLE_IPV6`,
  привязка портов; находка 5 — три штатных правила `postfilter`, перезапуск Dovecot, свёрнутые заголовки,
  `SKQ`; находка 6 — вариант (b) невозможен; находка 7 — `Get-BlockedConnector`, единицы лимита; находка 9
  — лицензии, контакт вместо mail user, алиасы, catch-all, петля `5.4.14`; находка 10 и 15 — устаревшие
  ссылки на строки; находка 11 — `ClientRequestId`, `*.mx.microsoft`; находка 13 — пересмотрена, «Что сделать» и «Кто делает» зачёркнуты, добавлена цена (`MICROSOFT_SPAM`,
  `SPOOFED_UNAUTH`); находка 14
  — реализуется forwarding hosts; находка 15 — поведение mailcow подтверждено по коду; находка 16 — 48 248 (и в тексте находки),
  рампа молодого тенанта; «Решения владельца» и «Проверить на реальном тенанте» ссылаются сюда.
- [eop-and-hosting.md](eop-and-hosting.md): направления коннекторов в терминах Microsoft (разделы 1.6,
  2.2, 2.3), домены через Graph или центр администрирования (`New-AcceptedDomain` только on-prem), mail
  contact как объект DBEB, лимиты на ящик к add-on не применяются (2.6 и сводка, п. 5), TERRL 48 248 и рампа
  (2.7 и сводка, п. 4), форма MX (4.1), строка таблицы про SMTP relay (2.6), Graph не создаёт получателей
  (3.2), зеркало с контактами и алиасами (сводка, п. 6).
- [platforms.md](platforms.md): relayhost домена рядом с общим (D-12), политика TLS Policy Map по
  эксперименту 4.
- [README.md](README.md): ссылка на этот документ; названия коннекторов, forwarding hosts, TERRL и лимит на
  ящик в разделе 2; открытые решения ссылаются на раздел 7.
- [mail-node.md](../../operations/mail-node.md): плейсхолдер `<EOP_HOST>`; коннекторы в терминах Microsoft;
  MX и smart host — значение из тенанта, не `<tenant>.mail.protection.outlook.com`; relayhost домена =
  «Sender-dependent transports» (`add/relayhost`, не `add/transport`); `ENABLE_IPV6`; перезапуск Dovecot при
  `add/global-filter`; явный фишинг без `MoveToJmf`; домен в тенант через центр администрирования и
  `Set-AcceptedDomain`; бэкскаттер при удалении ящика на Internal Relay; forwarding hosts — по решению D-3;
  порядок блока «Один раз на узел и тенант» (домен сертификата до Inbound connector, relayhost и TLS Policy
  Map после шага 2 первого домена); TLSA для `mx.microsoft`; TXT верификации в шаге DNS.
- [ROADMAP.md](../../../ROADMAP.md): пункты Next про почтовый узел выровнены по этапам раздела 5 (forwarding
  hosts — в этапе 5, псевдонимы — в этапе 6).

## Источники

- Код MailExpert (`main`, `62529906`): `backend/src/services/mailNode/mailcow.js`, `backend/src/routes/mailNode.js`,
  `backend/src/routes/accounts.js`, `backend/src/routes/send.js`, `backend/src/services/ruleForwarder.js`,
  `backend/src/services/imapManager.js`, `backend/src/services/auditLog.js`, `scripts/deploy/test/stage.sh`.
- mailcow-dockerized, коммит `ca07d8d3` (тег `2026-09`): `data/web/json_api.php`,
  `data/web/inc/functions.{mailbox,transports,tls_policy_maps,dkim,fwdhost,fail2ban,ratelimit,mailq,quarantine}.inc.php`,
  `data/web/inc/init_db.inc.php`, `data/web/inc/ajax/dns_diagnostics.php`, `data/Dockerfiles/postfix/postfix.sh`,
  `data/Dockerfiles/postfix/whitelist_forwardinghosts.sh`, `data/conf/postfix/main.cf`,
  `data/conf/dovecot/global_sieve_after`,
  `data/conf/rspamd/local.d/{actions,policies_group,greylist,force_actions,composites,metadata_exporter}.conf`,
  `data/conf/rspamd/dynmaps/forwardinghosts.php`, `data/conf/rspamd/lua/rspamd.local.lua`,
  `_modules/scripts/ipv6_controller.sh`, `generate_config.sh`.
- Postfix: `transport(5)`, `postconf(5)` (`sender_dependent_default_transport_maps`,
  `empty_address_default_transport_maps_lookup_key`), `mysql_table(5)` (запрос с `%d` для ключа без домена
  не выполняется), TLS_README (ключ `smtp_tls_policy_maps`).
- Microsoft Tech Community (блог Exchange Team): DANE и DNSSEC для новых MX —
  https://techcommunity.microsoft.com/blog/exchange/modernizing-dns-security-for-exchange-online-mail-flow/4514248 ;
  https://techcommunity.microsoft.com/blog/exchange/announcing-general-availability-of-inbound-smtp-dane-with-dnssec-for-exchange-on/4281292
- Microsoft Learn (дата обновления страницы):
  - New-InboundConnector (2026-05-16): https://learn.microsoft.com/en-us/powershell/module/exchange/new-inboundconnector
  - New-OutboundConnector (2026-05-19): https://learn.microsoft.com/en-us/powershell/module/exchange/new-outboundconnector
  - Validate-OutboundConnector (2026-05-16): https://learn.microsoft.com/en-us/powershell/module/exchange/validate-outboundconnector
  - Коннекторы (2026-08-03): https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail
  - App-only для EXO PowerShell (2026-08-27): https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2
  - EXO PowerShell V3 (2026-08-01): https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2
  - Exchange Online Admin API: https://learn.microsoft.com/en-us/exchange/reference/admin-api-overview
  - Graph domains: https://learn.microsoft.com/en-us/graph/api/resources/domain
  - New-AcceptedDomain (только on-prem) и Set-AcceptedDomain: https://learn.microsoft.com/en-us/powershell/module/exchange/set-accepteddomain
  - DBEB (2026-08-03): https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-directory-based-edge-blocking
  - Mail users (2026-08-03): https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-mail-users
  - New-MailContact: https://learn.microsoft.com/en-us/powershell/module/exchange/new-mailcontact
  - DKIM (2026-08-24): https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure
  - Заголовки антиспама (2026-08-12): https://learn.microsoft.com/en-us/defender-office-365/message-headers-eop-mdo
  - Set-HostedContentFilterPolicy (2026-08-12): https://learn.microsoft.com/en-us/powershell/module/exchange/set-hostedcontentfilterpolicy
  - Спам в Junk для локальных ящиков: https://learn.microsoft.com/en-us/exchange/standalone-eop/configure-eop-spam-protection-hybrid
  - Блокировки коннектора (2026-07-17): https://learn.microsoft.com/en-us/defender-office-365/connectors-remove-blocked
  - Get-MessageTraceV2: https://learn.microsoft.com/en-us/powershell/module/exchange/get-messagetracev2 ;
    Graph messageTraces: https://learn.microsoft.com/en-us/graph/api/messagetracingroot-list-messagetraces
  - Лимиты EOP (2026-02-10): https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-protection-service-description/exchange-online-protection-limits
  - Лимиты исходящей почты (2026-08-25): https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot
  - Веб-сервис IP-адресов (2026-08-20): https://learn.microsoft.com/en-us/microsoft-365/enterprise/microsoft-365-ip-web-service
  - Внешние DNS-записи Microsoft 365 (2026-08-20): https://learn.microsoft.com/en-us/microsoft-365/enterprise/external-domain-name-system-records
  - NDR 5.4.14 и TenantAttribution (2026-08-11): https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/tenantattribution-ndr
- V-2: MC1048624 (MX под `mx.microsoft`), зеркало Message Center: https://mc.merill.net/message/MC1048624 ;
  ограничения молодых и пробных тенантов: https://lazyadmin.nl/office-365/exchange-online-tightens-outbound-limits-for-new-trial-and-edu-tenants/
