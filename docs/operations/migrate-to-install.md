# Переход с собственного docker compose на боевую установку

Для сервера, где MailExpert поднят собственным `docker compose` (образы GHCR по тегу `sha-<12>`,
версия задаётся параметром сервиса, `AUTH_MODE=local`, без почтового узла, без исполнителя тенанта и
без исполнителя обновлений — карточка «Обновление панели» пишет «механизм обновления не установлен»).
Цель — заменить его штатной установкой `install.sh`, которая ведёт себя как прод: кнопка обновления,
`update.sh` и `rollback.sh`, дамп перед каждым обновлением, таймеры проверки здоровья и бэкапа,
обязательные бэкапы restic и переезд на другой сервер из бэкапа.

Порядок: решить, что делать со старыми данными (раздел 2), снять дамп старого развёртывания, поставить
панель, внести секреты, проверить, при необходимости перенести данные, включить бэкапы и проверить их,
и только потом убрать старое развёртывание.

Плейсхолдеры: `<PANEL_HOST>` — сервер новой установки (SSH), `<OLD_HOST>` — сервер старого
compose-развёртывания (может совпадать с `<PANEL_HOST>`), `<APP_HOST>` — публичный адрес панели
(`<CF_HOST>` и/или `<DIRECT_HOST>`), `<ADMIN_EMAIL>` — адрес Google первого администратора,
`<PREFIX>` — каталог установки (по умолчанию `/opt/mailexpert`), `<OLD_PROJECT>` — имя compose-проекта
старого развёртывания, `<OLD_BACKEND>` и `<OLD_POSTGRES>` — имена его контейнеров backend и postgres.
Все команды — от root. Короче: `D=<PREFIX>/app/scripts/deploy`.

Обычная первая установка на чистый сервер — [quickstart.md](quickstart.md); здесь только то, чем
переход от неё отличается, и полный путь целиком.

## 1. Требования

| Что | Подробности |
|---|---|
| ОС и ресурсы | Ubuntu 24.04, минимум 2 vCPU / 4 ГБ RAM / 20 ГБ свободного диска: `install.sh` проверяет это сам и первую установку с нехваткой останавливает |
| systemd | обязателен: установка **без** `--no-system`. Только с systemd `install.sh` ставит таймеры `mailexpert-backup.timer`, `mailexpert-health.timer` и исполнитель обновлений `mailexpert-updater.path` / `.service`. С `--no-system` юнитов нет и отдельной команды, которая поставила бы их потом, тоже нет — кнопка обновления снова будет писать «механизм обновления не установлен» |
| Порты | в режиме `direct` снаружи нужны 80 и 443 (TCP, и необязательный UDP 443), они должны быть свободны: `install.sh` останавливается, если их держит что-то кроме Caddy края. `install.sh` включает `ufw`: открыты только порты SSH и, для Caddy, 80/443. В режиме `cf` входящие порты не нужны. Панель слушает `127.0.0.1:8080` ([ports.md](ports.md)) |
| Исходящие соединения хоста | `github.com` (`git fetch` коммита и тега `latest`) и `ghcr.io` (образы и сверка digest) |
| Исходящие соединения контейнера backend | `api.github.com`: оттуда карточка обновления узнаёт, куда указывает `latest`. Без него карточка не видит новую сборку |
| Реестр | образы `mailexpert-backend`, `-frontend`, `-edge`, `-tenant-worker` в GHCR публичные: `docker login` не нужен |
| Хранилище бэкапов | S3-совместимый бакет **у другого провайдера, чем сервер** (раздел 6) — здесь обязательно |
| Мониторинг | проверка в Healthchecks.io или совместимом сервисе (`HEALTHCHECK_PING_URL`), лучше отдельная для бэкапов (`BACKUP_PING_URL`) |

Cloudflare (запись DNS, токен DNS-01, для `cf`/`both` — туннель и приложение Access) настраивается
**до** `install.sh` по [cloudflare.md](cloudflare.md).

**Новый сервер или тот же.** Надёжнее новый сервер: старое развёртывание продолжает работать, пока
новое не проверено, а откат — просто не переключать DNS. На том же сервере `install.sh` упрётся в то,
что занимает старое развёртывание:

- порты 80/443 — `install.sh` остановится («ports for the edge are taken»);
- имена контейнеров — штатный `docker-compose.yml` называет их `<проект>-backend`, `<проект>-postgres`
  и т. д. по имени compose-проекта (по умолчанию `mailexpert`);
