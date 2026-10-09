# CLI панели

Командная строка `mailexpert` — второе лицо панели для администратора, когда экран неудобен. Правило
владельца: всё делается через панель, поэтому CLI не имеет своей бизнес-логики и не ходит в mailcow
или тенант мимо сервисов. Порядок работы для администратора — [deployment.md, «CLI
панели»](../operations/deployment.md); полный справочник команд — [cli.md](../operations/cli.md).

## Где что

| Файл | Что |
|---|---|
| `backend/src/cli/mailexpert.js` | вход: разбор группы и команды, справка, `--as`, вывод, коды выхода; `run(argv, io)` для тестов |
| `backend/src/cli/args.js` | разбор параметров без зависимостей, `EXIT` |
| `backend/src/cli/common.js` | `CliError`, отказ по каталогу кодов, сбой узла, подтверждение, `--wait` |
| `backend/src/cli/output.js` | таблицы и пары «ключ: значение» |
| `backend/src/cli/commands/*.js` | группы `mailbox`, `domain`, `tenant`, `quarantine`, `jobs`, `access`, `user`, `settings`, `sso`, `integration`, `node`, `eop`, `seats`, `agent`, `queue`, `alerts`, `outage`, `spam-quarantine`, `invite`, `system-email`, `audit`, `account`, `rule` |
| `backend/src/cli/effects.js` | постановка задания `admin_effects` для административных групп, чтение секрета со stdin |
| `backend/src/services/admin/users.js` | пользователи: список, поиск по адресу, одобрение, правка, удаление, сброс 2FA (бывшие обработчики `/api/admin/users`) |
| `backend/src/services/admin/systemSettings.js` | ключи и проверки `PATCH /api/admin/settings` |
| `backend/src/services/auth/oidcProviders.js` | SSO-провайдеры (бывшие обработчики `/api/admin/oidc`) |
| `backend/src/services/integrations/microsoft.js` | клиент Microsoft OAuth: хранение, маскирование секрета, `process.env` |
| `backend/src/services/admin/adminEffects.js` | последствия админских изменений в процессе backend и задание `admin_effects` |
| `backend/src/services/accessSync/actions.js` | синхронизация с Cloudflare Access: снимок настроек, сохранение настроек и токена с журналом, постановка и чтение задания `access_sync`, его обработчик |
| `backend/src/services/actor.js` | кто действует: пользователь маршрута или CLI (`--as`) |
| `backend/src/services/mailNode/mailboxActions.js` | список, создание, имена, запрос и отмена удаления, деактивация и активация ящика узла |
| `backend/src/services/mailNode/domainActions.js` | список доменов администратора, добавление, приём (adopt), шаги онбординга, `ready`, перезапуск, применение настроек домена, ожидаемые значения DNS, принятие времени создания |
| `backend/src/services/mailNode/settingsActions.js` | настройки узла и EOP: просмотр без ключа, сохранение с журналом и применением к узлу, бюджет TERRL |
| `backend/src/services/mailNode/seatActions.js` | места EOP: сводка, сверка с Microsoft (задание), срок удержания |
| `backend/src/services/mailNode/agentActions.js` | агент узла: состояние, выдача и отзыв токена, задания агента, каталог отказов `NODE_AGENT_ERRORS` |
| `backend/src/services/mailNode/errors.js` | каталог отказов узла (бывший `ERRORS` маршрута) |
| `backend/src/services/mailNode/nodeOpsActions.js` | почтовая очередь узла (список, письмо, flush, действия над письмом) и просмотр и настройки оповещений |
| `backend/src/services/mailNode/outageActions.js` | окна простоя: просмотр, письма окна, добавление, правка, закрытие, удаление, настройки, проход трассировки; каталог `OUTAGE_ERRORS` |
| `backend/src/services/mailNode/quarantineActions.js` | карантин rspamd узла: список, действия над записью, настройки панели и mailcow; каталог `QUARANTINE_ERRORS` |
| `backend/src/services/mailNode/nodeChecks.js` | задание `mail_node_check`: проверки узла (DNS всех доменов, оповещения, трассировка простоев), которые CLI ставит для backend |
| `backend/src/services/accountAliases.js` | алиасы ящика с правилом D-16 |
| `backend/src/services/tenant/tenantActions.js` | действия тенанта: статус, задания кнопок, шаги домена, hold, Internal Relay, контакты псевдонимов, выпуск из карантина, задания |
| `backend/src/services/admin/invites.js`, `admin/systemEmail.js`, `admin/auditQuery.js` | приглашения, системная почта, чтение журнала (бывшие обработчики `/api/admin/invites`, `/system-email`, `/audit`); события входа — `services/authEvents.js` (`listAuthEvents`) |
| `backend/src/services/accounts/manualAccounts.js` | ящики, настроенные вручную: поиск по адресу или ID, список, создание (`POST /api/accounts`), смена серверов, сброс привязки OAuth |
| `backend/src/services/accounts/connection.js` | поля подключения ящика, проверки хостов и портов по политике, хранение значений, переподключение (`reconnectAccount`) — общие для `routes/accounts.js` и `manualAccounts.js` |
| `backend/src/services/rules/ruleActions.js` | правила: проверки, список, создание, замена, удаление, журнал, прогон по входящим (бывшие обработчики `/api/rules`) |
| `scripts/deploy/mailexpert-cli.sh` | обёртка на хосте: `docker compose exec backend node src/cli/mailexpert.js`; перед этим одним `docker ps` проверяет, что в compose-проекте панели нет чужих контейнеров (`lib/app.sh` `guard_panel_exec`) |
| `backend/src/cli/googleApp.js`, `scripts/deploy/google-app.sh` | отдельная команда для Google-приложений (добавить из JSON клиента, список, show, enable/close/disable, delete, set-limit, set-label, replace-secret); не группа `mailexpert` ([google-oauth.md](../operations/google-oauth.md)) |

