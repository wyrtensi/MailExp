# Развёртывание MailExpert

Практическое руководство для владельца: установка панели на VPS, режимы входа, повседневные
операции и CLI панели, обновление, откат и переезд на другой сервер. Дизайн и обоснование решений — в
[2026-09-21-deployment-design.md](../superpowers/specs/2026-09-21-deployment-design.md). Настройка
Google-приложений для ящиков Gmail — отдельно, в [google-oauth.md](google-oauth.md).

Плейсхолдеры: `<APP_HOST>` — публичный адрес панели, это `<CF_HOST>` и/или `<DIRECT_HOST>`;
`<MAIL_HOST>` — почтовый узел, см. [mail-node.md](mail-node.md).

Сетевые требования всех модулей — [ports.md](ports.md): production frontend доступен на
`127.0.0.1:8080` (настраивается через `--http-port` / `APP_HTTP_PORT`), снаружи direct-вход
использует TCP 80/443 и необязательный UDP 443. Cloudflare Tunnel использует исходящий TCP/UDP
7844; базы и tenant-worker остаются внутри Docker. Там же — исходящие соединения, узел и стенды.

## 1. Что нужно

Всё, что настраивается в Cloudflare (Zero Trust и Google как способ входа, туннель и маршрут
`<CF_HOST>`, приложение Access и его AUD, токен DNS-01 и A-запись `<DIRECT_HOST>`, токен
синхронизации пользователей, права каждого токена) — пошагово, в панели и через API, в
[cloudflare.md](cloudflare.md). Делайте это **до** первого `install.sh`.

- VPS Ubuntu 24.04, минимум 2 vCPU / 4 ГБ RAM / 20 ГБ свободного диска (`install.sh` проверяет это
  сам и первую установку с нехваткой останавливает).
- Зона DNS в Cloudflare для `<DIRECT_HOST>` и будущего `<MAIL_HOST>`. Хосты `<APP_HOST>`
  (`<CF_HOST>` и/или `<DIRECT_HOST>`) и `<MAIL_HOST>` — с TTL 300 у записей, которые меняются при
  переезде (см. раздел 6 и «Переезд узла»).
- Токен Cloudflare API для DNS-01 (`DNS_API_TOKEN`) — только на одну зону: Zone · DNS · Edit и
  Zone · Zone · Read, нужен Caddy для выпуска сертификата `<DIRECT_HOST>`.
- Токен туннеля (`TUNNEL_TOKEN`), если используется режим входа через Cloudflare (`cf` или
  `both`).
- OAuth-клиент входа в Google (`AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET`) — для режимов
  `direct`/`both`; это отдельный клиент, не путать с приложениями для Gmail-ящиков из
  [google-oauth.md](google-oauth.md).
- S3-совместимый бакет **у другого провайдера, чем сам сервер** — для бэкапов restic. Можно
  добавить позже: без него `install.sh` предупреждает «backups are off» и ставит панель без
  ночных бэкапов, а `update.sh` перед обновлением всё равно делает локальный дамп. Почтовый узел
  бэкапится в то же хранилище, но в свой репозиторий restic со своим паролем
  ([mail-node.md, раздел 7](mail-node.md)).
- Проверка в Healthchecks.io (или совместимом сервисе) с интеграцией в Telegram — оповещения о
  сбое бэкапа, проверки здоровья или о том, что пинги вообще перестали приходить.

## 2. Установка

Репозиторий публичный, образы GHCR публичные — токен реестра не нужен. Кратчайший путь с проверками
после каждого шага — [quickstart.md](quickstart.md). Клонировать от root: `install.sh` работает с
`/opt/mailexpert/app` от root. `--version` принимает только `sha-<12>`; для боевой версии клонируйте
тег `latest` и возьмите его коммит.

```bash
sudo git clone --branch latest https://github.com/wyrtensi/MailExpert.git /opt/mailexpert/app
V=sha-$(sudo git -C /opt/mailexpert/app rev-parse HEAD | cut -c1-12)
sudo /opt/mailexpert/app/scripts/deploy/install.sh \
  --version "$V" \
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

**Первый вход и администратор.** Без `--local-auth` (вход через Google или Cloudflare Access,
`AUTH_MODE=google` в `.env`) учётные записи из `--admin-email` становятся администраторами при первом
входе на `https://<APP_HOST>`. С `--local-auth` (только для тестовых стендов) администратором
становится первый зарегистрированный пользователь.

## 3. Режимы входа

| Режим | Что делает | Нужные секреты | Redirect URI в Google |
|---|---|---|---|
| `direct` | Caddy закрывает TLS на `<DIRECT_HOST>` (сертификат через DNS-01), «Войти через Google» | `DNS_API_TOKEN`; `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET`, если не `--local-auth` | `https://<DIRECT_HOST>/oauth/login/google/callback` |
| `cf` | `cloudflared` — исходящий туннель к `<CF_HOST>`, вход через Cloudflare Access | `TUNNEL_TOKEN`; `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, если не `--local-auth` | не нужен: вход обрабатывает Access, а не клиент MailExpert |
| `both` | оба хоста разом: `<CF_HOST>` — основной (`APP_URL`), `<DIRECT_HOST>` — дополнительный (`APP_ALT_URLS`) | все перечисленные выше | `https://<DIRECT_HOST>/oauth/login/google/callback` |

