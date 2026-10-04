# Mail node host scripts

The parts of a mailcow mail node that have no API: what [`setup.sh`](setup.sh) puts on the host and
what [`eop-ranges.sh`](eop-ranges.sh) keeps current there (requirements R-39 and R-40 in
[eop-panel-requirements.md](../../../docs/architecture/mail-node-research/eop-panel-requirements.md)),
and the node's backup and restore ([`node-backup.sh`](node-backup.sh), [`node-restore.sh`](node-restore.sh)).
Everything the mailcow API can do, the panel does ("Apply settings", runbook section 6). The owner's
runbook is [docs/operations/mail-node.md](../../../docs/operations/mail-node.md), sections 3 and 4,
and 7 and 8 for the backup and the move.

| File | What it is |
|---|---|
| `setup.sh` | one idempotent run on the node host, as root, from a checkout of this repository |
| `eop-ranges.sh` | the EOP ranges, the firewall and the node checks; installed to `/opt/mailexpert-node`, run hourly and at boot |
| `lib.sh` | shared by both (parsing, mailcow files, ipsets, the `DOCKER-USER` chains) |
| `node-backup.sh` | the nightly backup of the node into restic; installed to `/opt/mailexpert-node` once the restic keys are stored |
| `node-restore.sh` | restores a node backup onto a fresh server (a move, a rebuilt node) |
| `backup-lib.sh` | shared by the two and `setup.sh`; uses the panel's `lib/backup.sh` (restic in its pinned container) |
| `extra-cf.sh` | edits one `key = value` line of Postfix's `extra.cf`; the local stand uses it too |
| `dovecot-extra.conf` | the Dovecot settings `setup.sh` keeps as a block in `data/conf/dovecot/extra.conf` |
| `systemd/`, `cron/` | the timers, the boot unit, and the cron files for a host without systemd |

## setup.sh

```bash
sudo scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --eop-host <EOP_HOST> \
  --mailcow-dir /opt/mailcow-dockerized --ping-url <Healthchecks check URL> --dry-run
```

Without `--dry-run` it does, in this order, and only where something differs:

1. `mailcow.conf`: `SKIP_CLAMD=y`, `SKIP_OLEFY=y`, `SKIP_FTS=y`, `ENABLE_IPV6=false` (decision D-13)
   and every mail port published on IPv4 only: `SMTP_PORT`, `SMTPS_PORT`, `SUBMISSION_PORT`,
   `IMAP_PORT`, `IMAPS_PORT`, `POP_PORT`, `POPS_PORT`, `SIEVE_PORT` become `0.0.0.0:<port>` (an IPv4
   address already given, `<NODE_IP>:25`, stays). Without an address Docker also publishes them on
   `[::]` through `docker-proxy` — even with `ENABLE_IPV6=false`, checked on the local stand — and that
   traffic goes through `INPUT`, past `DOCKER-USER`, and reaches mailcow from the bridge's gateway,
   which mailcow's `mynetworks` trusts. Other lines stay, the file is replaced through a temporary
   file and keeps its owner and mode; the output names only the keys it sets (the file holds
   passwords). A change takes a full `docker compose down && docker compose up -d` of mailcow; the
   script says so and does not do it.
2. `data/conf/postfix/extra.cf`: `relayhost = <EOP_HOST>` (decision D-12), other lines kept;
   `postfix-mailcow` restarts only when the line changed. Without `--eop-host` (no tenant yet) the
   step is skipped; run the script again once the first domain's MX is known.
3. `data/conf/dovecot/extra.conf`: `dovecot-extra.conf` between `# BEGIN MailExpert` / `# END
   MailExpert` markers; `dovecot-mailcow` restarts only on a change (IMAP sessions reconnect). A copy
   appended by hand earlier becomes the block. If the same settings stand outside the block, the
   script stops before writing anything and lists the lines to remove. A restart that fails leaves a
   marker in `/var/lib/mailexpert-node`, and the next run tries again.
