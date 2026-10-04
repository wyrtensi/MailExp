# Развёртывание MailExpert

Практическое руководство для владельца: установка панели на VPS, режимы входа, повседневные
операции и CLI панели, обновление, откат и переезд на другой сервер. Дизайн и обоснование решений — в
[2026-09-21-deployment-design.md](../superpowers/specs/2026-09-21-deployment-design.md). Настройка
Google-приложений для ящиков Gmail — отдельно, в [google-oauth.md](google-oauth.md).

Плейсхолдеры: `<APP_HOST>` — публичный адрес панели, это `<CF_HOST>` и/или `<DIRECT_HOST>`;
`<MAIL_HOST>` — почтовый узел, см. [mail-node.md](mail-node.md).

## 1. Что нужно

- VPS Ubuntu 24.04, минимум 2 vCPU / 4 ГБ RAM / 20 ГБ свободного диска (`install.sh` проверяет это
  сам и первую установку с нехваткой останавливает).
- Зона DNS в Cloudflare для `<DIRECT_HOST>` и будущего `<MAIL_HOST>`. Хосты `<APP_HOST>`
  (`<CF_HOST>` и/или `<DIRECT_HOST>`) и `<MAIL_HOST>` — с TTL 300 у записей, которые меняются при
  переезде (см. раздел 6 и «Переезд узла»).
- Токен Cloudflare API для DNS-01 (`DNS_API_TOKEN`) — только на правку DNS одной зоны, нужен
  Caddy для выпуска сертификата `<DIRECT_HOST>`.
- Токен туннеля (`TUNNEL_TOKEN`), если используется режим входа через Cloudflare (`cf` или
  `both`).
- OAuth-клиент входа в Google (`AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET`) — для режимов
  `direct`/`both`; это отдельный клиент, не путать с приложениями для Gmail-ящиков из
  [google-oauth.md](google-oauth.md).
- S3-совместимый бакет **у другого провайдера, чем сам сервер** — для бэкапов restic. Можно
  добавить позже: без него `install.sh` предупреждает «backups are off» и ставит панель без
  ночных бэкапов, а `update.sh` перед обновлением всё равно делает локальный дамп.
- Проверка в Healthchecks.io (или совместимом сервисе) с интеграцией в Telegram — оповещения о
  сбое бэкапа, проверки здоровья или о том, что пинги вообще перестали приходить.

## 2. Установка

Репозиторий публичный, образы GHCR публичные — токен реестра не нужен.

```bash
git clone https://github.com/wyrtensi/MailExpert.git /opt/mailexpert/app
sudo /opt/mailexpert/app/scripts/deploy/install.sh \
  --version sha-<12 символов коммита> \
  --signin cf|direct|both \
  --cf-host <CF_HOST> --direct-host <DIRECT_HOST> \
  --admin-email <email>[,<email>]
```

Тот же вызов из cloud-init user-data (секреты сюда не идут — они остаются только в
метаданных провайдера до конца установки):

```yaml
#cloud-config
packages:
  - git
runcmd:
  - git clone https://github.com/wyrtensi/MailExpert.git /opt/mailexpert/app
  - git -C /opt/mailexpert/app checkout --detach <12 символов коммита>
  - bash /opt/mailexpert/app/scripts/deploy/install.sh --version sha-<12 символов коммита>
      --signin both --cf-host <CF_HOST> --direct-host <DIRECT_HOST>
      --admin-email <email>
```

Первый запуск без секретов владельца останавливается с **кодом выхода 3** и списком
недостающих ключей. Внесите их через `configure.sh` (только stdin, значения не выводятся и не
попадают в аргументы):

```bash
ssh root@<host> /opt/mailexpert/app/scripts/deploy/configure.sh <<'EOF'
AUTH_GOOGLE_CLIENT_ID=<...>
AUTH_GOOGLE_CLIENT_SECRET=<...>
CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com
CF_ACCESS_AUDIENCE=<AUD>
TUNNEL_TOKEN=<...>
DNS_API_TOKEN=<...>
HEALTHCHECK_PING_URL=https://hc-ping.com/<uuid>
RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/mailexpert
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
RESTIC_PASSWORD=<пароль не короче 16 символов>
EOF
```