## Один путь для экрана и CLI

Действия вынесены из маршрутов в сервисы; маршрут только читает запрос и отвечает, CLI только
разбирает командную строку и печатает. Ответы маршрутов не изменились, кроме двух отказов создания
ящика, у которых раньше не было кода (`name_invalid`, `mailbox_create_failed`).

- Действие отвечает результатом или `{ error: code }`. Код — ключ каталога (`MAILBOX_ERRORS`,
  `MAIL_NODE_ERRORS`, `TENANT_ERRORS`, `ALIAS_ERRORS`) с HTTP-статусом и текстом: маршрут отвечает
  ими, CLI печатает тот же код и текст. Каталоги живут в сервисах, потому что CLI не должен
  загружать модули маршрутов (`routes/accounts.js` тянет `index.js`, то есть весь сервер).
- Сбой самого узла — по-прежнему `MailNodeError`: маршрут отвечает 502 (или статус ошибки), CLI —
  выходом 3 с кодом узла.
- То, что зависит от процесса сервера, передаётся снаружи: после создания ящика маршрут подключает
  его через `imapManager` (`onCreated`), CLI этого не может — новый ящик подключает проверка
  соединений backend (раз в 90 секунд). Плагины узнают о смене алиасов только от маршрута
  (`onAccountIdentityChanged`); CLI меняет алиасы только ящиков узла, у которых адрес алиаса — адрес
  ящика (D-16), поэтому кэш адресов владельца GTD не устаревает.
- Работа с тенантом — только задания очереди (`docs/architecture/job-queue.md`). CLI их ставит, но
  не выполняет: выполняет воркер backend (опрос раз в секунду). `--wait` следит за заданием по
  `getTenantJob`. Число попыток каждого вида передаётся при постановке (`TENANT_JOB_MAX_ATTEMPTS`,
  `RELEASE_JOB_MAX_ATTEMPTS`, `DOMAIN_SYNC_MAX_ATTEMPTS`), а не берётся из реестра видов: без этого
  процесс, который виды не регистрировал, ставил бы задания с 5 попытками по умолчанию. CLI вдобавок
  регистрирует виды при старте (`main`), но не выполняет их.
