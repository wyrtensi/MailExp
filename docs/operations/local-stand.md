# Локальный стенд

Весь продукт на одном «сервере» размера целевого VPS (4 vCPU / 8 ГБ) на своём компьютере: чтобы
руками проверить подключение Gmail, ящики на своих доменах и интерфейс до выкладки на настоящий сервер.

Скрипт: [`scripts/deploy/test/stage.sh`](../../scripts/deploy/test/stage.sh).

Порты стенда и отличие от production — [общая карта](ports.md). Внешний TCP
`127.0.0.1:443` проходит через порт `9443` внутри `me-stage` к stage-edge; панель на внутреннем
loopback `8080`. Дополнительная установка `mxu` (`/opt/mailexpert-u`) использует внутренний
`127.0.0.1:8090` по текущей настройке владельца. Mailcow, fake-eop и stage-dns наружу не публикуются.

## Что внутри

Один контейнер `me-stage` (Docker-in-Docker) с ограничением 4 CPU и 8 ГБ памяти. В нём:

- mailcow выпуска `2026-09` под именем `mail.test.local`, с сертификатом от CA стенда, без ClamAV,
  Olefy и FTS и с настройками Dovecot из [раздела 3 инструкции по узлу](mail-node.md);
- панель, установленная так же, как на настоящем сервере: `scripts/deploy/install.sh` в
  `/opt/mailexpert` (проект compose `stage`, вход по логину и паролю, без края и без systemd:
  `--local-auth --no-edge --no-system --http-port 8080`), из опубликованных образов
  `ghcr.io/wyrtensi/mailexpert-*:sha-<commit>` с лимитами `deploy/compose.prod.yml`;
- то, что нужно только стенду, — в `/opt/mailexpert/compose.local.yml` (локальные дополнения
  compose, [deployment.md, раздел 4](deployment.md)): backend видит `mail.test.local` и доверяет CA
  стенда, публичный адрес панели — `https://localhost`, и сервис `stage-edge` — Caddy со своим
  сертификатом перед панелью (`tls internal`, Caddyfile — `/opt/mailexpert/stage-edge.Caddyfile`).
  Обновления этот файл не трогают;
- цикл-наблюдатель `/root/stage-updater-watch.sh` вместо `mailexpert-updater.path` (в `me-stage`
  нет systemd): когда панель кладёт запрос в спул, он запускает `updater.sh`, как юнит на сервере.
  Поэтому кнопка «Обновить» в настройках панели работает как на сервере (раздел 9
  [deployment-system.md](../architecture/deployment-system.md)): предлагает только продвинутую
  сборку `latest`, новее текущей.

Панель открывается на `https://localhost` (порт 443, только с этого компьютера). Браузер
предупреждает о сертификате стенда: это ожидаемо, открыть через «Дополнительно».

Внутренний Docker хранится в томе `me-stage-docker`, поэтому стенд переживает перезапуск Docker.
Наблюдатель перезапуск `me-stage` не переживает: его снова запускают `updater` или `panel`, `status`
показывает, работает ли он. Почта снаружи на стенд не приходит: письма ходят только между его
собственными ящиками.

## Команды

Из корня репозитория (на Windows — в Git Bash):

```bash
scripts/deploy/test/stage.sh up
```

Поднимает сервер и mailcow, ставит панель через `install.sh`, заводит первого администратора,
подключает mailcow как почтовый узел, добавляет домен `stage.test` и запускает наблюдатель
обновлений. Первый запуск скачивает несколько ГБ образов и занимает около 10 минут.

Версия (`--version`, без него — текущий коммит) должна быть в GitHub (`install.sh` берёт код
оттуда), её образы — опубликованы (CI публикует их после слияния в `main`), и в ней должна быть
поддержка `compose.local.yml`: более старую сборку скрипт откажется ставить.

```bash
scripts/deploy/test/stage.sh panel --version sha-<12 символов коммита>
```

