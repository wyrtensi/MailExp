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
- Проверка имени сертификата для имён под `mx.microsoft` и наличие у них TLSA (DANE) не выяснены —
  раздел 6.

### 2.4. Next-hop в Postfix mailcow

В mailcow три разных механизма, и названия в интерфейсе путаются:

| Механизм | API | Ключ выбора |
|---|---|---|
| Relayhost (в UI — «Sender-dependent transports») | `add/relayhost`, `edit/domain {relayhost:<id>}` | домен или ящик **отправителя** (`sender_dependent_default_transport_maps`, `postfix.sh:108-153`) |
| Transport maps | `add/transport` | адрес или домен **получателя** (`transport_maps`, `postfix.sh:155-164`) |
| Общий `relayhost` | нет, только `data/conf/postfix/extra.cf` + перезапуск `postfix-mailcow` | всё, что не поймали первые два (`main.cf:18`, дописывание `extra.cf` — `postfix.sh:479-491`) |

- **Отбивки и DSN** (`MAIL FROM:<>`) не попадают под relayhost домена: у пустого отправителя нет строки в
  `relayhosts`, запрос mailcow возвращает `smtp:` с пустым next-hop, и Postfix берёт общий `relayhost`
  (**Inferred** по порядку next-hop из `postconf(5)`; проверяется на стенде). Поэтому общий relayhost в
  `extra.cf` обязателен, API его не заменяет.
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
- greylisting не применяется (`greylist.conf:1`, `force_actions.conf:7-11`);
- `reject` понижается до `add header`, то есть письмо уходит в Junk, а не отклоняется
  (`force_actions.conf:2-6`) — это и есть «per-IP force action» из находки 14;
- с символов групп `rbl`, `policies`, `hfilter`, `neural` снимаются положительные веса
  (`composites.conf:50-52`), `SPOOFED_UNAUTH` и `FREEMAIL_POLICY_FAILURE` их не трогают.

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
  панели — это `active: 0` на узле (`mailcow.js:229-233`), то есть каждый удалённый адрес становится таким
  источником.
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
| Whitelist fail2ban для `<PANEL_IP>` | админка mailcow | руками; API — **Inferred** (R-13) | узел |
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
- Как: по решению владельца (раздел 7, D-8) — лимит ящиков на пользователя или домен, удаление только
  администратором для доменов в `authoritative`, подтверждение с текстом о последствиях.
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
- Без EOP: да.

### Настройка узла через API mailcow

**R-07. TLS Policy Map на `<EOP_HOST>`.** S.
- Зачем: без записи TLS к EOP не проверяется (раздел 2.4; [eop-review](eop-review.md), находка 1).
- Как: `get/tls-policy-map/all`; если нет `dest = <EOP_HOST>` — `add/tls-policy-map {dest:"<EOP_HOST>",
  policy:"secure", parameters:"", active:1}`, при расхождении — `edit/tls-policy-map`. `policy` PHP не
  проверяет (в БД ENUM, `init_db.inc.php:318`) — панель валидирует сама.
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
  `dns_ok`, пока TXT не совпал по `p=`. Для уже созданных доменов без записи — публикация или
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
  умолчанию выводить из бюджета `0.8 × TERRL / число ящиков` получателей в сутки с запасом на письма
  многим получателям (**Inferred**). Панель сама шлёт от ящика пересылкой правил
  (`backend/src/services/ruleForwarder.js`) — это тоже расходует лимит.
- Без EOP: да — лимит `2 / 1m`, третье письмо получает отказ, событие видно в `get/logs/ratelimited`.

**R-11. Раскладка спама EOP в Junk.** S.
- Зачем: раздел 2.6; [eop-review](eop-review.md), находка 5.
- Как: `get/global_filters/prefilter` → сравнить с эталоном панели → только при расхождении
  `add/global-filter {filter_type:"prefilter", script_data}`. `postfilter` не трогать. Вызов
  перезапускает Dovecot — по отдельной кнопке с предупреждением, не внутри общего «Применить». Правило:
  Junk при `SFV` из `SPM|SKS|SKB` или `CAT` из `SPM|HSPM|PHSH|BULK` (BULK — решение D-11), никогда при
  `SFV:SKQ`; сравнение по границе токена `;`, потому что заголовок бывает свёрнут. `:regex` — если
  расширение `regex` есть в Pigeonhole mailcow (**Inferred**), иначе `:contains` с разделителем. mailcow
  проверяет скрипт PHP-парсером, а не `sievec` (`functions.mailbox.inc.php:105-119`), — эталон в тестах
  компилировать `sievec`. `fileinto` без `stop` не прерывает пользовательские скрипты (**Inferred**:
  возможна вторая копия) — проверить на стенде.
