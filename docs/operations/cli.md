# CLI панели: справочник

Командная строка `mailexpert` — те же действия администратора, что и на экранах панели, для случаев,
когда экран неудобен: массовые действия, скрипты, работа по SSH. CLI не имеет своей бизнес-логики:
команды вызывают те же сервисы backend, что и HTTP-маршруты, с теми же проверками, кодами отказов и
записями журнала. Мимо панели (напрямую в mailcow или тенант) CLI ничего не делает, а работу для
тенанта только ставит в очередь заданий: выполняет её воркер backend.

Это полный справочник. Устройство и причины решений — в [panel-cli.md](../architecture/panel-cli.md);
краткая сводка для владельца и остальные операции — в
[deployment.md, «CLI панели»](deployment.md#cli-панели).

Плейсхолдеры: `<PREFIX>` — каталог установки панели (по умолчанию `/opt/mailexpert`), `<DOMAIN>` —
домен почтового узла, `<LOCAL>@<DOMAIN>` — адрес ящика, `<ADMIN_EMAIL>` — адрес администратора панели.

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
- Короткие формы есть только у `-y` и `-h`.
- `--help` отвечает при любой остальной строке и ничего не выполняет.

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
`domain approve-alias-removal`, `quarantine pause`. Не спрашивают: `domain hold`, `domain sync`,
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
`tenant test`, `tenant antispam`, `quarantine release`. CLI ставит задание в очередь и, без `--wait`,
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
же. Новых действий журнала CLI не добавляет.

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

Команды, ставящие задание, — `{ "created": true, "job": {...} }`; `created: false` значит, что такое
задание уже стояло. Задание:

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
`{ "messages": [...] }`, `quarantine pause`/`resume` — `{ "enabled": ..., "changedAt": ... }`.

## 6. Коды ошибок, которые встретятся

Печатаются как `error: <текст> (<код>)`; в скобках HTTP-статус, с которым тот же отказ отвечает API панели
(5xx даёт код выхода 3).

### Собственные коды CLI

| Код | Выход | Смысл |
|---|---|---|
| `confirmation_required` | 2 | Действие просит подтверждения, а терминала нет: добавьте `--yes` (для удаления ящика `--confirm-address`). |
| `cancelled` | 1 | На вопрос ответили не «y»: ничего не изменено. |
| `admin_not_found` | 1 | `--as`: нет включённого администратора с таким адресом. |
| `wait_timeout` | 3 | `--wait` ждал дольше `--timeout`; задание идёт, следите командой `jobs show <ID>`. |
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

# Скрипты: JSON и код выхода
sudo $cli jobs list --status problems --json | jq -r '.jobs[].id'
sudo $cli domain restart <DOMAIN> --yes --json; echo "exit=$?"
```

Связанные документы: устройство CLI — [panel-cli.md](../architecture/panel-cli.md); установка, обновление
и остальные операции — [deployment.md](deployment.md); локальный стенд — [local-stand.md](local-stand.md).