Обновляет только панель настоящим путём — `update.sh` (проверки, дамп перед обновлением,
`install.sh` новой версии), данные остаются. Так можно поставить любой коммит `main`, а не только
`latest`, как кнопкой. Если наблюдатель не работает, запускает его.

```bash
scripts/deploy/test/stage.sh updater
```

Запускает наблюдатель обновлений, если он не работает (например, после перезапуска `me-stage`).
Его журнал — `/root/stage-updater-watch.log` в `me-stage`, журналы самих обновлений — в
`/opt/mailexpert/state/updater/`.

```bash
scripts/deploy/test/stage.sh panel-reinstall --yes [--version sha-<12 символов коммита>]
```

Одноразовый переход стенда, поднятого старой версией скрипта (панель в `/opt/app`, без
`install.sh`): удаляет все контейнеры и тома проекта compose `stage` (база панели — пользователи,
ящики, настройки, журнал; Redis; данные stage-edge), каталоги `/opt/app` и `/opt/mailexpert` и старые
секреты панели из `data/stage.env`, затем ставит панель как `up`, заводит администратора, узел и
домен и запускает наблюдатель. **Данные основной панели теряются.** mailcow, панель `mxu`
(`/opt/mailexpert-u`), fake-eop, stage-dns и CA стенда не трогаются. Без `--yes` только печатает,
что будет удалено. Повторный запуск после сбоя безопасен: начинает с того же удаления.

```bash
scripts/deploy/test/stage.sh status
```

Показывает версию панели, установку в `/opt/mailexpert` и состояние наблюдателя.

```bash
scripts/deploy/test/stage.sh down --purge
```

`down` удаляет контейнер стенда, `--purge` вместе с его данными.

## Имитация EOP (fake-EOP)

Почта схемы «узел + Exchange Online Protection» уходит наружу через EOP, а тенанта на стенде нет.
Поэтому на стенде есть его заменитель: контейнер `fake-eop` во внутреннем Docker, в сети compose
mailcow, под именем `eop.test.local`. Код — [`scripts/deploy/test/fake-eop/`](../../scripts/deploy/test/fake-eop),
без зависимостей (Node 22, образ `node:22.20-alpine`). Работает на уже запущенном стенде, данные стенда
не трогает (кроме одной строки в `extra.cf`); файлы берёт из репозитория, в котором лежит скрипт, и
`data/stage.env` не читает.

```bash
scripts/deploy/test/stage.sh eop up
```

Копирует fake-EOP в стенд, выпускает ему сертификат `eop.test.local` от CA стенда, запускает
контейнер и ставит `relayhost = eop.test.local` в `data/conf/postfix/extra.cf` mailcow (остальные строки
файла остаются), после чего перезапускает `postfix-mailcow`. Повторный запуск безопасен: если relayhost
уже стоит, Postfix не перезапускается. С этого момента всё, что Postfix mailcow отправляет на чужие
адреса, уходит в fake-EOP; почта между ящиками стенда идёт локально, как раньше.

```bash
scripts/deploy/test/stage.sh eop down
```

Обратное действие: возвращает `extra.cf` к тому, что было до первого `eop up` (прежний `relayhost`, если
он был, иначе строка убирается; файл, которого не было и который остался пустым, удаляется),
перезапускает Postfix и удаляет контейнер. Прежнее значение запоминается при первом `eop up` в
`/opt/fake-eop-data/relayhost.before`. Принятые письма остаются в `/opt/fake-eop-data/spool`.

**Что скрипты меняют в стенде.** `eop up`: одну строку `relayhost` в
`/opt/mailcow/data/conf/postfix/extra.cf` и перезапуск `postfix-mailcow` (только если значение в
работающем Postfix отличается); файлы `eop.crt`, `eop.key`, `eop.csr`, `eop.cnf` и счётчик серийных
номеров в `/opt/testca` (ключ самого CA никуда не копируется); каталоги `/opt/fake-eop` (код) и
`/opt/fake-eop-data` (TLS-файлы, состояние, очередь, запись о прежнем relayhost); контейнер `fake-eop` и
образ `node:22.20-alpine`. `dns up`: каталог `/opt/stage-dns` (зона и ключ DKIM фикстуры), образ
`stage-dns:dnsmasq` (собирается один раз из `alpine:3.22`, дальше сети не нужно) и контейнер `stage-dns`.
Больше ничего: ни данные mailcow и панели, ни `mailcow.conf`, ни compose-файлы.

