# MailExpert roadmap

Now / Next / Later, without dates. The detailed plan with acceptance criteria is
[docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md](docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md);
the target architecture is [docs/architecture/team-mail-system-handoff.md](docs/architecture/team-mail-system-handoff.md).

## Done

- Fork, full MailExpert rebrand and removal of upstream-only content.
- Full dependency modernization: Express 5, ImapFlow 2, Nodemailer 10, connect-redis 10 / Redis 6, React 19, React Router 7, Zustand 5, Tailwind 4, Electron 44.
- Google OAuth 2.0 for Gmail: PKCE S256, one-time Redis state, strict ID token checks, encrypted tokens, admin configuration and connect/reconnect UI.
- One OAuth token manager for every IMAP/SMTP path, with forced refresh on authentication failure and a persistent "reconnect required" state.
- Real IMAP authentication errors and bounded retry cooldowns instead of reconnect storms.
- Sign-in restricted to approved users, through Cloudflare Access or Google directly, with admin user management and Cloudflare Access policy sync.
- One shared install: the server connects mailboxes on its own schedule regardless of who is signed in, and every signed-in user works with every mailbox, its rules, block list and contacts.
- Mailbox audit log with an admin screen.
- Local demo mode for showing the product without a real mailbox.
- Gmail conversations threaded the way Gmail threads them: provider thread and message ids stored, no grouping by subject, a resumable backfill for already-cached mail, and a per-mailbox threading mode with preview, switch, rollback and a batched recompute.
- Per-message threading diagnostics: the headers, the provider thread number, the reason a message landed in its conversation and the folders it lives in.
- Several Google OAuth applications end to end. An unverified Google Cloud project accepts at most 100 unique users for its lifetime and the count never goes down, so mailboxes are spread over several projects: application selection with seat reservations, the grant journal, token refresh through the application a mailbox belongs to, revoke of refused and replaced grants, and the admin screen with active, closed and disabled states.
- One "Add account" entry: a Gmail address with suggestions of known addresses, and a manual IMAP/SMTP setup for administrators. Gmail mailboxes are reconnected from the sidebar and the Accounts tab.
- Google OAuth operations guide ([docs/operations/google-oauth.md](docs/operations/google-oauth.md)): separate development and production Google Cloud projects, consent screen mode, redirect URIs per host, app states, secret rotation, moving mailboxes between apps, revoke and removal.
- Sidebar mailbox filter and per-mailbox connection health.
- Selected upstream MailFlow fixes (see [upstream PR assessment](docs/architecture/upstream-pr-assessment.md)).
- Mailboxes on owned domains through a mailcow mail node: any signed-in user creates one from "Add account" (the server picks host, ports and a password nobody sees), deleting it only disables it on the node and creating the same address again enables it back; administrators add domains, set the default quota (5 GB) and per-mailbox quotas, and see usage and the mail disk, which the panel also reports to a ping URL. mailcow, EOP, DNS and DKIM are set up by hand: [docs/operations/mail-node.md](docs/operations/mail-node.md).
- Working with many mailboxes: "Add account" with Gmail and "Our mailbox" tabs (a mailbox on an owned domain, name plus domain, no duplicates), two sender names per mailbox (Russian and English) chosen when sending, reply headers and dates in the sender name's language, the mailbox a letter arrived in shown on the letter itself, and "Sent", "Received" or "Draft" marked on every letter in every list.
- Reading: "Earlier with this person" above an open letter and, on request, the whole conversation stacked under it the way Gmail shows it; contacts with the letters exchanged across all mailboxes; one inbox for every mailbox.
- Interface: two default themes (a light one and a dark one with light letter cards), one font for Latin and Cyrillic, larger default sizes, labelled toolbar buttons, a language choice at first sign-in, SVG icons instead of emoji, remote images shown by default.
- Managers see only their own mail settings; system settings are for administrators.
- Upstream MailFlow IMAP connection fixes (#474): a full pool queues instead of opening unbounded logins, teardown never waits on LOGOUT, rejected passwords back off from 30 minutes to 6 hours, unfetchable UIDs stop re-triggering backfill, the folder integrity pass fits a large mailbox.
- Demo mode for the whole product: 50 mailboxes, every settings screen, both roles (administrator and manager).
- The mail node sized and tuned for one server: Dovecot settings for hibernating idle sessions, no COMPRESS to the node, search on the body index, measured with 500 node and 125 Gmail mailboxes on 4 vCPU / 8 GB ([docs/operations/mail-node.md](docs/operations/mail-node.md), section 6a).
- IMAP connections that behave under load: backoff ladders that climb, one login gate in the pool so a wrong password stops at one rejected login (fail2ban on the node), a pooled session kept for user actions, read and star flags over the open session and in one command per folder, new letters' text fetched on the node right after sync.
- Moves, archive, Trash and spam applied in the database at once and sent to the server from a durable queue; a repeated delete never deletes a letter forever unless the user saw it in Trash.
- The panel restores a node mailbox's rejected password itself through the mailcow API.
- One letter delivered to two mailboxes shows as both copies; links to a letter name its mailbox.
- The panel does not name itself to other servers: neutral EHLO, no IMAP ID, no product User-Agent.
- List work from upstream: Ctrl/Shift-click multi-select, Ctrl+Z undo, a choice of hover actions, download as .eml, a star in the bulk bar; search covers every folder except Trash and Spam by default.
- A load scenario with ten employees working in shared mailboxes and a letter-by-letter check against the node (`scripts/deploy/test/e2e-mailcow.sh --scenario work`): 200 mailboxes and 60 000 letters, none lost or doubled.
- Scripted production deployment for both sign-in hosts: `install.sh`/`configure.sh`, edge (Caddy or Cloudflare Tunnel), encrypted and verified restic backups, `update.sh`, a documented manual rollback and moving the panel to another server without losing data. Runbook: [docs/operations/deployment.md](docs/operations/deployment.md).

## Now

- Live OAuth lifecycle check on real accounts: consent, refresh after expiry, revoke, reconnect.
- First mail node: install mailcow by the runbook and check what the live test cannot (docs/operations/mail-node.md, section 9): delivery through EOP, disk pings, the real certificate, the fail2ban allow list. The panel and mailcow 2026-09 together pass `scripts/deploy/test/e2e-mailcow.sh`.
- Production acceptance: a full move rehearsal between two VPS following the deployment runbook, with downtime measured (docs/operations/deployment.md, section 8).

## Next

- Gmail scale test in waves of 10 → 25 → 50 → 100 mailboxes: memory, CPU, IMAP connections, provider errors and UI latency on the target server.
- 24-hour stability run, controlled restart and restore.
- Mail node domain setup through the mailcow API instead of hand-run steps: apply the DKIM decision (publish or skip the key), set the relayhost, TLS policy map and rate limits, and show/check the DNS records the owner needs to publish. Findings and open decisions: [docs/architecture/mail-node-research/eop-review.md](docs/architecture/mail-node-research/eop-review.md).
- A timer script that keeps the node firewall's EOP ranges current from the Microsoft web service (IPv4 and IPv6), instead of the monthly manual check.
- A global mailcow spam filter that files mail on EOP's `X-Forefront-Antispam-Report` header into Junk.
- Mirror mail node mailboxes as mail users in the Microsoft tenant (Internal Relay while syncing, Authoritative once synced) so EOP's own directory blocks invalid recipients instead of the node generating backscatter NDRs.
- Optional: report spam/phishing from the panel to Microsoft through the Graph beta threat-submission API.

## Later

- The mail node on the same server as the panel (the edge would proxy <MAIL_HOST> to mailcow); today it needs its own server.
- Adaptive mailbox quotas, if fixed quotas prove wasteful ([research](docs/architecture/mail-node-research/README.md), section 6).
- Individual manager identities and mailbox membership, if per-person accountability becomes a requirement on top of the audit log.