4. `/etc/mailexpert-node/node.env` (0600): mailcow's directory, the `ENABLE_IPV6` it set, the panel
   addresses (each an address, or a network no wider than /24 or /48), `EOP_HOST`, the Healthchecks
   URL of the timer (`EOP_RANGES_PING_URL`) and the installation's `EOP_CLIENT_REQUEST_ID` (made once,
   or `--client-request-id`). A later run without options reuses them.
5. `eop-ranges.sh`, `lib.sh`, `common.sh`, `env.sh` copied to `/opt/mailexpert-node`, and one run of
   `eop-ranges.sh`, which fills the ipsets, puts the firewall in place and checks the node. If that
   first run fails and no firewall rule is in place, the script exits 1 (the port 25 rule is never
   installed while the EOP set is empty: it would shut EOP out).
6. Other `DOCKER-USER` rules on the mail ports (left from setting the firewall up by hand) are listed
   with a warning: remove them, and from `netfilter-persistent`'s saved rules.
7. `mailexpert-eop-ranges.timer` (hourly; restarted when its unit changed) and
   `mailexpert-node-firewall.service` (boot, before Docker), or `/etc/cron.d/mailexpert-node` on a
   host without systemd.

Exit codes: 0 done, 1 a step failed, 2 invalid input. Missing tools (`curl`, `jq`, `ipset`,
`iptables`, `flock`, `ss`) are installed with `apt-get`. Docker's nftables firewall backend
(`"firewall-backend": "nftables"` in `/etc/docker/daemon.json`) has no `DOCKER-USER` chain: the script
and the timer refuse it.

The timer runs the copy in `/opt/mailexpert-node`, which every run of `setup.sh` replaces: to update
it, pull the checkout and run `setup.sh` again (without options it reuses `node.env`). Run it again
after every mailcow update as well: mailcow's `update.sh` turns `ENABLE_IPV6` back on where the host
has IPv6 (the hourly run notices and fails its ping until then).

## The firewall

Docker publishes mailcow's ports past `ufw`, so the rules live in `DOCKER-USER`, which jumps to the
chain `MAILEXPERT-NODE` (or its alternate `MAILEXPERT-NODE-2`, see below):

```
-o br-mailcow ! -i br-mailcow -p tcp --dport 25 -m set --match-set mailexpert-eop4 src -j RETURN
-o br-mailcow ! -i br-mailcow -p tcp --dport 25 -j DROP
-o br-mailcow ! -i br-mailcow -p tcp -m multiport --dports 587,993 -s <PANEL_IP> -j RETURN
-o br-mailcow ! -i br-mailcow -p tcp -m multiport --dports 587,993 -j REJECT --reject-with tcp-reset
-o br-mailcow ! -i br-mailcow -p tcp -m multiport --dports 110,143,465,995,4190 -j DROP
```

- Only traffic to a published port: out through mailcow's bridge (`br-mailcow`, fixed in mailcow's
  `docker-compose.yml`) and not in through it. mailcow's own mail going out to EOP on port 25 and
  traffic between its containers never match; no external interface has to be guessed, and a
  second uplink is covered too.
- The ports are the containers' (`DOCKER-USER` sees packets after Docker's DNAT), so a host port
  moved in `mailcow.conf` (`SMTP_PORT=<NODE_IP>:25`, `SUBMISSION_PORT=...`) is still covered.
- 587 and 993 answer others with a TCP reset, so a client that tries another address (the panel over
  IPv6, say) gives up at once instead of waiting. With IPv6 enabled, give the panel's IPv6 address
  too (`--panel-ip <PANEL_IP>,<PANEL_IPV6>`).
- Unchanged: nothing is done. "Unchanged" means the wanted rules, the chain exactly as the last
  build left it (as `iptables -S` prints it, so a chain flushed or edited by hand, or wiped by a
  `firewalld` reload, is rebuilt) and exactly one jump.