| Команда | Что делает |
|---|---|
| `eop status` | контейнер, режим, имя коннектора, число сохранённых писем, relayhost в `extra.cf` и в запущенном Postfix |
| `eop send [from] [to]` | одно письмо изнутри `postfix-mailcow` (по умолчанию `someone@stage.test` → `test@example.com`) |
| `eop connector <имя>` | имя, которое должен нести клиентский сертификат; по умолчанию `mail.test.local` |
| `eop mode <режим> [--stage mail\|rcpt\|data]` | ответ на письмо, см. ниже; `--stage` — на какой команде SMTP (по умолчанию `rcpt`) |
| `eop list`, `eop show [id]`, `eop clear` | сохранённые письма |
| `eop inject <id\|latest> [вердикт] --to a@b[,c@d] [--auth pass\|fail] [--folded]` | вернуть сохранённое письмо на порт 25 узла с заголовками EOP; `--to` обязателен |
| `eop logs [n]`, `eop relaylog [n]`, `eop queue` | журнал fake-EOP; строки `relay=`/`status=` журнала Postfix; очередь Postfix |
| `eop inbound send --from a@b --to x@stage.test [--subject S] [--expire-seconds N]` | письмо «из интернета» ящику стенда через очередь fake-EOP (см. ниже) |
| `eop inbound list`, `show [id]`, `retry`, `clear`, `config [--retry-seconds N] [--expiry-seconds N]` | очередь входящей почты; `retry` — все ждущие письма сразу; настройки повтора и срока |
| `eop ndr list`, `ndr show [id]`, `ndr clear` | отбивки, которые fake-EOP «отправил» внешним отправителям |
| `eop trace [--start ISO] [--end ISO]` | трассировка очереди входящей почты в формах Graph |

**Что делает fake-EOP.** Принимает SMTP на порту 25 только после STARTTLS (до него `530 5.7.0`) с
сертификатом от CA стенда. Запрашивает клиентский сертификат (Postfix mailcow предъявляет
`/etc/ssl/mail/cert.pem`, то есть сертификат `mail.test.local`) и проверяет его: цепочка до CA стенда
полная и каждое звено проверено, промежуточные сертификаты имеют `CA:TRUE`, никто в цепочке (и сам CA) не
просрочен, имя из SAN (с подстановкой `*.` в сертификате, как в TLS) или CN, если SAN нет, совпадает с
именем коннектора. Нет сертификата, неполная цепочка, промежуточный не CA, чужой CA или другое имя —
`550 5.7.64 TenantAttribution; Relay Access Denied`. Расширенное использование ключа проверяется мягко:
подходят `serverAuth` (его и предъявляет Postfix, сертификат стенда выпускается только с ним), `clientAuth`
и сертификат без EKU; сертификат только «для подписи кода» отклоняется. Имя коннектора читается в каждой
сессии, так что `eop connector <имя>` действует сразу; это обычное имя хоста, подстановочные имена EOP
(`*.example.com`) в имени коннектора не поддерживаются и отклоняются при вводе. Режимы:

| Режим | Ответ |
|---|---|
| `accept` | приём, письмо сохраняется (конверт и исходный текст) |
| `tempfail` | `451 4.7.500 Server busy … (S77)`: письмо остаётся в очереди Postfix |
| `blocked-connector` | `550 5.7.711 Access denied, bad inbound connector. AS(2204)` |
| `tenant-limit` | `550 5.7.233 … tenant exceeded its daily limit …` |
| `recipient-denied` | `550 5.4.1 Recipient address rejected: Access denied. AS(201806281)` |
| `drop` | обрыв соединения (в журнале Postfix — `lost connection`, письмо откладывается) |

