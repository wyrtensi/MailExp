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
  (решения D-2 и D-11, R-42 и решения владельца после этапа 7, раздел 5.14): все категории
  нежелательного (`CAT` из `PHSH|HPHSH|HPHISH|MALW|SPM|HSPM|SPOOF|BULK`) — в Junk всегда, в том числе после
  выпуска из карантина (`SFV:SKQ`): спам, фишинг и массовую рассылку из карантина панель выпускает сама и
  показывает в «Спаме» в безопасном режиме; вердикт спама (`SFV` из `SPM|SKS|SKB`) — в Junk, кроме
  `SFV:SKQ`. Пока на узле прежняя версия правила, панель не выпускает ничего, кроме явного фишинга
  (раздел 5.14). Что выпущенное письмо сохраняет `CAT`, проверяет
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
- Сделано (2026-10-02): раздел 5.7; исходное письмо отбивки находится по конверту возвращённого письма в
  BODYSTRUCTURE, `In-Reply-To`/`References` или `text/rfc822-headers` (`Original-Message-ID` в DSN нет),
  строка TLS сопоставляется по серверу и времени (в логе mailcow нет номера процесса).

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
  домена). Postfix пишет `relay=` как разрешённое имя и адрес (`relay=<имя>[<IP>]:25`). «Через EOP» —
  только если имя совпало с `<EOP_HOST>` (без регистра и точки в конце). Адрес из диапазонов EOP (раздел
  2.10) **не** считается: в них же MX любого другого тенанта Microsoft 365, и письмо получателю на
  Microsoft 365 напрямую с узла — это обход, хотя адрес «EOP» (решение владельца 2026-10-02, поправка к
  прежней формулировке «имя **или** IP»). Диапазоны остаются для R-12 и R-40. Пока `<EOP_HOST>` не задан,
  проверки обхода нет: панель показывает пометку «хост EOP не задан» (информация, не тревога).
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
- Сделано (2026-10-02): раздел 5.6; настройки `edit/quarantine` — только разовой записью всех полей по решению владельца (там же).

**R-21. Бюджет TERRL.** S.
- Что: уникальные внешние получатели за скользящие 24 часа (журнал `message.sent` панели и/или
  `get/logs/postfix`), порог 80% (совет Microsoft), фактический лимит из R-06, рампа молодого тенанта.
  Получатели на accepted domains не считаются.
- Зачем: превышение TERRL останавливает внешнюю почту всего тенанта (`550 5.7.233`), а лимиты mailcow
  считают сообщения, не получателей (раздел 2.9).
- Без EOP: да — чистая функция, таблица значений: 100 лицензий → 22 059, 500 → 48 248; 10% и 25%.

**R-43. Письма, задержанные или потерянные во время простоя узла.** M.
- Зачем: пока узел не принимает почту (не работает Postfix, сервер недоступен), EOP держит
  входящие письма в своей очереди не больше 24 часов и повторяет попытку каждые 15 минут; с ошибками
  `450 4.4.312` (DNS), `4.4.315` (таймаут), `4.4.316` (соединение отклонено), `4.4.317`, `4.4.318`,
  `4.7.320` (сертификат). По истечении внешний отправитель получает `550 4.4.7 QUEUE.Expired; message
  expired`, а сотрудники — ничего. `Set-TransportConfig -MessageExpiration` принимает только 12-24 часа,
  то есть срок можно лишь сократить. Повторить, вытолкнуть или переслать такие письма клиент EOP не
  может: `Get-QueueDigest` и `Retry-Queue` есть только в on-prem Exchange. «Fix now» в оповещении EAC о
  `4.4.316` отключает коннектор или релей домена и превращает 24 часа ожидания в немедленные отбивки.
  Что письмо было и что с ним стало, видно только в трассировке тенанта.
- Как: окна простоя — по проверке задания оповещений (R-18) раз в пять минут: API mailcow не отвечает
  вовсе две проверки подряд или `postfix-mailcow` не `running` (`get/status/containers`); порт 25 панель
  проверить не может (он открыт только диапазонам EOP). Остановленный Dovecot — не простой этого рода:
  Postfix принимает письма и держит их в очереди узла (оповещения очереди и контейнеров, R-16, R-18),
  EOP ничего не ждёт. Начало — последняя успешная проверка перед
  первой неудачной (с запасом), конец — первая успешная. Лог Postfix — свидетельство вокруг окна, но не
  повод открыть его: тихий узел молчит часами. Администратор отмечает окно вручную (плановое
  обслуживание, простой самой панели) с причиной, изменения — в журнал. Трассировка (Graph
  `GET /admin/exchange/tracing/messageTraces` и `getDetailsByRecipient`, как в R-30) по окну ±1 час,
  получатели на доменах узла: `pending` — ждёт в очереди EOP (сколько осталось до 24 часов), `failed` —
  потеряно, отправитель получил NDR (`4.4.7`/`QUEUE.Expired` — истёк срок), `delivered` — пришло с
  опозданием (сверка с `cleanup ... message-id=` лога узла), `quarantined`/`filteredAsSpam` — не из-за
  простоя. Сотрудникам — список писем их ящиков с отправителем и темой, администратору — окна, все
  письма и баннер, пока письма ждут; оповещение R-18 и пометка в пинге Healthchecks. Лимиты Graph: 100
  запросов за 5 минут отдельно на список и на подробности, окно запроса до 10 суток, история 90 суток,
  данные запаздывают на 5-30 минут.
- Решение владельца D-15 (раздел 7.1): только наблюдение и сообщение (вариант A), без промежуточного
  релея.
