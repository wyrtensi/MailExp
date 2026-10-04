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

| Документ | О чём |
|---|---|
| [deployment.md](deployment.md) | установка панели, режимы входа, CLI, обновление, откат, переезд панели |
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
| **B. Только панель** | один сервер (минимум 2 vCPU / 4 ГБ / 20 ГБ свободно) | только Gmail и внешние IMAP-ящики |
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

Узел — [mail-node.md, раздел 2](mail-node.md): провайдер с открытым портом 25 и своим PTR,
статический IPv4, NVMe.

Тенант Microsoft (если нужен EOP) — [mail-node.md, раздел 6е](mail-node.md): приложение в Entra,
сертификат.

Секреты в командную строку, в cloud-init, в чат и в issues не попадают: только `configure.sh`
(stdin) на панели и файлы `0600` на узле.

## 3. Установить панель

[deployment.md, разделы 2-3](deployment.md): `git clone`, `install.sh --version sha-<12> --signin ...`,
секреты через `configure.sh`, повторный `install.sh`. Сохранить ключ восстановления restic.

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
`setup.sh --eop-host <EOP_HOST>` на узле.

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

Версия — коммит `main` с зелёным CI (джоба `images` опубликовала образы `sha-<12>`). Узнать последнюю:

```bash
gh run list --repo wyrtensi/MailExpert --workflow ci.yml --branch main --status success --limit 1 \
  --json headSha --jq '.[0].headSha[0:12]'
```

1. **Предпроверка** (ничего не меняет, кроме `git fetch` нужного коммита):

   ```bash
   sudo $D/update.sh --check sha-<12>      # = status.sh --target sha-<12>
   ```

   **Первое обновление с версии без `status.sh`** (`update.sh` отвечает «unknown argument:
   --check»): запустить предпроверку из свежей копии репозитория — скрипт работает с уже
   установленной панелью любой версии, — а само обновление как обычно:

   ```bash
   git clone --depth 1 https://github.com/wyrtensi/MailExpert.git /root/mailexpert-next
   sudo /root/mailexpert-next/scripts/deploy/status.sh --prefix <PREFIX> --target sha-<12>
   ```

   После обновления `status.sh` есть в `<PREFIX>/app`, копию можно удалить.

   Код 0 — можно обновлять. `problem:` — устранить до обновления (не та версия в checkout, нет
   образа в реестре, мало места, база новее целевой версии, идёт другое обновление). `note:` — шаги
   после `update.sh`. Строка `pending_migrations` — есть ли новые миграции: от неё зависит откат.
2. **Обновление**:

   ```bash
   sudo $D/update.sh sha-<12>
   ```

   Бэкап перед обновлением, переключение, ожидание готовности до 10 минут. tenant-worker (если
   включён) обновляется вместе с панелью. В конце `update.sh` печатает строки `next:` — что сделать
   вне панели.
3. **Шаги по строкам `next:`**:
   - `mail node: ...` — на узле тот же коммит (раздел 4 выше), `setup.sh --dry-run`, затем `setup.sh`;
   - `edge: the Caddy image changed ...` — в `<PREFIX>/edge/.env` оставить `EDGE_IMAGE=` пустым и
     запустить `sudo $D/install.sh --prefix <PREFIX>`: он закрепит образ края текущей версии.
     Прежний digest записать заранее (`status.sh`, строка `edge_image`) — он нужен для отката;
   - `migrations: ...` — откат теперь только через дамп (раздел 10).
4. **Предупреждения панели**: правило раскладки спама на узле (`status.sh`: `spam_rule outdated`),
   «Применить настройки» узла, антиспам-политика тенанта.
5. **Проверка**: `sudo $D/status.sh` без проблем, `sudo $D/healthcheck.sh` код 0, вход, статус ящиков.

**mailcow** обновляется отдельно и не в одном окне с панелью: `./update.sh` mailcow, затем `setup.sh`
без параметров ([mail-node.md, разделы 3-4](mail-node.md)).