Где взять каждый из этих секретов в Cloudflare — [cloudflare.md](cloudflare.md). В режимах `cf` и
`both` `install.sh` после запуска туннеля проверяет, что `https://<CF_HOST>` закрыт Access команды
из `CF_ACCESS_ISSUER`; несовпадение — предупреждение со следующим шагом, не остановка установки, а
`status.sh` повторяет проверку (поле `cf_access`, [cloudflare.md, раздел 7](cloudflare.md)).

**Адрес клиента и лимит входа.** Во всех трёх режимах перед бэкендом два прокси: край (Caddy
или `cloudflared`) и nginx контейнера `frontend`, и оба дописывают адрес в `X-Forwarded-For`.
Поэтому `deploy/compose.prod.yml` задаёт `TRUST_PROXY=2`: бэкенд берёт адрес клиента на два
шага от себя. Через Cloudflare это тот же адрес, что в `CF-Connecting-IP` (Cloudflare дописывает
адрес посетителя последним); сам заголовок `CF-Connecting-IP` не читается, потому что в режиме
`both` его может прислать посетитель хоста Caddy.

**Лимиты входа** (`auth_max_attempts` за `auth_window_minutes`, дальше — N). У каждого шага свои
счётчики: вход по паролю, шаги 2FA, регистрация, ссылка и сброс пароля друг другу не мешают.
- Вход по паролю считает только неудачные попытки: N на учётную запись с одного адреса, 10·N на
  учётную запись со всех адресов, 10·N на адрес по всем учётным записям. Успешный вход сбрасывает
  счётчик «учётка с этого адреса». Офис за одним NAT, где все входят с правильным паролем, лимит
  не расходует.
- Запрос с действующей cookie доверенного устройства (`mf_td`) этой учётной записи не
  блокируется лимитами учётной записи, только лимитом адреса.
- Шаги 2FA: N на ожидающий вход, 10·N на адрес. Запросы ссылки сброса пароля: N на адрес почты,
  10·N на адрес клиента; вход они не блокируют.
- Оставшийся компромисс: тот, кто может делать неудачные попытки с 10·N разных адресов, может
  на одно окно закрыть вход в чужую учётную запись (кроме входа с доверенного устройства).

Менять `TRUST_PROXY` в `.env`
нужно только при другой цепочке прокси: значение больше реального числа прокси позволяет
клиенту подставить чужой адрес. Без overlay (`docker-compose.yml`, nginx снаружи) действует `1`.

Этот клиент Google — только для входа в саму панель; OAuth-приложения, через которые
MailExpert подключает Gmail-ящики пользователей, настраиваются отдельно и описаны в
[google-oauth.md](google-oauth.md).

## 4. Повседневные операции

- **Ночной бэкап** — таймер `mailexpert-backup.timer`, 03:30 по времени сервера
  (`backup.sh --tag nightly`). По воскресеньям бэкап дополнительно проверяется восстановлением
  (`--verify`: временная база + расшифровка), в остальные дни — `restic check --read-data-subset=5%`.
  Бэкап ждёт до часа, пока закончатся другой бэкап, обновление, откат, восстановление, `install.sh`
  или `configure.sh`; не дождался — пинг `fail`. Обновления и установки он задерживает только на
  время дампа базы (`install.sh`, `update.sh` и `rollback.sh` ждут его до 10 минут); загрузка в
  хранилище и проверки им не мешают. Весь прогон юнита ограничен 6 часами.
- **Проверка здоровья** — таймер `mailexpert-health.timer`, каждые 5 минут
  (`healthcheck.sh`): готовность `/api/health/ready`, состояние контейнеров, свободное место,
  возраст последнего бэкапа, срок сертификата `<DIRECT_HOST>`, исполнитель обновлений из панели
  (проблема, если `mailexpert-updater.path` установлен, но не активен).
- **Ручной бэкап:**

  ```bash
  sudo /opt/mailexpert/app/scripts/deploy/backup.sh --tag manual
  # с полной проверкой восстановлением:
  sudo /opt/mailexpert/app/scripts/deploy/backup.sh --tag manual --verify
  ```

- **Что в бэкапе.** Снимок restic содержит всё, что нужно, чтобы поднять панель на чистом сервере
  (`restore.sh`, раздел 6): дамп базы со счётчиками строк, `.env` (ключ шифрования, пароль базы,
  секреты владельца, ключи restic и S3), `edge/.env`, `install.conf`, а при включённом профиле
  `tenant` — сертификат исполнителя тенанта `app.pfx` и файл его пароля (из `TENANT_CERT_DIR` и
  `TENANT_PFX_PASSWORD_FILE`). Если профиль включён, а какого-то из этих файлов нет, бэкап пишет
  предупреждение с именем ключа и путём (оно же — в тексте пинга успеха) и идёт дальше без него;
  бэкап переезда (`--tag move`) в этом случае завершается ошибкой. С `--with-redis` — ещё дамп Redis.
  Репозиторий restic зашифрован паролем `RESTIC_PASSWORD`: без него снимки не прочитать, с ним и
  ключами S3 — прочитать все секреты панели, поэтому ключ восстановления храните как самый ценный
  секрет (менеджер паролей, не на этом сервере). Не входят в снимок и не нужны для восстановления:
  сертификаты Caddy (выпускаются заново), имя хоста restic (`state/restic-host`, у каждого сервера
  своё), локальные дампы в `backups/`.

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

### Локальные дополнения compose (`compose.local.yml`)

