# Карта кодовой базы MailExpert

Где что лежит и что учитывать при изменении. Карта обновлена по `main` 2026-10-05 (после #153):
маршруты, сервисы, компоненты, миграции, скрипты развёртывания и CI. Числа в «Снимке анализа» и в
«Проверках» — исторический baseline форка, а не текущее состояние. Короткий обзор для агента —
[AGENTS.md](../../AGENTS.md).

## Снимок анализа (baseline форка)

- Основа: upstream `maathimself/mailflow`, commit `543a049cd085306af095a5e244a26722544432af`.
- Форк: `wyrtensi/MailExpert`.
- Версия исходного приложения: 3.3.0.
- Проанализировано: 1012 tracked-файлов.
- Текстовые исходники и конфигурация: 452 файла, около 132 500 строк и 5,88 млн символов.
- 474 из 1012 файлов — шрифты WOFF2; 57 — PNG. Они увеличивают размер репозитория, но почти не влияют на сложность сопровождения.

| Область | Файлов | Комментарий |
| --- | ---: | --- |
| JavaScript | 276 | Backend, utilities, stores, tests и web/native helpers |
| JSX | 39 | Основной React UI; часть компонентов чрезмерно крупная |
| JSON | 17 | Девять локалей, package metadata, manifests/config |
| SQL migrations | 51 | Последовательная PostgreSQL-схема |
| Java | 13 | Android native bridge |
| Backend tests | 74 на baseline | Vitest, baseline: 1333 теста; два test-файла добавлены переносом PR #425/#420 |
| Frontend tests | 48 с новым branding test | Node test runner, baseline до изменения: 1864 теста |

## Общая схема выполнения

```text
Browser / PWA / Electron / Android shell
                |
                | HTTPS + session cookie + X-Requested-With
                v
        Express API (backend/src/index.js)
          |          |          |
          |          |          +--> Redis: sessions, shared runtime state
          |          +-------------> PostgreSQL: users, accounts, message cache
          +------------------------> IMAP via ImapFlow / SMTP via Nodemailer
```

Frontend не ходит к Gmail напрямую. Он обращается к Express API. Backend хранит настройки аккаунтов, держит/ограничивает IMAP-соединения, индексирует метаданные писем в PostgreSQL и отправляет изменения интерфейсу через WebSocket. SMTP-отправка выполняется отдельно для выбранного аккаунта.

## Корень репозитория

| Файл | Назначение | Что учитывать в MailExpert |
| --- | --- | --- |
| `README.md` | Что за продукт, функции, ссылки на эксплуатацию; сборка из исходников и нативная установка (upstream) | Боевая установка — не здесь, а в `docs/operations/` |
| `AGENTS.md` | Обзор проекта и правила для ИИ-агента | Раскатка — скилл `.claude/skills/mailexpert-rollout` |
| `.env.example` | Все runtime-переменные | Google OAuth описан там как одноразовый импорт первого приложения и запасной callback; лимиты IMAP и production-настройки |
| `docker-compose.yml` | Локальный HTTP/HTTPS stack | Backend, frontend, PostgreSQL и Redis на одном сервере; `TRUST_PROXY=1` |
| `docker-compose.https.yml` | Профиль с публичным TLS (Caddy, Let's Encrypt) для сборки из исходников | Прод ставится через `deploy/compose.prod.yml` и `deploy/edge/` (раздел «Развёртывание и CI») |
| `Caddyfile` | TLS/reverse proxy профиля `https` | Краевой Caddy прода — `deploy/edge/Caddyfile.tmpl` |
| `.github/workflows/*` | `ci.yml` (тесты, shellcheck, bats, e2e установки, образы `sha-<12>`), `promote.yml` (канал `latest`), `publish.yml` (semver-образы по тегам `v*`), `publish-apps.yml` (нативные приложения, вручную) | Подробно — раздел «Развёртывание и CI» |
| `LICENSE` | AGPL-3.0 | Изменения сетевого сервиса должны быть доступны пользователям сервиса |
| `CONTRIBUTING.md` | Правила разработки MailExpert | Внешние PR не принимаются, пока не определены условия участия |
| `ROADMAP.md` | Roadmap MailExpert (Now / Next / Later) | Детали и критерии приёмки — в плане `docs/superpowers/plans` |

## Backend

### Точка входа и middleware

`backend/src/index.js` собирает Express-приложение, security headers, CORS/CSRF-защиту, сессии Redis, WebSocket, маршруты, migration startup и IMAP manager. Это центральный composition root; новые provider-модули лучше подключать сюда минимально, не добавляя бизнес-логику в сам файл.

`backend/src/middleware/auth.js` проверяет обычную, admin- и lock-сессию. OAuth callback должен связываться с инициирующей сессией, но provider logic не должна ослаблять общую middleware-модель.

### HTTP-маршруты

| Файл | Ответственность |
| --- | --- |
| `routes/accounts.js` | CRUD IMAP/SMTP-аккаунтов, aliases, folder mappings и флаг unified inbox |
| `routes/admin.js` | Пользователи, приглашения, системная почта и административные операции |
| `routes/accessSync.js` | Настройки и ручной запуск синхронизации с Cloudflare Access; монтируется в `routes/admin.js` |
| `routes/auth.js` | Регистрация, login, MFA enrolment, password reset, preferences и сессии |
| `routes/totp.js` | Отдельные TOTP-операции |
| `routes/oauth.js` | Microsoft OAuth/device code; монтирует `routes/oauthGoogle.js` и реэкспортирует `refreshMicrosoftToken` из `services/oauth/microsoftOAuth.js` |
| `routes/oauthGoogle.js` | Google OAuth под `/oauth/google`: переподключение `GET /oauth/google?account=<id>`, одноразовый переход `/launch?flow=` и callback, который создаёт (`add`) или обновляет (`reconnect`) Gmail-ящик и пишет журнал мест |
| `routes/oauthGoogleApi.js` | `/api/oauth/google`: `POST /start` формы Gmail (выбор приложения, бронь, ключ перехода) и `GET /known-emails` для подсказки |
| `routes/mailNode.js` | `/api/mail-node`: настройки почтового узла (mailcow), домены, квоты и заполнение ящиков узла, диск; список доменов виден всем, остальное администратору. Создание ящика узла — `POST /api/accounts` с `kind: 'domain'`, отключение на узле — в `DELETE /api/accounts/:id` |
| `routes/mailNodeQuarantine.js` | `/api/mail-node` (рядом с `mailNode.js`): карантин mailcow — список, запись с письмом для безопасного вида, выпуск, удаление, «удалить и обучить как спам», разовая запись настроек карантина (администратор; пользователям — просмотр по настройке) и «почему письмо в Спаме» (`/messages/:id/spam-verdict`, любой вошедший) |
| `routes/googleAppsAdmin.js` | `/api/admin/google-apps`: список, добавление, правка, смена состояния и удаление Google-приложений; монтируется в `routes/admin.js` |
| `routes/oidc.js` | Вход пользователей MailExpert через внешний OIDC/SSO; не путать с OAuth почтового аккаунта |
| `routes/integrations.js` | Глобальные секреты/настройки интеграций; для Google — только общий callback-адрес и `/status` (`google.configured`, `google.available`) |
| `routes/mail.js` | Чтение, папки, move/delete/archive/snooze и вложения; 2286 строк |
| `routes/send.js` | Проверка и сборка письма (reply/forward, вложения, MIME) и постановка в очередь отправки: 5 секунд на отмену или отложенная отправка ([очередь заданий](job-queue.md)) |
| `routes/scheduled.js` | `/api/mail/scheduled`: ожидающие и неотправленные письма — отмена с возвратом в редактор, перенос, повторная отправка |
| `routes/draft.js` | Сохранение и синхронизация черновиков |
| `routes/search.js` | Поиск по кешу/индексам с account scope |
| `routes/rules.js` | Правила обработки входящих |
| `routes/blockList.js` | Пользовательский blacklist |
| `routes/categories.js` | Категории сообщений |
| `routes/contacts.js` | Внутренние контакты |
| `routes/diagnostics.js` | Безопасный диагностический отчёт |
| `routes/ai.js` | AI provider/actions |
| `routes/plugins.js` | Управление plugin runtime/config |
| `routes/senderFavicons.js` | Прокси и кеш доменных иконок отправителя |
| `routes/todoist.js` | Todoist integration |
| `routes/adminUpdate.js` | `/api/admin/update` (администратор, монтируется в `routes/admin.js`): какая сборка `latest`, предпроверка, запрос обновления в спул хоста, ход и итог ([deployment-system.md, раздел 9](deployment-system.md)) |
| `routes/mailNodeTenant.js` | `/api/mail-node/tenant/*` (администратор): тенант Microsoft — состояние, кнопки ставят задания очереди (проверка, опрос, антиспам, шаги домена, hold, Internal Relay, выпуск из карантина) |
| `routes/mailNodeAgent.js` | служба узла: `/api/mail-node/agent*` (администратор) — состояние и отчёт узла, токен (выпуск и перевыпуск с показом один раз, отзыв), задания (`backup`); `/api/node-agent/*` — сама служба по bearer-токену, без сессии (смонтировано до сессии и проверки CSRF): long poll `next`, ход задания, отчёт `status` |
| `routes/mailNodeOutages.js` | `/api/mail-node/outages*`: простои узла и письма, задержанные или потерянные в EOP; письма ящиков видят все, управление простоями — администратор |
| `routes/delivery.js` | `/api/mail/messages/:id/delivery` — детали доставки отправленного письма по получателям; `/eop-trace` — запрос трассировки Microsoft |
| `routes/health.js` | `/api/health` и `/api/health/ready` (PostgreSQL и Redis отвечают) — проба для скриптов развёртывания |
| `routes/authGoogle.js` | `/oauth/login/google` — вход в саму панель через Google (режим `direct`), не путать с OAuth ящиков |

Файлы `*.test.js` рядом с маршрутами — contract/regression tests. У Google OAuth свои `oauth.google.test.js`, `oauthGoogleApi.test.js` и `googleAppsAdmin.test.js`.

### Почтовое ядро

`services/imapManager.js` — крупнейший backend-файл: 5633 строки и около 308 КБ. Он отвечает сразу за connection admission, provider profiles, IDLE/polling, backfill, folder sync, fetch/parsing, indexing, reconnection и часть правил. Его нельзя переписывать одновременно с обновлением ImapFlow и OAuth.

Критические соседние файлы:

- `smtpTransport.js` — создаёт transport выбранного аккаунта, обновляет Microsoft token и закрепляет SMTP за проверенными IP-адресами.
- `messageParser.js` — MIME/header/body parsing и snippet extraction.
- `messageService.js` и `mailAccess.js` — account-scoped доступ к сообщениям.
- `folderStatus.js` — server/local status папок.
- `archiveInbox.js` — фоновые archive-процессы.
- `inboxRules.js` и `ruleForwarder.js` — применение правил и forwarding.
- `labels.js`, `labelsRead.js` — label/folder metadata.
- `unifiedInbox.js` — выбор аккаунтов для общей ленты; в нашем MVP все Gmail получают opt-out.
- `threading/` — цепочки писем: `threadId.js` вычисляет ключ цепочки и причину (`computeThreading`: номер Gmail в режиме `gmail`, иначе цепочка `References`/`In-Reply-To`, без склейки по теме), `providerIds.js` читает `X-GM-THRID`/`X-GM-MSGID` из ответа imapflow, `providerIdBackfill.js` догружает эти номера для уже сохранённых писем и в режиме `gmail` переключает их ключ, `providerIdBackfillStore.js` хранит прогресс догрузки, `providerThreadIndex.js` проверяет, что индекс по номеру цепочки валиден, `recompute.js` пересчитывает `thread_id` всех писем ящика заново после смены режима пачками, разбирая старые склейки по теме, `recomputeStore.js` хранит прогресс и курсор этого пересчёта (см. миграцию 0064).
- Отправка и очередь: `jobQueue.js` — общая устойчивая очередь заданий (таблица `jobs`, миграция 0087; [job-queue.md](job-queue.md)); `sendQueue.js` — отмена отправки и «Отправить позже» поверх неё (задание `send_message`, письмо в `outgoing_messages`, `delivered_unrecorded`); `sendDelivery.js` — передача письма серверу и последствия (журнал `message.sent`, контакты, копия в «Отправленных»); `mailSendTransport.js` — одна точка отправки: Gmail через API с запасным SMTP, остальные через SMTP; `gmailApiSender.js` — низкоуровневая отправка Gmail API.
- Доставка: `deliveryStatus.js` — что стало с отправленным письмом по получателям (миграция 0084); `deliveryReport.js` — разбор вернувшихся отбивок (DSN) и отметка исходного письма; `mailNode/deliveryCodes.js` — общий список кодов доставки.
- Перемещения и удаление: `moveQueue.js` — «сначала база», MOVE на сервере из очереди `message_moves` (0075); `expungeClaims.js` — заявки на окончательное удаление (0077).
- Ящики: `accountHealth.js` — код состояния подключения для боковой панели; `accountReceived.js` — время последнего входящего письма (сортировка ящиков, 0085); `updateCheck.js` — старая проверка релизов GitHub для баннера `/api/update`, не путать с обновлением панели.
- `threadingDiagnostics.js` (по образцу `senderHistory.js`) — диагностика одного письма для `GET /api/mail/messages/:id/threading`: заголовки цепочки, номер Gmail, причина из `threading_reason`, режим ящика и группировка остальных писем той же цепочки по папкам через `thread_key`, без новой миграции.

### Безопасность и инфраструктура backend

- `encryption.js` — граница шифрования паролей и OAuth-токенов. Google refresh token должен проходить только через неё.
- `hostValidation.js`, `connectionPolicy.js`, `safeFetch.js` — SSRF/DNS rebinding/TLS policy. Не обходить их в OAuth или SMTP.
- `mailNode/mailcow.js` — клиент API mailcow (домены, создание, удаление вместе с почтой и квота ящика, диск; отказ внутри ответа 200 — ошибка) и настройки узла в `integration_config`; `mailNode/diskWatch.js` — проверка диска узла раз в 10 минут с пингом ссылки мониторинга. `mailNode/mailboxDeletion.js` — отложенное удаление ящика узла: запрос с причиной и отмена, задание раз в 5 минут удаляет ящики, чей срок наступил. Эксплуатация узла: `mailNode/postfixLog.js` — чтение и разбор лога Postfix через API mailcow (строки по queue id, куда ушло письмо); `mailNode/mailQueue.js` — очередь почты и `postcat`; `mailNode/nodeAlerts.js` — оповещения раз в 5 минут (отказы EOP и обход EOP в логе, очередь, сертификат, контейнеры, TERRL) со своей ссылкой мониторинга; `mailNode/terrl.js` — бюджет внешних получателей тенанта; `mailNode/eopRanges.js` — диапазоны адресов EOP. Карантин и история rspamd (R-20): `mailNode/quarantine.js` — разбор письма из карантина, кэш истории rspamd и поиск письма в ней, кто видит карантин. Домены и EOP: `mailNode/domains.js` — домены узла и ход онбординга (0079); `mailNode/eopSettings.js` — настройки пути почты через EOP; `mailNode/nodeApply.js` — «Применить настройки» (только расхождения, состояние правила «Спама»); `mailNode/dnsCheck.js` и `dnsCheckJob.js` — проверки DNS и сертификата и их расписание; `mailNode/txtRecord.js` — склейка TXT-значений. Простои (R-43): `mailNode/outages.js`, `outageTrace.js`, `traceSource.js`. Служба узла: `mailNode/nodeAgent.js` — токен (только хеш SHA-256), очередь её заданий с long poll и сроками, отчёт узла (0093), задание `update` скриптов узла на коммит панели после её обновления и по кнопке (0094). Места EOP (0095): `mailNode/eopSeats.js` — журнал мест, счётчик, срок ожидания, число купленных мест (Graph или поле «Лицензии»); `mailNode/seatProvider.js` — запрос мест (ручной режим); `mailNode/readOnlyFilter.js` — фильтр Sieve «только чтение» на узле и сверка с строками панели; маршруты `routes/mailNodeSeats.js`. Пароли ящиков узла: `mailNode/passwordRestore.js` (автовосстановление), `currentPassword.js`. Эксплуатация — [mail-node.md](../operations/mail-node.md).
- `tenant/` — тенант Microsoft (R-22 и дальше): `driver.js` — драйвер с двумя транспортами (EXO PowerShell через `tenant-worker` — `exoRunner.js`, Microsoft Graph — `graphClient.js`; `TENANT_DRIVER=fake` — `fakes.js` и `fixtures.json` для тестов, стенда и демо); `tenantJobs.js` — виды заданий тенанта на общей очереди; `tenantDomains.js` — шаги тенанта на домен и зеркало получателей DBEB; `connectors.js`, `antispam.js` — эталон коннекторов и антиспам-политики; `messageTrace.js` — «Спросить Microsoft» о письме; `quarantineRelease.js` — выпуск из карантина EOP; `tenantActions.js` — действия администратора, общие для маршрута и CLI. Работа с тенантом идёт только заданиями очереди, не на пути HTTP-запроса.
- `panelUpdate/` — обновление из панели: `latest.js` (какая сборка `latest`, через GitHub API), `spool.js` (единственный канал контейнера с хостом: `request/*.json` пишет backend, `result/*.json` — хост), `reconcile.js` (журнал начала и итога обновления по файлам результата).
- `auth/` — вход в панель: `authSettings.js` (режим входа из окружения), `cloudflareAccess.js` (проверка утверждения Access), `userIdentity.js`, `userStatus.js`. `utils/trustProxy.js` — `trust proxy` из `TRUST_PROXY` (сколько прокси перед backend), от него зависят лимиты входа и адрес в журнале.
- `redis.js` — клиент Redis и session/runtime state.
- `db.js`, `migrations.js` — PostgreSQL pool, транзакции и запуск миграций.
- `authLimiter.js`, `rateLimiter.js`, `authEvents.js` — защита login/API и журнал безопасности.
- `auditLog.js` — журнал действий пользователей с ящиками, письмами и пользователями (`mailbox_audit_log`); маршруты пишут в него без ожидания, ошибка записи не ломает действие.
- `actor.js` — кто действует (пользователь маршрута или CLI панели с `--as`) и поля записи журнала для него. Действия администратора, общие для маршрутов и CLI: `mailNode/mailboxActions.js` (ящики узла), `mailNode/domainActions.js` (домены и их онбординг), `mailNode/settingsActions.js` (настройки узла и EOP, бюджет TERRL), `mailNode/seatActions.js` (места EOP), `mailNode/agentActions.js` (агент узла), `mailNode/errors.js` (каталог отказов узла), `accountAliases.js` (алиасы, D-16), `tenant/tenantActions.js` (тенант, карантин EOP, задания), `accessSync/actions.js` (синхронизация с Cloudflare Access), `admin/users.js` (пользователи), `admin/systemSettings.js` (настройки экрана администратора), `auth/oidcProviders.js` (SSO-провайдеры), `integrations/microsoft.js` (клиент Microsoft OAuth); `admin/adminEffects.js` — последствия этих изменений в процессе backend и задание `admin_effects`, которое ставит CLI. CLI панели — `src/cli/mailexpert.js` и `src/cli/commands/`; устройство — [panel-cli.md](panel-cli.md).
- `accessSync/` — синхронизация одобренных пользователей с Allow-политикой Cloudflare Access: клиент API (`cloudflareAccessClient.js`), чистая трёхсторонняя сверка (`reconcile.js`), настройки с зашифрованным токеном (`settings.js`), прогон (`runner.js`), один исполнитель на процесс (`scheduler.js`, `index.js`) и действия администратора, общие для маршрута и CLI панели (`actions.js`: снимок, сохранение с журналом, задание `access_sync` для прогона из CLI). `auth/userStatus.js` — проверки последнего администратора и отключение по email.
- `emailSanitizer.js` — граница недоверенного HTML письма.
- `logger.js`, `diagnosticsRing.js`, `diagnosticsReport.js` — журналы и redaction.
- `websocket.js`, `pushNotifications.js` — обновления UI и Web Push.
- `performanceMetrics.js` — база для нагрузочного теста 100 Gmail.

### PostgreSQL migrations

93 миграции в `backend/migrations/` образуют append-only историю от `0001_baseline.sql` до
`0093_node_agent.sql`, `0094_node_agent_update.sql`. Влитую миграцию не переименовывают и не меняют.

Основные группы:

- `0001–0009`: базовая схема сообщений, threading и search indexes.
- `0010–0018`: rules, block list, contacts, bulk/category metadata.
- `0019–0029`: integrations, trusted MFA devices, reset tokens, unsubscribe, OIDC, CardDAV и OAuth public-client flag.
- `0030–0035`: GTD и lock/logout.
- `0036–0040`: per-account unified inbox, delivery addresses, Codex OAuth, forwarding и отдельные SMTP credentials.
- `0041–0046`: plugin data/config и перенос GTD в plugin architecture.
- `0047–0051`: folder selectability, snippet retry state, OIDC matching, sender metadata и server folder status.
- `0052–0059`: переподключение OAuth, Google-приложения, статус пользователей, интервалы синхронизации, общие данные ящиков, журнал (`mailbox_audit_log`), BCC черновиков, ссылки контактов.
- `0060–0066`: номера писем и цепочек Gmail, их догрузка, режим цепочек и пересчёт, индексы.
- `0067–0078`: ящики почтового узла, индексы поиска и истории отправителя, недоступные UID, общая лента для всех ящиков, пароли узла, очередь перемещений, заявки на удаление, отключённый Gmail API.
- `0079–0086`: домены узла и их идентичность, отложенное удаление ящиков, «Применить настройки», категория EOP, статус доставки, время последнего письма, простои узла.
- `0087–0090`: очередь заданий (`jobs`), домены тенанта, трассировка и карантин тенанта.

Google OAuth хранит токены в provider-agnostic колонках `email_accounts.oauth_*`. Миграция `0053_google_oauth_apps.sql` добавила таблицы `google_oauth_apps` и `google_oauth_grants` (журнал мест) и колонки `email_accounts.oauth_app_id`, `oauth_subject`. Одноразовый state/PKCE, брони мест и ключи перехода живут в Redis с TTL.

### Plugin layer

`backend/src/plugins/registry.js`, `loadPlugins.js`, `mailEngine.js`, `mailEngineFacade.js`, `storage.js` и `accountConfig.js` формируют расширяемую границу. GTD уже вынесен в `backend/src/plugins/gtd/*` и показывает рекомендуемый способ добавлять независимые функции.

Google OAuth — не plugin уровня UI: он является credential provider для общего mail engine и живёт в `services/oauth/`: `googleOAuth.js` (URL, обмен кода, ID token, обновление и отзыв токена), `googleApps.js` (реестр приложений, журнал мест, импорт старой настройки), `googleAppSelection.js` (выбор приложения и брони), `googleLaunch.js` (одноразовый ключ перехода), `tokenManager.js` (обновление для всех IMAP/SMTP-путей). Эксплуатация — [google-oauth.md](../operations/google-oauth.md).

## Frontend

### Точки входа и состояние

- `src/main.jsx` — React bootstrap.
- `src/App.jsx` — theme/layout init, callback-window handling и первичная проверка сессии.
- `src/components/MailApp.jsx` — shell авторизованного приложения, navigation и глобальные эффекты.
- `src/store/index.js` — Zustand store; 1237 строк. Хранит accounts, selection, folders, messages и UI state.
- `src/utils/api.js` — единый HTTP client и CSRF header.
- `src/hooks/useWebSocket.js` — real-time events и reconciliation.

### Крупные UI-компоненты

| Файл | Размер | Роль и риск изменения |
| --- | ---: | --- |
| `AdminPanel.jsx` | 8621 строк | Все настройки в одном файле; Google-приложения и формы «Добавить аккаунт» вынесены в отдельные компоненты |
| `MessageList.jsx` | 4714 | Список, threads, bulk actions; высокий риск гонок optimistic state |
| `MessagePane.jsx` | 3420 | Рендеринг недоверенного email HTML и actions |
| `ComposeModal.jsx` | 3304 | Редактор, aliases, attachments, reply/forward |
| `Sidebar.jsx` | 2055 | Аккаунты и папки; сюда добавляется фильтр 100 ящиков |
| `MailApp.jsx` | 1019 | Application shell и callback integration |
| `LoginPage.jsx` | 1000 | Password/OIDC/MFA flows |
| `ContactsPage.jsx` | 861 | Контакты |
| `ContextMenu.jsx` | 809 | Message/folder actions |

Остальные компоненты отвечают за command palette, diagnostics, window layers, notifications, profile, signature editor, GTD views и native notification bridge.

- `AuditLogTab.jsx` — экран журнала для администратора: фильтры и подгрузка по курсору; логика запроса и подписей в `utils/auditLog.js`.
- `AccessSyncPanel.jsx` — вкладка синхронизации с Cloudflare Access в режиме `google`; логика формы и итога прогона в `utils/accessSync.js`.
- `MailNodeSection.jsx` — раздел «Почтовый узел» на вкладке «Администрирование → Почтовый узел» (там же `MailNodeForeignAliases`, `EopSection` с `MailNodeTenant`, `MailNodeOpsSection`, `MailNodeOutagesSection`, `MailNodeQuarantine`) для администратора: имя узла, ключ API, квота, ссылка проверки диска, домены, ящики узла с квотами; `DomainMailboxAddForm.jsx` — вкладка «Наш ящик» в «Добавить аккаунт»: имя до @, домен узла, отображаемое имя, отказ на адрес, который уже есть, и шаг подтверждения; чистая логика в `utils/mailNode.js`.
- `MailNodeQuarantine.jsx` — карантин почтового узла (администратор — на вкладке «Почтовый узел», пользователь — в «Ящиках», если разрешено): список, запись с письмом только в безопасном виде, выпуск, удаление, обучение, запись настроек карантина mailcow; `SpamVerdict.jsx` — «почему письмо в Спаме» у письма из «Спама» ящика узла (окно письма и лента переписки); чистая логика в `utils/quarantine.js`.
- Вкладка «Почтовый узел» (`MailNodeTab` в `AdminPanel.jsx`, только администратор), блоки по порядку: `MailNodeSection`, `MailNodeForeignAliases`, `EopSection` (внутри — `MailNodeTenant`, `MailNodeTerrlBudget`, `MailNodeApplyResult`, `MailNodeDomainOnboarding` с `MailNodeDnsResult` и `MailNodeDomainTenant`), `MailNodeOpsSection`, `MailNodeAgentSection` (служба узла: состояние, подключение по токену, «Бэкап почты сейчас»; логика в `utils/nodeAgent.js`), `MailNodeOutagesSection`, `MailNodeQuarantine`. `MailNodeOutageNotice.jsx` — плашка над списком писем о письмах, задержанных за простой узла; `MailboxDeletionNotice.jsx` — пометки «только чтение»: отложенное удаление и деактивация ящика узла, отмена и «Активировать»; `MailNodeSeats.jsx` — счётчик мест EOP.
- `PanelUpdateSection.jsx` — вкладка «Администрирование → Обновление панели»: версия, `latest`, предпроверка, кнопка «Обновить», ход и итог; чистая логика в `utils/panelUpdate.js`.
- Отправка: `SendLaterMenu.jsx` — меню «Отправить позже»; `ScheduledLetters.jsx` — счётчик и диалог «Запланированные», возврат письма в редактор; логика в `utils/scheduledSend.js` и `utils/sendTracker.js`. Доставка: `DeliveryDetails.jsx` — «Детали доставки» под отправленным письмом и трассировка Microsoft; `DeliveryMarker.jsx` — метка «не доставлено / задержано» в списке.
- Вход в режиме `google`: `GoogleLoginPage.jsx` (экран входа), `GoogleUsersPanel.jsx` (одобренные пользователи в «Пользователях»). `DemoBadge.jsx` — значок демо-режима со сменой роли.
- Демо-режим: `src/demo/` — клиентский мок API на фикстурах (`npm run demo` или `VITE_DEMO_MODE=true`), 50 ящиков (`fleet.js`), узел, тенант, простои; `demo/routeCoverage.test.js` требует демо-ответ или явный отказ для каждого пути `api.js`.
- Группы вкладок настроек (`TAB_GROUPS` в `AdminPanel.jsx`): «Аккаунт и почта» (Аккаунты, Уведомления, Правила, Категории, Очистка), «Отображение» (Внешний вид, Горячие клавиши), «Безопасность и интеграции» (Безопасность, Интеграции, ИИ-ассистент, ИИ-действия, Плагины), «Администрирование» (Пользователи, Почтовый узел, Журнал, Обновление панели, SSO); «О приложении» — внизу, только администратор.
- `GoogleAppsSection.jsx` — экран «Google-приложения» в «Интеграции → Почтовые провайдеры» для администратора: callback-адрес, таблица приложений, добавление, правка, состояния; чистая логика в `utils/googleApps.js`.
- `AddAccountTabs.jsx` и `GmailAddForm.jsx` — диалог «Добавить аккаунт»: две карточки «Личный Gmail» (по умолчанию) и «Наш ящик», ссылка «Другой сервер» для администратора и форма Gmail с подсказкой адресов, в демо — с карточкой вместо шага Google; варианты, подсказка и ошибки старта в `utils/addAccount.js`, результаты callback и URL переподключения в `utils/googleOAuth.js` и `utils/accountHealth.js`.

### Utilities и тестируемая бизнес-логика

`src/utils/*` содержит account scope, optimistic guards, folder ordering, reply alias selection, message identity/deduplication, draft autosave, diagnostics, security policy native actions и UI helpers. Это наиболее удобное место для чистых функций с быстрыми `node --test` тестами.

Для MailExpert важны:

- `accountScope.js` — выбранный аккаунт против общей области;
- `defaultSender.js`, `replyAlias.js` — правильный From;
- `unifiedInbox.js` — исключение наших Gmail из общей ленты;
- `folderSync.js` — внешние папки Gmail;
- `sidebar.js` — будущий фильтр аккаунтов;
- `nativeActionSecurity.js` — доверие native bridge;
- `api.js` — все OAuth/admin вызовы должны идти через него;
- `senderHistory.js`, `threadingDiagnostics.js` — чистые хелперы под секции диалога письма/заголовков (`SenderHistory.jsx`, `MessageHeaderModal.jsx`): i18n-ключи причины/режима и т.п.

### Локализация

`src/locales/{en,ru}.json` должны иметь одинаковые ключи. `i18n.test.js` проверяет key coverage, отсутствие неиспользуемых ключей, совпадения значений и hardcoded strings. Любой новый UI должен обновлять обе локали.

### Native wrappers

- `frontend/packages/electron/*` — Electron shell, update verification и installer.
- `frontend/packages/native-shell/*` — страница выбора/ошибки сервера.
- `frontend/packages/android/*` — Capacitor/Java bridge, background sync и notification actions.

Полный ребрендинг выполнен до начала продуктовой разработки: локальные IDs используют `sh.mailexpert.app`, Java-классы и native plugin — `MailExpertNative`, browser storage — `mailexpert_*`, Docker services/volumes и data paths — `mailexpert`. Это намеренно разрывает совместимость с ранними upstream-установками и исключает дальнейшее накопление legacy-идентификаторов.

## Развёртывание и CI

Как это работает целиком — [deployment-system.md](deployment-system.md); команды —
[operations/README.md](../operations/README.md).

### Скрипты панели (`scripts/deploy/`)

| Файл | Что делает | Коды выхода |
| --- | --- | --- |
| `install.sh` | установка и повторное применение конфигурации; идемпотентен, параметры хранит в `<PREFIX>/install.conf` | 0, 1 сбой, 2 неверный ввод, 3 ждёт секретов |
| `configure.sh` | секреты владельца из stdin (`KEY=VALUE`), никогда из аргументов | 0, 1, 2 |
| `status.sh` | только чтение: состояние установки, с `--target` — предпроверка версии, `--json` для агента | 0 нет проблем, 1 проблемы, 2 |
| `update.sh` | обновление до `sha-<12>` или `latest`: дамп и снимок, `install.sh --version`, ожидание готовности; `--check` | 0, 1 сбой после переключения, 2, 3 сбой до переключения |
| `updater.sh` | хостовая сторона кнопки «Обновить»: разбирает недоверенный запрос из спула, запускает `status.sh` и `update.sh`, при коде 1 без миграций — автооткат | 0, 1, 2 |
| `rollback.sh` | откат к версии до обновления через её дамп, с подтверждением | 0, 1 сбой после остановки, 2, 3 |
| `backup.sh`, `restore.sh` | бэкап в restic (S3) и восстановление на новом сервере | 0, 1, 2 |
| `healthcheck.sh` | проверка по таймеру (готовность, контейнеры, место, возраст бэкапа, сертификат) с пингом | 0, 1 проблемы, 2 |
| `mailexpert-cli.sh` | обёртка CLI панели в контейнере `backend` ([cli.md](../operations/cli.md)) | коды CLI; свои 2, 3 |
| `google-app.sh` | управление Google-приложениями как на экране панели: add, list, show, enable/close/disable, delete, set-limit, set-label, replace-secret (`src/cli/googleApp.js`) | 0, 1, 2 |

`lib/`: `common.sh` (общие помощники), `env.sh` (разбор `KEY=VALUE` без `source`), `config.sh`
(флаги, `install.conf`, проверка, производное от режима входа), `app.sh` (пути, compose, образы
установленной панели), `edge.sh` (файлы проекта `edge`), `system.sh` (подготовка Ubuntu 24.04, ufw,
таймеры и юниты исполнителя обновлений), `backup.sh` (restic), `channel.sh` (`latest` → `sha-<12>`),
`health.sh`, `ops.sh`, `status.sh`, `updater.sh` (чистые решения соответствующих скриптов),
`pg-dump.sh` и `counts.sql` (дамп и счётчики строк одним снимком), `verify-restore.mjs` (проверка
восстановленной базы в образе backend).

### Почтовый узел (`scripts/deploy/mail-node/`)

`setup.sh` (настройки хоста, файрвол, Dovecot, таймеры, служба узла; `--dry-run`), `eop-ranges.sh` (диапазоны EOP
и файрвол раз в час), `node-backup.sh` и `node-restore.sh` (бэкап узла в свой репозиторий restic и
восстановление на чистый сервер), `node-agent.sh` (служба узла: задания панели `status`, `backup` и `update`), `node-update.sh` (задание `update`: отдельно от службы, бэкап `pre-update`, `setup.sh` с откатом, mailcow до версии из `deploy/mailcow-version`), `lib.sh`, `backup-lib.sh`, `extra-cf.sh`, `dovecot-extra.conf`,
юниты `systemd/`, варианты `cron/` и `logrotate/` для хостов без systemd. Описание —
[README](../../scripts/deploy/mail-node/README.md).

### `deploy/`

- `compose.prod.yml` — оверлей прода: образы `sha-<12>` из GHCR, frontend только на `127.0.0.1`,
  лимиты памяти, `TRUST_PROXY=2`, спул обновлений, `tenant-worker` (профиль `tenant`).
- `edge/` — отдельный compose-проект края: `caddy` (TLS через DNS-01 Cloudflare, `Dockerfile`,
  `Caddyfile.tmpl`) и `cloudflared`.
- `systemd/` — `mailexpert-backup` (03:30), `mailexpert-health` (каждые 5 минут),
  `mailexpert-updater.path` и `.service` (кнопка «Обновить»).
- `tenant-worker/` — образ исполнителя тенанта: PowerShell 7 с ExchangeOnlineManagement за HTTP-сервером
  Node (`server.mjs`), белый список операций (`ops.mjs`), сертификат приложения (`cert.ps1`), тесты.

### CI и канал `latest`

- `.github/workflows/ci.yml` — push и PR в `main`: backend, frontend, shellcheck, bats, фейковый EOP,
  tenant-worker, e2e установки; джоба `images` публикует `sha-<12>` четырёх образов только с `main`.
- `.github/workflows/promote.yml` и `scripts/ci/promote-latest.sh` — ручное продвижение коммита `main`
  в канал `latest`: проверка образов, тег `latest` на тех же digest, затем git-тег `latest`.
- `publish.yml` — semver-образы backend и frontend по тегам `v*` (тег `latest` не ставит);
  `publish-apps.yml` — нативные приложения, вручную.

### Тесты скриптов (`scripts/deploy/test/`)

bats на каждый скрипт и библиотеку (`*.bats`, общий `helper.bash`, моки узла в `mail-node/`); e2e в
одноразовом Docker-in-Docker (`e2e.sh`, `e2e-install.sh`, `e2e-backup.sh`, `e2e-mailcow.sh`);
фейковый EOP (`fake-eop/`) и DNS стенда (`stand-dns/`); `stage.sh` — локальный стенд всего продукта
([local-stand.md](../operations/local-stand.md)).

## Проверки и quality gates

Backend:

```bash
cd backend
npm ci
npm test
npm run lint
npm run lint:plugins
npm run audit:redos
```

Frontend:

```bash
cd frontend
npm ci
npm test
npm run lint
npm run build
```

Baseline на commit `543a049`: backend 1333/1333 тестов, frontend 1864/1864 тестов.

После baseline в MailExpert перенесены upstream PR #425 и #420. Они добавили `messageParser.attachments.test.js` и `mail.createFolder.test.js`; целевой прогон трёх связанных test-файлов после переноса дал 243/243.

Итоговый gate bootstrap выполнен и локально на Node 24.19.0, и в чистых `node:22-bookworm-slim` контейнерах:

- backend: 76 test-файлов, 1345/1345 тестов;
- backend ESLint: pass;
- plugin-boundary ESLint: pass;
- frontend: 1866/1866 тестов;
- frontend ESLint: pass;
- production build: pass;
- `branding.test.js`: 2/2;
- `git diff --check`: pass.

Production build предупреждает о нескольких chunks больше 500 kB. Крупнейшие — `store` (~733 kB), основной `index` (~690 kB) и `ComposeModal` (~558 kB) до gzip. Это performance debt для отдельной задачи по code splitting, а не ошибка bootstrap.

На момент ребрендинга `npm audit` показывал один moderate advisory backend в transitive `qs`, для которого было доступно обычное исправление, и два связанных moderate advisory frontend в `react-router`/`react-router-dom`, для которых npm предлагал major-обновление. Они входили в первый dependency-модернизационный этап и не исправлялись принудительным `npm audit fix --force` внутри ребрендинга. Обновление зависимостей в сентябре 2026 года закрыло оба advisory: `qs` ушёл вместе с Express 4, а `react-router-dom` удалён и заменён на `react-router` 7. Подробности — в [dependency-upgrade-2026-09.md](../operations/dependency-upgrade-2026-09.md).

## Главные технические риски

1. `imapManager.js` и `AdminPanel.jsx` стали монолитами. Новую OAuth-логику нельзя добавлять в них большим inline-блоком.
2. Одновременное обновление major-зависимостей и перенос PR делает регрессии неразличимыми. Сначала dependency snapshot, потом Google provider.
3. Разграничения доступа по ящикам нет: любой вошедший видит все ящики. Атрибуцию даёт журнал (`mailbox_audit_log`) с автором действия; настройки подключения ящика меняет только администратор.
4. 100 Gmail создают provider/IP connection pressure; лимит проверяется измерениями, а не размером PostgreSQL.
5. Restricted scope `https://mail.google.com/` без verification ограничивает проект Google Cloud сотней пользователей за всё время; решение — несколько проектов, риски описаны в [google-oauth.md](../operations/google-oauth.md#риски).
6. Native IDs и data paths нельзя переименовывать простым search/replace.

## Рекомендуемые границы будущих изменений

- Google OAuth: новые `services/oauth/*`, тонкие routes, Redis TTL для pending state/PKCE.
- Provider refresh: один `tokenManager` для Google/Microsoft, вызываемый всеми IMAP/SMTP путями.
- UI Google: отдельные компоненты `GoogleAppsSection.jsx` и `GmailAddForm.jsx`, подключённые к AdminPanel.
- Mailbox filter: чистая utility + минимальная Sidebar integration.
- EOP/Postfix/Dovecot: отдельный mail-node и отдельный план; не встраивать MTA в Express process.
