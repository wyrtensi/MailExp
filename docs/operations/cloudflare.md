# Cloudflare: туннель, Access и токены

Пошаговая настройка Cloudflare для MailExpert: вход через Cloudflare Access на `<CF_HOST>` (режимы
`cf` и `both`), сертификат Caddy через DNS-01 для `<DIRECT_HOST>` (режимы `direct` и `both`) и
двусторонняя синхронизация пользователей панели с политикой Access. **Всё здесь делается до `install.sh`**:
к первому запуску у вас должны быть готовы ключи для `configure.sh`, а маршрут туннеля и приложение
Access уже созданы, тогда `install.sh` сразу проверит их (раздел 7).

Плейсхолдеры:

| Плейсхолдер | Что это | Пример |
|---|---|---|
| `<CF_HOST>` | адрес панели через туннель и Access | `mail.example.com` |
| `<DIRECT_HOST>` | адрес панели напрямую через Caddy | `panel.example.com` |
| `<PANEL_IP>` | публичный IPv4 сервера панели | `203.0.113.10` |
| `<TEAM>` | имя команды Zero Trust: команда живёт на `https://<TEAM>.cloudflareaccess.com` | `example-team` |
| `<ACCOUNT_ID>` | ID аккаунта Cloudflare, 32 шестнадцатеричных символа | |
| `<ZONE_ID>` | ID зоны `example.com` | |
| `<APP_HTTP_PORT>` | порт панели на loopback сервера, `install.sh --http-port`, по умолчанию `8080` | `8080` |
| `<ADMIN_EMAIL>` | адрес Google первого администратора | `admin@example.com` |

Коротко, по кликам — раздел «Подключение Cloudflare — просто»; для агента — «Для агента»; какие
права у какого ключа — «Ключи и права». Полный порядок: разделы 1-5 в Cloudflare и Google, раздел 6 — `install.sh` и `configure.sh`
([quickstart.md](quickstart.md)), раздел 7 — проверка, раздел 8 — синхронизация пользователей
после первого входа. Какие шаги нужны для какого режима:

| Шаг | `cf` | `direct` | `both` |
|---|---|---|---|
| 1. Zero Trust и Google как способ входа | да | нет | да |
| 2. Туннель и маршрут `<CF_HOST>` → `TUNNEL_TOKEN` | да | нет | да |
| 3. Приложение Access → `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE` | да | нет | да |
| 4. `DNS_API_TOKEN` и A-запись `<DIRECT_HOST>` | нет | да | да |
| 5. Токен синхронизации (можно позже, после первого входа) | по желанию | нет | по желанию |

Для `direct` и `both` нужен ещё клиент Google OAuth для «Войти через Google» в саму панель — он не
связан с Cloudflare, см. [deployment.md, раздел 3](deployment.md).