Передавайте только те ключи, которые `install.sh` перечислил как недостающие (набор зависит от
режима входа, см. раздел 3); бэкап можно настроить позже — без ключей restic панель ставится
и работает, но без бэкапов, пока их не добавят. Затем запустите установку ещё раз тем же
вызовом — она идемпотентна и продолжит с того же места:

```bash
sudo /opt/mailexpert/app/scripts/deploy/install.sh --version sha-<12 символов коммита> ...
```

**Ключ восстановления.** Если ключи restic были заданы, при первой успешной установке в терминал
один раз печатается `RESTIC_REPOSITORY` и `RESTIC_PASSWORD` — сохраните их вне сервера (в
менеджере паролей). Если установка шла не из терминала (cloud-init, CI), достаньте ключ вручную:

```bash
sudo /opt/mailexpert/app/scripts/deploy/backup.sh --show-recovery-key
```

**Первый вход и администратор.** В режиме `google` учётные записи из `--admin-email` становятся
администраторами при первом входе на `https://<APP_HOST>`. В режиме `--local-auth` (только для
тестовых стендов) администратором становится первый зарегистрированный пользователь.

## 3. Режимы входа

| Режим | Что делает | Нужные секреты | Redirect URI в Google |
|---|---|---|---|
| `direct` | Caddy закрывает TLS на `<DIRECT_HOST>` (сертификат через DNS-01), «Войти через Google» | `DNS_API_TOKEN`; `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET`, если не `--local-auth` | `https://<DIRECT_HOST>/oauth/login/google/callback` |
| `cf` | `cloudflared` — исходящий туннель к `<CF_HOST>`, вход через Cloudflare Access | `TUNNEL_TOKEN`; `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, если не `--local-auth` | не нужен: вход обрабатывает Access, а не клиент MailExpert |
| `both` | оба хоста разом: `<CF_HOST>` — основной (`APP_URL`), `<DIRECT_HOST>` — дополнительный (`APP_ALT_URLS`) | все перечисленные выше | `https://<DIRECT_HOST>/oauth/login/google/callback` |

Этот клиент Google — только для входа в саму панель; OAuth-приложения, через которые
MailExpert подключает Gmail-ящики пользователей, настраиваются отдельно и описаны в
[google-oauth.md](google-oauth.md).

## 4. Повседневные операции

- **Ночной бэкап** — таймер `mailexpert-backup.timer`, 03:30 по времени сервера
  (`backup.sh --tag nightly`). По воскресеньям бэкап дополнительно проверяется восстановлением
  (`--verify`: временная база + расшифровка), в остальные дни — `restic check --read-data-subset=5%`.
- **Проверка здоровья** — таймер `mailexpert-health.timer`, каждые 5 минут
  (`healthcheck.sh`): готовность `/api/health/ready`, состояние контейнеров, свободное место,
  возраст последнего бэкапа, срок сертификата `<DIRECT_HOST>`.
- **Ручной бэкап:**

  ```bash
  sudo /opt/mailexpert/app/scripts/deploy/backup.sh --tag manual
  # с полной проверкой восстановлением:
  sudo /opt/mailexpert/app/scripts/deploy/backup.sh --tag manual --verify
  ```

- **Что означают пинги.** И бэкап, и проверка здоровья шлют `start`/`success`/`fail` на
  `HEALTHCHECK_PING_URL` (бэкап — на отдельный `BACKUP_PING_URL`, если он задан). Успех — пинг
  на сам URL, сбой — на `<url>/fail` с описанием проблемы. Если сервер вообще замолчал (упал,
  не смог выполнить скрипт), пинги перестают приходить — Healthchecks.io замечает это сам и
  сообщает через интеграцию в Telegram.
- **Логи:**

  ```bash
  docker compose -p mailexpert logs backend    # или frontend, postgres, redis
  journalctl -u mailexpert-backup               # прогоны ночного бэкапа
  journalctl -u mailexpert-health                # прогоны проверки здоровья
  ```

