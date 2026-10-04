---
name: mailexpert-rollout
description: Use when installing, updating, verifying or rolling back a MailExpert deployment over SSH - the panel (install.sh, update.sh, status.sh), the tenant worker, the edge, or the mailcow mail node (setup.sh, node-backup, node-restore). Triggers - "deploy MailExpert", "roll out sha-...", "update the panel", "раскатай", "обнови панель", "обнови узел", "откати обновление", "check the server before updating".
---

# MailExpert rollout

## Overview

Deploying MailExpert is running the scripts in `scripts/deploy/` on the servers, in the order the
operator docs give, with a human approving every change. This skill is how an agent does that
safely. The human-readable map is `docs/operations/README.md`; the modules, what may be split
across servers and the version rules are in `docs/architecture/deployment-system.md`. Read both
before the first rollout in a session.

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
  images. Never run `promote.yml` yourself unless the owner explicitly asks for that promotion.
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
- Update mailcow and the panel in the same window.
- Report "done" because a command exited 0: confirm with the post-checks below.

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

The updater rolls back by itself only after `update.sh` exit 1 when the preflight read the schema,
nothing was pending and the migration count did not change (`state: rolled_back`); `failed` or
`rollback_failed` means the Rollback section below, by a person's decision.

First install of a panel: `docs/operations/deployment.md`, section 2. Run `install.sh` with the
human's flags (detached); exit 3 lists the missing secrets: hand the list to the human, who feeds
`configure.sh` from a file; then rerun `install.sh`. First install of a node: `mail-node.md`,
sections 3-4 (mailcow itself is the human's step: `generate_config.sh` asks questions).

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
  0 done, 1 failed after the stop (read its output), 2/3 nothing changed. Never drop the kept
  database yourself.
- **Edge** without `rollback.sh`: put the old digest (`state/edge-image.previous`) back into
  `EDGE_IMAGE`, `install.sh` (GATE).
- **Node scripts**: previous commit in `/opt/mailexpert-node-src`, `setup.sh` (GATE).
- Node data: `node-restore.sh` only onto a clean server (`mail-node.md`, section 8). Never on a
  live node.

## Reporting

State: target and previous version, every command run with its exit code, the post-check output
(trimmed), `next:` steps left for the human, and anything skipped. No secret values, no full
`.env`, no IPs that the human did not already give you.
