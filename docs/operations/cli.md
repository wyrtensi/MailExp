# CLI панели: справочник

Командная строка `mailexpert` — те же действия администратора, что и на экранах панели, для случаев,
когда экран неудобен: массовые действия, скрипты, работа по SSH. CLI не имеет своей бизнес-логики:
команды вызывают те же сервисы backend, что и HTTP-маршруты, с теми же проверками, кодами отказов и
записями журнала. Мимо панели (напрямую в mailcow, тенант или Cloudflare) CLI ничего не делает, а
работу для тенанта, прогон синхронизации с Cloudflare Access и то, что после изменения пользователей и
настроек должен сделать процесс backend (разлогинить, перечитать настройки), только ставит в очередь
заданий: выполняет её воркер backend.

Это полный справочник. Устройство и причины решений — в [panel-cli.md](../architecture/panel-cli.md);
краткая сводка для владельца и остальные операции — в
[deployment.md, «CLI панели»](deployment.md#cli-панели).

Плейсхолдеры: `<PREFIX>` — каталог установки панели (по умолчанию `/opt/mailexpert`), `<DOMAIN>` —
домен почтового узла, `<LOCAL>@<DOMAIN>` — адрес ящика, `<ADMIN_EMAIL>` — адрес администратора панели,
`<ACCOUNT_ID>`, `<APP_ID>`, `<POLICY_ID>` — ID аккаунта, приложения и политики Cloudflare Access
([cloudflare.md](cloudflare.md)), `<USER_EMAIL>` — адрес пользователя панели, `<IDP_NAME>`, `<SLUG>`,
`<IDP_HOST>` — имя, slug и хост SSO-провайдера, `<CLIENT_ID>` — ID OAuth-клиента.

## 1. Как запускать

### На сервере: обёртка

```bash
sudo <PREFIX>/app/scripts/deploy/mailexpert-cli.sh [--prefix <PREFIX>] [--] <группа> <команда> [параметры]
```

Обёртка `scripts/deploy/mailexpert-cli.sh` находит установленную панель так же, как остальные скрипты
развёртывания (`install.conf` в `<PREFIX>`), проверяет, что контейнер `backend` работает и что в его
образе есть `src/cli/mailexpert.js`, и выполняет `docker compose exec backend node
src/cli/mailexpert.js ...`, передавая все остальные аргументы без изменений.

- Нужен root (`sudo`).
- `--prefix <PREFIX>` — параметр самой обёртки, он идёт перед группой. Значение — абсолютный путь без
  пробелов (`^/[A-Za-z0-9._/-]+$`); без `--prefix` берётся `/opt/mailexpert`.
- `--` завершает параметры обёртки. `--help`/`-h` перед группой — справка обёртки (работает без root и без
  установленной панели). Справка группы и команды (`domain --help`) — это справка самого CLI, ей нужна
  установленная панель.
- Имя группы проверяется до docker: оно должно быть строчными латинскими буквами и дефисами
  (`^[a-z][a-z-]*$`).
- Терминал контейнеру обёртка даёт только когда он есть и на входе, и на выходе, и среди аргументов нет
  `--json`. Иначе `docker compose exec -T`: с терминалом stderr слился бы со stdout и сломал JSON. Значит,
  в конвейере, скрипте и с `--json` CLI не может задать вопрос: действие, которое просит подтверждения,
  требует `--yes` (удаление ящика — `--confirm-address`).
- stdin обёртки доходит до CLI целиком: `access token < файл`, `sso add`, `sso set --secret` и
  `integration microsoft set --secret` читают секрет оттуда. Свои проверки
  перед запуском CLI обёртка делает без stdin.

Параметры CLI (`--json`, `--yes`, `--as`, `--wait`) идут после команды, а не перед группой: перед ней
обёртка понимает только `--prefix`, `--` и `--help`.

### Внутри контейнера

```bash
docker compose exec backend node src/cli/mailexpert.js <группа> <команда> [параметры]
```

Это то же самое без обёртки (в `backend/package.json` файл объявлен как `bin` с именем `mailexpert`).
Подтверждения спрашивают, только если у процесса есть терминал на stdin и stderr (`-T` его отключает).

### На локальном стенде

Стенд (`scripts/deploy/test/stage.sh`, [local-stand.md](local-stand.md)) — один контейнер Docker-in-Docker
`me-stage`; панель в нём запущена compose-проектом `stage`, поэтому контейнер backend называется
`stage-backend`. `install.conf` на стенде нет, обёртка к нему не применяется; CLI запускается напрямую:

```bash
docker exec -i me-stage docker exec -i stage-backend node src/cli/mailexpert.js domain list
docker exec -it me-stage docker exec -it stage-backend node src/cli/mailexpert.js domain restart <DOMAIN>
```

Без `-t` вопросов нет, нужны `--yes` / `--confirm-address`. Команда работает, если образ панели на стенде
содержит CLI; иначе `node` ответит, что файла нет.

## 2. Общие правила

### Разбор командной строки

- `<группа> <команда> [параметры и аргументы]`. Параметры и позиционные аргументы можно перемежать.
- Параметр со значением — `--name значение` или `--name=значение`. Значение, начинающееся с `-`, всё
  равно значение (`--reason --json` задаёт причину `--json`, а не включает JSON).
- Булевы параметры не принимают значения (`--json=1` — ошибка использования).
- `--` — всё после него позиционные аргументы. Одиночный `-` — тоже аргумент.
- Один параметр дважды — ошибка (`--name is given twice`). Неизвестный параметр, лишний аргумент и
  недостающий аргумент — ошибка использования, код выхода 2.
- Короткие формы есть только у `-y` (`--yes`) и `-h` (`--help`); других однобуквенных параметров нет.
- `--help` (или `-h`) отвечает справкой и ничего не выполняет, даже если не хватает аргументов или
  их слишком много. Ошибки в самих параметрах (неизвестный параметр, параметр дважды, значение у
  булева, нет значения) разбираются раньше и дают ошибку использования с кодом 2, а не справку.

### Общие параметры

| Параметр | Что делает |
|---|---|
| `--json` | Печатает ответ действия как JSON на stdout, в тех же формах, что отвечает API панели. Ошибка — `{ "error", "code" }` на stdout. С `--json` вопросов не бывает никогда, даже в терминале. |
| `--yes`, `-y` | Отвечает «да» на подтверждение необратимого действия. Удаление ящика им не подтверждается (нужен `--confirm-address`). |
| `--as <ADMIN_EMAIL>` | Записать действие в журнал от имени этого администратора. Администратор ищется по адресу (или имени пользователя), он должен быть включённым администратором панели, иначе отказ `admin_not_found` (код 1) до любого действия. Без `--as` исполнитель в журнале — `cli`. |
| `--wait`, `--timeout <SEC>` | Только у команд, ставящих задание (раздел 3). Ждать, пока воркер backend выполнит задание. `--timeout` — секунды ожидания, целое от 1 до 3600, по умолчанию 120. |
| `--help`, `-h` | Справка CLI, группы или команды. Справка команды содержит строку `Journal:`. |

`mailexpert --help`, `mailexpert help` — список групп (stdout, код 0). `mailexpert` без аргументов,
`mailexpert <группа>` без команды — та же справка на stderr и код 2. Справка группы:
`mailexpert <группа> --help`.

### Подтверждения

Необратимое действие спрашивает `[y/N]` в терминале (ответ `y` или `yes`, любой другой — отмена:
код 1, код ошибки `cancelled`, ничего не изменено). Без терминала (конвейер, `exec -T`, `--json`) CLI не
ждёт ответа: код 2, ошибка `confirmation_required`. `--yes` отвечает «да».

Спрашивают: `domain restart`, `domain allow-authoritative`, `domain internal-relay`,
`domain approve-alias-removal`, `quarantine pause`, `user delete`, `user totp-reset`, `sso remove`,
`integration microsoft remove`. Не спрашивают: `domain hold`, `domain sync`,
`quarantine resume`, `quarantine release`, `tenant test`, `tenant antispam`, `mailbox ...` (кроме
`delete`), все команды чтения.

`mailbox delete` подтверждается вводом полного адреса ящика: на вопрос в терминале или параметром
`--confirm-address <ADDRESS>`. `--yes` его не заменяет. Без терминала и без `--confirm-address` — код 2,
`confirmation_required`. `--reason` обязателен и без него команда завершается кодом 2 до всего остального.
Введённый адрес сверяет действие панели (то же, что экран): несовпадение — `confirmation_mismatch`.

`domain approve-alias-removal` перед вопросом пишет в stderr адреса, которые держит последний прогон
(`Contacts held on <DOMAIN>: ...`), и одобряет только их.

### Задания и `--wait`

Команды, ставящие задание тенанта: `domain sync`, `domain internal-relay`, `domain approve-alias-removal`,
`tenant test`, `tenant antispam`, `quarantine release`; `domain allow-authoritative` (снятие удержания)
тоже ставит прогон домена, но отвечает состоянием домена, а не заданием. CLI ставит задание в очередь и, без `--wait`,
сразу отвечает его состоянием (`job <ID> (<вид>) queued`, либо `already queued`, если такое задание уже
стоит и новое не создано; в JSON это `created: false`). Выполняет задание воркер backend (опрос раз в
секунду): если backend остановлен, задание ждёт.

С `--wait` CLI опрашивает задание, пока его состояние не станет `done`, `failed`, `cancelled` или
`needs_attention`:

- `done` — код 0, в ответе итоговое задание.
- Любой другой конец — код 3; код ошибки — `errorCode` задания (или `job_<состояние>`), в JSON-ошибке есть
  поле `job`.
- Время вышло — код 3, ошибка `wait_timeout` с подсказкой `jobs show <ID>`, в JSON-ошибке поле `job`.

Состояния заданий: `queued`, `running`, `done`, `failed`, `cancelled`, `needs_attention`. Виды заданий
тенанта (для `jobs list --kind`): `tenant_test_connection`, `tenant_poll`, `tenant_antispam_read`,
`tenant_domain_sync`, `tenant_quarantine_release`.

### Журнал аудита

У каждой меняющей команды справка говорит, что она пишет в журнал (`Journal: ...`). Записи, которые пишет
CLI, имеют исполнителя `cli` (или администратора из `--as`) и `details.via = "cli"`. С `--as` адрес
берётся из таблицы пользователей, так что `cli` остаётся только в `details.via`. Задания, поставленные CLI,
несут автора `--as` (или никого) и `via: cli`, поэтому и записи, которые пишет само задание, подписаны так
же. Действия журнала у CLI те же, что у экранов; для синхронизации с Access экран и CLI пишут
`access.config_changed` (изменение настроек или токена, без значения токена) и `access.sync_requested`
(прогон по запросу администратора).

## 3. Группы и команды

Ящик называется адресом или ID (UUID); если у адреса две строки в панели, CLI просит ID
(`mailbox_ambiguous`). Домен — именем (`example.com`), регистр не важен.

### 3.1. `mailbox`: ящики почтового узла

| Команда | Что делает | Журнал |
|---|---|---|
| `mailbox list [--domain <DOMAIN>]` | Список ящиков узла с квотой, использованием, лимитом отправки и ожидающими удалениями; `--domain` оставляет ящики одного домена. | нет (чтение) |
| `mailbox show <address\|id>` | Один ящик: имена, ожидающее удаление и взгляд узла (активен ли, квота, использование). Недоступный узел не ошибка: он показан полем `node.error`. | нет (чтение) |
| `mailbox create <LOCAL>@<DOMAIN> [--name N] [--sender-name N] [--second-sender-name N]` | Создаёт ящик на узле; домен должен завершить онбординг. | `mailbox.added`, как у панели |
| `mailbox set-names <address\|id> [--name N] [--sender-name N] [--second-sender-name N]` | Переименовывает ящик или меняет имена отправителя. Нужен хотя бы один параметр. | нет: панель имена тоже не журналирует |
| `mailbox delete <address\|id> --reason TEXT [--confirm-address ADDRESS]` | Просит удалить ящик со всей почтой после дней ожидания из настроек почтового узла (D-14). Причина обязательна и остаётся в журнале. | `mailbox.deletion_requested` с причиной |
| `mailbox cancel-deletion <address\|id>` | Отменяет ожидающее удаление, ящик остаётся как есть. | `mailbox.deletion_cancelled` |

Параметры имён (у `create` и `set-names`):

- `--name NAME` — имя ящика в панели (при создании по умолчанию адрес). Пустое имя — `name_required`.
- `--sender-name NAME` (синоним `--ru`) — имя отправителя, например кириллицей.
- `--second-sender-name NAME` (синоним `--en`) — второе имя отправителя с тем же адресом, например
  латиницей; `""` убирает его. Второе имя, совпадающее с основным без учёта регистра, отклоняется
  (`sender_name_alt_same`). Если у ящика несколько имён с его адресом, CLI отказывает
  (`sender_name_alt_ambiguous`): их правят в редакторе алиасов панели.
- Алиаса с другим адресом CLI не делает (D-16): другой адрес — отдельный ящик.

Подробности:

- `create` не печатает пароль: хост, порты и пароль выбирает панель. Backend подключает новый ящик сам в
  течение 90 секунд (проверка соединений). Если домен Authoritative, а у тенанта ещё нет получателя,
  ответ содержит `tenantPending: true` и человеческая строка `note: the domain is Authoritative; EOP
  accepts mail for the address once the tenant has its recipient`.
- `delete`: ящик продолжает работать до срока, потом задание удаления удаляет его на узле со всей почтой.
  Отменить можно до срока командой `cancel-deletion`.
- `list`: колонки `ADDRESS`, `ON NODE` (`active`, `inactive`, `missing`), `QUOTA MB`, `USED MB`,
  `SEND LIMIT` (`<N>/<период>`, `(own)` у собственного лимита), `DELETION`, `SENDER NAME`; после таблицы
  строка `disk: N% used` (или `disk: not read (<код>)`).
- `show` и `list` читают узел; сбой чтения узла в `list` — ошибка (код 3), а в `show` отображается в
  ответе.

### 3.2. `domain`: домены узла и их онбординг

| Команда | Что делает | Подтверждение | Журнал |
|---|---|---|---|
| `domain list` | Список доменов с состоянием онбординга, следующим шагом, числом ящиков, удержанием на Internal Relay и числом предупреждений; в конце, ведёт ли тенантские шаги драйвер. | нет | нет |
| `domain show <DOMAIN>` | Один домен: шаги онбординга (кто и когда подтвердил), проверка DNS, применение настроек узла, последний прогон тенанта и предупреждения. | нет | нет |
| `domain restart <DOMAIN>` | Возвращает онбординг домена к `node_created`: без подтверждённых шагов и без того, что держали узел или тенант; режим DKIM, лимит отправки и ящики остаются; настройки узла применяются заново. | да | `mail_node.domain_state_changed`, и `mail_node.applied`, когда настройки узла меняются |
| `domain sync <DOMAIN> [--wait] [--timeout SEC]` | Ставит задание: выполнить тенантские шаги домена сейчас. | нет | при постановке нет; то, что меняет прогон, журналирует MailExpert, как для кнопки |
| `domain hold <DOMAIN>` | Держать домен на Internal Relay (так по умолчанию). | нет | `tenant.domain_hold_changed`, когда удержание меняется |
| `domain allow-authoritative <DOMAIN>` | Разрешить полному зеркалу получателей сделать домен Authoritative. После этого EOP отвергает почту на адреса домена, для которых у тенанта нет получателя, включая ручные алиасы mailcow (D-16). | да | `tenant.domain_hold_changed`, когда удержание меняется |
| `domain internal-relay <DOMAIN> [--wait] [--timeout SEC]` | Одобрить перевод домена, который у тенанта Authoritative, в Internal Relay. Ставит задание. | да | `tenant.internal_relay_approved` |
| `domain approve-alias-removal <DOMAIN> [--wait] [--timeout SEC]` | Разрешить зеркалу убрать контакты ручных алиасов mailcow на домене Authoritative (раздел 5.14 требований): почта на эти алиасы отвергается EOP со следующего прогона. Ставит задание. | да, после показа адресов | `tenant.alias_contacts_removal_approved` с адресами |

Предупреждения `domain show` и счётчик в `domain list` собирает CLI. Он указывает, в частности: узел не
знает домен или не читается; домен неактивен на узле; узел сообщает другое время создания, чем то, к
которому привязана панель; проверка DNS не `ok` (с перечнем неудачных проверок); не удалось применить
настройки узла; ошибки отдельных частей прогона тенанта; тенант держит домен Authoritative и нужно
одобрить перевод командой `domain internal-relay`; есть контакты алиасов, ждущие решения
(`domain approve-alias-removal`); ручные алиасы mailcow не зеркалируются в тенант; тенант ограничил
последний прогон.

`domain approve-alias-removal`: список контактов, которые держит последний прогон, пуст — отказ
`alias_contacts_not_held` без вопроса. Если прогон за время вопроса изменил список — отказ
`alias_contacts_changed`, ничего не одобрено.

### 3.3. `tenant`: тенант Microsoft

Ничего из этой группы не обращается к тенанту или его воркеру напрямую: `status` читает то, что сохранили
задания, остальные команды ставят те же задания, что кнопки экрана.

| Команда | Что делает | Журнал |
|---|---|---|
| `tenant status` | Драйвер тенанта (`none`, если нет), настроен ли тенант, достиг ли backend воркера (по сохранённым результатам проверки и опроса), последняя проверка соединения, срок сертификата, заблокированные коннекторы, изменения коннекторов с эталона, последние задания проверки/опроса/антиспама и состояние антиспам-политики. | нет |
| `tenant test [--wait] [--timeout SEC]` | Ставит проверку соединения с тенантом через воркера (кнопка «Test connection»). | `tenant.connection_tested`, пишет задание |
| `tenant antispam [--wait] [--timeout SEC]` | Проверяет и исправляет политику Default anti-spam (кнопка «Check and fix»): действия spam, high confidence spam, phishing и bulk ставятся в `MoveToJmf`, где они отличаются (раздел 5.14); что изменилось, журналируется. | `tenant.antispam_enforced`, пишет задание, когда меняет политику |

В `tenant status` строка `worker profile without driver` появляется, когда профиль воркера включён, но
`TENANT_WORKER_URL` не задан или токен слишком короткий.

### 3.4. `quarantine`: выпуск из карантина EOP

Автоматический выпуск спама и фишинга из карантина EOP (R-42, раздел 5.14), та же часть экрана тенанта
«Spam and phishing in EOP's quarantine». Собственный карантин почтового узла (mailcow) остаётся в панели.

| Команда | Что делает | Подтверждение | Журнал |
|---|---|---|---|
| `quarantine status` | Работает ли автоматический выпуск, последний проход, число удерживаемых сообщений и срок первого, последнее задание. | нет | нет |
| `quarantine list` | Сообщения, которые панель держит в карантине EOP (удержаны проверкой или закончились попытки): получено, истекает, тип, состояние:причина, отправитель, получатели, тема. | нет | нет |
| `quarantine release [--wait] [--timeout SEC]` | Запускает проход выпуска сейчас (кнопка «Release now»). Проход выпускает то, что разрешают проверки; вредоносное ПО и прочие типы не выпускаются никогда. Отказ, пока автоматический выпуск на паузе. | нет | при постановке нет; каждое выпущенное сообщение журналирует MailExpert, как для кнопки |
| `quarantine pause` | Приостановить автоматический выпуск: письма остаются в карантине вместо папки Spam. | да | `tenant.phish_release_changed`, когда состояние меняется |
| `quarantine resume` | Возобновить автоматический выпуск. | нет | `tenant.phish_release_changed`, когда состояние меняется |

### 3.5. `jobs`: задания тенанта в очереди

Только задания тенанта: кнопки, тенантские шаги доменов и выпуск из карантина. Письма в очереди отправки
здесь не показываются, они принадлежат своим авторам.

| Команда | Что делает |
|---|---|
| `jobs list [--status S] [--kind K] [--limit N]` | Новейшие задания первыми. `--status` — одно из `queued`, `running`, `done`, `failed`, `cancelled`, `needs_attention` (можно через запятую) или `problems` (то есть `failed` и `needs_attention`). `--kind` — один или несколько видов через запятую (раздел 2). `--limit` — сколько, целое от 1 до 500, по умолчанию 30. Колонки: `ID`, `KIND`, `STATUS`, `DOMAIN`, `UPDATED`, `ERROR`. |
| `jobs show <ID>` | Одно задание: вид, состояние, время создания и обновления, код и текст ошибки. Неизвестный ID — `tenant_job_not_found`. |

Журнал эти команды не пишут (чтение).

### 3.6. `access`: синхронизация пользователей с Cloudflare Access

Та же синхронизация, что раздел «Синхронизация с Access» в настройках администратора: MailExpert
держит Allow-политику приложения Access в соответствии со своими одобренными пользователями. Как
создать приложение, политику и токен — [cloudflare.md](cloudflare.md), разделы 3, 5 и 8. Настройки
CLI сохраняет тем же действием, что и экран (`services/accessSync/actions.js`); сам прогон CLI не
выполняет, а ставит задание `access_sync`, которое выполняет backend: только он может разлогинить
отключённых пользователей и не пересечься с ежечасным прогоном.

| Команда | Что делает | Журнал |
|---|---|---|
| `access status` | Настройки (включена ли, ID аккаунта, приложения и политики, задан ли токен — сам токен никогда), режим входа `google`, предел отключений за прогон (`ACCESS_SYNC_MAX_DISABLES`), последний прогон: итог, источник, время, сколько добавлено, удалено, отключено. | нет |
| `access config [--account ID] [--app ID] [--policy ID] [--enable \| --disable]` | Меняет только названные поля, остальные остаются. ID аккаунта — 32 шестнадцатеричных символа, ID приложения и политики — UUID (`invalid_id`); включить можно только с тремя ID и токеном (`incomplete`). Смена аккаунта, приложения или политики забывает, что синхронизация писала в старую. Если синхронизация после сохранения включена, ставится прогон (в ответе — ID задания). Без параметров или с `--enable --disable` — код 2. | `access.config_changed`: изменённые поля, ID, включена ли |
| `access token` | Читает API-токен Cloudflare **только со stdin** (файл или конвейер; в терминале — вставить и нажать Ctrl-D), не из аргументов, и нигде его не печатает. Пробелы по краям и перевод строки отбрасываются; токен — одна строка из 20-512 символов без пробелов, иначе `token_invalid`. Хранится зашифрованным. Остальные настройки не меняются; если синхронизация включена, ставится прогон. Права токена — «Access: Apps and Policies» Edit на один аккаунт. | `access.config_changed` с `tokenChanged: true` (без значения) |
| `access sync [--timeout SEC]` | Ставит прогон и ждёт его итога (по умолчанию до 120 секунд). | `access.sync_requested`; сам прогон пишет `user.disabled` и `access.sync_aborted` от «Cloudflare Access», как всегда |

Итог `access sync` и код выхода:

| Итог | Код | Что значит |
|---|---|---|
| `updated` | 0 | политика обновлена: добавлено, удалено, отключено — в ответе |
| `unchanged` | 0 | политика уже совпадала с активными пользователями |
| `empty` | 0 | в политике не осталось бы ни одного адреса, она не тронута |
| `not_configured` | 1 | синхронизация выключена или настроена не полностью |
| `not_google_mode` | 1 | панель работает не в `AUTH_MODE=google` |
| `aborted` | 1 | прогон отключил бы больше пользователей, чем позволяет `ACCESS_SYNC_MAX_DISABLES`; ничего не изменено, кандидаты — в журнале (`access.sync_aborted`) |
| `failed` | 3 | код ошибки — код прогона (`policy_not_allow`, `policy_not_attached`, `token_unreadable`, `internal_error`) или `cloudflare_error` с текстом вида `Cloudflare getPolicy failed (403): error 10000` |
| — | 3 | `wait_timeout`: backend не выполнил задание вовремя (он остановлен?); задание остаётся в очереди |

```bash
M=<PREFIX>/app/scripts/deploy/mailexpert-cli.sh
sudo $M access token < /root/access-sync-token.txt      # токен — только stdin
sudo $M access config --account <ACCOUNT_ID> --app <APP_ID> --policy <POLICY_ID> --enable
sudo $M access sync --json | jq '.job.result'
```

### Административные группы: что доделывает backend

Группы `user`, `settings`, `sso` и `integration` — разделы «Пользователи», «Настройки», «SSO» и
«Интеграции» экрана администратора, через те же сервисы (`services/admin/users.js`,
`services/admin/systemSettings.js`, `services/auth/oidcProviders.js`,
`services/integrations/microsoft.js`). Часть последствий изменения живёт только в процессе backend:
разлогинить пользователя во всех сессиях и закрыть его сокеты, вызвать очистку данных плагинов после
удаления, попросить прогон синхронизации с Access, перечитать то, что backend держит в памяти (лимиты
входа, интервалы синхронизации ящиков, кэши категоризации и политики подключений, клиент Microsoft в
`process.env`). Экран делает это сразу; CLI ставит задание `admin_effects`, которое воркер backend
выполняет теми же функциями (`services/admin/adminEffects.js`). В ответе команды — строка
`backend: job <ID> queued (...)` (в `--json` — поле `job`). Пока backend остановлен, задание ждёт в
очереди; изменение в базе уже сделано, а отключённого или удалённого пользователя `requireAuth` не
пускает и без задания.

### 3.7. `user`: пользователи панели

Пользователь называется адресом (или именем пользователя, если адреса нет); регистр не важен.
Проверки те же, что у экрана: последний активный администратор остаётся (`last_admin`; в
`AUTH_MODE=google` без адреса администратор не считается активным), адреса из `BOOTSTRAP_ADMIN_EMAILS`
здесь не меняются и не удаляются (`bootstrap_admin`), адрес не может быть у двух пользователей
(`email_taken`), администратор из `--as` не снимает с себя права, не отключает и не удаляет себя и не
сбрасывает себе 2FA (`self_change`). Все проверки идут под той же блокировкой (`lockAdminGuard`), что у
экрана, удаление — внутри неё.

| Команда | Что делает | Журнал |
|---|---|---|
| `user list [--limit N] [--offset N]` | Пользователи, старые первыми (по 100, не больше 200): адрес, имя, администратор (`bootstrap` для адресов из `BOOTSTRAP_ADMIN_EMAILS`), 2FA, отключён ли, создан. | нет |
| `user show <email>` | Один пользователь. | нет |
| `user create <email> [--admin]` | Одобряет адрес: новый пользователь или существующий, у которого это имя пользователя. В `AUTH_MODE=google` именно это пускает человека войти. С `--admin` — сразу администратор. Backend просит прогон синхронизации с Access. | `user.added`; с `--admin` ещё `user.admin_changed` |
| `user set <email> [--admin \| --no-admin] [--disable \| --enable] [--email NEW]` | Делает администратором или нет, отключает или включает, меняет адрес (`--email ""` убирает его). Кто потерял вход (отключён или сменился адрес, под которым открыты сессии) — backend разлогинивает его везде. Без параметров или с противоречащими — код 2. | `user.admin_changed`, `user.disabled`, `user.enabled` — что изменилось |
| `user delete <email>` | Удаляет пользователя и всё его (просит подтверждения, `--yes`). Backend разлогинивает его, плагины удаляют свои данные, просится прогон синхронизации с Access. | `user.deleted` |
| `user totp-reset <email>` | Выключает 2FA пользователя, потерявшего устройство (просит подтверждения). Он входит по паролю и заново подключает 2FA, где она обязательна. | нет (как и у кнопки экрана) |

### 3.8. `settings`: настройки установки

Те же ключи и проверки, что `PATCH /api/admin/settings`. Читаются и пишутся только они; остальные
системные настройки (SMTP, ИИ, синхронизация с Access — в них секреты) здесь не видны.

| Ключ | Значения |
|---|---|
| `registration_open`, `allow_private_hosts`, `allow_insecure_tls`, `allow_nonstandard_ports`, `categorization_enabled` | `true` / `false` |
| `internal_auth_disabled` | `true` — вход по паролю выключен, `false` — включён |
| `auth_max_attempts` | 1-100 |
| `auth_window_minutes` | 1-1440 |
| `mfa_enforcement` | `off`, `required` |
| `mfa_device_trust` | `never`, `7d`, `30d`, `permanent` |
| `sync_interval_sec` | 15, 30, 60, 120 |
| `folder_sync_interval_sec` | 0, 900, 1800, 3600 |
| `custom_css` | текст до 50 000 символов; `-` читает его со stdin |

| Команда | Что делает | Журнал |
|---|---|---|
| `settings get [key]` | Все ключи (`(not set)` — панель берёт значение по умолчанию) или значение одного. Неизвестный ключ — код 2. | нет |
| `settings set <key> <value>` | Меняет один ключ. Булево — `true`/`false` (также `on`/`off`, `yes`/`no`), число — целое, иначе код 2. Выключить вход по паролю (`internal_auth_disabled true`) можно, только если есть включённый SSO-провайдер (`no_sso_provider`) и у администратора из `--as` есть SSO-учётка (`sso_identity_required`): иначе он сам не войдёт. Без `--as` такой администратор не найдётся, и запрос будет отклонён. Включить вход по паролю обратно (`false`) можно всегда — это путь назад. Backend перечитывает лимиты входа, интервалы и кэши. | нет (как и у экрана) |

Сбросить блокировки входа по лимиту попыток (счётчики `auth:*` в Redis) ни экран, ни CLI не умеют:
такой функции в панели нет. Блокировка снимается сама через `auth_window_minutes`.

### 3.9. `sso`: SSO-провайдеры (OIDC)

Те же проверки, что у экрана (`/api/admin/oidc`). Провайдер называется ID или slug. Секрет клиента
читается **только со stdin** (файл или конвейер; в терминале — вставить и нажать Ctrl-D), хранится
зашифрованным и никогда не печатается.

| Команда | Что делает | Журнал |
|---|---|---|
| `sso list` | Провайдеры: slug, имя, включён ли, issuer, client ID, ID. Секретов нет. | нет |
| `sso add --name TEXT --slug SLUG --issuer URL --client-id ID [параметры] < файл-с-секретом` | Добавляет провайдера. Slug — строчные латинские буквы, цифры, дефисы (`slug_invalid`), не занят (`slug_taken`); issuer — HTTPS (`issuer_not_https`) и разрешённый политикой хост (`issuer_host_refused`), если не `--allow-insecure`. Пустой stdin — `fields_required`. Параметры: `--scopes`, `--provisioning`, `--allowed-domains`, `--admin-group-claim`/`--admin-group-value`, `--login-match-claim`, `--disable`, `--no-require-email-verified`, `--allow-insecure`, `--rp-logout`. | нет (как и у экрана) |
| `sso set <id\|slug> [параметры] [--secret < файл-с-секретом]` | Меняет названные поля, остальные остаются; `--allowed-domains ""` и `--admin-group-claim ""` с `--admin-group-value ""` очищают. Секрет меняется только с `--secret`. Включение и выключение: `--enable`/`--disable`, переключатели — `--[no-]require-email-verified`, `--[no-]allow-insecure`, `--[no-]rp-logout`. Выключить последний включённый провайдер при выключенном входе по паролю нельзя (`last_provider`). | нет |
| `sso remove <id\|slug>` | Удаляет провайдера и привязанные через него учётки SSO (просит подтверждения). `last_provider` — как у `set`: сначала `settings set internal_auth_disabled false`. | нет |

### 3.10. `integration`: клиент Microsoft OAuth

Клиент, через который подключаются ящики Outlook (`/api/integrations/microsoft`). Приложения Google —
своим CLI (`src/cli/googleApp.js`).

| Команда | Что делает | Журнал |
|---|---|---|
| `integration microsoft show` | Client ID, tenant ID, redirect URI, задан ли секрет (значение никогда), когда изменён. | нет |
| `integration microsoft set [--client-id ID] [--tenant-id ID] [--redirect-uri URL] [--secret]` | Меняет названные поля, остальные и сохранённый секрет остаются. С `--secret` новый секрет читается **только со stdin** и хранится зашифрованным; строка с символом `•` отклоняется (`client_secret_redacted`). Backend перечитывает клиента. Без параметров — код 2. | нет (как и у экрана) |
| `integration microsoft remove` | Удаляет клиента (просит подтверждения): подключать и переподключать ящики Outlook нельзя, пока его не зададут снова. | нет |

## 4. Коды выхода

### CLI

| Код | Значение |
|---|---|
| 0 | Сделано (включая справку). |
| 1 | Отказ: напечатан код ошибки API (например `domain_not_ready`); также ответ «нет» на вопрос (`cancelled`) и `admin_not_found` для `--as`. |
| 2 | Ошибка в командной строке (неизвестная группа, команда или параметр, недостающий или лишний аргумент, неверное значение), либо подтверждение, которое CLI не смог спросить (`confirmation_required`). |
| 3 | Сбой почтового узла, тенанта, задания или самой панели: отказ с HTTP-статусом 5xx, ошибка узла (`MailNodeError`, по умолчанию 502), задание закончилось не `done`, `wait_timeout`, `internal_error`. |

Правило для отказов: код 3, если у отказа в каталоге статус 5xx, иначе 1.

### Обёртка

Коды CLI проходят без изменений (в том числе 1, 2, 3). Собственные коды обёртки:

| Код | Когда |
|---|---|
| 2 | Не заданы группа и команда; недопустимое имя группы; `--prefix` без значения или не абсолютный путь без пробелов; запуск не от root; не нашлась установка (`install.conf`). |
| 3 | docker не может выполнить CLI: `docker compose` не отработал, контейнер `backend` не запущен, в образе нет `src/cli/mailexpert.js` (сначала обновите панель), docker вернул 125-127 (команду не удалось запустить). |

Коды 2 и 3 у обёртки и у CLI совпадают по номеру, но различаются по тексту на stderr.

## 5. Вывод: человеческий и `--json`

Без `--json` результаты — таблицы и пары «ключ: значение» на stdout; даты в UTC (`YYYY-MM-DD HH:MMZ`),
пусто — `-`, булевы — `yes`/`no`. Диагностические строки и ошибки идут в stderr.

Ошибка без `--json` — одна строка на stderr:

```text
error: The domain is at the first step with nothing to clear (domain_nothing_to_restart)
```

С `--json` на stdout печатается ответ действия как есть (с отступом в 2 пробела), а ошибка — объект с
`error` (текст) и `code`. Добавочные поля бывают у ошибок заданий (`job`):

```json
{
  "error": "Mailboxes can be created only on a domain that finished its onboarding",
  "code": "domain_not_ready"
}
```

```json
{
  "error": "The mail node is unreachable (ECONNREFUSED)",
  "code": "mail_node_unreachable"
}
```

Ошибки командной строки (код 2: неизвестный параметр, недостающий аргумент) пишутся в stderr простым
текстом и с `--json`: объект получают только отказы действий. Исключение: `confirmation_required` с
`--json` приходит объектом на stdout.

Примеры форм успешных ответов (поля берутся из действий панели, показаны ключевые):

`mailbox create`, `set-names`, `delete`, `cancel-deletion` — вид ящика:

```json
{
  "id": "<UUID>",
  "email": "<LOCAL>@<DOMAIN>",
  "name": "...",
  "senderName": "...",
  "secondSenderNames": ["..."],
  "enabled": true,
  "imapHost": "...",
  "addedAt": "...",
  "deletion": null
}
```

У `create` добавляется `tenantPending`; при ожидающем удалении `deletion` — объект с `deleteAfter`,
`requestedAt`, `requestedBy`, `reason`, `lastError`. `mailbox show` добавляет `node`: `{ "active", "quotaMb",
"usedBytes", "rateLimit" }` или `{ "error": "<код>" }`. `mailbox list` — `{ "disk": {...}, "mailboxes":
[...] }` (у ящика, например, `email`, `onNode`, `active`, `quotaMb`, `usedBytes`, `deleteAfter`).

`domain list` — `{ "domains": [...], "tenantDriverActive": true }` (при ненадёжном чтении узла добавляется
`node`); `domain show` — запись домена с добавленными `warnings` и `tenantDriverActive`.
`domain restart` — например `{ "ok": true, "domain": "<DOMAIN>", "state": "node_created", ... }`.
`domain hold` и `domain allow-authoritative` — `{ "domain": "<DOMAIN>", "holdInternalRelay": false }`
(`true` у `hold`).

`domain sync`, `tenant test`, `tenant antispam`, `quarantine release` — `{ "created": true, "job": {...} }`;
`created: false` значит, что такое задание уже стояло. `domain internal-relay` — `{ "job": {...} }`,
`domain approve-alias-removal` — `{ "job": {...}, "addresses": [...] }`, без `created`. Задание:

```json
{
  "id": "7",
  "kind": "tenant_domain_sync",
  "status": "queued",
  "errorCode": null,
  "error": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

С `--wait` поле `job` — итоговое состояние. `jobs list` — `{ "jobs": [ { ...задание, "domain": "<DOMAIN>" } ] }`,
`jobs show` — `{ "job": {...} }`. `tenant status` — состояние тенанта (`driver`, `configured`, `state`,
`connectorDrift`, `jobs`) плюс `worker`: `{ "reachable", "at", "code", "source" }`. `quarantine list` —
`{ "held": {...}, "messages": [...] }` (сводка и сами сообщения), `quarantine pause`/`resume` — `{ "enabled": ..., "changedAt": ... }`.
`access status` — то же, что `GET /api/admin/access-sync`: `{ "config": { "enabled", "accountId", "appId",
"policyId", "apiTokenSet" }, "lastRun", "maxDisables", "googleMode" }`; `access config` и `access token` —
то же плюс `"job": { "id", "status" }` (или `null`, если прогон не ставился); `access sync` —
`{ "job": { "id", "status", "result", "errorCode", "error" } }`, где `result` — итог прогона
(`outcome`, `added`, `removed`, `disabled`, `wouldDisable`, `error`, `trigger`, `startedAt`, `finishedAt`).

`user list` — то же, что `GET /api/admin/users`: `{ "users": [ { "id", "username", "email", "isAdmin",
"totpEnabled", "disabledAt", "created_at", "isBootstrapAdmin" } ], "total" }`; `user show` — `{ "user" }`;
`user create` — `{ "user", "created", "job" }`, `user set` — `{ "user", "job" }`, `user delete` —
`{ "ok": true, "job" }`, где `job` — `{ "id", "kind": "admin_effects", "status" }` или `null`.
`settings get` — `{ "settings": { ключ: значение } }` (только заданные ключи), `settings get <key>` и
`settings set` — `{ "key", "value" }` (у `set` ещё `job`). `sso list` — `{ "providers": [...] }` в полях API
(`issuer_url`, `client_id`, `enabled`, ...; без секрета), `sso add`/`set` — `{ "provider" }`.
`integration microsoft show` — `{ "config": { "clientId", "tenantId", "redirectUri", "clientSecret":
"••••••••", "updated_at" } }` или `{ "config": null }`; `set` — то же плюс `job`.

## 6. Коды ошибок, которые встретятся

Печатаются как `error: <текст> (<код>)`; в скобках HTTP-статус, с которым тот же отказ отвечает API панели
(5xx даёт код выхода 3).

### Собственные коды CLI

| Код | Выход | Смысл |
|---|---|---|
| `confirmation_required` | 2 | Действие просит подтверждения, а терминала нет: добавьте `--yes` (для удаления ящика `--confirm-address`). |
| `cancelled` | 1 | На вопрос ответили не «y»: ничего не изменено. |
| `admin_not_found` | 1 | `--as`: нет включённого администратора с таким адресом. |
| `wait_timeout` | 3 | `--wait` ждал дольше `--timeout`; задание идёт, следите командой `jobs show <ID>` (для `access sync` — `access status`: `jobs` показывает только задания тенанта). |
| `internal_error` | 3 | Непредвиденный сбой панели; причина в строке выше на stderr. |
| `job_failed`, `job_cancelled`, `job_needs_attention` | 3 | `--wait`: задание закончилось не `done`, а своего кода у него нет (иначе печатается `errorCode` задания). |

### Ящики (`MAILBOX_ERRORS`, включает `MAIL_NODE_ERRORS`)

Собственные отказы ящиков:

| Код | Статус | Смысл |
|---|---|---|
| `local_part_invalid` | 400 | Имя до `@`: только буквы, цифры, точка, дефис и подчёркивание. |
| `name_invalid` | 400 | Имя или адрес содержат управляющие символы. |
| `name_required` | 400 | Имя ящика не может быть пустым. |
| `sender_name_invalid` | 400 | Имена отправителя содержат управляющие символы. |
| `mailbox_pending_deletion` | 409 | Ящик ждёт удаления: отмените удаление, чтобы сохранить. |
| `mailbox_exists` | 409 | Ящик уже есть в MailExpert. |
| `domain_unknown` | 400 | У почтового узла нет такого активного домена. |
| `mailbox_create_failed` | 500 | Ящик не добавлен. |
| `account_not_found` | 404 | Ящик не найден. |
| `not_mail_node` | 400 | Только ящик на почтовом узле ждёт перед удалением; этот удаляется напрямую. |
| `deletion_already_requested` | 409 | Удаление ящика уже запрошено. |
| `deletion_not_requested` | 409 | Ожидающего удаления нет. |
| `deletion_in_progress` | 409 | Ящик удаляется прямо сейчас. |
| `confirmation_mismatch` | 400 | Нужно ввести полный адрес ящика. |
| `deletion_reason_required` | 400 | Скажите, почему удаляется ящик. |
| `deletion_reason_too_long` | 400 | Причина не длиннее 500 символов. |
| `admin_required` | 403 | Нужны права администратора. |
| `mailbox_ambiguous` | 409 | У адреса больше одной строки ящика: назовите его по ID. |
| `sender_name_alt_ambiguous` | 409 | У ящика несколько имён отправителя для адреса: меняйте в панели. |
| `sender_name_alt_same` | 400 | Второе имя отправителя должно отличаться от основного. |

Дополнительно у команд ящиков бывает `mailbox_not_found` (404, из каталога узла; нет такого ящика узла).

### Узел и домены (`MAIL_NODE_ERRORS`)

Те, что могут встретиться в командах CLI (`mailbox`, `domain list/show/restart`); остальные коды каталога
относятся к экранам настроек узла и CLI не затрагивают.

| Код | Статус | Смысл |
|---|---|---|
| `mail_node_not_configured` | 409 | Почтовый узел не настроен. |
| `mailbox_not_found` | 404 | Ящика узла нет. |
| `domain_invalid` | 400 | Домен должен быть именем вроде `example.com`. |
| `domain_not_ready` | 400 | Ящики создаются только на домене, завершившем онбординг. |
| `domain_not_on_node` | 404 | У узла нет такого домена. |
| `domain_not_found` | 404 | Панель не знает этот домен. |
| `domain_nothing_to_restart` | 409 | Домен на первом шаге, чистить нечего. |
| `mail_node_host_mismatch` | 409 | Ящик на другом хосте, чем в настройках почтового узла. |

Сбой самого узла (`MailNodeError`) печатается с кодом узла и текстом, например `mail_node_unreachable`
(`The mail node is unreachable ...`), статус по умолчанию 502 (код выхода 3).

### Алиасы (`ALIAS_ERRORS`)

Эти отказы возвращают действия, когда `set-names` меняет второе имя отправителя; CLI печатает их как есть:

| Код | Статус | Смысл |
|---|---|---|
| `account_not_found` | 404 | Ящик не найден. |
| `alias_not_found` | 404 | Алиас не найден. |
| `alias_fields_required` | 400 | Нужны имя и адрес. |
| `alias_fields_invalid` | 400 | Поля содержат управляющие символы. |
| `node_alias_address_mismatch` | 400 | Ящик узла отправляет только со своего адреса: другой адрес — отдельный ящик. |

### Тенант (`TENANT_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `tenant_driver_missing` | 409 | У панели нет воркера тенанта (`TENANT_WORKER_URL`). |
| `tenant_not_configured` | 409 | Сначала заполните ID тенанта, его домен `onmicrosoft.com`, ID приложения и отпечаток сертификата. |
| `tenant_job_not_found` | 404 | Нет такого задания тенанта. |
| `domain_invalid` | 400 | Домен должен быть именем вроде `example.com`. |
| `domain_not_found` | 404 | Панель не знает этот домен. |
| `connectors_not_read` | 409 | Коннекторы ещё не прочитаны: сначала проверьте. |
| `hold_invalid` | 400 | `hold` должен быть `true` или `false` (для CLI внутренняя проверка). |
| `domain_authoritative` | 409 | Домен уже Authoritative: он не удерживается на Internal Relay. |
| `internal_relay_not_needed` | 409 | Домен не ждёт этого решения. |
| `alias_contacts_not_held` | 409 | Домен не держит контактов алиасов для решения. |
| `alias_contacts_changed` | 409 | Удерживаемые контакты алиасов изменились с момента показа: посмотрите ещё раз. |
| `enabled_invalid` | 400 | `enabled` должен быть `true` или `false` (для CLI внутренняя проверка). |
| `phish_release_paused` | 409 | Выпуск фишинга из карантина на паузе. |

Код ошибки задания при `--wait` (`errorCode`) берётся из самого задания и может быть кодом тенанта или
воркера, например `tenant_not_configured`, `tenant_throttled`.

### Синхронизация с Access (`ACCESS_SYNC_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `invalid_id` | 400 | ID аккаунта — 32 шестнадцатеричных символа, ID приложения и политики — UUID. Текст ответа API: «Invalid Cloudflare Access settings». |
| `incomplete` | 400 | Чтобы включить синхронизацию, нужны три ID и токен. |
| `invalid_field` | 400 | Нет флага «включена» (только API). |
| `token_invalid` | 400 | Токен — одна строка из 20-512 символов без пробелов. |
| `job_not_found` | 404 | Задание прогона пропало из очереди. |

Итоги прогона (`not_configured`, `aborted`, `policy_not_allow` и другие) и их коды выхода — в
разделе 3.6.

### Пользователи (`ADMIN_USER_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `not_found` | 404 | Нет пользователя с таким адресом или именем. |
| `email_invalid` | 400 | Адрес не похож на адрес. |
| `user_exists` | 409 | Адрес уже одобрен. |
| `username_taken` | 409 | Этот адрес — имя пользователя у другого пользователя. |
| `email_taken` | 409 | Этот адрес уже у другого пользователя. |
| `last_admin` | 409 | Не осталось бы ни одного активного администратора. |
| `bootstrap_admin` | 409 | Адрес из `BOOTSTRAP_ADMIN_EMAILS`: меняется только в окружении. |
| `self_change` | 400 | Администратор из `--as` меняет себе права, отключает, удаляет себя или сбрасывает себе 2FA. |
| `no_fields`, `invalid_field` | 400 | Нечего менять или поле не того типа (для CLI — внутренняя проверка). |

### Настройки (`SYSTEM_SETTINGS_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `invalid_field` | 400 | Недопустимый интервал синхронизации или `categorization_enabled` не булево. |
| `auth_max_attempts_invalid`, `auth_window_minutes_invalid` | 400 | Вне 1-100 или 1-1440. |
| `mfa_enforcement_invalid`, `mfa_device_trust_invalid` | 400 | Значение не из списка. |
| `custom_css_invalid`, `custom_css_too_long` | 400 | Не текст или длиннее 50 000 символов. |
| `no_sso_provider` | 400 | Выключить вход по паролю нельзя: нет включённого SSO-провайдера. |
| `sso_identity_required` | 400 | Выключить вход по паролю нельзя: у администратора (`--as`) нет SSO-учётки. |

Как и у экрана, ключи проверяются по очереди: при отказе записанное до него остаётся, а backend всё равно
перечитывает то, что перечитал бы экран.

### SSO-провайдеры (`OIDC_PROVIDER_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `fields_required` | 400 | Нужны имя, slug, issuer, client ID и секрет (stdin пуст). |
| `slug_invalid`, `slug_taken` | 400, 409 | Slug не из строчных букв, цифр и дефисов, или уже занят. |
| `issuer_invalid`, `issuer_not_https`, `issuer_host_refused` | 400 | Issuer не URL, не HTTPS или хост запрещён политикой (`allow_private_hosts`). |
| `login_match_claim_invalid` | 400 | Имя claim — буквы, цифры и `. _ : -`. |
| `last_provider` | 400 | Последний включённый провайдер при выключенном входе по паролю. |
| `not_found` | 404 | Нет провайдера с таким ID или slug. |
| `secret_missing` | 1 | `--secret`, а stdin пуст (код CLI). |

### Клиент Microsoft (`MICROSOFT_INTEGRATION_ERRORS`)

| Код | Статус | Смысл |
|---|---|---|
| `client_secret_redacted` | 400 | В секрете символ `•`: это заглушка экрана, а не секрет. |
| `secret_missing` | 1 | `--secret`, а stdin пуст (код CLI). |

## 7. Практические примеры

```bash
cli=<PREFIX>/app/scripts/deploy/mailexpert-cli.sh

# Состояние: домены, один домен с предупреждениями, ящики домена
sudo $cli domain list
sudo $cli domain show <DOMAIN>
sudo $cli mailbox list --domain <DOMAIN>

# Создать ящик с двумя именами отправителя (одно кириллицей, одно латиницей)
sudo $cli mailbox create <LOCAL>@<DOMAIN> --name "<NAME>" --sender-name "<NAME_RU>" --second-sender-name "<NAME_LATIN>"

# Сменить имена; убрать второе имя
sudo $cli mailbox set-names <LOCAL>@<DOMAIN> --sender-name "<NAME_RU>"
sudo $cli mailbox set-names <LOCAL>@<DOMAIN> --second-sender-name ""

# Удаление ящика: в терминале спросит адрес, из скрипта нужен --confirm-address
sudo $cli mailbox delete <LOCAL>@<DOMAIN> --reason "left the company"
sudo $cli mailbox delete <LOCAL>@<DOMAIN> --reason "left the company" --confirm-address <LOCAL>@<DOMAIN>
sudo $cli mailbox cancel-deletion <LOCAL>@<DOMAIN>

# Онбординг домена: перезапуск, тенантские шаги и ожидание результата
sudo $cli domain restart <DOMAIN> --yes
sudo $cli domain sync <DOMAIN> --wait --timeout 300

# Проверка тенанта и антиспам-политики от имени администратора
sudo $cli tenant status
sudo $cli tenant test --wait --as <ADMIN_EMAIL>
sudo $cli tenant antispam --wait --as <ADMIN_EMAIL>

# Карантин EOP
sudo $cli quarantine status
sudo $cli quarantine release --wait --as <ADMIN_EMAIL>
sudo $cli quarantine pause --yes

# Что пошло не так в очереди
sudo $cli jobs list --status problems
sudo $cli jobs show <ID>

# Синхронизация с Cloudflare Access: токен со stdin, настройка, прогон сейчас
sudo $cli access token < /root/access-sync-token.txt && shred -u /root/access-sync-token.txt
sudo $cli access config --account <ACCOUNT_ID> --app <APP_ID> --policy <POLICY_ID> --enable --as <ADMIN_EMAIL>
sudo $cli access sync
sudo $cli access status

# Доступ: восстановить администратора, отключить сотрудника, сбросить 2FA
sudo $cli user list
sudo $cli user set <ADMIN_EMAIL> --enable --admin
sudo $cli user set <USER_EMAIL> --disable
sudo $cli user totp-reset <USER_EMAIL> --yes

# Вход по паролю обратно, если SSO сломался
sudo $cli settings set internal_auth_disabled false
sudo $cli settings get

# SSO и клиент Microsoft: секреты — только stdin
sudo $cli sso add --name "<IDP_NAME>" --slug <SLUG> --issuer https://<IDP_HOST> --client-id <CLIENT_ID> < /root/oidc-secret.txt
sudo $cli sso set <SLUG> --secret < /root/oidc-secret.txt && shred -u /root/oidc-secret.txt
sudo $cli integration microsoft set --client-id <CLIENT_ID> --tenant-id common --secret < /root/ms-secret.txt
sudo $cli integration microsoft show

# Скрипты: JSON и код выхода
sudo $cli jobs list --status problems --json | jq -r '.jobs[].id'
sudo $cli domain restart <DOMAIN> --yes --json; echo "exit=$?"
```

Связанные документы: устройство CLI — [panel-cli.md](../architecture/panel-cli.md); установка, обновление
и остальные операции — [deployment.md](deployment.md); локальный стенд — [local-stand.md](local-stand.md).