### CLI панели

Для случаев, когда экран неудобен (массовые действия, скрипты, работа по SSH), у панели есть
командная строка `mailexpert`. Это та же панель: команды вызывают те же сервисы backend, что и
HTTP-маршруты экранов, с теми же проверками, кодами отказов и записями журнала. В обход панели
(напрямую в mailcow или тенант) CLI ничего не делает. Устройство — в
[panel-cli.md](../architecture/panel-cli.md).

Запуск с хоста — обёртка, которая находит установленную панель и выполняет CLI в контейнере
`backend`:

```bash
sudo /opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh <группа> <команда> [параметры]
sudo /opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh --help            # обёртка
sudo /opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh domain --help     # команды группы
sudo /opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh --prefix <PREFIX> domain list
```

`--prefix` — параметр самой обёртки, он идёт первым (по умолчанию `/opt/mailexpert`). Внутри
контейнера то же самое — `node src/cli/mailexpert.js ...` (в `package.json` backend это `bin`
`mailexpert`).

| Группа | Команды |
|---|---|
| `mailbox` | `list [--domain <DOMAIN>]`, `show <ADDRESS>`, `create <ADDRESS> [--name ...] [--sender-name ...] [--second-sender-name ...]`, `set-names <ADDRESS> [--name ...] [--sender-name ...] [--second-sender-name ...]`, `delete <ADDRESS> --reason <TEXT> [--confirm-address <ADDRESS>]`, `cancel-deletion <ADDRESS>` |
| `domain` | `list`, `show <DOMAIN>`, `restart <DOMAIN>`, `sync <DOMAIN>`, `hold <DOMAIN>`, `allow-authoritative <DOMAIN>`, `internal-relay <DOMAIN>`, `approve-alias-removal <DOMAIN>` |
| `tenant` | `status`, `test`, `antispam` |
| `quarantine` | `status`, `list`, `release`, `pause`, `resume` |
| `jobs` | `list [--status <STATUS>\|problems] [--kind <KIND>] [--limit <N>]`, `show <ID>` |

Ящик называется адресом или ID; если у адреса две строки в панели, CLI просит ID
(`mailbox_ambiguous`). `--sender-name` (синоним `--ru`) — имя отправителя, `--second-sender-name`
(синоним `--en`) — второе имя с тем же адресом, `""` убирает его; второе имя, совпадающее с
основным, отклоняется (`sender_name_alt_same`). Алиаса с другим адресом CLI не делает (D-16):
другой адрес — отдельный ящик. Новый ящик backend подключает сам в течение
90 секунд (его проверка соединений).

Общие параметры:

- `--json` — ответ в виде JSON, в тех же формах, что отвечает API панели; ошибка —
  `{ "error": "...", "code": "..." }` на stdout. С `--json` обёртка не даёт контейнеру терминал
  (иначе stderr смешался бы со stdout), поэтому подтверждение тогда — только `--yes`.
- `--yes` (`-y`) — подтвердить необратимое действие без вопроса: `domain restart`,
  `allow-authoritative`, `internal-relay`, `approve-alias-removal`, `quarantine pause`. Без
  терминала (конвейер, скрипт, `--json`) CLI не ждёт ответа, а отказывает с кодом
  `confirmation_required`. Удаление ящика, как в интерфейсе, подтверждается вводом адреса
  ящика (в терминале — на вопрос, иначе `--confirm-address <ADDRESS>`); `--yes` его не заменяет,
  причина (`--reason`) обязательна.
- `--as <ADMIN_EMAIL>` — записать действие в журнал от имени администратора (он должен быть
  включённым администратором панели). Без него в журнале исполнитель `cli`; в обоих случаях
  `details.via = "cli"`. Так же подписаны записи заданий, которые CLI поставил (проверка
  соединения, исправление антиспам-политики). `--help` команды говорит, что она пишет в журнал.
