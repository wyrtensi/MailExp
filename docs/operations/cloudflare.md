# Cloudflare: туннель, Access и токены

Пошаговая настройка Cloudflare для MailExpert: вход через Cloudflare Access на `<CF_HOST>` (режимы
`cf` и `both`), сертификат Caddy через DNS-01 для `<DIRECT_HOST>` (режимы `direct` и `both`) и
синхронизация одобренных пользователей в политику Access. **Всё здесь делается до `install.sh`**:
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

Порядок такой: разделы 1-5 в Cloudflare и Google, раздел 6 — `install.sh` и `configure.sh`
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
   именно правило по адресам.
4. Login methods: оставьте **Google** (можно включить «Instant Auth», чтобы сразу уходить на
   Google). Сохраните приложение.
5. **`CF_ACCESS_AUDIENCE`**: Applications → MailExpert → **Configure** → **Additional settings**
   (прежде вкладка Overview) → **Application Audience (AUD) Tag**: 64 шестнадцатеричных символа.
6. **`CF_ACCESS_ISSUER`**: `https://<TEAM>.cloudflareaccess.com` — адрес команды из шага 1, со
   схемой `https://` и без `/` в конце.

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

Можно отложить до первого входа (раздел 8), но собрать удобно сейчас.

| Что | Где взять |
|---|---|
| ID аккаунта (`<ACCOUNT_ID>`) | любая зона → Overview → API → Account ID; или `GET /accounts` |
| ID приложения (`<APP_ID>`, UUID) | Access controls → Applications → MailExpert → Configure: в адресе страницы; или `id` из шага 3 |
| ID политики (`<POLICY_ID>`, UUID) | Access controls → Policies → MailExpert users: в адресе страницы; или `id` из шага 3; или `GET /accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies` |
| токен | раздел 0: Account · Access: Apps and Policies · Edit на один аккаунт |

Политика должна быть Allow. Синхронизация работает и с переиспользуемой политикой (Policies), и с
политикой внутри приложения; переиспользуемая должна быть привязана к этому приложению.

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

После первого входа администратора. MailExpert держит Allow-политику в соответствии со своим
списком одобренных пользователей: добавленный в панели пользователь попадает в политику за
несколько секунд, весь список сверяется раз в час; адреса, группы и правила, добавленные в
Cloudflare вручную, не трогаются. Пока синхронизация включена, список пользователей MailExpert —
единственное место, где пользователей одобряют: адрес, удалённый из политики в Cloudflare,
отключает пользователя в панели, а незнакомый адрес, который пропустил Access, панель не впускает.
Прогон, который отключил бы больше `ACCESS_SYNC_MAX_DISABLES` (по умолчанию 10) пользователей,
останавливается и пишет `access.sync_aborted` в журнал.

В панели: настройки администратора, раздел «Синхронизация с Access»: ID аккаунта, приложения и политики,
API-токен, галочка «Синхронизировать…», «Сохранить настройки», «Синхронизировать сейчас».

Или с сервера, через CLI панели ([cli.md, раздел 3.6](cli.md)):

```bash
M=/opt/mailexpert/app/scripts/deploy/mailexpert-cli.sh
$M access token < /root/access-sync-token.txt && shred -u /root/access-sync-token.txt
$M access config --account <ACCOUNT_ID> --app <APP_ID> --policy <POLICY_ID> --enable
$M access sync                     # прогон в backend и его итог: updated / unchanged
$M access status
```

Токен читается только со stdin и никогда не печатается. После этого отзовите временный токен
(раздел 0).

## 9. Неполадки

| Признак | Причина | Что делать |
|---|---|---|
| Вход через Access проходит, панель отвечает `401` `{"error":"not_authenticated"}` («invalid identity token») | токен Access не прошёл проверку панели: `CF_ACCESS_ISSUER` не той команды или `CF_ACCESS_AUDIENCE` не того приложения | `status.sh`: `team_mismatch` называет нужную команду; AUD — шаг 3.5. Внесите верные значения через `configure.sh`, затем `install.sh` |
| `403` `not_allowed` | адрес не одобрен: синхронизация включена, а пользователя нет в списке панели | добавьте пользователя в панели; при выключенной синхронизации Access-адрес получает учётку при первом входе |
| `403` `user_disabled` | пользователь отключён в панели (или синхронизацией после удаления адреса из политики) | включите его в панели; проверьте журнал (`user.disabled` от «Cloudflare Access») |
| Бесконечные редиректы между `<CF_HOST>` и `<TEAM>.cloudflareaccess.com` | у маршрута туннеля `https://` вместо `http://`; второе приложение Access или правило перенаправления на `*.example.com`; браузер блокирует cookies `CF_Authorization` | Service URL — `http://127.0.0.1:<APP_HTTP_PORT>`; одно приложение на `<CF_HOST>` без пути; очистите cookies обоих имён, попробуйте другой браузер |
| Cloudflare `Error 1033`, HTTP 530 (`tunnel_down`) | ни один коннектор этого туннеля не подключён, или `<CF_HOST>` — маршрут другого туннеля | `docker compose -p edge logs cloudflared`; на сервере тот ли `TUNNEL_TOKEN`; туннель в Zero Trust должен быть Healthy; исходящие 7844 TCP/UDP открыты ([ports.md](ports.md)) |
| HTTP 502 / 504 (`origin_error`) | туннель подключён, но не достучался до панели | маршрут на `http://127.0.0.1:<APP_HTTP_PORT>` (порт — `APP_HTTP_PORT` в `<prefix>/.env`); панель запущена: `status.sh` |
| `<CF_HOST>` открывается без входа, `status.sh`: `access_missing` | приложения Access нет или оно на другом имени/пути | шаг 3: приложение ровно на `<CF_HOST>` |
| `access_missing` с кодом 403, а в браузере вход через Access работает | раньше Access ответило правило безопасности Cloudflare (WAF, Bot Fight Mode) на запрос `curl` с сервера | проверка ошиблась, не установка; сверьте события Security → Events зоны, при желании разрешите адрес сервера |
| `dns_missing` | у `<CF_HOST>` нет записи DNS или она ещё не разошлась | маршрут туннеля создаёт CNAME сам; через API — шаг 2; подождите несколько минут и повторите `status.sh` |
| `redirect_elsewhere` | имя перенаправляет не на Access (правило Redirect, другой сервис) | уберите перенаправление, создайте приложение Access |
| Caddy не получает сертификат `<DIRECT_HOST>` | у `DNS_API_TOKEN` нет DNS Edit или Zone Read на эту зону, или токен на другую зону | шаг 4; `docker compose -p edge logs caddy` |
| `configure.sh`: `TUNNEL_TOKEN: must be the token of a remotely managed tunnel` | скопирована вся команда, кавычки или токен туннеля, управляемого локально | только значение `eyJ...` после `install` или `--token`, шаг 2 |
| Синхронизация: `policy_not_allow`, `policy_not_attached`, `Cloudflare getPolicy failed (403)` | не Allow-политика; политика не привязана к приложению; у токена нет «Access: Apps and Policies Edit» | раздел 5; `mailexpert access status` |

Ссылки: [туннель через API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
[приложение Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/),
[проверка токена Access и AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Google как способ входа](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/),
[токены через API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/),
[ошибки туннеля](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/).
