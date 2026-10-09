# Порты и направления соединений

Карта всех модулей MailExpert для настройки сетевого экрана, проверки конфликтов портов и передачи
проекта. Проверена по исходникам 2026-10-05. Номер в таблице — **порт назначения**, а не исходящий
временный порт клиента. Stateful-файрвол разрешает ответный трафик по состоянию соединения;
для stateless-фильтра провайдера нужны отдельные правила ответов, включая временные порты DNS.

«Внутри Docker» означает соединение между контейнерами одной установки без публикации на хосте;
`127.0.0.1` — только на соответствующем хосте. Опубликованный Docker-порт и разрешённый файрволом
порт — разные вещи. Для узла правила `DOCKER-USER` применяются после DNAT, к порту контейнера.
Названия `<PANEL_HOST>`, `<APP_HOST>`, `<MAIL_HOST>`, `<PANEL_IP>` — плейсхолдеры из
[руководства эксплуатации](README.md).

## 1. Панель в production

Установка скриптами использует [базовый compose](../../docker-compose.yml) вместе с
[production overlay](../../deploy/compose.prod.yml). Периметр — отдельный проект
[edge](../../deploy/edge/compose.yml). Его Caddy и cloudflared работают в сети хоста.

| Модуль / соединение | Порт / протокол | Направление и доступность | Настройка / условие |
|---|---|---|---|
| Браузер → Caddy → панель | 443 TCP | Входящий на `<PANEL_HOST>` из браузера | `direct` / `both`; TLS, API, OAuth, WebSocket `/ws`, SSE на одном порту |
| Caddy, HTTP → HTTPS | 80 TCP | Входящий на `<PANEL_HOST>` | `direct` / `both`; перенаправление HTTP |
| Caddy, HTTP/3 | 443 UDP | Входящий на `<PANEL_HOST>` | `direct` / `both`; необязателен для HTTP/1.1 и HTTP/2 |
| Caddy или cloudflared → frontend nginx | 8080 TCP → 80 TCP | `127.0.0.1:8080` хоста → контейнер | `install.sh --http-port` меняет `APP_HTTP_PORT`; порт, занятый не своей панелью, останавливает `install.sh` до запуска; не открывать наружу |
| frontend nginx → backend | 3000 TCP | Внутри Docker | `PORT=3000` в compose; при ручном изменении нужен согласованный upstream nginx |
| backend → PostgreSQL | 5432 TCP | Внутри Docker | `DB_HOST` / `DB_PORT`; штатная установка использует свой контейнер |
| backend → Redis | 6379 TCP | Внутри Docker | `REDIS_URL`; без публикации на хосте |
| backend → tenant-worker | 8080 TCP | Внутри Docker, профиль `tenant` | `TENANT_WORKER_URL=http://tenant-worker:8080`; опциональный модуль |
| cloudflared → сеть Cloudflare | 7844 UDP / TCP | Исходящий с `<PANEL_HOST>` | QUIC / HTTP2; `cf` / `both`, разрешить оба для выбора протокола и переключения |
| Браузер → Cloudflare Access / Tunnel | 443 TCP | Исходящий с машины пользователя к Cloudflare | `cf` / `both`; туннель не требует входящего 443 на сервер панели |
| Администратор → SSH | Обычно 22 TCP | Входящий на `<PANEL_HOST>` от администратора | Фактический порт SSH; установщик учитывает слушающие порты и SSH socket activation |
| cloudflared, метрики | 20241–20245 TCP, первый свободный; при занятости всех — случайный | HTTP listener процесса в сети хоста | В контейнере vendor default — `0.0.0.0`; не открывать публике, это не вход туннеля |

Установщик разрешает SSH и, при наличии Caddy, `80/tcp`, `443/tcp`, `443/udp`; другие входящие
соединения UFW запрещает. В режиме `cf` входящие HTTP/HTTPS на сервере не нужны. Docker может
обходить правила UFW для опубликованных портов, поэтому production frontend привязан именно к
loopback. Внутренний HTTPS listener nginx `443/tcp` существует, но production overlay его на хост
не публикует. Caddy admin API отключён (`admin off`), отдельный порт управления не требуется.

