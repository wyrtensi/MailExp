<p align="center">
  <img src="media/mailexpert-logo.png" width="200" alt="MailExpert logo">
</p>

<h1 align="center">MailExpert</h1>

<p align="center">
  A self-hosted webmail panel for a team that works shared mailboxes: Gmail, Microsoft 365, any IMAP server and mailboxes on your own domains behind Microsoft EOP, in one interface.
</p>

<p align="center">
  <a href="docs/operations/quickstart.md">Production quick start</a> ·
  <a href="docs/operations/README.md">Operations</a> ·
  <a href="docs/user-guide/README.md">User guide</a> ·
  <a href="docs/operations/cli.md">CLI</a> ·
  <a href="AGENTS.md">For AI agents</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="docs/architecture/codebase-file-map.md">Codebase map</a>
</p>

## Licensing and upstream

MailExpert is a fork of [MailFlow](https://github.com/maathimself/mailflow). The fork keeps the upstream copyright and attribution and is distributed under [AGPL-3.0](LICENSE). Deploying a modified network service under the AGPL requires making the corresponding source available to its users.

MailExpert is available only under AGPL-3.0. The commercial licence that the MailFlow author sells covers MailFlow itself and does not apply to MailExpert.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made; external pull requests are not accepted until contribution terms are defined.

## What it is

MailExpert keeps a team's mailboxes connected on the server and lets every approved user work
them from one interface:

- **Shared mailboxes.** Mailboxes belong to the installation, not to a person: every signed-in user
  sees all of them, reads and sends from them; every action with mailboxes, letters, rules and
  users is written to an audit log with its author. Users sign in with Google or through
  Cloudflare Access; administrators approve them and own the system settings.
- **Mailbox kinds.** Gmail through Google OAuth (spread over several Google Cloud apps), Microsoft
  365 / Outlook through OAuth, any IMAP/SMTP server, and mailboxes on your own domains on a
  **mail node** (mailcow on a separate server) with mail going in and out through **Microsoft
  Exchange Online Protection**. The panel sets up the node through the mailcow API and the Microsoft
  tenant through its tenant driver (Graph and an Exchange Online PowerShell worker).
- **Production operations.** One-command install on a VPS, encrypted verified backups, updates from
  the admin screen (or `update.sh`) to the build the owner promoted to the `latest` channel,
  rollback, moving to another server, and an admin CLI.

Status: under active development; what is done and what comes next is in [ROADMAP.md](ROADMAP.md).

| I want to | Read |
|---|---|
| take over the project: what it is, what is done, what is left | [Handoff](docs/HANDOFF.md) (in Russian) |
| install it on a server | [Quick start](docs/operations/quickstart.md) (in Russian), then [operations](docs/operations/README.md) |
| let an AI agent install or update it | [AGENTS.md](AGENTS.md) and the [`mailexpert-rollout` skill](.claude/skills/mailexpert-rollout/SKILL.md) |
| learn the screens | [User guide](docs/user-guide/README.md) (in Russian) |
| run the admin CLI | [CLI reference](docs/operations/cli.md) (in Russian) |
| set up Gmail / Microsoft mailboxes | [Google apps](docs/operations/google-oauth.md), [Microsoft](docs/operations/microsoft-oauth.md) (in Russian) |
| run mailboxes on my own domains | [Mail node](docs/operations/mail-node.md) (in Russian) |
| understand the code | [Codebase map](docs/architecture/codebase-file-map.md), [deployment system](docs/architecture/deployment-system.md), [job queue](docs/architecture/job-queue.md) |
| try it without a server | [Demo workspace](#demo-workspace) |


## Features

MailExpert-specific:

- **Shared mailboxes and audit log** — every approved user works every mailbox; administrators approve users (with optional Cloudflare Access policy sync), own system settings and a mailbox's connection settings; the audit log records who added, changed, reconnected or removed a mailbox, who sent or deleted a letter, rule changes, user changes, node, tenant and update actions
- **Gmail through several Google apps** — an unverified Google Cloud project serves at most 100 accounts for life, so mailboxes are spread over several apps with seat tracking; sending goes through the Gmail API with SMTP as a fallback
- **Mail node behind Microsoft EOP** — mailboxes on your own domains on a mailcow server: domain onboarding with DNS and certificate checks, mailboxes with quotas and two sender names, deletion after a delay that can be cancelled, mailcow quarantine with a safe view, node queue and alerts, outage tracking for letters held in EOP
- **Microsoft tenant driver** — accepted domains, connectors, the anti-spam policy, the directory-based edge blocking (DBEB) recipient mirror, message trace ("Ask Microsoft's message trace" on a sent letter) and release of EOP quarantine into the node's Spam, run as background jobs through Microsoft Graph and an Exchange Online PowerShell worker
- **Delivery status** — per-recipient delivery details of a sent letter from the node's logs, bounces and EOP message trace, with "not delivered" and "delayed" marks in the list
- **Durable job queue** — undo send, send later and tenant work survive restarts; a letter is never handed to the mail server twice
- **In-panel updates** — administrators see the promoted `latest` build, its pre-check and update with one button; the host runs the update with a pre-update backup and rolls back by itself when the new version does not start and nothing was migrated
- **Admin CLI** — `mailexpert` (mailboxes, domains, tenant, quarantine, jobs) over SSH, through the same services, checks and audit entries as the screens
- **Demo mode** — the whole product with 50 mailboxes in the browser, no backend needed

From MailFlow, kept and extended:

- **Unified inbox** — all accounts merged in one view, sorted by date
- **Sender imagery** — saved contact photos take priority, with optional domain favicons proxied and cached through Twenty Icons and deterministic initials as the offline fallback; disable sender favicons under Appearance to prevent lookups for your user
- **Email categorization** — automatic inbox tabs (Primary, Newsletters, Social, Notifications, Other) sort incoming mail by type using header detection and sender heuristics; AI reclassify button for misclassifications
- **Unsubscribe** — one-click unsubscribe button appears in the message pane for detected newsletters; sends the request or opens the unsubscribe URL automatically
- **Conversation threads** — messages grouped into reply chains with inline sent replies
- **Rich text compose** — WYSIWYG editor with font family, size, color, highlight, tables, emoji, links, attachments, image resize handles, and Excel table paste
- **Attachments** — send and receive file attachments across all accounts
- **Undo send and send later** — every sent letter waits five seconds with an Undo that reopens it in the composer; Send later schedules it (later today, tomorrow morning, Monday morning or any date and time) and the Scheduled list lets its author edit, reschedule or cancel it; a letter that fails after you left is kept there and you are told
- **Multiple layouts** — classic, compact, wide reader, vertical split, and more
- **Multiple themes** — dark, light, and several color schemes; custom CSS field for per-user style overrides
- **Two-language UI** — English and Russian
- **Full-text search** — across all connected accounts simultaneously
- **Real-time notifications** — WebSocket-powered new-mail toasts and web push notifications
- **PWA** — installable as a desktop or mobile app with push notification support
- **Command palette** — Cmd+K / Ctrl+K quick-access for actions and navigation
- **Keyboard shortcuts** — full shortcut set, fully customisable per user
- **Smart contact autocomplete** — learns from sent mail to rank suggestions
- **Reply / Forward / Compose** — correct per-account SMTP routing; font family groups, email priority
- **Folder navigation** — expand any account to browse folders
- **Folder-structure sync** — folders created or renamed in other clients appear automatically, on a configurable interval or on demand
- **Star, archive, delete, mark read/unread** — synced back to IMAP
- **Mark-as-read behavior** — choose immediate (on open), after a configurable delay in seconds, or manual (button only) per-user preference
- **Inbox rules** — automate actions (move, archive, delete, mark read, star) based on sender, subject, recipient, headers, body, or attachments
- **Block list** — automatically move mail from blocked senders to trash before inbox rules run
- **Spam reporting** — mark messages as spam or not spam from the context menu, toolbar, or bulk actions; feedback will feed into automated filtering in a future release
- **Snooze** — snooze messages until a chosen time; they reappear at the top of the inbox
- **AI assistant** — use an OpenAI-compatible API provider or a ChatGPT Codex subscription; summarise threads, draft replies, ask questions about a message
- **User management** — admin panel, invite-only registration, invite emails
- **Optional local-sign-in security** — two-factor authentication (TOTP, email code fallback, device trust), a recovery email and a lock-screen PIN, set by administrators as policy; production installs sign in through Google or Cloudflare Access and normally do not use them
- **SSO / OIDC** — single sign-on via any OpenID Connect provider; group claims from the IdP can be mapped to the MailExpert admin role, with optional RP-initiated (end-session) logout to sign out of the provider too
- **Microsoft 365 / OAuth2** — an optional administrator path: work accounts via Azure App Registration; personal Outlook.com via device code flow
- **Todoist integration** — create tasks directly from emails; tasks include a deep link back to the original message; the Todoist token is per user
- **Plugins** — an administrator enables plugins for everyone; the bundled one is GTD
- **GTD workflow** — optional Getting-Things-Done rail: label threads Todo / Watch / Delegated / Someday / Reference (each backed by a real IMAP folder) with the t / w / d keys, see below

---

## GTD (Getting Things Done)

An optional Getting-Things-Done workflow, off by default. Plugins are enabled by an
administrator for everyone; the GTD folders are then set per mailbox under
Settings → Categories → GTD. When on, a rail beside the message list
groups threads into five states, each backed by a real IMAP folder — so the labels
are just server-side folders that sync to every mail client and survive MailExpert
itself:

- **Todo** / **Someday** — things you need to act on; the label clears itself once your latest non-draft reply is sent.
- **Watch** / **Delegated** — things you're waiting on; kept until you remove the label or mark the thread done.
- **Reference** — kept until you remove the label or mark the thread done.

Label the selected thread from the keyboard — **t** for Todo, **w** for Watch,
**d** for Delegated (all remappable in the keyboard-shortcut settings) — or from the
context menu, which also covers Someday and Reference. Each state's folder name is
configurable per account, and accounts with GTD off behave exactly as before.

---

## Installation

**For a production server use the scripted install**: [Quick start](docs/operations/quickstart.md)
(Ubuntu 24.04, published images of the promoted `latest` build, Google or Cloudflare Access sign-in,
backups, monitoring, updates from the panel). The two options below build MailExpert from this
repository for development and evaluation; they start with local password sign-in, where the first
registered account becomes the admin.

---

## Option A — Build MailExpert from source (recommended)

### Prerequisites

- A server with Docker and Docker Compose installed

### 1. Get the code

```bash
git clone https://github.com/wyrtensi/MailExpert.git mailexpert
cd mailexpert
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the required fields are:

| Variable | Description |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 3. Build and start

```bash
docker compose up -d --build
```

First build takes 2–3 minutes. MailExpert will be available on port 443 (HTTPS, self-signed certificate) and port 80 (HTTP).

#### Demo workspace

For a populated local workspace, set `VITE_DEMO_MODE=true` in `.env` and rebuild, or run `npm run demo` in `frontend/` (no backend needed). The demo holds 50 mailboxes, Gmail and ones on the mail node's domains, with conversations of every kind; adding a mailbox works in it, with the Google step played by a card in the form. Demo mode needs no mailbox credentials or OAuth, performs no network mail activity, and its local data resets on reload.

**Ports are configurable in `.env`:**

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` | `443` | HTTPS port |
| `APP_HTTP_PORT` | `80` | HTTP port |

**Optional — automatic HTTPS via Let's Encrypt:** set `DOMAIN` and `ACME_EMAIL` in `.env`, then start with the HTTPS overlay (requires Docker Compose 2.21+):

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d --build
```

**Optional — behind your own reverse proxy:** point your proxy at port 80. Your proxy should forward `X-Forwarded-Proto: https` so that session cookies are marked Secure correctly.

### 4. Create your admin account

Open `https://your-domain.com` in a browser. The **first account registered becomes
the admin**. After registering, you can close registration and manage users from the
settings panel → Users tab.

### 5. Add your email accounts

In the settings panel → Accounts → Add Account, pick **Gmail mailbox** (Google sign-in,
see [Gmail](#gmail)) or, as an administrator, **Other server, set up manually** with a preset
(Yahoo, iCloud) or Custom for any IMAP server.

---

## Option B — Native install (no Docker)

Run MailExpert directly on any Linux, macOS, or BSD machine using Node.js, PostgreSQL, and Redis.
No container runtime required. The steps below use Ubuntu/Debian; adapt package manager commands for other platforms.

### Prerequisites

- **Node.js 22.19+ (LTS)** — [nodejs.org](https://nodejs.org) or via your package manager.
- **PostgreSQL 16+**
- **Redis 7+**
- **nginx** — serves the built frontend and proxies API/WebSocket requests to the backend

### 1. Install system dependencies

**Ubuntu / Debian:**
```bash
# Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql redis-server nginx
```

**macOS (Homebrew):**
```bash
brew install node@22 postgresql@16 redis nginx
brew services start postgresql@16
brew services start redis
```

### 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER mailexpert WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE mailexpert OWNER mailexpert;
SQL
```

### 3. Get the code

```bash
git clone https://github.com/wyrtensi/MailExpert.git /opt/mailexpert
cd /opt/mailexpert
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. In addition to the required secrets, set these for a native install:

| Variable | Value |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` — override for a Postgres server on a non-standard port |
| `DB_NAME` | `mailexpert` |
| `DB_USER` | `mailexpert` |
| `DB_PASSWORD` | password you set in step 2 |
| `REDIS_URL` | `redis://localhost:6379` — or `redis+unix:///path/to/redis.sock` for a Unix socket |

For Docker installs, the bundled Postgres/Redis work out of the box. To point at **external** database or cache servers (any host/port), or to store data on a host **bind mount** (e.g. an Unraid appdata share with `PUID`/`PGID`), see the "Database & Redis" and "Storage & permissions" sections of [`.env.example`](.env.example).
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 5. Build the frontend

```bash
cd /opt/mailexpert/frontend
npm ci
npm run build
# Built files are written to /opt/mailexpert/frontend/dist
```

### 6. Install backend dependencies

```bash
cd /opt/mailexpert/backend
npm ci --omit=dev
```

### 7. Configure nginx

A ready-to-use nginx config is provided in `contrib/nginx.conf`. Copy it, update the `root` path, then enable it:

```bash
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp /opt/mailexpert/contrib/nginx.conf /etc/nginx/sites-available/mailexpert
```

Open `/etc/nginx/sites-available/mailexpert` and replace `/path/to/mailexpert/frontend/dist` with `/opt/mailexpert/frontend/dist`.

The provided config listens on port 80 for use behind a TLS-terminating reverse proxy (Nginx/Caddy/Traefik). If you want nginx to terminate TLS directly, uncomment the HTTPS server block in the file and set your certificate paths. A quick self-signed cert:

```bash
sudo mkdir -p /etc/ssl/mailexpert
sudo openssl req -x509 -nodes -newkey rsa:4096 -days 3650 \
  -keyout /etc/ssl/mailexpert/key.pem \
  -out    /etc/ssl/mailexpert/cert.pem \
  -subj "/CN=mailexpert"
```

Enable the site and reload nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/mailexpert /etc/nginx/sites-enabled/mailexpert
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Run the backend

**Option A — systemd (recommended for production):**

```bash
sudo cp /opt/mailexpert/contrib/mailexpert.service /etc/systemd/system/mailexpert.service
# Edit the service file if your install path or user differs from the defaults
sudo systemctl daemon-reload
sudo systemctl enable --now mailexpert
sudo systemctl status mailexpert
```

**Option B — PM2:**

```bash
sudo npm install -g pm2
cd /opt/mailexpert/backend
pm2 start src/index.js --name mailexpert
pm2 save
pm2 startup   # follow the printed command to register auto-start on boot
```

**Option C — foreground (testing only):**

```bash
cd /opt/mailexpert/backend
node src/index.js
```

### 9. Create your admin account

Open the app in a browser. The **first account registered becomes the admin**. After registering, close open registration from Settings → Users.

### 10. Add your email accounts

In the settings panel → Accounts → Add Account.

### Updating

```bash
cd /opt/mailexpert
git pull
cd frontend && npm ci && npm run build && cd ..
cd backend && npm ci --omit=dev && cd ..
sudo systemctl restart mailexpert   # or: pm2 restart mailexpert
```

---

## Email Provider Setup

### Gmail

Gmail mailboxes connect only through Google OAuth 2.0; app passwords are not a supported
way in. An administrator first sets up one or more Google apps under **Settings →
Integrations → Email Providers → Google apps**: each app is its own Google Cloud project
with an OAuth client of type "Web application", audience External, published In
Production, scopes `openid email profile https://mail.google.com/`, and the callback URL
shown on that screen (`https://<your-mailexpert-host>/oauth/google/callback`, one per
public host) as an authorized redirect URI. An unverified project accepts at most 100
Google accounts for its whole life, so MailExpert spreads mailboxes over the apps and
tracks the seats.

Any signed-in user then adds a mailbox with **Add account → Gmail mailbox**: enter the
address, continue to Google, pass the "unverified app" warning and grant access. A
mailbox whose access was revoked or whose app was disabled shows **Reconnect** in the
sidebar and the Accounts tab.

Setup, app states, error codes, secret rotation, moving mailboxes between apps and the
risks are described in [docs/operations/google-oauth.md](docs/operations/google-oauth.md)
(in Russian).

### iCloud / Apple Mail

1. Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords
2. Generate a password — name it "MailExpert"

| Setting | Value |
|---|---|
| IMAP Host | `imap.mail.me.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.mail.me.com` |
| SMTP Port | `587` |
| Username | your full iCloud email (`you@icloud.com`) |

### Microsoft 365 / Outlook (OAuth2)

This is an optional, administrator-only path: the team's mailboxes otherwise connect
automatically (mail node mailboxes through EOP, Gmail through the Google apps).
Microsoft has disabled basic (password) auth for Outlook.com, Hotmail, and most
Microsoft 365 accounts, so they connect via OAuth2 under **Settings → Integrations →
Microsoft 365** (not the normal Add Account form). This is a one-time setup: you
create a free [Microsoft Entra app registration](https://portal.azure.com) once, and
the same app then serves every account and user on your instance.

**1. Register the app.** In the Azure portal, go to **Microsoft Entra ID → App
registrations → New registration**. Under **Supported account types**, choose
**"Accounts in any organizational directory and personal Microsoft accounts"** so it
covers both Outlook.com/Hotmail and work/school accounts. After creating it, copy the
**Application (Client) ID**.

**2. Grant the mail permissions.** Open the app's **API permissions** page and add
both of these, then follow the consent note:

- **Add a permission → APIs my organization uses → Office 365 Exchange Online →
  Delegated permissions**, and add **`IMAP.AccessAsUser.All`** and **`SMTP.Send`**
  (if Exchange Online is not listed, type "Exchange" in the search box).
- **Add a permission → Microsoft Graph → Delegated permissions**, and add
  **`offline_access`**, **`openid`**, **`email`**, and **`profile`**.
- For **work / school** accounts, click **Grant admin consent for your
  organization**. Personal accounts consent at sign-in and can skip this.

> This step is required. Without these permissions the account still "connects" and
> is added, but no mail loads and sending fails with a credentials error, because
> Outlook's IMAP and SMTP servers reject a token that lacks the mail scopes.

**3. Add the optional ID token claims.** MailExpert takes the mailbox address only from
verified claims, so under **Token configuration → Add optional claim → ID** add **`email`**,
**`xms_edov`** and **`upn`**. Without them the sign-in is refused with `email_not_verified`.
For personal accounts (Outlook.com, Hotmail) Microsoft does not document when `xms_edov` is
sent: before relying on personal accounts, check with a test sign-in that the mailbox connects. A
mailbox is bound to the Microsoft account that connected it (tenant and object id); reconnecting
only updates that account's mailbox, and an administrator can reset the binding. Details:
[docs/operations/microsoft-oauth.md](docs/operations/microsoft-oauth.md) (in Russian).

Then follow the steps for your account type:

**Personal accounts (Outlook.com / Hotmail)** (public client, device code):

1. In the Azure app, open **Authentication** and set **"Allow public client flows"**
   to **Yes**. No client secret or redirect URI is needed.
2. In Integrations → Microsoft 365, enter the **Client ID** and **Tenant ID**
   (`common`), leave Client Secret and Redirect URI blank, then save.
3. Start the device-code flow shown there. MailExpert displays a short code; visit
   [microsoft.com/devicelogin](https://microsoft.com/devicelogin) and enter it to
   authorise.

**Work / school accounts (Microsoft 365)** (confidential client):

1. In the Azure app, open **Authentication → Add a platform → Web**, and set the
   redirect URI to `https://<your-mailexpert-host>/oauth/microsoft/callback` (the exact
   value is shown on the Integrations screen).
2. Under **Certificates & secrets → New client secret**, create a secret and copy its
   **Value** (not the Secret ID).
3. In Integrations → Microsoft 365, enter the Client ID, Tenant ID, Client Secret,
   and Redirect URI, then save and click **Connect Microsoft account**.

### Custom IMAP

Any standard IMAP/SMTP server works. Use port 993 for IMAP (TLS) and
587 (STARTTLS) or 465 (TLS) for SMTP.

---

## Management

```bash
# View all logs
docker compose logs -f

# View backend logs only
docker compose logs -f backend

# Stop
docker compose down

# Stop and delete all data (destructive)
docker compose down -v

# Rebuild after a code change (Docker build-from-source install)
docker compose up -d --build

# Update a native install
git pull && \
  cd frontend && npm ci && npm run build && cd .. && \
  cd backend && npm ci --omit=dev && cd .. && \
  sudo systemctl restart mailexpert   # or: pm2 restart mailexpert
```

## Backup and Restore

Quick, unencrypted, unverified dump for a source-build install — fine for a dev box, not for
production:

```bash
# Backup database
docker exec mailexpert-postgres pg_dump -U mailexpert mailexpert \
  > mailexpert-$(date +%Y%m%d).sql

# Restore database
cat mailexpert-YYYYMMDD.sql | \
  docker exec -i mailexpert-postgres psql -U mailexpert -d mailexpert
```

## Production Deployment

For a production VPS, use the scripted install instead: encrypted, deduplicated, verified
backups (restic to any S3-compatible storage), automatic sign-in and edge (Caddy or Cloudflare
Tunnel) setup, updates from the admin screen or `update.sh` to the promoted `latest` build,
`rollback.sh`, and a way to move the panel to another server without losing data. The shortest path
from a clean VPS is [docs/operations/quickstart.md](docs/operations/quickstart.md); the full map is
[docs/operations/README.md](docs/operations/README.md) (topology, install, mail node, backups,
monitoring, updates, rollback, troubleshooting); the modules and what may run on separate servers
are in [docs/architecture/deployment-system.md](docs/architecture/deployment-system.md). An AI
agent can do the first install and later updates with the `mailexpert-rollout` skill (see
[AGENTS.md](AGENTS.md)); the quick start has a ready prompt for it.

---

## Architecture

### Default deployment (self-signed HTTPS)

```
Browser (HTTPS / HTTP)
  │
  ▼
nginx  (frontend container — ports 443 + 80)
  │
  ├── /api/*  → Node.js backend (port 3000)
  ├── /oauth/ → Node.js backend (port 3000)
  └── /ws     → Node.js backend WebSocket (port 3000)
                    │
                    ├── PostgreSQL  (messages, accounts, users)
                    ├── Redis       (sessions)
                    └── IMAP        (outbound to mail servers)
```

nginx and the backend communicate on an internal Docker network. PostgreSQL and Redis are not exposed outside that network.

### With your own reverse proxy

```
Browser (HTTPS)
  │
  ▼
Your proxy  (Nginx / Traefik / Caddy / etc. — TLS termination)
  │  X-Forwarded-Proto: https
  ▼
nginx  (frontend container — port 80)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

### With automatic HTTPS (--profile https)

```
Browser (HTTPS)
  │
  ▼
Caddy  (ports 80/443 — TLS termination, auto Let's Encrypt)
  │
  ▼
nginx  (frontend container — internal only)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

## Desktop and Android apps

MailExpert remains a self-hosted web app, but the repository includes native wrappers for users who prefer an installed desktop or mobile application:

- Windows, macOS, and Linux use Electron-based packages.
- Android uses a Capacitor WebView wrapper.
- On first launch, the native wrapper prompts for the MailExpert server URL, such as `https://mail.your-domain.com`, stores it locally, and connects to that server.
- Native package sources live under `frontend/packages`.

> **Note:** Prebuilt, signed native apps are not published yet — they are in development and will be attached to a future MailExpert release. For now you can build them locally from source:

```bash
cd frontend
npm ci
npm run electron:dist   # desktop installers (.exe / .dmg / .deb / .rpm)
npm run android:dist    # Android package (.apk / .aab)
```

## Upgrading

Database migrations apply automatically on startup. MailExpert renamed the internal MailFlow identifiers (containers, volumes, database defaults, storage keys), so an existing MailFlow installation cannot be upgraded in place; migrate its data explicitly.

---

## Security notes

- Production installs (`AUTH_MODE=google`) sign users in only through Google or Cloudflare Access; a user must be approved by an administrator (or listed in `BOOTSTRAP_ADMIN_EMAILS`), and the user's status is checked on every request
- With local sign-in (`AUTH_MODE=local`, source builds and test stands) the first registered user becomes the admin automatically; close open registration in Settings → Users and use invitations for other users
- Only administrators change where a mailbox connects and how it signs in (servers, ports, TLS, user names, passwords); for anyone else such a change is refused (`connection_admin_only`), so stored credentials are never sent to a host a user chose
- Inbox rules are shared: every user sees every rule with its author and forwarding target, and creating, changing, deleting or running rules is written to the audit log
- Enable two-factor authentication in Settings → Security — supports TOTP (authenticator app), email OTP fallback, and persistent device trust. TOTP codes are one-time and cannot be replayed within their validity window
- Session cookies are `HttpOnly`, `SameSite=Lax`, with a 7-day TTL. The `Secure` flag is set automatically when the connection is HTTPS (direct or via a proxy that forwards `X-Forwarded-Proto: https`)
- Passwords are bcrypt-hashed (cost factor 12)
- Sign-in steps are rate-limited per purpose (password sign-in, 2FA steps, registration, password reset each have their own counters; by default 10 per 15 minutes, configurable by an administrator): password sign-in counts only failures, per account and address, per account from all addresses and per address; a trusted device is held only by the address limit
- The client address comes from `TRUST_PROXY` (the number of proxies in front of the backend: `1` for `docker-compose.yml`, `2` in the production overlay); a larger value than the real proxy chain lets a client forge its address
- Password reset tokens are consumed atomically — concurrent reset requests cannot both succeed
- Database and Redis are not exposed outside the Docker network
- IMAP/SMTP passwords and OAuth tokens are stored in the database encrypted with `ENCRYPTION_KEY`; protect the server, the database volume and the `.env` that holds the key
- Responses set a strict `Content-Security-Policy`, clickjacking protection via `X-Frame-Options`, and a restrictive `Referrer-Policy`
- Email HTML is sanitized before rendering, including stripping external `url()` references from CSS style blocks to prevent tracking