**Интерфейс Cloudflare часто переименовывает пункты меню.** Ниже — названия на момент написания
(октябрь 2026) и, в скобках, прежние. Если пункта нет, ищите по смыслу или делайте шаг через API: у
каждого шага есть вызов API, пути и поля сверены с
[документацией API Cloudflare](https://developers.cloudflare.com/api/). Что сверить не удалось,
помечено «не проверено».

## Подключение Cloudflare — просто

Короткий путь для человека, по кликам, для режимов `cf` и `both`. Подробности каждого шага — в
разделах 1-8 ниже; здесь только порядок.

1. **Команда Zero Trust.** [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust**. Мастер
   спросит имя команды — это `<TEAM>`; план **Free**. Адрес команды — `https://<TEAM>.cloudflareaccess.com`.
2. **Вход через Google.** В Google Cloud Console создайте OAuth-клиент «Web application» с redirect URI
   `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`. В Zero Trust → **Integrations** →
   **Identity providers** → **Add new** → **Google**: вставьте Client ID и Client secret → **Test**
   (раздел 1).
3. **Туннель.** **Networking** → **Tunnels** → **Create a tunnel** → **Cloudflared** → имя `mailexpert`.
   Из показанной команды скопируйте только значение `eyJ...` — это `TUNNEL_TOKEN`; команду не
   запускайте. Вкладка **Routes** → **Add route** → **Published application**: имя `<CF_HOST>`, Service
   URL `http://127.0.0.1:<APP_HTTP_PORT>` (раздел 2).
4. **Приложение Access с одной Allow-политикой.** Zero Trust → **Access controls** → **Applications** →
   **Create new application** → **Self-hosted**: имя `MailExpert`, адрес ровно `<CF_HOST>`. Политика —
   одна: **Allow**, имя `MailExpert users`, Include → **Emails** → `<ADMIN_EMAIL>`. Способ входа —
   Google. После сохранения: **Configure** → **Additional settings** → **Application Audience (AUD)
   Tag** — это `CF_ACCESS_AUDIENCE`; адрес команды из шага 1 — `CF_ACCESS_ISSUER` (раздел 3).
5. **Ключи сервера.** На сервере, от root, файл `cloudflare.env` (только строки нужного режима):

   ```
   TUNNEL_TOKEN=<из шага 3>
   CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com
   CF_ACCESS_AUDIENCE=<AUD из шага 4>
   DNS_API_TOKEN=<только для both: раздел 4>
   ```

   ```bash
   chmod 600 cloudflare.env
   /opt/mailexpert/app/scripts/deploy/configure.sh < cloudflare.env && shred -u cloudflare.env
   /opt/mailexpert/app/scripts/deploy/install.sh        # первая установка — с параметрами из quickstart.md
   ```

6. **Первый вход.** Откройте `https://<CF_HOST>`, войдите через Google как `<ADMIN_EMAIL>` — вы
   администратор.
7. **Токен синхронизации** (по желанию: без него вход работает, но пользователей панели и политику
   придётся вести по отдельности). My Profile → **API Tokens** → **Create Token** → **Custom token**:
   Permissions — **Account · Access: Apps and Policies · Edit**, и больше ничего; Account Resources —
   **Include → ваш аккаунт** (не «All accounts»). По желанию — фильтр по IP сервера и срок действия.
   **Create Token** → скопируйте значение: Cloudflare показывает его один раз.
8. **Ввод в панели.** Настройки администратора → **Синхронизация с Access**: ID аккаунта, ID приложения,
   ID политики (где взять — раздел 5), API-токен в поле токена. Нажмите **Проверить**: панель спросит
   Cloudflare (только чтение) и покажет по строке на токен, приложение, AUD и политику. Проверяются ID
   из формы как есть, пустое поле — «не указано»; пустое поле токена значит сохранённый токен — зелёным, что
   работает, красным, что нет и почему («у токена нет права „Access: Apps and Policies“…», «AUD не
   совпадает с CF_ACCESS_AUDIENCE сервера» и т. д.). Когда всё зелёное — галочка «Синхронизировать…» →
   **Сохранить настройки** → **Синхронизировать сейчас**.
9. **Что видно в панели.** Токен после сохранения не показывается никогда — только «Токен сохранён».
   Ниже, в блоке **Задаётся на сервере**: `CF_ACCESS_ISSUER`, задан ли `CF_ACCESS_AUDIENCE` и вошли ли
   вы через Access. `TUNNEL_TOKEN` и `DNS_API_TOKEN` панель не видит: их состояние показывает
   `status.sh` (раздел 7).

## Для агента

Агент настраивает и проверяет Cloudflare, **не видя ни одного токена**.

**Никогда:**

- не просить токен, секрет или содержимое `.env` в чат и не принимать их оттуда; если человек всё же
  вставил токен в чат — попросить отозвать его и выпустить новый;
- не передавать токен аргументом команды, в URL, в переменной окружения на командной строке, в лог, в
  коммит, issue или PR; не выводить файлы с токенами (`cat`, `jq .`, `env`);
- не выпускать токены шире таблицы «Ключи и права» и не запрашивать «All accounts» / «All zones»;
- не менять и не удалять чужие приложения, политики, туннели и записи DNS; не привязывать политику
  панели к другим приложениям и не добавлять приложению панели вторую Allow-политику;
- не запускать на сервере команду установки `cloudflared` из Zero Trust (коннектор ставит `install.sh`).

**Куда идут токены** (вносит человек, агент только называет команду):

| Значение | Куда |
|---|---|
| токен синхронизации | поле «API-токен» в панели или `mailexpert access token < файл` (stdin) |
| `TUNNEL_TOKEN`, `DNS_API_TOKEN`, `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE` | файл `KEY=VALUE` → `configure.sh < файл` → `install.sh` |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (узел за Access) | файл токена узла → `setup.sh --agent-token-file` ([mail-node.md](mail-node.md)) |

**Что спросить у человека:** режим (`cf`, `both`); `<CF_HOST>`, `<TEAM>`, `<ADMIN_EMAIL>`; ID аккаунта,
приложения и политики (это не секреты, их можно в чат); подтверждение, что токены внесены. Шаги в
панели Cloudflare — по разделу «просто» выше, шаги через API — разделы 0-4 (их запускает человек со
своим временным токеном).

**Что агент делает сам** (на сервере панели, от root; ни одна команда не печатает токен):

```bash
D=/opt/mailexpert/app/scripts/deploy
M=$D/mailexpert-cli.sh
$D/status.sh --json | jq .cf_access          # {"state": "ok", "team": "<TEAM>.cloudflareaccess.com"}
sudo $M access status --json | jq '{config, host}'   # ID, задан ли токен, CF_ACCESS_ISSUER, задан ли AUD
sudo $M access verify --json | jq .          # токен, приложение, AUD, политика: только чтение
sudo $M access config --account <ACCOUNT_ID> --app <APP_ID> --policy <POLICY_ID>
sudo $M access config --enable && sudo $M access sync
```

Как читать `access verify` (поле `checks`, у каждой проверки `id`, `status`, `code`):

| `id` / `code` | Что значит | Что делать |
|---|---|---|
| `token` / `refused` | Cloudflare не принимает токен: неверный, отозван, истёк | человек выпускает новый и вносит в панели или `access token` |
| `token` / `token_disabled`, `token_expired` | токен отключён или просрочен | то же |
| `token` / `forbidden`, `not_found` | токен аккаунта, но ID аккаунта не тот, или токен выпущен в другом аккаунте | ID аккаунта — раздел 5 |
| `app` или `policy` / `forbidden` | у токена нет «Access: Apps and Policies» на этот аккаунт, или ID аккаунта чужой | права токена по таблице ниже; ID аккаунта — раздел 5 |
| `app` / `not_found` | нет приложения с таким ID в аккаунте | ID приложения — раздел 5 |
| `audience` / `mismatch` | `aud` приложения не равен `CF_ACCESS_AUDIENCE` сервера | либо ID приложения не того, что закрывает `<CF_HOST>`, либо AUD на сервере неверный (`configure.sh`) |
| `audience` / `not_configured` | `CF_ACCESS_AUDIENCE` на сервере не задан | шаг 5 раздела «просто» |
| `policy` / `not_found`, `not_attached`, `not_allow` | нет такой политики у приложения; переиспользуемая не привязана; не Allow | раздел 3 и 5 |
| любая / `unreachable`, `unavailable` | сеть сервера или сбой Cloudflare | повторить позже |

Право **Edit** без записи не проверить: его подтверждает первый прогон, который меняет политику
(`access sync` → `updated`; ошибка `Cloudflare updatePolicy failed (403)` значит, что у токена только Read).

Если всё же нужен прямой вызов API на сервере (например, прочитать `aud`), токен передаётся curl из
файла заголовков, а не командной строкой: человек кладёт строку `Authorization: Bearer <токен>` в
`/root/cf-auth.txt` (`chmod 600`), агент вызывает

```bash
curl -fsS -H @/root/cf-auth.txt https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/access/apps/<APP_ID> \
  | jq '{name: .result.name, aud: .result.aud, domain: .result.domain}'
```

и после работы — `shred -u /root/cf-auth.txt`.

## Ключи и права

Какие значения Cloudflare нужны MailExpert, где каждое живёт, какие права у токенов и какие вызовы
API делает код. Права названы, как в мастере токенов (**тип · группа · уровень**); в списке групп API
то же называется `Access: Apps and Policies Write`, `DNS Write`, `Zone Read`.

| Значение | Что это | Где хранится, как вносится | Права в Cloudflare и ресурс | Обязательно |
|---|---|---|---|---|
| токен синхронизации | API-токен | база панели, зашифрован (`ENCRYPTION_KEY`); поле в панели или `access token` (stdin); обратно не отдаётся, видно только «сохранён» | **Account · Access: Apps and Policies · Edit** на один аккаунт `<ACCOUNT_ID>`. Больше ничего | только для синхронизации пользователей |
| ID аккаунта, приложения, политики | не секреты | база панели; панель или `access config` | — | вместе с токеном синхронизации |
| `CF_ACCESS_ISSUER` | адрес команды, не секрет | `<prefix>/.env` через `configure.sh`; в панели — только показ | токен не нужен | `cf`, `both` |
| `CF_ACCESS_AUDIENCE` | AUD-тег приложения, не секрет | `<prefix>/.env` через `configure.sh`; в панели — только «задан / не задан» | токен не нужен | `cf`, `both` |
| `TUNNEL_TOKEN` | ключ коннектора одного туннеля, **не** API-токен | `<prefix>/edge/.env` через `configure.sh`; читает контейнер `cloudflared` | групп прав нет: кто знает ключ, может подключить коннектор этого туннеля — храните как секрет | `cf`, `both` |
| `DNS_API_TOKEN` | API-токен | `<prefix>/edge/.env` через `configure.sh`; читает Caddy | **Zone · DNS · Edit** и **Zone · Zone · Read** на одну зону `example.com` | `direct`, `both` (кроме `--edge-tls internal`) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | service token Access, **не** API-токен | `agent.env` почтового узла через `setup.sh --agent-token-file` | групп прав нет; в приложении Access панели — политика с действием **Service Auth**, которая его пускает | только если узел ходит к панели через Access |
| временный широкий токен | API-токен | только машина человека, отозвать после настройки | раздел 0 | только для настройки через API |

Не давайте токену синхронизации: `Access: Organizations, Identity Providers, and Groups`, `Access: Service
Tokens`, `Cloudflare Tunnel`, `Account Settings`, любые права на зону. Код их не использует.

Вызовы API по токенам — ровно те, что делает код:

| Токен | Вызов | Кто и когда | Нужное право |
|---|---|---|---|
| синхронизации | `GET /user/tokens/verify`, для токена аккаунта — `GET /accounts/<ACCOUNT_ID>/tokens/verify` | «Проверить», `access verify` | никакого: токен проверяет сам себя |
| синхронизации | `GET /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>` | «Проверить», `access verify` (сверка `aud`) | Access: Apps and Policies · Read (входит в Edit) |
| синхронизации | `GET /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies/<POLICY_ID>` | каждый прогон, «Проверить» | Read (входит в Edit) |
| синхронизации | `GET /accounts/<ACCOUNT_ID>/access/policies/<POLICY_ID>` | только если предыдущий ответил 404: есть ли политика в аккаунте, но не у приложения | Read (входит в Edit) |
| синхронизации | `PUT /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies/<POLICY_ID>`, для переиспользуемой — `PUT /accounts/<ACCOUNT_ID>/access/policies/<POLICY_ID>` | прогон, когда список адресов изменился | **Edit** |
| — | `GET https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/certs` | backend, проверка подписи токена Access при входе | без токена: ключи публичные |
| `DNS_API_TOKEN` | поиск зоны и запись/удаление TXT `_acme-challenge` | модуль `caddy-dns/cloudflare` в Caddy при выпуске и продлении сертификата (не код MailExpert) | Zone Read, DNS Edit |
| `TUNNEL_TOKEN` | соединение коннектора с Cloudflare (исходящие 7844) | контейнер `cloudflared` | — |

**Почему часть значений вносится только на сервере.** Токен синхронизации и три ID панель хранит сама и
применяет без перезапуска: следующий прогон берёт новые значения, ошибка в них ломает только
синхронизацию, а «Проверить» ловит её до сохранения. Остальное — на сервере, и это сознательно:

- `CF_ACCESS_ISSUER` и `CF_ACCESS_AUDIENCE` решают, чьей подписи панель верит при каждом входе. Ошибка
  в них закрывает вход всем, включая администратора, который мог бы её исправить, а возможность менять
  их из панели позволила бы украденной сессии администратора подставить чужую команду Access и
  входить под любым адресом. Их же сверяют с Cloudflare `install.sh` и `status.sh` — из файла на
  сервере. Применяются перезапуском: `configure.sh`, затем `install.sh`.
- `TUNNEL_TOKEN` и `DNS_API_TOKEN` читают контейнеры края (`cloudflared`, Caddy), а не backend; панель
  их не видит и перезапустить край не может. Канал «панель → хост» для обновлений принимает только
  проверенный номер сборки и никогда — данные, которые доходят до файлов или команд root, поэтому
  секреты края через него не передаются.

## 0. Токены: временный широкий → узкие → отзыв

Мастеру в панели Cloudflare токены не нужны. Для пути через API удобно так:

1. **Временный широкий токен** (только на вашей машине, срок жизни — сутки). My Profile → API
   Tokens → Create Token → Custom token. Права из столбца «временный» таблицы ниже, ресурсы —
   аккаунт `<ACCOUNT_ID>` и зона `example.com`, «TTL» — завтрашняя дата. Им вы создаёте туннель,
   приложение Access и записи DNS, а заодно — два узких токена.
2. **Узкие токены** — только с теми правами, что нужны серверу: `DNS_API_TOKEN` (Caddy) и токен
   синхронизации (панель). Каждый — на один ресурс.
3. **Отзыв временного** сразу после настройки: My Profile → API Tokens → … → Delete, или
   `DELETE /user/tokens/<TOKEN_ID>`.

| Токен | Где живёт | Права (в мастере токенов) | Ресурс |
|---|---|---|---|
| временный (настройка через API) | только ваша машина, удалить после шага 8 | Account · Cloudflare Tunnel · Edit (в новом списке прав — «Cloudflare One Connector: cloudflared Write» или «Cloudflare One Connectors Write»); Account · Access: Apps and Policies · Edit; Account · Access: Organizations, Identity Providers, and Groups · Edit; Zone · DNS · Edit; Zone · Zone · Read; чтобы выпускать узкие токены — User · API Tokens · Edit | аккаунт `<ACCOUNT_ID>`, зона `example.com` |
| `TUNNEL_TOKEN` | `<prefix>/edge/.env` через `configure.sh` | это не API-токен, а ключ коннектора одного туннеля: он даёт только право подключиться этим туннелем | один туннель |
| `DNS_API_TOKEN` | `<prefix>/edge/.env` через `configure.sh` | Zone · DNS · Edit и Zone · Zone · Read (их требует модуль DNS-01 Caddy) | одна зона `example.com` |
| токен синхронизации | база панели, зашифрован; вносится в панели или `mailexpert access token` | Account · Access: Apps and Policies · Edit | один аккаунт `<ACCOUNT_ID>` |

Через API узкий токен создаётся так (ID групп прав не постоянны, их берут из списка, не из этой
инструкции):

```bash
export CF_API=https://api.cloudflare.com/client/v4
export CF_TOKEN=<временный токен>          # только в этой оболочке, не в истории: read -s CF_TOKEN
curl -fsS "$CF_API/user/tokens/permission_groups" -H "Authorization: Bearer $CF_TOKEN" \
  | jq -r '.result[] | "\(.id)  \(.name)"' | grep -Ei 'dns|zone read|apps and policies'

# DNS_API_TOKEN: DNS Edit и Zone Read на одну зону
curl -fsS -X POST "$CF_API/user/tokens" -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{
    "name": "mailexpert-dns01",
    "policies": [{
      "effect": "allow",
      "resources": {"com.cloudflare.api.account.zone.<ZONE_ID>": "*"},
      "permission_groups": [{"id": "<ID группы DNS Write>"}, {"id": "<ID группы Zone Read>"}]
    }]
  }' | jq -r .result.value > /root/dns-token.txt     # значение показывается один раз

# токен синхронизации: Access: Apps and Policies Write на один аккаунт
curl -fsS -X POST "$CF_API/user/tokens" -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{
    "name": "mailexpert-access-sync",
    "policies": [{
      "effect": "allow",
      "resources": {"com.cloudflare.api.account.<ACCOUNT_ID>": "*"},
      "permission_groups": [{"id": "<ID группы Access: Apps and Policies Write>"}]
    }]
  }' | jq -r .result.value > /root/access-sync-token.txt

# в конце: отозвать временный токен (его ID — в GET /user/tokens)
curl -fsS -X DELETE "$CF_API/user/tokens/<TOKEN_ID>" -H "Authorization: Bearer $CF_TOKEN"
```

Создавать токены через API может только токен с правом «API Tokens Edit». Токены, принадлежащие
аккаунту, а не пользователю, создаются тем же телом по `POST /accounts/<ACCOUNT_ID>/tokens`. Файлы с
токенами — `chmod 600`, после внесения — `shred -u`.

## 1. Zero Trust и вход через Google

Нужен для `cf` и `both`.

**В панели Cloudflare.**

1. Dashboard → **Zero Trust**. При первом входе мастер просит имя команды (team name) — это `<TEAM>`,
   адрес команды будет `https://<TEAM>.cloudflareaccess.com`. Выберите план **Free** (до 50
   пользователей; Cloudflare может попросить способ оплаты даже для него).
2. Посмотреть имя команды позже: Zero Trust → **Settings** (прежде Settings → Custom Pages →
   Team domain).
3. Клиент Google для Access — в [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   Create credentials → OAuth client ID → Web application:
   - Authorized JavaScript origins: `https://<TEAM>.cloudflareaccess.com`
   - Authorized redirect URIs: `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`

   Это отдельный клиент: не тот, что для «Войти через Google» на `<DIRECT_HOST>`, и не приложения
   для Gmail-ящиков из [google-oauth.md](google-oauth.md).
4. Zero Trust → **Integrations** → **Identity providers** (прежде Settings → Authentication → Login
   methods) → **Add new identity provider** → **Google**. Вставьте Client ID и Client secret,
   сохраните, нажмите **Test**.

**Через API.**

```bash
# адрес команды (auth_domain), если команда уже есть
curl -fsS "$CF_API/accounts/<ACCOUNT_ID>/access/organizations" -H "Authorization: Bearer $CF_TOKEN" \
  | jq -r .result.auth_domain                       # <TEAM>.cloudflareaccess.com

# Google как способ входа
curl -fsS -X POST "$CF_API/accounts/<ACCOUNT_ID>/access/identity_providers" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"name": "Google", "type": "google",
           "config": {"client_id": "<GOOGLE_CLIENT_ID>", "client_secret": "<GOOGLE_CLIENT_SECRET>"}}' \
  | jq -r .result.id                                # <IDP_ID>, пригодится в шаге 3
```

Первичное создание организации Zero Trust (выбор имени команды и плана) делайте в панели: создание
через API (`POST /accounts/<ACCOUNT_ID>/access/organizations`) здесь не проверено.

## 2. Туннель и маршрут `<CF_HOST>`

Нужен для `cf` и `both`. Туннель «управляется удалённо» (remotely managed): его маршруты хранятся
в Cloudflare, а сервер запускает `cloudflared` только с токеном. `cloudflared` ставит сам
`install.sh` (контейнер в проекте `edge`), **на сервере ничего из инструкции Cloudflare не
запускайте**.

**В панели Cloudflare.**

1. **Networking** → **Tunnels** (прежде Zero Trust → Networks → Tunnels) → **Create a tunnel** →
   тип **Cloudflared** → имя, например `mailexpert`.
2. На шаге установки Cloudflare показывает команду вида `cloudflared service install eyJhIjoi...`
   (или `cloudflared tunnel run --token eyJhIjoi...`). Скопируйте **только значение `eyJ...` после
   `install` или `--token`** — это
   `TUNNEL_TOKEN`. Команду не запускайте. Позже токен открывается там же: туннель → Configure (или
   кнопка с командой установки).
3. Маршрут: туннель → вкладка **Routes** → **Add route** → **Published application** (прежде
   вкладка **Public Hostname** → Add a public hostname):
   - Subdomain: `mail`, Domain: `example.com` (вместе — `<CF_HOST>`), Path — пусто;
   - Service URL: `http://127.0.0.1:<APP_HTTP_PORT>` (в старой форме: Type `HTTP`, URL
     `127.0.0.1:<APP_HTTP_PORT>`).

   Именно `http`, не `https`: TLS закрывает Cloudflare, а панель слушает обычный HTTP только на
   loopback ([ports.md](ports.md)). Cloudflare сам создаёт CNAME `<CF_HOST>` →
   `<TUNNEL_ID>.cfargotunnel.com` с оранжевым облаком.

**Через API.**

```bash
# туннель, управляемый из Cloudflare; ответ содержит id и token
curl -fsS -X POST "$CF_API/accounts/<ACCOUNT_ID>/cfd_tunnel" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"name": "mailexpert", "config_src": "cloudflare"}' | jq -r .result.id      # <TUNNEL_ID>

# токен туннеля (TUNNEL_TOKEN) — в файл, не на экран
curl -fsS "$CF_API/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/token" \
  -H "Authorization: Bearer $CF_TOKEN" | jq -r .result > /root/tunnel-token.txt

# маршрут: <CF_HOST> -> панель; последнее правило ловит всё остальное
curl -fsS -X PUT "$CF_API/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"config": {"ingress": [
            {"hostname": "<CF_HOST>", "service": "http://127.0.0.1:<APP_HTTP_PORT>", "originRequest": {}},
            {"service": "http_status:404"}]}}'

# DNS: при маршруте через API запись не создаётся сама
curl -fsS -X POST "$CF_API/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"type": "CNAME", "name": "<CF_HOST>", "content": "<TUNNEL_ID>.cfargotunnel.com", "proxied": true}'
```

`<ZONE_ID>` — на странице зоны в панели (Overview → API → Zone ID) или
`GET /zones?name=example.com` (`.result[0].id`). `configure.sh` проверяет форму `TUNNEL_TOKEN`:
это base64 от JSON с полями `a` (аккаунт), `t` (туннель) и `s` (секрет); строка, скопированная с
`cloudflared service install` или кавычками, будет отклонена без вывода значения.

## 3. Приложение Access для `<CF_HOST>`

Нужен для `cf` и `both`. Без него `<CF_HOST>` открыт всему интернету, а панель отвечает «не вошли»
каждому. Создавайте его сразу вместе с маршрутом, до `install.sh`.

**В панели Cloudflare.**

1. Zero Trust → **Access controls** → **Applications** (прежде Access → Applications) → **Create new
   application** (Add an application) → **Self-hosted and private** (Self-hosted).
2. Имя — `MailExpert`. **Add public hostname**: Subdomain `mail`, Domain `example.com`, Path пусто —
   ровно `<CF_HOST>`, без пути и без `*`.
3. Политика: **Create new policy** (или **Add a policy**) → имя `MailExpert users`, Action
   **Allow**, правило Include → **Emails** → `<ADMIN_EMAIL>` (и другие администраторы из
   `--admin-email`). Эту политику потом ведёт синхронизация (раздел 8), поэтому именно Allow и
   именно правило по адресам. Правило по домену почты не нужно: кого пускать, решает список адресов.
4. Login methods: оставьте **Google** (можно включить «Instant Auth», чтобы сразу уходить на
   Google). Сохраните приложение.
5. **`CF_ACCESS_AUDIENCE`**: Applications → MailExpert → **Configure** → **Additional settings**
   (прежде вкладка Overview) → **Application Audience (AUD) Tag**: 64 шестнадцатеричных символа.
6. **`CF_ACCESS_ISSUER`**: `https://<TEAM>.cloudflareaccess.com` — адрес команды из шага 1, со
   схемой `https://` и без `/` в конце.

**Одна панель — одно приложение Access — одна Allow-политика.** У каждой панели своё приложение и
ровно одна переиспользуемая Allow-политика, которая больше ни к чему не привязана. Access пропускает
каждого, кого пропускает **любая** из привязанных к приложению Allow-политик, а синхронизация ведёт
только одну: адрес из второй политики войдёт в панель (и получит учётную запись при первом входе), но
синхронизация его не увидит и не сможет убрать. По той же причине не привязывайте политику панели к
другим приложениям: всё, что панель в неё пишет, откроет и их.

**Через API.**

```bash
# Allow-политика по адресам (переиспользуемая): её ID нужен синхронизации
curl -fsS -X POST "$CF_API/accounts/<ACCOUNT_ID>/access/policies" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"name": "MailExpert users", "decision": "allow",
           "include": [{"email": {"email": "<ADMIN_EMAIL>"}}]}' | jq -r .result.id    # <POLICY_ID>

# самостоятельно размещённое приложение на <CF_HOST> с этой политикой и входом через Google
curl -fsS -X POST "$CF_API/accounts/<ACCOUNT_ID>/access/apps" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"name": "MailExpert", "type": "self_hosted", "domain": "<CF_HOST>",
           "session_duration": "24h", "allowed_idps": ["<IDP_ID>"], "auto_redirect_to_identity": true,
           "policies": [{"id": "<POLICY_ID>"}]}' | jq '{id: .result.id, aud: .result.aud}'
```

`aud` из ответа — это `CF_ACCESS_AUDIENCE`, `id` — `<APP_ID>` для синхронизации. Его же можно
прочитать позже: `GET /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>` → `.result.aud`.
Не проверено: поле `destinations` вместо `domain` (документация называет его новой формой);
вызов выше использует `domain`, который API по-прежнему принимает.

## 4. `DNS_API_TOKEN` и A-запись `<DIRECT_HOST>`

Нужен для `direct` и `both` (кроме `--edge-tls internal` на стендах).

**В панели Cloudflare.**

1. Зона `example.com` → **DNS** → **Records** → **Add record**: Type `A`, Name `panel` (вместе —
   `<DIRECT_HOST>`), IPv4 `<PANEL_IP>`, **Proxy status: DNS only** (серое облако), TTL 300.
   Серое облако обязательно: TLS закрывает Caddy на сервере, а «Войти через Google» ходит на сам
   сервер.
2. Токен: My Profile → **API Tokens** → **Create Token** → шаблон **Edit zone DNS** → Permissions:
   Zone · DNS · Edit, добавьте Zone · Zone · Read; Zone Resources: Include → Specific zone →
   `example.com`. Сохраните значение — это `DNS_API_TOKEN`.

Caddy выпускает по нему сертификат через DNS-01 — для `<DIRECT_HOST>` из трёх и более частей это
сертификат на `*.example.com`, чтобы точное имя не попадало в журналы Certificate Transparency.
Порты 80 и 443 на сервере при этом открыты (`install.sh` включает их в `ufw`).

**Через API.**

```bash
curl -fsS -X POST "$CF_API/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  --data '{"type": "A", "name": "<DIRECT_HOST>", "content": "<PANEL_IP>", "proxied": false, "ttl": 300}'
```

Сам токен через API — в разделе 0.

## 5. Токен и три ID для синхронизации

Можно отложить до первого входа (раздел 8), но собрать удобно сейчас. Вносятся они в панели
(раздел «Синхронизация с Access», кнопка «Проверить» сверяет их с Cloudflare до сохранения) или
командами `access token` и `access config`; права токена — в разделе «Ключи и права».

| Что | Где взять |
|---|---|
| ID аккаунта (`<ACCOUNT_ID>`) | любая зона → Overview → API → Account ID; или `GET /accounts` |
| ID приложения (`<APP_ID>`, UUID) | Access controls → Applications → MailExpert → Configure: в адресе страницы; или `id` из шага 3 |
| ID политики (`<POLICY_ID>`, UUID) | Access controls → Policies → MailExpert users: в адресе страницы; или `id` из шага 3; или `GET /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies` |
| токен | раздел 0: Account · Access: Apps and Policies · Edit на один аккаунт |

Политика должна быть Allow. Синхронизация работает и с переиспользуемой политикой (Policies), и с
политикой внутри приложения; переиспользуемая должна быть привязана к этому приложению. Других
Allow-политик у приложения быть не должно (раздел 3).

## 6. Установка

Теперь — [quickstart.md](quickstart.md) или [deployment.md, раздел 2](deployment.md) с нужным
`--signin`. В файл для `configure.sh` идут только те ключи, которые назвал `install.sh`:

```
TUNNEL_TOKEN=<из шага 2>
CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com
CF_ACCESS_AUDIENCE=<AUD из шага 3>
DNS_API_TOKEN=<из шага 4>
```

`configure.sh` проверяет форму каждого значения и называет ошибку, не печатая само значение:
`CF_ACCESS_AUDIENCE` — ровно 64 шестнадцатеричных символа в нижнем регистре, `CF_ACCESS_ISSUER` —
`https://<TEAM>.cloudflareaccess.com`, `TUNNEL_TOKEN` — base64 с полями `a`, `t`, `s`.

## 7. Проверка

`install.sh` в режимах `cf` и `both` после запуска туннеля сам спрашивает
`https://<CF_HOST>/api/health` с сервера — без cookies и без перехода по редиректу — и ждёт ответа
Access: редирект на `https://<TEAM>.cloudflareaccess.com/...`. Команду из адреса редиректа он
сравнивает с `CF_ACCESS_ISSUER`. Если в приложении включён managed OAuth и Access ответит `401` с
`WWW-Authenticate: Bearer resource_metadata="https://<CF_HOST>/.well-known/oauth-protected-resource"`,
это тоже считается «Access на месте», но команда в таком ответе не названа и не сравнивается. Результат — строка `edge: ...`; несовпадение и отсутствие Access —
предупреждение с точным следующим шагом, **установку оно не останавливает** (DNS может
обновляться минуты). Ждёт он не дольше `MAILEXPERT_CF_CHECK_TIMEOUT` секунд (по умолчанию 60) и
только то, что может пройти само (DNS, коннектор). `update.sh` запускает `install.sh`, поэтому проверка
идёт и при каждом обновлении. Ту же проверку в любой момент повторяет `status.sh`:

```bash
/opt/mailexpert/app/scripts/deploy/status.sh            # cf_access  ok | warning: cloudflare access: ...
/opt/mailexpert/app/scripts/deploy/status.sh --json | jq .cf_access     # {"state": "ok", "team": "<TEAM>.cloudflareaccess.com"}
```

Состояния `cf_access`: `ok`, `dns_missing`, `unreachable`, `tunnel_down`, `origin_error`,
`access_missing`, `redirect_elsewhere`, `team_mismatch`.

Чего эта проверка **не** доказывает: Access отвечает раньше туннеля, поэтому `ok` значит «имя
указывает на Cloudflare и закрыто Access вашей команды», но не «туннель довёл запрос до панели».
Это показывает только вход: откройте `https://<CF_HOST>` в браузере, войдите через Google как
`<ADMIN_EMAIL>` — откроется панель, и вы станете администратором.

## 8. Синхронизация пользователей с Access

После первого входа администратора. Членство в Allow-политике приложения панели и учётная запись в
панели — одно и то же, и MailExpert держит их в согласии в обе стороны:

- **Из панели в Cloudflare.** Пользователь, добавленный в панели (или включённый снова), попадает в
  политику за несколько секунд; отключённый или удалённый уходит из неё. Весь список сверяется раз
  в час. Панель убирает из политики только адреса, которые сама туда записала.
- **Из Cloudflare в панель.** Адрес, добавленный в политику в панели Cloudflare, на следующем прогоне
  становится пользователем панели (не администратором) и с этого момента ведётся синхронизацией как
  свой; в журнале — `access.user_imported` от «Cloudflare Access». Если адрес, который записала
  панель, в Cloudflare убрали, пользователь отключается (`user.disabled`, на экране пользователей —
  «Удалён в Cloudflare»). Вернуть адрес в политику мало: пользователь остаётся отключённым, пока
  администратор не включит его в панели.
- **Вход.** Любой адрес, который пропустил Access (токен Access проверен), получает учётную запись
  при первом входе — и при включённой синхронизации тоже, так же, как если бы его добавил прогон.
  Отказ получают только отключённый пользователь (`user_disabled`) и удалённый или сменивший адрес
  (`user_deleted`, см. ниже).
- **Пользователи по правилу домена или группы.** Если Access пропустил человека не по его адресу, а
  по правилу домена или группы (адреса нет среди правил Emails политики на момент последнего
  удачного прогона), учётная запись создаётся с пометкой «По правилу Access», и синхронизация **не**
  дописывает его адрес в политику: иначе отдельное правило по адресу пережило бы удаление правила
  домена или группы. Если позже в Cloudflare добавить правило именно по его адресу, следующий прогон
  делает пользователя «своим» (снимает пометку, дальше как с остальными). Одобрение администратором
  («Разрешить снова», «Сменить email») тоже снимает пометку, и адрес пишется в политику.
- **Удалённые пользователи и заменённые адреса.** Удаление в панели запоминает адрес (причина
  `deleted`), смена или удаление адреса у пользователя — прежний адрес (причина `email_changed`):
  синхронизация не вернёт его из политики, а вход с ним через Access отклоняется, даже пока Cloudflare
  ещё перечисляет адрес или у человека не истёк токен Access. Учётные записи, удалённые до обновления,
  попадают в список из журнала (`user.deleted`). Список — в разделе «Синхронизация с Access» →
  «Удалённые пользователи и заменённые адреса» и в `mailexpert access tombstones`. «Разрешить снова» (`access allow <EMAIL>`, или
  просто одобрить адрес заново: экран «Пользователи», `user create <EMAIL>`) снимает запрет и создаёт
  пользователя.
- **Что панель не трогает.** Группы, правила по домену и прочие типы правил остаются как есть; адреса
  удалённых пользователей, которые кто-то оставил в политике, тоже.
- **Лимиты.** Прогон, который отключил бы больше `ACCESS_SYNC_MAX_DISABLES` (по умолчанию 10)
  пользователей или больше половины активных либо добавил бы из политики больше
  `ACCESS_SYNC_MAX_IMPORTS` (по умолчанию 10) новых, останавливается целиком, ничего не меняя, и пишет
  в журнал `access.sync_aborted` или `access.import_aborted` (по разу на каждый новый набор адресов).
  `0` останавливает любой прогон с отключениями или добавлениями. Пока прогон стоит, человек из
  политики всё равно получает учётную запись при первом входе. Если синхронизацию включают на
  политике, где уже много адресов, поднимите `ACCESS_SYNC_MAX_IMPORTS` в `.env` на время первого
  прогона.
- **Повторы.** Прогон, упавший из-за сети, тайм-аута, ответа 5xx или 429 от Cloudflare, повторяется
  через 1, 5 и 15 минут; если Cloudflare прислал `Retry-After` больше этого срока, панель ждёт столько,
  сколько он просит. Ошибки токена, прав и настроек (401, 403, 404, `policy_not_allow`,
  `policy_not_attached`) не повторяются: их исправляет администратор. Время следующей попытки видно
  на экране и в `mailexpert access status`; после трёх неудач дальше пробует ежечасный прогон.

В панели: настройки администратора, раздел «Синхронизация с Access»: ID аккаунта, приложения и
политики, API-токен, галочка «Синхронизировать…», «Сохранить настройки», «Проверить» (сверяет
токен, приложение, AUD и политику с Cloudflare, только чтение, ничего не сохраняя; пустые поля
значат «не указано», пустое поле токена — сохранённый токен), «Синхронизировать сейчас»; блок «Задаётся на сервере» показывает
`CF_ACCESS_ISSUER`, задан ли `CF_ACCESS_AUDIENCE` и вошли ли вы через Access;
ниже — итог последнего прогона (добавлено и удалено в политике, добавлено из Cloudflare, отключено,
ошибки, следующая попытка) и «Удалённые пользователи». На экране «Пользователи» у каждого — метка:
«В Access», «Ещё не в Access» (запишется следующим прогоном), «По правилу Access» (вошёл по правилу
домена или группы, в политику не пишется), «Удалён в Cloudflare» или «Без синхронизации»; там же —
«Сменить email».

Или с сервера, через CLI панели ([cli.md, раздел 3.6](cli.md)):

```bash
M=/opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh
$M access token < /root/access-sync-token.txt && shred -u /root/access-sync-token.txt
$M access config --account <ACCOUNT_ID> --app <APP_ID> --policy <POLICY_ID>
$M access verify                   # токен, приложение, AUD, политика: только чтение
$M access config --enable
$M access sync                     # прогон в backend и его итог: updated / unchanged
$M access status                   # последний прогон: добавлено из Cloudflare, ошибки, следующая попытка
$M access tombstones               # удалённые пользователи
$M access allow <EMAIL>            # разрешить удалённого снова
```

Токен читается только со stdin и никогда не печатается. После этого отзовите временный токен
(раздел 0).

### Запасной вход через Google без Access

Если Cloudflare Access недоступен (сбой Zero Trust, ошибка в политике), в панель можно войти напрямую
через Google на втором имени без Access — режим `both` ([deployment.md, раздел 3](deployment.md)):

- `<DIRECT_HOST>` — дополнительный адрес панели в `APP_ALT_URLS`, его обслуживает Caddy, приложения
  Access на нём нет;
- `AUTH_GOOGLE_CLIENT_ID` и `AUTH_GOOGLE_CLIENT_SECRET` — клиент Google OAuth;
- в том же клиенте Google — redirect URI `https://<DIRECT_HOST>/oauth/login/google/callback`.

Этот вход пускает только тех, кто уже есть в панели и не отключён, и администраторов из
`BOOTSTRAP_ADMIN_EMAILS`; незнакомый адрес получает `not_allowed`. Новые учётные записи этот вход
создаёт только для администраторов из `BOOTSTRAP_ADMIN_EMAILS`. Сессия, открытая через Cloudflare, на этом имени не действует: ей нужен заголовок Access
на каждом запросе.

## 9. Неполадки

| Признак | Причина | Что делать |
|---|---|---|
| Вход через Access проходит, панель отвечает `401` `{"error":"not_authenticated"}` («invalid identity token») | токен Access не прошёл проверку панели: `CF_ACCESS_ISSUER` не той команды или `CF_ACCESS_AUDIENCE` не того приложения | `status.sh`: `team_mismatch` называет нужную команду; AUD — шаг 3.5. Внесите верные значения через `configure.sh`, затем `install.sh` |
| `403` `user_deleted` | пользователя с этим адресом удалили в панели или сменили ему адрес, а Access его ещё пропускает | если доступ нужен — «Разрешить снова» в разделе «Синхронизация с Access» или `mailexpert access allow <EMAIL>` |
| `403` `user_disabled` | пользователь отключён в панели (или синхронизацией после удаления адреса из политики); возврат адреса в политику его не включает | включите его в панели; проверьте журнал (`user.disabled` от «Cloudflare Access») |
| «Войти через Google» на `<DIRECT_HOST>`: `not_allowed` | запасной вход пускает только пользователей панели и `BOOTSTRAP_ADMIN_EMAILS` | одобрите адрес в панели или войдите через Access |
| Человека добавили в политику в Cloudflare, а пользователем панели он не стал | прогон остановлен лимитом (`access.import_aborted`), адрес удалён в панели или у него уже есть отключённая учётная запись | `mailexpert access status`, `access tombstones`; при первом включении поднимите `ACCESS_SYNC_MAX_IMPORTS`; при первом входе через Access учётная запись всё равно создастся |
| Синхронизация: `failed` и «Следующая попытка в …» | сеть, тайм-аут, 5xx или 429 от Cloudflare | подождать: повторы через 1, 5 и 15 минут, затем ежечасный прогон; `access sync` запускает прогон сразу |
| Бесконечные редиректы между `<CF_HOST>` и `<TEAM>.cloudflareaccess.com` | у маршрута туннеля `https://` вместо `http://`; второе приложение Access или правило перенаправления на `*.example.com`; браузер блокирует cookies `CF_Authorization` | Service URL — `http://127.0.0.1:<APP_HTTP_PORT>`; одно приложение на `<CF_HOST>` без пути; очистите cookies обоих имён, попробуйте другой браузер |
| Cloudflare `Error 1033`, HTTP 530 (`tunnel_down`) | ни один коннектор этого туннеля не подключён, или `<CF_HOST>` — маршрут другого туннеля | `docker compose -p edge logs cloudflared`; на сервере тот ли `TUNNEL_TOKEN`; туннель в Zero Trust должен быть Healthy; исходящие 7844 TCP/UDP открыты ([ports.md](ports.md)) |
| HTTP 502 / 504 (`origin_error`) | туннель подключён, но не достучался до панели | маршрут на `http://127.0.0.1:<APP_HTTP_PORT>` (порт — `APP_HTTP_PORT` в `<prefix>/.env`); панель запущена: `status.sh` |
| `<CF_HOST>` открывается без входа, `status.sh`: `access_missing` | приложения Access нет или оно на другом имени/пути | шаг 3: приложение ровно на `<CF_HOST>` |
| `access_missing` с кодом 403, а в браузере вход через Access работает | раньше Access ответило правило безопасности Cloudflare (WAF, Bot Fight Mode) на запрос `curl` с сервера | проверка ошиблась, не установка; сверьте события Security → Events зоны, при желании разрешите адрес сервера |
| `dns_missing` | у `<CF_HOST>` нет записи DNS или она ещё не разошлась | маршрут туннеля создаёт CNAME сам; через API — шаг 2; подождите несколько минут и повторите `status.sh` |
| `redirect_elsewhere` | имя перенаправляет не на Access (правило Redirect, другой сервис) | уберите перенаправление, создайте приложение Access |
| Caddy не получает сертификат `<DIRECT_HOST>` | у `DNS_API_TOKEN` нет DNS Edit или Zone Read на эту зону, или токен на другую зону | шаг 4; `docker compose -p edge logs caddy` |
| `configure.sh`: `TUNNEL_TOKEN: must be the token of a remotely managed tunnel` | скопирована вся команда, кавычки или токен туннеля, управляемого локально | только значение `eyJ...` после `install` или `--token`, шаг 2 |
| Синхронизация: `policy_not_allow`, `policy_not_attached`, `Cloudflare getPolicy failed (403)` | не Allow-политика; политика не привязана к приложению; у токена нет «Access: Apps and Policies Edit» | раздел 5; «Проверить» в панели или `mailexpert access verify` называет, что именно не так |
| «Проверить» зелёное, а прогон: `Cloudflare updatePolicy failed (403)` | у токена Access: Apps and Policies только Read | выпустите токен с Edit (раздел «Ключи и права») |
| «Проверить»: AUD не совпадает | ID приложения не того, что закрывает `<CF_HOST>`, или `CF_ACCESS_AUDIENCE` на сервере неверный | сверьте ID приложения (раздел 5) и AUD (шаг 3.5); AUD меняется только `configure.sh` + `install.sh` |

Ссылки: [туннель через API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
[приложение Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/),
[проверка токена Access и AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Google как способ входа](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/),
[токены через API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/),
[ошибки туннеля](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/).
