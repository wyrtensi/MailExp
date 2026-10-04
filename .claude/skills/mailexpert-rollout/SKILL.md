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
- The target version `sha-<12>`, or permission to pick the latest green `main` (below).
- For the mail node: `<MAIL_HOST>` SSH target. For a first install: sign-in mode, hosts, admin
  emails (see `docs/operations/deployment.md`, sections 1-3).
- Which components are in scope (panel only, panel + node, tenant).

If any is missing, ask. Do not guess host names, IPs, emails or versions.

## Never

- Print, `cat`, `grep`, copy or paste anything from `<PREFIX>/.env`, `<PREFIX>/edge/.env`,
  `/etc/mailexpert-node/node.env`, `/root/node-backup.env`, PFX or password files. Read key
  *names* only (`status.sh` and the scripts never print values).
- Pass a secret as a command-line argument or put it in chat. Secrets go through `configure.sh`
  (stdin) or a `0600` file the human creates; ask the human to run that step if they prefer.
- Run `install.sh` or `update.sh` over `ssh -t` (a terminal makes `install.sh` print the restic
  recovery key once). Never run `backup.sh --show-recovery-key`; tell the human to run it.
- `docker compose down -v`, `docker volume rm`, `docker system prune`, `dropdb`, `rm` under
  `<PREFIX>/backups` or `<PREFIX>/state`, `git reset --hard` / local edits in `<PREFIX>/app`.
- Use the `latest` image tag, build images on a server, or install Watchtower-like auto-updaters.
- Touch a test stand you were not pointed at, or containers of other compose projects.
- Update mailcow and the panel in the same window.
- Report "done" because a command exited 0: confirm with the post-checks below.

## Phase 1 - Discovery (read-only, no confirmation needed)

Panel. Set `D=<PREFIX>/app/scripts/deploy` in your local shell: the double quotes below expand it
before `ssh` sends the command.

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX> --json"
ssh root@<PANEL_HOST> "systemctl list-timers 'mailexpert-*' --no-pager"
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

Read from the JSON: `problems` (blockers), `warnings`, `notes`, `ready`, `running` vs `version`,
`backup.last_finished_at`, `free_kb`, `tenant_worker`, `edge_image`, `spam_rule`,
`target.images`, `target.pending_migrations`, `target.unknown_migrations`.

Stop and report (do not plan around it) when: `problems` is not empty, `target.unknown_migrations`
is not empty (target older than the schema), an update is running, or the server is standby and
the human did not say it is a move.

## Phase 2 - Plan, shown to the human

Write it in the chat and wait for an explicit "yes". Template:

```
Target: sha-<12> (from sha-<running>), N commits: <one line each, or a summary>
Preflight: <ready/version/backup age/free space/images/problems=none>
Pending migrations: <list or none>  -> rollback without data loss: <yes if none, else "dump only">
Steps:
  1. update.sh sha-<12> on <PANEL_HOST> (pre-update dump + restic snapshot, up to 10 min)   [GATE]
  2. <only if notes say so> node: checkout <commit>, setup.sh --dry-run, setup.sh           [GATE]
  3. <only if notes say so> edge: empty EDGE_IMAGE, install.sh (old digest: <edge_image>)    [GATE]
  4. panel warnings to clear: <spam rule / apply settings / tenant policy>                   [human, in UI]
Post-checks: status.sh, healthcheck.sh, /api/version, sign-in, mailbox status
Rollback triggers: update.sh exit 1; backend restart loop; wrong /api/version; mass mailbox errors
Rollback: <install.sh --version sha-<running> | runbook "Откат обновления" with the dump>
Downtime: backend restart; migrations may add minutes
```

## Phase 3 - Execute (each GATE = ask, wait for "yes", then run exactly that)

Update the panel:

```bash
ssh root@<PANEL_HOST> "$D/update.sh sha-<12> --prefix <PREFIX>"
```

Exit 0: updated, read the `next:` lines. Exit 1: the new version did not become ready and was
left as it is: go to Rollback, do not retry blindly. Exit 2: nothing changed, read the message.

Node scripts, when `next: mail node:` appeared (or the plan says so):

```bash
ssh root@<MAIL_HOST> "git -C /opt/mailexpert-node-src fetch --quiet origin && git -C /opt/mailexpert-node-src checkout --detach <commit>"
ssh root@<MAIL_HOST> "/opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh --dry-run"   # show the diff to the human
ssh root@<MAIL_HOST> "/opt/mailexpert-node-src/scripts/deploy/mail-node/setup.sh"             # GATE: restarts Dovecot/Postfix only on change
```

If `setup.sh` says `mailcow.conf` changed and a full `docker compose down && up -d` of mailcow is
needed, that is a separate GATE: mail stops for the restart, EOP queues inbound mail.

Edge image, when `next: edge: the Caddy image changed` appeared: ask the human to set
`EDGE_IMAGE=` (empty) in `<PREFIX>/edge/.env` or get approval to do exactly that edit with
`sed -i 's/^EDGE_IMAGE=.*/EDGE_IMAGE=/'`, then `install.sh --prefix <PREFIX>` (GATE).

First install of a panel: `docs/operations/deployment.md`, section 2. Run `install.sh` with the
human's flags; exit 3 lists the missing secrets: hand the list to the human, who feeds
`configure.sh` from a file; then rerun `install.sh`. First install of a node: `mail-node.md`,
sections 3-4 (mailcow itself is the human's step: `generate_config.sh` asks questions).

## Phase 4 - Post-checks (report the actual output)

```bash
ssh root@<PANEL_HOST> "$D/status.sh --prefix <PREFIX>"        # result: no problems
ssh root@<PANEL_HOST> "$D/healthcheck.sh --prefix <PREFIX>"   # exit 0
curl -fsS https://<APP_HOST>/api/version                        # sha starts with the target
```

Then ask the human to sign in and look at mailbox status and panel warnings (spam-sort rule,
mail node "Apply settings", tenant anti-spam policy): those actions restart Dovecot or change the
tenant and are the human's clicks.

## Rollback

Triggers: `update.sh` exit 1, backend in a restart loop, `/api/version` not the target, sign-in
broken, many mailboxes red after the update. Report first, then propose:

- **No pending migrations** in the preflight: `install.sh --prefix <PREFIX> --version sha-<old>`
  (GATE). No data loss.
- **Pending migrations were applied**: the runbook `docs/operations/deployment.md`, "Откат
  обновления": stop backend and frontend, restore `backups/pre-update-sha-<old>.dump` into a new
  database, swap by rename, `install.sh --version sha-<old>`. Everything written since the update
  is lost. Separate GATE before the restore and before the rename; show the exact commands with the
  project and database names filled in first.
- **Edge**: put the old digest back into `EDGE_IMAGE`, `install.sh` (GATE).
- **Node scripts**: previous commit in `/opt/mailexpert-node-src`, `setup.sh` (GATE).
- Node data: `node-restore.sh` only onto a clean server (`mail-node.md`, section 8). Never on a
  live node.

## Reporting

State: target and previous version, every command run with its exit code, the post-check output
(trimmed), `next:` steps left for the human, and anything skipped. No secret values, no full
`.env`, no IPs that the human did not already give you.