- Действия дожидаются постановки заданий (`kickDomainSync` в создании ящика и перезапуске
  онбординга), а `finish()` перед выходом ждёт незаконченные записи журнала (`auditWritesSettled`) и
  только потом закрывает пул. Иначе задание и запись журнала терялись бы при закрытии пула.

Чего нет в общих сервисах. `PUT /api/accounts/:id` остаётся маршрутом: это общий путь правки любых
полей ящика с хуками плагинов и переподключением. CLI меняет имя ящика и имя отправителя своим
действием `setNodeMailboxNames` с проверками формы добавления (`parseSenderNames`), а второе имя —
через общие действия алиасов, всё в одной транзакции. Если у ящика несколько имён с его адресом, CLI
отказывает (`sender_name_alt_ambiguous`) и отправляет в редактор алиасов панели. Второе имя, равное
основному без учёта регистра (какое бы из них ни менялось), отклоняется (`sender_name_alt_same`), а не
отбрасывается молча, как в форме добавления: иначе существующий алиас пропал бы. Пустое `--name` —
`name_required`. ID ящика не с узла — `not_mail_node`, как у маршрута удаления. Имена журнал панели
не ведёт, CLI тоже.

## Почтовый узел из CLI

Группы `node`, `eop`, `seats`, `agent` и команды онбординга `domain` (`add`, `adopt`, `step`,
`ready`, `ack`, `dns-expected`) идут через `settingsActions.js`, `seatActions.js`, `agentActions.js` и
`domainActions.js`; маршруты `routes/mailNode.js`, `mailNodeSeats.js` и `mailNodeAgent.js` теперь
вызывают те же функции. Различия процесса передаются параметром, а не копией логики:

- Сохранение настроек узла и EOP применяет настройки к узлу. Маршрут отвечает сразу и применяет
  после ответа (`background: true`, как раньше); CLI закрывает пул сразу после ответа, поэтому ждёт
  применения и проверки диска (`background: false`) и печатает, что изменилось.
- Постановка синхронизации тенанта после добавления, приёма и шагов домена (`kickDomainSync`)
  дожидается, как в перезапуске онбординга.
- `applyNode` и `applyPrefilter` принимают `actor`, как `applyDomain`: записи `mail_node.applied` от
  CLI несут `via: cli`. Маршрут его не передаёт, его записи прежние.
- Шаги онбординга записывают адрес подтвердившего из строки `users`; без `--as` у CLI адреса нет, в
  шаге остаётся только время, а исполнитель — в журнале (`cli`).
- Токен агента — секрет, который печатает CLI (`agent token issue`; кроме него — только ссылка
  приглашения: `invite create` и, в форме API, `invite list --json`): он для этого и
  выдаётся. `--out FILE` до выдачи токена проверяет, что файла нет, и создаёт рядом временный (0600,
  `wx`), поэтому занятый или недоступный путь не ротирует токен впустую. Токен пишется во временный
  файл и жёсткой ссылкой (`link`, не поверх существующего) становится FILE: тот либо целый, либо его
  нет. Если запись после выдачи не удалась, CLI так и говорит: старый токен уже не работает, выдать
  заново с другим `--out` или `--out -`. Через обёртку `--out` указывает файл на хосте, обёртка
  запускает CLI с `--out -`.
- Применения настроек узла (`applyNode`, `applyDomain`, `applyPrefilter`) кроме очереди внутри процесса
  держат сессионную advisory-блокировку PostgreSQL на отдельном соединении (`withSessionLock` в
  `db.js`): применение из CLI и из backend не пересекаются.

