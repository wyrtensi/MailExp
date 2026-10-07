---
name: mailexpert-rollout
description: Use when installing MailExpert on a fresh server, or updating, verifying or rolling back a MailExpert deployment over SSH - the panel (install.sh, update.sh, status.sh), the tenant worker, the edge, or the mailcow mail node (setup.sh, node-backup, node-restore). Triggers - "install MailExpert on <host>", "поставь MailExpert на сервер", "deploy MailExpert", "roll out sha-...", "update the panel", "раскатай", "обнови панель", "обнови узел", "откати обновление", "check the server before updating".
---

# MailExpert rollout

## Overview

MailExpert is a self-hosted panel for a team working shared mailboxes (Gmail, Microsoft 365, IMAP,
and optionally mailboxes on the owner's domains on a mailcow **mail node** behind Microsoft EOP).
A deployment is: the **panel** on one server (docker compose project: frontend, backend, postgres,
redis, optional tenant-worker; a separate `edge` project with Caddy and/or cloudflared; systemd
timers for backup and health; the updater units behind the panel's "Обновить" button) and an
optional **mail node** on a second server. `AGENTS.md` is the project primer.

Deploying MailExpert is running the scripts in `scripts/deploy/` on the servers, in the order the
operator docs give, with a human approving every change. This skill is how an agent does that
safely, for a first install ("First install" below) and for updates and rollbacks (Phases 1-4).
The human-readable map is `docs/operations/README.md`, the shortest install
`docs/operations/quickstart.md`; the modules, what may be split across servers and the version
rules are in `docs/architecture/deployment-system.md`. Read them before the first rollout in a
session.

**Core rule:** look first, write the plan down, get a "yes", run the repo's scripts (never
hand-rolled docker commands), verify, report what the commands printed.

## Inputs you must get from the human (never invent them)

- `<PANEL_HOST>`: SSH target of the panel server, and `<PREFIX>` (default `/opt/mailexpert`).
- The target version `sha-<12>`. The production channel is `latest`: the build the owner promoted
  as ready for production with the `promote.yml` workflow (git tag `latest` plus image tags
  `latest` on the same digests; deployment-system.md, section 9). Default to `latest` when the
  human says "update"; another `sha-<12>` only when the human names it, the latest green `main`
  (below) only when the human agrees to it. A channel is always resolved to its `sha-<12>` first
  (`update.sh latest` and `status.sh --target latest` do it): servers only ever run `sha-<12>`
  images. Never run `promote.yml` yourself unless the owner explicitly asks for that promotion (it
  runs only from main and needs a tag ruleset on `latest`, see docs/operations/README.md, section 9).
- For the mail node: `<MAIL_HOST>` SSH target. For a first install: sign-in mode, hosts, admin
  emails (see `docs/operations/deployment.md`, sections 1-3).
- Which components are in scope (panel only, panel + node, tenant).

If any is missing, ask. Do not guess host names, IPs, emails or versions.

## Never

- Print, `cat`, `grep`, copy or paste anything from `<PREFIX>/.env`, `<PREFIX>/edge/.env`,
  `/etc/mailexpert-node/node.env`, `/root/node-backup.env`, PFX or password files. `status.sh`
  prints no secrets (its `edge_image` is a public image digest).
- Pass a secret as a command-line argument or put it in chat. Secrets go through `configure.sh`
  (stdin) or a `0600` file the human creates; ask the human to run that step if they prefer.
- Run `install.sh` or `update.sh` over `ssh -t` (a terminal makes `install.sh` print the restic
  recovery key once). Never run `backup.sh --show-recovery-key`; tell the human to run it.
- Run a long step (`update.sh`, `install.sh`, `restore.sh`) in the foreground of an SSH session: a
  dropped connection kills it halfway. Use the detached form in Phase 3.
- `docker compose down -v`, `docker volume rm`, `docker system prune`, `dropdb`, `rm` under
  `<PREFIX>/backups` or `<PREFIX>/state`, `git reset --hard` / local edits in `<PREFIX>/app`.
- Deploy a mutable image tag (`latest` as a tag on a server), build images on a server, or install
  Watchtower-like auto-updaters.
- Touch a test stand you were not pointed at, or containers of other compose projects.
- Update mailcow to anything but the version `deploy/mailcow-version` pins, or in the same window as
  the panel by hand (the node agent's update does it after the panel, by design).
- Report "done" because a command exited 0: confirm with the post-checks below.

## First install (fresh server)

The human-facing version of this flow, with the copy-paste prompt that starts it, is
`docs/operations/quickstart.md`. Flags and sign-in modes: `docs/operations/deployment.md`,
sections 2-3.

### F1. Ask the human (do not guess any of it)

- `<PANEL_HOST>`: SSH target (root, or a user with passwordless `sudo`; key-based). `<PREFIX>`
  stays `/opt/mailexpert` unless they say otherwise.
- Sign-in mode: `direct` (Caddy on `<DIRECT_HOST>`, "Войти через Google"), `cf` (Cloudflare Tunnel
  to `<CF_HOST>` and Cloudflare Access) or `both`; the host names; admin emails (`--admin-email`,
  required unless `--local-auth`). `--local-auth` is for test stands only: say so if they ask for it.
- Version: `latest` (default) or a `sha-<12>` they name.
- Backups now or later (an S3-compatible bucket at a different provider) and a Healthchecks check.
- Mail node yes/no; if yes, `<MAIL_HOST>`, SSH access to it and `<PANEL_IP>`.

Tell them which secrets they will have to prepare themselves, by name only (this is
`required_owner_secrets` in `scripts/deploy/lib/config.sh`):

| Mode | Keys |
|---|---|
| `direct` | `DNS_API_TOKEN` (Cloudflare, Zone DNS Edit + Zone Read on the one zone; not with `--edge-tls internal`), `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` (a Google OAuth "Web application" client with redirect URI `https://<DIRECT_HOST>/oauth/login/google/callback`) |
| `cf` | `TUNNEL_TOKEN`, `CF_ACCESS_ISSUER` (`https://<TEAM>.cloudflareaccess.com`), `CF_ACCESS_AUDIENCE` |
| `both` | all of the above |
| `--local-auth` | no sign-in keys; only the edge keys of the mode |
| optional | `RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESTIC_PASSWORD` (16+ characters), `AWS_DEFAULT_REGION` if the storage needs one, `HEALTHCHECK_PING_URL`, `BACKUP_PING_URL` |

You never create these, never see their values and never ask for them in chat.

The Cloudflare side comes **before** `install.sh`: point the human to
`docs/operations/cloudflare.md` (Russian; dashboard steps and the equivalent API calls) and name the
sections their mode needs: `cf`/`both` - section 1 (Zero Trust, Google login method), 2 (remotely
managed tunnel, route `<CF_HOST>` -> `http://127.0.0.1:<APP_HTTP_PORT>`, `TUNNEL_TOKEN`), 3 (Access
application, `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE`); `direct`/`both` - section 4 (`DNS_API_TOKEN`
with Zone DNS Edit + Zone Read on one zone, grey-cloud A record for `<DIRECT_HOST>`). Section 0 is
the token hand-off (broad temporary token -> least-privilege tokens -> revoke). Never call the
Cloudflare API yourself and never take a Cloudflare token into chat. `configure.sh` rejects a
malformed `CF_ACCESS_AUDIENCE` (not 64 lowercase hex) or `TUNNEL_TOKEN` (not base64 of a JSON with
`a`, `t`, `s`) without printing the value: relay its message.

### F2. Discovery (read-only, no confirmation needed)

```bash
ssh root@<PANEL_HOST> "grep -E '^(ID|VERSION_ID)=' /etc/os-release; nproc; awk '/^MemTotal:/ {print \$2\" kB\"}' /proc/meminfo; df -Ph /opt 2>/dev/null || df -Ph /"
ssh root@<PANEL_HOST> "ss -ltnpH '( sport = :80 or sport = :443 or sport = :8080 )'; docker compose version 2>&1 | head -1; dpkg -s docker.io >/dev/null 2>&1 && echo 'docker.io installed'"
ssh root@<PANEL_HOST> "ls -d <PREFIX> <PREFIX>/install.conf 2>&1; ufw status 2>&1 | head -1; ip -4 -o addr show scope global"
getent hosts <DIRECT_HOST>        # from your machine: must be the server's public IPv4 (direct/both)
```

What `install.sh` will insist on (`scripts/deploy/lib/system.sh`): Ubuntu 24.04 (anything else only
with `--no-system`, then Docker Engine with Compose 2.24.4+ is the human's job), at least 2 vCPU,
about 4 GB RAM, 20 GB free disk; ports 80/443 free when Caddy runs; no `docker.io` package with an
old Compose. Stop and report when any of it fails. If `<PREFIX>/install.conf` exists this is not a
first install: switch to Phase 1.

### F3. Plan, shown to the human (wait for an explicit "yes")

```
Server: <PANEL_HOST>, Ubuntu 24.04, <cpu>/<ram>/<disk>; ports 80/443 free; <PREFIX> absent
Version: latest -> sha-<12> (resolved after the clone) | sha-<12> named by you
Mode: direct, <DIRECT_HOST> -> <server IPv4> (DNS checked), admins <emails>
Changes on the server: apt packages (git, curl, jq, ufw, ...), Docker Engine + Compose from
  download.docker.com, 2 GB swap if none, unattended-upgrades, ufw (SSH ports, 80, 443),
  systemd timers mailexpert-backup/-health, mailexpert-updater.path, <PREFIX>
Steps:
  1. clone the tag latest into <PREFIX>/app, check it is on main, resolve sha-<12>      [GATE]
  2. install.sh first run, detached; expected to stop with exit 3 and the list of keys
  3. you: put the keys into a 0600 file and feed configure.sh (command below)            [human]
  4. install.sh again, detached                                                           [GATE]
  5. post-checks; you sign in as <admin>; you fetch the restic recovery key yourself
  6. (mail node) separate plan                                                            [GATE]
```

### F4. Execute

Clone and resolve the version (GATE 1):

```bash
ssh root@<PANEL_HOST> "apt-get update -qq && apt-get install -y -qq git >/dev/null && git clone --quiet --branch latest https://github.com/wyrtensi/MailExpert.git <PREFIX>/app"
ssh root@<PANEL_HOST> "cd <PREFIX>/app && git merge-base --is-ancestor HEAD origin/main && echo on-main && git rev-parse HEAD | cut -c1-12"
```

For a named version clone without `--branch` and `git -C <PREFIX>/app checkout --detach <12>`.
`install.sh --version` accepts only `sha-<12>`, never `latest`. Clone as root (`install.sh` runs git
in that directory as root).

Run `install.sh` detached (never over `ssh -t`, never in the foreground). Set `S=sha-<12>` in your
local shell (the double quotes expand it before `ssh` sends the command); the flags are the
human's:

```bash
ssh root@<PANEL_HOST> "systemctl reset-failed mailexpert-install 2>/dev/null; systemctl stop mailexpert-install 2>/dev/null; systemd-run --unit=mailexpert-install --property=RemainAfterExit=yes <PREFIX>/app/scripts/deploy/install.sh --version $S --signin direct --direct-host <DIRECT_HOST> --admin-email <ADMIN_EMAIL>"
ssh root@<PANEL_HOST> "journalctl -u mailexpert-install -o cat --no-pager -n 100"
ssh root@<PANEL_HOST> "systemctl show mailexpert-install -p SubState -p ExecMainStatus"
```

Exit 3 with `waiting for secrets: <KEYS>` is the expected first result: relay the key names. The
human then runs on the server (or lets you run the `configure.sh` line on the file they created;
you never open or print it):

```bash
install -m 600 /dev/null /root/mailexpert-secrets.env    # the human edits it: KEY=VALUE lines
<PREFIX>/app/scripts/deploy/configure.sh --prefix <PREFIX> < /root/mailexpert-secrets.env
shred -u /root/mailexpert-secrets.env
```

`configure.sh` exits 0 stored, 1 failure (for example `install.sh` held the lock too long), 2
invalid input (it lists the problems, nothing stored). Then rerun the same command line, with its
`reset-failed` and `stop` of `mailexpert-install` first (GATE 4). `install.sh` is
idempotent: rerunning after a failure or a dropped connection is the fix, not a risk. Exit 0 ends
with `done`; exit 1 shows the failing step (`docker compose -p mailexpert logs backend`, `-p edge
logs caddy`); exit 2 is invalid flags.

Run detached, `install.sh` has no terminal and does **not** print the restic recovery key; it logs
how to show it. Tell the human to run `<PREFIX>/app/scripts/deploy/backup.sh --show-recovery-key`
in their own SSH session and store it in a password manager. Never run it yourself.

### F5. Verify and hand over

Phase 4 post-checks (`status.sh`: `ready`, `running` = the version, `problems` empty;
`healthcheck.sh` exit 0, or exit 1 with only `backup: not configured` when backups were left for
later; `/api/version`). With `cf`/`both`, `install.sh` logs `edge: ...` after checking that
`https://<CF_HOST>/api/health` redirects to Cloudflare Access of the team in `CF_ACCESS_ISSUER`;
`status.sh --json` repeats it as `cf_access` (`state`: `ok`, `dns_missing`, `unreachable`,
`tunnel_down`, `origin_error`, `access_missing`, `redirect_elsewhere`, `team_mismatch`). Anything but
`ok` is a warning that names the next step (it never fails the install: DNS can lag); relay it and
the matching row of `docs/operations/cloudflare.md`, section 9. `ok` does not prove the tunnel route
reaches the panel (Access answers first): only the human's sign-in does. Then the human signs in at `https://<APP_HOST>` with an admin email. Report
the version, the commands with exit codes, the warnings `install.sh` printed (`backups are off`,
ufw, `cloudflare access`), and what is left to the human: recovery key, Google apps for Gmail
mailboxes (`docs/operations/google-oauth.md`), the mail node, and with `cf`/`both` the optional
user sync into the Access policy (`docs/operations/cloudflare.md`, section 8: the token goes in
through `mailexpert-cli.sh access token < file`, stdin only, run by the human).

Mail node (separate plan, GATE per step): `docs/operations/mail-node.md`, sections 2-6е (as in quickstart.md, section 8). mailcow's
`generate_config.sh` is interactive: the human runs it. The node's MailExpert scripts are cloned
to `/opt/mailexpert-node-src` at the **panel's commit**, then `setup.sh --dry-run` (show the diff)
and `setup.sh` with `--panel-ip <PANEL_IP>`; the API key and the node settings are entered by the
human in "Настройки → Администрирование → Почтовый узел", or over SSH with the panel CLI
(`docs/operations/cli.md`, sections 3.7-3.10): `mailexpert-cli.sh node config set --mail-host
<MAIL_HOST> --api-key-stdin < file` (stdin only, run by the human), `eop set ...`, `domain add`,
`node apply`. The agent token for `setup.sh --agent-token-file` comes from `mailexpert-cli.sh agent
token issue --out <TOKEN_FILE> --yes` (a 0600 file on the panel host, moved to the node by the
human); never print it into the transcript.

## Reading status.sh

`status.sh --json` prints one JSON object. If the object has an `error` key, or stdout holds no
JSON at all, the script itself failed: that is not a status, stop and report it.

- `problems`: blockers. `warnings`: do not block. `next`: steps a person takes besides `update.sh`.
  `info`: context (what `update.sh` does by itself, what matters for a rollback).
- `target.pending_migrations`: `[]` means none; **`null` means unknown** (the schema could not be
  read: postgres down, standby). Treat `null` exactly like "migrations present": no code-only
  rollback in the plan.
- `target.images.<name>`: `ok`, `missing` (the registry says the tag does not exist) or `unknown`
  (the registry could not be asked: network, credentials, rate limit).
- `cf_access` (tunnel installs only, else `null`): `{state, team}`; a state other than `ok` is in
  `warnings` with its next step, never in `problems`.

## Phase 1 - Discovery (read-only, no confirmation needed)

Panel. Set `D=<PREFIX>/app/scripts/deploy` in your local shell: the double quotes below expand it
before `ssh` sends the command.

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX> --json"
ssh root@<PANEL_HOST> "systemctl list-timers 'mailexpert-*' --no-pager"
```

The promoted `latest` (what the panel's "Обновление панели" card offers):

```bash
gh api repos/wyrtensi/MailExpert/git/ref/tags/latest --jq '.object.sha[0:12]'
```

Whether the host updater behind that card is installed, and what it did last (results hold no
secrets; they are what the panel shows):

```bash
ssh root@<PANEL_HOST> "systemctl is-active mailexpert-updater.path; ls -t <PREFIX>/state/update-spool/result/ | head -3"
```

Latest green version on `main` (CI's `images` job published `sha-<12>` for it):

```bash
gh run list --repo wyrtensi/MailExpert --workflow ci.yml --branch main --status success --limit 1 \
  --json headSha --jq '.[0].headSha[0:12]'
```

Target preflight (it may `git fetch` the commit into `<PREFIX>/app`; nothing else changes):

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX> --target sha-<12> --json"
```

If the installed version predates `status.sh` (`No such file`, or `update.sh --check` answers
"unknown argument"), run it from a fresh shallow clone. The clone is the one write of this phase (a
scratch directory outside `<PREFIX>`): say so to the human, and reuse it
(`git -C /root/mailexpert-next pull`) when it already exists:

```bash
ssh root@<PANEL_HOST> "git clone --depth 1 https://github.com/wyrtensi/MailExpert.git /root/mailexpert-next && /root/mailexpert-next/scripts/deploy/status.sh --prefix <PREFIX> --target sha-<12> --json"
```

Caveat: this reads the old install with today's script. It needs an install made by `install.sh`
(`<PREFIX>/install.conf` exists); a much older install may show problems that are only the gap
between versions (for example image tags or a state file it does not have yet). Treat its output
as advisory, say so in the plan, and lean on `update.sh`'s own checks. The update itself runs from
`<PREFIX>/app` (`update.sh` hands over to the target's installer); afterwards `status.sh` is in
`<PREFIX>/app`.

What changed between the running and the target commit (for the plan):

```bash
gh api repos/wyrtensi/MailExpert/compare/<running12>...<target12> --jq '.commits[].commit.message | split("\n")[0]'
```

Mail node (when in scope):

```bash
ssh root@<MAIL_HOST> "git -C /opt/mailexpert-node-src rev-parse --short=12 HEAD"
ssh root@<MAIL_HOST> "systemctl list-timers 'mailexpert-*' --no-pager; df -h /"
ssh root@<MAIL_HOST> "/opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --dry-run"
```

Stop and report (do not plan around it) when: `problems` is not empty, `target.unknown_migrations`
is not empty (target older than the schema), an image is `missing` or `unknown`, an update is
running, or the server is standby and the human did not say it is a move.

## Phase 2 - Plan, shown to the human

Write it in the chat and wait for an explicit "yes". Template:

```
Target: sha-<12> (from sha-<running>), N commits: <one line each, or a summary>
Preflight: <ready/version/backup age/free space/images/problems=none>
Pending migrations: <list | none | unknown>
  -> rollback without data loss: yes only if "none"; "unknown" counts as present: dump only
Steps:
  1. update.sh sha-<12> on <PANEL_HOST>, detached (pre-update dump + restic snapshot, up to 10 min) [GATE]
     (or: the human presses "Обновить" in Настройки -> Администрирование -> Обновление панели;
     same checks, same update.sh, run by the host updater)
  2. <only if next says so> node: checkout <commit>, setup.sh --dry-run, setup.sh            [GATE]
  3. panel warnings to clear: <spam rule / apply settings / tenant policy>                    [human, in UI]
Edge: <the Caddy image changes: update.sh pulls and pins it, old digest <edge_image> | unchanged>
Post-checks: status.sh (running = target, no problems), healthcheck.sh, sign-in, mailbox status
Rollback triggers: update.sh exit 1; backend restart loop; running != target; mass mailbox errors
Rollback: <install.sh --version sha-<running> | rollback.sh --to sha-<running> (the dump)>
Downtime: backend restart; migrations may add minutes
```

## Phase 3 - Execute (each GATE = ask, wait for "yes", then run exactly that)

Update the panel, detached from the SSH session (a dropped connection does not stop it):

```bash
ssh root@<PANEL_HOST> "systemctl reset-failed mailexpert-update 2>/dev/null; systemctl stop mailexpert-update 2>/dev/null; systemd-run --unit=mailexpert-update --property=RemainAfterExit=yes $D/update.sh sha-<12> --prefix <PREFIX>"
# follow it (re-run after a disconnect; Ctrl-C stops only the viewer):
ssh root@<PANEL_HOST> "journalctl -u mailexpert-update -o cat --no-pager -n 200"
# finished? SubState=running: still going; SubState=exited: ExecMainStatus is update.sh's exit code
ssh root@<PANEL_HOST> "systemctl show mailexpert-update -p ActiveState -p SubState -p ExecMainStatus"
```

Poll every minute or two; do not start anything else on the panel meanwhile (`status.sh` shows
"an update ... is running" while it holds its lock). On a host without systemd:
`nohup $D/update.sh sha-<12> --prefix <PREFIX> >/var/log/mailexpert-update.log 2>&1 &`, then read the
log and `status.sh`.

`update.sh` exit codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | updated | read the `next:` lines, go to Phase 4 |
| 1 | the switch began and the new version did not become ready | Rollback; the log says whether migrations were recorded; never retry blindly |
| 2 | invalid input or a state that forbids an update; nothing changed | read the message, report |
| 3 | failed before the switch (image pull, pre-update backup, any other command); nothing changed, the old version runs | report the cause; confirm with `status.sh` that `running` is still the old version |

Node scripts, when `next: mail node:` appeared (or the plan says so):

```bash
ssh root@<MAIL_HOST> "git -C /opt/mailexpert-node-src fetch --quiet origin && git -C /opt/mailexpert-node-src checkout --detach <commit>"
ssh root@<MAIL_HOST> "/opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --dry-run"   # show the diff to the human
ssh root@<MAIL_HOST> "/opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh"             # GATE: restarts Dovecot/Postfix only on change
```

If `setup.sh` says `mailcow.conf` changed and a full `docker compose down && up -d` of mailcow is
needed, that is a separate GATE: mail stops for the restart, EOP queues inbound mail.

mailcow itself (GATE: mail stops for minutes): only to the version `deploy/mailcow-version` of the
node's checkout pins. With the node agent the update job does it; by hand, after a pre-update node
backup, the same code: `sudo bash -c '. /opt/mailexpert-node-src/scripts/deploy/mail-node/node-update.sh; SRC=/opt/mailexpert-node-src; mailcow_update_if_pinned'`
(exit 0 updated or skipped with the reason, 1 failed: `docker compose up -d` in the mailcow
directory; `docs/operations/mail-node.md`, section 7a).

Edge image: when the Caddy image changes between the versions (`info: edge: the Caddy image
changed`), `update.sh` pulls the new one before the backup, pins it by digest and keeps the old
`EDGE_IMAGE` in `<PREFIX>/state/edge-image.previous`; nothing to do by hand.

Update from the panel (the human's button) runs the same `update.sh` through the host updater
(`mailexpert-updater.path` -> `.service` -> `updater.sh`). If the human pressed it, do not start
`update.sh` yourself; follow it read-only:

```bash
ssh root@<PANEL_HOST> "journalctl -u mailexpert-updater.service -o cat --no-pager -n 200"
ssh root@<PANEL_HOST> "jq '{state, message, exitCode, next}' <PREFIX>/state/update-spool/result/<request id>.json"
```

The button installs only exactly the promoted `latest` (on main, newer than the running version,
not a version that was rolled back); any other version is `update.sh sha-<12>` over SSH after the
human's "yes". The updater rolls back by itself only after `update.sh` exit 1 when the preflight
read the schema, nothing was pending and the migration count did not change
(`state: rolled_back`); any other exit code means no rollback. `failed` or `rollback_failed` means
the Rollback section below, by a person's decision. A version left by a rollback
(`<PREFIX>/state/rolled-back-version`) is not offered again until a newer build is promoted; do not
delete that file to get around it.

First install of a panel or a node: the "First install" section above.

## Phase 4 - Post-checks (report the actual output)

Check on the server, not through the public URL (it sits behind Cloudflare Access or Google
sign-in):

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX> --json"   # running = target, ready, problems = []
ssh root@<PANEL_HOST> "$D/healthcheck.sh --prefix <PREFIX>"     # exit 0
ssh root@<PANEL_HOST> "curl -fsS http://127.0.0.1:<HTTP_PORT>/api/version"   # HTTP_PORT from install.conf, 8080 by default
```

Then ask the human to sign in and look at mailbox status and panel warnings (spam-sort rule,
mail node "Apply settings", tenant anti-spam policy): those actions restart Dovecot or change the
tenant and are the human's clicks.

## Rollback

Triggers: `update.sh` exit 1, backend in a restart loop, `running` not the target, sign-in broken,
many mailboxes red after the update. Report first.

Before proposing any rollback, read the server's state again, never from memory:

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX> --json"
```

Look at `version` (install.conf), `checkout`, `running`, `ready`, `migrations_applied`. After exit
3 or 2 they still show the old version: there is nothing to roll back. After exit 1 the checkout
and `version` are the target and `running` is usually empty (not ready).

- **No migrations were recorded** (`update.sh` said "no migration was recorded as applied", and
  the preflight's `pending_migrations` was `[]`, not `null`):
  `install.sh --prefix <PREFIX> --version sha-<old>` (GATE, detached). No data loss.
- **Migrations were applied, or it is unknown**: `rollback.sh --prefix <PREFIX> --to sha-<old>`
  (the runbook `docs/operations/deployment.md`, "Откат обновления", as one script: stops backend
  and frontend, restores `backups/pre-update-sha-<old>.dump` into a new database, swaps it in by
  renaming, keeps the replaced database as `<db>_before_rollback_<time>`, restores the Caddy image
  an update replaced, `install.sh --version sha-<old>`). Everything written since the update is
  lost. GATE: show the human the command and what is lost; after an explicit "yes" run it
  detached with `--confirm sha-<old>` (it refuses without a terminal or that flag). Exit codes:
  0 done, 1 failed after the stop (read its output), 2/3 nothing changed (2 also covers too little
  free space: it needs the database size plus the dump). Interrupted after the swap: rerun the same
  command, it only switches the code; if it says install.conf is at the target already, the next
  step is `install.sh --prefix <PREFIX>` (GATE). Never drop the kept database yourself.
- **Edge** without `rollback.sh`: put the old digest (`state/edge-image.previous`) back into
  `EDGE_IMAGE`, `install.sh` (GATE).
- **Node scripts**: previous commit in `/opt/mailexpert-node-src`, `setup.sh` (GATE).
- Node data: `node-restore.sh` only onto a clean server (`mail-node.md`, section 8). Never on a
  live node.

## Reporting

State: target and previous version, every command run with its exit code, the post-check output
(trimmed), `next:` steps left for the human, and anything skipped. No secret values, no full
`.env`, no IPs that the human did not already give you.