Источники: [генерация параметров и правил UFW](../../scripts/deploy/lib/config.sh),
[применение UFW](../../scripts/deploy/lib/system.sh),
[nginx](../../frontend/nginx.conf), [edge Caddyfile](../../deploy/edge/Caddyfile.tmpl),
[tenant-worker](../../deploy/tenant-worker/server.mjs),
[Cloudflare: firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/),
[Cloudflare: метрики](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/).
В compose адрес метрик не переопределён; для конкретного запуска его проверяют отдельно.

## 2. Исходящие подключения панели, worker и хоста

| Кто → куда | Порт / протокол | Обязательность / настройка |
|---|---|---|
| Хост / контейнеры → DNS resolver | 53 UDP и TCP | Разрешение имён; TCP нужен в том числе для больших ответов. Docker DNS `127.0.0.11:53` — внутренний resolver, не публичный сервер |
| backend → внешний IMAP | 993 TCP (TLS), 143 TCP (STARTTLS) | По подключённым ящикам; по умолчанию 993 |
| backend → внешний SMTP | 587 TCP (STARTTLS), 465 TCP (TLS) | По подключённым ящикам; по умолчанию 587 |
| backend → Google / Microsoft OAuth, Gmail API, Graph, Cloudflare Access | 443 TCP | По включённым способам входа и подключения ящиков |
| tenant-worker → Entra, Exchange Online, Graph | 443 TCP | Живой tenant driver; сертификат и PowerShell не требуют входящего порта на worker |
| Caddy → Cloudflare DNS API / ACME | 443 TCP | Выпуск и продление сертификата direct-входа через DNS-01; входящий 53 не нужен |
| Хост → GitHub, GHCR, реестры образов, репозитории ОС | 443 TCP; 80 TCP для HTTP-репозиториев | Установка, обновление, загрузка образов и пакетов; зависит от URL репозитория |
| restic панели / узла → S3 endpoint | 443 TCP по умолчанию HTTPS | Опциональный бэкап; явный порт в `RESTIC_REPOSITORY` заменяет default, входящего listener нет |
| backend / хост → AI, Web Push, мониторинг, уведомления | Обычно 443 TCP для HTTPS URL | По включённым интеграциям; использовать порт фактического endpoint, а не открывать новый порт панели |
| Системные уведомления → SMTP provider | Порт из настроек SMTP | Опционально; это исходящее соединение, а не собственный SMTP-сервер панели |

Для внешних ящиков хосты и порты задаются в настройках аккаунта (`imap_host`, `imap_port`,
`smtp_host`, `smtp_port`). Стандартная политика разрешает IMAP 143/993 и SMTP 465/587;
нестандартные порты зависят от политики сети установки. HTTPS URL интеграции или S3 с явным портом
требует исходящего доступа именно к этому порту. Это не меняет listener backend или edge.

Источники: [аккаунты и допустимые порты](../../backend/src/routes/accounts.js),
[IMAP](../../backend/src/services/imapManager.js), [SMTP](../../backend/src/services/smtpTransport.js),
[Gmail API](../../backend/src/services/gmailApiSender.js),
[tenant runner](../../deploy/tenant-worker/runner.ps1),
[DNS-проверки узла](../../backend/src/services/mailNode/dnsCheck.js),
[restic URL](../../scripts/deploy/lib/backup.sh),
[AI HTTP](../../backend/src/services/aiHttp.js),
[Web Push](../../backend/src/services/pushNotifications.js).