## Операции узла из CLI

Группы `queue`, `alerts`, `outage`, `spam-quarantine`, команды `mailbox set-quota` / `set-rate-limit`,
`domain dns-check`, `tenant poll` и `tenant connectors-reference` идут через `nodeOpsActions.js`,
`outageActions.js`, `quarantineActions.js`, `mailboxActions.js`, `dnsCheckJob.js` и
`tenant/tenantActions.js`; маршруты `routes/mailNode.js`, `mailNodeOutages.js`, `mailNodeQuarantine.js`
и `mailNodeTenant.js` вызывают те же функции, их ответы и записи журнала прежние. Записи от CLI несут
`via: cli`: функции окон простоя (`addOutage`, `updateOutage`, `deleteOutage`) принимают `actor` вместо
ID пользователя (ID по-прежнему принимается), проверки DNS и оповещений — необязательный `by`.

Три проверки принадлежат процессу backend, и CLI их не выполняет: проверка DNS всех доменов и проверка
оповещений присоединяются к идущему в процессе прогону, проверка оповещений после себя запускает
трассировку простоев, не дожидаясь её, а трассировка ведёт бюджет запросов и паузу принудительного
прохода в памяти процесса. Прогон в CLI работал бы мимо этих ограничений и оставлял бы фоновую работу
при закрытии пула. Поэтому `domain dns-check` без домена, `alerts check` и `outage trace` ставят
задание `mail_node_check` (`payload.check`: `dns`, `alerts`, `outage_trace`; одна попытка), которое
backend регистрирует в `index.js`; обработчик вызывает `checkAllNow`, `checkAlertsNow` и
`traceOutagesNow` с автором и `via` задания. `--wait` следит за заданием (`maybeWait` с
`nodeCheckWait`), итог печатается из сохранённого состояния. Проверка одного домена
(`domain dns-check <DOMAIN>`) общего состояния не держит и идёт в CLI сразу.

## Синхронизация с Cloudflare Access из CLI

Группа `access` (`cli/commands/access.js`) работает через `services/accessSync/actions.js`, которым
теперь пользуется и маршрут `routes/accessSync.js`. Прогон синхронизации зависит от процесса
backend: планировщик (`services/accessSync/index.js`) один на процесс, держит очередь прогонов и
сохранений настроек, а отключённого пользователя прогон разлогинивает (`destroyUserSessions` и
`closeUserSockets` из `index.js`, которые CLI загрузить не может). Поэтому `access sync` ставит
задание `access_sync` (`max_attempts` 1: прогон не бросает исключений, его неудача — итог) и ждёт его;
обработчик, зарегистрированный backend, вызывает `runAccessSyncNow()` и кладёт итог в `payload.result`
задания. `access config` и `access token` сохраняют настройки сами (`saveAccessSyncConfig`) и, если
синхронизация включена, ставят такое же задание — как экран просит прогон у планировщика.

Сохранение из CLI идёт в другом процессе, мимо блокировки планировщика (`withAccessSyncLock` — только
внутри процесса). Поэтому всё, что читает настройки или состояние и пишет обратно, идёт в одной
транзакции с advisory-блокировкой PostgreSQL (`pg_advisory_xact_lock`, общий ключ;
`withAccessSyncTransaction` в `settings.js`): сохранение настроек экраном и CLI (`updateConfig`: чтение,
слияние частичной правки CLI, сброс состояния, запись) и запись итога прогона в `runner.js` (чтение
настроек, сравнение с теми, с которыми прогон начинал, запись). Прогон, начатый со старой политикой,
видит новую и не пишет её базовый список поверх сброса (иначе следующий прогон отключил бы
пользователей по чужому списку), а две частичные правки из разных процессов не теряют друг друга.
Проверено `services/accessSync/settings.race.pglite.test.js`: второй писатель запускается между
чтением и записью первого.

