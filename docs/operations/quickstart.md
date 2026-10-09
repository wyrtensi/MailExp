# Быстрый старт

Самый короткий правильный путь от сервера до работающей панели MailExpert и, при желании,
почтового узла — по шагам, с проверкой после каждого шага и коротким «почему так». Два сценария:

- **А. Отдельный сервер (VM)** только под панель — рекомендуется, если сервер чистый;
- **Б. Общий сервер**, где уже живут другие проекты, — с минимальным влиянием на соседей.

Шаги у них общие, различаются флаги `install.sh` и проверки; где сценарии расходятся, это сказано.
Справочник (все флаги, что панель создаёт на хосте, имена, коды выхода) —
[deployment.md](deployment.md), карта эксплуатации — [README.md](README.md); здесь — порядок и
точные команды.

Плейсхолдеры: `<DIRECT_HOST>` — публичный адрес панели с Caddy или прокси (например,
`mail.example.com`), `<CF_HOST>` — адрес панели за Cloudflare Tunnel и Access, `<PANEL_HOST>` —
сервер панели для SSH, `<MAIL_HOST>` — почтовый узел, `<PANEL_IP>` — публичный IPv4 панели (адрес,
с которого она выходит в интернет), `<ADMIN_EMAIL>` — адрес первого администратора, `<PREFIX>` —
каталог установки (по умолчанию `/opt/mailexpert`), `<PROJECT>` — имя compose-проекта панели (по
умолчанию `mailexpert`), `<HTTP_PORT>` — порт панели на `127.0.0.1` (по умолчанию `8080`).

## Установить с помощью ИИ-агента

Если у вас есть Claude Code (или другой агент, читающий `AGENTS.md`) с этим репозиторием и SSH-доступ
к серверу, достаточно написать ему:

> Поставь MailExpert на сервер `<PANEL_HOST>` по SSH по навыку mailexpert-rollout. Адрес панели
> `<DIRECT_HOST>`, вход через Google, администратор `<ADMIN_EMAIL>`, почтовый узел пока не нужен.

Для общего сервера добавьте: «сервер общий, ставь с `--no-system` и входом через туннель
Cloudflare на `<CF_HOST>`».

Агент работает по скиллу [`mailexpert-rollout`](../../.claude/skills/mailexpert-rollout/SKILL.md),
раздел «First install». Что он спросит, если вы не сказали сразу:

- адрес сервера и пользователя для SSH (нужен root или `sudo` без пароля, вход по ключу);
- отдельный это сервер или общий;
- публичные адреса панели и режим входа: `direct` (Caddy и «Войти через Google»), `cf` (туннель и
  Cloudflare Access) или `both`; для `direct` — что зона DNS в Cloudflare;
- адреса администраторов;
- нужен ли почтовый узел (тогда — `<MAIL_HOST>` и SSH к нему);
- нужны ли бэкапы сразу (S3-хранилище у другого провайдера) и проверка в Healthchecks.

Чего агент делать не будет: создавать клиент Google, токены Cloudflare и ключи хранилища, видеть
секреты или печатать их в чат. Cloudflare (туннель, приложение Access, токены) вы настраиваете до
установки по [cloudflare.md](cloudflare.md); агент сошлётся на нужные разделы для выбранного режима,
а после установки покажет, что `install.sh` и `status.sh` сказали о проверке Access на `<CF_HOST>`.
Он назовёт, **какие** ключи нужны, а вы внесёте их сами через `configure.sh` (шаг 5). Перед каждым
шагом, который меняет сервер, агент показывает план и ждёт вашего «да»; ключ восстановления бэкапов
вы получаете сами командой из шага 7.

## 1. Выбрать сценарий

| | А. Отдельный сервер | Б. Общий сервер |
|---|---|---|
| Сервер | Ubuntu 24.04, минимум 2 vCPU / 4 ГБ RAM / 20 ГБ свободного диска | любой Linux с systemd; свободно около 2 vCPU и 4-4,5 ГБ памяти под панель, 20 ГБ диска |
| Флаг | без `--no-system` | `--no-system` |
| Вход | любой: `direct`, `cf`, `both` | `cf` (туннель) — рекомендуется; или `direct --no-edge` за reverse proxy соседа |
| Что ставите вы | ничего: Docker, файрвол, swap, автообновления ставит `install.sh` | Docker Engine с Compose 2.24.4+, утилиты `git curl jq ss sha256sum timeout flock`; файрвол и обновления ОС — как принято на сервере |