Каждая сессия пишется в stdout (`eop logs`): адрес клиента, версия TLS, subject клиентского сертификата,
результат атрибуции, ответ. Пустой отправитель (DSN) проходит те же проверки, отдельного правила для него
нет.

Строки SMTP строгие, как у Postfix с `smtpd_forbid_bare_newline`: команды и строки письма оканчиваются
CRLF, одиночный LF получает `500 5.5.2 Error: bare <LF> received` и разрыв соединения сразу, без
ожидания таймаута. Команда длиннее 2048 байт — `500 5.5.2 Line too long`. Размер письма ограничен 25 МиБ;
то же число объявляется в `SIZE`, а `MAIL FROM ... SIZE=` больше него получает `552 5.3.4`. Если спул
стенда не пишется, ответ `451 4.3.0`, процесс не падает. После `STARTTLS` всё, что клиент послал открытым
текстом следом за командой, отбрасывается.

**Обратный путь EOP → узел.** `eop inject` берёт сохранённое письмо и отдаёт его `postfix-mailcow:25`
по обычному SMTP с исходным отправителем. `--to` обязателен: сохранённые письма адресованы наружу, и
отдать их с исходными получателями значило бы снова отправить их через relayhost; получатель должен быть
ящиком стенда. Если узел обрывает связь или отвечает 4xx/5xx, команда печатает причину и завершается с
кодом 1. К письму добавляются `Received`,
`Authentication-Results` и `X-Forefront-Antispam-Report` с `SFV`, `CAT` и `SCL` по вердикту: `spam` (по
умолчанию), `clean`, `high-confidence-spam`, `bulk`, `phish`, `high-confidence-phish`, `spoof`,
`blocked-sender` (`SFV:SKB`), `rule-spam` (`SFV:SKS`), `none` (без заголовка) или своя строка вида
`SFV:SKQ;CAT:SPM`. `--folded` переносит заголовок на несколько строк, как это бывает у настоящего EOP.

**Очередь входящей почты: узел не принимает (R-43).** `eop inbound send` ставит письмо внешнего
отправителя ящику стенда в очередь fake-EOP (`/opt/fake-eop-data/inbound`), как его принял бы EOP. Процесс
`serve` раз в 10 секунд (`EOP_INBOUND_TICK`) смотрит очередь и отдаёт письмо `postfix-mailcow:25` с
заголовками EOP (вердикт `clean`) — сразу и затем каждые `retrySeconds` (900, как у EOP; `eop inbound config
--retry-seconds 60` — для проверки). Пока узел не отвечает, в журнале fake-EOP — `event=defer` с причиной
в форме EOP: `450 4.4.316 Connection refused`, `4.4.315` (таймаут), `4.4.318` (обрыв), `4.4.317`, а на
стенде чаще `450 4.4.312 DNS query failed`: остановленный контейнер пропадает из DNS Docker; `4xx` самого
узла записывается как есть. Через `expirySeconds` (86400; у одного письма — `--expire-seconds`) письмо
получает `550 4.4.7 QUEUE.Expired; message expired`, а отправителю пишется отбивка (`multipart/report`,
`Status: 4.4.7`) в `/opt/fake-eop-data/ndr` — дальше она никуда не уходит. `5xx` узла — отказ и отбивка
сразу. Трассировка этой очереди в формах Graph (`messageTraces` с `$filter` по `receivedDateTime`, `$top`,
`@odata.nextLink`; `getDetailsByRecipient` с событиями `Receive`, `Defer`, `Send`, `Fail`) — на
`http://eop.test.local:8080/v1.0` в сети mailcow и в `eop trace`; панель ветки читает её с
`MAIL_NODE_TRACE_URL=http://eop.test.local:8080/v1.0` (контейнер панели нужно подключить к сети mailcow).
Простой узла на стенде: `docker compose stop postfix-mailcow` в `/opt/mailcow` внутри `me-stage`, потом
`start` (проверено 2026-10-02, требования, раздел 5.9). После проверки — `eop inbound clear`, `eop ndr clear`,
`eop inbound config --retry-seconds 900 --expiry-seconds 86400`.