Токен CLI читает только со stdin (`io.readStdin`), поэтому обёртка выполняет свою проверку `test -f`
с `</dev/null`: `docker compose exec` пересылает stdin, и проверка съела бы токен.

## Пользователи, настройки, SSO и клиент Microsoft из CLI

Обработчики `/api/admin/users`, `PATCH /api/admin/settings`, `/api/admin/oidc` и
`/api/integrations/microsoft` вынесены в сервисы (таблица выше); маршруты только читают запрос и
отвечают. Ответы маршрутов не изменились: отказы, у которых не было кода (сброс 2FA, удаление себя,
большинство отказов настроек и все отказы SSO), маршрут отдаёт по-прежнему только текстом; коды у них
есть внутри сервиса и в CLI. Последний активный администратор защищён так же: проверки и удаление идут
под `lockAdminGuard` в одной транзакции.

Часть последствий живёт только в процессе backend: разлогинить пользователя (`destroyUserSessions`
работает с Redis, к которому CLI не подключается, `closeUserSockets` — с сокетами процесса), хук
плагинов `onUserDelete`, планировщик синхронизации с Access (`requestAccessSync`), а также то, что
процесс держит в памяти: лимиты входа (`reloadAuthSettings`), интервалы синхронизации ящиков
(`imapManager.applySyncSettings`), кэши категоризации и политики подключений, клиент Microsoft в
`process.env`. Сервис отвечает их списком (`effects`: `signOut`, `userDeleted`, `accessSync`,
`reload`), не выполняя. Маршрут выполняет их сразу (`applyAdminEffects` с `ADMIN_EFFECT_HOOKS` из
`routes/admin.js`); CLI ставит задание `admin_effects` (`max_attempts` 3, все хуки можно повторить),
которое воркер backend выполняет с теми же хуками (`registerAdminEffectsJobKind` в `index.js`).
Порядок: разлогинить, перечитать, очистка плагинов, синхронизация с Access. Отказ настроек на
середине тоже несёт `effects` — то, что маршрут успел бы перечитать до отказа.

Чего здесь нет. Выключить вход по паролю (`internal_auth_disabled true`) экран разрешает, только если у
самого администратора есть SSO-учётка; у CLI без `--as` администратора нет, и такой запрос отклоняется
(`sso_identity_required`) — нужен `--as`. Сброс 2FA, настройки, SSO и клиент Microsoft журнал не пишут:
экран их тоже не журналирует, а новые действия журнала (`AUDIT_ACTIONS`) в эту работу не входили.
Сбросить блокировки входа по лимиту попыток панель не умеет, поэтому и CLI тоже.

## Приглашения, системная почта, журнал, ящики и правила из CLI

Обработчики `/api/admin/invites`, `/api/admin/system-email`, `/api/admin/audit`,
`/api/admin/auth-events`, `POST /api/accounts` (ручная настройка), `POST
/api/accounts/:id/oauth-subject/reset` и `/api/rules` вынесены в сервисы (таблица выше); ответы
маршрутов не изменились. `requireMailbox` (`utils/requireMailbox.js`) получил чистую часть
`findMailboxId`, которой пользуются сервис правил и CLI.

- Приглашение требует `created_by` (`NOT NULL`): CLI создаёт его только с `--as`. Письмо отправляет сам
  процесс CLI через системный SMTP — это сеть, а не состояние backend. Приглашения и системная почта
  журнал не пишут, как и экран.
- `PUT /api/accounts/:id` по-прежнему маршрут (правка любых полей с хуками плагинов). Общими стали его
  части про подключение: поля, проверка хостов и портов по политике, хранение значений, переподключение
  (`services/accounts/connection.js`). `account set-connection` вызывает `updateAccountConnection`,
  который меняет только поля подключения с теми же проверками и записью `mailbox.connection_changed`.
  Проверки соединения при сохранении у маршрута нет, у CLI тоже.