- том `<проект>_postgres_data` — если он уже есть, а в новом `<PREFIX>/.env` нет `DB_PASSWORD` и
  `ENCRYPTION_KEY`, `install.sh` останавливается («volume ... exists but ... has no ...»), чтобы не
  запереть данные новыми ключами.

Посмотрите, что есть: `docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}'` и
`docker volume ls`. Дальше — либо остановить старое развёртывание (`docker compose -p <OLD_PROJECT>
stop`, тома не удалять) до запуска новой панели, либо дать новой установке имена, которые не
пересекаются со старыми (`--project <имя>`, `--edge-project <имя>`; тогда и во всех командах
`docker compose -p` ниже — это имя). Порты 80/443 так или иначе освобождает только остановка старого
края.

## 2. Что делать со старыми данными

Сначала — дамп, что бы вы ни решили (раздел 4, шаг 2): он ничего не меняет и даёт путь назад.

- **Ценных данных нет** (тестовые ящики, пробные правила) — ставьте начисто: разделы 3, 5, 6, 7, без
  раздела 8. Дамп всё равно сохраните вне сервера, пока новая установка не проверена.
- **Данные нужны** (пользователи, подключённые ящики, правила, журнал) — разделы 3-8 по порядку.
  Ключевое условие: в новую установку должен попасть **тот же `ENCRYPTION_KEY`**, что у старого
  развёртывания, и попасть **до первого запуска `install.sh`** (раздел 4, шаг 3).

`restore.sh` здесь не помогает: он принимает только снимок restic, сделанный `backup.sh` штатной
установки, и только на сервере без базы. Обычный дамп `pg_dump` загружается вручную (раздел 8).

## 3. Режим входа

Боевые режимы ([deployment.md, раздел 3](deployment.md)):

| Режим | Что | Секреты владельца (`install.sh` их ждёт) |
|---|---|---|
| `direct` | Caddy на `<DIRECT_HOST>`, сертификат через DNS-01 Cloudflare, «Войти через Google» | `DNS_API_TOKEN`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` |
| `cf` | туннель `cloudflared` к `<CF_HOST>` и Cloudflare Access | `TUNNEL_TOKEN`, `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE` |
| `both` | оба адреса, `<CF_HOST>` — основной | всё перечисленное |

Во всех трёх `AUTH_MODE=google`, а `--admin-email` обязателен: эти адреса становятся
администраторами при первом входе (и снова получают права администратора при каждом входе).

**`--local-auth`** — то, на чём работало старое развёртывание (`AUTH_MODE=local`: первый
зарегистрированный пользователь становится администратором, после этого открытая регистрация
закрывается, дальше — по приглашениям). Флаг у `install.sh` есть, но документация и скилл
`mailexpert-rollout` относят его только к тестовым стендам; для прода он не предназначен.

**Что значит переход с локальных учётных записей на `AUTH_MODE=google`** (по коду
`backend/src/middleware/identityGate.js` и `services/auth/userIdentity.js`):

- Вход по паролю перестаёт существовать: `/api/auth/login`, регистрация, 2FA, сброс пароля,
  приглашения и SSO-провайдеры (OIDC) отвечают 404. Пароли старых пользователей остаются в базе, но
  не используются.
- Пользователь находится по адресу почты: строка с этим `email`, а если такой нет — самая старая строка,
  у которой **имя пользователя равно этому адресу**, а `email` пуст (она «забирается» и получает
  этот адрес). Всё, что принадлежало этой строке (ящики, правила, настройки), остаётся у человека.
- `direct`: войти может только одобренный адрес или адрес из `--admin-email`; остальные получают отказ
  `not_allowed`, пока администратор не одобрит их (`mailexpert-cli.sh user create <EMAIL>` или экран
  «Пользователи»).
- `cf`: тот, кого пропустила политика Access, получает учётную запись при первом входе, если
  синхронизация пользователей с Access не включена ([cloudflare.md, раздел 8](cloudflare.md)).
- Если старое имя пользователя — **не** адрес Google этого человека, при первом входе появится новая
  пустая учётная запись, а старая со всеми ящиками останется отдельно. Поэтому **до первого входа**
  привяжите адреса к старым учётным записям (раздел 8, шаг 6):
  `mailexpert-cli.sh user set <OLD_USERNAME> --email <EMAIL>`. Один адрес двум учётным записям не
  достаётся: после того как кто-то уже вошёл и получил новую запись, привязка того же адреса к старой
  будет отклонена.

**Без публичного домена.** `--edge-tls internal` существует (Caddy со своим корневым сертификатом,
`DNS_API_TOKEN` не нужен), но предназначен для тестовых стендов: браузеры ему не доверяют, а Google
для «Войти через Google» и для Gmail-приложений требует настоящий адрес. Для прода — `acme` (по
умолчанию).

## 4. Подготовка

1. **Версия старого развёртывания.** Запишите его `sha-<12>` (`curl -fsS
   http://127.0.0.1:<порт старого frontend>/api/version` или параметр версии в его compose). Новая
   установка должна быть на этом коммите или новее: миграции идут только вперёд, а база новее кода
   не запустится. Проверка — в разделе 5, шаг 1.