**Чего fake-EOP не имитирует.** Интернет и получателей (письма никуда дальше не идут), тенант, DBEB и
accepted domains (`recipient-denied` отвечает всем получателям одинаково), лимиты и счётчики TERRL,
исходящую фильтрацию, DKIM-подпись на стороне EOP, диапазоны адресов EOP. Поэтому `eop inject` идёт с
адреса докер-сети, которая входит в `mynetworks` Postfix: postscreen и проверки rspamd на отправителя
обходятся, и оценки rspamd так проверять нельзя (раскладку Sieve — можно). Поведение EOP при пустом
отправителе и атрибуция по другому имени хоста — гипотезы из
[требований](../architecture/mail-node-research/eop-panel-requirements.md), на стенде они не проверяются, а
лишь заданы правилом «сертификат должен совпасть».

**Что видно на стенде (проверено).**
- TLS к fake-EOP при `smtp_tls_security_level = dane` у Postfix устанавливается как `Untrusted TLS
  connection established to eop.test.local…` (TLSA нет, CA стенда в `smtp_tls_CAfile` нет). Проверка
  сертификата сервера записью TLS Policy Map (`encrypt` или `fingerprint`) — отдельный шаг, см. раздел
  5.1 требований.
- Имя `eop.test.local` Postfix получает от встроенного DNS Docker (сетевой алиас контейнера), а не от
  unbound mailcow: запись в unbound не нужна. Имя намеренно в `.local`, а не в `.test`: unbound по
  умолчанию считает `test.` особой зоной (не проверялось).
- Postfix повторно использует сессию TLS во втором соединении. Серверу поэтому нужен
  `sessionIdContext` (без него вторая отправка давала `Cannot start TLS: handshake failure`); на это
  есть тест.
- rspamd mailcow стирает пришедший `Authentication-Results` и ставит свой (`mail.test.local; none`);
  `X-Forefront-Antispam-Report` остаётся. Правило раскладки спама R-11 (кнопка панели, этап 2) на стенде
  стоит с 2026-10-01: после `inject` спам, массовая рассылка, подделка, фишинг и вредоносное ложатся в
  Junk, `clean` и `none` — в INBOX; выпущенное из карантина (`SFV:SKQ`) — в INBOX, кроме фишинга и
  вредоносного. Повторный `inject` того же письма вне Junk не доходит: штатное правило `duplicate`
  отбрасывает письмо с уже виденным `Message-ID`, поэтому перед каждым таким `inject` нужен новый
  `eop send`.

**Очередь и оповещения панели на стенде (этап 4a).** `eop mode tempfail` и `eop send` дают письмо в
отложенной очереди (причина — ответ `451 4.7.500`), `blocked-connector` и `tenant-limit` — строки
`dsn=5.7.711` и `dsn=5.7.233` в логе Postfix, которые поднимают оповещения. Отправитель `eop send` по
умолчанию (`someone@stage.test`) — не ящик стенда: отбивка на него отбрасывается как двойная и в очереди не
остаётся. Обход EOP проверяется без правки `extra.cf`: временный транспорт mailcow
(`add/transport {destination: "bypass-test.example", nexthop: "[<адрес fake-EOP>]:25"}`) отправляет письмо
на этот домен в тот же fake-EOP, но по адресу, а не по имени `eop.test.local`, и строка `status=sent`
получает `relay=<адрес>[<адрес>]:25`; транспорт удаляется сразу после отправки (`delete/transport`).
Опубликованные образы стенда этих функций пока не несут: код ветки запускается одноразовым контейнером в
сети `stage_mailexpert` с окружением `stage-backend` (как для проверки DNS выше), см. раздел 5.5
[требований](../architecture/mail-node-research/eop-panel-requirements.md).

