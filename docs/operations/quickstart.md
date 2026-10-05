# Быстрый старт

Самый короткий правильный путь от чистого VPS до работающей панели MailExpert и, при желании,
почтового узла. Подробности каждого шага — в [README.md](README.md) (карта эксплуатации) и
[deployment.md](deployment.md); здесь — только порядок и точные команды.

Плейсхолдеры: `<DIRECT_HOST>` — публичный адрес панели (например, `mail.example.com`),
`<PANEL_HOST>` — сервер панели для SSH, `<MAIL_HOST>` — почтовый узел, `<PANEL_IP>` — публичный
IPv4 панели, `<ADMIN_EMAIL>` — адрес Google первого администратора.

## Установить с помощью ИИ-агента

Если у вас есть Claude Code (или другой агент, читающий `AGENTS.md`) с этим репозиторием и SSH-доступ
к серверу, достаточно написать ему:

> Поставь MailExpert на сервер `<PANEL_HOST>` по SSH по навыку mailexpert-rollout. Адрес панели
> `<DIRECT_HOST>`, вход через Google, администратор `<ADMIN_EMAIL>`, почтовый узел пока не нужен.

Агент работает по скиллу [`mailexpert-rollout`](../../.claude/skills/mailexpert-rollout/SKILL.md),
раздел «First install». Что он спросит, если вы не сказали сразу:

- адрес сервера и пользователя для SSH (нужен root или `sudo` без пароля, вход по ключу);
- публичные адреса панели и режим входа: `direct` (Caddy и «Войти через Google»), `cf` (туннель и
  Cloudflare Access) или `both`; для `direct` — что зона DNS в Cloudflare;
- адреса администраторов;
- нужен ли почтовый узел (тогда — `<MAIL_HOST>` и SSH к нему);
- нужны ли бэкапы сразу (S3-хранилище у другого провайдера) и проверка в Healthchecks.

Чего агент делать не будет: создавать клиент Google, токены Cloudflare и ключи хранилища, видеть
секреты или печатать их в чат. Cloudflare (туннель, приложение Access, токены) вы настраиваете до
установки по [cloudflare.md](cloudflare.md); агент сошлётся на нужные разделы для выбранного режима,
а после установки покажет, что `install.sh` и `status.sh` сказали о проверке Access на `<CF_HOST>`. Он назовёт, **какие** ключи нужны, а вы внесёте их сами через
`configure.sh` (шаг 4 ниже). Перед каждым шагом, который меняет сервер, агент показывает план и ждёт
вашего «да»; ключ восстановления бэкапов вы получаете сами командой из шага 6.

## 1. Что подготовить

Шаги в Cloudflare — запись DNS, токен с минимальными правами, для `cf`/`both` туннель и приложение
Access — пошагово в [cloudflare.md](cloudflare.md). Сделайте их сейчас, до `install.sh`.

| Что | Зачем |
|---|---|
| VPS **Ubuntu 24.04**, минимум 2 vCPU / 4 ГБ RAM / 20 ГБ свободного диска; почтовый узел — всегда отдельный сервер, 4 vCPU / 8 ГБ (раздел 8) | `install.sh` ставит Docker, файрвол, swap и таймеры только на Ubuntu 24.04 и проверяет ресурсы; другая ОС — только с `--no-system`, а Docker Engine с Compose 2.24.4+ тогда ставите вы |
| SSH-доступ root по ключу | все команды ниже — от root |
| Зона DNS `example.com` в Cloudflare, A-запись `<DIRECT_HOST>` → IP сервера (TTL 300) | сертификат выпускается через DNS-01 Cloudflare |
| Токен Cloudflare API только на правку DNS этой зоны (`DNS_API_TOKEN`) | для сертификата |
| Клиент Google OAuth «Web application» для **входа в панель** с redirect URI `https://<DIRECT_HOST>/oauth/login/google/callback` (`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`) | «Войти через Google»; это не те Google-приложения, через которые подключаются Gmail-ящики ([google-oauth.md](google-oauth.md)) |
| Необязательно: S3-бакет у другого провайдера (`RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESTIC_PASSWORD` не короче 16 символов) | ночные зашифрованные бэкапы; без них панель работает, но `install.sh` предупреждает «backups are off» |
| Необязательно: проверка в Healthchecks.io (`HEALTHCHECK_PING_URL`) | оповещения о сбоях |