- `--wait [--timeout <SEC>]` у команд, которые ставят задание тенанта (`domain sync`,
  `internal-relay`, `approve-alias-removal`, `tenant test`, `tenant antispam`,
  `quarantine release`): дождаться, пока воркер backend выполнит задание (по умолчанию до
  120 секунд). Сам CLI заданий не выполняет.

Коды выхода: `0` — сделано; `1` — отказ (печатается код ошибки API, например
`domain_not_ready`), или ответ «нет» на вопрос; `2` — ошибка в командной строке или
подтверждение, которое CLI не смог спросить; `3` — сбой почтового узла, тенанта, задания или
самой панели. Обёртка возвращает код CLI как есть; её собственные ошибки (параметры, запуск не от
root, нет установки) — `2`; если docker не может выполнить CLI (контейнер `backend` не запущен,
образ панели старее CLI — сначала обновите панель, ошибка docker 125-127) — `3`.

Примеры:

```bash
cli=/opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh
sudo $cli domain list
sudo $cli domain show <DOMAIN>
sudo $cli mailbox create <LOCAL>@<DOMAIN> --sender-name "<NAME>" --second-sender-name "<NAME_LATIN>"
sudo $cli mailbox delete <LOCAL>@<DOMAIN> --reason "<REASON>"          # спросит адрес
sudo $cli jobs list --status problems --json | jq '.jobs[].id'
sudo $cli quarantine release --wait --as <ADMIN_EMAIL>
```

## 5. Обновление

```bash
sudo /opt/mailexpert/app/scripts/deploy/update.sh sha-<12 символов коммита>
```

`sha-<12>` — тег образов в GHCR, который публикует джоба `images` CI после зелёной сборки на
`main`; посмотреть его можно в логе прогона CI этой джобы или коротким `git rev-parse` нужного
коммита на `main`.

`update.sh` делает бэкап перед обновлением (`backups/pre-update-<старый sha>.dump`, последние 3
хранятся на месте), переключает версию через `install.sh --version` и проверяет готовность до
10 минут. **Автоматического отката нет** (упрощено 2026-09-22): если новая версия не поднялась,
скрипт останавливается с кодом 1, прежняя версия остаётся как есть, а путь назад — ручной.

### Откат обновления

Точные команды (замените `<old-sha>` на версию, к которой возвращаетесь, и `mailexpert` — на
своё имя проекта/БД, если меняли `--project`/`DB_NAME` при установке):

1. Остановить backend и frontend, оставив базу работающей:

   ```bash
   cd /opt/mailexpert
   APP="docker compose -p mailexpert --project-directory app --env-file .env -f app/docker-compose.yml -f app/deploy/compose.prod.yml"
   $APP stop backend frontend
   ```

2. Восстановить `backups/pre-update-<old-sha>.dump` в базу. `pg_restore --clean` здесь не
   годится: он не убирает таблицы, которые создали более новые миграции, и следующее обновление
   упадёт на их повторном создании. Поэтому дамп восстанавливается в отдельную базу, а затем
   подменяет текущую переименованием:

   ```bash
   $APP exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d postgres' <<'SQL'
   DROP DATABASE IF EXISTS mailexpert_rollback;
   CREATE DATABASE mailexpert_rollback;
   SQL

   $APP exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d mailexpert_rollback --no-owner --exit-on-error --single-transaction' \
     < backups/pre-update-<old-sha>.dump

   $APP exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d postgres' <<SQL
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'mailexpert' AND pid <> pg_backend_pid();
   BEGIN;
   ALTER DATABASE mailexpert RENAME TO mailexpert_before_rollback_$(date +%Y%m%d%H%M%S);
   ALTER DATABASE mailexpert_rollback RENAME TO mailexpert;
   COMMIT;
   SQL
   ```

   Прежняя база остаётся как `mailexpert_before_rollback_<время>` — удалите её вручную, когда
   убедитесь, что откат не нужен:
   `$APP exec postgres sh -c 'dropdb -U "$POSTGRES_USER" mailexpert_before_rollback_<время>'`.