2. **Дамп старой базы — первым делом.** На `<OLD_HOST>`: мажорная версия PostgreSQL старого контейнера
   должна быть не новее 16 (новая установка — `postgres:16-alpine`, `pg_restore` 16 не читает дамп
   более новой мажорной версии):

   ```bash
   docker exec <OLD_POSTGRES> postgres --version                    # PostgreSQL 16.x
   # если данные переносятся — сначала ключи (шаг 3, пока backend работает), затем:
   docker stop <OLD_BACKEND>                                         # заморозить запись; frontend тоже можно
   install -m 600 /dev/null /root/old-panel.dump
   docker exec <OLD_POSTGRES> sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > /root/old-panel.dump
   docker exec -i <OLD_POSTGRES> pg_restore --list < /root/old-panel.dump | head -5   # читается
   ```

   Если в старом контейнере нет `POSTGRES_USER`/`POSTGRES_DB`, впишите имя пользователя и базы явно
   (`-U <OLD_DB_USER> -d <OLD_DB_NAME>`). Копию дампа унесите с сервера. Пока backend остановлен,
   старое развёртывание не синхронизирует ящики; после этого **не запускайте его снова**, если данные
   будут загружены в новую установку: две панели на одной базе ящиков синхронизировали бы их дважды.
   Если данные не переносятся, backend можно не останавливать.
3. **Ключи старого развёртывания (только если данные переносятся).** Пока `<OLD_BACKEND>` работает, его
   ключи пишутся сразу в файл `0600` — не на экран и не в чат:

   ```bash
   install -m 600 /dev/null /root/old-panel-keys.env
   docker exec <OLD_BACKEND> sh -c 'printf "ENCRYPTION_KEY=%s\nVAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n" "$ENCRYPTION_KEY" "$VAPID_PUBLIC_KEY" "$VAPID_PRIVATE_KEY"' > /root/old-panel-keys.env
   awk -F= '$2 == "" {print "empty: " $1}' /root/old-panel-keys.env   # пустые строки удалить из файла
   ```

   - `ENCRYPTION_KEY` (64 hex-символа) шифрует всё, что панель хранит секретом: пароли ящиков IMAP/SMTP,
     токены OAuth Gmail и Microsoft, секреты Google-приложений, TOTP, ключи интеграций, секреты SSO.
     Без старого значения эти данные в новой установке не расшифровать, ящики придётся подключать
     заново.
   - `VAPID_PUBLIC_KEY` и `VAPID_PRIVATE_KEY` — только чтобы сохранить подписки на push-уведомления;
     нужна пара целиком или ничего. Пустые строки уберите: `configure.sh` отклоняет пустое значение.
   - `DB_PASSWORD` и `SESSION_SECRET` переносить не нужно: база новая, сессии всё равно не переносятся.

   Файл переносится на `<PANEL_HOST>` так же, как дамп (`scp`), и на старом сервере удаляется
   (`shred -u`).

## 5. Установка

1. **Код боевой версии** на `<PANEL_HOST>`:

   ```bash
   apt-get update && apt-get install -y git
   git clone --branch latest https://github.com/wyrtensi/MailExpert.git <PREFIX>/app
   cd <PREFIX>/app
   git merge-base --is-ancestor HEAD origin/main && echo "on main"          # on main
   V=sha-$(git rev-parse HEAD | cut -c1-12); echo "$V"
   git merge-base --is-ancestor <12 символов коммита старого развёртывания> HEAD && echo "not older"
   ```

   Нет `not older` — старое развёртывание новее продвинутой `latest`: ставьте его же коммит
   (`git checkout --detach <12 символов>`, `V=sha-<12 символов>`; коммит должен быть на `main`). Кнопка
   тогда предложит обновление, когда владелец продвинет более новую `latest`.

