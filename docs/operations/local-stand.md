# Локальный стенд

Весь продукт на одном «сервере» размера целевого VPS (4 vCPU / 8 ГБ) на своём компьютере: чтобы
руками проверить подключение Gmail, ящики на своих доменах и интерфейс до выкладки на настоящий сервер.

Скрипт: [`scripts/deploy/test/stage.sh`](../../scripts/deploy/test/stage.sh).

## Что внутри

Один контейнер `me-stage` (Docker-in-Docker) с ограничением 4 CPU и 8 ГБ памяти. В нём:

- mailcow выпуска `2026-09` под именем `mail.test.local`, с сертификатом от CA стенда, без ClamAV,
  Olefy и FTS и с настройками Dovecot из [раздела 3 инструкции по узлу](mail-node.md);
- панель из опубликованных образов `ghcr.io/wyrtensi/mailexpert-*:sha-<commit>` с лимитами
  `deploy/compose.prod.yml`;
- Caddy со своим сертификатом перед панелью.

Панель открывается на `https://localhost` (порт 443, только с этого компьютера). Браузер
предупреждает о сертификате стенда: это ожидаемо, открыть через «Дополнительно».

Внутренний Docker хранится в томе `me-stage-docker`, поэтому стенд переживает перезапуск Docker.
Почта снаружи на стенд не приходит: письма ходят только между его собственными ящиками.

## Команды

Из корня репозитория (на Windows — в Git Bash):

```bash
scripts/deploy/test/stage.sh up
```

Поднимает сервер, mailcow и панель, заводит первого администратора, подключает mailcow как
почтовый узел и добавляет домен `stage.test`. Первый запуск скачивает несколько ГБ образов и занимает
около 10 минут.

```bash
scripts/deploy/test/stage.sh panel --version sha-<12 символов коммита>
```

Обновляет только панель, данные остаются. Без `--version` берётся текущий коммит; его образы
CI публикует после слияния в `main`.

```bash
scripts/deploy/test/stage.sh status
```

```bash
scripts/deploy/test/stage.sh down --purge
```

`down` удаляет контейнер стенда, `--purge` вместе с его данными.

## Секреты

При первом запуске скрипт пишет `data/stage.env` (каталог `data/` не попадает ни в git, ни в
Docker-образы): секреты панели, ключ API mailcow и первого администратора `PANEL_ADMIN_USER` /
`PANEL_ADMIN_PASSWORD`. Вход в панель на стенде — по логину и паролю.

## Подключение Gmail

1. В Google Cloud: OAuth-клиент типа «Web application», в Authorized redirect URIs —
   `https://localhost/oauth/google/callback`, в JavaScript origins — `https://localhost`. На экране
   согласия режим Testing и адреса Gmail, которые будут подключаться, в Test users. Подробно —
   [google-oauth.md](google-oauth.md).
2. Скачать JSON клиента и добавить приложение: в панели «Настройки → Интеграции → приложения
   Google → Импорт JSON» или из консоли:

   ```bash
   docker exec -i me-stage docker exec -i stage-backend node src/cli/googleApp.js add < data/client_secret_<id>.apps.googleusercontent.com.json
   ```

3. «Добавить аккаунт» → Gmail.
