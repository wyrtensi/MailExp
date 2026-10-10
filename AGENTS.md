# Agent instructions

A primer for an AI agent working in this repository: what the product is, where things live, the
rules, and how to verify a change. Read it every session; follow the links only when the task needs
the detail.

## What MailExpert is

A self-hosted webmail **panel for a team that works shared mailboxes**: a fork of
[MailFlow](https://github.com/maathimself/mailflow) (AGPL-3.0, see `CONTRIBUTING.md`). The product
model:

- **Mailboxes belong to the installation, not to a person.** The server keeps every mailbox
  connected (IMAP/SMTP, Gmail through Google OAuth, Microsoft 365 through OAuth). Every signed-in
  user sees all mailboxes, reads and sends from them. There is no per-mailbox access control.
- **Users and admins.** Users are approved rows in `users` (or `BOOTSTRAP_ADMIN_EMAILS`); sign-in is
  Google or Cloudflare Access (`AUTH_MODE=google`), local passwords only on test stands
  (`AUTH_MODE=local`). Admins own system settings, users, integrations, the mail node, the tenant
  and panel updates. A mailbox's connection fields (server, port, sign-in) are admin-only; inbox
  rules are shared, visible to everyone and journaled.
- **Audit log** (`mailbox_audit_log`, `services/auditLog.js`): who did what with mailboxes, letters,
  rules, users, the node, the tenant, updates.
- **Mail node**: an optional separate mailcow server for mailboxes on the owner's own domains,
  behind **Microsoft EOP** (inbound and outbound through Exchange Online Protection). The panel
  drives mailcow only through its API (domains, mailboxes, quotas, quarantine, queue, logs). The
  **tenant driver** (`services/tenant/`) does the Microsoft tenant side (accepted domains,
  connectors, anti-spam policy, message trace, quarantine release) through the optional
  `tenant-worker` container (EXO PowerShell + Graph); `TENANT_DRIVER=fake` on stands and in tests.
- **Durable job queue** (`services/jobQueue.js`, table `jobs`): undo send (5 s) and send later,
  tenant jobs. `send_message` is at most once; every other kind at least once.
- **Delivery status**: per-letter delivery and bounces for node mailboxes, from Postfix logs and
  EOP message trace (`services/deliveryStatus.js`, `routes/delivery.js`).
- **Plugins**: a plugin layer (`backend/src/plugins/`, `frontend/src/plugins/`); GTD is the bundled
  one.
- **Operations**: one-command install, updates from the panel or `update.sh`, the `latest`
  channel, backups with restic, rollback, an admin CLI (`mailexpert`).

## Map

| Area | Entry points |
|---|---|
| Backend (Node 24, Express 5, ESM) | `backend/src/index.js` (composition root: middleware, route mounts, migrations at start, IMAP manager, job worker, pollers); routes in `backend/src/routes/` (`/api/accounts`, `/api/mail`, `/api/mail-node`, `/api/admin`, `/oauth`, ...); logic in `backend/src/services/` |
| Mail engine | `services/imapManager.js` (connections, IDLE, sync; very large: change surgically), `smtpTransport.js`, `gmailApiSender.js`, `sendQueue.js`, `threading/` |
| Mail node and tenant | `services/mailNode/*` (mailcow client, domains, mailbox actions, quarantine, alerts, outages), `services/tenant/*` (driver, jobs, quarantine release), routes `mailNode*.js` |
| Panel updates | `routes/adminUpdate.js`, `services/panelUpdate/{latest,spool,reconcile}.js` (the panel only writes a request file; the host's `updater.sh` acts) |
| CLI | `backend/src/cli/` (`mailexpert` bin), host wrapper `scripts/deploy/mailexpert-cli.sh`; see `docs/architecture/panel-cli.md` |
| Migrations | `backend/migrations/NNNN_name.sql`, forward only, applied by the backend at start; never rename or edit a merged migration |
| Frontend (React 19, Vite, Zustand) | `frontend/src/main.jsx`, `App.jsx`, `components/MailApp.jsx` (shell), `store/index.js`, `utils/api.js` (all HTTP), `hooks/useWebSocket.js`; settings and admin area in `components/AdminPanel.jsx` plus section components (`MailNodeSection`, `PanelUpdateSection`, ...); pure logic in `utils/*` with `node --test` tests |
| Demo mode | `frontend/src/demo/` (`npm run demo`, `VITE_DEMO_MODE=true`): a fake backend in the browser; `demo/routeCoverage.test.js` fails when a new API path has no demo answer |
| Deploy | `scripts/deploy/` (install, configure, status, update, updater, rollback, backup, restore, healthcheck), `scripts/deploy/lib/`, `deploy/` (prod compose overlay, edge, systemd units, tenant-worker), `scripts/deploy/mail-node/` (node host scripts), `scripts/ci/promote-latest.sh`, `.github/workflows/` |
| Stand | `scripts/deploy/test/stage.sh`, `docs/operations/local-stand.md` |

A per-file map: `docs/architecture/codebase-file-map.md`.

## Where decisions live

- `docs/architecture/*`: `deployment-system.md` (modules, versions, rollout, update from the panel,
  threat model), `job-queue.md`, `panel-cli.md`, `team-mail-system-handoff.md`,
  `upstream-pr-assessment.md`.
- Mail node and EOP: `docs/architecture/mail-node-research/eop-panel-requirements.md`; the owner's
  decisions D-1 ... D-16 are in its section 7.1. Do not reopen a recorded decision; quote it.
- Specs and plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
- Operator docs (Russian): `docs/operations/README.md` (entry point), `quickstart.md`,
  `deployment.md`, `mail-node.md`, `cli.md`; the UI guide: `docs/user-guide/README.md`.

## Rules

- Never read anything under a `data/` directory and exclude it from recursive searches: it holds
  local secrets and client files.
- Docs, PRs and commits use placeholders (`<PANEL_HOST>`, `<APP_HOST>`, `<MAIL_HOST>`,
  `<PANEL_IP>`, `example.com`), never real hosts, addresses or people.
- Code, comments, commits and PR text in English; operator and user docs in Russian; this file and
  the rollout skill in English.
- UI strings live in `frontend/src/locales/{en,ru}.json` with identical keys; `locales/i18n.test.js`
  checks coverage, unused keys and hard-coded strings. Every new UI text goes into both.
- Secrets (OAuth tokens, client secrets, mail passwords) never reach logs, URLs, API responses or
  errors. Keep TLS verification on. More in `CONTRIBUTING.md` (branches, Conventional Commits, test
  first, no weakened tests, no new dependencies without need).
- Do not touch a test stand you were not pointed at, or containers of other compose projects.
- Updating an external module (mailcow and its pinned version, Caddy, cloudflared, PostgreSQL,
  Redis, the restic image, npm dependencies) is a security change. Read the module's release notes
  and security advisories between the two versions, check that what MailExpert relies on still
  holds (the node's firewall and published ports, IPv4-only binding, the mailcow API allow-list,
  TLS, the settings `setup.sh` writes), and fix whatever the new version broke or exposed in the
  same PR. Say in the PR what was checked. Never change mailcow's own code; adapt our scripts and
  configuration instead.
- mailcow's version is pinned in `deploy/mailcow-version` (tag and full commit); the node agent's
  update brings mailcow only to it, with mailcow's own `update.sh`, and only while it is the head of
  mailcow's `master`. Bump it under the rule above: test the upgrade from the previous pin on the
  stand first (`mailcow_update_if_pinned`, docs/operations/mail-node.md section 7a), then change
  both lines in one commit.

## Versions and releases

- One version for every shipped package: `backend`, `frontend`, `frontend/packages` (with both
  lockfiles) and the Android `versionName`. It is what the panel shows (`/api/version`, About).
  Servers still run the `sha-<12>` images and the `latest` channel works as before.
- The scheme (owner's decision): the first release is `1.0.0`; each release is the next patch,
  `1.0.1` ... `1.0.99`, then the minor goes up with patch `0` (`1.1.0` ... `1.1.99`, `1.2.0`).
  A bigger step (a minor before `.99`, a major) only on the owner's explicit request
  (`scripts/ci/release-version.sh set <x.y.z>`).
- A release starts with a separate PR `chore(release): x.y.z` that only bumps the version:
  `scripts/ci/release-version.sh bump` (`current` checks that all files agree; a bats test fails
  when they do not). The owner then runs `promote.yml` on that commit: besides `latest`, it creates
  the annotated tag `v<x.y.z>`, tags the four images `<x.y.z>` (same digest as `sha-<12>`, nothing
  is rebuilt) and makes the GitHub Release `v<x.y.z>` with generated notes. Promoting an already
  released commit (rollback) only moves `latest`; a version tag on another commit or a version not
  above the newest release is refused.
- Never create, move or push `v*` tags by hand and never `git push --tags`. Fetch the `upstream`
  (MailFlow) remote without tags: its `v*` tags collide with ours
  (`git config remote.upstream.tagOpt --no-tags`).

## How to verify a change

| Area | Commands |
|---|---|
| Backend | `cd backend && npm ci && npm test && npm run lint && npm run lint:plugins` (Vitest; `*.pglite.test.js` run against an in-memory PostgreSQL with all migrations) |
| Frontend | `cd frontend && npm ci && npm test && npm run lint && npm run build` (`node --test`, includes i18n and demo route coverage) |
| Deploy scripts | `shellcheck` over `scripts/*.sh deploy/*.sh frontend/*.sh` (as in CI) and `bats scripts/deploy/test` (CI runs `bats/bats:1.14.0` in Docker with `jq` and `git`) |
| Tenant worker | `node --test deploy/tenant-worker/worker.test.mjs` |

CI (`.github/workflows/ci.yml`) runs all of these plus an install e2e and publishes `sha-<12>` images
from green `main`. Report what you ran and its output; "works" without a command is not a result.

## Installing, updating and operating a server

Installing, updating, checking or rolling back a MailExpert server goes through the scripts in
`scripts/deploy/` and follows the skill
[`.claude/skills/mailexpert-rollout/SKILL.md`](.claude/skills/mailexpert-rollout/SKILL.md) (first
install and update). Agents without skill support read that file as plain instructions.

- Start read-only: on a fresh server the discovery in the skill's "First install"; on an existing
  panel `scripts/deploy/status.sh [--target sha-<12>|latest] --json`; on the mail node
  `scripts/deploy/mail-node/setup.sh --dry-run`.
- Show the human a written plan and wait for an explicit "yes" before any step that changes a
  server; ask again before each irreversible step (an install, an update with new migrations, a
  database restore, a mailcow restart, a node restore).
- Never print or copy secret values (`.env` files, `node.env`, PFX and password files, the restic
  recovery key); secrets reach a server only through `configure.sh` on stdin or a `0600` file the
  human provides. Name the keys that are missing, never their values.
- Ask for host names, versions, admin emails and other inputs; never invent them.
- Report what the commands printed (exit codes and post-check output), not that they ran.

The operator map is [docs/operations/README.md](docs/operations/README.md), the shortest install is
[docs/operations/quickstart.md](docs/operations/quickstart.md); modules, topologies and version rules
are in [docs/architecture/deployment-system.md](docs/architecture/deployment-system.md).