2. **Секреты — одним файлом `0600`, до первого `install.sh`.** Обычно `install.sh` сначала
   останавливается с кодом 3 и списком недостающих ключей, а секреты вносятся после. Здесь удобнее
   сразу: тогда первый же запуск дойдёт до конца, а `ENCRYPTION_KEY` старого развёртывания
   **обязан** попасть в `.env` раньше, чем `install.sh` сгенерирует свой (генерация идёт до проверки
   секретов владельца; ключ после этого записан навсегда и `configure.sh` его не заменит).

   ```bash
   install -m 600 /dev/null /root/mailexpert-secrets.env
   nano /root/mailexpert-secrets.env
   ```

   Строки `KEY=VALUE` (полный список — `$D/configure.sh --help`):

   ```bash
   # режим входа (раздел 3): только ключи своего режима
   DNS_API_TOKEN=<...>
   AUTH_GOOGLE_CLIENT_ID=<...>
   AUTH_GOOGLE_CLIENT_SECRET=<...>
   # бэкапы (раздел 6) — обязательно
   RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/mailexpert
   AWS_ACCESS_KEY_ID=<...>
   AWS_SECRET_ACCESS_KEY=<...>
   RESTIC_PASSWORD=<не короче 16 символов>
   HEALTHCHECK_PING_URL=https://hc-ping.com/<uuid>
   BACKUP_PING_URL=https://hc-ping.com/<uuid>
   ```

   Если данные переносятся — допишите в конец строки из `/root/old-panel-keys.env`
   (`cat /root/old-panel-keys.env >> /root/mailexpert-secrets.env`). Затем:

   ```bash
   <PREFIX>/app/scripts/deploy/configure.sh --prefix <PREFIX> < /root/mailexpert-secrets.env
   shred -u /root/mailexpert-secrets.env /root/old-panel-keys.env 2>/dev/null
   ```

   `configure.sh` ничего не печатает из значений; код 2 — список проблем, ничего не записано. Если вы
   переносите данные, а `install.sh` уже успел запуститься и сгенерировал свой ключ, `configure.sh`
   откажет («already has a different value»): см. раздел 8, «Если ключ не тот».

3. **`install.sh` — отдельно от SSH-сессии.** Флаги — ваш режим (здесь `direct`); с переносом данных
   добавьте `--no-start` (панель не запускается, пока база не загружена):

   ```bash
   systemctl reset-failed mailexpert-install 2>/dev/null; systemctl stop mailexpert-install 2>/dev/null
   systemd-run --unit=mailexpert-install --property=RemainAfterExit=yes \
     <PREFIX>/app/scripts/deploy/install.sh --version "$V" \
     --signin direct --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL>
   journalctl -u mailexpert-install -f -o cat                    # Ctrl-C закрывает только просмотр
   systemctl show mailexpert-install -p SubState -p ExecMainStatus
   ```

   `ExecMainStatus=0` и последняя строка `done` — готово. Код 3 и `waiting for secrets: <KEYS>` —
   какого-то ключа не хватило: допишите его через `configure.sh` и повторите тот же блок (`install.sh`
   идемпотентен). Код 1 — шаг, на котором остановился, назван в логе; код 2 — неверные флаги.
   `--prefix` нужен, только если `<PREFIX>` не `/opt/mailexpert`. Флаги запоминаются в
   `<PREFIX>/install.conf`: повторный запуск без флагов повторяет последнюю установку.

Что `install.sh` делает (по порядку): пакеты, Docker Engine с Compose, swap, автообновления
безопасности; `<PREFIX>/install.conf`; checkout коммита; образы; каталоги спула обновлений
`<PREFIX>/state/update-spool/{request,result}` (uid процесса backend он спрашивает у образа и пишет в
`<PREFIX>/state/spool-uid`); генерирует недостающие `SESSION_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`,
пару VAPID; файлы края; затем запускает панель и край (без `--no-start`), включает `ufw`, ждёт
готовности и сверяет `/api/version` с `--version`, проверяет `https://<DIRECT_HOST>` через Caddy
(для `cf` — что `<CF_HOST>` закрыт Access); открывает или создаёт репозиторий restic; ставит таймеры
`mailexpert-backup.timer` (03:30) и `mailexpert-health.timer` (каждые 5 минут) и исполнитель
обновлений: `mailexpert-updater.path` (включён и следит за `request/*.json`) и
`mailexpert-updater.service` (oneshot от root, запускается по запросу), пишет
`result/updater.json` с `"installed": true`. С `--no-start` сервер помечен standby: таймеры его
пропускают, пока `install.sh` без `--no-start` не запустит панель.

**Ключ восстановления бэкапов.** Запущенный через `systemd-run` `install.sh` не имеет терминала и ключ
не печатает (в логе — строка, как его показать). Выполните сами, в своей SSH-сессии, и сохраните
`RESTIC_REPOSITORY` и `RESTIC_PASSWORD` в менеджере паролей, вне сервера:

