# Карта кодовой базы MailExpert

## Снимок анализа

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
| `README.md` | Установка, функции и эксплуатация | Содержит upstream-инструкции; дополнен ссылкой на эту карту |
| `.env.example` | Все runtime-переменные | Google OAuth описан там как одноразовый импорт первого приложения и запасной callback; лимиты IMAP и production-настройки |
| `docker-compose.yml` | Локальный HTTP/HTTPS stack | Backend, frontend, PostgreSQL и Redis на одном сервере |
| `docker-compose.https.yml` | Профиль с публичным TLS | Для production всё равно предпочтителен внешний reverse proxy/Cloudflare Access |
| `Caddyfile` | TLS/reverse proxy | Не смешивать с OAuth-логикой |
| `.github/workflows/*` | CI, release, images, native builds | После первого push проверить, что actions разрешены в форке |
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
| `routes/send.js` | Отправка, reply/forward, MIME и Sent APPEND |
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
- `threadingDiagnostics.js` (по образцу `senderHistory.js`) — диагностика одного письма для `GET /api/mail/messages/:id/threading`: заголовки цепочки, номер Gmail, причина из `threading_reason`, режим ящика и группировка остальных писем той же цепочки по папкам через `thread_key`, без новой миграции.

### Безопасность и инфраструктура backend

- `encryption.js` — граница шифрования паролей и OAuth-токенов. Google refresh token должен проходить только через неё.
- `hostValidation.js`, `connectionPolicy.js`, `safeFetch.js` — SSRF/DNS rebinding/TLS policy. Не обходить их в OAuth или SMTP.
- `mailNode/mailcow.js` — клиент API mailcow (домены, создание, удаление вместе с почтой и квота ящика, диск; отказ внутри ответа 200 — ошибка) и настройки узла в `integration_config`; `mailNode/diskWatch.js` — проверка диска узла раз в 10 минут с пингом ссылки мониторинга. `mailNode/mailboxDeletion.js` — отложенное удаление ящика узла: запрос с причиной и отмена, задание раз в 5 минут удаляет ящики, чей срок наступил. Эксплуатация узла: `mailNode/postfixLog.js` — чтение и разбор лога Postfix через API mailcow (строки по queue id, куда ушло письмо); `mailNode/mailQueue.js` — очередь почты и `postcat`; `mailNode/nodeAlerts.js` — оповещения раз в 5 минут (отказы EOP и обход EOP в логе, очередь, сертификат, контейнеры, TERRL) со своей ссылкой мониторинга; `mailNode/terrl.js` — бюджет внешних получателей тенанта; `mailNode/eopRanges.js` — диапазоны адресов EOP. Карантин и история rspamd (R-20): `mailNode/quarantine.js` — разбор письма из карантина, кэш истории rspamd и поиск письма в ней, кто видит карантин. Эксплуатация — [mail-node.md](../operations/mail-node.md).
- `redis.js` — клиент Redis и session/runtime state.
- `db.js`, `migrations.js` — PostgreSQL pool, транзакции и запуск миграций.
- `authLimiter.js`, `rateLimiter.js`, `authEvents.js` — защита login/API и журнал безопасности.
- `auditLog.js` — журнал действий пользователей с ящиками, письмами и пользователями (`mailbox_audit_log`); маршруты пишут в него без ожидания, ошибка записи не ломает действие.
- `accessSync/` — синхронизация одобренных пользователей с Allow-политикой Cloudflare Access: клиент API (`cloudflareAccessClient.js`), чистая трёхсторонняя сверка (`reconcile.js`), настройки с зашифрованным токеном (`settings.js`), прогон (`runner.js`) и один исполнитель на процесс (`scheduler.js`, `index.js`). `auth/userStatus.js` — проверки последнего администратора и отключение по email.
- `emailSanitizer.js` — граница недоверенного HTML письма.
- `logger.js`, `diagnosticsRing.js`, `diagnosticsReport.js` — журналы и redaction.
- `websocket.js`, `pushNotifications.js` — обновления UI и Web Push.
- `performanceMetrics.js` — база для нагрузочного теста 100 Gmail.

### PostgreSQL migrations

51 migration образуют append-only историю от `0001_baseline.sql` до `0051_folder_server_status.sql`.

Основные группы:

- `0001–0009`: базовая схема сообщений, threading и search indexes.
- `0010–0018`: rules, block list, contacts, bulk/category metadata.
- `0019–0029`: integrations, trusted MFA devices, reset tokens, unsubscribe, OIDC, CardDAV и OAuth public-client flag.
- `0030–0035`: GTD и lock/logout.
- `0036–0040`: per-account unified inbox, delivery addresses, Codex OAuth, forwarding и отдельные SMTP credentials.
- `0041–0046`: plugin data/config и перенос GTD в plugin architecture.
- `0047–0051`: folder selectability, snippet retry state, OIDC matching, sender metadata и server folder status.

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
- `MailNodeSection.jsx` — раздел «Почтовый узел» в «Интеграции → Почтовые провайдеры» для администратора: имя узла, ключ API, квота, ссылка проверки диска, домены, ящики узла с квотами; `DomainMailboxAddForm.jsx` — вкладка «Наш ящик» в «Добавить аккаунт»: имя до @, домен узла, отображаемое имя, отказ на адрес, который уже есть, и шаг подтверждения; чистая логика в `utils/mailNode.js`.
- `MailNodeQuarantine.jsx` — карантин почтового узла (администратор — в «Интеграциях», пользователь — в «Ящиках», если разрешено): список, запись с письмом только в безопасном виде, выпуск, удаление, обучение, запись настроек карантина mailcow; `SpamVerdict.jsx` — «почему письмо в Спаме» у письма из «Спама» ящика узла (окно письма и лента переписки); чистая логика в `utils/quarantine.js`.
- `GoogleAppsSection.jsx` — экран «Google-приложения» в «Интеграции → Почтовые провайдеры» для администратора: callback-адрес, таблица приложений, добавление, правка, состояния; чистая логика в `utils/googleApps.js`.
- `AddAccountTabs.jsx` и `GmailAddForm.jsx` — диалог «Добавить аккаунт»: вкладки способов (Gmail, «Наш ящик», «Другой сервер» для администратора) и форма Gmail с подсказкой адресов, в демо — с карточкой вместо шага Google; варианты, подсказка и ошибки старта в `utils/addAccount.js`, результаты callback и URL переподключения в `utils/googleOAuth.js` и `utils/accountHealth.js`.

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
3. Один общий пользователь удобен, но не даёт атрибуции действий менеджерам.
4. 100 Gmail создают provider/IP connection pressure; лимит проверяется измерениями, а не размером PostgreSQL.
5. Restricted scope `https://mail.google.com/` без verification ограничивает проект Google Cloud сотней пользователей за всё время; решение — несколько проектов, риски описаны в [google-oauth.md](../operations/google-oauth.md#риски).
6. Native IDs и data paths нельзя переименовывать простым search/replace.

## Рекомендуемые границы будущих изменений

- Google OAuth: новые `services/oauth/*`, тонкие routes, Redis TTL для pending state/PKCE.
- Provider refresh: один `tokenManager` для Google/Microsoft, вызываемый всеми IMAP/SMTP путями.
- UI Google: отдельные компоненты `GoogleAppsSection.jsx` и `GmailAddForm.jsx`, подключённые к AdminPanel.
- Mailbox filter: чистая utility + минимальная Sidebar integration.
- EOP/Postfix/Dovecot: отдельный mail-node и отдельный план; не встраивать MTA в Express process.