- Без EOP: да — письмо с `X-Forefront-Antispam-Report` через порт 25 внутри сети стенда: `SFV:SPM` → Junk,
  `SFV:SKQ` и `SFV:NSPM` → INBOX; Junk панель видит опросом (`backend/src/services/imapManager.js:6647-6650`).

**R-12. Диапазоны EOP как forwarding hosts.** S-M. По решению D-3.
- Зачем: раздел 2.5.
- Как: `get/fwdhost/all` → сравнить с актуальными CIDR (запись Exchange/25 веб-сервиса, раздел 2.10) →
  `add/fwdhost {hostname:"<EOP_RANGE>", filter_spam:1}` и `delete/fwdhost ["<EOP_RANGE>"]`. Без
  `filter_spam: 1` не отправлять никогда. Источник списка — тот же разбор, что у таймера файрвола (R-40):
  панель читает веб-сервис сама или берёт результат таймера.
- Без EOP: да — `docker exec rspamd-mailcow rspamc -i <адрес из диапазона EOP> -f a@<домен с -all в SPF>
  -r b@<DOMAIN> < msg` до и после `add/fwdhost`: до — `R_SPF_FAIL`, после — без понижения до reject.

**R-13. Whitelist fail2ban для панели.** S.
- Что: `<PANEL_IP>` в whitelist fail2ban (runbook, раздел 3, шаг 7), чтение для проверки раздела 9.
- Как: `get/fail2ban` / `edit/fail2ban` — ни одно исследование не проверило их по исходникам
  (**Inferred**). Если API нет — шаг остаётся в runbook, панель только показывает напоминание.
- Без EOP: да — стенд.

### Проверка DNS и сертификата

**R-14. Проверка DNS домена.** M.
- Что: MX — ровно ожидаемые значения (из Graph или введённые руками до тенанта), других MX нет; SPF — одна
  запись `v=spf1` с `include:spf.protection.outlook.com`, без `ip4:<NODE_IP>`; DKIM по режиму — TXT
  `dkim._domainkey` совпадает с `get/dkim` по `p=` (формула как в mailcow `dns_diagnostics.php:402-410`)
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
- Как: отдельная проверка Healthchecks тем же механизмом ping URL, что у диска (`diskWatch.js:14-37`).
- Без EOP: да.

**R-19. Контроль обхода EOP.** S.
- Что: любая строка `status=sent` в `get/logs/postfix` с `relay=`, отличным от `<EOP_HOST>` и от локальной
  доставки в Dovecot, — тревога: почта ушла мимо EOP (нет общего relayhost, неверный relayhost домена).
- Зачем: `extra.cf` через API не прочитать, а отбивки без него уходят напрямую (раздел 2.4).
- Без EOP: да — фикстуры строк лога; на стенде прогон с `extra.cf` и без него.

**R-20. Карантин mailcow и история rspamd.** M.
- Как: `get/quarantine/all`, `get/quarantine/<id>` (сырое письмо, символы, IP), `edit/qitem {items:[id],
  attr:{action:"release"|"learnham"}}`, `delete/qitem`, настройки `edit/quarantine`;
  `get/logs/rspamd-history` — «почему письмо в Junk». Копия попадает в карантин и при `add header`
  (`metadata_exporter.conf:2-7,45-56`), то есть и то, что уже лежит в Junk (**Inferred**).
- Без EOP: да.

**R-21. Бюджет TERRL.** S.
- Что: уникальные внешние получатели за скользящие 24 часа (журнал `message.sent` панели и/или
  `get/logs/postfix`), порог 80% (совет Microsoft), фактический лимит из R-06, рампа молодого тенанта.
  Получатели на accepted domains не считаются.
- Без EOP: да — чистая функция, таблица значений: 100 лицензий → 22 059, 500 → 48 248; 10% и 25%.

### Тенант