Порты: в режиме `direct` снаружи открыты только SSH, 80 и 443 (`install.sh` включает `ufw`); порты 80 и
443 на сервере должны быть свободны. Панель слушает `127.0.0.1:8080` и наружу не публикуется.

Другие режимы входа: `cf` — через Cloudflare Tunnel и Access (нужны `TUNNEL_TOKEN`,
`CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`, входящие порты не нужны), `both` — оба адреса сразу;
таблица — [deployment.md, раздел 3](deployment.md), где взять ключи — [cloudflare.md](cloudflare.md). Вход по логину и паролю (`--local-auth`, первый
зарегистрированный становится администратором) предназначен для тестовых стендов.

## 2. Скачать код боевой версии

Боевая версия — git-тег `latest`: сборка, которую владелец проекта продвинул как готовую к проду.
Сервер всегда запускает её неизменяемый тег образов `sha-<12 символов коммита>`.

```bash
apt-get update && apt-get install -y git
git clone --branch latest https://github.com/wyrtensi/MailExpert.git /opt/mailexpert/app
cd /opt/mailexpert/app
git merge-base --is-ancestor HEAD origin/main && echo "on main"     # должно напечатать: on main
V=sha-$(git rev-parse HEAD | cut -c1-12); echo "$V"
```

Клонировать от root: `install.sh` работает с этим каталогом от root и откажется от чужого владельца.

## 3. Первый запуск `install.sh`

```bash
/opt/mailexpert/app/scripts/deploy/install.sh --version "$V" \
  --signin direct --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL>
```

`install.sh` ничего не спрашивает интерактивно. Он ставит пакеты, Docker, swap, автообновления
безопасности, пишет `/opt/mailexpert/install.conf`, скачивает образы, создаёт внутренние секреты
(пароль базы, ключ шифрования, ключ сессий) и, не найдя ваших секретов, **останавливается с кодом 3**
и строкой `waiting for secrets: DNS_API_TOKEN AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET` — это
нормально.

## 4. Внести секреты

Только через `configure.sh` со stdin: в аргументы, историю shell и чат секреты не попадают, значения
не выводятся.

```bash
install -m 600 /dev/null /root/mailexpert-secrets.env
nano /root/mailexpert-secrets.env      # строки KEY=VALUE: ключи из шага 3, при желании restic и Healthchecks
/opt/mailexpert/app/scripts/deploy/configure.sh < /root/mailexpert-secrets.env
shred -u /root/mailexpert-secrets.env
```

Полный список ключей: `configure.sh --help`; пример файла — [deployment.md, раздел 2](deployment.md).

## 5. Повторный запуск

Тот же вызов ещё раз (`install.sh` идемпотентен: продолжит с того места, где остановился; при обрыве
SSH его можно просто запустить снова):

```bash
/opt/mailexpert/app/scripts/deploy/install.sh --version "$V" \
  --signin direct --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL>
```

Дальше он запускает панель и Caddy, включает `ufw`, ждёт готовности панели, проверяет
`https://<DIRECT_HOST>` через Caddy, затем настраивает бэкапы, таймеры бэкапа и проверки здоровья и
исполнитель обновлений из панели и пишет `done`.
Если ключи restic были внесены, при первом успешном запуске в терминале **один раз** печатается ключ
восстановления (`RESTIC_REPOSITORY` и `RESTIC_PASSWORD`).

## 6. Проверить