Тесты fake-EOP: `node --test scripts/deploy/test/fake-eop/eop.test.mjs` (нужен `openssl`; разбор сертификата,
режимы, полный диалог SMTP с STARTTLS и клиентским сертификатом, строгие строки и лимиты, возобновление
сессии TLS, inject и коды возврата команды, очередь входящей почты с повтором, истечением и отбивкой,
трассировка в формах Graph). Правка `extra.cf` — `scripts/deploy/mail-node/extra-cf.sh` (тот же
инструмент, которым `setup.sh` ставит relayhost на рабочем узле), тесты — `scripts/deploy/test/stage-eop.bats`. В CI это отдельное задание «Stand fake-EOP».

## Карантин и rspamd на стенде

Проверено 2026-10-02 при работе над R-20 ([runbook, раздел 6в](mail-node.md)):

- rspamd стенда оценивает и письма из сети Docker mailcow (`mynetworks`): в истории у них
  `is_skipped: false` и обычные символы. Поэтому письмо для карантина можно отдать прямо на
  `postfix-mailcow:25` из одноразового контейнера в сети `mailcowdockerized_mailcow-network` (простой
  SMTP-клиент на Node, `node:22.20-alpine`), получатель — ящик стенда.
- GTUBE (`XJS*C4JDBQADN1...`) для этого не годится: rspamd отвечает `554 5.7.1 Gtube pattern` как
  предварительный результат, и экспортёр карантина не вызывается — записи нет. Вариант `YJS*...` («add
  header») символа `GTUBE` на стенде не дал. Надёжно работает вложение `.exe`: `MIME_BAD_EXTENSION` (10.1) и
  ссылка без зоны (`URL_NO_TLD`, 2) дают `add header` (12.1, письмо в Junk и копия в карантине), а с
  заголовком EOP `X-Forefront-Antispam-Report: …SFV:SPM;…CAT:SPM;` добавляется `MICROSOFT_SPAM` (4) и
  выходит `reject` (16.1, письмо только в карантине). `MICROSOFT_SPAM` срабатывает, пока диапазоны EOP не
  стали forwarding hosts (R-12).
- Карантин нового mailcow ничего не хранит: `Q_MAX_SIZE` и `Q_RETENTION_SIZE` в Redis не заданы (0), а
  без `Q_EXCLUDE_DOMAINS` (появляется при первом сохранении формы карантина в админке) `pipe.php` падает
  и теряет письмо, отвечая rspamd `200`. Для проверки на стенде эти три ключа ставились на время теста
  и потом удалялись (стенд остаётся как был); позже — кнопкой панели «Включить карантин на этом узле»
  с тем же возвратом после проверки (`Q_MAX_AGE` 365 и `Q_RELEASE_FORMAT` `raw` ставит entrypoint php-fpm,
  остальных ключей на стенде нет); на рабочем узле — раздел 3, шаг 9 runbook.
- Выпуск письма с `SFV:SPM` правило R-11 снова кладёт в Junk; выпуск записи `add header` отбрасывает
  штатное правило `duplicate` (тот же `Message-ID`).

## DNS-фикстуры (stage-dns)

Зона `stage.test`, какой её должен публиковать тенант за EOP, для проверки DNS панели (R-14, R-15;
[runbook, «Проверка DNS»](mail-node.md)). Опционально: контейнер `stage-dns` (dnsmasq, образ `stage-dns:dnsmasq` собирается из `alpine:3.22`) стоит в сети панели `stage_mailexpert`
и в сети mailcow, и **ничем не пользуется, пока клиент не укажет его адрес**. Ни панель, ни mailcow на
него не переключаются, реальные адреса (Gmail) резолвятся как раньше.