```bash
$D/backup.sh --show-recovery-key
```

## 6. Бэкапы — обязательно

Без бэкапов этот сервер не переносится (раздел 10), а при его потере данные пропадут: `update.sh`
тогда делает только локальный дамп на том же диске.

- Ключи restic и пинги — в файле секретов шага 5.2. Добавить позже можно тем же `configure.sh` и
  повторным `install.sh --prefix <PREFIX>`. `RESTIC_PASSWORD` записывается один раз и `configure.sh`
  его не заменяет.
- Бакет — у **другого провайдера**, чем сервер. Репозиторий зашифрован `RESTIC_PASSWORD`: с ним и
  ключами S3 читаются все секреты панели (`.env`, сертификат тенанта), поэтому храните ключ
  восстановления как самый ценный секрет.
- `BACKUP_PING_URL` — отдельная проверка для ночного бэкапа (иначе бэкап пингует
  `HEALTHCHECK_PING_URL`).

**Первый бэкап — сразу, с проверкой восстановлением** (после запуска панели; на standby-сервере бэкап
пропускается):

```bash
$D/backup.sh --tag manual --verify; echo "exit $?"     # 0: снимок сделан, восстановлен во временную базу, ключи расшифрованы
$D/status.sh --json | jq .backup                       # configured: true, last_finished_at — только что
$D/healthcheck.sh; echo "exit $?"                      # 0
journalctl -u mailexpert-backup -n 20 -o cat           # ночные прогоны, со следующей ночи
```

Ночной бэкап — 03:30 (по воскресеньям с `--verify`, в остальные дни `restic check` 5% данных).
`healthcheck.sh` считает проблемой бэкап старше допустимого возраста; до первого бэкапа отсчёт идёт с
момента, когда бэкапы были настроены. Что входит в снимок — [deployment.md, раздел 4](deployment.md).

## 7. Проверки после установки

```bash
$D/status.sh                                      # в конце: no problems
$D/status.sh --json | jq '{version, running, ready, standby, updater}'
# updater: {"state":"active","expected":true}
systemctl is-active mailexpert-updater.path       # active
cat <PREFIX>/state/update-spool/result/updater.json   # "installed":true, version — текущая
systemctl list-timers 'mailexpert-*'              # mailexpert-backup.timer, mailexpert-health.timer
$D/healthcheck.sh; echo "exit $?"                 # 0
curl -fsS http://127.0.0.1:8080/api/version       # sha совпадает с $V
$D/update.sh --check latest; echo "exit $?"       # предпроверка кнопки: 0; сразу после установки — info: already at
```

`status.sh` ставит `warning: updater: ...`, если юнитов нет или `.path` не активен, а
`healthcheck.sh` считает проблемой установленный, но не активный `.path`. Лечение —
`systemctl enable --now mailexpert-updater.path` или `install.sh --prefix <PREFIX>`.

Затем — вход на `https://<APP_HOST>` под `<ADMIN_EMAIL>` (при переносе данных — сначала раздел 8,
шаг 6) и «Настройки → Администрирование → Обновление панели»: карточка показывает текущую версию,
`latest` и предпроверку, а не «механизм обновления не установлен».

## 8. Перенос данных из старого развёртывания (необязательно)

Предусловия: дамп и ключи сняты (раздел 4), `configure.sh` с `ENCRYPTION_KEY` выполнен **до**
первого `install.sh`, `install.sh` выполнен с `--no-start` и закончился `done`. Это те же шаги, что
делает `restore.sh` с базой из снимка (`restore_database` в `scripts/deploy/restore.sh`), только
вручную.

1. Дамп — на `<PANEL_HOST>`, например `/root/old-panel.dump` (`0600`).
2. Команда compose проекта панели (`mailexpert` — имя проекта; с `--project` — своё; если есть
   `<PREFIX>/compose.local.yml`, допишите `-f <PREFIX>/compose.local.yml`):

   ```bash
   APP="docker compose -p mailexpert --project-directory <PREFIX>/app --env-file <PREFIX>/.env -f <PREFIX>/app/docker-compose.yml -f <PREFIX>/app/deploy/compose.prod.yml"
   ```

3. Пустая база и загрузка дампа (одной транзакцией: ошибка — ничего не загружено):

   ```bash
   $APP up -d --wait postgres
   $APP exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error --single-transaction' < /root/old-panel.dump
   ```

   `--no-owner --no-privileges` — потому что пользователь базы в старом развёртывании мог называться
   иначе. Ошибка `already exists` значит, что база не пустая: проверьте, что вы в новом проекте.