Плагины (включая GTD), очередь jobs, IMAP/pollers, delivery status и журналы работают в backend;
новых listener-портов у них нет. CLI работает через процесс/контейнеры установки. Запрос обновления
из панели передаётся host updater файлом spool; systemd timers/path, backup/restore/rollback и
healthcheck не создают сетевых серверов. Desktop/Android-клиенты обращаются к настроенному URL
панели; desktop также проверяет релизы через GitHub HTTPS, отдельный входящий порт им не нужен.
Источники: [composition root](../../backend/src/index.js),
[spool](../../backend/src/services/panelUpdate/spool.js),
[CLI](../architecture/panel-cli.md), [desktop](../../frontend/packages/electron/main.cjs).

## 3. Почтовый узел mailcow и Microsoft EOP

| Соединение | Порт / протокол | Направление / ограничение | Настройка / условие |
|---|---|---|---|
| EOP → Postfix узла | 25 TCP, SMTP STARTTLS | Входящий на `<MAIL_HOST>`, только актуальные диапазоны EOP | `SMTP_PORT`, default 25; диапазоны обновляет `eop-ranges.sh` |
| Postfix узла → EOP | 25 TCP, SMTP STARTTLS | Исходящий с узла к endpoint тенанта | Relay через EOP; провайдер VPS должен разрешать исходящий 25 |
| backend → IMAPS узла | 993 TCP, TLS | Панель → узел, разрешены только IP панели | `IMAPS_PORT`, default 993 |
| backend → submission узла | 587 TCP, STARTTLS | Панель → узел, разрешены только IP панели | `SUBMISSION_PORT`, default 587 |
| backend / администратор → API / web mailcow | 443 TCP, HTTPS | Панель / администратор → узел | `HTTPS_PORT` / `HTTPS_BIND` у mailcow; панель использует `https://<MAIL_HOST>/api/v1` |
| ACME HTTP-01 → nginx узла | 80 TCP | Входящий на узел при штатном HTTP-01 | `HTTP_PORT` / `HTTP_BIND`; при другом способе выпуска сертификата условие меняется |
| POP3, IMAP без TLS, SMTPS, POP3S, ManageSieve узла | 110, 143, 465, 995, 4190 TCP | Входящий к контейнерам **запрещён** правилами MailExpert | Mailcow может публиковать их; это не список разрешённых портов |
| Администратор → SSH узла | Обычно 22 TCP | Входящий от администратора | Порт фактического SSH daemon; правила почтового узла не заменяют защиту SSH |
| Узел → DNS | 53 UDP и TCP | Исходящий; Unbound выполняет рекурсивные запросы | Внутри mailcow DNS тоже 53, без публичной публикации |
| Узел → Microsoft endpoints API | 443 TCP | Исходящий | Получение актуальных диапазонов EOP |
| Узел → ACME, обновления, базы антиспама/антивируса, S3, мониторинг | Обычно 443 TCP; 80 TCP по URL сервисов | Исходящий, по включённым компонентам | Антивирус/антиспам и другие upstream-компоненты сверять с выбранной версией mailcow |
| Clamd → Sanesecurity | 873 TCP | Исходящий, rsync сигнатур | При включённом ClamAV; `rsync.sanesecurity.net` |
| Rspamd → mailcow fuzzy | 11445 UDP | Исходящий | При включённой соответствующей проверке; `fuzzy.mailcow.email` |
| Rspamd → Rspamd fuzzy | 11335 UDP | Исходящий | При включённой соответствующей проверке; `fuzzy1.rspamd.com`, `fuzzy2.rspamd.com` |
| Unbound → upstream probe destinations | ICMP, без TCP/UDP-порта | Исходящий ping и ответы | Проверка доступности Интернета; адреса из upstream runbook |

Правила MailExpert ограничивают **порты контейнеров** 25, 587, 993 и закрытые почтовые порты,
даже если в `mailcow.conf` публикацию перенесли на другой номер. Внешний файрвол провайдера,
напротив, должен разрешать соответствующий **порт хоста**. Штатное создание ящика в панели
фиксирует IMAP 993 и SMTP 587, API использует HTTPS 443; перенос этих портов mailcow сам по себе
не перенастраивает панель. Не путать configurable endpoint внешнего IMAP/SMTP/S3 с этим контрактом
почтового узла.

