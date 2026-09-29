# Почтовая нода за Microsoft EOP для MailExpert: сравнение платформ

Дата исследования: 2026-09-21. Цель: owned-domain mail node, на которой MailExpert по HTTP API заводит ящики; входящая почта MX -> EOP -> наша нода (TCP 25, TLS), исходящая наша нода -> EOP как smarthost. До 500 ящиков на нескольких доменах, продакшн, ежедневная работа многих сотрудников. MailExpert держит по одному IMAP IDLE на ящик плюс короткие sync-соединения, всё с одного IP, и отправляет через SMTP submission.

Условные обозначения:
- **[ист.]**: факт прочитан в источнике по ссылке рядом.
- **[вывод]**: мой вывод или оценка, в источнике прямо не написано. Перед продакшном такое проверить на стенде.
- **[устар.?]**: источник старше 2025 года или помечен старой датой, факт может быть неактуален.

---

## 0. Коротко

**Рекомендация: mailcow-dockerized** (Postfix + Dovecot + Rspamd), ClamAV выключен (`SKIP_CLAMD=y`), FTS по ситуации, SOGo оставить (отключение SOGo официально не поддерживается). Админка и API mailcow **не должны смотреть в интернет**. Почему mailcow:
1. Самый полный и стабильный REST API: домены, ящики, `active` 0/1/2, пароль, квота. Через тот же API настраиваются relayhost для каждого домена, TLS policy map, forwarding hosts и whitelist fail2ban.
2. По EOP закрывает всё. Postfix уже отдаёт клиентский сертификат (`smtp_tls_cert_file`), а значит работает certificate-based connector в EOP. Relayhost назначается per-domain. TLS к EOP можно сделать обязательным через API. Диапазоны EOP заносятся в forwarding hosts, и тогда DNSBL и greylisting к ним не применяются.
3. `mail_max_userip_connections = 500` уже стоит в конфиге. Релизы выходят раз в 1-2 месяца, есть штатный скрипт бэкапа.
4. Цена за это: тяжелее остальных (реалистично 8-16 GiB RAM) и заметная история CVE в PHP-админке (SSTI 9.1, stored XSS, SQLi в 2025-2026). Эти CVE и определяют жёсткое условие по сетевой изоляции UI и API.