**R-22. `TenantDriver` и `tenant-worker`.** L.
- Что: интерфейс `TenantDriver` с двумя реализациями: `GraphClient` (Node, client credentials по
  сертификату) и `ExoRunner` (отдельный контейнер `tenant-worker`: pwsh + модуль ExchangeOnlineManagement,
  только типизированные операции, JSON на входе и выходе). Задания — таблица PostgreSQL (`tenant_jobs`:
  операция, аргументы, состояние, попытки, последняя ошибка, время следующей попытки) и один исполнитель с
  блокировкой в БД: backend рассчитан на один процесс (`backend/src/services/mailNode/currentPassword.js:10-13`).
  Вне пути HTTP-запроса: подключение EXO занимает секунды и десятки секунд.
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
- Как: `POST /domains {"id":"<DOMAIN>"}` → `GET /domains/<DOMAIN>/verificationDnsRecords` (показать
  `label`, `recordType`, `text`, `ttl`) → проверка DNS (R-14) → `POST /domains/<DOMAIN>/verify` →
  `PATCH /domains/<DOMAIN> {supportedServices:["Email"]}` → `GET /domains/<DOMAIN>/serviceConfigurationRecords`
  → ожидаемый MX в `mail_node_domains`. Затем опрос `Get-AcceptedDomain` с повторами: задержка не
  документирована.
- Без EOP: да — мок, обе формы MX. Реальные задержки и формат TXT — тенант.

**R-24. Тип accepted domain.** S.
- Как: как только домен виден в `Get-AcceptedDomain`, до смены MX — `Set-AcceptedDomain -Identity <DOMAIN>
  -DomainType InternalRelay`. `Authoritative` — только из R-29, после полного зеркала.
- Без EOP: логика — да; поведение — тенант.

**R-25. Коннекторы: эталон, сверка, список доменов.** M.
- Что: владелец создаёт оба коннектора мастером EAC один раз; панель снимает `Get-InboundConnector` и
  `Get-OutboundConnector` как эталон, затем сверяет ключевые свойства (`ConnectorType OnPremises`,
  `TlsSenderCertificateName`, `SmartHosts`, `TlsSettings`, `TlsDomain`, список доменов) и показывает
  расхождения.
- Как: новый домен — `Set-OutboundConnector -Identity <имя> -RecipientDomains @{Add="<DOMAIN>"}` (решение
  D-9); проверка — `Validate-OutboundConnector -Identity <имя> -Recipients <адрес>@<DOMAIN>`, затем
  `Set-OutboundConnector -IsValidated $true -LastValidationTimestamp <UTC>` (сам `Validate-*` статус не
  ставит). Для Inbound connector команды проверки нет: реальная отправка и трассировка.
- Без EOP: мок; настоящее — тенант.

**R-26. DKIM в EOP.** S-M. Если по решению D-1 подписывает EOP.
- Как: `New-DkimSigningConfig -DomainName <DOMAIN> -Enabled $false -KeySize 2048` →
  `Get-DkimSigningConfig -Identity <DOMAIN>` (`Status`, `Selector1CNAME`, `Selector2CNAME`) → показать
  CNAME `selector1._domainkey` и `selector2._domainkey` → опрос `Set-DkimSigningConfig -Identity <DOMAIN>
  -Enabled $true` до успеха (пока CNAME не видны, команда падает с ошибкой). Ротация —
  `Rotate-DkimSigningConfig`, вступает через 96 часов.
- Без EOP: мок; подпись релейной почты — тенант.

**R-27. Блокировка коннектора.** S.
- Как: опрос `Get-BlockedConnector` раз в 5-10 минут (пусто — норма); `Remove-BlockedConnector
  -ConnectorId <GUID>` только по кнопке администратора с подтверждением и ссылкой на процедуру Microsoft
  «Respond to a compromised connector»; снятие действует до часа. Роли: снятие — Organization Management
  или Security Administrator, чтение — Global Reader, Security Reader. Попадает ли встроенный алерт
  «Suspicious connector activity» в Graph `security/alerts_v2` — **Inferred**.
- Без EOP: мок; быстрый сигнал по логам (R-18) работает без тенанта.

**R-28. Антиспам-политика — только чтение.** S.
- Как: `Get-HostedContentFilterPolicy -Identity Default` → показать `SpamAction`, `HighConfidenceSpamAction`,
  `PhishSpamAction`, `HighConfidencePhishAction`; предупреждать, если действие расходится с раскладкой
  R-11 (например `Quarantine` для обычного спама — сотрудники его не увидят). `Set-HostedContentFilterPolicy`
  — только по решению владельца (D-2), не кнопкой по умолчанию.
- Без EOP: мок.