В штатной схеме узел отдельный, IPv4-only (решение D-13); 25 не открывают всему Интернету,
587/993 не открывают рабочим станциям сотрудников. API 443 нужен панели, а доступ администратора
к web-интерфейсу определяется отдельной политикой. `setup.sh` управляет почтовыми портами;
он не является общей политикой для web-портов 80/443 и SSH.

У mailcow есть собственная внутренняя сеть и вспомогательные процессы (MariaDB, Redis, Rspamd,
ClamAV, SOGo, PHP, TLS policy, watchdog и другие). Их внутренние порты не требуют доступа из
панели или Интернета: управление идёт через API. В upstream compose выпуска `2026-09`
служебные публикации по умолчанию — loopback `13306→3306` TCP (SQL), `7654→6379` TCP (Redis),
`19991→12345` TCP (doveadm). Их не открывают снаружи; проверять переопределения `SQL_PORT`,
`REDIS_PORT`, `DOVEADM_PORT` при смене версии или конфигурации.

Источники: [правила и DNAT](../../scripts/deploy/mail-node/lib.sh),
[настройка узла](../../scripts/deploy/mail-node/setup.sh),
[диапазоны EOP](../../scripts/deploy/mail-node/eop-ranges.sh),
[создание ящика](../../backend/src/services/mailNode/mailboxActions.js),
[API mailcow](../../backend/src/services/mailNode/mailcow.js),
[runbook узла](mail-node.md),
[upstream compose 2026-09](https://github.com/mailcow/mailcow-dockerized/blob/2026-09/docker-compose.yml),
[upstream firewall и исходящие сервисы](https://docs.mailcow.email/getstarted/prerequisite-system/#firewall-ports).
Для строгой исходящей политики полный vendor-список целей —
[Outgoing Ports/Hosts](https://docs.mailcow.email/getstarted/prerequisite-system/#outgoing-portshosts).

## 4. Базовый compose, HTTPS-профиль и разработка

| Режим | Порт / протокол | Где доступен / параметры |
|---|---|---|
| Только базовый compose: frontend | 80 TCP и 443 TCP | Опубликованы на интерфейсах хоста; `APP_HTTP_PORT=80`, `APP_PORT=443` по умолчанию. Это отличается от production overlay |
| Базовый compose + HTTPS overlay: Caddy | 80 TCP, 443 TCP, 443 UDP | Публикует Caddy; frontend host-порты сброшены через `!reset`, proxy → frontend 443 внутри Docker |
| Vite `npm run dev` / `npm run demo` | 5173 TCP | Локальный dev-сервер; `server.port`, CLI `--port` / `--host`; при занятом порте Vite может выбрать следующий |
| Backend, запущенный отдельно | 3000 TCP по умолчанию | `PORT`; доступность определяется способом запуска и файрволом, не production publication |
| Dev proxy → backend | 3000 TCP | В Vite указан hostname `backend` для `/api` и `/ws`; при запуске вне Docker нужен доступный адрес proxy |
| Caddy admin API в базовом HTTPS-профиле / stage-edge | 2019 TCP, loopback контейнера по умолчанию | Эти Caddyfile не отключают vendor default API; на хост порт не публикуется, production edge отключает его |

Базы и worker сохраняют внутренние порты из раздела 1. Demo подменяет API в браузере и не требует
почтового узла или tenant-worker. Для preview/dev команд с переопределениями порт проверяют по
выводу запуска; эти серверы не являются production edge.
Источники: [compose](../../docker-compose.yml),
[HTTPS overlay](../../docker-compose.https.yml), [Caddyfile](../../Caddyfile),
[Vite](../../frontend/vite.config.js), [npm scripts](../../frontend/package.json),
[backend](../../backend/src/index.js), [Caddy admin default](https://caddyserver.com/docs/api).

## 5. Локальные стенды и тесты

`127.0.0.1` внешней машины и `127.0.0.1` внутри Docker-in-Docker — разные адресные пространства.
Следующие порты не следует переносить в правила production.

| Стенд / процесс | Порт / протокол | Область и назначение |
|---|---|---|
| `me-stage`: внешний вход панели | 443 TCP → 9443 TCP → 443 TCP | `127.0.0.1:443` рабочей машины → порт 9443 хоста внутри DIND → stage-edge Caddy 443; UDP наружу не опубликован |
| `me-stage`: production frontend | 8080 TCP → 80 TCP | Loopback внутри DIND → frontend; stage-edge также обращается к frontend 80 внутри сети Docker |
| `mxu`, prefix `/opt/mailexpert-u` | 8090 TCP → 80 TCP | Подтверждённая владельцем дополнительная установка: `127.0.0.1:8090` **внутри me-stage**. Это выбранный `APP_HTTP_PORT`, не default установщика и не публикация на рабочую машину |
| Mailcow в `me-stage` | 25, 80, 443, 587, 993 TCP; остальные публикации upstream | Только внутри DIND; с рабочей машины скрипт эти порты не публикует |
| `fake-eop` | 25 TCP; 8080 TCP для HTTP trace | В сети mailcow; `EOP_PORT` / `EOP_TRACE_PORT`, без host publication; тестовая SMTP/TLS и Graph-shaped trace |
| `stage-dns`, dnsmasq | 53 UDP и TCP | В сетях панели/mailcow; без host publication; тестовая зона `stage.test` |
| Install E2E | 18080 TCP → 80 TCP | Loopback внутри одноразового DIND, без внешней публикации |
| Backup/restore E2E, панели A и B | 18081 / 18082 TCP → 80 TCP | Loopback внутри одноразового DIND |
| Backup E2E, rclone S3 | 19000 TCP → 9000 TCP | `127.0.0.1:19000` внутри DIND → HTTP S3 fixture; исключение для тестового loopback URL |
| IMAP benchmark | 993 TCP | `me-bench-node` → `me-bench-dovecot` в `me-bench-net`; `BENCH_PORT`; без host publication |
| Unit test HTTP/TLS/SMTP fixtures | Динамический TCP-порт | `listen(0, '127.0.0.1')`: ОС выбирает свободный порт; нет фиксированного production правила |

Docker daemon стенда управляется через `docker exec` / сокет. Скрипты не публикуют Docker API
2375/2376 на рабочую машину; открывать их для панели или тестов не нужно. Имена `me-stage`,
`mxu` и пути выше относятся к стендам, а не к рекомендуемой production раскладке.

Источники: [stage.sh](../../scripts/deploy/test/stage.sh),
[fake EOP](../../scripts/deploy/test/fake-eop/eop.mjs),
[install E2E](../../scripts/deploy/test/e2e-install.sh),
[backup E2E](../../scripts/deploy/test/e2e-backup.sh),
[DIND E2E](../../scripts/deploy/test/e2e.sh),
[benchmark](../architecture/mail-node-research/bench/run-one.sh),
[локальный стенд](local-stand.md). Настройка `mxu` — текущий контекст владельца, не значение из скрипта.

## 6. Проверка конкретной установки

Перед изменением сетевого экрана сверить listen-адреса (`ss -ltn`, `ss -lun`), Docker-публикации
(`docker ps --format '{{.Names}}\t{{.Ports}}'`, `docker port <CONTAINER>`), действующие UFW /
`DOCKER-USER` и внешний файрвол провайдера. Для панели использовать `status.sh --prefix <PREFIX>
--json`, для узла `setup.sh --dry-run`; на стенде проверять обе границы Docker. Эти проверки
не требуют чтения или вывода `.env`, PFX, паролей и токенов.

Изменение номера порта требует согласовать listener, публикацию, URL клиента, healthcheck и
сетевые правила. Открывать все строки таблицы наружу не требуется: направление и область доступа
указаны отдельно для каждого модуля.