4. **Проверка ключа до запуска панели** — тот же скрипт, которым `restore.sh` и `backup.sh --verify`
   проверяют восстановленную базу: применяет недостающие миграции (если код новее дампа) и
   расшифровывает каждое хранимое значение текущим `ENCRYPTION_KEY`:

   ```bash
   $APP run --rm --no-deps -T -e VERIFY_EXPECT_MAILBOX=1 \
     -v <PREFIX>/app/scripts/deploy/lib/verify-restore.mjs:/app/verify-restore.mjs:ro \
     --entrypoint node backend verify-restore.mjs
   ```

   Одна строка JSON: `failed` должен быть `0`, `decrypted` — больше нуля, если в старом
   развёртывании были ящики (без ящиков уберите `-e VERIFY_EXPECT_MAILBOX=1`).
   `migrationsApplied` больше нуля здесь нормален — это миграции новой версии, и скрипт тогда
   выходит с кодом 1, даже если всё расшифровалось; смотрите на `failed`.
5. **Запуск панели** — тот же `install.sh` без `--no-start` (флаги взяты из `install.conf`; снимает
   standby, запускает панель, ждёт готовности):

   ```bash
   systemctl reset-failed mailexpert-install 2>/dev/null; systemctl stop mailexpert-install 2>/dev/null
   systemd-run --unit=mailexpert-install --property=RemainAfterExit=yes <PREFIX>/app/scripts/deploy/install.sh --prefix <PREFIX>
   journalctl -u mailexpert-install -f -o cat
   ```

6. **Учётные записи — до первого входа** (раздел 3):

   ```bash
   $D/mailexpert-cli.sh user list
   $D/mailexpert-cli.sh user set <OLD_USERNAME> --email <EMAIL>        # для каждого, чьё имя — не его адрес Google
   $D/mailexpert-cli.sh user create <EMAIL>                            # direct: одобрить остальных
   ```

   Старый администратор, чьё имя не `<ADMIN_EMAIL>`, привязывается так же
   (`user set <OLD_ADMIN_USERNAME> --email <ADMIN_EMAIL>`): тогда при входе через Google он остаётся
   той же учётной записью со своими ящиками.
7. Разделы 6 и 7: первый бэкап с `--verify`, проверки, вход. Затем — статус ящиков в «Аккаунтах».
   Если адрес панели изменился, OAuth-клиентам Gmail нужен новый redirect URI
   ([google-oauth.md, «Callback-адрес»](google-oauth.md)), иначе подключение и переподключение Gmail
   не пройдут.

**Если ключ не тот** (`failed` больше нуля в шаге 4). Панель ещё ни разу не запускалась на этой базе,
поэтому начать заново безопасно: `$APP down -v` (удаляет **только** тома нового проекта — пустую
установку с загруженным дампом), затем верный `ENCRYPTION_KEY`. `configure.sh` записанный ключ не
заменяет — так задумано, ключ шифрования записывается один раз, а штатной команды замены в коде нет.
Единственный путь — поправить строку `ENCRYPTION_KEY=` в `<PREFIX>/.env` руками (root, файл `0600`) и
повторить шаги 3-4. Делать это можно только до первого запуска панели на этой базе.

**Вариант на том же сервере без дампа.** Если старое развёртывание использовало штатный
`docker-compose.yml` под именем проекта `mailexpert` (том `mailexpert_postgres_data`), со стандартными
`DB_NAME`/`DB_USER` и PostgreSQL 16, `install.sh` может взять этот том как есть: тогда в `configure.sh`
до первого `install.sh` нужны **все** ключи, с которыми этот том создан и данные зашифрованы —
`DB_PASSWORD` и `ENCRYPTION_KEY` (иначе `install.sh` остановится на проверке тома), плюс по желанию
`SESSION_SECRET` и пара VAPID; старые контейнеры перед этим останавливаются и удаляются
(`docker compose -p mailexpert down`, **без** `-v`). Дамп из раздела 4 всё равно снимается первым.
Этот вариант следует из кода (`guard_existing_database` в `install.sh`, ключи «записать один раз» в
`configure.sh`), но ни тестами, ни на сервере не проверялся; поддерживаемый путь — дамп и загрузка выше.

## 9. Обновления