```bash
D=/opt/mailexpert/app/scripts/deploy
$D/status.sh                                   # в конце: no problems
$D/healthcheck.sh; echo "exit $?"              # exit 0; без ключей restic — exit 1 и «backup: not configured»
curl -fsS http://127.0.0.1:8080/api/version    # sha совпадает с $V
```

Затем откройте `https://<DIRECT_HOST>` и войдите через Google под `<ADMIN_EMAIL>`: этот адрес станет
администратором при первом входе.

Ключ восстановления бэкапов, если в терминале его не было (установка шла не из терминала), достаньте
сами и сохраните в менеджере паролей, вне сервера:

```bash
$D/backup.sh --show-recovery-key
```

## 7. Первые шаги в панели

- Подключить Gmail-ящики: администратор добавляет Google-приложения
  («Настройки → Интеграции → Почтовые провайдеры → Google-приложения»,
  [google-oauth.md](google-oauth.md)), затем любой пользователь — «Добавить аккаунт → Gmail».
- Ящики Microsoft 365 / Outlook — [microsoft-oauth.md](microsoft-oauth.md).
- Пользователи, журнал и остальные экраны — [руководство пользователя](../user-guide/README.md).

## 8. Почтовый узел (необязательно)

Нужен для ящиков на своих доменах через Microsoft EOP. Это **отдельный** сервер Ubuntu 24.04
(4 vCPU / 8 ГБ, у провайдера с открытым портом 25 и своим PTR); на одном сервере с панелью узел не
поддерживается. Порядок — [mail-node.md, разделы 2-6е](mail-node.md), коротко:

1. DNS: A-запись `<MAIL_HOST>` и PTR на IP узла.
2. Docker и mailcow по инструкции mailcow, `./generate_config.sh` (имя — `<MAIL_HOST>`).
3. Скрипты MailExpert на узле — на **том же коммите**, что панель:

   ```bash
   git clone https://github.com/wyrtensi/MailExpert.git /opt/mailexpert-node-src
   git -C /opt/mailexpert-node-src checkout --detach <коммит панели, 12 символов из $V>
   /opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --ping-url <ссылка проверки> --dry-run
   /opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --ping-url <ссылка проверки>
   ```

4. `docker compose up -d` в каталоге mailcow, ключ API с доступом только с `<PANEL_IP>`.
5. В панели: «Настройки → Администрирование → Почтовый узел» — имя узла и ключ API, затем домены и
   тенант Microsoft ([mail-node.md, разделы 5-6е](mail-node.md)).

## 9. Обновление

- **Кнопкой**: «Настройки → Администрирование → Обновление панели» — показывает текущую версию,
  продвинутую `latest`, предпроверку и кнопку «Обновить»; ставит только `latest`.
- **По SSH**:

  ```bash
  $D/update.sh --check latest      # предпроверка, ничего не меняет
  systemctl reset-failed mailexpert-update 2>/dev/null; systemctl stop mailexpert-update 2>/dev/null
  systemd-run --unit=mailexpert-update --property=RemainAfterExit=yes $D/update.sh latest
  journalctl -u mailexpert-update -f -o cat
  ```

Перед обновлением `update.sh` сам делает дамп базы. Коды выхода, откат (`rollback.sh`) и шаги после
обновления — [README.md, разделы 9-10](README.md).

## Куда дальше

- [README.md](README.md) — карта эксплуатации: бэкапы, мониторинг, обновление, откат, переезд, неполадки.
- [deployment.md](deployment.md) — все флаги `install.sh`, режимы входа, CLI, переезд панели.
- [cloudflare.md](cloudflare.md) — туннель, Access, токены Cloudflare, синхронизация пользователей, неполадки.
- [cli.md](cli.md) — командная строка панели `mailexpert`.
- [../architecture/deployment-system.md](../architecture/deployment-system.md) — из чего состоит
  система и что можно разносить по серверам.