**R-29. DBEB: зеркало получателей.** L. По решениям D-4..D-7.
- Что: желаемое множество — адреса ящиков и алиасов (без catch-all) доменов, идущих в DBEB; фактическое —
  `Get-Recipient -ResultSize unlimited` (или `Get-MailContact`) по домену; создать недостающих, удалить
  лишних; пачками по 20-50 с экспоненциальными повторами («you might encounter throttling», числа нет).
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
- Как: кнопка «статус доставки» у письма: Graph `GET /admin/exchange/tracing/messageTraces` с `$filter` по
  `messageId` (v1.0; нужен сервис-принципал `8bd644d1-64a1-4d4b-ae52-2e0cbf64e373` в тенанте, провижининг
  до нескольких часов) или `Get-MessageTraceV2 -MessageId` (для add-on подтверждён, Graph для add-on —
  **Inferred**). Окно запроса до 10 суток, история 90; 100 запросов за 5 минут на тенант — кэш и очередь,
  не непрерывный опрос.
- Без EOP: мок.

**R-31. Карантин EOP и Tenant Allow/Block List.** L. Только если по D-2 явный фишинг остаётся в карантине.
- Как: `Get-QuarantineMessage`, `Release-QuarantineMessage -Identity <id> (-ReleaseToAll | -User <адрес>)
  [-AllowSender] [-ReportFalsePositive]`; TABL — `New/Get/Remove-TenantAllowBlockListItems` (без Defender
  500 allow + 500 block на подтип, без срока — 30 дней). Graph-эквивалента нет. Риск: выпущенное письмо на
  локального получателя может снова попасть в карантин.
- Без EOP: только интерфейс против мока.

### Жизненный цикл ящика и псевдонимов

**R-32. Создание ящика.** S без DBEB, M с DBEB.
- Как: домен `ready` (R-03) → `add/mailbox` с `rl_value`/`rl_frame` (R-10) → строка панели → задание
  «создать получателя» (R-29). В `authoritative`-домене письма на новый адрес получают `550 5.4.1`, пока
  получатель не создан, — ящик показывается «ожидает тенант». Повторное создание удалённого адреса
  (перехват, `mailcow.js:205-218`) тоже ставит задание.
- Без EOP: да.

**R-33. Удаление и отключение.** S-M.
- Как: с DBEB — сначала убрать получателя в тенанте, затем `edit/mailbox active:0`, затем строку (сейчас
  узел → строка, `accounts.js:474-508`); после удаления в тенанте EOP (домен в `authoritative`) отклоняет адрес на границе
  синхронно, без бэкскаттера. Без DBEB удалённый адрес — источник NDR от EOP: подсказка в интерфейсе
  (`frontend/src/locales/en.json:1840`) и runbook должны это говорить. Отключение в панели
  (`enabled: false`, `accounts.js:430-447`) узел не трогает — записать это как «пауза в панели»; «только
  приём» (`active: 2`) — отдельное действие администратора, если понадобится. Аудит с признаком узла.
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

### Безопасность и аудит

**R-35. Секреты.** S.
- Ключ mailcow уже хранится зашифрованным. Сертификат приложения Entra — PFX только в read-only томе
  `tenant-worker`, пароль — секрет контейнера (Microsoft: для локального сертификата «no automated and secure
  way»); в БД панели — только id тенанта, id приложения, отпечаток. Не логировать ответы `get/relayhost/all`.
  mailcow сам пишет тела API-запросов в `API_LOG`, маскируя только поля с `pass` в имени (`json_api.php:11-35`).

**R-36. Никакого произвольного PowerShell.** S.
- `tenant-worker` исполняет только операции из белого списка; параметры — провалидированные домены и
  адреса (`parseHostName`, `parseLocalPart`), передаются как аргументы, не склейкой строк; `-CommandName`
  ограничивает загружаемые командлеты.

**R-37. Минимальные права.** S.
- Ключ mailcow — rw только с `<PANEL_IP>`; Graph — три application-права из R-22; EXO — сначала Exchange
  Administrator, затем кастомная группа ролей (`New-ServicePrincipal` + `Add-RoleGroupMember`) после проверки
  на тенанте; только чтение (`Get-BlockedConnector`, трассировка) — ролям чтения.

**R-38. Одновременность и нагрузка на API.** S.
- Массовые операции (лимиты на 500 ящиков, сверка, зеркало) — с ограничением одновременных вызовов по
  образцу `NODE_RESTORE_CONCURRENCY` (`imapManager.js:1588-1590`); `add/global-filter` — никогда в цикле.