**Почему `--no-system` на общем сервере.** Без него `install.sh` настраивает хост целиком: ставит
пакеты и Docker из download.docker.com, включает `ufw` с политикой «входящие закрыты», создаёт swap,
включает автообновления. На машине только под панель это то, что нужно; на сервере соседа это
вмешательство в чужое. С `--no-system` `install.sh` хост не настраивает: только свои файлы в
`<PREFIX>`, свои контейнеры, тома и сеть и свои юниты systemd (таймеры бэкапа и проверки здоровья,
исполнитель кнопки обновления — их он ставит в обоих сценариях, если хостом управляет systemd).
Полный список по сценариям — [«Сосед на общем сервере»](deployment.md#сосед-на-общем-сервере-что-панель-трогает-и-что-нет).

**Почему туннель на общем сервере.** В режиме `cf` панель не слушает 80/443: `cloudflared` сам
подключается к Cloudflare исходящим соединением (порт 7844), а TLS и вход (Cloudflare Access) — на
стороне Cloudflare. Порты 80/443 соседа не нужны, входящих правил файрвола не нужно. Единственное,
что закрыть своим файрволом: слушатель метрик `cloudflared` (первый свободный из 20241-20245, в сети
хоста, [ports.md, раздел 1](ports.md)). Если у соседа уже есть reverse proxy с TLS — можно и через
него (`--signin direct --no-edge`), требования к прокси —
[рецепт общего сервера](deployment.md#установка-на-общий-сервер-минимальное-влияние-полный-функционал).
Caddy панели (`direct` без `--no-edge`) ставьте только туда, где 80/443 свободны.

Где запускать нельзя или не стоит (контейнер без systemd, голый `docker compose`) —
[«Где запускать панель»](deployment.md#где-запускать-панель-и-почему-не-голый-docker-compose).
Панель уже поднята собственным `docker compose` и её нужно заменить боевой установкой —
[migrate-to-install.md](migrate-to-install.md).

## 2. Подготовить Cloudflare, Google и хранилище

Шаги в Cloudflare — запись DNS, токен с минимальными правами, для `cf`/`both` туннель и приложение
Access — пошагово в [cloudflare.md](cloudflare.md). Сделайте их сейчас, до `install.sh`. Короткий путь
по кликам — его раздел «Подключение Cloudflare — просто», какие права у какого ключа и что вносится в
панели, а что только через `configure.sh` — раздел «Ключи и права».

| Что | Режим | Зачем |
|---|---|---|
| SSH-доступ root по ключу | все | все команды ниже — от root |
| Туннель с маршрутом `<CF_HOST>` → `http://127.0.0.1:<HTTP_PORT>` (`TUNNEL_TOKEN`) и приложение Access на `<CF_HOST>` (`CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`) | `cf`, `both` | вход без входящих портов; Access решает, кого пускать |
| Зона DNS в Cloudflare, A-запись `<DIRECT_HOST>` → IP сервера (TTL 300) и токен API только на эту зону: DNS Edit и Zone Read (`DNS_API_TOKEN`, [cloudflare.md, раздел 4](cloudflare.md)) | `direct`, `both` с Caddy | сертификат выпускается через DNS-01 Cloudflare, порт 80 для этого не нужен |
| Клиент Google OAuth «Web application» для **входа в панель** с redirect URI `https://<DIRECT_HOST>/oauth/login/google/callback` (`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`) | `direct`, `both` | «Войти через Google»; это не те Google-приложения, через которые подключаются Gmail-ящики ([google-oauth.md](google-oauth.md)) |
| S3-бакет у другого провайдера (`RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESTIC_PASSWORD` не короче 16 символов) | все; на общем сервере — обязательно по смыслу | ночные зашифрованные бэкапы. Без них панель работает, но `install.sh` предупреждает «backups are off». На общем сервере любой с правами на Docker может удалить тома панели вместе с базой — от этого защищает только копия вне сервера |
| Проверка в Healthchecks.io (`HEALTHCHECK_PING_URL`) | все, необязательно | оповещения о сбоях бэкапа и проверки здоровья |

Вход по логину и паролю (`--local-auth`, первый зарегистрированный становится администратором)
предназначен для тестовых стендов. Все режимы и их секреты —
[deployment.md, раздел 3](deployment.md#3-режимы-входа).

## 3. Скачать код боевой версии

Боевая версия — git-тег `latest`: сборка, которую владелец проекта продвинул как готовую к проду.
Сервер всегда запускает её неизменяемый тег образов `sha-<12 символов коммита>`.

```bash
apt-get update && apt-get install -y git        # сценарий Б: git ставите как принято на сервере
git clone --branch latest https://github.com/wyrtensi/MailExpert.git <PREFIX>/app
cd <PREFIX>/app
git merge-base --is-ancestor HEAD origin/main && echo "on main"     # должно напечатать: on main
V=sha-$(git rev-parse HEAD | cut -c1-12); echo "$V"
```

Клонировать от root: `install.sh` работает с этим каталогом от root и откажется от чужого владельца.
Почему тег, а не `main`: сервер ставит только то, что владелец проверил и продвинул; кнопка
обновления потом тоже ставит только продвинутую `latest`.

## 4. Первый запуск `install.sh`

**А. Отдельный сервер** (здесь `direct`; для туннеля — как в Б, но без `--no-system`):

```bash
<PREFIX>/app/scripts/deploy/install.sh --version "$V" \
  --signin direct --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL>
```

**Б. Общий сервер:**

```bash
<PREFIX>/app/scripts/deploy/install.sh --version "$V" --no-system \
  --signin cf --cf-host <CF_HOST> --admin-email <ADMIN_EMAIL>
# через прокси соседа вместо туннеля:
#   --signin direct --direct-host <DIRECT_HOST> --no-edge
# если умолчания уже заняты (вторая панель, порт 8080 у соседа):
#   --prefix <PREFIX> --project <PROJECT> --edge-project <PROJECT>-edge --http-port <HTTP_PORT>
```

С `--prefix`, отличным от `/opt/mailexpert`, его нужно передавать и всем остальным скриптам
(`status.sh --prefix <PREFIX>` и т. д.). Флаги запоминаются в `<PREFIX>/install.conf`: следующий
запуск без флагов (`install.sh --prefix <PREFIX>`) повторяет установку. Имена compose-проектов по
умолчанию — `mailexpert` (панель) и `mailexpert-edge` (край: Caddy и/или `cloudflared`); указывать
их нужно, только если они уже заняты.

`install.sh` ничего не спрашивает интерактивно. Что он делает до остановки:

1. Проверяет флаги (`--prefix` — абсолютный путь без пробелов и сегментов `..`), при первом
   запуске создаёт **ID установки** (`INSTALL_ID`, строка `install ID <16 hex>` в логе), берёт
   блокировку (два `install.sh` одной установки разом не идут).
2. Сценарий А: проверяет ОС и ресурсы, ставит пакеты, Docker, swap и автообновления безопасности.
   Сценарий Б: ничего из этого.
3. Проверяет утилиты и Docker с Compose 2.24.4+.
4. **Проверяет владельца compose-проектов.** Если в проектах `mailexpert` или `mailexpert-edge` уже
   есть чужие контейнеры, тома или сети (сосед взял то же имя), установка останавливается с кодом 2 и
   перечисляет их: ни одна команда compose против них не выполняется. Почему: `up --remove-orphans`
   и удаление лишних сервисов края работают по имени проекта и иначе тронули бы соседа.
5. **Проверяет порты.** С Caddy: 80 и 443 должны быть свободны (чужой процесс, контейнер или Caddy,
   который не является Caddy этой установки, — остановка). Всегда: `127.0.0.1:<HTTP_PORT>` не должен
   держать никто, кроме этой же панели.
6. Пишет `install.conf` (вместе с ID), скачивает образы, создаёт внутренние секреты (пароль базы,
   ключ шифрования, ключ сессий).
7. Не найдя ваших секретов, **останавливается с кодом 3** и строкой `waiting for secrets: ...` — это
   нормально. Для `direct`: `DNS_API_TOKEN AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET`; для
   `cf`: `TUNNEL_TOKEN CF_ACCESS_ISSUER CF_ACCESS_AUDIENCE`; для `direct --no-edge`: только клиент Google.

**Зачем ID установки.** Каждый контейнер этой установки получает метку
`io.mailexpert.install=<INSTALL_ID>` (и `io.mailexpert.managed=true`, `io.mailexpert.component`).
По ней проверка владельца отличает свои контейнеры от соседских с тем же именем проекта, а вы можете
найти и удалить ровно свои — [«Имена на общем сервере»](deployment.md#имена-на-общем-сервере).
ID не флаг; хранится в `install.conf`, переживает обновления и откаты.

Если `install.sh` остановился не с кодом 3 — таблица в [шаге 10](#10-если-проверка-отказала).

## 5. Внести секреты

Только через `configure.sh` со stdin: в аргументы, историю shell и чат секреты не попадают, значения
не выводятся.

```bash
install -m 600 /dev/null /root/mailexpert-secrets.env
nano /root/mailexpert-secrets.env      # строки KEY=VALUE: ключи из шага 4, restic, Healthchecks
<PREFIX>/app/scripts/deploy/configure.sh --prefix <PREFIX> < /root/mailexpert-secrets.env
shred -u /root/mailexpert-secrets.env
```

Код 0 — сохранено; код 2 — список проблем, ничего не записано. Полный список ключей:
`configure.sh --help`; пример файла — [deployment.md, раздел 2](deployment.md#2-установка).

## 6. Повторный запуск

Тот же вызов ещё раз. `install.sh` идемпотентен: продолжит с того места, где остановился; при обрыве
SSH его можно просто запустить снова (или сразу запускать отдельно от SSH-сессии через
`systemd-run`, как в [migrate-to-install.md, раздел 5](migrate-to-install.md#5-установка)).

```bash
<PREFIX>/app/scripts/deploy/install.sh --version "$V" <те же флаги, что в шаге 4>
```

Дальше он запускает панель и край, в сценарии А включает `ufw` (входящие закрыты, открыты SSH и,
с Caddy, 80/443), ждёт готовности панели, проверяет `https://<DIRECT_HOST>` через Caddy или, для
туннеля, что `<CF_HOST>` закрыт Access вашей команды (несовпадение — предупреждение, не остановка),
настраивает бэкапы, ставит таймеры бэкапа и проверки здоровья и исполнитель обновлений из панели и
пишет `done`. Если ключи restic были внесены, при первом успешном запуске в терминале **один раз**
печатается ключ восстановления (`RESTIC_REPOSITORY` и `RESTIC_PASSWORD`).

## 7. Проверить

```bash
D=<PREFIX>/app/scripts/deploy
$D/status.sh --prefix <PREFIX>                 # в конце: result: no problems; в начале: version, install_id
$D/status.sh --prefix <PREFIX> --json | jq .updater   # {"state":"active","expected":true}
$D/healthcheck.sh --prefix <PREFIX>; echo "exit $?"   # exit 0; без ключей restic — exit 1 и «backup: not configured»
curl -fsS http://127.0.0.1:<HTTP_PORT>/api/version    # sha совпадает с $V
```

Юниты: в проекте по умолчанию — `mailexpert-updater.path`, `mailexpert-backup.timer`,
`mailexpert-health.timer`; с `--project <PROJECT>` — с суффиксом: `mailexpert-updater-<PROJECT>.path`
и т. д. (так две установки на одном хосте не делят юниты).

```bash
systemctl is-active mailexpert-updater.path      # active (с --project: mailexpert-updater-<PROJECT>.path)
systemctl list-timers 'mailexpert-*'             # backup и health этой установки
docker ps --filter label=io.mailexpert.install=<INSTALL_ID> --format '{{.Names}}'   # свои контейнеры
```

`status.sh` перечисляет найденное строками `problem:` (чинить), `warning:`, `next:` и `info:`
(справка). Что значат строки `ownership:` и `names:` — [шаг 10](#10-если-проверка-отказала).

Затем откройте `https://<DIRECT_HOST>` (или `https://<CF_HOST>`) и войдите под `<ADMIN_EMAIL>`:
этот адрес станет администратором при первом входе.

Ключ восстановления бэкапов, если в терминале его не было (установка шла не из терминала), достаньте
сами и сохраните в менеджере паролей, вне сервера. Первый бэкап с проверкой восстановлением
подтверждает, что ключи и хранилище работают:

```bash
$D/backup.sh --prefix <PREFIX> --show-recovery-key
$D/backup.sh --prefix <PREFIX> --tag manual --verify; echo "exit $?"   # 0
```

## 8. Первые шаги в панели

- Подключить Gmail-ящики: администратор добавляет Google-приложения
  («Настройки → Интеграции → Почтовые провайдеры → Google-приложения»,
  [google-oauth.md](google-oauth.md)), затем любой пользователь — «Добавить аккаунт → Gmail».
- Ящики Microsoft 365 / Outlook — [microsoft-oauth.md](microsoft-oauth.md).
- Пользователи, журнал и остальные экраны — [руководство пользователя](../user-guide/README.md).

## 9. Почтовый узел (необязательно)

Нужен для ящиков на своих доменах через Microsoft EOP. Это **отдельный** сервер Ubuntu 24.04
(4 vCPU / 8 ГБ, у провайдера с открытым портом 25 и своим PTR); на одном сервере с панелью узел не
поддерживается. Какие связи идут между серверами панели и узла и что проверить, если панель на общем
сервере, — [mail-node.md, «Панель и узел на разных серверах»](mail-node.md#панель-и-узел-на-разных-серверах).
Порядок — [mail-node.md, разделы 2-6е](mail-node.md), коротко:

1. DNS: A-запись `<MAIL_HOST>` и PTR на IP узла.
2. Docker и mailcow по инструкции mailcow, `./generate_config.sh` (имя — `<MAIL_HOST>`).
3. Скрипты MailExpert на узле — на **том же коммите**, что панель:

   ```bash
   git clone https://github.com/wyrtensi/MailExpert.git /opt/mailexpert-node-src
   git -C /opt/mailexpert-node-src checkout --detach <коммит панели, 12 символов из $V>
   /opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --ping-url <ссылка проверки> --dry-run
   /opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --ping-url <ссылка проверки>
   ```

   `<PANEL_IP>` — адрес, с которым панель **выходит** в интернет; на общем сервере с несколькими
   адресами или NAT он может отличаться от адреса, на который указывает DNS.
4. `docker compose up -d` в каталоге mailcow, ключ API с доступом только с `<PANEL_IP>`.
5. В панели: «Настройки → Администрирование → Почтовый узел» — имя узла и ключ API, затем домены и
   тенант Microsoft ([mail-node.md, разделы 5-6е](mail-node.md)).

## 10. Если проверка отказала

Скрипты останавливаются до изменений, если что-то угрожает данным или соседям. Сообщение называет
причину; коды выхода — [README.md, раздел 12](README.md#12-неполадки).

| Сообщение | Код | Что значит и что делать |
|---|---|---|
| `waiting for secrets: ...` | 3 | ожидаемо при первой установке: шаг 5, затем шаг 6 |
| `compose project <имя> is not only this install's ...` | 2 | в проекте есть контейнеры, тома или сети другого владельца (перечислены в сообщении); ничего не запущено. Новая установка — другое имя: `--project <имя>` или `--edge-project <имя>`. Существующая — выяснить, чьи это объекты (`docker inspect <имя>`), и убрать их из проекта; край со старым именем `edge` — [переезд края](deployment.md#имена-на-общем-сервере) |
| `cannot list Docker's containers, volumes and networks ...` | 1 (`install.sh`, `restore.sh`), 3 (`update.sh`, `rollback.sh`) | Docker не ответил на проверке владельца; ничего не изменено. Проверить `docker info` и повторить |
| `ports for the edge are taken: ...` | 1 | 80/443 занимает другой процесс, контейнер или чужой Caddy. На общем сервере — туннель (`--signin cf`) или `--no-edge` за прокси соседа |
| `--http-port <порт> is taken on 127.0.0.1 ...` | 1 | порт панели занят не этой панелью: другой `--http-port`. С `--no-start` — только предупреждение |
| `docker compose ... is too old` / `the docker daemon is not reachable` | 1 | сценарий Б: обновить или запустить Docker самим; сценарий А ставит его сам |
| `<утилита> is required` (например, `flock is required`) | 1 | поставить утилиту (`flock` — пакет util-linux) |
| `--prefix must be an absolute path without spaces or .. segments` | 2 | исправить `--prefix` |
| `status.sh`: `problem: ownership: compose project ...` | — | то же, что код 2 выше: пока объект соседа в проекте, `install.sh`, `update.sh`, `rollback.sh` и `restore.sh` откажут |
| `status.sh`: `info: names: ...` | — | справка: проект без префикса `mailexpert` (установка, сделанная до этого умолчания) или ещё нет `INSTALL_ID` (появится при следующем `install.sh` или `update.sh`). Строка называет команду переезда края |
| `status.sh`: `warning: updater: ...` | — | юнитов исполнителя нет или `.path` не активен: `install.sh --prefix <PREFIX>` ([раздел 5.1](deployment.md#51-включить-обновления-на-боевом-сервере)) |

## 11. Обновление

**Один раз — включить обновления** (подробно и с причинами —
[deployment.md, раздел 5.1](deployment.md#51-включить-обновления-на-боевом-сервере)):

1. Сервер: ничего дополнительно — `install.sh` из шагов 4-6 уже поставил исполнитель кнопки и
   каталоги спула (проверка — шаг 7). На хосте без systemd (контейнер) исполнителя нет: обновления
   только по SSH.
2. GitHub: ничего настраивать не нужно. Тег `latest` двигает только владелец через `promote.yml`
   ([deployment.md, раздел 5.1](deployment.md#51-включить-обновления-на-боевом-сервере)).
3. Бэкапы restic (шаг 5) — рекомендуются: без них перед обновлением делается только локальный дамп
   на этом же сервере.
4. Почтовый узел: подключить службу узла (токен — `mailexpert-cli.sh agent token issue --out
   <FILE> --yes`, на узле — `setup.sh --panel-url https://<APP_HOST> --agent-token-file <FILE>`),
   тогда скрипты узла и mailcow (только до версии из `deploy/mailcow-version`) обновляются вслед за
   панелью.

- **Кнопкой**: «Настройки → Администрирование → Обновление панели» — показывает текущую версию,
  продвинутую `latest`, предпроверку и кнопку «Обновить»; ставит только `latest`.
- **По SSH** (с `--project` называйте временный юнит по проекту: `mailexpert-update-<PROJECT>`):

  ```bash
  $D/update.sh --prefix <PREFIX> --check latest      # предпроверка, ничего не меняет
  systemctl reset-failed mailexpert-update 2>/dev/null; systemctl stop mailexpert-update 2>/dev/null
  systemd-run --unit=mailexpert-update --property=RemainAfterExit=yes $D/update.sh latest --prefix <PREFIX>
  journalctl -u mailexpert-update -f -o cat
  ```

Перед обновлением `update.sh` сам делает дамп базы. Первое обновление с версии старее 2026-10-09
один раз пересоздаёт все контейнеры панели и края, включая базу: короткий перерыв —
[«Что изменилось»](deployment.md#что-изменилось-заметки-для-операторов). Коды выхода, откат
(`rollback.sh`) и шаги после обновления — [README.md, разделы 9-10](README.md#9-обновление).

## Куда дальше

- [README.md](README.md) — карта эксплуатации: бэкапы, мониторинг, обновление, откат, переезд, неполадки.
- [deployment.md](deployment.md) — все флаги `install.sh`, общий сервер, имена и метки, режимы входа,
  CLI, обновление, переезд панели.
- [cloudflare.md](cloudflare.md) — туннель, Access, токены Cloudflare, синхронизация пользователей, неполадки.
- [cli.md](cli.md) — командная строка панели `mailexpert`.
- [../architecture/deployment-system.md](../architecture/deployment-system.md) — из чего состоит
  система и что можно разносить по серверам.