Раскатка агентом (Claude Code и т. п.) идёт по тем же шагам — скилл
[`mailexpert-rollout`](../../.claude/skills/mailexpert-rollout/SKILL.md).

## 10. Откат

- **Не было новых миграций** (`pending_migrations none` в предпроверке):
  `sudo $D/install.sh --prefix <PREFIX> --version sha-<старая>`. Данные не теряются.
- **Были новые миграции**: [deployment.md, «Откат обновления»](deployment.md) — восстановление
  `backups/pre-update-<старая>.dump` в отдельную базу, подмена переименованием, `install.sh --version`.
  Теряется всё, записанное после обновления.
- **Образ края**: вернуть прежний digest в `EDGE_IMAGE` и `install.sh --prefix <PREFIX>`.
- **Скрипты узла**: прежний коммит в `/opt/mailexpert-node-src`, `setup.sh`.

## 11. Переезд

- Панель — [deployment.md, раздел 6](deployment.md): репетиция, финальный бэкап `--with-redis`,
  `restore.sh`, переключение DNS или туннеля.
- Узел — [mail-node.md, раздел 8](mail-node.md): `node-restore.sh`, репетиция, окно не дольше очереди
  EOP.
- Смена IP панели: на узле `setup.sh --panel-ip <новый>`, в панели — адреса для fail2ban и «Allow API
  access from» в mailcow.

## 12. Неполадки

Коды выхода скриптов панели: `0` — сделано; `1` — сбой (или найдены проблемы: `status.sh`,
`healthcheck.sh`); `2` — неверный ввод или состояние, ничего не изменено; `3` — `install.sh` ждёт
секреты от `configure.sh` (у `mailexpert-cli.sh` — сбой docker или CLI). Скрипты узла: `0`, `1` —
шаг не удался, `2` — неверный ввод.

| Признак | Где смотреть | Что делать |
|---|---|---|
| `install.sh` вышел с кодом 3 | его вывод: список ключей | `configure.sh` с этими ключами, повторить `install.sh` |
| `update.sh`: «did not become ready» | `docker compose -p <project> logs backend` | миграция или старт backend; откат — раздел 10 |
| `status.sh`: «checkout ... install.conf says» | прерванная установка или обновление | `install.sh --prefix <PREFIX>` доведёт до версии из `install.conf` |
| `status.sh`: «older than the database schema» | обновление на версию старее базы | только откат через дамп |
| `status.sh`: «not in the registry» | CI коммита: джоба `images` | выбрать коммит с зелёным CI |
| `status.sh` / `healthcheck.sh`: «backup: ... hours old» | `journalctl -u mailexpert-backup` | бэкап вручную `backup.sh --tag manual`, проверить ключи restic |
| `containers: tenant-worker ...` | `docker compose -p <project> logs tenant-worker` | нет PFX или файла пароля; [mail-node.md, раздел 6е](mail-node.md) |
| `https://<DIRECT_HOST>` не отвечает | `docker compose -p edge logs caddy` | токен DNS, A-запись, `ufw` |
| `<CF_HOST>` — ошибка туннеля | `docker compose -p edge logs cloudflared` | `TUNNEL_TOKEN`, public hostname в Zero Trust |
| ящики узла красные после обновления узла | «Почтовый узел» в панели, `docker compose logs dovecot-mailcow` на узле | Dovecot перезапускался — подождать переподключения; правила файрвола: `setup.sh --dry-run` |
| пинг EOP-диапазонов `/fail` | тело пинга в Healthchecks | [mail-node.md, раздел 4](mail-node.md) |

Логи: `docker compose -p <project> logs backend` (или `frontend`, `postgres`, `redis`,
`tenant-worker`), `journalctl -u mailexpert-backup`, `journalctl -u mailexpert-health`; на узле —
`journalctl -u mailexpert-eop-ranges`, `journalctl -u mailexpert-node-backup`.