Если на сервере нужно что-то своё поверх стандартной конфигурации панели (дополнительная запись
`extra_hosts`, свой корневой сертификат для backend, ещё один сервис в той же сети), положите это в
`<PREFIX>/compose.local.yml` (по умолчанию `/opt/mailexpert/compose.local.yml`). Если файл есть,
скрипты добавляют его последним `-f` (после `deploy/compose.prod.yml`) в каждую команду
`docker compose` проекта панели: `install.sh`, `update.sh` и кнопка обновления в панели, `backup.sh`,
`restore.sh`, `rollback.sh`, `status.sh`, `healthcheck.sh`, CLI `mailexpert`. Файл лежит вне `app/`,
поэтому checkout другой версии при обновлении его не трогает. Пример:

```yaml
services:
  backend:
    extra_hosts:
      - "mail.example.com:192.0.2.10"
```

- Относительные пути в файле считаются от `<PREFIX>/app` (каталог проекта compose) — надёжнее писать
  абсолютные.
- `install.sh` при запуске пишет в лог, что использует этот файл; применяется он при следующем
  `install.sh` или обновлении (или `docker compose ... up -d` с тем же набором `-f`).
- Проект края (`edge`, Caddy и cloudflared) этот файл не затрагивает.
- `install.sh` запускает панель с `--remove-orphans`: сервис, убранный из файла, при следующем
  запуске останавливается и удаляется. Это касается только контейнеров проекта панели (`-p`):
  проект края и чужие проекты не трогаются.
- Файл входит в бэкап (`compose.local.yml` в снимке, root, `0600`). `restore.sh` возвращает его,
  если на новом сервере файла нет (свой файл сервера остаётся), и дальше восстанавливает уже с ним.
- **Версии старше этой возможности файл не знают.** Установка, обновление или откат на такую
  версию (`install.sh --version <старая>` — он продолжает установщиком той версии, `update.sh`,
  `rollback.sh --to <старая>`, автооткат кнопки обновления на прежнюю версию) запускают панель без
  дополнений. `install.sh`, `update.sh` и `rollback.sh` в этом случае пишут предупреждение;
  дополнения вернутся после установки версии, которая файл знает.

> **Внимание: это ответственность оператора.** Скрипты не проверяют содержимое файла. Дополнение,
> которое меняет образы, порты, тома базы, лимиты памяти или переменные, которые пишет `install.sh`,
> может сломать обновление, бэкап или откат, и предпроверки этого не заметят. Держите в файле только
> то, без чего сервер не работает, и проверяйте его после каждого обновления
> (`status.sh`, `docker compose -p <проект> ps`). Без файла панель работает в стандартной
> конфигурации — удалить его и перезапустить `install.sh --prefix <PREFIX>` безопасно: сервисы,
> которые добавлял только он, `install.sh` остановит и удалит (`--remove-orphans`), а данные в
> их именованных томах останутся.

### CLI панели

