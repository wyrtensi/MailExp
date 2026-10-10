# Эксплуатация MailExpert: с чего начать

Единая точка входа для того, кто разворачивает и сопровождает MailExpert: выбор раскладки, что
подготовить, установка панели и почтового узла, подключение тенанта, бэкапы, мониторинг,
обновление, откат, переезд и неполадки. Каждый шаг ссылается на документ с точными командами; здесь
— порядок, проверки между шагами и то, чего нет в других документах.

Из каких модулей состоит система, что можно разносить по серверам, правила совместимости версий —
[architecture/deployment-system.md](../architecture/deployment-system.md).

Плейсхолдеры: `<PANEL_HOST>` — сервер панели (адрес для SSH), `<APP_HOST>` — публичный адрес панели
(`<CF_HOST>` и/или `<DIRECT_HOST>`), `<MAIL_HOST>` — почтовый узел, `<PANEL_IP>` — публичный IPv4
панели, `<PREFIX>` — каталог установки панели (по умолчанию `/opt/mailexpert`), `sha-<12>` — версия
(тег образов, первые 12 символов коммита на `main`).

Команды панели ниже — от root на `<PANEL_HOST>`; короче: `D=<PREFIX>/app/scripts/deploy`.

Первая установка с нуля — [quickstart.md](quickstart.md): от чистого VPS до работающей панели за
несколько команд, с проверками, и готовый запрос для ИИ-агента.

| Документ | О чём |
|---|---|
| [quickstart.md](quickstart.md) | быстрый старт: панель на чистом VPS, почтовый узел по желанию, установка агентом |
| [deployment.md](deployment.md) | установка панели, режимы входа, CLI, обновление, откат, переезд панели |
| [migrate-to-install.md](migrate-to-install.md) | замена собственного docker compose боевой установкой: перенос данных, бэкапы, обновления, переезд из бэкапа |
| [cloudflare.md](cloudflare.md) | Cloudflare до установки: Zero Trust, туннель, приложение Access, токены DNS и синхронизации, неполадки |
| [ports.md](ports.md) | порты всех модулей: входящие, исходящие, Docker/loopback, production и стенды |
| [cli.md](cli.md) | справочник командной строки панели `mailexpert` |
| [../user-guide/README.md](../user-guide/README.md) | руководство по экранам панели для пользователей и администраторов |
| [mail-node.md](mail-node.md) | почтовый узел: mailcow, файрвол, EOP, тенант Microsoft, бэкап и переезд узла |
| [google-oauth.md](google-oauth.md) | Google-приложения для Gmail-ящиков пользователей |
| [microsoft-oauth.md](microsoft-oauth.md) | ящики Microsoft 365 / Outlook |
| [local-stand.md](local-stand.md) | локальный стенд для проверки версии |
| [../../scripts/deploy/mail-node/README.md](../../scripts/deploy/mail-node/README.md) | скрипты хоста узла |
| [../architecture/panel-cli.md](../architecture/panel-cli.md) | устройство CLI панели |

## 1. Выбрать раскладку