**Запасной вариант: Stalwart (Community, AGPL-3.0)**. Один Rust-бинарник, самый лёгкий, API на JMAP, лимит 16 соединений на пользователя, allowlist IP встроен. Сейчас не первый по трём причинам:
- До 1.0 ещё не дошёл: в 0.16 (апрель 2026) REST API заменили на JMAP с ломающей миграцией, а 1.0 с заморозкой схемы ожидают «around October».
- Флага «отключить аккаунт» нет, есть только обходные пути через permissions или срок действия credential. Архивирование и восстановление удалённых аккаунтов есть только в Enterprise.
- Клиентского TLS-сертификата для исходящего SMTP нет (issue #277 открыт с 2024-03). Поэтому в EOP возможен только IP-based connector, и через него не пройдут NDR и пересылка на внешние адреса.

К Stalwart стоит вернуться после выхода 1.0 и закрытия #277.

Третий по порядку: **Mailu**. API есть, флаг `enabled` есть, требования к ресурсам скромные. Но relayhost только глобальный, клиентского сертификата по умолчанию нет, в 2026 была критичная CVE, мажорного релиза не было с 2024.06.

Сразу отпали: **iRedMail** (API только в платном iRedAdmin-Pro), **Carbonio CE / Zimbra** (от 16 GB RAM, свой Java-стек, у Zimbra FOSS нет официальных бинарников), **docker-mailserver** (API нет), **Mox** (стабильного provisioning API нет, версия 0.0.x, фактически один разработчик), **Poste.io** (закрытый код, лицензия запрещает обслуживать третьих лиц, хотя REST API есть и в бесплатной редакции).

---

## 1. Общие вопросы для всех кандидатов

### 1.1 Схема с EOP: что требует Microsoft

- Нужны два connector'а: Office 365 -> ваш сервер (smart host) и ваш сервер -> Office 365. На нашем сервере должен быть включён TLS с CA-подписанным сертификатом, TCP 25 открыт для всех адресов Exchange Online. [ист.] https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail (updated 2026-08-03)
- Connector O365 -> наш сервер: можно включить «Always use TLS» и требовать сертификат от доверенного CA с совпадающим subject/SAN. [ист.] там же
- Connector наш сервер -> O365 опознаёт отправителя двумя способами: по subject name сертификата, которым отправляющий сервер аутентифицируется в Office 365 (Microsoft рекомендует этот вариант), или по IP. Smarthost в примере Microsoft: `<domain>-com.mail.protection.outlook.com`, порт 25, `RequireTLS`. [ист.] там же
- **SMTP AUTH в этой схеме не участвует.** Connector аутентифицирует по сертификату или IP, поэтому «smarthost auth» для EOP означает клиентский TLS-сертификат. [вывод из двух способов, перечисленных Microsoft]
- Relay в интернет через M365 работает при одном из условий: домен отправителя является accepted domain тенанта, либо используется certificate-based connector с CN/SAN из домена тенанта. Иначе ответ `550 5.7.64 Relay Access Denied ATTR36`. Отдельно оговорено, что **NDR с on-prem во внешний мир, отправка от доменов вне тенанта и серверные пересылки на внешние адреса работают только через certificate-based connector**. [ист.] https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/office-365-notice (обновлено 2025-06-25; сам механизм введён в 2017)
  - Следствие для нас [вывод]. Если нода сама генерирует NDR (переполнена квота, отказ после приёма) или у пользователей настроен redirect/forward наружу, то с IP-only connector такие письма не уйдут. Отказ неизвестному получателю на этапе RCPT формирует уже EOP, это не наша проблема.
- Диапазоны EOP для firewall на TCP 25 (Microsoft 365 endpoints, ID 10, версия списка 2026081400): `40.92.0.0/15, 40.107.0.0/16, 52.100.0.0/14, 104.47.0.0/17, 2a01:111:f400::/48, 2a01:111:f403::/48`, URL `*.mail.protection.outlook.com`, `*.mx.microsoft`. [ист.] https://endpoints.office.com/endpoints/worldwide?ServiceAreas=Exchange&clientrequestid=b10c5ed1-bad1-445f-b386-b919946339a7, https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
  - Список время от времени меняется. Firewall лучше обновлять по версии из web service (`/version/worldwide`), а не держать захардкоженным. [вывод]
- Если домены тенанта уже переведены на новые MX `*.mx.microsoft` (DNSSEC/DANE), smarthost-адрес надо сверить с актуальным MX тенанта. [вывод из списка URL выше, не проверял]
- **Проверка SPF/DMARC за шлюзом.** Вся входящая почта приходит с IP EOP. Если нода проверяет SPF/DMARC/DNSBL/greylisting по IP соединения, она получит ложные срабатывания. На любой платформе IP EOP надо сделать доверенными или вывести из этих проверок. Фильтрацией пусть занимается EOP. [вывод]
- **Где подписывать DKIM.** Если в M365 для домена включён DKIM, EOP подписывает письма на выходе. Подпись на ноде тогда дублируется, а mail flow rules в EOP, которые меняют тело (например, дисклеймеры), могут её сломать. Надо заранее решить, где живёт DKIM: на ноде (все кандидаты это умеют) или в EOP. [вывод]
- Лицензирование EOP для on-prem ящиков в Microsoft-документации называется «Built-in security add-on for on-premises mailboxes» [ист.: первая ссылка]. Цену я не проверял: сторонние источники дают $1-2/user/month, но друг с другом не сходятся. [не проверено]

### 1.2 500 постоянных IMAP-соединений с одного IP

**Dovecot** (mailcow, Mailu, docker-mailserver, Modoboa, Poste.io, iRedMail):
- Каждое IMAP-соединение обслуживается отдельным `imap`-процессом (`client_limit=1` по умолчанию). У сервиса imap `process_limit` по умолчанию 1024, и это прямой потолок одновременных IMAP-соединений. [ист., документация 2.3] https://doc.dovecot.org/2.3/configuration_manual/service_configuration/
- Режимы login-процессов. В high-security (`service_count=1`) на каждое подключение создаётся новый login-процесс, а при TLS/SSL он не завершается и остаётся проксировать трафик до конца соединения. High-performance режим обслуживает много соединений небольшим числом долгоживущих login-процессов. [ист.] https://doc.dovecot.org/2.3/admin_manual/login_processes/
- `mail_max_userip_connections`: по умолчанию **10**. Это «maximum number of IMAP connections allowed for a user from each IP address», то есть лимит считается **на пользователя с одного IP**, а не на IP в целом. [ист.] https://doc.dovecot.org/2.3/settings/core/
  - Для MailExpert: на каждый ящик один IDLE и несколько sync, итого 2-5 соединений на пользователя. 500 разных пользователей с одного IP под этот лимит не попадают. Упереться можно, только если MailExpert начнёт параллелить sync внутри одного ящика (например, по папкам) больше чем на 10 соединений. [вывод]
  - Фактические значения: mailcow `mail_max_userip_connections = 500` [ист.] https://github.com/mailcow/mailcow-dockerized/blob/master/data/conf/dovecot/dovecot.conf; Mailu `= 20` [ист.] https://github.com/Mailu/Mailu/blob/2024.06/core/dovecot/conf/dovecot.conf; docker-mailserver не переопределяет, значит 10 [вывод из grep 20-imap.conf].
- Память. По оценке из рассылки Dovecot, «1500 IMAP sessions will eat up about 3GB», то есть около 2 MB на сессию. [ист., устар.? 2017] https://dovecot.org/list/dovecot/2017-February/107029.html
  - Для 500 IDLE получаем порядка 1 GB на imap-процессы. В high-security режиме с TLS добавляются ещё около 500 imap-login процессов, так что в сумме ориентир 1-2 GB. [вывод]
- `imap_hibernate_timeout` (по умолчанию 0, то есть выключено) переносит IDLE-соединения в общий процесс imap-hibernate и освобождает imap-процесс. [ист.] https://doc.dovecot.org/2.3/settings/core/, https://doc.dovecot.org/2.3/configuration_manual/hibernation/
  - В рассылке описан случай: 237 гибернированных соединений в одном процессе примерно на 3.2 MB. [ист., устар.? 2017] https://dovecot.org/list/dovecot/2017-April/107667.html
  - Документация предупреждает, что процесс под `$default_internal_user` получает доступ к почте всех пользователей. В mailcow гибернация по умолчанию не включена. [ист.: hibernation doc; для mailcow вывод из dovecot.conf, где параметр не встречается]
- Для 500 IDLE плюс всплески sync нужен запас до `process_limit` 1024 у imap. Если MailExpert массово переподключается (после рестарта), надо ограничить параллельность на своей стороне или поднять лимит. [вывод]

**Stalwart**: асинхронный Rust без процесса на соединение. По умолчанию до 8192 одновременных соединений на все сервисы, в простое около 100 MB RAM [ист.] https://stalw.art/docs/install/requirements/. Лимит IMAP/POP3 `maxConcurrent` = **16 на пользователя** (не на IP) [ист.] https://stalw.art/docs/email/settings/ratelimit/, https://stalw.art/docs/ref/object/imap/.

**Mox**: Go, собственный IMAP. Соединения, по-видимому, дешёвые, но цифр я не нашёл. [вывод]

### 1.3 Главный риск схемы «один клиентский IP»: баны за неудачные логины

Лимит соединений на пользователя здесь не проблема. Проблема в том, что **все платформы банят или троттлят по IP за неудачную аутентификацию**, а MailExpert ходит с одного IP за все 500 ящиков. Если у одного ящика протух пароль и MailExpert в цикле переподключает IDLE, IP забанят, и отвалятся все 500 ящиков. [вывод]

| Платформа | Механизм и параметры | Что сделать |
|---|---|---|
| mailcow | netfilter (аналог fail2ban). Параметры из **примера запроса** в OpenAPI, это не подтверждённые умолчания: `max_attempts 5`, `retry_window 600`, `ban_time 86400`, `netban_ipv4 24` (при таком значении банится вся /24) [ист.] https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/api/openapi.yaml (`/api/v1/edit/fail2ban`). Реальные умолчания посмотреть в UI на стенде | IP MailExpert в `whitelist`, через UI или `POST /api/v1/edit/fail2ban` |
| Mailu | `AUTH_RATELIMIT_IP` по умолчанию **5/hour**, `AUTH_RATELIMIT_USER` 50/day [ист.] https://mailu.io/2024.06/configuration.html | `AUTH_RATELIMIT_EXEMPTION=<IP MailExpert>/32` |
| Stalwart | `authBanRate` 100 за сутки, `abuseBanRate` 35 за сутки [ист.] https://stalw.art/docs/ref/object/security/ | `x:AllowedIp/set` с IP MailExpert [ист.] https://stalw.art/docs/ref/object/allowed-ip/ |
| docker-mailserver | fail2ban (`setup fail2ban ...`) [ист.] https://github.com/docker-mailserver/docker-mailserver/blob/master/target/bin/setup | `ignoreip` в jail [вывод] |
| Mox | учитывает login attempts (с v0.0.15) [ист.] https://github.com/mjl-/mox/releases/tag/v0.0.15 | как и когда банит, не проверял |

На стороне MailExpert [вывод]: после ошибки аутентификации ящик надо помечать как «нужен пароль» и уходить в экспоненциальный backoff вместо переподключения в цикле. Иначе whitelist просто прячет проблему.

**SMTP submission с одного IP.** У Postfix по умолчанию `smtpd_client_connection_count_limit` = 50 одновременных соединений с одного клиента (половина `default_process_limit` = 100). В mailcow `main.cf` этот параметр не переопределён. Если MailExpert отправляет параллельно, пул SMTP-соединений нужно держать меньше этого предела или поднять лимит (например, для IP MailExpert через `smtpd_client_event_limit_exceptions`). [вывод из умолчаний Postfix и grep mailcow main.cf]

### 1.4 Семантика «пересоздание реактивирует»

У mailcow (`add/mailbox`), Mailu (`POST /api/v1/user`) и Stalwart (`x:Account/set create`) создание ящика по уже существующему адресу завершается ошибкой. Значит, для «пересоздания» MailExpert должен сначала найти ящик, а если он есть, выполнить update (active=1 и новый пароль), иначе create. [вывод из схем API ниже]

---

## 2. Отброшенные кандидаты

### iRedMail: отпал из-за API
- REST API есть только в **iRedAdmin-Pro**: `POST /api/login`, `GET /api/domains`, `POST /api/user/<mail>` (name, password, quota), `PUT /api/user/<mail>` с `accountStatus=active|disabled` или `password`. [ист.] https://docs.iredmail.org/iredadmin-pro.restful.api.html
- Цена Pro: $499 в первый год на один сервер, дальше продление $250/год. [ист.] https://www.iredmail.org/pricing.html
- Устанавливается на голую ОС скриптом, а не контейнерами. Сам по себе вариант возможен, но это деньги плюс ручной Postfix/Dovecot без выигрыша перед mailcow. [вывод]

### Carbonio CE / Zimbra-форки: отпали по весу и стеку
- Carbonio CE на одном сервере требует минимум 4 vCPU, 16 GB RAM, 50 GB диска. [ист.] https://docs.zextras.com/carbonio-ce/html/install/requirements.html (через поисковую выдачу, страницу не открывал)
- Стек Java/Zimbra со своими IMAP/SOAP, для роли «тонкий backend за EOP» это избыточно. [вывод]
- У Zimbra 10 FOSS нет бесплатных официальных бинарников, остаются только сборки сообщества (Maldua, Intalio и другие). [ист.] https://forums.zimbra.org/viewtopic.php?t=72645&start=50, https://www.zintalio.com/

### docker-mailserver (DMS): отпал, API нет
- Провижининг идёт только через CLI внутри контейнера: `setup email add|update|del|restrict|list`, `setup quota set|del`, `setup relay add-domain|add-auth|exclude-domain`, `setup config dkim`. [ист.] https://github.com/docker-mailserver/docker-mailserver/blob/master/target/bin/setup
- Альтернатива: `ACCOUNT_PROVISIONER=LDAP`, и тогда MailExpert пишет в LDAP. Но с LDAP **квоты не реализованы**. [ист.] https://docker-mailserver.github.io/docker-mailserver/latest/config/account-management/overview/
- Флага «disable» нет. `email restrict` ограничивает только send/receive на уровне Postfix [ист.: setup]. Деактивация = смена пароля на случайный (`setup email update`) [вывод]. Display name не хранится [вывод из формата `postfix-accounts.cf`: только адрес и хэш] [ист.] https://docker-mailserver.github.io/docker-mailserver/latest/config/account-management/provisioner/file/
- Как это выглядело бы: sidecar-сервис с доступом к Docker socket, который принимает HTTP от MailExpert и вызывает `docker exec mailserver setup ...`. Доступ к docker socket по сути равен root на хосте. [вывод]
- Relay: `DEFAULT_RELAY_HOST` глобально, `setup relay add-domain` по доменам отправителя (`postfix-relaymap.cf`). [ист.] https://docker-mailserver.github.io/docker-mailserver/latest/config/advanced/mail-forwarding/relay-hosts/
- В `main.cf` DMS нет `smtp_tls_cert_file`, значит без override клиентского сертификата нет. [вывод из grep] https://github.com/docker-mailserver/docker-mailserver/blob/master/target/postfix/main.cf
- Релизы: v15.0.0 (2025-03), v15.1.0 (2025-08), v16.0.0 (2026-08-30, Debian 13, Dovecot 2.3 -> 2.4, ломающие изменения), v16.0.1 (2026-09-04). Лицензия MIT. [ист.] https://github.com/docker-mailserver/docker-mailserver/releases, https://github.com/docker-mailserver/docker-mailserver/blob/master/CHANGELOG.md

### Mox: отпал, стабильного provisioning API нет
- Админка вызывает sherpa JSON-RPC (`/admin/api/...`): `Domains`, `AccountAdd`, `SetPassword`, `AccountLoginDisabledSave`, `DomainDisabledSave`, `RoutesSave`/`DomainRoutesSave`/`AccountRoutesSave`, `DomainDKIMAdd`. [ист.] https://github.com/mjl-/mox/blob/main/webadmin/api.json
  - Аутентификация там сессионная: `LoginPrep`/`Login` с паролем админа, cookie и CSRF-токен. API-ключей нет. [ист.] https://github.com/mjl-/mox/blob/main/webadmin/admin.go
  - Это внутренний API веб-интерфейса, а не контракт для интеграций. Публичный `webapi` в mox нужен для отправки и приёма писем, не для администрирования. [ист.] https://www.xmox.nl/features/ [вывод: «внутренний»]
- По возможностям mox подошёл бы: с v0.0.15 есть отключение логина аккаунта и отключение домена [ист.] https://github.com/mjl-/mox/releases/tag/v0.0.15, smarthost через Transports/Routes с разбивкой глобально, по домену или по аккаунту [ист.] https://github.com/mjl-/mox/blob/main/README.md.
- Против: версия 0.0.17 (2026-08-19), между v0.0.15 (2025-04) и v0.0.16 (2026-08) прошло 16 месяцев без релизов. 1065 коммитов у автора `mjl-` против единиц у остальных, то есть bus factor = 1. В v0.0.16 закрыты уязвимости: подделка From через несколько заголовков, парсинг SCRAM, sendmail setgid. [ист.] https://github.com/mjl-/mox/releases, https://api.github.com/repos/mjl-/mox/contributors

### Poste.io: условно отпал
- Стек: Haraka (SMTP), Dovecot, Rspamd, ClamAV, SQLite, nginx, Roundcube, всё в одном контейнере. [ист.] https://poste.io/doc/mailserver-parts
- REST API одинаковый во всех редакциях, включая FREE. [ист.] https://poste.io/order
  - Эндпоинты `/admin/api/v1/boxes`, `/admin/api/v1/boxes/{email}/quota`, `/admin/api/v1/domains` видны по стороннему PHP-враппер у [ист.] https://github.com/tormjens/posteio-php. Официальная документация API лежит за логином (`/admin/api/doc`), поля для disable/password в ней я не проверял. [не проверено]
- Код закрыт. Лицензия: «Licensee is prohibited to run Software instances as service to any third party». Если в «нескольких доменах» есть клиентские, это блокер. [ист.] https://poste.io/doc/license
- PRO стоит $349/год, PRO+ $1239/год за инсталляцию. [ист.] https://poste.io/order
- Релизы примерно ежемесячные, последний 2.5.17 (2026-09-18). В 2026 закрывали предсказуемый SRS-секрет (подделка SRS и relay), shell injection в хелперах, CSRF и XSS. [ист.] https://poste.io/changelog
- Итог: для продакшна с 500 ящиками смущает сочетание закрытого кода, одного вендора, SQLite и Haraka. Лучше открытые варианты с тем же Dovecot. [вывод]

---

## 3. Серьёзные кандидаты

### 3.1 mailcow-dockerized

**Архитектура.** Docker Compose: Postfix, Dovecot, Rspamd, MariaDB, Redis, nginx + PHP (UI и API), SOGo, ClamAV, Olefy, Unbound, netfilter, watchdog. [ист.] https://docs.mailcow.email/getstarted/prerequisite-system/, https://github.com/mailcow/mailcow-dockerized/blob/master/generate_config.sh
- Dovecot собран из пакетов Alpine 3.21, то есть ветка 2.3.21.x. [вывод из `FROM alpine:3.21`] https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/dovecot/Dockerfile
- С 2025-01 полнотекстовый поиск на Flatcurve внутри Dovecot, Solr убран, `SKIP_SOLR` удалён. [ист.] https://github.com/mailcow/mailcow-dockerized/releases/tag/2025-01

**«Облегчённый режим» по фактам:**
- `SKIP_CLAMD=y` поддерживается официально. На машинах с ≤2.5 GiB установщик сам предлагает выключить ClamAV. [ист.] generate_config.sh. Сколько это экономит: ClamAV рекомендует 3-4 GiB RAM для Docker-контейнера, при concurrent reload баз нужна двойная память. [ист.] https://docs.clamav.net/manual/Installing/Docker.html. Экономия порядка 1.5-3 GiB. [вывод] Антивирус у нас на стороне EOP, так что выключаем.
- `SKIP_FTS=y` поддерживается официально. Умолчания: `FTS_HEAP=128` MB на процесс индексации, `FTS_PROCS=1`. Рекомендуют 512 MB на процесс и примерно половину потоков CPU. Flatcurve экономнее Solr по RAM, но занимает больше диска (индекс лежит в `vmail-index`). [ист.] https://docs.mailcow.email/manual-guides/Dovecot/u_e-dovecot-fts/. Если поиск по почте MailExpert делает сам или серверный IMAP SEARCH по телу не нужен, FTS можно выключить. Иначе оставить с `FTS_HEAP` 256-512. [вывод]
- `SKIP_SOGO=y` в самом `generate_config.sh` помечен как **«experimental, unsupported, not fully implemented»**. [ист.] generate_config.sh, строка с `SKIP_SOGO`. Потенциально это самая большая экономия (по документации до ~350 MiB на воркер и 20 воркеров по умолчанию [ист.] prerequisite-system), но в продакшне на неподдерживаемый режим я бы не опирался. SOGo без пользователей webmail/EAS занимает заметно меньше верхней границы. [вывод]
- Поддерживаемых облегчённых форков mailcow я не нашёл: в выдаче только личные форки без признаков сопровождения. [ист.] https://github.com/topics/mailcow

**Ресурсы на 500 ящиков.**
- Официальный минимум: 6 GiB RAM + 1 GiB swap, CPU 1 GHz, 20 GiB диска без почты. «8 GiB RAM are recommended for ~5 to 10 users». Пример: «15 phones (EAS enabled) and about 50 concurrent IMAP connections should plan 16 GiB». [ист.] https://docs.mailcow.email/getstarted/prerequisite-system/ (обновлено 2025-08-19)
- Наша оценка [вывод]: ClamAV выключен, EAS нет, SOGo почти простаивает, 500 IDLE с одного IP. Dovecot займёт 1-2 GB (раздел 1.2), MariaDB + Redis + Rspamd примерно 1.5-2 GB, SOGo 0.3-1 GB, остальное мелочь.
  - **Минимум 8 GiB, комфортно 12-16 GiB, 4 vCPU.** Диск SSD, объём = сумма реально используемых квот + 10-20% на индексы Dovecot (и больше, если включён Flatcurve) + место под бэкапы.

**Provisioning API.** Заголовок `X-API-Key`, ключи read-only и read-write. Ключ создаётся в UI или задаётся через `API_KEY` в `mailcow.conf`, **обязателен allowlist `API_ALLOW_FROM`**. [ист.] https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/api/openapi.yaml, generate_config.sh

| Операция | Вызов |
|---|---|
| Список доменов | `GET /api/v1/get/domain/all` (`/api/v1/get/domain/{id}`) |
| Ящики домена | `GET /api/v1/get/mailbox/all/{domain}`, `GET /api/v1/get/mailbox/{id}` |
| Создать ящик | `POST /api/v1/add/mailbox` `{local_part, domain, name, password, password2, quota, active:"1", force_pw_update:"0", tls_enforce_in, tls_enforce_out}` |
| Деактивировать | `POST /api/v1/edit/mailbox` `{items:["a@d"], attr:{active:"0"}}` или `active:"2"` |
| Реактивировать с новым паролем | `POST /api/v1/edit/mailbox` `{items:["a@d"], attr:{active:"1", password, password2}}` |
| Сменить пароль | тот же `edit/mailbox` с `password`/`password2` |
| DKIM | `POST /api/v1/add/dkim` |
| Relayhost | `POST /api/v1/add/relayhost` `{hostname, username, password}`, затем `POST /api/v1/edit/domain` `attr.relayhost=<id>` |
| TLS policy | `POST /api/v1/add/tls-policy-map` `{dest, policy:"encrypt", parameters}` |
| Forwarding hosts | `POST /api/v1/add/fwdhost` `{hostname, filter_spam}` |
| Whitelist бана | `POST /api/v1/edit/fail2ban` (`whitelist`) |

[ист.] openapi.yaml (все пути выше)

- Значения `active`: 0 = выключен; 1 = активен; **2 = «Disallow login (incoming mail is still accepted)»**. [ист.] https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/lang/lang.en-gb.json
  - Postfix берёт ящики запросом `... WHERE username='%s' AND (active = '1' OR active = '2')` [ист.] https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/postfix/postfix.sh. Отсюда: при `active=0` входящая почта отклоняется как для неизвестного получателя, при `active=2` почта продолжает приходить. [вывод] Какую семантику выбрать для «удаления» в MailExpert, решает продукт.
- Единицы `quota`: в примерах `3072`, по UI это MiB. [вывод, проверить на стенде]

**Совместимость с EOP.**
- Relayhost назначается per-domain: sender-dependent transports через `sender_dependent_default_transport_maps`. Логин и пароль опциональны («If the relay host requires a username and password...»), хранятся открытым текстом. [ист.] https://docs.mailcow.email/manual-guides/Postfix/u_e-postfix-relayhost/, https://github.com/mailcow/mailcow-dockerized/blob/master/data/conf/postfix/main.cf
  - Для EOP заводим relayhost `[tenant-com.mail.protection.outlook.com]:25` без логина и назначаем его каждому домену через API. Глобальный relayhost в UI не описан. Если нужен и для доменов вне mailcow, можно задать `relayhost` в `data/conf/postfix/extra.cf`. [вывод]
- TLS наружу: `smtp_tls_security_level = dane`. Для хостов без TLSA это оппортунистический TLS, поэтому к EOP TLS нужно **сделать обязательным** через `tls-policy-map` (`policy: encrypt` или `secure`). [ист. параметра: main.cf; вывод о поведении]
- **Клиентский сертификат** Postfix уже отдаёт: `smtp_tls_cert_file = /etc/ssl/mail/cert.pem`, `smtp_tls_key_file = /etc/ssl/mail/key.pem`. [ист.] main.cf. Поэтому в EOP можно сделать **certificate-based connector**, при условии что CN/SAN сертификата mailcow (hostname ноды) лежит в accepted domain тенанта. [ист. условия: office-365-notice; вывод о применимости]
  - Тогда NDR и пересылки наружу тоже пройдут. Для сравнения, Postfix + client cert в связке с M365 описан здесь: [ист.] https://zuba.dev/connecting-postfix-to-microsoft-365 (2022, устар.?)
- Входящая почта:
  - На firewall пускаем на TCP 25 только диапазоны EOP.
  - Эти же CIDR заносим в **Forwarding Hosts**: «Incoming messages are unconditionally accepted from any hosts listed here. These hosts are then not checked against DNSBLs or subjected to greylisting. Spam received from them is never rejected, but optionally it can be filed into the Junk folder.» [ист.] lang.en-gb.json
  - Неизвестные получатели отклоняются самим Postfix, потому что их нет в `virtual_mailbox_maps`. [вывод из postfix.sh]
  - Можно включить `tls_enforce_in` на ящиках, но TLS на входе проще гарантировать на стороне EOP, включив «Always use TLS» в connector.

**Лицензия и стоимость.** GPL-3.0, бесплатно. [ист.] https://github.com/mailcow/mailcow-dockerized. Коммерческая поддержка у Servercow, условия не проверял.

**Релизы.** Примерно раз в 1-2 месяца, плюс хотфиксы a/b/c.
- 2025: 01, 01a, 02, 03, 03a, 03b, 05, 07, 09, 09a, 09b, 09c, 10, 10a, 12, 12a.
- 2026: 01, 03, 03a, 03b, 05, 05a, 05b, 05c, 07, 07a, 07b, 09 (вышел 2026-09-21).
- 2026-07: Postfix 3.10.12, Rspamd 4.1.0. [ист.] https://github.com/mailcow/mailcow-dockerized/releases

**CVE 2025-2026** (все в PHP-UI/API, не в Postfix/Dovecot) [ист.] https://github.com/mailcow/mailcow-dockerized/security/advisories:
- CVE-2025-53909, critical 9.1: SSTI в шаблонах уведомлений о квоте и карантине, исправлено в 2025-07.
- CVE-2025-25198, high: password reset poisoning, исправлено в 2025-01a.
- CVE-2024-56529, high: session fixation, опубликовано 2025-01.
- 2026-04-16, пакет из 6 advisories, всё исправлено в 2026-03b: CVE-2026-40872 (critical, stored XSS в логах autodiscover), CVE-2026-40871 (high, second-order SQLi через API карантина), CVE-2026-40873 и CVE-2026-40875 (high, stored XSS), CVE-2026-40874 (medium, нет авторизации на удаление forwarding hosts), CVE-2026-40878 (low).
- 2026-05: security-релиз, CVE на момент релиза не раскрыт. [ист.] https://github.com/mailcow/mailcow-dockerized/releases/tag/2026-05
- Dovecot/Postfix-стек наследует общие CVE Dovecot 2025-2026: DoS до аутентификации, ManageSieve, LDAP injection и другие. [ист.] https://access.redhat.com/errata/RHSA-2026:19364, https://dovecot.org/security
- Вывод: **UI и API mailcow держать только во внутренней сети или VPN**. API закрыть `API_ALLOW_FROM` на IP MailExpert. Обновляться в течение нескольких дней после релиза. [вывод]

**Бэкапы.** `helper-scripts/backup_and_restore.sh` (vmail, crypt, redis, rspamd, postfix, mysql, all) работает на живой системе, поддерживает `THREADS`, `--delete-days` и `MAILCOW_BACKUP_LOCATION` для cron. Для консистентности рекомендуют снапшоты на целевом хранилище. [ист.] https://docs.mailcow.email/backup_restore/b_n_r-backup/. Обновление через `update.sh` [ист.: документация mailcow; сам скрипт не открывал].

**Итог.** По функциям подходит лучше всех. Платим весом и дисциплиной обновлений и изоляции UI.

### 3.2 Stalwart Mail Server

**Архитектура.** Один Rust-бинарник: SMTP, IMAP, JMAP, POP3, ManageSieve, CalDAV/CardDAV/WebDAV, собственный спам-фильтр (не Rspamd), без Postfix и Dovecot.
- Хранилище: RocksDB, PostgreSQL, MySQL, SQLite, FoundationDB; блобы в FS или S3. [ист.] https://stalw.art/compare/
- С 0.16 почти вся конфигурация хранится в БД как JMAP-объекты, на диске остаётся только маленький `config.json`. [ист.] https://github.com/stalwartlabs/stalwart/blob/main/UPGRADING/v0_16.md

**Зрелость на сентябрь 2026:**
- Текущая версия v0.16.23 (2026-09-21). Ветка 0.16 выпускает патчи примерно раз в неделю. 0.13 вышла в 2025-07, 0.14 в 2025-10, 0.15 в 2025-12, 0.16 в 2026-04-20. [ист.] https://github.com/stalwartlabs/stalwart/releases, https://github.com/stalwartlabs/stalwart/blob/main/CHANGELOG.md
- 0.16 — это «**multiple breaking changes**». REST API `/api/...` удалён целиком, управление перенесено на JMAP. Миграция идёт через Python-скрипт и recovery mode. [ист.] CHANGELOG, UPGRADING/v0_16.md, https://stalw.art/blog/stalwart-0-16/
- 1.0 в roadmap раньше обещали на первую половину 2026 [ист.] https://stalw.art/blog/roadmap/. Сейчас: «We expect to release Stalwart 1.0.0 this year, most likely around October». Главная задача 1.0 — финализировать схему БД. [ист.] https://stalw.art/blog/road-to-stalwart-1-0/ (2026-06-21)
- Вывод: если заходить сейчас, скорее всего предстоит ещё одна миграция 0.16 -> 1.0. После 1.0 обещают, что обновления перестанут требовать окна обслуживания. [вывод]

**Лицензия и стоимость.** AGPL-3.0-only плюс Stalwart Enterprise License (SELv1), файлы `LICENSES/AGPL-3.0-only.txt`, `LICENSES/LicenseRef-SEL.txt`. [ист.] https://github.com/stalwartlabs/stalwart/tree/main/LICENSES
- **Только в Enterprise**: мультитенантность, per-domain directory backends, брендинг, **account archiving and un-deletion**, восстановление удалённых писем, AI/LLM-классификатор спама, SCIM, read replicas, sharded stores, live telemetry, история доставки, дашборды и алерты. [ист.] https://stalw.art/compare/
- Цена Enterprise: 25-499 ящиков по €2.00 (USD 2.40) за ящик в год, 500-999 по €1.70. На 500 ящиков около **€1000/год**. От 150 ящиков включён Premium Support (ответ в течение 48 часов). После отмены подписки сервер откатывается в Community без потери данных. [ист.] https://stalw.art/pricing/
- Для нашей задачи достаточно Community. [вывод]

**Ресурсы.**
- В простое около 100 MB. Для 5-10 пользователей хватает 1 GB. По умолчанию 8192 соединения. [ист.] https://stalw.art/docs/install/requirements/
- Одна нода рассчитана на «10,000 and 50,000 active mailboxes». [ист.] https://stalw.art/docs/cluster/deployment/sizing/
- Оценка на 500 ящиков и 500 IDLE: **2-4 GiB RAM, 2-4 vCPU**, диск = почта + индекс FTS. Если backend PostgreSQL, отдельный экземпляр PG, а не общий с MailExpert. [вывод]

**Provisioning API (0.16, JMAP).**
- Все операции идут через `POST` на JMAP endpoint с `using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"]`. [ист.] https://stalw.art/docs/ref/object/account/
- В UPGRADING сказано «reachable at `/jmap`», а curl-примеры в reference шлют запросы на `https://mail.example.com/api`. **Расхождение**: адрес надо проверить на живом инстансе. [ист. обоих; вывод о расхождении]
- Аутентификация: `Authorization: Bearer <OAuth token>` или `Basic`. [ист.] https://stalw.art/docs/development/api/
  - Есть API keys с ограниченными правами, IP-ограничениями и сроком действия. [ист.] CHANGELOG 0.16.0
  - Как именно предъявлять API key (Bearer или Basic), не проверял. [не проверено]

| Операция | Вызов |
|---|---|
| Список доменов | `x:Domain/query` + `x:Domain/get` (у Domain есть `name`, `isEnabled`, `dkimManagement`, `catchAllAddress`) [ист.] https://stalw.art/docs/ref/object/domain/ |
| Создать ящик | `x:Account/set create` `{"@type":"User", name:<local part>, domainId, credentials, quotas, roles:{"@type":"User"}, permissions:{"@type":"Inherit"}, ...}`, требует `sysAccountCreate` [ист.] account |
| Display name | поле `description` [вывод: отдельного поля displayName нет] |
| Пароль | элемент `credentials` типа `Password` (`secret`, `expiresAt`, `allowedIps`) [ист.] account |
| Квота | `quotas: {"maxDiskQuota": <bytes>}` [ист.] account |
| Сменить пароль админом | `x:Account/set update` с новым `credentials` [вывод]. Синглтон `x:AccountPassword` предназначен для self-service и требует `currentSecret` [ист.] https://stalw.art/docs/ref/object/account-password/ |
| Деактивировать | **флага enabled/disabled у Account нет** [ист.] account. Обходной путь: `permissions: {"@type":"Merge","enabledPermissions":{},"disabledPermissions":{"authenticate":true,"imapAuthenticate":true}}` (разрешения `authenticate`, `imapAuthenticate` и др.) [ист. разрешений] https://stalw.art/docs/ref/permissions/ [вывод о применимости]. `Set<T>` в JMAP Stalwart кодируется объектом `{значение: true}`, ср. `scanBanPaths` [ист.] https://stalw.art/docs/ref/object/security/ [вывод о кодировке]. Второй вариант: `expiresAt` на credential [вывод]. Архивирование аккаунтов только в Enterprise [ист.] compare |
| Реактивировать | вернуть `permissions: {"@type":"Inherit"}` и записать новый `credentials` [вывод] |

- Важная деталь для пересоздания: в 0.16.0 исправлен баг «Recreated account cannot log in until server is restarted (#1469)». [ист.] CHANGELOG. Сценарий реактивации надо прогнать в тестах. [вывод]
- Полезная возможность: `allowedIps` на Password credential позволяет привязать пароль ящика к IP MailExpert. Украденный пароль не сработает с другого адреса. [ист. поля; вывод о применении]

**Совместимость с EOP.**
- Smarthost: `MtaRoute` с `@type: "Relay"` (`address`, `port`, `authUsername`, `authSecret` может быть None, `implicitTls`, `allowInvalidCerts`). [ист.] https://stalw.art/docs/ref/object/mta-route/
  - Маршрут выбирается выражением `MtaOutboundStrategy.route`, где доступны `sender_domain` и `rcpt_domain`. Значит, relay можно разводить глобально или по доменам отправителя. [ист.] https://stalw.art/docs/ref/object/mta-outbound-strategy/, https://stalw.art/docs/ref/expression/variable/mta-queue-rcpt-variable/
  - Для обязательного TLS: `MtaTlsStrategy.startTls = "require"`. [ист.] https://stalw.art/docs/ref/object/mta-tls-strategy/
- **Клиентского сертификата для исходящего SMTP нет**: issue «SMTP Client Certificate (for the stalwart smtp client)» #277 открыт с 2024-03-04, прямо про relay в M365. [ист.] https://github.com/stalwartlabs/stalwart/issues/277
  - В reference `MtaRoute` и `MtaTlsStrategy` полей под клиентский сертификат тоже нет. [ист.: страницы выше]
  - Следствие: в EOP только **IP-based connector**. Обычная почта от наших accepted domains пройдёт. NDR, сгенерированные нодой, и пересылки наружу получат `550 5.7.64`. [вывод из office-365-notice]
- Неизвестные получатели отклоняются, если не задан `catchAllAddress` («When catchAllAddress is left unset, messages to unknown local recipients are rejected»). [ист.] https://stalw.art/docs/mta/inbound/rcpt/
- Приём только от EOP ограничиваем firewall'ом. Проверки SPF/DMARC/DNSBL встроенного спам-фильтра для IP EOP нужно отключить или ослабить выражениями. Как именно это сделать, не проверял. [вывод]
- DKIM: автоматическая генерация, ротация и DNS-управление появились в 0.16 и в changelog не помечены как Enterprise. [ист.] CHANGELOG 0.16.0

**Безопасность** (Rust, memory-safe; в таблице compare есть строка «Independent security audit», но сам отчёт аудита я не открывал) [ист.] https://stalw.art/compare/:
- CVE-2025-59045 (high, OOM через раскрытие повторений CalDAV, исправлено в 0.13.3).
- CVE-2025-61600 (high, неограниченная аллокация в IMAP-парсере, исправлено в 0.13.4).
- CVE-2026-26312 (medium, OOM на циклических MIME, исправлено в 0.15.5).
- [ист.] https://github.com/stalwartlabs/stalwart/security/advisories
- В changelog 0.16.x без CVE также есть: утечка id чужих объектов через JMAP `*/changes`, неверная привилегия в DAV REPORT, «OIDC: JWKS Exposes Symmetric Signing Key». [ист.] CHANGELOG
- Итого три опубликованные CVE, все класса DoS. RCE и обходов аутентификации среди них нет.

**Бэкапы.**
- Встроенный export/import предназначен для миграции между backend'ами: «must be stopped», «not a substitute for proper backup procedures». Для штатных бэкапов советуют нативные инструменты backend'а. [ист.] https://stalw.art/docs/management/maintenance/migration/
- Практически: PostgreSQL (pg_dump/PITR) плюс бэкап blob-хранилища, либо снапшоты тома с RocksDB. [вывод]

**Итог.** Технически это лучший движок для 500 IDLE с одного IP. Но по стабильности API и схемы, отсутствию disable-флага и клиентского сертификата для EOP сегодня он уступает mailcow.

### 3.3 Mailu

**Архитектура.** Docker Compose: nginx `front` (терминирует TLS и проксирует IMAP/SMTP), admin (Flask), Postfix, Dovecot, Rspamd, опционально ClamAV и webmail. Лицензия MIT. [ист.] https://github.com/Mailu/Mailu/blob/master/LICENSE.md
- Dovecot работает в high-performance login-режиме: `service_count=0`, `client_limit=25000`, `mail_max_userip_connections = 20`. [ист.] https://github.com/Mailu/Mailu/blob/2024.06/core/dovecot/conf/dovecot.conf
- В nginx `worker_connections 1024` на воркер (`worker_processes auto`). Каждое проксируемое IMAP-соединение занимает два соединения nginx, так что на 500 IDLE при двух и более CPU запаса хватает, но впритык. [ист. параметров] https://github.com/Mailu/Mailu/blob/2024.06/core/nginx/conf/nginx.conf [вывод о запасе]

**Ресурсы.** С ClamAV 3 GB RAM + 1 GB swap, без ClamAV 1 GB + 1 GB swap. [ист.] https://mailu.io/2024.06/compose/requirements.html. На 500 ящиков реалистично 4-8 GiB и 2-4 vCPU. [вывод]

**API.** Включается `API=true`, `WEB_API=/api`, `API_TOKEN=...`. Заголовок `Authorization: Bearer <token>`. Swagger лежит на `/api/v1/swagger.json`. [ист.] https://mailu.io/2024.06/api.html, https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/api/common.py, https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/api/v1/__init__.py
- `GET /api/v1/domain`, `GET /api/v1/domain/<domain>`, `GET /api/v1/domain/<domain>/users`.
- **DKIM per domain**: `POST /api/v1/domain/<domain>/dkim` генерирует и сохраняет ключ, в ответах по домену есть поле `dns_dkim`. [ист.] https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/api/v1/domain.py
- `GET/POST /api/v1/user`. POST принимает `{email, raw_password, displayed_name, comment, quota_bytes, enabled, enable_imap, ...}`.
- `GET/PATCH/DELETE /api/v1/user/<email>`. [ист.] https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/api/v1/user.py
- Деактивация: `PATCH {enabled:false}`. Описание поля: «When an user is disabled, the user is unable to login to the Admin GUI or webmail or access his email via IMAP/POP3 or send mail». [ист.] user.py
  - Postfix-map ящиков `enabled` не проверяет, поэтому отключённый ящик **продолжает получать почту**. [вывод из кода] https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/internal/views/postfix.py
- Реактивация: `PATCH {enabled:true, raw_password}`. Пароль меняется через `PATCH {raw_password}`.

**EOP.**
- Только глобальный `RELAYHOST` / `RELAYUSER` / `RELAYPASSWORD`. [ист.] https://mailu.io/2024.06/configuration.html. Per-domain relay штатно нет, только через Postfix overrides. [вывод]
- В `main.cf` нет `smtp_tls_cert_file`, значит без override клиентского сертификата нет и остаётся IP-based connector. [вывод из grep] https://github.com/Mailu/Mailu/blob/2024.06/core/postfix/conf/main.cf
- Лимит логинов с IP 5/hour по умолчанию, нужен `AUTH_RATELIMIT_EXEMPTION` (раздел 1.3).

**Релизы и безопасность.**
- Мажорного релиза не было с 2024.06, выходят только патчи 2024.06.x (последний 2024.06.58 от 2026-08-12). [ист.] https://github.com/Mailu/Mailu/releases
- Мейнтейнер в январе 2025: «We have little to nothing on our master branch that would warrant one». [ист.] https://github.com/Mailu/Mailu/discussions/3700
- CVE-2026-85751, critical 9.8: обход аутентификации в header-based proxy auth через подделываемый `X-Forwarded-By`, исправлено в 2024.06.55.
- CVE-2026-49217, high 7.5: `PATCH /api/v1/token/<id>` без аутентификации снимает IP-ограничения токена, исправлено в 2024.06.52.
- [ист.] https://github.com/Mailu/Mailu/security/advisories

**Бэкапы.** Отдельного инструмента нет. Всё хранится в файлах (`data`, `dkim`, `mail` и т.д.), переносится rsync'ом. [ист.] https://mailu.io/2024.06/maintain.html

**Итог.** Жизнеспособно и легче mailcow, но по EOP (relay по доменам, клиентский сертификат) придётся дописывать overrides, а развитие проекта фактически заморожено на 2024.06.

### 3.4 Modoboa

**Архитектура.** Django-админка плюс Postfix, Dovecot, Amavis (SpamAssassin + ClamAV) или Rspamd, OpenDKIM, Radicale. Ставится `modoboa-installer` на Debian 12+ / Ubuntu 20.04+, **без Docker**. Для сборки зависимостей нужно минимум 2 GB RAM. Лицензия ISC. [ист.] https://github.com/modoboa/modoboa-installer/blob/master/README.rst

**API (DRF).** `Authorization: Token <key>` (DRF TokenAuthentication) или OAuth2. [ист.] https://github.com/modoboa/modoboa/blob/master/modoboa/core/commands/templates/settings.py.tpl (`DEFAULT_AUTHENTICATION_CLASSES`), https://github.com/modoboa/modoboa/blob/master/modoboa/admin/api/v2/urls.py
- Роутер v2: `/api/v2/domains/`, `/api/v2/accounts/`, `/api/v2/aliases/`, `/api/v2/identities/` и т.д.
- Аккаунт: поля `username`, `first_name`, `last_name`, `is_active`, `role`, `mailbox{quota, use_domain_quota}`, `password` (write-only), `random_password`. [ист.] https://github.com/modoboa/modoboa/blob/master/modoboa/admin/api/v1/serializers.py
- Деактивация через `PATCH is_active=false` [вывод из ModelSerializer/ViewSet]. Проверяют ли Postfix и Dovecot `is_active`, не смотрел. [не проверено]
- Смена пароля: в v1 есть `/api/v1/accounts/{pk}/password/`. [ист.] https://github.com/modoboa/modoboa/blob/master/modoboa/admin/api/v1/viewsets.py

**EOP.** Relayhost и per-domain relay настраиваются руками в Postfix, штатного управления нет. [вывод]

**Релизы и безопасность.**
- Примерно ежемесячно: 2.4.0 (2025-07), дальше до 2.10.1 (2026-09-17). [ист.] https://github.com/modoboa/modoboa/releases
- CVE-2026-27602, high 7.2: OS command injection в версиях ≤2.7.0, исправлено в 2.7.1. [ист.] https://github.com/modoboa/modoboa/security/advisories/GHSA-wwv8-cqpr-vx3m

**Бэкапы.** `./run.py --silent-backup`, restore помечен как «experimental». [ист.] README установщика

**Итог.** API приличный, но нода «на голой ОС» с ручным Postfix: нагрузка на администрирование выше, а по EOP выигрыша перед mailcow нет. [вывод]

---

## 4. Сводная таблица

| | mailcow | Stalwart | Mailu | Modoboa | DMS | Mox | Poste.io | iRedMail | Carbonio CE |
|---|---|---|---|---|---|---|---|---|---|
| Стек | Postfix+Dovecot+Rspamd, Docker | свой Rust, один бинарник | Postfix+Dovecot+Rspamd, Docker | Postfix+Dovecot, bare OS | Postfix+Dovecot, 1 контейнер | свой Go | Haraka+Dovecot+Rspamd, 1 контейнер | Postfix+Dovecot, bare OS | Java/Zimbra |
| HTTP API ящиков | да, полный | да, JMAP (с 0.16) | да | да | **нет** | только внутренний sherpa | да (и в FREE) | только Pro | SOAP |
| Disable/enable | `active` 0/1/2 | нет флага, обход через permissions | `enabled` | `is_active` | нет | `LoginDisabled` | вероятно, не проверено | `accountStatus` (Pro) | есть (не проверял) |
| Relay по доменам | да, API | да, выражения | нет (только глобальный) | вручную Postfix | да, CLI | да, Routes | не проверял | вручную | н/д |
| Клиентский cert к EOP | **да, по умолчанию** | **нет (#277)** | нет по умолчанию | вручную Postfix | нет по умолчанию | не проверял | не проверял | вручную | н/д |
| RAM на 500 ящиков [вывод] | 8-16 GiB | 2-4 GiB | 4-8 GiB | 4-8 GiB | 4-8 GiB | нет данных | нет данных | нет данных | ≥16 GiB [ист.] |
| Лицензия | GPL-3.0 | AGPL-3.0 / Enterprise | MIT | ISC | MIT | MIT | закрытая | GPL / Pro $499 | AGPL-вариант CE |
| Релизы | 1-2 мес. | еженедельно, до 1.0 | патчи 2024.06.x | ежемесячно | мажор раз в год | редко | ежемесячно | не проверял | не проверял |
| CVE 2025-26 | много (UI) | 3 DoS | 2 (critical, high) | 1 high | нет GHSA | фиксы в релизе | фиксы в changelog | не проверял | не проверял |

Про лицензию iRedMail и Carbonio CE я лицензионные тексты не открывал; пометки в таблице сделаны по памяти. [не проверено]

---

## 5. Рекомендация

**Выбор: mailcow-dockerized.**

Какой критерий решает. Требования по RAM выполняют все, кроме Carbonio: 500 IDLE помещаются даже в 8 GiB на Dovecot. Разница между кандидатами в двух вещах: (а) стабильный и полный API для нашего жизненного цикла ящика; (б) полнота интеграции с EOP (certificate-based connector, relay по доменам, обязательный TLS, отключение DNSBL и greylisting для IP EOP). mailcow закрывает оба пункта готовыми средствами через API. Stalwart закрывает (б) только частично и живёт до 1.0 с ломающими изменениями.

**Жёсткие условия развёртывания mailcow** [вывод]:
1. UI и API mailcow недоступны из интернета: только VPN или внутренняя сеть. `API_ALLOW_FROM` = IP MailExpert. Причина: история CVE в UI из раздела 3.1.
2. На firewall TCP 25 открыт только для диапазонов EOP (ID 10), и эти же CIDR добавлены в Forwarding Hosts (обязательно `filter_spam: 1`, иначе rspamd не проверяет их почту на спам). Submission (587/465) и IMAP (993) открыты только для IP MailExpert. Если пользователям нужен прямой доступ к почте, это отдельное решение.
3. `SKIP_CLAMD=y`. `SKIP_FTS` включать по тому, нужен ли серверный поиск по телу. SOGo оставить, `SKIP_SOGO` не поддерживается.
4. EOP:
   - Общий `relayhost = <EOP_HOST>` в `extra.cf` (голое имя без скобок и порта; `<EOP_HOST>` — значение MX домена из тенанта, у каждого домена своё, для новых доменов в зоне `*.mx.microsoft`). `add/transport "*"` не использовать: он заворачивает в EOP и почту собственных доменов узла. Подробно — [eop-panel-requirements.md](eop-panel-requirements.md), раздел 2.
   - `tls-policy-map` на тот же `<EOP_HOST>` дословно, с `secure`/`encrypt` и `active: 1`.
   - В терминах Microsoft: Inbound connector (узел -> EOP) по сертификату, домен из SAN сертификата узла должен быть accepted domain тенанта; Outbound connector (EOP -> узел) с обязательным TLS и проверкой сертификата. В ранних документах направления были названы наоборот.
5. IP MailExpert в whitelist netfilter. В MailExpert: backoff при ошибке аутентификации, ограничение параллельных переподключений (imap `process_limit` 1024, лимит соединений Postfix submission 50 с одного IP).
6. Сценарий «удалить» в MailExpert = `active:"0"` (или `"2"`, если почту нужно продолжать принимать). «Пересоздать» = `edit/mailbox` с `active:"1"` и новым паролем.
7. Бэкапы: `backup_and_restore.sh all` по cron на отдельный том со снапшотами. Обновления в течение недели после релиза. Подписка на GitHub Security Advisories mailcow.
8. Размер: 4 vCPU, 12-16 GiB RAM (минимум 8), SSD под почту + 20-30% запаса. Нагрузку снять на стенде: 500 IDLE с одного IP (RSS Dovecot, число imap-процессов).

**Запасной вариант: Stalwart Community.** Переоценить после 1.0 (ожидается около октября 2026) и после закрытия issue #277. Отрыв mailcow условный. Минус #277 существенен, только если нам нужен certificate-based connector. IP-based connector вполне законный выбор, если нода не шлёт NDR и пересылки наружу. А 1.0 может выйти уже через 4-6 недель. **Если решение можно отложить до Q4 2026 или IP-based connector нас устраивает, стоит дождаться Stalwart 1.0 и повторить оценку до того, как окончательно выбрать mailcow.** [вывод] Если #277 закроют, а у аккаунта появится disable-флаг (или обход через `disabledPermissions: ["authenticate"]` пройдёт тесты), Stalwart станет лучшим выбором: на порядок меньше RAM, один бинарник, API keys с IP-ограничениями, лимит соединений на пользователя вместо ограничений по IP. Если нужны архивирование аккаунтов и Premium Support, Enterprise на 500 ящиков стоит около €1000/год.

**Что проверить на стенде до решения:**
- mailcow: единицы `quota`; поведение `active:"0"` для входящей почты от EOP; отдаёт ли Postfix client cert при relay через sender-dependent transport; валидация certificate-based connector в EOP.
- Stalwart: реальный JMAP endpoint (`/jmap` или `/api`); как предъявлять API key; блокирует ли `disabledPermissions: ["authenticate"]` IMAP и SMTP AUTH при сохранении доставки; реактивация без рестарта (регрессия #1469).
- EOP: актуальный smarthost-адрес тенанта (`*.mail.protection.outlook.com` или `*.mx.microsoft`); лицензирование ящиков в EOP.

---

## 6. Источники (сводно)

Microsoft / EOP:
- https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/set-up-connectors-to-route-mail
- https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/office-365-notice
- https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
- https://endpoints.office.com/endpoints/worldwide?ServiceAreas=Exchange&clientrequestid=b10c5ed1-bad1-445f-b386-b919946339a7
- https://zuba.dev/connecting-postfix-to-microsoft-365 (2022)

Dovecot:
- https://doc.dovecot.org/2.3/settings/core/
- https://doc.dovecot.org/2.3/admin_manual/login_processes/
- https://doc.dovecot.org/2.3/configuration_manual/service_configuration/
- https://doc.dovecot.org/2.3/configuration_manual/hibernation/
- https://dovecot.org/list/dovecot/2017-February/107029.html (2017)
- https://dovecot.org/list/dovecot/2017-April/107667.html (2017)
- https://access.redhat.com/errata/RHSA-2026:19364
- https://dovecot.org/security

mailcow:
- https://docs.mailcow.email/getstarted/prerequisite-system/
- https://docs.mailcow.email/manual-guides/Dovecot/u_e-dovecot-fts/
- https://docs.mailcow.email/manual-guides/Postfix/u_e-postfix-relayhost/
- https://docs.mailcow.email/backup_restore/b_n_r-backup/
- https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/api/openapi.yaml
- https://github.com/mailcow/mailcow-dockerized/blob/master/generate_config.sh
- https://github.com/mailcow/mailcow-dockerized/blob/master/data/conf/dovecot/dovecot.conf
- https://github.com/mailcow/mailcow-dockerized/blob/master/data/conf/postfix/main.cf
- https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/postfix/postfix.sh
- https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/lang/lang.en-gb.json
- https://github.com/mailcow/mailcow-dockerized/releases
- https://github.com/mailcow/mailcow-dockerized/security/advisories
- https://docs.clamav.net/manual/Installing/Docker.html

Stalwart:
- https://github.com/stalwartlabs/stalwart/blob/main/CHANGELOG.md
- https://github.com/stalwartlabs/stalwart/blob/main/UPGRADING/v0_16.md
- https://github.com/stalwartlabs/stalwart/issues/277
- https://github.com/stalwartlabs/stalwart/security/advisories
- https://stalw.art/compare/
- https://stalw.art/pricing/
- https://stalw.art/blog/stalwart-0-16/
- https://stalw.art/blog/road-to-stalwart-1-0/
- https://stalw.art/blog/roadmap/
- https://stalw.art/docs/ref/object/account/
- https://stalw.art/docs/ref/object/account-password/
- https://stalw.art/docs/ref/object/domain/
- https://stalw.art/docs/ref/permissions/
- https://stalw.art/docs/ref/object/mta-route/
- https://stalw.art/docs/ref/object/mta-outbound-strategy/
- https://stalw.art/docs/ref/object/mta-tls-strategy/
- https://stalw.art/docs/ref/expression/variable/mta-queue-rcpt-variable/
- https://stalw.art/docs/ref/object/imap/
- https://stalw.art/docs/ref/object/security/
- https://stalw.art/docs/ref/object/allowed-ip/
- https://stalw.art/docs/email/settings/ratelimit/
- https://stalw.art/docs/install/requirements/
- https://stalw.art/docs/cluster/deployment/sizing/
- https://stalw.art/docs/development/api/
- https://stalw.art/docs/mta/inbound/rcpt/
- https://stalw.art/docs/management/maintenance/migration/

Mailu:
- https://mailu.io/2024.06/api.html
- https://mailu.io/2024.06/configuration.html
- https://mailu.io/2024.06/compose/requirements.html
- https://mailu.io/2024.06/maintain.html
- https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/api/v1/user.py
- https://github.com/Mailu/Mailu/blob/2024.06/core/admin/mailu/internal/views/postfix.py
- https://github.com/Mailu/Mailu/discussions/3700
- https://github.com/Mailu/Mailu/security/advisories

Остальные:
- https://github.com/docker-mailserver/docker-mailserver/blob/master/target/bin/setup
- https://docker-mailserver.github.io/docker-mailserver/latest/config/account-management/overview/
- https://docker-mailserver.github.io/docker-mailserver/latest/config/advanced/mail-forwarding/relay-hosts/
- https://github.com/docker-mailserver/docker-mailserver/blob/master/CHANGELOG.md
- https://github.com/mjl-/mox/blob/main/webadmin/api.json
- https://github.com/mjl-/mox/releases
- https://www.xmox.nl/features/
- https://github.com/modoboa/modoboa-installer/blob/master/README.rst
- https://github.com/modoboa/modoboa/tree/master/modoboa/admin/api
- https://github.com/modoboa/modoboa/security/advisories/GHSA-wwv8-cqpr-vx3m
- https://docs.iredmail.org/iredadmin-pro.restful.api.html
- https://www.iredmail.org/pricing.html
- https://poste.io/order, https://poste.io/doc/license, https://poste.io/doc/mailserver-parts, https://poste.io/changelog
- https://github.com/tormjens/posteio-php
- https://docs.zextras.com/carbonio-ce/html/install/requirements.html
- https://forums.zimbra.org/viewtopic.php?t=72645&start=50