- Подключение ящика и прогон правил по входящим требуют IMAP-соединений процесса backend. Маршрут
  делает это сразу; CLI ставит `admin_effects` с новыми видами последствий: `reconnect` (ID ящиков,
  хук `reconnectAccount` с той же очередью на ящик, что у маршрута, подключает только включённый
  IMAP-ящик) и `runRules` (ID ящиков; хук занимает ящики, как `POST /api/rules/run`, и запускает
  прогон в фоне; занятый ящик пропускается). Запись `rule.run` пишет хук, когда занял ящики, от
  того, кто поставил задание (`created_by` и `via` задания), как маршрут при старте прогона.
  Пароли со stdin (`system-email`, `account`) берутся как есть: `readSecret(..., { exact: true })`
  отбрасывает только один перевод строки в конце; ключи и токены по-прежнему обрезаются.
- Правила принадлежат ящику (миграция 0056 убрала `user_id`), поэтому «от имени пользователя»
  значит автора: `--user` ставит `created_by` при создании и `details.onBehalfOf` в записи журнала;
  исполнитель — по-прежнему `cli` или `--as`. Отдельного включения и выключения у API нет: CLI, как
  экран, сохраняет правило целиком (`rule.updated`). Запуска одного правила у панели нет, `rule run`
  прогоняет все включённые правила ящика или всех ящиков.

## Кто в журнале

`actor = { userId, via }` (`services/actor.js`). Маршрут передаёт `{ userId }` — записи журнала те же,
что раньше. CLI передаёт `{ userId: null, via: 'cli' }` или, с `--as`, id администратора (включённого,
`disabled_at IS NULL`). `auditOf` добавляет `details.via = 'cli'`, а без пользователя ставит
исполнителя `cli` (`actor_email`). С `--as` журнал берёт адрес администратора из `users`, поэтому
`cli` остаётся только в `details.via`. Новых действий журнала CLI не вводил, кроме двух для
синхронизации с Access: раньше маршрут настроек писал только строку в лог сервера, теперь и экран,
и CLI пишут `access.config_changed` (изменённые поля, ID, `tokenChanged`, никогда сам токен) и
`access.sync_requested` (прогон по запросу администратора).

Задания, поставленные CLI, несут `created_by` = id администратора `--as` или `NULL` и `via: 'cli'` в
`payload`. Свои записи журнала задание пишет через `jobAudit` (`services/tenant/tenantJobs.js`): от
`created_by` и с `details.via`, без пользователя — от `cli`; задание, которое никто не ставил (по
расписанию), — от `MailExpert`. Так подписаны `tenant.connection_tested` и `tenant.antispam_enforced`.
Записи прогона домена и выпуска из карантина (`mail_node.domain_state_changed` с `how: tenant_driver`,
`tenant.quarantine_released`) и при кнопке на экране пишутся от `MailExpert`; CLI это не меняет.

Справка каждой меняющей команды говорит, что она пишет в журнал (`Journal: ...`).

`approve-alias-removal` показывает адреса, которые держит последний прогон, и одобряет только их:
действие получает показанный список (`expected`) и отказывает (`alias_contacts_changed`), если
прогон тем временем изменил его. Пустой список — отказ `alias_contacts_not_held` без вопроса.

## Подтверждения и терминал

Необратимые действия спрашивают «y/N». `--yes` отвечает «да»; без терминала (или с `--json`) CLI не
ждёт ответа и выходит с кодом 2 (`confirmation_required`). Удаление ящика подтверждается вводом
адреса, как в интерфейсе (D-14); `--yes` его не заменяет, нужен `--confirm-address`. Обёртка даёт
контейнеру терминал, только когда он есть с обеих сторон и среди параметров нет `--json`, иначе
`exec -T`: с терминалом stderr сливается со stdout, и JSON для конвейера сломался бы.