- A change is built into the other chain of the pair; `DOCKER-USER` jumps to it first, then the old
  jump goes and the old chain is emptied and deleted. If the old chain cannot be deleted (something
  else refers to it), it stays empty and the next change builds into it: the chain in force never
  loses its jump.
- IPv6 (`ip6tables`, set `mailexpert-eop6`) when `ENABLE_IPV6=true` in `mailcow.conf` or when Docker
  made an IPv6 `DOCKER-USER`. A list without IPv6 ranges leaves the IPv6 set empty: port 25 is then
  closed to IPv6.
- Neither ipsets nor rules survive a reboot: `mailexpert-node-firewall.service` runs
  `eop-ranges.sh --restore` before Docker starts (it makes `DOCKER-USER`; Docker keeps an existing
  one), from the last good list, without asking Microsoft. It is wanted by `docker.service`, not
  required: a failed restore does not keep mail down, and the hourly run fails its ping and puts the
  rules in place again. With cron instead of systemd the restore comes a minute after the boot, so
  for that minute the ports are published without the rules.

## eop-ranges.sh

```bash
/opt/mailexpert-node/eop-ranges.sh            # what the timer runs
/opt/mailexpert-node/eop-ranges.sh --dry-run  # what would change
/opt/mailexpert-node/eop-ranges.sh --force    # fetch the ranges even if the version is the same
/opt/mailexpert-node/eop-ranges.sh --restore  # the boot run
```

Each run asks `https://endpoints.office.com/version/Worldwide` with the installation's
`ClientRequestId` (without one the service answers 400). The same version as last time asks nothing
more: the sets are compared with the saved list and refilled from it if they differ. A new version
fetches `/endpoints/Worldwide?ServiceAreas=Exchange` and keeps the entries of the `Exchange` service
area whose `tcpPorts` carry 25 (blanks around the commas allowed, unknown fields skipped, never by
`id`): the same filter as `rangesFromEndpoints` in `backend/src/services/mailNode/eopRanges.js`. The
list is applied only whole: every CIDR valid, none wider than /8 (IPv4) or /24 (IPv6), at least one
IPv4 range. An empty, malformed or too wide list, HTTP 400 or 429, any other error or no answer
changes nothing. A good list is filled into a temporary ipset and swapped in (`ipset swap`), then
written to `/var/lib/mailexpert-node/eop-ranges.txt` (one CIDR per line, IPv4 first; through a
temporary file) and the version to `eop-version`. `--restore` checks the saved list the same way.

Then every run checks the node: the firewall is in place, `mailcow.conf` still has the `ENABLE_IPV6`
that `setup.sh` set, and with IPv6 off nothing listens on the mail ports over IPv6 (`ss -ltn`). Any
problem, or any failure above, pings `<EOP_RANGES_PING_URL>/fail` with the reasons and exits 1;
otherwise the run pings success. On the old node of a move (standby after `node-backup.sh --tag
move`) the run keeps the firewall but pings nothing: the new node pings the same check.

The list file is the same list the panel applies as mailcow forwarding hosts (R-12); the panel has
its own copy in `eopRanges.js` and shows its version in the apply result. When the version changes,
the success ping's body starts with `eop_ranges_version_changed <old>-><new>`: in Healthchecks, set
the check's filtering to treat a body containing `eop_ranges_version_changed` as a failure, so the
change alerts once (the next hourly ping recovers it) and the panel's copy gets bumped
(`backend/scripts/update-eop-ranges.mjs`).

The units run with `NoNewPrivileges`, `PrivateTmp`, `ProtectHome` and `ProtectSystem=full`; they
write only `/var/lib/mailexpert-node`.

## node-backup.sh and node-restore.sh