- Источники: [лимиты EOP](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-protection-service-description/exchange-online-protection-limits)
  («Message deferral limit: 1 day, retried every 15 minutes»);
  [Mail flow intelligence](https://learn.microsoft.com/en-us/defender-office-365/connectors-mail-flow-intelligence)
  (коды `4.4.312`-`4.4.318`, `4.7.320`, «Fix now»);
  [отчёт об очереди](https://learn.microsoft.com/en-us/exchange/monitoring/mail-flow-reports/mfr-queued-messages-report);
  [NDR 4.4.7](https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/fix-error-code-550-4-4-7-in-exchange-online);
  [Set-TransportConfig](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-transportconfig)
  (`-MessageExpiration`, 12-24 часа);
  [Graph messageTraces](https://learn.microsoft.com/en-us/graph/api/messagetracingroot-list-messagetraces) и
  [getDetailsByRecipient](https://learn.microsoft.com/en-us/graph/api/exchangemessagetrace-getdetailsbyrecipient);
  [задержка трассировки](https://learn.microsoft.com/en-us/exchange/monitoring/monitoring);
  [оповещения Defender](https://learn.microsoft.com/en-us/defender-xdr/alert-policies) («Messages have
  been delayed» — от 2000 писем старше часа, для малого тенанта практически не срабатывает).
- Без EOP: да — fake-EOP в режиме очереди и его трассировка в форме Graph на стенде; на тенанте —
  трассировка в add-on, точные строки статусов и событий, `MessageExpiration` (раздел 6, эксперименты
  19-21).
- Сделано (2026-10-02): раздел 5.9. Трассировка через драйвер тенанта (токен Graph по сертификату
  приложения) — этап 7c, раздел 5.13.

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
- Сделано (2026-10-03, этап 7a): раздел 5.11. Отличие: задания тенанта идут в общей очереди `jobs`
  (`services/jobQueue.js`), а не в отдельной `tenant_jobs`; ассерцию для Graph подписывает исполнитель,
  ключ сертификата панели не передаётся. Модуль 3.9.2 на pwsh 7.5: образа 7.6 на MCR нет.

**R-23. Домен в тенанте через Graph.** M.
- Зачем: без домена в тенанте нет ни релея, ни MX; MX нового домена можно узнать только из Graph (раздел
  2.3), а TXT верификации — показать владельцу домена.
- Как: `POST /domains {"id":"<DOMAIN>"}` → `GET /domains/<DOMAIN>/verificationDnsRecords` (показать
  `label`, `recordType`, `text`, `ttl`) → проверка DNS (R-14) → `POST /domains/<DOMAIN>/verify` →
  `PATCH /domains/<DOMAIN> {supportedServices:["Email"]}` → `GET /domains/<DOMAIN>/serviceConfigurationRecords`
  → ожидаемый MX в `mail_node_domains`. Затем опрос `Get-AcceptedDomain` с повторами: задержка не
  документирована.
- Без EOP: да — мок, обе формы MX. Реальные задержки и формат TXT — тенант.
- Сделано (2026-10-03, этап 7b): задание домена `tenant_domain_sync` (раздел 5.12). Отличие: домен
  добавляется в тенант сразу (TXT нужен владельцу до шага «DNS опубликованы»), `verify` — только после этого
  шага, который по-прежнему подтверждает человек.

**R-24. Тип accepted domain.** S.
- Зачем: новый домен, вероятно, Authoritative по умолчанию (раздел 2.8): до зеркала получателей EOP
  отклонял бы почту на все адреса узла.
- Как: как только домен виден в `Get-AcceptedDomain`, до смены MX — `Set-AcceptedDomain -Identity <DOMAIN>
  -DomainType InternalRelay`. `Authoritative` — только из R-29, после полного зеркала.
- Без EOP: логика — да; поведение — тенант.
- Сделано (2026-10-03, этап 7b): раздел 5.12; Internal Relay восстанавливается на каждом прогоне, пока
  домен не `authoritative`.

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
- Сделано (2026-10-03, этап 7b): добавление домена, эталон (первое чтение или кнопка), сверка и
  оповещение `tenant_connector_drift` (раздел 5.12). Отличие: `Validate-OutboundConnector` и
  `-IsValidated` не сделаны — оставлены эксперименту 7.

**R-26. DKIM в EOP.** S-M. Если по решению D-1 подписывает EOP.
- Зачем: значения CNAME нельзя вычислить (формат сменился в мае 2025), их надо прочитать и показать
  владельцу домена, а включение возможно только после публикации.
- Как: `New-DkimSigningConfig -DomainName <DOMAIN> -Enabled $false -KeySize 2048` →
  `Get-DkimSigningConfig -Identity <DOMAIN>` (`Status`, `Selector1CNAME`, `Selector2CNAME`) → показать
  CNAME `selector1._domainkey` и `selector2._domainkey` → опрос `Set-DkimSigningConfig -Identity <DOMAIN>
  -Enabled $true` до успеха (пока CNAME не видны, команда падает с ошибкой). Ротация —
  `Rotate-DkimSigningConfig`, вступает через 96 часов.
- Без EOP: мок; подпись релейной почты — тенант.
- Сделано (2026-10-03, этап 7b): раздел 5.12, только в режиме DKIM `eop`. Ротации нет.

**R-27. Блокировка коннектора.** S.
- Зачем: блокировка Inbound connector останавливает исходящую почту всех ящиков узла
  ([eop-review](eop-review.md), находка 7); алерт Microsoft уходит администраторам тенанта, а не в панель.
- Как: опрос `Get-BlockedConnector` раз в 5-10 минут (пусто — норма); `Remove-BlockedConnector
  -ConnectorId <GUID>` только по кнопке администратора с подтверждением и ссылкой на процедуру Microsoft
  «Respond to a compromised connector»; снятие действует до часа. Роли: снятие — Organization Management
  или Security Administrator, чтение — Global Reader, Security Reader. Попадает ли встроенный алерт
  «Suspicious connector activity» в Graph `security/alerts_v2` — **Inferred**.
- Без EOP: мок; быстрый сигнал по логам (R-18) работает без тенанта.
- Сделано (2026-10-03, этап 7a): опрос раз в 10 минут через очередь и оповещение
  `connector_blocked_tenant` (раздел 5.11). Кнопки снятия нет: блокировку снимает администратор тенанта в
  портале или `Remove-BlockedConnector`, панель показывает процедуру. Форма ответа `Get-BlockedConnector` в
  фикстуре — **Inferred** до тенанта.

**R-28. Антиспам-политика.** S. До раздела 5.14 — только чтение.
- Зачем: раскладка R-11 работает, только если EOP доставляет спам на узел с заголовками; действие
  `Quarantine` в политике молча уводит письма туда, где сотрудники их не видят (находка 6).
- Как: `Get-HostedContentFilterPolicy -Identity Default` → показать `SpamAction`, `HighConfidenceSpamAction`,
  `PhishSpamAction`, `HighConfidencePhishAction`; предупреждать, если действие расходится с раскладкой
  R-11 (например `Quarantine` для обычного спама — сотрудники его не увидят). `Set-HostedContentFilterPolicy`
  — только по решению владельца (D-2), не кнопкой по умолчанию.
- Без EOP: мок.
- Сделано (2026-10-03, этап 7a): просмотр в разделе «EOP» с предупреждениями, кроме четырёх полей ещё
  `BulkSpamAction` (D-11); `Set-` нет (раздел 5.11).
- После этапа 7 (2026-10-04, раздел 5.14): по решению владельца панель сама ставит `SpamAction`,
  `HighConfidenceSpamAction`, `PhishSpamAction` и (D-11) `BulkSpamAction` политики Default в `MoveToJmf`
  (чтение, запись только отличий, чтение снова, журнал, оповещение при отказе, раз в 6 часов поверх правок
  руками); `HighConfidencePhishAction` (`MoveToJmf` ему недоступен) — по-прежнему только проверка. Свои
  политики и Standard/Strict не трогаются.

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
- Сделано (2026-10-03, этап 7b): раздел 5.12. Отличия: желаемое множество берётся с узла (ящики, которые
  принимают почту, и псевдонимы mailcow), а не только из панели — после Authoritative EOP отклоняет всё
  без получателя; псевдонимы — отдельные контакты, не proxy-адреса (D-16); catch-all на узле не даёт
  перейти в Authoritative (D-6); пробное письмо `550 5.4.1` не автоматизировано (эксперимент 8).
- После этапа 7 (2026-10-04, раздел 5.14): псевдонимы mailcow, заведённые руками, не отражаются (ящики
  mailcow, заведённые руками, отражаются и показываются как «созданы вне панели»); панель показывает такие
  псевдонимы с предупреждением. Контакты, заведённые для них этапом 7b, на Internal Relay удаляются как
  лишние, на Authoritative-домене — только после разрешения администратора (журнал).

**R-30. Трассировка по запросу.** M.
- Зачем: логи узла (R-17) заканчиваются на передаче в EOP; что EOP сделал с письмом дальше (доставил,
  отфильтровал, задержал), видно только в трассировке тенанта.
- Как: кнопка «статус доставки» у письма: Graph `GET /admin/exchange/tracing/messageTraces` с `$filter` по
  `messageId` (v1.0; нужен сервис-принципал `8bd644d1-64a1-4d4b-ae52-2e0cbf64e373` в тенанте, провижининг
  до нескольких часов) или `Get-MessageTraceV2 -MessageId` (для add-on подтверждён, Graph для add-on —
  **Inferred**). Окно запроса до 10 суток, история 90; 100 запросов за 5 минут на тенант — кэш и очередь,
  не непрерывный опрос.
- Без EOP: мок.
- Сделано (2026-10-04, этап 7c): раздел 5.13. Отличие: `$filter` по `messageId` в Learn не описан
  (описаны `receivedDateTime`, `recipientAddress`, `id`, `contains(subject)`), поэтому список берётся по
  времени вокруг отправки, а Message-ID сверяется в панели; только Graph, `Get-MessageTraceV2` — запасной
  путь, если эксперимент 19 покажет, что Graph в add-on не работает.

**R-31. Карантин EOP и Tenant Allow/Block List.** L. Только если по D-2 явный фишинг остаётся в карантине.
- Зачем: у сотрудников панели нет учётных записей Microsoft, самообслуживание карантина им недоступно, и
  ложное срабатывание «high confidence phish» иначе выпускается только из портала Defender.
- Как: `Get-QuarantineMessage`, `Release-QuarantineMessage -Identity <id> (-ReleaseToAll | -User <адрес>)
  [-AllowSender] [-ReportFalsePositive]`; TABL — `New/Get/Remove-TenantAllowBlockListItems` (без Defender
  500 allow + 500 block на подтип, без срока — 30 дней). Graph-эквивалента нет. Риск: выпущенное письмо на
  локального получателя может снова попасть в карантин.
- Без EOP: только интерфейс против мока.
- Не делается (этап 7c, 2026-10-04): по D-2 явный фишинг не остаётся в карантине — его выпускает панель
  (R-42). Ручного выпуска, `-AllowSender`, `-ReportFalsePositive` и TABL нет; исполнитель не умеет других
  типов карантина. Письма, которые R-42 оставил в карантине (получатель вне узла, исходящее, выпуск
  отклонён), панель показывает с причиной, выпускает их администратор тенанта в портале Defender (раздел 5.13).
  После этапа 7 (раздел 5.14) тем же заданием выпускаются обычный фишинг, спам, явный спам и массовая
  рассылка; вредоносное и прочие типы остаются за администратором тенанта.

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

**R-34. Имена отправителя ящика узла.** S. Сделано на этапе 6 (раздел 5.10).
- Зачем: псевдоним панели (`account_aliases`) принимал любой адрес, а отправка ставит адрес псевдонима в
  From и, по умолчанию nodemailer, в envelope (**Inferred**). mailcow проверяет **envelope** отправителя:
  `reject_authenticated_sender_login_mismatch` по `smtpd_sender_login_maps` (`main.cf:102-107`,
  `postfix.sh:318-373`), заголовок From не проверяет. Псевдоним с другим адресом без записи на узле
  получает отказ на SMTP — уже после окна отмены отправки.
- Как (решение владельца D-16, раздел 7.1): у ящика узла псевдоним — это ещё одно имя отправителя с тем же
  адресом (например, на русском и на английском), как второе имя при создании ящика. Другой адрес — всегда
  отдельный ящик (отдельно оплачивается), а не псевдоним: `example@домен` и `example1@домен` — два ящика.
  Поэтому панель не создаёт `add/alias` с `sender_allowed`, не меняет `sender_acl` и не заводит
  proxy-адреса в тенанте; прежний план (`add/alias {address, goto, sender_allowed:1}` или `edit/mailbox
  {attr:{sender_acl}}`, `delete/alias`, proxy-адрес через R-29) отменён. Сделано: `POST`/`PUT
  /api/accounts/:id/aliases` для ящика узла (`mail_node`) отклоняют адрес, отличный от адреса ящика
  (без регистра и пробелов по краям), — 400 `node_alias_address_mismatch`; имя, Reply-To и подпись
  меняются как раньше; у Gmail и IMAP-ящиков псевдонимы с любым адресом остаются. Отправка с
  псевдонима другого адреса, оставшегося у ящика узла с прежних версий, отклоняется до сборки письма и
  постановки в очередь — 400 `node_alias_stale`, а письмо, уже стоящее в очереди с таким From, задание
  отклоняет тем же кодом до SMTP. Такие псевдонимы администратор видит списком и для каждого выбирает
  «Создать отдельный ящик» или «Удалить»; само ничего не меняется. Псевдоним mailcow с тем же адресом,
  заведённый руками, сначала удаляют в mailcow (`address_is_node_alias`).
- Без EOP: да — route-тесты; на стенде не проверялось (отправки с чужого адреса больше нет).

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
- Сделано (2026-10-04, этап 7c): раздел 5.13. Задание — в общей очереди `jobs` (как все задания тенанта),
  идемпотентность — строка `tenant_quarantine_releases` на `Identity`; выпуск только входящих писем, все
  получатели которых на доменах узла, почта которых идёт через EOP; исполнитель сам отказывает в выпуске
  другого типа. По умолчанию выпуск выключен до эксперимента 17, включает его администратор (журнал).
- После этапа 7 (2026-10-04, раздел 5.14): выпуск включён по умолчанию (выключает администратор, журнал);
  тем же заданием и с теми же проверками выпускаются обычный фишинг, спам, явный спам и массовая рассылка
  — только пока на узле правило «Спама» этой версии; вредоносное и прочие типы — никогда.

### Безопасность и аудит

**R-35. Секреты.** S.
- Ключ mailcow уже хранится зашифрованным. Сертификат приложения Entra — PFX только в read-only томе
  `tenant-worker`, пароль — секрет контейнера (Microsoft: для локального сертификата «no automated and secure
  way»); в БД панели — только id тенанта, id приложения, отпечаток. Не логировать ответы `get/relayhost/all`.
  mailcow сам пишет тела API-запросов в `API_LOG`, маскируя только поля с `pass` в имени (`json_api.php:11-35`).
- Без EOP: да — тест, что логи панели и ответы API не содержат пароля relayhost и пароля PFX; на стенде
  `tenant-worker` стартует с PFX из тома и отказывается стартовать без него.
- Сделано для тенанта (2026-10-03, этап 7a): PFX — в томе только для чтения, пароль — секрет compose;
  исполнитель не стартует без них и не пишет пароль в лог (тесты образа); в БД — id тенанта, его домен,
  id приложения и отпечаток; токены и ассерции не попадают ни в состояние, ни в задания (раздел 5.11).

**R-36. Никакого произвольного PowerShell.** S.
- `tenant-worker` исполняет только операции из белого списка; параметры — провалидированные домены и
  адреса (`parseHostName`, `parseLocalPart`), передаются как аргументы, не склейкой строк; `-CommandName`
  ограничивает загружаемые командлеты.
- Без EOP: да — тесты воркера в режиме печати команд: неизвестная операция и адрес с `;`, `$(...)`,
  кавычками отклоняются до запуска pwsh.
- Сделано (2026-10-03, этап 7a): белый список проверяется трижды — в панели (`ExoRunner`), в Node-части
  исполнителя до pwsh и ещё раз в `runner.ps1`; значения передаются сплаттингом (раздел 5.11).

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
| 6. Жизненный цикл | R-04, R-32, R-33, R-34 (без тенанта) | route-тесты (раздел 5.10) |
| 7. Тенант на моках | R-22 … R-31, R-42 | фейковые `ExoRunner`/Graph: порядок операций, повторы, идемпотентность, формы ответов. Части: 7a — драйвер, R-27, R-28, R-35, R-36 (раздел 5.11); 7b — R-23 … R-26, R-29; 7c — R-30, R-42 и трассировка R-43 через драйвер (раздел 5.13; R-31 не делается по D-2); решения владельца после этапа 7 — раздел 5.14 |
| 8. Живой тенант | раздел 6 | ручные эксперименты; ответы `Get-*` сохраняются как фикстуры этапа 7 |

Этапы 1-7 не требуют тенанта. Этапы 2-5 можно вести параллельно после 1 (R-01 и R-02 нужны всем).

Этап 6: части R-04, R-32 и R-33 без тенанта сделаны раньше, вместе с доменами и отложенным удалением
(#127, #128, #129); на этапе 6 осталось R-34, и оно сделано по решению D-16 (раздел 5.10). Части этих
требований для тенанта (получатель DBEB при создании и удалении ящика, R-29) относятся к этапу 7.

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

### 5.5. Этап 4a: что сделано (2026-10-02)

Эксплуатация узла: очередь, оповещения, контроль обхода EOP, бюджет TERRL. Код —
`backend/src/services/mailNode/postfixLog.js` (чтение лога Postfix), `mailQueue.js` (очередь и `postcat`),
`nodeAlerts.js` (оповещения и задание), `terrl.js` (бюджет), `eopRanges.js` (диапазоны EOP) и
`scripts/update-eop-ranges.mjs`; вызовы mailcow — отдельный блок в конце `mailcow.js`; маршруты —
`routes/mailNode.js`; экраны — `MailNodeOpsSection` («Эксплуатация узла»), `MailNodeTerrlBudget` в
`EopSection`; демо — `frontend/src/demo/index.js`. Порядок для администратора — [runbook, раздел
6б](../../operations/mail-node.md). Миграций нет: настройки оповещений — `integration_config`
(`mail_node_alerts`), последняя проверка — `mail_node_alert_state`, лицензии и дата создания тенанта — в
настройках EOP (`licenses`, `tenantCreatedOn`). Новые записи журнала: `mail_node.queue_action`,
`mail_node.alert_raised`, `mail_node.alert_cleared`.

| Требование | Сделано | Отличия от раздела 4 |
|---|---|---|
| R-16 | список (`get/mailq/all`: очередь, id, время прихода, размер, отправитель, получатели с причиной), подробности (`get/postcat/<id>`: конверт и заголовки, текст — только по запросу, до 64 КБ), задержать/отпустить/отправить сейчас по одному письму (`edit/mailq`), «Повторить все» (`edit/mailq {action: "flush"}`), удаление одного письма с подтверждением (`delete/mailq`, сервер требует `confirm: true`); перед действием письмо ищется в очереди (нет — 404); только администратор; каждое действие в журнал с конвертом письма, чтение текста письма — тоже (`view_body`: id и конверт, без текста) | `super_delete` нет; «Отправить сейчас» для задержанного письма сервер отклоняет (`queue_item_held`, 409): `postqueue -i` его не отпускает. Вывод `postcat` читается потоком не больше 2 МБ; 404 — только для «No such file» (письма в очереди нет), прочие ответы без дампа — 502. Получатели — из конверта и из `HEADER EXTRACTED` (`sendmail -t`), уже доставленные (`done_recipient`) — отдельно. Экран показывает первые 200 писем и общие счётчики. Поля `postqueue -j` проверены на стенде: mailcow переписывает получателей в строки `адрес (причина)`, панель разбирает их обратно; `get/postcat` отвечает текстом при заголовке JSON |
| R-18 | задание раз в пять минут (первый прогон через 90 с, таймер `unref`, запуск панели не ждёт, одновременно один прогон) и «Проверить сейчас»; сигналы: `5.7.711`/`AS(2204)`, `5.7.64`, `5.7.233`/`5.7.232` в строках доставки лога за последний час; отложенных больше N или самое старое старше T (настройки, 20 и 60 минут); `cert_expiry` последней проверки узла этапа 3 (меньше 14 дней или истёк); контейнеры не `running` или с health `unhealthy`, если ответ его несёт (`get/status/containers` mailcow 2026-09 health не отдаёт); обход EOP (R-19); бюджет TERRL от 80% (R-21). Список в панели, отдельная ссылка Healthchecks: на каждом прогоне, прочитавшем все источники, `/fail` только при оповещении severity `error`, иначе успех, предупреждения и пометки — в теле пинга; в журнал — только появление и снятие оповещения | коды отказов — точное поле `dsn=` или код в тексте ответа, стоящий отдельно (не часть адреса вроде `[5.7.64.12]`). Сигнал по логу живёт час после последней строки: оповещение снимается само, когда отказов нет час. Источник, который не прочитался, оставляет свои оповещения как были и отменяет пинг (Healthchecks замечает тишину, как у диска); пустой ответ лога (`{}`, `[]`, не список) — тоже сбой источника, а не «тихий узел»; при сбое лога бюджет TERRL не пересчитывается по одному журналу, его оповещение остаётся прежним. Лог читается один раз на всех (single flight, кэш 60 с): задание и бюджет экрана EOP делят одно чтение. `Get-BlockedConnector` (R-27) — с драйвером тенанта |
| R-19 | строка `status=sent` из лога, у которой `relay=` не имя `<EOP_HOST>` (без регистра и точки), а служба не LMTP/local/virtual/pipe/discard — оповещение «почта ушла мимо EOP» с relay и примерами; без `<EOP_HOST>` проверки нет, вместо неё пометка `eop_host_missing` (severity `info`, на `/fail` Healthchecks не влияет) | только имя, без адресов из диапазонов EOP (решение владельца 2026-10-02, см. R-19 выше): письмо на MX получателя в Microsoft 365 (`relay=<домен>.mail.protection.outlook.com[52.101.x.x]:25`) — обход. Диапазоны (`eopRanges.js`: Microsoft 365 endpoints, `serviceArea` Exchange с TCP 25, версия `2026081400`, сверено с веб-сервисом 2026-10-01: 4 диапазона IPv4, 2 IPv6) и скрипт обновления с постоянным `ClientRequestId` установки (`EOP_CLIENT_REQUEST_ID`) остаются для R-12 и R-40 |
| R-21 | `500 × лицензии^0.7 + 9500` с округлением (100 → 22 059, 500 → 48 248), рампа по дате создания тенанта (до 30 дней 10%, 31-60 — 25%), лимит — TERRL настроек, иначе по лицензиям; уникальные внешние получатели за скользящие 24 часа (свои — домены узла в панели и alias-домены mailcow, `get/alias-domain/all`; не прочитались — считаются внешними, бюджет ошибается в большую сторону); блок в разделе EOP (читается при открытии и после сохранения, менявшего лимит), оповещение от 80% | считается объединение двух источников: журнал `message.sent` ящиков узла (полные 24 часа, точное время, индекс по времени) и строки лога `status=sent` с `relay=` по имени `<EOP_HOST>` (пересылки правилами панели, отбивки и Sieve, которых в журнале нет; без `<EOP_HOST>` лог ничего не добавляет) — лог хранит `LOG_LINES` строк и на занятом узле не покрывает сутки, поэтому один лог не годится, а один журнал недосчитывает; блок пишет, с какого времени покрыт лог. Рампа применяется к TERRL из настроек: если отчёт EAC уже показывает уменьшенный лимит, дату создания не вводить (открытый вопрос, эксперимент 13) |

**Чтение лога Postfix (для R-17, этап 4c).** `readPostfixLog(cfg, { lines, since })` из
`services/mailNode/postfixLog.js` читает `get/logs/postfix/<lines>` (всегда с явным числом: без него
mailcow отдаёт `$LOG_LINES` веб-настроек, 1000; по умолчанию и не больше — 10000, столько держит Redis при
`LOG_LINES=9999`) и возвращает `{ lines, fetched, malformed, oldestAt, newestAt, covered }`: `lines` —
разобранные строки от старых к новым (в пределах секунды — в порядке Postfix), `covered` — дошёл ли лог до
`since`. Чтение общее: одновременные вызовы ждут одного запроса, результат служит всем 60 с
(`LOG_CACHE_MS`; `maxAgeMs: 0` — прочитать заново, `clearPostfixLogCache()` — забыть); неудачное чтение не
кэшируется; пустой ответ mailcow (`{}`, `[]`) — ошибка `mail_node_failed`. Чистые функции:
`parsePostfixEntry(entry)` → `{ at, epoch, program, service, queueId, event, to,
origTo, from, relay, relayHost, relayIp, relayPort, dsn, status, statusText, reply, delay, messageId, size,
nrcpt, notificationQueueId, message }` или `null` для записи, которая не строка лога; `statusText` —
блок после `status=` до конца строки (скобки внутри ответа, парные или нет, не обрывают его), `reply` —
слова удалённого сервера (после `said: `, без `(in reply to ... command)`); `event` — `sent`,
`deferred`, `bounced`, `expired`, `undeliverable`, `deliverable`, `received`, `message_id`, `queued`,
`notification` (отбивка с новым queue id в `notificationQueueId`), `removed`, `held`, `released`, `deleted`,
`rejected`, `other`; запись
строкой JSON разбирается, многострочное сообщение складывается в одну строку. `parsePostfixLog(entries)`
→ `{ lines, malformed }`; `correlateByQueueId(lines)` → `Map` queue id → `{ messageId, from, size, nrcpt,
firstAt, lastAt, deliveries, notifications, removed, lines }`; `relayKind(line, { eopHost })` → `eop`,
`local` или `other` (только по имени `<EOP_HOST>`, без диапазонов; без `eopHost` — никогда `eop`). Фикстуры со стенда — `postfixLog.fixtures.js` (отложено 451, отбито 5.7.711 и 5.7.233
с отбивками, задержано-отпущено-доставлено). Связь письма панели с queue id — по `messageId` (строка
`cleanup ... message-id=`), отбивки — по `notificationQueueId`.

Проверено на стенде (2026-10-01 по UTC, код ветки в одноразовом контейнере на сети `stage_mailexpert` с
окружением `stage-backend`, сервисы вызывались напрямую: маршруты и экраны на опубликованных образах стенда
не проверялись — их покрывают тесты). Хост EOP на время проверки — `eop.test.local`, потом настройки EOP
стенда возвращены как были (записи не было):
- `eop mode tempfail`, `eop send`: очередь — `deferred`, причина `host eop.test.local[172.22.1.13] said:
  451 4.7.500 Server busy...`; подробности — конверт и 11 заголовков, текст скрыт; «Задержать» — очередь
  `hold` (в логе `placed on hold`), «Отпустить» — снова `deferred`; `eop mode accept`, «Отправить
  сейчас» — `relay=eop.test.local[172.22.1.13]:25, dsn=2.6.0, status=sent`, очередь пуста; читатель лога
  отнёс эту строку к `eop`.
- «Повторить все»: отложенное письмо повторено (вторая строка `status=deferred` через 7 с); удаление —
  очередь пуста, `postcat` отвечает `fatal: open queue file ... No such file`, экран отвечает 404.
- `eop mode blocked-connector`, `eop send`: проверка оповещений подняла `connector_blocked` (две строки
  `dsn=5.7.711` за час) и `terrl_exceeded` (`5.7.233` из прогона `tenant-limit`); повторная проверка
  сохранила время подъёма, в журнал за две проверки — три записи `mail_node.alert_raised`, повторов нет.
- Обход EOP вживую: временный транспорт mailcow `bypass-test.example → [172.22.1.13]:25` (тот же fake-EOP,
  но по адресу, а не по имени), письмо ушло `relay=172.22.1.13[172.22.1.13]:25, status=sent`, проверка
  подняла `eop_bypass` с relay `172.22.1.13`; транспорт удалён сразу после отправки, таблица транспортов
  снова пуста. Фикстурная строка `relay=mx.example.org[198.51.100.25]:25, status=sent`, добавленная к
  живому логу, — тоже `eop_bypass`. Прогон `eop down`/`eop up` без общего relayhost не делался: он удаляет
  контейнер fake-EOP, а без relayhost письмо на `example.com` осталось бы в очереди, а не ушло бы мимо EOP.
- `get/status/containers`: 18 контейнеров, все `running`; лог стенда — 971 строка с 2026-09-28, сутки
  покрыты; бюджет без лимита (TERRL и лицензии на стенде не заданы) — 1 внешний получатель за 24 часа.

Ревизия PR (2026-10-02): обход и счёт TERRL по логу — только по имени `<EOP_HOST>`, пометка вместо проверки
без него, `/fail` только для `error`, пустой лог — сбой источника, общее чтение лога, alias-домены, разбор
`statusText` до конца строки, точные коды отказов, `discard` — локальная доставка, `postcat` потоком до 2 МБ,
журнал чтения текста, отказ «Отправить сейчас» для задержанного. Проверено тестами; на стенде заново не
прогонялось. Живой прогон обхода выше остаётся верным и по новому правилу: `relay=172.22.1.13[...]` не имя
`eop.test.local`.

Не сделано в этом этапе: статус доставки и отметка отбивок у письма (R-17, этап 4c); `Get-BlockedConnector`
(R-27, драйвер тенанта); автоматическое обновление диапазонов EOP (R-40); проверки в
`e2e-mailcow-driver.mjs`.

### 5.6. Этап 4: карантин и история rspamd, R-20 (2026-10-02)

Код — клиент API `services/mailNode/mailcow.js` (блок «Quarantine and rspamd history»), разбор письма,
история и настройка видимости — `services/mailNode/quarantine.js`, маршруты — `routes/mailNodeQuarantine.js`
(смонтированы на `/api/mail-node` рядом с `routes/mailNode.js`), экраны — `MailNodeQuarantine`
(вкладка «Администрирование → Почтовый узел» администратора, «Ящики» пользователя) и `SpamVerdict` (в `MessagePane`), демо —
`frontend/src/demo/index.js`. Что видит администратор и что делает каждая кнопка — [runbook, раздел
6в](../../operations/mail-node.md). Миграции не понадобилось: настройка видимости — поле
`quarantineUserView` строки `mail_node` в `integration_config` (слияние, как у остальных настроек узла).

| Что | Сделано | Отличия от R-20 |
|---|---|---|
| Список | `get/quarantine/all` (без писем): время, тема, отправитель, ящик, оценка, действие, признак вируса; главные символы — из истории rspamd, сопоставлены по ящику, оценке и времени (±2 мин), потому что `get/quarantine/all` символов не отдаёт, а у строки истории нет queue id; история не прочиталась или не пришла за 4 с — список без символов (чтение продолжается и заполняет кэш). В кэше истории у символов нет `options`. До 2000 новых записей с общим числом. Администратору при пустом карантине — число строк истории `reject`/`add header`/`rewrite subject` для ящиков панели (`spamInHistory`): больше нуля — предупреждение «карантин, скорее всего, выключен» | символы в списке — только для писем из последних 1000 в истории; письма на псевдоним (в истории адрес псевдонима, в карантине — ящик) остаются без символов в списке |
| Запись | `get/quarantine/<id>`: заголовки по порядку (развёрнуты, encoded words раскрыты; блок заголовков до 256 КБ, до 1000 строк разбора, на экран — первые 150, значения до 4000 символов; Subject, From, Date, Message-ID — первый экземпляр, To и Cc — все), From, отправитель конверта, ящик, дата, IP источника, `SFV`/`CAT` EOP, все символы с весами и пояснениями; письмо разбирается на сервере (multipart до 8 уровней и 100 частей, параметры заголовков — с учётом кавычек, HTML до 1 МБ, текст до 512 КБ, вложения — имя, тип, размер) и показывается только через безопасный вид R-41 (`safeViewMarkup`). mailcow хранит письмо после `mb_convert_encoding(…, 'HTML-ENTITIES', 'UTF-8')` (`meta_exporter/pipe.php`): сущности с кодом от 0x80 обращаются обратно в заголовках и в частях 7bit/8bit/binary; base64 и quoted-printable mailcow не трогал, их сущности (`&#8212;`) — собственные сущности письма и остаются как есть. 8-битная часть не в UTF-8 испорчена ещё в mailcow. Пользователю без прав администратора — без `user` (логин отправителя) и без `options` символов | вложения не скачиваются вовсе, исходное письмо (`.eml`) панель не отдаёт |
| Выпуск | `edit/qitem {action: "release"}`; успех — `item_released`, ошибка обучения rspamd после выпуска — предупреждение; журнал `mail_node.quarantine_released`. Диалог: необратимо, rspamd учит письмо как не спам и добавляет нечёткий хеш как хороший (`learnham` + `fuzzyadd` флаг 13, `fuzzydel` в mailcow закомментирован); оговорка про R-11 — только у `reject`; тексты исходят из формата выпуска `raw` (его ставит «Включить карантин»; узнать формат панель не может) | `learnham` в mailcow `2026-09` — тот же код, что `release` (ветка `release || learnham`): одна кнопка «Выпустить», которая и учит. Выпуск `add header` отбрасывается правилом `duplicate`, выпуск письма с `SFV:SPM` возвращается в Junk по R-11 |
| Удаление | `delete/qitem [id]`; журнал `mail_node.quarantine_deleted`. «Удалить и обучить как спам» — `edit/qitem {action: "learnspam"}`: mailcow удаляет запись, затем учит rspamd и добавляет нечёткий хеш; ошибка обучения (в том числе «already learned») после удаления — предупреждение; журнал `mail_node.quarantine_learned_spam` | — |
| Кто видит | администратор — всё; настройка «пользователи видят» (по умолчанию выключена) — все вошедшие видят записи ящиков узла, которые есть в панели, только просмотр («Настройки → Ящики»: вкладка «Почтовый узел» только для администратора); записи ящиков вне панели — только администратор (пользователю 404) | ящики в панели общие (`services/mailAccess.js`), поэтому «свои ящики» пользователя — все ящики узла панели |
| Настройки карантина | решение владельца 2026-10-02: разовое действие администратора «Включить карантин на этом узле» (`POST /quarantine/node-settings {confirm: true}`) записывает все поля `edit/quarantine`: `max_size` 10, `retention_size` 20, `max_age` 365, `max_score` пусто, `exclude_domains` `[]`, `release_format` `raw`, `sender`/`subject`/`bcc`/`redirect`/`html_tmpl` пусто (запасные значения проверены по `quarantine_notify.py`: `quarantine@localhost`, «Spam Quarantine Notification», встроенный шаблон, порог 9999). Время записи — `quarantineSettingsAppliedAt` в настройках узла, после него кнопка — «Записать ещё раз» с более строгим предупреждением; журнал `mail_node.quarantine_settings_applied`. До записи — только обнаружение (`spamInHistory`) | читать эти настройки API не умеет (`quarantine('settings')` вызывают только `quarantine.php` и `admin/system.php`), а `edit/quarantine` сбрасывает непереданные поля, поэтому выборочной правки нет: только «записать всё» с предупреждением |
| «Почему в Junk» | `GET /api/mail-node/messages/:id/spam-verdict` для письма ящика узла (любой вошедший): `get/logs/rspamd-history/1000` (таймаут 20 с), кэш 60 с на узел, одновременные запросы делят одно чтение; поиск по `Message-ID` (без `<>`) среди строк для адресов ящика и его псевдонимов, ближайшая по времени (`message_id`); иначе по `Message-ID` среди строк для других адресов доменов узла (`message_id_other_rcpt`, экран говорит об этом; строки только для чужих доменов не берутся); без `Message-ID` — адрес, тема и ±30 мин от даты письма, без темы — ±2 мин (`recipient_time`). Ответ — оценка, пороги `add header`/`reject` (`thresholds` строки), действие, до 15 символов с ненулевым весом и пояснениями, число строк истории, категория EOP из `messages.eop_category`. Кнопка — у письма в папке «Спам» ящика узла в окне письма и у каждого такого письма в ленте переписки (`ConversationThread`), запрос — по нажатию; ответ для уже закрытого письма отбрасывается; ошибки — словами экрана узла (`mailNodeErrorKey`) | вердикт EOP — только сохранённая категория (`CAT`), `SFV` синхронизация не хранит, поэтому причина «правило EOP» с оговоркой; «rspamd отметил как спам» — только для `add header`/`rewrite subject` |

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

Проверено на стенде после правок ревью (2026-10-02, тот же способ; тестовый ящик заведён и удалён):
- `POST /quarantine/node-settings` без `confirm` — 400 `quarantine_settings_unconfirmed`; с `{confirm: true}` —
  в Redis mailcow `Q_MAX_SIZE` 10, `Q_RETENTION_SIZE` 20, `Q_MAX_AGE` 365, `Q_MAX_SCORE` пусто,
  `Q_RELEASE_FORMAT` `raw`, `Q_EXCLUDE_DOMAINS` `[]`, `Q_SENDER`/`Q_BCC`/`Q_REDIRECT`/`Q_SUBJ`/`Q_HTML` пусто; после
  этого карантин сразу хранит письма (без ручной правки Redis, как в первой проверке);
- письмо с HTML в quoted-printable, где `&#8212; &#8364; &#169;` и кириллица сущностями: HTML в записи —
  сущности как в письме, `=C3=A9` раскрыто в «é», 8-битный текст с кириллицей прочитан;
- `POST /quarantine/4/learn-spam` — `{ok, learned: true, warnings: []}`, повтор — 404; удаление — `{ok}`;
- после проверки настройки карантина стенда возвращены как были (`Q_MAX_AGE` 365 и `Q_RELEASE_FORMAT` `raw`
  — их ставит entrypoint php-fpm, остальных ключей нет), записи журнала и `quarantineSettingsAppliedAt`
  удалены, карантин пуст.
- Не проверено на стенде: предупреждение `spamInHistory` (в панели стенда нет ящиков узла) и кнопка «почему
  в Спаме» в ленте переписки — покрыты тестами.

### 5.7. Этап 4c: статус доставки и отбивки, R-17 (2026-10-02)

Код — хранение и лог узла `backend/src/services/deliveryStatus.js`, отбивки `services/deliveryReport.js`,
словарь кодов `services/mailNode/deliveryCodes.js` (его же берут оповещения `nodeAlerts.js`), разбор строк
TLS, `pid` и `delays` — `services/mailNode/postfixLog.js`, крючок синхронизации — `imapManager.js`
(`_scheduleDeliveryReports`), маршрут — `routes/delivery.js` (`GET /api/mail/messages/:id/delivery`,
смонтирован на `/api/mail`), отметка в строках списка — `messageService.js`, `routes/mail.js`,
`routes/search.js` (`delivery_state`); экраны — `DeliveryDetails` (блок «Доставка» в `MessagePane`) и
`DeliveryMarker` (строки `MessageList`), правила — `frontend/src/utils/delivery.js`, демо —
`frontend/src/demo/index.js`; fake-EOP — `scripts/deploy/test/fake-eop/`. Порядок для администратора —
[runbook, раздел 6г](../../operations/mail-node.md). Миграция `0084_message_delivery_status.sql`.

**Хранение.** Таблица `message_delivery_status`: строка на (ящик, `Message-ID`, получатель) с последним
известным исходом — `state` (`sent`, `deferred`, `bounced`, `expired`, `unknown` из лога; `failed`,
`delayed` из отчёта), `source` (`log` или `dsn`), код, короткая диагностика (до 300 символов), время; рядом
`log` и `report` — последние сведения каждого источника отдельно (relay, IP, порт, вид relay
`eop`/`local`/`discard`/`other`, TLS, отметка EOP, queue id и отправитель конверта; у отчёта — `Action`,
`Remote-MTA`, `Reporting-MTA`). Получатель — адрес, как его написал отправитель: `orig_to` лога (иначе
`to=`) и `Original-Recipient` отчёта (иначе `Final-Recipient`); адрес после раскрытия, если другой,
показывается отдельно. Кто побеждает: отказ — над тем, что не отказ (письмо, которое EOP принял, а Microsoft
потом вернул отчётом, — недоставлено, как бы ни расходились часы узла и Microsoft; собственный отказ узла —
над задержкой из отчёта); из двух отказов — лог (в нём relay и ответ); иначе более поздний, причём отчёт
без времени или не раньше строки лога больше чем на 2 минуты считается более поздним. Внутри одного
источника: более старая строка лога ничего не меняет; отчёт заменяет более старый, отчёт без времени —
любой. Та же строка лога, прочитанная снова без своей строки TLS или отметки EOP (они ушли из окна чтения),
сохранённые TLS и отметку не стирает. Повторное чтение тех же строк ничего не пишет (сравнение без учёта
порядка ключей `jsonb`). Запись одного письма — одна транзакция под `pg_advisory_xact_lock` на (ящик,
`Message-ID`): задание и открытое письмо не пишут поверх друг друга. Отметка списка — подзапрос по
первичному ключу и только у копии в папке «Отправленные» (письмо самому себе лежит ещё и во «Входящих» —
там отметки нет): `failed`, если хоть один получатель `bounced`/`expired`/`failed`, иначе `delayed`, если
хоть один `deferred`/`delayed` с новостями не старше 6 дней (срок жизни очереди Postfix, 5 дней, плюс
день); в окне письма такая устаревшая задержка читается «несколько дней без новостей: итог неизвестен».

**Только свои отправленные письма.** И сведения из лога, и отметки отчётов — только для письма, которое
ящик сам отправил: журнал панели (`message.sent` этого ящика с этим `Message-ID`) или копия в его папке
«Отправленные» с адреса входа ящика. Полученное письмо, письмо другого ящика или письмо, на которое
претендуют через псевдоним, ничего не получают (маршрут отвечает `owned: false`), лог для него не читается.
Псевдонимы панели (`account_aliases`) для этого не используются: добавить псевдоним может любой, а с ним —
увидеть получателей (в том числе Bcc), relay и ответы чужого письма.

**Лог узла.** Задание оповещений (раздел 5.5) после своего чтения лога проходит письма журнала `message.sent`
за 7 дней ящиков, которые на узле (`mail_node` и тот же хост, что в настройках узла); ошибка этого прохода
пишется в лог панели и не трогает ни оповещения, ни пинг Healthchecks. Второго чтения и таймера нет;
очередь узла задание теперь читает до лога. Письмо находится по строке `cleanup ... message-id=`, доставки —
по queue id (`correlateByQueueId`). Очередь письма — только та, что поставил сам ящик: отправленная с его
логином (`sasl_username` строки `smtpd ... client=`; SOGo mailcow тоже входит, `SOGoSMTPAuthenticationType
= plain`); если логина в логе нет ни у одной очереди с этим `Message-ID` — та, у которой отправитель
конверта (`qmgr from=`) равен адресу входа ящика. Копия, которую переслало правило Sieve (тот же
`Message-ID`, тот же отправитель, но без логина), при этом отбрасывается. По каждому получателю —
последняя строка доставки; строка `status=expired` (без получателя) переводит отложенных получателей в
`expired`; письмо, удалённое из очереди (`postsuper -d`, кнопка R-16), с отложенным получателем — в
`unknown` («ушло из очереди без окончательного ответа»). Отметка EOP — из ответа `250 2.6.0 <Message-ID>
[InternalId=..., Hostname=...]` (старый ответ fake-EOP без `Hostname` тоже читается). TLS приписывается
доставке, только если в окне соединения ровно одна строка TLS к тому же `host[ip]:port`: все письма идут на
один хост EOP, и при двух одновременных соединениях (или если одно ушло без TLS) верное не выбрать —
тогда «нет в логе».

Письмо, которое долго лежит отложенным, своей строки `cleanup` в чтении (10000 строк) может уже не иметь:
она пишется один раз при постановке в очередь. Поэтому отложенные получатели хранят queue id и отправителя
конверта, и следующие попытки находятся по queue id: `qmgr` пишет `from=` при каждой активации, так что
отправитель проверяется снова, а очередь, где `cleanup` называет другой `Message-ID` (Postfix выдал тот же
queue id другому письму) или другой отправитель, не берётся. Если отложенного письма нет в очереди узла, а в
логе нет его окончательной строки, получатель становится `unknown` со временем самой задержки — поэтому
окончательная строка, найденная позже (задание читает очередь до лога, а лог может быть из кэша минутной
давности), всё равно побеждает. Чтение лога разбирается в индекс один раз на всё кэшированное чтение
(общий для задания и всех открытых писем); задание одним запросом читает сохранённые строки всех писем
журнала и пишет только те письма, у которых что-то изменилось. Открытие блока ищет письмо ещё раз в том
же кэшированном чтении (60 с) — и для писем, отправленных не из панели, если они в «Отправленных» и с
адреса входа ящика. Если поиск упал (лог не прочитался или любая другая ошибка), блок показывает
сохранённое и пишет, что лог недоступен, а не отвечает ошибкой.

**Отбивки.** Сначала — настоящая отбивка со стенда (`eop mode recipient-denied`, письмо ящика узла двум
получателям, 2026-10-02): Postfix mailcow присылает `multipart/report; report-type=delivery-status` из
трёх частей — `text/plain`, `message/delivery-status` (блок письма с `Reporting-MTA`, `X-Postcow-Queue-ID`,
`Arrival-Date`, затем по блоку на получателя: `Final-Recipient`, `Original-Recipient`, `Action: failed`,
`Status: 5.4.1`, `Remote-MTA`, перенесённый на две строки `Diagnostic-Code`) и `message/rfc822` с исходным
письмом целиком. `In-Reply-To` и `References` в отбивке Postfix нет, `Original-Message-ID` тоже. Зато IMAP
кладёт конверт вложенного `message/rfc822`, с его `Message-ID`, прямо в BODYSTRUCTURE, а синхронизация и
так берёт BODYSTRUCTURE и заголовки каждого письма. Поэтому самая дешёвая надёжная точка — синхронизация:
отчёт узнаётся по структуре без лишних запросов; исходный `Message-ID` — из конверта возвращённого
письма, иначе `In-Reply-To`, иначе последний `References` (так у отчётов Exchange), иначе из части
`text/rfc822-headers` (её забирают только в этом случае); у каждого отчёта отдельно забирается только
часть `message/delivery-status` (сотни байт). Это происходит сразу после синхронизации папки, на одной
фоновой сессии под семафором фоновых соединений хоста, и только для писем, которые эта синхронизация
вставила впервые (повторный проход папки отчёты заново не читает), не старше 30 дней и не больше 50 самых
новых за синхронизацию (первая синхронизация ящика вставляет всю историю как новые письма). Часть больше
64 КБ (по BODYSTRUCTURE) не забирается, получателей читается не больше 100. Повторной попытки нет: отчёт,
который не прочитался, ничего не отмечает. Разбор — только стандартные поля RFC 3464/6533: `X-Postcow-*` и
прочие поля производителей игнорируются; получатель — `Original-Recipient` (как `orig_to` лога, поэтому
оба источника ложатся в одну строку), иначе `Final-Recipient`. `failed` — «не доставлено», `delayed` —
«задерживается», `delivered`/`relayed`/`expanded` ничего не отмечают. Отметка ставится только письму,
которое ящик сам отправил (см. выше): отчёт может прислать кто угодно, указав любой `Message-ID`; если
письмо есть в журнале, — только его получателям (To, Cc, Bcc журнала; у копии из «Отправленных», сделанной
не панелью, Bcc нет, поэтому её получатели не проверяются). Диагностика отчёта и ответ сервера из лога на
экране — цитата удалённого сервера, обычный текст без ссылок.

**Доступ.** Блок открывает любой, кто может открыть письмо (ящики общие): права администратора не нужны.
Сервер сам находит ящик, `Message-ID` и queue id; от клиента — только id письма, в ответе — только исходы
этого письма, без строк лога. Лог читается только для своего отправленного письма ящика на узле
(`mail_node` и `onOtherMailHost`, как у «почему в Спаме»); остальным ящикам — только отметки отчётов. Ответ —
`{ messageId, owned, node, log: { coverage, error, oldestAt, sentAt } | null, recipients }` (`owned: false` —
письмо ящик не отправлял, остального нет); `coverage`: `found` (лог показывает письмо сейчас), `stored`
(показывал раньше, исход сохранён), `gone` (не встречалось, а лог начинается позже отправки — «лог
почтового узла это письмо уже не покрывает: сведений о доставке нет», и это не «доставлено»), `not_found`
(лог покрывает время, строк нет), `unavailable` (лог не прочитался или поиск упал). Строки ленты
(`GET /api/mail/thread/...`) и переписки (`ConversationThread`) несут ту же отметку; карточка своего письма в
переписке, раскрытая, показывает тот же блок «Доставка».

**Словарь кодов.** Один модуль для экранов и оповещений: `5.7.64` атрибуция (сертификат коннектора),
`5.7.711`/`AS(2204)` коннектор заблокирован, `5.7.233` TERRL, `5.7.232` TERRL пробного тенанта (оба
поднимают оповещение `terrl_exceeded`), `5.4.1` адрес не принят (DBEB), `5.4.14` петля маршрутизации, иначе
класс `4.x.x` (временный) или `5.x.x` (постоянный). Совпадение — точный код (`dsn=`, `Status:`) или код,
стоящий отдельно в ответе или диагностике, как в 4a. Тексты для людей — `message.delivery.code.*` в
`en.json`/`ru.json`; временный отказ описан нейтрально («отправляющий сервер повторяет попытки»), он
подходит и логу узла, и отчёту чужого сервера.

| Пункт R-17 | Сделано | Отличия от раздела 4 и от решений |
|---|---|---|
| Лог | состояние, время, relay, IP, порт, `dsn`, ответ сервера (до 300 символов), TLS (уровень, протокол, шифр), отметка EOP (`InternalId`, `Hostname`, `Message-ID` из ответа), queue id | `pid` в разбор добавлен, но API mailcow его не отдаёт: шаблон syslog-ng пишет `$PROGRAM` без `$PID`, у записи только `time`, `program`, `priority`, `message` (проверено чтением API стенда). Поэтому TLS сопоставляется с доставкой по серверу (`host[ip]:port`) и времени: строка TLS не раньше `delays` c+d (округлено вверх) плюс секунда до строки доставки, и только если она в этом окне одна; экран пишет «сопоставлено по серверу и времени». Если номер процесса когда-нибудь появится — сопоставление по нему (окно 300 с). Повторно использованное соединение — «нет в логе», без догадок по политике TLS |
| Отбивки | отметка по каждому получателю, `failed`/`delayed`, для любого ящика | `Original-Message-ID` в отчётах нет; ключ — `Message-ID` возвращённого письма (см. выше) |
| Словарь | общий модуль, оповещения пользуются им | — |
| Хранение | миграция 0084 | ключ строки — (ящик, `Message-ID`, получатель), а сведения обоих источников хранятся рядом (`log`, `report`), чтобы поздний отчёт не стирал relay и TLS |
| Экран | блок «Доставка» у отправленного письма (по раскрытию), пометка в списке, в ленте и в переписке, демо | блок — у письма из «Отправленных» и у любого письма с отметкой; состояние `unknown` (ушло из очереди, давно без новостей, неизвестное экрану состояние) — словами и нейтральным цветом, отброшенное правилом — как отброшенное |

Проверено на стенде (2026-10-02, код ветки в одноразовом контейнере образа backend стенда
`sha-e7d870e180e2` на сети `stage_mailexpert` с окружением `stage-backend`; БД — временная база `r17check` в
`stage-postgres` со всеми миграциями ветки, из базы панели только прочитана строка настроек узла;
тестовый ящик `r17-delivery@stage.test` заведён и удалён вместе с отбивкой; временная база удалена):
- строки `Untrusted TLS connection established to eop.test.local[172.22.1.7]:25: TLSv1.3 with cipher
  TLS_AES_256_GCM_SHA384 ...` в ответе `get/logs/postfix` есть; fake-EOP STARTTLS предлагает (и требует);
- fake-EOP теперь отвечает в форме EOP: `250 2.6.0 <Message-ID письма> [InternalId=1099511627777,
  Hostname=EOPSTAGE01MB0001.stageprd01.prod.eop.test.local] 1091 bytes in 0.049, 21.743 KB/sec Queued mail
  for delivery`;
- принятое письмо двум получателям (задание оповещений, затем маршрут ветки): по каждому `sent`, `relay`
  `eop.test.local`, `172.22.1.7`, `25`, вид `eop`, TLS `untrusted`/`TLSv1.3`/`TLS_AES_256_GCM_SHA384`
  (по времени), отметка EOP `InternalId=1099511627777` с `Hostname`, queue id `0C3BF1A4B81`; оповещений нет;
- `recipient-denied`: отбивка прочитана тем же запросом, что у синхронизации (BODYSTRUCTURE и заголовки),
  затем `readDeliveryReports`: исходное письмо найдено по конверту возвращённого письма, оба получателя —
  `failed`, `5.4.1`, `source: dsn` ещё до чтения лога; строка списка — `delivery_state: failed`; после
  задания — `bounced` из лога (то же время, лог побеждает при равенстве), отчёт сохранён рядом, объяснение
  `recipient_not_accepted`;
- покрытие: чтение 5 строк лога (начинается после отказанного письма) — `stored` с сохранёнными
  получателями; после удаления строк письма — `gone`, получателей нет; полное чтение — снова `found`;
- в конце: режим fake-EOP `accept`, очередь пуста, спул fake-EOP очищен от тестового письма, файлы
  fake-EOP стенда возвращены к версии `main` (форма ответа EOP появится на стенде после слияния и `eop up`).

Не проверено на стенде: крючок `_scheduleDeliveryReports` внутри `syncMessages` (на стенде нет ящика узла в
панели с синхронизацией ветки; функции, которые он вызывает, проверены вживую выше, сам вызов — тестом
`imapManager.test.js`), экраны (тесты рендера и демо), отчёты Microsoft (форма с `In-Reply-To` и
`text/rfc822-headers` — фикстура по описанию Exchange, не артефакт тенанта; проверяется с тенантом).

Ревизия PR (2026-10-02): только свои отправленные письма (журнал или копия в «Отправленных» с адреса входа)
и очередь по логину ящика вместо псевдонимов панели; отчёты — только о своих письмах и их получателях,
диагностика — цитатой; отложенное письмо — по сохранённому queue id, `unknown` после ухода из очереди или
удаления, отметка задержки стареет через 6 дней; отказ из отчёта побеждает `sent` лога при любом расхождении
часов; TLS — только при единственной строке в окне; повторное чтение не стирает TLS; получатель — `orig_to`;
`discard` отдельно; ограничения на размер отчёта, число получателей и отчётов за синхронизацию; индекс лога —
один на чтение, задание пишет только изменившиеся письма; ошибка поиска — сохранённое и `unavailable`;
отметка только у копии в «Отправленных», в ленте и в переписке. Проверено тестами (в том числе на
фикстурах лога и отбивки со стенда); на стенде заново не прогонялось.

Тесты: backend — `npm run lint` чисто, `vitest run` 245 файлов, 3909 тестов; frontend — `npm run lint`
чисто, `npm test` 3804 теста, `npm run build` собирается; fake-EOP — `node --test eop.test.mjs` 33 теста.

### 5.8. Этап 5: хост узла и rspamd, R-39, R-40, R-12 (2026-10-02)

Код хоста — `scripts/deploy/mail-node/`: `setup.sh` (R-39), `eop-ranges.sh` (R-40), общая библиотека
`lib.sh`, `extra-cf.sh` (перенесён из `scripts/deploy/test/fake-eop/`: стенд и рабочий узел правят
`extra.cf` одним инструментом), шаблоны `systemd/` и `cron/`, [README](../../../scripts/deploy/mail-node/README.md);
`send_ping` и `ping_target` переехали из `lib/backup.sh` в `lib/common.sh`, чтобы ими пользовался и таймер
узла. Тесты — `scripts/deploy/test/mail-node-setup.bats` и `mail-node-eop-ranges.bats`, заглушки
`docker`, `iptables`/`ip6tables`, `ipset`, `curl`, `systemctl` и записанные ответы веб-сервиса — в
`scripts/deploy/test/mail-node/`; задание CI «Bats» ставит `jq` в образ `bats/bats` (его там нет, а разбор
ответов Microsoft идёт через `jq`). Код панели (R-12) — пункт `forwarding_hosts` в
`services/mailNode/nodeApply.js`, вызовы `get/fwdhost/all`, `add/fwdhost`, `delete/fwdhost` в `mailcow.js`,
проверка списка `eopRangeList` в `eopRanges.js`; экран — `MailNodeApplyResult`, демо —
`frontend/src/demo/index.js`. Порядок для администратора — [runbook, разделы 3, 4 и 6](../../operations/mail-node.md).
Миграций нет: что панель добавила на узел, хранится в `owned.fwdhosts` итога узла (`mail_node_apply`).

| Требование | Сделано | Отличия от раздела 4 |
|---|---|---|
| R-39 | `setup.sh` сначала строит все файлы целиком и только потом пишет, только изменившиеся, через временный файл рядом и переименование (владелец и права сохраняются): `mailcow.conf` — `SKIP_CLAMD=y`, `SKIP_OLEFY=y`, `SKIP_FTS=y`, `ENABLE_IPV6=false` явно и все почтовые порты только на IPv4 (`SMTP_PORT`, `SMTPS_PORT`, `SUBMISSION_PORT`, `IMAP_PORT`, `IMAPS_PORT`, `POP_PORT`, `POPS_PORT`, `SIEVE_PORT` = `0.0.0.0:<порт>`, заданный IPv4-адрес остаётся; остальные строки и повторы ключа сохраняются; в выводе — только эти ключи, в файле пароли; на запущенном mailcow скрипт пишет, что нужен `docker compose down && up -d`, но не делает его); `extra.cf` — `relayhost = <EOP_HOST>` (`--eop-host`, без него шаг пропускается) с перезапуском `postfix-mailcow` только при изменении строки; `dovecot-extra.conf` блоком между метками в `data/conf/dovecot/extra.conf` с перезапуском `dovecot-mailcow` только при изменении (копия, дописанная руками по прежнему runbook, становится блоком; те же настройки вне блока — отказ до любой записи, со списком строк); неудавшийся перезапуск оставляет отметку, следующий запуск повторяет его; `/etc/mailexpert-node/node.env` (0600) с адресами панели (адрес или сеть не шире /24 и /48), поставленным `ENABLE_IPV6`, `EOP_HOST`, ссылкой Healthchecks и постоянным `EOP_CLIENT_REQUEST_ID` (создаётся один раз); копия `eop-ranges.sh` с библиотеками в `/opt/mailexpert-node`, первый прогон таймера, правила `DOCKER-USER`, список чужих правил `DOCKER-USER` на почтовых портах (остались от настройки руками) с предупреждением, таймер systemd (перезапускается, если его юнит изменился; cron без systemd). Заданные один раз параметры берутся из `node.env`; второй прогон ничего не пишет и не перезапускает. `--dry-run` печатает diff `extra.cf` и блока Dovecot, ключи `mailcow.conf` (было → стало) и правила файрвола (`node.env` — только имена ключей: ссылка Healthchecks — секрет). Docker с бэкендом nftables — отказ | правила — в своей цепочке (пара `MAILEXPERT-NODE`/`MAILEXPERT-NODE-2`), на которую переходит `DOCKER-USER`, и только для трафика к опубликованным портам: `-o br-mailcow ! -i br-mailcow` (имя моста задано в `docker-compose.yml` mailcow). Правило «порт 25 только EOP» без такого условия отбрасывало бы и исходящую почту mailcow в EOP (тоже FORWARD с портом назначения 25) — пример прежнего runbook этим страдал, исправлен; привязка к внешнему интерфейсу (первая версия этапа) открывала порты при втором канале или переименовании интерфейса. Порты — порты контейнеров (после DNAT Docker), так перенос порта хоста их не обходит. 587 и 993 чужим — сброс соединения (`REJECT --reject-with tcp-reset`), а не `DROP`. Привязка портов к IPv4 — не альтернатива `ENABLE_IPV6=false` (D-13), а дополнение: без неё `docker-proxy` слушает `[::]` |
| R-40 | `eop-ranges.sh` раз в час (`mailexpert-eop-ranges.timer`, `RandomizedDelaySec` 10 минут; сервис Docker не запускает — только `After`): `version/Worldwide` с `clientrequestid` установки; та же версия — без запроса диапазонов, наборы сверяются с сохранённым списком и при расхождении заполняются из него; новая — `endpoints/Worldwide?ServiceAreas=Exchange`, фильтр как у `rangesFromEndpoints` (`serviceArea` Exchange, в `tcpPorts` есть 25, пробелы вокруг запятых допустимы — в записанном ответе есть `"143, 587, 993, 995"`, `id` не используется, незнакомые поля пропускаются), каждый CIDR проверяется (не шире /8 и /24), нужен хотя бы один IPv4; набор заполняется во временном ipset и подменяется `ipset swap`; затем файл `/var/lib/mailexpert-node/eop-ranges.txt` (по CIDR на строку, IPv4 первыми, через временный файл) и версия. Потом проверка узла: правила файрвола на месте (собираются заново, если цепочка не такая, какой её оставила последняя сборка), `ENABLE_IPV6` в `mailcow.conf` тот, что поставил `setup.sh` (`update.sh` mailcow его включает), и при выключенном IPv6 никто не слушает почтовые порты по IPv6 (`ss -ltn`). IPv6 (`ip6tables`, набор `mailexpert-eop6`) — при `ENABLE_IPV6=true` или если Docker создал IPv6-цепочку `DOCKER-USER`; без IPv6-диапазонов набор пуст, порт 25 по IPv6 закрыт, и это не повод запрашивать список каждый час. Healthchecks: успех с версией и числом диапазонов (при смене версии тело начинается с `eop_ranges_version_changed <старая>-><новая>` — сигнал обновить копию панели) или `/fail` со всеми причинами, включая сбой файрвола. `--dry-run` (diff со списком в файле), `--force`, `--restore` (при загрузке **до** Docker: проверенный сохранённый список, наборы, `DOCKER-USER` создаётся, если её нет; без запроса к Microsoft; сбой — `/fail`). Юниты: `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `ProtectSystem=full`, запись только в `/var/lib/mailexpert-node` | 429 — тоже `/fail` (при запросе раз в час он означает, что что-то не так); при сбое первого прогона в `setup.sh` правила файрвола не ставятся вовсе (порт 25 закрылся бы для EOP), при сбое следующих остаётся то, что есть. Юнит восстановления — `WantedBy=docker.service`, а не `Requires` (решение: доступность важнее закрытия при сбое; часовой прогон поднимет `/fail` и поставит правила). С cron восстановление — `@reboot` через 60 с: эту минуту порты открыты без правил (ограничение, в runbook) |
| R-12 | пункт «Forwarding hosts» общего «Применить» (тот же формат итога и журнал `mail_node.applied`): `get/fwdhost/all` → недостающие диапазоны `add/fwdhost {hostname, filter_spam: 1}` (параметра у обёртки нет: другое значение отправить нельзя) → чтение заново (не появилось — `fwdhost_not_written`); `delete/fwdhost` — только для записей из `owned.fwdhosts`, которых больше нет в списке, и тоже с проверкой чтением (осталось — `fwdhost_not_deleted`, запись остаётся «своей» до следующего прогона). Чужая запись диапазона с `keep_spam` («Filter spam» выключен) — панель включает ей фильтр (`add/fwdhost` с `filter_spam: 1` по существующему ключу снимает `KEEP_SPAM`), пункт `changed` с кодом `fwdhost_filter_turned_on`, запись остаётся чужой и никогда не удаляется; любая другая запись с `keep_spam`, пересекающаяся с диапазоном (шире или уже: rspamd проверяет `KEEP_SPAM` для всех сетей вокруг адреса клиента, /8-/32), — `failed` с кодом `fwdhost_keep_spam`, не трогается. В итоге — версия списка, сколько диапазонов на узле, каких нет, чужие записи («не трогаются»), записи с выключенным фильтром и те, кому фильтр включён. Пункт, упавший на середине, несёт в итоге и в журнале то, что успел добавить или удалить (`to`/`from`). Только если пункт правила раскладки спама (R-11) — `ok`: иначе `skipped` с `prefilter_not_applied` (правила нет) или `prefilter_check_failed` (правило не прочиталось) и тем, что панель добавила раньше (`current`), без удаления. Запись правила кнопкой сразу добавляет ждавшие его диапазоны; ответ кнопки несёт итог диапазонов, и сообщение экрана говорит, добавились ли они. Список без версии, без IPv4, с испорченным или слишком широким CIDR — `skipped` с `eop_ranges_invalid`, ничего не меняется | IPv6-диапазоны тоже ставятся (на поведение при `ENABLE_IPV6=false` не влияют). Правило, которое перестало совпадать (новая версия правила в новом выпуске панели), forwarding hosts не снимает: это вернуло бы отказы по SPF, от которых они защищают |

**Источник диапазонов для панели.** Панель берёт свою копию — `EOP_RANGES` в `eopRanges.js` (обновляется
`scripts/update-eop-ranges.mjs` к выпуску) — и сама к веб-сервису не ходит. Почему: панель и узел — разные
серверы, канала до файла таймера у панели нет; свой запрос потребовал бы второго постоянного
`ClientRequestId` и ещё одного источника сбоев (400, 429) в панели; запись Exchange/25 с версией
`2026081400` не менялась с 2026-08-14. Риск: новый диапазон EOP, который таймер уже открыл в файрволе,
до выпуска панели не будет forwarding host, и письмо с него от домена с `-all` и `p=reject` получит отказ.
Поэтому версия копии видна в пункте итога, а смена версии на узле — отдельный сигнал: тело пинга таймера
начинается с `eop_ranges_version_changed <старая>-><новая>`, и runbook (раздел 4) велит настроить это слово
в Healthchecks как признак сбоя. Проверка списка в панели (`eopRangeList`) — те же правила, что у таймера:
не пустой, есть IPv4, каждый CIDR корректен и не шире /8 (IPv4) и /24 (IPv6), есть версия.

**Проверено.**
- bats: 34 новых теста (`mail-node-setup.bats` 18, `mail-node-eop-ranges.bats` 16) на записанных
  2026-10-02 ответах `version/Worldwide` (с недокументированным `serviceArea`) и
  `endpoints/Worldwide?ServiceAreas=Exchange`: разбор (4 диапазона IPv4 и 2 IPv6, запись TCP 443 с теми же
  диапазонами и `52.238.78.88/32` не берётся), 400 без GUID (скрипт не делает запрос, а ответ 400 самого
  сервиса оставляет список), 429, та же версия (один запрос, ни одной записи), новое поле в `version` с
  новой версией (наборы подменены), пустой, только IPv6, испорченный и не-список (не применяются), нет
  ответа, отказ `ipset` (живой набор прежний), IPv6 только при `ENABLE_IPV6=true`, `--dry-run`,
  `--restore`; файрвол (ждёт заполненного набора, смена цепочки с одним переходом, отказ правила оставляет
  старую цепочку), `mailcow.conf`, блок Dovecot, повторный прогон без изменений, отказ при настройках
  Dovecot вне блока, первый сбой таймера без правил, cron без systemd. Все 156 тестов bats проходят,
  shellcheck чисто.
- Настоящие `iptables` (nft) и `ipset` в одноразовом контейнере ubuntu 24.04 со своим сетевым
  пространством (`NET_ADMIN` только у него, `curl` и `docker` — заглушки тестов): `setup.sh` поставил
  цепочку и набор из 4 диапазонов, второй прогон не изменил `iptables-save`, новый адрес панели — одна
  ссылка из `DOCKER-USER` на новую цепочку, новая версия списка — набор подменён, после удаления правил и
  набора `--restore` вернул их, с `ENABLE_IPV6=true` — то же в `ip6tables` и наборе `inet6`.
- Стенд (код ветки в одноразовом контейнере образа backend стенда на сети `stage_mailexpert` с окружением
  `stage-backend`; из базы панели прочитаны только настройки узла). Forwarding hosts до проверки — пусто,
  правило раскладки спама на месте (`ok`). DNS стенда: unbound mailcow не достаёт до корневых серверов
  (`SERVFAIL`, у rspamd `R_SPF_DNSFAIL`), поэтому на время проверки в unbound добавлена пересылка на `1.1.1.1`
  командой `unbound-control forward_add` (только в памяти; после проверки снята, кэш сброшен). Отправитель —
  адрес публичного домена с SPF `-all` и DMARC `p=reject`, чей SPF не включает Microsoft (у самой Microsoft
  SPF включает диапазоны EOP и с них проходит), получатель `b@stage.test`:
  - до: `rspamc -i 40.92.1.1` — `R_SPF_FAIL` (8, `-all`), `DMARC_POLICY_REJECT` (16), `reject`, 31.2;
  - прогон `runApply` (без `<EOP_HOST>` и адресов панели, так что писал только этот пункт) — `changed`, 6
    записей, у всех `keep_spam: no`; в Redis `KEEP_SPAM` пуст; второй прогон — `ok`, записей нет;
  - после: `40.92.1.1`, `40.93.200.7`, `40.107.1.1`, `52.100.1.1` — `WHITELISTED_FWD_HOST`, ни
    `R_SPF_FAIL`, ни `DMARC_POLICY_REJECT` (композит `WL_FWD_HOST` снимает положительные веса групп
    `policies`, `rbl`, `hfilter`), `no action`, 5.9; адрес вне EOP `198.51.100.7` — по-прежнему `reject`;
  - находка: `104.47.0.1` и `52.103.250.9` (без PTR) при `rspamc` без `--hostname` не совпали, и у них же
    пропал `RCPT_MAILCOW_DOMAIN` — то есть при эмуляции клиента без имени redis-карты multimap rspamd не
    срабатывают вовсе; с `--hostname` (Postfix передаёт имя клиента всегда) оба — `WHITELISTED_FWD_HOST`,
    `no action`. Адреса EOP имеют PTR (`*.outbound.protection.outlook.com`); как ведёт себя письмо через
    Postfix с адреса без PTR (имя `unknown`), стенд проверить не может — эксперимент 12 на тенанте;
  - после проверки записи удалены (`delete/fwdhost` всех шести), `get/fwdhost/all` — `[]`, хэши Redis
    пусты, `rspamc -i 40.92.1.1` — снова `reject`; пересылка unbound снята; режим fake-EOP `accept`, очередь
    Postfix пуста. Карантин стенда ничего не сохранил (`Q_MAX_SIZE` 0, `pipe.php` отвечает 505); строки
    тестовых проверок остались в истории rspamd.

Ревизия PR (2026-10-02):
- **IPv6 в обход файрвола.** С `ENABLE_IPV6=false` и портом без адреса (`SMTP_PORT=25`) Docker слушает его и
  на `[::]` через `docker-proxy`. Проверено на стенде (Docker 29.8.1, `ENABLE_IPV6=false`): `ss -ltnp` в
  `me-stage` показывает `docker-proxy` на `[::]:25`, `465`, `587`, `143`, `993`, `110`, `995`, `4190`;
  одноразовый контейнер с `-p 39025:25` слушает `0.0.0.0:39025` и `[::]:39025`, с `-p 0.0.0.0:39026:25` —
  только `0.0.0.0:39026` (контейнеры удалены). На хосте с глобальным IPv6 такой трафик идёт через `INPUT`,
  мимо `DOCKER-USER`, и приходит в mailcow с адреса шлюза моста, которому доверяет `mynetworks` — обход
  файрвола и риск открытого релея. Теперь `setup.sh` публикует все почтовые порты только на IPv4, а часовой
  прогон шлёт `/fail`, пока `ss -ltn` показывает почтовый порт по IPv6.
- Сбой файрвола в часовом прогоне и в `--restore` — `/fail` и код 1 (раньше — предупреждение и успех).
- «Без изменений» сравнивает цепочку с тем, что оставила последняя сборка (вывод `iptables -S`), а не только
  желаемые правила: очищенная или исправленная руками цепочка собирается заново. Сборка — во второй цепочке
  пары, без переименования: цепочка в силе не теряет перехода, даже если старую удалить не удаётся.
- Восстановление после загрузки — до Docker (`DefaultDependencies=no`, `After=local-fs.target
  network-pre.target`, `Before=docker.service`, `WantedBy=docker.service`), с созданием `DOCKER-USER`;
  часовой юнит больше не тянет Docker (`Wants` убран). Docker с бэкендом nftables — отказ.
- `update.sh` mailcow возвращает `ENABLE_IPV6=true`: `setup.sh` хранит своё значение в `node.env`, часовой
  прогон шлёт `/fail` при расхождении; IPv6-правила ставятся всегда, когда есть IPv6-цепочка `DOCKER-USER`.
- Правила по мосту `br-mailcow` вместо внешнего интерфейса (`--ext-if` убран); 587/993 — сброс соединения.
- `setup.sh` перечисляет чужие правила `DOCKER-USER` на почтовых портах; runbook — убрать их и не сохранять
  правила скриптов через `netfilter-persistent`.
- Смена версии списка — слово `eop_ranges_version_changed` в пинге.
- Мелкое: адреса панели не шире /24 и /48, диапазоны EOP не шире /8 и /24 (в скрипте и в панели);
  `mailcow.conf` в выводе — только свои ключи; отметка неудавшегося перезапуска; файлы — через временный
  файл и переименование (и в `extra-cf.sh`); `apt-get update` перед установкой; ошибки `systemctl` видны;
  изменённый таймер перезапускается; сохранённый список проверяется перед `--restore`, пишется через
  временный файл, наборы сверяются с ним; IPv6 без IPv6-диапазонов не вызывает запрос каждый час; ужесточение
  юнитов; `MAILTO=""` в cron; ручной вариант в runbook — `RETURN`, а не `ACCEPT`, и про `firewalld`.
- R-12: чужой записи диапазона с `keep_spam` фильтр включается (запись остаётся чужой); записи с `keep_spam`,
  пересекающиеся с диапазонами, — ошибка пункта; упавший на середине пункт несёт добавленное в итоге и в
  журнале (пробел первой версии закрыт); удаление проверяется чтением; правило, которое не прочиталось, —
  `prefilter_check_failed`, а не «правила нет»; сообщение после записи правила — по итогу диапазонов.
- Проверено: bats (заглушки) и настоящие `iptables`/`ip6tables`/`ipset` в одноразовом контейнере ubuntu 24.04
  с `NET_ADMIN` только у него: цепочки по мосту, `REJECT --reject-with tcp-reset`, второй прогон не меняет
  `iptables-save`, очищенная руками цепочка собрана во второй цепочке пары, после удаления всех правил,
  наборов и самой `DOCKER-USER` `--restore` вернул их по IPv4 и IPv6; `systemd-analyze verify` юнитов —
  без замечаний. Стенд, код ветки тем же способом (forwarding hosts до проверки — пусто): запись диапазона `40.92.0.0/15`, добавленная через API с `filter_spam: 0` (`keep_spam: yes`), после прогона — `changed`, `fwdhost_filter_turned_on`, в Redis `KEEP_SPAM` пуст, запись осталась чужой (не в `owned`); запись `40.0.0.0/8` с `keep_spam` — пункт `failed`, `fwdhost_keep_spam`, `keepSpam: [40.0.0.0/8]`; затем все семь записей удалены, `get/fwdhost/all` — `[]`, хэши Redis пусты, fake-EOP `accept`, очередь пуста. `rspamc` заново не прогонялся (unbound стенда по-прежнему без рекурсии).

Тесты после ревизии: backend — `npm run lint` чисто, `vitest run` 248 файлов, 3972 теста; frontend — `npm run lint` чисто, `npm test` 3945 тестов, `npm run build` собирается; bats — 177 тестов; shellcheck по всем `scripts/*.sh` — чисто.

Не сделано: панель не читает список таймера и не ходит к веб-сервису (см. выше); прогон `setup.sh` на
хосте с настоящими Docker и mailcow (стенд — Docker-in-Docker, его файрвол не трогали) — runbook, раздел 9,
пункты 5 и 6.

Тесты: backend — `npm run lint` чисто, `vitest run` 245 файлов, 3924 теста; frontend — `npm run lint`
чисто, `npm test` 3813 тестов, `npm run build` собирается; bats — 156 тестов (из них 34 новых); shellcheck
по всем `scripts/*.sh` — чисто.

### 5.9. R-43: письма во время простоя узла (2026-10-02)

Решение владельца D-15: вариант A — наблюдать и сообщать, без промежуточного релея. Код — окна простоя
`backend/src/services/mailNode/outages.js`, трассировка `services/mailNode/traceSource.js` (интерфейс и
драйверы) и `services/mailNode/outageTrace.js` (сопоставление), крючок в задании оповещений
`nodeAlerts.js` (`outageStep`), маршруты `routes/mailNodeOutages.js` (смонтированы на `/api/mail-node`);
экраны — `MailNodeOutagesSection` (вкладка «Администрирование → Почтовый узел», под «Эксплуатацией узла»),
`MailNodeOutageNotice` (над списком писем ящика, `MessageList`), правила — `frontend/src/utils/mailNodeOutage.js`,
демо — `frontend/src/demo/outages.js`; fake-EOP — `scripts/deploy/test/fake-eop/inbound.mjs`. Порядок для
администратора — [runbook, раздел 6д](../../operations/mail-node.md). Миграция `0086_mail_node_outages.sql`:
`mail_node_outages` (окно: начало, конец, `detected`/`manual`, плановое ли, причина, что упало, свидетельства
лога, последний проход трассировки; открытое найденное окно — не больше одного) и `mail_node_outage_letters`
(строка на окно, id трассировки и получателя: отправитель, тема, когда EOP получил, статус трассировки,
исход, истёк ли срок, код и слова подробностей до 300 символов, что видно в логе узла). Настройки —
`integration_config` `mail_node_outages` (`retentionDays`, по умолчанию 30, от 1 до 90), последняя проверка —
`mail_node_outage_state`. Новые записи журнала: `mail_node.outage_opened`, `outage_closed`, `outage_added`,
`outage_changed`, `outage_deleted`; срок хранения — `mail_node.config_changed` с `settings: 'outages'`.

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| Окна | Проверка задания оповещений: `failed` — `postfix-mailcow` не `running` (имя ищется подстрокой: и `postfix-mailcow`, и `mailcowdockerized-postfix-mailcow-1`) или API mailcow не ответил вовсе (`mail_node_unreachable`) — этот сигнал считается только со второй неудачной проверки подряд; `good` — контейнеры прочитаны, Postfix работает; `unknown` (ключ отклонён, ошибка API, Postfix нет в ответе) окно не открывает и не закрывает и прерывает серию неудачных. Окно открывается с началом в последней `good`, закрывается на первой `good`; без прежней `good` или после перерыва в проверках больше 15 минут (не работала панель) начало помечено «неточно»; новое окно не начинается раньше конца предыдущего найденного (его мог закрыть администратор, пока узел не работал); окно, которое задание закрыло меньше 15 минут назад, открывается снова (цикл перезапусков; в журнале `outage_opened` с `reopened`). Открытое окно без неудачной проверки 30 минут — «зависшее»: трассировка смотрит только до последней неудачной проверки, экран просит закрыть его. Свидетельства лога (сеанс `postfix/smtpd ... client=` на порту 25 — только от EOP): последний до окна, первый после, сколько во время; пишутся, пока окно открыто и 25 часов после; лог, который начинается позже прежнего (прокрутился), найденное раньше не стирает | Порт 25 не проверяется (открыт только EOP). Остановленный Dovecot окна не открывает: Postfix принимает письма и держит их в очереди узла (оповещения очереди и контейнеров). Тишина в логе окно не открывает: на тихом узле это ложные тревоги. Ошибка этого шага пишется в лог панели и не трогает остальные оповещения |
| Вручную | «Отметить период» (начало, конец или пусто — пока длится, причина обязательна, «плановое»), «Изменить» (причина обязательна, смена времени сбрасывает трассировку окна), «Закрыть», «Удалить» (подтверждение и причина); журнал с временами и причиной | Окно можно отметить на месяц вперёд (плановое обслуживание); трассировка берёт его, когда оно началось |
| Трассировка | Интерфейс `list({ start, end, recipientDomains, statuses, maxRequests }) → { rows, requests, complete }` и `details(row) → { events, requests }` в формах Graph. Драйверы: Graph-образный HTTP (`$filter` по `receivedDateTime` с обеими границами, `$top`, `@odata.nextLink` только на тот же хост, части по 10 суток, не старше 90; без токена — только для стенда через `MAIL_NODE_TRACE_URL`), фикстуры (тесты, демо). Без настроенной трассировки экран пишет «не подключена» и показывает окна | Драйвер тенанта — этап 7 (R-22, R-30): ему остаётся дать токен (сертификат приложения) или подставить `Get-MessageTraceV2` через `ExoRunner` за тем же интерфейсом. `$filter` Graph не умеет домен получателя, поэтому один запрос по времени на окно, а домены узла отбираются на стороне панели (вместо «запрос на домен» — меньше запросов) |
| Сопоставление | Окно ±1 час; проход раз в 15 минут, пока окно открыто и 25 часов после закрытия, и ещё через 20 и 35 минут после закрытия. Проход идёт после пинга задания оповещений и его не ждёт (своя очередь в один проход, срок 4 минуты); панель держит «ведро» в 80 запросов на 5 минут (Graph даёт 100, остаток — R-30), проход берёт не больше 40. Список страницами по 5000; не дочитанный список сохраняет курсор (`@odata.nextLink` и часть диапазона), и следующий проход продолжает с него, а окно остаётся «к проверке», пока не дочитано. Подробности — только для письма, нового в хранилище или со сменившимся статусом (ждущее — ещё раз не чаще чем через 2 часа, окончательный отказ — один раз); без подробностей берётся сохранённое (истёк ли срок). Исходы: `pending` → ждёт (срок — получено + 24 часа); `failed` → потеряно, если истёк срок (`4.4.7`/`QUEUE.Expired` в `Fail`, не внутри адреса вроде `10.4.4.7`) или письмо ждало (в подробностях есть `Defer`), иначе во время окна — «другое»; отказ в часе вокруг окна без истечения скрыт; `delivered` → по логу узла (`cleanup message-id=` очереди с `smtpd client=`): пришло позже 10 минут после приёма EOP — задержано, раньше — скрытая отметка «не затронуто», которая потом не превращается в задержку; лог письма не покрывает или не прочитан — сохранённое остаётся (и исход, и отметка лога: `seen` назад не меняется), а нового письма во время окна без прочитанного лога не заводится; в часе вокруг окна — только если письмо раньше ждало или уже задержано. `quarantined`/`filteredAsSpam` во время окна → «другое» (только администратору); `gettingStatus`, `expanded` — до следующего прохода. «Проверить трассировку сейчас» — не чаще раза в две минуты (429 `trace_cooldown`). Смена времени окна удаляет его письма вне нового окна ±1 час. Число ждущих несёт время прохода (`asOf`). Строки старше срока хранения удаляются каждым проходом; `data` (XML) не хранится | Событие и слова подробностей сравниваются без учёта регистра (Learn пишет `Receive`/`Deliver`, командлеты — `RECEIVE`/`FAIL`); точные строки для истёкшего письма и порог «вовремя» (10 минут) — эксперимент 20. Окно, которое открыто, когда лог уже не покрывает его начало (занятой узел, первый проход поздно), может назвать задержанным письмо, пришедшее вовремя |
| Кто что видит | Любой вошедший — письма ящиков панели (ящики общие, `services/mailAccess.js`) по адресу входа ящика (индекс по `lower(email_address)`): задержанные, ждущие, потерянные, с отправителем, темой, временем и тем, истёк ли срок, без статуса трассировки, кодов, слов EOP и лога; не больше 500 новых (`truncated`); у письма постоянный ключ (id трассировки и получатель); без подключённой трассировки ждущие не показываются ни пользователям, ни в баннере. Администратор — окна, все письма окна (и получателей без ящика в панели, и «другое»), коды, слова EOP и лог | Псевдонимы панели для сопоставления не используются (их может добавить любой, R-17) |
| Оповещение | `outage_letters_waiting` (источник `trace`, `warning`): сколько писем ещё ждёт и когда EOP вернёт первое; в теле пинга Healthchecks, `/fail` не вызывает; в журнал — появление и снятие с числом и временем, без адресов и тем | Пока API узла не отвечает, задание пинга не шлёт вовсе (как раньше), поэтому пометка видна в Healthchecks только после того, как узел ответил; ошибка трассировки оставляет оповещение прежним |
| Экраны | Администратор: баннер (`role="alert"`) с числом ждущих, временем до первого возврата и «не нажимать Fix now», окна с тем, как найдены, причиной, свидетельствами и счётчиками, письма окна, формы, «Проверить трассировку сейчас», срок хранения. Сотрудник: заметка над списком писем ящика (во «Всех входящих» — всех ящиков, с адресом), свёрнута в одну строку, список по кнопке (`aria-expanded`), «Понятно» скрывает её в этом браузере до нового письма. en/ru, демо: прошлый простой на 26 часов (два задержанных, одно истёкшее, одно в карантине EOP), текущий с двумя ждущими, плановое обслуживание без писем | — |
| fake-EOP | Очередь входящей почты: `eop inbound send` ставит письмо «из интернета» ящику узла, процесс `serve` раз в 10 с смотрит очередь и пытается отдать его `postfix-mailcow:25` каждые `retrySeconds` (15 минут, для тестов меньше); пока узел не отвечает — `Defer` с `450 4.4.312`/`4.4.315`/`4.4.316`/`4.4.317`/`4.4.318` или ответом узла `4xx`; после `expirySeconds` (24 часа, у письма — `--expire-seconds`) — `Fail` с `550 4.4.7 QUEUE.Expired; message expired` и отбивка отправителю в `ndr/`; `5xx` узла — `Fail` сразу. Трассировка в формах Graph на порту 8080 и `eop trace` | Отбивки никуда не уходят (отправители «в интернете»). Остановленный контейнер пропадает из DNS Docker, поэтому на стенде видно `4.4.312`, а не `4.4.316`, как у настоящего EOP при живом DNS узла |

Проверено на стенде (2026-10-02 по UTC; код ветки в одноразовом контейнере образа backend стенда
`sha-9bef5483377f` на сети `stage_mailexpert` и сети mailcow, окружение `stage-backend` с временной базой
`r43check` (все 85 миграций того времени, эта была `0085`), из базы панели прочитана только строка настроек узла; fake-EOP ветки — `eop up`,
`eop inbound config --retry-seconds 660`; тестовый ящик `r43-outage@stage.test` заведён и удалён):
- 12:22:40 проверка — `good`; 12:22:53 `docker compose stop postfix-mailcow`; 12:22:59-12:23:01 три письма
  `eop inbound send` на тестовый ящик (одно с `--expire-seconds 150`);
- 12:23:10 проверка — `failed` (`postfix-mailcow` `exited`): окно открыто с началом 12:22:40 (последняя `good`),
  оповещения `containers` (error) и `outage_letters_waiting` (warning, 3 письма, первое вернётся 2026-10-03
  12:22:59); проход трассировки — 3 ждут, 4 запроса;
- журнал fake-EOP: 12:23:11-12:23:21 `event=defer attempt=1 reply="450 4.4.312 DNS query failed [Message=EAI_AGAIN]"`
  по каждому письму; 12:25:36 `event=fail reply="550 4.4.7 QUEUE.Expired; message expired" ndr_to=<...>`;
  отбивка: `Status: 4.4.7`, `Diagnostic-Code: smtp;550 4.4.7 QUEUE.Expired; message expired`, тема
  `Undeliverable: ...`;
- проход трассировки 12:26:00 — 2 ждут, 1 потеряно (`expired`, `4.4.7`);
- 12:26:11 `start postfix-mailcow`, 12:26:21 проверка — `good`: окно закрыто (3 мин 41 с), журнал —
  `outage_opened`, `outage_closed`, `alert_raised`/`alert_cleared` для `containers`;
- 12:34:06 fake-EOP повторил (вторая попытка через 11 минут) — `250 2.0.0 Ok: queued as ...` по двум письмам;
  свидетельства окна — первый сеанс после окна 12:34:06;
- проход трассировки 12:34:31 (2 запроса: список и подробности потерянного) — 2 задержано (`nodeLog: seen`,
  по логу узла пришли в 12:34:06, через 11 минут после приёма EOP), 1 потеряно, 0 ждут; список сотрудника —
  все три письма ящика;
- в конце: ящик удалён, очередь и отбивки fake-EOP очищены, `retrySeconds` и `expirySeconds` возвращены к
  900 и 86400, режим `accept`, очередь Postfix пуста, все контейнеры mailcow `running`, временная база и
  копия кода и окружения ветки удалены, файлы fake-EOP стенда возвращены к версии `main` (очередь входящей
  почты появится на стенде после слияния и `eop up`).

Не проверено на стенде: экраны (тесты рендера и демо, демо просмотрено в браузере), Graph-драйвер с
токеном и настоящая трассировка (этап 7, эксперименты 19-21), окно по недоступному API (проверено тестом:
недоступный API — `failed`, как и упавший контейнер).

Тесты: backend — `npm run lint` чисто, `vitest run` 248 файлов, 3944 теста; frontend — `npm run lint`
чисто, `npm test` 3947 тестов, `npm run build` собирается; fake-EOP — `node --test eop.test.mjs` 38 тестов.

Ревизия PR (2026-10-03, после слияния `main`; миграция переименована в `0086_mail_node_outages.sql`):
исходы «липкие» (скрытая отметка «не затронуто», лог, видящий меньше, сохранённое не меняет, без лога
задержка не заводится), проход трассировки — после пинга и без ожидания, ведро запросов, курсор
недочитанного списка, подробности только для нового и изменившегося, пауза у ручного прохода, доп. проходы
после закрытия и `asOf`, «потеряно» только для истёкшего или ждавшего; обнаружение — API со второй неудачи,
без Dovecot, повторное открытие, окно не раньше конца предыдущего, «зависшее» окно; смена времени окна
удаляет письма вне его; пользователям — без статусов и кодов, постоянный ключ, не больше 500, ждущие —
только при подключённой трассировке; `MAIL_NODE_TRACE_URL` в production — только с
`MAIL_NODE_TRACE_STAND=1`, без перенаправлений, ответ до 16 МБ; свидетельства лога не стираются прокруткой;
формы множественного числа; в заметке ящика живая область — только строка итога, опрос раз в 5 минут.
fake-EOP: состояние по каждому получателю (отказ одного не держит других, трассировка — статус и события
получателя), письмо, принятое узлом, не считается отложенным при обрыве после `250` (повтора не будет),
`inbound retry`/`clear` и проход `serve` пишут под блокировкой очереди. Проверено тестами: backend — 251
файл, 4000 тестов; frontend — 4084 теста, сборка; fake-EOP — 41 тест. На стенде заново не прогонялось.

### 5.10. Этап 6: имена отправителя ящика узла, R-34 (2026-10-03)

Решение владельца D-16: ящик узла отправляет только со своего адреса; несколько имён отправителя с тем же
адресом — да, другой адрес — отдельный ящик. Части R-04, R-32 и R-33 без тенанта были сделаны раньше
(#127, #128, #129, раздел 5.2), поэтому этап 6 — это R-34. Код — `backend/src/utils/senderNames.js`
(`isForeignNodeAliasAddress`, `normalizeAddress`, `fromHeaderAddress`), `routes/accounts.js` (алиасы),
`routes/send.js` (выбор From), `services/sendQueue.js` (задание отправки), `services/mailNode/mailcow.js`
(`provisionMailbox`: `address_is_node_alias`); экраны — редактор алиасов в `AdminPanel.jsx`,
`MailNodeForeignAliases` (вкладка «Администрирование → Почтовый узел», под «Почтовым узлом»), начальные значения в
`DomainMailboxAddForm`, поле «От» в `ComposeModal`; правила — `frontend/src/utils/mailNode.js`,
`replyAlias.js`, `scheduledSend.js`; демо — `frontend/src/demo/index.js`. Порядок для администратора —
[runbook, раздел 1](../../operations/mail-node.md). Миграций и новых записей журнала нет. В интерфейсе
алиас панели (`account_aliases`) — «алиас», псевдоним mailcow — «псевдоним».

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| Сохранение | `POST`/`PUT /api/accounts/:id/aliases` для ящика узла (`mail_node = true`) сравнивают адрес алиаса с адресом ящика: без регистра, пробелов по краям, домен — в ASCII (`domainToASCII`, как у ящиков узла, которые бывают только в ASCII); другой — 400 `node_alias_address_mismatch` до записи и без хука `onAccountIdentityChanged`. Записывается адрес ящика из его строки, а не из запроса. Имя, Reply-To и подпись меняются как раньше, удаление — тоже. Gmail и IMAP — без изменений | Поля ящика читаются тем же запросом, что проверяет ящик и алиас (лишнего обращения к базе нет). Строки с `mail_node` `null` (старые) считаются не узлом |
| Отправка | Алиас с другим адресом у ящика узла — 400 `node_alias_stale` до сборки письма и постановки в очередь; окно compose показывает перевод. Задание отправки (`handleSendJob`) после чтения ящика сверяет адрес From сохранённого письма и отклоняет такое письмо тем же кодом (`fail`) до SMTP: письмо, поставленное до этой версии или до того, как ящик стал ящиком узла, отложенное, «Отправить снова», перенос времени. У такого отказа в списке отложенных нет «Отправить снова», только «Изменить» и «Удалить» | Отказ на сервере — главная защита (compose, открытый заново черновик, вызов API, очередь); кроме него автовыбор алиаса в ответе (`pickReplyAlias`) для ящика узла алиасы с другим адресом не выбирает, а в поле «От» они недоступны с пометкой. Черновик (`draft.js`) может хранить старый From: сохраняется он как раньше, отправка его отклоняет |
| Старые алиасы | Раздел «Алиасы с другим адресом» (администратор): адрес, имя, ящик; «Создать отдельный ящик» открывает обычную форму создания ящика с локальной частью, доменом и именем алиаса (с «Отменой»); после создания алиас удаляется (404 — уже удалён — тоже успех), его подпись становится подписью нового ящика, а Reply-To — алиасом нового ящика с тем же именем и адресом; «Удалить» — с подтверждением. Если ящик с этим адресом уже есть в панели, строка говорит об этом и предлагает только «Удалить». Само ничего не создаётся | Список строится из уже загруженного списка ящиков (`GET /api/accounts` отдаёт алиасы), отдельного API нет; без таких алиасов раздел не показывается. Домен адреса, в котором узел не создаёт ящики, в форме не выбирается, и форма говорит почему: домен узла ещё не готов или это не домен узла (внешний, вроде gmail.com). Алиас панели с другим адресом работал на отправку, только если администратор завёл в mailcow псевдоним `<адрес> → <ящик>` с правом отправки; тогда `add/mailbox` отвечает `is_alias`, и панель возвращает 409 `address_is_node_alias` («удалите псевдоним в mailcow»). После удаления псевдонима почта на адрес идёт в новый ящик, а не в прежний — форма и runbook об этом предупреждают. Если ящик создан, а алиас удалить не удалось, строка остаётся с сообщением; не перенесённые подпись или Reply-To тоже называются |
| Редактор алиасов | У ящика узла поле адреса закреплено за адресом ящика (`readOnly`, подсказка через `aria-describedby`: другой адрес — отдельный ящик), кнопка «Добавить имя отправителя», своё описание. Старый алиас с другим адресом помечен, у него нет «Изменить» (только «Удалить»), пометка ведёт администратора к списку на вкладке «Почтовый узел». Подписи полей связаны с полями: `htmlFor` у имени, адреса и Reply-To, у подписи (contenteditable) — `aria-labelledby` | Старый алиас из редактора не переписывается: превратить его в ящик или удалить — в разделе администратора |
| Демо | Тот же отказ при сохранении и отправке, адрес ящика при записи, `PUT` без имени или адреса — 400, как на сервере; у ящика `sales@example.com` демо — старый алиас `orders@example.com` для раздела администратора | — |

Проверено тестами: backend — `npm run lint` чисто, `vitest run` 255 файлов, 4082 теста (новые и
изменённые: `accounts.aliases.test.js`, `send.nodeAlias.test.js`, `send.queue.pglite.test.js`,
`senderNames.test.js`, `mailcow.test.js`); frontend — `npm run lint` чисто, `npm test` 4227 тестов
(`MailNodeForeignAliases.render.test.js`, `mailNode.test.js`, `replyAlias.test.js`, `scheduledSend.test.js`,
`demo/index.test.js`, `demo/routeCoverage.test.js`), `npm run build` собирается. На стенде не проверялось:
отправка с чужого адреса больше не предусмотрена; ответ mailcow `is_alias` на `add/mailbox` взят из кода
mailcow (`functions.mailbox.inc.php`) и проверен тестом с подменённым ответом.

### 5.11. Этап 7a: драйвер тенанта (2026-10-03)

Фундамент этапа 7: панель умеет обращаться к тенанту, но только читает. Код — `backend/src/services/tenant/`
(`driver.js` — `TenantDriver` и выбор по окружению, `exoRunner.js`, `graphClient.js`, `fakes.js` с
`fixtures.json`, `tenantJobs.js`, `antispam.js`), `routes/mailNodeTenant.js`, источник `tenant` в
`services/mailNode/nodeAlerts.js`; исполнитель — `deploy/tenant-worker/` (`server.mjs`, `ops.mjs`,
`runner.ps1`, `cert.ps1`, `Dockerfile`); экран — `MailNodeTenant` внутри «EOP»; демо — `frontend/src/demo/tenant.js`.
Порядок для владельца — [runbook, раздел 6е](../../operations/mail-node.md). Миграций нет.

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| `TenantDriver` (R-22) | `driver.forTenant(tenant)` → `{ exo.run(op, args), graph.request/getToken }` и `driver.certificate()`. Выбор: `TENANT_WORKER_URL` + `TENANT_WORKER_TOKEN` (32+ символов) — исполнитель; `TENANT_DRIVER=fake` — записанные ответы (в production только с `TENANT_DRIVER_STAND=1`, как `MAIL_NODE_TRACE_URL`); иначе драйвера нет, и всё как раньше | Тенант — четыре поля настроек EOP: к трём прежним добавлен домен тенанта `<TENANT>.onmicrosoft.com` (`-Organization`). `tenantDriverActive()` остаётся `false`: онбординг доменов драйвер возьмёт на этапе 7b, до него чек-лист ручной. Этап 7c подаст `graph.getToken` в `createGraphTraceSource` (R-43) или добавит `Get-MessageTraceV2` в белый список |
| `GraphClient` | client credentials с ассерцией сертификата (RS256, `x5t` и `x5t#S256`, `aud` — v2.0 token endpoint тенанта, 10 минут); кэш токена до 5 минут до конца (короткий токен — до половины срока), один запрос токена на всех; 401 — один новый токен и один повтор; 429 — ожидание по `Retry-After` (или 1, 2, 4 с), до трёх повторов, 503/504 — так же, но только для GET (запись этапа 7b после 503 сама не повторяется: она могла примениться), потом `graph_throttled` с `retryAfterMs` в результате задания — задания тенанта сами не повторяются, повторит следующий опрос или кнопка; токен не уходит на другой хост; не больше 4 запросов одновременно. Адреса Graph и login задаются (`TENANT_GRAPH_URL`, `TENANT_LOGIN_URL`) для тестов и стенда; в production — только с `TENANT_DRIVER_STAND=1` | Ассерцию подписывает исполнитель (`POST /assertion`, утверждения строит он сам), потому что ключ есть только у него (R-35). Отказ токена показывает OAuth-ошибку и код `AADSTS`, не ассерцию |
| `ExoRunner` и `tenant-worker` (R-22, R-36, R-38) | Node-сервер перед одним долгоживущим процессом pwsh (`runner.ps1` и `runner.lib.ps1`, NDJSON по stdin/stdout; ответ командлета — всегда JSON-массив, и для одного, и для нуля элементов, панель сверх того принимает и одиночный объект; pwsh получает окружение без токена панели; `TENANT_ID`/`TENANT_APP_ID`/`TENANT_ORGANIZATION` у исполнителя ограничивают, для какого тенанта он подписывает ассерции и выполняет операции): общий секрет (`Authorization: Bearer`, сравнение постоянного времени), белый список `whoami` (`Get-OrganizationConfig`), `get_blocked_connector`, `get_content_filter_policy` (`-Identity Default`), `get_accepted_domain` (`-Identity <DOMAIN>`, заготовка для R-24); значения — правила `parseHostName`/`parseLocalPart`; `Connect-ExchangeOnline -AppId -Organization -CertificateFilePath -CertificatePassword -CommandName <белый список> -SkipLoadingFormatData`, сеанс один, переподключение при смене тенанта и один раз при ошибке сеанса; одна операция за раз, очередь до 20 (`busy`), таймаут 120 с убивает pwsh, следующий вызов поднимает новый; `TENANT_WORKER_DRY_RUN=1` печатает команды (пароль — `<redacted>`). Панель держит у себя мьютекс: одна операция EXO за раз на процесс | Node, а не HTTP-сервер на самом pwsh: зависший командлет в своём runspace не прервать, а `HttpListener` на это время перестаёт отвечать и на `/health`; Node убивает и перезапускает pwsh, а белый список проверяется и тестируется без pwsh. Цена — ~100 МБ бинарника Node в образе. Образ: `mcr.microsoft.com/powershell:7.5-ubuntu-24.04` по digest, модуль 3.9.2 (3.10.x требует 7.6, образа 7.6 на MCR нет), только amd64, 202 МБ сжатым / 759 МБ на диске; пользователь uid 10001, корень только для чтения, `HOME=/tmp` (tmpfs) |
| Очередь вместо `tenant_jobs` | виды `tenant_test_connection`, `tenant_poll`, `tenant_antispam_read` в `jobs` ([job-queue.md](../job-queue.md), «Задания тенанта»); результат — в `integration_config` `mail_node_tenant_state` вместе с завершением задания | Отклонение от R-22: вторая таблица повторила бы захват, аренду и повторы. `max_attempts` 1 — опрос повторит следующий слот |
| «Проверить подключение» | три шага: сертификат исполнителя = отпечаток в настройках; токен Graph и `GET /domains` (начальный домен = домен тенанта; `/domains` — потому что `Domain.ReadWrite.All` есть, а `Organization.Read.All` нет); EXO `whoami`. Каждый шаг — свой код отказа; журнал `tenant.connection_tested` (успех или список упавших шагов) | Кнопка, нажатая во время проверки, возвращает то же задание |
| Сертификат (R-35, R-18) | отпечаток, субъект, срок — от исполнителя (`GET /certificate`), в настройках не вводится; оповещение `tenant_certificate`: предупреждение меньше 30 дней, ошибка меньше 14 и после истечения | Ошибка (а не предупреждение, как у сертификата узла за 14 дней) — потому что с истёкшим сертификатом панель теряет тенант целиком |
| R-27 | `tenant_poll` раз в 10 минут (таймер ставит задание со слотом в `dedupe_key` и пропускает слот, если опрос стоит в очереди или закончился меньше 5 минут назад, например по «Проверить сейчас»; первый — через минуту после старта), «Проверить сейчас»; оповещение `connector_blocked_tenant` (ошибка, ping `/fail`). Неудачный опрос хранит прежний список с ошибкой и счётчиком неудач подряд; опрос с ошибкой или старше 30 минут оставляет оповещение о коннекторе прежним. После трёх неудач подряд или 30 минут без опроса — предупреждение `tenant_poll_failing`. Проблемы тенанта никогда не задерживают ping узла (только перечисляются в его теле) | Снятия блокировки нет (решение этапа): только процедура в интерфейсе. Без почтового узла проверка оповещений не идёт вовсе (как раньше), поэтому и оповещений тенанта нет |
| R-28 | просмотр `SpamAction`, `HighConfidenceSpamAction`, `BulkSpamAction`, `PhishSpamAction`, `HighConfidencePhishAction`; ожидается `MoveToJmf`/`AddXHeader`, для явного фишинга — `Quarantine` (D-2); `Quarantine` для остальных — предупреждение «сотрудники не увидят», `Delete` — ошибка, `Redirect` — предупреждение, `ModifySubject` — пометка. Читается при удачной проверке подключения, раз в 6 часов опросом и по кнопке | Значения политики Default в фикстуре (обычный фишинг — `Quarantine`) взяты по Learn; что действует в тенанте — эксперимент 11 |
| Демо | фейковый тенант подключён: проверка, опрос и политика завершаются сразу, сертификат истекает через 25 дней (предупреждение и оповещение), политика с одним расхождением; другой отпечаток — отказ на первом шаге | — |

Проверено: backend — `npm run lint` и `lint:plugins` чисто, `node --check src/index.js`, `vitest run` 260
файлов, 4149 тестов (новые: `services/tenant/*.test.js`, `tenantJobs.pglite.test.js` с маршрутами на
PGlite, тенант в `nodeAlerts.test.js`); frontend — `npm run lint` чисто, `npm test` 4327 тестов
(`MailNodeTenant.render.test.js`, `mailNodeTenant.test.js`, демо и покрытие маршрутов), `npm run build`;
исполнитель — `node --test deploy/tenant-worker/worker.test.mjs` 17 тестов (на Windows с pwsh 7.6 —
16, тест импорта модуля пропущен) и те же 17 внутри собранного образа, в том числе с корнем только для
чтения: отказ старта без PFX и с неверным паролем (пароль в лог не попадает), напечатанные команды каждой
операции, R-36 до pwsh и в `runner.ps1` (и значение с переводом строки в конце), ответы `runner.lib.ps1`
с заглушками командлетов на 0, 1 и 2 элемента (всегда массив) и переподключение только при ошибке
сеанса, токен панели не попадает в окружение pwsh, закреплённый тенант, EPIPE умершего pwsh и
заменённый процесс, импорт модуля под пользователем исполнителя. На стенде
`me-stage` не запускалось: образ проверен локально. Живой тенант — только раздел 6, ниже.

Что подтверждает только живой тенант (раздел 6): ассерция с `x5t#S256` и выдача токена; `Connect-ExchangeOnline`
с PFX из файла на Linux в образе; набор прав (`Get-OrganizationConfig`, `Get-BlockedConnector`,
`Get-HostedContentFilterPolicy`, `Get-AcceptedDomain` под Exchange Administrator, затем под своей группой
ролей — эксперимент 16); форма ответа `Get-BlockedConnector` (свойства в фикстуре — **Inferred**,
эксперимент 14); фактическая политика Default (эксперимент 11); поведение сеанса за часы работы (срок токена
EXO, переподключение после ошибки).

### 5.12. Этап 7b: домены в тенанте и зеркало DBEB (2026-10-03)

Драйвер тенанта сам проводит домен через шаги тенанта и держит зеркало получателей. Код —
`backend/src/services/tenant/tenantDomains.js` (задание домена, `planMirror`, шаг удаления),
`connectors.js` (эталон и сверка коннекторов), `fakes.js` (`createFakeTenantModel` — фейковый тенант с
состоянием), `tenantJobs.js` (опрос читает коннекторы), `routes/mailNodeTenant.js`; исполнитель —
`deploy/tenant-worker/` (`ops.mjs`, `runner.lib.ps1`); экраны — `MailNodeDomainTenant` в подробностях
домена, блок «Коннекторы» в `MailNodeTenant`, два поля настроек EOP, строка «Ждёт тенант» у ящика; демо —
`frontend/src/demo/tenant.js`. Миграция `0088_tenant_domains.sql`: `mail_node_domains.tenant_sync` (что
увидел и сделал последний прогон) и `email_accounts.tenant_recipient_at` (когда зеркало видело получателя
ящика), `hold_internal_relay` (удержание на Internal Relay, по умолчанию включено),
`internal_relay_approved_at` (разрешение перевести в Internal Relay домен, который тенант уже держал как
Authoritative) и `sync_lock_job`/`sync_locked_at` (какой прогон держит домен). Порядок для владельца —
[runbook, раздел 6е](../../operations/mail-node.md).

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| Задание домена | вид `tenant_domain_sync` в общей очереди, один на домен: сверяет, а не выполняет список шагов — сначала читает Graph и EXO, пишет только недостающее, состояние домена сдвигает только после чтения, подтвердившего шаг (`mail_node.domain_state_changed` с `how: tenant_driver`, автор MailExpert, в `steps` пометка `tenantDriver`). Ставится при добавлении, принятии и перезапуске домена, после «Сделано» и «Готов», после создания ящика в домене с зеркалом, кнопкой «Выполнить шаги тенанта сейчас» и таймером опроса (каждый слот 10 минут для незаконченных доменов, раз в час для `authoritative` с готовым DKIM). Одновременно идёт один прогон домена: прогон берёт строку домена атомарным `UPDATE … sync_lock_job` (захват старше 30 минут — от умершего прогона); второй прогон заканчивается без траты попытки и ставит новое задание через 30 с. Повтор записи, которая уже применилась (503 Graph, повтор исполнителя после переподключения), безвреден: «уже есть» и «не найден» у записи считаются выполненными | `max_attempts` 6. Троттлинг (`exo_throttled`, `graph_throttled`) сохраняет сделанное и ставит задание снова через `Retry-After` или 1, 2, 4 … минут; прочие ошибки остаются в `tenant_sync` с кодом, повторит следующий слот. Прогон пишет итог, только если состояние домена не изменилось за время прогона (перезапуск онбординга во время прогона подхватит следующий) |
| R-23 | `POST /domains` с любого состояния (TXT верификации нужен владельцу домена сразу; `verificationDnsRecords` → `tenant.verificationTxt`, источник `tenant`); после шага «DNS опубликованы» (`dns_ok`, его по-прежнему подтверждает человек; MX на нём может ещё смотреть на прежний хост — значение MX даёт только подтверждённый домен, а сменить его можно только после Internal Relay, R-24) — `POST /verify`, `PATCH supportedServices` с `Email`, MX из `serviceConfigurationRecords` (обе формы, по `preference`) → `expected_mx`; `dns_ok` → `tenant_verified`. Отказ `verify` (400) — не ошибка: «Microsoft пока не видит TXT», следующий прогон пробует снова | Ответ Graph на уже добавленный домен (400/409) и текст отказа `verify` — **Inferred**; панель после отказа `POST` читает домен, а не полагается на текст. Значения, введённые руками, заменяются прочитанными из тенанта (источник `tenant`), и «Начать заново» их очищает |
| R-24 | опрос `Get-AcceptedDomain`, пока тенант не покажет домен: повторные задания через 1, 2, 4 … до 10 минут; затем `Set-AcceptedDomain -DomainType InternalRelay` и чтение типа; `tenant_verified` → `internal_relay`. Пока домен не `authoritative`, каждый прогон возвращает тип в Internal Relay, если он другой (тип по умолчанию у домена, добавленного драйвером, правка руками). Тип держится по фактам тенанта, а не только по состоянию панели: подтверждённый в тенанте домен остаётся на Internal Relay и после «Начать заново». Домен, который тенант уже держал как Authoritative до того, как драйвер его нашёл (`graph.preexisting`), драйвер не трогает: код `authoritative_in_tenant`, предупреждение `tenant_domain_authoritative`, остальные шаги домена ждут, пока администратор не нажмёт «Перевести в Internal Relay» (с подтверждением, `tenant.internal_relay_approved`). «Начать заново» домена, который был в тенанте, это разрешение даёт само и тип accepted domain не стирает | Задержка и тип по умолчанию — эксперимент 6 |
| R-25 | Outbound connector — указанный в настройках EOP (`outboundConnector`, имя из EAC) или единственный включённый OnPremises; иначе `outbound_connector_missing`/`_ambiguous`/`_not_found` с именами. Домена нет в `RecipientDomains` — `Set-OutboundConnector -RecipientDomains @{Add=<DOMAIN>}`, чтение; `internal_relay` → `connector_ready`. `AllAcceptedDomains $true` считается покрытием. Эталон: первое удачное чтение обоих коннекторов (опрос раз в 10 минут), «Принять как эталон» после намеренной правки (`tenant.connector_reference_taken`); сверка ключевых свойств (Inbound: `ConnectorType`, `TlsSenderCertificateName`, `RequireTls`, `RestrictDomainsToCertificate`, `SenderDomains`, … ; Outbound: `SmartHosts`, `TlsSettings`, `TlsDomain`, `UseMXRecord`, …) — на экране и оповещением `tenant_connector_drift` (предупреждение) | `Validate-OutboundConnector` и `-IsValidated` не сделаны: проверка шлёт письмо и ничего не меняет в пути почты — оставлено эксперименту 7. `RecipientDomains` не сравниваются с эталоном: задание домена само возвращает пропавший домен. Исполнителю коннектор передаётся по `Guid` (имя из EAC может содержать любые символы; имя в настройках только сравнивается в панели). Шаг `ready` остаётся за человеком: владелец сначала переключает MX |
| R-26 | только если подписывает EOP (режим DKIM домена или настроек `eop`, D-1): `New-DkimSigningConfig -Enabled $false -KeySize 2048` (если нет), `Get-DkimSigningConfig` → CNAME селекторов в `tenant` (их сверяет проверка DNS), затем `Set-DkimSigningConfig -Enabled $true` на каждом прогоне до успеха; ожидание CNAME — не ошибка (показывается причина) | Ротации (`Rotate-DkimSigningConfig`) нет. Формат CNAME в фикстуре и текст отказа до публикации — **Inferred** (эксперимент 9) |
| R-29 | зеркало в `internal_relay` и дальше: желаемое — адреса, на которые узел принимает почту (ящики mailcow с `active` 1 и 2, активные псевдонимы кроме catch-all; псевдонимы — до раздела 5.14), кроме ящиков, чьё удаление уже началось; фактическое — `Get-Recipient -ResultSize Unlimited` по домену. Контакт (D-5) — `New-MailContact -Name <адрес> -PrimarySmtpAddress <адрес> -ExternalEmailAddress <внешний>` и `Set-MailContact -HiddenFromAddressListsEnabled $true`; лишний контакт — `Remove-MailContact`. Не больше 25 записей EXO за прогон, остаток — следующим заданием через 2 с; запись, которая не прошла, сразу не повторяется (показана в отчёте, повторит слот опроса). Ответ «уже есть» на `New-MailContact` засчитывается только после чтения, которое показывает контакт; иначе адрес занят невидимым получателем — `address_taken`. D-7: вариант А по умолчанию, вариант Б — поле `dbebExternalDomain` (`<local>@<домен>`); контакт другого варианта меняется на месте (`Set-MailContact -ExternalEmailAddress`) и всё время принимает почту. `ready` → `authoritative` (D-4), когда свежее чтение нашло зеркало полным (нечего создавать, менять и удалять, нет активного catch-all, ответ узла не подозрителен), тенант показывает домен и Outbound connector его доставляет, и домен не удерживается на Internal Relay; затем `Set-AcceptedDomain -DomainType Authoritative` и чтение. Удержание (`hold_internal_relay`) включено по умолчанию, пока эксперимент 8 не пройдёт на живом тенанте: при полном зеркале экран говорит «все получатели есть», администратор выключает удержание («Разрешить Authoritative», `tenant.domain_hold_changed`); у `authoritative`-домена удержания нет. Домен `authoritative`, снова ставший Internal Relay руками, возвращается в Authoritative при полном зеркале, иначе — `authoritative_lost`. Отчёт «узел / панель / тенант»: нет получателя, лишние, адрес занят другим получателем тенанта (облачный ящик, группа — контакт не создаётся), на узле без панели, в панели без узла, catch-all; журнал `tenant.recipients_synced` | Узел не вернул ни одного ящика домена, хотя в панели они есть или в тенанте есть контакты домена, — удалений нет (`suspicious`). Узел не ответил — зеркало не трогается. Псевдонимы — отдельные контакты, а не proxy-адреса (D-16 отменил proxy-адреса). Уточнение к D-16 этапа 7b владелец отменил: с раздела 5.14 псевдонимы mailcow не отражаются вовсе. Адрес, занятый другим получателем тенанта, почту в тенанте принимает: такой ящик не показывает «Ждёт тенант». Пробное письмо на несуществующий адрес (`550 5.4.1`) панель не шлёт: это эксперимент 8. `Get-Recipient` читает весь тенант на каждый прогон домена — для add-on тенанта с сотнями получателей приемлемо |
| R-32, R-33 | создание ящика в домене с зеркалом ставит задание домена; ящик в `authoritative`-домене без получателя показывает «Ждёт тенант: почта на него пока отклоняется» (`tenant_pending` в `GET /api/accounts`, по `tenant_recipient_at`). Хук `BEFORE_NODE_DELETE` удаления ящика: `Remove-MailContact` до `delete/mailbox`, контакта нет — тоже удалён; домен определяется и по состоянию, и по типу accepted domain в тенанте (после «Начать заново» хук продолжает работать). В `authoritative`-домене (или Authoritative в тенанте) без драйвера или при ошибке тенанта удаление ждёт (`tenant_driver_missing`, `tenant_not_configured`, `tenant_recipient_not_removed` у строки) и повторяется как ошибка узла; в Internal Relay домене удаление идёт дальше, лишний контакт уберёт зеркало | — |
| «Сделано» и настройки | с драйвером и заполненным тенантом (`tenantDriverActive(settings)`) шаги `tenant_verified`, `internal_relay`, `connector_ready` подтверждает драйвер: «Сделано» на них — 409 `step_by_tenant_driver`, «Отметить готовым» — 409 `mark_ready_by_tenant_driver` и кнопки нет (иначе домен миновал бы Internal Relay и коннектор), в списке шагов «делает MailExpert в тенанте», чек-лист раздела «EOP» скрыт, `GET /domains` отдаёт `tenantDriverActive`. Подпись шага «DNS опубликованы» говорит, что MX переключается позже. Без драйвера всё как раньше. Новые поля настроек EOP: `outboundConnector`, `dbebExternalDomain` | — |
| Исполнитель (R-36) | белый список +13 операций, в обеих таблицах (панель и `ops.mjs`, тест держит их равными) и в `runner.lib.ps1`: `set_accepted_domain_internal_relay`/`_authoritative` (тип закреплён операцией), `get_inbound_connectors`, `get_outbound_connectors`, `add_outbound_connector_domain` (значение передаётся как `@{Add=...}`), `new_`/`get_`/`enable_dkim_signing_config`, `get_recipients`, `new_mail_contact`, `set_mail_contact_external`, `hide_mail_contact`, `remove_mail_contact` (`-Confirm:$false`). Коннектор передаётся по `Guid` (вид значения `guid`). Ошибки `exo_exists` («already exists», «already being used») и `exo_throttled` («Micro delay», «throttl», «Server Busy») | Исполнитель после ошибки сеанса повторяет и запись: повтор `New-MailContact` даёт `exo_exists`, который панель проверяет чтением. Формы ответов `Get-InboundConnector`, `Get-OutboundConnector`, `Get-Recipient` в фикстуре — **Inferred** |
| Демо | фейковый тенант: опрос читает оба коннектора (эталон — первое чтение, расхождений нет), «Принять как эталон» работает, «Выполнить шаги тенанта сейчас» завершается сразу; домены демо остаются на ручном онбординге (`tenantDriverActive: false`) | — |

Проверено (после ревью): backend — `npm run lint` и `lint:plugins` чисто, `vitest run` 262 файла, 4203
теста (новые: `tenantDomains.test.js` — `planMirror` с переводом контакта на месте, подозрительный пустой
ответ узла при контактах в тенанте, выключенный catch-all, MX, выбор коннектора, сверка;
`tenantDomains.pglite.test.js` — домен от `dns_ok` до `authoritative` на фейковом тенанте через
удержание, повторный прогон только читает, ожидание `verify` и `Get-AcceptedDomain`, домен, бывший
Authoritative до драйвера, и разрешение администратора, выбор коннектора по `Guid` с именем `[EU] & …`,
DKIM, catch-all, пустой ответ узла, пачки, отказ записи без быстрого повтора, `address_taken`, адрес
другого получателя, Authoritative без коннектора не включается, вариант Б на Authoritative-домене без
удалений, «Начать заново» Authoritative-домена, захват домена прогоном без траты попыток, 403 не
администратору, удержание, «Отметить готовым» с драйвером; изменены `exoRunner.test.js`,
`nodeAlerts.test.js`, `eopSettings.test.js`, `domains.pglite.test.js`); frontend — `npm run lint`
чисто, `npm test` 4427 тестов (`MailNodeOnboarding.render.test.js`, `MailNodeTenant.render.test.js`,
`mailNode.test.js`, `auditLog.test.js`, демо и покрытие маршрутов), `npm run build`; исполнитель —
`node --test deploy/tenant-worker/worker.test.mjs` 17 тестов (на Windows с pwsh 7.6 — 16, тест импорта
модуля пропущен): напечатанные команды каждой новой операции (закреплённые параметры, `@{Add=...}`,
коннектор по `Guid`, `Name` и `PrimarySmtpAddress` из одного адреса, `Set-MailContact
-ExternalEmailAddress`), отказ враждебных значений до pwsh и в `runner.ps1`,
`exo_exists`/`exo_throttled`/`exo_not_found` с заглушками командлетов. Образ исполнителя не
пересобирался и на стенде `me-stage` не запускалось.

Что подтверждает только живой тенант: эксперименты 6 (тип по умолчанию, задержка до
`Get-AcceptedDomain`, формат TXT), 7 (Outbound connector), 8 (DBEB: контакт, вариант А или Б, репликация,
`550 5.4.1`), 9 (DKIM EOP), 16 (роли для новых командлетов) и 23 ниже.

### 5.13. Этап 7c: трассировка и карантин EOP (2026-10-04)

Драйвер тенанта читает трассировку Microsoft (R-43 и R-30) и выпускает явный фишинг из карантина EOP
(R-42). R-31 не делается: по D-2 явный фишинг в карантине не остаётся (раздел 7.1), поэтому ручного
выпуска и Tenant Allow/Block List нет. Код — `backend/src/services/mailNode/traceSource.js`
(`tenantTraceSource`, `resolveTraceSource`), `services/tenant/messageTrace.js` (R-30),
`services/tenant/quarantineRelease.js` (R-42), `graphClient.js` (`dropToken`), `driver.js` (`graphFetch`),
`fakes.js` (трассировка и карантин фейкового тенанта), источник `tenant_quarantine` в
`services/mailNode/nodeAlerts.js`, маршруты `routes/delivery.js` (`POST /api/mail/messages/:id/eop-trace`,
`eopTrace` в ответе подробностей доставки) и `routes/mailNodeTenant.js` (`/tenant/phish-release`);
исполнитель — `deploy/tenant-worker/` (`ops.mjs`, `runner.lib.ps1`); экраны — раздел «В Microsoft» в
`DeliveryDetails` и блок «Явный фишинг в карантине EOP» в `MailNodeTenant`; демо — `frontend/src/demo/tenant.js`,
`demo/index.js`. Миграция `0089_tenant_trace_quarantine.sql`: `tenant_quarantine_releases` (строка на
письмо карантина: `Identity`, Message-ID, отправитель, тема, получатели, когда получено и когда истекает,
состояние `releasing`/`released`/`skipped`/`failed`, причина, ошибка, попытки, выпустила ли панель; строки
удаляются через 45 дней) и `message_eop_traces` (последняя трассировка письма: состояние, курсор,
получатели со статусом, кодом и словами EOP; строки удаляются через 45 дней). Новые записи журнала: `tenant.quarantine_released`,
`tenant.phish_release_changed`, `tenant.message_traced`. Порядок для администратора —
[runbook, раздел 6е](../../operations/mail-node.md).

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| R-43 через драйвер | `resolveTraceSource()`: источник теста или демо, затем `MAIL_NODE_TRACE_URL` стенда, затем драйвер тенанта с заполненным тенантом — `tenantTraceSource(driver, tenant)`: формы Graph на базе Graph драйвера (Microsoft или стенда с `TENANT_DRIVER_STAND=1`), токен из `GraphClient` драйвера (ассерция подписана исполнителем), fetch драйвера (у фейкового — фейковый Graph). Настройки EOP читаются при каждом проходе и запросе экрана, поэтому «подключена ли трассировка» следует за настройками. 401 сбрасывает кэш токена (`dropToken`), следующий проход берёт новый; 403 (нет права или роли) токен не сбрасывает. Сопоставление окон, ведро в 80 запросов, курсор и подробности — без изменений (раздел 5.9) | Graph, а не `Get-MessageTraceV2`: интерфейс уже в формах Graph. Работает ли Graph `messageTraces` в add-on тенанте с `ExchangeMessageTrace.Read.All` — эксперимент 19; если нет, `Get-MessageTraceV2` через исполнителя встаёт за тот же интерфейс. R-43 переходит на Graph тенанта, как только тенант заполнен и исполнитель есть, ещё до эксперимента 19 (решение исполнителя, без отдельного переключателя): без драйвера трассировки нет вовсе, а отказ Graph виден у окна кодом (`trace_auth` и т. п.) и ничего не ломает; `MAIL_NODE_TRACE_URL` стенда по-прежнему главнее. Свой reader трассировки (а не `GraphClient.request`): страница в 5000 строк больше предела `GraphClient` (4 МБ), а повторы `GraphClient` на 429 (до 60 с трижды) не помещаются в срок прохода. Reader, как и `GraphClient`, ходит только на HTTPS публичного адреса (Graph стенда по HTTP на частном адресе не годится ни тому, ни другому) |
| R-30 | «Спросить трассировку Microsoft» в «Подробностях доставки» отправленного письма ящика узла (любой вошедший: ящики общие). Запрос пишет строку и ставит задание `tenant_message_trace` в одной транзакции и сразу отвечает сохранённым; строка «в очереди», у которой задания уже нет (и она старше 15 минут), ставится заново. Экран перечитывает подробности раз в 3 с, пока трассировка идёт. Задание читает список трассировки по времени — от 10 минут до отправки (или до передачи в EOP по логу узла, R-17) до 2 часов после последней передачи, без передачи в логе — 6 часов после отправки; не позже «сейчас», не старше 90 дней — и оставляет строки с Message-ID письма, затем читает подробности каждого получателя (до 10): код (`5.1.1` и т. п.), слова EOP последнего отказа или задержки, время доставки. Ведро — 20 запросов на 5 минут (остаток от 100 после 80 у R-43); задание резервирует до 10 до первого запроса и возвращает неиспользованное в конце (запросы до ошибки, и сама неудачная, считаются), поэтому задания, идущие вместе, берут не больше 20. Без запросов задание заканчивается и ставит новое на момент, когда ведро наполнится (попытка не тратится); недочитанный список или подробности продолжает новое задание с курсором; 429 — резерв считается израсходованным, повтор через минуту; повторы кончились — строка `failed` с кодом. Повторный запрос о том же письме — не чаще раза в 5 минут (ответ — сохранённое, `cooldownUntil`). Строки удаляются через 45 дней после последнего изменения (таймер опроса и каждое задание). Отказы: `trace_not_sent` (не отправлено этим ящиком), `trace_not_node`, `trace_not_connected` (в том числе если трассировку не удалось определить: ошибка чтения настроек), `trace_sent_at_unknown`, `trace_too_old` | `$filter` по `messageId` в Learn не описан, поэтому запрос по времени и сверка Message-ID в панели: на занятом тенанте окно в 6 часов — несколько страниц по 5000. Подробности без `data` (XML не хранится). Сервис-принципал трассировки (`8bd644d1-…`) и задержка провижининга — эксперимент 19 |
| R-42 | задание `tenant_quarantine_release` в каждом слоте опроса (10 минут), если выпуск включён и прохода в очереди нет, и по «Выпустить сейчас». Одновременно идёт один проход: проход берёт блокировку (`integration_config` `mail_node_phish_release_run`, блокировка старше 30 минут — от умершего прохода), второй (слот и кнопка в один момент, истёкшая аренда) заканчивается сразу. Кандидаты: письма `Get-QuarantineMessage` (исполнитель закрепляет `-QuarantineTypes HighConfPhish -Direction Inbound -ReleaseStatus NotReleased -PageSize 100`, до 5 страниц), которых нет в таблице, вперемешку со строками, оставленными прошлыми проходами (самые старые первыми): `releasing`, `failed` с попытками и раз в 6 часов — исчерпавшие попытки. На письмо (не больше 25 за проход): чтение по `Identity` (получатели видны только так; ответ без письма с точно этим `Identity` — «нет письма») → проверки → выключатель читается снова (кэш 5 с) → атомарный захват строки (`releasing`, попытка +1; захват другого прохода моложе 10 минут не перехватывается) → `Release-QuarantineMessage -Identity <id> -ReleaseToAll -Confirm:$false` → `released` вместе с записью журнала в одной транзакции; запись журнала — только если строка действительно перешла в `released` (`UPDATE … WHERE state <> 'released'`), поэтому два прохода не пишут один выпуск дважды. Проверки: тип — явный фишинг (`QuarantineTypes` или `Type`), направление — входящее, все получатели на доменах узла, почта которых идёт через EOP (состояния `connector_ready`, `ready`, `authoritative`; `-ReleaseToAll` выпускает всем), статус не `Released`/`Approved`/`Denied`/в процессе (`PreparingToRelease`, `Requested` — ждёт следующего прохода). Не прошедшее проверку — `skipped` с причиной (`foreign_recipients`, `outbound`, `no_recipients`, `not_high_conf_phish`, `release_denied`, `worker_refused`) и больше не читается; выпущенное кем-то раньше — `released` без записи журнала от панели. Следующее задание через 30 с — только если остались кандидаты и проход что-то изменил | Без доменов узла в этих состояниях ничего не выпускается. Неудачное чтение по `Identity` — попытка (`failed`/`read_failed`), поэтому застрявшие письма не держат очередь: каждый проход сдвигает их к пределу, и следующие письма доходят. «Нет в карантине» — попытка (`not_found`), `skipped`/`gone` — только после второго такого чтения. Потерянный ответ исполнителя (таймаут) оставляет `releasing`: следующий проход сначала читает письмо (выпущено — отмечается с журналом, нет — выпуск ещё раз). Отказ EXO — `failed`, повтор следующим слотом; после трёх попыток — `failed`/`attempts_exhausted`, такая строка раз в 6 часов только читается: выпущено после всего — отмечается и снимается с оповещения, исчезло — `gone`. Троттлинг завершает проход с сохранённым, возвращает письму попытку и ставит задание снова через `Retry-After` или 1, 2, 4 … минут (`max_attempts` 4). «Не выпустит дважды после потерянного ответа» держится на двух **Inferred** допущениях (эксперимент 24): EOP показывает письмо выпущенным (`ReleaseStatus`) раньше, чем захват устаревает (10 минут), и повторный `Release-QuarantineMessage` без `-Force` отклоняется (Learn: повторный выпуск требует `-Force`, а `-ReleaseToAll` пропускает уже получивших). Формы ответа (`Type`, регистр `ReleaseStatus`, `RecipientAddress` массивом) — **Inferred** до эксперимента 17 |
| Выключатель и оповещение | «Выпускать фишинг из карантина в ящики узла» (`integration_config` `mail_node_phish_release`, журнал `tenant.phish_release_changed`) **по умолчанию выключен** (с раздела 5.14 — включён), пока эксперимент 17 не подтвердит формы ответа `Get-QuarantineMessage`; экран говорит почему, администратор включает его сам. Выключенный — проход пишет `paused`, кнопка «Выпустить сейчас» — 409 `phish_release_paused`; выключение посреди прохода останавливает его до следующего захвата. Оповещение `tenant_phish_held` (предупреждение, источник `tenant_quarantine`): письма, оставленные проверкой (кроме `gone`) или исчерпавшие попытки, пока не истекли в карантине | Решение исполнителя по вопросу владельцу (раздел 7.1, D-2): по умолчанию выключено, включается одной кнопкой. Ping узла не задерживает, как прочие оповещения тенанта; ошибка чтения оставляет оповещение прежним. На экране слова EXO — подробность под переведённой причиной |
| Исполнитель (R-36) | белый список +3 операции во всех трёх таблицах (панель, `ops.mjs`, `runner.lib.ps1`; тест держит их равными): `get_quarantine_messages` (`page` — строка цифр 1-1000), `get_quarantine_message` (отвечает только письмом с точно этим `Identity`: по Learn несуществующий `-Identity` отвечает всеми письмами) и `release_quarantine_message` (`identity` — `GUID\GUID` в нижнем регистре, `\z` в шаблоне pwsh). Перед `Release-QuarantineMessage` исполнитель сам читает письмо по `Identity` и отказывает (`quarantine_not_allowed`), если это не ровно одно входящее письмо явного фишинга: другие типы карантина исполнитель выпустить не может. `-User`, `-AllowSender`, `-ReportFalsePositive` и TABL недоступны | Право на командлеты карантина у роли Exchange Administrator (Organization Management) — **Inferred**, эксперимент 16 |
| Экраны и демо | «В Microsoft (трассировка EOP)» под «Подробностями доставки»: кнопка, статус по получателю словами (доставлено, не доставлено с кодом, ждёт, карантин, спам), слова Microsoft цитатой, время проверки; без подключённой трассировки раздела нет, письмо старше 90 дней — причина без кнопки. Блок «Явный фишинг в карантине EOP» (только с драйвером и заполненным тенантом): выключатель с объяснением, последний проход, предупреждение об оставленных, таблица последних писем с причиной и переведённой ошибкой, «Выпустить сейчас». en/ru. Демо: трассировка отвечает сразу (доставлено или отказ EOP с кодом), выпуск выключен, как на новой установке, в таблице — одно выпущенное, одно оставленное (получатель вне узла, оповещение), одно исчезнувшее | — |

Пробел, который этап не закрывает (вопрос владельцу): обычный фишинг (`PhishSpamAction`), спам, вредоносное и другие типы, которые EOP отправил в карантин, в панели пути не имеют — R-28 только предупреждает, что политика их туда уводит, а выпускает их администратор тенанта в портале Defender. Нужен ли для них путь в панели (R-31 в каком-то виде) — решение владельца; по D-2 R-31 не делается. Закрыт решениями владельца после этапа 7 (раздел 5.14).

Проверено тестами: backend — `npm run lint` и `lint:plugins` чисто, `node --check src/index.js`, `vitest run`
265 файлов, 4246 тестов (новые: `quarantineRelease.test.js` — проверки; `quarantineRelease.pglite.test.js` —
выпуск и журнал один раз, порядок «чтение, затем выпуск», получатель вне узла и оповещение, выпущенное
кем-то раньше, захват, оставленный упавшим проходом, чужой захват, троттлинг с возвратом попытки и
повтором задания, потерянный ответ и предел попыток, 25 за проход с продолжением, выключатель и слот,
без доменов, маршруты; после ревью — выключено по умолчанию и включение в журнале, 30 писем с неудачным
чтением доходят до предела без бесконечных продолжений, выключение посреди прохода, один выпуск — одна
запись журнала при двух вызовах, блокировка прохода и перехват умершей, только домены в состояниях
`connector_ready`/`ready`/`authoritative`, «нет в карантине» дважды, перечтение исчерпавших попыток и
снятие оповещения, ожидание `PreparingToRelease`, отказ исполнителя; `messageTrace.pglite.test.js` —
запрос, повторный клик, сопоставление по Message-ID, подробности, оба ограничения времени в `$filter`, один
токен, пауза 5 минут, отказы, пустое ведро без траты попытки и продолжение подробностей, 429, 403; после
ревью — резерв и возврат запросов, три задания вместе не больше 20 запросов, запрос до ошибки считается,
строка без задания ставится заново, нерешаемая трассировка — 409, удаление через 45 дней; в
`traceSource.test.js` — трассировка через драйвер, сброс токена после 401 и не после 403, счёт запросов до
ошибки, выбор источника; в `nodeAlerts.test.js` — `tenant_phish_held`); frontend — `npm run lint` чисто,
`npm test` 4507 тестов (`DeliveryDetails.render.test.js`, `MailNodeTenant.render.test.js`, `delivery.test.js`,
`mailNodeTenant.test.js`, `auditLog.test.js`, демо и покрытие маршрутов), `npm run build`; исполнитель —
`node --test deploy/tenant-worker/worker.test.mjs` 17 тестов (на Windows с pwsh 7.6 — 16 прошли, тест импорта модуля пропущен): напечатанные команды трёх новых операций
с закреплёнными параметрами (выпуск — с чтением перед ним), отказ враждебных `Identity` и номеров страниц
до pwsh и в `runner.ps1`, `runner.lib.ps1` с заглушками: чтение отвечает только точным `Identity`, выпуск
обычного фишинга, исходящего и неизвестного письма — `quarantine_not_allowed`. Образ исполнителя не
пересобирался, на стенде `me-stage` не запускалось.

Что подтверждает только живой тенант: эксперименты 16 (роли для командлетов карантина), 17 (выпуск и
формы ответа `Get-QuarantineMessage`; до него выпуск был выключен, с раздела 5.14 включён по умолчанию), 19 (Graph-трассировка в add-on,
сервис-принципал) и 24 ниже.

### 5.14. Решения владельца после этапа 7 (2026-10-04)

Владелец принял три решения по итогам этапов 7a-7c, этот раздел их реализует: обычный спам и фишинг
попадают в «Спам» сотрудников сами, а не застревают в карантине EOP; всё делается через панель
(псевдонимы mailcow, заведённые руками, в тенант не отражаются); выпуск из карантина включён по
умолчанию. После ревью PR владелец принял ответы по умолчанию на вопросы раздела (их можно пересмотреть):
массовая рассылка — как спам (D-11: `MoveToJmf` и выпуск из карантина); ящики mailcow, заведённые руками,
по-прежнему отражаются; свои антиспам-политики тенанта и Standard/Strict не трогаются.

Код — `backend/src/services/tenant/antispam.js` (`ENFORCED`, `enforcementPlan`), `tenantJobs.js`
(`syncAntispam` с блокировкой), `quarantineRelease.js` (`RELEASABLE_TYPES`, `RULE_GATED_TYPES`,
`typeVerdict`, курсор окна), `tenantDomains.js` (`planMirror`, `nodeAliases`, `heldAliasContacts`), `fakes.js`,
`services/mailNode/nodeApply.js` (правило R-11, `checkSpamRule`), `services/mailNode/nodeAlerts.js`
(`spam_rule_outdated`, `tenant_antispam_not_enforced`, `tenant_alias_contacts_held`),
`routes/mailNodeTenant.js` (`POST /tenant/domains/:domain/alias-contacts/remove`),
`routes/mailNodeQuarantine.js` (`spamRule` в записи карантина узла); исполнитель — `deploy/tenant-worker/`
(`ops.mjs`, `runner.lib.ps1`); экраны — блоки «Антиспам-политика» и «Спам и фишинг в карантине EOP» в
`MailNodeTenant`, псевдонимы и ящики вне панели в `MailNodeDomainTenant`, строка в разделе «Алиасы с другим
адресом», `eopSendsToSpam` в `frontend/src/utils/quarantine.js`; демо — `frontend/src/demo/tenant.js`.
Миграция `0090_tenant_quarantine_types.sql`: `tenant_quarantine_releases.quarantine_type`,
`mail_node_domains.alias_contacts_approved_at` и удаление строк, которые этап 7c оставил только из-за типа
(`not_high_conf_phish`, `worker_refused`). Новые записи журнала: `tenant.antispam_enforced`,
`tenant.alias_contacts_removal_approved`; новые оповещения: `spam_rule_outdated`,
`tenant_antispam_not_enforced`, `tenant_alias_contacts_held`. Полного CLI панели здесь нет: это отдельный
этап (сделан позже, [panel-cli.md](../panel-cli.md)). Порядок для администратора и порядок обновления — [runbook, разделы 6 и 6е](../../operations/mail-node.md).

| Что | Сделано | Отличия и оговорки |
|---|---|---|
| Решение 1: спам и фишинг — в «Спам» сами (R-28) | задание `tenant_antispam_read` (кнопка «Проверить и исправить») и опрос (раз в 6 часов и сразу после проверки подключения, если она нашла, что менять) ставят `SpamAction`, `HighConfidenceSpamAction`, `PhishSpamAction` и (D-11) `BulkSpamAction` политики Default в `MoveToJmf`: чтение, запись только полей с другим значением, чтение снова. На поле — своя операция исполнителя (`set_spam_action_junk`, `set_high_confidence_spam_action_junk`, `set_phish_spam_action_junk`, `set_bulk_spam_action_junk`): `-Identity Default`, поле и значение закреплены в исполнителе, аргументов нет. Поле считается изменённым, только если второе чтение показывает `MoveToJmf`. Журнал `tenant.antispam_enforced` (поле, было, стало; кто нажал или MailExpert). Одновременно идёт одна проверка (блокировка `mail_node_antispam_run`, старше 10 минут — от умершей): опрос и кнопка в один момент не пишут и не журналируют одно изменение дважды. Отказ записи (код EXO; следующие поля прогона не пишутся) или «принято, но не изменилось» (`antispam_not_written`) — `enforcement.ok: false`, предупреждение на экране и оповещение `tenant_antispam_not_enforced`. Неудачное чтение после записи — `unconfirmed`: текст говорит, что состояние неизвестно и запись могла пройти. Исполнитель без операции (`unknown_op`, старый образ) — текст «пересоберите образ tenant-worker». Неудачное первое чтение ничего не пишет и оставляет оповещение прежним. Проверка подключения только читает | По Learn (`Set-HostedContentFilterPolicy`, страница обновлена 2026-08-12) `MoveToJmf` допустим для `SpamAction`, `HighConfidenceSpamAction`, `PhishSpamAction` и `BulkSpamAction`, а `HighConfidencePhishAction` принимает только `Redirect` и `Quarantine`; по «Secure by default» (2026-04-13) `MoveToJmf` у явного фишинга превращается в `Quarantine`, вредоносное всегда в карантине. Поэтому явный фишинг по-прежнему идёт через выпуск. По «Recommended settings» (2026-08-10) у политики Default обычный фишинг по умолчанию `MoveToJmf`, у политик, созданных в портале, и у Standard/Strict — `Quarantine`. Меняется только Default, и раз в 6 часов панель возвращает свои значения поверх правок руками в портале Defender; Default действует и на облачные ящики тенанта, если они есть (тенант задуман отдельным для узла). Свои политики и Standard/Strict для своих получателей главнее и не трогаются: их письма уйдут в карантин и выйдут через выпуск. Право на `Set-HostedContentFilterPolicy` у Exchange Administrator — **Inferred** (эксперимент 16), запись и чтение после неё — эксперимент 25 |
| Решение 1: выпуск из карантина (R-42) | то же задание `tenant_quarantine_release` с теми же проверками выпускает, кроме явного фишинга, обычный фишинг, спам, явный спам и массовую рассылку. Исполнитель читает список `-QuarantineTypes HighConfPhish,Phish,Spam,Bulk` (закреплено). Тип решает перечисление `QuarantineTypes`: все его значения должны быть из набора (`HighConfPhish`, `Phish`, `Spam`, `HighConfSpam`, `Bulk`; панель и исполнитель держат один набор, тест сверяет их); `Type`, написание которого Learn не описывает, только запрещает — слово malware (и SPOMalware), transport rule, file type, DLP в любом из полей даёт окончательный `type_not_allowed` — и заменяет `QuarantineTypes`, только когда того нет. Незнакомое значение (новое в `QuarantineTypes` или неизвестное написание `Type` без `QuarantineTypes`) и письмо без типа — не окончательно: `wait` (`type_unknown`), строка не пишется, следующий проход читает снова. Так `High Confidence Phishing` или `Phishing` в `Type` больше не останавливают выпуск явного фишинга этапа 7c. Тип хранится в строке (`quarantine_type`), показывается в таблице блока и пишется в журнал выпуска. Список проходится окном: каждый проход читает первую страницу и дальше до 4 страниц от курсора (`mail_node_phish_release_cursor`), курсор сдвигается каждый проход и с конца списка начинает сначала — оставленные навсегда письма (получатель вне узла и т. п.) больше не заслоняют новые: письмо за 500 оставленными находится вторым проходом (тест) | В `-QuarantineTypes` у Learn (`Get-QuarantineMessage`, 2026-08-31) нет своего значения для явного спама (есть Bulk, DataLossPrevention, FileTypeBlock, HighConfPhish, Malware, Phish, Spam, SPOMalware, TransportRule): ожидаем его под `Spam`, а `Type` может называть его отдельно (`High Confidence Spam`) — выпускаются оба случая; как на самом деле — эксперимент 17. После перехода политики на `MoveToJmf` новых писем этих типов в карантине почти не будет: выпуск разбирает накопленное и то, что попало туда по другим политикам. Алерт и ключи настроек сохранили имена этапа 7c (`tenant_phish_held`, `mail_node_phish_release`): поменялись только тексты |
| Решение 1: «Спам» на узле (R-11) и окно до записи правила | в правиле prefilter все категории нежелательного (`PHSH`, `HPHSH`, `HPHISH`, `MALW`, `SPM`, `HSPM`, `SPOOF`, `BULK`) идут в Junk всегда, в том числе с `SFV:SKQ`; исключение `SKQ` осталось только для вердикта `SFV` (`SPM`, `SKS`, `SKB`). Правило на узле меняется только кнопкой администратора (перезапуск Dovecot), поэтому до неё на существующем узле стоит прежняя версия: выпущенный спам, массовая рассылка и подделка (`SFV:SKQ` с `CAT` `SPM`, `HSPM`, `BULK`, `SPOOF`) попали бы во «Входящие». Панель читает правило с узла (`checkSpamRule`: `ok`, `outdated` — правило панели другой версии, `missing` — правила нет, `unknown` — узел не ответил или метки сломаны) каждым проходом выпуска и каждой проверкой оповещений (при заданном `<EOP_HOST>`); последнее состояние хранится (`mail_node_spam_rule`), его обновляют и «Применить», и запись правила. Пока состояние не `ok`, выпуск держит `Phish`, `Spam`, `HighConfSpam` и `Bulk` в карантине: такие письма из списка даже не читаются (`ruleWaiting` в итоге прохода), а оставленные прошлыми проходами ждут (`spam_rule_not_applied`), всё не окончательно; явный фишинг выпускается как раньше (прежняя версия тоже клала его в «Спам»). Блок выпуска показывает, сколько писем ждёт правила; оповещение `spam_rule_outdated` (предупреждение) просит записать правило; неудачное чтение оставляет оповещение прежним. Экран карантина узла получает `spamRule` и считает вердикт EOP по правилу, которое на узле сейчас (`eopSendsToSpam(eop, rule)`) | `SPOOF` — потому что подделка, отправленная в карантин, приходит туда как фишинг и выпускается тем же заданием; `BULK` — потому что массовая рассылка теперь выпускается. Обратная сторона: спам, который администратор выпустит руками в портале Defender, тоже ляжет в «Спам». Пока правило не записано, пункт forwarding hosts (R-12) пропускается с `prefilter_not_applied`: добавленные диапазоны остаются, новые ждут. Что выпущенное письмо сохраняет `CAT` — эксперимент 17 |
| Решение 2: всё через панель (D-16, R-29) | зеркало DBEB больше не отражает псевдонимы mailcow, заведённые руками: желаемое — только ящики узла, которые принимают почту. Активные псевдонимы (кроме catch-all) перечисляются в итоге прогона (`nodeAliases`) и в блоке домена «В тенанте Microsoft» с предупреждением (для домена, уже Authoritative, — своим текстом: почта на них отклоняется, если нет оставленного контакта). Контакты, заведённые для псевдонимов этапом 7b: на домене в Internal Relay зеркало удаляет их как любые лишние; на Authoritative-домене (по состоянию панели или типу в тенанте) не трогает — удаление сразу отклоняло бы почту на псевдоним: они перечислены (`heldAliasContacts`), не мешают «полному зеркалу», поднимают оповещение `tenant_alias_contacts_held`, а удаляет их следующий прогон только после «Удалить контакты псевдонимов» с подтверждением (`alias_contacts_approved_at`, журнал `tenant.alias_contacts_removal_approved` с адресами). Ящики mailcow, заведённые руками (есть на узле, нет в панели), отражаются как раньше и показываются как «созданы вне панели». Раздел «Алиасы с другим адресом» (#139) получил строку о том же | Раздел #139 перечисляет алиасы панели (`account_aliases`), а не псевдонимы mailcow: псевдонимы mailcow видны в блоке домена. Разрешение удалять контакты псевдонимов — на домен и навсегда: зеркало больше не создаёт таких контактов. Catch-all (D-6) по-прежнему не пускает домен в Authoritative |
| Решение 3: выпуск включён по умолчанию (D-2) | `mail_node_phish_release` без записи — включено; администратор выключает его в «Тенант Microsoft» (`tenant.phish_release_changed`, как раньше), выключенное остаётся выключенным. Демо начинает с включённым выпуском, в таблице — строки трёх типов | Отменяет «выключено до эксперимента 17» этапа 7c. Допущения «не выпустить дважды» (эксперимент 24) и формы ответа (эксперимент 17) остаются **Inferred** |

Порядок обновления существующей установки (runbook, раздел 6е): пересобрать образ `tenant-worker` (иначе
сразу `tenant_antispam_not_enforced` с `unknown_op`), обновить панель (миграция 0090), записать новое
правило «Спама» кнопкой (до этого спам, фишинг и массовая рассылка ждут в карантине, висит
`spam_rule_outdated`), затем «Проверить и исправить» в антиспам-политике и решение по контактам псевдонимов
на Authoritative-доменах.

Найдено при ревью и исправлено: записи журнала `tenant.antispam_enforced` первой версии раздела не были
зарегистрированы в списке действий журнала и молча отбрасывались (тест задания подменял журнал); теперь
действие зарегистрировано, тест списка его проверяет. Проверка исполнителя «вредоносное, массовая рассылка,
правило потока, без типа, смешанный тип не выпускаются» в тесте `runner.lib.ps1` проходила впустую:
переменная цикла `$q` в PowerShell — та же, что `$Q` со списком карантина, и после первого прохода список
пропадал; переменная переименована, проверка снова настоящая.

Проверено тестами: backend — `npm run lint` и `lint:plugins` чисто, `node --check src/index.js`, `vitest run`
265 файлов, 4272 теста (новые и изменённые: `antispam.test.js`; `tenantJobs.pglite.test.js` — запись только
отличий, четыре поля сразу, принятая, но не применённая запись, отказ, две проверки одновременно — одна
запись и одна запись журнала, неудачное чтение после записи, `unknown_op`, проверка подключения только
читает; `quarantineRelease.test.js` — решение по `QuarantineTypes`, вето `Type`, незнакомое написание,
ожидание правила, набор равен набору исполнителя; `quarantineRelease.pglite.test.js` — выпуск типов,
ожидание правила с явным фишингом мимо него, `High Confidence Phishing` и `Phishing` выпускаются, письмо за
520 оставленными находится вторым проходом; `tenantDomains.test.js` и `tenantDomains.pglite.test.js` —
псевдонимы не отражаются, контакт псевдонима на Authoritative-домене остаётся до разрешения, маршрут с
журналом; `nodeApply.test.js` — правило и состояния `ok`/`outdated`/`missing`/`unknown`;
`nodeAlerts.test.js` — три новых оповещения; `mailNodeQuarantine.test.js` — `spamRule`;
`auditLog.test.js` — новые действия); frontend — `npm run lint` чисто, `npm test` 4546 тестов
(`MailNodeTenant.render.test.js`, `MailNodeOnboarding.render.test.js`, `mailNodeTenant.test.js`,
`auditLog.test.js`, `quarantine.test.js`, `routeCoverage.test.js`), `npm run build`; исполнитель —
`node --test deploy/tenant-worker/worker.test.mjs` 17 тестов (на Windows с pwsh 7.6 — 16 прошли, тест
импорта модуля пропущен): напечатанные команды четырёх операций политики и отказ им в аргументах, список
с четырьмя типами, проверка перед выпуском (выпускаются `HighConfPhish`, `Phish`, `Spam` с `Type` `High
Confidence Spam`, `Bulk`, `HighConfPhish` с `Type` `High Confidence Phishing`, `Type` `Phishing` без
`QuarantineTypes`; не выпускаются `Malware`, `SPOMalware`, `TransportRule`, письмо без типа, `QuarantineTypes`
`Phish` и `Malware`, `Type` `Phish, Malware`, незнакомое значение `QuarantineTypes`, исходящее). fake-EOP не
менялся (операций тенанта он не знает). Образ исполнителя не пересобирался, на стенде `me-stage` не
запускалось.

Что подтверждает только живой тенант: эксперименты 16 (роль для `Set-HostedContentFilterPolicy`), 17 (типы
и формы ответа карантина, `CAT` выпущенного спама) и 25 ниже.

### 5.15. Бэкап и переезд узла (2026-10-04)

Не требование R-xx, а недостающая часть эксплуатации узла: до этого раздел 7 runbook был заметкой «cron с
`backup_and_restore.sh` и копия куда-нибудь». Код — `scripts/deploy/mail-node/node-backup.sh`,
`node-restore.sh`, общая `backup-lib.sh`, юниты `mailexpert-node-backup.service`/`.timer` и cron-файл;
ставит `setup.sh` (ключи restic — `--backup-keys` на stdin). Код restic общий с бэкапом панели
(`scripts/deploy/lib/backup.sh`: контейнер restic, открытие и создание репозитория, ключ восстановления,
пинги); `load_restic_host` получил префикс (`mailexpert-node`), `pick_snapshot` переехал туда из
`restore.sh`, `ensure_image` — из `lib/app.sh` в `lib/common.sh`. Порядок для владельца —
[runbook, разделы 7 и 8](../../operations/mail-node.md).

| Решение | Почему |
|---|---|
| vmail — `restic backup` тома напрямую (только чтение), остальное — скриптом mailcow (`crypt redis rspamd postfix mysql`) | скрипт mailcow пишет vmail одним локальным `tar.zst` (вторая полная копия почты на диске узла), а сжатый архив почти не дедуплицируется; файлы maildir неизменяемы |
| свой репозиторий restic со своим паролем, хост `mailexpert-node-<hex>`, теги `mailcow` и запуска | один пароль на репозиторий; `forget --host --tag mailcow` трогает только снапшоты своего узла |
| ежедневной `restic check --read-data-subset` нет, по воскресеньям — чтение части (`NODE_BACKUP_READ_SUBSET`, 5%) и восстановление дампа и одного ящика | трафик из хранилища при большом объёме почты |
| в панели состояния бэкапа нет, только Healthchecks (период 1 день, grace 2 часа) | панель достаёт до узла только через API mailcow; нового канала к хосту ради этого не заводили |
| `node-restore.sh` отвечает на вопросы `backup_and_restore.sh restore` и сначала проверяет, что вопросы те же (6 `read -p`, тексты) | у скрипта mailcow нет неинтерактивного режима восстановления |
| переезд: `--rehearsal` (без очереди Postfix) заранее, затем `--update` со снапшота `move` (`--overwrite if-changed --delete`) | простой — только разница с ночным снапшотом, а не вся почта; очередь старого узла не уходит второй раз |
| `--tag move` только при остановленных `postfix-mailcow` и `dovecot-mailcow`; у них и watchdog политика перезапуска `no`, снапшот без пропусков, перед standby службы проверяются ещё раз | письмо после бэкапа осталось бы только на старом узле; watchdog и `restart: always` подняли бы службы сами |
| standby старого узла: `eop-ranges.sh` закрывает почтовые порты для всех, пингует только `/fail`, если почтовые службы снова работают; снимает только `setup.sh --end-standby` | старый узел не должен принять ни одного письма после снапшота `move`; обычный запуск `setup.sh` после переезда не должен его «оживить» |
| `node-restore.sh` ведёт `STATE` (`in-progress`, `rehearsal`, `live`): `--update` только после репетиции, только вперёд и того же узла или `move`; `live` (обычное восстановление, `setup.sh`) — больше никогда; оборванное восстановление запускается ещё раз | `--update` поверх живого узла откатил бы его почту; без отметки оборванное восстановление упиралось бы в проверку «чистого сервера» |
| результат восстановления проверяется на сервере (ключи mail_crypt в томе, число ящиков в базе = записанному в бэкапе), а не по словам в выводе mailcow | скрипт mailcow завершается с 0 после неудачного шага |
| запас места (больше из 10% ФС и 2 ГБ), границы времени на каждый вызов restic проверки, `TimeoutStartSec`/`timeout` cron = сумма границ, метка на контейнерах restic и их уборка (`--cleanup`, `ExecStopPost`), `restic unlock` | убитый таймаутом запуск не должен оставить работающий контейнер, блокировку или забитый диск |
| exit 3 restic: для ночного — `partial` в пинге и `backup-last.json`, `/fail` после 3 подряд; для `move` — ошибка | на работающем узле письма двигаются, пока restic читает том; на остановленном это настоящая ошибка чтения |
| репозиторий со снапшотами панели — отказ; `restore.sh` панели выбирает только хосты `mailexpert-<hex>`; `latest` узла без `--host` при нескольких узлах — отказ со списком | разные данные не должны восстановиться не туда |
| снапшоты старого узла после переезда — отдельный шаг `node-backup.sh --forget-host <хост>` на новом узле (остаётся только `move`), не автоматически | удаление истории не должно случиться само, пока новый узел не проверен |

Проверено по исходникам mailcow `2026-09` на GitHub (2026-10-04): `docker-compose.yml` — у всех служб
`restart: always`, синхронизацию ящиков (`imapsync_runner.pl`), уведомления карантина и прочие задания по
расписанию запускает `ofelia-mailcow` по меткам `dovecot-mailcow`; `watchdog-mailcow` перезапускает службы,
которые считает нездоровыми (`USE_WATCHDOG`); есть отдельный том индексов `vmail-index-vol-1`, его не
бэкапит ни скрипт mailcow, ни этот (Dovecot строит индексы заново). `helper-scripts/backup_and_restore.sh` —
шесть `read -p`/`read -ep`, их тексты лежат в `scripts/deploy/test/mail-node/mailcow-2026-09-prompts`;
архивы `tar --use-compress-program="zstd --rsyncable"` с абсолютными путями (`/crypt/...`,
`/backup_mariadb/...`), `restore` шагов `docker run -i` читает stdin. `generate_config.sh` требует ссылку
`.env -> mailcow.conf` до запуска и пишет `data/web/inc/app_info.inc.php` и самоподписанный сертификат.
restic `0.18.0` (документация и `cmd_ls.go`): `ls` с каталогом не рекурсивен без `--recursive`, у `restore`
есть `--overwrite if-changed` и `--delete`, которое с `--include` удаляет только совпавшее.

Тесты: `scripts/deploy/test/mail-node-backup.bats`, 43 теста (заглушки `docker` с restic внутри —
`mock-restic`, `git`, и скрипт mailcow `fake-backup-and-restore` с его раскладкой и вопросами). CI на
коммите `d7efaa1d` (код этого раздела; позже менялся только этот абзац): весь `bats scripts/deploy/test` —
232 из 232, shellcheck чисто, «Deploy e2e» (бэкап и восстановление панели через общий `lib/backup.sh`)
проходит. С настоящими mailcow и restic бэкап узла не запускался: Docker на машине разработки не был
запущен, стенд не трогался.

### 5.16. Места EOP: ящик «только чтение» и локальная доставка (2026-10-07)

Вопрос: у деактивированного ящика и ящика на удалении контакта в тенанте нет, так что EOP отказывает
внешней почте, но письмо с другого ящика того же узла mailcow доставляет локально, мимо EOP. Можно ли
запретить такую доставку через API mailcow, не меняя mailcow и не трогая файлы, которые пишет `setup.sh`.
Проверено по исходникам mailcow на закреплённом коммите `81f6f7b002f2681b732aed74ae53179377def5e0`
(`deploy/mailcow-version`, тег `2026-09a`), без запуска узла.

1. Фильтры Sieve на ящик есть в API. `data/web/json_api.php`: `POST add/filter` (строки 274-275),
   `POST delete/filter` с массивом id (1747-1748), `GET get/filters/all` и `get/filters/<ящик>`
   (1116-1153). `data/web/inc/functions.mailbox.inc.php`, `add filter` (строки 206-300): поля
   `username`, `filter_type` (`prefilter` или `postfilter`, иначе `filter_type`), `script_desc`,
   `script_data` (пустые дают `script_empty` и `value_missing`), `active`; скрипт проверяется
   разборщиком Sieve до записи. Строка списка (`filter_details`, 4554-4578): `id`, `username`,
   `filter_type`, `script_data`, `script_desc`, `active` (1 или 0, считается из `script_name`).
2. Пользовательский `prefilter` работает только при доставке и не затрагивает IMAP.
   `data/conf/dovecot/dovecot.conf`, 232-235: `sieve_before` (глобальный файл), затем
   `sieve_before2 = dict:proxy::sieve_before` (скрипты `prefilter` ящиков из таблицы `sieve_filters`,
   представление `sieve_before` в `data/web/inc/init_db.inc.php`, 51-55), затем `sieve_after`
   (`postfilter`) и `sieve_after2`. Sieve исполняется Dovecot при доставке (LMTP); вход по IMAP,
   чтение и перенос писем он не проверяет.
3. `reject` в этих скриптах доступен: это штатное расширение Pigeonhole, включённое по умолчанию, а
   `sieve_extensions` в `dovecot.conf` (строка 222) только добавляет другие. Разборщик Sieve в
   mailcow (`add filter`) принимает `require ["reject"]`. При доставке по LMTP `reject` даёт
   постоянный отказ получателю, и Postfix отправляет отправителю уведомление о недоставке (по
   документации Pigeonhole; на живом узле не проверено).
4. `add filter` с `active=1` делает неактивными все остальные фильтры того же `filter_type` этого
   ящика (`UPDATE sieve_filters SET script_name = 'inactive' ...`, строки 278-286): активен один
   `prefilter` на ящик. У ящика, где его завели вручную в интерфейсе mailcow, прежний активный
   `prefilter` станет неактивным; `edit/filter` с `active=1` ведёт себя так же (строки 2494-2550).
   Поэтому панель пишет id вытесненных фильтров в описание своего (`mailexpert-read-only restore=<id>`)
   тем же вызовом `add/filter` и при снятии сначала включает их через `edit/filter`, потом удаляет свой.
5. Глобальный `prefilter` панели (правило спама, `nodeApply.js`: `fileinto "Junk"; stop;`)
   исполняется раньше пользовательского: локальное письмо, которое он счёл спамом, попадёт в Junk и
   `reject` не увидит. Известный пробел, не препятствие: у локальных писем нет вердикта EOP, по
   которому правило сработало бы.
6. `delete/mailbox` убирает фильтры ящика: в `init_db.inc.php` (433-440) у `sieve_filters.username`
   внешний ключ на `mailbox.username` с `ON DELETE CASCADE`.
7. Другие варианты, найденные по пути, без нового решения владельца не применять: `edit/mailbox`
   с `active` 0 закрывает и IMAP (панель перестала бы читать ящик), 2 запрещает вход и оставляет
   доставку (обратное нужному); отдельного переключателя «не принимать почту» у ящика нет; ограничение
   по отправителю (`sender_acl`) относится к отправке «от имени», не к приёму.

Итог: пункты 1, 2, 3 и 6 подтверждены (пункт 3 по документации Pigeonhole), нужное делается одним
`prefilter` с `reject` на ящик через `add/filter` и `delete/filter`; файлы и код mailcow не меняются.
Ограничения: пункт 4 (один активный `prefilter` на ящик) и пункт 5 (глобальное правило спама идёт
первым).

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
| 22 | Драйвер этапа 7a (раздел 5.11): токен Graph по ассерции исполнителя, `Connect-ExchangeOnline` с PFX в образе, ответы `whoami`, `Get-BlockedConnector`, `Get-HostedContentFilterPolicy` | «Проверить подключение» в панели; сохранить ответы в `backend/src/services/tenant/fixtures.json` |
| 23 | Драйвер этапа 7b (раздел 5.12): ответы Graph на повторный `POST /domains` и ранний `verify`, свойства `Get-InboundConnector`/`Get-OutboundConnector`/`Get-Recipient`/`Get-DkimSigningConfig`, тексты ошибок «уже есть» и троттлинга EXO (по ним исполнитель ставит `exo_exists` и `exo_throttled`), `Set-OutboundConnector -RecipientDomains @{Add=...}` через splatting | пробный домен шаг за шагом кнопкой «Выполнить шаги тенанта сейчас»; сохранить ответы в `fixtures.json`, тексты ошибок сверить с `runner.lib.ps1` |
| 17 | Выпуск из карантина на локального получателя (D-2: карантин и выпуск панелью, R-42) | `Release-QuarantineMessage`, письмо доходит и не возвращается в карантин; сохранить ответы `Get-QuarantineMessage` (список и по `Identity`: `Type`, `QuarantineTypes`, `ReleaseStatus`, `Direction`, `RecipientAddress`) в `fixtures.json`; текст ошибки повторного выпуска. С раздела 5.14 — то же для писем `Phish` и `Spam`: как EOP называет явный спам (`QuarantineTypes` и `Type`), принимает ли `Get-QuarantineMessage` список `-QuarantineTypes HighConfPhish,Phish,Spam` одним вызовом, какие `SFV` и `CAT` у выпущенного спама |
| 18 | Лицензирование: минимум, считаются ли контакты или mail users получателями, цена | вопрос партнёру (CSP) |
| 19 | Трассировка в add-on тенанте для R-43: работает ли Graph `messageTraces` с правом приложения `ExchangeMessageTrace.Read.All` (иначе `Get-MessageTraceV2` через `ExoRunner`); отдаёт ли `Get-MessageTraceV2` тему | запрос по окну и `getDetailsByRecipient` по одному письму; сохранить ответы как фикстуры `traceSource.fixtures.js` |
| 20 | Точные строки письма в очереди коннектора и истёкшего: статус (`pending`, `failed`), слова событий (`Defer`, `Fail` или иначе), есть ли в `description`/`data` `4.4.7` и `QUEUE.Expired`; через сколько после возврата узла EOP повторяет попытку | тестовый домен с остановленным узлом: письмо снаружи, трассировка каждые 15 минут, затем `MessageExpiration` 12 часов (если есть), чтобы дождаться истечения быстрее |
| 24 | Драйвер этапа 7c (раздел 5.13): трассировка письма по кнопке (R-30) и проход окна простоя (R-43) с токеном драйвера; выпуск фишинга (R-42) | письмо наружу, «Спросить трассировку Microsoft» через 30 минут; окно простоя на пробном домене (эксперимент 20) без `MAIL_NODE_TRACE_URL`; выпуск — на письме, которое EOP сам отнёс к явному фишингу, «Выпустить сейчас», письмо в «Спаме», запись журнала. Два допущения «не выпустить дважды»: (а) через сколько после `Release-QuarantineMessage` `Get-QuarantineMessage -Identity` показывает `ReleaseStatus` выпущенным — должно быть меньше 10 минут (срок захвата); (б) что отвечает повторный `Release-QuarantineMessage -ReleaseToAll` без `-Force` уже выпущенного письма — ожидается отказ, письмо не уходит второй раз; сохранить текст отказа |
| 25 | Решения владельца после этапа 7 (раздел 5.14): запись антиспам-политики | на тенанте, где у Default `PhishSpamAction` = `Quarantine`, «Проверить и исправить» в блоке «Антиспам-политика»: `Set-HostedContentFilterPolicy -Identity Default -PhishSpamAction MoveToJmf` проходит под ролью исполнителя (эксперимент 16), чтение сразу после записи показывает `MoveToJmf` (или через сколько); письмо, которое EOP относит к фишингу, доходит на узел с `SFV:SPM;CAT:PHSH` и лежит в «Спаме»; есть ли в тенанте свои антиспам-политики или Standard/Strict, которые перекрывают Default |
| 26 | Места EOP ([дизайн](../../superpowers/specs/2026-10-07-eop-seats-design.md)): ответ Graph `GET /subscribedSkus` для `EOP_ENTERPRISE` после покупки подписки | право `LicenseAssignment.Read.All`; «Сверить» в блоке «Лицензии EOP»; сохранить `skuId`, `appliesTo`, `prepaidUnits.enabled`, `consumedUnits` фикстурой разбора в `backend/src/services/tenant/fixtures.json` (`graph.subscribedSkus`) |
| 21 | Есть ли `Set-TransportConfig -MessageExpiration` в add-on (в Learn add-on не указан) и действует ли он на очередь коннектора | `Get-TransportConfig \| Format-List MessageExpiration`; значение влияет на «сколько осталось» R-43 (сейчас 24 часа) |

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
| D-15 | Простой узла дольше 24 часов (R-43) | A — наблюдать и сообщать: окна простоя, трассировка, списки писем; B — A и промежуточный релей (store-and-forward) за smart host с MX-приоритетом; C — A и холодный релей, который добавляют в коннектор вручную | A сразу; B — если простои дольше ~20 часов станут реальным риском (нужны второй сервер, общий сертификат, список диапазонов EOP на релее и проверка MX-приоритета smart host на тенанте); C — только если не сработает приём B |

### 7.1. Принятые решения (2026-10-01)

| # | Решение владельца |
|---|---|
| D-1 | Цель — подпись только EOP. Пока эксперимент 9 не подтвердил, что EOP подписывает релейную почту, подписывает mailcow; после подтверждения ключ mailcow снимается. |
| D-2 | Явный фишинг: карантин EOP с автоматическим выпуском панелью (R-42), письмо попадает в «Спам» и показывается в безопасном режиме (R-41). Безопасный режим — для всех писем в «Спаме». 2026-10-04, после этапа 7 (раздел 5.14): выпуск включён по умолчанию, администратор может выключить его в разделе «Тенант Microsoft» (журнал); прежнее «выключено до эксперимента 17» этапа 7c отменено. Обычный фишинг, спам, явный спам и массовая рассылка тоже попадают в «Спам» сами: панель ставит им `MoveToJmf` в политике Default (свои политики и Standard/Strict не трогаются — решение по умолчанию), а то, что EOP всё же поместил в карантин, выпускает тем же заданием с теми же проверками, пока на узле правило «Спама» этой версии. Вредоносное и прочие типы карантина не выпускаются никогда. |
| D-3 | Да: антивирус и вердикт о спаме — от EOP (ClamAV на узле выключен, `SKIP_CLAMD=y`), диапазоны EOP — forwarding hosts вместе с правилом R-11. Письма между ящиками узла идут мимо EOP и им не проверяются — для внутренней переписки принято. |
| D-4 | DBEB с самого начала: домен проходит Internal Relay только на время первой синхронизации, панель сама переводит его в Authoritative (R-29). |
| D-5 | Mail contact. |
| D-6 | Catch-all запрещён. |
| D-7 | Решается экспериментом 8; код поддерживает оба варианта, начинаем с А (тот же адрес). |
| D-8 | Создавать ящики узла может любой вошедший пользователь без лимита: панель закрытая, доступ по одобрению в Cloudflare. |
| D-9 | `RecipientDomains`: домены перечисляются явно, панель добавляет каждый новый домен. |
| D-10 | Лимит на ящик: по умолчанию 50 писем в час, администратор меняет для отдельного ящика. Сервис — точечная переписка сотрудников, не рассылки: лимит страхует от взлома ящика. |
| D-11 | `CAT:BULK` — в «Спам». 2026-10-04, после этапа 7 (раздел 5.14, ответ по умолчанию): и после выпуска из карантина; панель ставит `BulkSpamAction` в `MoveToJmf` и выпускает карантин типа `Bulk`. |
| D-12 | И `extra.cf`, и relayhost домена, одной строкой `<EOP_HOST>`. |
| D-13 | `ENABLE_IPV6=false`. |
| D-14 | У ящиков узла нет «Отключить». Удаление (2026-10-01): запросить может любой вошедший — ввод адреса ящика и обязательная причина; ящик продолжает работать N дней (по умолчанию 5, администратор задаёт от 1 до 90), отменить может любой; затем задание удаляет его безвозвратно с узла (`delete/mailbox`) и из панели, журнал хранит причину (R-33). Удаление в тенанте добавится в то же задание вместе с драйвером тенанта (R-29). **Изменено 2026-10-07 (места EOP, [дизайн](../../superpowers/specs/2026-10-07-eop-seats-design.md)):** у ящиков узла есть «Деактивировать» (администратор, с причиной) и «Активировать»; деактивированный ящик и ящик после запроса на удаление — только для чтения: место EOP уходит в ожидание (по умолчанию 90 дней), получатель в тенанте снимается синхронизацией домена, отправка запрещена, письма читаются. Активация и отмена удаления возвращают своё место, пока оно в ожидании, иначе требуют свободное. |
| D-15 | 2026-10-02: вариант A — наблюдать и сообщать (R-43); промежуточного релея (store-and-forward) пока нет; вернуться к вопросу, если простои дольше ~20 часов станут реальным риском. |
| D-16 | 2026-10-03: Gmail и IMAP — собственные ящики пользователей, подключённые к панели. Ящики узла (mailcow и EOP) создаются из панели и синхронизируются с mailcow и Microsoft; каждый адрес — отдельный оплачиваемый ящик (`example@домен` и `example1@домен` — два ящика). У ящика может быть несколько имён отправителя с тем же адресом (например, на русском и на английском); другой адрес — всегда отдельный ящик, не псевдоним. Заменяет прежний план R-34 (`add/alias` в mailcow и proxy-адреса в тенанте). 2026-10-04, после этапа 7 (раздел 5.14): всё делается через панель. Уточнение этапа 7b (зеркало отражало псевдонимы mailcow, заведённые руками, отдельными контактами) отменено: зеркало DBEB покрывает только адреса панели; такие псевдонимы панель показывает администраторам с предупреждением, что после Authoritative почта на них отклоняется; контакты, заведённые для них раньше, зеркало удаляет как лишние на Internal Relay, а на Authoritative-домене — только после разрешения администратора. Ящики mailcow, заведённые руками, отражаются по-прежнему и показываются как «созданы вне панели» (ответ по умолчанию). Полный CLI панели для таких случаев — отдельный этап. |

Модули: логика EOP живёт в backend панели (состояние доменов и ящиков, задания тенанта — в общей очереди
`jobs` вместо задуманной `tenant_jobs`, раздел 5.11; повторы, журнал, вызовы Graph); отдельный контейнер `tenant-worker` только выполняет типизированные
операции EXO PowerShell и держит сертификат приложения (R-22, R-35, R-36). Создание и удаление ящика в
панели само ставит задания для mailcow и тенанта (псевдонимов с другим адресом у ящиков узла нет, D-16) — руками в тенанте делается только
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
    (раздел 5.14: допустимые действия `SpamAction`, `HighConfidenceSpamAction`, `PhishSpamAction` и
    `HighConfidencePhishAction`, проверено 2026-10-04)
  - Secure by default (2026-04-13): https://learn.microsoft.com/en-us/defender-office-365/secure-by-default
  - Рекомендуемые настройки EOP, действия политики Default (2026-08-10): https://learn.microsoft.com/en-us/defender-office-365/recommended-settings-for-eop-and-office365
  - Get-QuarantineMessage, значения `-QuarantineTypes` (2026-08-31): https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-quarantinemessage
  - Спам в Junk для локальных ящиков: https://learn.microsoft.com/en-us/exchange/standalone-eop/configure-eop-spam-protection-hybrid
  - Блокировки коннектора (2026-07-17): https://learn.microsoft.com/en-us/defender-office-365/connectors-remove-blocked
  - Get-MessageTraceV2: https://learn.microsoft.com/en-us/powershell/module/exchange/get-messagetracev2 ;
    Graph messageTraces: https://learn.microsoft.com/en-us/graph/api/messagetracingroot-list-messagetraces
  - Лимиты EOP (2026-02-10): https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-protection-service-description/exchange-online-protection-limits
  - Очередь EOP при недоступном узле (R-43): https://learn.microsoft.com/en-us/defender-office-365/connectors-mail-flow-intelligence ;
    https://learn.microsoft.com/en-us/exchange/monitoring/mail-flow-reports/mfr-queued-messages-report ;
    https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/fix-error-code-550-4-4-7-in-exchange-online ;
    https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-transportconfig ;
    https://learn.microsoft.com/en-us/exchange/monitoring/monitoring ; https://learn.microsoft.com/en-us/defender-xdr/alert-policies
  - Graph getDetailsByRecipient (2026-01-27): https://learn.microsoft.com/en-us/graph/api/exchangemessagetrace-getdetailsbyrecipient
  - Лимиты исходящей почты (2026-08-25): https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-sending-limits-troubleshoot
  - Веб-сервис IP-адресов (2026-08-20): https://learn.microsoft.com/en-us/microsoft-365/enterprise/microsoft-365-ip-web-service
  - Внешние DNS-записи Microsoft 365 (2026-08-20): https://learn.microsoft.com/en-us/microsoft-365/enterprise/external-domain-name-system-records
  - NDR 5.4.14 и TenantAttribution (2026-08-11): https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/tenantattribution-ndr
- V-2: MC1048624 (MX под `mx.microsoft`), зеркало Message Center: https://mc.merill.net/message/MC1048624 ;
  ограничения молодых и пробных тенантов: https://lazyadmin.nl/office-365/exchange-online-tightens-outbound-limits-for-new-trial-and-edu-tenants/