Обёртка до запуска CLI проверяет, что контейнер `backend` работает и что в образе есть CLI
(образ старее этой версии его не содержит). Её собственные ошибки — код 2 (параметры, не root,
установка), сбой docker (контейнер не запущен, нет CLI в образе, коды docker 125-127) — код 3; коды
CLI проходят как есть.

## Тесты

- `cli/args.test.js`, `cli/output.test.js`, `cli/mailexpert.test.js` — разбор, вывод, справка каждой
  команды, коды выхода, подтверждения, `--as`, `--wait` с замоканными действиями.
- `cli/mailexpert.jobs.pglite.test.js` — задания без зарегистрированных видов: попытки вида, `via` в
  `payload`, автор `--as`; кто подписывает записи журнала задания.
- `cli/mailexpert.mailNode.pglite.test.js`, `cli/mailexpert.tenant.pglite.test.js` — команды каждой
  группы против PGlite со всеми миграциями, mailcow в памяти (`services/testing/fakeMailcow.js`) и
  фейкового драйвера тенанта (`TENANT_DRIVER=fake`, режим стенда и демо): записи в базу и журнал,
  отказы с кодами API, пароль ящика не печатается, задания выполняет воркер теста.
- `cli/mailexpert.nodeOps.pglite.test.js` — группы `node`, `eop`, `seats`, `agent`, деактивация ящика
  и команды онбординга `domain` на PGlite с mailcow в памяти: записи и журнал от `cli`, ключ mailcow
  со stdin не печатается, применение к узлу до выхода, хеш выданного токена агента, файл `--out`.
- `cli/mailexpert.nodeQueue.pglite.test.js` — проверка DNS, квота и лимит ящика, группы `queue`,
  `alerts`, `outage`, `spam-quarantine` на PGlite с mailcow в памяти: записи и журнал от `cli`,
  подтверждения, задания `mail_node_check` выполняет воркер теста.
- `cli/mailexpert.access.pglite.test.js` — группа `access` на PGlite: токен со stdin хранится
  зашифрованным и нигде не печатается, частичные правки настроек, задание `access_sync` выполняет
  воркер теста против поддельного API Cloudflare (`fetch`), коды выхода итогов, журнал от `cli` и
  `--as`.
- `cli/mailexpert.admin.pglite.test.js` — группы `user`, `settings`, `sso`, `integration` на PGlite:
  последний администратор, bootstrap-адреса, занятый адрес, `--as` и `self_change`, журнал от `cli`,
  секреты со stdin хранятся зашифрованными и не печатаются, задание `admin_effects` выполняет воркер
  теста с записывающими хуками (разлогин, перечитывание, очистка, синхронизация).
- `services/admin/adminEffects.test.js` — слияние и порядок выполнения последствий.
- `cli/mailexpert.panelOps.pglite.test.js` — группы `invite`, `system-email`, `audit`, `account` и
  `mailbox oauth-reset` на PGlite с подменённым SMTP и DNS: `--as` у приглашения, пароли со stdin
  хранятся зашифрованными и не печатаются, проверки хостов и портов, фильтры журнала, задание
  `reconnect`.
- `cli/mailexpert.rules.pglite.test.js` — группа `rule` на PGlite: проверки API, `--user` как автор,
  журнал с прежним адресом пересылки, включение целым сохранением, задание `runRules`.
- `routes/admin.effectHooks.pglite.test.js` — настоящие хуки `ADMIN_EFFECT_HOOKS`: `reconnect` не
  подключает выключенный ящик, `runRules` пишет `rule.run` от автора задания только после захвата
  ящика и пропускает ящик, который уже прогоняется.
- `scripts/deploy/test/mailexpert-cli.bats` — разбор параметров обёртки, а с `id` и `docker`,
  подменёнными в `PATH`, — вызов контейнера: `-T`, параметры без изменений, stdin целиком до CLI, коды
  CLI, сбои docker, файл токена агента на хосте (`agent token --out`).