### Хост узла (скрипты, не панель)

**R-39. Скрипт настройки узла.** M.
- Что: `scripts/deploy/mail-node/` — `mailcow.conf` (`SKIP_CLAMD/OLEFY/FTS=y`; `ENABLE_IPV6=false` явно:
  генератор сам ставит `true`, если у хоста работает IPv6, `ipv6_controller.sh:196-236`; альтернатива —
  привязка `SMTP_PORT=<NODE_IP>:25` и других портов, `generate_config.sh:218-226`), `extra.cf` с
  `relayhost = <EOP_HOST>` и перезапуск `postfix-mailcow`, `dovecot-extra.conf`, правила `DOCKER-USER`.
  Идемпотентно, с bats-тестами (инфраструктура есть в `scripts/deploy/test/*.bats`).
- Без EOP: да.

**R-40. Таймер диапазонов EOP.** S-M.
- Как: раздел 2.10; не применять пустой список; замена правил атомарно (ipset или временная цепочка с
  переключением); IPv4 и, если IPv6 включён, IPv6; пинг Healthchecks. Результат — источник для R-12.
- Без EOP: да — bats и записанный ответ веб-сервиса, случаи 400 без GUID, 429, новое поле в `version`.

## 5. Что можно сделать без EOP

### 5.1. Что добавить в стенд

Стенд — [`scripts/deploy/test/stage.sh`](../../scripts/deploy/test/stage.sh) и
[`e2e-mailcow.sh`](../../scripts/deploy/test/e2e-mailcow.sh), описание — [local-stand.md](../../operations/local-stand.md).

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
| 4. Эксплуатация | R-16 … R-21 | fake-EOP с 4xx/5xx: очередь, DSN, тревоги, обход EOP |
| 5. Хост и rspamd | R-39, R-40, R-12 | bats; `rspamc -i` до и после `add/fwdhost` |
| 6. Жизненный цикл | R-04, R-32, R-33, R-34 (без тенанта) | route-тесты; отправка с алиаса на 587 стенда |
| 7. Тенант на моках | R-22 … R-31 | фейковые `ExoRunner`/Graph: порядок операций, повторы, идемпотентность, формы ответов |
| 8. Живой тенант | раздел 6 | ручные эксперименты; ответы `Get-*` сохраняются как фикстуры этапа 7 |

Этапы 1-7 не требуют тенанта. Этапы 2-5 можно вести параллельно после 1 (R-01 и R-02 нужны всем).

## 6. Что требует живого тенанта

Нужен платный или пробный тенант с add-on (в E5 developer Inbound connector не создать) и пробный домен
второго уровня. Каждый ответ `Get-*` сохранять как фикстуру для моков.

| # | Эксперимент | Как проверить |
|---|---|---|
| 1 | Inbound connector по сертификату: набор свойств после мастера EAC | `Get-InboundConnector \| Format-List` → эталон R-25 |
| 2 | Релей обычной почты и пустого отправителя (DSN) через сертификат; домен `<MAIL_HOST>` как accepted domain нужен ли | письмо наружу и отбивка (письмо на несуществующий адрес с внешнего ящика) — `status=sent relay=<EOP_HOST>` в логе, NDR дошёл, нет `5.7.64 ATTR36` |
| 3 | Цепочка сертификата | временно leaf без промежуточного на тестовом узле → ожидаем `5.7.64` |
| 4 | TLS к EOP: `secure` для `<EOP_HOST>` обеих форм, голое имя без MX, TLSA | лог «Verified TLS connection established to <EOP_HOST>»; `dig +dnssec TLSA _25._tcp.<EOP_HOST>` |
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

Закрыто исследованием: вариант «явный фишинг в MoveToJmf» невозможен (только `Redirect` и `Quarantine`);
вопрос о лимите 10 000 получателей на ящик для релея закрыт (к add-on не применяется); `Get-BlockedConnector`
существует; `add/transport "*"` как замена `extra.cf` отклонён.

| # | Решение | Варианты | Рекомендация |
|---|---|---|---|
| D-1 | Кто подписывает DKIM | mailcow; EOP; оба | mailcow сразу (ключ публикуется при создании домена, проверяемо на стенде); DKIM EOP включать дополнительно после эксперимента 9. Две подписи допустимы |
| D-2 | Явный фишинг | карантин администратора; `Redirect` на отдельный ящик узла, видимый администраторам в панели | начать с карантина (рекомендация Microsoft) и ручной проверки в портале; `Redirect` — если ложных срабатываний станет много и эксперимент 11 пройдёт |
| D-3 | Диапазоны EOP как forwarding hosts (`filter_spam: 1`) | да, с синхронизацией; нет | да, после проверки `rspamc -i` на стенде (R-12); это отменяет прежнюю рекомендацию находки 13 |
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

