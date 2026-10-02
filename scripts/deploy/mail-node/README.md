# Mail node host scripts

The parts of a mailcow mail node that have no API: what [`setup.sh`](setup.sh) puts on the host and
what [`eop-ranges.sh`](eop-ranges.sh) keeps current there (requirements R-39 and R-40 in
[eop-panel-requirements.md](../../../docs/architecture/mail-node-research/eop-panel-requirements.md)).
Everything the mailcow API can do, the panel does ("Apply settings", runbook section 6). The owner's
runbook is [docs/operations/mail-node.md](../../../docs/operations/mail-node.md), sections 3 and 4.

| File | What it is |
|---|---|
| `setup.sh` | one idempotent run on the node host, as root, from a checkout of this repository |
| `eop-ranges.sh` | the EOP ranges and the firewall; installed to `/opt/mailexpert-node`, run hourly and at boot |
| `lib.sh` | shared by both (parsing, mailcow files, ipsets, `DOCKER-USER` chain) |
| `extra-cf.sh` | edits one `key = value` line of Postfix's `extra.cf`; the local stand uses it too |
| `dovecot-extra.conf` | the Dovecot settings `setup.sh` keeps as a block in `data/conf/dovecot/extra.conf` |
| `systemd/`, `cron/` | the timer, the boot unit, and the cron file for a host without systemd |

## setup.sh

```bash
sudo scripts/deploy/mail-node/setup.sh --panel-ip <PANEL_IP> --eop-host <EOP_HOST> \
  --mailcow-dir /opt/mailcow-dockerized --ping-url <Healthchecks check URL> --dry-run
```

Without `--dry-run` it does, in this order, and only where something differs:

1. `mailcow.conf`: `SKIP_CLAMD=y`, `SKIP_OLEFY=y`, `SKIP_FTS=y`, `ENABLE_IPV6=false` (decision D-13).
   Other lines stay, the file keeps its mode. A change takes a full `docker compose down && docker
   compose up -d` of mailcow; the script says so and does not do it.
2. `data/conf/postfix/extra.cf`: `relayhost = <EOP_HOST>` (decision D-12), other lines kept;
   `postfix-mailcow` restarts only when the line changed. Without `--eop-host` (no tenant yet) the
   step is skipped; run the script again once the first domain's MX is known.
3. `data/conf/dovecot/extra.conf`: `dovecot-extra.conf` between `# BEGIN MailExpert` / `# END
   MailExpert` markers; `dovecot-mailcow` restarts only on a change (IMAP sessions reconnect). A copy
   appended by hand earlier becomes the block. If the same settings stand outside the block, the
   script stops before writing anything and lists the lines to remove.
4. `/etc/mailexpert-node/node.env` (0600): mailcow's directory, the panel addresses, the external
   interface (the default route's, or `--ext-if`), `EOP_HOST`, the Healthchecks URL of the timer
   (`EOP_RANGES_PING_URL`) and the installation's `EOP_CLIENT_REQUEST_ID` (made once, or
   `--client-request-id`). A later run without options reuses them.
5. `eop-ranges.sh`, `lib.sh`, `common.sh`, `env.sh` copied to `/opt/mailexpert-node`, and one run of
   `eop-ranges.sh`, which fills the ipsets and puts the firewall in place. If that first run fails,
   no firewall rule is installed (the port 25 rule would shut EOP out) and the script exits 1.
6. `mailexpert-eop-ranges.timer` (hourly) and `mailexpert-node-firewall.service` (boot), or
   `/etc/cron.d/mailexpert-node` on a host without systemd.

Exit codes: 0 done, 1 a step failed, 2 invalid input. Missing tools (`curl`, `jq`, `ipset`,
`iptables`, `flock`) are installed with `apt-get`.

The timer runs the copy in `/opt/mailexpert-node`, which every run of `setup.sh` replaces: to update
it, pull the checkout and run `setup.sh` again (without options it reuses `node.env`).

## The firewall

Docker publishes mailcow's ports past `ufw`, so the rules live in `DOCKER-USER`, which jumps to the
chain `MAILEXPERT-NODE`:

```
-i <ext> -p tcp --dport 25 -m set --match-set mailexpert-eop4 src -j RETURN
-i <ext> -p tcp --dport 25 -j DROP
-i <ext> -p tcp -m multiport --dports 587,993 -s <PANEL_IP> -j RETURN
-i <ext> -p tcp -m multiport --dports 587,993 -j DROP
-i <ext> -p tcp -m multiport --dports 110,143,465,995,4190 -j DROP
```

- Only packets coming in on the external interface: `DOCKER-USER` also sees mailcow's own mail
  going out to EOP on port 25.
- The ports are the containers' (`DOCKER-USER` sees packets after Docker's DNAT), so a host port
  moved in `mailcow.conf` (`SMTP_PORT=<NODE_IP>:25`, `SUBMISSION_PORT=...`) is still covered.
- A change is a new chain that `DOCKER-USER` jumps to first; then the old chain goes and the new one
  takes its name. An unchanged chain is left alone.
- IPv6 (`ip6tables`, set `mailexpert-eop6`) only when `ENABLE_IPV6=true` in `mailcow.conf`.
- Neither ipsets nor rules survive a reboot: `mailexpert-node-firewall.service` runs
  `eop-ranges.sh --restore` after Docker starts, from the last good list, without asking Microsoft.

## eop-ranges.sh

```bash
/opt/mailexpert-node/eop-ranges.sh            # what the timer runs
/opt/mailexpert-node/eop-ranges.sh --dry-run  # what would change
/opt/mailexpert-node/eop-ranges.sh --force    # fetch the ranges even if the version is the same
/opt/mailexpert-node/eop-ranges.sh --restore  # the boot run
```

Each run asks `https://endpoints.office.com/version/Worldwide` with the installation's
`ClientRequestId` (without one the service answers 400). The same version as last time, with the
sets filled, is a no-op. A new one fetches `/endpoints/Worldwide?ServiceAreas=Exchange` and keeps the
entries of the `Exchange` service area whose `tcpPorts` carry 25 (blanks around the commas allowed,
unknown fields skipped, never by `id`): the same filter as `rangesFromEndpoints` in
`backend/src/services/mailNode/eopRanges.js`. The list is applied only whole: every CIDR valid and at
least one IPv4 range. An empty or malformed list, HTTP 400 or 429, any other error or no answer
changes nothing; the run pings `<EOP_RANGES_PING_URL>/fail` with the reason and exits 1. A good list
is filled into a temporary ipset and swapped in (`ipset swap`), then written to
`/var/lib/mailexpert-node/eop-ranges.txt` (one CIDR per line, IPv4 first) and the version to
`eop-version`. The file is the same list the panel applies as mailcow forwarding hosts (R-12); the
panel has its own copy in `eopRanges.js` and shows its version in the apply result, so compare the
two after Microsoft changes the list.

## Tests

```bash
docker run --rm -v "$PWD:/code:ro" -w /code --entrypoint bash bats/bats:1.14.0 \
  -c 'apk add --no-cache -q jq && bats scripts/deploy/test'
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable scripts/deploy/mail-node/*.sh
```

`scripts/deploy/test/mail-node-setup.bats` and `mail-node-eop-ranges.bats` run with `docker`,
`iptables`, `ip6tables`, `ipset`, `curl` and `systemctl` mocked (`test/mail-node/mocks/`); the web
service answers are recorded (`test/mail-node/version.json`, `endpoints.json`, 2026-10-02, version
`2026081400`).