- **Кнопкой**: «Настройки → Администрирование → Обновление панели». Ставит только продвинутую
  `latest`: коммит на `main`, новее текущей версии, образы `latest` совпадают с `sha-<12>`. Тег
  `latest` двигает только владелец, запуская `promote.yml` с `main` (сначала `dry_run`); ruleset на тег
  не используется — [deployment.md, раздел 5.1](deployment.md#51-включить-обновления-на-боевом-сервере).
- **По SSH** — любую версию с `main`, отдельно от SSH-сессии
  ([README.md, раздел 9](README.md)):

  ```bash
  $D/update.sh --check sha-<12>     # предпроверка, ничего не меняет
  systemctl reset-failed mailexpert-update 2>/dev/null; systemctl stop mailexpert-update 2>/dev/null
  systemd-run --unit=mailexpert-update --property=RemainAfterExit=yes $D/update.sh sha-<12> --prefix <PREFIX>
  journalctl -u mailexpert-update -f -o cat
  ```

  Перед переключением `update.sh` сам делает дамп `<PREFIX>/backups/pre-update-<старая>.dump` (три
  последних хранятся на месте) и снимок `pre-update` в restic. Коды: 0 — обновлено; 1 — новая версия
  не поднялась; 2 и 3 — ничего не изменено.
- **Откат** — `rollback.sh` по SSH (через `systemd-run`, с `--confirm`):

  ```bash
  $D/rollback.sh --prefix <PREFIX> --to sha-<старая>                     # спросит версию ещё раз
  systemd-run --unit=mailexpert-rollback --property=RemainAfterExit=yes \
    $D/rollback.sh --prefix <PREFIX> --to sha-<старая> --confirm sha-<старая>
  ```

  Восстанавливает дамп `pre-update-<старая>.dump`, всё записанное после обновления теряется. Без новых
  миграций хватает `install.sh --prefix <PREFIX> --version sha-<старая>` ([README.md, раздел
  10](README.md)). После отката (или автоотката кнопки) версия, с которой ушли, записана в
  `<PREFIX>/state/rolled-back-version`: кнопка её не предлагает, пока не продвинута более новая;
  поставленная по SSH, она снимает эту запись.

## 10. Перенос на другой сервер из бэкапа

Порядок целиком — [deployment.md, раздел 6](deployment.md); здесь — что нужно иметь заранее и
команды.

**Вне сервера хранить:**

| Что | Зачем |
|---|---|
| `RESTIC_REPOSITORY` и `RESTIC_PASSWORD` (ключ восстановления, `backup.sh --show-recovery-key`) | без них снимки не прочитать |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (и `AWS_DEFAULT_REGION`, если нужен) | доступ к бакету |
| флаги установки: `--signin`, хосты, `--admin-email`, `--project`, `--prefix` | сервер B ставится с теми же |
| доступ к Cloudflare (DNS, туннель) | переключение адреса |

Остальное приходит из снимка и вручную не переносится: `.env` (`ENCRYPTION_KEY`, `DB_PASSWORD`,
`SESSION_SECRET`, VAPID, секреты входа, пинги), `edge/.env` (`TUNNEL_TOKEN`, `DNS_API_TOKEN`),
`install.conf`, `compose.local.yml`, настройки исполнителя тенанта (`COMPOSE_PROFILES`, `TENANT_*`) и его
`app.pfx` с файлом пароля. `restore.sh` берёт сгенерированные ключи из снимка вместо своих, а секреты
владельца — только там, где на B их нет.

**Команды.** На сервере B (Ubuntu 24.04, требования раздела 1):

```bash
# 1. та же версия, что работает на A (status.sh на A: running), с теми же флагами, но --no-start
git clone https://github.com/wyrtensi/MailExpert.git <PREFIX>/app
git -C <PREFIX>/app checkout --detach <12 символов версии A>
install -m 600 /dev/null /root/restic.env      # RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
<PREFIX>/app/scripts/deploy/configure.sh --prefix <PREFIX> < /root/restic.env && shred -u /root/restic.env
<PREFIX>/app/scripts/deploy/install.sh --version sha-<12 версии A> --signin direct \
  --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL> --no-start
# install.sh может остановиться с кодом 3 (нет секретов входа): для --no-start это не помеха,
# restore.sh возьмёт их из снимка и сам запустит install.sh

# 2. репетиция: восстановить, не запуская панель, и убрать
<PREFIX>/app/scripts/deploy/restore.sh latest --prefix <PREFIX> --no-start
docker compose -p mailexpert down -v
```

В день переезда:

```bash
# на A: остановить приложение (и cloudflared в режиме cf/both), финальный бэкап — A станет standby
docker compose -p mailexpert stop backend frontend
<PREFIX>/app/scripts/deploy/backup.sh --prefix <PREFIX> --with-redis --tag move
# на B: восстановить снимок move и запустить (без --no-start), отдельно от SSH-сессии
systemd-run --unit=mailexpert-restore --property=RemainAfterExit=yes \
  <PREFIX>/app/scripts/deploy/restore.sh <id снимка move> --prefix <PREFIX>
journalctl -u mailexpert-restore -f -o cat
```

Id снимка `move` — в выводе `backup.sh` на A; вместо него можно `latest`: это самый новый снимок
панели любого хоста, а после бэкапа переезда A standby и новых снимков не делает, B тоже.
`restore.sh` отказывает (код 2, ничего не изменено), если на B уже есть база или контейнеры проекта,
или если версия снимка не совпадает с установленной (и называет нужную). Затем:

- **Переключение**: `direct` — A-запись `<DIRECT_HOST>` на IP сервера B (TTL 300); `cf` —
  `cloudflared` на B поднимается с тем же `TUNNEL_TOKEN`, DNS не меняется.
- **Проверка на B**: разделы 6 и 7 (`status.sh`, `healthcheck.sh`, `/api/version`, вход, статус ящиков) и
  ключ восстановления — тот же, репозиторий тот же; у B свой хост restic.
- **Сервер A** после `--tag move` — standby: таймеры его пропускают, кнопка и `update.sh` на нём
  отказывают. Отдельного флага снятия standby у панели нет (у почтового узла есть свой порядок в
  [mail-node.md](mail-node.md)): standby снимает обычный `install.sh --prefix <PREFIX>`, который
  запускает панель — делайте это на A, только если переезд отменяется и B остановлен
  (`docker compose -p mailexpert down` на B, без `-v`). После проверки B сервер A выключают и удаляют.

Почтовый узел, если он появится, переезжает отдельно своим бэкапом и `node-restore.sh` —
[mail-node.md, разделы 7 и 8](mail-node.md).

## 11. Необязательно

- **Почтовый узел** — отдельный сервер, [mail-node.md](mail-node.md) (разделы 2-6е), коротко —
  [quickstart.md, раздел 8](quickstart.md). Служба узла, чтобы скрипты узла и mailcow обновлялись вслед
  за панелью ([mail-node.md, раздел 7а](mail-node.md)):

  ```bash
  $D/mailexpert-cli.sh agent token issue --out /root/mailexpert-agent-token --yes   # файл 0600, не должен существовать
  # перенести на узел (scp), на панели: shred -u /root/mailexpert-agent-token
  # на узле: setup.sh --panel-url https://<APP_HOST> --agent-token-file /root/mailexpert-agent-token
  ```

- **Исполнитель тенанта Microsoft** — [mail-node.md, раздел 6е](mail-node.md): приложение в Entra,
  сертификат в `<PREFIX>/tenant-cert` и `<PREFIX>/tenant-secrets` (владелец 10001, `0400`), ключи
  `COMPOSE_PROFILES=tenant` и `TENANT_*` в `<PREFIX>/.env` вручную (`configure.sh` их не принимает),
  затем `install.sh --prefix <PREFIX>`. С профилем `tenant` бэкап кладёт `app.pfx` и файл пароля в снимок.
- **Google-приложения для Gmail** — [google-oauth.md](google-oauth.md): экран «Настройки → Интеграции →
  Почтовые провайдеры → Google-приложения» или `$D/google-app.sh add <client JSON file>`.

## 12. Убрать старое развёртывание

Только когда новая установка проверена: разделы 6 и 7 прошли, первый бэкап с `--verify` сделан, ключ
восстановления сохранён, пользователи вошли и видят свои ящики.

1. Дамп старой базы (`old-panel.dump`) сохраните вне сервера — это единственная копия состояния до
   перехода.
2. Остановите и удалите старые контейнеры: `docker compose -p <OLD_PROJECT> down` в каталоге старого
   compose (или `docker rm` его контейнеров). Тома — отдельным решением, после того как убедились, что
   дамп читается: `docker volume ls`, затем `docker volume rm <том старого проекта>`. На том же сервере
   сверяйте имена: тома новой установки называются `<проект>_postgres_data` и `<проект>_redis_data`
   (`docker volume ls --filter label=com.docker.compose.project=mailexpert`) — их не трогать.
3. Уберите старые файлы compose и `.env` старого развёртывания (в нём лежал `ENCRYPTION_KEY`):
   `shred -u` для файла с ключами.
4. Если старое развёртывание было на другом сервере — выключите его; DNS уже указывает на новую
   установку.