| Раскладка | Что ставить | Когда |
|---|---|---|
| **A. Панель + почтовый узел** | два сервера Ubuntu 24.04 по 4 vCPU / 8 ГБ | ящики на своих доменах через EOP |
| **B. Только панель** | один сервер (минимум 2 vCPU / 4 ГБ / 20 ГБ свободно); отдельный или общий с другими проектами ([общий сервер](deployment.md#сосед-на-общем-сервере-что-панель-трогает-и-что-нет)) | только Gmail и внешние IMAP-ящики |
| **C. Стенд** | один сервер или Docker на машине разработчика | проверить версию до прода |

Не поддерживаются: узел на одном сервере с панелью, внешняя PostgreSQL, несколько реплик backend,
несколько узлов на панель, tenant-worker на отдельном сервере. Почему —
[deployment-system.md, раздел 3](../architecture/deployment-system.md).

## 2. Что подготовить

Общее:
- доступ root по SSH к серверам (по ключу);
- зона DNS в Cloudflare для `<DIRECT_HOST>` и `<MAIL_HOST>`, TTL 300 у записей, которые меняются
  при переезде;
- S3-совместимый бакет **у другого провайдера**, чем серверы (бэкапы панели и узла — разные
  репозитории restic с разными паролями);
- проверки в Healthchecks.io (или совместимом сервисе) с интеграцией в Telegram: здоровье панели,
  при желании отдельно бэкап панели, диапазоны EOP узла, бэкап узла, диск узла, оповещения узла;
- менеджер паролей для ключей восстановления (restic панели и узла).

Панель — [deployment.md, раздел 1](deployment.md): токены Cloudflare (`DNS_API_TOKEN`,
`TUNNEL_TOKEN`), клиент Google для входа или приложение Cloudflare Access, адреса администраторов.
Всё, что делается в Cloudflare (Zero Trust, туннель и маршрут, приложение Access, токены с
минимальными правами), — по шагам, в панели и через API, в [cloudflare.md](cloudflare.md); это
делается **до** `install.sh`.

Узел — [mail-node.md, раздел 2](mail-node.md): провайдер с открытым портом 25 и своим PTR,
статический IPv4, NVMe.

Тенант Microsoft (если нужен EOP) — [mail-node.md, раздел 6е](mail-node.md): приложение в Entra,
сертификат.

Секреты в командную строку, в cloud-init, в чат и в issues не попадают: только `configure.sh`
(stdin) на панели и файлы `0600` на узле.

## 3. Установить панель

Сначала Cloudflare — [cloudflare.md](cloudflare.md) (для `cf`/`both` — туннель и Access, для
`direct`/`both` — токен DNS и A-запись). Затем [quickstart.md](quickstart.md) или
[deployment.md, разделы 2-3](deployment.md): `git clone --branch
latest`, `install.sh --version sha-<12> --signin ...` (код 3 и список ключей), секреты через
`configure.sh`, повторный `install.sh`. Сохранить ключ восстановления restic. На сервере, где уже
живут другие проекты, — `--no-system` и рецепт
[«Установка на общий сервер»](deployment.md#установка-на-общий-сервер-минимальное-влияние-полный-функционал).

Проверка:

```bash
sudo $D/status.sh                 # result: no problems
sudo $D/healthcheck.sh            # код 0
curl -fsS https://<APP_HOST>/api/version
```

Вход администратора через `<APP_HOST>`.

## 4. Установить почтовый узел (раскладка A)

[mail-node.md, разделы 3-4](mail-node.md): DNS и PTR, mailcow, `setup.sh --dry-run`, затем `setup.sh`
(файрвол, диапазоны EOP, Dovecot), запуск mailcow, ключ API, настройки mailcow (размер письма,
карантин). Бэкап узла — `setup.sh --backup-keys` ([раздел 7](mail-node.md)).

Копия репозитория на узле (`/opt/mailexpert-node-src`) — на **том же коммите**, что панель:

```bash
git -C /opt/mailexpert-node-src fetch --quiet origin
git -C /opt/mailexpert-node-src checkout --detach <коммит панели>
```

Проверка: `systemctl status mailexpert-eop-ranges.timer mailexpert-node-backup.timer`, пинг проверки
диапазонов EOP пришёл, `doveconf` выводит значения из раздела 3, шаг 5.

## 5. Подключить узел к панели и завести домен

[mail-node.md, разделы 5-6](mail-node.md): имя узла, ключ API, адреса панели для fail2ban, «Проверить
и сохранить»; затем шаги «один раз на узел и тенант» и «на каждый домен». После первого домена —
`setup.sh --eop-host <EOP_HOST>` на узле. Какие соединения идут между серверами и чек-лист для панели
на общем сервере — [mail-node.md, «Панель и узел на разных серверах»](mail-node.md#панель-и-узел-на-разных-серверах).

## 6. Подключить тенант Microsoft

[mail-node.md, раздел 6е](mail-node.md): приложение и сертификат, затем в `<PREFIX>/.env`
`COMPOSE_PROFILES=tenant` и ключи `TENANT_*`. Чтобы поднять исполнитель, достаточно повторного
`install.sh --prefix <PREFIX>` (он делает `up` с профилем из `.env`; образ исполнителя той же
версии скачивается сам). Затем «Тенант Microsoft» → «Проверить подключение».

Проверка: `sudo $D/status.sh` показывает `tenant_worker 1` и не жалуется на контейнер
`tenant-worker`.

## 7. Бэкапы

| Что | Как | Восстановление |
|---|---|---|
| панель: база, `.env`, при `--with-redis` — сессии | `mailexpert-backup.timer`, 03:30; вручную `backup.sh --tag manual [--verify]` | `restore.sh`, [deployment.md, раздел 6](deployment.md) |
| панель перед обновлением | `update.sh` сам: `backups/pre-update-<старая>.dump` (3 последних) и снимок `pre-update` | runbook «Откат обновления» |
| узел: vmail, mysql, ключи, конфигурация | `mailexpert-node-backup.timer`, 02:30 | `node-restore.sh` на чистый сервер, [mail-node.md, разделы 7-8](mail-node.md) |

Раз в квартал — репетиция восстановления на одноразовом сервере (панель: `restore.sh --no-start`;
узел: `node-restore.sh --rehearsal`), с замером времени.

## 8. Мониторинг

| Проверка | Кто пингует | Что значит тишина |
|---|---|---|
| здоровье панели (`HEALTHCHECK_PING_URL`) | `healthcheck.sh` раз в 5 минут | сервер панели или таймер не работает |
| бэкап панели (`BACKUP_PING_URL`, иначе предыдущая) | `backup.sh` ночью | бэкапа не было |
| диапазоны EOP и файрвол узла (`--ping-url`) | `eop-ranges.sh` раз в час | узел или таймер не работает |
| бэкап узла (`NODE_BACKUP_PING_URL`) | `node-backup.sh` ночью | бэкапа узла не было |
| диск узла, оповещения узла и EOP | панель (настройки узла, «Эксплуатация узла») | панель остановлена или узел недоступен |

Вручную в любой момент: `sudo $D/status.sh` (что сейчас) и `sudo $D/healthcheck.sh` (то же, что по
таймеру).

## 9. Обновление

Сборка — коммит `main` с зелёным CI (джоба `images` опубликовала образы `sha-<12>`). Номер версии
(`1.0.0`, `1.0.1`, ...) общий для всех пакетов и виден в панели; выпуск `v<x.y.z>` создаётся при
продвижении. Боевой канал —
`latest`: сборка, которую владелец отметил как готовую к проду
([deployment-system.md, раздел 9](../architecture/deployment-system.md)). Сервер и тогда запускает
её `sha-<12>`; `update.sh latest` и `status.sh --target latest` сначала превращают канал в `sha-<12>`.

**Продвижение в `latest`** (владелец): GitHub → Actions → «Promote to latest» → Run workflow, поле
`sha` — коммит `main` (пусто — голова `main`), `dry_run` — только проверить образы и версию. Перед
продвижением новой сборки её версия поднята PR `chore(release): x.y.z`
(`scripts/ci/release-version.sh bump`). Или:

```bash
gh workflow run promote.yml --repo wyrtensi/MailExpert -f sha=<sha или sha-12>   # пусто: голова main
gh api repos/wyrtensi/MailExpert/git/ref/tags/latest --jq '.object.sha[0:12]'    # что сейчас latest
```

Workflow ничего не собирает: проверяет, что коммит на `main` и что его образы (backend, frontend,
edge, tenant-worker) есть в GHCR, ставит им тег `latest` на тот же digest и переносит git-тег
`latest`. Новая версия коммита становится выпуском: образам тег `<x.y.z>`, git-тег `v<x.y.z>` и
GitHub Release с заметками. Уже выпущенный коммит (откат) только переносит `latest`; версия, которая
уже выпущена другим коммитом или не выше последнего выпуска, — отказ. Запускается только с `main`.

**Что изменилось в последних выпусках** и что заметит оператор при обновлении (первое обновление
с версии старее 2026-10-09 один раз пересоздаёт все контейнеры, включая базу, — короткий перерыв;
проверка владельца compose-проектов; ID установки и метки; привязка кодов входа и ссылок сброса к
адресу) — [deployment.md, «Что изменилось»](deployment.md#что-изменилось-заметки-для-операторов).

**Что сделать один раз, чтобы обновления работали на боевом сервере** (юниты исполнителя,
первое продвижение, проверка исполнителя, бэкапы, служба узла) —
[deployment.md, раздел 5.1](deployment.md#51-включить-обновления-на-боевом-сервере). Последний зелёный `main` (если владелец
просит другую версию; кнопка её не поставит, только `update.sh sha-<12>` по SSH):

```bash
gh run list --repo wyrtensi/MailExpert --workflow ci.yml --branch main --status success --limit 1 \
  --json headSha --jq '.[0].headSha[0:12]'
```

### Из панели (кнопка)

Администратор: «Настройки → Администрирование → Обновление панели». Карточка показывает текущую
версию и `latest` как номер версии и коммит («1.0.1 (sha-<12>)»; без номера — только `sha-<12>`),
число коммитов между ними со ссылкой на сравнение на GitHub, предпроверку
(`status.sh --target` на хосте: проблемы, предупреждения, шаги вне панели, новые миграции и
возможен ли автооткат) и кнопку «Обновить» с подтверждением. Дальше — ход обновления (строки лога
`update.sh`), итог, путь к логу на хосте (`<PREFIX>/state/updater/<id>.log`,
`journalctl -u mailexpert-updater.service`); панель на несколько минут перезапускается. В журнале
— «Запрошено обновление панели», «началось», «обновлена» или «не удалось», с администратором,
который нажал кнопку. Обычные пользователи карточку не видят.

Кнопку исполняет хост: `mailexpert-updater.path` замечает запрос, `mailexpert-updater.service`
(root) проверяет его, запускает `status.sh --target` и `update.sh` — те же шаги и проверки, что
ниже. Кнопка ставит только ровно продвинутую `latest` (на `main`, новее текущей версии); всё
остальное — `update.sh` по SSH, откат — `rollback.sh` по SSH. Версию, с которой откатились, кнопка
не предлагает, пока владелец не продвинет более новую. Юниты ставит `install.sh` на хосте с systemd (с `--no-system` тоже) на новых и
существующих установках; без них карточка пишет «механизм обновления не установлен», и обновление
идёт по шагам ниже. `status.sh` (поле `updater`, предупреждение) и `healthcheck.sh` (проблема, если
`mailexpert-updater.path` установлен, но не активен) следят за этими юнитами. Если кнопка не отвечает: `systemctl status mailexpert-updater.path
mailexpert-updater.service`; после множества запросов подряд юнит может упереться в лимит запусков —
`systemctl reset-failed mailexpert-updater.service mailexpert-updater.path && systemctl start
mailexpert-updater.path`. За один запуск исполнитель берёт не больше 10 запросов, остальные удаляет
(строка «removed N requests beyond 10» в журнале). Карточка пишет «каталог запросов недоступен для
записи» — владелец `request/` не совпадает с uid образа backend: перезапустить `install.sh` (он
спрашивает uid у образа и пишет его в `<PREFIX>/state/spool-uid`).

### По SSH

1. **Предпроверка** (ничего не меняет, кроме `git fetch` нужного коммита):

   ```bash
   sudo $D/update.sh --check sha-<12>      # = status.sh --target sha-<12>; вместо sha-<12> можно latest
   ```

   Код 0 — можно обновлять. `problem:` — устранить до обновления (не та версия в checkout, образа
   нет в реестре или реестр не ответил, мало места, база новее целевой версии, смена мажорной версии
   PostgreSQL, идёт другое обновление). `next:` — шаги после `update.sh`, `info:` — справка. Строка
   `pending_migrations` решает, каким будет откат: `none` — новых миграций нет; список — есть;
   `unknown` — схему прочитать не удалось (postgres не отвечает, standby), считать, что миграции
   **есть**.

   **Первое обновление с версии без `status.sh`** (`update.sh` отвечает «unknown argument:
   --check»): предпроверка из свежей копии репозитория, само обновление — как обычно:

   ```bash
   sudo git clone --depth 1 https://github.com/wyrtensi/MailExpert.git /root/mailexpert-next
   sudo /root/mailexpert-next/scripts/deploy/status.sh --prefix <PREFIX> --target sha-<12>
   ```

   Оговорка: так сегодняшний скрипт читает старую установку. Нужна установка, сделанная
   `install.sh` (есть `<PREFIX>/install.conf`); у совсем старой версии часть «проблем» может
   оказаться просто разницей версий (теги образов, файлы состояния, которых тогда не было). Такой
   вывод — подсказка, а не вердикт; собственные проверки `update.sh` остаются. После обновления
   `status.sh` есть в `<PREFIX>/app`, копию можно удалить (`sudo rm -rf /root/mailexpert-next`).
2. **Обновление** — отдельно от SSH-сессии: обновление идёт до 10 минут и дольше, а обрыв
   соединения убил бы запущенный в ней `update.sh` на полпути:

   ```bash
   sudo systemctl reset-failed mailexpert-update 2>/dev/null; sudo systemctl stop mailexpert-update 2>/dev/null
   sudo systemd-run --unit=mailexpert-update --property=RemainAfterExit=yes $D/update.sh sha-<12> --prefix <PREFIX>
   sudo journalctl -u mailexpert-update -f -o cat          # Ctrl-C закрывает только просмотр
   sudo systemctl show mailexpert-update -p ActiveState -p SubState -p ExecMainStatus
   ```

   `SubState=running` — ещё идёт; `exited` или `ActiveState=failed` — закончилось, код выхода в
   `ExecMainStatus`. Без systemd: `nohup $D/update.sh sha-<12> >/var/log/mailexpert-update.log 2>&1 &`
   и чтение лога.

   `update.sh`: бэкап перед обновлением, переключение, ожидание готовности до 10 минут.
   tenant-worker (если включён) обновляется вместе с панелью. Коды выхода:

   | Код | Что значит |
   |---|---|
   | 0 | обновлено; дальше — строки `next:` |
   | 1 | переключение началось, новая версия не поднялась; в выводе — были ли записаны миграции и путь назад (раздел 10) |
   | 2 | неверный ввод или состояние, запрещающее обновление (standby, панель не готова, нет коммита, мало места, мажорная версия PostgreSQL, чужие объекты в compose-проекте панели или края — [проверка владельца](deployment.md#имена-на-общем-сервере)); ничего не изменено |
   | 3 | сбой до переключения (образ не скачался, бэкап перед обновлением, Docker не ответил на проверке владельца, любая другая команда); ничего не изменено, работает прежняя версия |
3. **Шаги по строкам `next:`**:
   - `mail node: ...` — на узле тот же коммит (раздел 4 выше), `setup.sh --dry-run`, затем `setup.sh`;
   - образ Caddy (`info: edge: the Caddy image changed`) вручную не трогается: если между версиями
     изменился `deploy/edge/Dockerfile`, `update.sh` скачивает новый образ до бэкапа, `install.sh`
     закрепляет его по digest, а прежний `EDGE_IMAGE` остаётся в `<PREFIX>/state/edge-image.previous`
     (его возвращают `rollback.sh` и автооткат).
4. **Предупреждения панели**: правило раскладки спама на узле (`status.sh`: `spam_rule outdated`),
   «Применить настройки» узла, антиспам-политика тенанта.
5. **Проверка** на сервере, а не через публичный адрес (он за Access или входом Google):
   `sudo $D/status.sh` — `running` равен новой версии, проблем нет; `sudo $D/healthcheck.sh` — код 0;
   затем вход и статус ящиков.

**mailcow** обновляется только до версии, закреплённой выпуском (`deploy/mailcow-version`): со
службой узла — тем же заданием `update`, что и скрипты узла, после обновления панели; без службы —
`./update.sh` mailcow руками, пока голова `master` mailcow — закреплённый коммит, затем `setup.sh`
без параметров ([mail-node.md, разделы 3 и 7а](mail-node.md)).

Раскатка агентом (Claude Code и т. п.) идёт по тем же шагам — скилл
[`mailexpert-rollout`](../../.claude/skills/mailexpert-rollout/SKILL.md).

## 10. Откат

Сначала — состояние сервера сейчас: `sudo $D/status.sh` (`version`, `checkout`, `running`,
`migrations_applied`). После кода 2 или 3 там прежняя версия — откатывать нечего.

- **Новых миграций не было** (в предпроверке `pending_migrations none`, а не `unknown`, и
  `update.sh` написал «no migration was recorded as applied»):
  `sudo $D/install.sh --prefix <PREFIX> --version sha-<старая>` (тоже через `systemd-run`). Данные
  не теряются. Если обновление меняло образ Caddy (строка «the Caddy image was replaced as well»),
  **сначала** верните `EDGE_IMAGE` в `<PREFIX>/edge/.env` на значение из
  `<PREFIX>/state/edge-image.previous` (пустое — если прежний образ не был закреплён):
  `install.sh --version` прежний образ края сам не возвращает, `rollback.sh` и автооткат — возвращают.
  Строка `info: migrations: none was applied ...` после обновления называет этот шаг сама.
- **Миграции были или неизвестно**: `rollback.sh` (через `systemd-run`, как обновление):

  ```bash
  sudo $D/rollback.sh --prefix <PREFIX> --to sha-<старая>   # спросит версию ещё раз
  # без терминала (systemd-run, агент после «да» владельца): --confirm sha-<старая>
  ```

  Он делает то же, что [deployment.md, «Откат обновления»](deployment.md): останавливает backend и
  frontend, восстанавливает `backups/pre-update-<старая>.dump` в отдельную базу, подменяет текущую
  переименованием (прежняя остаётся как `<db>_before_rollback_<время>`), возвращает образ Caddy,
  если обновление его меняло, и запускает `install.sh --version`. Теряется всё, записанное после
  обновления. Коды: 0 — откат сделан; 1 — сбой после остановки (вывод говорит, в каком состоянии
  база); 2 и 3 — ничего не изменено.
- **Автооткат кнопки**: только если `update.sh` вышел с кодом 1 (новая версия не поднялась), а
  предпроверка прочитала схему и новых миграций не было (и число записанных не изменилось) —
  исполнитель сам запускает `install.sh --version <старая>` (итог «откат выполнен»). Любой другой
  код (2, 3 — ничего не изменено; прочие, например убитый процесс, — состояние неизвестно) — без
  отката: карточка показывает «не удалось» и ссылку сюда — решение за человеком.
- После отката (`rollback.sh` или автооткат) версия, с которой ушли, записана в
  `<PREFIX>/state/rolled-back-version`: кнопка её не предлагает, пока не продвинута более новая.
  Если эту версию потом поставили по SSH (`update.sh` или `install.sh --version`), `install.sh`
  снимает запись, как только она запущена.
- `rollback.sh` проверяет место до остановки (размер базы плюс дамп), перед подменой запрещает
  новые подключения к базе и повторяет подмену до 5 раз; прерванный после подмены запуск можно
  просто повторить (он только переключит код). Если `install.conf` уже говорит о целевой версии —
  закончить `install.sh --prefix <PREFIX>`. Откат на версию без `updater.sh` отключает юниты
  исполнителя.
- **Образ края** без `rollback.sh`: прежний digest из `<PREFIX>/state/edge-image.previous` в
  `EDGE_IMAGE` и `install.sh --prefix <PREFIX>`.
- **Скрипты узла**: прежний коммит в `/opt/mailexpert-node-src`, `setup.sh`.

## 11. Переезд

- Панель — [deployment.md, раздел 6](deployment.md): репетиция, финальный бэкап `--with-redis`,
  `restore.sh`, переключение DNS или туннеля.
- Узел — [mail-node.md, раздел 8](mail-node.md): `node-restore.sh`, репетиция, окно не дольше очереди
  EOP.
- Смена IP панели: на узле `setup.sh --panel-ip <новый>`, в панели — адреса для fail2ban и «Allow API
  access from» в mailcow; адрес — исходящий адрес нового сервера
  ([чек-лист](mail-node.md#панель-и-узел-на-разных-серверах)).

## 12. Неполадки

Коды выхода скриптов панели: `0` — сделано; `1` — сбой (у `status.sh` и `healthcheck.sh` — найдены
проблемы; у `update.sh` — сбой после переключения; у `install.sh` и `restore.sh` — в том числе
Docker не ответил на проверке владельца; у `backup.sh` — в том числе чужой контейнер в проекте
панели или Docker не ответил на этой проверке, дампа нет); `2` — неверный ввод или состояние, ничего
не изменено (сюда же отказ проверки владельца у `install.sh`, `update.sh`, `rollback.sh`, `restore.sh`,
`mailexpert-cli.sh`, `google-app.sh`); `3` — у `install.sh` ждёт секреты от `configure.sh`, у
`update.sh` и `rollback.sh` — сбой до переключения (в том числе Docker не ответил на проверке
владельца), ничего не изменено, у `mailexpert-cli.sh` и `google-app.sh` — сбой docker (в том числе
на проверке владельца) или CLI. `status.sh --json`
при сбое самого скрипта печатает `{"error": ..., "exit_code": N}`. Скрипты узла: `0`, `1` — шаг не
удался, `2` — неверный ввод.

| Признак | Где смотреть | Что делать |
|---|---|---|
| `install.sh` вышел с кодом 3 | его вывод: список ключей | `configure.sh` с этими ключами, повторить `install.sh` |
| «compose project ... is not only this install's» (код 2), `status.sh`: `problem: ownership: ...` | вывод: перечислены чужие контейнеры, тома, сети | новая установка — другое `--project`/`--edge-project`; существующая — `docker inspect <имя>`, убрать чужое из проекта; край `edge` — переезд ([«Имена на общем сервере»](deployment.md#имена-на-общем-сервере)) |
| `status.sh`: `info: names: ...` | строка называет проект без префикса или отсутствие `INSTALL_ID` | справка; переезд края — по команде из строки, ID появится при следующем `install.sh` или `update.sh` |
| `install.sh`: «ports for the edge are taken» или «--http-port ... is taken» | вывод: кто держит порт (`ss -ltnp`) | освободить порт, другой `--http-port`; на общем сервере — туннель или `--no-edge` ([рецепт](deployment.md#установка-на-общий-сервер-минимальное-влияние-полный-функционал)) |
| `update.sh` с прежней версии вышел с кодом 1, `status.sh`: «the running build is ..., install.conf says ...» сразу после отказа проверки владельца | вывод нового `install.sh` | убрать чужое из проекта, затем `install.sh --prefix <PREFIX>`; `rollback.sh` не нужен ([«Что изменилось»](deployment.md#что-изменилось-заметки-для-операторов)) |
| `update.sh` вышел с кодом 3 | его вывод: что не удалось | устранить (реестр, место, ключи restic) и повторить; сервер не менялся |
| `update.sh`: «did not become ready» (код 1) | `docker compose -p <project> logs backend` | миграция или старт backend; откат — раздел 10 |
| `status.sh`: «checkout ... install.conf says» | прерванная установка или обновление | `install.sh --prefix <PREFIX>` доведёт до версии из `install.conf` |
| `status.sh`: «older than the database schema» | обновление на версию старее базы | только откат через дамп |
| `status.sh`: «does not exist in the registry» | CI коммита: джоба `images` | выбрать коммит с зелёным CI |
| `status.sh`: «registry is unreachable or refused access» | сеть сервера, `docker manifest inspect <образ>` | доступ к `ghcr.io`, лимиты; образ при этом может существовать |
| `status.sh`: «PostgreSQL major version» | `docker-compose.yml` целевой версии | скриптами не поддерживается: дамп, новый том, восстановление — отдельная задача |
| `status.sh` / `healthcheck.sh`: «backup: ... hours old» | `journalctl -u mailexpert-backup` | бэкап вручную `backup.sh --tag manual`, проверить ключи restic |
| `containers: tenant-worker ...` | `docker compose -p <project> logs tenant-worker` | нет PFX или файла пароля; [mail-node.md, раздел 6е](mail-node.md) |
| `https://<DIRECT_HOST>` не отвечает | `docker compose -p mailexpert-edge logs caddy` (у установок, сделанных раньше, проект `edge`) | токен DNS, A-запись, `ufw` |
| `<CF_HOST>` — ошибка туннеля | `docker compose -p mailexpert-edge logs cloudflared` (у установок, сделанных раньше, проект `edge`) | `TUNNEL_TOKEN`, public hostname в Zero Trust |
| `install.sh` / `status.sh`: «cloudflare access: ...» | `status.sh --json`, поле `cf_access` | следующий шаг назван в строке; таблица — [cloudflare.md, раздел 9](cloudflare.md) |
| ящики узла красные после обновления узла | «Почтовый узел» в панели, `docker compose logs dovecot-mailcow` на узле | Dovecot перезапускался — подождать переподключения; правила файрвола: `setup.sh --dry-run` |
| пинг EOP-диапазонов `/fail` | тело пинга в Healthchecks | [mail-node.md, раздел 4](mail-node.md) |

Логи: `docker compose -p <project> logs backend` (или `frontend`, `postgres`, `redis`,
`tenant-worker`), `journalctl -u mailexpert-update`, `journalctl -u mailexpert-backup`,
`journalctl -u mailexpert-health` (с `--project <имя>` юниты таймеров и исполнителя — с суффиксом
`-<имя>`); на узле — `journalctl -u mailexpert-eop-ranges`,
`journalctl -u mailexpert-node-backup`.