```bash
sudo scripts/deploy/mail-node/setup.sh --backup-keys < node-backup.env   # KEY=VALUE lines, see below
/opt/mailexpert-node/node-backup.sh                       # what mailexpert-node-backup.timer runs, 02:30
/opt/mailexpert-node/node-backup.sh --tag manual --verify # now, with the restore check
/opt/mailexpert-node/node-backup.sh --status              # the last backup; exit 1 when older than 26 h
/opt/mailexpert-node/node-backup.sh --show-recovery-key
/opt/mailexpert-node/node-backup.sh --tag move            # the last one before a move: postfix and dovecot stopped
scripts/deploy/mail-node/node-restore.sh latest|<id> [--host <restic host>] [--rehearsal | --update] < keys
```

`--backup-keys` takes `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` (stored once, never replaced),
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `NODE_BACKUP_PING_URL`,
`NODE_BACKUP_READ_SUBSET` (default `5%`), `NODE_BACKUP_DUMP_TIMEOUT` (3600) and
`NODE_BACKUP_PUSH_TIMEOUT` (43200) on stdin into `node.env`; `setup.sh` then opens the repository
(creating it when it does not exist), shows the recovery key once in a terminal and enables the
timer. The node's repository is its own, with its own password (`s3:https://<endpoint>/<bucket>/node`):
the same restic code as the panel's backups (`lib/backup.sh`), the node's restic host
`mailexpert-node-<hex>`.

A run: mailcow's own `helper-scripts/backup_and_restore.sh backup crypt redis rspamd postfix mysql`
into `/var/backups/mailexpert-node/mailcow` (after a free space check), every archive checked (the
script exits 0 when a step failed), mailcow's configuration files, certificates, override,
`node.env` and `meta.json` (the mailcow commit) added; then one `restic backup` of that dump
(`/backup`) and of the vmail volume mounted read-only (`/vmail`), tags `mailcow` and the run's tag.
vmail goes past mailcow's script: it would tar all mail locally first (a second full copy on the
disk), and a compressed tar deduplicates poorly where maildir files deduplicate almost whole.
Retention: 7 daily, 4 weekly, 6 monthly, every `move`; the nightly run on Sunday prunes. On Sundays
and with `--verify`: `restic check --read-data-subset`, and the dump plus one mailbox (another each
week) restored into a temporary directory with `--verify`, mailcow's archives listed whole in
mailcow's backup image. The local dump is removed; `/var/lib/mailexpert-node/backup-last.json` keeps
the time, sizes and durations; pings go to `NODE_BACKUP_PING_URL` (start, success, `/fail`). The panel
does not read any of this: it reaches the node only through the mailcow API, so a missed or failed
backup is the Healthchecks check's to report.

`node-restore.sh` on a fresh server (mailcow cloned at the backup's commit, `generate_config.sh` run, nothing started):
`/backup` into a temporary directory, mailcow.conf and the files in place, `docker compose pull` and
`up -d`, vmail from restic straight into the volume (Dovecot stopped; `--overwrite if-changed
--delete`, so an update downloads only what changed), then mailcow's own `restore` with its questions
answered, once `mailcow_restore_prompts_ok` has checked that this version of the script asks exactly
those. `--rehearsal` leaves the mail queue (Postfix's data set) out; `--update` brings a server it
restored before to a newer snapshot (the move, after a rehearsal).

## Tests

```bash
docker run --rm -v "$PWD:/code:ro" -w /code --entrypoint bash bats/bats:1.14.0 \
  -c 'apk add --no-cache -q jq && bats scripts/deploy/test'
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable scripts/deploy/mail-node/*.sh
```

`scripts/deploy/test/mail-node-setup.bats`, `mail-node-eop-ranges.bats` and `mail-node-backup.bats` run
with `docker` (restic inside it: `mock-restic`), `git`, `iptables`, `ip6tables`, `ipset`, `curl`, `ss`
and `systemctl` mocked (`test/mail-node/mocks/`) and mailcow's backup script replaced by
`test/mail-node/fake-backup-and-restore` (its layout and its questions); the
web service answers are recorded (`test/mail-node/version.json`, `endpoints.json`, 2026-10-02,
version `2026081400`).