3. Вернуть прежний код и образы:

   ```bash
   sudo /opt/mailexpert/app/scripts/deploy/install.sh --version <old-sha>
   ```

**Всё, что записано после обновления, теряется** — пользователи, правила, журнал, новые
подключения ящиков появившиеся после апдейта. Почта сама не теряется: она живёт на серверах
провайдера, синхронизация догрузит пропущенное после отката.

## 6. Переезд панели на другой сервер

Имена хостов не меняются, поэтому Google-приложения, redirect URI и Cloudflare Access трогать
не нужно.

1. **Сервер B заранее:** `install.sh` той же версии, что на A, с теми же флагами, но
   `--no-start` (Caddy стартует и получает сертификат `<DIRECT_HOST>` заранее, `cloudflared` —
   нет). `configure.sh` на B — только ключи restic (остальные секреты возьмёт `restore.sh` из
   бэкапа).
2. **Репетиция:**

   ```bash
   sudo /opt/mailexpert/app/scripts/deploy/restore.sh latest --no-start
   curl --resolve <DIRECT_HOST>:443:<IP сервера B> https://<DIRECT_HOST>/api/health
   docker compose -p mailexpert down -v   # убрать репетиционные данные с B
   ```

   Время восстановления из репетиции (`restore_seconds` в выводе) — оценка простоя.
3. **В день переезда, на A:** остановить приложение и туннель —
   `docker compose -p mailexpert stop backend frontend`, для режима `cf`/`both` — также
   `cloudflared` в проекте `edge`.
4. **Финальный бэкап на A:**

   ```bash
   sudo /opt/mailexpert/app/scripts/deploy/backup.sh --with-redis --tag move
   ```

   После него A автоматически становится standby: ночной бэкап и проверка здоровья на нём
   пропускаются.
5. **Восстановление на B:** `restore.sh <снимок move>` (без `--no-start` — панель запустится).
6. **Переключение:**
   - режим `cf`: `cloudflared` на B поднимается с тем же `TUNNEL_TOKEN`, DNS не меняется;
   - режим `direct`: A-запись `<DIRECT_HOST>` — на IP сервера B (TTL уже 300, ждать не нужно).
7. **Проверка:** `/api/health/ready` и `/api/version` через оба хоста; вход; статус ящиков в
   админке; тестовое письмо.
8. **Если переезд отменяется:**
   - до шага 4 (финального бэкапа) — просто не выполняйте оставшиеся шаги, A всё ещё активен;
   - после шага 4, но до старта B — на A: `sudo /opt/mailexpert/app/scripts/deploy/install.sh
     --prefix /opt/mailexpert` без флагов — это снимает отметку standby и снова запускает
     панель на A;
   - если B уже запущен (после шага 5) — сначала остановите его
     (`docker compose -p mailexpert down`, без `-v`, данные не трогать), затем снимите standby
     на A так же, как выше.

**Простой** — от остановки A (шаг 3) до готовности B (шаг 6): финальный дамп, передача,
восстановление. Ориентир — `restore_seconds` из `state/backup-last.json` плюс время дампа: для
базы в единицы гигабайт это 5-15 минут, для 50 ГБ — около часа.

**Что видят пользователи:** во время простоя — страница ошибки туннеля (`<CF_HOST>`) или
страница обслуживания Caddy (`<DIRECT_HOST>`); после переезда — сессии сохранены (бэкап был с
`--with-redis`), без него — повторный вход; начатые в момент заморозки подключения Gmail
заканчиваются `invalid_state` и начинаются заново.

## 7. Переезд почтового узла

Установка, файрвол, EOP, бэкап и переезд узла описаны в [mail-node.md](mail-node.md). Коротко:
MailExpert хранит только `<MAIL_HOST>`, IP узла не хранится нигде, поэтому после переезда узла в
панели менять нечего.

## 8. Проверка перед продом

Перед первым боевым переездом владелец проводит **репетицию переезда на втором дешёвом VPS** по
разделу 6 целиком, с замером фактического простоя. Этот шаг выполняется вручную и не
автоматизирован скриптами.