## 8. Поправки к существующим документам

Внесены 2026-09-30 вместе с этим документом:

- [eop-review.md](eop-review.md): находка 1 — `<EOP_HOST>` вместо одного имени тенанта, второе звено
  `postfix-tlspol`, `active: 1`, ENUM `policy`, скобки в `dest`; находка 2 — голое имя вместо
  `[...]:25` (противоречило находке 1), `add/transport "*"` отозван, relayhost = «Sender-dependent
  transports»; находка 3 — ротации нет, формат CNAME EOP; находка 4 — автоопределение `ENABLE_IPV6`,
  привязка портов; находка 5 — три штатных правила `postfilter`, перезапуск Dovecot, свёрнутые заголовки,
  `SKQ`; находка 6 — вариант (b) невозможен; находка 7 — `Get-BlockedConnector`, единицы лимита; находка 9
  — лицензии, контакт вместо mail user, алиасы, catch-all, петля `5.4.14`; находка 10 и 15 — устаревшие
  ссылки на строки; находка 11 — `ClientRequestId`, `*.mx.microsoft`; находка 13 — пересмотрена; находка 14
  — реализуется forwarding hosts; находка 15 — поведение mailcow подтверждено по коду; находка 16 — 48 248,
  рампа молодого тенанта; «Решения владельца» и «Проверить на реальном тенанте» ссылаются сюда.
- [eop-and-hosting.md](eop-and-hosting.md): направления коннекторов в терминах Microsoft (разделы 1.6,
  2.2, 2.3), домены через Graph или центр администрирования (`New-AcceptedDomain` только on-prem), mail
  contact как объект DBEB, лимиты на ящик к add-on не применяются (2.6 и сводка, п. 5), TERRL 48 248 и рампа
  (2.7 и сводка, п. 4), форма MX (4.1).
- [README.md](README.md): ссылка на этот документ; названия коннекторов, forwarding hosts, TERRL и лимит на
  ящик в разделе 2; открытые решения ссылаются на раздел 7.
- [mail-node.md](../../operations/mail-node.md): плейсхолдер `<EOP_HOST>`; коннекторы в терминах Microsoft;
  MX и smart host — значение из тенанта, не `<tenant>.mail.protection.outlook.com`; relayhost домена =
  «Sender-dependent transports» (`add/relayhost`, не `add/transport`); `ENABLE_IPV6`; перезапуск Dovecot при
  `add/global-filter`; явный фишинг без `MoveToJmf`; домен в тенант через центр администрирования и
  `Set-AcceptedDomain`; бэкскаттер при удалении ящика на Internal Relay; forwarding hosts — по решению D-3.
- [ROADMAP.md](../../../ROADMAP.md): пункты Next про почтовый узел выровнены по этапам раздела 5.

## Источники

- Код MailExpert (`main`, `62529906`): `backend/src/services/mailNode/mailcow.js`, `backend/src/routes/mailNode.js`,
  `backend/src/routes/accounts.js`, `backend/src/routes/send.js`, `backend/src/services/ruleForwarder.js`,
  `backend/src/services/imapManager.js`, `backend/src/services/auditLog.js`, `scripts/deploy/test/stage.sh`.
- mailcow-dockerized, коммит `ca07d8d3` (тег `2026-09`): `data/web/json_api.php`,
  `data/web/inc/functions.{mailbox,transports,tls_policy_maps,dkim,fwdhost,ratelimit,mailq,quarantine}.inc.php`,
  `data/web/inc/init_db.inc.php`, `data/Dockerfiles/postfix/postfix.sh`, `data/conf/postfix/main.cf`,
  `data/conf/dovecot/global_sieve_after`, `data/conf/rspamd/local.d/{actions,policies_group,greylist}.conf`,
  `data/conf/rspamd/{force_actions,composites}.conf`, `data/conf/rspamd/lua/rspamd.local.lua`,
  `_modules/scripts/ipv6_controller.sh`, `generate_config.sh`.
- Postfix: `transport(5)`, `postconf(5)` (`sender_dependent_default_transport_maps`), TLS_README (ключ
  `smtp_tls_policy_maps`).
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