```bash
scripts/deploy/test/stage.sh dns up [вариант]        # контейнер и зона (вариант по умолчанию: ok)
scripts/deploy/test/stage.sh dns variant <вариант>   # переключить зону
scripts/deploy/test/stage.sh dns query TXT stage.test
scripts/deploy/test/stage.sh dns status              # адрес резолвера и активный вариант
scripts/deploy/test/stage.sh dns down
```

Зона `ok`: MX `stage-test.mail.protection.outlook.com`, SPF `v=spf1 include:spf.protection.outlook.com
-all`, TXT `MS=ms12345678`, `dkim._domainkey` с ключом в двух строках TXT (проверка склейки кусков по 255
символов; ключ создаётся один раз и хранится в `/opt/stage-dns/dkim.pub` стенда и не является ключом
mailcow), `_dmarc`, а также A `mail.test.local` и PTR к нему (`203.0.113.10`). Неполные варианты:
`no-spf`, `spf-ip4`, `spf-double`, `no-dkim`, `dkim-mismatch`, `dkim-cname` (CNAME `selector1/2`),
`no-dmarc`, `dmarc-bad`, `wrong-mx`, `extra-mx`, `mx-new-form` (`*.mx.microsoft`), `no-ms-txt`,
`ms-txt-wrong`, `mta-sts`, `no-ptr` (A узла через `address=`: `host-record` dnsmasq сам добавляет
PTR), `aaaa`. Имя вне зоны получает `REFUSED` (наружу `stage-dns` ничего
не пересылает), несуществующее имя в `stage.test` — `NXDOMAIN`. Новая зона пишется во временный файл и
подменяет рабочую только когда сформирована целиком: неверное имя варианта или пустой ключ не портят
действующую зону. Адрес резолвера — вывод `dns status`; панель получает его как единственный сервер через
`DNS_CHECK_RESOLVER`. Опубликованные образы панели стенда проверку пока не несут (она появится после
слияния): код ветки запускается одноразовым контейнером в сети `stage_mailexpert` с
`DNS_CHECK_RESOLVER=<адрес stage-dns>`, а для сертификата на 587 — с `--add-host
mail.test.local:host-gateway` и CA стенда (`-v /opt/testca/ca.pem:/ca/ca.pem:ro -e
NODE_EXTRA_CA_CERTS=/ca/ca.pem`). Резолвер самого контейнера на `stage-dns` не переключать: в зоне
`mail.test.local` указывает на `203.0.113.10` (TEST-NET), и подключение к 587 ушло бы в никуда. Ключ DKIM
зоны — `/opt/stage-dns/dkim.pub`, а не ключ mailcow: в режиме «mailcow» вариант `ok` проходит проверку
только против него. Зона — `scripts/deploy/test/stand-dns/zone.sh`,
тесты — `scripts/deploy/test/stage-dns.bats`. Unbound mailcow на `stage-dns` не настроен (для него понадобился
бы `stub-zone` и `local-zone: "test." transparent`); проверка DNS этого не требует.

## IPv6 в mailcow

Runbook требует `ENABLE_IPV6=false` ([mail-node.md](mail-node.md), раздел 3). `stage.sh up` теперь
выставляет его при создании стенда и останавливается, если такой строки в `mailcow.conf` нет. На уже
запущенном стенде значение меняется только полным `docker compose down` и `up -d` всего mailcow (сеть
Docker пересоздаётся); скрипты `eop` и `dns` этого не делают. Какое значение у конкретного стенда,
показывает `docker exec me-stage grep ENABLE_IPV6 /opt/mailcow/mailcow.conf`.

## Секреты

При первом запуске скрипт пишет `data/stage.env` (каталог `data/` не попадает ни в git, ни в
Docker-образы): ключ API mailcow и первого администратора `PANEL_ADMIN_USER` /
`PANEL_ADMIN_PASSWORD`. Секреты самой панели (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD` и
другие) генерирует `install.sh` в `/opt/mailexpert/.env` внутри `me-stage`; наружу они не выходят и
скриптом не печатаются. Вход в панель на стенде — по логину и паролю.

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