Для случаев, когда экран неудобен (массовые действия, скрипты, работа по SSH), у панели есть
командная строка `mailexpert`. Это та же панель: команды вызывают те же сервисы backend, что и
HTTP-маршруты экранов, с теми же проверками, кодами отказов и записями журнала. В обход панели
(напрямую в mailcow или тенант) CLI ничего не делает. Полный справочник команд, параметров, кодов
и ответов `--json` — [cli.md](cli.md); устройство — [panel-cli.md](../architecture/panel-cli.md).

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
| `mailbox` | `list [--domain <DOMAIN>]`, `show <ADDRESS>`, `create <ADDRESS> [--name ...] [--sender-name ...] [--second-sender-name ...]`, `set-names <ADDRESS> [--name ...] [--sender-name ...] [--second-sender-name ...]`, `delete <ADDRESS> --reason <TEXT> [--confirm-address <ADDRESS>]`, `cancel-deletion <ADDRESS>`, `deactivate <ADDRESS> --reason <TEXT>`, `reactivate <ADDRESS>`, `set-quota <ADDRESS> <MB>`, `set-rate-limit <ADDRESS> <N/s\|N/m\|N/h\|N/d\|default>`, `oauth-reset <ADDRESS>` (OAuth-ящик Gmail или Outlook, не с узла) |
| `domain` | `list`, `show <DOMAIN>`, `add <DOMAIN> [--mailboxes <N>]`, `adopt <DOMAIN>`, `step <DOMAIN> <STEP>`, `ready <DOMAIN>`, `ack <DOMAIN> [--created <TIME>]`, `dns-expected <DOMAIN> [--mx ...] [--tenant-txt ...] [--dkim-cname1 ...] [--dkim-cname2 ...]`, `restart <DOMAIN>`, `sync <DOMAIN> [--wait]`, `hold <DOMAIN>`, `allow-authoritative <DOMAIN>`, `internal-relay <DOMAIN> [--wait]`, `approve-alias-removal <DOMAIN> [--wait]`, `dns-check [<DOMAIN>] [--wait]` (`--wait` — только без домена) |
| `tenant` | `status`, `test [--wait]`, `antispam [--wait]`, `poll [--wait]`, `connectors-reference` |
| `quarantine` | `status`, `list`, `release [--wait]`, `pause`, `resume` |
| `jobs` | `list [--status <STATUS>\|problems] [--kind <KIND>] [--limit <N>]`, `show <ID>` |
| `access` | `status`, `config [--account <ID>] [--app <ID>] [--policy <ID>] [--enable\|--disable]`, `token` (токен только со stdin), `sync [--timeout <SEC>]` — синхронизация пользователей с политикой Cloudflare Access ([cloudflare.md, раздел 8](cloudflare.md)) |
| `user` | `list [--limit <N>] [--offset <N>]`, `show <EMAIL>`, `create <EMAIL> [--admin]`, `set <EMAIL> [--admin\|--no-admin] [--disable\|--enable] [--email <NEW>]`, `delete <EMAIL>`, `totp-reset <EMAIL>` — пользователи панели, с защитой последнего администратора |
| `settings` | `get [<KEY>]`, `set <KEY> <VALUE>` — настройки экрана администратора (вход по паролю, регистрация, 2FA, лимиты входа, интервалы синхронизации, сетевые разрешения) |
| `sso` | `list`, `add ...`, `set <ID\|SLUG> ...`, `remove <ID\|SLUG>` — SSO-провайдеры; секрет клиента только со stdin |
| `integration` | `microsoft show\|set\|remove` — клиент Microsoft OAuth для ящиков Outlook; секрет только со stdin (`--secret`). Приложения Google — не группа `mailexpert`, а отдельная обёртка `google-app.sh` ([google-oauth.md](google-oauth.md#управление-из-командной-строки)) |
| `node` | `config show`, `config set [--mail-host <MAIL_HOST>] [--quota <MB>] [--delete-after-days <N>] [--disk-ping-url <URL>] [--panel-ips <LIST>] [--node-ip <IP>] [--api-key-stdin]` (ключ mailcow только со stdin), `apply [--domain <DOMAIN> [--confirm-dkim-delete]]`, `apply --prefilter` — настройки почтового узла и их применение |
| `eop` | `show`, `set [--eop-host ...] [--licenses <N>] ...` (все поля экрана EOP), `budget` — настройки EOP и бюджет TERRL |
| `seats` | `status`, `check [--wait]`, `set-hold <DAYS>`, `request <N>` — места EOP |
| `agent` | `status`, `jobs [--limit <N>]`, `token issue [--out <TOKEN_FILE>\|--out -]`, `token revoke`, `run status\|backup\|update` — агент узла; токен печатается один раз (или пишется в файл 0600 на хосте) для `setup.sh --agent-token-file` |
| `queue` | `list`, `show <QUEUE_ID> [--body]`, `flush`, `hold\|release\|deliver\|delete <QUEUE_ID>` — почтовая очередь узла |
| `alerts` | `status`, `check [--wait]`, `set [--ping-url <URL>] [--deferred-count <N>] [--deferred-minutes <N>]` — оповещения узла |
| `outage` | `list`, `show <ID>`, `letters <ID>`, `open --start <TIME> [--end <TIME>] --reason <TEXT> [--planned]`, `update <ID> [--start <TIME>] [--end <TIME>] --reason <TEXT>`, `close <ID> [--end <TIME>] --reason <TEXT>`, `delete <ID> --reason <TEXT>`, `trace [--wait]`, `settings show\|set --retention-days <N>` — простои узла и письма в них |
| `spam-quarantine` | `list`, `release\|learn-spam\|delete <ID>`, `settings show\|set --user-view on\|off`, `node-settings show\|apply` — карантин rspamd на узле (не EOP) |
| `invite` | `list [--limit <N>] [--offset <N>]`, `create <EMAIL> --as <ADMIN_EMAIL>`, `revoke <ID>` — приглашения на регистрацию; письмо уходит через системную почту |
| `system-email` | `show`, `set [--host ...] [--user ...] [--password-stdin] ...` (пароль только со stdin), `test`, `remove` — SMTP системной почты панели |
| `audit` | `list [--action <A>] [--since <T>] [--until <T>] [--account <ADDRESS>] [--user <EMAIL>] [--before <CURSOR>] [--limit <N>]`, `auth-events [--limit <N>] [--offset <N>]` — журнал и события входа |
| `account` | `list [--user <EMAIL>]`, `create <ADDRESS> --imap-host ... --smtp-host ...` (пароль только со stdin), `set-connection <ADDRESS> ... [--password-stdin\|--smtp-password-stdin]` — ящики, настроенные вручную по IMAP/SMTP, с проверками политики подключений |
| `rule` | `list [--account <ADDRESS>] [--user <EMAIL>]`, `show <ID>`, `create`, `set <ID>` (JSON правила со stdin или `--file`; `--account`, `--user`), `enable <ID>`, `disable <ID>`, `delete <ID>` (`--user`), `run --account <ADDRESS>\|--all` — правила входящих |

Ящик называется адресом или ID; если у адреса две строки в панели, CLI просит ID
(`mailbox_ambiguous`). `--sender-name` (синоним `--ru`) — имя отправителя, `--second-sender-name`
(синоним `--en`) — второе имя с тем же адресом, `""` убирает его; второе имя, совпадающее с
основным, отклоняется (`sender_name_alt_same`). Алиаса с другим адресом CLI не делает (D-16):
другой адрес — отдельный ящик. Новый ящик backend подключает сам в течение
90 секунд (его проверка соединений).

Общие параметры:

- `--json` — ответ в виде JSON, в тех же формах, что отвечает API панели; отказ —
  `{ "error": "...", "code": "..." }` на stdout (ошибки самой командной строки, код 2, — текстом в
  stderr; `confirmation_required` — объектом). С `--json` обёртка не даёт контейнеру терминал
  (иначе stderr смешался бы со stdout), поэтому подтверждение тогда — только `--yes`.
- `--yes` (`-y`) — подтвердить необратимое действие без вопроса: `mailbox deactivate`,
  `mailbox oauth-reset`, `domain ready`, `domain ack` (без `--created`), `domain restart`,
  `allow-authoritative`, `internal-relay`, `approve-alias-removal`, `quarantine pause`,
  `user delete`, `user totp-reset`, `sso remove`, `integration microsoft remove`,
  `node apply --prefilter`, `agent token issue` при ротации, `agent token revoke`, `queue flush`,
  `queue delete`, `outage delete`, `spam-quarantine release`, `spam-quarantine learn-spam`,
  `spam-quarantine delete`, `spam-quarantine node-settings apply`, `invite revoke`,
  `system-email remove`, `rule delete`, `rule run`. Без терминала (конвейер, скрипт, `--json`) CLI
  не ждёт ответа, а отказывает с кодом `confirmation_required` (код 2). Удаление ящика, как в интерфейсе, подтверждается вводом адреса
  ящика (в терминале — на вопрос, иначе `--confirm-address <ADDRESS>`); `--yes` его не заменяет,
  причина (`--reason`) обязательна.
- `--as <ADMIN_EMAIL>` — записать действие в журнал от имени администратора (адрес или имя
  пользователя ровно одного включённого администратора панели, иначе отказ `admin_not_found`). Без него в журнале исполнитель `cli`; в обоих случаях
  `details.via = "cli"`. Так же подписаны записи заданий, которые CLI поставил (проверка
  соединения, исправление антиспам-политики). `--help` команды говорит, что она пишет в журнал.
- `--wait [--timeout <SEC>]` у команд, которые ставят задание: тенанта (`domain sync`,
  `internal-relay`, `approve-alias-removal`, `tenant test`, `tenant antispam`, `tenant poll`,
  `quarantine release`, `seats check`) и проверки узла (`domain dns-check` без домена,
  `alerts check`, `outage trace`) — дождаться, пока воркер backend выполнит задание (по умолчанию
  до 120 секунд, не больше 3600); задание закончилось неудачей или время вышло — код 3. `access sync`
  ждёт всегда (только `--timeout`). Сам CLI заданий не выполняет.
- Секреты — только stdin, никогда аргументом: `access token`, `sso add`, `sso set --secret`,
  `integration microsoft set --secret`, `node config set --api-key-stdin`,
  `system-email set --password-stdin`, `account create`,
  `account set-connection --password-stdin|--smtp-password-stdin`. Обёртка передаёт stdin в
  контейнер целиком.

Коды выхода: `0` — сделано; `1` — отказ (печатается код ошибки API, например
`domain_not_ready`), ответ «нет» на вопрос (`cancelled`) или `admin_not_found` у `--as`; `2` —
ошибка в командной строке или подтверждение, которое CLI не смог спросить; `3` — сбой почтового
узла, тенанта, задания или самой панели (отказ со статусом 5xx, `wait_timeout`,
`database_unavailable`, `internal_error`). Обёртка возвращает код CLI как есть; её собственные ошибки (параметры, запуск не от
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
sudo $cli access token < /root/access-sync-token.txt                     # токен — только stdin
sudo $cli access sync
sudo $cli node config set --api-key-stdin < /root/mailcow-api-key.txt     # ключ — только stdin
sudo $cli agent token issue --out <TOKEN_FILE> --yes                     # файл 0600 на хосте
```

## 5. Обновление

Порядок целиком (предпроверка, шаги вне панели, проверка после) — [README.md, раздел 9](README.md).

Проще всего — кнопкой: «Настройки → Администрирование → Обновление панели» (администратор,
обновляет до продвинутой `latest`; [README.md, раздел 9](README.md)). По SSH то же самое:

```bash
# предпроверка, ничего не меняет (= status.sh --target): образы, место, новые миграции, шаги после
sudo /opt/mailexpert/app/scripts/deploy/update.sh --check latest
sudo /opt/mailexpert/app/scripts/deploy/update.sh latest          # или sha-<12 символов коммита>
```

`latest` — сборка, которую владелец продвинул workflow `promote.yml`; скрипт превращает его в
`sha-<12>` этого коммита и запускает этот тег. `sha-<12>` — тег образов в GHCR, который публикует
джоба `images` CI после зелёной сборки на `main`; посмотреть его можно в логе прогона CI этой джобы
или коротким `git rev-parse` нужного коммита на `main`.

`update.sh` делает бэкап перед обновлением (`backups/pre-update-<старый sha>.dump`, последние 3
хранятся на месте), переключает версию через `install.sh --version` и проверяет готовность до
10 минут. Сам `update.sh` не откатывает: если новая версия не поднялась, он останавливается с
кодом 1, прежняя версия остаётся как есть. Откат — `rollback.sh` (ниже) или, при обновлении из
панели без новых миграций, автооткат исполнителя. Если между версиями изменился образ Caddy, он
обновляется вместе с панелью (скачивается до бэкапа, прежний digest — в
`state/edge-image.previous`).
Сбой до переключения (образ не скачался, бэкап не удался) — код 3, сервер не менялся; неверный
ввод или запрещающее состояние — код 2. После неудачи с кодом 1 скрипт пишет, были ли записаны
миграции: если нет, путь назад — `install.sh --version <old-sha>` без восстановления дампа. С
профилем `tenant` образ `mailexpert-tenant-worker` той же версии скачивается до бэкапа. После
обновления `update.sh` печатает строки `next:` (шаги вне панели: скрипты почтового узла, образ
Caddy) и `info:` (справка: что `install.sh` сделал сам и `info: migrations:` — были ли применены
миграции, по числу записей в `schema_migrations` до и после: если нет, путь назад —
`install.sh --version <old-sha>` без дампа; если обновление меняло образ Caddy, строка сначала
велит вернуть `EDGE_IMAGE` в `/opt/mailexpert/edge/.env` на прежнее значение — `install.sh
--version` его сам не возвращает, `rollback.sh` и автооткат возвращают). Изменённый файл в
`backend/migrations/` сам по себе новой миграцией не считается: `status.sh --target` пишет
`info: migrations:` только когда `pending_migrations` не пуст (называет эти версии), а если схему
прочитать не удалось — предупреждает, что миграции неизвестны. Запускать его лучше
отдельно от SSH-сессии, через `systemd-run` — [README.md, раздел 9](README.md).

### 5.1. Включить обновления на боевом сервере

Чтобы кнопка «Обновить» в панели и `update.sh latest` работали, нужно один раз: исполнитель на
хосте и продвинутая сборка. Бэкапы и служба почтового узла —
рекомендуемые части того же пути.

**1. Хост панели — делает `install.sh` сам.** Отдельной команды включения нет: всё ставит
`install.sh` с systemd (без `--no-system`), если в установленном коммите есть
`scripts/deploy/updater.sh`. На новой установке это происходит при первом успешном запуске, на
существующей — при любом следующем `install.sh` или `update.sh` (он вызывает `install.sh` новой
версии):

- каталоги спула при каждом запуске (с systemd и без): `<PREFIX>/state/update-spool/request/` —
  владелец uid процесса backend, `0700`; `<PREFIX>/state/update-spool/result/` — root, `0755`. Uid
  `install.sh` спрашивает у образа backend и пишет в `<PREFIX>/state/spool-uid`; не получилось —
  предупреждение «cannot ask ... for its uid» и прежнее значение или 1000. Путь спула для контейнера
  — `UPDATE_SPOOL_HOST_DIR` в `.env`, его тоже пишет `install.sh`;
- юниты `/etc/systemd/system/mailexpert-updater.path` (следит за `request/*.json`) и
  `mailexpert-updater.service` (oneshot от root, `updater.sh --prefix <PREFIX>`, до 4 часов);
  `.path` включается и перезапускается, `.service` запускается только по запросу;
- `result/updater.json` (`{"installed": true, "version": ..., "rolledBack": ...}`) — по нему
  карточка в панели знает, что исполнитель есть. В логе `install.sh` — строка
  `updater: mailexpert-updater.path watches <PREFIX>/state/update-spool/request`.

С `--no-system` юнитов нет и команды, которая поставила бы их отдельно, тоже нет: карточка пишет
«механизм обновления не установлен», обновление — только `update.sh` по SSH.

Сети: хосту панели нужен доступ к `github.com` (`git fetch` коммита и тега `latest`) и `ghcr.io`
(сверка digest и скачивание образов); контейнеру backend — к `api.github.com`: оттуда карточка узнаёт,
куда указывает `latest` и сколько коммитов до него. Без этого карточка не видит новую сборку.

**2. GitHub — ничего настраивать не нужно.** Ruleset на тег `latest` не создаётся: `wyrtensi/MailExpert`
— личный репозиторий, и GitHub не принимает в обход ruleset приложение GitHub Actions (ошибка 422
`Actor GitHub Actions integration must be part of the ruleset source or owner organization`), а ruleset
без этого обхода заблокировал бы `promote.yml`, который двигает тег токеном `GITHUB_TOKEN`. Решение
владельца: тег `latest` двигает только он, запуская `promote.yml` с `main` (сначала `dry_run`).
Канал защищают проверки хостов (`latest` вне `main` или старее текущей версии отклоняется, digest
образов сверяется) и то, что пушить теги и запускать workflow могут только люди с правом записи в
репозиторий. Если репозиторий перейдёт в организацию, ruleset с обходом для GitHub Actions станет
возможен.

**3. Продвинуть сборку в `latest`** (владелец; workflow запускается только с `main`):

```bash
gh workflow run promote.yml --repo wyrtensi/MailExpert -f sha=<sha или sha-<12>> -f dry_run=true   # только проверка образов
gh workflow run promote.yml --repo wyrtensi/MailExpert -f sha=<sha или sha-<12>>                   # пусто: голова main
gh api repos/wyrtensi/MailExpert/git/ref/tags/latest --jq '.object.sha[0:12]'                       # куда указывает latest
```

Коммит должен быть на `main`, а его образы `sha-<12>` (backend, frontend, edge, tenant-worker) — в
GHCR, то есть CI на `main` для него зелёный; иначе workflow останавливается, ничего не меняя.
Workflow ставит образам тег `latest` на тот же digest, проверяет его и последним двигает git-тег.

**4. Проверить исполнитель на хосте.** Его проверяют оба скрипта. `status.sh` показывает поле
`updater` (`{"state": "active|inactive|not_installed|no_system|no_systemd", "expected": true|false}`)
и предупреждение `warning: updater: ...`, если юнитов нет или `.path` не активен там, где они должны
быть (с systemd и `updater.sh` в checkout); установка с `--no-system` и хост без `systemctl` получают
строку `info:`, не ошибку. `healthcheck.sh` (таймер каждые 5 минут) считает проблемой установленный,
но не активный `mailexpert-updater.path`: кнопка в панели тогда молчит. Лечение —
`systemctl enable --now mailexpert-updater.path` или `install.sh --prefix <PREFIX>`. Остальное
смотрите сами:

```bash
sudo <PREFIX>/app/scripts/deploy/status.sh --json | jq .updater   # {"state":"active","expected":true}
systemctl is-active mailexpert-updater.path                    # active
cat <PREFIX>/state/update-spool/result/updater.json            # "installed":true, version = текущая
sudo <PREFIX>/app/scripts/deploy/update.sh --check latest      # та же предпроверка, что у кнопки
ls -t <PREFIX>/state/update-spool/result/ | head -3             # результаты последних запросов (<uuid>.json)
journalctl -u mailexpert-updater.service -n 50 -o cat           # что исполнитель делал
```

Лог каждого запроса — `<PREFIX>/state/updater/<uuid>.log` (только root). Если `.path` в состоянии
`failed` (предел запусков systemd) — `systemctl reset-failed mailexpert-updater.service
mailexpert-updater.path && systemctl start mailexpert-updater.path` или повторный `install.sh`.

**Что кнопка не ставит и почему.** Цель кнопки — только то, что владелец продвинул, и только вперёд:
даже скомпрометированный администратор или контейнер backend не может поставить непродвинутую
версию или откатить сервер. Исполнитель отказывает (сообщение — в карточке), если:

- сервер в режиме standby (после бэкапа переезда) или уже идёт обновление, откат или восстановление;
- не удался `git fetch` или скачивание тега `latest` (без свежего тега ничего не считается `latest`);
- панель уже работает на этой версии;
- версия — не та, на которую сейчас указывает `latest` (любая другая — `update.sh sha-<12>` по SSH);
- `latest` указывает на коммит вне `main`;
- версия не новее текущей (не потомок работающего коммита): откат — только `rollback.sh` по SSH;
- с этой версии уже откатывались (`<PREFIX>/state/rolled-back-version`): её снова предложат только
  после продвижения более новой сборки;
- образы `latest` в реестре не совпадают с образами `sha-<12>` (продвижение не доделано или тег
  сдвинут руками).

Затем `status.sh --target`: любая `problem:` — обновление не начинается (итог `blocked`).

**Откат после кнопки.** Автоматически — только если `update.sh` вышел с кодом 1 (новая версия не
поднялась), предпроверка прочитала схему и новых миграций не было, и число записанных миграций до и
после не изменилось: тогда исполнитель возвращает прежний образ Caddy (если обновление его меняло) и
запускает `install.sh --version <старая>`, ничего не теряется. Во всех остальных случаях — итог
«не удалось» без отката: откат через дамп теряет данные, записанные после обновления, решает человек
(`rollback.sh`, [README.md, раздел 10](README.md)).

**5. Бэкапы — рекомендуются.** `update.sh` (и кнопка) перед каждым обновлением делает дамп
`backups/pre-update-<старая>.dump` (хранятся 3 последних) — на него опирается `rollback.sh`. С ключами
restic (раздел 2) тот же бэкап уходит снимком `pre-update` во внешнее хранилище; без них
`update.sh` предупреждает «backups are not configured: only the local dump ... is made» и
продолжает: откат работает, но при потере сервера копии нет.

**6. Почтовый узел — служба узла.** Чтобы скрипты узла и mailcow обновлялись вслед за панелью (та же
кнопка, задание `update` на коммит панели), подключите службу узла
([mail-node.md, раздел 7а](mail-node.md)):

```bash
# на хосте панели: токен — в новый файл 0600 (файл не должен существовать)
sudo /opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh agent token issue --out /root/mailexpert-agent-token --yes
# перенести файл на узел (scp), на панели удалить: shred -u /root/mailexpert-agent-token
# на узле, в клоне /opt/mailexpert-node-src:
sudo scripts/deploy/mail-node/setup.sh --panel-url https://<APP_HOST> --agent-token-file /root/mailexpert-agent-token
sudo shred -u /root/mailexpert-agent-token
systemctl is-active mailexpert-node-agent
```

Панель за Cloudflare Access — в тот же файл ещё service token Access (там же, в разделе 7а). Условия,
без которых задание `update` откажет, не тронув узел: бэкап узла настроен (ключи restic в
`/etc/mailexpert-node/node.env`, иначе `backup_not_configured`), `origin` клона узла — официальный
репозиторий (`untrusted_origin`), в клоне нет изменённых отслеживаемых файлов (`local_changes`), коммит
панели на `main` и не старее скриптов узла. Служба версии без задания `update` в первый раз
обновляется вручную (раздел 7а, «Первый раз — вручную»).

mailcow служба двигает только до версии из `deploy/mailcow-version` выпуска и только пока голова
`master` официального mailcow — именно этот коммит: штатный `update.sh` mailcow умеет доводить лишь до
головы `master`. Вышел более новый mailcow — шаг пропускается, mailcow остаётся на своей версии до
выпуска MailExpert, который подтвердит новую; назад mailcow не откатывается.

### Откат обновления

Одной командой — `rollback.sh` (те же шаги, что ниже, плюс возврат образа Caddy, если обновление
его меняло):

```bash
sudo /opt/mailexpert/app/scripts/deploy/rollback.sh --to <old-sha>          # спросит версию ещё раз
sudo systemd-run --unit=mailexpert-rollback --property=RemainAfterExit=yes \
  /opt/mailexpert/app/scripts/deploy/rollback.sh --to <old-sha> --confirm <old-sha>   # отдельно от SSH
```

Он сначала проверяет дамп, коммит, место (размер базы плюс дамп на диске Docker) и скачивает образы
старой версии (сбой образа — код 3, остальное — код 2; ничего не изменено), потом останавливает
backend и frontend. Если дамп не восстановился или базы не удалось подменить (перед подменой
новые подключения к базе запрещены, подмена повторяется до 5 раз), текущая база не тронута, панель
запускается снова (код 1). Прерванный после подмены запуск можно повторить: он только переключит
код. Если `install.conf` уже говорит о старой версии, закончить `install.sh --prefix`. После отката
кнопка в панели не предлагает версию, с которой ушли, пока не продвинута более новая; откат на
версию без исполнителя обновлений отключает его юниты. Вручную — те же шаги (кроме запрета
подключений и повторов):

Точные команды (замените `<old-sha>` на версию, к которой возвращаетесь, и `mailexpert` — на
своё имя проекта/БД, если меняли `--project`/`DB_NAME` при установке):

1. Остановить backend и frontend, оставив базу работающей:

   ```bash
   cd /opt/mailexpert
   APP="docker compose -p mailexpert --project-directory app --env-file .env -f app/docker-compose.yml -f app/deploy/compose.prod.yml"
   $APP stop backend frontend
   ```

   Если на сервере есть `compose.local.yml` (раздел 4), допишите в `APP` в конце
   `-f compose.local.yml`.

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

   Если на A работает исполнитель тенанта (`COMPOSE_PROFILES=tenant`), его настройки
   (`COMPOSE_PROFILES` и ключи `TENANT_*`) `restore.sh` тоже возьмёт из бэкапа (если на B уже задан
   свой `COMPOSE_PROFILES`, к нему добавится `tenant`), и вместе с ними сертификат `app.pfx` и файл его
   пароля: `restore.sh` положит их по путям из `TENANT_CERT_DIR` и `TENANT_PFX_PASSWORD_FILE` (каталоги
   создаст), с владельцем 10001 и режимом 0400, как в [mail-node.md, раздел 6е](mail-node.md). Файлы,
   которые на B уже лежат по этим путям, остаются как есть и снимком **не заменяются** — в том числе
   оставшиеся от репетиции (шаг 2 говорит, как их убрать). Готовить на B ничего не нужно.

   Исключение — снимок без этих файлов: сделанный версией панели, которая файлов тенанта ещё не
   бэкапила, или в момент, когда их на A не было (обычный бэкап тогда только предупреждает, а бэкап
   переезда, шаг 4, отказывает). Тогда `app.pfx` и пароль нужно заранее положить на B по тем же путям,
   что в `.env` на A, с теми же владельцем и режимом. Без них `restore.sh` назовёт недостающие пути и
   остановится с кодом 2, ничего не изменив.

   Локальные дополнения compose (`compose.local.yml`, раздел 4) тоже приходят с бэкапом:
   `restore.sh` положит файл в `<PREFIX>` на B, если там своего нет, и восстановит базу уже с ним.
   Копировать его вручную не нужно. Файл, оставшийся на B от репетиции, снимком не заменяется:
   если на A его меняли после репетиции, удалите его на B перед шагом 5.
2. **Репетиция:**

   ```bash
   # latest — самый новый снимок панели (хосты restic mailexpert-<hex>; снимки почтового узла,
   # mailexpert-node-<hex>, restore.sh не выбирает, даже если их положили в тот же репозиторий)
   sudo /opt/mailexpert/app/scripts/deploy/restore.sh latest --no-start
   curl --resolve <DIRECT_HOST>:443:<IP сервера B> https://<DIRECT_HOST>/api/health
   docker compose -p mailexpert down -v   # убрать репетиционные данные с B
   # с исполнителем тенанта: убрать и разложенные репетицией app.pfx и пароль; пути — значения
   # TENANT_CERT_DIR и TENANT_PFX_PASSWORD_FILE в /opt/mailexpert/.env на B
   sudo shred -u <TENANT_CERT_DIR>/app.pfx <TENANT_PFX_PASSWORD_FILE>
   ```

   `down -v` удаляет только тома, файлы тенанта на диске остаются. Если их не убрать, настоящее
   восстановление (шаг 5) оставит репетиционные копии на месте, и после обновления сертификата на A
   между репетицией и переездом исполнитель на B стартует со старым сертификатом.

   Время восстановления из репетиции (`restore_seconds` в выводе) — оценка простоя.
3. **В день переезда, на A:** остановить приложение и туннель —
   `docker compose -p mailexpert stop backend frontend`, для режима `cf`/`both` — также
   `cloudflared` в проекте `edge`.
4. **Финальный бэкап на A:**

   ```bash
   sudo /opt/mailexpert/app/scripts/deploy/backup.sh --with-redis --tag move
   ```

   После него A автоматически становится standby: ночной бэкап и проверка здоровья на нём
   пропускаются. Если на A включён профиль `tenant`, а `app.pfx` или файла пароля нет, бэкап
   переезда завершается ошибкой (пинг `fail`, путь и ключ в выводе) и A standby не становится:
   верните файлы или выключите профиль и повторите шаг 4.
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
панели менять нечего. `backup.sh` панели узел не бэкапит: у узла свой ночной бэкап
(`node-backup.sh`, таймер `mailexpert-node-backup.timer`, ставится `setup.sh` узла) и свой скрипт
восстановления на новый сервер (`node-restore.sh`), которым пользуется и переезд узла
([mail-node.md, разделы 7 и 8](mail-node.md)). Его состояние в панели не показывается: о сбое или
пропуске сообщает его проверка Healthchecks.

## 8. Проверка перед продом

Перед первым боевым переездом владелец проводит **репетицию переезда на втором дешёвом VPS** по
разделу 6 целиком, с замером фактического простоя. Этот шаг выполняется вручную и не
автоматизирован скриптами.
